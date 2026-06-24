import { connect as connectSocket, type Socket } from "node:net";
import type { ProxyConfig } from "./config.ts";

const SOCKS_VERSION = 0x05;
const NO_AUTHENTICATION = 0x00;
const USERNAME_PASSWORD = 0x02;
const NO_ACCEPTABLE_METHODS = 0xff;
const CONNECT_COMMAND = 0x01;
const RESERVED = 0x00;
const DOMAIN_NAME = 0x03;
const IPV4_ADDRESS = 0x01;
const IPV6_ADDRESS = 0x04;

export interface Socks5ConnectOptions {
  proxy: ProxyConfig;
  targetHost: string;
  targetPort: number;
  timeoutMs?: number;
  socketFactory?: (proxy: ProxyConfig) => Socket;
}

export type Socks5Connector = (
  options: Socks5ConnectOptions,
) => Promise<Socket>;

class SocketReader {
  private readonly chunks: Buffer[] = [];
  private length = 0;
  private error: Error | undefined;
  private readonly waiters: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];

  constructor(private readonly socket: Socket) {
    this.socket.on("data", this.onData);
    this.socket.once("end", this.onEnd);
    this.socket.once("error", this.onError);
  }

  async readExactly(size: number): Promise<Buffer> {
    while (this.length < size) {
      if (this.error !== undefined) {
        throw this.error;
      }
      await new Promise<void>((resolve, reject) => {
        this.waiters.push({ resolve, reject });
      });
    }

    return this.take(size);
  }

  release(): void {
    this.socket.off("data", this.onData);
    this.socket.off("end", this.onEnd);
    this.socket.off("error", this.onError);

    if (this.length > 0) {
      this.socket.unshift(this.take(this.length));
    }
  }

  private readonly onData = (chunk: Buffer): void => {
    this.chunks.push(chunk);
    this.length += chunk.length;
    this.resolveWaiters();
  };

  private readonly onEnd = (): void => {
    this.error = new Error("SOCKS5 proxy closed the connection");
    this.rejectWaiters(this.error);
  };

  private readonly onError = (error: Error): void => {
    this.error = error;
    this.rejectWaiters(error);
  };

  private take(size: number): Buffer {
    const output = Buffer.allocUnsafe(size);
    let offset = 0;

    while (offset < size) {
      const chunk = this.chunks[0];
      if (chunk === undefined) {
        throw new Error("Internal SOCKS5 reader underflow");
      }

      const remaining = size - offset;
      if (chunk.length <= remaining) {
        chunk.copy(output, offset);
        offset += chunk.length;
        this.length -= chunk.length;
        this.chunks.shift();
        continue;
      }

      chunk.copy(output, offset, 0, remaining);
      this.chunks[0] = chunk.subarray(remaining);
      this.length -= remaining;
      offset += remaining;
    }

    return output;
  }

  private resolveWaiters(): void {
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve();
    }
  }

  private rejectWaiters(error: Error): void {
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error);
    }
  }
}

function validateByteLength(label: string, value: string): Buffer {
  const bytes = Buffer.from(value);
  if (bytes.length > 255) {
    throw new Error(`${label} must be at most 255 bytes for SOCKS5`);
  }
  return bytes;
}

function validatePort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `SOCKS5 target port must be an integer between 1 and 65535`,
    );
  }
}

function waitForSocketConnect(
  socket: Socket,
  timeoutMs: number,
): Promise<void> {
  if (socket.readyState === "open") {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      fail(
        new Error(`Timed out connecting to SOCKS5 proxy after ${timeoutMs}ms`),
      );
    }, timeoutMs);

    const cleanup = (): void => {
      clearTimeout(timeout);
      socket.off("connect", onConnect);
      socket.off("error", fail);
    };
    const onConnect = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve();
    };
    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      socket.destroy();
      reject(error);
    };

    socket.once("connect", onConnect);
    socket.once("error", fail);
  });
}

function socksReplyMessage(code: number): string {
  switch (code) {
    case 0x01:
      return "general SOCKS server failure";
    case 0x02:
      return "connection not allowed by ruleset";
    case 0x03:
      return "network unreachable";
    case 0x04:
      return "host unreachable";
    case 0x05:
      return "connection refused";
    case 0x06:
      return "TTL expired";
    case 0x07:
      return "command not supported";
    case 0x08:
      return "address type not supported";
    default:
      return `reply code ${code}`;
  }
}

async function authenticate(
  socket: Socket,
  reader: SocketReader,
  proxy: ProxyConfig,
): Promise<void> {
  const hasCredentials =
    proxy.username !== undefined || proxy.password !== undefined;
  const methods = hasCredentials
    ? [NO_AUTHENTICATION, USERNAME_PASSWORD]
    : [NO_AUTHENTICATION];

  socket.write(Buffer.from([SOCKS_VERSION, methods.length, ...methods]));
  const methodSelection = await reader.readExactly(2);
  if (methodSelection[0] !== SOCKS_VERSION) {
    throw new Error(
      `Invalid SOCKS version ${methodSelection[0]} in authentication response`,
    );
  }
  if (methodSelection[1] === NO_ACCEPTABLE_METHODS) {
    throw new Error("SOCKS5 proxy did not accept any authentication method");
  }
  if (methodSelection[1] === NO_AUTHENTICATION) {
    return;
  }
  if (methodSelection[1] !== USERNAME_PASSWORD) {
    throw new Error(
      `SOCKS5 proxy selected unsupported authentication method ${methodSelection[1]}`,
    );
  }

  const username = validateByteLength("SOCKS5 username", proxy.username ?? "");
  const password = validateByteLength("SOCKS5 password", proxy.password ?? "");
  socket.write(
    Buffer.concat([
      Buffer.from([0x01, username.length]),
      username,
      Buffer.from([password.length]),
      password,
    ]),
  );

  const authResponse = await reader.readExactly(2);
  if (authResponse[0] !== 0x01 || authResponse[1] !== 0x00) {
    throw new Error("SOCKS5 username/password authentication failed");
  }
}

async function connectTarget(
  socket: Socket,
  reader: SocketReader,
  targetHost: string,
  targetPort: number,
): Promise<void> {
  const host = validateByteLength("SOCKS5 target host", targetHost);
  const port = Buffer.allocUnsafe(2);
  port.writeUInt16BE(targetPort, 0);

  socket.write(
    Buffer.concat([
      Buffer.from([
        SOCKS_VERSION,
        CONNECT_COMMAND,
        RESERVED,
        DOMAIN_NAME,
        host.length,
      ]),
      host,
      port,
    ]),
  );

  const response = await reader.readExactly(4);
  const version = response[0];
  const reply = response[1];
  const addressType = response[3];
  if (
    version === undefined ||
    reply === undefined ||
    addressType === undefined
  ) {
    throw new Error("Invalid SOCKS5 connect response");
  }
  if (version !== SOCKS_VERSION) {
    throw new Error(`Invalid SOCKS version ${version} in connect response`);
  }
  if (reply !== 0x00) {
    throw new Error(`SOCKS5 connect failed: ${socksReplyMessage(reply)}`);
  }

  switch (addressType) {
    case IPV4_ADDRESS:
      await reader.readExactly(4 + 2);
      break;
    case DOMAIN_NAME: {
      const length = await reader.readExactly(1);
      const domainLength = length[0];
      if (domainLength === undefined) {
        throw new Error("Invalid SOCKS5 domain length");
      }
      await reader.readExactly(domainLength + 2);
      break;
    }
    case IPV6_ADDRESS:
      await reader.readExactly(16 + 2);
      break;
    default:
      throw new Error(
        `SOCKS5 proxy returned unsupported address type ${addressType}`,
      );
  }
}

export async function connectSocks5(
  options: Socks5ConnectOptions,
): Promise<Socket> {
  validatePort(options.targetPort);

  const timeoutMs = options.timeoutMs ?? 5000;
  const socket =
    options.socketFactory?.(options.proxy) ??
    connectSocket({ host: options.proxy.host, port: options.proxy.port });
  let reader: SocketReader | undefined;

  try {
    await waitForSocketConnect(socket, timeoutMs);
    reader = new SocketReader(socket);
    await authenticate(socket, reader, options.proxy);
    await connectTarget(socket, reader, options.targetHost, options.targetPort);
    reader.release();
    socket.setTimeout(0);
    return socket;
  } catch (error) {
    reader?.release();
    socket.destroy();
    throw new Error(
      `SOCKS5 proxy ${options.proxy.host}:${options.proxy.port} failed to connect to ${options.targetHost}:${options.targetPort}: ${(error as Error).message}`,
      { cause: error },
    );
  }
}
