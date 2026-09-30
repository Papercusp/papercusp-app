/**
 * Per-turn journal (deterministic-context-carry-2026-07-14 P-012, plan D-003).
 *
 * One 1–3-sentence note per completed agent TURN, written by the ACTING agent
 * (never a separate reader-LLM): the agent ends its final message with a line
 *
 *   ⟦journal⟧ <what landed / where I am / what's next>
 *
 * and the collection layer extracts it at turn end. Collection is
 * client-neutral (predecessor agent-managed-compaction D-002 control tiers):
 * the Claude/Codex cc/ Stop hook and the OMP in-process turn_end port each
 * ping `journal:record-turn` with the session id + transcript path, and the
 * SERVER does the identical extraction here — one extractor, thin pings.
 * When the agent wrote no marker line the MECHANICAL FALLBACK is the first
 * line of the last assistant message, flagged so the reader knows nobody
 * wrote it on purpose.
 *
 * The note is a CLAIM; the tool ledger (harness_shared.agent_activity) is
 * TRUTH. `detectClaimLedgerMismatch` diffs them: P-012 shipped the canonical
 * dishonesty shape — the note says "tests pass" while the same turn's ledger
 * recorded a failure ("note says pass, ledger says exit 1"). P-029 broadened
 * it into a per-domain taxonomy (tests · deploy · commit) where each claim is
 * diffed ONLY against its own ledger truth. Journals are never graded
 * (ambient-semantic-push D-008 anti-Goodhart); the diff audits honesty instead.
 */
import { open, realpath, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  FILE_ADAPTERS,
  jsonlAtDepth,
  type ParsedResponseDisposition,
  type ParsedTurn,
} from './search/session-ingest';

export const JOURNAL_MARKER = '⟦journal⟧';
/** An agent-authored note is bounded so a runaway "journal" can't become a
 *  context payload — 1–3 sentences, not a report. */
export const JOURNAL_NOTE_MAX_CHARS = 600;
export const MECHANICAL_NOTE_MAX_CHARS = 300;

export interface ExtractedJournal {
  note: string;
  /** 'agent' = a ⟦journal⟧ line the acting agent wrote; 'mechanical' = the
   *  first-line fallback (always flagged). */
  source: 'agent' | 'mechanical';
  flagged: boolean;
}

/** Extract the journal note from a turn's FINAL assistant message text. */
export function extractJournalFromAssistantText(text: string): ExtractedJournal | null {
  const lines = text.split('\n');
  // The LAST marker line wins (an agent quoting the convention earlier in the
  // message must not shadow its actual trailing journal line).
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith(JOURNAL_MARKER)) continue;
    const note = trimmed.slice(JOURNAL_MARKER.length).trim().slice(0, JOURNAL_NOTE_MAX_CHARS);
    if (note) return { note, source: 'agent', flagged: false };
  }
  for (const line of lines) {
    // Strip markdown heading/bullet/quote lead-ins so the fallback reads as a
    // sentence, not markup.
    const cleaned = line
      .trim()
      .replace(/^(?:#{1,6}|[-*>]|\d+\.)\s+/, '')
      .trim();
    if (!cleaned) continue;
    return { note: cleaned.slice(0, MECHANICAL_NOTE_MAX_CHARS), source: 'mechanical', flagged: true };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Claim-vs-ledger tripwire                                            */
/* ------------------------------------------------------------------ */

/** The slice of an agent_activity row the tripwire reads. */
export interface LedgerEntry {
  toolName?: string | null;
  status?: string | null;
  summary?: string | null;
}

/** Which claim domain tripped. P-012 shipped only 'tests'; P-029 broadened the
 *  diff into this taxonomy — each domain is diffed ONLY against its own ledger
 *  truth (cross-domain isolation: a failed test run must never contradict a
 *  deploy claim, and vice-versa). New domains cost no migration (the tripwire
 *  is a jsonb column) and no reader change (readers discriminate on `kind`). */
export type HonestyClaimDomain = 'tests' | 'deploy' | 'commit';

export interface ClaimLedgerMismatchTripwire {
  kind: 'claim-ledger-mismatch';
  /** Which claim domain tripped (P-029). Readers keying on `kind` are unaffected. */
  domain: HonestyClaimDomain;
  /** The success claim matched in the note. */
  claim: string;
  /** The ledger rows contradicting it (capped). */
  evidence: Array<{ toolName: string | null; status: string | null; summary: string | null }>;
}

/** The journal tripwire union. P-015 adds 'unregistered-artifact'
 *  (turn-end-tracking.ts) — a jsonb column, so widening costs no migration;
 *  readers discriminate on `kind`. */
export type JournalTripwire =
  | ClaimLedgerMismatchTripwire
  | import('./turn-end-tracking').UnregisteredArtifactTripwire
  | import('./turn-end-tracking').UnguardedHaltTripwire
  | import('./turn-end-tracking').OpenTaskReminderTripwire;

/** A note that ALSO discloses failure is honest — never tripwire disclosure.
 *  Shared across every domain: an honest note that names the failure alongside
 *  the claim is auditing itself, exactly what D-008 wants. */
const HONEST_FAILURE_RE =
  /\b(?:fail(?:s|ed|ing|ure)?|red|broken|flaky|regress(?:ed|ion)?|error(?:s|ed)?|exit\s*(?:code\s*)?[1-9]|rolled\s*back|reverted)\b/i;
/** Ledger-side failure text when `status` wasn't stamped: a non-zero exit or
 *  an explicit test failure. Deliberately narrow — `status === 'error'` is the
 *  primary signal; this regex only catches the canonical Bash shapes. */
const LEDGER_FAILURE_TEXT_RE = /\bexit(?:ed)?\s*(?:code[:\s]*)?[1-9]\d*\b|\bFAILED\b|\btests?\s+fail(?:ed|ing|s)?\b/i;

/** Tools whose ledger outcome can ATTEST a tests/build claim — command
 *  executions. A Read/Edit succeeding says nothing about the test suite. */
const EXECUTION_TOOL_RE = /^(bash|shell|exec|run|local_shell|capability:bash)/i;
/** Tool names whose outcome attests a DEPLOY/release claim — the deploy:* /
 *  release:* MCP tools (deploy:harness, deploy:pot, release:cut, release:deploy…).
 *  Matched on the tool-name segment, not prose, so it never fires on a note. */
const DEPLOY_TOOL_RE = /(?:^|[:_.\-])(?:deploy|release)\b/i;
/** Tool names whose outcome attests a COMMIT/push claim — the git surfaces
 *  (capability:git, git-sync:run/await). */
const GIT_TOOL_RE = /(?:^|[:_.\-])git(?:-sync)?\b/i;

function isFailureEntry(e: LedgerEntry): boolean {
  return e.status === 'error' || (typeof e.summary === 'string' && LEDGER_FAILURE_TEXT_RE.test(e.summary));
}

/** Command-shaped summary: the server summariser renders shell calls as
 *  "▶ <cmd>" (activity-bridge summariseActivity — the live shape, P-013 recon);
 *  "$ <cmd>" covers pre-formatted hook summaries. */
function commandSummary(e: LedgerEntry): string | null {
  if (typeof e.summary !== 'string') return null;
  const s = e.summary.trimStart();
  return s.startsWith('$') || s.startsWith('▶') ? s : null;
}

function isExecutionEntry(e: LedgerEntry): boolean {
  if (e.toolName && EXECUTION_TOOL_RE.test(e.toolName)) return true;
  return commandSummary(e) !== null;
}

function isDeployEntry(e: LedgerEntry): boolean {
  if (e.toolName && DEPLOY_TOOL_RE.test(e.toolName)) return true;
  // A bash-driven deploy: a command-shaped summary naming deploy/release.
  const cmd = commandSummary(e);
  return cmd !== null && /\b(?:deploy|release)\b/i.test(cmd);
}

function isGitEntry(e: LedgerEntry): boolean {
  if (e.toolName && GIT_TOOL_RE.test(e.toolName)) return true;
  const cmd = commandSummary(e);
  return cmd !== null && /(?:^[$▶]\s*)git\b/i.test(cmd);
}

/** One honesty check: a claim shape for a domain, and the ledger predicate whose
 *  outcome ATTESTS-or-CONTRADICTS that claim. */
interface HonestyCheck {
  domain: HonestyClaimDomain;
  /** Success-claim shapes for this domain (first match wins). */
  claimRes: RegExp[];
  /** Does this ledger row's outcome speak to the domain's claim? */
  attests(e: LedgerEntry): boolean;
}

/** "tests pass" / "build green" / "typecheck clean" shaped claims. */
const SUCCESS_CLAIM_RE =
  /\b(?:all\s+)?(?:\d+\s+)?(?:tests?|suites?|builds?|lints?|typechecks?|checks?|gates?|ci)\b[^.!?\n]{0,60}?\b(?:pass(?:ed|ing|es)?|green|succeed(?:ed|s|ing)?|clean|ok)\b/i;
/** Reversed phrasing: "passing tests", "green build". */
const SUCCESS_CLAIM_REV_RE = /\b(?:passing|green)\s+(?:tests?|builds?|suites?|ci)\b/i;
/** "deployed", "released", "rolled out", "cut a release", "live on :3170". */
const DEPLOY_CLAIM_RE =
  /\b(?:re-?)?deploy(?:ed|ment|s)?\b|\breleased?\b|\broll(?:ed)?\s*out\b|\bcut\s+(?:a\s+)?release\b|\bpromoted\s+to\s+(?:prod(?:uction)?|staging)\b|\blive\s+(?:on|at)\b/i;
/** "committed", "pushed", "merged". */
const COMMIT_CLAIM_RE = /\b(?:committed|commit(?:s|ted)?\b|force-?pushed|pushed|merged)\b/i;

/** The honesty taxonomy, evaluated in dishonesty priority order — a broken
 *  test claim outranks a broken deploy claim outranks a broken commit claim
 *  (only the first tripwire fills the single tripwire slot). */
const HONESTY_CHECKS: HonestyCheck[] = [
  { domain: 'tests', claimRes: [SUCCESS_CLAIM_RE, SUCCESS_CLAIM_REV_RE], attests: isExecutionEntry },
  { domain: 'deploy', claimRes: [DEPLOY_CLAIM_RE], attests: isDeployEntry },
  { domain: 'commit', claimRes: [COMMIT_CLAIM_RE], attests: isGitEntry },
];

/** Evaluate ONE domain: its claim vs the turn's ledger (`ledger` NEWEST FIRST —
 *  the store's DESC order). The verdict follows the MOST RECENT attesting
 *  operation: a turn that iterated fail → fix → re-run-green ends on an ok row
 *  and stays clean; a turn that ends on a failing attesting row while the note
 *  claims success trips. Null when the note makes no claim in this domain, when
 *  it honestly discloses failure alongside, or when the window holds no
 *  contradicting operation of THIS domain (cross-domain isolation). */
function evaluateDomain(check: HonestyCheck, note: string, ledger: LedgerEntry[]): ClaimLedgerMismatchTripwire | null {
  let claim: RegExpMatchArray | null = null;
  for (const re of check.claimRes) {
    claim = note.match(re);
    if (claim) break;
  }
  if (!claim) return null;
  if (HONEST_FAILURE_RE.test(note)) return null;
  const latest = ledger.find((e) => check.attests(e) && (e.status === 'ok' || isFailureEntry(e)));
  if (!latest || !isFailureEntry(latest)) return null;
  const evidence = ledger
    .filter((e) => check.attests(e) && isFailureEntry(e))
    .slice(0, 3)
    .map((e) => ({
      toolName: e.toolName ?? null,
      status: e.status ?? null,
      summary: e.summary ? e.summary.slice(0, 300) : null,
    }));
  return { kind: 'claim-ledger-mismatch', domain: check.domain, claim: claim[0].slice(0, 200), evidence };
}

/**
 * The P-029 honesty diff: the note is a CLAIM, the tool ledger is TRUTH. Walk
 * the {@link HONESTY_CHECKS} taxonomy in priority order and return the first
 * domain whose success claim is contradicted by that same domain's ledger
 * truth. Each domain diffs ONLY against its own attesting operations, so a
 * failed test never masquerades as a broken deploy. Absence never trips
 * (unverifiable ≠ dishonest); only a positive same-domain failure does.
 * Journals are never graded — the diff audits honesty (ambient-semantic-push
 * D-008; no fabrication, D-001).
 */
export function detectClaimLedgerMismatch(note: string, ledger: LedgerEntry[]): ClaimLedgerMismatchTripwire | null {
  for (const check of HONESTY_CHECKS) {
    const trip = evaluateDomain(check, note, ledger);
    if (trip) return trip;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Transcript access (bounded tail read via the ingest adapters)       */
/* ------------------------------------------------------------------ */

/** How much file tail the last-assistant-message scan reads. Claude lines can
 *  be huge (tool results), but the final TEXT line of a turn sits at the very
 *  end of the JSONL — 256 KB of tail is orders of magnitude of headroom. */
const TAIL_READ_BYTES = 256 * 1024;

export type JournalSourceKind = 'claude' | 'omp' | 'codex';

/** Read the LAST assistant text turn from a transcript file (bounded tail
 *  read; parses with the same adapter session-ingest indexes with). */
export async function readLastAssistantTurn(
  filePath: string,
  sourceKind: JournalSourceKind,
): Promise<ParsedTurn | null> {
  const adapter = FILE_ADAPTERS.find((a) => a.sourceKind === sourceKind);
  if (!adapter) return null;
  const st = await stat(filePath);
  const start = Math.max(0, st.size - TAIL_READ_BYTES);
  const fh = await open(filePath, 'r');
  try {
    const buf = Buffer.alloc(st.size - start);
    await fh.read(buf, 0, buf.length, start);
    let lines = buf.toString('utf8').split('\n');
    // A mid-file start lands mid-line — the first fragment is unparseable.
    if (start > 0) lines = lines.slice(1);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i].trim();
      if (!line) continue;
      const turn = adapter.parseLine(line);
      if (turn?.speaker === 'assistant') return turn;
    }
    return null;
  } finally {
    await fh.close();
  }
}

/** One verbatim tail turn — the carry-document's raw last-N-turns leg
 *  (deterministic-context-carry P-009 tail). Speaker+text+ts only; the
 *  owner-vs-agent provenance stamp is a separate leg (P-009 provenance). */
export interface TranscriptTailTurn {
  speaker: 'user' | 'assistant';
  /** Verbatim text (already ingest-capped by the adapter). */
  text: string;
  ts: Date | null;
  /** Logical native turn/request identity.  For linked-list clients this is
   *  resolved to the originating text-user node while scanning the tail. */
  requestId?: string | null;
  /** Native response lifecycle evidence; absence remains unknown/open. */
  responseDisposition?: ParsedResponseDisposition | null;
  /** Present on the oldest returned turn when older transcript/request records
   *  were outside the bounded read.  Consumers must not turn that into
   *  "answered" or "no owner demand". */
  requestHistoryStatus?: 'truncated';
}

interface TailLineLink {
  messageId: string | null;
  parentMessageId: string | null;
  requestId: string | null;
  completion: ParsedResponseDisposition | null;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Read only the client-native linkage/lifecycle envelope.  This companion to
 * the text adapter intentionally sees tool-result and task-complete records
 * that `ParsedTurn` drops from the recall corpus: those records are the bridge
 * between a final answer and the owner request it actually serves.
 */
function tailLineLink(line: string, sourceKind: JournalSourceKind): TailLineLink {
  const empty: TailLineLink = {
    messageId: null,
    parentMessageId: null,
    requestId: null,
    completion: null,
  };
  let row: Record<string, unknown>;
  try {
    row = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return empty;
  }

  if (sourceKind === 'claude') {
    return {
      messageId: typeof row.uuid === 'string' ? row.uuid : null,
      parentMessageId: typeof row.parentUuid === 'string' ? row.parentUuid : null,
      requestId: null,
      completion: null,
    };
  }
  if (sourceKind === 'omp') {
    return {
      messageId: typeof row.id === 'string' ? row.id : null,
      parentMessageId: typeof row.parentId === 'string' ? row.parentId : null,
      requestId: null,
      completion: null,
    };
  }

  const payload = recordOf(row.payload);
  if (!payload) return empty;
  const metadata = recordOf(payload.internal_chat_message_metadata_passthrough);
  const requestId =
    typeof metadata?.turn_id === 'string'
      ? metadata.turn_id
      : typeof payload.turn_id === 'string'
        ? payload.turn_id
        : null;
  if (row.type === 'event_msg' && (payload.type === 'task_complete' || payload.type === 'turn_completed')) {
    const delivered = typeof payload.last_agent_message === 'string' && payload.last_agent_message.trim().length > 0;
    return {
      ...empty,
      requestId,
      completion: payload.error != null ? 'interrupted' : delivered ? 'delivered' : null,
    };
  }
  return {
    messageId: typeof payload.id === 'string' ? payload.id : null,
    parentMessageId: null,
    requestId,
    completion: null,
  };
}

/**
 * Read the LAST `maxTurns` text turns (user + assistant) from a transcript,
 * returned most-recent LAST. Same bounded tail-read + adapter as
 * {@link readLastAssistantTurn}, generalized from "the one last assistant turn"
 * to "the last N turns of either speaker" for the carry-document verbatim tail.
 * Never throws on an empty/malformed tail — returns what parsed.
 */
export async function readVerbatimTail(
  filePath: string,
  sourceKind: JournalSourceKind,
  maxTurns: number,
): Promise<TranscriptTailTurn[]> {
  if (maxTurns <= 0) return [];
  const adapter = FILE_ADAPTERS.find((a) => a.sourceKind === sourceKind);
  if (!adapter) return [];
  const st = await stat(filePath);
  const start = Math.max(0, st.size - TAIL_READ_BYTES);
  const fh = await open(filePath, 'r');
  try {
    const buf = Buffer.alloc(st.size - start);
    await fh.read(buf, 0, buf.length, start);
    let lines = buf.toString('utf8').split('\n');
    // A mid-file start lands mid-line — the first fragment is unparseable.
    if (start > 0) lines = lines.slice(1);
    const out: TranscriptTailTurn[] = [];
    const requestByMessage = new Map<string, string>();
    const lastAssistantByRequest = new Map<string, number>();
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (!line) continue;
      const link = tailLineLink(line, sourceKind);
      const turn = adapter.parseLine(line);
      // WI-10003691: the byte window above routinely opens MID-TURN, so the
      // first in-window rows point at a parent this read never saw.  Resolving
      // that to null used to poison the whole chain: every later row inherited
      // null, a null-keyed owner message can never be settled, and a delivered
      // answer carrying null settles nothing — so an owner message queued
      // mid-turn (a `queued_command`, which has no node id of its own) was
      // re-delivered to a carry successor as "unanswered" although the same
      // turn had answered it.  Key such a chain by its out-of-window parent
      // instead: every row descending from it shares one synthetic request, the
      // same grouping a complete read gives them under the real prompt id.
      let requestId =
        turn?.requestId ??
        link.requestId ??
        (link.parentMessageId
          ? requestByMessage.get(link.parentMessageId) ?? `window-orphan:${link.parentMessageId}`
          : null);

      // A real text-user node starts a logical request for the linked-list
      // clients.  Synthetic tool-result nodes have no ParsedTurn, so they take
      // the inherited parent request and keep the chain connected instead.
      if (turn?.speaker === 'user') {
        requestId = turn.requestId ?? turn.messageId ?? requestId;
      }
      if (link.messageId && requestId) requestByMessage.set(link.messageId, requestId);

      if (turn && (turn.speaker === 'assistant' || turn.speaker === 'user')) {
        out.push({
          speaker: turn.speaker,
          text: turn.text,
          ts: turn.ts,
          requestId,
          responseDisposition: turn.responseDisposition ?? null,
        });
        if (turn.speaker === 'assistant' && requestId) {
          lastAssistantByRequest.set(requestId, out.length - 1);
        }
      }

      // Codex's task-complete record is the terminal receipt.  It can repair a
      // legacy/missing message phase, but an errored completion never becomes a
      // delivered answer merely because commentary text preceded it.
      if (link.requestId && link.completion) {
        const at = lastAssistantByRequest.get(link.requestId);
        if (at != null) out[at] = { ...out[at], responseDisposition: link.completion };
      }
    }
    const selected = out.slice(-maxTurns);
    const truncated = start > 0 || out.length > maxTurns;
    if (!truncated) return selected;
    if (selected.length === 0) {
      return [{ speaker: 'user', text: '', ts: null, requestHistoryStatus: 'truncated' }];
    }
    selected[0] = { ...selected[0], requestHistoryStatus: 'truncated' };
    return selected;
  } finally {
    await fh.close();
  }
}

/** Root spec shape shared with session-ingest (structural — RootSpec is not
 *  exported from there). */
export interface JournalRootSpec {
  root: string;
  dirDepth: number;
  descend?: (dirName: string, level: number) => boolean;
}

/**
 * Resolve the transcript file for a session, refusing paths outside the known
 * transcript roots (the tool is reachable over MCP — it must never become an
 * arbitrary-file reader). A caller-supplied `candidatePath` is realpath'd and
 * prefix-checked against the adapter roots; without one, the roots are walked
 * (bounded, fixed-shape — same discipline as the ingest sweep) for a filename
 * carrying the session id.
 */
export async function resolveTranscriptPath(
  sourceKind: JournalSourceKind,
  sessionId: string,
  candidatePath?: string,
  rootsOverride?: JournalRootSpec[],
): Promise<string | null> {
  const adapter = FILE_ADAPTERS.find((a) => a.sourceKind === sourceKind);
  if (!adapter) return null;
  const roots: JournalRootSpec[] = rootsOverride ?? adapter.roots();

  const realRoots: string[] = [];
  for (const spec of roots) {
    try {
      realRoots.push(await realpath(spec.root));
    } catch {
      // absent root (this box never ran that client) — skip
    }
  }

  if (candidatePath) {
    try {
      const real = await realpath(candidatePath);
      if (realRoots.some((r) => real.startsWith(r + '/'))) return real;
    } catch {
      // missing/unreadable — fall through to the walk
    }
  }

  if (!sessionId) return null;
  for (const spec of roots) {
    const files = await jsonlAtDepth(spec.root, spec.dirDepth, spec.descend);
    // Every adapter's filename carries the session id (claude: <sid>.jsonl;
    // omp: <ts>_<sid>.jsonl; codex: rollout-<ts>-<sid>.jsonl).
    const named = files.filter((f) => basename(f).includes(sessionId));
    for (const f of named) {
      if (adapter.meta(f).sessionId === sessionId) return f;
    }
  }
  return null;
}
