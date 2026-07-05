import { describe, expect, test } from "bun:test";
import { describeProxy, proxyUrl } from "../src/proxy.ts";
import {
  applyAzureSocksProxy,
  azureProxyOptions,
  parseAzureConnectionString,
  toDfsEndpointUrl,
} from "../src/clients/azure_proxy.ts";
import type {
  RequestPolicy,
  RequestPolicyFactory,
  WebResource,
} from "@azure/storage-blob";

describe("proxy", () => {
  test("describes default SOCKS5 proxies", () => {
    const proxy = { host: "proxy.example.com", port: 1080 };

    expect(describeProxy(proxy)).toBe("socks5://proxy.example.com:1080");
  });

  test("uses remote DNS SOCKS5 URLs for SDK agents", () => {
    const proxy = {
      host: "proxy.example.com",
      port: 1080,
      username: "proxy user",
      password: "secret/pass",
    };

    expect(proxyUrl(proxy)).toBe(
      "socks5h://proxy%20user:secret%2Fpass@proxy.example.com:1080",
    );
  });

  test("preserves HTTP proxy protocols for SDK agents", () => {
    expect(
      proxyUrl({
        host: "proxy.example.com",
        port: 80,
        protocol: "http",
      }),
    ).toBe("http://proxy.example.com/");
  });

  test("maps HTTP Azure proxies to SDK proxy options", () => {
    expect(
      azureProxyOptions({
        host: "proxy.example.com",
        port: 8080,
        protocol: "http",
        username: "user",
        password: "pass",
      }),
    ).toEqual({
      proxyOptions: {
        host: "http://proxy.example.com",
        port: 8080,
        username: "user",
        password: "pass",
      },
    });
  });

  test("adds SOCKS5 Azure proxies through the SDK pipeline bridge", async () => {
    const pipeline = {
      factories: [] as RequestPolicyFactory[],
      options: {},
      toServiceClientOptions() {
        return { requestPolicyFactories: this.factories };
      },
    };
    applyAzureSocksProxy(pipeline, {
      host: "proxy.example.com",
      port: 1080,
    });

    expect(pipeline.factories).toHaveLength(1);
    const request = {} as WebResource;
    const response = {} as Awaited<ReturnType<RequestPolicy["sendRequest"]>>;
    const policy = pipeline.factories[0]!.create(
      {
        async sendRequest(_nextRequest: WebResource) {
          return response;
        },
      },
      {} as never,
    );

    expect(await policy.sendRequest(request)).toBe(response);
    expect(request).toHaveProperty("agent");
  });

  test("parses Azure connection strings for custom pipelines", () => {
    const account = parseAzureConnectionString(
      "DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=YWJjZA==;EndpointSuffix=core.windows.net",
    );
    const sas = parseAzureConnectionString(
      "BlobEndpoint=https://acct.blob.core.windows.net/;SharedAccessSignature=?sv=1&sig=2",
    );

    expect(account).toEqual({
      kind: "account",
      url: "https://acct.blob.core.windows.net",
      accountName: "acct",
      accountKey: "YWJjZA==",
    });
    expect(sas).toEqual({
      kind: "sas",
      url: "https://acct.blob.core.windows.net",
      accountName: "acct",
      accountSas: "sv=1&sig=2",
    });
    expect(toDfsEndpointUrl(sas.url)).toBe("https://acct.dfs.core.windows.net");
  });
});
