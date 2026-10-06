/**
 * gate-fire-ledger — P-001 (gate-verdict-liveness-and-repair-reliability-2026-08-31):
 * the durable per-fire ledger over `harness_shared.pipeline_events`.
 *
 * ## What existed before this module
 *
 * The mid-streak taxonomy work (D-004 of green-main-fast, the typed pre-suite no-verdict
 * writers in release-actions.ts) already gives every OUTCOME a typed
 * `kind='green_checkpoint'` pipeline event: skips (`skipped-locked`, `skipped-held`,
 * `skipped-memory-budget`, …), infra aborts (`migrations-pending`, `error`, `cancelled`,
 * `deadline-exceeded`, `infra-inconclusive`), reds (`not-green`), greens (`advanced`,
 * `up-to-date`, `advanced-prefix`), promotion failures (`not-fast-forward`,
 * `create-failed`) and the mid-run `decision-pending` bridge. The table is append-only
 * with NO pruning path (measured 2026-09-01: zero DELETE/prune sites outside tests), so
 * the ≥90d retention requirement holds by construction.
 *
 * ## The gap this module closes
 *
 * Nothing marked the FIRE itself. A tick or detached launch whose process died before its
 * first write — SIGKILL, OOM of the routine cage, a bg-host restart mid-run: exactly the
 * 74h-blackout class the 11-day-red audit measured — left ZERO rows, so "27 fires → 3
 * verdicts" was only reconstructable from logs, never SQL. `recordGateFire` writes one
 * ANCHOR row per fire at ENTRY (before admission/skip/suite), under its own kind:
 *
 *   kind = 'green_checkpoint_fire', status = 'fired'
 *
 * ⚠ The separate kind is load-bearing, not taste: at least four consumers treat "a
 * green_checkpoint row exists" as "an outcome happened" — green-stall-watchdog's
 * `last_verdict_ms` subquery is the CLOCK of the D-006 verdict-less limb, and an anchor
 * row under that kind would reset it every fire, structurally blinding the limb built to
 * catch fires-that-record-nothing. Anchors ride their own kind; every existing consumer
 * filters `kind = 'green_checkpoint'` exactly and never sees them. The DB CHECK admits
 * the new kind once migration 1054 applies; until then `appendPipelineEvent`'s
 * best-effort contract turns each anchor write into a warn-and-noop (visible, harmless).
 *
 * ## Reconstruction (the P-001 acceptance)
 *
 * `reconstructGateFireDays` answers, from SQL alone for any past day: how many fires,
 * how many of each outcome class, and how many fires are UNACCOUNTED (fired with no
 * outcome row after it that day — the killed/vanished class). Correlation uses the
 * stable gateFireId when both launcher and producer carry it: distinct anchor ids are
 * matched to at most one terminal outcome, while pending/diagnostic rows remain
 * non-terminal. Legacy rows without a valid id retain the historical per-day count
 * fallback because their historical rows cannot be correlated after the fact.
 */
import { randomUUID } from 'node:crypto';
import { isCheckpointCandidateSource } from './checkpoint-candidate-source';
import type { Sql } from 'postgres';
import { appendPipelineEvent, readGatePipelineWindow, type PipelineEventWindowRead, type PipelineEventRow } from '../harness/git-sync/pipeline-events';
import { evaluateTestPassReuseAuditWindow, parseTestPassReuseAuditArchive,
  parsePureProofCaptureArchive,
  type TestPassReuseAuditInvocation } from './test-pass-reuse-report';

/** The anchor kind. See the module doc — DO NOT fold anchors into 'green_checkpoint'. */
export const GATE_FIRE_KIND = 'green_checkpoint_fire' as const;
/** The one status anchors carry. */
export const GATE_FIRE_STATUS = 'fired' as const;
/** Environment transport from a launcher into the checkpoint producer. */
export const GATE_FIRE_ID_ENV = 'PAPERCUSP_GATE_FIRE_ID' as const;

/** Gate-fire identities are launcher-minted opaque values, bounded for env/detail transport. */
export function isGateFireId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value);
}

/** Mint one stable identity for one accepted scheduled or detached fire. */
export function mintGateFireId(): string {
  return randomUUID();
}

/** Read a valid transported identity; malformed env is treated as absent, never trusted. */
export function gateFireIdFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[GATE_FIRE_ID_ENV]?.trim();
  return isGateFireId(value) ? value : undefined;
}

export interface GateFireTarget {
  workspaceId: string;
  installSlug: string;
}

export interface GateFireContext {
  /** Which door fired the gate. */
  route: 'scheduled' | 'detached' | 'manual';
  /** The integration root the run will judge, when the caller knows it. */
  root?: string;
  /** The transient unit for a detached launch, when known. */
  unit?: string;
  /** Stable identity shared by this fire's anchor and terminal/pending rows. */
  gateFireId?: string;
  /** Free evidence (e.g. the routine tick id); bounded by the caller. */
  note?: string;
}

/**
 * Append one fire ANCHOR row. Best-effort by contract (appendPipelineEvent swallows +
 * warns): a ledger write must never break the fire it is recording — identical to every
 * other pipeline-event writer.
 */
export async function recordGateFire(target: GateFireTarget, ctx: GateFireContext, sql?: Sql): Promise<void> {
  await appendPipelineEvent(
    {
      workspaceId: target.workspaceId,
      installSlug: target.installSlug,
      kind: GATE_FIRE_KIND,
      status: GATE_FIRE_STATUS,
      detail: {
        route: ctx.route,
        ...(ctx.root ? { root: ctx.root } : {}),
        ...(ctx.unit ? { unit: ctx.unit } : {}),
        ...(isGateFireId(ctx.gateFireId) ? { gateFireId: ctx.gateFireId } : {}),
        ...(ctx.note ? { note: ctx.note } : {}),
      },
    },
    sql,
  );
}

/**
 * The outcome classes the reconstruction rolls green_checkpoint statuses into.
 * `verdict-green` / `verdict-red` are the only two that count as VERDICTS — the number
 * the audit's "27 fires → 3 verdicts" table is about. `promotion-failed` means the suite
 * judged green but main could not advance; it is deliberately NOT a verdict-green
 * (nothing shipped) and NOT a no-verdict (the code WAS judged) — it gets its own column.
 */
export type GateOutcomeClass =
  | 'verdict-green'
  | 'verdict-red'
  | 'no-verdict'
  | 'skip'
  | 'pending'
  | 'promotion-failed'
  | 'unknown';

/**
 * The known-status → class map behind `classifyGateOutcomeStatus`. A MAP rather than a
 * switch so derived views (P-003's `VERDICT_BEARING_STATUSES`, usable in SQL `= ANY`)
 * are computed FROM it mechanically instead of hand-copied beside it (derived-truth
 * ladder rung 1 — a second list is how `failed`-vs-`fail` never-match bugs happen).
 */
const GATE_OUTCOME_CLASS_BY_STATUS: Record<string, GateOutcomeClass> = {
  advanced: 'verdict-green',
  'advanced-prefix': 'verdict-green',
  'up-to-date': 'verdict-green',
  // the one red
  'not-green': 'verdict-red',
  // infra aborts / withheld verdicts
  error: 'no-verdict',
  cancelled: 'no-verdict',
  'deadline-exceeded': 'no-verdict',
  'migrations-pending': 'no-verdict',
  'disk-headroom': 'no-verdict',
  'infra-inconclusive': 'no-verdict',
  // Standing pre-suite abort: the repair queue's staging expectation mismatched the tree.
  'repair-staging-mismatch': 'no-verdict',
  // P-006/P-007 exit-74 prerequisite outages: refused before any test ran.
  'dependency-prewarm-missing': 'no-verdict',
  'dependency-generation-unusable': 'no-verdict',
  // WI-42207: a WITHHELD verdict (candidate older than the fossil cap at verdict time) —
  // the suite's opinion was discarded, so nothing was established about the code.
  'candidate-fossil': 'no-verdict',
  'not-fast-forward': 'promotion-failed',
  'create-failed': 'promotion-failed',
  // The suite judged the code green but the perf gate held promotion — same shape as
  // not-fast-forward: judged, nothing shipped. See green-checkpoint.ts stampPromotion(false, …).
  'perf-held': 'promotion-failed',
  'desktop-perf-held': 'promotion-failed',
  // mid-run bridge
  'decision-pending': 'pending',
  'repair-in-progress': 'skip',
  // WI-42350's decline-to-rejudge self-clears on tree movement.
  'unchanged-since-verdict': 'skip',
  // A release-fixer DISPATCH diagnostic row, not a tick outcome — it rides the
  // green_checkpoint kind but records fixer routing, so it must not read as a verdict.
  'release-fixer-skipped-stale': 'skip',
};

/**
 * The statuses that COUNT as a verdict about the code — derived from the map above, so it
 * cannot drift from `classifyGateOutcomeStatus`. P-003's rate alarm passes this to SQL
 * (`status = ANY(...)`) to find the newest verdict-bearing row without a second hand list.
 */
export const VERDICT_BEARING_STATUSES: readonly string[] = Object.entries(GATE_OUTCOME_CLASS_BY_STATUS)
  .filter(([, cls]) => cls === 'verdict-green' || cls === 'verdict-red')
  .map(([status]) => status);

/**
 * Rows written under `green_checkpoint` that are not terminal outcomes for a fire.
 * `decision-pending` is an in-run bridge and the release-fixer statuses are dispatch
 * diagnostics; none may satisfy a fire in the liveness ledger.
 */
export const NON_TERMINAL_GATE_OUTCOME_STATUSES = [
  'decision-pending',
  'release-fixer-skipped-scope',
  'release-fixer-skipped-stale',
  'release-fixer-skipped-no-measured-failures',
] as const;

export function isTerminalGateOutcomeStatus(status: string): boolean {
  return !(NON_TERMINAL_GATE_OUTCOME_STATUSES as readonly string[]).includes(status);
}

export const GATE_REUSE_AUDIT_INSTRUMENT_KEY = 'gate-test-reuse.audit-window';

/** The display candidate can remain frozen after a different repair head was judged. */
function matchesRecordedGateJudgedSha(detail: Record<string, unknown>, judgedSha: string): boolean {
  const sha = (value: unknown): value is string =>
    typeof value === 'string' && /^[0-9a-f]{12,40}$/.test(value);
  if (!sha(detail.candidate)) return false;
  if (judgedSha.startsWith(detail.candidate)) return true;
  const provenance = detail.verdictProvenance;
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) return false;
  const p = provenance as Record<string, unknown>;
  return detail.frozenCandidate === detail.candidate && sha(detail.repairHead) &&
    judgedSha.startsWith(detail.repairHead) && p.frozenCandidate === detail.frozenCandidate &&
    p.repairHead === detail.repairHead && p.frozenCandidateVerdict === 'full-gate-red' &&
    ((p.repairHeadVerdict === 'full-gate-red' &&
      ['awaiting-fixer', 'ready-to-verify', 'blocked'].includes(p.phase as string)) ||
     (p.repairHeadVerdict === 'isolated-repair-green' && p.phase === 'ready-to-promote'));
}

/** Duplicate writers must agree on the measured identity as well as the display pin. */
function gateReuseOutcomeIdentity(row: PipelineEventRow): string {
  return JSON.stringify([row.status, row.detail.runId, row.detail.candidate,
    row.detail.frozenCandidate, row.detail.repairHead, row.detail.verdictProvenance,
    row.detail.candidateSource, row.detail.diagnostic, row.detail.testPassReuse]);
}

/** Derive the invocation population from fire anchors and terminal archives, never a grader's list. */
export function evaluateGateReuseAuditWindow(read: PipelineEventWindowRead) {
  const fireIds: string[] = [];
  const excludedFireIds: string[] = [];
  const invocations: TestPassReuseAuditInvocation[] = [];
  const evidenceRefs = read.rows.map((r) => `pipeline-event:${r.id}`);
  const unknown = (reason: string) => ({ verdict: 'unknown' as const, reason, fireIds, excludedFireIds,
    runIds: invocations.map((r) => r.runId), audited: 0, alarms: 0, evidenceRefs });
  if (read.status !== 'complete' || read.total !== read.rows.length || read.rows.length === 0 ||
      !Number.isSafeInteger(read.windowStartMs) || !Number.isSafeInteger(read.windowEndMs) ||
      read.windowStartMs < 0 || read.windowStartMs >= read.windowEndMs) {
    return unknown(read.reason ?? 'A complete, nonempty canonical gate window is required.');
  }
  const groups = new Map<string, typeof read.rows>();
  for (const row of read.rows) {
    if (!isGateFireId(row.detail.gateFireId) || !row.id.trim() || !Number.isSafeInteger(row.createdAtMs)) {
      return unknown('A historical event lacks a qualified fire identity or timestamp.');
    }
    const rows = groups.get(row.detail.gateFireId) ?? [];
    rows.push(row);
    groups.set(row.detail.gateFireId, rows);
  }
  const seenRuns = new Set<string>();
  for (const [fireId, rows] of groups) {
    fireIds.push(fireId);
    const anchors = rows.filter((r) => r.kind === GATE_FIRE_KIND && r.status === GATE_FIRE_STATUS);
    const outcomes = rows.filter((r) => r.kind === 'green_checkpoint' && isTerminalGateOutcomeStatus(r.status));
    if (anchors.length !== 1 || outcomes.length === 0) return unknown('A fire has no unique anchor or completed outcome.');
    const anchor = anchors[0]!;
    if (anchor.createdAtMs < read.windowStartMs || anchor.createdAtMs > read.windowEndMs ||
        outcomes.some((r) => r.createdAtMs < anchor.createdAtMs || r.createdAtMs > read.windowEndMs)) {
      return unknown('A gate attempt crosses the exact observation boundaries.');
    }
    // Producer and scheduled fallback may both archive one terminal result. They may collapse
    // only when their measurement payloads agree; host/vintage/display stamps are irrelevant.
    if (new Set(outcomes.map(gateReuseOutcomeIdentity)).size !== 1) return unknown('Conflicting terminal archives name the same fire.');
    const outcome = outcomes.reduce((a, b) => a.createdAtMs <= b.createdAtMs ? a : b);
    const cls = classifyGateOutcomeStatus(outcome.status);
    if (cls === 'skip' && outcome.detail.testPassReuse === undefined) {
      excludedFireIds.push(fireId);
      continue;
    }
    if (!['verdict-green', 'verdict-red', 'promotion-failed'].includes(cls)) {
      return unknown('An attempt ended without a qualified suite measurement.');
    }
    const archive = parseTestPassReuseAuditArchive(outcome.detail.testPassReuse);
    const runId = outcome.detail.runId;
    if (!archive || typeof runId !== 'string' || !runId.trim() || seenRuns.has(runId) ||
        !matchesRecordedGateJudgedSha(outcome.detail, archive.judgedSha) || archive.recordedAtMs < anchor.createdAtMs ||
        archive.recordedAtMs > outcome.createdAtMs) {
      return unknown('The immutable archive lacks matching run, source or suite boundaries.');
    }
    const workspaces = archive.auditRuns.flatMap((r) => r.workspaces);
    const hasSelectorRuntime = workspaces.some((w) => w.runtime !== undefined);
    if (hasSelectorRuntime && workspaces.some((w) => !w.runtime ||
        w.runtime.judgedSha !== archive.judgedSha || w.runtime.runGroupId !== runId ||
        w.runtime.runContext !== 'green-checkpoint' || w.runtime.dirty !== false)) {
      return unknown('The archived selector runtime is missing or mismatches the initial suite.');
    }
    // A valid 5% draw can select zero files for one invocation. Its selector runtime must
    // then come from the original task line, never from another invocation's sample.
    const runnerIdentities = hasSelectorRuntime ? workspaces.map((w) => w.runtime!.runnerIdentity)
      : archive.auditedFiles.map((f) => f.runnerIdentity);
    const runners = new Set(runnerIdentities);
    const runnerIdentity = runnerIdentities[0];
    if (!runnerIdentity || runners.size !== 1) return unknown('The archived audit runner identity is unmeasured or ambiguous.');
    seenRuns.add(runId);
    invocations.push({ runId, judgedSha: archive.judgedSha, runnerIdentity,
      expectedRunGroupId: runId, startedAtMs: anchor.createdAtMs, completedAtMs: archive.recordedAtMs,
      output: '', auditRuns: archive.auditRuns, auditedFiles: archive.auditedFiles });
  }
  const result = evaluateTestPassReuseAuditWindow({ windowStartMs: read.windowStartMs,
    windowEndMs: read.windowEndMs, expectedRunIds: [...seenRuns], invocations });
  return { ...result, fireIds, excludedFireIds, evidenceRefs };
}

/**
 * R-3: select the FIRST later configured suite from complete immutable history. The required
 * command comes from the qualified gate configuration, not from whichever run reused files.
 * Unknown/incomplete earlier attempts block the answer; a later success cannot replace them.
 */
export function evaluateFirstPostCaptureGateReuse(input: {
  capture: unknown;
  captureRef: string;
  requiredCommand: string;
  read: PipelineEventWindowRead;
}) {
  const { read } = input;
  const evidenceRefs = [input.captureRef, ...read.rows.map((r) => `pipeline-event:${r.id}`)];
  const excludedRunIds: string[] = [];
  const result = (verdict: 'pass' | 'fail' | 'unknown', reason: string,
    runId: string | null = null, pureReused: number | null = null) =>
    ({ verdict, reason, runId, pureReused, excludedRunIds, evidenceRefs });
  const capture = parsePureProofCaptureArchive(input.capture);
  if (!capture || !input.captureRef.trim() || !input.requiredCommand.trim() || !capture.gateFireId ||
      capture.verdictRecordedAtMs === null || !capture.promotion || capture.capture?.state !== 'done' ||
      !capture.capture.evidence.proofs?.length || capture.capture.rows === 0) {
    return result('unknown', 'A named, nonempty clean capture with measured verdict and promotion boundaries is required.');
  }
  if (read.status !== 'complete' || read.total !== read.rows.length || !read.rows.length ||
      !Number.isSafeInteger(read.windowStartMs) || !Number.isSafeInteger(read.windowEndMs) ||
      read.windowStartMs < 0 || read.windowStartMs > capture.processStartedAtMs ||
      read.windowEndMs < capture.archivedAtMs || read.windowStartMs >= read.windowEndMs) {
    return result('unknown', 'Complete history must span the capture process and subsequent attempts.');
  }
  const groups = new Map<string, typeof read.rows>();
  const eventIds = new Set<string>();
  for (const row of read.rows) {
    if (!isGateFireId(row.detail.gateFireId) || !row.id.trim() || eventIds.has(row.id) ||
        !Number.isSafeInteger(row.createdAtMs) || row.createdAtMs < read.windowStartMs ||
        row.createdAtMs > read.windowEndMs) {
      return result('unknown', 'A historical event is duplicated or lacks a scoped identity or timestamp.');
    }
    eventIds.add(row.id);
    const rows = groups.get(row.detail.gateFireId) ?? [];
    rows.push(row);
    groups.set(row.detail.gateFireId, rows);
  }
  const attempts: Array<{ anchor: PipelineEventRow; rows: PipelineEventRow[] }> = [];
  for (const rows of groups.values()) {
    const anchors = rows.filter((r) => r.kind === GATE_FIRE_KIND && r.status === GATE_FIRE_STATUS);
    if (anchors.length !== 1 || rows.some((r) => r.createdAtMs < anchors[0]!.createdAtMs)) {
      return result('unknown', 'A historical attempt lacks a unique preceding fire anchor.');
    }
    attempts.push({ anchor: anchors[0]!, rows });
  }
  const source = groups.get(capture.gateFireId);
  const sourceOutcomes = source?.filter((r) => r.kind === 'green_checkpoint' && isTerminalGateOutcomeStatus(r.status)) ?? [];
  if (new Set(sourceOutcomes.map(gateReuseOutcomeIdentity)).size !== 1 ||
      !sourceOutcomes.some((r) => ['verdict-green', 'verdict-red', 'promotion-failed'].includes(classifyGateOutcomeStatus(r.status)) &&
      r.detail.runId === capture.runId && matchesRecordedGateJudgedSha(r.detail, capture.judgedSha) &&
      isCheckpointCandidateSource(r.detail.candidateSource) && r.detail.candidateSource !== 'pinned' &&
      r.detail.diagnostic === undefined &&
      r.createdAtMs <= capture.capture!.evidence.startedAtMs)) {
    return result('unknown', 'The capture is not bound to its canonical recorded gate outcome.');
  }
  const runners = new Set(capture.capture.evidence.proofs.map((p) => p.runnerIdentity));
  attempts.sort((a, b) => a.anchor.createdAtMs - b.anchor.createdAtMs);
  const later = attempts.filter((a) => a.anchor.createdAtMs > capture.capture!.evidence.completedAtMs);
  const seenRunIds = new Set([capture.runId]);
  if (later.some((a, i) => i > 0 && a.anchor.createdAtMs === later[i - 1]!.anchor.createdAtMs)) {
    return result('unknown', 'Subsequent fire ordering is ambiguous.');
  }
  for (const { anchor, rows } of later) {
    const outcomes = rows.filter((r) => r.kind === 'green_checkpoint' && isTerminalGateOutcomeStatus(r.status));
    if (!outcomes.length) return result('unknown', 'An earlier subsequent attempt has no completed outcome.');
    if (new Set(outcomes.map(gateReuseOutcomeIdentity)).size !== 1) {
      return result('unknown', 'An earlier subsequent attempt has conflicting terminal archives.');
    }
    const outcome = outcomes.reduce((a, b) => a.createdAtMs <= b.createdAtMs ? a : b);
    if (classifyGateOutcomeStatus(outcome.status) === 'skip' && outcome.detail.testPassReuse === undefined) continue;
    if (outcome.detail.candidateSource === 'pinned' || outcome.detail.diagnostic === 'candidate-pinned') {
      if (typeof outcome.detail.runId !== 'string' || !outcome.detail.runId.trim()) {
        return result('unknown', 'A diagnostic attempt lacks a measured run identity.');
      }
      excludedRunIds.push(outcome.detail.runId);
      continue;
    }
    if (!isCheckpointCandidateSource(outcome.detail.candidateSource) || outcome.detail.diagnostic !== undefined) {
      return result('unknown', 'An earlier subsequent attempt lacks live candidate provenance.');
    }
    const archive = parseTestPassReuseAuditArchive(outcome.detail.testPassReuse);
    const suite = archive?.suite;
    if (!archive || !suite || suite.runGroupId !== outcome.detail.runId ||
        seenRunIds.has(suite.runGroupId) ||
        suite.startedAtMs < anchor.createdAtMs || archive.recordedAtMs > outcome.createdAtMs ||
        !matchesRecordedGateJudgedSha(outcome.detail, archive.judgedSha)) {
      return result('unknown', 'An earlier subsequent suite lacks measured command, run or source boundaries.');
    }
    seenRunIds.add(suite.runGroupId);
    if (suite.command !== input.requiredCommand) { excludedRunIds.push(suite.runGroupId); continue; }
    const workspaces = archive.auditRuns.flatMap((r) => r.workspaces);
    if (workspaces.some((w) => !w.runtime || w.runtime.runGroupId !== suite.runGroupId ||
        w.runtime.judgedSha !== archive.judgedSha || w.runtime.runContext !== 'green-checkpoint' ||
        w.runtime.dirty !== false || !runners.has(w.runtime.runnerIdentity) || w.lane === null ||
        !Number.isSafeInteger(w.counts.reused) || w.counts.reused < 0)) {
      return result('unknown', 'The first required suite lacks matching clean selector identities or lane measurements.');
    }
    const pureReused = workspaces.filter((w) => w.lane === 'pure').reduce((n, w) => n + w.counts.reused, 0);
    return result(pureReused > 0 ? 'pass' : 'fail',
      'Measured pure reuse in the first subsequent required suite.', suite.runGroupId, pureReused);
  }
  return result('unknown', 'No subsequent required suite is present in the complete historical window.');
}

/** Read only historical immutable records. This does not inspect, fire or monitor the live gate. */
export async function measureGateReuseAuditWindow(
  input: GateFireTarget & { windowStartMs: number; windowEndMs: number },
  sql?: Sql,
) {
  const read = await readGatePipelineWindow(input, { ...input,
    nonTerminalStatuses: NON_TERMINAL_GATE_OUTCOME_STATUSES }, sql);
  return { ...evaluateGateReuseAuditWindow(read), populationStatus: read.status, totalEvents: read.total };
}

/**
 * Classify one `kind='green_checkpoint'` status string. Single-homed here on purpose —
 * P-002's taxonomy work and P-003's rate alarm both need this exact map, and two copies
 * of it is how `failed`-vs-`fail` style never-match bugs happen.
 *
 * Unknown statuses fall back by prefix (`skipped-*` ⇒ skip) and then to 'unknown', so a
 * future status is VISIBLE in the reconstruction (its own column) rather than silently
 * absorbed into a class it may not belong to.
 */
export function classifyGateOutcomeStatus(status: string): GateOutcomeClass {
  const cls = GATE_OUTCOME_CLASS_BY_STATUS[status];
  if (cls) return cls;
  return status.startsWith('skipped-') ? 'skip' : 'unknown';
}

/** One reconstructed day. `unaccounted` = fires with no outcome row that day (killed/vanished). */
export interface GateFireDay {
  /** ISO date (UTC day). */
  day: string;
  /** Anchor rows (kind='green_checkpoint_fire'). 0 for days before the anchor landed. */
  fires: number;
  /** Outcome rows (kind='green_checkpoint'), total, including pending/diagnostic rows. */
  outcomes: number;
  /** Terminal outcome rows only; pending/diagnostic rows are excluded. */
  terminalOutcomes: number;
  verdictsGreen: number;
  verdictsRed: number;
  noVerdicts: number;
  skips: number;
  pending: number;
  promotionFailed: number;
  unknown: number;
  /**
   * max(0, fires - outcomes): fires that left NO outcome row — the silent-death class.
   * Meaningful only once the anchor is live; a pre-anchor day reads fires=0 so this
   * stays 0 rather than inventing negative history.
   */
  unaccounted: number;
  /** Distinct raw statuses that classified 'unknown', so a new status is nameable. */
  unknownStatuses: string[];
}

/**
 * The acceptance query: reconstruct the per-day fires→outcomes table for `sinceDays`
 * back, from SQL alone. Classification happens HERE (TS) so it stays single-homed with
 * `classifyGateOutcomeStatus`; the SQL is one grouped fetch over both kinds.
 */
export async function reconstructGateFireDays(
  sql: Sql,
  target: GateFireTarget,
  opts: { sinceDays?: number } = {},
): Promise<GateFireDay[]> {
  const sinceDays = Math.max(1, Math.min(365, Math.floor(opts.sinceDays ?? 14)));
  const rows = await sql<{
    day: string;
    kind: string;
    status: string;
    gate_fire_id: string | null;
    n: string | number;
  }[]>`
    SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
           kind,
           status,
           NULLIF(detail->>'gateFireId', '') AS gate_fire_id,
           count(*) AS n
      FROM harness_shared.pipeline_events
     WHERE workspace_id = ${target.workspaceId}
       AND install_slug = ${target.installSlug}
       AND kind IN ('green_checkpoint', ${GATE_FIRE_KIND})
       AND created_at >= now() - make_interval(days => ${sinceDays})
     GROUP BY 1, 2, 3, 4
     ORDER BY 1`;
  type DayAccumulator = GateFireDay & {
    anchorIds: Set<string>;
    terminalIds: Set<string>;
    legacyFires: number;
    legacyOutcomes: number;
  };
  const byDay = new Map<string, DayAccumulator>();
  const dayOf = (day: string): DayAccumulator => {
    let d = byDay.get(day);
    if (!d) {
      d = {
        day,
        fires: 0,
        outcomes: 0,
        terminalOutcomes: 0,
        verdictsGreen: 0,
        verdictsRed: 0,
        noVerdicts: 0,
        skips: 0,
        pending: 0,
        promotionFailed: 0,
        unknown: 0,
        unaccounted: 0,
        unknownStatuses: [],
        anchorIds: new Set<string>(),
        terminalIds: new Set<string>(),
        legacyFires: 0,
        legacyOutcomes: 0,
      };
      byDay.set(day, d);
    }
    return d;
  };
  for (const row of rows) {
    const d = dayOf(row.day);
    const n = Number(row.n);
    if (!Number.isFinite(n) || n <= 0) continue;
    if (row.kind === GATE_FIRE_KIND) {
      if (row.status === GATE_FIRE_STATUS) {
        d.fires += n;
        if (isGateFireId(row.gate_fire_id)) d.anchorIds.add(row.gate_fire_id);
        else d.legacyFires += n;
      }
      continue;
    }
    d.outcomes += n;
    if (!isGateFireId(row.gate_fire_id)) d.legacyOutcomes += n;
    const terminal = isTerminalGateOutcomeStatus(row.status);
    if (terminal) {
      d.terminalOutcomes += n;
      if (isGateFireId(row.gate_fire_id)) d.terminalIds.add(row.gate_fire_id);
    }
    switch (classifyGateOutcomeStatus(row.status)) {
      case 'verdict-green':
        d.verdictsGreen += n;
        break;
      case 'verdict-red':
        d.verdictsRed += n;
        break;
      case 'no-verdict':
        d.noVerdicts += n;
        break;
      case 'skip':
        d.skips += n;
        break;
      case 'pending':
        d.pending += n;
        break;
      case 'promotion-failed':
        d.promotionFailed += n;
        break;
      case 'unknown':
        d.unknown += n;
        if (!d.unknownStatuses.includes(row.status)) d.unknownStatuses.push(row.status);
        break;
    }
  }
  for (const d of byDay.values()) {
    // Stable identities reconcile one terminal outcome to one fire, so a pending bridge,
    // duplicate terminal row, or a different fire's healthy outcome cannot mask a death.
    // Legacy rows have no correlation identity; preserve the historical count fallback
    // (including pending/diagnostic rows) rather than inventing terminal ownership.
    const identifiedFires = d.anchorIds.size;
    const identifiedTerminalFires = [...d.anchorIds].filter((id) => d.terminalIds.has(id)).length;
    const legacyFires = Math.max(0, d.fires - identifiedFires);
    d.unaccounted =
      d.fires > 0
        ? Math.max(0, identifiedFires - identifiedTerminalFires) +
          Math.max(0, legacyFires - d.legacyOutcomes)
        : 0;
    d.unknownStatuses.sort();
    delete (d as Partial<DayAccumulator>).anchorIds;
    delete (d as Partial<DayAccumulator>).terminalIds;
    delete (d as Partial<DayAccumulator>).legacyFires;
    delete (d as Partial<DayAccumulator>).legacyOutcomes;
  }
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}
