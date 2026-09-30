/**
 * artifact.ts — the structured result every p2p-perf scenario emits, across
 * ALL tiers (p2p-performance-suite-2026-06-07 P-001 + P-012).
 *
 * One JSON shape from Tier 1 (local loopback benches) through Tier 2 (netem
 * WAN sim) to Tier 3 (real Latitude/Hetzner frames), so curves from any tier
 * overlay directly. Artifacts are written under `test-results/p2p-perf/` by
 * the runner; committed baselines live next to the suite in `baselines/`.
 *
 * Design notes:
 *   - `metrics` is a flat name → summary map (not nested per-phase objects):
 *     the comparator (compare.ts) walks it generically, and a new metric in a
 *     scenario needs no comparator change.
 *   - `loopLag` is first-class, not just another metric: D-003 makes the
 *     host-responsiveness SLO (event-loop lag p95 < 100ms while sync runs)
 *     the headline gate, and `sloPassed` records the verdict per artifact.
 *   - `convergence`/`convergencePassed` is a SECOND, DELIBERATELY SEPARATE
 *     verdict (EI-20576392705164447). "The host stayed responsive" and "the
 *     mesh converged" are different claims, and a 64-peer run on 2026-08-16
 *     is exactly where they diverge: loop-lag p95 was a healthy 21ms while
 *     many readers never applied all ops and appendToVisible p95 was 601
 *     SECONDS — and the artifact still stamped `sloPassed: true`. Never merge
 *     the two into one boolean, and never read a green `sloPassed` as evidence
 *     that replication kept up.
 */

import { createHash } from 'node:crypto';
import { hostname, cpus } from 'node:os';

/** Distribution summary for one measured series. All latencies in ms. */
export interface MetricSummary {
  /** What the numbers mean — latency distributions are 'ms', rates 'ops/sec', sizes 'bytes', counts 'count'. */
  unit: 'ms' | 'ops/sec' | 'bytes' | 'count';
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

/** Event-loop-lag window stats, straight off the EI-79 gauge. */
export interface LoopLagStats {
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

/**
 * Reader-convergence outcome for a scenario that formed a mesh
 * (EI-20576392705164447).
 *
 * The harness ALREADY detected non-convergence before this existed — it wrote
 * `reader N did not apply all ops in time` into `notes` and then dropped that
 * signal on the floor, because nothing in the pass/fail verdict read `notes`.
 * This makes the same observation structured so a verdict (and a gate) can
 * consult it.
 */
export interface ConvergenceStats {
  /** Readers this scenario waited on (declared via `ScenarioMeter.expectReaders`). */
  expectedReaders: number;
  /** Readers that applied EVERY op inside the scenario's catch-up budget. */
  convergedReaders: number;
  /** The readers that did not — peer index (Tier 1/2) or label (Tier 3). */
  laggingReaders: string[];
  /**
   * appendToVisible p95 ceiling (ms) this run was judged against, or null when
   * no ceiling was set. Deliberately opt-in: a defensible number is a product
   * call per scenario, and an invented one would be its own false verdict.
   */
  p95LimitMs: number | null;
  /** Observed appendToVisible p95 (ms), when the scenario measured it. */
  observedP95Ms: number | null;
  /**
   * The catch-up budget (ms) every reader was judged against, or null when the
   * scenario did not declare one.
   *
   * WHY THIS IS RECORDED (EI-20581532536662596): `convergedReaders` alone is a
   * BINARY, and a binary cannot say whether a run passed with 110s of headroom
   * or with 200ms of it. That makes a pass/fail flip UNATTRIBUTABLE — when the
   * budget and the instrument change in the same edit, a suddenly-green ladder
   * reads identically whether the substrate got faster or the deadline got
   * looser. Recording the budget ALONGSIDE the observed times is what separates
   * those two, so a later reader never has to take on trust that nobody moved
   * the goalpost between runs.
   */
  budgetMs: number | null;
  /**
   * Observed time-to-converge (ms) over the readers that DID converge, measured
   * from the start of the shared deadline — so `max` is directly comparable to
   * `budgetMs`, and `budgetMs - max` is the run's headroom.
   *
   * Null when the scenario recorded no per-reader timings (pre-existing
   * artifacts, or a scenario reporting only the binary). Readers that never
   * converged are absent by construction — they have no elapsed time, only a
   * `laggingReaders` entry — so a `count` falling behind `expectedReaders` is
   * itself the signal, and the surviving percentiles are never diluted by a
   * censored sample stamped at the budget.
   */
  convergedMs: MetricSummary | null;
}

/** One subject directory's newest write, as of a provenance capture. */
export interface SubjectTreeStamp {
  /** Repo-RELATIVE directory that was walked. Never absolute — see RunProvenance. */
  dir: string;
  /** Source files found under it. */
  fileCount: number;
  /**
   * sha256 prefix over the COMPLETE sorted `(repo-relative path, mtimeMs)`
   * inventory. This is the compact form of the per-file mtime stamp required
   * by D-026: unlike `newestMtimeMs`, it changes when ANY file in the subject
   * tree changes, including a file older than the tree's newest file.
   *
   * Null means at least one directory/file could not be read, so the stamp is
   * incomplete and must never clear a drift suspicion.
   */
  mtimesDigest: string | null;
  /** Newest mtime over those files (ms since epoch); null when unreadable. */
  newestMtimeMs: number | null;
  /** Repo-relative path of the newest file — names WHAT moved, not just that something did. */
  newestPath: string | null;
}

/**
 * The runner's existing whole-run host evidence, copied verbatim onto every
 * artifact after the final sample. Keeping one shared type prevents the
 * artifact and RunSummary from silently disagreeing about units or verdicts.
 */
export interface HostLoadEvidence {
  /** Final loadavg sample; `ratio1m` below is the conservative start/end max. */
  loadavg1m: number;
  cpus: number;
  /** max(start, end) loadavg1m / cpus. */
  ratio1m: number;
  oversubscribed: boolean;
  /** Swap pages in+out over the run window; null when the probe could not answer. */
  swapPagesDelta: number | null;
  memoryContended: boolean;
  memoryContendedReason: 'psi-stall' | 'swap-pages-fallback' | null;
  /** max(start, end) PSI `some avg60` percentages. */
  psiMemSome60: number | null;
  psiCpuSome60: number | null;
}

/**
 * What code produced this artifact
 * (harden-shared-hive-to-256-peers-2026-06-29 D-026).
 *
 * Captured ONCE at run start by `provenance.ts` and stamped onto each artifact
 * at emit. Read `provenance.ts`'s header before quoting any field here — it
 * states, in full, the five things this instrument cannot tell you. The two
 * that bite hardest:
 *
 *  - `lastCommitSha` is the SUPERPROJECT's last commit. It does not pin
 *    submodule code. A non-empty `submodulesDivergedFromGitlink` means it
 *    positively does not describe all the code that ran.
 *  - A null field means the probe did not answer (see `unavailable`), NEVER a
 *    negative finding. Null `worktree` is not "the tree was clean".
 *
 * ⚠ EVERY PATH HERE IS REPO-RELATIVE, AND THAT IS LOAD-BEARING, NOT TIDINESS.
 * Absolute paths on this box embed the build box's identity, which
 * `lint:no-identity-literals` fails the build on for any tracked file. This
 * struct is per-RUN data and must never reach a committed baseline — see the
 * allowlist note on `baselineFromArtifacts` (compare.ts) and the guard test
 * `baseline-excludes-run-provenance.test.ts` that holds that seam shut.
 */
export interface RunProvenance {
  /** When this snapshot was taken — RUN START, not artifact emit. ISO, UTC. */
  capturedAt: string;
  /**
   * The checkout's LAST COMMIT — explicitly NOT the state of the working tree,
   * which on this shared checkout routinely carries other lanes' uncommitted
   * edits. `worktree` is what describes the tree.
   */
  lastCommitSha: string | null;
  /** Committer date of `lastCommitSha`, rendered UTC. */
  lastCommitAt: string | null;
  /**
   * The last commit touching the SUBJECT SCOPE — a more precise answer than
   * the checkout tip, which here is usually an unrelated agent's sweep.
   */
  subjectLastCommitSha: string | null;
  subjectLastCommitAt: string | null;
  /**
   * Submodules whose checked-out HEAD differs from the gitlink the
   * superproject records (prefixed with git's own status char). NON-EMPTY
   * MEANS `lastCommitSha` IS AN INCOMPLETE ANSWER. Null ⇒ not probed.
   */
  submodulesDivergedFromGitlink: string[] | null;
  /**
   * Working-tree dirtiness at run start. Null ⇒ not probed — never "clean".
   */
  worktree: {
    /**
     * sha256 prefix of the whole-tree `git status --porcelain`. A FINGERPRINT,
     * not a comparison key: on a ~90-agent box this is effectively unique per
     * run, so it can distinguish two runs and can never establish that two
     * runs saw the same code.
     */
    dirtyDigest: string | null;
    dirtyFileCount: number | null;
    /** Dirty paths under `scope` — the field that carries information. */
    dirtyPathsInScope: string[];
    /** True when `dirtyPathsInScope` was capped. */
    scopedTruncated: boolean;
    /**
     * The repo-relative prefixes actually consulted. Recorded so that this
     * leg's under-reporting is VISIBLE rather than implied by silence: an
     * empty `dirtyPathsInScope` means "nothing dirty under these", never "the
     * tree was clean".
     */
    scope: string[];
  } | null;
  /** Complete path+mtime inventory digest per subject tree at run start. Null ⇒ not probed. */
  subjects: SubjectTreeStamp[] | null;
  /**
   * Subject trees whose complete path+mtime inventory CHANGED between the
   * run-start capture and THIS artifact's emit — the falsifier for "the
   * snapshot still describes this artifact".
   *
   * Non-empty means the tree moved mid-run and the run must not be quoted as
   * one code state. Empty means the complete inventories matched, which is a
   * suspicion cleared, not a content diff (mtime over-reports on a rewrite of
   * identical bytes).
   * Null on the run-level snapshot (nothing to compare yet) and whenever the
   * re-check could not run.
   */
  subjectDriftSinceCapture: string[] | null;
  /**
   * Host contention AT RUN START, carried onto the artifact instead of being
   * spent only on the runner's internal health verdict (D-026). These are the
   * figures `runner.ts` already sampled — not a second, differently-timed
   * sample. The run-level max(start,end) evidence is finalized separately in
   * `hostLoad`; this captures the state the first scenario started under.
   */
  hostAtStart: {
    loadavg1m: number;
    cpus: number;
    /** loadavg1m / cpus — the EI-8843 oversubscription ratio. */
    ratio1m: number;
    /** PSI memory `some avg60` (%), null when /proc/pressure is unreadable. */
    psiMemSome60: number | null;
    psiCpuSome60: number | null;
    /** vmstat swap pages in+out at start; the EI-9145 fallback's baseline. */
    swapPagesAtStart: number | null;
  };
  /**
   * The runner's final/max load, PSI, and swap-delta evidence for the whole run.
   * Null while scenarios are still running (or if finalization never happened);
   * `runner.ts` rewrites each emitted JSON artifact after computing host health.
   */
  hostLoad: HostLoadEvidence | null;
  /** One line per probe that could not answer. Empty ⇒ every leg reported. */
  unavailable: string[];
}

export interface PerfArtifact {
  /**
   * Artifact schema version — bump on breaking shape changes.
   *
   * 2 (D-026): added required-and-nullable `provenance`. Artifacts written at
   * schema 1 carry no provenance field at all, which is exactly the condition
   * that makes every pre-D-026 number unattributable; a reader encountering
   * `schema: 1` should treat the code that produced it as unknown rather than
   * assuming it matches anything.
   */
  schema: 2;
  /** Scenario id, e.g. 'merge.idle-tick' / 'replication.sustained' / 'tier3.cross-region'. */
  scenario: string;
  /** 1 = local loopback, 2 = netem WAN sim, 3 = real machines. */
  tier: 1 | 2 | 3;
  /** Scenario parameters (history size, peer count, rate, netem profile, region…). */
  params: Record<string, string | number | boolean>;
  startedAt: string; // ISO
  durationMs: number;
  host: {
    hostname: string;
    platform: string;
    arch: string;
    cpus: number;
    node: string;
  };
  /** Named measured series. Keys are stable per scenario — the comparator matches on them. */
  metrics: Record<string, MetricSummary>;
  /**
   * Event-loop lag over the scenario window, from the shipped EI-79 gauge
   * (`event-loop-lag-monitor.ts`). Null only when a scenario genuinely cannot
   * host the gauge (it should be rare — D-003 makes this the headline metric).
   */
  loopLag: LoopLagStats | null;
  /**
   * The D-003 SLO verdict: loop-lag p95 < `sloLimitMs` while sync ran. Null
   * when loopLag is null.
   *
   * ⚠ HOST RESPONSIVENESS ONLY. This says the operator stayed usable while
   * sync ran (EI-79) — it says NOTHING about whether replication kept up. Read
   * `convergencePassed` for that; a run can be `sloPassed: true` while readers
   * are ten minutes behind (EI-20576392705164447).
   */
  sloPassed: boolean | null;
  sloLimitMs: number;
  /**
   * Reader convergence for this cell, when the scenario declared how many
   * readers it waits on. Null ⇒ not measured (no mesh formed, or a scenario
   * with no readers) — never read null as "converged".
   */
  convergence: ConvergenceStats | null;
  /**
   * The convergence verdict: every expected reader applied all ops in budget,
   * AND (when a ceiling was set) appendToVisible p95 stayed under it. Null when
   * `convergence` is null. Kept DISTINCT from `sloPassed` on purpose.
   */
  convergencePassed: boolean | null;
  /** Process CPU consumed over the scenario (parent process; children report their own). */
  cpu: { userMs: number; systemMs: number };
  /** Peak RSS observed over the scenario (bytes). */
  rss: { peakBytes: number };
  /**
   * What code produced this number (D-026). Stamped by the runner at emit, so
   * it covers child-produced artifacts (netem, mesh peers) too — `ctx.emit` is
   * the single funnel every artifact passes through.
   *
   * REQUIRED-AND-NULLABLE on purpose, matching `convergence` above and for the
   * same reason: an OPTIONAL field is precisely what lets the next writer of a
   * PerfArtifact omit it without the typechecker ever objecting, which is how
   * this hole existed at all. Null states "not captured" — a claim a reader
   * can act on. Absent states nothing.
   *
   * ⚠ Null is NOT "the tree was clean" and NOT "this is attributable". An
   * artifact with `provenance: null` is exactly as unquotable as every
   * pre-D-026 artifact.
   */
  provenance: RunProvenance | null;
  /** Total ops decoded/applied across the scenario, when the scenario counts them. */
  opsDecoded?: number;
  /** Free-form observations (capability skips, capped logs, anomalies). */
  notes: string[];
}

export interface ScenarioHostInfo {
  hostname: string;
  platform: string;
  arch: string;
  cpus: number;
  node: string;
}

/**
 * A stable but NON-IDENTIFYING tag for the machine that produced an artifact.
 *
 * Baselines under `baselines/` are COMMITTED to tracked source and ship inside
 * the release bundle, so a raw `os.hostname()` here leaks this box's identity —
 * `lint:no-identity-literals` fails the build on it, and the release cut's
 * box-identity audit (bin/audit-release-bundle.py) fails later and more
 * expensively. A committed baseline carrying the raw hostname red-pinned the
 * green-checkpoint gate on 2026-07-26.
 *
 * A hash keeps the ONLY property the field is actually read for — telling
 * whether two artifacts came from the same machine, so a baseline captured
 * elsewhere is not silently compared against local numbers. Nothing branches on
 * the value (report.ts prints it; compare.ts carries it through), so the digest
 * costs no behaviour.
 */
export function hostTag(rawHostname: string = hostname()): string {
  return `host-${createHash('sha256').update(rawHostname).digest('hex').slice(0, 8)}`;
}

export function currentHostInfo(): ScenarioHostInfo {
  return {
    // NEVER the raw hostname — see hostTag(). This file is the single writer of
    // the field, so redacting here covers every artifact and every baseline.
    hostname: hostTag(),
    platform: process.platform,
    arch: process.arch,
    cpus: cpus().length,
    node: process.version,
  };
}
