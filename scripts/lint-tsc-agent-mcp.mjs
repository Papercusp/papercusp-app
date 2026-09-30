#!/usr/bin/env node
/**
 * typecheck (agent-mcp) — the shared per-file baseline gate for the agent-mcp package.
 *
 * `npm run test` uses Vitest/esbuild and is intentionally type-blind. The package's direct
 * project compile also follows source-only workspace links into operator-core, so a raw `tsc`
 * result contains standing diagnostics from that graph. Keep those measured and visible in a
 * committed per-file baseline while failing on any new diagnostic in the graph. The operator-core
 * baseline is inherited for files that this gate does not own, avoiding a second hand-maintained
 * copy of its standing debt.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runTscBaselineGate } from './lib/tsc-baseline-gate.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baselineFile = resolve(ROOT, 'packages/agent-mcp/.tsc-baseline.json');

// A fresh compiler run is required: a warm tsbuildinfo can under-report errors and silently
// ratchet a baseline down (EI-487).
/** @type {string} */
export const TSC_COMMAND =
  'npx tsc -p packages/agent-mcp/tsconfig.json --noEmit --incremental false';

/** @type {{prefix:string, baselineFile:string, label:string}[]} */
export const FOREIGN_BASELINES = [
  {
    prefix: 'packages/operator-core/',
    baselineFile: resolve(ROOT, 'packages/operator-core/.tsc-baseline.json'),
    label: 'operator-core',
  },
];

async function main() {
  await runTscBaselineGate({
    root: ROOT,
    tscCommand: TSC_COMMAND,
    baselineFile,
    label: 'agent-mcp',
    argv: process.argv.slice(2),
    foreignBaselines: FOREIGN_BASELINES,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    // A failed or interrupted measurement is never a typecheck pass.
    console.error(err);
    process.exit(1);
  });
}
