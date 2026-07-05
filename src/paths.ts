import { posix as posixPath } from "node:path";

export function normalizeRemotePath(path: string): string {
  if (path === "") {
    return ".";
  }
  const normalized = posixPath.normalize(path.replaceAll("\\", "/"));
  return normalized === "." && path.startsWith("/") ? "/" : normalized;
}

export function joinRemotePath(basePath: string, path: string): string {
  if (path === "") {
    return normalizeRemotePath(basePath);
  }
  if (path.startsWith("/")) {
    return normalizeRemotePath(path);
  }
  return normalizeRemotePath(posixPath.join(basePath || "/", path));
}

function hasPathPrefix(basePath: string, path: string): boolean {
  return path === basePath || path.startsWith(`${basePath}/`);
}

export function isRemotePathInsideBase(
  basePath: string,
  path: string,
): boolean {
  const normalizedBase = normalizeRemotePath(basePath || "/");
  const normalizedPath = normalizeRemotePath(path);
  if (normalizedBase === "/") {
    return normalizedPath.startsWith("/");
  }
  if (normalizedPath.startsWith("/")) {
    const absoluteBase = normalizeRemotePath(posixPath.resolve(normalizedBase));
    return hasPathPrefix(absoluteBase, normalizedPath);
  }
  return hasPathPrefix(normalizedBase, normalizedPath);
}

export function joinRemotePathInsideBase(
  basePath: string,
  path: string,
): string {
  const resolved = joinRemotePath(basePath, path);
  if (!isRemotePathInsideBase(basePath, resolved)) {
    throw new Error(`Path '${path}' escapes base path '${basePath}'`);
  }
  return resolved;
}

export function baseName(path: string): string {
  return posixPath.basename(path.replaceAll("\\", "/"));
}

export function parentRemotePath(path: string): string {
  const normalized = normalizeRemotePath(path);
  const parent = posixPath.dirname(normalized);
  return parent === "." ? "/" : parent;
}

export function stripLeadingSlash(path: string): string {
  return path.replace(/^\/+/, "");
}
