import { describe, expect, test } from "bun:test";
import { parseStorageUrl } from "../../src/url.ts";

describe("parseStorageUrl", () => {
  test("parses local absolute paths", () => {
    expect(parseStorageUrl("/home/user/data")).toEqual({
      protocol: "file",
      host: "",
      path: "/home/user/data",
    });
  });

  test("parses ftp credentials and port", () => {
    expect(parseStorageUrl("ftp://user%40domain:p%40ss%3Aword@example.com:2121/pub")).toEqual({
      protocol: "ftp",
      host: "example.com",
      port: 2121,
      username: "user@domain",
      password: "p@ss:word",
      path: "/pub",
    });
  });

  test("parses cloud-style URLs", () => {
    expect(parseStorageUrl("s3://bucket/path/to/files")).toMatchObject({
      protocol: "s3",
      host: "bucket",
      path: "/path/to/files",
    });
    expect(parseStorageUrl("azure://account.dfs.core.windows.net/filesystem/path")).toMatchObject({
      protocol: "azure",
      host: "account.dfs.core.windows.net",
      path: "/filesystem/path",
    });
  });
});
