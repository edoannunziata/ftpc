import type {
  PipelineLike,
  RequestPolicy,
  RequestPolicyFactory,
  RequestPolicyOptions,
} from "@azure/storage-blob";
import type { ProxyConfig } from "../config.ts";
import { getProxyAgent, isHttpProxy, proxyProtocol } from "../proxy.ts";

interface AzurePipelineOptions {
  proxyOptions?: {
    host: string;
    port: number;
    username?: string;
    password?: string;
  };
}

const DEVELOPMENT_CONNECTION_STRING =
  "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;";

export type AzureConnectionStringParts =
  | {
      kind: "account";
      url: string;
      accountName: string;
      accountKey: string;
    }
  | {
      kind: "sas";
      url: string;
      accountName: string;
      accountSas: string;
    };

class ProxyAgentPolicyFactory implements RequestPolicyFactory {
  constructor(private readonly proxy: ProxyConfig) {}

  create(
    nextPolicy: RequestPolicy,
    _options: RequestPolicyOptions,
  ): RequestPolicy {
    const agent = getProxyAgent(this.proxy);
    return {
      async sendRequest(request) {
        request.agent = agent;
        return nextPolicy.sendRequest(request);
      },
    };
  }
}

function connectionStringValue(
  connectionString: string,
  argument: string,
): string {
  for (const element of connectionString.split(";")) {
    const trimmed = element.trim();
    if (trimmed.startsWith(argument)) {
      return trimmed.match(`${argument}=(.*)`)?.[1] ?? "";
    }
  }
  return "";
}

function accountNameFromEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  if (
    (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
    url.pathname !== ""
  ) {
    const [accountName] = url.pathname.replace(/^\/+/, "").split("/");
    if (accountName !== undefined && accountName !== "") {
      return accountName;
    }
  }
  return url.hostname.split(".")[0] ?? url.hostname;
}

export function parseAzureConnectionString(
  connectionString: string,
): AzureConnectionStringParts {
  if (connectionString.startsWith("UseDevelopmentStorage=true")) {
    connectionString = DEVELOPMENT_CONNECTION_STRING;
  }

  let blobEndpoint = connectionStringValue(connectionString, "BlobEndpoint");
  blobEndpoint = blobEndpoint.endsWith("/")
    ? blobEndpoint.slice(0, -1)
    : blobEndpoint;

  if (
    connectionString.includes("DefaultEndpointsProtocol=") &&
    connectionString.includes("AccountKey=")
  ) {
    const accountName = connectionStringValue(connectionString, "AccountName");
    const accountKey = connectionStringValue(connectionString, "AccountKey");
    if (blobEndpoint === "") {
      const protocol = connectionStringValue(
        connectionString,
        "DefaultEndpointsProtocol",
      ).toLowerCase();
      if (protocol !== "https" && protocol !== "http") {
        throw new Error(
          "Invalid DefaultEndpointsProtocol in the provided Connection String. Expecting 'https' or 'http'",
        );
      }
      const endpointSuffix = connectionStringValue(
        connectionString,
        "EndpointSuffix",
      );
      if (endpointSuffix === "") {
        throw new Error(
          "Invalid EndpointSuffix in the provided Connection String",
        );
      }
      blobEndpoint = `${protocol}://${accountName}.blob.${endpointSuffix}`;
    }
    if (accountName === "") {
      throw new Error("Invalid AccountName in the provided Connection String");
    }
    if (accountKey === "") {
      throw new Error("Invalid AccountKey in the provided Connection String");
    }
    return {
      kind: "account",
      url: blobEndpoint,
      accountName,
      accountKey,
    };
  }

  let accountSas = connectionStringValue(
    connectionString,
    "SharedAccessSignature",
  );
  if (blobEndpoint === "") {
    throw new Error(
      "Invalid BlobEndpoint in the provided SAS Connection String",
    );
  }
  if (accountSas === "") {
    throw new Error(
      "Invalid SharedAccessSignature in the provided SAS Connection String",
    );
  }
  if (accountSas.startsWith("?")) {
    accountSas = accountSas.slice(1);
  }
  return {
    kind: "sas",
    url: blobEndpoint,
    accountName:
      connectionStringValue(connectionString, "AccountName") ||
      accountNameFromEndpoint(blobEndpoint),
    accountSas,
  };
}

export function toDfsEndpointUrl(blobUrl: string): string {
  const url = new URL(blobUrl);
  url.hostname = url.hostname.replace(".blob.", ".dfs.");
  return url.toString().replace(/\/$/, "");
}

export function hasAzureSocksProxy(
  proxy: ProxyConfig | undefined,
): proxy is ProxyConfig {
  return proxy !== undefined && !isHttpProxy(proxy);
}

export function azureProxyOptions(
  proxy: ProxyConfig | undefined,
): AzurePipelineOptions {
  if (proxy === undefined || !isHttpProxy(proxy)) {
    return {};
  }

  return {
    proxyOptions: {
      host: `${proxyProtocol(proxy)}://${proxy.host}`,
      port: proxy.port,
      username: proxy.username,
      password: proxy.password,
    },
  };
}

export function applyAzureSocksProxy<T extends PipelineLike>(
  pipeline: T,
  proxy: ProxyConfig | undefined,
): T {
  if (hasAzureSocksProxy(proxy)) {
    pipeline.factories.push(new ProxyAgentPolicyFactory(proxy));
  }
  return pipeline;
}
