#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const tests = process.argv.slice(2);
if (tests.length === 0) {
  console.error("run-gate requires at least one Vitest path");
  process.exit(2);
}

const env = { ...process.env };
const materializedConfig = resolve("checks-config.json");
if (!env.TEMPLATE_CHECKS_CONFIG && existsSync(materializedConfig)) {
  env.TEMPLATE_CHECKS_CONFIG = materializedConfig;
}

const result = spawnSync(
  process.execPath,
  [resolve("node_modules/vitest/vitest.mjs"), "run", ...tests],
  { env, stdio: "inherit" },
);
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
