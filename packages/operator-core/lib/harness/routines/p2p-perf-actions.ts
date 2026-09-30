/**
 * p2p-perf system actions — p2p-performance-suite-2026-06-07 P-014.
 *
 * Two cron routines (seeded by `seed-p2p-perf-routines.ts`):
 *   - `system:p2p-perf-tier1` — NIGHTLY Tier-1 run (loopback benches, ci
 *     profile) against the committed baseline.
 *   - `system:p2p-perf-tier2` — WEEKLY Tier-2 run (netem WAN matrix; skips
 *     cleanly on hosts without userns).
 * Tier 3 (real frames) is deliberately NOT here — on-demand only (D-004).
 *
 * Findings that cross thresholds AUTO-FILE via `captureImprovement` (the
 * improvements backlog): every loop-lag SLO violation (D-003 — the headline
 * gate, kind=bug: a real regression worth an auto-fix attempt) and every
 * advisory regression past tolerance (kind=change — EI-7254: informational,
 * D-005 never gates, so it is not an auto-implement-eligible code defect).
 * A `findIssuesByWatchdogKeys` pre-filter (EI-7254) skips the capture entirely
 * when an OPEN issue already carries the same stable watchdogKey — an exact
 * indexed lookup, not capture-core's fuzzy search-first dedup (whose title
 * search is defeated once a few hundred near-duplicates already exist for the
 * same scenario+metric, since the live baseline→current numbers embedded in
 * the title vary every run). A STANDING regression now truly files once.
 * The run itself stays advisory (D-005): the routine never gates anything.
 *
 * Mirrors release-actions.ts layering: the handler SHELLS OUT to the runner
 * (which lives in this same package but is designed as a standalone tsx CLI)
 * and runs it from the INTEGRATION tree so nightly numbers track staging.
 */

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { captureImprovement } from '../improvements/capture-core';
import { findIssuesByWatchdogKeys } from '../../issues-engineer';
import type { RunSummary } from '../../sync/hyperbee/perf/runner';

const RUNNER_REL = 'packages/operator-core/lib/sync/hyperbee/perf/runner.ts';

function integrationRoot(): string {
  return process.env.PAPERCUSP_INTEGRATION_ROOT ?? path.resolve(process.cwd(), '..', '..');
}

function tsxBin(root: string): string {
  return path.join(root, 'node_modules/.bin/tsx');
}

/**
 * Single-flight lock for a perf tier (p2p-perf-reaper-requeue-oom, 2026-06-30).
 *
 * THE BUG this guards: runTier `await`s a multi-minute shell-out with NO DBOS step
 * and no live `workflow_queue` row, so the dbos-executor-reaper's 90s ORPHAN path
 * (no-queue-row + no-operation_output ⇒ "stuck") cancels the routineFire and
 * requeues the routine every ~90s. The DB-level cancel does NOT kill the OS child,
 * so WITHOUT this lock every requeue spawns ANOTHER runner + its hyperbee peer-child
 * swarm; over a ~15-min run they stack to ~40 GB and OOM-kill the whole bg-host unit
 * (the 2026-06-30 incident: 37.7 GB peak, MemoryMax 40 GB). With the lock, the ONE
 * real run holds it and every reaper-requeued re-fire is a fast no-op skip → the
 * workflow completes immediately and DBOS reschedules to the next cron slot, so the
 * requeue storm self-limits and memory stays bounded to a single run.
 *
 * Cross-process + crash-safe: the lock records {pid, startedAt}; a lock is LIVE only
 * if its pid is still alive AND it is younger than maxAgeMs (always > the run's own
 * timeoutMs, so the run's internal SIGTERM frees it before the age check would). A
 * stale lock (dead pid after an OOM/restart, or past maxAge) is reclaimed, so a
 * crashed run never wedges future ones. The acquire is fully synchronous (no await
 * between read and write), so concurrent in-process runTier calls cannot interleave.
 */
interface PerfRunLock {
  pid: number;
  startedAt: number;
  tier: string;
}

function perfLockPath(tier: string): string {
  return path.join(os.tmpdir(), `papercusp-p2p-perf${tier}.lock`);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Acquire the tier lock. Returns true (caller MUST release) or false ⇒ a live run
 *  already holds it and this (likely reaper-requeued) fire should skip. */
function acquirePerfLock(tier: string, maxAgeMs: number): boolean {
  const p = perfLockPath(tier);
  try {
    const cur = JSON.parse(readFileSync(p, 'utf8')) as PerfRunLock;
    if (pidAlive(cur.pid) && Date.now() - cur.startedAt < maxAgeMs) return false; // live run holds it
    // else: stale (dead pid or past max-age) — fall through and reclaim
  } catch {
    /* no lock / unreadable — fall through and acquire */
  }
  try {
    writeFileSync(p, JSON.stringify({ pid: process.pid, startedAt: Date.now(), tier } satisfies PerfRunLock));
    return true;
  } catch {
    return false; // could not write — be conservative and skip rather than risk a stampede
  }
}

/** Release the tier lock if we still own it (never clobber a reclaimer's lock). */
function releasePerfLock(tier: string): void {
  try {
    const cur = JSON.parse(readFileSync(perfLockPath(tier), 'utf8')) as PerfRunLock;
    if (cur.pid === process.pid) rmSync(perfLockPath(tier), { force: true });
  } catch {
    /* already gone / unreadable */
  }
}

/** Outcome of a runner shell-out. `timedOut` records whether OUR killer fired
 *  (the run overran its budget); `signal` is the terminating signal Node reported
 *  on `close` (non-null ⇒ the tsx child itself was signal-killed). Together they
 *  let the caller tell an INTERRUPTED run (timeout / restart / OOM) from a genuine
 *  runner crash — see classifyNoSummaryRun (EI-5753). */
interface RunnerResult {
  code: number;
  stdout: string;
  stderr: string;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

function runRunner(root: string, args: string[], timeoutMs: number): Promise<RunnerResult> {
  return new Promise((resolve) => {
    // detached ⇒ the runner is its own process-group leader, so the timeout can kill
    // the WHOLE runner + hyperbee peer-child subtree (`kill(-pid)`), not just the
    // direct tsx child — the old `child.kill('SIGTERM')` left the peer swarm orphaned.
    const child = spawn(tsxBin(root), [path.join(root, RUNNER_REL), ...args], {
      cwd: root,
      env: { ...process.env, PAPERCUSP_INTEGRATION_ROOT: root },
      detached: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const killTree = (sig: NodeJS.Signals): void => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* already dead */
        }
      }
    };
    let escalate: NodeJS.Timeout | null = null;
    const killer = setTimeout(() => {
      timedOut = true;
      killTree('SIGTERM');
      escalate = setTimeout(() => killTree('SIGKILL'), 15_000);
      escalate.unref();
    }, timeoutMs);
    const finish = (res: RunnerResult): void => {
      clearTimeout(killer);
      if (escalate) clearTimeout(escalate);
      resolve(res);
    };
    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', (d) => (stderr += d.toString()));
    child.on('error', (e) => finish({ code: 1, stdout, stderr: stderr + String(e), signal: null, timedOut }));
    child.on('close', (code, signal) => finish({ code: code ?? 1, stdout, stderr, signal: signal ?? null, timedOut }));
  });
}

/**
 * Classify a p2p-perf run that produced NO summary file (EI-5753).
 *
 * A run killed by a SIGNAL — our own timeout firing, the OOM killer, or a bg-host
 * service restart mid-run — is an INTERRUPTED run, not a runner crash with a real
 * finding. Such terminations surface either as a non-null `close` signal or, when
 * the tsx wrapper forwards its signal-killed child's status, as an exit code in the
 * POSIX signal band 128+N — e.g. 143 (128+SIGTERM), 137 (128+SIGKILL), 130
 * (128+SIGINT), 129 (128+SIGHUP). They must NOT be filed as `kind:'bug'`: `bug` is
 * auto-implement-eligible, and an implement worker cannot fix "the box was
 * restarted" / "the run is slow" — it just re-files the same noise every night
 * (EI-5752 / EI-5753: an exit-143 restart-kill mis-filed as an auto-fixable bug).
 *
 *  - `timeout` → the run overran its OWN budget (our killer fired). A real perf/ops
 *    signal worth a human-reviewed `kind:'change'`, but not an auto-fixable code bug.
 *  - `signal`  → externally interrupted (restart / OOM / external kill, our timeout
 *    did NOT fire). Not a finding at all — log and skip.
 *  - `crash`   → a genuine non-zero exit with no signal: a real runner defect (bug).
 */
export type NoSummaryRunClass = 'timeout' | 'signal' | 'crash';

/**
 * Is `code` a POSIX signal-termination exit status (128+N for a standard signal
 * N∈1..31 ⇒ 129..159)? The perf runner only ever exits 0 or 1 deliberately
 * (runner.ts: `process.exitCode = 1`), so ANY exit code in this band is the tsx
 * wrapper forwarding a signal-kill it could not surface as a `close` signal — never
 * a real runner exit. Generalizes the original 143/137-only check so a restart by
 * ANY signal (SIGHUP/SIGINT/SIGTERM/SIGKILL/…) can't re-file as a phantom crash bug.
 * Codes ≤128 (incl. 1/2/127) stay genuine crashes.
 */
function isSignalExitCode(code: number): boolean {
  return code >= 129 && code <= 159;
}

export function classifyNoSummaryRun(r: Pick<RunnerResult, 'code' | 'signal' | 'timedOut'>): NoSummaryRunClass {
  if (r.timedOut) return 'timeout';
  if (r.signal != null || isSignalExitCode(r.code)) return 'signal';
  return 'crash';
}

/**
 * EI-7254: capture-core's dedup is search-FIRST (full-text title search, capped
 * at 20 results, then filtered by title similarity — see capture-core.ts) with
 * the watchdogKey check applied only to whatever that fuzzy search happens to
 * surface. This p2p-perf title embeds the live baseline→current numbers, which
 * differ every run, so once a few hundred near-duplicates exist for the SAME
 * scenario+metric the true match routinely falls outside the fuzzy search's
 * top-20 / similarity cut — and a fresh duplicate gets filed anyway, despite
 * the stable watchdogKey each capture already carries (the EI-3909-era fix
 * intent, never fully closed). This produced 1,200+ near-duplicate advisory
 * bugs by 2026-07-04.
 *
 * Fix: pre-filter with `findIssuesByWatchdogKeys` — the SAME indexed, exact
 * lookup the improvement watchdog's own collectors already use before planning
 * a capture (watchdog.ts readWatchdogKeyDups) — and skip the capture entirely
 * when an OPEN issue already carries the key. This is authoritative (an exact
 * index match, not a fuzzy heuristic) and cannot miss regardless of backlog size.
 */
async function openIssueExistsForKeys(keys: readonly string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const issues = await findIssuesByWatchdogKeys([...keys]).catch(() => []);
  const open = new Set<string>();
  for (const i of issues) {
    if (i.state !== 'open') continue;
    const k = (i.payload as Record<string, unknown> | null)?.watchdogKey;
    if (typeof k === 'string') open.add(k);
  }
  return open;
}

/** File one improvement per threshold-crossing finding (deduped by capture-core,
 *  pre-filtered by an exact watchdogKey lookup — EI-7254).
 *
 * EI-8843: `hostLoad.oversubscribed` means the runner sampled sustained
 * contention (load/cpus ratio) around this run — this box is a SHARED
 * interactive dev box, not a dedicated perf host, and 7+ concurrent agent
 * fleets routinely oversubscribe it. A wall-clock/PG-latency-sensitive
 * scenario (loop-lag, any PG-write-heavy metric) measures shared-box
 * contention under that condition, not a code regression (the 2026-07-09
 * incident: 2748%-18113% "regressions" at load-ratio >1.0 that WORSENED on a
 * second independent run, while pure in-memory scenarios in the SAME run
 * improved 58-106% — the signature of contention, not a fixed algorithmic
 * bug). Skip auto-filing entirely on an oversubscribed run: the artifacts +
 * report.md are written regardless (a human auditing a noisy night still
 * sees the real numbers, flagged uncertain in the report), only the
 * auto-implement/auto-review backlog noise is suppressed.
 *
 * `scenarioFailures` (a proc-mesh scenario that threw instead of measuring)
 * is gated the SAME way (EI-22042363019140442/EI-22130724058668873 et al.,
 * 2026-09-01/02): every observed failure to date is `MeshFormationError`'s
 * `proc mesh: writer never became ready` / `proc mesh: reader N never
 * admitted the writer` — a wall-clock wait (`meshTimeoutMs`, default 120s)
 * on a real OS-process swarm join, exactly the kind of timing-sensitive
 * measurement this gate exists for. 20 consecutive clean nightly runs
 * (2026-08-17..31) then TWO consecutive nights of the identical failure
 * signature, both independently flagged `hostLoad.oversubscribed`, with a
 * same-HEAD manual repro passing (meshFormationMs elevated ~2x but nowhere
 * near the 120s budget) — the contention signature, not a code regression.
 * Also given a stable watchdogKey (previously none), matching the fix
 * EI-7254 already applied to the other three finding types below — without
 * one, a STANDING crash re-filed as a fresh near-duplicate every night
 * instead of deduping (the exact failure mode EI-3909/EI-7254 fixed for
 * regressions/SLO violations; two full-signature duplicate EIs from the two
 * nights above are the same bug recurring in the one finding type that
 * hadn't been fixed yet). */
/**
 * The denominator that must travel with every rendered regression count
 * (WI-39359). A metric whose baseline sits under the absolute floor is never
 * ELIGIBLE to regress, so "0 regressions" over a partially-blind metric set is
 * a bounded measurement wearing the costume of a clean sweep — indistinguishable
 * from a run that genuinely cleared everything. Measured 2026-08-17 on the
 * tier1 `ci` baseline: 11 of 51 metrics blind, the hot path among them.
 *
 * Returns '' only when coverage is genuinely complete or no comparison ran, so
 * the common clean case stays quiet and a blind spot is always loud.
 */
function formatCoverage(summary: RunSummary): string {
  const c = summary.regressionCoverage;
  if (!c || c.blind === 0) return '';
  return ` (⚠ over ${c.judged}/${c.total} metrics — ${c.blind} NOT COMPARABLE, never eligible to regress)`;
}

async function fileFindings(summary: RunSummary, tierLabel: string): Promise<void> {
  if (summary.hostLoad?.oversubscribed) {
    // EI-19301664378023382: surface the PSI "some" stall-time evidence in the skip
    // line, and name WHICH branch produced the verdict. As of 2026-08-17 PSI is the
    // authoritative memory signal (see runner.ts computeHostHealth); the swap-page
    // delta only decides on hosts where PSI is unreadable, so a reader must be able
    // to tell those two cases apart rather than inferring from the numbers.
    const psiMem = summary.hostLoad.psiMemSome60;
    const psiCpu = summary.hostLoad.psiCpuSome60;
    const memReason =
      summary.hostLoad.memoryContendedReason === 'psi-stall'
        ? `, memory stall per PSI`
        : summary.hostLoad.memoryContendedReason === 'swap-pages-fallback'
          ? `, swap Δ${summary.hostLoad.swapPagesDelta} pages (PSI unavailable — page-delta fallback)`
          : '';
    console.info(
      `[p2p-perf] ${tierLabel} run ${summary.runId}: host was oversubscribed (load ratio ` +
        `${summary.hostLoad.ratio1m.toFixed(2)}× cpus${memReason}` +
        `; PSI some avg60 mem=${psiMem !== null && psiMem !== undefined ? `${psiMem.toFixed(1)}%` : 'n/a'} ` +
        `cpu=${psiCpu !== null && psiCpu !== undefined ? `${psiCpu.toFixed(1)}%` : 'n/a'}) — skipping auto-filing of ` +
        `${summary.sloViolations.length} SLO violation(s) / ` +
        `${summary.regressions.length} regression(s) / ` +
        `${summary.scenarioFailures.length} scenario crash(es)${formatCoverage(summary)} ` +
        `as unreliable under contention (EI-8843); see ${summary.reportPath} for the raw numbers.`,
    );
    return;
  }
  const sloKeys = summary.sloViolations.map((v) => `p2p-perf-slo:${v.scenario}:${v.paramsKey}`);
  // EI-20576392705164447: the nightly used to file ONLY loop-lag SLO violations
  // and regressions, so a run where the mesh never converged auto-filed nothing
  // at all — the same false-green one layer out from the artifact verdict.
  const convergenceViolations = summary.convergenceViolations ?? [];
  const convergenceKeys = convergenceViolations.map(
    (v) => `p2p-perf-convergence:${v.scenario}:${v.paramsKey}`,
  );
  const regressionKeys = summary.regressions.map(
    (r) => `p2p-perf-regression:${r.scenario}:${r.paramsKey}:${r.metric}`,
  );
  // EI-22042363019140442: a proc-mesh scenario crash (e.g. MeshFormationError's
  // "writer never became ready") gets the SAME exact-key dedup as the other three
  // finding types below (EI-7254 pattern) — the failure string embeds no live
  // numbers (scenario id + static error message), so it is already a stable key
  // across runs without any further normalization.
  const scenarioCrashKeys = summary.scenarioFailures.map((f) => `p2p-perf-crash:${f}`);
  const alreadyOpen = await openIssueExistsForKeys([
    ...sloKeys,
    ...convergenceKeys,
    ...regressionKeys,
    ...scenarioCrashKeys,
  ]);

  for (let idx = 0; idx < convergenceViolations.length; idx++) {
    const v = convergenceViolations[idx]!;
    const watchdogKey = convergenceKeys[idx]!;
    if (alreadyOpen.has(watchdogKey)) continue;
    await captureImprovement({
      kind: 'bug',
      severity: 'major',
      // Numbers stay OUT of the title (EI-3909 et al above): they differ every
      // run, which is what broke cross-run dedup for the SLO findings.
      title: `p2p-perf convergence failure: ${v.scenario} readers did not catch up [${v.paramsKey}]`,
      body:
        `${tierLabel} run ${summary.runId} (profile ${summary.profile}): the mesh did not converge.\n` +
        `scenario: ${v.scenario} [${v.paramsKey}]\n` +
        `converged readers: ${v.convergedReaders}/${v.expectedReaders}` +
        (v.laggingReaders.length ? `\nlagging: ${v.laggingReaders.slice(0, 24).join(', ')}` : '') +
        (v.observedP95Ms !== null ? `\nappendToVisible p95: ${v.observedP95Ms}ms` : '') +
        (v.p95LimitMs !== null ? ` (ceiling ${v.p95LimitMs}ms)` : '') +
        `\n\nNOTE: this is SEPARATE from the D-003 host-responsiveness SLO, which can be GREEN in the ` +
        `same run — it was on 2026-08-16, at 21ms loop-lag p95, while appendToVisible p95 was 601 seconds ` +
        `(EI-20576392705164447). Do not close this against a green sloPassed.\n` +
        `artifacts: ${summary.outDir}\nreport: ${summary.reportPath}\n` +
        `(auto-filed by system:p2p-perf — p2p-performance-suite-2026-06-07 P-014)`,
      source: 'su',
      sourceRole: 'system',
      dedupScope: 'open',
      createdBy: 'system:p2p-perf',
      watchdogKey,
    }).catch(() => {
      /* duplicates declined by capture-core; other failures must not break the routine */
    });
  }

  for (let idx = 0; idx < summary.sloViolations.length; idx++) {
    const v = summary.sloViolations[idx]!;
    const watchdogKey = sloKeys[idx]!;
    if (alreadyOpen.has(watchdogKey)) continue; // EI-7254: a standing violation already has an open EI
    await captureImprovement({
      kind: 'bug',
      severity: 'major',
      title: `p2p-perf SLO violation: ${v.scenario} loop-lag p95 ${v.p95Ms}ms (limit ${v.limitMs}ms)`,
      body:
        `${tierLabel} run ${summary.runId} (profile ${summary.profile}): host event-loop lag p95 ` +
        `crossed the D-003 SLO while sync ran.\nscenario: ${v.scenario} [${v.paramsKey}]\n` +
        `p95=${v.p95Ms}ms limit=${v.limitMs}ms\nartifacts: ${summary.outDir}\nreport: ${summary.reportPath}\n` +
        `(auto-filed by system:p2p-perf — p2p-performance-suite-2026-06-07 P-014)`,
      source: 'su',
      sourceRole: 'system',
      dedupScope: 'open',
      createdBy: 'system:p2p-perf',
      // EI-3909/EI-5846/EI-5829/EI-6585: without a stable watchdogKey, dedup
      // falls back to fuzzy title-similarity — and this title embeds the live
      // p95Ms, which differs almost every run, so cross-run dedup effectively
      // never matched. Result: hundreds of near-duplicate EIs for the SAME
      // recurring SLO violation. Key on scenario+params only (never the live
      // numbers) so a standing violation truly files once, per the module's
      // own doc-comment intent. (EI-7254: the openIssueExistsForKeys() pre-filter
      // above is now the authoritative guard; this stays as defense-in-depth.)
      watchdogKey,
    }).catch(() => {
      // capture-core declines duplicates — exactly what we want for a standing
      // violation; any other failure must not break the routine.
    });
  }
  for (let idx = 0; idx < summary.regressions.length; idx++) {
    const r = summary.regressions[idx]!;
    const watchdogKey = regressionKeys[idx]!;
    if (alreadyOpen.has(watchdogKey)) continue; // EI-7254: a standing regression already has an open EI
    await captureImprovement({
      // EI-7254: an advisory (D-005, never-gating) baseline comparison is not an
      // auto-fixable code defect — `kind:'change'` (human-reviewed informational)
      // instead of `kind:'bug'` (auto-implement-eligible) keeps it out of the
      // auto-implement dispatch lane, which cannot "fix" a perf-baseline drift
      // and would just orphan trying (mirrors the timeout/signal classification
      // a few lines up in this same file for exactly this reason).
      kind: 'change',
      severity: 'minor',
      title: `p2p-perf regression: ${r.scenario} ${r.metric} ${r.baseline} → ${r.current} (${Math.round(r.relChange * 100)}% worse)`,
      body:
        `${tierLabel} run ${summary.runId} (profile ${summary.profile}): metric regressed past the ` +
        `advisory tolerance vs the committed baseline (D-005 — informational, not gating).\n` +
        `scenario: ${r.scenario} [${r.paramsKey}]\nmetric: ${r.metric}: ${r.baseline} → ${r.current}\n` +
        `artifacts: ${summary.outDir}\nreport: ${summary.reportPath}\n` +
        `(auto-filed by system:p2p-perf — p2p-performance-suite-2026-06-07 P-014)`,
      source: 'su',
      sourceRole: 'system',
      dedupScope: 'open',
      createdBy: 'system:p2p-perf',
      // Same fix as the SLO-violation capture above: the title embeds the live
      // baseline→current numbers (never identical two runs running), which
      // defeated fuzzy title dedup and produced 1,200+ near-duplicate EIs for
      // this one recurring regression (EI-3909 et al., EI-7254). Key on scenario
      // + params + metric only — stable across every run that re-detects the
      // SAME regressed metric. (EI-7254: openIssueExistsForKeys() above is now
      // the authoritative guard; this stays as defense-in-depth.)
      watchdogKey,
    }).catch(() => {
      /* dedup-decline / capture failure never breaks the routine */
    });
  }
  for (let idx = 0; idx < summary.scenarioFailures.length; idx++) {
    const f = summary.scenarioFailures[idx]!;
    const watchdogKey = scenarioCrashKeys[idx]!;
    if (alreadyOpen.has(watchdogKey)) continue; // EI-22042363019140442: a standing crash already has an open EI
    await captureImprovement({
      kind: 'bug',
      severity: 'major',
      title: `p2p-perf scenario crashed in ${tierLabel} run: ${f.slice(0, 140)}`,
      body:
        `${tierLabel} run ${summary.runId} (profile ${summary.profile}): scenario failure.\n${f}\n` +
        `artifacts: ${summary.outDir}\nreport: ${summary.reportPath}\n` +
        `(auto-filed by system:p2p-perf — p2p-performance-suite-2026-06-07 P-014)`,
      source: 'su',
      sourceRole: 'system',
      dedupScope: 'open',
      createdBy: 'system:p2p-perf',
      // EI-22042363019140442: same fix as the SLO/convergence/regression captures
      // above (EI-7254 pattern) — without a stable watchdogKey a STANDING crash
      // (the observed case to date: MeshFormationError's "proc mesh: writer never
      // became ready" / "reader N never admitted the writer") re-files as a fresh
      // near-duplicate every night instead of deduping against the still-open
      // original. (openIssueExistsForKeys() above is the authoritative guard;
      // this stays as defense-in-depth against capture-core's fuzzy dedup.)
      watchdogKey,
    }).catch(() => {
      /* dedup-decline / capture failure never breaks the routine */
    });
  }
}

/** Exported for the watchdogKey-stability unit test (EI-3909). */
export const _testing = { fileFindings, formatCoverage };

async function runTier(ctx: SystemActionCtx, tier: '--tier1' | '--tier2', timeoutMs: number): Promise<void> {
  const root = integrationRoot();
  const label = tier === '--tier1' ? 'nightly Tier-1' : 'weekly Tier-2';

  // Single-flight guard (p2p-perf-reaper-requeue-oom). maxAge is ALWAYS > timeoutMs so
  // the run's own SIGTERM frees the lock before the age check would reclaim it; the
  // +5min only covers a crashed run that never released. A held lock ⇒ a real run is
  // already in flight and this fire (almost always a reaper requeue) must NOT spawn a
  // second runner+peer swarm — skip and let the workflow complete + reschedule.
  if (!acquirePerfLock(tier, timeoutMs + 5 * 60_000)) {
     
    console.info(
      `[p2p-perf] ${label}: a run already holds the lock — skipping this (reaper-requeued) fire to avoid stacking runners`,
    );
    return;
  }

  try {
    const summaryPath = path.join(os.tmpdir(), `p2p-perf-${tier.slice(2)}-${Date.now()}.json`);
    const r = await runRunner(root, [tier, '--profile', 'ci', '--summary-json', summaryPath], timeoutMs);

    let summary: RunSummary | null = null;
    try {
      summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as RunSummary;
    } catch {
      summary = null;
    }

    if (!summary) {
      // The runner produced no summary. WHY matters (EI-5753): a signal-terminated run
      // is INTERRUPTED, not crashed — only a genuine non-zero exit is an auto-fixable bug.
      const cls = classifyNoSummaryRun(r);
      if (cls === 'signal') {
        // Externally interrupted (bg-host restart / OOM / external kill) — not a finding.
         
        console.info(
          `[p2p-perf] ${label}: run interrupted by a signal (exit ${r.code}${r.signal ? `, ${r.signal}` : ''}) before ` +
            `writing a summary — bg-host restart / OOM / external kill, not a finding; skipping (it will re-run next cycle)`,
        );
        return;
      }
      if (cls === 'timeout') {
        // The run overran its OWN budget: a perf/ops signal, NOT an auto-fixable code bug.
        // File as human-reviewed kind:'change' so it does not enter the auto-implement loop.
        const mins = Math.round(timeoutMs / 60_000);
        await captureImprovement({
          kind: 'change',
          severity: 'minor',
          title: `p2p-perf ${label} run overran its ${mins}min budget`,
          body:
            `system:p2p-perf ${label} did not finish within ${mins}min and was SIGTERM-killed before writing a ` +
            `summary (exit ${r.code}${r.signal ? `, signal ${r.signal}` : ''}). This is a perf/ops signal — the run is ` +
            `slow under live-fleet load or the budget is too tight — NOT an auto-fixable code bug; review whether the ` +
            `Tier-1 budget or the run itself needs attention.\nstderr tail:\n${r.stderr.slice(-1500)}\n` +
            `(auto-filed by system:p2p-perf — P-014)`,
          source: 'su',
          sourceRole: 'system',
          dedupScope: 'open',
          createdBy: 'system:p2p-perf',
        }).catch(() => {});
        return;
      }
      // cls === 'crash': a genuine non-zero exit (the runner really failed) — that IS a bug.
      await captureImprovement({
        kind: 'bug',
        severity: 'major',
        title: `p2p-perf ${label} run failed to produce a summary (exit ${r.code})`,
        body:
          `system:p2p-perf could not complete the ${label} run.\nexit code: ${r.code}\n` +
          `stderr tail:\n${r.stderr.slice(-1500)}\n(auto-filed by system:p2p-perf — P-014)`,
        source: 'su',
        sourceRole: 'system',
        dedupScope: 'open',
        createdBy: 'system:p2p-perf',
      }).catch(() => {});
      return;
    }

     
    console.info(
      `[p2p-perf] ${label} run ${summary.runId}: ${summary.artifacts} artifacts, ` +
        `${summary.sloViolations.length} SLO violations, ` +
        `${summary.regressions.length} regressions${formatCoverage(summary)}, ` +
        `${summary.improvements} improvements (advisory — D-005). Report: ${summary.reportPath}`,
    );
    // EI-22042363019140442: scenario-crash filing moved INTO fileFindings() so it
    // shares the same host-oversubscription gate (EI-8843) and watchdogKey dedup
    // (EI-7254 pattern) as the other three finding types — it used to be a separate
    // ungated loop here with no watchdogKey, which re-filed a standing crash as a
    // fresh near-duplicate every night.
    await fileFindings(summary, label);
    void ctx;
  } finally {
    releasePerfLock(tier);
  }
}

// Nightly Tier-1 — 30 min bound (ci profile measures ~10-15 min on the dev box).
registerSystemAction('p2p-perf-tier1', (ctx) => runTier(ctx, '--tier1', 30 * 60_000));

// Weekly Tier-2 — netem cells are deliberately slow under impairment; 60 min bound.
registerSystemAction('p2p-perf-tier2', (ctx) => runTier(ctx, '--tier2', 60 * 60_000));
