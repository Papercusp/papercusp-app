/**
 * pipeline-health.ts — the release pipeline's health, folded into the wake bootstrap (WI-4533).
 *
 * ## The gap this closes
 *
 * An agent wakes, orients, and starts editing code. Nothing in `coord:orient` tells it whether the
 * gate is GREEN — so it does not know whether the change it is about to make can ship at all.
 * Measured live (2026-07-13, 7d): the gate went not-green 20×, errored 2×, and failed to
 * fast-forward 5× — while `dev:why`, the tool that would have said so, was called 16 times by 16
 * agents. 425 agents oriented 2256 times and essentially none of them asked. The fact is not
 * missing from the system; it is missing from the ONE read every agent actually makes.
 *
 * This was demonstrated on its own author: the orient that opened the session that built this fold
 * reported a clean bill of health while the gate was RED with four failing files.
 *
 * ## What it must not cost
 *
 * `coord:orient` is the fleet's hottest tool (p50 1.75s). So this leg:
 *   - reuses gate + deploy ONLY (no gateway fetch, no account-pool read — those are dev:why's job);
 *   - is CACHED per-harness behind a short TTL with single-flight, so a burst of waking agents
 *     shares ONE snapshot (they all run in the operator host process);
 *   - is kicked off by the handler BEFORE composeOrient's sequential legs, so its latency hides
 *     behind reads that were happening anyway;
 *   - is bounded + FAIL-SOFT everywhere: any error, any timeout ⇒ the leg is simply absent.
 *     Orientation must never get worse because a pipeline read had a bad day.
 *
 * ## What it must not say
 *
 * Two silences are load-bearing, both instances of the same rule — **a detector with no evidence
 * must say nothing, never OK**:
 *   - a harness with no green-checkpoint routine gets NO block (not a cheerful green);
 *   - a STALE red (WI-4489) is reported as `stale-verdict`, never as `red` — naming its tests
 *     would re-arm the phantom-dispatch loop that item was filed for.
 *
 * A green, caught-up pipeline renders as two short fields — the cost of being told "all clear" is
 * a handful of tokens; the cost of NOT being told the gate is red is a day of work that cannot ship.
 */
import type { PipelineHealth } from '../../why-chain';

/** The shaped block an agent reads at wake. Terse when healthy; actionable when not. */
export interface OrientPipeline {
  /** The gate's colour. `stale-verdict` = superseded red; `inconclusive` = no code verdict. */
  gate: 'green' | 'red' | 'stalled' | 'wedged' | 'stale-verdict' | 'conflict' | 'inconclusive';
  /** Is what's live on :3070 caught up with the green pin and main? */
  deploy: 'current' | 'behind';
  /** Consecutive red checkpoint runs — present only when non-zero. */
  consecutiveReds?: number;
  /** How long since the gate was last green — present only when it isn't now. */
  lastGreenAgoMs?: number;
  /** The test files behind a real (non-stale) red — the ones to go fix. Never set for a
   *  stale-verdict gate: those names are exactly what must NOT be dispatched against. */
  failingFiles?: string[];
  /** The latest checkpoint attempt rendered no code verdict; counters/files are historical. */
  inconclusive?: NonNullable<PipelineHealth['inconclusive']>;
  /** The decisive next action for a non-green root cause, when one is available. */
  nextVerb?: string;
  /** The upstream-most blocking leg, "<stage> — <reason>". Present only when not all-ok. */
  rootCause?: string;
  /** What this means for the caller's work. Present only when not all-ok. */
  note?: string;
  /** Runtime-vs-staging freshness warning; present only when the process is not current. */
  diagnosticVintage?: PipelineHealth['diagnosticVintage'];
  checkedAtMs: number;
}

/** The advisory a NOT-GREEN gate rides with — the agent's own persona already says a red gate
 *  blocking their work is theirs to green; this is the wake-time reminder that it IS red. */
export const PIPELINE_RED_NOTE =
  'the release gate is NOT green — your merged change will NOT reach :3070 until it is. A red gate ' +
  'blocking your work is YOURS to green: fix the failing tests (never force-deploy past it, never ' +
  'wait for someone else). Full causal chain: dev:why.';

/** The latest checkpoint rendered no code verdict; its counters and failing files are historical. */
export const PIPELINE_INCONCLUSIVE_NOTE =
  'the latest green-checkpoint run is INCONCLUSIVE — it ABORTED before judging code, so any red ' +
  'counter or failing-file list beside it belongs to an older verdict. Do NOT triage those files; ' +
  'follow the abort detail and nextVerb for the measured condition.';

/** The advisory a green-but-lagging pipeline rides with. */
export const PIPELINE_BEHIND_NOTE =
  'the gate is green but the tip is NOT live on :3070 yet — verify against the port your write ' +
  'actually lands on, not the one you assume. Position of a specific commit: dev:pipeline_position.';

/** A stale verdict is an UNKNOWN colour, not a red — say exactly that, and name no tests. */
export const PIPELINE_STALE_NOTE =
  "the gate's recorded red is STALE (superseded or unverified), so its true colour is UNKNOWN — do " +
  'NOT go fix the tests it names (that phantom dispatch is WI-4489). Re-run the checkpoint for a ' +
  'real verdict.';

/** EI-18669342433807110: one stale reason — a stale-candidate auto-refire for this exact red
 *  running RIGHT NOW (gate-verdict-freshness.ts Rule 4) — means "re-run the checkpoint" (the
 *  generic PIPELINE_STALE_NOTE advice) is actively wrong: one is already running. Detected by its
 *  reasonCode so the note can say so instead of sending an agent to fire a redundant re-run. */
export const PIPELINE_REFIRE_IN_FLIGHT_NOTE =
  'a stale-candidate auto-refire for this exact red is IN FLIGHT right now — the checkpoint already ' +
  'proved (or is proving) these tests pass at a newer tip and is re-verifying the gate on it. Do ' +
  'NOT go fix the tests it names, and do NOT fire another checkpoint run — a fresh verdict is ' +
  'imminent; just wait for it.';

/** A measured green-checkpoint run is active, so the stale verdict is pending rather than starved. */
export const PIPELINE_RUN_IN_FLIGHT_NOTE =
  'a green-checkpoint run is IN FLIGHT right now (measured live via the run lock), so the stale verdict ' +
  'is pending. Do NOT fire another release:checkpoint-run or fix the named tests while it runs; wait ' +
  'for this active run to finish.';

/** EI-17603: the checkpoint's own failingTests record for this commit was CONTRADICTED by the
 *  test-run ledger — `failingFiles` below is ledger-derived, not the checkpoint's own (wrong)
 *  list. Told explicitly because the checkpoint blob is otherwise the FIRST-preferred source
 *  (see why-chain.ts's namedFailures) — an agent who has seen that convention should know this
 *  read overrode it. */
export const PIPELINE_DISJOINT_NOTE =
  "the release gate is NOT green, and its OWN recorded failing-tests list for this commit was " +
  'CONTRADICTED by the test-run ledger — the file(s) below come from the ledger instead. Fix ' +
  'those (never the checkpoint\'s original list, which does not reproduce). Full causal chain: dev:why.';

/**
 * PURE: shape a PipelineHealth into the wake block. `null` ⇒ fold NOTHING (unknown gate).
 * Unit-testable with hand-built inputs — no PG, no git.
 */
export function toOrientPipeline(health: PipelineHealth, nowMs: number = Date.now()): OrientPipeline | null {
  if (!health.known) return null;

  const gate = health.gateLabel;
  const deployBehind =
    (health.greenPinBehindStaging ?? 0) > 0 || (health.deployedBehindGreenPin ?? 0) > 0;
  const gateOk = gate === 'green';

  const out: OrientPipeline = {
    gate,
    deploy: deployBehind ? 'behind' : 'current',
    checkedAtMs: health.generatedAtMs,
  };
  if (health.inconclusive) out.inconclusive = health.inconclusive;
  if (health.rootCause?.nextVerb) out.nextVerb = health.rootCause.nextVerb;
  if (gateOk && !deployBehind) {
    if (health.diagnosticVintage.status !== 'current') {
      out.diagnosticVintage = health.diagnosticVintage;
    }
    return out;
  }

  // An inconclusive abort leaves the red streak frozen on the previous verdict. Do not expose
  // that historical counter alongside the abort, or the wake fold still looks like a current RED.
  if (gate !== 'inconclusive' && health.consecutiveReds > 0) out.consecutiveReds = health.consecutiveReds;
  if (!gateOk && health.lastGreenAtMs != null) {
    out.lastGreenAgoMs = Math.max(0, nowMs - health.lastGreenAtMs);
  }
  // A stale verdict or inconclusive abort names NO files, by design. An abort's counters and
  // failingTests are inherited from the previous verdict, so exposing them would re-arm the
  // phantom dispatch this fold exists to prevent.
  if (gate !== 'stale-verdict' && gate !== 'inconclusive' && health.recentFailingFiles.length) {
    out.failingFiles = health.recentFailingFiles.slice(0, 5);
  }
  if (health.rootCause) out.rootCause = `${health.rootCause.stage} — ${health.rootCause.reason}`;
  out.note =
    gate === 'inconclusive'
      ? PIPELINE_INCONCLUSIVE_NOTE
      : gate === 'stale-verdict'
      ? // EI-18669342433807110: a refire-in-flight stale reason gets its OWN note — the generic
        // PIPELINE_STALE_NOTE says "re-run the checkpoint for a real verdict", which is actively
        // wrong advice while one is already running.
        health.verdictStaleReasonCode === 'run-in-flight'
        ? PIPELINE_RUN_IN_FLIGHT_NOTE
        : health.verdictStaleReasonCode === 'refire-in-flight'
          ? PIPELINE_REFIRE_IN_FLIGHT_NOTE
          : PIPELINE_STALE_NOTE
      : gateOk
        ? PIPELINE_BEHIND_NOTE
        : health.gateVerdictDisjointFromLedger
          ? PIPELINE_DISJOINT_NOTE
          : PIPELINE_RED_NOTE;
  if (health.diagnosticVintage.status !== 'current') {
    out.diagnosticVintage = health.diagnosticVintage;
  }
  return out;
}

// ─── Short-TTL single-flight cache ───────────────────────────────────────────────────────────
// Every agent's orient runs in the operator host process, so one cached snapshot serves the whole
// waking fleet. Mirrors dev-deploy-state.ts's cache (which this sits on top of, and whose own git
// fan-out is likewise amortized). TTL is read per-call so it stays runtime-tunable + test-overridable.
const DEFAULT_TTL_MS = 60_000;

function ttlMs(): number {
  const raw = process.env.PAPERCUSP_ORIENT_PIPELINE_TTL_MS;
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TTL_MS;
}

const cache = new Map<string, { at: number; value: OrientPipeline | null }>();
const inflight = new Map<string, Promise<OrientPipeline | null>>();

/** Clear the cache — for tests that mutate gate state then re-read. */
export function clearOrientPipelineCache(): void {
  cache.clear();
  inflight.clear();
}

/**
 * Read (or serve from cache) the pipeline block for a harness. NEVER throws and never rejects:
 * every failure path resolves to `null` (the leg is absent from the orientation), because a
 * pipeline read that had a bad day must not degrade the wake bootstrap it decorates.
 */
export async function fetchOrientPipeline(
  slug?: string,
  deps: { compute?: (slug?: string) => Promise<PipelineHealth>; nowMs?: () => number } = {},
): Promise<OrientPipeline | null> {
  const key = slug ?? '__default__';
  const now = deps.nowMs?.() ?? Date.now();
  const ttl = ttlMs();

  const hit = cache.get(key);
  if (ttl > 0 && hit && now - hit.at < ttl) return hit.value;

  const pending = inflight.get(key);
  if (pending) return pending;

  const run = (async () => {
    try {
      const compute =
        deps.compute ??
        (async (s?: string) => {
          const { computePipelineHealth } = await import('../../why-chain');
          return computePipelineHealth({ slug: s, harnessSlug: s });
        });
      const value = toOrientPipeline(await compute(slug), now);
      if (ttl > 0) cache.set(key, { at: now, value });
      return value;
    } catch {
      return null; // fail-soft: no pipeline block, never a broken orient.
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, run);
  return run;
}
