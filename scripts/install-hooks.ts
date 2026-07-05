const hooksPath = ".githooks";
const decoder = new TextDecoder();

const gitDir = Bun.spawnSync({
  cmd: ["git", "rev-parse", "--git-dir"],
  stdout: "pipe",
  stderr: "pipe",
});

if (gitDir.exitCode !== 0) {
  process.exit(0);
}

const currentHooksPath = Bun.spawnSync({
  cmd: ["git", "config", "--get", "core.hooksPath"],
  stdout: "pipe",
  stderr: "pipe",
});

if (currentHooksPath.exitCode === 0) {
  const configuredHooksPath = decoder.decode(currentHooksPath.stdout).trim();

  if (configuredHooksPath === hooksPath) {
    process.exit(0);
  }

  console.warn(
    `Not installing ${hooksPath} because core.hooksPath is already set to ${configuredHooksPath}.`,
  );
  process.exit(0);
}

const install = Bun.spawnSync({
  cmd: ["git", "config", "core.hooksPath", hooksPath],
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

process.exit(install.exitCode);
