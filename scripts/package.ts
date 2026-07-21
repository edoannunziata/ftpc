import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

interface ReleaseTarget {
  target: string;
  platform: "linux" | "darwin" | "windows";
  arch: "x64" | "arm64";
  executableName: "ftpc" | "ftpc.exe";
}

const releaseTargets: ReleaseTarget[] = [
  {
    target: "bun-linux-x64",
    platform: "linux",
    arch: "x64",
    executableName: "ftpc",
  },
  {
    target: "bun-linux-arm64",
    platform: "linux",
    arch: "arm64",
    executableName: "ftpc",
  },
  {
    target: "bun-darwin-x64",
    platform: "darwin",
    arch: "x64",
    executableName: "ftpc",
  },
  {
    target: "bun-darwin-arm64",
    platform: "darwin",
    arch: "arm64",
    executableName: "ftpc",
  },
  {
    target: "bun-windows-x64-baseline",
    platform: "windows",
    arch: "x64",
    executableName: "ftpc.exe",
  },
  {
    target: "bun-windows-arm64",
    platform: "windows",
    arch: "arm64",
    executableName: "ftpc.exe",
  },
];

function usage(): string {
  return `Usage:
  bun run scripts/package.ts [--target bun-linux-x64] [--outdir dist/packages]
  bun run scripts/package.ts --all [--outdir dist/packages]

Targets:
  ${releaseTargets.map((target) => target.target).join("\n  ")}`;
}

function currentTarget(): ReleaseTarget {
  const platform = process.platform;
  const arch = process.arch;
  const target = releaseTargets.find(
    (candidate) =>
      (candidate.platform === platform ||
        (candidate.platform === "windows" && platform === "win32")) &&
      candidate.arch === arch,
  );
  if (target === undefined) {
    throw new Error(`Unsupported local platform: ${platform}-${arch}`);
  }
  return target;
}

function parseArgs(argv: string[]): {
  outdir: string;
  targets: ReleaseTarget[];
} {
  let outdir = "dist/packages";
  let targetName: string | undefined;
  let all = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      break;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--all") {
      all = true;
      continue;
    }
    if (arg === "--outdir") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("--outdir requires a value");
      }
      outdir = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--outdir=")) {
      outdir = arg.slice("--outdir=".length);
      continue;
    }
    if (arg === "--target") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("--target requires a value");
      }
      targetName = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--target=")) {
      targetName = arg.slice("--target=".length);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (all && targetName !== undefined) {
    throw new Error("--all and --target cannot be used together");
  }

  if (all) {
    return { outdir, targets: releaseTargets };
  }

  if (targetName !== undefined) {
    const normalizedTargetName = targetName.startsWith("bun-")
      ? targetName
      : `bun-${targetName}`;
    const target = releaseTargets.find(
      (candidate) => candidate.target === normalizedTargetName,
    );
    if (target === undefined) {
      throw new Error(`Unsupported target: ${targetName}`);
    }
    return { outdir, targets: [target] };
  }

  return { outdir, targets: [currentTarget()] };
}

function spawnOrThrow(cmd: string[], cwd = process.cwd()): void {
  const result = Bun.spawnSync({
    cmd,
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  if (result.exitCode !== 0) {
    throw new Error(`Command failed (${result.exitCode}): ${cmd.join(" ")}`);
  }
}

async function sha256(path: string): Promise<string> {
  const bytes = await Bun.file(path).arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function buildTargetArg(target: ReleaseTarget): string {
  return target.target === currentTarget().target ? "bun" : target.target;
}

const { outdir, targets } = parseArgs(process.argv.slice(2));
const outputDir = resolve(outdir);
const workDir = join(outputDir, ".work");

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });

const checksums: string[] = [];

for (const target of targets) {
  const packageName = `ftpc-${target.platform}-${target.arch}`;
  const packageRoot = join(workDir, packageName);
  const binaryPath = join(packageRoot, target.executableName);
  const archivePath = join(outputDir, `${packageName}.tar.gz`);

  mkdirSync(packageRoot, { recursive: true });

  spawnOrThrow([
    "bun",
    "build",
    "--compile",
    "--external=cpu-features",
    `--target=${buildTargetArg(target)}`,
    "src/index.ts",
    "--outfile",
    binaryPath,
  ]);

  chmodSync(binaryPath, 0o755);
  copyFileSync("LICENSE", join(packageRoot, "LICENSE"));
  copyFileSync("README.md", join(packageRoot, "README.md"));

  spawnOrThrow(["tar", "-czf", archivePath, "-C", workDir, packageName]);
  checksums.push(`${await sha256(archivePath)}  ${basename(archivePath)}`);
}

writeFileSync(join(outputDir, "checksums.txt"), `${checksums.join("\n")}\n`);
rmSync(workDir, { recursive: true, force: true });

for (const checksum of checksums) {
  console.log(checksum);
}
