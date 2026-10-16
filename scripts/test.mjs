// Bundles each tests/*.test.ts with esbuild and runs it under node:test, so lib code needs no loader.
import { build } from "esbuild";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = new URL("..", import.meta.url).pathname;
const out = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "composer-tests-"));
try {
  const entries = readdirSync(join(root, "tests")).filter((name) => name.endsWith(".test.ts"));
  await build({
    entryPoints: entries.map((name) => join(root, "tests", name)),
    outdir: out,
    bundle: true,
    platform: "node",
    format: "esm",
    outExtension: { ".js": ".mjs" },
    logLevel: "warning",
  });
  const files = entries.map((name) => join(out, name.replace(/\.ts$/, ".mjs")));
  const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(out, { recursive: true, force: true });
}
