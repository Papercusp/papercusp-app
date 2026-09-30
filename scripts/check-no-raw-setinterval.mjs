#!/usr/bin/env node
/**
 * check-no-raw-setinterval.mjs — fail-loud guard against NEW bare setInterval()
 * (schedule-inventory-and-ephemeral-tier-2026-06-26, P-007).
 *
 * Every recurring timer in the operator host must go through `managedSetInterval`
 * (@papercusp/scheduled-registry) so it is NAMED + LISTABLE in schedule:inventory —
 * the "see EVERYTHING running on a timer" guarantee. A bare `setInterval(...)` is
 * runtime-INVISIBLE. This guard fails the build when a NEW bare setInterval appears
 * outside the allowed sites, so the universal-visibility ratchet (the P-008 codemod)
 * can't silently erode back.
 *
 * visibility != control: registering a timer does NOT centralize its scheduling — a
 * watchdog still runs as its own out-of-band interval; it just calls
 * `managedSetInterval(name, ms, fn, { category: 'watchdog' })` so it's listed.
 *
 *   node scripts/check-no-raw-setinterval.mjs
 *
 * EXCLUDED (never scanned): vendored / build output / _retired / tests / non-source
 *   AND .tsx — browser/renderer timers run in the webview, not the host, and cannot
 *   reach the server-side registry (UI-timer visibility is a separate client concern).
 *
 * ALLOWLIST_DIRS (permanently allowed): the registry impl itself (its default timer
 *   seam IS setInterval) + libs/generic/* libraries that keep their own timers (sse,
 *   tooldef) — domain-free, must NOT depend on operator-core's registry (layering).
 *
 * BASELINE (TEMPORARY — must shrink to EMPTY): operator-host files that still call bare
 *   setInterval pending the P-008 codemod. NEW files may NOT be added here. P-008
 *   migrates each to managedSetInterval (remove from BASELINE) or, if it is genuinely a
 *   separate-process / generic site, promotes it into ALLOWLIST_DIRS / ALLOWLIST.
 *
 * The predicate (usesRawSetInterval) is exported + unit-tested
 * (packages/operator-core/lib/dbos/no-raw-setinterval-guard.test.ts) so the
 * "fails on a NEW bare setInterval" property is durably verified, not only
 * green-on-clean-tree.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { describeUnscanned, listTrackedFiles } from './lib/tracked-files.mjs';
import { stripCommentsAndStrings } from './lib/strip-comments-and-strings.mjs';

const ROOT = new URL('..', import.meta.url).pathname;

/** Permanently-allowed directory prefixes (the registry impl + generic libs with own timers). */
export const ALLOWLIST_DIRS = [
  'libs/generic/scheduled-registry/', // the wrapper itself — its default seam is setInterval
  'libs/generic/sse/', // generic SSE lib: keeps its own heartbeat/reaper timers (can't import operator-core)
  'libs/generic/tooldef/', // generic tool-dispatch lib: own GC/idle timers
  'libs/generic/p2p-voice/', // generic voice lib: own per-session timers (domain-free)
  'packages/operator-core/lib/external-bench/', // bench harness — per-run samplers/heartbeats, not host timers
  'packages/operator-core/lib/deployment/p2p-perf-tier3/', // perf-test CHILD processes
  'packages/operator-core/lib/sync/hyperbee/perf/', // perf-test measurement processes
  'apps/operator/scripts/', // standalone .mjs processes (psu-launcher/pty-host, bghost-watchdog) — separate procs
  'libs/testing-shell/', // test-shell RUNNER processes (stagehand-runner) — own process per run, no host registry
  // Standalone test-infrastructure SUBMODULE (github.com/Papercusp/test-config). Its only
  // timer is the embedded-PG template-builder heartbeat in src/pg-migrate.ts, armed in the
  // TEST-RUNNER process rather than the operator host — so a registry entry would land in a
  // separate per-process inventory that `schedule:inventory` never serves, the same
  // structural unreachability already recorded for scripts/lib/governed-test-process.mjs
  // and libs/testing-shell/. It also cannot import @papercusp/scheduled-registry without
  // taking a NEW cross-repo dependency on operator-core (its package.json declares none) —
  // the same layering constraint the libs/generic/* entries above record. The timer is
  // unref()'d and cleared by the stopper startTemplateBuilderHeartbeat returns.
  'libs/test-config/',
];

/**
 * BROWSER/CLIENT `.ts` — run in the webview, not the host; cannot reach the server-side
 * registry (verified client-side: window./document./useEffect/MediaRecorder).
 *
 * SPLIT OUT AS ITS OWN EXPORT DELIBERATELY (P-026): these files are exempt HERE only
 * because they are HANDED OFF to `check-timer-classification.mjs`, whose CLIENT scan
 * classifies them instead — this guard asks "is it visible in schedule:inventory?", a
 * question a renderer timer structurally cannot answer. A file that leaves this guard
 * without arriving at that one is checked by NEITHER, which is a silent hole rather than
 * a loud failure.
 *
 * The handoff is therefore an INVARIANT, asserted by `client-timer-classification.test.ts`:
 * every entry here must also be in that guard's CLIENT_TS_FILES. Membership is a named
 * SET rather than a comment section because the previous arrangement encoded "is this
 * browser/client?" as *comment placement* — two of these entries already sit under the
 * "Separate processes" heading with their own inline `// browser ...` note, so any check
 * that read the section header would have mis-partitioned them. Anchor the property to a
 * declaration, never to how a comment happens to be spelled (CLAUDE.md § shared-lib
 * singletons documents three population corrections caused by exactly that mistake).
 */
export const BROWSER_CLIENT_ALLOWLIST = new Set([
  'apps/operator/app/_components/SetupWizard/useWizardStatuses.ts',
  'apps/operator/app/_components/voice/voice-leader.ts',
  'apps/operator/app/admin/plans/plans-api.ts',
  'apps/operator/app/admin/testing/_lib/vitals-recorder.ts',
  'apps/operator/lib/ui/use-ui-presence.ts',
  'apps/operator-vite/src/lib/video/camera-capture.ts',
  'packages/operator-core/lib/voice-engines/deepgram.ts', // browser STT adapter — window.setInterval + MediaRecorder, runs in the webview not the host
  'apps/operator/app/_components/useWslGateBlocking.ts', // browser hook -- window.setInterval polling wsl_status in the webview, not the host
  'packages/operator-core/lib/operator-window-sync.ts', // browser cross-window localStorage sync (lease heartbeat) -- window/StorageEvent, only imported by OperatorConversationProvider.tsx; not a host timer
]);

/**
 * Separate processes that don't share the operator registry. NOT handed off to the
 * client scan — these are host-SHAPED, just in another process, so no other guard
 * covers them and none should.
 */
export const SEPARATE_PROCESS_ALLOWLIST = new Set([
  'packages/operator-core/lib/deployment/cross-hive-frame.ts', // cross-hive e2e spike child process
  'packages/operator-core/lib/inference-gateway/gateway.ts', // runs INSIDE the :8788 inference-gateway process
  'packages/operator-core/lib/inference-gateway/launch.ts', // :8788 gateway process bootstrap
  'packages/operator-core/lib/inference-gateway/watchdog.mjs', // standalone systemd watchdog for the gateway
  'apps/operator/lib/mcp-proxy/watchdog.mjs', // standalone systemd watchdog for mcp-proxy -- plain node, no TS imports (deliberately dependency-free, same class as inference-gateway/watchdog.mjs)
  // The plain-Node bridge used by the two test CLIs (scripts/test-files.mjs,
  // scripts/affected-tests.mjs). Its own header states the constraint: these
  // entrypoints must stay executable by bare `node scripts/*.mjs` for packaged
  // installs where a project-wide TS loader is not an option, so it registers
  // tsx LAZILY and only when a real child is about to start. A static import of
  // @papercusp/scheduled-registry (whose package main is a .ts file) would break
  // exactly that case. The timer is also armed in the TEST-RUNNER process, not
  // the operator host, so its registry entry would land in a separate
  // per-process inventory that `schedule:inventory` never serves — the same
  // structural unreachability recorded for event-loop-sentinel.worker.ts. Its
  // in-host twin (createTestProcessDemandSampler in agent-tools/testing/run.ts)
  // IS registered via managedSetInterval. [P-018]
  'scripts/lib/governed-test-process.mjs',
]);

/** Permanently-allowed individual files (rare; prefer ALLOWLIST_DIRS). */
export const ALLOWLIST = new Set([
  // This guard itself: its console messages + the detection regex literally contain
  // "setInterval(" (the thing it bans), exactly as check-no-raw-agent-spawn allowlists
  // its own definition site.
  'scripts/check-no-raw-setinterval.mjs',
  // Its sibling guard's CLIENT scan (P-026) carries the literal detection regex
  // `setInterval\s*\(` as CODE, not prose — so stripComments() cannot remove it and the
  // textual scan flags the guard that exists to police this very pattern. This is the
  // exact reciprocal of the entry check-timer-classification.mjs already keeps for THIS
  // file; the pair of guards must allowlist each other or each reds on the other's
  // detector. Added when the client scan landed (2026-08-09) left this lint red.
  'scripts/check-timer-classification.mjs',
  // worker_threads BODY — runs on the worker's own event loop, so registering there
  // buys nothing this guard is asking for. MEASURED 2026-08-04: the registry's state
  // is pinned per-isolate, so a managedSetInterval call inside a Worker succeeds but
  // lands in a SEPARATE per-thread registry — the worker sees ["probe-worker"] while
  // the main thread sees only ["probe-main"]. `schedule:inventory` is served by the
  // main process, so the timer would still be invisible there; the guard's stated
  // purpose ("NAMED + visible in schedule:inventory") is structurally unreachable
  // from a worker. Importing the registry here would also add a main-thread-shaped
  // dependency to the one component whose whole job is to keep running when the main
  // thread cannot. Same rationale as the ALLOWLIST_DIRS "separate procs" entries.
  'packages/operator-core/lib/event-loop-sentinel.worker.ts',
  ...BROWSER_CLIENT_ALLOWLIST,
  ...SEPARATE_PROCESS_ALLOWLIST,
]);

/**
 * Was EMPTY at P-008 (2026-06-28) — every operator-host bare setInterval had been
 * migrated to managedSetInterval (or, for genuine separate-process / browser / generic
 * sites, promoted into ALLOWLIST_DIRS / ALLOWLIST). This grandfather set was seeded with
 * 74 files at P-007 and shrank to empty as the codemod landed. It MUST shrink back to
 * empty: a NEW bare setInterval is a hard guard failure, not a BASELINE addition — that
 * is the whole universal-visibility ratchet. Do NOT add entries for new code.
 *
 * RE-SEEDED WITH ONE PRE-EXISTING SITE (WI-6730, 2026-08-01). "Empty" was only ever true
 * of the subtree this guard could SEE: it enumerated with a bare `git ls-files`, which
 * does not recurse into submodules, so all 39 of them — including libs/papercusp — were
 * never scanned. Switching to the recursing enumerator did not introduce this timer; it
 * revealed one that had been invisible since P-007. It is grandfathered here, not
 * allowlisted, because it is a genuine host-side violation that SHOULD be migrated:
 *
 *   libs/papercusp/packages/locks/src/workspace-listener.ts — startBackgroundJanitor()'s
 *   recurring sweep, armed by inWorkspaceTxn on the first mutating locks:* op in a
 *   non-test process. Migrating it needs a new cross-submodule dependency edge
 *   (@papercusp/scheduled-registry into libs/papercusp/packages/locks, whose deps are
 *   currently just @papercusp/file-claim + @papercusp/locks-core) — a deliberate
 *   architectural change, not a drive-by rewrite, so it is tracked separately rather
 *   than bundled into the enumerator fix.
 */
export const BASELINE = new Set([]);

export const isExcluded = (f) =>
  f.startsWith('_retired/') ||
  f.includes('/_retired/') ||
  f.includes('/node_modules/') ||
  f.includes('/dist/') ||
  f.includes('/.next/') ||
  f.includes('/build/') ||
  f.includes('/storybook-static/') ||
  f.includes('/code-server/') ||
  // WI-6730: bundled sidecar BUILD OUTPUT (esbuild-minified serve.mjs), not source.
  // Only became reachable when the enumerator started recursing into submodules
  // (papercusp-desktop); the sibling guards already carried this exclusion.
  f.includes('/env-sidecars/') ||
  // P-026: TRACKED build output, same class as `/dist/` above — the `-sidecar` suffix
  // means the existing `/dist/` substring does not match it. Holds the compiled copy of
  // event-loop-sentinel.worker.ts, whose SOURCE is already in ALLOWLIST for the
  // worker_threads reason, so flagging the artifact re-litigates a settled exemption
  // against a file no one edits. Committed 2026-08-08; the guard went red on it the
  // moment it landed and stayed red, unnoticed, because this lint runs only in CI on
  // `main` and green-checkpoint does not carry it as a leg.
  f.includes('/dist-sidecar/') ||
  f.includes('/spa/assets/') ||
  f.includes('/holepunch-spike/') ||
  /\.(test|spec)\.[cm]?tsx?$/.test(f) ||
  f.endsWith('.tsx') || // browser/renderer timers — webview, not the host; separate concern
  !/\.(ts|mjs|cjs)$/.test(f);

/** Strip block (/* *​/, incl. JSDoc) + line (//) comments so a prose mention of setInterval() isn't flagged. */
// Implementation moved to ./lib/strip-comments-and-strings.mjs — ONE shared stripper
// (EI-19991116787260658). It also strips STRING LITERALS, which the local copy did not:
// `setInterval(` quoted in prose inside a string read as a real call site. This guard's
// own comment above already reasoned about the code-vs-prose distinction; the shared
// stripper is what finally makes that reasoning true for strings as well as comments.

/**
 * The tell: a CALL to `setInterval(...)`. Case-sensitive lowercase `setInterval`
 * followed by optional whitespace + `(` — so it does NOT match `managedSetInterval(`
 * (capital S), `setIntervalImpl(` / `setIntervalFn(` (followed by Impl/Fn, not `(`),
 * or `typeof setInterval` (followed by `>`/`,`). Comments are stripped first. Pure
 * (text → boolean) so it's unit-testable.
 */
export function usesRawSetInterval(text, fileName) {
  return /\bsetInterval\s*\(/.test(stripCommentsAndStrings(text, fileName));
}

/**
 * Scan the tracked tree for offenders (excludes vendored/tests/.tsx + ALLOWLIST + BASELINE).
 *
 * WI-6730: enumerates via the shared `listTrackedFiles` helper, which recurses
 * into submodules. A bare `git ls-files` does NOT — it emits one gitlink entry
 * per submodule — so this guard previously printed ✓ for all 39 of them,
 * including libs/papercusp, where an unlisted host timer was sitting. Returns
 * the coverage report alongside the offenders so `main` can state what it could
 * not check instead of implying a clean tree.
 */
export function findOffenders() {
  const { files: tracked, unscanned } = listTrackedFiles(ROOT);

  const offenders = [];
  for (const f of tracked) {
    if (isExcluded(f)) continue;
    if (ALLOWLIST.has(f) || BASELINE.has(f)) continue;
    if (ALLOWLIST_DIRS.some((p) => f.startsWith(p))) continue;
    let text;
    try {
      text = readFileSync(new URL(f, `file://${ROOT}`), 'utf8');
    } catch {
      continue;
    }
    if (usesRawSetInterval(text, f)) offenders.push(f);
  }
  return { offenders, unscanned };
}

function main() {
  const { offenders, unscanned } = findOffenders();
  if (offenders.length === 0) {
    const note = BASELINE.size > 0 ? ` (${BASELINE.size} file(s) still in the shrink-to-empty BASELINE — P-008)` : '';
    console.log(
      `✓ no NEW bare setInterval() — every operator-host timer goes through managedSetInterval${note}.` +
        describeUnscanned(unscanned),
    );
    process.exit(0);
  }
  console.error('✗ NEW bare setInterval() call(s) outside the scheduled-registry:');
  console.error('  Use managedSetInterval(name, intervalMs, fn, { category }) from @papercusp/scheduled-registry');
  console.error('  so the timer is NAMED + visible in schedule:inventory (visibility != control —');
  console.error('  a watchdog still runs out-of-band; it just registers).\n');
  for (const o of offenders) console.error('    ' + o);
  console.error(
    `\n  ${offenders.length} offender(s). See plan schedule-inventory-and-ephemeral-tier-2026-06-26 (P-007/P-008).`,
  );
  process.exit(1);
}

// Run the scan only when invoked as a CLI — importing the module (for the unit test)
// must NOT exec git / exit the process. Symlink-robust (WI-1443): node realpaths
// import.meta.url while argv[1] keeps the invoked path, so also compare realpaths.
const isMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  if (import.meta.url === pathToFileURL(argv1).href) return true;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
})();
if (isMain) {
  main();
}
