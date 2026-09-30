/**
 * task-manager/reaper — the ENFORCEMENT half the reconciler never had
 * (WI-41607, plan agent-session-scope-reaper-2026-08-25).
 *
 * D-010 of task-manager-no-escape-2026-07-27 made the reconciler REPORT-ONLY
 * while residue classification matured. That decision is now superseded by an
 * explicit owner directive, given twice: 2026-08-23 "If we launch an agent
 * session and end it there should be no process residue", and 2026-08-25
 * "investigate the issue and fix it once and for all" — after the third
 * accumulation incident (2026-08-25: 62 residue scopes / ~409 processes, on
 * top of a 5-day-old fleet that was never stood down). Detection without
 * enforcement measurably does not hold this box: every prior fix improved a
 * census and the residue regrew.
 *
 * TWO reap classes, both narrowly discriminated, both AGENT-SESSION-ONLY:
 *
 *   terminal-residue  — the task's ledger row is TERMINAL (exited/killed/…)
 *                       but its scope cgroup still holds processes past a
 *                       grace window. The session is over by its own record;
 *                       whatever survives is leftovers (MCP servers, bash
 *                       wrapper chains, codex children). This is the
 *                       "start and stop a session, processes remain" defect.
 *
 *   quiet-zombie      — the row is RUNNING but its log has not been written
 *                       for >= quietMs (default 90m, plus an independent fresh
 *                       presence-heartbeat veto; the census's validated
 *                       window) AND no fresh coord-presence heartbeat vouches
 *                       for its owner. These are sessions that will never take
 *                       another turn: forks/consult-revivals that never got
 *                       their question, fleet members whose fleet drained days
 *                       ago, booted-but-never-woken launches (WI-41044 class).
 *
 * WHAT IS DELIBERATELY NOT A SIGNAL: CPU. The 2026-08-25 autopsy measured the
 * codex CLI idle-spinning at a constant ~8% CPU in scopes whose logs had been
 * silent for 9–35 hours (EI-21417256075155406) — "CPU-active" is NOT evidence
 * of progress here, and a CPU gate would have spared 53 of 58 confirmed
 * zombies. Log mtime + presence are the instruments that survived
 * falsification (see agent-session-progress-census.ts's header for the three
 * instruments that did not).
 *
 * SAFETY RAILS, in order:
 *   - agent-session class only — no other task class is ever touched, so a
 *     payload that legitimately daemonizes (release cut, service launcher)
 *     cannot be collateral.
 *   - `isAutoReapExempt` rows are never reaped (terminal-psu-session-enrolment
 *     2026-08-24 D-001, owner ruling: enrolled terminal sessions opt out of
 *     AUTOMATED reaping; explicit kills still work).
 *   - a DEGRADED progress census (unreadable > measurable) disables the
 *     quiet-zombie class entirely for that tick — an unmeasurable census must
 *     never authorize a kill.
 *   - fresh presence heartbeat (when the owner is mapped) spares the row even
 *     when the log is quiet.
 *   - per-tick cap: a pathological tick reaps a bounded number of scopes and
 *     leaves the rest for the next tick, so a wrong discriminator can never
 *     take out a whole population before someone notices.
 *   - every reap archives the session's log tail FIRST (the 2026-08-23 hand
 *     reap's own protocol), and every decision — reaped or spared — is
 *     reported, so the audit trail exists before the process dies.
 *
 * The decision function is PURE (rows + census + sets in, verdicts out) so the
 * falsifiability tests can drive it with deliberately-wrong controls; all IO
 * (cgroup reads, systemctl, tail archiving, ledger closes) is injected.
 */

import { isAutoReapExempt, isTerminalState, taskIdFromScopeUnit, type TaskRow } from './types';
import type { AgentSessionProgressCensus } from './agent-session-progress-census';
import { nodeCgroupFs, parseProcCgroup, type CgroupFs } from './cgroup-read';
import type { ResidueGroup } from './reconcile';

/** A terminal row's scope gets this long after `ended_at` before its survivors
 *  are considered leftovers. Long enough for any legitimate teardown; short
 *  enough that "stop a session" visibly clears the box. */
export const REAP_TERMINAL_GRACE_MS = 10 * 60_000;

/** Terminal-residue guard against the CARRY-RESPAWN edge: respawns re-enter the
 *  SAME scope (measured 2026-08-25 — two process generations in one scope), so a
 *  terminal row's scope can briefly hold a LIVE successor. A live session writes
 *  its log; leftovers do not. A terminal row whose log was written more recently
 *  than this is therefore spared as an anomaly, never reaped. */
export const REAP_TERMINAL_LOG_QUIET_MS = 30 * 60_000;

/** Bounded blast radius per tick. 12 covers the measured steady-state churn
 *  (5 stranded scopes on 2026-08-25) with headroom, while a false discriminator
 *  would need many ticks — each broadcasting its decisions — to do real damage. */
export const REAP_MAX_PER_TICK = 12;

/** Presence heartbeat younger than this vouches for a quiet session's owner. */
export const REAP_PRESENCE_FRESH_MS = 15 * 60_000;

/** A settled consult's answering session gets this long to finish the turn it
 *  replied in (flush its transcript, end the turn) before it is stopped. */
export const REAP_CONSULT_SETTLED_GRACE_MS = 3 * 60_000;

export type ReapKind = 'terminal-residue' | 'managed-residue' | 'consult-settled' | 'quiet-zombie';

// ── consult answering sessions (EI-24106882795589775) ──────────────────────
//
// consult-dispatch launches a headless session to answer ONE question. Its brief
// says "reply, then END YOUR TURN" — but a headless interactive CLI does not exit
// when a turn ends; it idles on its pty forever. Measured 2026-09-24: 94 such rows
// RUNNING, 87 idle `claude` processes, ~14.4 GB RSS, oldest 19 days.
//
// The quiet-zombie class could not clear them, for a measured reason: its
// fresh-presence veto. The session's presence heartbeat is a PROCESS KEEPALIVE,
// not activity — fork 0muescjix2spy7114ys showed heartbeat_at 02:21:51 (a minute
// before it was killed) against last_active_at 01:21:53. So every idle-but-alive
// fork vouched for itself and was spared on every tick.
//
// Two rules follow, both scoped to rows that ARE consult answering sessions:
//   - `consult-settled`: once the consult is settled FOR THIS SESSION (closed, or
//     the cascade has moved past it), the session's purpose is over — stop it
//     after a short grace, no quiet window, no presence veto.
//   - the quiet-zombie presence veto does not apply: for a one-question session a
//     log quiet for the full window is the answer to "is it done", and its
//     heartbeat cannot say otherwise.

/** What a ledger row says it answers. */
export interface ConsultAnswerFacts {
  conversationId: string | null;
  answeringOwnerId: string | null;
  operation: string | null;
  /**
   * The expert whose knowledge this session answers with — `selection.selected[]
   * .ownerId` of the slot it was launched for. Unlike the `answeringOwnerId`
   * stamp (absent on most consults, measured 2026-09-24), the selected entry's
   * `ownerId` is always written, so this is what locates the session's slot.
   * Null on rows tagged before it was recorded.
   */
  sourceOwnerId: string | null;
}

// consult-dispatch's label shape (`consult-<operation> · <owner16>`), for rows
// written before the structured `consultAnswer` tag existed.
const LEGACY_CONSULT_LABEL_RE = /^consult-(fork|convert|resume|revival)\b/;

/** The consult facts a row carries, or null when it is not a consult answering session. */
export function consultAnswerFacts(row: Pick<TaskRow, 'detail'>): ConsultAnswerFacts | null {
  const d = row.detail ?? {};
  const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : null);
  const tagged = d.consultAnswer;
  if (tagged && typeof tagged === 'object' && !Array.isArray(tagged)) {
    const t = tagged as Record<string, unknown>;
    return {
      conversationId: str(t.conversationId),
      answeringOwnerId: str(t.answeringOwnerId) ?? rowOwnerId(row),
      operation: str(t.operation),
      sourceOwnerId: str(t.sourceOwnerId),
    };
  }
  const legacy = LEGACY_CONSULT_LABEL_RE.exec(str(d.label) ?? '');
  if (!legacy) return null;
  return {
    conversationId: null,
    answeringOwnerId: rowOwnerId(row),
    operation: legacy[1] ?? null,
    sourceOwnerId: null,
  };
}

/** The slice of `harness_shared.consult_state` the settlement rule reads. */
export interface ConsultStateRow {
  conversationId: string;
  state: string;
  closedAt: string | null;
  updatedAt: string | null;
  cascadeCursor: number | null;
  /** `routing.selection.selected` — per-cursor responder entries. */
  selected: unknown;
  /**
   * The consult's `answer` / `decline` posts (`consult_post_meta`), oldest first.
   * Missing ⇒ not read; the answered rule is then off for this consult.
   */
  responses?: readonly ConsultResponsePost[];
}

/** One `answer` / `decline` post on a consult thread. */
export interface ConsultResponsePost {
  authorId: string;
  kind: string;
  at: string | null;
}

export interface ConsultSettlement {
  why: string;
  /** When the consult settled for this session; null = unknown (the row's start is used). */
  settledAtMs: number | null;
}

/** States that end a consult even when `closed_at` was not stamped. */
const CONSULT_SETTLED_STATES = new Set([
  'expired',
  'closed_answered',
  'closed_cant_help',
  'declined',
  'no_qualified_responder',
]);

function selectedAnsweringOwners(selected: unknown): (string | null)[] {
  if (!Array.isArray(selected)) return [];
  return selected.map((entry) => {
    const v = entry && typeof entry === 'object' ? (entry as Record<string, unknown>).answeringOwnerId : null;
    return typeof v === 'string' && v.length > 0 ? v : null;
  });
}

/** Per-slot expert (`selected[].ownerId`) — always written by the router. */
function selectedSourceOwners(selected: unknown): (string | null)[] {
  if (!Array.isArray(selected)) return [];
  return selected.map((entry) => {
    const v = entry && typeof entry === 'object' ? (entry as Record<string, unknown>).ownerId : null;
    return typeof v === 'string' && v.length > 0 ? v : null;
  });
}

function parseMs(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * PURE: is the consult this session answers settled FOR THIS SESSION?
 *
 * Returns null whenever that cannot be established — no matching consult row, an
 * ambiguous legacy match, or a session that is still the active responder. Null is
 * "not this class's call", never "keep forever": the quiet-zombie class (with no
 * presence veto for consult rows) remains the backstop.
 *
 * A legacy row (no structured tag) is matched by answering owner ONLY for a fork,
 * whose owner id is minted fresh per launch and therefore unique. A conversion
 * continues the expert's own id, which recurs across consults, so an owner match
 * there could name the wrong conversation.
 */
export function consultSettlement(
  facts: ConsultAnswerFacts,
  consults: readonly ConsultStateRow[],
): ConsultSettlement | null {
  let consult: ConsultStateRow | undefined;
  if (facts.conversationId) {
    consult = consults.find((c) => c.conversationId === facts.conversationId);
  } else if (facts.answeringOwnerId && facts.operation === 'fork') {
    const matches = consults.filter((c) =>
      selectedAnsweringOwners(c.selected).includes(facts.answeringOwnerId),
    );
    if (matches.length === 1) consult = matches[0];
  }
  if (!consult) return null;

  if (consult.closedAt || CONSULT_SETTLED_STATES.has(consult.state)) {
    return {
      why: `consult ${consult.conversationId} is ${consult.state}`,
      settledAtMs: parseMs(consult.closedAt) ?? parseMs(consult.updatedAt),
    };
  }

  // Still open. Locate this session's cascade slot: the `answeringOwnerId` stamp
  // when present, else the slot whose expert (`ownerId`) this session answers for.
  // The stamp alone was not enough — it is absent on most consults, so a rule keyed
  // only on it never fired and answered forks idled to the quiet-zombie window.
  const stamped = facts.answeringOwnerId
    ? selectedAnsweringOwners(consult.selected).indexOf(facts.answeringOwnerId)
    : -1;
  const slot =
    stamped >= 0
      ? stamped
      : facts.sourceOwnerId
        ? selectedSourceOwners(consult.selected).indexOf(facts.sourceOwnerId)
        : -1;

  // Settled for THIS session once the cascade has moved on to a different
  // responder — this session answered, declined or expired.
  if (slot >= 0 && consult.cascadeCursor != null && slot < consult.cascadeCursor) {
    return {
      why: `consult ${consult.conversationId} cascade advanced past this responder (slot ${slot} → cursor ${consult.cascadeCursor})`,
      settledAtMs: parseMs(consult.updatedAt),
    };
  }

  // …or once this session has posted its answer/decline and the consult is not
  // waiting on this slot again (a requester follow-up re-awaits the same slot, and
  // that session must stay up to take it). A fork can post under the expert's id,
  // so both identities count. Unknown slot + awaiting ⇒ not settled.
  const authors = new Set(
    [facts.answeringOwnerId, facts.sourceOwnerId].filter((v): v is string => !!v),
  );
  let response: ConsultResponsePost | undefined;
  for (const post of consult.responses ?? []) if (authors.has(post.authorId)) response = post;
  const awaitingThisSlot =
    consult.state === 'awaiting_responder' && (slot < 0 || slot === consult.cascadeCursor);
  if (response && !awaitingThisSlot) {
    return {
      why: `consult ${consult.conversationId}: this responder posted its ${response.kind} as ${response.authorId}`,
      settledAtMs: parseMs(response.at) ?? parseMs(consult.updatedAt),
    };
  }
  return null;
}

/** A two-scan-confirmed managed agent-session scope with no live ledger row. */
export interface ManagedResidueCandidate {
  taskId: string;
  scopeUnit: string;
  cgroupPath: string;
  pids: number[];
  sampleCmdline: string;
  /** Best-effort file-backed stdout/stderr path discovered from a live pid. */
  logPath?: string | null;
}

const MANAGED_AGENT_SESSION_SEGMENTS = [
  'papercusp.slice',
  'papercusp-agent.slice',
  'papercusp-agent-session.slice',
] as const;

function hasManagedAgentSessionPath(cgroupPath: string, scopeUnit: string): boolean {
  const segments = cgroupPath.split('/').filter(Boolean);
  for (let i = 0; i <= segments.length - MANAGED_AGENT_SESSION_SEGMENTS.length - 1; i += 1) {
    const expected = [...MANAGED_AGENT_SESSION_SEGMENTS, scopeUnit];
    if (expected.every((segment, offset) => segments[i + offset] === segment)) return true;
  }
  return false;
}

/**
 * Convert confirmed scan residue into exact, addressable agent-session scopes.
 *
 * The scanner can return one group per leaf cgroup beneath a scope. Merge those
 * leaves by the scope unit, but accept a group only when the observed path has
 * the complete managed agent-session hierarchy and the unit is a valid `.scope`.
 * A `pc-` name in an arbitrary slice is not enough provenance to terminate it.
 */
export function managedResidueCandidates(groups: readonly ResidueGroup[]): ManagedResidueCandidate[] {
  const byScope = new Map<
    string,
    { taskId: string; scopeUnit: string; cgroupPath: string; pids: Set<number>; sampleCmdline: string }
  >();

  for (const group of groups) {
    const scopeUnit = group.scopeUnit?.trim() ?? '';
    if (!scopeUnit.endsWith('.scope') || !hasManagedAgentSessionPath(group.cgroupPath, scopeUnit)) continue;
    const taskId = taskIdFromScopeUnit(scopeUnit);
    if (!taskId) continue;
    const current = byScope.get(scopeUnit);
    if (current) {
      for (const pid of group.pids) current.pids.add(pid);
      if (!current.sampleCmdline && group.sampleCmdline) current.sampleCmdline = group.sampleCmdline;
      continue;
    }
    byScope.set(scopeUnit, {
      taskId,
      scopeUnit,
      cgroupPath: group.cgroupPath,
      pids: new Set(group.pids),
      sampleCmdline: group.sampleCmdline,
    });
  }

  return [...byScope.values()]
    .map((candidate) => ({ ...candidate, pids: [...candidate.pids].sort((a, b) => a - b) }))
    .sort((a, b) => a.scopeUnit.localeCompare(b.scopeUnit));
}

/** A live process OUTSIDE a no-row scope that still parents one of its members. */
export interface ScopeHolder {
  pid: number;
  comm: string;
  cgroupPath: string;
}

/**
 * Who still HOLDS a no-row managed scope, read from `/proc`.
 *
 * `systemd-run --scope` execs the payload in the very process the spawner forked,
 * so the scope's root stays the spawner's child for as long as the spawner lives.
 * When the spawner dies the kernel reparents it to the nearest subreaper: the user
 * manager (cgroup `…/init.scope`) or pid 1. A live parent outside the scope that is
 * neither is therefore the process that launched the scope and still owns it, and
 * the scope is not residue.
 *
 * That is exactly what a scope from ANOTHER store looks like here. An isolated
 * operator (the installed-PUI acceptance suite, a VERIFY_TAURI_ISOLATED_DB desktop)
 * confines its engines into this same agent-session slice but enrols them in its
 * own ledger, so this reaper finds no row. Measured 2026-09-24: the live reaper
 * stopped the acceptance suite's Claude engine mid-turn, three minutes into a
 * journey (WI-10000435).
 *
 * `pids` must be the scope's CURRENT members; a pid that has left the scope (exited,
 * or recycled into another cgroup) is skipped. Returns 'unreadable' when no
 * member's parentage could be read: an unmeasurable holder must never authorize a
 * kill.
 */
export function readScopeHolder(
  scopeUnit: string,
  pids: readonly number[],
  fs: CgroupFs = nodeCgroupFs,
): ScopeHolder | null | 'unreadable' {
  const inScope = (cgroupPath: string) => cgroupPath.split('/').includes(scopeUnit);
  let measured = 0;
  for (const pid of pids) {
    const own = parseProcCgroup(fs.readFile(`/proc/${pid}/cgroup`) ?? '');
    if (!own || !inScope(own)) continue;
    const ppid = parseStatusPpid(fs.readFile(`/proc/${pid}/status`));
    if (ppid === null) continue;
    measured += 1;
    if (ppid <= 1) continue;
    const parent = parseProcCgroup(fs.readFile(`/proc/${ppid}/cgroup`) ?? '');
    // A parent that exited between the two reads holds nothing: its child is
    // being reparented to the subreaper right now.
    if (!parent || inScope(parent) || parent.split('/').at(-1) === 'init.scope') continue;
    return { pid: ppid, comm: fs.readFile(`/proc/${ppid}/comm`)?.trim() || '?', cgroupPath: parent };
  }
  return measured > 0 ? null : 'unreadable';
}

function parseStatusPpid(status: string | null): number | null {
  const match = status?.match(/^PPid:\s*(\d+)\s*$/m);
  return match ? Number(match[1]) : null;
}

export interface ReapDecision {
  taskId: string;
  scopeUnit: string;
  logPath: string | null;
  kind: ReapKind;
  why: string;
}

export interface SpareDecision {
  taskId: string;
  why: string;
}

export interface ReaperInputs {
  /** Ledger rows to consider — the caller passes live AND recently-terminal rows. */
  rows: readonly TaskRow[];
  /** Confirmed managed scopes that have no corresponding live ledger row. */
  managedResidue?: readonly ManagedResidueCandidate[];
  /** Progress census over the LIVE agent-session rows (log-mtime instrument). */
  census: AgentSessionProgressCensus;
  /**
   * Live pid count for a row's scope cgroup; null = unreadable, 0 = the scope
   * does not exist (both mean "do not reap"; unreadable must never read as
   * "has processes").
   *
   * ⚠ CONTRACT — RESOLVE THIS FROM `row.scopeUnit`, NEVER FROM `row.cgroupPath`.
   *
   * `task_ledger.cgroup_path` is NOT trustworthy for this decision. It records
   * the cgroup observed at ENROLMENT, and for a large minority of rows that is
   * the SPAWNER's cgroup (the operator's own service) rather than the scope the
   * process ends up in. Measured live 2026-08-25: of 94 non-exempt agent-session
   * rows, 28 recorded `…/app.slice/papercup-bg-host.service`, yet 27 of those 28
   * pids were alive INSIDE their own correct `pc-<taskId>--*.scope`. The field
   * was simply stale.
   *
   * Both failure modes of trusting it are severe and were both observed:
   *   - reading pids from the spawner's cgroup counts the OPERATOR'S OWN
   *     processes as "survivors" (this produced the 0/12 pass that tried to stop
   *     12 scopes which never existed, once every 5 minutes for an hour), and
   *   - filtering on it EXCLUDES genuine residue whose scope is real — including
   *     a session log-silent for 10h with no presence heartbeat at all.
   *
   * Deriving the directory from `scopeUnit` (see `scopeCgroupRelPath`) answers
   * both correctly from ground truth: a phantom scope is simply absent, so it
   * reads 0 and is skipped instead of being stopped and failing.
   */
  scopePidCount: (row: TaskRow) => number | null;
  /** Positive recheck for a no-row candidate. Missing means candidates are spared. */
  scopePidCountForScope?: (scopeUnit: string) => number | null;
  /** Live out-of-scope parent still holding a no-row candidate (`readScopeHolder`).
   *  Missing reads as unmeasurable, so candidates are spared. */
  scopeHolderForScope?: (scopeUnit: string) => ScopeHolder | null | 'unreadable';
  /** coord_presence owner_ids with a heartbeat fresher than REAP_PRESENCE_FRESH_MS. */
  freshOwners: ReadonlySet<string>;
  /** ms since the row's log was last written; null = unmeasurable. Consulted for
   *  TERMINAL rows only (live rows are judged by the census) — the carry-respawn
   *  guard above. */
  logQuietForMs: (row: TaskRow) => number | null;
  /**
   * For a LIVE consult answering session: is its consult settled for it
   * (`consultSettlement`)? Missing ⇒ the consult-settled class is off for the
   * tick; null for a row ⇒ unknown / still active, never a reap.
   */
  consultSettlementFor?: (row: TaskRow, facts: ConsultAnswerFacts) => ConsultSettlement | null;
  now: number;
  maxPerTick?: number;
}

export interface ReaperVerdict {
  reap: ReapDecision[];
  spared: SpareDecision[];
  /** True when the quiet-zombie class was skipped because the census degraded. */
  quietClassDisabled: boolean;
  /** Candidates beyond the per-tick cap — next tick's work, reported not lost. */
  deferred: number;
}

/** The owner id a ledger row maps to, when the spawner recorded one. */
export function rowOwnerId(row: Pick<TaskRow, 'detail'>): string | null {
  const d = row.detail ?? {};
  const v = d.ownerId ?? d.coordOwnerId ?? d.owner;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function decideReaps(inputs: ReaperInputs): ReaperVerdict {
  const cap = inputs.maxPerTick ?? REAP_MAX_PER_TICK;
  const reap: ReapDecision[] = [];
  const spared: SpareDecision[] = [];

  const quietByTask = new Map(inputs.census.quietRows.map((r) => [r.taskId, r]));
  const quietClassDisabled = inputs.census.degraded;

  for (const row of inputs.rows) {
    if (row.class !== 'agent-session') continue;
    // `scopeUnit` is the ONLY addressability key, and it is a UNIQUE column
    // (`task_ledger_scope_unit_key`). Everything below resolves through it.
    if (!row.scopeUnit) continue;
    if (isAutoReapExempt(row)) {
      spared.push({ taskId: row.taskId, why: 'autoReapExempt (D-001 terminal-psu-session-enrolment)' });
      continue;
    }

    const terminal = isTerminalState(row.state) || row.endedAt != null;
    if (terminal) {
      const endedMs = row.endedAt ? Date.parse(row.endedAt) : NaN;
      if (!Number.isFinite(endedMs)) continue; // no trustworthy end time — not this pass's call
      if (inputs.now - endedMs < REAP_TERMINAL_GRACE_MS) continue; // within grace
      const pids = inputs.scopePidCount(row);
      if (pids === null) continue; // unreadable is not "has processes"
      if (pids <= 0) continue; // nothing survives — systemd will collect the empty scope
      const logQuiet = inputs.logQuietForMs(row);
      if (logQuiet !== null && logQuiet < REAP_TERMINAL_LOG_QUIET_MS) {
        // Terminal row, live log: a successor generation (carry-respawn) is in
        // this scope. Never reap it — surface the anomaly instead.
        spared.push({
          taskId: row.taskId,
          why: `ANOMALY: row ${row.state} but log written ${Math.round(logQuiet / 60_000)}min ago — live successor in scope, investigate`,
        });
        continue;
      }
      reap.push({
        taskId: row.taskId,
        scopeUnit: row.scopeUnit,
        logPath: row.logPath ?? null,
        kind: 'terminal-residue',
        why: `row ${row.state} ${Math.round((inputs.now - endedMs) / 60_000)}min ago, ${pids} process(es) survive`,
      });
      continue;
    }

    // Live row — consult-settled class first: a one-question session whose
    // consult is over has no further purpose, however recently it wrote its log.
    const consult = consultAnswerFacts(row);
    if (consult && inputs.consultSettlementFor) {
      const settled = inputs.consultSettlementFor(row, consult);
      if (settled) {
        const since = settled.settledAtMs ?? Date.parse(row.startedAt);
        const age = Number.isFinite(since) ? inputs.now - since : NaN;
        if (Number.isFinite(age) && age >= REAP_CONSULT_SETTLED_GRACE_MS) {
          const pids = inputs.scopePidCount(row);
          if (pids !== null && pids > 0) {
            reap.push({
              taskId: row.taskId,
              scopeUnit: row.scopeUnit,
              logPath: row.logPath ?? null,
              kind: 'consult-settled',
              why: `consult answering session (${consult.operation ?? '?'}): ${settled.why} ${Math.round(age / 60_000)}min ago, ${pids} process(es)`,
            });
            continue;
          }
        }
      }
    }

    // Live row — quiet-zombie class.
    const quietRow = quietByTask.get(row.taskId);
    if (!quietRow) continue; // active / too-young / no-log / unreadable — never residue
    if (quietClassDisabled) {
      spared.push({ taskId: row.taskId, why: 'census degraded — quiet class disabled this tick' });
      continue;
    }
    const owner = rowOwnerId(row);
    // A consult answering session's heartbeat is a process keepalive, not
    // activity (see the header above `ConsultAnswerFacts`), so it cannot veto.
    if (owner && inputs.freshOwners.has(owner) && !consult) {
      spared.push({ taskId: row.taskId, why: `log quiet ${quietRow.quietMinutes}min but presence heartbeat fresh (${owner})` });
      continue;
    }
    const pids = inputs.scopePidCount(row);
    if (pids === null || pids <= 0) continue;
    reap.push({
      taskId: row.taskId,
      scopeUnit: row.scopeUnit,
      logPath: row.logPath ?? null,
      kind: 'quiet-zombie',
      why:
        `log quiet ${quietRow.quietMinutes}min, ` +
        (consult
          ? `consult answering session (presence keepalive is not activity)`
          : `owner ${owner ? 'presence-stale' : 'unmapped'}`) +
        `, ${pids} process(es)`,
    });
  }

  // A residue placeholder is deliberately not coerced into a synthetic ledger
  // row: doing so would make a no-row process look owned by an invented record.
  // Recheck the exact scope at decision time and skip it if an ordinary row has
  // arrived since the reconcile scan (the normal register/adoption race).
  const rowTaskIds = new Set(inputs.rows.map((row) => row.taskId));
  const rowScopes = new Set(inputs.rows.map((row) => row.scopeUnit).filter(Boolean));
  for (const candidate of inputs.managedResidue ?? []) {
    if (rowTaskIds.has(candidate.taskId) || rowScopes.has(candidate.scopeUnit)) continue;
    const pids = inputs.scopePidCountForScope?.(candidate.scopeUnit);
    if (pids == null || pids <= 0) continue;
    // Only a MISSING probe is unmeasurable: null is the probe's positive "no holder".
    const holder = inputs.scopeHolderForScope ? inputs.scopeHolderForScope(candidate.scopeUnit) : 'unreadable';
    if (holder === 'unreadable') {
      spared.push({
        taskId: candidate.taskId,
        why: `managed scope ${candidate.scopeUnit}: no member's parent could be read, so its holder is unmeasurable`,
      });
      continue;
    }
    if (holder) {
      spared.push({
        taskId: candidate.taskId,
        why:
          `managed scope ${candidate.scopeUnit} has no ledger row but live parent pid ${holder.pid} ` +
          `(${holder.comm}) outside it still holds it — a live spawner, e.g. an isolated store's operator`,
      });
      continue;
    }
    reap.push({
      taskId: candidate.taskId,
      scopeUnit: candidate.scopeUnit,
      logPath: candidate.logPath ?? null,
      kind: 'managed-residue',
      why:
        `managed scope ${candidate.scopeUnit} has no ledger row after ` +
        `two-scan confirmation, ${pids} process(es) survive the positive recheck`,
    });
  }

  // Longest-standing residue first, bounded per tick.
  const order: Record<ReapKind, number> = {
    'terminal-residue': 0,
    'managed-residue': 1,
    'consult-settled': 2,
    'quiet-zombie': 3,
  };
  reap.sort((a, b) => order[a.kind] - order[b.kind]);
  const deferred = Math.max(0, reap.length - cap);
  return { reap: reap.slice(0, cap), spared, quietClassDisabled, deferred };
}

// ── execution (all IO injected) ─────────────────────────────────────────────

export interface ReapEffects {
  /** Preserve the session's log tail BEFORE the kill. Must never throw. */
  archiveTail(decision: ReapDecision): Promise<string | null>;
  /** `systemctl --user stop <scopeUnit>` — the addressable subtree kill. */
  stopUnit(scopeUnit: string): Promise<boolean>;
  /** Close a still-running row as stranded with the reap reason. Idempotent. */
  closeAsReaped(taskId: string, why: string): Promise<void>;
}

export interface ReapOutcome {
  taskId: string;
  scopeUnit: string;
  kind: ReapKind;
  ok: boolean;
  archived: string | null;
  note?: string;
}

// ── the recurrence guard (P-006) ────────────────────────────────────────────
//
// Enforcement that silently stops working is the failure this whole work-item
// exists to end: every prior fix improved a census, nothing watched the fix, and
// the residue regrew. So the reaper measures ITSELF.
//
// The measured quantity is the residue that SURVIVED a pass. Its healthy value
// is ZERO — a working pass leaves nothing behind — which is what makes it a
// usable floor. A busy host does not raise it; only a reaper that cannot clear
// what it selected does.
//
// THE ALARM CONDITION IS "SUSTAINED NON-ZERO", NOT "GROWING" — and that choice
// is load-bearing, so here is the reasoning rather than the conclusion.
//
// The obvious detector to reach for is the dead-window census's
// `evaluateResidueTrend`: compare a recent floor against an earlier floor and
// alarm when it climbs. Checked against the REAL incident, it fails. On
// 2026-08-25 the first deployed pass failed 0/12 every five minutes for an hour:
// the survivor count sat at a FLAT 12, so recent floor 12, earlier floor 12,
// growth delta ZERO. A growth detector would have watched that entire hour in
// silence and reported steady.
//
// A growth term is also formally REDUNDANT here, which is why none is offered.
// `recentFloor > olderFloor >= 0` implies every recent sample is >= 1, which
// implies the last N samples are all non-zero — so `stuck` has already fired.
// Growth is only meaningful for a metric whose healthy value is non-zero (the
// dead-window census, where scopes legitimately exist and churn). THIS metric's
// healthy value is ZERO, so "still non-zero N passes later" already IS the
// accumulation signal. Adding a growth branch would be unreachable code carrying
// a test that could never fail — the exact shape of a detector that reassures
// without detecting.
//
// The alarm is an ESCALATION, not a message: the report-only era proved that a
// `message` about accumulating residue reads as weather and is actioned by no one.

/** Consecutive residue-leaving passes before the alarm fires. Three, per P-006. */
export const REAPER_FLOOR_MIN_CONSECUTIVE = 3;

export interface ReaperFloorSample {
  atMs: number;
  /** Residue that survived that pass. Named to match the persisted ring's shape. */
  scopesDead: number;
}

export interface ReaperFloorVerdict {
  alarm: boolean;
  kind: 'stuck' | null;
  /** How many of the most recent passes, consecutively, left residue behind. */
  consecutiveNonZero: number;
  summary: string;
}

/**
 * PURE: how much of what this pass SELECTED it could not clear.
 *
 * Attempted-but-failed stops, and nothing else. The alarm this feeds says
 * "enforcement is selecting scopes it cannot clear", so everything counted here
 * must be evidence of INABILITY — not of restraint, and not of throughput.
 * Two exclusions, both deliberate, both for that one reason:
 *
 *   - a SPARED row is the rails working as designed (exempt session, live
 *     successor in the scope, degraded census). Counting it would make correct
 *     caution indistinguishable from failure.
 *   - a DEFERRED row is one the per-tick cap did not reach. The reaper did not
 *     try and fail; it has not tried yet, and the next pass will. Counting it
 *     made any healthy backlog drain wider than REAP_MAX_PER_TICK alarm on its
 *     third consecutive pass, carrying a diagnosis that was flatly untrue —
 *     the scopes were being cleared, just rate-limited. Deferral is reported in
 *     the pass line and in the alarm body as context; it is not evidence of a
 *     stuck reaper. (Found 2026-08-25 while writing this plan's acceptance
 *     rubric: the drift marker that rejected spared rows applies verbatim to
 *     deferred ones, and the original implementation counted them.)
 *
 * The incident this guard exists for is untouched: 12 selected, 0 reaped, 12
 * FAILED, flat across every pass, is twelve failures and still fires.
 */
export function residualAfterPass(outcomes: readonly ReapOutcome[]): number {
  return outcomes.filter((o) => !o.ok).length;
}

/**
 * PURE: is the reaper failing to clear what it selects?
 *
 * Thin history answers `alarm:false` WITH a summary that says so — never a
 * reassuring "healthy". Same rule the dead-window trend follows: a detector that
 * cannot tell must say it cannot tell, or a storage failure launders as green.
 */
export function evaluateReaperFloor(
  samples: readonly ReaperFloorSample[],
  opts: { minConsecutive?: number },
): ReaperFloorVerdict {
  const minConsecutive = opts.minConsecutive ?? REAPER_FLOOR_MIN_CONSECUTIVE;
  const ordered = [...samples].sort((a, b) => a.atMs - b.atMs);

  // Counted over the sample TAIL, not a wall-clock window: N consecutive passes
  // that each left residue is the same evidence whatever the tick cadence, and a
  // window would silently stop judging if the interval were ever retuned.
  let consecutiveNonZero = 0;
  for (let i = ordered.length - 1; i >= 0 && ordered[i]!.scopesDead > 0; i--) consecutiveNonZero++;

  const tail = ordered.slice(-minConsecutive);
  if (tail.length >= minConsecutive && tail.every((s) => s.scopesDead > 0)) {
    return {
      alarm: true,
      kind: 'stuck',
      consecutiveNonZero,
      summary:
        `agent-session reaper has left residue behind on ${consecutiveNonZero} consecutive ` +
        `pass(es) (last ${tail.length}: ${tail.map((s) => s.scopesDead).join(',')}) — ` +
        `enforcement is selecting scopes it cannot clear`,
    };
  }

  if (ordered.length < minConsecutive) {
    // Thin history is NOT health. Same rule the dead-window trend follows: a
    // detector that cannot yet judge must say so, or an empty/unreadable ring
    // launders as green.
    return {
      alarm: false,
      kind: null,
      consecutiveNonZero,
      summary: `only ${ordered.length} sample(s) — no verdict yet, which is not the same as healthy`,
    };
  }

  return {
    alarm: false,
    kind: null,
    consecutiveNonZero,
    summary: `reaper floor clear (last ${tail.length} pass(es) left ${tail.map((s) => s.scopesDead).join(',')})`,
  };
}

export async function executeReaps(
  decisions: readonly ReapDecision[],
  effects: ReapEffects,
): Promise<ReapOutcome[]> {
  const out: ReapOutcome[] = [];
  for (const d of decisions) {
    let archived: string | null = null;
    try {
      archived = await effects.archiveTail(d);
    } catch {
      archived = null; // archiving is best-effort; the reap decision stands
    }
    let ok = false;
    let note: string | undefined;
    try {
      ok = await effects.stopUnit(d.scopeUnit);
      // Both classes stop a row the ledger still records as RUNNING.
      if (ok && (d.kind === 'quiet-zombie' || d.kind === 'consult-settled')) {
        await effects.closeAsReaped(d.taskId, d.why);
      }
    } catch (err) {
      note = (err as Error).message?.slice(0, 200);
    }
    out.push({ taskId: d.taskId, scopeUnit: d.scopeUnit, kind: d.kind, ok, archived, note });
  }
  return out;
}
