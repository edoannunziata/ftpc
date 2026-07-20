import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

interface ProjectPackage {
  name: string;
  version: string;
  description: string;
  license: string;
  repository: { type: string; url: string };
  homepage: string;
  bugs: { url: string };
}

interface NativeTarget {
  packageName: string;
  target: Bun.Build.Target;
  os: "darwin" | "linux" | "win32";
  cpu: "arm64" | "x64";
  libc?: "glibc" | "musl";
  executableName: "ftpc" | "ftpc.exe";
}

const nativeTargets: NativeTarget[] = [
  {
    packageName: "ftpc-darwin-arm64",
    target: "bun-darwin-arm64",
    os: "darwin",
    cpu: "arm64",
    executableName: "ftpc",
  },
  {
    packageName: "ftpc-darwin-x64",
    target: "bun-darwin-x64",
    os: "darwin",
    cpu: "x64",
    executableName: "ftpc",
  },
  {
    packageName: "ftpc-linux-arm64",
    target: "bun-linux-arm64",
    os: "linux",
    cpu: "arm64",
    libc: "glibc",
    executableName: "ftpc",
  },
  {
    packageName: "ftpc-linux-arm64-musl",
    target: "bun-linux-arm64-musl",
    os: "linux",
    cpu: "arm64",
    libc: "musl",
    executableName: "ftpc",
  },
  {
    packageName: "ftpc-linux-x64",
    target: "bun-linux-x64-baseline",
    os: "linux",
    cpu: "x64",
    libc: "glibc",
    executableName: "ftpc",
  },
  {
    packageName: "ftpc-linux-x64-musl",
    target: "bun-linux-x64-musl",
    os: "linux",
    cpu: "x64",
    libc: "musl",
    executableName: "ftpc",
  },
  {
    packageName: "ftpc-windows-arm64",
    target: "bun-windows-arm64",
    os: "win32",
    cpu: "arm64",
    executableName: "ftpc.exe",
  },
  {
    packageName: "ftpc-windows-x64",
    target: "bun-windows-x64-baseline",
    os: "win32",
    cpu: "x64",
    executableName: "ftpc.exe",
  },
];

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function run(command: string[]): void {
  const result = Bun.spawnSync({
    cmd: command,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Command failed (${result.exitCode}): ${command.join(" ")}`,
    );
  }
}

const projectPackage = (await Bun.file(
  "package.json",
).json()) as ProjectPackage;
const outputDir = resolve("dist/npm");

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });

for (const target of nativeTargets) {
  const packageDir = join(outputDir, target.packageName);
  const binDir = join(packageDir, "bin");
  const executablePath = join(binDir, target.executableName);
  mkdirSync(binDir, { recursive: true });

  run([
    "bun",
    "build",
    "--compile",
    `--target=${target.target}`,
    "src/index.ts",
    "--outfile",
    executablePath,
  ]);
  chmodSync(executablePath, 0o755);

  writeJson(join(packageDir, "package.json"), {
    name: target.packageName,
    version: projectPackage.version,
    description: `Native ftpc executable for ${target.os}-${target.cpu}${target.libc === undefined ? "" : `-${target.libc}`}.`,
    license: projectPackage.license,
    os: [target.os],
    cpu: [target.cpu],
    ...(target.libc === undefined ? {} : { libc: [target.libc] }),
    bin: { ftpc: `./bin/${target.executableName}` },
    files: ["bin"],
    repository: projectPackage.repository,
    homepage: projectPackage.homepage,
    bugs: projectPackage.bugs,
    publishConfig: {
      access: "public",
      provenance: true,
      registry: "https://registry.npmjs.org/",
    },
  });
  copyFileSync("LICENSE", join(packageDir, "LICENSE"));
}

const launcherDir = join(outputDir, projectPackage.name);
const launcherBinDir = join(launcherDir, "bin");
mkdirSync(launcherBinDir, { recursive: true });
copyFileSync("scripts/npm-launcher.js", join(launcherBinDir, "ftpc.js"));
chmodSync(join(launcherBinDir, "ftpc.js"), 0o755);
copyFileSync("LICENSE", join(launcherDir, "LICENSE"));
copyFileSync("README.md", join(launcherDir, "README.md"));

writeJson(join(launcherDir, "package.json"), {
  name: projectPackage.name,
  version: projectPackage.version,
  description: projectPackage.description,
  type: "module",
  license: projectPackage.license,
  bin: { ftpc: "./bin/ftpc.js" },
  files: ["bin"],
  engines: { node: ">=18", npm: ">=9" },
  optionalDependencies: Object.fromEntries(
    nativeTargets.map((target) => [target.packageName, projectPackage.version]),
  ),
  repository: projectPackage.repository,
  homepage: projectPackage.homepage,
  bugs: projectPackage.bugs,
  publishConfig: {
    access: "public",
    provenance: true,
    registry: "https://registry.npmjs.org/",
  },
});

console.log(`Created ${nativeTargets.length + 1} npm packages in ${outputDir}`);
