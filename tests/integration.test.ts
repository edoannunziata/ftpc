import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseConfigText, type Config } from "../src/config.ts";
import { Storage, type StorageSession } from "../src/storage.ts";
import { parseStorageUrl } from "../src/url.ts";

const RUN_INTEGRATION = process.env.FTPC_INTEGRATION === "1";
const TEST_TIMEOUT_MS = 120_000;

interface IntegrationConnection {
  connection: string;
  config?: Config;
  required: string[];
}

let tempDir = "";

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "ftpc-integration-"));
});

afterEach(async () => {
  if (tempDir !== "") {
    await rm(tempDir, { recursive: true, force: true });
  }
});

function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function optionalTomlLine(key: string, value: string | undefined): string {
  return value === undefined ? "" : `${key} = ${tomlString(value)}\n`;
}

function resourceNameFromStorageUrl(
  url: string,
  label: string,
  protocol?: "azure" | "blob",
): string {
  const parsed =
    protocol === undefined
      ? parseStorageUrl(url)
      : parseStorageUrl(url.includes("://") ? url : `${protocol}://${url}`);
  const [resourceName] = parsed.path.split("/").filter((part) => part !== "");
  if (resourceName === undefined) {
    throw new Error(
      `${label} URL must include the remote resource name in the first path segment`,
    );
  }
  return resourceName;
}

function configConnection(name: string, text: string): IntegrationConnection {
  return {
    connection: name,
    config: parseConfigText(text),
    required: [],
  };
}

function parseUrlWithDefaultProtocol(url: string, protocol: "ftp" | "sftp") {
  return parseStorageUrl(url.includes("://") ? url : `${protocol}://${url}`);
}

function ftpConnection(envName: string, tls: boolean): IntegrationConnection {
  const url = env(envName);
  const remoteName = tls ? "ftps-it" : "ftp-it";
  if (url === undefined) {
    return { connection: "", required: [envName] };
  }

  const parsed = parseUrlWithDefaultProtocol(url, "ftp");
  const prefix = tls ? "FTPC_INTEGRATION_FTPS" : "FTPC_INTEGRATION_FTP";
  return configConnection(
    remoteName,
    `[${remoteName}]
type = "ftp"
url = ${tomlString(url)}
tls = ${tls ? "true" : "false"}
${parsed.port === undefined ? "" : `port = ${parsed.port}\n`}${optionalTomlLine("username", env(`${prefix}_USERNAME`) ?? parsed.username)}${optionalTomlLine("password", env(`${prefix}_PASSWORD`) ?? parsed.password)}`,
  );
}

function sftpConnection(): IntegrationConnection {
  const url = env("FTPC_INTEGRATION_SFTP_URL");
  const username = env("FTPC_INTEGRATION_SFTP_USERNAME");
  const password = env("FTPC_INTEGRATION_SFTP_PASSWORD");
  const keyFilename = env("FTPC_INTEGRATION_SFTP_KEY_FILENAME");

  if (url === undefined) {
    return { connection: "", required: ["FTPC_INTEGRATION_SFTP_URL"] };
  }

  const parsed = parseUrlWithDefaultProtocol(url, "sftp");
  const effectiveUsername = username ?? parsed.username;
  const effectivePassword = password ?? parsed.password;

  if (effectivePassword !== undefined || keyFilename !== undefined) {
    return configConnection(
      "sftp-it",
      `[sftp-it]
type = "sftp"
url = ${tomlString(url)}
${optionalTomlLine("username", effectiveUsername)}${optionalTomlLine("password", effectivePassword)}${optionalTomlLine("key_filename", keyFilename)}`,
    );
  }

  return {
    connection: "",
    required: ["FTPC_INTEGRATION_SFTP_PASSWORD"],
  };
}

function s3Connection(): IntegrationConnection {
  const url = env("FTPC_INTEGRATION_S3_URL");
  if (url === undefined) {
    return { connection: "", required: ["FTPC_INTEGRATION_S3_URL"] };
  }

  return configConnection(
    "s3-it",
    `[s3-it]
type = "s3"
url = ${tomlString(url)}
${optionalTomlLine("region_name", env("FTPC_INTEGRATION_S3_REGION"))}${optionalTomlLine("endpoint_url", env("FTPC_INTEGRATION_S3_ENDPOINT_URL"))}${optionalTomlLine("aws_access_key_id", env("FTPC_INTEGRATION_S3_AWS_ACCESS_KEY_ID"))}${optionalTomlLine("aws_secret_access_key", env("FTPC_INTEGRATION_S3_AWS_SECRET_ACCESS_KEY"))}`,
  );
}

function azureDataLakeConnection(): IntegrationConnection {
  const url = env("FTPC_INTEGRATION_AZURE_URL");
  if (url === undefined) {
    return { connection: "", required: ["FTPC_INTEGRATION_AZURE_URL"] };
  }

  return configConnection(
    "azure-it",
    `[azure-it]
type = "azure"
url = ${tomlString(url)}
filesystem = ${tomlString(env("FTPC_INTEGRATION_AZURE_FILESYSTEM") ?? resourceNameFromStorageUrl(url, "Azure Data Lake", "azure"))}
${optionalTomlLine("connection_string", env("FTPC_INTEGRATION_AZURE_CONNECTION_STRING"))}${optionalTomlLine("account_key", env("FTPC_INTEGRATION_AZURE_ACCOUNT_KEY"))}`,
  );
}

function azureBlobConnection(): IntegrationConnection {
  const url = env("FTPC_INTEGRATION_BLOB_URL");
  if (url === undefined) {
    return { connection: "", required: ["FTPC_INTEGRATION_BLOB_URL"] };
  }

  return configConnection(
    "blob-it",
    `[blob-it]
type = "blob"
url = ${tomlString(url)}
container = ${tomlString(env("FTPC_INTEGRATION_BLOB_CONTAINER") ?? resourceNameFromStorageUrl(url, "Azure Blob", "blob"))}
${optionalTomlLine("connection_string", env("FTPC_INTEGRATION_BLOB_CONNECTION_STRING"))}${optionalTomlLine("account_key", env("FTPC_INTEGRATION_BLOB_ACCOUNT_KEY"))}`,
  );
}

async function assertTransferWorkflow(
  session: StorageSession,
  label: string,
): Promise<void> {
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const remoteDir = `ftpc-integration-${label}-${token}`;
  const fileName = "uploaded.txt";
  const content = `ftpc ${label} integration ${token}\n`;
  const source = join(tempDir, `${label}-source.txt`);
  const downloaded = join(tempDir, `${label}-downloaded.txt`);
  await writeFile(source, content, "utf8");

  try {
    expect(await session.mkdir(remoteDir)).toBe(true);
    await session.upload(source, `${remoteDir}/${fileName}`);

    const listed = await session.list(remoteDir);
    expect(
      listed.some((entry) => entry.name === fileName && entry.type === "file"),
    ).toBe(true);

    await session.download(`${remoteDir}/${fileName}`, downloaded);
    expect(await readFile(downloaded, "utf8")).toBe(content);

    expect(await session.delete(`${remoteDir}/${fileName}`)).toBe(true);
  } finally {
    await session.delete(`${remoteDir}/${fileName}`).catch(() => false);
    await session.delete(`${remoteDir}/`).catch(() => false);
    await session.close();
  }
}

function defineIntegrationTest(
  label: string,
  connectionFactory: () => IntegrationConnection,
): void {
  const connection = connectionFactory();
  const missing = [
    ...connection.required.filter((name) => env(name) === undefined),
    ...(RUN_INTEGRATION ? [] : ["FTPC_INTEGRATION=1"]),
  ];

  const runner = missing.length === 0 ? test.serial : test.skip;
  runner(
    `${label} real service transfer workflow`,
    async () => {
      const session = Storage.connect(connection.connection, {
        config: connection.config,
      });
      await assertTransferWorkflow(
        session,
        label.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-"),
      );
    },
    { timeout: TEST_TIMEOUT_MS },
  );
}

function withEnv(
  values: Record<string, string | undefined>,
  action: () => void,
): void {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  try {
    action();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

describe("integration connection helpers", () => {
  test("SFTP helper accepts no-scheme URL credentials through configured remotes", () => {
    withEnv(
      {
        FTPC_INTEGRATION_SFTP_URL: "user:pass@sftp.example.com:2222/home/user",
        FTPC_INTEGRATION_SFTP_USERNAME: undefined,
        FTPC_INTEGRATION_SFTP_PASSWORD: undefined,
        FTPC_INTEGRATION_SFTP_KEY_FILENAME: undefined,
      },
      () => {
        const connection = sftpConnection();
        const remote = connection.config?.remotes.get("sftp-it");

        expect(connection.connection).toBe("sftp-it");
        expect(connection.required).toEqual([]);
        expect(remote).toMatchObject({
          type: "sftp",
          url: "user:pass@sftp.example.com:2222/home/user",
          username: "user",
          password: "pass",
          port: 22,
          portExplicit: false,
        });
      },
    );
  });

  test("SFTP helper lets explicit environment credentials override URL credentials", () => {
    withEnv(
      {
        FTPC_INTEGRATION_SFTP_URL:
          "url-user:url-pass@sftp.example.com/home/user",
        FTPC_INTEGRATION_SFTP_USERNAME: "env-user",
        FTPC_INTEGRATION_SFTP_PASSWORD: "env-pass",
        FTPC_INTEGRATION_SFTP_KEY_FILENAME: undefined,
      },
      () => {
        const connection = sftpConnection();
        const remote = connection.config?.remotes.get("sftp-it");

        expect(connection.connection).toBe("sftp-it");
        expect(remote).toMatchObject({
          type: "sftp",
          username: "env-user",
          password: "env-pass",
        });
      },
    );
  });

  test("SFTP helper skips unauthenticated URLs instead of attempting an unusable direct connection", () => {
    withEnv(
      {
        FTPC_INTEGRATION_SFTP_URL: "sftp.example.com/home/user",
        FTPC_INTEGRATION_SFTP_USERNAME: undefined,
        FTPC_INTEGRATION_SFTP_PASSWORD: undefined,
        FTPC_INTEGRATION_SFTP_KEY_FILENAME: undefined,
      },
      () => {
        expect(sftpConnection()).toEqual({
          connection: "",
          required: ["FTPC_INTEGRATION_SFTP_PASSWORD"],
        });
      },
    );
  });

  test("Azure helper derives filesystem from no-scheme account URLs", () => {
    withEnv(
      {
        FTPC_INTEGRATION_AZURE_URL:
          "account.dfs.core.windows.net/filesystem/base",
        FTPC_INTEGRATION_AZURE_FILESYSTEM: undefined,
        FTPC_INTEGRATION_AZURE_CONNECTION_STRING: undefined,
        FTPC_INTEGRATION_AZURE_ACCOUNT_KEY: undefined,
      },
      () => {
        const connection = azureDataLakeConnection();
        const remote = connection.config?.remotes.get("azure-it");

        expect(connection.connection).toBe("azure-it");
        expect(remote).toMatchObject({
          type: "azure",
          url: "account.dfs.core.windows.net/filesystem/base",
          filesystem: "filesystem",
        });
      },
    );
  });

  test("Blob helper derives container from no-scheme account URLs", () => {
    withEnv(
      {
        FTPC_INTEGRATION_BLOB_URL:
          "account.blob.core.windows.net/container/base",
        FTPC_INTEGRATION_BLOB_CONTAINER: undefined,
        FTPC_INTEGRATION_BLOB_CONNECTION_STRING: undefined,
        FTPC_INTEGRATION_BLOB_ACCOUNT_KEY: undefined,
      },
      () => {
        const connection = azureBlobConnection();
        const remote = connection.config?.remotes.get("blob-it");

        expect(connection.connection).toBe("blob-it");
        expect(remote).toMatchObject({
          type: "blob",
          url: "account.blob.core.windows.net/container/base",
          container: "container",
        });
      },
    );
  });

  test("Azure and Blob helpers keep explicit resource environment overrides", () => {
    withEnv(
      {
        FTPC_INTEGRATION_AZURE_URL:
          "account.dfs.core.windows.net/filesystem/base",
        FTPC_INTEGRATION_AZURE_FILESYSTEM: "env-filesystem",
        FTPC_INTEGRATION_AZURE_CONNECTION_STRING: undefined,
        FTPC_INTEGRATION_AZURE_ACCOUNT_KEY: undefined,
        FTPC_INTEGRATION_BLOB_URL:
          "account.blob.core.windows.net/container/base",
        FTPC_INTEGRATION_BLOB_CONTAINER: "env-container",
        FTPC_INTEGRATION_BLOB_CONNECTION_STRING: undefined,
        FTPC_INTEGRATION_BLOB_ACCOUNT_KEY: undefined,
      },
      () => {
        const lakeRemote =
          azureDataLakeConnection().config?.remotes.get("azure-it");
        const blobRemote = azureBlobConnection().config?.remotes.get("blob-it");

        expect(lakeRemote).toMatchObject({
          type: "azure",
          filesystem: "env-filesystem",
        });
        expect(blobRemote).toMatchObject({
          type: "blob",
          container: "env-container",
        });
      },
    );
  });
});

describe("real service integrations", () => {
  defineIntegrationTest("FTP", () =>
    ftpConnection("FTPC_INTEGRATION_FTP_URL", false),
  );
  defineIntegrationTest("FTPS", () =>
    ftpConnection("FTPC_INTEGRATION_FTPS_URL", true),
  );
  defineIntegrationTest("SFTP", sftpConnection);
  defineIntegrationTest("S3", s3Connection);
  defineIntegrationTest("Azure Data Lake", azureDataLakeConnection);
  defineIntegrationTest("Azure Blob", azureBlobConnection);
});
