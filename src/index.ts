export * from "./types.ts";
export * from "./errors.ts";
export * from "./config.ts";
export * from "./url.ts";
export * from "./storage.ts";
export { LocalClient } from "./clients/local.ts";
export { main } from "./cli.ts";

import { main } from "./cli.ts";

if (import.meta.main) {
  const exitCode = await main();
  process.exitCode = exitCode;
}
