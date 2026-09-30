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

import { openEscalation } from '../agent-tools/coordination/escalations';
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import { resolveSessionStates } from '../agent-tools/coordination/liveness-oracle';
import type { SessionState } from '../agent-tools/coordination/presence-wakeability';
import { resolveIdentityArtifact } from '../capability-envelope/identity-grants-port';
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
}

export interface WedgedSession {
  ownerId: string;
  reason: string;
  liveness: WedgedLiveness;
}

export interface WedgedIdentitySweepDeps {
  loadCandidates: () => Promise<CandidateRow[]>;
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

async function defaultLoadCandidates(): Promise<CandidateRow[]> {
  const { sql } = getOrgPg();
  const workspaceId = activeWorkspaceId();
  const rows = await sql<Array<{
    owner_id: string;
    launch_spec: unknown;
    adv_session_id: string | number | null;
    activation: unknown;
  }>>`
    SELECT b.owner_id,
           a.launch_spec,
           a.id AS adv_session_id,
           b.control_state->'activation' AS activation
      FROM harness_shared.session_briefs b
      LEFT JOIN LATERAL (
        SELECT s.id, to_jsonb(s)->'launch_spec' AS launch_spec
          FROM harness_shared.adv_sessions s
         WHERE s.coord_owner_id = b.owner_id
           AND s.workspace_id = b.workspace_id
         ORDER BY ${sql.unsafe(CANDIDATE_SQL_ORDER)}
         LIMIT 1
      ) a ON true
     WHERE b.workspace_id = ${workspaceId}
       AND b.control_state->'activation' IS NOT NULL
  `;
  return rows.map((r) => ({
    ownerId: r.owner_id,
    launchSpec: r.launch_spec,
    advSessionId: r.adv_session_id == null ? null : String(r.adv_session_id),
    activation: r.activation,
  }));
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

  let rows: CandidateRow[];
  try {
    rows = await deps.loadCandidates();
  } catch (e) {
    const reason = `candidate read failed: ${e instanceof Error ? e.message : String(e)}`;
    await deps.escalateNotMeasured({ reason });
    return { verdict: 'not-measured', reason, escalated: 1 };
  }

  // A built-in positive control. Every operator has session_briefs rows carrying
  // an activation; zero means the query matched nothing it should have matched
  // (wrong workspace, renamed column, a migration not applied) — which returns
  // an empty `wedged` list that is indistinguishable from a clean fleet.
  if (rows.length === 0) {
    const reason = 'no session_briefs rows carried an activation — the sweep cannot have measured anything';
    await deps.escalateNotMeasured({ reason });
    return { verdict: 'not-measured', reason, escalated: 1 };
  }

  const confirmed: Array<{ ownerId: string; reason: string }> = [];
  for (const row of rows) {
    const verdict = classifyCandidate(row);
    if (verdict.wedged) confirmed.push({ ownerId: row.ownerId, reason: verdict.reason });
  }

  if (confirmed.length === 0) return { verdict: 'clean', scanned: rows.length, escalated: 0 };

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

  if (wedged.length === 0) return { verdict: 'clean', scanned: rows.length, escalated: 0 };

  await deps.escalateWedged(wedged);
  return { verdict: 'wedged', scanned: rows.length, wedged, escalated: 1 };
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
      void runWedgedIdentitySweepOnce()
        .catch((e) => {
          console.warn(
            `[wedged-identity-activation-watchdog] sweep failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
          );
        })
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
