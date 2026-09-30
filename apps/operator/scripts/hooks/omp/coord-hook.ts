/**
 * Papercusp coordination hook for OMP — one module, eight handlers
 * (per agent-coordination-architecture-v2 §7.3 + §12.1 +
 * file-locking-improvements #2):
 *
 *   session_start    → mint the per-process coordination owner id;
 *                      probe the operator (attached/detached) +
 *                      declare presence (coord:declare-intent over
 *                      MCP, attached only — presence is PG-backed).
 *   turn_start       → assemble + inject the system-reminder payload
 *                      (held locks, unread inbox, changed plans).
 *   turn_end         → persist the watermark pointers consumed.
 *   before_provider_request
 *                    → proactively space exact Vertex Gemini 3.1 Pro request
 *                      starts across local OMP processes.
 *   auto_retry_start → smooth bare Vertex shared-capacity 429 retries across
 *                      simultaneous sessions before OMP starts its own wait.
 *   tool_call        → L2 file-lock enforcement — extract paths,
 *                      locks:acquire, block on busy.
 *   tool_result      → release the lock for that toolCallId, AND append any
 *                      pending advisory context to the completed result — the
 *                      non-preempting Claude/Codex PostToolUse analogue.
 *   session_shutdown → defensive release of any locks still held.
 *
 * Runtime: the hook is loaded BY OMP, inside the OMP child process,
 * NOT in the operator. It MUST be self-contained (no operator imports)
 * and talks back to the operator over HTTP.
 *
 * Env (set by buildConsoleEnvelope when mode='omp' per the OMP-bundle
 * plan §4.4, omp-power-user-bundle-brief §3):
 *   PAPERCUSP_AUTH_SESSION_ID     — agent canonical id (pus-<uuid>)
 *   PAPERCUSP_BUNDLE_URL          — bundle URL (operator origin = prefix)
 *   PAPERCUSP_BUNDLE_ACCESS_TOKEN — bearer for MCP calls
 *
 * Best-effort: every handler swallows its errors — a hook failure must
 * never crash the OMP session. See the omp-bundle plan §4.3.1.
 *
 * OMP HookAPI shape — VERIFY AT DEPLOY: this file assumes a standard
 * `default (pi: HookAPI) => void` registration where `pi.on(event,
 * handler)` wires a handler whose return value can carry an injection
 * (turn_start) or a block decision (tool_call). The exact OMP types
 * are in node_modules/@oh-my-pi/pi-coding-agent/src/extensibility/.
 * The adapter at the bottom is documented and trivial to reshape.
 *
 * Attached vs detached: the extension probes the operator at session
 * start. Attached → the MCP path below. Detached (operator unreachable)
 * → coord state is ALL PG-backed now — channels, watermarks, presence,
 * and locks (coord-channels-pg-port D-001, P-010) — so there is no
 * filesystem fallback: the turn-start coord injection is skipped for the
 * turn (lock enforcement separately fails open with its own notice). The
 * operator + PG are required for any coord surface.
 */

import { promises as fsp, existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import {
  appendAdvisories,
  stashAdvisory,
  takeAdvisories,
} from './non-preempting-delivery';

// ── Pure helpers (unit-tested) ───────────────────────────────────────

export interface InboxEntry {
  ts: string;
  msg_id: string;
  from: string;
  kind: string;
  summary?: string;
  plan_slug?: string;
  related_msg_id?: string;
  severity?: string;
  /** Present on plan_event entries — created / promoted / etc. */
  event?: string;
  /** Subscribe→inject fan-out fields (coordination-substrate Phase 2). `subject`
   *  groups digest coalescing (e.g. 'feature:F-1'); `digest` flags a digest-mode
   *  notice the inbox coalesces; `notify_kind` is the change sub-type. */
  subject?: string;
  notify_kind?: string;
  digest?: boolean;
}

export interface HeldLock {
  path: string;
  acquired_ts?: string;
  expires_ts?: string;
}

export interface PlanEventSummary {
  plan_slug: string;
  events: string[];
}

export interface ReminderInput {
  ownerId: string;
  inbox: InboxEntry[];
  heldLocks: HeldLock[];
  changedPlans: PlanEventSummary[];
}

export interface AutoRetryStartEvent {
  type: 'auto_retry_start';
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  errorMessage: string;
  errorId?: number;
}

export interface ProviderModelRef {
  provider?: unknown;
  id?: unknown;
}

export interface VertexGeminiRequestStartReservation {
  scheduledAtMs: number;
  waitMs: number;
  nextStartAtMs: number;
  saturated: boolean;
}

/**
 * OMP 17.2.13 classifies a bare Vertex 429 as transient model capacity, but its
 * turn-recovery path only applies the reason-specific floor to explicit rate and
 * concurrency limits. The resulting 0.5/1/2s waits let simultaneously-launched
 * sessions repeatedly re-form the same burst against Vertex shared capacity.
 *
 * Keep this shim deliberately narrow: the observed Vertex wording plus its
 * canonical error-code URL, with no explicit quota/rate/concurrency detail. OMP
 * remains authoritative for every richer response and for provider retry-after.
 */
const BARE_VERTEX_SHARED_CAPACITY_429_RE =
  /\bGoogle API error \(429\):\s*Resource exhausted\.\s*Please try again later\./i;
const VERTEX_429_DOC_RE =
  /cloud\.google\.com\/vertex-ai\/generative-ai\/docs\/error-code-429/i;
const EXPLICIT_VERTEX_CAP_DETAIL_RE =
  /\b(?:quota|rate[-_ ]?limit|per\s+(?:second|minute)|concurren\w*|limit\s+will\s+reset)\b/i;

export const VERTEX_SHARED_CAPACITY_RETRY_BASE_MS = 5_000;
export const VERTEX_SHARED_CAPACITY_RETRY_EXPONENTIAL_CAP_MS = 20_000;
export const VERTEX_SHARED_CAPACITY_RETRY_SLOT_COUNT = 16;
export const VERTEX_SHARED_CAPACITY_RETRY_SLOT_WIDTH_MS = 2_000;
/** The hook runs before OMP creates its retry AbortController, so cap our unabortable addition. */
export const VERTEX_SHARED_CAPACITY_RETRY_MAX_ADDED_MS = 45_000;

/**
 * Google recommends smoothing traffic presented to Dynamic Shared Quota. Keep
 * this proactive gate narrower than the error-driven retry shim: it applies
 * only to the exact Vertex Gemini 3.1 Pro preview model that reproduced the
 * shared-capacity bursts. The 25s ceiling leaves 5s of headroom under OMP's
 * hard 30s extension-handler timeout.
 */
export const VERTEX_GEMINI_REQUEST_START_INTERVAL_MS = 5_000;
export const VERTEX_GEMINI_REQUEST_START_MAX_WAIT_MS = 25_000;
const VERTEX_GEMINI_REQUEST_START_LOCK_WAIT_MS = 500;
const VERTEX_GEMINI_REQUEST_START_LOCK_POLL_MS = 20;
const VERTEX_GEMINI_REQUEST_START_LOCK_STALE_MS = 30_000;
const VERTEX_GEMINI_REQUEST_START_STATE_FILE = 'google-vertex-gemini-3.1-pro-preview.json';

export function isVertexGemini31ProRequest(model: ProviderModelRef | null | undefined): boolean {
  return model?.provider === 'google-vertex' && model.id === 'gemini-3.1-pro-preview';
}

/**
 * Pure leaky-bucket reservation. Persisted state is accepted only inside the
 * horizon this gate itself can produce, so clock jumps or corrupt future data
 * cannot impose an unbounded wait. At saturation, callers share the bounded
 * last slot rather than crossing OMP's 30s handler ceiling.
 */
export function vertexGeminiRequestStartReservation(
  nowMs: number,
  storedNextStartAtMs: number | null | undefined,
): VertexGeminiRequestStartReservation {
  const now = Number.isFinite(nowMs) ? Math.max(0, Math.trunc(nowMs)) : 0;
  const maxPersistedHorizonMs =
    now + VERTEX_GEMINI_REQUEST_START_MAX_WAIT_MS + VERTEX_GEMINI_REQUEST_START_INTERVAL_MS;
  const stored = Number.isFinite(storedNextStartAtMs)
    ? Math.max(0, Math.trunc(storedNextStartAtMs as number))
    : now;
  const queuedStartAtMs = stored >= now && stored <= maxPersistedHorizonMs ? stored : now;
  const latestStartAtMs = now + VERTEX_GEMINI_REQUEST_START_MAX_WAIT_MS;
  const scheduledAtMs = Math.min(queuedStartAtMs, latestStartAtMs);
  return {
    scheduledAtMs,
    waitMs: scheduledAtMs - now,
    nextStartAtMs: scheduledAtMs + VERTEX_GEMINI_REQUEST_START_INTERVAL_MS,
    saturated: queuedStartAtMs > latestStartAtMs,
  };
}

function vertexGeminiRequestStartStateDir(): string {
  return join(homedir(), '.papercusp', 'provider-pacing');
}

async function pause(ms: number): Promise<void> {
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, ms));
}

async function acquireVertexGeminiRequestStartLock(lockPath: string): Promise<{
  close: () => Promise<void>;
} | null> {
  const deadlineMs = Date.now() + VERTEX_GEMINI_REQUEST_START_LOCK_WAIT_MS;
  for (;;) {
    try {
      const handle = await fsp.open(lockPath, 'wx', 0o600);
      return handle;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') return null;
      try {
        const stat = await fsp.stat(lockPath);
        if (Date.now() - stat.mtimeMs > VERTEX_GEMINI_REQUEST_START_LOCK_STALE_MS) {
          await fsp.unlink(lockPath);
          continue;
        }
      } catch {
        continue;
      }
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) return null;
      await pause(Math.min(VERTEX_GEMINI_REQUEST_START_LOCK_POLL_MS, remainingMs));
    }
  }
}

/**
 * Reserve one process-shared start time under an atomic local lock. The gate is
 * deliberately fail-open: an unwritable home or a contended/stale lock must
 * not strand a model request. Tests pass an isolated directory explicitly;
 * production uses ~/.papercusp/provider-pacing.
 */
export async function reserveVertexGeminiRequestStart(
  stateDir: string = vertexGeminiRequestStartStateDir(),
  nowMs: number = Date.now(),
): Promise<VertexGeminiRequestStartReservation | null> {
  try {
    await fsp.mkdir(stateDir, { recursive: true, mode: 0o700 });
    const statePath = join(stateDir, VERTEX_GEMINI_REQUEST_START_STATE_FILE);
    const lockPath = `${statePath}.lock`;
    const lock = await acquireVertexGeminiRequestStartLock(lockPath);
    if (!lock) return null;
    try {
      let storedNextStartAtMs: number | null = null;
      try {
        const parsed = JSON.parse(await fsp.readFile(statePath, 'utf8')) as {
          nextStartAtMs?: unknown;
        };
        if (typeof parsed.nextStartAtMs === 'number') storedNextStartAtMs = parsed.nextStartAtMs;
      } catch {
        // Missing/corrupt state is an empty bucket, never a provider blocker.
      }
      const reservation = vertexGeminiRequestStartReservation(nowMs, storedNextStartAtMs);
      const tmpPath = `${statePath}.tmp-${process.pid}-${randomUUID()}`;
      await fsp.writeFile(
        tmpPath,
        JSON.stringify({ version: 1, nextStartAtMs: reservation.nextStartAtMs }),
        { encoding: 'utf8', mode: 0o600 },
      );
      await fsp.rename(tmpPath, statePath);
      return reservation;
    } finally {
      await lock.close().catch(() => undefined);
      await fsp.unlink(lockPath).catch(() => undefined);
    }
  } catch {
    return null;
  }
}

export function isBareVertexSharedCapacity429(errorMessage: string): boolean {
  if (!BARE_VERTEX_SHARED_CAPACITY_429_RE.test(errorMessage) || !VERTEX_429_DOC_RE.test(errorMessage)) {
    return false;
  }
  const providerDetail = errorMessage
    .replace(BARE_VERTEX_SHARED_CAPACITY_429_RE, '')
    .replace(VERTEX_429_DOC_RE, '');
  return !EXPLICIT_VERTEX_CAP_DETAIL_RE.test(providerDetail);
}

/**
 * Assign a process-lifetime-stable phase slot from the psu session identity.
 * Cryptographic hashing is used for distribution, not secrecy. Discrete 2s
 * slots avoid two independent PRNG draws landing only milliseconds apart.
 */
export function vertexSharedCapacityRetrySlot(sessionKey: string): number {
  const key = sessionKey.trim() || 'omp-session-without-id';
  return createHash('sha256').update(key).digest().readUInt32BE(0) % VERTEX_SHARED_CAPACITY_RETRY_SLOT_COUNT;
}

/** Total delay OMP plus this hook should observe for a bare shared-capacity retry. */
export function vertexSharedCapacityRetryTargetMs(attempt: number, sessionKey: string): number {
  const safeAttempt = Number.isFinite(attempt) ? Math.max(1, Math.trunc(attempt)) : 1;
  const exponentialFloorMs = Math.min(
    VERTEX_SHARED_CAPACITY_RETRY_EXPONENTIAL_CAP_MS,
    VERTEX_SHARED_CAPACITY_RETRY_BASE_MS * 2 ** Math.min(safeAttempt - 1, 2),
  );
  return exponentialFloorMs + vertexSharedCapacityRetrySlot(sessionKey) * VERTEX_SHARED_CAPACITY_RETRY_SLOT_WIDTH_MS;
}

/**
 * Return only the wait this hook must add. OMP's announced delay is subtracted
 * so a future upstream fix or an explicit retry-after cannot double-stack.
 */
export function vertexSharedCapacityRetrySmoothingMs(
  event: AutoRetryStartEvent,
  sessionKey: string,
): number {
  if (!isBareVertexSharedCapacity429(event.errorMessage)) return 0;
  const nativeDelayMs = Number.isFinite(event.delayMs) ? Math.max(0, Math.trunc(event.delayMs)) : 0;
  return Math.min(
    VERTEX_SHARED_CAPACITY_RETRY_MAX_ADDED_MS,
    Math.max(0, vertexSharedCapacityRetryTargetMs(event.attempt, sessionKey) - nativeDelayMs),
  );
}

/**
 * Format the turn-start reminder shown to the model. Compact,
 * skimmable — does NOT dump full bodies; those are one tool call away.
 * Returns "" when there is nothing to surface (no reminder injected) —
 * which is also what a detached (operator-unreachable) turn produces,
 * since coord state is all PG-backed now with no filesystem fallback.
 */
/**
 * Coalesce digest-mode subscribe→inject notifies by `subject` (D-006 — the noise
 * control). Full-mode notifies pass through untouched; same-subject digest
 * notifies collapse into ONE line carrying the count + the latest summary. Other
 * kinds pass through unchanged, preserving input order. Pure + unit-tested.
 */
export function collapseDigestNotifies(entries: InboxEntry[]): InboxEntry[] {
  const out: InboxEntry[] = [];
  const groups = new Map<string, InboxEntry & { _count: number }>();
  for (const e of entries) {
    if (e.kind === 'notify' && e.digest) {
      const key = e.subject ?? e.summary ?? '?';
      const g = groups.get(key);
      if (!g) {
        const ne: InboxEntry & { _count: number } = { ...e, _count: 1 };
        groups.set(key, ne);
        out.push(ne);
      } else {
        g._count += 1;
        if (e.ts > g.ts) {
          g.ts = e.ts;
          g.summary = e.summary;
        }
      }
    } else {
      out.push(e);
    }
  }
  for (const g of groups.values()) {
    if (g._count > 1) {
      const subj = g.subject ?? '';
      g.summary = `${subj ? `${subj} ` : ''}×${g._count} — latest: ${g.summary ?? ''}`;
    }
  }
  return out;
}

export function formatTurnStartReminder(input: ReminderInput): string {
  const out: string[] = [];

  if (input.heldLocks.length > 0) {
    out.push(`You (${input.ownerId}) currently hold ${input.heldLocks.length} lock${input.heldLocks.length === 1 ? '' : 's'}:`);
    for (const l of input.heldLocks.slice(0, 5)) {
      out.push(`  • ${l.path}`);
    }
    if (input.heldLocks.length > 5) {
      out.push(`  • … and ${input.heldLocks.length - 5} more (locks:queue { owner })`);
    }
  }

  // Escalations first within the inbox — they earn the right to interrupt.
  const escalations = input.inbox.filter((e) => e.kind === 'escalation');
  const messages = input.inbox.filter((e) => e.kind === 'message' || e.kind === 'ack');
  const notifies = collapseDigestNotifies(input.inbox.filter((e) => e.kind === 'notify'));
  const handoffs = input.inbox.filter((e) => e.kind === 'handoff' || e.kind === 'handoff_accepted');

  if (input.inbox.length > 0) {
    out.push(`Inbox — ${input.inbox.length} unread:`);
    for (const e of escalations.slice(0, 3)) {
      out.push(`  • [escalation${e.severity ? `:${e.severity}` : ''}] ${e.summary ?? '(no summary)'} (id ${e.msg_id})`);
    }
    for (const e of handoffs.slice(0, 3)) {
      out.push(`  • [${e.kind} from ${e.from}] ${e.summary ?? ''}${e.plan_slug ? ` → ${e.plan_slug}` : ''}`);
    }
    for (const e of messages.slice(0, 5)) {
      out.push(`  • [${e.kind} from ${e.from}] ${e.summary ?? ''}`);
    }
    for (const e of notifies.slice(0, 5)) {
      out.push(`  • [notify] ${e.summary ?? ''}`);
    }
  }

  if (input.changedPlans.length > 0) {
    out.push(`Plans changed since you last read (${input.changedPlans.length}):`);
    for (const p of input.changedPlans.slice(0, 5)) {
      out.push(`  • ${p.plan_slug} — ${p.events.join(', ')}`);
    }
  }

  if (out.length === 0) return '';

  return `<system-reminder type="coord">\n${out.join('\n')}\n</system-reminder>`;
}

/**
 * Format the MID-TURN delta reminder — the coord messages that arrived since
 * the last tool call (parity with the Claude/Codex PostToolUse coord hook).
 * Compact, newest-capped (the most recent matter most; older are summarized as
 * a count), wrapped in the same `<system-reminder type="coord">` envelope as
 * the turn-start reminder. Returns '' for an empty list (nothing injected).
 */
export function formatInboxDelta(injection: string): string {
  // DUMB PIPE (token-efficient-coord-injection D-003/P-009): the positional
  // `[coord+N]` block — capping, digest + latest-per-peer intent collapse, the
  // glyph key, and the relocated footer — all live SERVER-SIDE now, in
  // coord:inbox's `injection` (coord-schema.renderInjection). This hook only
  // wraps it in the OMP coord envelope + (in pollInboxDelta) keeps the cursor.
  // One server-side edit re-tunes every client. Empty injection → no reminder.
  const body = (injection ?? '').trim();
  if (!body) return '';
  return `<system-reminder type="coord">\n${body}\n</system-reminder>`;
}

/** Aggregate raw plan_event lines into one summary per plan_slug. */
export function summarisePlanEvents(events: InboxEntry[]): PlanEventSummary[] {
  const by = new Map<string, string[]>();
  for (const e of events) {
    if (e.kind !== 'plan_event') continue;
    const slug = e.plan_slug ?? '<unknown>';
    const ev = (e as { event?: string }).event ?? 'event';
    if (!by.has(slug)) by.set(slug, []);
    by.get(slug)!.push(ev);
  }
  return [...by.entries()].map(([plan_slug, events]) => ({ plan_slug, events }));
}

// ── HTTP plumbing (operator MCP transport) ───────────────────────────

interface JsonRpcResp {
  result?: { isError?: boolean; content?: Array<{ type: string; text?: string }> };
  error?: { code: number; message: string };
}

/**
 * Call an MCP tool on the operator. Returns the parsed JSON of the
 * tool's text content (the coord:* tools all JSON-stringify into a
 * single text element). Returns null on any failure — best-effort.
 */
/**
 * Per-PROCESS coordination owner id (file-locking #2). Minted once,
 * cached for the process lifetime.
 *
 * This is the structural fix for OMP per-session identity: the hook
 * OWNS its identity rather than inheriting it from whatever the MCP
 * transport's `Mcp-Session-Id` / bundle token happens to carry. Two
 * OMP shells on one machine ALWAYS get distinct owners because
 * `process.pid` differs — the lock store can never collapse them.
 *
 * Format `omp-<session>-<pid>`: the session part is
 * PAPERCUSP_AUTH_SESSION_ID when the bundle env supplies it (already
 * unique per desktop launch), else a random hex (covers the
 * standalone-install path where no bundle session id exists). The
 * `<pid>` makes it unconditional regardless. callMcpTool passes this
 * via `?client=` — the operator's power-user route branch honors it
 * (see _mcp-handler.ts).
 */
let _hookOwnerId: string | null = null;
type AdvSessionLinkState = 'pending' | 'linked' | 'conflict' | 'failed';
let _advSessionLinkState: AdvSessionLinkState = 'pending';
export function hookOwnerId(): string {
  if (_hookOwnerId === null) {
    // Prefer the psu-assigned session id (PAPERCUSP_SID): it has an adv_sessions row the operator
    // resolves the WORKSPACE through, so coord calls succeed even when PAPERCUSP_WORKSPACE is NOT in
    // the env (the scoped-superuser clamp would otherwise reject every call → "coordination call
    // failed this turn", every turn). It is unique per psu launch (lock isolation preserved) and
    // matches the identity the agent's own MCP tool calls use, so the hook's presence/locks no longer
    // split from the session. Fall back to a minted `omp-<session>-<pid>` only for a bare/non-psu omp
    // launch that has no PAPERCUSP_SID.
    const sid = process.env.PAPERCUSP_SID && process.env.PAPERCUSP_SID.length > 0 ? process.env.PAPERCUSP_SID : '';
    if (sid) {
      _hookOwnerId = sid;
    } else {
      const session =
        process.env.PAPERCUSP_AUTH_SESSION_ID && process.env.PAPERCUSP_AUTH_SESSION_ID.length > 0
          ? process.env.PAPERCUSP_AUTH_SESSION_ID
          : Math.random().toString(36).slice(2, 10);
      _hookOwnerId = `omp-${session}-${process.pid}`;
    }
  }
  return _hookOwnerId;
}

/** Test-only: reset memoised state between cases. */
export function _resetHookOwnerIdForTests(): void {
  _hookOwnerId = null;
  _advSessionLinkState = 'pending';
  _mode = 'attached';
  _lastProbeAtMs = 0;
}

/**
 * Resolve the workspace for a coord call. PAPERCUSP_WORKSPACE is the primary source, but psu does
 * NOT always export it into the omp env (and a bare `omp` launch never does), so fall back to the
 * workspace name embedded in the session PATH — `.papercusp-workspaces/<workspace>/.papercusp`, the
 * value PAPERCUSP_HOME / the cwd carries. Without a resolved workspace the scoped-superuser clamp
 * rejects EVERY coord call ("coordination call failed this turn", every turn). Exported for tests.
 */
export function resolveHookWorkspace(): string {
  const fromEnv = (process.env.PAPERCUSP_WORKSPACE ?? '').trim();
  if (fromEnv) return fromEnv;
  let cwd = '';
  try {
    cwd = process.cwd();
  } catch {
    cwd = '';
  }
  for (const p of [process.env.PAPERCUSP_HOME ?? '', cwd]) {
    const m = p.match(/\.papercusp-workspaces\/([^/]+)/);
    if (m && m[1] && m[1] !== '.papercusp') return m[1];
  }
  return '';
}

export async function callMcpTool(
  toolName: string,
  args: Record<string, unknown>,
  env: {
    mcpUrl?: string;
    bearer?: string;
    sessionId?: string;
    workspace?: string;
    timeoutMs?: number;
    /** Preserve a structured error for callers that can distinguish a
     * deterministic schema/argument failure from a transient transport miss. */
    preserveErrors?: boolean;
    /** Optional JSON-RPC `params._meta` (token-efficient-tool-result-formats P-005). Pass
     *  `{ format: 'json' }` to force a tool whose result is TOON-encoded by default (tabular
     *  results like tools:find's hits[]) back to JSON so the JSON.parse(content) path below can
     *  read it. Omitted for every existing caller → default serialization, byte-identical. */
    meta?: Record<string, unknown>;
  } = {},
): Promise<unknown | null> {
  // Append the per-process coordination owner as `?client=` so the
  // operator attributes every coord/locks call to THIS process, not
  // to a shared bundle-token identity (file-locking #2).
  const clientParam = `client=${encodeURIComponent(hookOwnerId())}`;
  const withClient = (base: string): string =>
    base.includes('?') ? `${base}&${clientParam}` : `${base}?${clientParam}`;
  const mcpUrl =
    env.mcpUrl ??
    (process.env.PAPERCUSP_BUNDLE_URL
      ? withClient(
          new URL('/api/mcp?power_user=1&origin=hook', process.env.PAPERCUSP_BUNDLE_URL).toString(),
        )
      : (process.env.PAPERCUSP_OPERATOR_URL || process.env.PAPERCUSP_API_BASE)
      ? withClient(
          new URL(
            '/api/mcp?superuser=1&origin=hook',
            process.env.PAPERCUSP_OPERATOR_URL || process.env.PAPERCUSP_API_BASE!,
          ).toString(),
        )
      : null);
  if (!mcpUrl) return null;
  let bearer =
    env.bearer ??
    process.env.PAPERCUSP_BUNDLE_ACCESS_TOKEN ??
    process.env.PAPERCUSP_SUPERUSER_TOKEN ??
    '';
  if (!bearer && !process.env.PAPERCUSP_BUNDLE_URL) {
    try {
      bearer = (
        await fsp.readFile(join(process.env.HOME ?? homedir(), '.papercusp', 'superuser-token'), 'utf8')
      ).trim();
    } catch {
      bearer = '';
    }
  }
  const sessionId = env.sessionId ?? process.env.PAPERCUSP_AUTH_SESSION_ID ?? '';
  // Workspace scope (scoped-superuser-workspace-clamp-2026-06-18): the clamp REJECTS a superuser
  // coord call whose workspace can't be resolved — every coord call then fails ("Papercusp
  // coordination call failed this turn", every turn). resolveHookWorkspace() resolves it robustly
  // (PAPERCUSP_WORKSPACE if exported, else derived from the .papercusp-workspaces/<ws>/ session path),
  // sent as the `x-papercusp-workspace` header the operator reads FIRST.
  const workspace = env.workspace ?? resolveHookWorkspace();
  // No-timeout hang guard (WI-1081 / operator-latency-coord-timeout-2026-06-29): a slow or
  // wedged operator (e.g. during a bg-host restart-loop) used to block this fetch until OMP's
  // framework handler timeout KILLED the handler — 30s session_start / 2s turn_start — a 30s
  // launch STALL + an "Extension error: handler timed out", with no graceful degrade. Bound every
  // coord fetch with an AbortController so a hung operator returns null FAST (→ the hook's normal
  // degraded path: "coordination call failed, will retry"), never a multi-second handler kill.
  // Default 6s cleanly separates "slow-but-working" (healthy coord calls are ≤1.1s) from "hung"
  // (≥30s); turn_start passes a tighter budget so its handler stays under OMP's 2s framework cap.
  const timeoutMs = env.timeoutMs ?? 6000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
        ...(workspace ? { 'x-papercusp-workspace': workspace } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: toolName, arguments: args, ...(env.meta ? { _meta: env.meta } : {}) },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const text = await res.text();
    // The Streamable HTTP MCP transport may return either application/json
    // or text/event-stream framed. A correctly framed SSE response from
    // the current @modelcontextprotocol/sdk leads with `event: message\n`
    // BEFORE the `data: <json>` line — the older check only handled the
    // case where `data:` was the first byte, which silently broke every
    // coord call (regression: see plans/coord-hook-sse-event-prefix-*).
    // Always scan for a `data:` line first; fall back to raw text.
    const dataLine = text.split('\n').find((l) => l.startsWith('data:'));
    const payload = dataLine !== undefined ? dataLine.slice(5).trim() : text;
    const parsed = JSON.parse(payload) as JsonRpcResp;
    if (parsed.error) {
      return env.preserveErrors
        ? { ok: false, error: 'mcp_rpc_error', code: parsed.error.code, message: parsed.error.message }
        : null;
    }
    const content = parsed.result?.content?.[0]?.text;
    if (typeof content !== 'string') return null;
    try {
      return JSON.parse(content);
    } catch {
      return env.preserveErrors && parsed.result?.isError === true
        ? { ok: false, error: 'mcp_tool_error', message: content }
        : null;
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Mode detection: attached vs detached (§10) ───────────────────────

export type CoordMode = 'attached' | 'detached';

/**
 * Current coordination mode. Defaults to 'attached' (optimistic) — the
 * first turn self-corrects if the operator turns out unreachable, so a
 * missing session_start probe is not fatal.
 */
let _mode: CoordMode = 'attached';

/** Edge-trigger for the degraded notice (WI-1082). True once we've surfaced the
 * "coordination call was slow this turn" notice for the CURRENT degraded streak;
 * reset when coordination recovers. Re-injecting the notice every turn during a
 * transient operator-latency window spams the model + TUI and, in an auto-continuing
 * omp session, drives a self-reinforcing turn loop (each notice → a worried quick turn
 * → another turn_start → more coord burst → more latency → more notices). Surface it
 * ONCE per streak instead. Exported reset for tests. */
let _degradedNotified = false;
export function _resetDegradedNotifiedForTests(): void {
  _degradedNotified = false;
}

/** Epoch ms of the last probe — drives the detached-mode re-probe
 *  throttle so a recovered operator is picked up without paying a
 *  probe (a 2s timeout when still down) on every detached turn. */
let _lastProbeAtMs = 0;

/** How stale a detached-mode probe may get before onTurnStart re-probes
 *  (audit NB-1 — detached→attached recovery). */
const DETACHED_REPROBE_MS = 120_000;

/** The operator's base origin from env, or null if none is configured. */
function operatorBaseUrl(): string | null {
  for (const v of [process.env.PAPERCUSP_BUNDLE_URL, process.env.PAPERCUSP_OPERATOR_URL]) {
    if (v) {
      try {
        return new URL(v).origin;
      } catch {
        /* malformed — try the next */
      }
    }
  }
  return null;
}

/**
 * Probe GET <operator>/api/health. True iff the operator answers 200
 * within `timeoutMs`. Any error (no operator configured, refused,
 * timeout, non-200) → false. See agent-coordination-architecture-v2
 * Q-5: /api/health is the dedicated liveness route.
 */
export async function probeOperator(timeoutMs = 2000): Promise<boolean> {
  const base = operatorBaseUrl();
  if (!base) return false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${base}/api/health`, { signal: ctrl.signal });
      return res.ok;
    } finally {
      clearTimeout(t);
    }
  } catch {
    return false;
  }
}

/** Probe and update `_mode` + the probe timestamp. Returns the mode. */
export async function refreshMode(): Promise<CoordMode> {
  _mode = (await probeOperator()) ? 'attached' : 'detached';
  _lastProbeAtMs = Date.now();
  return _mode;
}

// ── Watermark staging type ───────────────────────────────────────────

/** Last-read pointers the hook tracks — a subset of the operator's
 *  Watermark (messages + plan-events; escalations/subscriptions are
 *  not consumed by the turn-start reminder). */
export interface HookWatermark {
  messages?: string;
  plan_events?: string;
}

// ── Handlers ─────────────────────────────────────────────────────────

interface HookSessionLinkContext {
  cwd?: string;
  sessionManager?: {
    getSessionId?: () => string;
    getSessionFile?: () => string | undefined;
    getCwd?: () => string;
  };
}

function contextCwd(ctx: unknown): string | undefined {
  const c = ctx as HookSessionLinkContext | undefined;
  const cwd = c?.cwd ?? c?.sessionManager?.getCwd?.();
  return typeof cwd === 'string' && cwd.trim() ? cwd : undefined;
}

function currentSessionLinkFromContext(ctx: unknown): {
  advSessionId: number;
  sessionId: string;
  filePath?: string;
  cwd?: string;
} | null {
  const rawAdvSessionId = process.env.PAPERCUSP_ADV_SESSION_ID;
  if (!rawAdvSessionId) return null;
  const advSessionId = Number(rawAdvSessionId);
  if (!Number.isFinite(advSessionId) || advSessionId <= 0) return null;

  const c = ctx as HookSessionLinkContext | undefined;
  const sessionId = c?.sessionManager?.getSessionId?.()?.trim();
  if (!sessionId) return null;

  const filePath = c?.sessionManager?.getSessionFile?.();
  const cwd = contextCwd(c);
  return {
    advSessionId,
    sessionId,
    ...(filePath ? { filePath } : {}),
    ...(cwd ? { cwd } : {}),
  };
}

export async function linkAdvSessionFromContext(ctx: unknown): Promise<boolean> {
  if (_advSessionLinkState === 'linked') return true;
  if (_advSessionLinkState === 'conflict' || _advSessionLinkState === 'failed') return false;
  const link = currentSessionLinkFromContext(ctx);
  if (!link) return false;
  const result = await callMcpTool('omp:sessions', { op: 'link', ...link }, { preserveErrors: true }) as
    | { ok?: boolean; code?: number; error?: string; message?: string; result?: string }
    | null;
  if (result?.result === 'conflict') {
    _advSessionLinkState = 'conflict';
    return false;
  }
  // A structured tool/RPC error is deterministic for this payload. Latch it
  // so a schema mismatch cannot turn every subsequent hook invocation into an
  // identical retry storm. Transport failures remain null and retryable.
  const error = result?.error;
  const deterministicError =
    (error === 'mcp_tool_error' && /invalid[_ ]args|unrecognized key|validation/i.test(result?.message ?? '')) ||
    (error === 'mcp_rpc_error' && (result?.code === -32602 || /invalid[_ ]args|unrecognized key|validation/i.test(result?.message ?? ''))) ||
    (typeof error === 'string' && error.length > 0 && error !== 'mcp_tool_error' && error !== 'mcp_rpc_error');
  if (deterministicError) {
    _advSessionLinkState = 'failed';
    return false;
  }
  const linked = result?.ok === true &&
    (result.result === 'linked' || result.result === 'already_linked');
  if (linked) _advSessionLinkState = 'linked';
  return linked;
}

/** Overall wall-clock budget for onSessionStart. pi's extension framework HARD-KILLS a
 *  session_start handler that runs past 30s ("Extension error: handler timed out after
 *  30000ms"), turning a slow-operator launch into a framework error instead of a graceful
 *  degrade. Each coord call is already AbortController-bounded (6s, above), but the handler
 *  used to run them SEQUENTIALLY (refreshMode → link → declare-intent), whose worst-case sum
 *  rode past 30s once machine load (WI-3147: load ~68) slipped the fetch/abort timers. We now
 *  (a) run the two independent attached-mode coord calls CONCURRENTLY (critical path becomes
 *  max(link, declare), not link + declare) and (b) cap the whole handler under this deadline,
 *  so it ALWAYS returns well under pi's 30s cap. A deadline hit degrades to the normal
 *  "coordination unavailable, will retry" path — the first onTurnStart re-probes, re-links,
 *  and re-declares presence, so nothing is permanently lost. */
const SESSION_START_DEADLINE_MS = 20_000;

/** Await `p`, but never longer than `ms`. Resolves (never rejects) when `p` settles OR the
 *  deadline elapses, whichever is first. The losing promise keeps running — its own
 *  AbortController guards bound it — we simply stop awaiting it. Used to hard-cap a hook
 *  handler's wall-clock time so it returns under pi's framework timeout. */
export async function withDeadline(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    // Swallow a rejection from `p` so a losing (deadline-won) promise never surfaces an
    // unhandled rejection after we've stopped awaiting it.
    await Promise.race([p.then(() => undefined, () => undefined), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Fired once per OMP session start. Probes the operator to choose
 *  attached/detached mode, then links the ADV sessions row to the OMP
 *  session id when the launcher passed PAPERCUSP_ADV_SESSION_ID. It then
 *  declares presence (attached only — presence is PG-backed and unavailable
 *  detached). Bounded by SESSION_START_DEADLINE_MS so a slow operator can never
 *  drive the handler past pi's 30s framework cap (WI-3147). */
export async function onSessionStart(ctx?: unknown): Promise<void> {
  // Mint the per-process coordination owner id up front (file-locking
  // #2). Every subsequent callMcpTool carries it via `?client=`, so a
  // lock or coordination message authored by this process is always
  // attributed to THIS process — never collapsed with a sibling OMP
  // shell that happens to share a bundle token.
  hookOwnerId();
  await withDeadline(sessionStartInner(ctx), SESSION_START_DEADLINE_MS);
}

/** The actual session-start work, wrapped by onSessionStart's deadline. */
async function sessionStartInner(ctx?: unknown): Promise<void> {
  await refreshMode();
  if (_mode !== 'attached') return;
  // The ADV-session link and the presence declare-intent share no ordering
  // dependency, so run them CONCURRENTLY — the attached critical path becomes
  // max(link, declare) instead of link + declare (WI-3147). Both callees catch
  // their own errors (callMcpTool returns null on failure), so Promise.all never
  // rejects. reportLifecycle stays fire-and-forget.
  await Promise.all([
    linkAdvSessionFromContext(ctx),
    callMcpTool('coord:declare-intent', { intent: 'OMP session started' }),
  ]);
  // Activity bridge: a "worker appeared" lifecycle marker for the fleet view.
  void reportLifecycle('start');
}

/**
 * Fired on process exit (SIGINT/SIGTERM). Defensive lock cleanup
 * (file-locking #2 step 4): release every lock this owner still
 * holds. In the normal path onToolResult already released each lock
 * as its tool finished, so this is a backstop for a session that
 * ends mid-edit (turn aborted between tool_call and tool_result).
 *
 * Uses `all_mine: true` — one call that releases everything the
 * `?client=` owner holds, rather than iterating the local cache
 * (which could be stale if a tool_result was missed). Best-effort:
 * a failure here is covered by the lock TTL.
 */
export async function onSessionShutdown(): Promise<void> {
  acquiredLocks.clear();
  // Activity bridge: a "worker left" lifecycle marker, then the lock backstop.
  await reportLifecycle('shutdown');
  await callMcpTool('locks:release', { all_mine: true });
}

/**
 * Watermark carried between turn_start and turn_end. onTurnStart records
 * the newest ts it surfaced on each surface (messages + plan-events);
 * onTurnEnd persists them. Conservative by design (plan §7.2): an
 * aborted turn never reaches turn_end, so the next turn re-sees the
 * same notifications — a missed notification is worse than a repeated
 * one.
 */
let _pendingWatermark: HookWatermark = {};

/** Mid-turn delivery cursor — the newest message ts already surfaced this
 *  turn (by turn_start or a prior tool_result). The tool_result poll fetches
 *  coord:inbox SINCE this, so a message that arrives mid-turn reaches the
 *  agent before its next step instead of only at the next turn_start. Seeded
 *  each attached turn_start; undefined detached/pre-seed (→ no mid-turn poll,
 *  so we never dump history on a missing baseline). */
let _midTurnCursor: string | undefined;

/** Test seam — reset the mid-turn cursor between cases. */
export function _resetMidTurnCursorForTests(v?: string): void {
  _midTurnCursor = v;
}

/** Largest ISO ts in a list of inbox entries, or '' if empty. */
function maxTs(entries: InboxEntry[]): string {
  let max = '';
  for (const e of entries) {
    if (e.ts > max) max = e.ts;
  }
  return max;
}

/** Result of a turn-start assembly. `degraded` is true when ATTACHED
 *  but the core operator call (coord:inbox) failed transiently.
 *  `mode` reports attached/detached — detached is a supported mode,
 *  not a failure. The adapter surfaces both (plan §7.4 / §10). */
export interface TurnStartResult {
  reminder: string;
  degraded: boolean;
  mode: CoordMode;
}

/** Attached turn-start: assemble the reminder over the MCP tool path. */
async function onTurnStartAttached(ownerId: string): Promise<TurnStartResult> {
  // Read the watermark first — its two pointers scope the inbox and the
  // plan-events feed respectively.
  // Tight per-call budgets (WI-1081): turn_start has only OMP's 2s framework cap. watermark is
  // sequential-before the batch (500ms), the 4-call batch runs in parallel (1000ms each) → ≤1.5s
  // worst case, leaving margin under 2s. Healthy coord calls are <100ms so this only bites when
  // the operator is slow — where aborting to the graceful degraded path is exactly right.
  const wmResult = await callMcpTool('coord:watermark', {}, { timeoutMs: 500 });
  const wm = (() => {
    const r = wmResult as {
      watermark?: { messages_since_ts?: string; plan_events_since_ts?: string };
    } | null;
    const m = r?.watermark?.messages_since_ts;
    const p = r?.watermark?.plan_events_since_ts;
    return {
      messages: typeof m === 'string' && m.length > 0 ? m : undefined,
      planEvents: typeof p === 'string' && p.length > 0 ? p : undefined,
    };
  })();

  // The heartbeat (declare-intent) runs concurrently with the inbox
  // fetch — it does not gate the reminder — but is AWAITED as part of
  // the batch. A bare `void callMcpTool(...)` could accumulate unbounded
  // pending promises against a hung operator (audit B4); batching it
  // bounds the in-flight count to one per turn. coord:plan-events is in
  // the same batch — plan_event lines live in coord/plan-events-*.jsonl,
  // NOT coord/messages/, so coord:inbox never surfaces them (audit NB-2).
  const [inboxResult, locksResult, , planEventsResult] = await Promise.all([
    callMcpTool('coord:inbox', {}, { timeoutMs: 1000 }),
    callMcpTool('locks:queue', { owner: ownerId }, { timeoutMs: 1000 }).catch(() => null),
    callMcpTool('coord:declare-intent', {
      intent: '(active — see coord:presence for current work)',
    }, { timeoutMs: 1000 }),
    callMcpTool('coord:plan-events', {}, { timeoutMs: 1000 }).catch(() => null),
  ]);

  // coord:inbox returning null means the operator call FAILED (an empty
  // inbox returns { entries: [] }, which is truthy). That is the
  // degraded signal — the turn-start context is incomplete.
  const degraded = inboxResult === null;

  const inbox: InboxEntry[] = (() => {
    const r = inboxResult as { entries?: InboxEntry[] } | null;
    return r?.entries ?? [];
  })();
  const heldLocks: HeldLock[] = (() => {
    const r = locksResult as { active_locks?: HeldLock[] } | null;
    return r?.active_locks ?? [];
  })();
  const planEvents: InboxEntry[] = (() => {
    const r = planEventsResult as { events?: InboxEntry[] } | null;
    return r?.events ?? [];
  })();
  const changedPlans = summarisePlanEvents(planEvents);

  const inboxMax = maxTs(inbox);
  const planEventsMax = maxTs(planEvents);
  _pendingWatermark = degraded
    ? {}
    : {
        ...(inboxMax.length > 0 ? { messages: inboxMax } : {}),
        ...(planEventsMax.length > 0 ? { plan_events: planEventsMax } : {}),
      };

  // Seed the mid-turn cursor at the newest position surfaced this turn, so the
  // tool_result poll only injects messages that arrive AFTER turn start (no
  // overlap with the reminder just built, no history dump on a fresh inbox).
  _midTurnCursor = degraded
    ? undefined
    : inboxMax.length > 0
      ? inboxMax
      : (wm.messages ?? new Date().toISOString());

  return {
    reminder: formatTurnStartReminder({
      ownerId,
      inbox,
      heldLocks,
      changedPlans,
    }),
    degraded,
    mode: 'attached',
  };
}

/** Detached turn-start: the operator is unreachable, so coord state —
 *  inbox, plan-events, watermarks, presence, locks — is ALL PG-backed and
 *  cannot be read (no filesystem fallback; coord-channels-pg-port P-010 /
 *  D-001). Inject nothing (a lone notice every turn risks an OMP
 *  auto-continue loop — see formatTurnStartReminder) and stage no
 *  watermark. The agent's lock hook separately fails open with its own
 *  stderr notice. */
function onTurnStartDetached(): TurnStartResult {
  _pendingWatermark = {};
  _midTurnCursor = undefined; // no baseline → tool_result poll is a no-op
  return { reminder: '', degraded: false, mode: 'detached' };
}

/** Fired once per turn start. Dispatches by mode. Recovery is
 *  bidirectional (audit NB-1): an attached call that comes back
 *  degraded re-probes (operator may have gone away); a detached turn
 *  re-probes on a throttle (operator may have come back). */
export async function onTurnStart(ctx?: unknown): Promise<TurnStartResult> {
  const ownerId = process.env.PAPERCUSP_AUTH_SESSION_ID ?? 'unknown';

  if (_mode === 'detached') {
    // Throttled re-probe — a recovered operator is picked up without
    // paying a probe (a 2s timeout while still down) every turn.
    const needsImmediateAdvLinkProbe =
      _advSessionLinkState === 'pending' && !!process.env.PAPERCUSP_ADV_SESSION_ID;
    if (needsImmediateAdvLinkProbe || Date.now() - _lastProbeAtMs > DETACHED_REPROBE_MS) {
      await refreshMode();
    }
    if (_mode === 'detached') {
      return onTurnStartDetached();
    }
    // Operator came back — fall through to the attached path.
  }

  await linkAdvSessionFromContext(ctx);
  const attached = await onTurnStartAttached(ownerId);
  if (!attached.degraded) return attached;
  // Attached call failed — was it a transient blip or did the operator
  // go away? Re-probe; if it is truly gone, fall through to detached so
  // this turn is still useful.
  // Use refreshMode()'s return value, not the module-level `_mode`:
  // TS's control-flow analysis over-narrows `_mode` to 'attached' here
  // (it was narrowed by the block above and TS doesn't track that
  // refreshMode() reassigns it), which makes `_mode === 'detached'`
  // look like dead code. The returned value is correctly typed.
  const reprobed = await refreshMode();
  if (reprobed === 'detached') {
    return onTurnStartDetached();
  }
  await linkAdvSessionFromContext(ctx);
  return attached; // operator is up — a genuine transient failure
}

/** Fired once per turn end.
 *
 *  The client-reported watermark write is RETIRED (plan
 *  fleet-deltas-leader-primitives-2026-07-10, D-004 ruling 1 / D-014). This used
 *  to send client-reported cursor pointers staged by onTurnStart. Both
 *  cursors now settle SERVER-side and are derived from the authoritative read
 *  receipt rather than reported by the client:
 *    - `messages_since_ts` settles at `journal:record-turn`
 *      (turn-end-tracking-io.ts), which fires at every turn end on EVERY CLI —
 *      not just OMP — and which now also carries the EI-9389 inbox-wake
 *      delivery coalescing that used to ride the retired verb;
 *    - plan-events delivery rides the server-side read cursors.
 *
 *  Kept as an explicit no-op rather than deleted: it is part of the OMP hook's
 *  published lifecycle surface, and a hook the adapter calls must exist. */
export async function onTurnEnd(): Promise<void> {
  _pendingWatermark = {};
}

/* `pollInboxDelta` (the LEGACY direct mid-turn poll) was removed with the
 * agent-facing `since_ts` parameter it depended on — plan
 * fleet-deltas-leader-primitives-2026-07-10, decision D-013 R2. It had no
 * production caller: the adapter takes mid-turn delivery from `activity:report`'s
 * bundled surface (see `consumeInboxDelta(bundle.surfaces.inbox)` below), which
 * owns the server-side read cursor for surface 'inbox' and is therefore a real
 * delta without any client-carried timestamp. `consumeInboxDelta` is retained —
 * it is the shared shape-consumer that path still uses. */

/** Consume the server's coord:inbox JSON shape from either the legacy direct
 * poll or activity:report's bundled surface. */
export function consumeInboxDelta(inboxResult: unknown): { reminder: string } {
  const r = inboxResult as
    | { entries?: InboxEntry[]; injection?: string; summary?: { newest_ts?: string | null } }
    | null;
  const inbox = r?.entries ?? [];
  if (inbox.length === 0) return { reminder: '' };
  // Advance the cursor past every returned entry (server's max-ts, else compute).
  const serverMax = typeof r?.summary?.newest_ts === 'string' ? r.summary.newest_ts : '';
  const newMax = serverMax || maxTs(inbox);
  if (newMax.length > 0) {
    _midTurnCursor = newMax;
    _pendingWatermark = { ..._pendingWatermark, messages: newMax };
  }
  // Echo the server-rendered positional injection (dumb pipe).
  return { reminder: formatInboxDelta(r?.injection ?? '') };
}

/**
 * Tool-call enforcement (file-locking-improvements #2). Matches OMP's
 * `ToolCallEvent` from @oh-my-pi/pi-coding-agent/src/extensibility/
 * hooks/types.ts: discriminated `type: "tool_call"` envelope with
 * toolName / toolCallId / input. Return shape matches
 * `ToolCallEventResult` ({ block?, reason? }).
 *
 * Strategy (mirrors the now-deleted Claude Code PreToolUse/PostToolUse
 * shell hooks, with the same fail-open precedent):
 *   1. Extract repo-relative paths from the tool input (skip if the
 *      tool isn't a file-edit, or the path is outside the repo).
 *   2. Call locks:acquire with wait={max_sec:0} (no queueing on
 *      the hook — block immediately so the agent can replan).
 *   3. On ok → cache lock_id by toolCallId for onToolResult to release.
 *   4. On busy → return { block: true, reason: <formatted refusal> }.
 *   5. On operator-unreachable → log + return {} (fail open;
 *      cooperative discipline only works when the system is up).
 */
/**
 * Persistent OS schedulers, matched at COMMAND POSITION (start of command,
 * after a `;`/`&`/`|`/newline separator, or behind `sudo`) — never mid-word
 * or in prose args, so `cat`, `atuin`, or `echo "look at this"` can't trip
 * it (native-scheduler-lockout-2026-06-09 P-010 / OQ-3: the unambiguous set
 * only; widen only on observed escapes). Exported for unit tests.
 */
export const OS_SCHEDULER_CMD_RE = /(?:^|[;&|\n]\s*|\bsudo\s+)(?:crontab|at|batch|systemd-run)\b/;

/**
 * Strip single- and double-quoted spans (each → a single space) so the `;&|`
 * command-position anchor in {@link OS_SCHEDULER_CMD_RE} only ever sees REAL
 * shell separators, never a `;`/`&`/`|` that is literal data inside a quoted
 * argument (EI-9937). Replacing with a space (not deleting) keeps adjacent
 * tokens from gluing into a false match and from becoming adjacent to a
 * separator. An unterminated quote drops the rest — only ever more permissive,
 * never a false deny. A backslash-escaped quote inside `"..."` does not close.
 */
export function stripShellQuotes(s: string): string {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === "'") {
      const j = s.indexOf("'", i + 1);
      if (j === -1) break;
      out += ' ';
      i = j + 1;
    } else if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (s[j] === '\\') {
          j += 2;
          continue;
        }
        if (s[j] === '"') break;
        j += 1;
      }
      if (j >= n) break;
      out += ' ';
      i = j + 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/**
 * Remove heredoc payloads interpreted by another language before scanning shell
 * command positions. A Python/Node variable named `batch` is not the shell's
 * `batch` scheduler; shell-fed heredocs remain visible so real schedules are
 * still denied.
 */
export function stripNonShellHeredocBodies(s: string): string {
  return s.replace(
    /^([^\n]*)<<-?\s*(["']?)([A-Za-z_]\w*)\2([^\n]*)\n([\s\S]*?)^\s*\3\s*$/gm,
    (whole, before: string, quote: string, delimiter: string, after: string) => {
      const opener = `${before}${after}`;
      const isShell = /(?:^|[;&|]\s*)(?:\S*\/)?(?:ba|da|k|z)?sh(?:\s|$)/.test(opener);
      return isShell ? whole : `${before}<<${quote}${delimiter}${quote}${after}\n`;
    },
  );
}

/**
 * Same anchors as {@link OS_SCHEDULER_CMD_RE}, but CAPTURING the invocation head
 * so a match can be widened to the command segment it starts and then classified
 * read-vs-write. Global: a compound command can hold several invocations.
 */
const OS_SCHEDULER_CMD_HEAD_RE = /(?:^|[;&|\n]\s*|\bsudo\s+)((?:crontab|at|batch|systemd-run)\b)/g;

/** Read-only crontab shapes: `-l`, optionally with `-u <user>`. Nothing else. */
const CRONTAB_READONLY_ARGS_RE = /^crontab((?:\s+(?:-l|-u\s+\S+))*)\s*$/;

/**
 * EI-20419484186942049 — the lockout exists to stop an agent CREATING an OS
 * schedule the hive's pause/status/liveness machinery cannot see. A pure LISTING
 * creates nothing, so denying it bought no safety and taught agents to route
 * AROUND the rail: observed live, the reporter dropped a `crontab -l` audit of a
 * reconciler's entry and verified it indirectly through journal output instead.
 * A guard that blocks reads is the one a session learns to distrust.
 *
 * ALLOWLIST, deliberately — exempt only when the ENTIRE argument list is a
 * recognised listing, so an unrecognised shape (including a mutating flag some
 * future crontab adds) still denies and the guard fails CLOSED. Still denied:
 * `crontab -e`, `crontab -r`, `crontab <file>`, `crontab -`, bare `crontab`.
 *
 * Mirrors `_is_readonly_scheduler_invocation()` in the Claude/Codex hook
 * (scripts/hooks/cc/pretooluse-bash-resource-gate.sh) — a guard fixed in one
 * path must be fixed in both.
 */
const SCHEDULER_INPUT_REDIR_RE = /(?:^|\s)\d*</;
const SCHEDULE_WRITE_TARGET_RE =
  /\/etc\/cron|\/var\/spool\/cron|\/etc\/at\b|\/var\/spool\/at|\/etc\/systemd|\/systemd\/(?:user|system)\b/;
/**
 * fd-duplication FIRST, so `2>&1` is not consumed as `2>` plus the filename
 * `&1`. The final alternative matches a DANGLING operator at end-of-segment:
 * {@link isOsSchedulerCommand} splits on `[;&|\n]`, and the `&` inside `2>&1`
 * is one of those — so the segment that actually reaches this predicate for
 * `crontab -l 2>&1 | head` is the truncated `crontab -l 2>`.
 */
const SCHEDULER_OUTPUT_REDIR_RE = /\s*(?:\d*>&\s*[-\d]+|&>>?\s*\S+|\d*>>?\s*\S+|\d*>>?&?\s*$)/g;

/**
 * EI-21934170410740770 — `seg` with output redirections removed, or null when
 * it carries a redirection that must NOT be waved through.
 *
 * The allowlist regex is $-ANCHORED, so any redirection token defeated it:
 * `crontab -l 2>&1` denied while bare `crontab -l` passed, and the refusal
 * text promised in the same breath that listings pass. A redirection is
 * DECORATION on the invocation, not an argument to it — but stripping it is
 * fail-CLOSED, because two shapes really can create a schedule: INPUT
 * redirection (`crontab < file` IS the stdin install vector) and an OUTPUT
 * target that is itself a schedule spool or drop-in (`crontab -l >
 * /var/spool/cron/crontabs/bob` installs a crontab for bob with no mutating
 * flag anywhere in the command).
 */
function stripOutputRedirections(s: string): string | null {
  if (SCHEDULER_INPUT_REDIR_RE.test(s)) return null;
  let vetoed = false;
  const stripped = s.replace(new RegExp(SCHEDULER_OUTPUT_REDIR_RE.source, 'g'), (token) => {
    if (SCHEDULE_WRITE_TARGET_RE.test(token)) vetoed = true;
    return ' ';
  });
  return vetoed ? null : stripped.trim();
}

export function isReadOnlySchedulerInvocation(seg: string): boolean {
  const bare = seg.trim().replace(/^sudo\s+/, '').trim();
  const s = stripOutputRedirections(bare);
  if (s === null) return false;
  if (/^systemd-run\b/.test(s)) {
    // Transient service/scope/resource-control units are not schedules.
    return !isSystemdScheduleInvocation(s);
  }
  const m = CRONTAB_READONLY_ARGS_RE.exec(s);
  // `-l` must be PRESENT, not merely permitted by the shape: bare
  // `crontab -u bob` installs bob's crontab FROM STDIN.
  if (m) return /(?:^|\s)-l(?=\s|$)/.test(m[1]);
  // `at -l` is `atq` spelled differently — a queue listing, not a new job.
  return /^at\s+-l\s*$/.test(s);
}

/**
 * True when `cmd` creates a persistent OS schedule at command position, IGNORING
 * `;&|` operators that appear inside quoted arguments (EI-9937) and read-only
 * listings (EI-20419484186942049). This is the matcher the guard uses;
 * {@link OS_SCHEDULER_CMD_RE} stays exported for the raw-anchor unit tests.
 */
export function isOsSchedulerCommand(cmd: string): boolean {
  const scannable = stripShellQuotes(stripNonShellHeredocBodies(cmd));
  const re = new RegExp(OS_SCHEDULER_CMD_HEAD_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(scannable)) !== null) {
    const headStart = m.index + m[0].length - m[1].length;
    const seg = scannable.slice(headStart).split(/[;&|\n]/, 1)[0] ?? '';
    if (!isReadOnlySchedulerInvocation(seg)) return true;
  }
  return false;
}

/**
 * EI-21924747520941481 — `systemd-run` is also the cgroup-isolation mechanism
 * used by the execution guards. Only its timer-backed forms create a persistent
 * OS schedule; transient services/scopes, `--pipe --wait`, and resource-control
 * properties must remain available. The lockout therefore denies only explicit
 * timer options.
 */
const SYSTEMD_SCHEDULE_FLAG_RE = /--on-(?:calendar|active|boot|startup|unit-active|unit-inactive)\b|--timer-property\b/i;

function isSystemdScheduleInvocation(cmd: string): boolean {
  const c = stripShellQuotes(cmd);
  const marker = /\bsystemd-run\b/.exec(c);
  if (!marker) return false;
  // `--` terminates systemd-run's own options; a payload argument named
  // `--on-calendar` is not a timer request.
  const options = c.slice((marker.index ?? 0) + marker[0].length).split(/\s+--(?:\s|$)/, 1)[0] ?? '';
  return SYSTEMD_SCHEDULE_FLAG_RE.test(options);
}

/** The refusal text for a blocked OS-scheduler command. */
export function osSchedulerDenyReason(_cmd: string): string {
  return (
    'native-scheduler lockout: agent sessions must not create OS schedules ' +
    '(crontab / at / batch / systemd-run). Declare your wake via ' +
    'pot:declare-wake instead — the routines table is the only scheduler ' +
    'the hive’s pause/status/liveness machinery can see. ' +
    '(Read-only listings are NOT blocked — `crontab -l`, `atq` / `at -l` and ' +
    '`systemctl list-timers` all pass. This refusal is specifically about ' +
    'CREATING or MODIFYING a schedule, so if you were only trying to VERIFY an ' +
    'existing entry, re-run the listing form on its own.)'
  );
}

/**
 * EI-10939 — tauri-agent-tools target guard (SAFETY). Mirrors the Claude/Codex
 * shell hook (pretooluse-bash-resource-gate.sh); fix one, fix both.
 *
 * `tauri-agent-tools` chooses its target by scanning /tmp for
 * `tauri-dev-bridge-<pid>.token` and taking THE FIRST LIVE ONE IT HAPPENS TO READ
 * (its tokenDiscovery.js: `if (!found) found = …`, over an unordered readdir;
 * commands/shared.js `resolveBridge()` falls into that path whenever `--pid` and
 * `--port`+`--token` are all absent). No preference, no tie-break, and no warning
 * when several bridges are alive — so a bare `tauri-agent-tools click …` drives
 * whichever app came up first. That is frequently the OWNER'S LIVE DESKTOP WINDOW
 * rather than the throwaway instance the agent spawned (an agent came within one
 * keystroke of typing into the owner's real app).
 *
 * The package is a third-party global npm install, outside our repo — we cannot
 * fix `resolveBridge`. Refusing to let an UNAIMED command through is the same
 * protection, and it is ours to enforce.
 *
 * TWO TIERS, because ambiguity is not the only hazard:
 *  • MUTATING (eval/click/type/…) — an explicit target is required ALWAYS, even
 *    with exactly one live bridge. Verified 2026-07-13: the ONLY live bridge on
 *    this box WAS the owner's own papercusp-desktop, so an ambiguity-only rule
 *    would have sailed through and driven his window. Driving a webview you did
 *    not name is never safe.
 *  • READ-ONLY bridge commands — required only when genuinely AMBIGUOUS (2+ live
 *    bridges). Reading the wrong app is how "I verified my fix" becomes a false green.
 *  • Discovery / bridge-free commands (probe, list-windows, info, forensics, …) are
 *    NEVER gated — `probe` is the ANSWER to this deny.
 */
const TAT_MUTATING = new Set([
  'eval', 'click', 'type', 'scroll', 'focus', 'navigate', 'select', 'invoke',
]);
const TAT_BRIDGE_READ = new Set([
  'screenshot', 'dom', 'wait', 'ipc-monitor', 'page-state', 'storage',
  'console-monitor', 'mutations', 'snapshot', 'rust-logs', 'store-inspect',
  'check', 'capture', 'process-tree', 'capabilities', 'webview', 'health',
  'diagnose',
]);
const TAT_BIN_RE = /(?:^|[\s;&|(])(?:[\w./-]*\/)?tauri-agent-tools(?=\s|$)/;

export interface TauriBridge {
  pid: number;
  port: number | null;
  exe: string;
}

/** The subcommand being run, or null for a bare / `--help` / non-tat command. */
export function tauriSubcommand(cmd: string): string | null {
  const stripped = stripShellQuotes(cmd);
  const m = TAT_BIN_RE.exec(stripped);
  if (!m) return null;
  for (const tok of stripped.slice(m.index + m[0].length).trim().split(/\s+/)) {
    if (!tok) continue;
    if (tok.startsWith('-')) continue;
    return tok;
  }
  return null;
}

/** `--pid N` aims it; `--port N --token X` bypasses discovery and is equally explicit. */
export function tauriHasExplicitTarget(cmd: string): boolean {
  const c = stripShellQuotes(cmd);
  if (/--pid[=\s]/.test(c)) return true;
  return /--port[=\s]/.test(c) && /--token[=\s]/.test(c);
}

/**
 * The same discovery the tool itself does — live `tauri-dev-bridge-<pid>.token`
 * files — plus each process's cmdline, so the refusal can NAME the candidates
 * instead of merely asserting ambiguity. Fail-open (returns []) on any error: a
 * hook must never wedge a command because it could not read /tmp.
 */
export function liveTauriBridges(dir: string = tmpdir()): TauriBridge[] {
  const out: TauriBridge[] = [];
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return out;
  }
  for (const f of files.sort()) {
    if (!f.startsWith('tauri-dev-bridge-') || !f.endsWith('.token')) continue;
    try {
      const data = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { pid: number; port?: number };
      process.kill(data.pid, 0); // throws unless alive — stale tokens are skipped (as the tool does)
      let exe = '(unknown process)';
      try {
        exe = readFileSync(`/proc/${data.pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
      } catch { /* /proc unreadable — the pid is still live and still a candidate */ }
      out.push({ pid: data.pid, port: data.port ?? null, exe: exe.slice(0, 100) });
    } catch {
      continue; // dead or malformed
    }
  }
  return out;
}

/** The refusal text — always NAMES the live candidates so it is satisfiable in one edit. */
export function tauriTargetDenyReason(
  sub: string,
  bridges: TauriBridge[],
  mutating: boolean,
): string {
  const head = mutating
    ? 'tauri-agent-tools target guard: this command DRIVES a webview but does not say WHICH one.'
    : `tauri-agent-tools target guard: ${bridges.length} bridges are live, so \`${sub}\` cannot tell which app you mean.`;
  const candidates =
    bridges.map((b) => `  --pid ${b.pid}  port ${b.port ?? '?'}  ${b.exe}`).join('\n') ||
    '  (none discoverable right now)';
  return (
    `${head}\n` +
    'With no --pid, tauri-agent-tools attaches to the FIRST bridge token it finds in /tmp — ' +
    "an arbitrary readdir order, with no warning. That is frequently the OWNER'S LIVE DESKTOP " +
    'APP rather than the instance you spawned.\n\n' +
    `Live bridges right now:\n${candidates}\n\n` +
    `Re-run naming your target:\n  tauri-agent-tools ${sub} --pid <PID> …\n\n` +
    'Not sure which is yours? `tauri-agent-tools probe` (never blocked) lists the targets, ' +
    'and the PID of an app YOU spawned is the one you launched — if you did not spawn one, ' +
    "you are about to act on someone else's window."
  );
}

/** null = allow; a string = the refusal. */
export function tauriTargetDenial(cmd: string, dir: string = tmpdir()): string | null {
  const sub = tauriSubcommand(cmd);
  if (!sub) return null;
  const mutating = TAT_MUTATING.has(sub);
  if (!mutating && !TAT_BRIDGE_READ.has(sub)) return null; // probe / list-windows / bridge-free
  if (tauriHasExplicitTarget(cmd)) return null;
  const bridges = liveTauriBridges(dir);
  if (bridges.length === 0) return null; // nothing to hit — the tool prints its own error
  if (!mutating && bridges.length === 1) return null; // read + unambiguous
  return tauriTargetDenyReason(sub, bridges, mutating);
}

/**
 * Destructive tree-wide git guard (hive-loop-supervision-2026-06-21 / EI-2376
 * follow-up (a)): a TypeScript mirror of the Claude+Codex PreToolUse shell
 * hook's Python guard (pretooluse-bash-resource-gate.sh). OMP has no
 * shell-subprocess PreToolUse contract, so it can't share that script — this
 * duplicates its regex logic instead, applied to OMP's own bash tool call
 * path below. A pathspec-less `git reset --hard` / `git checkout|restore .`
 * (or `:/`) / `git clean -f*` / `git stash` on the SHARED staging checkout
 * discards EVERY concurrent agent's UNCOMMITTED work — edits sit unstaged
 * until the next git-sync tick, so the loss is UNRECOVERABLE (git never made
 * a blob; kopia backs up workspace-state, ~14KB, NOT the code). Confirmed
 * wiping a tested in-flight fix on 2026-06-21 — the root of the recurring
 * "my edits got reverted/overwritten" reports.
 *
 * Per-segment + start-anchored (split on `;&|`/newline, strip a leading
 * `sudo`) so `cd x && git reset --hard` is caught but `echo "git reset
 * --hard"` / a commit-message mention are not. Exported for unit tests.
 */
const GIT_CMD_PREFIX = String.raw`git\b(?:\s+-C\s+\S+|\s+-c\s+\S+|\s+--git-dir\S*|\s+--work-tree\S*)*\s+`;
const GIT_RESET_HARD_RE = new RegExp(`^${GIT_CMD_PREFIX}reset\\b.*--hard\\b`);
const GIT_CLEAN_F_RE = new RegExp(`^${GIT_CMD_PREFIX}clean\\b.*-\\w*f`);
const GIT_CHECKOUT_DOT_RE = new RegExp(`^${GIT_CMD_PREFIX}(?:checkout|restore)\\b.*\\s(?:\\.|:/)(?:\\s|$)`);
// EI-18215743778965613 (self-caught 2026-07-20): `pop`/`apply` used to be
// exempted alongside the genuinely-read-only subcommands below, and a scoped
// `push -- <paths>` was exempted too — but the stash is a SINGLE shared LIFO
// stack across the whole tree, not scoped by a push's pathspec: a scoped push
// followed by `pop` popped an UNRELATED ancient stash entry, producing a merge
// conflict in files never touched by the caller. `pop`/`apply` apply WHATEVER
// is on top of that shared stack to the working tree — the same "clobbers a
// peer's uncommitted state" hazard as reset --hard/checkout . — so deny them
// unconditionally, same as a scoped `push` (no more ` -- ` exemption below).
// `list`/`show` stay exempt (read-only); `drop`/`branch`/`clear` unchanged.
const GIT_STASH_RE = new RegExp(`^${GIT_CMD_PREFIX}stash\\b(?!\\s+(?:list|show|drop|branch|clear))`);

/** Returns the offending op name (e.g. `'git reset --hard'`) if `command`
 *  contains a destructive tree-wide git op at command position in any
 *  `;`/`&`/`|`/newline-separated segment, else `null`. Exported for tests. */
export function destructiveGitCommandOp(command: string): string | null {
  for (const rawSegment of command.split(/[;&|\n]/)) {
    const seg = rawSegment.trim().replace(/^sudo\s+/, '');
    if (GIT_RESET_HARD_RE.test(seg)) return 'git reset --hard';
    if (GIT_CLEAN_F_RE.test(seg)) return 'git clean -f';
    if (GIT_CHECKOUT_DOT_RE.test(seg)) return 'git checkout/restore .';
    if (GIT_STASH_RE.test(seg)) return 'git stash';
  }
  return null;
}

/** The refusal reason shown for a blocked destructive git op — mirrors the
 *  shell hook's `_git_deny` message verbatim (same guidance, same incident
 *  citation) so the two enforcement points give the agent identical advice. */
export function destructiveGitDenyReason(op: string): string {
  return (
    `shared-tree guard: \`${op}\` would discard EVERY concurrent agent's ` +
    "UNCOMMITTED work on the shared staging checkout — edits sit unstaged " +
    'until the next git-sync tick, so the loss is UNRECOVERABLE (no git blob; ' +
    'kopia backs up workspace-state, not code). This wiped a tested in-flight ' +
    "fix on 2026-06-21. To discard only YOUR change to ONE file, re-edit it by " +
    'hand or run `git checkout -- <that.one.file>` with an EXPLICIT path — ' +
    'never a pathspec-less reset/checkout/clean/stash. If you wanted a clean ' +
    "tree, you don't need one: stop editing and let git-sync commit."
  );
}

/**
 * EI-13135 — systemd user-manager exit/kill guard: a TypeScript mirror of the
 * Claude+Codex PreToolUse shell hook's Python guard
 * (pretooluse-bash-resource-gate.sh) — fix one, fix both.
 *
 * `systemctl --user exit` (or `start exit.target`) tears down the WHOLE
 * shared user@<uid> manager in one shot — bg-host, :3070, :3170, the
 * inference gateway, git-sync, mcp-proxy, every timer/watchdog, and every
 * OTHER live agent session's scope, all at once. Confirmed root cause of a
 * ~15min fleet-wide outage on 2026-07-16 (EI-13135): the manager logged
 * "Activating special unit exit.target" and exited 0/SUCCESS, and every
 * papercusp service stayed dead until an owner-authorized
 * `sudo systemctl start user@1000.service` recovered it. `loginctl
 * terminate-user`/`kill-user` and `systemctl stop|kill user@<uid>.service`
 * are the same class (they too tear down every unit under that user at
 * once) — same deny.
 *
 * Deliberately NOT gated on isAgentSession(), mirroring the tauri-agent-tools
 * guard above: EI-7872 established the marker is silently unset in exactly
 * the fleet-launched sessions this must protect, and unlike the git-guard the
 * protected resource here is the whole HOST's service plane, not a working
 * tree — there is no legitimate reason for ANY session driven through this
 * hook to tear it down.
 */
const SYSTEMD_EXIT_RE = /^systemctl\b(?:\s+--user)?\s+(?:start\s+exit\.target|exit)\b(?:\s|$)/;
const SYSTEMD_HALT_RE = /^systemctl\b(?:\s+--user)?\s+(?:halt|poweroff)\b(?:\s|$)/;
const LOGINCTL_KILL_RE = /^loginctl\b\s+(?:terminate-user|kill-user)\b(?:\s|$)/;
const SYSTEMD_USER_SERVICE_STOP_RE = /^systemctl\b\s+(?:stop|kill)\s+user@\d+\.service\b(?:\s|$)/;
const EXIT_GUARD_WRAP_STRIP_RE =
  /^\s*(?:sudo(?:\s+(?:-[ugpUrCht]\s+\S+|-[A-Za-z]+|--[\w-]+(?:=\S*)?))*|env(?:\s+[A-Za-z_]\w*=\S*)*|nice(?:\s+-n\s*-?\d+)?|ionice(?:\s+-\w+(?:\s+\d+)?)*|xargs(?:\s+-\w+)*|rtk|time|command|nohup|exec|setsid|nocorrect|stdbuf|doas|nocache)\s+/;

/** Returns the offending op name if `command` contains a systemd
 *  user-manager exit/kill op at command position in any
 *  `;`/`&`/`|`/newline-separated segment, else `null`. Exported for tests. */
export function systemdExitCommandOp(command: string): string | null {
  for (const rawSegment of command.split(/[;&|\n]/)) {
    let seg = stripShellQuotes(rawSegment.trim());
    for (let i = 0; i < 8; i++) {
      const next = seg.replace(EXIT_GUARD_WRAP_STRIP_RE, '');
      if (next === seg) break;
      seg = next;
    }
    if (SYSTEMD_EXIT_RE.test(seg)) return 'systemctl --user exit';
    if (SYSTEMD_HALT_RE.test(seg)) return 'systemctl --user halt/poweroff';
    if (LOGINCTL_KILL_RE.test(seg)) return 'loginctl terminate-user/kill-user';
    if (SYSTEMD_USER_SERVICE_STOP_RE.test(seg)) return 'systemctl stop/kill user@<uid>.service';
  }
  return null;
}

/** The refusal reason for a blocked systemd exit/kill op — mirrors the shell
 *  hook's `_EXIT_GUARD_DENY` message verbatim so both enforcement points give
 *  the agent identical advice. */
export function systemdExitDenyReason(op: string): string {
  return (
    `systemd user-manager exit/kill guard (EI-13135): \`${op}\` would tear down ` +
    'the ENTIRE shared user@<uid> service plane in one shot — bg-host, :3070, ' +
    ":3170, the inference gateway, git-sync, mcp-proxy, every timer/watchdog, " +
    "and every OTHER live agent session's scope, all at once. This caused a " +
    '~15min fleet-wide outage on 2026-07-16 (EI-13135). There is no ' +
    'legitimate agent reason to do this — if you mean to restart one specific ' +
    'papercusp service, use the blessed wrapper (dev:restart) instead.'
  );
}

// ── bash→tool substitution + resource verdict (bash-to-tool-substitution-2026-07-26, P-017) ──
/**
 * The OMP half of the substitution gate. Claude/Codex reach the registry through
 * the shell PreToolUse hook (`pretooluse-bash-resource-gate.sh`); OMP has no
 * shell-subprocess PreToolUse contract, so it asks the SAME question here over
 * MCP — `locks:check_command`, one round-trip, both answers.
 *
 * WHAT IS DELIBERATELY *NOT* MIRRORED: the patterns. Every guard above this one
 * is a TypeScript re-implementation of a Python regex, and each carries the
 * "fix one, fix both" tax that the file's own comments keep restating. The
 * substitution rules live in the registry
 * (`harness_shared.bash_tool_substitutions`) and are matched SERVER-side, so a
 * rule added there starts enforcing on both paths at once with no code change
 * in either. Duplicating the patterns here would reintroduce exactly the drift
 * the registry exists to remove.
 *
 * The one thing that must stay in step is the cheap PRE-FILTER — the local test
 * that decides whether a command is worth an HTTP round-trip at all. That is a
 * port of the server's atomizer (`packages/operator-core/lib/bash-substitution/
 * atomize.ts`), for the reason its shell twin spells out: testing registry verbs
 * as bare substrings would match "concatenate"/"duplicate"/"categories" and make
 * nearly every command pay the call this filter exists to avoid. A pre-filter
 * that disagrees with the matcher silently drops the very commands a rule was
 * written for, and that failure is invisible — so it is guarded mechanically by
 * replaying the committed equivalence fixtures through it (coord-hook.test.ts),
 * the same anti-drift test the shell hook has.
 */

/*
 * The three atomizer regexes below are duplicated in the shell hook (as Python
 * `re` patterns with textually identical sources) because each hook must be able
 * to run its pre-filter with no imports. That duplication is the one piece of
 * D-005's "fix one, fix both" tax the registry does NOT remove — widen the
 * runner set on one path only and a command behind the new wrapper reaches the
 * operator on that path while silently skipping the round-trip on the other.
 * So they are EXPORTED purely so coord-hook.test.ts can assert their sources
 * still match the shell hook's byte-for-byte; nothing else reads them.
 */
/** Compound-command separators — `atomize.ts` SEPARATORS. */
export const SUBST_SPLIT_RE = /\|\||&&|\||;|\n/;
/** Leading runner wrappers — `atomize.ts` RUNNER_PREFIX. */
export const SUBST_RUNNER_RE =
  /^(?:sudo\s+(?:-n\s+)?|nohup\s+|timeout\s+\S+\s+|time\s+|env\s+|command\s+|exec\s+)+/;
/** Leading `FOO=bar` env assignments — `atomize.ts` ENV_PREFIX. */
export const SUBST_ENV_RE = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/;

/**
 * Atom heads any enabled registry row can claim. A SET (not a regex
 * alternation) so it stays a cheap hash lookup on the hot path, and identical
 * to the shell hook's `_SUBSTITUTION_HEADS`. `npm run gen:tool-routing` derives
 * both copies from the audited pair fixtures; its check mode fails before CI if
 * either projection is stale.
 */
export const SUBSTITUTION_PREFILTER_HEADS = new Set([
  // BEGIN GENERATED gen:tool-routing prefilter heads — do not edit by hand
  'cat',
  'curl',
  'date',
  'free',
  'git',
  'grep',
  'head',
  'journalctl',
  'lsof',
  'netstat',
  'nproc',
  'npx',
  'pgrep',
  'ps',
  'psql',
  'sed',
  'ss',
  'systemctl',
  'tail',
  'tsc',
  'uptime',
  'vitest',
  // END GENERATED gen:tool-routing prefilter heads
]);

/**
 * Narrow PHRASES a substitution row can claim whose bare atom head is too
 * common to put in the head set above. The head set is a cheap hash lookup and
 * therefore all-or-nothing per verb: listing `npm` to reach
 * `tests.router-files` (`npm run test:file -- <paths>`) would make every
 * `npm run …` in the repo pay the operator round-trip and would break the
 * committed "does NOT claim an unrelated npm script" case. So the phrase is
 * matched instead — same question, one verb narrower.
 *
 * Duplicated in the shell hook as `_SUBSTITUTION_PHRASE_RE` for the same
 * no-imports reason as the three atomizer regexes, and guarded by the same
 * byte-for-byte parity test. Tested against the atom AFTER runner/env
 * stripping, so `sudo npm run test:file …` is claimed too.
 *
 * P-028 adds `npm install|ci|i` here for exactly the same reason, not in the
 * head set: `npm run lint` and friends must keep paying nothing. The pair's own
 * pattern is far narrower again (flags-only whole-tree reifies); this phrase
 * only decides which atoms pay the round-trip at all.
 */
export const SUBSTITUTION_PHRASE_RE = /^npm\s+run\s+test:file\b|^npm\s+(?:install|ci|i)(?=\s|$)/;

/** Resource-registry pre-filter — mirrors the shell hook's `_needs_check` regex.
 *  Exported for the same reason as the three atomizer regexes above: so the
 *  parity test can compare its source to the shell hook's rather than trusting
 *  two files to be edited together. */
export const RESOURCE_PREFILTER_RE =
  /systemctl|overmind|psql|astro|build-desktop-sidecar|release-local|npm\s+run\s+(?:dev|build)/;

/**
 * The normalized atoms of `command` — split on the separators, with runner and
 * env prefixes stripped and blanks dropped.
 *
 * Exported (with `substitutionAtomHead` below) so the head-set guards can derive
 * heads through the SAME code the hot path runs. A test that re-implements this
 * atomization would drift from it silently, which is the precise failure mode the
 * head-set guards exist to catch — so the guard must not contain a second copy.
 */
export function substitutionAtoms(command: string): string[] {
  const atoms: string[] = [];
  for (const part of command.split(SUBST_SPLIT_RE)) {
    let atom = part.trim();
    for (;;) {
      const stripped = atom.replace(SUBST_RUNNER_RE, '').replace(SUBST_ENV_RE, '');
      if (stripped === atom) break;
      atom = stripped;
    }
    if (atom) atoms.push(atom);
  }
  return atoms;
}

/** The claimable head of one normalized atom — `''` when it has none. */
export function substitutionAtomHead(atom: string): string {
  const first = atom.split(/\s+/).filter(Boolean)[0] ?? '';
  return (first.split('/').pop() ?? '').replace(/^[({`$'"]+|[)}`$'"]+$/g, '');
}

/** True when any atom of `command` has a head a substitution row could claim. */
export function substitutionPrefilterHit(command: string): boolean {
  for (const atom of substitutionAtoms(command)) {
    if (SUBSTITUTION_PHRASE_RE.test(atom)) return true;
    const head = substitutionAtomHead(atom);
    if (head && SUBSTITUTION_PREFILTER_HEADS.has(head)) return true;
  }
  return false;
}

/** True when the command could touch a named resource under an exclusive hold. */
export function resourcePrefilterHit(command: string): boolean {
  return RESOURCE_PREFILTER_RE.test(command);
}

/** One substitution match as `locks:check_command` returns it. */
export interface SubstitutionWire {
  atom?: string;
  toolName?: string;
  advisoryText?: string;
  tier?: string;
  /**
   * P-009 — the EXECUTABLE form of this row's advice, when the server could
   * derive one: args already mapped from the matched command. Optional by
   * design; see `formatSubstitutionLines` for what its absence means.
   */
  invoke?: { name?: string; args?: unknown };
  /**
   * P-009 — that same envelope, already RENDERED as a paste-ready
   * `tools:invoke { … }` line. Rendered on the server so this hook, the cc
   * shell hook and any other consumer print a string they cannot disagree
   * about; see `bash-substitution/invoke-envelope.ts` for why the formatting
   * deliberately does not live here.
   */
  invokeLine?: string;
}

/** The `locks:check_command` verdict, narrowed to what this hook consumes. */
export interface CheckCommandVerdict {
  decision?: string;
  matched?: { resource?: string }[];
  substitutions?: SubstitutionWire[];
  substitutionTier?: string | null;
}

/**
 * Ask the operator. Returns null on any failure — FAIL-OPEN is mandatory: a
 * wedged or detached operator must never wedge a shell command (`callMcpTool`
 * already swallows and returns null). The 3s budget is tighter than the shell
 * hook's 4s because this call sits inside an OMP tool_call handler, where the
 * latency is paid before the tool starts rather than in a detached subprocess.
 *
 * `format: 'json'` is REQUIRED, not a nicety. `locks:check_command` returns a
 * tabular `substitutions[]`, so the agent transport serializes it as TOON by
 * default — and `callMcpTool` parses the text as JSON. Without this the parse
 * throws, the helper returns null, and FAIL-OPEN does exactly what it promises:
 * every resource hold and every substitution row silently stops being enforced,
 * with no error anywhere. That is not hypothetical — it is the state this line
 * was in when P-028 tried to ship the registry's first `deny` and found the
 * gate had been dead on both hook paths (the suites never caught it because
 * they stub the operator with JSON, which is the one thing it does not send).
 * The parity is deliberate: the shell hook declares the same `_meta.format`.
 */
export async function checkCommandVerdict(
  command: string,
  cwd?: string,
): Promise<CheckCommandVerdict | null> {
  const res = await callMcpTool(
    'locks:check_command',
    { command, ...(cwd && cwd.trim() ? { cwd } : {}) },
    { timeoutMs: 3000, meta: { format: 'json' } },
  );
  return res && typeof res === 'object' ? (res as CheckCommandVerdict) : null;
}

/**
 * How to call a named tool that is not in the caller's loaded tool set
 * (EI-18810711449496523).
 *
 * Both messages below name a tool, and on a trimmed launch that tool usually
 * is not directly callable: measured on a live su session, 8 of the 10 tools
 * the registry names were absent from the session's surface entirely — not
 * loaded and not deferred, so a `ToolSearch select:` for them returns nothing.
 * The agent's next move is a wasted round-trip and a fall back to bash, after
 * which the same row fires again on the next command.
 *
 * Neither hook can fix that by suppression: a PreToolUse payload carries the
 * command and the session's identity, never its tool surface. So the messages
 * carry the calling convention that works unconditionally — `tools:invoke`
 * dispatches any catalog tool server-side under the same gating as a direct
 * call, and ships in every trimmed seed alongside `tools:find`.
 *
 * One constant feeds both messages deliberately. The advisory and the refusal
 * already state the same routing twice, and the pair has drifted before; a
 * remedy that appeared in one and not the other would leave the `deny` path —
 * the one that actually blocks the command — as the dead end.
 */
export const TOOLS_INVOKE_FALLBACK_HINT =
  'Not in your loaded tool set? `tools:invoke { name, args }` dispatches any ' +
  'catalog tool server-side — a ToolSearch miss is not a dead end.';

/**
 * `  • \`<atom>\` → <tool>` + the row's authored advisory, one block per match,
 * plus the EXECUTABLE call when the server derived one (P-009).
 *
 * The envelope goes LAST in the block, after the prose, because it is the line
 * the agent acts on: the advisory explains WHY the tool is better, the envelope
 * is what to type. `run:` labels it as a command rather than more explanation —
 * an unlabelled `tools:invoke {…}` reads as one more sentence about tools in a
 * block that is already made of sentences about tools.
 */
export function formatSubstitutionLines(subs: SubstitutionWire[]): string {
  return subs
    .map((s) => {
      const tool = s.toolName || '?';
      const atom = (s.atom || '').trim().slice(0, 160);
      const text = (s.advisoryText || '').trim();
      const invoke = (s.invokeLine || '').trim();
      const head = text ? `  • \`${atom}\` → ${tool}\n    ${text}` : `  • \`${atom}\` → ${tool}`;
      return invoke ? `${head}\n    run: ${invoke}` : head;
    })
    .join('\n');
}

/** True when at least one match carried an executable envelope. */
export function hasInvokeEnvelope(subs: SubstitutionWire[]): boolean {
  return subs.some((s) => (s.invokeLine || '').trim().length > 0);
}

/**
 * The generic routing hint, but ONLY when no block already carries a concrete
 * `run:` line (P-009).
 *
 * {@link TOOLS_INVOKE_FALLBACK_HINT} exists to tell an agent that a named tool
 * missing from its surface is not a dead end. A rendered envelope IS a
 * `tools:invoke` call, so repeating the generic form underneath it explains the
 * mechanism the agent is already looking at — and pushes the one executable line
 * further from the eye with a paragraph that no longer applies. Suppressing it
 * is not a cosmetic trim: the whole premise of P-009 is that the executable form
 * outcompetes prose only while it is the SHORTEST path in the message.
 */
function invokeFallbackSuffix(subs: SubstitutionWire[]): string {
  return hasInvokeEnvelope(subs) ? '' : `\n${TOOLS_INVOKE_FALLBACK_HINT}`;
}

/** Refusal for tier `deny` — mirrors the shell hook's message so both paths teach the same thing. */
export function substitutionDenyReason(subs: SubstitutionWire[]): string {
  return (
    'substitution-gate: this command has a tool form that must be used instead.\n\n' +
    `${formatSubstitutionLines(subs)}\n\n` +
    'Re-run using the tool above. (This rule reached `deny` only by proving ' +
    'equivalence against real sampled commands, or because the prohibition ' +
    'already existed independently.)\n' +
    invokeFallbackSuffix(subs)
  );
}

/** Soft advisory for tier `advise` — the command runs exactly as issued. */
export function substitutionAdvisoryText(subs: SubstitutionWire[]): string {
  return (
    'bash→tool advisory: a tool already answers this question directly.\n\n' +
    `${formatSubstitutionLines(subs)}\n\n` +
    'The tool call is cheaper (no shell round-trip, structured result) and is ' +
    'what the routing table points at. Advisory only; this command proceeded as issued.' +
    invokeFallbackSuffix(subs)
  );
}

/** Refusal for a resource under an exclusive hold — mirrors the shell hook verbatim. */
export function resourceBlockReason(matched: { resource?: string }[] | undefined): string {
  const names = (matched ?? []).map((m) => m.resource || '?').join(', ') || 'a registered resource';
  return (
    `resource-gate: this command touches ${names}, which has an exclusive hold ` +
    "in flight (a peer is restarting/migrating it). Wait for the 'back up' " +
    'broadcast, or coordinate via locks:list / locks:acquire_resource. ' +
    'Use the blessed wrapper (dev:restart / db:migrate) instead of a raw command.'
  );
}

/**
 * Pending soft advisory, drained by the tool_result reminder path.
 *
 * The shell hook rides `advise` out as `additionalContext` on an explicit
 * allow; OMP's tool_call return carries only `{ block, reason }`, and a `reason`
 * without `block` is discarded. So the equivalent non-blocking channel here is
 * the EXISTING tool_result `followUp` reminder — the same delivery the coord
 * inbox uses, deliberately NOT `steer` (steer aborts the in-flight tool and
 * livelocks a slow model, see the tool_result comment). This keeps `advise` a
 * new matched CLASS inside the existing mechanisms (plan D-003), not a fourth
 * one.
 */
let _pendingSubstitutionAdvisory: string | null = null;

export function stageSubstitutionAdvisory(text: string): void {
  _pendingSubstitutionAdvisory = text;
}

/** Take and clear the pending advisory (empty string when there is none). */
export function drainSubstitutionAdvisory(): string {
  const text = _pendingSubstitutionAdvisory;
  _pendingSubstitutionAdvisory = null;
  return text ?? '';
}

export interface ToolCallEvent {
  type: 'tool_call';
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
}

export interface ToolResultEvent {
  type: 'tool_result';
  toolCallId: string;
  toolName?: string;
  content?: unknown;
}

/** Positive edit evidence sent to locks:release after a native OMP writer returns. */
export interface NativeEditProof {
  success: true;
  source: 'omp';
  tool: string;
  paths: string[];
}

const OMP_NATIVE_EDIT_TOOLS = new Set(['write', 'edit', 'ast_edit', 'multi_edit']);

/** Classify only an explicit/recognizable successful native result. Lock intent or
 * an absent result is not mutation proof and must never reach attribution. */
export function nativeEditResultSucceeded(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const text = value.trim();
    return text.length > 0 && !/^(?:error|failed|failure|denied|permission denied)\b/i.test(text);
  }
  if (Array.isArray(value)) return value.length > 0 && value.every(nativeEditResultSucceeded);
  if (typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  if (result.is_error === true || result.isError === true) return false;
  if (result.ok === false || result.success === false) return false;
  if (typeof result.status === 'string' && ['error', 'failed', 'failure', 'denied'].includes(result.status.toLowerCase())) return false;
  if (result.error) return false;
  if (result.ok === true || result.success === true || result.is_error === false || result.isError === false) return true;
  if (typeof result.status === 'string' && ['ok', 'success', 'succeeded', 'completed', 'applied'].includes(result.status.toLowerCase())) return true;
  for (const key of ['content', 'result', 'output', 'message', 'path', 'filePath', 'file_path']) {
    if (result[key] !== undefined && result[key] !== null && result[key] !== '' && !(Array.isArray(result[key]) && result[key].length === 0)) return true;
  }
  return (result.type === 'text' || result.type === 'tool_result') && Boolean(result.text);
}

/** Build proof from the cached tool metadata and exact acquired paths. */
export function nativeEditProofForResult(
  toolName: string,
  result: unknown,
  paths: readonly string[],
): NativeEditProof | undefined {
  if (!OMP_NATIVE_EDIT_TOOLS.has(toolName) || paths.length === 0 || paths.some((path) => !path)) return undefined;
  if (!nativeEditResultSucceeded(result)) return undefined;
  return { success: true, source: 'omp', tool: toolName, paths: [...paths] };
}

/**
 * In-process toolCallId → lock_id cache. Same OMP process handles
 * both tool_call and tool_result, so an in-memory Map is sufficient
 * — no FS cache (the CC hooks needed one because each Pre/Post fired
 * as a separate subprocess). Cleared on tool_result.
 */
interface AcquiredLock {
  lockId: string;
  coordinationDomain?: string;
  toolName: string;
  paths: string[];
}

const acquiredLocks = new Map<string, AcquiredLock>();

type DeclarationRegenerator = (repoRoot: string, paths: readonly string[]) => Promise<void>;

const defaultDeclarationRegenerator: DeclarationRegenerator = async (repoRoot, paths) => {
  const helper = resolve(
    homedir(),
    '.papercusp/hooks/cc/regenerate-declaration-before-lock-release.mjs',
  );
  if (!existsSync(helper)) return;
  await new Promise<void>((resolveRun, rejectRun) => {
    execFile(
      process.execPath,
      [helper, '--repo-root', repoRoot, ...paths.flatMap((path) => ['--path', path])],
      { timeout: 120_000 },
      (error) => (error ? rejectRun(error) : resolveRun()),
    );
  });
};

let declarationRegenerator: DeclarationRegenerator = defaultDeclarationRegenerator;

/** Test seam for proving regeneration happens before release without spawning npm. */
export function setDeclarationRegeneratorForTests(
  next?: DeclarationRegenerator,
): DeclarationRegenerator {
  const previous = declarationRegenerator;
  declarationRegenerator = next ?? defaultDeclarationRegenerator;
  return previous;
}

// ── Fail-open health marker (file-locking #3) ────────────────────────

/**
 * Directory the hook writes its two health markers into. Operator
 * reads them via GET /api/su-locks/hook-health so the /coord UI can
 * surface "enforcement is offline" when the last error is newer than
 * the last success. Located OUTSIDE the repo so multiple checkouts
 * share one marker set per host user.
 *
 * Two files, per the plan contract:
 *   - last-error.json   — written ONLY on a hook error (fail-open)
 *   - last-success.json — written on every successful hook call
 */
function locksCacheDir(): string {
  const override = process.env.PAPERCUSP_LOCKS_CACHE_DIR;
  if (override) return override;
  const home = process.env.HOME ?? '/tmp';
  return resolve(home, '.papercusp/locks-cache');
}

/** Error record — shape per file-locking plan §3 step 1. */
export interface HookErrorRecord {
  /** ISO timestamp of the failure. */
  ts: string;
  /** Which hook handler hit the error. */
  handler: 'tool_call' | 'tool_result';
  /** Coarse phase of the failure. `request` = the operator ANSWERED and
   *  refused our arguments — a defect in the hook itself, never an
   *  outage. It is separated from `connect` because collapsing the two
   *  reported a deterministic schema bug as a transient transport miss. */
  phase: 'connect' | 'http' | 'parse' | 'request' | 'declaration-regeneration';
  /** One-line human-readable context. */
  detail: string;
  /** Operator URL the hook was trying to reach. */
  operator_url: string;
}

/** Success record — the "track this similarly" half of plan §3 step 2. */
export interface HookSuccessRecord {
  ts: string;
}

/**
 * Atomic-ish JSON write — temp file + rename. The hook never throws
 * on marker write failure (a filesystem error must not crash the
 * agent's tool call); errors are silently swallowed.
 */
async function writeMarker(path: string, value: unknown): Promise<void> {
  try {
    await fsp.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = path + '.tmp-' + process.pid;
    await fsp.writeFile(tmp, JSON.stringify(value, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fsp.rename(tmp, path);
  } catch {
    // Best-effort. A failed marker write must never break the hook.
  }
}

/** Record a successful hook call (operator reachable + answered). */
export async function recordHookSuccess(): Promise<void> {
  const rec: HookSuccessRecord = { ts: new Date().toISOString() };
  await writeMarker(resolve(locksCacheDir(), 'last-success.json'), rec);
}

/**
 * A REQUEST DEFECT — the operator answered and refused our arguments.
 *
 * Kept in its OWN marker file, deliberately, because `healthy` in
 * `/api/su-locks/hook-health` is a machine-wide last-error-vs-last-success
 * comparison over a marker set shared by every client on the box. A
 * persistent per-client defect is therefore masked the instant ANY other
 * agent's hook call succeeds — which, on a busy fleet, is immediate. That
 * masking is the reason 220 consecutive `locks:acquire` rejections
 * produced no signal anywhere. A success by an unrelated client cannot
 * clear this file; only the defect ceasing to recur can, via its own
 * recency.
 */
export interface HookRequestDefectRecord {
  ts: string;
  handler: HookErrorRecord['handler'];
  /** One-line context — the tool + the operator's refusal. */
  detail: string;
  /** Consecutive occurrences observed by THIS hook process. A defect of
   *  this class repeats on every tool call, so a high count is the
   *  signal that enforcement has been off for a long time. */
  count: number;
  operator_url: string;
}

/** Consecutive request-defect count for this hook process. */
let _requestDefectCount = 0;
export function _resetRequestDefectCountForTests(): void {
  _requestDefectCount = 0;
}

/**
 * Record a deterministic request defect (our arguments were refused).
 * Writes the dedicated marker AND the shared `last-error.json` with
 * `phase: 'request'`, so an operator watching either surface sees a hook
 * BUG rather than "operator unreachable".
 */
export async function recordRequestDefect(input: {
  handler: HookErrorRecord['handler'];
  detail: string;
}): Promise<void> {
  _requestDefectCount += 1;
  const rec: HookRequestDefectRecord = {
    ts: new Date().toISOString(),
    handler: input.handler,
    detail: input.detail,
    count: _requestDefectCount,
    operator_url:
      process.env.PAPERCUSP_BUNDLE_URL ??
      process.env.PAPERCUSP_OPERATOR_URL ??
      '(unset)',
  };
  await writeMarker(resolve(locksCacheDir(), 'last-request-defect.json'), rec);
  await recordHookError({
    handler: input.handler,
    phase: 'request',
    detail: input.detail,
  });
}

/**
 * Narrow a {@link callMcpTool} result to the structured error shape it
 * returns under `preserveErrors` — the operator answered and REFUSED.
 * Returns null for every normal result (including a `busy` refusal, which
 * is a successful call reporting contention, not a request defect).
 */
export function asStructuredCallError(
  result: unknown,
): { error: string; message: string } | null {
  if (result === null || typeof result !== 'object') return null;
  const r = result as { ok?: unknown; error?: unknown; message?: unknown };
  if (r.ok !== false) return null;
  if (r.error !== 'mcp_tool_error' && r.error !== 'mcp_rpc_error') return null;
  return {
    error: r.error,
    message: typeof r.message === 'string' ? r.message : '(no message)',
  };
}

/** Record a hook error (fail-open path). */
export async function recordHookError(
  input: { handler: HookErrorRecord['handler']; phase: HookErrorRecord['phase']; detail: string },
): Promise<void> {
  const rec: HookErrorRecord = {
    ts: new Date().toISOString(),
    handler: input.handler,
    phase: input.phase,
    detail: input.detail,
    operator_url:
      process.env.PAPERCUSP_BUNDLE_URL ??
      process.env.PAPERCUSP_OPERATOR_URL ??
      '(unset)',
  };
  await writeMarker(resolve(locksCacheDir(), 'last-error.json'), rec);
}

/** The workspace whose direct-child worktrees this hook coordinates.
 *  Mirrors the cc hook's WORKSPACE_ROOT — override with
 *  PAPERCUSP_WORKSPACE_ROOT; default ~/papercupai-workspace. Realpath'd
 *  so the dirname comparison in extractLockTargets is symlink-stable. */
function workspaceRoot(): string {
  const raw =
    process.env.PAPERCUSP_WORKSPACE_ROOT ??
    resolve(process.env.HOME ?? '/tmp', 'papercupai-workspace');
  try {
    return realpathSync(raw);
  } catch {
    return raw;
  }
}

/** The workspace registry root that owns suite-app checkouts. */
function workspacesRoot(): string {
  const raw =
    process.env.PAPERCUSP_WORKSPACES_ROOT ??
    resolve(process.env.HOME ?? '/tmp', '.papercusp-workspaces');
  try {
    return realpathSync(raw);
  } catch {
    return raw;
  }
}

/**
 * Workspace-owned suite apps are separate repositories at
 * `<workspaces>/<workspace>/.papercusp/apps/<app>`. They are managed edit
 * trees even though they do not sit below `PAPERCUSP_WORKSPACE_ROOT`, so their
 * automatic lock must use the physical repository domain just like an
 * explicit `locks:acquire { coordination_domain, paths }` call.
 */
function isManagedSuiteAppRepo(repoRoot: string): boolean {
  let realRoot: string;
  try {
    realRoot = realpathSync(repoRoot);
  } catch {
    realRoot = repoRoot;
  }
  const rel = relative(workspacesRoot(), realRoot);
  const parts = rel.split('/');
  return (
    parts.length === 4 &&
    !['', '.', '..'].includes(parts[0]) &&
    parts[1] === '.papercusp' &&
    parts[2] === 'apps' &&
    !['', '.', '..'].includes(parts[3]) &&
    validGitEntry(repoRoot)
  );
}

/** A `.git` entry marks a repository root only when it is valid: a file
 * (submodule/link-worktree gitlink) or a directory containing HEAD (an
 * ordinary clone). Mirrors the cc hook's `_valid_git_entry` predicate so a
 * stray empty `.git` directory cannot silently change lock scope. */
function validGitEntry(repoRoot: string): boolean {
  try {
    const entry = join(repoRoot, '.git');
    const stats = statSync(entry);
    return stats.isFile() || (stats.isDirectory() && existsSync(join(entry, 'HEAD')));
  } catch {
    return false;
  }
}

function pathIsWithin(path: string, parent: string): boolean {
  return path === parent || path.startsWith(`${parent}/`);
}

/** Find the direct-child workspace repository containing a nested repo root.
 * The nearest root may be a submodule; worktree policy belongs to the
 * enclosing direct-child checkout. */
function workspaceRepoRoot(repoRoot: string, ws: string): string | null {
  let candidate: string;
  try {
    candidate = realpathSync(repoRoot);
  } catch {
    candidate = repoRoot;
  }
  if (candidate === ws || !pathIsWithin(candidate, ws)) return null;
  while (dirname(candidate) !== ws) {
    const parent = dirname(candidate);
    if (parent === candidate || !pathIsWithin(parent, ws)) return null;
    candidate = parent;
  }
  return validGitEntry(candidate) ? candidate : null;
}

/** The one tree whose edits git-sync commits and deploys. Keep this helper
 * shared by target extraction and the worktree guard so nested repositories
 * use the same canonical-tree comparison in both paths. */
function canonicalTreeRoot(ws: string): string {
  const raw = process.env.PAPERCUSP_CANONICAL_TREE ?? join(ws, 'papercusp');
  try {
    return realpathSync(raw);
  } catch {
    return raw;
  }
}

function isIsolationWorktree(repoRoot: string, canonicalTree: string): boolean {
  let realRoot: string;
  try {
    realRoot = realpathSync(repoRoot);
  } catch {
    realRoot = repoRoot;
  }
  return pathIsWithin(realRoot, join(canonicalTree, '.papercusp', 'worktrees'));
}

/** Resolve the main checkout for a linked worktree. Returns null for an
 * ordinary repo, a submodule gitlink, or an unreadable/malformed entry. */
function resolveWorktreeMainRoot(repoRoot: string): string | null {
  try {
    const gitEntry = join(repoRoot, '.git');
    if (!statSync(gitEntry).isFile()) return null;
    const match = /^gitdir:\s*(.+)$/.exec(readFileSync(gitEntry, 'utf8').trim());
    if (!match) return null;
    let gitDir = match[1].trim();
    if (!gitDir.startsWith('/')) gitDir = join(repoRoot, gitDir);
    gitDir = realpathSync(gitDir);
    const commonDir = join(gitDir, 'commondir');
    if (!existsSync(commonDir)) return null;
    let common = readFileSync(commonDir, 'utf8').trim();
    if (!common.startsWith('/')) common = join(gitDir, common);
    return dirname(realpathSync(common));
  } catch {
    return null;
  }
}

/** Walk up from a path (or its nearest existing parent) to the dir
 *  holding a `.git` entry — file (worktree) or dir. Mirrors the cc
 *  hook's find_repo_root so OMP and cc key locks identically across the
 *  many worktrees in this workspace; a single hardcoded root mis-keys in
 *  every checkout but one. Returns the repo root, or null if none. */
function findRepoRoot(absPath: string): string | null {
  let d = absPath;
  let isDir = false;
  try {
    isDir = statSync(d).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) d = dirname(d);
  while (d && d !== dirname(d)) {
    if (validGitEntry(d)) return d;
    d = dirname(d);
  }
  return null;
}

/** A file the hook will claim: its worktree `root` plus the lock key
 *  `rel` (path relative to that root). */
export interface LockTarget {
  root: string;
  rel: string;
}

/**
 * Pull the files a tool will edit and resolve each to its worktree root
 * + repo-relative lock key. Anything outside a coordinated worktree, any
 * wildcard/glob, or any backslash path is silently dropped (the lock
 * store is workspace-scoped; non-repo paths are not coordinated, globs
 * would over-claim).
 *
 * Worktree resolution MIRRORS the cc hook
 * (`pretooluse-locks-acquire.sh` `find_repo_root` + workspace gate):
 * walk up from each path to the dir holding `.git`, and keep it when that root
 * belongs to either a direct child of `workspaceRoot()` or a managed suite app
 * under `<workspaces>/<workspace>/.papercusp/apps/<app>`. The key is RELATIVE
 * TO that worktree root, so the same logical file collides
 * across sibling worktrees AND with a cc edit (which keys the same
 * way) — that's the cross-client / cross-worktree contention this buys.
 * The old single fixed `papercupRoot()` silently dropped every
 * sibling-worktree edit (it only matched the canonical checkout).
 *
 * Tool-name coverage matches OMP's file-edit surface:
 *   - write       → input.path
 *   - edit        → input.path | file_path | filePath  (extension)
 *   - ast_edit    → input.paths[]  (skip entries containing * ? [ )
 *   - multi_edit  → input.paths[]  (legacy / future)
 *
 * Path normalization mirrors the server's rules in
 * `apps/operator/lib/agent-tools/locks/path-normalize.ts` — that file
 * is the source of truth. The hook MUST duplicate them rather than
 * import the module because it ships as a single self-contained file
 * copied into `~/.papercusp/`. `node:path.resolve()` already collapses
 * `.`, `..`, `//` and trailing `/`; the explicit backslash skip below
 * covers the one rule resolve() does NOT enforce on POSIX (a `\` is a
 * literal filename char there, but the server rejects it).
 * `coord-hook.test.ts` asserts this stays consistent with
 * `normalizePaths()`.
 */
export function extractLockTargets(
  toolName: string,
  input: Record<string, unknown>,
): LockTarget[] {
  const raw: string[] = [];
  if (toolName === 'write' || toolName === 'edit') {
    for (const k of ['path', 'file_path', 'filePath'] as const) {
      const v = input[k];
      if (typeof v === 'string' && v.length > 0) raw.push(v);
    }
  } else if (toolName === 'ast_edit' || toolName === 'multi_edit') {
    const ps = input.paths;
    if (Array.isArray(ps)) {
      for (const p of ps) {
        if (typeof p === 'string' && p.length > 0 && !/[*?[\]]/.test(p)) {
          raw.push(p);
        }
      }
    }
  }
  const ws = workspaceRoot();
  const canonicalTree = canonicalTreeRoot(ws);
  const out: LockTarget[] = [];
  for (const p of raw) {
    // Backslash: the server's validatePath rejects it outright. Skip
    // here so the hook never asks the operator to claim a path the
    // operator would refuse (consistency with path-normalize.ts).
    if (p.includes('\\')) continue;
    const abs = resolve(p);
    const root = findRepoRoot(abs);
    if (root === null) continue; // outside any git repo — not coordinated
    if (abs === root) continue; // never claim the repo root itself
    // A nested submodule has its own valid `.git` entry, but worktree policy
    // belongs to the enclosing direct-child checkout. Retain nested roots
    // only when that enclosing checkout is the canonical tree; a nested repo
    // inside an independent sibling remains outside automatic coordination.
    const scopeRoot = workspaceRepoRoot(root, ws) ??
      (isManagedSuiteAppRepo(root) ? root : null);
    if (scopeRoot === null) continue;
    let realRoot: string;
    try {
      realRoot = realpathSync(root);
    } catch {
      realRoot = root;
    }
    let scopeReal: string;
    try {
      scopeReal = realpathSync(scopeRoot);
    } catch {
      scopeReal = scopeRoot;
    }
    if (isIsolationWorktree(root, canonicalTree)) continue;
    if (scopeReal !== realRoot && scopeReal !== canonicalTree) continue;
    const rel = relative(root, abs);
    if (rel === '' || rel.startsWith('..')) continue;
    out.push({ root, rel });
  }
  return out;
}

/**
 * Dedupe {@link LockTarget}s down to the repo-relative lock keys sent to
 * `locks:acquire`, preserving first-seen order. Lock keys are
 * worktree-relative, so the same file claimed through two worktrees
 * collapses to one key.
 *
 * ⚠ THIS FUNCTION IS THE SINGLE SOURCE OF THE ACQUIRE PAYLOAD — both
 * {@link extractPathsFromToolInput} (what tests assert on) and
 * `onToolCall` (what actually claims the lock) MUST route through it.
 * They used to compute the keys separately, and that divergence is
 * precisely how a total loss of OMP lock enforcement shipped unnoticed:
 * `onToolCall` inlined the dedupe as
 *
 *     targets.map(t => t.rel).filter(x => !(seen.has(x) || seen.add(x)))
 *
 * `Set.add()` returns the SET, not a boolean — so `false || Set` is
 * truthy and the negation is `false` for EVERY element. `paths` was
 * unconditionally `[]`, and every OMP `locks:acquire` was rejected
 * `invalid_args` (measured: 220/220 byte-identical failures in one
 * session, 2026-08-11). The existing guard test passed throughout,
 * because it asserted on `extractPathsFromToolInput` — the projection
 * `onToolCall` did NOT use. Keeping one implementation is the fix; the
 * one-line correction alone would leave the divergence in place.
 */
export function lockKeysFromTargets(targets: LockTarget[]): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const target of targets) {
    if (seen.has(target.rel)) continue;
    seen.add(target.rel);
    keys.push(target.rel);
  }
  return keys;
}

/**
 * Repo-relative lock keys for a tool's edits — the deduped `rel` of each
 * {@link LockTarget}. This is the EXACT payload `onToolCall` sends to
 * `locks:acquire` (both call {@link lockKeysFromTargets}); the worktree
 * roots needed for symlink detection come from {@link extractLockTargets}.
 */
export function extractPathsFromToolInput(
  toolName: string,
  input: Record<string, unknown>,
): string[] {
  return lockKeysFromTargets(extractLockTargets(toolName, input));
}

/**
 * Symlink refusal (file-locking-improvements #1). The lock store keys
 * on the path STRING — `apps/foo.ts` and a symlink `apps/link.ts`
 * pointing at it are two different keys, so two agents editing "the
 * same file" through different names would BOTH acquire. The operator
 * can't catch this (it doesn't share the agent's filesystem); the hook
 * runs ON that filesystem, so it can.
 *
 * The hook REFUSES rather than silently rewriting the claim to the
 * canonical path: rewriting would hide the aliasing from the agent,
 * and the plan (#1) deliberately scoped resolution out — the caller
 * owns resolving symlinks before it claims.
 *
 * Detection: canonicalize both the repo root and each candidate with
 * realpathSync, then compare repo-relative forms. Equal ⇒ no symlink.
 * Differ ⇒ a symlink sits somewhere in the path (or it escapes the
 * repo entirely). A not-yet-existent leaf (a `write` creating a new
 * file) is not itself a symlink — realpath its PARENT dir instead, so
 * a symlinked directory component is still caught. Anything realpath
 * can't resolve at all (broken link, EACCES, missing parent, or a root
 * that isn't a real dir — e.g. unit tests with PAPERCUSP_REPO_ROOT set
 * to a fake path) is left to the server: fail-open, consistent with
 * every other hook failure path.
 */
export function detectSymlinkedPaths(
  relPaths: string[],
  root: string,
): Array<{ given: string; real: string }> {
  let canonRoot: string;
  try {
    canonRoot = realpathSync(root);
  } catch {
    return []; // root not a real directory — fail open
  }
  const hits: Array<{ given: string; real: string }> = [];
  for (const rel of relPaths) {
    const abs = join(root, rel);
    let canon: string | null = null;
    try {
      canon = realpathSync(abs);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        // Leaf missing (new file via `write`). A symlink can still
        // hide in a directory component — resolve the parent.
        try {
          canon = join(realpathSync(dirname(abs)), basename(abs));
        } catch {
          canon = null; // parent unresolvable — leave it to the server
        }
      }
      // EACCES / ELOOP / etc. — canon stays null, fail open.
    }
    if (canon === null) continue;
    const canonRel =
      canon === canonRoot
        ? ''
        : canon.startsWith(canonRoot + '/')
          ? canon.slice(canonRoot.length + 1)
          : null;
    // canonRel === null ⇒ the real path escaped the repo (a symlink
    // pointing outside): also a refusal — the claim string would look
    // in-repo while the edit lands elsewhere.
    if (canonRel !== rel) {
      hits.push({ given: rel, real: canonRel ?? canon });
    }
  }
  return hits;
}

/** Format the refusal when a tool targets a symlinked path (#1). */
export function formatSymlinkRefusal(
  hits: Array<{ given: string; real: string }>,
): string {
  const lines = [
    'locks: refused — symlinked path(s). Edit the real file directly:',
  ];
  for (const h of hits.slice(0, 5)) {
    lines.push(`  - ${h.given} → ${h.real || '(repo root)'}`);
  }
  if (hits.length > 5) lines.push(`  ... and ${hits.length - 5} more`);
  lines.push('');
  lines.push(
    'The lock store keys on the path string, so a symlink and its target',
  );
  lines.push(
    'are two separate claims — editing through the symlink would let',
  );
  lines.push('another agent hold the same underlying file at the same time.');
  return lines.join('\n');
}

/** Busy-array entry as returned by locks:acquire. */
interface BusyEntry {
  path: string;
  owner?: string;
  owner_label?: string | null;
  intent?: string;
  expires_ts?: string;
}

/** Format the human/agent-readable refusal when paths are contested. */
export function formatBusyRefusal(busy: BusyEntry[]): string {
  const lines: string[] = [
    'locks: refused — file(s) held by another SU agent:',
  ];
  for (const b of busy.slice(0, 5)) {
    const who = b.owner_label || b.owner || 'unknown';
    const intent = b.intent ? JSON.stringify(b.intent) : "'unknown'";
    lines.push(
      `  - ${b.path}: held by ${who} for ${intent} (expires ${b.expires_ts ?? '?'})`,
    );
  }
  if (busy.length > 5) lines.push(`  ... and ${busy.length - 5} more`);
  lines.push('');
  lines.push('Options: (1) wait and retry, (2) work on something else,');
  lines.push('(3) call locks:acquire with wait={max_sec:300} to queue.');
  const paths = busy.slice(0, 5).map((b) => b.path);
  lines.push(
    `If locks:acquire is not on this client surface, use tools:invoke {name:"locks:acquire", args:{paths:${JSON.stringify(paths)}, intent:"<your intent>", wake_on_grant:true}} and end this turn.`,
  );
  return lines.join('\n');
}

// ── Activity bridge: the OMP in-process port (papercusp-worker-integration-2026-06-04,
//    D-002/D-003) ─────────────────────────────────────────────────────
//
// The cross-CLI counterpart of the shared `posttooluse-activity-report.sh` shell
// hook (Claude+Codex). OMP has no PostToolUse shell contract, so its activity report
// rides this in-process hook and calls the SAME `activity:report` MCP tool. The
// tool_call input is staged in memory, then the matching tool_result emits ONE
// phase='post' heartbeat whose response also carries coordination deltas. The display
// summary is derived SERVER-SIDE (one shared formatter), so this forwards RAW fields.

/** Cap a worker's native tool input so a giant Write `content` / patch body never
 *  bloats the report (mirrors the shell hook's cap). */
const ACTIVITY_STR_CAP = 500;
function capActivityInput(input: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input ?? {})) {
    if (typeof v === 'string') out[k] = v.length > ACTIVITY_STR_CAP ? v.slice(0, ACTIVITY_STR_CAP) + '…' : v;
    else if (Array.isArray(v)) out[k] = `[${v.length} items]`;
    else if (v && typeof v === 'object') out[k] = '[object]';
    else out[k] = v;
  }
  return out;
}

const ACTIVITY_TODO_TOOLS = new Set(['todo', 'todo_write', 'todowrite', 'taskcreate', 'taskupdate']);
const ACTIVITY_REPORT_DEDUPE_MS = 10_000;
const activityReportDedupe = new Map<string, number>();
const pendingActivityCalls = new Map<string, ToolCallEvent>();
const ACTIVITY_HOOK_BUNDLE_SCHEMA = 'activity-hook-bundle-v1';
let _hookBundleGeneration: string | null = null;

function currentHarnessSlug(): string | null {
  const slug = process.env.PAPERCUSP_HARNESS_SLUG?.trim();
  return slug || null;
}

/** Fine-grained role stamped by role-scoped or generic child launchers. */
function currentLaunchRole(): string | null {
  for (const value of [process.env.PAPERCUSP_ROLE, process.env.PAPERCUSP_AGENT_ROLE]) {
    const role = value?.trim();
    if (role) return role;
  }
  return null;
}

export interface ActivityHookBundle {
  schemaVersion?: string;
  generation?: string;
  changed?: boolean;
  complete?: boolean;
  surfaces?: {
    inbox?: Record<string, unknown>;
    glance?: Record<string, unknown>;
  };
}

/**
 * Build the `activity:report` args from an OMP tool_call event. A todo tool forwards
 * its list (uncapped, sliced) so the server summarises it as kind=todos; every other
 * tool forwards a string-capped input. Pure — exported for tests.
 */
export function buildActivityArgs(event: ToolCallEvent): Record<string, unknown> {
  const lower = event.toolName.toLowerCase();
  const args: Record<string, unknown> = {
    owner: hookOwnerId(),
    agent: 'omp',
    phase: 'post',
    tool_name: event.toolName,
    tool_use_id: event.toolCallId,
  };
  const harnessSlug = currentHarnessSlug();
  if (harnessSlug) args.harness_slug = harnessSlug;
  const role = currentLaunchRole();
  if (role) args.role = role;
  const todos = (event.input as Record<string, unknown> | undefined)?.todos;
  if (ACTIVITY_TODO_TOOLS.has(lower) && Array.isArray(todos)) {
    args.todos = todos.slice(0, 100);
  } else {
    args.tool_input = capActivityInput(event.input);
  }
  return args;
}

function activityReportKey(args: Record<string, unknown>): string | null {
  if (typeof args.tool_use_id !== 'string' || args.tool_use_id.length === 0) return null;
  return JSON.stringify([
    args.owner ?? '',
    args.agent ?? '',
    args.phase ?? '',
    args.tool_name ?? '',
    args.tool_use_id,
    args.tool_input ?? null,
    args.todos ?? null,
  ]);
}

function shouldSendActivityReport(args: Record<string, unknown>, now = Date.now()): boolean {
  const key = activityReportKey(args);
  if (!key) return true;
  for (const [k, ts] of activityReportDedupe) {
    if (now - ts > ACTIVITY_REPORT_DEDUPE_MS) activityReportDedupe.delete(k);
  }
  const prev = activityReportDedupe.get(key);
  if (prev !== undefined && now - prev <= ACTIVITY_REPORT_DEDUPE_MS) return false;
  activityReportDedupe.set(key, now);
  return true;
}

export function _resetActivityReportDedupeForTests(): void {
  activityReportDedupe.clear();
  pendingActivityCalls.clear();
  _hookBundleGeneration = null;
}

/** Stage the input-bearing half of an OMP tool event. The matching tool_result
 * consumes it so telemetry and coordination deltas share ONE post-tool RPC. */
export function stageActivityReport(event: ToolCallEvent): void {
  pendingActivityCalls.set(event.toolCallId, event);
}

/**
 * Fire-and-forget activity report. Never blocks or throws — callMcpTool swallows all
 * errors + returns null, so a `void reportActivity(event)` is safe (no unhandled
 * rejection) and adds no latency to the tool call.
 */
export async function reportActivity(event: ToolCallEvent): Promise<void> {
  const args = buildActivityArgs(event);
  if (!shouldSendActivityReport(args)) return;
  await callMcpTool('activity:report', args);
}

/** Report a completed tool and request the generation-aware coordination fold. */
export async function reportActivityResult(event: ToolResultEvent): Promise<ActivityHookBundle | null> {
  const staged = pendingActivityCalls.get(event.toolCallId);
  pendingActivityCalls.delete(event.toolCallId);
  if (!staged) return null;
  const args = buildActivityArgs(staged);
  const result = (await callMcpTool('activity:report', {
    ...args,
    hook_bundle: {
      generation: _hookBundleGeneration,
      ...(_midTurnCursor ? { since_ts: _midTurnCursor } : {}),
      ...(_hookBundleGeneration === null ? { force_resync: true } : {}),
    },
  })) as { hook_bundle?: ActivityHookBundle } | null;
  return result?.hook_bundle ?? null;
}

/**
 * Report a session LIFECYCLE transition (kind='lifecycle') into the activity bridge —
 * the OMP counterpart of the Claude/Codex SessionStart/Stop lifecycle hook. Gives the
 * fleet view a crisp "worker appeared / left" marker rather than inferring it from
 * activity silence. Fire-and-forget; callMcpTool fails open when detached.
 */
export async function reportLifecycle(phase: 'start' | 'shutdown'): Promise<void> {
  const harnessSlug = currentHarnessSlug();
  const role = currentLaunchRole();
  await callMcpTool('activity:report', {
    owner: hookOwnerId(),
    agent: 'omp',
    kind: 'lifecycle',
    summary: phase === 'start' ? '▶ session started' : '■ session ended',
    ...(harnessSlug ? { harness_slug: harnessSlug } : {}),
    ...(role ? { role } : {}),
  });
}

/**
 * Ping the per-turn JOURNAL collector at turn end (deterministic-context-carry
 * -2026-07-14 P-012) — the OMP counterpart of the cc/ Stop hook
 * (stop-turn-journal.sh). No extraction here: the server reads the session
 * transcript and extracts the agent's trailing ⟦journal⟧ line (mechanical
 * first-line fallback, flagged). Fire-and-forget; callMcpTool fails open, so
 * `void reportTurnJournal(ctx)` adds no latency to the turn boundary.
 */
export async function reportTurnJournal(ctx: unknown): Promise<void> {
  const c = ctx as HookSessionLinkContext | undefined;
  const sessionId = c?.sessionManager?.getSessionId?.()?.trim();
  if (!sessionId) return;
  const filePath = c?.sessionManager?.getSessionFile?.();
  await callMcpTool('journal:record-turn', {
    owner: hookOwnerId(),
    agent: 'omp',
    session_id: sessionId,
    source_kind: 'omp',
    ...(filePath ? { transcript_path: filePath } : {}),
  });
}

// ── Unstructured owner-ask detection + ingest (owner-inbox-single-pane-2026-07-17 P-004) ──
//
// OMP has no hook-level signal equivalent to Claude's AskUserQuestion tool_use (P-001's
// PreToolUse mirror) — there is nothing to intercept, only the turn's final TEXT. So the OMP
// leg works off a bounded, best-effort tail-read of the turn's own transcript file, self
// -contained (this file ships standalone to OMP — no operator import): a minimal mirror of
// the server's readLastAssistantTurn/parseOmpLine (packages/operator-core/lib/{turn-journal,
// search/session-ingest}.ts). Any read/parse failure degrades to "no text" — never throws.

/** Bounded tail-read size — an OMP JSONL line can carry a large tool payload, but the final
 *  TEXT turn sits at the very end of the file; 64 KB is generous headroom for a text-only scan. */
const OMP_ASK_TAIL_READ_BYTES = 64 * 1024;

/** Same shape as the server's textFromContent (session-ingest.ts) — OMP message content is
 *  either a plain string or an array of `{type:'text'|'input_text'|'output_text', text}`
 *  blocks. Pure, unit-tested. */
export function extractOmpMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const p of content) {
    if (!p || typeof p !== 'object') continue;
    const part = p as { type?: string; text?: string };
    if (typeof part.text !== 'string') continue;
    if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
      parts.push(part.text);
    }
  }
  return parts.join('\n');
}

/** Read the last ASSISTANT text turn from an OMP transcript (`{type:'message',
 *  message:{role,content}}` lines — verified against packages/operator-core/lib/search/
 *  session-ingest.ts's parseOmpLine). Bounded tail read; best-effort — any failure (missing
 *  file, mid-file JSON fragment, unknown shape) returns '' rather than throwing, since this
 *  runs inside a fire-and-forget turn_end hook. */
export async function readLastOmpAssistantText(filePath: string): Promise<string> {
  try {
    const st = await fsp.stat(filePath);
    const start = Math.max(0, st.size - OMP_ASK_TAIL_READ_BYTES);
    const fh = await fsp.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(st.size - start);
      await fh.read(buf, 0, buf.length, start);
      let lines = buf.toString('utf8').split('\n');
      if (start > 0) lines = lines.slice(1); // a mid-file start lands mid-line — unparseable
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i].trim();
        if (!line) continue;
        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (obj.type !== 'message') continue;
        const message = obj.message as { role?: string; content?: unknown } | undefined;
        if (!message || message.role !== 'assistant') continue;
        const text = extractOmpMessageText(message.content);
        if (text) return text;
      }
      return '';
    } finally {
      await fh.close();
    }
  } catch {
    return '';
  }
}

/** Heuristic: does the last assistant turn's plain text look like it ends by asking the OWNER
 *  a question with NO structured envelope (an `<ask>` block, or an explicit coord:escalate /
 *  coord:ask-owner mention)? Deliberately conservative in both directions: a false negative
 *  (a missed ask) just means no nudge fires this turn; a false positive would nudge on ordinary
 *  rhetorical prose, so this only trips on a short, standalone LAST non-empty line ending in
 *  '?' — a genuine turn-ending question, not a stray '?' inside a code block or a long
 *  multi-clause sentence. Pure, unit-tested. */
export function looksLikeUnstructuredOwnerAsk(text: string): boolean {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return false;
  if (/<ask\b/i.test(trimmed) || /<report\b/i.test(trimmed)) return false; // already structured
  if (/coord:escalate|coord:ask-owner/i.test(trimmed)) return false; // already routed durably
  const lines = trimmed
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1] ?? '';
  if (!last.endsWith('?')) return false;
  return last.length <= 300 && !last.startsWith('```') && !last.startsWith('//');
}

/** sessionId → the open ask-gate's refId this hook itself opened, so the matching `cleared`
 *  event carries the SAME refId (the contract's pairing key) and we never re-open a gate every
 *  single turn the model keeps asking the same way. Process-lifetime only — a restarted OMP
 *  process re-detects and re-opens, which is fine (the server dedupes on refId, not on us). */
const _openAskGates = new Map<string, string>();

/** Test-only: reset the open-ask-gate tracking between cases. */
export function _resetOpenAskGatesForTests(): void {
  _openAskGates.clear();
}

/**
 * Ingest the turn's final text into P-002's ask/owner-gate surface (OMP leg of
 * `owner-inbox-single-pane-2026-07-17` P-004; D-002's "soft enforce" tier for OMP — see
 * /internal/docs/agent-insights/su-owner-ask-capability-matrix). Locked contract from the P-002
 * holder (WI-5234, coord msg mroqabes…): `sessions:ingest-gate-event` — role-gated built-in,
 * `{ sessionId, client, kind:'ask'|'permission_wait'|'cleared', refId, question?, text?,
 * ownerId? }` → `{ ok, gateId, state }`. We generate refId; the SAME refId closes the gate.
 *
 * Soft enforcement only (D-002): unlike Claude's Stop hook, OMP has no blocking primitive at a
 * turn boundary, so the strongest available cue is a `followUp` nudge delivered on the NEXT
 * turn — never a bounce of the one that just ended. Fire-and-forget from the caller;
 * callMcpTool fails open (detached, or the tool not yet live on :3170 → null → no-op), so this
 * is safe to have landed ahead of the endpoint going live.
 */
export async function reportTurnAskIngest(ctx: unknown): Promise<{ nudge: string }> {
  const c = ctx as HookSessionLinkContext | undefined;
  const sessionId = c?.sessionManager?.getSessionId?.()?.trim();
  if (!sessionId) return { nudge: '' };
  const filePath = c?.sessionManager?.getSessionFile?.();
  if (!filePath) return { nudge: '' };
  const text = await readLastOmpAssistantText(filePath);
  const isAsk = looksLikeUnstructuredOwnerAsk(text);
  const openRefId = _openAskGates.get(sessionId);

  if (!isAsk) {
    // A previously-open gate for this session is now resolved (the model moved on, or
    // re-asked structurally) — close it so the gate list doesn't accumulate stale rows.
    if (openRefId) {
      _openAskGates.delete(sessionId);
      void callMcpTool('sessions:ingest-gate-event', {
        sessionId,
        client: 'omp',
        kind: 'cleared',
        refId: openRefId,
      });
    }
    return { nudge: '' };
  }

  const refId = openRefId ?? randomUUID();
  if (!openRefId) _openAskGates.set(sessionId, refId);
  const lastLine = trimmedLastLine(text);
  await callMcpTool('sessions:ingest-gate-event', {
    sessionId,
    client: 'omp',
    kind: 'ask',
    refId,
    question: lastLine,
    text,
    ownerId: hookOwnerId(),
  });
  return {
    nudge:
      'Your last turn ended in what looks like a question for the owner, but it was not ' +
      'wrapped in a durable channel, so the owner Inbox cannot see it. Re-ask via ' +
      "coord:escalate with structured options (preferred), or an <ask> block at minimum.",
  };
}

/** The last non-empty trimmed line of `text`, capped for a `question` field. Pure helper. */
function trimmedLastLine(text: string): string {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1] ?? '';
  return last.length > 500 ? `${last.slice(0, 499)}…` : last;
}

// ── Objective title (session-objective-display-2026-06-22, P-004) ────────
//
// The OMP leg of the SESSION-OBJECTIVE DISPLAY. OMP has no statusline, but it
// owns a tty, so each turn we set the terminal TITLE to this session's
// coord:glance self.objective — the same objective the Claude statusline renders
// as its leading 🔭 segment and the Codex hooks.json hook puts in the codex
// terminal title. Mirrors the Codex hook: an OSC-0 escape written to /dev/tty
// (the CLIENT owns the tty; the hook only nudges its title), fail-open.

// ── Legacy fallback title — ONE shape across all three pipes (WI-1383525 GAP 3) ──
//
// When the operator ships no `display` block (a pre-display operator, or the
// server render failed), each hook falls back to LOCAL assembly. The two
// Claude/Codex scripts (statusline-fleet.sh, posttooluse-objective-title.sh)
// keep their `term_title` BYTE-IDENTICAL to each other; this is the TypeScript
// port of that same function, so OMP's fallback agrees with them too. Before
// this port the OMP leg rendered `id · 🔭 objective` (clip 60, no fleet/loop
// chips) while the other two rendered `fleets · ⟳loop · id · objective`
// (clip 40, no 🔭) — a three-way divergence exactly in the failure mode where
// nobody is looking. objective-title-parity.test.ts drives all three pipes on
// the same display-less glance and asserts byte-identity, so a drift in any
// one copy fails there.
//
// Deliberately a LOCAL port, not an import from status-display.ts: this hook
// runs inside the OMP client process with no operator-core dependency, and the
// fallback's contract is parity with the PYTHON copies, not with the server
// render (which carries more chips). Model tag intentionally absent (WI-2124).

const LEGACY_OBJECTIVE_MAX = 40; // python: `o[:40] + ('…' if len(o) > 40 else '')`

/** Strip every control char that could break out of an OSC string. */
function stripTitleControl(s: string): string {
  return [...s].filter((c) => c.codePointAt(0)! >= 32 && c !== '\x07' && c !== '\x1b').join('');
}

/** `ESC ] 0 ; <title> BEL`, or '' for an empty title (skip the write). */
function wrapTitleOsc(title: string): string {
  const clean = stripTitleControl(title);
  return clean.length === 0 ? '' : `\x1b]0;${clean}\x07`;
}

/** Port of the scripts' `self_short`: `su-9859ea5e-…` → `su-9859e`; '' for unset / 'fixture'. */
export function legacySelfShort(owner: string | null | undefined): string {
  const o = typeof owner === 'string' ? owner.trim() : '';
  if (!o || o === 'fixture') return '';
  const bits = o.split('-');
  if (bits.length >= 2 && bits[1]) return `${bits[0]}-${[...bits[1]].slice(0, 5).join('')}`;
  return [...o].slice(0, 8).join('');
}

/** Port of the scripts' `fmt_interval`: 120→'2m', 30→'30s', 3600→'1h', 5400→'1h30m', junk→'?'. */
export function legacyFmtInterval(sec: unknown): string {
  const n =
    typeof sec === 'number' ? sec : typeof sec === 'string' && sec.trim() !== '' ? Number(sec) : Number.NaN;
  if (!Number.isFinite(n)) return '?';
  const s = Math.trunc(n);
  if (s < 60) return `${s}s`;
  const m = Math.trunc(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.trunc(m / 60);
  const rm = m % 60;
  return rm === 0 ? `${h}h` : `${h}h${rm}m`;
}

/** Port of the scripts' `fleets_part`: 👑/👤 + name (clip 16) + colour square, ≤4 chips, `+N`. */
export function legacyFleetsPart(glance: unknown): string {
  const self = (glance as { self?: unknown } | null)?.self;
  const fleets = (self as { fleets?: unknown } | null)?.fleets;
  if (!Array.isArray(fleets) || fleets.length === 0) return '';
  const chips: string[] = [];
  for (const f of fleets.slice(0, 4)) {
    if (!f || typeof f !== 'object') continue;
    const row = f as { label?: unknown; slug?: unknown; role?: unknown; square?: unknown };
    let label = String(row.label ?? row.slug ?? '').trim();
    if (!label) continue;
    if ([...label].length > 16) label = `${[...label].slice(0, 15).join('')}…`;
    const glyph = row.role === 'leader' ? '👑' : '👤';
    const square = String(row.square ?? '').trim();
    chips.push(`${glyph} ${label}${square ? ` ${square}` : ''}`);
  }
  if (chips.length === 0) return '';
  let seg = chips.join(' · ');
  const more = fleets.length - chips.length;
  if (more > 0) seg += ` +${more}`;
  return seg;
}

/**
 * Pure: the shared legacy title — `fleets · ⟳<interval>[!] · <id> · <objective[:40]>` —
 * byte-identical to the two python `term_title` copies. '' when nothing renders.
 */
export function buildLegacyStatusTitle(glance: unknown, agentId: string | null | undefined): string {
  const self = ((glance as { self?: unknown } | null)?.self ?? null) as
    | { objective?: unknown; loop?: unknown }
    | null;
  const bits: string[] = [];
  const fl = legacyFleetsPart(glance);
  if (fl) bits.push(fl);
  const lp = (self?.loop ?? null) as { active?: unknown; intervalSec?: unknown; reachable?: unknown } | null;
  if (lp && typeof lp === 'object' && lp.active) {
    // WI-655: trailing '!' when the loop is armed but not wake-reachable.
    let tag = `⟳${legacyFmtInterval(lp.intervalSec)}`;
    if (lp.reachable === false) tag += '!';
    bits.push(tag);
  }
  const me = legacySelfShort(agentId);
  if (me) bits.push(me);
  const obj = typeof self?.objective === 'string' ? self.objective.trim() : '';
  if (obj) {
    const cps = [...obj];
    bits.push(cps.length > LEGACY_OBJECTIVE_MAX ? `${cps.slice(0, LEGACY_OBJECTIVE_MAX).join('')}…` : obj);
  }
  return stripTitleControl(bits.join(' · '));
}

/**
 * Pure: the title THIS pipe prints for a glance — the server-rendered
 * `display.title` VERBATIM when present, else the shared legacy fallback. The
 * production leg (`applyStatusDisplay`) and the cross-pipe parity test call the
 * SAME function, so the test cannot drift from what the hook does.
 */
export function selectStatusTitle(
  glance: { self?: { objective?: string | null } | null; display?: { title?: string | null } | null } | null,
  agentId: string | null | undefined,
): string {
  const served = typeof glance?.display?.title === 'string' ? stripTitleControl(glance.display.title.trim()) : '';
  return served || buildLegacyStatusTitle(glance, agentId);
}

/**
 * Pure: build the OSC-0 set-title escape for an objective, or '' when there's
 * nothing to show. Legacy one-arg/two-arg entry kept for title-only callers;
 * since WI-1383525 GAP 3 it renders the SHARED legacy shape (`id · objective`,
 * clip 40, no 🔭) so it can never disagree with the other two pipes' fallback.
 */
export function buildObjectiveTitleOsc(
  objective: string | null | undefined,
  agentId?: string | null,
): string {
  const obj = typeof objective === 'string' ? objective : null;
  return wrapTitleOsc(buildLegacyStatusTitle({ self: { objective: obj } }, agentId ?? null));
}

// ── Single-source display pipe (tui-status-parity-single-source-2026-07-05) ──
//
// Since 2026-07-05 coord:glance (audience:'user') returns a server-rendered
// `display` block ({ title, statusline[], notice }) built ONCE server-side in
// status-display.ts — the same render the Claude statusline and the Codex hook
// print. OMP has no statusline, so its legs are:
//   • TITLE  → display.title VERBATIM, OSC-0 to /dev/tty (the legacy
//     buildObjectiveTitleOsc objective render survives ONLY as the fallback
//     for a pre-display operator);
//   • NOTICE → display.notice (the 💡 tip), delivered ON CHANGE to the human
//     (ctx.ui.notify) AND the model (shared tool-result advisory), deduped
//     by notice key so a standing tip doesn't spam every turn.

/**
 * Ordered terminal paths an OSC-0 title write should try, most authoritative first.
 * The TS twin of pc_tty.py's `tty_candidates` (read that file for the full WI-3665
 * rationale); objective-title-parity.test.ts holds the two in lockstep.
 *
 *   1. PAPERCUSP_OBJECTIVE_TTY — this hook's test seam (capture the escape in a file).
 *   2. PAPERCUSP_TTY          — the terminal this session OWNS, resolved once at launch
 *                               by psu-launcher. The only entry that survives a setsid'd
 *                               spawn, which is how Claude runs its statusline child.
 *   3. /dev/tty               — the controlling terminal. OMP's hook runs in-process so it
 *                               still has one; kept as the fallback for non-psu launches.
 *
 * A list, not a single answer: terminals close, and a stale seam must be skipped rather
 * than throw. We deliberately do NOT walk /proc ancestry to find a tty — ancestry crosses
 * ownership boundaries and would let a headless bee retitle a window it does not own.
 */
export function ttyCandidates(env: Partial<NodeJS.ProcessEnv> = process.env): string[] {
  const out: string[] = [];
  for (const name of ['PAPERCUSP_OBJECTIVE_TTY', 'PAPERCUSP_TTY']) {
    const val = (env[name] ?? '').trim();
    if (val) out.push(val);
  }
  out.push('/dev/tty');
  return out;
}

/** The directory holding one claim marker per terminal device — the TS twin of
 *  pc_tty.py's `_tty_claims_dir` / psu-launcher.mjs's `TTY_CLAIMS_DIR`. */
function ttyClaimsDir(env: Partial<NodeJS.ProcessEnv>): string {
  return (env.PAPERCUSP_TTY_CLAIMS_DIR ?? '').trim() || join(homedir(), '.papercusp', 'tty-claims');
}

function ttyClaimFilename(ttyPath: string): string {
  return ttyPath.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+/, '');
}

/**
 * Does the CURRENT claim on terminal `path` still name our own session `sid`?
 *
 * EI-10377 — the TS twin of pc_tty.py's `tty_owned_by_us` (read that docstring for the
 * full rationale: a Linux pty's minor number is recycled once its old holder closes it,
 * so a session whose PAPERCUSP_TTY outlives its own window can silently retitle whatever
 * unrelated session now owns that recycled path). No sid, or no claim on record, ⇒ true
 * (fail open) — a title is cosmetic and a missing claim must never hard-fail a write.
 */
async function ttyOwnedByUs(path: string, sid: string, env: Partial<NodeJS.ProcessEnv>): Promise<boolean> {
  if (!sid) return true;
  try {
    const claimedBy = (await fsp.readFile(join(ttyClaimsDir(env), ttyClaimFilename(path)), 'utf8')).trim();
    return claimedBy === sid;
  } catch {
    return true; // no claim on record — fail open, as before this check existed
  }
}

/**
 * Write an OSC escape to the first terminal that accepts it. Resolves true when some
 * terminal took the write; false when there was nothing to write, or when every candidate
 * failed (headless bee / closed terminal / no tty). Callers ignore the result — it exists
 * for tests. Never throws: a title is cosmetic and must never break a turn.
 *
 * EI-10377: the PAPERCUSP_TTY candidate specifically is skipped when its claim now names a
 * different session — see ttyOwnedByUs.
 */
export async function writeOscTitle(
  osc: string,
  env: Partial<NodeJS.ProcessEnv> = process.env,
  candidatePaths: readonly string[] = ttyCandidates(env),
): Promise<boolean> {
  if (osc.length === 0) return false;
  const sid = (env.PAPERCUSP_SID ?? '').trim();
  const ownedPath = (env.PAPERCUSP_TTY ?? '').trim();
  // `candidatePaths` is an injection seam for tests that must model a headless process
  // deterministically. Production callers use the ordered ttyCandidates(env) default.
  for (const path of candidatePaths) {
    if (path === ownedPath && !(await ttyOwnedByUs(path, sid, env))) continue;
    try {
      const fh = await fsp.open(path, 'w');
      try {
        await fh.write(osc);
      } finally {
        await fh.close();
      }
      return true;
    } catch {
      /* stale seam / closed terminal / no tty — try the next candidate */
    }
  }
  return false;
}

/** Pure: wrap a server-rendered display title in the OSC-0 escape, stripping
 *  control chars that could break out of the OSC string. '' when empty. */
export function buildDisplayTitleOsc(title: string | null | undefined): string {
  const t = typeof title === 'string' ? title.trim() : '';
  const clean = [...t].filter((c) => c.codePointAt(0)! >= 32 && c !== '\x07' && c !== '\x1b').join('');
  if (clean.length === 0) return '';
  // OSC 0 sets BOTH icon name and window title: ESC ] 0 ; <text> BEL.
  return `\x1b]0;${clean}\x07`;
}

/** The glance `display` block this hook consumes (statusline is Claude-only). */
interface GlanceDisplayBlock {
  title?: string | null;
  notice?: { id?: string | null; text?: string | null } | null;
}

/** Pure: the dedup key for a status notice — '' when there is nothing to show. */
export function statusNoticeKey(notice: GlanceDisplayBlock['notice']): string {
  const text = typeof notice?.text === 'string' ? notice.text.trim() : '';
  if (text.length === 0) return '';
  return `${notice?.id ?? 'tip'}|${text}`;
}

let _lastStatusNoticeKey = '';
/** Test seam: reset the per-session notice dedup. */
export function _resetStatusNoticeDedup(): void {
  _lastStatusNoticeKey = '';
}

/** Apply a server-rendered glance snapshot regardless of whether it arrived via
 * coord:glance directly or inside activity:report's hook bundle. */
export async function applyStatusDisplay(
  glance: { self?: { objective?: string | null }; display?: GlanceDisplayBlock | null } | null,
  _pi?: { sendMessage: HookApi['sendMessage'] },
  ctx?: unknown,
): Promise<void> {
  // display.title VERBATIM, else the shared legacy fallback (same shape as the
  // Claude/Codex scripts' term_title — WI-1383525 GAP 3). One selector for the
  // production leg and the parity test.
  const osc = wrapTitleOsc(selectStatusTitle(glance, process.env.PAPERCUSP_SID ?? null));
  await writeOscTitle(osc);
  const key = statusNoticeKey(glance?.display?.notice);
  if (key.length > 0 && key !== _lastStatusNoticeKey) {
    const text = (glance?.display?.notice?.text ?? '').trim();
    try {
      const c = ctx as { hasUI?: boolean; ui?: { notify?: (m: string, t?: string) => void } } | undefined;
      if (c?.hasUI && typeof c.ui?.notify === 'function') c.ui.notify(text, 'info');
      stashAdvisory(
        'coord-status-tip',
        `<system-reminder type="papercusp-status-tip">${text} (fleet status tip — act on it or surface it to the user; coord:glance for detail)</system-reminder>`,
      );
      _lastStatusNoticeKey = key;
    } catch {
      /* delivery failed → key stays unset so the next turn retries */
    }
  }
}

/**
 * Fire-and-forget per-turn display emit: ONE coord:glance (audience:'user')
 * read feeds both the terminal TITLE (display.title verbatim; the legacy
 * objective render as fallback) and the 💡 status NOTICE (on change only).
 * Attached-only in spirit (callMcpTool returns null detached → no-op). Never
 * throws; never writes to stdout/stderr (an OSC there could corrupt OMP's TUI
 * render). Best-effort, like reportActivity.
 */
export async function emitStatusDisplay(
  pi?: { sendMessage: HookApi['sendMessage'] },
  ctx?: unknown,
): Promise<void> {
  const glance = (await callMcpTool(
    'coord:glance',
    { audience: 'user', activity_limit: 0 },
    // `format: 'json'` is REQUIRED: coord:glance is TOON-encoded by default and callMcpTool's
    // JSON.parse(content) cannot read TOON — it returned null, so the title fell back to the
    // bare session id and the fleet 👑/👤 never rendered on OMP at all (WI-3665; the EI-7029
    // class, fixed long ago in statusline-fleet.sh and never propagated here). The
    // fixture-driven parity tests missed it because fixtures bypass the network entirely.
    { meta: { format: 'json' }, timeoutMs: 5000 },
  )) as { self?: { objective?: string | null }; display?: GlanceDisplayBlock | null } | null;
  await applyStatusDisplay(glance, pi, ctx);
}

/** Apply one delta bundle. The generation advances only after BOTH surfaces
 * hydrate, so partial responses retry on the next completed tool. */
export async function consumeActivityHookBundle(
  bundle: ActivityHookBundle | null,
  pi?: { sendMessage: HookApi['sendMessage'] },
  ctx?: unknown,
): Promise<{ reminder: string }> {
  if (!bundle || bundle.schemaVersion !== ACTIVITY_HOOK_BUNDLE_SCHEMA || typeof bundle.generation !== 'string') {
    _hookBundleGeneration = null;
    return { reminder: '' };
  }
  let reminder = '';
  // Apply each surface on its own PRESENCE, not on `bundle.changed`.
  //
  // The server only ever populates a surface it actually hydrated, so for every
  // response shape that predates the leg split this is byte-identical: the quiet
  // path returns no `surfaces` at all. What it additionally handles is a
  // `glance-only` fold — `changed:false` (the INBOX gate stayed shut, correctly)
  // carrying a fresh glance. Gating on `changed` would silently discard that
  // snapshot, i.e. re-couple the legs in the consumer right after the producer
  // split them. See hook-bundle.ts `glance_stale` (WI-10002436, compromise B).
  if (bundle.surfaces?.inbox) reminder = consumeInboxDelta(bundle.surfaces.inbox).reminder;
  if (bundle.surfaces?.glance) {
    await applyStatusDisplay(
      bundle.surfaces.glance as { self?: { objective?: string | null }; display?: GlanceDisplayBlock | null },
      pi,
      ctx,
    );
  }
  _hookBundleGeneration = bundle.complete ? bundle.generation : null;
  return { reminder };
}

/** Back-compat alias (pre-display name) — title-only callers keep working. */
export async function emitObjectiveTitle(): Promise<void> {
  await emitStatusDisplay();
}

/** True iff `toolName` is OMP's native keyword tool-search (`search_tool_bm25`) — the discovery
 *  off-ramp the trimmed surface (weak-model-tool-tier-2026-07-01) replaces with tools:find.
 *  Case-insensitive. Pure. */
export function isNativeToolSearch(toolName: string): boolean {
  return toolName.toLowerCase() === 'search_tool_bm25';
}

/** Pull the search query out of a native tool-search call, tolerant of the exact field name
 *  (query / keyword(s) / q / search / text, else the first non-empty string value). Pure. */
export function extractToolSearchQuery(input: Record<string, unknown> | undefined): string {
  for (const k of ['query', 'keyword', 'keywords', 'q', 'search', 'text']) {
    const v = input?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  for (const v of Object.values(input ?? {})) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/** Render the block-reason returned when an agent session reaches for search_tool_bm25: the
 *  instruction to use tools:find→tools:invoke, plus the inline tools:find matches (the
 *  "suggestion") when we have them. Pure — the I/O (running tools:find) is buildToolFindRedirect. */
export function formatToolFindRedirect(
  query: string,
  hits: ReadonlyArray<{ tool?: string; description?: string }>,
): string {
  const head =
    'search_tool_bm25 is disabled for agent sessions — use tools:find (semantic + lexical ' +
    'discovery over the full catalog) to find a tool, then tools:invoke {name, args} to call it ' +
    '(tools:invoke runs any catalog tool server-side, no load/activation step). ';
  if (!query) return head + 'Call tools:find("<what you need>") next.';
  const lines = hits
    .map((h) => {
      const name = (h.tool ?? '').trim();
      if (!name) return '';
      const desc = (h.description ?? '').split('\n')[0].trim().slice(0, 100);
      return `  • ${name}${desc ? ` — ${desc}` : ''}`;
    })
    .filter(Boolean);
  if (lines.length === 0) {
    return (
      head +
      `I ran tools:find(${JSON.stringify(query)}) for you and it returned no matches — refine the ` +
      'query and call tools:find yourself.'
    );
  }
  return (
    head +
    `I already ran tools:find(${JSON.stringify(query)}) — top matches:\n${lines.join('\n')}\n` +
    'Call the one you need with tools:invoke {name:"<exact name>", args:{…}}.'
  );
}

/** Off-ramp redirect (I/O): extract the query from a native tool-search call, run tools:find with
 *  it, and return the block-reason with the matches inline. Never throws — a failed/timed-out
 *  tools:find degrades to the plain "call tools:find yourself" instruction. */
export async function buildToolFindRedirect(
  input: Record<string, unknown> | undefined,
): Promise<string> {
  const query = extractToolSearchQuery(input);
  if (!query) return formatToolFindRedirect('', []);
  // Request JSON: tools:find's hits[] array is TOON-encoded by default (P-005), which
  // callMcpTool's JSON.parse(content) cannot read — without this the redirect silently
  // degrades to "no matches" even when tools:find found plenty.
  const res = (await callMcpTool(
    'tools:find',
    { query, limit: 8 },
    { meta: { format: 'json' }, timeoutMs: 5000 },
  ).catch(() => null)) as { hits?: Array<{ tool?: string; description?: string }> } | null;
  const hits = Array.isArray(res?.hits) ? res!.hits : [];
  return formatToolFindRedirect(query, hits);
}

// ── Doom-loop breaker (ornith-reliability-2026-07-03 / EI-7076 + EI-7092) ────
// A weak/local model (ornith IQ3_M) can wedge in a degenerate tool loop, calling
// the SAME tool with the SAME args over and over without ever reading the result.
// Observed twice on 2026-07-03: a fleet LEADER burned 66 identical `resolve` calls
// and never read its plan (EI-7076); a MEMBER burned 132 bash `find` calls,
// re-running the same empty search (EI-7092). Prompt-level "don't loop" guidance
// does not reach a model already IN the loop — this is the deterministic backstop.
// After N CONSECUTIVE identical (toolName+args) calls the guard BLOCKS further
// repeats with a steer that names the repetition and points at the right approach.
// In-process is sufficient: one omp child = one process (unlike the multi-worker
// :3070 MCP pool), so a module-scoped counter — like `acquiredLocks` — is correct.
// Gated on the agent-session marker; owner sessions are never throttled (D-003).
// It counts CONSECUTIVE identical calls, reset at each turn_start (a doom-loop is
// intra-turn — the model emits the whole burst inside one turn), so a legitimate
// re-call across two separate turns never trips it, and a legit FORCED `resolve`
// (each resolves a DISTINCT pending action and returns a real result, so it never
// repeats identically) cannot trip it either.

/** After this many CONSECUTIVE identical (toolName+args) calls in one turn, the
 *  loop-breaker blocks further identical repeats. Two identical calls pass; the
 *  third is blocked. Chosen to catch BOTH observed loops (the member find-flail
 *  had a 3× identical tail; the leader resolve-loop was 66×) while leaving a
 *  legitimate double-call (e.g. a retry) untouched. */
export const IDENTICAL_CALL_LOOP_LIMIT = 3;

interface RepeatRun {
  key: string;
  count: number;
}
let _repeatRun: RepeatRun | undefined;

/** Deterministically re-key every plain-object level of `value` in sorted-key order, leaving
 *  arrays/primitives untouched. A `JSON.stringify(value, Object.keys(value).sort())` replacer
 *  ARRAY (the previous implementation here) is NOT scoped to one level: JSON.stringify applies
 *  that same top-level key allowlist RECURSIVELY at every nesting depth, so a wrapped call whose
 *  distinguishing fields live inside a nested object (a `tools:invoke` call shaped
 *  `{name, args:{name, plan, model, ...}}`) silently drops every nested key not named `name`/
 *  `args` — collapsing genuinely-different calls (different `plan`/`model`/`count`) into the
 *  SAME loop-detection key. Caught by the WI-2382 fleet-launch model-guard tests: a corrected
 *  retry (different `model`) was misclassified as a 4th identical repeat and blocked. Pure. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeysDeep((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/** Stable, bounded key for loop detection: lowercased toolName + deep sorted-key JSON of the
 *  input, capped so a huge arg blob cannot blow memory. Never throws (an unserializable input
 *  degrades to a constant marker, which still detects a repeat of that same input). Pure. */
export function toolCallLoopKey(
  toolName: string,
  input: Record<string, unknown> | undefined,
): string {
  let argsPart: string;
  try {
    argsPart = JSON.stringify(sortKeysDeep(input ?? {})).slice(0, 2000);
  } catch {
    argsPart = '<unserializable>';
  }
  return `${toolName.toLowerCase()} ${argsPart}`;
}

/** Record a tool call under `key` and return the new CONSECUTIVE run length (1 =
 *  first occurrence, or the run just changed). Mutates module state. */
export function noteToolCallRepeat(key: string): number {
  if (_repeatRun && _repeatRun.key === key) {
    _repeatRun.count += 1;
  } else {
    _repeatRun = { key, count: 1 };
  }
  return _repeatRun.count;
}

/** Annotation "noise" fields an omp tool call may carry that DON'T change what the call DOES —
 *  chiefly `i`, omp's free-text intent annotation. A weak model stuck retrying a failing call often
 *  tweaks ONLY this prose ("read the plan" → "read the plan with harness papercusp") while leaving
 *  the actual (wrong) args unchanged, which defeats an exact-match loop detector. Stripped before
 *  keying so those retries collapse to one key. */
const REPEAT_NOISE_FIELDS = new Set(['i', 'intent', 'reason', 'note', 'why', 'thought', 'comment']);

/** Loop-detection key that IGNORES the noise annotation fields (REPEAT_NOISE_FIELDS), so a model
 *  tweaking only its prose `i` between otherwise-identical calls still keys the same. Pure. */
export function sessionRepeatKey(
  toolName: string,
  input: Record<string, unknown> | undefined,
): string {
  let clean: Record<string, unknown> | undefined = input;
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    clean = {};
    for (const k of Object.keys(input)) {
      if (!REPEAT_NOISE_FIELDS.has(k.toLowerCase())) clean[k] = input[k];
    }
  }
  return toolCallLoopKey(toolName, clean);
}

/** SESSION-cumulative consecutive-repeat breaker (ornith iter25, 2026-07-04 / WI-2382 — failure
 *  mode #9). The turn-scoped identical breaker (noteToolCallRepeat, reset every turn_start) is BLIND
 *  to the common omp doom-loop where each tool call is its own TURN: iter25's leader called
 *  `plans:get` 58× across 58 turns, every call failing `harness_required` (it wrote "harness" into
 *  the prose `i` field instead of passing the `harness:` arg), and the turn-scoped counter reset to 1
 *  every time so it never tripped. This run is NOT turn-reset — it tracks the CURRENT run of
 *  consecutive identical (noise-stripped) calls across turns, and only a genuinely DIFFERENT call
 *  resets it, so a varied workflow never accumulates but a stuck retry-loop does. The hook cannot see
 *  tool RESULTS (ToolResultEvent carries no error status), so it detects the LOOP, not the error; the
 *  redirect points the model at reading the error + fixing its args. */
export const SESSION_REPEAT_LIMIT = 8;
let _sessionRepeatRun: { key: string; count: number } | undefined;

/** Count the current call against the session-cumulative consecutive-repeat run; returns the new run
 *  length (1 = a different call than last time, which resets the run). */
export function noteSessionRepeat(key: string): number {
  if (_sessionRepeatRun && _sessionRepeatRun.key === key) {
    _sessionRepeatRun.count += 1;
  } else {
    _sessionRepeatRun = { key, count: 1 };
  }
  return _sessionRepeatRun.count;
}

/** Reset the consecutive-repeat run. Deliberately NOT wired to turn_start (surviving turn boundaries
 *  is the whole point) — a test seam, and a place to clear it on session lifecycle if ever needed. */
export function resetSessionRepeatRun(): void {
  _sessionRepeatRun = undefined;
}

/** The redirect once the same (noise-stripped) call has repeated SESSION_REPEAT_LIMIT times in a row.
 *  It cannot name the specific error (the hook can't see results), so it points the model at the last
 *  error + the most common fix (a missing REQUIRED arg belongs as a top-level arg, not in prose).
 *  Pure. */
export function sessionRepeatReason(toolName: string, count: number): string {
  return (
    `repeat-breaker: you have called \`${toolName}\` ${count} times in a row with the same ` +
    'arguments and it is NOT working — repeating it will keep failing the same way. STOP and CHANGE ' +
    'something now. READ the last error/result carefully: it almost always names the exact fix — a ' +
    'missing REQUIRED argument (e.g. `harness:"papercusp"`) must be passed as a TOP-LEVEL arg, NOT ' +
    'described in the prose `i` field. Fix the arguments and try ONCE more, or take a different ' +
    'action / report the blocker via coord:send. Do not repeat the identical call again.'
  );
}

/** Per-turn shell-call budget for agent sessions (ornith-reliability-2026-07-03 /
 *  EI-7092 wandering-search half). A weak model (ornith IQ3_M) can grind dozens of
 *  DIFFERENT `bash` greps/finds in a single turn without converging — and drift
 *  off-scope while doing it — which the identical-repeat breaker cannot catch
 *  (each call is distinct, so its run length stays 1). Observed live in run-7: a
 *  leader ran 56+ distinct greps on one plan item, wandering into unrelated code.
 *  After this many shell calls in one turn, further shell calls are blocked with a
 *  "converge or report" steer; every NON-shell tool (read, grep, tools:invoke,
 *  coord:send, status writes) stays open so the model can still finish or report.
 *  Reset at turn_start. High enough that an ordinary heavy turn (<10 shell calls)
 *  never trips it — only a genuine runaway wander. */
export const SHELL_CALLS_PER_TURN_LIMIT = 40;
let _shellCallsThisTurn = 0;

/** True for OMP's shell tool (bash / shell). Pure. */
export function isShellTool(toolName: string): boolean {
  const t = toolName.toLowerCase();
  return t.startsWith('bash') || t === 'shell';
}

/** Count a shell call in the current turn; returns the new per-turn total. */
export function noteShellCall(): number {
  return ++_shellCallsThisTurn;
}

/** The "converge or report" steer returned once the per-turn shell budget is spent. Pure. */
export function shellBudgetReason(count: number): string {
  return (
    `shell-budget: you have run ${count} shell commands this turn without converging — STOP ` +
    'running more `bash`. You have gathered plenty of output already; read what you have and ' +
    'either state your finding / verdict NOW, or if you are genuinely stuck, report the blocker ' +
    '(coord:send to your leader) or mark the item and move on. For one more targeted lookup use ' +
    'the `read` / `grep` file tools, not another shell command. Non-shell tools remain available.'
  );
}

/** Reset the per-turn loop-detection run AND the shell-call budget. Called at every
 *  turn_start (both counters are turn-scoped) and exported as a test seam. */
export function resetToolCallLoopState(): void {
  _repeatRun = undefined;
  _shellCallsThisTurn = 0;
}

/** SESSION-cumulative fleet-launch budget (ornith run-10, 2026-07-04): leader
 *  session 10127 re-called fleet:launch-on-plan 20× in one session. Every re-call
 *  was absorbed by the PG launch-slot guard ("a re-call opens NO new members for
 *  300s") — but the model kept re-issuing it between loop:checkpoint calls, so the
 *  CONSECUTIVE-identical breaker never saw a run ≥3, and a third of the leader's
 *  turns burned on no-op launches instead of supervision. The launch verb is
 *  one-shot by design: after this many calls in one session, further launch calls
 *  are blocked with a supervise-instead steer. Deliberately NOT turn-reset — the
 *  budget covers the process lifetime (2 allows one genuine retry after an error). */
export const FLEET_LAUNCH_CALLS_PER_SESSION = 2;
let _fleetLaunchCalls = 0;

/** True for a fleet:launch-on-plan call in ANY surface spelling — the direct MCP
 *  name (hyphen or underscore verb) or a tools:invoke wrapper whose inner `name`
 *  is the launch verb. Pure. */
export function isFleetLaunchCall(
  toolName: string,
  input: Record<string, unknown> | undefined,
): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/-/g, '_');
  const t = norm(toolName);
  if (t.includes('fleet_launch_on_plan') || t.includes('fleet:launch_on_plan')) return true;
  if (t.endsWith('tools_invoke') || t === 'tools:invoke') {
    const inner = input && typeof input.name === 'string' ? norm(input.name) : '';
    return inner.includes('fleet_launch_on_plan') || inner.includes('fleet:launch_on_plan');
  }
  return false;
}

/** Count a fleet-launch call for this session; returns the new cumulative total. */
export function noteFleetLaunchCall(): number {
  return ++_fleetLaunchCalls;
}

/** Test seam: reset the session-cumulative fleet-launch budget. */
export function resetFleetLaunchBudget(): void {
  _fleetLaunchCalls = 0;
}

/** The supervise-instead steer returned once the fleet-launch budget is spent. Pure. */
export function fleetLaunchBudgetReason(count: number): string {
  return (
    `fleet-launch budget: this session has already called fleet:launch-on-plan ${count - 1} ` +
    'times — your fleet EXISTS, and a re-call opens NO new members (the launch slot is held). ' +
    'STOP calling it. Supervise instead: fleet:status { fleet } for the roster, plans:get for ' +
    'item progress, coord:send to steer members. If you genuinely need MORE members, ask your ' +
    'launcher/owner via coord:send first — do not re-call the launch tool.'
  );
}

/** True for a LOCAL / gateway model spec — the models only the omp backend runs: an `ollama-cc/…`,
 *  an `ollama/…`, or any spec naming ornith / maxwell (the local ornith build). Used to tell an
 *  ornith agent session apart from a cloud (claude/codex) one, and to check that a fleet-launch pins
 *  a local MEMBER model. Pure. */
export function isLocalModel(model: string | undefined): boolean {
  if (!model) return false;
  const m = model.toLowerCase();
  return (
    m.startsWith('ollama-cc/') || m.startsWith('ollama/') || m.includes('ornith') || m.includes('maxwell')
  );
}

/** The model THIS omp session was launched with, read from its own process argv (`--model <spec>` or
 *  `--model=<spec>`). The `-e` coord hook loads INSIDE the omp process, so process.argv IS omp's argv.
 *  Returns undefined if no --model flag is present, so callers FAIL OPEN (no false block). Pure-ish
 *  (reads process.argv only). */
export function getOwnLaunchedModel(): string | undefined {
  const argv = process.argv || [];
  const i = argv.indexOf('--model');
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith('--model='));
  return eq ? eq.slice('--model='.length) : undefined;
}

/** Extract the member `model` arg from a fleet:launch-on-plan call in either surface spelling — the
 *  direct MCP call (input.model) or the tools:invoke wrapper (input.args.model). Pure. */
export function fleetLaunchMemberModel(
  input: Record<string, unknown> | undefined,
): string | undefined {
  if (!input) return undefined;
  if (typeof input.model === 'string') return input.model;
  const args = input.args;
  if (args && typeof args === 'object') {
    const inner = (args as Record<string, unknown>).model;
    if (typeof inner === 'string') return inner;
  }
  return undefined;
}

/** The redirect returned when a LOCAL-model (ornith) agent session launches a fleet WITHOUT pinning a
 *  local member `model` (ornith iter22, 2026-07-04 / WI-2382 — failure mode #8). fleet:launch-on-plan
 *  DEFAULTS members to cloud `claude` unless a local model is given, so an ornith leader that omits it
 *  (or whose weak model dropped the arg) silently spawns CLAUDE members — the wrong backend,
 *  invisibly (iter22: 2 claude members launched + died, the ornith-member test invalidated). Names the
 *  session's OWN model so the fix is copy-pasteable. Pure. */
export function fleetLaunchModelReason(ownModel: string): string {
  return (
    'fleet-launch model guard: you are running the local model `' +
    ownModel +
    '`, but this fleet:launch-on-plan call does NOT pin a local member `model` — so it would ' +
    'silently launch your members as CLOUD `claude` agents (fleet:launch-on-plan defaults ' +
    'agent=claude unless a local model is given), NOT your own model. Re-call it WITH the member ' +
    'model pinned: `tools:invoke {name:"fleet:launch-on-plan", args:{name:"<fleet>", ' +
    'plan:"<plan-slug>", count:<n>, agent:"omp", model:"' +
    ownModel +
    '"}}`. The `model` arg is REQUIRED — do not omit it.'
  );
}

/** True for a `work_items:claim_next` call in either surface spelling — the direct MCP call
 *  (`work_items:claim_next`) or the tools:invoke wrapper (`{name:"work_items:claim_next"}`). Matches
 *  ONLY claim_next (the blind "give me the next backlog item" pull), NOT `work_items:claim` (claim a
 *  SPECIFIC assigned item by id) — `claim_next` is a distinctive substring that `work_items_claim`
 *  never contains, so the by-id path stays open. Pure. */
export function isClaimNextCall(
  toolName: string,
  input: Record<string, unknown> | undefined,
): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/-/g, '_');
  const t = norm(toolName);
  if (t.includes('claim_next')) return true;
  if (t.endsWith('tools_invoke') || t === 'tools:invoke') {
    const inner = input && typeof input.name === 'string' ? norm(input.name) : '';
    return inner.includes('claim_next');
  }
  return false;
}

/** The redirect returned when a LOCAL-model (ornith) agent calls work_items:claim_next (ornith iter27,
 *  2026-07-04 / WI-2382 → WI-2046 — failure mode #11). claim_next pulls a RANDOM item off the SHARED
 *  REAL backlog, not the session's assigned work — an ornith leader that was meant to work its
 *  behaviour-test plan claim_next'd the live WI-2046 and then FALSELY marked it done, corrupting real
 *  project state (it had to be reopened by hand). A weak local model cannot be trusted to correctly
 *  complete + close a real backlog item it self-selected, so the blind pull is denied outright; a
 *  specifically-assigned item is still reachable by id via work_items:claim. Pure. */
export function claimNextBlockReason(): string {
  return (
    'work_items:claim_next is DISABLED for local-model (ornith) agent sessions. It pulls a RANDOM ' +
    'item off the SHARED REAL backlog — not your assigned work — and a weak local model that claims ' +
    "one then mis-marks it done CORRUPTS live project state (iter27: an ornith leader claim_next'd " +
    'WI-2046 and falsely closed it; it had to be reopened by hand). Work ONLY your ASSIGNED plan: ' +
    'call `plans:get {slug:"<your --plan>"}` to read your items, then edit the file(s) those items ' +
    'name. If your launcher/owner assigned you a SPECIFIC real item, claim that ONE by id with ' +
    '`work_items:claim {id:"WI-..."}` — never claim_next. Do NOT call claim_next again.'
  );
}

/** True when the current process is a Papercusp AGENT session, so the coord-hook
 *  guards below (doom-loop breaker, per-turn shell + session fleet-launch budgets,
 *  eval + native-tool-search redirects, native-scheduler lockout, destructive-git
 *  mirror) apply. Two signals, OR'd for defense-in-depth (WI-2350):
 *   - PAPERCUSP_AGENT_SESSION==='1' — the canonical marker psu-launcher arms for
 *     autonomous launches.
 *   - PAPERCUSP_AGENT==='omp' — this hook ONLY ever loads inside omp, and an omp
 *     CLI session is ALWAYS a local-model agent (never a human typing as
 *     themselves), so this alone is sufficient. It is the BACKSTOP that keeps
 *     every guard live even when a launcher path forgets the marker — the
 *     2026-07-04 ornith run-3b root cause: a `--plan`/`--fleet` omp launch is
 *     brain=false, so psu-launcher never set PAPERCUSP_AGENT_SESSION and the
 *     ENTIRE guard suite (incl. the doom-loop breaker) sat inert while the leader
 *     spun ~22× on a no-op `resolve`.
 *  Owner sessions set NEITHER signal, so they stay unrestricted (D-003). Pure. */
export function isAgentSession(): boolean {
  return (
    process.env.PAPERCUSP_AGENT_SESSION === '1' || process.env.PAPERCUSP_AGENT === 'omp'
  );
}

/** True for an `eval`/python code-execution call in any surface spelling. The
 *  trimmed OMP surface hands a weak local model (ornith IQ3_M) tools:find +
 *  tools:invoke as its ONLY discovery/invocation path — every MCP/papercusp tool
 *  is reachable THROUGH them. A raw `eval`/`python` tool is neither, and a weak
 *  model reaches for it to "call" a tool as code (ornith run-3, 2026-07-04:
 *  session 10177 called `eval` ~148× → "(no output)" → never reached plans:get,
 *  never gated). The consecutive-identical loop-breaker never caught it because
 *  each call carried different code, so the runs were non-adjacent. This is a
 *  tool-NAME block that fires on call #1 regardless of args. Strips a `group:`
 *  prefix first so a legitimately-namespaced verb (e.g. `code:run` → `run`) is
 *  NOT swept up. Pure. */
export function isEvalCall(toolName: string): boolean {
  const n = (toolName || '').toLowerCase().replace(/[_-]/g, '');
  const bare = n.replace(/^.*:/, '');
  return bare === 'eval' || bare === 'evaltool' || bare === 'runpython' || bare === 'python';
}

/** SESSION-cumulative eval-block budget (ornith Iter-4, 2026-07-04 / WI-2382). The
 *  WI-2299 name-block stops `eval` from EXECUTING, but a weak model (ornith IQ3_M)
 *  keeps REFLEXIVELY re-issuing `eval` every turn despite the block — session 10234
 *  called it 80+× across turns, each time acknowledging "I should use tools:invoke"
 *  in its thinking yet calling `eval` again. Because each `eval` is its own OMP turn,
 *  a turn-scoped counter would reset to 1 forever and never escalate; this counter is
 *  session-cumulative (like the fleet-launch budget) so the redirect can ESCALATE from
 *  the helpful triad steer to a hard, copy-pasteable directive. Test-seam reset only;
 *  deliberately NOT turn-reset. */
export const EVAL_BLOCK_ESCALATE_AFTER = 3;
let _evalBlockCount = 0;

/** Count an eval-block for this session; returns the new cumulative total. */
export function noteEvalBlock(): number {
  return ++_evalBlockCount;
}

/** Test seam: reset the session-cumulative eval-block budget. */
export function resetEvalBlockBudget(): void {
  _evalBlockCount = 0;
}

/** After this many CUMULATIVE blocked `eval` calls in one session, the guard gives up on prose
 *  and STRUCTURALLY terminates the session (ornith iter14, 2026-07-04 / WI-2382). The WI-2299
 *  name-block stops eval EXECUTING and evalBlockReason ESCALATES the message, but a weak IQ3_M
 *  ignores prose and doom-loops — 10177=148×, 10234=80+×, iter14=139× — burning the ENTIRE session
 *  without ever reading its plan. The HookApi tool_call return is only { block, reason } (no
 *  session-end lever), so the sole reliable break is process-level self-termination: a session
 *  that has ignored this many hard STOPs will never recover, and a fast fail + relaunch (the
 *  model's turn-to-turn variance means a fresh launch usually gets past kickoff — iter13 did)
 *  beats an unbounded hang. Threshold > EVAL_BLOCK_ESCALATE_AFTER so the prose escalation gets its
 *  chance first. Agent sessions only (the guard is isAgentSession-gated) — an owner never trips it. */
export const EVAL_BLOCK_KILL_AFTER = 10;

/** Structural halt for a runaway agent session. SIGTERM (not a raw exit) so the process's own
 *  SIGTERM handler runs the defensive lock cleanup first (see the exit handler above); process.exit
 *  is the fallback if the signal cannot be delivered. A module-level `let` so a unit test can swap
 *  it via setHaltForTest and assert it fires WITHOUT killing the test runner. NOTE: any agent-session
 *  test that issues ≥ EVAL_BLOCK_KILL_AFTER eval calls WITHOUT swapping this seam would SIGTERM the
 *  runner — swap the seam (as the halt tests do). Not `const`: the reassignment is the seam. */
export let _haltRunawaySession = (reason: string): void => {
  try {
    process.stderr.write(`[papercusp-coord] halting runaway session: ${reason}\n`);
  } catch {
    /* a diagnostic write must never itself throw */
  }
  try {
    process.kill(process.pid, 'SIGTERM');
  } catch {
    process.exit(1);
  }
};

/** Test seam: override the runaway-halt action so a unit test can assert it fires without actually
 *  terminating the test process. Returns the previous binding so the test can restore it. */
export function setHaltForTest(fn: (reason: string) => void): (reason: string) => void {
  const prev = _haltRunawaySession;
  _haltRunawaySession = fn;
  return prev;
}

/** After this many CUMULATIVE blocked "reflexive" tool calls in one session the shared backstop
 *  structurally terminates the runaway (ornith iter16, 2026-07-04 / WI-2382). The reflexive class is
 *  the weak-model doom-loop where the model keeps re-issuing a disabled/wrong tool despite the block.
 *  `eval` and the curl-the-MCP-endpoint content-block each already halt on their OWN per-tool count,
 *  but `irc` and `ask` had the block with NO halt — so an ornith LEADER that reflexively hammered
 *  `irc` at kickoff burned its ENTIRE session (iter16: 482 blocked `irc` calls, 0 progress — never
 *  read its plan; the iter14 eval doom-loop reproduced on a different tool). The generic
 *  consecutive-identical loop-breaker missed it because the calls varied just enough to be
 *  non-adjacent. This shared counter is the UNIVERSAL backstop for that class: any mix of reflexive
 *  blocks (irc/ask, + any future tool-name block wired to noteReflexiveBlock) that reaches the
 *  threshold self-terminates. Threshold matches EVAL_BLOCK_KILL_AFTER for consistency. */
export const REFLEXIVE_BLOCK_KILL_AFTER = 10;
/** After this many blocked reflexive calls, the block MESSAGE escalates from the polite redirect to a
 *  hard, copy-pasteable STOP (mirrors EVAL_BLOCK_ESCALATE_AFTER). Below the kill threshold so the
 *  escalated prose gets a few turns to land before the structural halt. */
export const REFLEXIVE_BLOCK_ESCALATE_AFTER = 3;
let _reflexiveBlockCount = 0;

/** Count a blocked reflexive tool call and, at/past REFLEXIVE_BLOCK_KILL_AFTER, structurally halt the
 *  runaway agent session (reuses _haltRunawaySession so the process SIGTERM handler cleans up locks
 *  first). Returns the new cumulative total so the caller can escalate its block MESSAGE too. Wired
 *  into the reflexive guards that lack their own per-tool halt (irc, ask). isAgentSession-gating stays
 *  at the call sites — an owner session never reaches these guards, so it never trips the halt. */
export function noteReflexiveBlock(tool: string): number {
  const n = ++_reflexiveBlockCount;
  if (n >= REFLEXIVE_BLOCK_KILL_AFTER) {
    _haltRunawaySession(
      `reflexive-block doom-loop: ${n} blocked reflexive tool calls in one session (latest: ${tool})`,
    );
  }
  return n;
}

/** Test seam: reset the session-cumulative reflexive-block backstop counter. */
export function resetReflexiveBlockBudget(): void {
  _reflexiveBlockCount = 0;
}

// ── Stall watchdog (ornith failure mode #5, 2026-07-04 / WI-2382) ──────
/** The doom-loop guards (eval/curl/irc/ask + the generic consecutive-identical
 *  breaker) all catch a RAPID loop — a session firing a disabled/wrong call over
 *  and over. iter17 surfaced the OPPOSITE failure: an ornith IQ3_M leader made a
 *  few tool calls, then WEDGED — its transcript froze for 7.5+ min, the process
 *  alive but sleeping (Ssl+), no tool activity, never routing. A per-call guard
 *  cannot see SILENCE (there is no call to inspect), so a stall hangs
 *  indefinitely and needs a manual kill — worse for an autonomous campaign than a
 *  loop (which now self-terminates). This is a HEARTBEAT watchdog armed ONLY
 *  WHILE A TURN IS IN PROGRESS: turn_start (and session_start) ARM it and each
 *  in-turn event (tool_call / tool_result) rearms the countdown; a clean
 *  turn_end DISARMS it. If the countdown elapses mid-turn the session is wedged
 *  → structural halt (same lever + fast-relaunch rationale as the doom-loop
 *  halts). CRITICAL (iter18): a session that cleanly ENDS its turn and idles
 *  waiting for input (a kickoff routing gate presented as text, an owner
 *  decision) is silence-identical to a wedge but is NOT wedged — so silence
 *  alone must never trigger the halt; only silence WITHIN an unfinished turn
 *  does (turn_end never fires for a genuine mid-turn freeze, so it stays armed
 *  and is still caught). Three further correctness properties:
 *   1. The timer is unref()'d, so it NEVER holds an otherwise-finished process
 *      open (a finished session should exit, not be held alive then falsely
 *      "stall-halted"). It can only fire while the event loop is alive for
 *      ANOTHER reason — a wedged session awaiting model output that never
 *      comes — which is exactly the stall.
 *   2. In-flight awareness: a long but LEGIT tool (a big build/test in Bash)
 *      produces the same silence as a wedge. tool_call/tool_result track whether
 *      a tool is executing; while one is, the timeout EXTENDS instead of halting
 *      — bounded by STALL_WATCHDOG_MAX_INFLIGHT_EXTENSIONS so a genuinely hung
 *      tool still halts (never regresses to an unbounded hang), just later.
 *   3. isAgentSession-gated inside the poke (defense-in-depth, not reliant on
 *      every call site): an owner may idle a session forever — never watchdog'd.
 *  Client-side omp `-e` hook ⇒ LIVE for the next omp launch, no deploy/flag dep. */
export const STALL_WATCHDOG_MS = 6 * 60 * 1000; // 6 min of between-events silence ⇒ wedged. ~9× a typical IQ3_M turn, well above the slowest legit generation. Tunable.
/** A legit long-running tool gets up to this many extra STALL_WATCHDOG_MS windows
 *  (in-flight) before we halt anyway — so a build/test that runs several minutes
 *  is not killed, but a hung tool still terminates (at (1+N)×the window). */
export const STALL_WATCHDOG_MAX_INFLIGHT_EXTENSIONS = 3;
let _stallTimer: ReturnType<typeof setTimeout> | null = null;
let _stallToolInFlight = false;
let _stallInflightExtensions = 0;

/** Record whether a tool is currently executing — set true at tool_call, false at
 *  tool_result. Read only by the (agent-only) armed timer to decide extend-vs-halt;
 *  a no-op flag in a session that never arms the watchdog. */
export function noteStallToolInFlight(inFlight: boolean): void {
  _stallToolInFlight = inFlight;
}

/** The countdown elapsed with no intervening hook event. If a tool is genuinely
 *  in flight, extend (bounded) rather than kill a slow-but-legit build; otherwise
 *  the session is wedged between events (the iter17 failure) → structural halt. */
function _onStallWatchdogTimeout(): void {
  if (_stallToolInFlight && _stallInflightExtensions < STALL_WATCHDOG_MAX_INFLIGHT_EXTENSIONS) {
    _stallInflightExtensions += 1;
    _stallTimer = setTimeout(_onStallWatchdogTimeout, STALL_WATCHDOG_MS);
    if (typeof _stallTimer.unref === 'function') _stallTimer.unref();
    return;
  }
  const elapsedS = Math.round((STALL_WATCHDOG_MS * (1 + _stallInflightExtensions)) / 1000);
  _stallTimer = null;
  _haltRunawaySession(
    `stall-watchdog: no hook activity for ${elapsedS}s — session wedged ` +
      `(a stall, not a loop — the doom-loop halts cannot see silence)`,
  );
}

/** (Re)arm the stall watchdog. Called at the top of every hook event: any event
 *  means the session is progressing, so clear the pending countdown and start a
 *  fresh one, resetting the in-flight extension budget. isAgentSession-gated — an
 *  owner session is never armed (so never halted). The timer is unref()'d so it
 *  never keeps the process alive on its own. */
export function pokeStallWatchdog(): void {
  if (!isAgentSession()) return;
  if (_stallTimer) clearTimeout(_stallTimer);
  _stallInflightExtensions = 0;
  _stallTimer = setTimeout(_onStallWatchdogTimeout, STALL_WATCHDOG_MS);
  if (typeof _stallTimer.unref === 'function') _stallTimer.unref();
}

/** Clear the watchdog — on clean session_shutdown and as a test-cleanup seam. */
export function disarmStallWatchdog(): void {
  if (_stallTimer) {
    clearTimeout(_stallTimer);
    _stallTimer = null;
  }
  _stallToolInFlight = false;
  _stallInflightExtensions = 0;
}

/** Test seam: is the watchdog currently armed? (Assert arm/disarm without waiting.) */
export function _stallWatchdogArmed(): boolean {
  return _stallTimer !== null;
}

/** The redirect returned when an agent session invokes `eval`. Forces the model back
 *  onto the native tool / tools:invoke / Bash triad it actually has. ESCALATES once the
 *  session has ignored the block more than EVAL_BLOCK_ESCALATE_AFTER times: a weak model
 *  that keeps reflexively re-issuing `eval` gets a hard, copy-pasteable next-action
 *  directive instead of the same polite steer. Pure. */
export function evalBlockReason(count = 1): string {
  if (count <= EVAL_BLOCK_ESCALATE_AFTER) {
    return (
      'eval-blocked: the `eval` (python) tool is DISABLED for papercusp agent sessions. ' +
      'Do NOT invoke MCP/papercusp tools through eval — call the tool NATIVELY by its name ' +
      '(e.g. call `plans:get` directly with its args), or if it is not directly callable use ' +
      'the `tools:invoke` tool ({ name, args }). For files or shell use the `Bash` tool. ' +
      'Retry your intended action with the correct tool now.'
    );
  }
  return (
    `eval-blocked (×${count}): STOP — you have called \`eval\` ${count} times and EVERY call is ` +
    'blocked. `eval` is permanently disabled for this session and will NEVER run; calling it ' +
    'again only wastes the turn. Do NOT call `eval` again. To READ YOUR PLAN, your next action ' +
    'must be EXACTLY: `tools:invoke { name: "plans:get", args: { slug: "<your plan slug>", ' +
    'harness: "papercusp" } }`. To call ANY other papercusp tool: `tools:invoke { name: ' +
    '"<group>:<verb>", args: {…} }`. For files or shell use the `Bash` tool. If you genuinely ' +
    'cannot proceed, report the blocker via `coord:send` to your launcher — but do NOT call eval.'
  );
}

/** True when the agent is invoking the interactive `ask` builtin. A spawned agent has NO
 *  human at the terminal, so `ask` cannot be answered — under a supervised/headless launch
 *  it BLOCKS or auto-resolves to its recommended option, which is how an ornith LEADER
 *  (iter10, 2026-07-04 / WI-2382) "chose" do-it-myself at its routing gate and began
 *  claiming+editing items before its owner ever answered route C. There is no omp config to
 *  disable `ask` (unlike eval.py/js) and the `--tools` whitelist also gates the papercusp
 *  MCP tools, so a tool-NAME block here is the structural lever. Strips a `group:` prefix so
 *  a namespaced verb (e.g. `x:ask`) is not swept up. Pure. */
export function isAskCall(toolName: string): boolean {
  const bare = (toolName || '').toLowerCase().replace(/[_-]/g, '').replace(/^.*:/, '');
  return bare === 'ask';
}

/** The redirect returned when an agent session invokes the interactive `ask` builtin. An
 *  agent has no live human to answer, so `ask` is never the right tool: a KICKOFF ROUTING
 *  GATE must be presented as plain TEXT and awaited (the launcher/owner sends the route as a
 *  coordination message); a genuine mid-work question goes to the durable `coord:ask-owner`
 *  path, which actually reaches the owner and never auto-defaults. Pure. */
export function askBlockReason(count = 1): string {
  const base =
    'ask-blocked: the interactive `ask` tool is DISABLED for papercusp agent sessions — you ' +
    'have no human at the terminal, so `ask` cannot be answered and auto-resolves to its ' +
    'default option (sending you down a route nobody chose). If this is your KICKOFF ROUTING ' +
    'GATE, present the options as plain TEXT and STOP — your launcher/owner will send the ' +
    'routing decision as a coordination message you act on next turn. If you genuinely need an ' +
    'owner decision mid-task, call `coord:ask-owner` (durable) — NOT `ask`. Do not call `ask` again.';
  if (count <= REFLEXIVE_BLOCK_ESCALATE_AFTER) return base;
  return (
    `ask-blocked (×${count}): STOP — you have called \`ask\` ${count} times and EVERY call is ` +
    'blocked; `ask` will NEVER be answered in this session. Do NOT call `ask` again. Present your ' +
    'routing gate as plain TEXT and end your turn, or use `coord:ask-owner` for a real owner ' +
    'decision. Continuing to call `ask` only wastes the session and will end it.'
  );
}

/** True when the agent is invoking OMP's native `irc` inter-agent chat builtin. It is NOT wired to
 *  the papercusp coordination bus (coord:*), so it always returns "No other agents" — a weak local
 *  model (ornith IQ3_M) reflexively reaches for it at KICKOFF to "find peers" and burns several
 *  turns (iter11, 2026-07-04 / WI-2382: 5× before the loop-breaker caught it) before it lands on
 *  the plan read. Same class as `ask`/`eval`: no omp-config disable, and the `--tools` whitelist
 *  also gates the papercusp MCP tools, so a tool-NAME block here is the structural lever. Strips a
 *  `group:` prefix so a namespaced verb (e.g. `x:irc`) is not swept up. Pure. */
export function isIrcCall(toolName: string): boolean {
  const bare = (toolName || '').toLowerCase().replace(/[_-]/g, '').replace(/^.*:/, '');
  return bare === 'irc';
}

/** The redirect returned when an agent session invokes the native `irc` builtin. papercusp agents
 *  coordinate through the `coord:*` MCP tools, never omp's native chat: `coord:presence` for live
 *  peers, `coord:send` to message one, `coord:orient` for your own assignments + inbox. At KICKOFF
 *  you do not need peers at all — read your plan and go through your routing gate. Pure. */
export function ircBlockReason(count = 1): string {
  const base =
    'irc-blocked: the native `irc` inter-agent chat tool is DISABLED for papercusp agent sessions — ' +
    'it is not wired to the papercusp coordination bus, so it always returns "No other agents" and ' +
    'only wastes turns. To see live peers use `coord:presence`; to message one use `coord:send`; for ' +
    'your own assignments + inbox use `coord:orient`. But at KICKOFF you do not need peers — read ' +
    'your plan with `tools:invoke {name:"plans:get", args:{slug, harness}}` and go through your ' +
    'routing gate. Do not call `irc` again.';
  if (count <= REFLEXIVE_BLOCK_ESCALATE_AFTER) return base;
  return (
    `irc-blocked (×${count}): STOP — you have called \`irc\` ${count} times and EVERY call is ` +
    'blocked; it is permanently disabled and will NEVER reach a peer. Do NOT call `irc` again — ' +
    'calling it again only wastes the turn. Your next action must be to READ YOUR PLAN: ' +
    '`tools:invoke {name:"plans:get", args:{slug:"<your plan slug>", harness:"papercusp"}}`, then ' +
    'go through your routing gate. If you truly need peers, use `coord:presence` — never `irc`.'
  );
}

/** True when an agent session is invoking its todo-list tool (`todo` / `todo_write` in any
 *  spelling). Normalizes like the other name-matchers (lowercase, strip `[_-]`, drop a `group:`
 *  prefix) so `todo`, `todo_write`, `todowrite`, `TodoWrite` all match. Deliberately does NOT match
 *  the `task*` panel tools — those are already hard-blocked (blockedTaskTools) at the top of
 *  onToolCall — so it only ever sees the LEGITIMATE todo tool. Pure. */
export function isTodoCall(toolName: string): boolean {
  const bare = (toolName || '').toLowerCase().replace(/[_-]/g, '').replace(/^.*:/, '');
  return bare === 'todo' || bare === 'todowrite';
}

/** SESSION-cumulative consecutive-todo counter with a PRODUCTIVE RESET (ornith iter19,
 *  2026-07-04 / WI-2382 — failure mode #6). Unlike eval/irc/ask, `todo_write` is a LEGITIMATE tool:
 *  omp's own guidance redirects the blocked `task` panel → "use todo_write for task tracking
 *  instead," so it can NOT be name-blocked. But a weak local model (ornith IQ3_M) doom-loops on it —
 *  iter19 leader session 10476 rewrote its todo list 264× in 7.5 min, never read its plan, never
 *  routed, 0 productive calls. The generic consecutive-identical breaker missed it for the same
 *  reason eval/irc did: each rewrite carried a DIFFERENT list, so the runs were non-adjacent. So this
 *  counter is input-AGNOSTIC (it counts consecutive todo calls regardless of content) and is RESET
 *  by any productive non-todo tool call — which distinguishes "10 varied todos in a row with no real
 *  work between" (a loop) from "10 legit todos interleaved with edits / reads / tools:invoke" (real
 *  work). Session-scoped, NOT turn-reset: each todo call is its own OMP turn, so a turn-reset would
 *  zero the run forever and it would never trip (same lesson as the eval / fleet-launch budgets). */
export const TODO_LOOP_LIMIT = 6;
/** Past this many consecutive todo calls the block MESSAGE hardens from the polite redirect to a
 *  copy-pasteable STOP (mirrors EVAL_BLOCK_ESCALATE_AFTER). Above TODO_LOOP_LIMIT so the polite
 *  redirect gets a couple of turns to land before the hard directive. */
export const TODO_LOOP_ESCALATE_AFTER = 8;
let _consecutiveTodoCalls = 0;

/** Count a consecutive todo call; returns the new run length. */
export function noteTodoCall(): number {
  return ++_consecutiveTodoCalls;
}

/** Reset the consecutive-todo run — called on ANY productive (non-todo) agent tool call, and a
 *  test seam. */
export function resetTodoLoopState(): void {
  _consecutiveTodoCalls = 0;
}

/** The redirect returned once an agent session exceeds its consecutive-todo budget. Escalates the
 *  message on repeats (mirrors askBlockReason / ircBlockReason). Pure. */
export function todoLoopReason(count: number): string {
  const base =
    `todo-loop: you have rewritten your todo list ${count} times in a row without DOING anything ` +
    'between the rewrites — tracking is not progress. STOP editing todos and take the NEXT REAL ' +
    'ACTION now: read your plan (`tools:invoke {name:"plans:get", args:{slug:"<your plan slug>", ' +
    'harness:"papercusp"}}`), present your routing gate as plain TEXT, or edit the file the task is ' +
    'about. A single todo update is fine — but only AFTER a real step. Do not call todo again until ' +
    'you have called a different, productive tool.';
  if (count <= TODO_LOOP_ESCALATE_AFTER) return base;
  return (
    `todo-loop (×${count}): STOP — ${count} straight todo rewrites, ZERO real work between them. ` +
    'Your todo list is not the task. Do NOT touch it again. Your very next call MUST be a productive ' +
    'tool: `tools:invoke {name:"plans:get", …}` to read your plan, `tools:invoke` for a real action, ' +
    'or an `edit`/`read` on the file. Rewriting your todos again only wastes the session and will end it.'
  );
}

/** SESSION-cumulative budget for blocked "curl the MCP endpoint" attempts (ornith failure
 *  mode #3, 2026-07-04 / WI-2382). A weak local model (ornith IQ3_M) that HAS the papercusp MCP
 *  tools wired still reflexively tries to reach the MCP server over HTTP — it copies the
 *  `http://127.0.0.1:9071/api/mcp?superuser=1…` endpoint straight out of its own mcp.json and
 *  `curl`s it (wrong: no session, wrong transport, and the tools are meant to be CALLED, not
 *  fetched) instead of calling `plans:get` / `tools:invoke` directly. A live corrective nudge
 *  ("that is a TOOL you call directly, not an HTTP endpoint") rescued a stuck leader this way, so
 *  this makes the rescue STRUCTURAL. Session-cumulative (not turn-scoped) for the same reason as
 *  the eval budget: each curl is its own turn and the model varies the JSON body, so a turn-reset
 *  or consecutive-identical counter would never escalate. Test-seam reset only. */
export const MCP_CURL_BLOCK_ESCALATE_AFTER = 3;
let _mcpCurlBlockCount = 0;

/** Count an MCP-endpoint-curl block for this session; returns the new cumulative total. */
export function noteMcpCurlBlock(): number {
  return ++_mcpCurlBlockCount;
}

/** Test seam: reset the session-cumulative MCP-curl block budget. */
export function resetMcpCurlBudget(): void {
  _mcpCurlBlockCount = 0;
}

/** After this many CUMULATIVE blocked MCP-endpoint curls in one session the guard gives up on
 *  prose and STRUCTURALLY terminates the session — same lever + rationale + threshold as
 *  EVAL_BLOCK_KILL_AFTER (a weak model that has ignored this many hard redirects will keep
 *  doom-looping; a fast fail + relaunch beats an unbounded hang). Reuses _haltRunawaySession, so
 *  the SIGTERM handler runs the defensive lock cleanup first. isAgentSession-gated — an owner
 *  curling the endpoint to debug is never touched (D-003). */
export const MCP_CURL_BLOCK_KILL_AFTER = 10;

/** True when a bash command is an agent trying to reach the papercusp MCP server over HTTP — by ANY
 *  client, not just curl — rather than calling the tool it wants directly. Requires BOTH an HTTP-client
 *  INVOCATION and an MCP-specific target, so a legitimate call to a real external API or an app health
 *  route — and prose that merely mentions the path (e.g. a commit message, an echo) — does NOT match.
 *  The client can be: a curl/wget/xh verb at a COMMAND position, OR a scripting HTTP client referenced
 *  anywhere in the command (python urllib/requests/httpx/aiohttp/http.client/urlopen, node
 *  fetch/axios/node-fetch, or Node's built-in http/https module — `require('http')` / `http.request(`
 *  / `https.get(`). ornith iter24 (2026-07-04 / WI-2382): a weak leader BLOCKED from `curl
 *  http://…/api/mcp` instantly evaded by POSTing the SAME endpoint via `python3 -c "import
 *  urllib.request; …"` 14× — the curl-only matcher missed it, so the doom-loop ran unbounded; iter28
 *  (2026-07-05) repeated the class via `node -e "const http=require('http'); http.request(…)"` 5× —
 *  the python/fetch tokens missed THAT, so Node http/https is now covered too. The
 *  MCP-specific targets:
 *    - `/api/mcp`   the exact MCP endpoint path (copied straight from the model's mcp.json)
 *    - `superuser=` the MCP superuser query param (MCP-only)
 *    - `:9071`      the papercusp MCP bundle-server port (agents have no other use for it)
 *    - a `/mcp` path aimed at a local host / operator port (localhost / 127.0.0.1 / :30x0 / :9071)
 *  Pure. (Name kept for import stability; it now covers any HTTP client, not only curl.) */
export function isMcpEndpointCurl(cmd: string): boolean {
  const c = (cmd || '').toLowerCase();
  // Must actually INVOKE an HTTP client — either a curl/wget/xh verb at a command position (start or
  // right after a real separator ; && || | newline ( `), NOT after a plain space, so `curl` inside a
  // quoted arg / commit message / echo does not false-positive), OR a scripting HTTP-client token
  // (python urllib/requests/…, node fetch/axios). A bare mention of the path with no client never
  // counts (an echo / commit-message reference stays un-blocked).
  const httpClient =
    /(?:^|[;&|\n(`]|&&|\|\|)\s*(?:curl|wget|xh)\b/.test(c) ||
    /\b(?:urllib|requests|httpx|aiohttp|http\.client|httplib|urlopen|node-fetch|axios)\b/.test(c) ||
    // Node's built-in http/https module via `node -e` (ornith iter28, 2026-07-05 / WI-2382): the
    // model POSTed the MCP endpoint with `require('http')` + `http.request(...)`, which the python /
    // fetch tokens above never covered — the same evasion class as the iter24 urllib pivot, via Node.
    /\bhttps?\.(?:request|get)\s*\(/.test(c) ||
    /\brequire\(\s*['"](?:node:)?https?['"]\s*\)/.test(c) ||
    /\bfetch\s*\(/.test(c);
  if (!httpClient) return false;
  if (c.includes('/api/mcp')) return true;
  if (c.includes('superuser=')) return true;
  if (c.includes(':9071')) return true;
  const local = /(localhost|127\.0\.0\.1|0\.0\.0\.0|:30\d0|:9071)/.test(c);
  if (local && /\/mcp(?:$|[/?'"\s&])/.test(c)) return true;
  return false;
}

/** The redirect returned when an agent session curls the papercusp MCP endpoint. The papercusp
 *  tools are TOOLS the model calls directly (like Bash), NOT an HTTP endpoint — this is the
 *  live-validated rescue text, made structural. ESCALATES once the session has ignored the block
 *  more than MCP_CURL_BLOCK_ESCALATE_AFTER times into a hard, copy-pasteable next action. Pure. */
export function mcpCurlBlockReason(count = 1): string {
  if (count <= MCP_CURL_BLOCK_ESCALATE_AFTER) {
    return (
      'mcp-curl-blocked: you tried to reach the Papercusp MCP server over HTTP (curl / wget / a ' +
      'python or node http client). The Papercusp tools are NOT an HTTP endpoint you fetch — they ' +
      'are TOOLS you call directly, the same way you call Bash. Do NOT curl OR script an HTTP ' +
      'request (urllib / requests / fetch) to localhost / :9071 / /api/mcp — it will never work. ' +
      'To read your plan, call `plans:get` directly (or `tools:invoke {name:"plans:get", ' +
      'args:{slug:"<your plan slug>", harness:"papercusp"}}`); for any other Papercusp tool use ' +
      '`tools:invoke {name:"<group>:<verb>", args:{…}}`. Retry your intended action as a direct ' +
      'tool call now.'
    );
  }
  return (
    `mcp-curl-blocked (×${count}): STOP — you have tried to reach the Papercusp MCP endpoint over ` +
    `HTTP ${count} times (curl and/or a python/node http client) and every attempt is blocked. The ` +
    'MCP server is NOT reachable over HTTP from here and never will be; the Papercusp tools are ' +
    'TOOLS you invoke directly. Your next action must be EXACTLY: `tools:invoke {name:"plans:get", ' +
    'args:{slug:"<your plan slug>", harness:"papercusp"}}` to read your plan, or `tools:invoke ' +
    '{name:"<group>:<verb>", args:{…}}` for any other tool. Do NOT curl OR script an HTTP request ' +
    'to localhost again. If you genuinely cannot proceed, report the blocker via `coord:send` to ' +
    'your launcher.'
  );
}

/** Known Papercusp/MCP tool GROUPS (the part before the `:` in a `group:verb` tool name). Used ONLY
 *  to recognize when a weak model has typed an MCP tool name as a bash COMMAND (ornith iter21,
 *  2026-07-04 / WI-2382 — failure mode #7). A whitelist keeps the detector from false-positiving on
 *  an ordinary shell command that merely contains a colon (a URL, a `sed 's:a:b:'`, a `time:` label).
 *  Scoped to the groups a leader/member actually reaches for at kickoff + delegation. */
const MCP_TOOL_GROUPS = new Set([
  'fleet', 'plans', 'plan_items', 'plan_item', 'coord', 'work_items', 'work_item', 'tools',
  'locks', 'memory', 'facts', 'docs', 'pot', 'rubrics', 'events', 'blueprint', 'harness',
  'recipes', 'agent_chats', 'deploy', 'scheduler', 'goals', 'topics',
]);

/** True when a bash command is really an agent trying to INVOKE a Papercusp MCP tool by typing its
 *  `group:verb` name as a shell command (ornith iter21, 2026-07-04 / WI-2382 — failure mode #7). A
 *  weak local model (IQ3_M) that loses the native tool-call path falls into calling e.g.
 *  `fleet:launch-on-plan` / `tools:invoke {…}` / `plans:get {…}` through Bash — which fails with
 *  `command not found: fleet:launch-on-plan` (exit 127) or `syntax error at end of input`, never
 *  runs the tool, and doom-loops (iter21: 20+ attempts, delegation FULLY blocked — the leader could
 *  not spawn a fleet, so ornith-as-leader was blocked). Matches a `group:verb` token at a COMMAND
 *  position (start, or right after a real separator ; && || | newline ( `) whose group is a known
 *  MCP group — so a URL (`http://…`), a `sed 's:a:b:'`, or prose that merely mentions a tool name
 *  never false-positives. Pure. */
export function extractMcpToolViaBash(cmd: string): string | null {
  const m = (cmd || '').match(
    /(?:^|[;&|\n(`]|&&|\|\|)\s*([a-z][a-z0-9_]*):([a-z][a-z0-9][a-z0-9_-]*)/i,
  );
  if (!m) return null;
  if (!MCP_TOOL_GROUPS.has(m[1].toLowerCase())) return null;
  return `${m[1].toLowerCase()}:${m[2].toLowerCase()}`;
}

export function isMcpToolViaBash(cmd: string): boolean {
  return extractMcpToolViaBash(cmd) !== null;
}

/** OMP flattens every Papercusp MCP tool to a NATIVE callable name `mcp__papercusp_su_<group>_<verb>`
 *  (server `papercusp-su` → `papercusp_su`; the `:` and any `-` in `group:verb` become `_`). A weak
 *  local model (ornith IQ3_M) routinely KNOWS the short `group:verb` name — it writes it into its
 *  reasoning — yet cannot emit it, and keeps typing that short form into bash (WI-2382 iter32:
 *  `plans:get`/`tools:invoke`/`tools:find` typed as shell, 13 flailing calls, never once emitting the
 *  native form). The very NEXT fresh sample (iter33) succeeded the instant it emitted
 *  `mcp__papercusp_su_plans_get` DIRECTLY. So handing the model that exact native name is the
 *  difference-maker between the fail and the success. Pure. */
export function nativeMcpToolName(groupVerb: string): string {
  return `mcp__papercusp_su_${groupVerb.trim().toLowerCase().replace(/[:-]/g, '_')}`;
}

/** Dedicated escalation counter for failure mode #7 (the block MESSAGE hardens on repeats). The
 *  structural HALT is delegated to the SHARED reflexive backstop (noteReflexiveBlock at the call
 *  site), so this needs no own kill threshold. Session-cumulative (each attempt is its own turn and
 *  the commands vary, so a turn-reset or consecutive-identical counter would never escalate — same
 *  reason as the eval / curl budgets). Test-seam reset only. */
export const MCP_TOOL_VIA_BASH_ESCALATE_AFTER = 3;
let _mcpToolViaBashCount = 0;

/** Count an MCP-tool-via-bash block for this session; returns the new cumulative total. */
export function noteMcpToolViaBashBlock(): number {
  return ++_mcpToolViaBashCount;
}

/** Test seam: reset the #7 escalation counter. */
export function resetMcpToolViaBashBudget(): void {
  _mcpToolViaBashCount = 0;
}

/** The redirect returned when an agent types an MCP tool name as a bash command. Papercusp tools are
 *  TOOLS the model calls directly (like Bash / read / edit), NEVER shell commands — this is the
 *  structural version of the live nudge that rescues a stuck leader. ESCALATES past
 *  MCP_TOOL_VIA_BASH_ESCALATE_AFTER into a hard, copy-pasteable direct-tool-call directive. Pure. */
export function mcpToolViaBashReason(count = 1, groupVerb?: string): string {
  // Name the EXACT native tool the model must emit (WI-2382 iter32→33): a weak model knows the short
  // `group:verb` but not the flattened `mcp__papercusp_su_*` form omp actually exposes — handing it
  // that exact name is what turns the flail into a call.
  const nativeHint = groupVerb
    ? ` The tool you typed (\`${groupVerb}\`) is exposed to you under the EXACT native name ` +
      `\`${nativeMcpToolName(groupVerb)}\` — emit THAT tool name directly (the \`${groupVerb}\` colon ` +
      'form only works INSIDE a tool call, never as a shell command).'
    : '';
  if (count <= MCP_TOOL_VIA_BASH_ESCALATE_AFTER) {
    return (
      'mcp-tool-via-bash blocked: you tried to run a Papercusp tool (a `group:verb` name like ' +
      '`fleet:launch-on-plan`) as a SHELL command. Papercusp tools are NOT shell commands and are ' +
      'NOT available in bash — they are TOOLS you call DIRECTLY, the same way you call Bash / read / ' +
      'edit. Do NOT wrap them in bash, python, echo, heredocs, or the `omp` CLI.' +
      nativeHint +
      ' To launch a fleet, call the tool directly: `tools:invoke {name:"fleet:launch-on-plan", ' +
      'args:{name:"<fleet>", plan:"<plan-slug>", count:2, agent:"omp"}}`. To read your plan: ' +
      '`tools:invoke {name:"plans:get", args:{slug:"<plan-slug>", harness:"papercusp"}}`. Retry as a ' +
      'DIRECT tool call now — not through bash.'
    );
  }
  return (
    `mcp-tool-via-bash blocked (×${count}): STOP — you have tried ${count} times to invoke a ` +
    'Papercusp tool through the shell and EVERY attempt fails (`command not found` / `syntax ' +
    'error`). The shell will NEVER run a `group:verb` tool.' +
    nativeHint +
    ' Emit a DIRECT tool call instead — e.g. `tools:invoke {name:"fleet:launch-on-plan", ' +
    'args:{name:"<fleet>", plan:"<plan-slug>", count:2, agent:"omp"}}` (or the tool you need via ' +
    '`tools:invoke {name:"<group>:<verb>", args:{…}}`). Do NOT type the tool into bash again. If you ' +
    'truly cannot emit a tool call, report the blocker via `coord:send` to your launcher.'
  );
}

/** The steer returned when the loop-breaker trips — names the repeated tool and
 *  the run length and redirects by tool family (resolve / shell / generic). Pure. */
export function loopBreakReason(toolName: string, count: number): string {
  const t = toolName.toLowerCase();
  const head =
    `loop-breaker: you have called \`${toolName}\` ${count} times in a row with identical ` +
    'arguments and it is not making progress — STOP repeating it. ';
  if (t === 'resolve') {
    return (
      head +
      'The `resolve` tool only applies a PENDING preview action; you have none, so it is a ' +
      'no-op every time. To read a plan call `plans:get {slug, harness}` directly; to call any ' +
      'other tool use `tools:invoke {name, args}`. Do NOT call `resolve` again.'
    );
  }
  if (t.startsWith('bash') || t === 'shell') {
    return (
      head +
      'Re-running the same shell command returns the same result. To find a file use the `read` / ' +
      '`grep` / `ls` file tools (or `docs:search` for docs), not a repeated `find`. If the file ' +
      'genuinely is not there, change your approach or report the blocker — do not loop.'
    );
  }
  return (
    head +
    'Read the previous result and change your approach: a different tool, different arguments, or ' +
    'report the blocker. Repeating the identical call will keep failing.'
  );
}

export async function onToolCall(
  event: ToolCallEvent,
  ctx?: unknown,
): Promise<{ block?: boolean; reason?: string }> {
  const blockedTaskTools = new Set(['task', 'taskcreate', 'taskupdate', 'taskget', 'tasklist']);
  if (blockedTaskTools.has(event.toolName.toLowerCase())) {
    // Bound a reflexive task-tool loop (ornith iter26, 2026-07-04 / WI-2382 — failure mode #10): a
    // weak leader trying to DELEGATE reaches for the Claude task/subagent tool, gets this block, and
    // re-issues it despite the block (iter26: 131×, thrashing). This block predated the shared
    // reflexive backstop and was never wired to it — so it never halted. Feed noteReflexiveBlock so a
    // reflexive task-loop self-terminates at REFLEXIVE_BLOCK_KILL_AFTER (same as irc/ask/eval).
    // isAgentSession-gated so an owner's own session is blocked but never SIGTERM'd (D-003). The
    // redirect now points a DELEGATING leader at the RIGHT tool (fleet:launch-on-plan), not just the
    // task-TRACKING tool (todo_write) — the old message was useless for the delegation case.
    if (isAgentSession()) noteReflexiveBlock('task');
    return {
      block: true,
      reason:
        'The Claude task / subagent tools are DISABLED in OMP and will never work here. To DELEGATE ' +
        'work to a fleet, call `tools:invoke {name:"fleet:launch-on-plan", args:{name:"<fleet>", ' +
        'plan:"<plan-slug>", count:<n>, agent:"omp", model:"<your own local model>"}}` (the member ' +
        'model must match yours). To TRACK your own tasks, use `todo_write`. Do NOT call the ' +
        'task/subagent tools again.',
    };
  }

  // EI-10939 — tauri-agent-tools target guard. Deliberately NOT gated on
  // isAgentSession(): EI-7872 established that the agent-session marker is silently
  // unset in fleet-launched sessions — exactly the ones doing unattended UI
  // verification, i.e. the ones most likely to drive the wrong webview. The resource
  // being protected is the OWNER'S LIVE APP (not a tree, not a schedule), and the
  // deny is satisfiable with one flag, so it applies to every session this hook sees.
  // EI-18695939815676668: isShellTool (bash* OR `shell`), not the narrower
  // startsWith('bash') — OMP's shell tool is reachable under both spellings,
  // and these two guards protect genuinely shared state (the owner's live
  // app; the whole host's service plane), so a spelling-shaped hole would
  // silently defeat them for a `shell`-named call. No false-positive risk: a
  // `shell` call with no `command` string leaves bashCmd empty and both
  // denial checks no-op.
  if (isShellTool(event.toolName)) {
    const bashCmd = typeof event.input?.command === 'string' ? (event.input.command as string) : '';
    const tauriDenial = tauriTargetDenial(bashCmd);
    if (tauriDenial) return { block: true, reason: tauriDenial };

    // EI-13135 — systemd user-manager exit/kill guard. Deliberately NOT gated
    // on isAgentSession(), same rationale as the tauri-agent-tools guard just
    // above: the protected resource is the whole host's service plane, not
    // scoped to a tree or a fragile session marker.
    const exitOp = systemdExitCommandOp(bashCmd);
    if (exitOp) return { block: true, reason: systemdExitDenyReason(exitOp) };
  }

  // Native-scheduler lockout (native-scheduler-lockout-2026-06-09 P-010): an
  // AGENT session must schedule wakes ONLY via the harness routines table
  // (pot:declare-wake) — never a persistent OS scheduler, which outlives the
  // hive as a zombie that Pause/`pot:status`/the liveness backstop can't see.
  // omp has no first-class scheduler tool (toolset audit 2026-06-09), so its
  // whole exposure is the shell — deny at command position (start / after
  // ;&|/newline / sudo) so prose args ("look at this") never false-positive.
  // Gated on the agent-session marker env: the owner's own sessions never set
  // it (D-003) and stay fully unrestricted. Local decision, no operator call.
  // EI-18695939815676668: isShellTool, not startsWith('bash') — same
  // spelling-hole rationale as the tauri/systemd guard above; this block also
  // gates the git/mcp-curl/mcp-tool-via-bash guards nested below it.
  if (
    isAgentSession() &&
    isShellTool(event.toolName)
  ) {
    const cmd = typeof event.input?.command === 'string' ? (event.input.command as string) : '';
    if (isOsSchedulerCommand(cmd)) {
      // EI-21924747520941481: only timer-backed systemd-run forms reach this
      // branch; transient units/scopes are intentionally allowed.
      return { block: true, reason: osSchedulerDenyReason(cmd) };
    }
    // EI-2376 follow-up (a): the shell hook's destructive tree-wide git guard,
    // mirrored here so OMP agent sessions get the same protection (the shell
    // hook only fires for Claude/Codex's shell-subprocess PreToolUse contract).
    const gitOp = destructiveGitCommandOp(cmd);
    if (gitOp) {
      return { block: true, reason: destructiveGitDenyReason(gitOp) };
    }
    // MCP-endpoint-curl guard (ornith failure mode #3, 2026-07-04 / WI-2382): a weak local model
    // that HAS the papercusp MCP tools wired still reflexively curls the MCP server's HTTP endpoint
    // (it copies http://127.0.0.1:9071/api/mcp?superuser=1… out of its own mcp.json) instead of
    // calling plans:get / tools:invoke directly — a stuck leader was rescued live by "that is a TOOL
    // you call directly, not an HTTP endpoint," so make that rescue structural. Block the curl (it
    // would fail anyway — no session, wrong transport) and return the redirect; escalate the message
    // on repeats, and after MCP_CURL_BLOCK_KILL_AFTER cumulative ignored blocks self-terminate the
    // runaway session (same lever + rationale as the eval doom-loop guard — a varied JSON body dodges
    // the consecutive-identical breaker, so this needs its own session-cumulative counter). Agent
    // sessions only (owner debugging with curl is never touched, D-003).
    if (isMcpEndpointCurl(cmd)) {
      const n = noteMcpCurlBlock();
      if (n >= MCP_CURL_BLOCK_KILL_AFTER) {
        _haltRunawaySession(`mcp-curl doom-loop: ${n} blocked MCP-endpoint curls in one session`);
      }
      return { block: true, reason: mcpCurlBlockReason(n) };
    }
    // MCP-tool-via-bash guard (ornith iter21, 2026-07-04 / WI-2382 — failure mode #7): a weak local
    // model that loses the native tool-call path types the MCP tool NAME as a shell command
    // (`fleet:launch-on-plan`, `tools:invoke {…}`, `plans:get {…}`) — which fails with `command not
    // found` / `syntax error at end of input`, never runs the tool, and doom-loops. iter21's leader
    // did this 20+ times and could NOT delegate (fleet:launch-on-plan never fired → no members
    // spawned → route C failed). Block it (it fails anyway) and return the "call it as a DIRECT tool,
    // not bash" redirect — the structural version of the live nudge. Feeds the SHARED reflexive
    // backstop (noteReflexiveBlock) so the doom-loop self-terminates after REFLEXIVE_BLOCK_KILL_AFTER,
    // and a dedicated counter escalates the message. Placed after the curl guard (a curl to /api/mcp
    // is caught there first). Owner sessions unrestricted (D-003).
    const mcpToolInBash = extractMcpToolViaBash(cmd);
    if (mcpToolInBash) {
      const n = noteMcpToolViaBashBlock();
      noteReflexiveBlock('mcp-bash');
      return { block: true, reason: mcpToolViaBashReason(n, mcpToolInBash) };
    }
  }

  // Registry verdict — resource holds + bash→tool substitutions (P-017). LAST of
  // the Bash guards on purpose: every guard above is a local regex that costs
  // nothing, so a command they already refuse must not first pay an HTTP
  // round-trip. Two questions, one call (locks:check_command).
  //
  // Gating differs per answer, and deliberately so:
  //  • RESOURCE (`decision === 'block'`) is UNGATED — same rationale as the
  //    tauri and systemd guards just above, and the same as the shell hook,
  //    which checks it for every session: the protected thing is a SHARED
  //    resource mid restart/migration, so who typed the command is irrelevant.
  //  • SUBSTITUTION is agent-gated (D-003). It is a routing discipline for
  //    agents; denying an owner's `cat` would be a papercut, and an advisory to
  //    an owner is noise. The pre-filter is agent-gated to match, so an owner
  //    session pays no round-trip for a command only a substitution row claims.
  //
  // Resource wins when both fire: an exclusive hold means a peer is mid
  // restart/migration RIGHT NOW (a live collision), whereas a substitution is a
  // lasting suggestion about tool choice — surfacing the lesson would bury the
  // emergency. Same precedence, and the same reason, as the shell hook.
  //
  // `isShellTool` (bash* OR `shell`), not the `startsWith('bash')` the older
  // guards above use: OMP's shell tool is reachable under both spellings — the
  // loop-breaker and the per-turn shell budget both accept `shell` — and a gate
  // that misses a spelling is enforced NOWHERE for it, silently. Widening costs
  // nothing: a `shell` call that carries no `command` string leaves `cmd` empty
  // and the whole block no-ops. (The narrower gate on the guards above is
  // pre-existing and shares this hazard — filed separately, not changed here.)
  if (isShellTool(event.toolName)) {
    const cmd = typeof event.input?.command === 'string' ? (event.input.command as string) : '';
    const agent = isAgentSession();
    if (cmd && (resourcePrefilterHit(cmd) || (agent && substitutionPrefilterHit(cmd)))) {
      // Fail-open throughout: a null verdict (detached / slow / malformed
      // operator) leaves the command exactly as it was before this block.
      const inputCwd = typeof event.input?.cwd === 'string' ? event.input.cwd.trim() : '';
      const cwd = inputCwd || contextCwd(ctx) || process.cwd();
      const verdict = await checkCommandVerdict(cmd, cwd);
      if (verdict) {
        if (verdict.decision === 'block') {
          return { block: true, reason: resourceBlockReason(verdict.matched) };
        }
        const subs = Array.isArray(verdict.substitutions) ? verdict.substitutions : [];
        if (agent && subs.length > 0) {
          if (verdict.substitutionTier === 'deny') {
            return { block: true, reason: substitutionDenyReason(subs) };
          }
          if (verdict.substitutionTier === 'advise') {
            // SOFT: the command proceeds as issued; the lesson rides out on the
            // next tool_result as a non-interrupting followUp.
            stageSubstitutionAdvisory(substitutionAdvisoryText(subs));
          }
        }
      }
    }
  }

  // Off-ramp closure (weak-model-tool-tier-2026-07-01 / ornith-coordination): CLOSE OMP's native
  // search_tool_bm25 for agent sessions and REDIRECT to tools:find. The trimmed surface hands a
  // weak/local model (e.g. ornith IQ3_M) tools:find + tools:invoke as its ONLY discovery path —
  // everything else stays reachable THROUGH them. search_tool_bm25 is a competing keyword search
  // that (a) a weak model reaches for despite the prompt telling it not to, and (b) dumps dozens
  // of tool schemas into context, after which the model mangles its NEXT tool-call JSON (the
  // D-010 retry storm). So don't just block it — run tools:find with the model's own query and
  // hand back the top matches inline: the model is forced onto tools:find→tools:invoke AND still
  // gets its answer this turn. Gated on the agent-session marker (owner sessions unrestricted, D-003).
  if (isAgentSession() && isNativeToolSearch(event.toolName)) {
    return { block: true, reason: await buildToolFindRedirect(event.input) };
  }

  // eval doom-loop guard (ornith run-3, 2026-07-04 / WI-2299): a weak local model
  // reaches for a raw `eval`/python tool to "call" a tool as code — session 10177
  // did it ~148× ("(no output)" each time) and never reached plans:get or the gate.
  // The consecutive-identical breaker below never caught it (each eval carried
  // different code, so the runs were non-adjacent), so block by tool-NAME on call
  // #1 and redirect onto the native tool / tools:invoke / Bash triad. Placed with
  // the specific guards so it wins before the generic loop-breaker. Owner sessions
  // unrestricted (D-003). After EVAL_BLOCK_KILL_AFTER cumulative ignored blocks the
  // prose escalation has demonstrably failed (iter14=139×), so structurally terminate
  // the runaway session instead of returning yet another STOP it will ignore (WI-2382).
  if (isAgentSession() && isEvalCall(event.toolName)) {
    const n = noteEvalBlock();
    if (n >= EVAL_BLOCK_KILL_AFTER) {
      _haltRunawaySession(`eval doom-loop: ${n} blocked eval calls in one session`);
    }
    return { block: true, reason: evalBlockReason(n) };
  }

  // ask-gate guard (ornith iter10, 2026-07-04 / WI-2382): a spawned agent has NO human at the
  // terminal, so the interactive `ask` builtin cannot be answered — under a supervised launch it
  // auto-resolves to its recommended option, which is how an ornith LEADER "chose" do-it-myself at
  // its routing gate and began hoarding items before the owner ever answered route C. `ask` has no
  // omp-config disable (unlike eval) and the `--tools` whitelist also strips the papercusp MCP
  // tools, so this tool-NAME block is the structural lever: present the routing gate as TEXT and
  // wait for the owner's coord decision; use coord:ask-owner for a genuine mid-task question. A
  // structural replacement for prompt-only steering (a weak model ignores prose — same lesson as
  // eval). Feeds the SHARED reflexive-block backstop (noteReflexiveBlock): the escalating message
  // hardens past the threshold and, after REFLEXIVE_BLOCK_KILL_AFTER blocked reflexive calls, the
  // session self-terminates — the generic identical-call breaker is NOT enough (iter16 proved it:
  // 482 blocked `irc` calls slipped past it, so `ask` gets the same halt). Owner sessions
  // unrestricted (D-003).
  // PUI connects the native rpc-ui callbacks to an owner-operated card. It
  // still carries the managed-session marker, but the no-UI premise of this
  // guard does not apply. Require both the native transport and its attached
  // UI context; a bare rpc/headless or unattended terminal keeps this guard.
  const hasRpcQuestionUi = (ctx as { hasUI?: boolean } | undefined)?.hasUI === true
    && process.argv.some((arg, index, argv) => arg === '--mode' && argv[index + 1] === 'rpc-ui');
  if (isAgentSession() && isAskCall(event.toolName) && !hasRpcQuestionUi) {
    const n = noteReflexiveBlock('ask');
    return { block: true, reason: askBlockReason(n) };
  }

  // irc-distraction guard (ornith iter11, 2026-07-04 / WI-2382): OMP's native `irc` inter-agent
  // chat builtin is NOT wired to the papercusp coord bus (coord:*), so it always returns "No other
  // agents" — a weak local model reaches for it at KICKOFF to "find peers" and burns several turns
  // (iter11: 5× before the generic loop-breaker caught it) before reading its plan. Same class as
  // eval/ask (no omp-config disable; `--tools` gates the MCP tools too), so block by tool-NAME on
  // call #1 and redirect onto coord:presence / the plan read. Fires before the generic loop-breaker
  // so it wins at call #1. That generic breaker is NOT a sufficient backstop here: iter16
  // (2026-07-04) a leader hammered `irc` 482× — 0 progress, never read its plan — and the
  // consecutive-identical breaker missed it (the calls varied just enough to be non-adjacent, the
  // exact reason eval needed its own counter). So `irc` feeds the SHARED reflexive-block backstop
  // (noteReflexiveBlock): the message escalates past the threshold and the session self-terminates
  // after REFLEXIVE_BLOCK_KILL_AFTER blocked reflexive calls. Owner sessions unrestricted (D-003).
  if (isAgentSession() && isIrcCall(event.toolName)) {
    const n = noteReflexiveBlock('irc');
    return { block: true, reason: ircBlockReason(n) };
  }

  // todo doom-loop guard (ornith iter19, 2026-07-04 / WI-2382 — failure mode #6): `todo_write` is a
  // LEGITIMATE tool (omp redirects the blocked `task` panel → "use todo_write instead"), so unlike
  // eval/irc/ask it can NOT be name-blocked. But a weak local model doom-loops on it — iter19 leader
  // rewrote its todo list 264× in 7.5 min, 0 productive calls, never read its plan. The generic
  // consecutive-identical breaker below missed it (each rewrite carried a different list, so the runs
  // were non-adjacent — the same reason eval/irc needed their own counters). So RATE-LIMIT with an
  // input-agnostic consecutive-todo counter that ANY productive non-todo tool call RESETS (the else
  // branch): legit interleaved todos never accumulate, but a pure rewrite loop trips past
  // TODO_LOOP_LIMIT and is blocked with an escalating "take the next real action" redirect. Feeds the
  // SHARED reflexive-block backstop (noteReflexiveBlock) so a leader that ignores the redirect
  // self-terminates after REFLEXIVE_BLOCK_KILL_AFTER cumulative reflexive blocks (a pure todo loop
  // halts at ~16 calls). Placed before the generic breaker so the reset runs on every real tool call.
  // Owner sessions unrestricted (D-003).
  if (isAgentSession()) {
    if (isTodoCall(event.toolName)) {
      const n = noteTodoCall();
      if (n > TODO_LOOP_LIMIT) {
        noteReflexiveBlock('todo');
        return { block: true, reason: todoLoopReason(n) };
      }
    } else {
      resetTodoLoopState();
    }
  }

  // Fleet-launch member-model guard (ornith iter22, 2026-07-04 / WI-2382 — failure mode #8): a
  // LOCAL-model (ornith) agent that launches a fleet WITHOUT pinning a local member model silently
  // spawns CLOUD `claude` members (fleet:launch-on-plan's default), NOT its own model — iter22's
  // leader dropped agent:"omp" and launched 2 claude members invisibly, invalidating the ornith-
  // member test. Enforce it structurally: if THIS session runs a local model but the launch omits a
  // local member model, BLOCK with a re-call-with-model redirect naming the session's own model.
  // Placed BEFORE the generic consecutive-identical breaker (not just before the budget check
  // below): a wrong-model retry loop calls fleet:launch-on-plan with THE SAME (wrong) args every
  // time, so the generic breaker would otherwise intercept it at its own IDENTICAL_CALL_LOOP_LIMIT
  // (3) with an unrelated "loop-breaker" reason — starving this guard's OWN shared reflexive-block
  // backstop (below REFLEXIVE_BLOCK_KILL_AFTER) of the counts it needs to ever reach its threshold,
  // and (separately) meaning a corrected retry right after 3 identical wrong-model attempts would
  // still read as "the 4th identical repeat" and get generic-breaker-blocked instead of allowed.
  // Feeds the shared reflexive backstop so a leader that keeps launching wrong-model self-halts.
  // Only fires for a local-model session (a cloud omp session is untouched) and only in agent
  // sessions (D-003).
  if (isAgentSession() && isFleetLaunchCall(event.toolName, event.input)) {
    const own = getOwnLaunchedModel();
    if (own && isLocalModel(own) && !isLocalModel(fleetLaunchMemberModel(event.input))) {
      noteReflexiveBlock('fleet-model');
      return { block: true, reason: fleetLaunchModelReason(own) };
    }
  }

  // Backlog-wandering containment (ornith iter27, 2026-07-04 / WI-2382 → WI-2046 — failure mode #11):
  // a LOCAL-model (ornith) agent meant to work its ASSIGNED behaviour-test plan instead called
  // work_items:claim_next, which pulls a RANDOM item off the SHARED REAL backlog — it grabbed the
  // live WI-2046 and then FALSELY marked it done, corrupting real project state (had to be reopened
  // by hand). A weak local model cannot be trusted to correctly complete + close a real backlog item
  // it self-selected, so deny the blind pull on call #1 with a work-your-assigned-plan redirect
  // (a specifically-assigned item is still reachable by id via work_items:claim — only the blind
  // "next available" pull is blocked). Feeds the shared reflexive backstop so a leader that ignores
  // the redirect self-halts after REFLEXIVE_BLOCK_KILL_AFTER. Scoped to LOCAL-model sessions,
  // mirroring the fleet-model guard above: getOwnLaunchedModel fails OPEN, so an indeterminate/cloud
  // model is never blocked. Agent sessions only (D-003).
  if (isAgentSession() && isClaimNextCall(event.toolName, event.input)) {
    if (isLocalModel(getOwnLaunchedModel())) {
      noteReflexiveBlock('claim-next');
      return { block: true, reason: claimNextBlockReason() };
    }
  }

  // Doom-loop breaker (ornith-reliability-2026-07-03 / EI-7076 + EI-7092): block the
  // Nth CONSECUTIVE identical (toolName+args) call from an agent session — the
  // deterministic backstop against a weak model wedging in a degenerate tool loop.
  // Placed AFTER the specific bash/tool-search guards so their (more precise) refusal
  // wins at call #1; this generic backstop only fires once a call has repeated
  // identically IDENTICAL_CALL_LOOP_LIMIT times. Owner sessions unrestricted (D-003).
  if (isAgentSession()) {
    const runLen = noteToolCallRepeat(toolCallLoopKey(event.toolName, event.input));
    if (runLen >= IDENTICAL_CALL_LOOP_LIMIT) {
      return { block: true, reason: loopBreakReason(event.toolName, runLen) };
    }
    // Session-cumulative consecutive-repeat breaker (ornith iter25 / WI-2382 — failure mode #9): the
    // turn-scoped breaker above is BLIND to a cross-turn loop (each omp tool call is its own turn, so
    // resetToolCallLoopState zeros it every turn_start). Track the run of identical (noise-stripped)
    // calls that SURVIVES turn boundaries; past SESSION_REPEAT_LIMIT the same call is clearly stuck
    // (iter25: plans:get 58× on harness_required, the model tweaking only its prose `i`). Block with a
    // read-the-error / fix-your-args redirect and feed the shared reflexive backstop so a pure
    // error-loop self-terminates. A genuinely different call resets the run, so varied work is safe.
    const repeatRun = noteSessionRepeat(sessionRepeatKey(event.toolName, event.input));
    if (repeatRun >= SESSION_REPEAT_LIMIT) {
      noteReflexiveBlock('repeat');
      return { block: true, reason: sessionRepeatReason(event.toolName, repeatRun) };
    }
    // Per-turn shell budget (EI-7092 wandering-search half): once an agent session
    // has spent its shell budget this turn, block further `bash`/`shell` calls with a
    // converge-or-report steer. Only shell is throttled — read/grep/tools:invoke/
    // coord:send stay open so the model can still finish or report. Placed after the
    // specific bash guards (git/scheduler) so those still win at call #1.
    if (isShellTool(event.toolName) && noteShellCall() > SHELL_CALLS_PER_TURN_LIMIT) {
      return { block: true, reason: shellBudgetReason(_shellCallsThisTurn) };
    }
    // Session-cumulative fleet-launch budget (ornith run-10): the launch verb is
    // one-shot; a weak leader re-calling it between checkpoints dodges the
    // consecutive-identical breaker (each repeat is non-adjacent). Past the budget,
    // block with a supervise-instead steer. Counted across turns on purpose. The
    // member-model guard above already returned for a wrong-model call, so reaching
    // here means either the model was fine or this session's own model is not local
    // (untouched) — either way a corrected retry does NOT burn the launch budget.
    // Feed the SHARED reflexive backstop (ornith iter35, 2026-07-05 / WI-2382 — gap A):
    // this was the ONE repeat-class guard NOT wired to noteReflexiveBlock, so a leader
    // that reflexively re-issued the launch PAST the budget was blocked every time yet
    // NEVER self-terminated (iter35's leader looped on fleet-launch instead of concluding;
    // the budget block, unlike eval/irc/ask/todo/claim-next/fleet-model, gave the reflexive
    // halt no counts). Now a launch doom-loop halts at REFLEXIVE_BLOCK_KILL_AFTER like its
    // siblings. Only fires INSIDE the over-budget branch, so calls #1-2 never feed the halt.
    if (
      isFleetLaunchCall(event.toolName, event.input) &&
      noteFleetLaunchCall() > FLEET_LAUNCH_CALLS_PER_SESSION
    ) {
      noteReflexiveBlock('fleet-launch');
      return { block: true, reason: fleetLaunchBudgetReason(_fleetLaunchCalls) };
    }
  }

  const targets = extractLockTargets(event.toolName, event.input);
  if (targets.length === 0) return {};

  // ── Worktree discipline: only the canonical staging tree is editable ──
  // extractLockTargets already kept ONLY worktrees that are direct children
  // of the workspace root (papercusp, papercup-staging, papercup-release, old
  // feature worktrees, …). The canonical staging tree (papercusp) is the ONE
  // tree agents edit — its changes are what git-sync auto-commits + deploys.
  // Work left in any sibling worktree never reaches the committed tree (it
  // stranded a whole feature on 2026-06-30). Refuse such an edit. Isolation
  // worktrees under <tree>/.papercusp/worktrees/ have a non-workspace-root
  // parent, so extractLockTargets already dropped them — they pass through;
  // foreign repos are likewise untouched. Mirrors the cc hook's guard;
  // fail-open on any error (a guard must never wedge an edit on its own bug).
  try {
    const ws = workspaceRoot();
    const canonicalTree = canonicalTreeRoot(ws);
    // WI-5031: best-effort `origin` fetch URL for ANY repo shape — ordinary
    // clone (.git dir), linked worktree (.git file → gitdir → commondir), or
    // submodule (.git file → gitdir with its own config). null on ANY failure.
    // Lets the guard tell a stray checkout of the CANONICAL project apart from
    // an INDEPENDENT repo (papercup-rust-mobile) that merely lives in the
    // workspace dir. Parses .git/config directly — no git subprocess on the
    // per-edit hot path. Mirrors the cc hook's _repo_origin_url/_norm_origin
    // (parity contract; keep in sync).
    const repoOriginUrl = (repoRoot: string): string | null => {
      try {
        const gitEntry = join(repoRoot, '.git');
        let cfgPath: string;
        if (statSync(gitEntry).isFile()) {
          const m = /^gitdir:\s*(.+)$/.exec(readFileSync(gitEntry, 'utf8').trim());
          if (!m) return null;
          let gd = m[1].trim();
          if (!gd.startsWith('/')) gd = join(repoRoot, gd);
          gd = realpathSync(gd);
          cfgPath = join(gd, 'config');
          if (!existsSync(cfgPath)) {
            // Linked worktree: config lives in the COMMON git dir.
            const cdPath = join(gd, 'commondir');
            if (!existsSync(cdPath)) return null;
            let cd = readFileSync(cdPath, 'utf8').trim();
            if (!cd.startsWith('/')) cd = join(gd, cd);
            cfgPath = join(realpathSync(cd), 'config');
          }
        } else {
          cfgPath = join(gitEntry, 'config');
        }
        let inOrigin = false;
        for (const line of readFileSync(cfgPath, 'utf8').split('\n')) {
          const s = line.trim();
          if (s.startsWith('[')) inOrigin = s.replace(/\s+/g, '') === '[remote"origin"]';
          else if (inOrigin && s.includes('=') && s.slice(0, s.indexOf('=')).trim() === 'url') {
            const v = s.slice(s.indexOf('=') + 1).trim();
            return v || null;
          }
        }
        return null;
      } catch {
        return null;
      }
    };
    const normalizeOriginUrl = (url: string | null): string | null => {
      if (!url) return null;
      let u = url.trim().replace(/\/+$/, '');
      if (u.toLowerCase().endsWith('.git')) u = u.slice(0, -4);
      const m = /^(?:git@|ssh:\/\/(?:git@)?|https?:\/\/|git:\/\/)([^/:]+)[:/](.*)$/.exec(u);
      return m ? `${m[1]}/${m[2]}`.toLowerCase() : u.toLowerCase();
    };
    for (const t of targets) {
      const scopeRoot = workspaceRepoRoot(t.root, ws);
      if (scopeRoot === null) continue;
      let rr: string;
      try {
        rr = realpathSync(scopeRoot);
      } catch {
        rr = scopeRoot;
      }
      if (rr !== canonicalTree) {
        const linkedMain = resolveWorktreeMainRoot(scopeRoot);
        if (linkedMain !== null) {
          let linkedMainReal: string;
          try {
            linkedMainReal = realpathSync(linkedMain);
          } catch {
            linkedMainReal = linkedMain;
          }
          if (linkedMainReal === canonicalTree) {
            return {
              block: true,
              reason:
                `worktree guard: refused — '${scopeRoot}' is a LINKED WORKTREE of ` +
                `the canonical staging tree (${canonicalTree}), registered ` +
                `outside it. Agents edit ONLY the canonical tree itself; work ` +
                `left in any of its linked worktrees is never committed by ` +
                `git-sync (it silently strands). cd into the canonical tree ` +
                `and make this edit there.`,
            };
          }
        }
        // WI-5031: a sibling is only a stranding hazard when it is a checkout
        // of the SAME project as the canonical tree — git-sync commits only
        // the canonical tree, so work left in same-project siblings dies. An
        // INDEPENDENT repo with a provably different origin remote is
        // legitimate to edit and falls through to normal lock coordination.
        // Unreadable origins keep the old refusal (conservative).
        const sibOrigin = normalizeOriginUrl(repoOriginUrl(scopeRoot));
        const canonOrigin = normalizeOriginUrl(repoOriginUrl(canonicalTree));
        if (sibOrigin !== null && canonOrigin !== null && sibOrigin !== canonOrigin) {
          continue;
        }
        return {
          block: true,
          reason:
            `worktree guard: refused — you are editing in '${scopeRoot}', which ` +
            `is not the canonical staging tree. Agents edit ONLY the shared ` +
            `staging tree (${canonicalTree}); other worktrees are off-limits ` +
            `because work left in them never reaches the auto-committed tree. ` +
            `cd into the staging tree and make this edit there. (An INDEPENDENT ` +
            `sibling repo — one whose \`origin\` remote provably differs from ` +
            `the canonical tree's — is exempt; this tree's origin matches the ` +
            `canonical project or could not be read.)`,
        };
      }
    }
  } catch {
    /* guard must never wedge an edit on its own error (fail-open) */
  }

  // Symlink refusal (file-locking #1) — runs BEFORE the acquire. The
  // operator keys locks on the path string and cannot see that two
  // strings alias one file; the hook, running on the agent's
  // filesystem, can. Detection is grouped by worktree root: a key is
  // relative to its own root, so realpath-ing it needs that root (a
  // single tool call may, in principle, span more than one worktree).
  // A local decision: no operator round-trip, so no health marker (like
  // the targets.length === 0 short-circuit above).
  const byRoot = new Map<string, string[]>();
  for (const t of targets) {
    const rels = byRoot.get(t.root);
    if (rels) rels.push(t.rel);
    else byRoot.set(t.root, [t.rel]);
  }
  const symlinked: Array<{ given: string; real: string }> = [];
  for (const [root, rels] of byRoot) {
    symlinked.push(...detectSymlinkedPaths(rels, root));
  }
  if (symlinked.length > 0) {
    return { block: true, reason: formatSymlinkRefusal(symlinked) };
  }

  // Lock keys are worktree-relative, so the same file claimed through
  // two worktrees collapses to one key. Shared with
  // extractPathsFromToolInput so a test of that projection covers THIS
  // payload — see lockKeysFromTargets' note on why they must not diverge.
  const paths = lockKeysFromTargets(targets);

  // targets was non-empty (the no-target case returned above), so an empty
  // key list here is an INTERNAL INVARIANT VIOLATION, not a benign no-op.
  // It means enforcement is silently off for this edit, which is exactly
  // the state that persisted undetected for a whole session. Fail open —
  // a harness bug must never wedge the agent — but never silently.
  if (paths.length === 0) {
    console.error(
      `[su-locks] INVARIANT: ${targets.length} lock target(s) produced 0 keys; ` +
        'lock enforcement is OFF for this tool call (failing open)',
    );
    await recordRequestDefect({
      handler: 'tool_call',
      detail:
        `lock-key derivation produced 0 keys from ${targets.length} target(s) ` +
        `for tool '${event.toolName}' — enforcement silently disabled`,
    });
    return {};
  }

  // The operator normally serves a different checkout than the one this hook
  // is running in (:3070's release tree vs the staging tree). Preserve the
  // physical repository domain for a single-root call so the lock store does
  // not accidentally use the operator process's own checkout. Mixed-root
  // calls intentionally omit it and let the operator use its default domain.
  const coordinationDomains = new Set<string>();
  for (const target of targets) {
    try {
      coordinationDomains.add(realpathSync(target.root));
    } catch {
      coordinationDomains.add(target.root);
    }
  }
  const coordinationDomain =
    coordinationDomains.size === 1 ? [...coordinationDomains][0] : undefined;

  const result = await callMcpTool(
    'locks:acquire',
    {
      paths,
      intent: `tool_call:${event.toolName}`,
      ttl_sec: 1200,
      wait: { max_sec: 0 },
      ...(coordinationDomain ? { coordination_domain: coordinationDomain } : {}),
    },
    // Without this a deterministic schema/argument rejection collapses to
    // `null` and is indistinguishable from "operator unreachable" — it then
    // takes the fail-open transport branch below and reports itself as a
    // transient miss. That is how 220 consecutive invalid_args rejections
    // escalated nothing.
    { preserveErrors: true },
  );

  // A structured error means the operator ANSWERED and refused our request:
  // our arguments are wrong. That is a defect in THIS hook, never a
  // transport problem, and it will recur on every tool call until fixed.
  const structured = asStructuredCallError(result);
  if (structured !== null) {
    console.error(
      `[su-locks] locks:acquire REFUSED THE REQUEST (${structured.error}): ` +
        `${structured.message} — this is a hook defect, not an operator outage; ` +
        'allowing tool_call (fail-open)',
    );
    await recordRequestDefect({
      handler: 'tool_call',
      detail: `locks:acquire ${structured.error}: ${structured.message}`,
    });
    return {};
  }

  if (result == null) {
    // Operator unreachable or call errored — fail open. Cooperative
    // discipline only works when the system is up; blocking edits
    // would wedge the agent. The persisted marker (file-locking #3)
    // lets the operator UI surface "enforcement offline."
    console.error(
      '[su-locks] locks:acquire unreachable; allowing tool_call (fail-open)',
    );
    await recordHookError({
      handler: 'tool_call',
      phase: 'connect',
      detail: 'locks:acquire returned null (operator unreachable)',
    });
    return {};
  }

  const r = result as {
    ok?: boolean;
    lock_id?: string;
    busy?: BusyEntry[];
    reason?: string;
  };
  // Reaching here means the operator answered — a successful hook
  // call, whether the answer was ok or busy.
  if (r.ok === true && typeof r.lock_id === 'string') {
    acquiredLocks.set(event.toolCallId, {
      lockId: r.lock_id,
      toolName: event.toolName,
      paths: [...paths],
      ...(coordinationDomain ? { coordinationDomain } : {}),
    });
    await recordHookSuccess();
    return {};
  }
  await recordHookSuccess();
  const reason =
    r.busy && r.busy.length > 0
      ? formatBusyRefusal(r.busy)
      : r.reason ?? 'locks: refused (unknown reason)';
  return { block: true, reason };
}

export async function onToolResult(event: ToolResultEvent): Promise<void> {
  const lock = acquiredLocks.get(event.toolCallId);
  if (lock === undefined) return;
  acquiredLocks.delete(event.toolCallId);
  const proof = nativeEditProofForResult(lock.toolName, event.content, lock.paths);
  if (proof && lock.coordinationDomain) {
    try {
      await declarationRegenerator(lock.coordinationDomain, lock.paths);
    } catch (error) {
      // Generation is a pre-release repair, never a reason to strand the source
      // lock. Persist the failure and continue to the release below.
      await recordHookError({
        handler: 'tool_result',
        phase: 'declaration-regeneration',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  // Best-effort release. Missed releases are covered by the lock's
  // TTL (1200s) so a network blip does NOT leak a lock permanently.
  await callMcpTool('locks:release', {
    lock_id: lock.lockId,
    ...(lock.coordinationDomain
      ? { coordination_domain: lock.coordinationDomain }
      : {}),
    ...(proof ? { native_edit_proof: proof } : {}),
  });
}

/** Test-only: reset the in-memory lock cache between cases. */
export function _resetToolCallCacheForTests(): void {
  acquiredLocks.clear();
}

// ── OMP adapter (registration) ───────────────────────────────────────

/**
 * Best-effort wrapper that swallows handler errors. A hook handler
 * must never crash the OMP session.
 */
async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

/**
 * Narrow shape of the OMP HookAPI we depend on. The real interface
 * lives at `@oh-my-pi/pi-coding-agent/src/extensibility/hooks/types.ts`
 * (HookAPI). We don't import it because this file ships standalone
 * to OMP — it has no dev-dependency on @oh-my-pi/pi-coding-agent.
 *
 * Verified 2026-05-20 against the installed version: turn_start
 * handlers receive `TurnStartEvent` and their return value is
 * DISCARDED — model context is stashed for the next tool_result instead.
 * tool_call handlers may return ToolCallEventResult
 * ({ block?, reason? }) to block. session_start handlers' return
 * values are also discarded.
 */
type SessionStartHandler = (event: { type: 'session_start' }, ctx: unknown) => unknown;
type SessionShutdownHandler = (event: { type: 'session_shutdown' }, ctx: unknown) => unknown;
type TurnStartHandler = (event: { type: 'turn_start'; turnIndex: number; timestamp: number }, ctx: unknown) => unknown;
type TurnEndHandler = (event: { type: 'turn_end' }, ctx: unknown) => unknown;
type BeforeProviderRequestHandler = (
  event: { type: 'before_provider_request'; payload: unknown },
  ctx: { model?: ProviderModelRef },
) => unknown;
type AutoRetryStartHandler = (event: AutoRetryStartEvent, ctx: unknown) => unknown;
type ToolCallHandler = (
  event: ToolCallEvent,
  ctx: unknown,
) => Promise<{ block?: boolean; reason?: string } | void> | { block?: boolean; reason?: string } | void;
type ToolResultHandler = (
  event: ToolResultEvent,
  ctx: unknown,
) => Promise<{ content?: unknown } | void> | { content?: unknown } | void;

interface HookApi {
  on(event: 'session_start', handler: SessionStartHandler): void;
  on(event: 'session_shutdown', handler: SessionShutdownHandler): void;
  on(event: 'turn_start', handler: TurnStartHandler): void;
  on(event: 'turn_end', handler: TurnEndHandler): void;
  on(event: 'before_provider_request', handler: BeforeProviderRequestHandler): void;
  on(event: 'auto_retry_start', handler: AutoRetryStartHandler): void;
  on(event: 'tool_call', handler: ToolCallHandler): void;
  on(event: 'tool_result', handler: ToolResultHandler): void;
  sendMessage(
    message: {
      customType: string;
      content: string | Array<{ type: 'text'; text: string }>;
      display?: boolean;
      attribution?: 'user' | 'agent';
    },
    options?: { triggerTurn?: boolean; deliverAs?: 'steer' | 'followUp' },
  ): void;
}

/**
 * Orientation primer (tool-discovery-for-weak-models-2026-06-30 WS4). Injected
 * ONCE at session_start, always-visible (it's a sendMessage, not an MCP tool, so
 * omp's tool-discovery never hides it). Teaches weaker/local models the two
 * things they get wrong — observed with `ollama/qwen3.5` and `ornith` running
 * blind: (1) plans/work-items/inbox live in the coordination SYSTEM, not files
 * (they `ls`/`find` for them and find nothing); (2) Papercusp MCP tools are
 * hidden behind discovery, so the right tool must be DISCOVERED then loaded
 * before it can be called (they hallucinate names → "Tool X not found").
 *
 * Discovery design (WS2 + WS4): `tools:find` is the discovery BRAIN — a hybrid
 * semantic+lexical search over the full catalog that understands intent, so it
 * works even when the model doesn't know the exact tool name. omp's native
 * `tools:invoke` is the LOADER-FREE call path: once tools:find yields an exact
 * name, tools:invoke {name, args} runs it server-side (no activation), so omp
 * never depends on its native search_tool_bm25. Flow: tools:find("<intent>")
 * → exact name → tools:invoke({name, args}). The capability map
 * below (a static mirror of catalogueProjection / renderCapabilityMap — the
 * hook ships standalone to omp and can't read the live catalog) tells the model
 * WHAT namespaces exist + the vocabulary to search.
 *
 * The core list mirrors CORE_MCP_TOOL_NAMES (orchestrator/invoke.ts). omp-only:
 * this hook is omp's `-e` coordination module; claude/codex load the full
 * catalog directly and reach for `tools:find` only (native ToolSearch, no bm25).
 */
const ORIENTATION_PRIMER = [
  '<system-reminder type="papercusp-orientation">',
  'You are a Papercusp superuser agent. Read this once.',
  '',
  'WHERE THINGS LIVE: plans, work-items, inbox, assignments, and coordination state live in the Papercusp COORDINATION SYSTEM (a database), NOT as files on disk. Do NOT ls/find/read the filesystem to find them — use the coordination tools below.',
  '',
  'FINDING ANY CAPABILITY: to find the right tool for ANYTHING, call tools:find("<what you need>"). It is a hybrid semantic+lexical search over the full ~550-tool catalog and is the discovery BRAIN — it understands intent, not just keywords, so it works even when you do not know the exact tool name. It returns the exact tool names that match.',
  '',
  'CALLING A TOOL BY NAME: your core spine (below) is always callable directly. For anything else, once tools:find gives you an exact name, run it with tools:invoke {name:"<exact name>", args:{...}} — tools:invoke executes ANY catalog tool server-side, so it never needs a separate "load"/activation step and works even for a tool that is hidden behind discovery. Do NOT guess name variants and do NOT reach for any native keyword tool-search (e.g. search_tool_bm25) — tools:find (to discover) and tools:invoke (to call) are the only two you need.',
  '',
  'START HERE: call coord:orient (it is in your core spine — always available) — one call returns your assignments, the claimable backlog, your unread inbox, recent plan changes, and a memory recall.',
  '',
  'YOUR CORE TOOLSET (your always-callable spine — call these directly; for anything else use tools:find → tools:invoke):',
  '  coord:orient · coord:inbox · coord:ack · coord:send · coord:glance · coord:ask',
  '  plans:get · plans:set-status · plans:items · work_items:list · work_items:claim · work_items:set_state · work_items:update',
  '  locks:acquire_granular · locks:release_granular · docs:search · memory:search · memory:remember · tools:find',
  '',
  'CAPABILITY MAP — namespaces in the ~550-tool catalog (call tools:find("<intent>") to get exact names in any of these):',
  '  coord       talk to peers / the Queen — orient, inbox, send, ack, ask, handoff, escalate',
  '  plans       work-plan store — get, items, set-status, set-now, add-item, decisions',
  '  work_items  the work backlog — list, claim, update, set_state, complete, comment',
  '  locks       file/resource claims before editing — acquire_granular, release_granular',
  '  hive        spawn / steer sub-agent hives — create, start, wake, status, report',
  '  fleet       worker fleet — spawn, assignments, capacity, supervise, tree',
  '  flags       feature flags — get, set, list',
  '  deploy      ship / teardown harnesses + hives — harness, hive, status, teardown',
  '  docs        knowledge base — search, get, outline, author',
  '  memory      durable facts (mem0) — search, remember, forget, update',
  '  harness     harness / repo management — get, list, status, health, overview',
  '  capability  host capabilities — bash, edit, write, read, git, fetch, computer',
  '  accounts    model / account pool — list, status, register, pin',
  '  (and more — tools:find reaches every namespace, not just these.)',
  '</system-reminder>',
].join('\n');

export default function register(pi: HookApi): void {
  pi.on('session_start', async (_event, ctx) => {
    pokeStallWatchdog(); // heartbeat: arm the stall watchdog at the very first event
    await safe(() => onSessionStart(ctx), undefined);
    // One startup render gives the terminal an immediate title. Subsequent
    // display refreshes ride the generation-stamped post-tool activity bundle.
    void safe(() => emitStatusDisplay(pi, ctx), undefined);
    // WS4 orientation primer — inject once, model-facing (display:false,
    // attribution:'agent' = not billed to the user), same channel as the
    // coord reminders. Non-fatal: the primer is additive guidance.
    stashAdvisory('coord-orientation', ORIENTATION_PRIMER);
  });

  pi.on('turn_start', async (_event, ctx) => {
    pokeStallWatchdog(); // heartbeat: a new turn ⇒ the session is progressing
    // Scope the doom-loop breaker's consecutive-repeat run to this turn (a loop is
    // emitted inside one turn; a legit re-call across two turns must not accrue).
    resetToolCallLoopState();
    const { reminder, degraded } = await safe(() => onTurnStart(ctx), {
      reminder: '',
      degraded: true,
      mode: 'attached' as CoordMode,
    });
    if (reminder.length > 0) {
      stashAdvisory('coord-turn-start', reminder);
    }
    if (degraded && !_degradedNotified) {
      // Edge-triggered (WI-1082): surface the degraded notice ONCE per slow streak,
      // not every turn. `degraded` is the TRANSIENT case — the operator probe succeeded
      // (it is reachable) but a coordination READ was slow/errored this turn. Re-injecting
      // a notice every turn spams the model + TUI and, in an auto-continuing omp session,
      // drives a self-reinforcing turn loop (notice → a worried quick turn → another
      // turn_start → more coord burst → more latency → more notices). Notify on the
      // healthy→degraded edge; stay quiet until coordination recovers (the else branch
      // re-arms the latch). Two markers:
      //  1. To the model — a reliable sendMessage note, worded as NON-actionable so the
      //     agent doesn't derail its task investigating a transient blip.
      //  2. To the human — a best-effort OMP TUI notification. The ctx shape is accessed
      //     defensively; if the API differs the marker simply no-ops.
      _degradedNotified = true;
      stashAdvisory(
        'coord-degraded',
        '<system-reminder type="coord">A coordination read was slow and was skipped this turn (transient — it retries automatically; NO action needed). Inbox/locks/changed-plans may be momentarily stale; just continue your task.</system-reminder>',
      );
      const c = ctx as
        | { hasUI?: boolean; ui?: { notify?: (m: string, t?: string) => void } }
        | undefined;
      if (c?.hasUI && typeof c.ui?.notify === 'function') {
        c.ui.notify(
          'Papercusp coordination was slow this turn (auto-retrying; no action needed)',
          'warning',
        );
      }
    } else if (!degraded) {
      // Recovered — re-arm the edge so the next slow streak surfaces one fresh notice.
      _degradedNotified = false;
    }
  });

  pi.on('turn_end', async (_event, ctx) => {
    // A CLEAN turn_end ⇒ the session is now idle BETWEEN turns — legitimately
    // waiting for the next input/wake (e.g. after presenting a kickoff routing
    // gate as text and STOPping, per the ask-block redirect), NOT wedged. DISARM
    // so the watchdog never kills a healthy waiting session. (iter18, 2026-07-04:
    // the watchdog SIGTERM'd a leader exactly 6 min into a CORRECT routing-gate
    // wait — a routing-gate idle is silence-identical to a wedge, so silence
    // alone must NOT trigger the halt. The watchdog is armed only WHILE a turn is
    // in progress; a mid-turn freeze keeps turn_end from ever firing, so it is
    // still caught.)
    disarmStallWatchdog();
    await safe(() => onTurnEnd(), undefined);
    // Per-turn journal ping (P-012) — deliberately un-awaited: fire-and-forget.
    void safe(() => reportTurnJournal(ctx), undefined);
    // owner-inbox-single-pane-2026-07-17 P-004: ingest the turn's final text into P-002's
    // ask surface, and soft-nudge a correction on the NEXT turn if it ended in an
    // unstructured owner-ask. The nudge waits for the next tool_result seam.
    void safe(async () => {
      const { nudge } = await reportTurnAskIngest(ctx);
      if (nudge.length > 0) {
        stashAdvisory('coord-owner-ask', nudge);
      }
    }, undefined);
  });

  pi.on('before_provider_request', async (_event, ctx) => {
    // OMP awaits this seam and supplies the model used for this exact provider
    // request. Return nothing so the payload-transform chain remains unchanged.
    if (!isVertexGemini31ProRequest(ctx.model)) return;
    const reservation = await reserveVertexGeminiRequestStart();
    if (!reservation || reservation.waitMs <= 0) return;
    console.error(
      `[coord-provider] pacing Vertex Gemini 3.1 Pro request start by ${reservation.waitMs}ms` +
        (reservation.saturated ? ' (bounded queue saturated)' : ''),
    );
    await pause(reservation.waitMs);
  });

  pi.on('auto_retry_start', async (event) => {
    // OMP awaits hook handlers, then creates its own AbortController and waits
    // event.delayMs. Lift only the missing portion to our bounded, session-stable
    // target; explicit provider timing and every non-Vertex retry pass through.
    const smoothingMs = vertexSharedCapacityRetrySmoothingMs(event, hookOwnerId());
    if (smoothingMs <= 0) return;
    console.error(
      `[coord-retry] smoothing bare Vertex shared-capacity 429 by ${smoothingMs}ms ` +
        `(attempt ${event.attempt}/${event.maxAttempts}, slot ${vertexSharedCapacityRetrySlot(hookOwnerId())})`,
    );
    await safe(() => new Promise<void>((resolveWait) => setTimeout(resolveWait, smoothingMs)), undefined);
  });

  pi.on('tool_call', async (event, ctx) => {
    // heartbeat: a tool is starting — mark it in flight so a long-but-legit tool
    // (build/test) EXTENDS the watchdog instead of tripping it, then rearm.
    noteStallToolInFlight(true);
    pokeStallWatchdog();
    const result = await safe(() => onToolCall(event, ctx), {});
    if (!result.block) stageActivityReport(event);
    return result;
  });

  pi.on('tool_result', async (event, ctx) => {
    // heartbeat: the tool finished — clear in-flight and rearm the countdown.
    noteStallToolInFlight(false);
    pokeStallWatchdog();
    // 1. Release the lock acquired for this tool (existing behavior).
    await safe(() => onToolResult(event), undefined);
    // 2. One post-tool activity heartbeat also returns generation-stamped
    //    inbox/display deltas. Never queue these through sendMessage:
    //    omp's message queues ABORT the in-flight
    //    tool (its result becomes "Skipped due to queued user message") every
    //    time a coord delta lands. On a slow local model (ornith IQ3_M, ~40s
    //    turns) in a busy fleet, ambient `*` broadcasts (claim pickups, sweeps)
    //    arrive faster than tools complete, so every tool is aborted before
    //    finishing → the session LIVELOCKS and never makes progress (observed
    //    2026-07-04: a leader burned 424 msgs / 170K tokens of "Skipped…" with
    //    0 goal actions — fact `ornith-coord-inbox-flood-livelock`). Appending
    //    to this completed result matches the Claude/Codex passive
    //    `additionalContext` parity this hook targets. Urgent control cues still arrive at the next tool
    //    boundary (one call later) — an acceptable trade vs. a full livelock.
    const bundle = await safe(() => reportActivityResult(event), null);
    const { reminder } = await safe(() => consumeActivityHookBundle(bundle, pi, ctx), { reminder: '' });
    // 3. Drain any bash→tool advisory staged by this tool's tool_call (P-017).
    const content = [drainSubstitutionAdvisory(), reminder].filter((s) => s.length > 0).join('\n\n');
    if (content.length > 0) stashAdvisory('coord-tool-result', content);

    // D-001/D-002: `sendMessage` is an interrupt even when labelled followUp.
    // Append every pending advisory to the tool result the model was already
    // going to read. inject-hook shares this keyed stash, so whichever hook's
    // tool_result handler runs first atomically delivers all pending blocks.
    const advisory = takeAdvisories();
    if (!advisory) return;
    return { content: appendAdvisories(event.content, advisory) };
  });

  pi.on('session_shutdown', async () => {
    disarmStallWatchdog(); // clean shutdown ⇒ tear down the watchdog (no false stall-halt)
    await safe(() => onSessionShutdown(), undefined);
  });
}
