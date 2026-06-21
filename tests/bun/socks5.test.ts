import { describe, expect, test } from "bun:test";
import type { Socket } from "node:net";
import { Duplex } from "node:stream";
import { connectSocks5 } from "../../src/socks5.ts";

class ScriptedSocket extends Duplex {
  readyState = "open";

  constructor(private readonly onWrite: (chunk: Buffer, socket: ScriptedSocket) => void) {
    super();
  }

  setTimeout(): this {
    return this;
  }

  _read(): void {}

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.onWrite(Buffer.from(chunk), this);
    callback();
  }

  send(chunk: Buffer): void {
    queueMicrotask(() => {
      this.push(chunk);
    });
  }
}

describe("connectSocks5", () => {
  test("connects through a no-auth SOCKS5 proxy", async () => {
    let step = 0;
    let requestedHost = "";
    let requestedPort = 0;
    const socket = new ScriptedSocket((chunk, proxy) => {
      if (step === 0) {
        expect([...chunk]).toEqual([0x05, 0x01, 0x00]);
        proxy.send(Buffer.from([0x05, 0x00]));
        step += 1;
        return;
      }

      expect([...chunk.subarray(0, 5)]).toEqual([0x05, 0x01, 0x00, 0x03, "sftp.example.com".length]);
      requestedHost = chunk.subarray(5, 5 + "sftp.example.com".length).toString("utf8");
      requestedPort = chunk.readUInt16BE(5 + "sftp.example.com".length);
      proxy.send(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0x12, 0x34]));
    });

    const result = await connectSocks5({
      proxy: { host: "proxy.example.com", port: 1080 },
      targetHost: "sftp.example.com",
      targetPort: 2222,
      socketFactory: () => socket as unknown as Socket,
    });

    expect(result).toBe(socket as unknown as Socket);
    expect(requestedHost).toBe("sftp.example.com");
    expect(requestedPort).toBe(2222);
  });

  test("authenticates with username and password", async () => {
    let step = 0;
    let username = "";
    let password = "";
    const socket = new ScriptedSocket((chunk, proxy) => {
      if (step === 0) {
        expect([...chunk]).toEqual([0x05, 0x02, 0x00, 0x02]);
        proxy.send(Buffer.from([0x05, 0x02]));
        step += 1;
        return;
      }
      if (step === 1) {
        expect([...chunk.subarray(0, 2)]).toEqual([0x01, 4]);
        username = chunk.subarray(2, 6).toString("utf8");
        expect(chunk[6]).toBe(6);
        password = chunk.subarray(7, 13).toString("utf8");
        proxy.send(Buffer.from([0x01, 0x00]));
        step += 1;
        return;
      }

      expect([...chunk.subarray(0, 5)]).toEqual([0x05, 0x01, 0x00, 0x03, "server.internal".length]);
      expect(chunk.subarray(5, 5 + "server.internal".length).toString("utf8")).toBe("server.internal");
      expect(chunk.readUInt16BE(5 + "server.internal".length)).toBe(22);
      proxy.send(Buffer.from([0x05, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00]));
    });

    const result = await connectSocks5({
      proxy: {
        host: "proxy.example.com",
        port: 1080,
        username: "user",
        password: "secret",
      },
      targetHost: "server.internal",
      targetPort: 22,
      socketFactory: () => socket as unknown as Socket,
    });

    expect(result).toBe(socket as unknown as Socket);
    expect(username).toBe("user");
    expect(password).toBe("secret");
  });

  test("rejects proxy connect failures", async () => {
    let step = 0;
    const socket = new ScriptedSocket((_chunk, proxy) => {
      if (step === 0) {
        proxy.send(Buffer.from([0x05, 0x00]));
        step += 1;
        return;
      }
      proxy.send(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
    });

    await expect(connectSocks5({
      proxy: { host: "proxy.example.com", port: 1080 },
      targetHost: "sftp.example.com",
      targetPort: 22,
      socketFactory: () => socket as unknown as Socket,
    })).rejects.toThrow("connection refused");
  });
});
