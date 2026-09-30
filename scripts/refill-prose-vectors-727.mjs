#!/usr/bin/env node
/**
 * One-shot bulk refill driver for migration 727 (prose vectors 384 -> 768).
 *
 * WHY THIS EXISTS. 727 necessarily DROPPED every stored prose vector (pgvector
 * cannot cast between widths), so ~399k rows now have `embedding IS NULL` and
 * the affected surfaces run LEXICAL-ONLY until they are refilled. The periodic
 * sweep alone cannot close that gap in reasonable time: `runBackfillSweep()`
 * defaults to MAX_ROWS_PER_TARGET_PER_SWEEP (BATCH_SIZE*4) on a 5-minute
 * cadence, which is ~2-5 DAYS for session_turns' 331k rows on its own
 * (EI-19375205903428632). That per-sweep ceiling is a FAIRNESS cap, not a
 * safety limit — its whole purpose is to stop one big table starving the
 * others on a routine tick.
 *
 * So this raises the ceiling rather than forking the sweep. Calling
 * `runBackfillSweep({ maxRowsPerTarget })` keeps every property the audited
 * path already provides — embedder resolution, the dims-fit guard, the org
 * pool, liveness probes, spaceAware routing, per-target error isolation and
 * the overlap guard — none of which a hand-rolled `backfillTable` loop would
 * inherit.
 *
 * COST: gemma runs LOCALLY on the :3384 sidecar, so this is wall time only —
 * no API tokens, and the daily spend governor (OpenAI-only) does not bind.
 *
 * Idempotent and safely re-runnable: the sweep selects on "vector missing OR
 * produced by a different embedder than the active one", so an interrupted run
 * simply resumes. Re-running after completion is a no-op.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { statSync } from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

/**
 * EI-19478208736094798 — WHY THIS DRIVER CANNOT TRUST ITS OWN "DONE".
 *
 * ESM caches a module for the life of the process. This driver imports
 * embed-backfill.ts ONCE (below) and then sweeps for as long as it takes, so the
 * eligibility predicate it runs is the one that existed AT BOOT — permanently.
 * The tree, meanwhile, is edited by a whole fleet and committed every few minutes.
 *
 * Measured 2026-08-03: this driver booted 05:46:58Z and logged
 * `DONE — a full pass embedded nothing` at 22:15:19Z. In between, the P-028
 * widening (short USER turns became eligible) landed in embed-backfill.ts. The
 * driver kept sweeping under its frozen bodySql, correctly exhausted it, and
 * reported DONE — while 3,441 rows eligible under the CURRENT predicate sat
 * unembedded. The claim was true under a definition 16h out of date, and read as
 * absolute. Nothing detected it for hours: a 99.043%-covered corpus clears every
 * coverage-ratio floor (see embed-coverage.ts's `backlog-stuck` leg, added for
 * exactly this).
 *
 * So DONE is now CONDITIONAL on the predicate not having moved under us.
 */
const MODULE_PATH = path.join(REPO, 'packages/operator-core/lib/search/embed-backfill.ts');
const BOOT_MS = Date.now();

/** Wall-clock budget after which this process exits so a re-run picks up current
 *  code. Defense in depth behind the staleness check below: a process that exits
 *  cannot drift from the tree in the first place. */
const MAX_RUNTIME_MS = Number(process.env.REFILL_MAX_RUNTIME_MS ?? 45 * 60 * 1000);

/** Did the predicate we are sweeping under change on disk after we imported it? */
function predicateChangedSinceBoot() {
  try {
    const mtimeMs = statSync(MODULE_PATH).mtimeMs;
    return mtimeMs > BOOT_MS ? mtimeMs : null;
  } catch {
    return null; // unreadable ⇒ cannot claim staleness; say nothing rather than guess
  }
}

/**
 * Decide what a completed pass means without conflating an empty pass under a
 * stale module with a genuinely drained current predicate. Keeping this as a
 * pure seam makes the false-DONE guard executable in a unit test without
 * starting the database-backed driver.
 */
export function classifyPass({ embedded, changedAt, nowMs, bootMs, maxRuntimeMs }) {
  if (embedded === 0 && changedAt != null) return 'stale';
  if (embedded === 0) return 'done';
  if (nowMs - bootMs > maxRuntimeMs) return 'budget';
  return 'continue';
}

// Drain-to-empty ceiling. Far above the largest target (session_turns ~331k)
// so a pass is bounded by "no rows left", never by the cap.
const MAX_ROWS_PER_TARGET = Number(process.env.REFILL_MAX_ROWS ?? 2_000_000);
// A pass can still end early (embedder hiccup, a target erroring in isolation),
// so loop until a pass does no work at all.
const MAX_PASSES = Number(process.env.REFILL_MAX_PASSES ?? 40);

const ts = () => new Date().toISOString().slice(11, 19) + 'Z';
const log = (...a) => console.log(`[refill-727 ${ts()}]`, ...a);

async function main() {
  process.env.PAPERCUSP_REPO_ROOT ??= REPO;
  const { runBackfillSweep } = await import(
    path.join(REPO, 'packages/operator-core/lib/search/embed-backfill.ts')
  );

  log(`starting — maxRowsPerTarget=${MAX_ROWS_PER_TARGET}, maxPasses=${MAX_PASSES}`);

  let grandTotal = 0;
  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    const t0 = Date.now();
    let result;
    try {
      result = await runBackfillSweep({ maxRowsPerTarget: MAX_ROWS_PER_TARGET });
    } catch (err) {
      log(`pass ${pass} THREW: ${err?.message ?? err}`);
      log('aborting — a throw here is not per-target isolated, so retrying blind would spin');
      process.exitCode = 1;
      return;
    }

    if (result && !Array.isArray(result) && result.skipped) {
      // 'already_running' = another sweep holds the in-process guard;
      // anything else (disabled / dims mismatch) is terminal for this run.
      log(`pass ${pass} SKIPPED: ${result.skipped}`);
      if (result.skipped === 'already_running') {
        await new Promise((r) => setTimeout(r, 15_000));
        continue;
      }
      log('terminal skip — nothing this driver can do; investigate the embedder/dims guard');
      process.exitCode = 2;
      return;
    }

    const stats = Array.isArray(result) ? result : [];
    const embedded = stats.reduce((n, s) => n + (s.embedded ?? 0), 0);
    const failed = stats.reduce((n, s) => n + (s.failed ?? 0), 0);
    grandTotal += embedded;
    const secs = ((Date.now() - t0) / 1000).toFixed(0);

    const perTable = stats
      .filter((s) => (s.embedded ?? 0) > 0 || (s.failed ?? 0) > 0)
      .map((s) => `${s.table ?? s.name ?? '?'}=${s.embedded ?? 0}${s.failed ? `/!${s.failed}` : ''}`)
      .join(' ');
    log(`pass ${pass}: embedded=${embedded} failed=${failed} in ${secs}s  ${perTable}`);

    const changedAt = embedded === 0 ? predicateChangedSinceBoot() : null;
    const outcome = classifyPass({
      embedded,
      changedAt,
      nowMs: Date.now(),
      bootMs: BOOT_MS,
      maxRuntimeMs: MAX_RUNTIME_MS,
    });

    if (outcome === 'stale') {
      log(
        `⚠ NOT DONE — a full pass embedded nothing, but embed-backfill.ts changed on disk at ` +
          `${new Date(changedAt).toISOString()}, AFTER this process imported it at ` +
          `${new Date(BOOT_MS).toISOString()}. ESM cached the OLD module, so "nothing left" is ` +
          `true only under the predicate as it was at boot. Rows made eligible by the newer ` +
          `predicate are INVISIBLE to this process and are NOT embedded. ` +
          `RE-RUN this driver to sweep under current code. ` +
          `(total embedded this run = ${grandTotal})`,
      );
      process.exitCode = 3;
      return;
    }

    if (outcome === 'done') {
      log(
        `DONE — a full pass embedded nothing, and embed-backfill.ts is unchanged since boot ` +
          `(${new Date(BOOT_MS).toISOString()}), so this is DONE under the CURRENT predicate. ` +
          `total embedded this run = ${grandTotal}`,
      );
      return;
    }

    if (outcome === 'budget') {
      log(
        `stopping at the ${Math.round(MAX_RUNTIME_MS / 60000)}min code-freshness budget with work ` +
          `still to do — a longer-lived process would keep sweeping under an increasingly stale ` +
          `cached predicate. Re-run to continue with current code. ` +
          `total embedded this run = ${grandTotal}`,
      );
      return;
    }
  }
  log(`stopped at MAX_PASSES=${MAX_PASSES}; total embedded this run = ${grandTotal} (re-run to continue)`);
}

const invokedScript = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;

if (invokedScript) {
  main().catch((e) => {
    log('fatal:', e?.stack ?? e);
    process.exitCode = 1;
  });
}
