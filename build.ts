import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const outputFile = "dist/ftpc";

const buildOptions = {
  entrypoints: ["src/index.ts"],
  target: "bun",
  compile: {
    outfile: outputFile,
  },
  throw: false,
} satisfies Bun.BuildConfig;

await mkdir(dirname(outputFile), { recursive: true });

const result = await Bun.build(buildOptions);

for (const log of result.logs) {
  console.error(log);
}

if (!result.success) {
  process.exit(1);
}

console.log(`Built ${outputFile}`);
