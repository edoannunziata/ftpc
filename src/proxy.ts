import { ProxyAgent } from "proxy-agent";
import type { ProxyConfig, ProxyProtocol } from "./config.ts";

const proxyAgents = new Map<string, ProxyAgent>();

export function proxyProtocol(proxy: ProxyConfig): ProxyProtocol {
  return proxy.protocol ?? "socks5";
}

export function describeProxy(proxy: ProxyConfig): string {
  return `${proxyProtocol(proxy)}://${proxy.host}:${proxy.port}`;
}

function agentProtocol(proxy: ProxyConfig): string {
  const protocol = proxyProtocol(proxy);
  return protocol === "socks5" ? "socks5h" : protocol;
}

export function proxyUrl(proxy: ProxyConfig): string {
  const url = new URL(`${agentProtocol(proxy)}://${proxy.host}`);
  url.port = String(proxy.port);
  if (proxy.username !== undefined) {
    url.username = proxy.username;
  }
  if (proxy.password !== undefined) {
    url.password = proxy.password;
  }
  return url.toString();
}

export function getProxyAgent(proxy: ProxyConfig): ProxyAgent {
  const url = proxyUrl(proxy);
  let agent = proxyAgents.get(url);
  if (agent === undefined) {
    agent = new ProxyAgent({
      getProxyForUrl: () => url,
    });
    proxyAgents.set(url, agent);
  }
  return agent;
}

export function isHttpProxy(proxy: ProxyConfig): boolean {
  return proxyProtocol(proxy) === "http" || proxyProtocol(proxy) === "https";
}
