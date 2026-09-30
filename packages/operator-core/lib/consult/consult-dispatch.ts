/**
 * consult-dispatch.ts — how a consult reaches an expert's KNOWLEDGE without ever
 * messaging a live agent (plan consult-expert-routing-2026-09-22, P-003).
 *
 * [owner 2026-09-22] "lets stop directing messages to live agents. I don't want
 * to distract them. Instead lets always fork the session or convert to a new
 * session (cross-model we cant fork)" (D-002), over a ranked allowlist of models
 * allowed to answer (D-004), walking past a walled account until one launches
 * (R-6).
 *
 * WHAT REPLACES WHAT. This module retires TWO older behaviours at once:
 *   - the directed ping + wake of a LIVE selectee (`GetFeedbackDeps.reach` bound
 *     to notifyAgents) — the distraction the owner asked us to stop; and
 *   - revive-responder's resume-IN-PLACE of a dead expert, which re-animated the
 *     expert's ORIGINAL identity.
 * Both collapse into one path, which is the point of D-002: dead and live
 * experts are now handled identically, so there is no liveness branch left to
 * get wrong, no per-responder load cap to tune, and no woken-but-silent case.
 *
 * THE WALK (D-009, measured — not a guess about what the platform can do):
 *   1. rank's backend === source's backend  → FORK (claude/codex). OMP has no
 *      native branch command, so an OMP source cannot fork at all.
 *   2. Claude source, different backend     → CONVERT (session port), and only
 *      while the source is NOT live — see `convert-needs-live-source-identity`.
 *   3. non-Claude source, different backend → NOT REACHABLE. The session-port
 *      transform is claude-source-only BY CONSTRUCTION (one adapter exists), so
 *      this is a SKIP, exactly like a walled account — never an error, and never
 *      the end of the consult.
 *
 * FAILURE IS A STEP, NOT A STOP. Every skip/failure reason is recorded on the
 * attempt and the walk continues; only an exhausted list is terminal
 * (`no_available_responder`). That is what makes "Claude is walled but Codex is
 * available" self-healing rather than an owner-visible stall.
 *
 * Reuses the launch-agent building blocks verbatim (resolveResumeTarget /
 * buildAgentLaunchCommand / buildConsoleEnvelope / spawnHeadless /
 * verifyResumeStarted) so dispatch cannot drift from the one audited launch
 * path — including the P-002 `targetAgent` conversion contract.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Sql } from 'postgres';
import {
  buildAgentLaunchCommand,
  injectLaunchedByArg,
  resolveResumeTarget,
  verifyResumeStarted,
  type ResumeTarget,
} from '../agent-launch-core';
import { fetchContextPressure } from '../agent-tools/coordination/context-pressure';
import { buildConsoleEnvelope } from '../console-launcher';
import { spawnHeadless, type SpawnChildExit } from '../console-spawn';
import { resolveSpawnHostOperatorBaseUrl } from '../mcp-base-url';
import { papercuspPathForWorkspace } from '../papercusp-root';
import { codexHomeForSessionKey } from '@papercusp/orchestrator/session-launch-dirs';
import {
  resolveExpertModelAllowlist,
  type AllowedExpertModel,
  type ExpertBackend,
  type ExpertModelAllowlistDeps,
} from './expert-model-allowlist';
import type { ConsultReviewerModel } from './get-feedback-core';
import { ACCEPTANCE_BAR_AMENDMENT_REVIEW_POLICY } from './selection-policies';

/** How long the dispatcher waits for the answering session's pty host to
 * register before reporting verified:null (booting). Same budget and same
 * three-state contract as the retired reviver: the consult sits on the
 * requester's critical path, and null is an honest "still booting", never a
 * failure — the cascade expiry guards the reply. */
export const DISPATCH_VERIFY_TIMEOUT_MS = 15_000;

export type DispatchOperation = 'fork' | 'convert';

export interface ConsultDispatchEvidenceRef {
  session_id: string;
  turn_idx: number;
  ts?: string | null;
  sim?: number;
  lexicalRank?: number;
}

export interface ConsultEvidenceSource {
  sessionId: string;
  evidence: ConsultDispatchEvidenceRef[];
}

/** A candidate can have evidence across several native sessions. A fork or
 * session port has one source transcript, so choose the session with the
 * strongest measured hit and retain only that session's exact refs. */
export function selectConsultEvidenceSource(
  refs: readonly ConsultDispatchEvidenceRef[] | undefined,
): ConsultEvidenceSource | null {
  const groups = new Map<string, ConsultDispatchEvidenceRef[]>();
  for (const ref of refs ?? []) {
    if (!ref || typeof ref.session_id !== 'string' || !ref.session_id.trim() ||
        !Number.isSafeInteger(ref.turn_idx) || ref.turn_idx < 0) continue;
    const group = groups.get(ref.session_id) ?? [];
    group.push(ref);
    groups.set(ref.session_id, group);
  }
  const score = (ref: ConsultDispatchEvidenceRef) =>
    Number.isFinite(ref.lexicalRank) ? ref.lexicalRank! : Number.isFinite(ref.sim) ? ref.sim! : 0;
  const ranked = [...groups.entries()].sort(([sessionA, a], [sessionB, b]) => {
    const bestA = Math.max(...a.map(score));
    const bestB = Math.max(...b.map(score));
    return bestB - bestA || b.length - a.length || sessionA.localeCompare(sessionB);
  });
  const [sessionId, evidence] = ranked[0] ?? [];
  if (!sessionId || !evidence) return null;
  return { sessionId, evidence: [...evidence].sort((a, b) => a.turn_idx - b.turn_idx) };
}

/**
 * Why a rank did not produce the answering session. Machine-readable because the
 * requester's hint, the routing snapshot and the P-009 census all need to tell
 * "every allowed model was walled" apart from "this expert cannot be reached at
 * all" — they call for different action and used to be one undifferentiated
 * failure.
 */
export type DispatchSkipReason =
  | 'fork-unsupported'
  | 'conversion-unavailable'
  | 'convert-needs-live-source-identity'
  | 'account-walled'
  | 'source-context-critical'
  | 'evidence-span-unavailable'
  | 'launch-failed'
  | 'kickoff-not-persisted'
  | 'launch-exited';

export interface ConsultDispatchAttempt {
  rank: number;
  agent: ExpertBackend;
  model: string;
  /** null when the rank was unreachable before any operation could be chosen. */
  operation: DispatchOperation | null;
  outcome: 'dispatched' | 'skipped' | 'failed';
  reason?: DispatchSkipReason;
  detail: string;
  /**
   * The launcher's own words for a spawned rank that did not survive, read from
   * its launch log (e.g. psu's "refusing unmanaged fork …"). `reason` says only
   * which dispatcher check failed; this says why psu or the CLI gave up.
   * Absent when the log holds no recognisable failure line.
   */
  launchError?: string;
}

export interface ConsultDispatchResult {
  dispatched: boolean;
  /**
   * The coord identity that will ANSWER — what the consult row must record as
   * its responder, so the answering session's first `consult:reply` has a
   * participant gate to pass.
   *
   * A FORK is a genuinely new session, so this is a freshly pre-pinned id. A
   * CONVERT continues the source's identity onto the other backend (the session
   * port's authority-continuity invariant), so this is the source's own id.
   * Either way the caller writes what it is TOLD, never what it assumed.
   */
  answeringOwnerId: string | null;
  operation: DispatchOperation | null;
  agent: ExpertBackend | null;
  model: string | null;
  /** Three-state, as the launch verifier: true = a live host registered; null =
   * still booting (NOT a failure); false = the launch did not survive. */
  verified: boolean | null;
  detail: string;
  /** Every rank considered, in walk order — the evidence for the verdict. */
  attempts: ConsultDispatchAttempt[];
}

export interface ConsultDispatchContext {
  workspaceId: string;
  /** Harness slug for the console envelope; null ⇒ the workspace home checkout. */
  harnessSlug: string | null;
  /** The requester's coord id — `--launched-by` provenance on the launch. */
  launchedBy: string | null;
}

export interface BackendAvailability {
  available: boolean;
  detail: string;
}

/** Injectable seams — unit tests pass fakes; production omits (real impls). */
export interface ConsultDispatchDeps extends ExpertModelAllowlistDeps {
  /** Test seam for the saved per-review model, read again on every cascade leg. */
  readReviewerModel?: (workspaceId: string, conversationId: string) => Promise<ConsultReviewerModel | null>;
  resolveResumeTarget: typeof resolveResumeTarget;
  checkResumeTranscript: (target: ResumeTarget) => Promise<{ available: boolean; detail: string }>;
  buildAgentLaunchCommand: typeof buildAgentLaunchCommand;
  injectLaunchedByArg: typeof injectLaunchedByArg;
  buildConsoleEnvelope: typeof buildConsoleEnvelope;
  spawnHeadless: typeof spawnHeadless;
  verifyResumeStarted: typeof verifyResumeStarted;
  fetchContextPressure: typeof fetchContextPressure;
  /** Is there budget to run this backend at all right now? (D-004 walls.) */
  probeBackendAvailable: (agent: ExpertBackend, workspaceId: string) => Promise<BackendAvailability>;
  mintOwnerId: () => string;
  /**
   * Stop a session this rank SPAWNED but then failed (EI-24106882795589775).
   * Returns a short outcome for the attempt record; never throws.
   */
  stopFailedLaunch: (taskId: string | null | undefined) => Promise<string>;
  /**
   * The failure line a spawned rank's launch log ends on, or null. Never throws.
   * (WI-10003197: psu refusals were visible only by grepping fleet-logs.)
   */
  readLaunchLogReason: (logPath: string | null | undefined) => Promise<string | null>;
  /**
   * Persist this dispatch walk on its consult row. Best-effort: the dispatcher
   * swallows a throw, because losing the record must never cost the dispatch.
   */
  recordDispatchAttempts: (record: ConsultDispatchRecordInput) => Promise<void>;
  /**
   * The source's persisted dispatch walks since `sinceIso`, for the cool-down
   * (WI-10003198). A throw fails OPEN: the cool-down only prevents repeat
   * launches, so losing it must never block a dispatch.
   */
  readSourceDispatchRecords: (
    workspaceId: string,
    sourceOwnerId: string,
    sinceIso: string,
  ) => Promise<PersistedDispatchRecord[]>;
  /** Clock seam for the cool-down. */
  nowMs: () => number;
}

/** What {@link ConsultDispatchDeps.recordDispatchAttempts} persists for one walk. */
export interface ConsultDispatchRecordInput {
  workspaceId: string;
  conversationId: string;
  sourceOwnerId: string;
  result: ConsultDispatchResult;
}

/** Newest dispatch records kept on `consult_state.dispatch_attempts` (migration 1225). */
export const DISPATCH_RECORDS_MAX = 24;
/** Per-string bound inside a persisted record — a pointer, never a log copy. */
export const DISPATCH_RECORD_TEXT_MAX = 600;

const clip = (s: string, max = DISPATCH_RECORD_TEXT_MAX): string =>
  s.length <= max ? s : `${s.slice(0, max - 1)}…`;

/** The persisted shape of one dispatch walk (bounded strings, stamped time). */
export function dispatchRecordEntry(input: ConsultDispatchRecordInput, nowIso: string): Record<string, unknown> {
  const r = input.result;
  return {
    at: nowIso,
    sourceOwnerId: input.sourceOwnerId,
    dispatched: r.dispatched,
    answeringOwnerId: r.answeringOwnerId,
    operation: r.operation,
    agent: r.agent,
    model: r.model,
    verified: r.verified,
    detail: clip(r.detail),
    attempts: r.attempts.map((a) => ({
      rank: a.rank,
      agent: a.agent,
      model: a.model,
      operation: a.operation,
      outcome: a.outcome,
      ...(a.reason ? { reason: a.reason } : {}),
      detail: clip(a.detail),
      ...(a.launchError ? { launchError: clip(a.launchError, 300) } : {}),
    })),
  };
}

/**
 * Append one record to `consult_state.dispatch_attempts`, keeping the newest
 * {@link DISPATCH_RECORDS_MAX} in append order. It deliberately leaves
 * `updated_at` alone — expiry and staleness readers key on it, and recording
 * evidence must not look like consult activity. Exported for the real-Postgres
 * test; production calls it through {@link defaultRecordDispatchAttempts}.
 */
export async function appendDispatchRecord(
  sql: Sql,
  input: ConsultDispatchRecordInput,
  nowIso: string,
): Promise<void> {
  await appendDispatchRecordEntry(sql, input, dispatchRecordEntry(input, nowIso));
}

/**
 * The one bounded append behind every `dispatch_attempts` writer — a launch walk
 * ({@link appendDispatchRecord}) or an answer-window failure
 * ({@link appendAnswerFailureRecord}).
 */
async function appendDispatchRecordEntry(
  sql: Sql,
  target: { workspaceId: string; conversationId: string },
  record: Record<string, unknown>,
): Promise<void> {
  // `::text` THEN `::jsonb`: typing the parameter as text makes postgres.js send
  // the string as-is on ANY client. A bare `${entry}::jsonb` infers a jsonb param,
  // and a client without the canonical hybrid serializer (restoreRawJsonbSerializer)
  // JSON-encodes it again — storing a jsonb STRING, not an object (caught by
  // consult-dispatch-record.integration.test.ts on a plain client). Not sql.json():
  // the org pool has mishandled that in templates (EI-10445).
  const entry = JSON.stringify(record);
  await sql`
    UPDATE harness_shared.consult_state
       SET dispatch_attempts = (
         SELECT COALESCE(jsonb_agg(e ORDER BY ord), '[]'::jsonb)
           FROM (
             SELECT e, ord
               FROM jsonb_array_elements(dispatch_attempts || jsonb_build_array(${entry}::text::jsonb))
                    WITH ORDINALITY AS t(e, ord)
              ORDER BY ord DESC
              LIMIT ${DISPATCH_RECORDS_MAX}
           ) kept
       )
     WHERE workspace_id = ${target.workspaceId} AND conversation_id = ${target.conversationId}
  `;
}

// ── Answer-window failures (WI-10003199, plan review-routing-through-relevance-router P-003) ──
//
// A launch walk records whether a session STARTED. It says nothing about whether
// that session then ANSWERED. Measured 2026-09-26 over 3 days of consult answering
// sessions: 8 launched, never posted, and ran a median 58 min (max 190) before the
// task reaper noticed — and none of them left any trace on their consult. The
// consult expiry sweep, the one actor that decides a slot's window is over, now
// stops that session and appends one of these records, so "launched but silent" is
// a failed attempt with a reason instead of an absence.

/** Why a launched answering session ended without posting. */
export type AnswerFailureReason =
  /** The slot's consult window elapsed (the cascade advanced, or the consult expired). */
  | 'answer-window-expired'
  /** Bounded pickup recovery found no consult post before the window (implicit decline). */
  | 'answer-pickup-stalled'
  /** A silent review consult was converted to pullable work at half its window. */
  | 'answer-window-converted';

export interface AnswerFailureRecordInput {
  workspaceId: string;
  conversationId: string;
  /** The expert the slot was selected for (`selection.selected[cursor].ownerId`). */
  sourceOwnerId: string;
  /** The slot's `answeringOwnerId` stamp; null when dispatch never stamped one. */
  answeringOwnerId: string | null;
  cascadeCursor: number;
  reason: AnswerFailureReason;
  detail: string;
  /** What stopping the session did, e.g. `stopped task …` or `no live answering session found`. */
  stopOutcome: string;
}

/**
 * The persisted shape of an answer-window failure. It deliberately mirrors a launch
 * walk's top level, so `conversations:get` renders it with no special case, and its
 * single attempt carries `outcome:'failed'` + the reason.
 *
 * `dispatched:false` with a reason outside the launch-failure set keeps it NEUTRAL to
 * the source cool-down: it launched nothing, so it neither counts as a failed launch
 * nor resets the count the way a successful dispatch does.
 */
export function answerFailureRecordEntry(input: AnswerFailureRecordInput, nowIso: string): Record<string, unknown> {
  const detail = clip(`${input.detail}; ${input.stopOutcome}`);
  return {
    at: nowIso,
    sourceOwnerId: input.sourceOwnerId,
    dispatched: false,
    answeringOwnerId: input.answeringOwnerId,
    operation: null,
    agent: null,
    model: null,
    verified: null,
    detail,
    answerFailure: {
      reason: input.reason,
      cascadeCursor: input.cascadeCursor,
      stopOutcome: clip(input.stopOutcome, 300),
    },
    attempts: [
      { rank: null, agent: null, model: null, operation: null, outcome: 'failed', reason: input.reason, detail },
    ],
  };
}

/** Append one {@link answerFailureRecordEntry} to its consult's `dispatch_attempts`. */
export async function appendAnswerFailureRecord(
  sql: Sql,
  input: AnswerFailureRecordInput,
  nowIso: string,
): Promise<void> {
  await appendDispatchRecordEntry(sql, input, answerFailureRecordEntry(input, nowIso));
}

/** Default recorder: {@link appendDispatchRecord} through the org pool. */
async function defaultRecordDispatchAttempts(input: ConsultDispatchRecordInput): Promise<void> {
  const { getOrgPg } = await import('@papercusp/db-org');
  await appendDispatchRecord(getOrgPg().sql as unknown as Sql, input, new Date().toISOString());
}

// ── Source cool-down (WI-10003198, plan review-routing-through-relevance-router P-002) ──
//
// Measured 2026-09-26: one source (fa2b9674, an earlier incarnation of
// su-5078d176) was launched 144 times — 72 forks, 72 converts — and psu refused
// every one within seconds, because each new consult routed to it re-ran the
// same doomed walk. A source whose launches keep failing is therefore skipped
// for a cool-down instead of launched again. The state is DERIVED from the
// persisted walks on consult_state.dispatch_attempts (migration 1225), not kept
// in a second table: those records are already the ground truth for what was
// launched and how it ended, so nothing can drift.

/** Consecutive failed launches (since the source's last dispatch) that start a cool-down. */
export const SOURCE_LAUNCH_FAILURE_THRESHOLD = 3;
/** How long a source is skipped after its latest failed launch once the threshold is met. */
export const SOURCE_COOLDOWN_MS = 60 * 60_000;
/** How far back failed launches still count toward the threshold. */
export const SOURCE_FAILURE_LOOKBACK_MS = 6 * 60 * 60_000;

/** Attempt reasons that mean a session was actually launched (or its launch
 *  composed) and did not survive. Skips — walls, pressure, unsupported
 *  operations — launch nothing and are never counted. */
const LAUNCH_FAILURE_REASONS: ReadonlySet<string> = new Set<DispatchSkipReason>([
  'launch-failed',
  'kickoff-not-persisted',
  'launch-exited',
]);

/** The fields of a persisted walk ({@link dispatchRecordEntry}) the cool-down reads. */
export interface PersistedDispatchRecord {
  at: string;
  sourceOwnerId?: string;
  dispatched?: boolean;
  attempts?: Array<{ outcome?: string; reason?: string; agent?: string; model?: string; launchError?: string; detail?: string }>;
}

export interface SourceCooldown {
  /** Failed launches counted, newest first, back to the last dispatch. */
  failures: number;
  /** ISO time the cool-down ends. */
  until: string;
  /** The newest counted failure, for the refusal detail. */
  lastFailure: string;
}

/**
 * The cool-down a source is in, or null. Pure. Walks the source's persisted
 * walks newest first and counts failed launches until it meets one that
 * dispatched (a success resets the count). A walk that launched nothing — a
 * refusal, an all-skipped walk, or an earlier cool-down — neither counts nor
 * resets, so a cool-down never extends itself.
 */
export function sourceCooldownFrom(
  records: readonly PersistedDispatchRecord[],
  nowMs: number,
  {
    threshold = SOURCE_LAUNCH_FAILURE_THRESHOLD,
    cooldownMs = SOURCE_COOLDOWN_MS,
    lookbackMs = SOURCE_FAILURE_LOOKBACK_MS,
  } = {},
): SourceCooldown | null {
  const sorted = [...records]
    .filter((r) => typeof r?.at === 'string' && Number.isFinite(Date.parse(r.at)))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  let failures = 0;
  let newestFailureAt: number | null = null;
  let lastFailure = '';
  for (const record of sorted) {
    const at = Date.parse(record.at);
    if (nowMs - at > lookbackMs) break;
    if (record.dispatched === true) break;
    for (const attempt of record.attempts ?? []) {
      if (attempt?.outcome !== 'failed' || !attempt.reason || !LAUNCH_FAILURE_REASONS.has(attempt.reason)) continue;
      failures += 1;
      if (newestFailureAt == null) {
        newestFailureAt = at;
        lastFailure =
          `${attempt.reason} on ${attempt.agent ?? '?'}/${attempt.model ?? '?'}` +
          (attempt.launchError ? `: ${clip(attempt.launchError, 200)}` : '');
      }
    }
  }
  if (failures < threshold || newestFailureAt == null) return null;
  const until = newestFailureAt + cooldownMs;
  if (nowMs >= until) return null;
  return { failures, until: new Date(until).toISOString(), lastFailure };
}

/**
 * The source's persisted walks since `sinceIso`, newest first, across every
 * consult in the workspace. Exported for the real-Postgres test; production
 * calls it through {@link defaultReadSourceDispatchRecords}.
 */
export async function readSourceDispatchRecords(
  sql: Sql,
  workspaceId: string,
  sourceOwnerId: string,
  sinceIso: string,
  limit = 60,
): Promise<PersistedDispatchRecord[]> {
  // The consult bound is the lookback plus the longest a consult stays open
  // (measured 2026-09-26: p99 8 h, max 32 h over 1,300 consults), so a walk
  // appended to a long-lived consult is still seen. Records carry an ISO `at`
  // from toISOString(), which compares correctly as text.
  const rows = await sql<Array<{ e: unknown }>>`
    SELECT r.e
      FROM harness_shared.consult_state c
     CROSS JOIN LATERAL jsonb_array_elements(c.dispatch_attempts) AS r(e)
     WHERE c.workspace_id = ${workspaceId}
       AND c.created_at >= ${sinceIso}::timestamptz - interval '2 days'
       AND jsonb_array_length(c.dispatch_attempts) > 0
       AND r.e->>'sourceOwnerId' = ${sourceOwnerId}
       AND r.e->>'at' >= ${sinceIso}
     ORDER BY r.e->>'at' DESC
     LIMIT ${limit}
  `;
  return rows
    .map((row) => (typeof row.e === 'string' ? (JSON.parse(row.e) as unknown) : row.e))
    .filter((e): e is PersistedDispatchRecord => !!e && typeof e === 'object' && typeof (e as { at?: unknown }).at === 'string');
}

/** Default reader: {@link readSourceDispatchRecords} through the org pool. */
async function defaultReadSourceDispatchRecords(
  workspaceId: string,
  sourceOwnerId: string,
  sinceIso: string,
): Promise<PersistedDispatchRecord[]> {
  const { getOrgPg } = await import('@papercusp/db-org');
  return readSourceDispatchRecords(getOrgPg().sql as unknown as Sql, workspaceId, sourceOwnerId, sinceIso);
}

/** Strip terminal control sequences (CSI and OSC) and carriage returns. */
function stripTerminalControl(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '');
}

/** psu prints its own refusals as whole `psu: …` lines, so the whole line is the reason. */
const PSU_FAILURE_LINE =
  /^psu(?:-pty-host)?: .*(?:refus|requires|could not|cannot|can only|failed|no session|not found|unavailable|DROPPED|still in progress)/i;
/**
 * The CLI's own failures arrive inside TUI output drawn with cursor-movement
 * escapes, not newlines, so they sit mid-way through one long rendered "line"
 * (which can open with the consult brief itself). Only the matched fragment is
 * the reason — keeping the line would clip to its start and report the brief.
 */
const MIDLINE_FAILURES: RegExp[] = [
  /You(?:'ve| have) hit your (?:session|weekly|usage) limit(?:\s*·\s*resets[^()\n·]{0,40}(?:\([^()\n]{0,40}\))?)?/gi,
  /Tool reference \S+ not found/g,
];
const LAUNCH_EXIT_LINE = /^\[papercusp\] initial terminal command exited with status \d+/;

/**
 * The failure a launch log ends on: the LAST launcher failure (psu's own
 * refusal, an account wall, a dropped kickoff), plus the terminal exit status
 * when present. Pure, for tests; the default reader feeds it the log's tail.
 */
export function launchLogFailureReason(logText: string): string | null {
  const lines = stripTerminalControl(logText)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  let failure: string | null = null;
  let exit: string | null = null;
  for (const line of lines) {
    if (PSU_FAILURE_LINE.test(line)) {
      failure = line;
      continue;
    }
    if (LAUNCH_EXIT_LINE.test(line)) {
      exit = line.replace(/; headless launch exiting\.?$/, '');
      continue;
    }
    for (const re of MIDLINE_FAILURES) {
      const hits = [...line.matchAll(re)];
      if (hits.length) failure = hits[hits.length - 1]![0].trim();
    }
  }
  if (!failure && !exit) return null;
  return clip([failure, exit].filter(Boolean).join(' · '), 300);
}

/** Default reader: the last 64 KiB of the launch log. Never throws. */
async function defaultReadLaunchLogReason(logPath: string | null | undefined): Promise<string | null> {
  if (!logPath) return null;
  try {
    const { open } = await import('node:fs/promises');
    const fh = await open(logPath, 'r');
    try {
      const { size } = await fh.stat();
      const length = Math.min(size, 64 * 1024);
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, size - length);
      return launchLogFailureReason(buf.toString('utf8'));
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

/**
 * Default `stopFailedLaunch`: kill the spawned session's ledger task, i.e. its
 * whole scope subtree, by the task id `spawnHeadless` returned.
 *
 * WHY THIS EXISTS. A rank that fails after its spawn succeeded (the kickoff never
 * persisted, or verification lost to a child death) used to be recorded as
 * `failed` while its process was left running. The walk then launched the next
 * rank, and the orphan idled on its pty forever: it was never announced as the
 * consult's responder, so nothing would ever route to it or settle it. Measured
 * 2026-09-24: 77 of the 94 consult processes found running, and 178 of the 203
 * the task reaper had stranded earlier, were such unannounced orphans.
 *
 * Keyed on the task id, never on the owner id: a conversion shares the expert's
 * own identity, so an owner-keyed stop could hit the expert's live session.
 */
async function defaultStopFailedLaunch(taskId: string | null | undefined): Promise<string> {
  if (!taskId) return 'no task id to stop (unledgered spawn)';
  try {
    const { killTask } = await import('../task-manager/control');
    const outcome = await killTask(taskId);
    return outcome.ok ? `stopped task ${taskId}` : `stop of task ${taskId} refused: ${outcome.error ?? 'unknown'}`;
  } catch (e) {
    return `stop of task ${taskId} threw: ${(e as Error)?.message ?? String(e)}`;
  }
}

/** The account-pool provider that funds a backend. OMP is not a pooled
 *  subscription, so it has no wall to probe — reported available rather than
 *  guessed at. */
function providerForBackend(agent: ExpertBackend): 'claude' | 'codex' | null {
  if (agent === 'claude') return 'claude';
  if (agent === 'codex') return 'codex';
  return null;
}

/**
 * Default wall probe: read the account-pool projection for the backend's
 * provider and ask whether ANY account still has headroom.
 *
 * Deliberately the cheap PROJECTION read, not `accounts:probe-capacity` — the
 * upstream probe costs one request per account and this runs on the requester's
 * critical path for every rank. A stale projection can only cost one wasted
 * launch attempt, which the walk already treats as a step rather than a stop.
 * An unreadable pool reports AVAILABLE: a failed measurement is not evidence of
 * a wall, and failing closed here would turn a settings/DB hiccup into
 * "no expert is reachable".
 */
async function defaultProbeBackendAvailable(
  agent: ExpertBackend,
  workspaceId: string,
): Promise<BackendAvailability> {
  const provider = providerForBackend(agent);
  if (!provider) return { available: true, detail: `${agent} is not a pooled subscription — no wall to probe` };
  try {
    const [{ loadAccountPool }, { anyAccountAvailable, poolForProvider }] = await Promise.all([
      import('../deployment/account-pool-store'),
      import('../deployment/account-pool'),
    ]);
    const pool = poolForProvider(await loadAccountPool(workspaceId), provider);
    const available = anyAccountAvailable(pool, Date.now());
    return {
      available,
      detail: available
        ? `${provider} pool has headroom (${pool.accounts.length} account(s))`
        : `every ${provider} account reads full/paused (${pool.accounts.length} account(s))`,
    };
  } catch (e) {
    return {
      available: true,
      detail: `${provider} capacity unreadable (${(e as Error)?.message ?? String(e)}) — not treated as a wall`,
    };
  }
}

/**
 * Confirm the source has something a fork/convert can actually read. Delegated
 * to the shared preflight so the launch paths cannot diverge on what counts as
 * a resumable transcript.
 */
async function defaultCheckResumeTranscript(target: ResumeTarget) {
  const { checkConsultResumeTranscript } = await import('./resume-transcript-preflight');
  return checkConsultResumeTranscript(target);
}

/** Nonzero/signal child termination is concrete evidence that a spawned
 *  answering session did not survive to become a responder. */
function childExitFailure(exit: SpawnChildExit): string | null {
  if (exit.error) return `answering-session spawn errored after return: ${exit.error.message}`;
  if (exit.signal) return `answering-session process exited on signal ${exit.signal}`;
  if (exit.code != null && exit.code !== 0) {
    return `answering-session process exited with status ${exit.code}`;
  }
  return null;
}

/** The operation a rank implies against this source, or the reason there is none. */
export function planDispatchOperation(
  source: { agent: string | null; live: boolean },
  rank: Pick<AllowedExpertModel, 'agent'>,
): { operation: DispatchOperation } | { operation: null; reason: DispatchSkipReason; detail: string } {
  const sourceAgent = (source.agent ?? '').toLowerCase();
  if (sourceAgent === rank.agent) {
    // D-009 §1: OMP has no native branch command (`resumeArgsFor` throws
    // forkUnsupportedMessage), so a same-backend OMP rank is unreachable even
    // though the backends match.
    if (rank.agent === 'omp') {
      return {
        operation: null,
        reason: 'fork-unsupported',
        detail: 'OMP has no native branch command, so an OMP source cannot be forked',
      };
    }
    // A consult fork PRE-PINS its answering identity (--owner-id), and the
    // launcher carries a pre-pinned identity only on the TRACKED fork, which is
    // claude-only (psu-launcher `launchTrackedFork`). It refuses the untracked
    // fallback for a pinned id, so a codex fork dies at boot every time — and
    // launching it anyway costs a session and strands the consult on a
    // responder that never existed (conv-muhi8wkf, 2026-09-25).
    if (rank.agent !== 'claude') {
      return {
        operation: null,
        reason: 'fork-unsupported',
        detail:
          `a consult fork needs a tracked fork to carry its pre-pinned identity, and tracked forks ` +
          `are claude-only, so a ${rank.agent} source cannot be forked`,
      };
    }
    return { operation: 'fork' };
  }
  // D-009 §3: the session-port transform is claude-source-only by construction
  // (one adapter, and acquireTrackedClaudeSource throws for any other source).
  if (sourceAgent !== 'claude') {
    return {
      operation: null,
      reason: 'conversion-unavailable',
      detail:
        `no ${sourceAgent || 'unknown'} → ${rank.agent} transform exists (session ports are ` +
        'claude-source-only), so this rank is skipped rather than failed',
    };
  }
  // A session port CONTINUES the source's coordination identity onto the target
  // backend — deliberately, so the ported session keeps its own loop/claims/
  // locks/awaits. That is exactly right for a dead source and a collision for a
  // live one, and D-002 forbids ever colliding with a live agent. The
  // independent answering identity that would lift this is P-004's (the port's
  // authority invariant is enforced server-side, in bootstrap-su, and is bound
  // into the prepared port's idempotency hash — it is not a launcher flag).
  if (source.live) {
    return {
      operation: null,
      reason: 'convert-needs-live-source-identity',
      detail:
        'a session port continues the SOURCE coord identity, which would collide with the live source; ' +
        'skipped in favour of the next rank',
    };
  }
  return { operation: 'convert' };
}

/**
 * Get an allowed model answering `question` from `sourceOwnerId`'s transcript,
 * by forking or converting that session. Resolves ALWAYS (never throws) — the
 * caller falls back to its pre-dispatch outcome on `dispatched:false`.
 */
export async function dispatchConsultResponder(
  opts: {
    /** The expert whose TRANSCRIPT is the knowledge source (the routed pick). */
    sourceOwnerId: string;
    conversationId: string;
    reviewerModel?: ConsultReviewerModel;
    /** Router-matched transcript turns; exact native session wins over the
     * owner's newest session so the routed evidence and carried source agree. */
    evidence?: ConsultDispatchEvidenceRef[];
    /**
     * Delivered as the answering session's first turn. A FUNCTION is resolved
     * per rank with the operation that rank actually implies, because a fork and
     * a conversion inherit history differently and a brief that names the wrong
     * one tells the session something false about its own provenance. A plain
     * string is the operation-independent case.
     */
    brief: string | ((operation: DispatchOperation) => string);
    /**
     * Called with the answering identity the INSTANT that session is running
     * with its brief submitted — before the bounded verification wait, because
     * the session can post during it and the consult's reply gate refuses an
     * author the row does not name yet. The caller persists the identity here;
     * the post-dispatch stamp remains the backstop, so a throw is swallowed.
     */
    onAnsweringOwner?: (answeringOwnerId: string) => void | Promise<void>;
  },
  ctx: ConsultDispatchContext,
  deps: Partial<ConsultDispatchDeps> = {},
): Promise<ConsultDispatchResult> {
  const d: ConsultDispatchDeps = {
    resolveResumeTarget,
    checkResumeTranscript: defaultCheckResumeTranscript,
    buildAgentLaunchCommand,
    injectLaunchedByArg,
    buildConsoleEnvelope,
    spawnHeadless,
    verifyResumeStarted,
    fetchContextPressure,
    probeBackendAvailable: defaultProbeBackendAvailable,
    mintOwnerId: () => `su-${randomUUID()}`,
    stopFailedLaunch: defaultStopFailedLaunch,
    readLaunchLogReason: defaultReadLaunchLogReason,
    recordDispatchAttempts: defaultRecordDispatchAttempts,
    readSourceDispatchRecords: defaultReadSourceDispatchRecords,
    nowMs: () => Date.now(),
    ...deps,
  };
  const result = await walkConsultDispatch(opts, ctx, d);
  // WI-10003197: every walk — dispatched, exhausted, or refused before any rank —
  // lands on its consult, so a failed answering session is visible without
  // searching fleet-logs. Best-effort: losing the record never costs the dispatch.
  try {
    await d.recordDispatchAttempts({
      workspaceId: ctx.workspaceId,
      conversationId: opts.conversationId,
      sourceOwnerId: opts.sourceOwnerId,
      result,
    });
  } catch {
    /* evidence write failed; the dispatch verdict stands */
  }
  return result;
}

async function walkConsultDispatch(
  opts: Parameters<typeof dispatchConsultResponder>[0],
  ctx: ConsultDispatchContext,
  d: ConsultDispatchDeps,
): Promise<ConsultDispatchResult> {
  const attempts: ConsultDispatchAttempt[] = [];
  const give = (detail: string): ConsultDispatchResult => ({
    dispatched: false,
    answeringOwnerId: null,
    operation: null,
    agent: null,
    model: null,
    verified: null,
    detail,
    attempts,
  });

  try {
    // WI-10003198: a source whose launches keep failing is not launched again
    // until its cool-down ends. Checked first: it is the cheapest refusal, and
    // everything after it (resolve, preflight, pressure, walls) is wasted on a
    // source that will be refused anyway.
    let cooldown: SourceCooldown | null = null;
    try {
      const nowMs = d.nowMs();
      const records = await d.readSourceDispatchRecords(
        ctx.workspaceId,
        opts.sourceOwnerId,
        new Date(nowMs - SOURCE_FAILURE_LOOKBACK_MS).toISOString(),
      );
      cooldown = sourceCooldownFrom(records, nowMs);
    } catch {
      /* fail open — see ConsultDispatchDeps.readSourceDispatchRecords */
    }
    if (cooldown) {
      return give(
        `source ${opts.sourceOwnerId} is cooling down until ${cooldown.until}: its last ${cooldown.failures} ` +
          `answering-session launches failed (newest: ${cooldown.lastFailure}), so no session was launched`,
      );
    }

    const evidenceSource = selectConsultEvidenceSource(opts.evidence);
    const target = await d.resolveResumeTarget(
      evidenceSource ? { sessionId: evidenceSource.sessionId } : { agentId: opts.sourceOwnerId },
    );
    if (!target.ok) return give(`source session unresolvable: ${target.detail}`);
    if (evidenceSource && target.sessionId !== evidenceSource.sessionId) {
      return give(`evidence session mismatch: requested ${evidenceSource.sessionId}, resolved ${target.sessionId ?? 'no native session'}`);
    }
    if (evidenceSource && target.ownerId !== opts.sourceOwnerId) {
      return give(`evidence session ownership changed: ${evidenceSource.sessionId} resolves to ${target.ownerId ?? 'no owner'}, expected ${opts.sourceOwnerId}`);
    }

    let transcript: { available: boolean; detail: string };
    try {
      transcript = await d.checkResumeTranscript(target);
    } catch (e) {
      return give(
        `transcript availability preflight failed; dispatch was refused before any launch ` +
          `(${(e as Error)?.message ?? String(e)})`,
      );
    }
    if (!transcript.available) {
      return give(`source transcript unavailable; dispatch was refused before any launch (${transcript.detail})`);
    }

    // EI-22563829644276962, carried forward: a source sitting at the CRITICAL
    // context band cannot take a turn even after a kickoff receipt is accepted.
    // A FORK inherits that whole transcript, so it inherits the wall; a CONVERT
    // re-renders the history into the TARGET's budget and does not. So this is a
    // per-operation skip, not a source-level refusal — the walk can still reach
    // the expert through a conversion.
    let forkBlockedByPressure: string | null = null;
    if (target.ownerId) {
      try {
        const pressure = await d.fetchContextPressure([target.ownerId]);
        if (pressure.get(target.ownerId) === 'critical') {
          forkBlockedByPressure =
            `${target.ownerId} is at CRITICAL context (at or above 90% of its compaction limit), so a fork ` +
            'would inherit a transcript with no room to answer';
        }
      } catch (e) {
        // Unknown pressure is not evidence the source is safe to fork. Fail
        // closed on the FORK legs only; the conversion legs are unaffected.
        forkBlockedByPressure =
          `context-pressure preflight failed for ${target.ownerId} ` +
          `(${(e as Error)?.message ?? String(e)}); forking was refused rather than assumed safe`;
      }
    }

    const allowedRanks = await resolveExpertModelAllowlist(ctx.workspaceId, d);
    const requested = opts.reviewerModel;
    const ranks = requested
      ? allowedRanks.filter((rank) => rank.agent === requested.agent && rank.model === requested.model)
        .map((rank) => ({
          ...rank,
          model: requested.effort ? `${rank.model}:${requested.effort}` : rank.model,
        }))
      : allowedRanks;
    if (ranks.length === 0) {
      return give(requested
        ? `requested reviewer model ${requested.agent}/${requested.model} is absent from the current expert allowlist`
        : 'the expert-model allowlist resolved empty — no model is allowed to answer consults');
    }

    for (const rank of ranks) {
      const plan = planDispatchOperation(target, rank);
      if (plan.operation === null) {
        attempts.push({
          rank: rank.rank,
          agent: rank.agent,
          model: rank.model,
          operation: null,
          outcome: 'skipped',
          reason: plan.reason,
          detail: plan.detail,
        });
        continue;
      }
      const operation = plan.operation;
      if (operation === 'convert' && !evidenceSource) {
        attempts.push({
          rank: rank.rank,
          agent: rank.agent,
          model: rank.model,
          operation,
          outcome: 'skipped',
          reason: 'evidence-span-unavailable',
          detail: 'cross-model conversion requires exact matched transcript turns; no evidence span was supplied',
        });
        continue;
      }
      if (operation === 'fork' && forkBlockedByPressure) {
        attempts.push({
          rank: rank.rank,
          agent: rank.agent,
          model: rank.model,
          operation,
          outcome: 'skipped',
          reason: 'source-context-critical',
          detail: forkBlockedByPressure,
        });
        continue;
      }

      const capacity = await d.probeBackendAvailable(rank.agent, ctx.workspaceId);
      if (!capacity.available) {
        attempts.push({
          rank: rank.rank,
          agent: rank.agent,
          model: rank.model,
          operation,
          outcome: 'skipped',
          reason: 'account-walled',
          detail: capacity.detail,
        });
        continue;
      }

      const attempt = await launchAnsweringSession({
        ...opts,
        ...(evidenceSource ? { evidenceSource } : {}),
      }, ctx, d, target, rank, operation);
      attempts.push(attempt.record);
      if (attempt.record.outcome === 'dispatched') {
        return {
          dispatched: true,
          answeringOwnerId: attempt.answeringOwnerId,
          operation,
          agent: rank.agent,
          model: rank.model,
          verified: attempt.verified,
          detail: attempt.record.detail,
          attempts,
        };
      }
    }

    return give(
      `every allowed expert model was exhausted for ${opts.sourceOwnerId} (${attempts.length} rank(s) tried): ` +
        attempts.map((a) => `#${a.rank} ${a.agent}/${a.model} ${a.reason ?? a.outcome}`).join('; '),
    );
  } catch (e) {
    return give(`dispatch threw: ${(e as Error)?.message ?? String(e)}`);
  }
}

/** One rank's launch. Never throws — a thrown launcher error is this rank's
 *  failure, and the walk owns what happens next. */
async function launchAnsweringSession(
  opts: {
    sourceOwnerId: string;
    conversationId: string;
    evidenceSource?: ConsultEvidenceSource;
    brief: string | ((operation: DispatchOperation) => string);
    onAnsweringOwner?: (answeringOwnerId: string) => void | Promise<void>;
  },
  ctx: ConsultDispatchContext,
  d: ConsultDispatchDeps,
  target: ResumeTarget,
  rank: AllowedExpertModel,
  operation: DispatchOperation,
): Promise<{ record: ConsultDispatchAttempt; answeringOwnerId: string | null; verified: boolean | null }> {
  const base = { rank: rank.rank, agent: rank.agent, model: rank.model, operation } as const;
  const failed = (reason: DispatchSkipReason, detail: string) => ({
    record: { ...base, outcome: 'failed' as const, reason, detail },
    answeringOwnerId: null,
    verified: null,
  });

  // A fork mints a NEW identity, so pre-pin it: the consult row has to name its
  // responder before this session exists. A convert continues the source's own
  // identity (the port's authority invariant), so there is nothing to pin and
  // the answering id is already known.
  const answeringOwnerId = operation === 'fork' ? d.mintOwnerId() : target.ownerId;
  if (!answeringOwnerId) {
    return failed(
      'launch-failed',
      'the source session records no coord identity, so a conversion has no identity to continue',
    );
  }

  let cmd: string;
  try {
    cmd = d.buildAgentLaunchCommand({
      mode: operation === 'fork' ? 'fork' : 'resume',
      sessionId: target.sessionId,
      resumeId: target.resumeId ?? target.sessionId,
      agent: target.agent,
      // P-002/R-12: name the TARGET backend explicitly on a conversion. Omitting
      // it lets psu back-fill the backend from the model name alone, which
      // silently degrades the conversion into a same-backend resume.
      ...(operation === 'convert' ? { targetAgent: rank.agent } : {}),
      model: rank.model,
      modelSource: 'explicit',
      headless: true,
      // The wall probe measures the provider pool. Route pooled Claude/Codex
      // launches through that same pool so another account's headroom is usable.
      account: providerForBackend(rank.agent) ? 'auto' : 'default',
      ...(operation === 'fork' ? { ownerId: answeringOwnerId } : {}),
    });
  } catch (e) {
    // The composer refuses commands psu would reject at boot (an impossible
    // conversion, a model-less codex port). That is this rank's failure, not
    // the consult's.
    return failed('launch-failed', `launch command could not be composed: ${(e as Error)?.message ?? String(e)}`);
  }
  cmd = d.injectLaunchedByArg(cmd, ctx.launchedBy).command;

  let envelope: Awaited<ReturnType<typeof buildConsoleEnvelope>>;
  try {
    envelope = await d.buildConsoleEnvelope({
      workspaceId: ctx.workspaceId,
      slug: ctx.harnessSlug,
      operatorBaseUrl: resolveSpawnHostOperatorBaseUrl(),
      // The answering session is an MCP-connected agent (it must call
      // consult:reply), not a bare command.
      skipMcpJson: false,
    });
  } catch (e) {
    return failed('launch-failed', `console envelope failed: ${(e as Error)?.message ?? String(e)}`);
  }

  // Codex stores its rollout in a per-adv-session home; the transcript preflight
  // read that exact root, so carry it through the detached psu boundary or psu
  // can resume against a different home and report the source rollout missing.
  const codexHome = target.agent === 'codex' ? codexHomeForSessionKey(target.advSessionId) : null;
  const spawn = await d.spawnHeadless({
    envelope: {
      ...envelope,
      env: {
        ...envelope.env,
        ...(codexHome ? { CODEX_HOME: codexHome } : {}),
        // The brief rides the ENV, never a --kickoff= value: free-form text
        // inside the console greeting one-liner breaks the shell.
        PAPERCUSP_KICKOFF_PROMPT:
          `${typeof opts.brief === 'function' ? opts.brief(operation) : opts.brief}` +
          (opts.evidenceSource
            ? `\n\nEXACT TRANSCRIPT EVIDENCE: ${opts.evidenceSource.evidence
                .map((ref) => `${ref.session_id}#${ref.turn_idx}`).join('; ')}. ` +
              `These refs belong to this source session; use them as the grounding span.`
            : ''),
        ...(operation === 'convert' && opts.evidenceSource
          ? {
              PAPERCUSP_CONSULT_EVIDENCE_SPAN: JSON.stringify({
                sessionId: opts.evidenceSource.sessionId,
                turnIndices: opts.evidenceSource.evidence.map((ref) => ref.turn_idx),
                contextTurns: 2,
              }),
            }
          : {}),
      },
      greetingCmd: cmd,
      cwd: target.cwd ?? envelope.cwd,
    },
    label: `consult-${operation} · ${answeringOwnerId.slice(0, 16)}`,
    logDir: join(papercuspPathForWorkspace(ctx.workspaceId), 'fleet-logs'),
    launchedBy: ctx.launchedBy ?? undefined,
    fleetSlug: null,
    coordOwnerId: answeringOwnerId,
    // EI-24106882795589775: an answering session is single-purpose, but a headless
    // interactive CLI does not exit when it ends its turn — "reply, then END YOUR
    // TURN" leaves an idle TUI alive, and its presence keepalive keeps vouching for
    // it. Recording WHAT this session answers lets the task reaper end it the
    // moment that consult is settled for it (`consult-settled`), keyed on this
    // exact ledger row — never on the owner id, which a conversion shares with
    // the expert's own, possibly live, session. `sourceOwnerId` is the expert this
    // session answers for — the reaper locates its cascade slot by it, because the
    // `answeringOwnerId` stamp on the selection is absent on most consults.
    ledgerDetail: {
      consultAnswer: {
        conversationId: opts.conversationId,
        operation,
        answeringOwnerId,
        sourceOwnerId: opts.sourceOwnerId,
      },
    },
    kickoffProof: true,
  });
  if (spawn.status !== 'ok') {
    return failed('launch-failed', `spawn failed (code ${spawn.code}): ${spawn.error}`);
  }
  // A detached spawn can report `ok` after the shell starts even when the
  // command never submitted the brief. Require the host's parent-visible native
  // transcript receipt before treating this rank as dispatched — an unsubmitted
  // brief would otherwise create a phantom responder the consult waits on.
  if (spawn.kickoffProof?.persisted !== true) {
    // The walk is about to launch another rank; this one must not outlive the
    // verdict (see defaultStopFailedLaunch).
    const stopped = await d.stopFailedLaunch(spawn.taskId);
    const launchError = await d.readLaunchLogReason(spawn.logPath);
    const result = failed(
      'kickoff-not-persisted',
      `spawn did not persist its kickoff in the native transcript ` +
        `(${spawn.kickoffProof?.reason ?? 'kickoff-proof-missing'}; log ${spawn.logPath ?? '?'}); ${stopped}` +
        (launchError ? `; launcher said: ${launchError}` : ''),
    );
    return launchError ? { ...result, record: { ...result.record, launchError } } : result;
  }

  // The brief is submitted and the session is running, so from HERE it can post
  // — and the reply gate refuses an author the consult row does not name yet.
  // Announce the answering identity BEFORE the verification wait (up to
  // DISPATCH_VERIFY_TIMEOUT_MS), not after it, or a fast first turn races the
  // stamp and is refused `not_a_participant` by its own launcher. Best-effort
  // by contract: a persistence failure here must not fail a live dispatch.
  try {
    await opts.onAnsweringOwner?.(answeringOwnerId);
  } catch {
    /* the post-verify stamp is the backstop */
  }

  // Race host registration against a durable child-death observation, so the
  // result cannot report a booting session for a process that already died.
  const verifyPromise = d.verifyResumeStarted(answeringOwnerId, { timeoutMs: DISPATCH_VERIFY_TIMEOUT_MS });
  let verify: Awaited<ReturnType<typeof d.verifyResumeStarted>>;
  if (spawn.childExit) {
    const winner = await Promise.race([
      verifyPromise.then((result) => ({ kind: 'verify' as const, result })),
      spawn.childExit.then((exit) => ({ kind: 'exit' as const, exit })),
    ]);
    if (winner.kind === 'exit') {
      const failure = childExitFailure(winner.exit);
      if (failure) {
        // The root died, but its scope can still hold descendants (MCP servers,
        // wrapper chains) — clear it before reporting the rank failed.
        await d.stopFailedLaunch(spawn.taskId);
        const launchError = await d.readLaunchLogReason(spawn.logPath);
        return {
          record: {
            ...base,
            outcome: 'failed',
            reason: 'launch-exited',
            detail:
              `${failure} before ${answeringOwnerId} registered a live host (log ${spawn.logPath ?? '?'})` +
              (launchError ? `; launcher said: ${launchError}` : ''),
            ...(launchError ? { launchError } : {}),
          },
          answeringOwnerId: null,
          verified: false,
        };
      }
      // A clean exit is not the targeted failure, but it cannot establish
      // liveness either — keep the three-state host verdict.
      verify = await verifyPromise;
    } else {
      verify = winner.result;
    }
  } else {
    verify = await verifyPromise;
  }

  return {
    record: {
      ...base,
      outcome: 'dispatched',
      detail: verify.started
        ? `${operation} of ${opts.sourceOwnerId} → ${rank.agent}/${rank.model} as ${answeringOwnerId}: ` +
          `live host registered after ${verify.waitedMs}ms (log ${spawn.logPath ?? '?'}).`
        : `${operation} of ${opts.sourceOwnerId} → ${rank.agent}/${rank.model} as ${answeringOwnerId}: ` +
          `spawned, no live host after ${verify.waitedMs}ms — still booting (NOT a failure; the cascade ` +
          `expiry guards the reply). Log ${spawn.logPath ?? '?'}.`,
    },
    answeringOwnerId,
    verified: verify.started ? true : null,
  };
}

/** Bind the consult dispatch seam for a given requester context. */
export function makeConsultDispatcher(
  ctx: ConsultDispatchContext,
  deps: Partial<ConsultDispatchDeps> = {},
): (opts: { sourceOwnerId: string; conversationId: string; brief: string; evidence?: ConsultDispatchEvidenceRef[] }) => Promise<ConsultDispatchResult> {
  return (opts) => dispatchConsultResponder(opts, ctx, deps);
}

/**
 * The first turn the answering session receives. The `summary`/`body` handed to
 * the old wake seam already say why this expert was routed and which verbs
 * settle the consult, so they carry over verbatim — a brief and a wake body want
 * the same content. What changes is the FRAME: this session was launched FOR the
 * consult and has no inbox notification to discover it in, so the brief must
 * state the conversation id and that answering is the whole job.
 *
 * P-004 owns the full answer-only posture (reply-then-end, nothing inherited);
 * this is the delivery frame P-003 needs to make the launch answerable at all.
 */
export function consultDispatchBrief(input: {
  conversationId: string;
  sourceOwnerId: string;
  operation: DispatchOperation;
  summary: string;
  body: string;
}): string {
  const provenance =
    input.operation === 'fork'
      ? `You are a FORK of ${input.sourceOwnerId}'s session: their history is above, and you are a NEW ` +
        `identity running alongside them. They were NOT notified and must not be — you answer from the ` +
        `transcript you inherited.`
      : `You are ${input.sourceOwnerId}'s session CONVERTED onto another backend: their history was carried ` +
        `across for you. Answer from it.`;
  return (
    `🧭 CONSULT — you were launched to answer ONE question, on consult conversation ${input.conversationId}.\n` +
    `${provenance}\n\n` +
    // P-004 answer-only posture. The brief is the ONLY thing that shapes this
    // session's behaviour — it boots with a fresh identity, no fleet, no loop
    // and no claims — so the posture has to be stated here or the inherited
    // transcript's agenda becomes this session's agenda. A fork reads its own
    // history as "what I was doing", which is precisely the failure: it would
    // resume the source's work under a new id, double-claiming their lane.
    `⛔ ANSWER-ONLY — this session exists for this ONE question and ends with it.\n` +
    `Reply (or decline) on the conversation above, then END YOUR TURN. Do NOT resume ` +
    `whatever the inherited transcript was doing: that work belongs to the session it ` +
    `came from, which is still its owner and was NOT notified. Do not claim work-items, ` +
    `do not arm a loop, do not start a plan, do not edit files. Your transcript is ` +
    `EVIDENCE to answer from, not an agenda to continue.\n\n` +
    `${input.summary}\n\n${input.body}`
  );
}

/**
 * The consult DELIVERY seam, in the shape every consult call site already binds
 * (`{ responder, conversationId, summary, body }` → a delivery count).
 *
 * D-010: the seam's SHAPE is preserved and its MEANING replaced. `responder` is
 * now the expert whose TRANSCRIPT answers, not an agent to ping; a non-zero
 * count means an answering session was launched from that transcript, and zero
 * means the whole allowlist was exhausted for them — which every caller already
 * treats as "advance to the next expert".
 *
 * `pickupConfirmed` is honest in a way the wake seam could not be: a launch with
 * a persisted native kickoff receipt AND a registered live host is a STARTED
 * turn, not a queued delivery. A still-booting launch reports the delivery
 * without claiming pickup.
 */
export function makeConsultReachDispatcher(
  ctx: ConsultDispatchContext,
  deps: Partial<ConsultDispatchDeps> = {},
): (opts: {
  responder: string;
  conversationId: string;
  summary: string;
  body: string;
  evidence?: ConsultDispatchEvidenceRef[];
  /** Persist the answering identity the moment the session starts — passed
   *  straight through to `dispatchConsultResponder`, which calls it before the
   *  verification wait so a fast first reply is not refused. */
  onAnsweringOwner?: (answeringOwnerId: string) => void | Promise<void>;
}) => Promise<{
  queued: number;
  woke: number;
  pickupConfirmed: boolean;
  answeringOwnerId: string | null;
  dispatch: ConsultDispatchResult;
}> {
  return async (opts) => {
    // The routed consult's saved snapshot is the authority on later reply,
    // decline and expiry cascades. A closure from the initial call is gone by
    // then, so never rely on it to keep the model constraint.
    const reviewerModel = await (deps.readReviewerModel ?? readPersistedReviewerModel)(
      ctx.workspaceId, opts.conversationId,
    );
    // Initial getFeedbackProd binds workspace ranks itself. Later decline and
    // expiry writers construct a new dispatcher, so load that same workspace
    // setting here instead of comparing the saved choice against the seed.
    const dispatchDeps = reviewerModel && !deps.loadRanks
      ? {
          ...deps,
          loadRanks: (workspaceId: string) =>
            import('./expert-routing-settings')
              .then(async ({ readConsultExpertRoutingSettings, bindConsultExpertRoutingSettings }) =>
                bindConsultExpertRoutingSettings(await readConsultExpertRoutingSettings(workspaceId)).loadRanks(workspaceId)),
        }
      : deps;
    const dispatch = await dispatchConsultResponder(
      {
        sourceOwnerId: opts.responder,
        conversationId: opts.conversationId,
        ...(reviewerModel ? { reviewerModel } : {}),
        ...(opts.evidence ? { evidence: opts.evidence } : {}),
        ...(opts.onAnsweringOwner ? { onAnsweringOwner: opts.onAnsweringOwner } : {}),
        // Per-rank, because a walled rank-1 can turn a fork into a conversion and
        // the two inherit history differently.
        brief: (operation) =>
          consultDispatchBrief({
            conversationId: opts.conversationId,
            sourceOwnerId: opts.responder,
            operation,
            summary: opts.summary,
            body: opts.body,
          }),
      },
      ctx,
      dispatchDeps,
    );
    const pickupConfirmed = dispatch.dispatched && dispatch.verified === true;
    return {
      queued: dispatch.dispatched ? 1 : 0,
      woke: pickupConfirmed ? 1 : 0,
      pickupConfirmed,
      answeringOwnerId: dispatch.answeringOwnerId,
      dispatch,
    };
  };
}

async function readPersistedReviewerModel(workspaceId: string, conversationId: string): Promise<ConsultReviewerModel | null> {
  const { getOrgPg } = await import('@papercusp/db-org');
  const [row] = await getOrgPg().sql<Array<{ policy: string | null; reviewer_model: unknown }>>`
    SELECT routing->>'policy' AS policy, routing->'reviewerModel' AS reviewer_model
      FROM harness_shared.consult_state
     WHERE workspace_id = ${workspaceId} AND conversation_id = ${conversationId}
  `;
  if (row?.reviewer_model == null) return null;
  if (row.policy !== ACCEPTANCE_BAR_AMENDMENT_REVIEW_POLICY) {
    throw new Error('reviewer model exists outside its acceptance amendment policy');
  }
  const raw = typeof row.reviewer_model === 'string' ? JSON.parse(row.reviewer_model) as unknown : row.reviewer_model;
  if (!raw || typeof raw !== 'object') throw new Error('invalid persisted reviewer model');
  const model = raw as Record<string, unknown>;
  if (!['claude', 'codex', 'omp'].includes(String(model.agent)) ||
    typeof model.model !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(model.model) ||
    (model.effort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(String(model.effort)))) {
    throw new Error('invalid persisted reviewer model');
  }
  return model as unknown as ConsultReviewerModel;
}
