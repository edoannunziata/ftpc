import { describe, expect, test } from "bun:test";
import { parseConfigText, listRemotes, getRemote } from "../../src/config.ts";
import { RemoteNotFoundError, ValidationError } from "../../src/errors.ts";

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
      password: "anonymous@",
      tls: false,
      port: 21,
    });
    expect(getRemote(config, "s3")).toMatchObject({ bucketName: "bucket" });
  });

  test("requires at least one valid remote", () => {
    expect(() => parseConfigText("[bad]\ntype = \"nope\"\n")).toThrow(ValidationError);
  });

  test("reports missing remotes", () => {
    const config = parseConfigText("[local]\ntype = \"local\"\n");
    expect(() => getRemote(config, "missing")).toThrow(RemoteNotFoundError);
  });
});
