#!/usr/bin/env node
/**
 * Generate the gitnexus-bridge CommonJS runtime artifact from its TypeScript source.
 *
 * WHY THIS EXISTS: `index.cjs` used to be a hand-written mirror of `index.ts`,
 * kept in sync by a comment that said "Edit both in lockstep until we add a
 * build step." It drifted, silently and expensively: `index.ts` grew the whole
 * TOOL_OVERRIDES block (agent-facing tool descriptions and guidance) and
 * `index.cjs` — the artifact the plugin host actually loads at runtime — never
 * received any of it. Agents therefore saw upstream GitNexus's own descriptions,
 * which are written for people who already know the product, and the local
 * corrective guidance shipped to nobody. Worse, the same drift class is
 * invisible: both files parse, both files run, and nothing fails.
 *
 * This IS the build step. The runtime artifact is generated, never edited, and
 * `--check` fails the build when the committed artifact does not match what the
 * source would produce (the recurrence guard — same shape as
 * `gen:tool-catalog:check`).
 *
 * Plan: code-intelligence-routing-lsp-gitnexus-2026-08-20, D-004 / P-005.
 *
 * Usage:
 *   node scripts/gen-gitnexus-bridge-runtime.mjs           # write the artifact
 *   node scripts/gen-gitnexus-bridge-runtime.mjs --check    # verify, exit 1 on drift
 */
import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_DIR = join(REPO_ROOT, 'libs/papercusp/plugins/gitnexus-bridge');
const ENTRY = join(PLUGIN_DIR, 'index.ts');
const ARTIFACT = join(PLUGIN_DIR, 'index.cjs');

const BANNER = `"use strict";
/**
 * @papercupai/gitnexus-bridge — GENERATED runtime artifact. DO NOT EDIT.
 *
 * Source of truth: index.ts
 * Regenerate:      npm run gen:gitnexus-bridge
 * Verify:          npm run gen:gitnexus-bridge:check
 *
 * Hand-editing this file reintroduces the source/runtime drift that shipped a
 * bridge whose agent-facing TOOL_OVERRIDES existed only in the TypeScript
 * source and never reached the runtime.
 */`;

/**
 * esbuild's CJS output exposes named exports as getters on `module.exports`.
 * The plugin host expects the historical shape instead: the plugin object
 * ITSELF as module.exports, carrying `.default`, `.tools` and
 * `._resetChildrenForTests`. Normalize in a footer so the generated artifact is
 * a drop-in replacement for the hand-written one.
 */
const FOOTER = `
// --- export-shape interop (see gen-gitnexus-bridge-runtime.mjs) ---
// Builds a FRESH object rather than mutating the bundled plugin. esbuild
// exposes named exports as accessor properties, and some loaders (Vitest's
// module evaluator among them) surface the default export carrying those
// getter-only descriptors — assigning onto it throws at module-load time.
// Copying into a plain object sidesteps loader-dependent descriptors entirely.
{
  const __exported = module.exports;
  const __plugin = __exported.default;
  if (!__plugin || typeof __plugin !== 'object') {
    throw new Error('gitnexus-bridge runtime: expected a default plugin export');
  }
  const __final = Object.assign(
    Object.create(Object.getPrototypeOf(__plugin) || Object.prototype),
    __plugin,
  );
  for (const __k of Object.keys(__exported)) {
    if (__k !== 'default') __final[__k] = __exported[__k];
  }
  __final.default = __final;
  module.exports = __final;
}`;

async function generate() {
const result = await build({
    entryPoints: [ENTRY],
    // Keep esbuild's source-label comments stable when this check runs through
    // `npm --workspace @papercusp/operator-core` (cwd=packages/operator-core)
    // versus the root generator (cwd=REPO_ROOT). Without an explicit working
    // directory those equivalent invocations emit different artifact bytes.
    absWorkingDir: REPO_ROOT,
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    // Node builtins and workspace packages stay external; the bridge's only
    // runtime imports are node: builtins (the plugin-sdk imports are types).
    packages: 'external',
    banner: { js: BANNER },
    footer: { js: FOOTER },
    legalComments: 'none',
  });
  const out = result.outputFiles[0].text;
  if (!out.includes('TOOL_OVERRIDES') && !out.includes('notWhen')) {
    // Guard the guard: if the overrides vanish from the bundle, the artifact
    // would once again ship without agent guidance — the original defect.
    throw new Error('generated artifact contains no tool-guidance content; refusing to write');
  }
  return out;
}

const check = process.argv.includes('--check');
const generated = await generate();

if (check) {
  if (!existsSync(ARTIFACT)) {
    console.error(`✗ ${ARTIFACT} is missing. Run: npm run gen:gitnexus-bridge`);
    process.exit(1);
  }
  const current = await readFile(ARTIFACT, 'utf8');
  if (current !== generated) {
    console.error(
      '✗ gitnexus-bridge runtime artifact is STALE — index.cjs does not match index.ts.\n' +
        '  This is the source/runtime drift class that shipped a bridge with no agent guidance.\n' +
        '  Fix: npm run gen:gitnexus-bridge (never hand-edit index.cjs).',
    );
    process.exit(1);
  }
  console.log('✓ gitnexus-bridge runtime artifact is up to date');
} else {
  await writeFile(ARTIFACT, generated, 'utf8');
  console.log(`✓ wrote ${ARTIFACT} (${generated.length} bytes) from index.ts`);
}
