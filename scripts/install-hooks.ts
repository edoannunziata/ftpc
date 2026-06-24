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

if (
  currentHooksPath.exitCode === 0 &&
  new TextDecoder().decode(currentHooksPath.stdout).trim() === ".githooks"
) {
  process.exit(0);
}

const install = Bun.spawnSync({
  cmd: ["git", "config", "core.hooksPath", ".githooks"],
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

process.exit(install.exitCode);
