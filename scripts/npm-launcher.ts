#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

type Libc = "glibc" | "musl";
type PackageTarget = readonly [packageName: string, executableName: string];
interface ProcessReport {
  header: { glibcVersionRuntime?: string };
}

function linuxLibc(): Libc {
  try {
    const report = process.report.getReport() as ProcessReport;
    return report.header.glibcVersionRuntime ? "glibc" : "musl";
  } catch {
    return "glibc";
  }
}

function currentTarget(): PackageTarget | undefined {
  const suffix =
    process.platform === "linux"
      ? `${process.platform}-${process.arch}-${linuxLibc()}`
      : `${process.platform}-${process.arch}`;

  const targets: Record<string, PackageTarget> = {
    "darwin-arm64": ["ftpc-darwin-arm64", "ftpc"],
    "darwin-x64": ["ftpc-darwin-x64", "ftpc"],
    "linux-arm64-glibc": ["ftpc-linux-arm64", "ftpc"],
    "linux-arm64-musl": ["ftpc-linux-arm64-musl", "ftpc"],
    "linux-x64-glibc": ["ftpc-linux-x64", "ftpc"],
    "linux-x64-musl": ["ftpc-linux-x64-musl", "ftpc"],
    "win32-arm64": ["ftpc-windows-arm64", "ftpc.exe"],
    "win32-x64": ["ftpc-windows-x64", "ftpc.exe"],
  };

  return targets[suffix];
}

const target = currentTarget();
if (target === undefined) {
  console.error(
    `ftpc does not provide a native executable for ${process.platform}-${process.arch}.`,
  );
  process.exit(1);
}

const [packageName, executableName] = target;
let executablePath: string;
try {
  const packageJsonPath = require.resolve(`${packageName}/package.json`);
  executablePath = join(dirname(packageJsonPath), "bin", executableName);
} catch {
  console.error(
    `The native ftpc package ${packageName} is missing. Reinstall ftpc without --omit=optional.`,
  );
  process.exit(1);
}

const result = spawnSync(executablePath, process.argv.slice(2), {
  stdio: "inherit",
});

if (result.error !== undefined) {
  console.error(`Failed to start ftpc: ${result.error.message}`);
  process.exit(1);
}

if (result.signal !== null) {
  process.kill(process.pid, result.signal);
} else {
  process.exit(result.status ?? 1);
}
