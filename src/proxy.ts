import type { ProxyConfig, RemoteConfig } from "./config.ts";
import { UnsupportedFeatureError } from "./errors.ts";

export function describeProxy(proxy: ProxyConfig): string {
  return `${proxy.host}:${proxy.port}`;
}

export function throwProxyUnsupported(type: string, name: string, proxy: ProxyConfig): never {
  throw new UnsupportedFeatureError(
    `${type} remote '${name}' uses SOCKS5 proxy ${describeProxy(proxy)}, but proxy transport is not implemented in the Bun adapter yet`,
  );
}

export function ensureProxyUnsupported(remote: RemoteConfig): void {
  if (remote.proxy === undefined) {
    return;
  }

  throwProxyUnsupported(remote.type, remote.name, remote.proxy);
}
