import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createDefaultConfig,
  DEFAULT_CONFIG_TEXT,
  parseConfigText,
  listRemotes,
  getRemote,
} from "../src/config.ts";
import { RemoteNotFoundError, ValidationError } from "../src/errors.ts";

describe("config", () => {
  test("loads valid remotes and warnings", () => {
    const config = parseConfigText(`
[local]
type = "local"

[ftp]
type = "ftp"
url = "ftp.example.com"

[invalid]
url = "missing-type"
`);

    expect(listRemotes(config)).toEqual({ local: "local", ftp: "ftp" });
    expect(config.warnings).toHaveLength(1);
    expect(config.warnings[0]).toContain("missing required 'type'");
  });

  test("applies backend defaults", () => {
    const config = parseConfigText(`
[ftp]
type = "ftp"
url = "ftp.example.com"

[s3]
type = "s3"
url = "s3://bucket"
`);

    expect(getRemote(config, "ftp")).toMatchObject({
      username: "anonymous",
      usernameExplicit: false,
      password: "anonymous@",
      passwordExplicit: false,
      tls: false,
      tlsExplicit: false,
      port: 21,
      portExplicit: false,
    });
    expect(getRemote(config, "s3")).toMatchObject({ bucketName: "bucket" });
  });

  test("parses S3 URL bucket names without swallowing path prefixes", () => {
    const config = parseConfigText(`
[s3]
type = "s3"
url = "s3://bucket/path/to/prefix"
`);

    expect(getRemote(config, "s3")).toMatchObject({
      bucketName: "bucket",
      url: "s3://bucket/path/to/prefix",
    });
  });

  test("accepts SFTP URL passwords as configured authentication", () => {
    const config = parseConfigText(`
[sftp]
type = "sftp"
url = "sftp://user:secret@sftp.example.com/home"
`);

    expect(config.warnings).toEqual([]);
    expect(getRemote(config, "sftp")).toMatchObject({
      type: "sftp",
      url: "sftp://user:secret@sftp.example.com/home",
      password: undefined,
      keyFilename: undefined,
    });
  });

  test("parses SOCKS5 proxy settings", () => {
    const config = parseConfigText(`
[ftp]
type = "ftp"
url = "ftp.example.com"

[ftp.proxy]
host = "proxy.example.com"
username = "proxyuser"
password = "proxypass"
`);

    expect(getRemote(config, "ftp")).toMatchObject({
      proxy: {
        host: "proxy.example.com",
        port: 1080,
        username: "proxyuser",
        password: "proxypass",
      },
    });
  });

  test("default config is parseable and includes commented backend examples", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ftpc-config-"));
    const configPath = join(tempDir, "nested", "ftpc.toml");
    try {
      await createDefaultConfig(configPath);
      const text = await readFile(configPath, "utf8");
      const config = parseConfigText(text);

      expect(text).toBe(DEFAULT_CONFIG_TEXT);
      expect(listRemotes(config)).toEqual({ local: "local" });
      expect(config.warnings).toEqual([]);
      expect(text).toContain("# [my-ftp-server]");
      expect(text).toContain("# [my-sftp-server]");
      expect(text).toContain("# [my-s3-bucket]");
      expect(text).toContain("# [my-azure-datalake]");
      expect(text).toContain("# [my-azure-blob]");
      expect(text).toContain(
        "SOCKS5 proxy configuration is implemented for FTP, SFTP, and anonymous S3",
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("requires at least one valid remote", () => {
    expect(() => parseConfigText('[bad]\ntype = "nope"\n')).toThrow(
      ValidationError,
    );
  });

  test("reports missing remotes", () => {
    const config = parseConfigText('[local]\ntype = "local"\n');
    expect(() => getRemote(config, "missing")).toThrow(RemoteNotFoundError);
  });
});
