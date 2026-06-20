export interface ParsedStorageUrl {
  protocol: string;
  host: string;
  port?: number;
  username?: string;
  password?: string;
  path: string;
}

function decodeComponent(value: string | null): string | undefined {
  if (value === null || value === "") {
    return undefined;
  }
  return decodeURIComponent(value);
}

export function parseStorageUrl(input: string): ParsedStorageUrl {
  if (input.startsWith("/")) {
    return {
      protocol: "file",
      host: "",
      path: input,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch (error) {
    throw new TypeError(`Invalid storage URL '${input}': ${(error as Error).message}`);
  }

  const protocol = parsed.protocol.replace(/:$/, "").toLowerCase();
  const port = parsed.port === "" ? undefined : Number.parseInt(parsed.port, 10);

  return {
    protocol,
    host: parsed.hostname,
    port,
    username: decodeComponent(parsed.username),
    password: decodeComponent(parsed.password),
    path: decodeURIComponent(parsed.pathname || "/"),
  };
}
