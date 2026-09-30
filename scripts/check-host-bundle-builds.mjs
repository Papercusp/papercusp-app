#!/usr/bin/env node
/**
 * GATING guard: the operator host bundle must actually BUILD.
 *
 * WHY (P-009, 2026-07-12): `bin/hono-host.ts` is esbuild-bundled to
 * `dist-host/hono-host.mjs` by apps/operator/bin/bundle-host.sh — which runs as the
 * service's ExecStartPre and during the release deploy, NOT during tests. So a change
 * that breaks the bundle is INVISIBLE to `npm run test:affected`, to tsc, and to the
 * green gate, and only detonates at the next restart — taking :3170 down for the whole
 * fleet and killing the deploy.
 *
 * The trigger that day: voice-node/kokoro-local dynamic-imports @huggingface/transformers,
 * which require()s onnxruntime-node's platform addon via a TEMPLATE specifier
 * (`../bin/napi-v6/${process.platform}/${process.arch}/onnxruntime_binding.node`).
 * esbuild followed it into all five platform binaries and hard-failed with
 * "No loader is configured for .node files". Unit tests were green throughout — they
 * import the module under tsx, which resolves natives natively.
 *
 * This is the same incident CLASS the sibling lints (no-self-referential-export,
 * smart-quotes, conflict-markers) each approximate with a pattern match: "something
 * broke bundle-host.sh, and we only found out at restart". Rather than add a fourth
 * proxy, this guard is the DIRECT detector — it runs the real bundle.
 *
 * Deliberately invokes bundle-host.sh itself (never a reimplementation) so the
 * externals/native list has ONE source of truth and cannot drift from what actually
 * ships. Output goes to a throwaway dir; the live dist-host/ is never touched.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const operatorDir = join(repoRoot, 'apps', 'operator');
const outDir = mkdtempSync(join(tmpdir(), 'papercusp-host-bundle-check-'));
const outFile = join(outDir, 'hono-host.mjs');

// WI-38221 host-bundle SIZE budget, checked on the bundle this guard already
// builds (so it costs no extra build).
//
// WHY: every MB of this bundle costs ~1 MB of resident off-heap SOURCE STRING in
// EVERY host process. The ascii-escape pass (bin/ascii-escape-bundle.mjs) keeps
// that string one-byte-per-char, which makes the cost ~1:1 with file size and
// ~17x box-wide across the 17 host processes here — so this is real memory, not
// disk. The 2026-08-12 trim took the bundle 61.2 -> 36.4 MB; NOTHING guarded that
// gain, and by 2026-09-05 it had grown back to 54.1 MB (+17.7 MB over 24 days)
// with no detector. check-bundle-budget.mjs is NOT this check: it budgets the
// operator-vite CLIENT eager bundle and explicitly declines to budget server dist
// size.
//
// The budget is a RATCHET WITH HEADROOM, not the baseline. Organic growth here has
// outpaced a single-dependency leak (typescript alone is 9.6 MB), so no threshold
// can separate "leak" from "growth" by size alone. This exists to (a) cap unbounded
// growth and (b) PRINT the size on every run, so erosion is visible instead of
// being rediscovered months later. A breach is often legitimate growth — diagnose
// first, then re-baseline deliberately.
const HOST_BUNDLE_BUDGET_BYTES = 68 * 1024 * 1024;
const HOST_BUNDLE_POST_TRIM_BASELINE_MB = 36.4;
const HOST_PROCESS_COUNT = 17;

let failed = false;
let bundleBytes = null;
try {
  execFileSync('bash', [join(operatorDir, 'bin', 'bundle-host.sh'), 'bin/hono-host.ts', outFile], {
    cwd: operatorDir,
    stdio: 'pipe',
    encoding: 'utf8',
    env: process.env,
  });
  console.log('✓ host bundle builds (bin/hono-host.ts → esbuild)');

  // Measured here because `finally` deletes outDir; the size VERDICT is rendered
  // after the try/catch so a budget breach never inherits the build-failure
  // handler's (wrong) "this WILL take :3170 down at the next restart" diagnosis.
  bundleBytes = statSync(outFile).size;

  const runnerSource = join(repoRoot, 'packages', 'operator-core', 'lib', 'systemd-scope-env-runner.mjs');
  const runnerOutput = join(outDir, 'systemd-scope-env-runner.mjs');
  if (!existsSync(runnerOutput)) {
    throw new Error(`systemd scope environment runner was not published at ${runnerOutput}`);
  }
  if (readFileSync(runnerOutput, 'utf8') !== readFileSync(runnerSource, 'utf8')) {
    throw new Error('published systemd scope environment runner differs from its source');
  }
  console.log('✓ systemd scope environment runner is published beside the host bundle');
} catch (err) {
  failed = true;
  const out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  const detail = out || (err instanceof Error ? err.message : String(err));
  const errorLines = out.split('\n').filter((l) => /✘|\[ERROR\]|No loader is configured/.test(l));
  console.error('✘ HOST BUNDLE FAILED TO BUILD — this WILL take :3170 down at the next restart');
  console.error('  and break the release deploy. It is invisible to unit tests by construction.\n');
  console.error(errorLines.length ? errorLines.slice(0, 20).join('\n') : detail.slice(-4000));
  console.error(
    '\nMost common cause: a new import pulled a package with a NATIVE (.node) addon into the\n' +
      'host graph. Fix by adding that package to NATIVE_PKGS in apps/operator/bin/bundle-host.sh\n' +
      '(and papercusp-desktop/bin/build-desktop-sidecar.sh, which ships the packaged app) so it\n' +
      'stays external and resolves from node_modules at runtime.',
  );
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

// Size verdict. Separate from the build try/catch on purpose: a budget breach is
// not a build failure and must not be reported as one.
if (!failed && bundleBytes !== null) {
  const mb = bundleBytes / 1024 / 1024;
  const budgetMb = HOST_BUNDLE_BUDGET_BYTES / 1024 / 1024;
  const sinceBaseline = (mb - HOST_BUNDLE_POST_TRIM_BASELINE_MB).toFixed(1);
  const boxWideGb = ((mb * HOST_PROCESS_COUNT) / 1024).toFixed(2);

  if (bundleBytes > HOST_BUNDLE_BUDGET_BYTES) {
    failed = true;
    console.error(
      `\n✘ host bundle is ${mb.toFixed(2)} MB — over the ${budgetMb.toFixed(2)} MB budget ` +
        `(WI-38221 post-trim baseline ${HOST_BUNDLE_POST_TRIM_BASELINE_MB} MB).\n\n` +
        `This is MEMORY, not disk: the bundle source stays resident one-byte-per-char in\n` +
        `each of the ~${HOST_PROCESS_COUNT} host processes — about ${boxWideGb} GB box-wide at this size.\n\n` +
        `FIRST look for a leak: a heavy package that became reachable from the host graph.\n` +
        `The lever that works is --external: in apps/operator/bin/bundle-host.sh (a\n` +
        `source-level \`await import()\` does NOT help — esbuild inlines dynamic imports\n` +
        `into the same bundle unless --splitting).\n\n` +
        `If the growth is legitimate, re-baseline DELIBERATELY: raise\n` +
        `HOST_BUNDLE_BUDGET_BYTES in this file and say why in the commit message.`,
    );
  } else {
    console.log(
      `✓ host bundle ${mb.toFixed(2)} MB (budget ${budgetMb.toFixed(2)} MB; ` +
        `WI-38221 post-trim baseline ${HOST_BUNDLE_POST_TRIM_BASELINE_MB} MB, ` +
        `+${sinceBaseline} MB since; ~${boxWideGb} GB across ${HOST_PROCESS_COUNT} host processes)`,
    );
  }
}

process.exit(failed ? 1 : 0);
