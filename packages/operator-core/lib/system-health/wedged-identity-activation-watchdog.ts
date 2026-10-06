/**
 * wedged-identity-activation-watchdog (WI-10002060) — the DETECTOR half of the
 * self-sealing-identity-failure work. EI-23745120264597384 built the
 * PREVENTION half (a break-glass contract enforced at the identity-grants
 * kernel gate by a source-level test); this is the half that finds a session
 * ALREADY wedged, or wedged by a path that never reaches that gate.
 *
 * THE CLASS. A session's authority is decided by comparing the acknowledged
 * activation receipt in `session_briefs.control_state->activation->applied`
 * against the launch record in `adv_sessions.launch_spec`. When those cannot be
 * reconciled the kernel answers `stale-artifact` and refuses EVERY tool — and
 * the refusal is SELF-SEALING: the wedged session cannot file its own bug,
 * because filing one is itself a tool call. So the finding has to be raised by
 * something OUTSIDE the failure domain. That is this sweep.
 *
 * ── DESIGN DECISION 1: ask the gate, never paraphrase it ──────────────────
 * The obvious implementation is a jsonb predicate. It has been tried twice and
 * was wrong BOTH TIMES, in BOTH DIRECTIONS — measured against the live
 * population on 2026-09-20:
 *
 *   `control_state->'activation'->>'status' IS DISTINCT FROM 'applied'`
 *     · selected 11 of 73 live sessions, ALL HEALTHY. `prepared:null` +
 *       `status:'applied'` is what SUCCESS looks like (acknowledgeControl-
 *       Transition sets both in one jsonb_set chain), so a predicate keying on
 *       the status label reports healthy sessions as wedged.
 *     · and it MISSED the one genuinely wedged session, whose status reads
 *       'applied'. A detector with a 100% false-positive AND a 100%
 *       false-negative rate is worse than none: it trains its reader to ignore
 *       it while the real thing sits undetected.
 *
 * The root cause of both errors is the same: `status` is a hand-maintained
 * second copy of a truth the gate derives elsewhere, and the gate's real
 * question is not a revision comparison at all — `appliedIdentityArtifact`
 * searches the record AND its `identityHistory` for a receipt matching both
 * revisions, with a fallback admitting a case no jsonb predicate expresses.
 *
 * So this sweep does not re-declare the decision. It loads the same two inputs
 * the kernel loads and calls the kernel's own `resolveIdentityArtifact`. There
 * is exactly one other caller of that function — the gate itself — which is
 * what makes a divergence between detector and decision impossible rather than
 * merely unlikely.
 *
 * ── DESIGN DECISION 2: select the launch record the way the KERNEL selects it
 * `adv_sessions` fans out: one owner can hold several rows (a relaunch or a
 * carry-respawn adds one without closing the old). The measured instance had
 * TWO open rows — an earlier one whose launch_spec matched `applied`, and a
 * later one carrying no specificationRevision at all. A plain JOIN yields BOTH,
 * so the same owner appears once healthy and once wedged and the sweep's answer
 * depends on which row it happens to read.
 *
 * The kernel is not ambiguous: projected-tool-deps.ts picks ONE row with
 * LAUNCH_RECORD_SELECTION_ORDER below. This sweep uses the identical ordering,
 * and `wedged-identity-activation-selection.pin.test.ts` fails if the two ever
 * drift apart. (Pinned rather than shared as a constant on purpose: threading
 * one through postgres.js tagged SQL needs `sql.unsafe` in the identity hot
 * path, which is a worse trade than a test that cannot be ignored.)
 *
 * ── DESIGN DECISION 3: fail closed ────────────────────────────────────────
 * "measured nothing" and "found nothing" must never render identically. A
 * failed read, and a scan that saw zero candidate rows when the table should
 * never be empty, both escalate as `not-measured` rather than returning clean.
 * The previous generation of a sibling guard was silently inert for ~6 weeks
 * for exactly this reason (WI-10002031).
 */
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { getOrgPg } from '@papercusp/db-org';
import { pinModuleState } from '@papercusp/module-singleton';

import { openEscalation } from '../agent-tools/coordination/escalations';
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import { resolveSessionStates } from '../agent-tools/coordination/liveness-oracle';
import type { SessionState } from '../agent-tools/coordination/presence-wakeability';
import { resolveIdentityArtifact } from '../capability-envelope/identity-grants-port';
import { cooperativeYield } from '../event-loop-lag-monitor';
import { narrowedLaunchSpecToAppliedPairSql } from '../capability-envelope/identity-receipt-narrowing';
import { normalizeSessionActivation } from '../session-activation';
import { activeWorkspaceId } from '../workspace-registry';

/**
 * The kernel's launch-record selection, verbatim. MUST stay byte-identical to
 * the ORDER BY in projected-tool-deps.ts — see DESIGN DECISION 2 and the pin
 * test. Prefers a still-open row, then the most recently started, then the
 * highest id.
 */
export const LAUNCH_RECORD_SELECTION_ORDER =
  '(s.ended_at IS NULL AND s.ended_by IS NULL) DESC, s.started_at DESC, s.id DESC';

/**
 * Hourly. A wedge is permanent once it starts — nothing self-heals it — so a
 * tighter cadence buys nothing, while a looser one leaves a session burning
 * wake budget against a total denial for most of a day.
 */
export const WEDGED_IDENTITY_SWEEP_INTERVAL_MS = 60 * 60_000;

const WATCHDOG_IDENTITY: AgentIdentity = {
  ownerId: 'wedged-identity-activation-watchdog',
  ownerLabel: 'system · wedged identity activation',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

/** A session's liveness as far as this sweep could establish it. */
export type WedgedLiveness = SessionState | 'unknown';

/** Terminal states — a wedged session that has already ended harms nobody. */
const TERMINAL_STATES: ReadonlySet<string> = new Set(['ended', 'recorded']);

export interface CandidateRow {
  ownerId: string;
  /** `adv_sessions.launch_spec`, or null when the owner has NO launch record. */
  launchSpec: unknown;
  /** Null when the LATERAL found no adv_sessions row at all. */
  advSessionId: string | null;
  /** Raw `control_state->'activation'`, normalized by the kernel's normalizer. */
  activation: unknown;
  /**
   * WI-10005391: identity of everything `classifyCandidate` reads for this
   * row — the selected launch row's id and row version (xmin) plus a digest of
   * the activation envelope. Null when there is no launch row.
   */
  verdictKey?: string | null;
  /**
   * True when the loader did NOT ship `launchSpec` because the sweep already
   * holds a verdict for `verdictKey`. Such a row is never classified; its prior
   * verdict is reused.
   */
  launchSpecOmitted?: boolean;
}

export type CandidateVerdict = { wedged: false } | { wedged: true; reason: string };

/**
 * WI-10005391 — verdicts carried from one sweep to the next.
 *
 * Every sweep used to stream the narrowed launch record of EVERY session that
 * ever carried an activation (2,094 rows, 1.28 GB stored, on 2026-10-02, and
 * growing with history) and replay each artifact twice. A main-thread CPU
 * profile of one fire put 24.8% of a 30 s window into that replay. Most of
 * those rows never change again (548 of 2,094 briefs moved in 24 h).
 *
 * A verdict is a pure function of the launch row and the activation, so it is
 * keyed on exactly those: launch row id + xmin (a new tuple version on ANY
 * update) + md5 of the activation jsonb. The SQL returns no launch record for a
 * known key, so an unchanged row is neither detoasted, shipped, parsed nor
 * replayed. A changed row gets a new key and is classified by the kernel's own
 * resolver, exactly as before (DESIGN DECISION 1 is untouched). The map is
 * replaced only after a COMPLETE scan, so it never outlives the rows it
 * describes; a code change restarts the process, which empties it.
 */
export interface WedgedVerdictCache {
  verdicts: Map<string, CandidateVerdict>;
  /** Rows the last complete sweep reused rather than classified (observability). */
  lastReused: number;
  lastScanned: number;
}

const sweepVerdictCache = pinModuleState<WedgedVerdictCache>(
  '@papercusp/operator-core.wedged-identity-verdict-cache',
  () => ({ verdicts: new Map(), lastReused: 0, lastScanned: 0 }),
);

export function wedgedIdentityVerdictCacheStats(): { size: number; lastReused: number; lastScanned: number } {
  return {
    size: sweepVerdictCache.verdicts.size,
    lastReused: sweepVerdictCache.lastReused,
    lastScanned: sweepVerdictCache.lastScanned,
  };
}

export interface WedgedSession {
  ownerId: string;
  reason: string;
  liveness: WedgedLiveness;
}

export interface WedgedIdentitySweepDeps {
  /**
   * One array, or a stream of pages (the default streams; WI-10004803).
   * `knownVerdictKeys` (WI-10005391) are the keys the sweep already holds a
   * verdict for; the loader MAY omit the launch record of such a row and must
   * then set `launchSpecOmitted`. A loader that ignores the argument stays correct.
   */
  loadCandidates: (knownVerdictKeys: readonly string[]) => Promise<CandidateRow[]> | AsyncIterable<CandidateRow[]>;
  verdictCache: WedgedVerdictCache;
  /**
   * Called after each row the sweep CLASSIFIES (never after a reused one) with
   * the running count, returning the next count. The default yields one
   * macrotask per classified row. Measured 2026-10-02 against the live table
   * (2,104 rows): a cold sweep spends 54.9 s of CPU, about 26 ms per row, and a
   * 25-row page classified without yielding blocks the bg-host main thread for
   * about 650 ms, about 84 times in a row. bg-host restarts so often that 19 of
   * 23 hourly ticks in one day were cold (WI-10005444).
   */
  yieldAfterClassified: (classifiedSoFar: number) => Promise<number>;
  resolveLiveness: (ownerIds: string[]) => Promise<Map<string, WedgedLiveness>>;
  escalateWedged: (wedged: WedgedSession[]) => Promise<void>;
  escalateNotMeasured: (info: { reason: string }) => Promise<void>;
}

/**
 * Classify ONE candidate. Pure, and deliberately thin: every judgement about
 * whether the identity reconciles is delegated to the kernel's own resolver.
 */
export function classifyCandidate(row: CandidateRow): { wedged: false } | { wedged: true; reason: string } {
  let applied: { specificationRevision: string; stateRevision: string } | null = null;
  if (row.activation != null) {
    try {
      applied = normalizeSessionActivation(row.activation)?.applied ?? null;
    } catch {
      // The kernel treats a malformed activation as "no activation" rather than
      // as an applied receipt, so a parse failure is NOT by itself a wedge.
      applied = null;
    }
  }

  // No acknowledged receipt ⇒ the legacy, non-opted-in path. The gate returns
  // null (no identity governance), so there is nothing to be wedged about.
  if (!applied) return { wedged: false };

  // An acknowledged identity with NO launch row at all is the `no-launch-record`
  // cause. coord:orient is break-glass for it, so the session is recoverable —
  // but only if it ever takes a turn, and it is still denied every other tool.
  if (row.advSessionId == null) {
    return { wedged: true, reason: 'no-launch-record' };
  }

  const record = row.launchSpec;
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { wedged: true, reason: 'launch-record-malformed' };
  }

  const resolution = resolveIdentityArtifact(record as Record<string, unknown>, applied);
  return resolution.kind === 'stale-artifact'
    ? { wedged: true, reason: resolution.reason }
    : { wedged: false };
}

const CANDIDATE_SQL_ORDER = LAUNCH_RECORD_SELECTION_ORDER;

/** Rows per cursor page. A page is the most launch-record JSON this sweep holds
 * at once; most records are one ~0.6 MB artifact, the largest ~2 MB narrowed. */
export const CANDIDATE_PAGE_ROWS = 25;

/**
 * WI-10004803: STREAMED and NARROWED. Reading every candidate at once parsed
 * ~1.5 GB of launch-record JSON (1,724 rows, measured 2026-10-01) in one
 * result on the bg-host. Now a cursor holds one page at a time, and each
 * record's identityHistory is narrowed in PostgreSQL to the receipt for that
 * row's own applied pair, the only receipt `resolveIdentityArtifact` reads
 * (the gate narrows its own body read the same way). The rows selected, their
 * order, and the classification are unchanged.
 */
async function* defaultLoadCandidates(knownVerdictKeys: readonly string[]): AsyncGenerator<CandidateRow[]> {
  const { sql } = getOrgPg();
  const workspaceId = activeWorkspaceId();
  // WI-10005391: `n.known` short-circuits the CASE, so a row whose verdict the
  // sweep already holds is never detoasted — the launch record stays a TOAST
  // pointer through the LIMIT 1 subquery and is simply not returned.
  const query = sql<Array<{
    owner_id: string;
    launch_spec: unknown;
    adv_session_id: string | number | null;
    activation: unknown;
    verdict_key: string | null;
    launch_spec_omitted: boolean | null;
  }>>`
    SELECT b.owner_id,
           a.launch_spec,
           a.id AS adv_session_id,
           b.control_state->'activation' AS activation,
           a.verdict_key,
           a.launch_spec_omitted
      FROM harness_shared.session_briefs b
      LEFT JOIN LATERAL (
        SELECT n.id,
               n.verdict_key,
               n.known AS launch_spec_omitted,
               CASE WHEN n.known THEN NULL ELSE ${narrowedLaunchSpecToAppliedPairSql(sql)} END AS launch_spec
          FROM (
            SELECT k.id, k.launch_spec, k.applied_pair, k.verdict_key,
                   k.verdict_key = ANY(${[...knownVerdictKeys]}::text[]) AS known
              FROM (
                SELECT s.id, s.launch_spec, b.control_state->'activation'->'applied' AS applied_pair,
                       s.id::text || ':' || s.xmin::text || ':' || md5((b.control_state->'activation')::text) AS verdict_key
                  FROM harness_shared.adv_sessions s
                 WHERE s.coord_owner_id = b.owner_id
                   AND s.workspace_id = b.workspace_id
                 ORDER BY ${sql.unsafe(CANDIDATE_SQL_ORDER)}
                 LIMIT 1
              ) AS k
          ) AS n
      ) a ON true
     WHERE b.workspace_id = ${workspaceId}
       AND b.control_state->'activation' IS NOT NULL
  `;
  for await (const rows of query.cursor(CANDIDATE_PAGE_ROWS)) {
    yield rows.map((r) => ({
      ownerId: r.owner_id,
      launchSpec: r.launch_spec,
      advSessionId: r.adv_session_id == null ? null : String(r.adv_session_id),
      activation: r.activation,
      verdictKey: r.verdict_key,
      launchSpecOmitted: r.launch_spec_omitted === true,
    }));
  }
}

/** One iteration shape for both loader forms: a page stream, or one array. */
async function* candidatePages(
  load: () => Promise<CandidateRow[]> | AsyncIterable<CandidateRow[]>,
): AsyncGenerator<CandidateRow[]> {
  const source = load();
  if (Symbol.asyncIterator in Object(source)) {
    yield* source as AsyncIterable<CandidateRow[]>;
  } else {
    yield await (source as Promise<CandidateRow[]>);
  }
}

async function defaultResolveLiveness(ownerIds: string[]): Promise<Map<string, WedgedLiveness>> {
  const out = new Map<string, WedgedLiveness>();
  if (ownerIds.length === 0) return out;
  // Resolved only for CONFIRMED-wedged owners, never the whole roster: that is
  // what keeps `hydratePerId` (one point-read each) an honest cost.
  const verdicts = await resolveSessionStates(
    ownerIds.map((ownerId) => ({ ownerId })),
    { hydratePerId: true, psuHostAuthority: true },
  );
  for (const ownerId of ownerIds) {
    const verdict = verdicts.get(ownerId);
    // A null sessionState is an IN-BAND unknown, never an absence. Reporting it
    // as 'unknown' keeps it visible instead of silently dropping a session the
    // sweep could not classify.
    out.set(ownerId, verdict?.sessionState ?? 'unknown');
  }
  return out;
}

async function defaultEscalateWedged(wedged: WedgedSession[]): Promise<void> {
  const n = wedged.length;
  const lines = wedged
    .map((w) => `  · ${w.ownerId} — ${w.reason} (liveness: ${w.liveness})`)
    .sort();
  await openEscalation(WATCHDOG_IDENTITY, {
    severity: 'advisory',
    summary:
      `${n} session${n === 1 ? ' is' : 's are'} wedged in an unreconcilable identity ` +
      `activation and cannot file this themselves`,
    body:
      `The identity-grants kernel would answer stale-artifact for ${n === 1 ? 'this session' : 'these sessions'}, ` +
      `which denies EVERY tool call.\n\n${lines.join('\n')}\n\n` +
      `WHY THIS ESCALATION EXISTS: the denial is SELF-SEALING. A wedged session ` +
      `cannot report its own condition, because reporting is a tool call and the ` +
      `denial is total. Nobody was ever going to file this from the inside — so ` +
      `if this escalation is ignored, the session stays bricked until a human ` +
      `happens to notice it went quiet.\n\n` +
      `RECOVERY: coord:orient is break-glass for the identity causes and is exempt ` +
      `from the kernel preflight, so a session that still takes turns can converge ` +
      `itself by calling it. A session that no longer takes turns (liveness ended/` +
      `parked) cannot, and needs its activation converged out of band — see the ` +
      `stale-artifact recovery note in the project guide.\n\n` +
      `NOT A REVISION MISMATCH YOU CAN EYEBALL: these were classified by calling ` +
      `the kernel's own resolveIdentityArtifact, not by comparing revision strings. ` +
      `A hand-written jsonb comparison disagrees with the gate in both directions ` +
      `(WI-10002060) — re-check with the resolver, not with SQL.`,
    meta: {
      dedupKind: 'wedged-identity-activation',
      // Keyed on WHICH sessions are wedged, not the count: a persistent wedge
      // dedups instead of re-alarming hourly, while a newly-wedged session
      // opens a fresh escalation rather than hiding behind the existing one.
      subjectSignature: wedged.map((w) => `${w.ownerId}:${w.reason}`).sort().join(','),
      wedgedCount: n,
      wedged: wedged.map((w) => ({ ownerId: w.ownerId, reason: w.reason, liveness: w.liveness })),
    },
  });
}

async function defaultEscalateNotMeasured(info: { reason: string }): Promise<void> {
  await openEscalation(WATCHDOG_IDENTITY, {
    severity: 'advisory',
    summary: `Wedged-identity sweep NOT MEASURED: ${info.reason}`,
    body:
      `The wedged-identity-activation sweep could not complete, so this is a FAILED ` +
      `MEASUREMENT — not a clean machine. Reason: ${info.reason}.\n\n` +
      `A quiet sweep must mean "measured and clean" or it means nothing at all. This ` +
      `escalation exists so that a broken detector can never be mistaken for a healthy ` +
      `fleet — the failure mode that left a sibling guard silently inert for ~6 weeks.`,
    meta: {
      dedupKind: 'wedged-identity-activation-not-measured',
      subjectSignature: info.reason,
    },
  });
}

function sweepDeps(overrides: Partial<WedgedIdentitySweepDeps>): WedgedIdentitySweepDeps {
  return {
    loadCandidates: defaultLoadCandidates,
    verdictCache: sweepVerdictCache,
    yieldAfterClassified: (classifiedSoFar) => cooperativeYield(classifiedSoFar, 1),
    resolveLiveness: defaultResolveLiveness,
    escalateWedged: defaultEscalateWedged,
    escalateNotMeasured: defaultEscalateNotMeasured,
    ...overrides,
  };
}

export type WedgedIdentitySweepOutcome =
  | { verdict: 'clean'; scanned: number; escalated: 0 }
  | { verdict: 'wedged'; scanned: number; wedged: WedgedSession[]; escalated: 1 }
  | { verdict: 'not-measured'; reason: string; escalated: 1 };

export async function runWedgedIdentitySweepOnce(
  overrides: Partial<WedgedIdentitySweepDeps> = {},
): Promise<WedgedIdentitySweepOutcome> {
  const deps = sweepDeps(overrides);

  // Pages are classified and dropped as they arrive (WI-10004803). A read that
  // fails on ANY page fails the whole sweep closed, exactly as a failed
  // single read did: a partial scan must never report clean. Only the read is
  // guarded, so a classification error still propagates as before.
  let scanned = 0;
  let reused = 0;
  let classified = 0;
  const confirmed: Array<{ ownerId: string; reason: string }> = [];
  // WI-10005391: an immutable snapshot of the carried verdicts. A row the loader
  // omitted is looked up HERE, never in a map this sweep is still building.
  const prior = new Map(deps.verdictCache.verdicts);
  const next = new Map<string, CandidateVerdict>();
  const pages = candidatePages(() => deps.loadCandidates([...prior.keys()]))[Symbol.asyncIterator]();
  for (;;) {
    let page: IteratorResult<CandidateRow[]>;
    try {
      page = await pages.next();
    } catch (e) {
      const reason = `candidate read failed: ${e instanceof Error ? e.message : String(e)}`;
      await deps.escalateNotMeasured({ reason });
      return { verdict: 'not-measured', reason, escalated: 1 };
    }
    if (page.done) break;
    scanned += page.value.length;
    for (const row of page.value) {
      let verdict: CandidateVerdict;
      if (row.launchSpecOmitted) {
        const carried = row.verdictKey ? prior.get(row.verdictKey) : undefined;
        if (!carried) {
          // The loader withheld a launch record the sweep holds no verdict for.
          // Classifying the row without it would be a guess, so fail closed.
          const reason =
            `candidate read omitted the launch record for ${row.ownerId} ` +
            `(verdict key ${row.verdictKey ?? 'null'}) that the sweep holds no verdict for`;
          await deps.escalateNotMeasured({ reason });
          return { verdict: 'not-measured', reason, escalated: 1 };
        }
        verdict = carried;
        reused += 1;
      } else {
        verdict = classifyCandidate(row);
        classified = await deps.yieldAfterClassified(classified);
      }
      if (row.verdictKey) next.set(row.verdictKey, verdict);
      if (verdict.wedged) confirmed.push({ ownerId: row.ownerId, reason: verdict.reason });
    }
  }

  // A built-in positive control. Every operator has session_briefs rows carrying
  // an activation; zero means the query matched nothing it should have matched
  // (wrong workspace, renamed column, a migration not applied) — which returns
  // an empty `wedged` list that is indistinguishable from a clean fleet.
  if (scanned === 0) {
    const reason = 'no session_briefs rows carried an activation — the sweep cannot have measured anything';
    await deps.escalateNotMeasured({ reason });
    return { verdict: 'not-measured', reason, escalated: 1 };
  }

  // A COMPLETE scan: carry exactly the verdicts of the rows it saw, so a deleted
  // or re-selected launch row drops out instead of accumulating.
  deps.verdictCache.verdicts = next;
  deps.verdictCache.lastReused = reused;
  deps.verdictCache.lastScanned = scanned;

  if (confirmed.length === 0) return { verdict: 'clean', scanned, escalated: 0 };

  let liveness: Map<string, WedgedLiveness>;
  try {
    liveness = await deps.resolveLiveness(confirmed.map((c) => c.ownerId));
  } catch {
    // A failed liveness read must not suppress a CONFIRMED wedge. Report it with
    // liveness unknown rather than dropping the finding.
    liveness = new Map();
  }

  const wedged: WedgedSession[] = confirmed
    .map((c) => ({ ...c, liveness: liveness.get(c.ownerId) ?? 'unknown' }))
    .filter((w) => !TERMINAL_STATES.has(w.liveness));

  if (wedged.length === 0) return { verdict: 'clean', scanned, escalated: 0 };

  await deps.escalateWedged(wedged);
  return { verdict: 'wedged', scanned, wedged, escalated: 1 };
}

// ── UNAPPLIED-ACTIVATION CENSUS (WI-10004999) ─────────────────────────────
//
// A SECOND class, measured on the same tick. The sweep above finds sessions
// the gate would REFUSE. This census finds sessions the gate lets through but
// whose identity activation was never ACKNOWLEDGED: `status` stays at
// 'desired' or 'prepared' while the session keeps taking turns. Nothing is
// denied, so nobody notices — but no `applied` activation event is written, so
// no activation span opens and the session's inference cost reads as
// unattributed (WI-10004663: fresh launches applied only on turn 2, and a
// one-turn launch never; Sep 29-30 shadow-statement drop).
//
// WHY THE STATUS LABEL IS THE RIGHT INPUT HERE, when DESIGN DECISION 1 above
// rejects it: that decision is about the gate's stale-artifact question, which
// the label does not answer. This census asks a different question — "was the
// latest desired transition acknowledged?" — and the label is exactly that
// answer: session-activation.ts sets 'applied' ONLY in the apply transition.
// The label alone still over-reports, so two more conditions gate a finding:
//
//   · TURNS, not time. An activation legitimately sits at desired/prepared
//     until the next turn-start hook applies it (turn 1 on the fixed build,
//     turn 2 on the pre-WI-10004663 build). A session is flagged only after it
//     has COMPLETED `UNAPPLIED_ACTIVATION_TURN_THRESHOLD` journaled turns since
//     its activation last entered desired/prepared — past every legitimate
//     path. A session that has not taken a turn yet is never flagged.
//   · A REAL identity change. desired === applied (same spec AND state
//     revision) is a re-desire of the identity already applied; the span is
//     already open, so it is not a finding.
//
// KNOWN LIMIT: turns are counted from `session_turn_journal`, which is written
// by the Claude turn-end hook only (measured 2026-10-01: every row
// source_kind='claude'). A non-Claude session reads 0 turns and is never
// flagged — a false NEGATIVE, never a false positive.

/** Completed turns, since the activation went unapplied, before it is a finding. */
export const UNAPPLIED_ACTIVATION_TURN_THRESHOLD = 2;

/** The per-row journal count stops here; the census needs ≥ threshold, not a total. */
export const UNAPPLIED_TURN_COUNT_CAP = 10;

export interface UnappliedCandidateRow {
  ownerId: string;
  /** Raw `control_state->'activation'`. */
  activation: unknown;
  /** When the activation last entered desired/prepared; null when no event records it. */
  unappliedSince: string | null;
  /** Journaled turns completed after `unappliedSince` (capped). */
  turnsSince: number;
}

export interface UnappliedSession {
  ownerId: string;
  status: 'desired' | 'prepared';
  turnsSince: number;
  unappliedSince: string;
  liveness: WedgedLiveness;
}

export type UnappliedClassification =
  | { unapplied: false }
  | { unapplied: 'unmeasured' }
  | { unapplied: true; status: 'desired' | 'prepared'; turnsSince: number; unappliedSince: string };

/** The census's instrument check — see `runUnappliedActivationCensusOnce`. */
export interface TurnJournalPositiveControl {
  /** session_briefs rows touched in the last 24h (was the fleet active at all?). */
  recentBriefs: number;
  /** session_turn_journal rows written in the last 24h. */
  recentJournalTurns: number;
}

export interface UnappliedActivationCensusDeps {
  loadUnapplied: () => Promise<UnappliedCandidateRow[]>;
  loadPositiveControl: () => Promise<TurnJournalPositiveControl>;
  resolveLiveness: (ownerIds: string[]) => Promise<Map<string, WedgedLiveness>>;
  escalateUnapplied: (unapplied: UnappliedSession[]) => Promise<void>;
  escalateNotMeasured: (info: { reason: string }) => Promise<void>;
}

function sameActivationPair(
  a: { specificationRevision: string; stateRevision: string } | null | undefined,
  b: { specificationRevision: string; stateRevision: string } | null | undefined,
): boolean {
  return !!a && !!b && a.specificationRevision === b.specificationRevision && a.stateRevision === b.stateRevision;
}

/** Classify ONE census row. Pure. */
export function classifyUnapplied(
  row: UnappliedCandidateRow,
  threshold: number = UNAPPLIED_ACTIVATION_TURN_THRESHOLD,
): UnappliedClassification {
  let parsed: ReturnType<typeof normalizeSessionActivation>;
  try {
    parsed = normalizeSessionActivation(row.activation);
  } catch {
    // Malformed is ungoverned for the kernel, so it is not this census's finding.
    return { unapplied: false };
  }
  if (!parsed || (parsed.status !== 'desired' && parsed.status !== 'prepared')) return { unapplied: false };
  if (sameActivationPair(parsed.desired, parsed.applied)) return { unapplied: false };
  // Unapplied, but no event says since WHEN, so its turns cannot be counted.
  // Reported as a count, never guessed into a finding.
  if (row.unappliedSince == null) return { unapplied: 'unmeasured' };
  if (row.turnsSince < threshold) return { unapplied: false };
  return {
    unapplied: true,
    status: parsed.status,
    turnsSince: row.turnsSince,
    unappliedSince: row.unappliedSince,
  };
}

async function defaultLoadUnapplied(): Promise<UnappliedCandidateRow[]> {
  const { sql } = getOrgPg();
  const workspaceId = activeWorkspaceId();
  // Index-backed per row: events by (workspace_id, owner_id, recorded_at, id);
  // journal by (owner_id, created_at DESC), capped so a long-lived session
  // costs at most UNAPPLIED_TURN_COUNT_CAP index entries.
  const rows = await sql<Array<{
    owner_id: string;
    activation: unknown;
    unapplied_since: Date | string | null;
    turns_since: string | number | null;
  }>>`
    SELECT b.owner_id,
           b.control_state->'activation' AS activation,
           u.recorded_at AS unapplied_since,
           CASE WHEN u.recorded_at IS NULL THEN 0 ELSE (
             SELECT count(*) FROM (
               SELECT 1
                 FROM harness_shared.session_turn_journal j
                WHERE j.owner_id = b.owner_id
                  AND j.workspace_id = b.workspace_id
                  AND j.created_at > u.recorded_at
                LIMIT ${UNAPPLIED_TURN_COUNT_CAP}
             ) AS capped
           ) END AS turns_since
      FROM harness_shared.session_briefs b
      LEFT JOIN LATERAL (
        SELECT ev.recorded_at
          FROM harness_shared.session_identity_activation_events ev
         WHERE ev.workspace_id = b.workspace_id
           AND ev.owner_id = b.owner_id
           AND ev.phase IN ('desired', 'prepared')
         ORDER BY ev.recorded_at DESC, ev.id DESC
         LIMIT 1
      ) u ON true
     WHERE b.workspace_id = ${workspaceId}
       AND b.control_state->'activation'->>'status' IN ('desired', 'prepared')
  `;
  return rows.map((r) => ({
    ownerId: r.owner_id,
    activation: r.activation,
    unappliedSince: r.unapplied_since == null ? null : toIsoUtc(r.unapplied_since),
    turnsSince: Number(r.turns_since ?? 0),
  }));
}

/** postgres.js returns timestamptz as a LOCAL-offset string here (measured
 * 2026-10-01: "2026-10-01 13:47:34.454261-04"); render UTC ISO like every
 * other Papercusp timestamp, keeping the raw value if it does not parse. */
function toIsoUtc(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
}

async function defaultLoadPositiveControl(): Promise<TurnJournalPositiveControl> {
  const { sql } = getOrgPg();
  const workspaceId = activeWorkspaceId();
  const [row] = await sql<Array<{ recent_briefs: string | number; recent_journal_turns: string | number }>>`
    SELECT
      (SELECT count(*) FROM harness_shared.session_briefs
        WHERE workspace_id = ${workspaceId} AND updated_at > now() - interval '24 hours') AS recent_briefs,
      (SELECT count(*) FROM harness_shared.session_turn_journal
        WHERE workspace_id = ${workspaceId} AND created_at > now() - interval '24 hours') AS recent_journal_turns
  `;
  return {
    recentBriefs: Number(row?.recent_briefs ?? 0),
    recentJournalTurns: Number(row?.recent_journal_turns ?? 0),
  };
}

async function defaultEscalateUnapplied(unapplied: UnappliedSession[]): Promise<void> {
  const n = unapplied.length;
  const lines = unapplied
    .map(
      (u) =>
        `  · ${u.ownerId} — ${u.status} since ${u.unappliedSince}, ${u.turnsSince}` +
        `${u.turnsSince >= UNAPPLIED_TURN_COUNT_CAP ? '+' : ''} turns (liveness: ${u.liveness})`,
    )
    .sort();
  await openEscalation(WATCHDOG_IDENTITY, {
    severity: 'advisory',
    summary:
      `${n} live session${n === 1 ? '' : 's'} kept taking turns with an identity activation ` +
      `that was never applied — inference cost is unattributed`,
    body:
      `Each session below has completed at least ${UNAPPLIED_ACTIVATION_TURN_THRESHOLD} turns since its ` +
      `identity activation last entered desired/prepared, and it is still not applied:\n\n` +
      `${lines.join('\n')}\n\n` +
      `CONSEQUENCE: no 'applied' activation event is written, so no activation span opens and ` +
      `every turn this session spends reads as unattributed inference cost. Nothing is denied, ` +
      `so the session itself will not notice.\n\n` +
      `WHAT IT IS NOT: a wedge. The kernel is not refusing these sessions — that class is the ` +
      `wedged-identity-activation escalation. And it is not a session merely between turns: an ` +
      `activation applies at the next turn start, which every session below has already passed.\n\n` +
      `TO DIAGNOSE: read the owner's session_identity_activation_events trail (which door ` +
      `desired it — launch/restart/control — and whether a prepared ever followed) against ` +
      `adv_sessions.launch_spec. Prior instance and fix: WI-10004663 (a fresh 'launch' never ` +
      `applied at turn 1). Census: WI-10004999.`,
    meta: {
      dedupKind: 'unapplied-identity-activation',
      // Keyed on WHICH sessions, like the wedge escalation: a persistent finding
      // dedups instead of re-alarming hourly; a new session opens a fresh one.
      subjectSignature: unapplied.map((u) => `${u.ownerId}:${u.status}`).sort().join(','),
      unappliedCount: n,
      unapplied: unapplied.map((u) => ({
        ownerId: u.ownerId,
        status: u.status,
        turnsSince: u.turnsSince,
        unappliedSince: u.unappliedSince,
        liveness: u.liveness,
      })),
    },
  });
}

async function defaultEscalateCensusNotMeasured(info: { reason: string }): Promise<void> {
  await openEscalation(WATCHDOG_IDENTITY, {
    severity: 'advisory',
    summary: `Unapplied-activation census NOT MEASURED: ${info.reason}`,
    body:
      `The unapplied-identity-activation census could not complete, so this is a FAILED ` +
      `MEASUREMENT — not a clean fleet. Reason: ${info.reason}.\n\n` +
      `The census counts turns from session_turn_journal. If that journal is not being written, ` +
      `every session reads 0 turns and the census would report clean forever.`,
    meta: {
      dedupKind: 'unapplied-identity-activation-not-measured',
      subjectSignature: info.reason,
    },
  });
}

function censusDeps(overrides: Partial<UnappliedActivationCensusDeps>): UnappliedActivationCensusDeps {
  return {
    loadUnapplied: defaultLoadUnapplied,
    loadPositiveControl: defaultLoadPositiveControl,
    resolveLiveness: defaultResolveLiveness,
    escalateUnapplied: defaultEscalateUnapplied,
    escalateNotMeasured: defaultEscalateCensusNotMeasured,
    ...overrides,
  };
}

export type UnappliedActivationCensusOutcome =
  | { verdict: 'clean'; scanned: number; ended: number; unmeasured: number; escalated: 0 }
  | {
      verdict: 'unapplied';
      scanned: number;
      unapplied: UnappliedSession[];
      ended: number;
      unmeasured: number;
      escalated: 1;
    }
  | { verdict: 'not-measured'; reason: string; escalated: 1 };

export async function runUnappliedActivationCensusOnce(
  overrides: Partial<UnappliedActivationCensusDeps> = {},
): Promise<UnappliedActivationCensusOutcome> {
  const deps = censusDeps(overrides);

  let rows: UnappliedCandidateRow[];
  let control: TurnJournalPositiveControl;
  try {
    [rows, control] = await Promise.all([deps.loadUnapplied(), deps.loadPositiveControl()]);
  } catch (e) {
    const reason = `census read failed: ${e instanceof Error ? e.message : String(e)}`;
    await deps.escalateNotMeasured({ reason });
    return { verdict: 'not-measured', reason, escalated: 1 };
  }

  // The positive control. Zero unapplied rows is a legitimate clean fleet, so
  // the row count cannot be the control (unlike the wedge sweep). The
  // instrument that CAN silently break is the turn counter: a journal that
  // stopped being written makes every session read 0 turns, which is
  // indistinguishable from "nobody is stuck". An active fleet (briefs touched
  // in 24h) with zero journaled turns is that broken instrument.
  if (control.recentBriefs > 0 && control.recentJournalTurns === 0) {
    const reason =
      `${control.recentBriefs} session brief(s) were active in the last 24h but session_turn_journal ` +
      `recorded 0 turns — the census cannot count turns`;
    await deps.escalateNotMeasured({ reason });
    return { verdict: 'not-measured', reason, escalated: 1 };
  }

  let unmeasured = 0;
  const confirmed: Array<Omit<UnappliedSession, 'liveness'>> = [];
  for (const row of rows) {
    const verdict = classifyUnapplied(row);
    if (verdict.unapplied === 'unmeasured') unmeasured += 1;
    else if (verdict.unapplied === true) {
      confirmed.push({
        ownerId: row.ownerId,
        status: verdict.status,
        turnsSince: verdict.turnsSince,
        unappliedSince: verdict.unappliedSince,
      });
    }
  }

  const scanned = rows.length;
  if (confirmed.length === 0) return { verdict: 'clean', scanned, ended: 0, unmeasured, escalated: 0 };

  let liveness: Map<string, WedgedLiveness>;
  try {
    liveness = await deps.resolveLiveness(confirmed.map((c) => c.ownerId));
  } catch {
    // A failed liveness read must not suppress a confirmed finding.
    liveness = new Map();
  }

  const withLiveness = confirmed.map((c) => ({ ...c, liveness: liveness.get(c.ownerId) ?? 'unknown' }));
  // An ended session cannot be converged; its finding is history, not an alarm.
  const unapplied = withLiveness.filter((u) => !TERMINAL_STATES.has(u.liveness));
  const ended = withLiveness.length - unapplied.length;

  if (unapplied.length === 0) return { verdict: 'clean', scanned, ended, unmeasured, escalated: 0 };

  await deps.escalateUnapplied(unapplied);
  return { verdict: 'unapplied', scanned, unapplied, ended, unmeasured, escalated: 1 };
}

let watchdogTimer: ManagedHandle | null = null;

export function startWedgedIdentityActivationWatchdog(opts: { intervalMs?: number } = {}): void {
  const intervalMs = opts.intervalMs ?? WEDGED_IDENTITY_SWEEP_INTERVAL_MS;
  if (watchdogTimer) watchdogTimer.stop();
  let sweeping = false;
  watchdogTimer = managedSetInterval(
    'wedged-identity-activation-watchdog',
    intervalMs,
    () => {
      if (sweeping) return;
      sweeping = true;
      const warn = (what: string) => (e: unknown) => {
        console.warn(
          `[wedged-identity-activation-watchdog] ${what} failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
        );
      };
      // Sequential, not parallel: each holds a PG connection, and the wedge
      // sweep's cursor is the expensive one (WI-10004803). A failure in either
      // never skips the other.
      void runWedgedIdentitySweepOnce()
        .catch(warn('sweep'))
        .then(() => runUnappliedActivationCensusOnce())
        .catch(warn('unapplied-activation census'))
        .finally(() => {
          sweeping = false;
        });
    },
    // 'must-sample': a wedge is a RELATIONSHIP between two rows written by
    // different writers at different times. Neither writer knows it created one,
    // so there is no event to subscribe to — it has to be read.
    { category: 'watchdog', classification: 'must-sample' },
  );
}

export function stopWedgedIdentityActivationWatchdog(): void {
  if (watchdogTimer) watchdogTimer.stop();
  watchdogTimer = null;
}
