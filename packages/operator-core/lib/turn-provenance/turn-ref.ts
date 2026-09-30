/**
 * turn-ref.ts — durable, verifiable references to specific turns
 * (deterministic-context-carry-2026-07-14 P-014).
 *
 * The live turn-provenance ledger (./turn-provenance.ts) is short-TTL by design
 * — it answers "was THIS prompt just injected?" at prompt-submit. A directive
 * carried on a carry surface ("the owner said X") outlives that window, so it
 * needs a DURABLE anchor: a turn ref
 *
 *   [turn:<session-prefix>@<iso-ts>]
 *
 * naming the recorded transcript turn the directive came from. Verification is
 * then mechanical: load the turn from the writer's own transcript and classify
 * it owner-vs-agent from what was RECORDED — the ⟦turn-origin:…⟧ envelope every
 * enrolled injector prefixes survives verbatim in the transcript, so an
 * injected turn is identifiable forever, while a clean turn with no envelope
 * and no machine banner is the affirmative owner shape (same D-002 default as
 * the live classifier). Manual [owner:…] tags are RETIRED as evidence: they
 * assert, a turn ref PROVES. The carry-surface stamper
 * (../carry-surface-provenance-stamp.ts) drives this on every write.
 */

import { open } from 'node:fs/promises';
import {
  resolveSelfSession,
  resolveOwnerIsolatedSessionByPrefix,
  type ResolveSelfSessionOptions,
} from '../search/self-session';
import { parseEnvelope } from './turn-provenance';
import { hasMachineSurfaceMarker, hasSyntheticMarker } from './machine-surface-catalogue';
import { blockPayloadText, CLAUDE_OWNER_DIALOG_RESULT_PREFIXES } from '../transcript-wire';

/* ------------------------------------------------------------------ */
/* Ref format                                                          */
/* ------------------------------------------------------------------ */

/** How much of the native session id a ref carries — enough to disambiguate
 *  the sessions one owner realistically touches, short enough to hand-copy.
 *  A native id may include its client namespace (`codex:` / `claude:`), so the
 *  parser below accepts that namespace as part of the prefix too. */
const SESSION_PREFIX_CHARS = 8;

export interface TurnRef {
  /** First SESSION_PREFIX_CHARS of the native session id. */
  sessionPrefix: string;
  /** The recorded turn's ISO timestamp (exact, or truncated to seconds). */
  ts: string;
  /** The literal matched text (for echoing back in verdicts). */
  raw: string;
  /** EI-12890: the quoted directive text found adjacent to the ref in the
   *  carrying prose (e.g. `[turn:…]: "now get our release out"`), if any.
   *  Present only when a quote was actually found next to this ref. */
  quote?: string;
}

export function formatTurnRef(sessionId: string, tsIso: string): string {
  return `[turn:${sessionId.slice(0, SESSION_PREFIX_CHARS)}@${tsIso}]`;
}

/** Global by design — a carry note can cite several turns. */
const TURN_REF_RE = /\[turn:([A-Za-z0-9][A-Za-z0-9:_-]{3,79})@([0-9T:.+Z-]{10,40})\]/gi;

/** How far around a `[turn:…]` ref to look for its associated quoted claim —
 *  wide enough to span a trailing "owner-typed]: " label, narrow enough that
 *  an unrelated quote elsewhere in a long carry note doesn't get attributed
 *  to the wrong ref. */
const QUOTE_WINDOW_CHARS = 200;

/** The first double-quoted run found in the window around a ref. Heuristic —
 *  this is an advisory lint, not a parser for a fixed grammar; a carry note
 *  format that doesn't co-locate ref and quote simply yields no quote (never
 *  a wrong one, since we only take the run immediately adjacent). */
function findAdjacentQuote(text: string, matchStart: number, matchEnd: number): string | undefined {
  const before = text.slice(Math.max(0, matchStart - QUOTE_WINDOW_CHARS), matchStart);
  const after = text.slice(matchEnd, matchEnd + QUOTE_WINDOW_CHARS);
  // Prefer a quote AFTER the ref (`[turn:…]: "…"` is the documented convention);
  // fall back to one immediately before it (`"…" [turn:…]`).
  const afterMatch = after.match(/^\s*[:\]]*\s*"([^"]{3,600})"/);
  if (afterMatch) return afterMatch[1];
  // The before-fallback must be END-ANCHORED (quote, then ≤60 non-quote label
  // chars, then the ref): a "last quoted run anywhere in the window" scan is
  // parity-poisoned when the window boundary clips an EARLIER quote's opening
  // char — the leftover closing quote pairs with the next quote's opener and
  // the extracted "claim" becomes the prose BETWEEN two directives (seen live
  // on a two-directive carry note spanning >200 chars, 2026-07-17).
  const beforeMatch = before.match(/"([^"]{3,600})"[^"]{0,60}$/);
  return beforeMatch ? beforeMatch[1] : undefined;
}

export function parseTurnRefs(text: string | null | undefined): TurnRef[] {
  if (!text) return [];
  const out: TurnRef[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(TURN_REF_RE)) {
    // Dedupe by literal ref — a note citing the same turn twice (e.g. an
    // append joining two sections) needs one verdict, not two.
    if (seen.has(m[0])) continue;
    seen.add(m[0]);
    const quote = findAdjacentQuote(text, m.index ?? 0, (m.index ?? 0) + m[0].length);
    out.push({ sessionPrefix: m[1].toLowerCase(), ts: m[2], raw: m[0], ...(quote ? { quote } : {}) });
  }
  return out;
}

/** Loose normalization for quote-vs-turn comparison: case/whitespace only — a
 *  carry note may re-flow the owner's line breaks without changing meaning,
 *  but must not paraphrase or splice text the turn never contained. */
function normalizeForQuoteCompare(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Does the turn's ACTUAL recorded text contain the claimed quote? The
 * guard-defeat in EI-12890: a `[turn:…]` ref resolved to a REAL owner turn
 * (found:true, verdict:'owner-typed'), which read as sufficient evidence —
 * but the quote attached to that ref did not appear anywhere in the turn's
 * actual text (it was fabricated by splicing two unrelated turns together).
 * A resolvable ref is necessary but not sufficient; the quote must also match.
 */
export function quoteMatchesTurn(quote: string, turnText: string): boolean {
  return normalizeForQuoteCompare(turnText).includes(normalizeForQuoteCompare(quote));
}

/* ------------------------------------------------------------------ */
/* Recorded-turn classification (owner-vs-agent from the transcript)   */
/* ------------------------------------------------------------------ */

export type RecordedTurnVerdict =
  | 'owner-typed'
  /** A clean user turn proven from the cross-session index. */
  | 'owner-turn'
  | 'owner-dialog'
  | 'agent-injected'
  | 'machine-surface'
  | 'synthetic';

/**
 * Durable marker for an owner answer returned by Claude Code's
 * AskUserQuestion dialog. The answer arrives in a `tool_result` carrier rather
 * than a normal user-text turn, so session ingest promotes only that narrow
 * shape into the recall corpus and stamps this marker before the display text.
 * Keeping a distinct verdict avoids reviving the unsafe generic
 * `owner-typed` residual for file-backed CLI transcripts.
 */
export const OWNER_DIALOG_TURN_MARKER = '⟦owner-dialog-answer⟧';

/**
 * Persisted verdicts that a turn WHICH MIGHT BE OWNER SPEECH can carry.
 *
 * `owner-typed` / `owner-dialog` are proven. `unenrolled-origin` is the honest
 * third state, and omitting it is what makes a provenance-filtered search lie:
 * a file-backed CLI row (claude/omp/codex) cannot carry an enrolment envelope,
 * so ingest downgrades its `owner-typed` residual to `unenrolled-origin` rather
 * than assert authorship it cannot prove. A typed owner directive in a psu
 * session is therefore stored under the third value, and a query restricted to
 * the first two returns zero rows however much the owner actually said.
 *
 * So this set — not `{owner-typed, owner-dialog}` — is the one to filter on
 * when the question is "did the owner say X", including when the answer sought
 * is NO. It is deliberately still narrower than "any user turn": it excludes
 * agent-injected and machine-surface rows, which is what stops an agent's own
 * replayed loop goal from reading back as the owner's words.
 */
export const OWNER_CANDIDATE_TURN_VERDICTS: readonly string[] = [
  'owner-typed',
  'owner-dialog',
  'unenrolled-origin',
];

export interface RecordedTurnClass {
  verdict: RecordedTurnVerdict;
  /** The envelope's origin when agent-injected (e.g. 'wake-pump'). */
  origin: string | null;
}

/* The curated un-enrollable machine-surface catalogue this module used to hold
 * privately now lives in ./machine-surface-catalogue.ts — see the import at the
 * top of this file. It moved because the OWNER'S CHAT PANE faces the same
 * population and could not reach a module-private `const`, so it fell through
 * to SHOW and rendered CLI plumbing as the owner's own words
 * (EI-20135573616431912, plan owner-visibility-provenance P-003). Behaviour
 * here is unchanged; the list simply has one home now instead of one home and
 * three divergent copies. */


/**
 * Classify a RECORDED user turn's text owner-vs-agent. Mirrors the live
 * classifier's decision shape (turn-provenance.ts `classify`) but works on
 * what the transcript kept: the envelope text (durable) instead of the
 * short-TTL nonce ledger. An envelope at turn start is decisive — every
 * enrolled injector writes it, and the owner never types one; absent one, a
 * known synthetic/machine surface is NOT-owner, and only a clean turn earns the
 * affirmative owner stamp (same D-002 default as the live classifier).
 */
export function classifyRecordedTurn(text: string): RecordedTurnClass {
  const env = parseEnvelope(text);
  if (env) return { verdict: 'agent-injected', origin: env.origin };
  const t = text ?? '';
  if (t.trimStart().startsWith(OWNER_DIALOG_TURN_MARKER)) {
    return { verdict: 'owner-dialog', origin: null };
  }
  // Both predicates apply the head bound themselves — see
  // CLASSIFY_HEAD_CHARS in ./machine-surface-catalogue.
  if (hasSyntheticMarker(t)) return { verdict: 'synthetic', origin: null };
  if (hasMachineSurfaceMarker(t)) return { verdict: 'machine-surface', origin: null };
  return { verdict: 'owner-typed', origin: null };
}

/* ------------------------------------------------------------------ */
/* The live hook's verdict, as the transcript recorded it              */
/* ------------------------------------------------------------------ */

/**
 * EI-23999888134974900: the UserPromptSubmit provenance hook's own classification
 * of a turn, read back from the transcript.
 *
 * Two classifiers judge every Claude turn. The hook
 * (`apps/operator/scripts/hooks/cc/userpromptsubmit-provenance.sh`) runs LIVE and
 * consults the nonce ledger. {@link classifyRecordedTurn} runs later, on the
 * recorded text alone. When the recorded one cannot see what the hook saw, its
 * default is the AFFIRMATIVE `owner-typed` — the dangerous direction: the
 * current-turn stamp (`turnProvenance.writtenDuring`) is what
 * `applyOwnerTurnAutoVerify` trusts to auto-verify `[owner:…]` tags, so a machine
 * turn misread as owner speech manufactures owner authority (the WI-3532 class).
 *
 * Measured 2026-09-22/23 (three occurrences, two sessions): the hook stamped
 * loop-fire turns VERIFIED AGENT-ORIGIN while loop:checkpoint returned
 * `{ verdict:'owner-typed', origin:null }` for the same turn. Those turns arrived
 * wrapped in `<pasted_content>`, which the text classifier learned to unwrap in
 * WI-10002461 — but the build serving the tool predated that, and the hook ALSO
 * has a branch no text classifier can reproduce: "envelope lost in transit,
 * matched by payload hash". So rather than chase each new transit shape, the
 * recorded classifier now DEFERS to the hook's stamp, which Claude Code persists
 * as a `hook_additional_context` attachment directly after the turn it judged.
 *
 * DOWNGRADE-ONLY. The stamp can take an `owner-typed` text verdict to a non-owner
 * one; it can never grant `owner-typed`. The model cannot author a transcript
 * attachment, and an owner typing this prefix lands in their own turn's TEXT, not
 * in a hook attachment — but even a forged stamp could only ever REMOVE owner
 * authority, never create it.
 */
export type HookProvenanceStamp =
  | { kind: 'agent-origin'; origin: string }
  | { kind: 'unverified-origin-claim' }
  | { kind: 'machine-surface' }
  | { kind: 'owner' };

/**
 * The hook's stamp prefixes. PINNED to the hook script by
 * `turn-ref.test.ts` (it reads the script off disk and requires each one), so a
 * reworded stamp fails a test instead of silently falling back to the text verdict.
 */
export const HOOK_PROVENANCE_STAMP_PREFIXES = {
  agentOrigin: '⟦turn-provenance⟧ VERIFIED AGENT-ORIGIN turn (origin: ',
  unverified: '⟦turn-provenance⟧ UNVERIFIED ORIGIN CLAIM',
  machineSurface: '⟦turn-provenance⟧ MACHINE-GENERATED SURFACE',
  owner: '⟦turn-provenance⟧ OWNER (interactive)',
} as const;

/** The origin a hook-downgraded turn carries when the hook could not verify one. */
export const UNVERIFIED_HOOK_ORIGIN = 'unverified-origin-claim';

/** Parse one hook-emitted string into a stamp; null when it is not a provenance stamp. */
export function parseHookProvenanceStamp(text: string): HookProvenanceStamp | null {
  const t = (text ?? '').trimStart();
  const P = HOOK_PROVENANCE_STAMP_PREFIXES;
  if (t.startsWith(P.agentOrigin)) {
    const origin = /^[^;)\s]+/.exec(t.slice(P.agentOrigin.length))?.[0] ?? 'unknown';
    return { kind: 'agent-origin', origin };
  }
  if (t.startsWith(P.unverified)) return { kind: 'unverified-origin-claim' };
  if (t.startsWith(P.machineSurface)) return { kind: 'machine-surface' };
  if (t.startsWith(P.owner)) return { kind: 'owner' };
  return null;
}

/** The provenance stamp carried by a Claude `hook_additional_context` attachment
 *  line from the UserPromptSubmit hook, if this line is one. */
function hookProvenanceStampOf(o: Record<string, unknown>): HookProvenanceStamp | null {
  const a = o.attachment as { type?: unknown; hookEvent?: unknown; hookName?: unknown; content?: unknown } | undefined;
  if (!a || a.type !== 'hook_additional_context') return null;
  if (a.hookEvent !== 'UserPromptSubmit' && a.hookName !== 'UserPromptSubmit') return null;
  const parts = Array.isArray(a.content) ? a.content : typeof a.content === 'string' ? [a.content] : [];
  for (const part of parts) {
    if (typeof part !== 'string') continue;
    const stamp = parseHookProvenanceStamp(part);
    if (stamp) return stamp;
  }
  return null;
}

/**
 * Classify a parsed transcript turn: the text verdict, downgraded by the live
 * hook's stamp when the two disagree about an owner-typed default. This — not the
 * bare text classifier — is what every raw-transcript reader in this module uses.
 */
export function classifyRecordedUserTurn(turn: RecordedUserTurn): RecordedTurnClass {
  const cls = classifyRecordedTurn(turn.text);
  if (cls.verdict !== 'owner-typed' || !turn.hookStamp) return cls;
  switch (turn.hookStamp.kind) {
    case 'agent-origin':
      return { verdict: 'agent-injected', origin: turn.hookStamp.origin };
    case 'unverified-origin-claim':
      return { verdict: 'agent-injected', origin: UNVERIFIED_HOOK_ORIGIN };
    case 'machine-surface':
      return { verdict: 'machine-surface', origin: null };
    case 'owner':
      return cls;
  }
}

/* ------------------------------------------------------------------ */
/* Transcript reads                                                    */
/* ------------------------------------------------------------------ */

/** A user turn parsed from a Claude-shaped session JSONL. */
export interface RecordedUserTurn {
  ts: string;
  text: string;
  /** EI-23999888134974900: the UserPromptSubmit hook's recorded verdict for this
   *  turn, when the transcript carries one. Absent for Codex rollouts, turns
   *  recorded before the hook, and turns the hook did not stamp. */
  hookStamp?: HookProvenanceStamp;
}

/** Where a turn ref was proven. Cross-session proofs come from the bounded
 * session_turns index rather than a transcript file owned by this caller. */
export type TurnRefScope = 'current-session' | 'owner-chain' | 'cross-session';

/** The small, redacted row shape needed for a cross-session proof. */
export interface IndexedRecordedTurn {
  sessionId: string;
  ts: string | null;
  speaker: string;
  text: string;
  turnOrigin?: string | null;
  turnOriginVerdict?: string | null;
}

/** Injectable for tests and alternate hosted stores. The scope is explicit at
 * the call boundary so a future caller cannot accidentally widen an
 * owner-scoped lookup into a cross-session read. */
export type IndexedTurnLoader = (
  sessionPrefix: string,
  scope: Extract<TurnRefScope, 'cross-session'>,
) => Promise<IndexedRecordedTurn[] | null>;

/** Ref verification and the current-turn stamp scan this much transcript tail
 *  (refs usually point at recent turns; older ones fall back to
 *  sessions:search by hand). A long session's final 512KB can be ALL
 *  tool-result plumbing with no text-bearing user turn — observed live on
 *  :3170 — so the current-turn walk gets the same deep tail as ref scans. */
const SCAN_BYTES = 4 * 1024 * 1024;

async function readTail(filePath: string, bytes: number): Promise<string> {
  const fh = await open(filePath, 'r');
  try {
    const size = (await fh.stat()).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally {
    await fh.close();
  }
}

/**
 * EI-22171324436610992: an AskUserQuestion answer is owner speech delivered
 * inside a synthetic `tool_result` user line — the exact shape
 * session-ingest.ts's `parseClaudeLine` already promotes into the recall
 * index (`OWNER_DIALOG_TURN_MARKER`). This raw-transcript reader used to have
 * no matching special case: its text-block filter only recognizes
 * `text`/`input_text` parts, so a dialog-answer turn (all `tool_result`, no
 * plain-text block) produced zero text and was silently dropped as
 * "tool_result-only plumbing" — even though the turn is real, is owner
 * speech, and is exactly what `sessions:read`/`sessions:search` (backed by
 * the indexed store `parseClaudeLine` populates) return for the same ref.
 * That asymmetry is what made `verifyTurnRefs`'s default `owner-chain` scope
 * (which reads THIS raw parser, never the index) report `found:false` for a
 * turn every other reader could see. Mirror `parseClaudeLine`'s detection
 * here so both readers agree on which turns exist.
 */
function findClaudeOwnerDialogAnswer(content: readonly unknown[]): string | null {
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const part = block as { type?: string; content?: unknown };
    if (part.type !== 'tool_result') continue;
    const payload = blockPayloadText(part.content).trim();
    if (!CLAUDE_OWNER_DIALOG_RESULT_PREFIXES.some((prefix) => payload.startsWith(prefix))) continue;
    return `${OWNER_DIALOG_TURN_MARKER}\n${payload}`;
  }
  return null;
}

/**
 * WI-2141807: Claude Code records a prompt the owner TYPED WHILE A TURN WAS
 * RUNNING (queued, then absorbed once the turn completes — visible as a
 * paired `queue-operation` enqueue/remove in the same transcript) as a
 * top-level `attachment` line, never as the ordinary `type:'user'` /
 * `message.content` shape the rest of this parser reads:
 *
 *   { type:'attachment', attachment:{ type:'queued_command',
 *     commandMode:'prompt', origin:{kind:'human'}, prompt:<text>,
 *     timestamp } }
 *
 * session-ingest.ts's `parseClaudeQueuedCommand` already recognizes this
 * exact shape for the recall index — which is why `sessions:search` resolves
 * such a turn while this raw-transcript reader (what `verifyTurnRefs`'s
 * default owner-chain scope actually reads) reported `found:false` for a
 * REAL owner-typed directive. Mirrored here rather than imported:
 * session-ingest.ts already imports FROM this module (classifyRecordedTurn),
 * so importing back would cycle. Same asymmetry class, same fix shape, as
 * EI-22171324436610992's findClaudeOwnerDialogAnswer above — kept
 * deliberately narrower than session-ingest's cleanTurnText (no boilerplate-
 * prefix / min-length drop): this reader's contract is to surface ALL user
 * turns for per-turn classification, never to silently drop a short one.
 *
 * Exported (EI-22215681617737293) so relay-provenance-resolve.ts's Tier 2/3
 * `relayOf`/`relayQuote` verifier can recognize the SAME shape instead of
 * carrying its own copy that silently drops it — that drift is exactly what
 * let a verbatim owner directive queued mid-turn resolve `found:true` here
 * (and in sessions:search, which is backed by session-ingest.ts's matching
 * `parseClaudeQueuedCommand`) while the relay verifier reported `unverified`
 * for the identical text in the identical transcript.
 */
export function findClaudeQueuedCommandTurn(o: Record<string, unknown>): RecordedUserTurn | null {
  const attachment = o.attachment as
    | { type?: unknown; commandMode?: unknown; origin?: { kind?: unknown }; prompt?: unknown; timestamp?: unknown }
    | undefined;
  if (
    !attachment ||
    attachment.type !== 'queued_command' ||
    attachment.commandMode !== 'prompt' ||
    attachment.origin?.kind !== 'human' ||
    typeof attachment.prompt !== 'string' ||
    !attachment.prompt.trim()
  ) {
    return null;
  }
  const ts =
    (typeof attachment.timestamp === 'string' && attachment.timestamp) ||
    (typeof o.timestamp === 'string' && o.timestamp) ||
    '';
  return { ts, text: attachment.prompt };
}

/** Parse ALL user turns (with timestamps) out of raw JSONL — including
 *  machine-injected ones; classification happens per turn, not by dropping. */
export function parseUserTurns(jsonl: string): RecordedUserTurn[] {
  const out: RecordedUserTurn[] = [];
  // EI-23999888134974900: the turn the NEXT UserPromptSubmit hook stamp belongs to.
  // Claude Code writes that stamp directly after the prompt line it judged (or
  // after the queued_command attachment, for a prompt typed mid-turn) and before
  // any assistant line. Measured over 183 stamps in 40 live transcripts: every one
  // followed its prompt with no assistant or tool traffic between. So the window
  // closes on an assistant line or tool_result plumbing, and a stamp arriving with
  // no open window is dropped rather than attached to an older turn.
  let awaitingStamp: RecordedUserTurn | null = null;
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // torn first line of a tail read
    }
    if (o.type === 'attachment') {
      const stamp = hookProvenanceStampOf(o);
      if (stamp) {
        if (awaitingStamp) awaitingStamp.hookStamp = stamp;
        awaitingStamp = null;
        continue;
      }
      const queued = findClaudeQueuedCommandTurn(o);
      if (queued) {
        out.push(queued);
        awaitingStamp = queued;
      } else if ((o.attachment as { type?: unknown } | undefined)?.type === 'queued_command') {
        // A non-human queued command (e.g. a task notification) owns the next stamp.
        awaitingStamp = null;
      }
      continue;
    }
    if (o.type === 'assistant') {
      awaitingStamp = null;
      continue;
    }
    let c: unknown;
    let isClaudeUserLine = false;
    if (o.type === 'user' && o.isMeta !== true) {
      const m = (o.message ?? {}) as Record<string, unknown>;
      c = m.content;
      isClaudeUserLine = true;
    } else if (o.type === 'response_item') {
      // Native Codex rollouts store prompts as response_item/message rows,
      // not Claude's top-level `type:'user'` shape. The carry verifier reads
      // both transcript families, so its parser must do the same; otherwise
      // it can locate the correct managed Codex file and still report every
      // genuine turn as absent (EI-21394895717783013 live successor repro).
      const payload = (o.payload ?? {}) as Record<string, unknown>;
      if (payload.type !== 'message' || payload.role !== 'user') continue;
      c = payload.content;
    } else {
      continue;
    }
    let text: string;
    if (typeof c === 'string') {
      text = c;
    } else if (Array.isArray(c)) {
      const texts = c
        .filter(
          (b): b is { type: string; text: string } => {
            if (!b || typeof b !== 'object') return false;
            const type = (b as { type?: unknown }).type;
            return (type === 'text' || type === 'input_text') && typeof (b as { text?: unknown }).text === 'string';
          },
        )
        .map((b) => b.text);
      if (texts.length) {
        text = texts.join('\n');
      } else {
        // No plain-text block. Before writing this off as tool_result-only
        // plumbing, check for a Claude owner-dialog answer (AskUserQuestion) —
        // codex response_item lines never take this shape, so it's gated to
        // the Claude branch, matching parseClaudeLine.
        const dialogText = isClaudeUserLine ? findClaudeOwnerDialogAnswer(c) : null;
        if (dialogText == null) {
          awaitingStamp = null; // genuine tool_result-only plumbing: the prompt window is closed
          continue;
        }
        text = dialogText;
      }
    } else {
      continue;
    }
    if (!text.trim()) continue;
    const turn: RecordedUserTurn = { ts: typeof o.timestamp === 'string' ? o.timestamp : '', text };
    out.push(turn);
    awaitingStamp = turn;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Verification + the current-turn stamp                               */
/* ------------------------------------------------------------------ */

export interface TurnRefVerdict {
  ref: string;
  found: boolean;
  /** Classification of the referenced turn when found. */
  verdict: RecordedTurnVerdict | null;
  origin: string | null;
  /** Head of the referenced turn's text (so the reader sees WHAT was said). */
  snippet: string | null;
  /** EI-12890: the quoted claim the writer attached to this ref, if any was
   *  found adjacent to it in the source text. */
  quote: string | null;
  /** EI-12890 guard-defeat fix: whether `quote` actually appears in the
   *  referenced turn's FULL recorded text. null when there is no quote to
   *  check, or the ref didn't resolve (nothing to compare against) — NOT the
   *  same as false, which means a resolvable turn whose text does not
   *  contain the claim: a resolvable ref is necessary but not sufficient. */
  quoteMatch: boolean | null;
  /** EI-19297300002186512: true when a transcript was actually LOCATED and
   *  searched for this ref's timestamp (regardless of whether a matching
   *  turn was found in it) — false when no transcript could be resolved at
   *  all for the ref's session. Distinguishes a VERIFIED-ABSENT ref
   *  (searched the right transcript, no turn at that timestamp) from a
   *  genuinely UNRESOLVABLE one (never searched — e.g. a session outside
   *  this owner's known claude isolation chain). Collapsing both into a bare
   *  `found:false` invites reading "we couldn't check" as "it's not there" —
   *  the same never-let-a-failed-lookup-report-a-confident-negative shape
   *  that let a real owner directive read as refuted. */
  checked: boolean;
  /** The proof boundary used for this verdict. Optional for backwards-
   * compatible hand-built fixtures; verifier results populate it. */
  scope?: TurnRefScope;
}

export interface VerifyTurnRefsOptions {
  /** Explicit transcript (tests / non-self sessions); else resolved from ownerId. */
  filePath?: string;
  sessionId?: string;
  scanBytes?: number;
  /** Testability hook: threaded through to resolveSelfSession /
   *  resolveOwnerIsolatedSessionByPrefix (mirrors ResolveSelfSessionOptions.home)
   *  when `filePath` is not pinned. Production callers omit it. */
  home?: string;
  /** Testability hook: threaded through to resolveSelfSession, so a test can
   *  avoid the real DB-backed active-sessions lookup. Production callers omit it. */
  loadActiveSessions?: ResolveSelfSessionOptions['loadActiveSessions'];
  /** Enable the deliberately broader, index-backed predecessor lookup. The
   * default remains owner-chain-only so callers must opt into cross-session
   * reads explicitly. */
  scope?: Extract<TurnRefScope, 'owner-chain' | 'cross-session'>;
  /** Test seam for the cross-session session_turns lookup. Production uses the
   * fail-soft loader below. */
  loadIndexedTurns?: IndexedTurnLoader;
}

const SNIPPET_CHARS = 160;
const INDEXED_TURN_LIMIT = 2_000;

/**
 * Read the bounded transcript index for a native-session prefix. This is
 * intentionally dynamic and fail-soft: a carry write must not become
 * dependent on PG discovery, and a missing/unavailable index must remain an
 * unverifiable ref rather than a confident negative.
 */
async function loadIndexedTurnsByPrefix(
  sessionPrefix: string,
  _scope: Extract<TurnRefScope, 'cross-session'>,
): Promise<IndexedRecordedTurn[] | null> {
  if (!sessionPrefix) return null;
  try {
    const [{ getOrgPg }, { activeWorkspaceId }] = await Promise.all([
      import('@papercusp/db-org'),
      import('../workspace-registry'),
    ]);
    const workspaceId = activeWorkspaceId();
    const prefix = `${sessionPrefix.toLowerCase()}%`;
    const rows = await getOrgPg().sql<IndexedRecordedTurn[]>`
      SELECT session_id AS "sessionId",
             ts::text AS ts,
             speaker,
             text,
             turn_origin AS "turnOrigin",
             turn_origin_verdict AS "turnOriginVerdict"
        FROM harness_shared.session_turns
       WHERE (workspace_id = ${workspaceId} OR workspace_id = 'default')
         AND lower(session_id) LIKE ${prefix}
         AND source_kind IN ('claude', 'omp', 'codex')
         AND speaker = 'user'
       ORDER BY session_id, turn_idx
       LIMIT ${INDEXED_TURN_LIMIT}
    `;
    return rows;
  } catch {
    return null;
  }
}

/** Apply persisted provenance fields when available, then fall back to the
 * recorded text classifier. A clean indexed user turn is deliberately named
 * `owner-turn`: it was proven from the cross-session store, not merely assumed
 * to be the current caller's owner-typed transcript turn. */
function classifyIndexedTurn(turn: IndexedRecordedTurn): RecordedTurnClass {
  const recorded = classifyRecordedTurn(turn.text);
  const persisted = turn.turnOriginVerdict?.toLowerCase() ?? null;

  if (persisted === 'agent-injected') {
    return { verdict: 'agent-injected', origin: turn.turnOrigin ?? recorded.origin };
  }
  if (persisted === 'machine-surface') return { verdict: 'machine-surface', origin: null };
  if (persisted === 'synthetic') return { verdict: 'synthetic', origin: null };

  // The index records `unenrolled-origin` for a clean file-backed row. It is
  // still the affirmative clean-user shape for this verifier: the row was
  // located by the exact session+timestamp anchor, and no machine marker was
  // present in its recorded text.
  if (
    turn.speaker.toLowerCase() === 'user' &&
    (recorded.verdict === 'owner-typed' || recorded.verdict === 'owner-dialog') &&
    (persisted === null ||
      persisted === 'owner-typed' ||
      persisted === 'owner-dialog' ||
      persisted === 'unenrolled-origin')
  ) {
    return { verdict: 'owner-turn', origin: null };
  }
  return recorded;
}

/** Second-resolution prefix match: an exact ts match, or either side is a
 *  prefix of the other down to seconds (refs may carry truncated timestamps). */
function tsMatches(refTs: string, turnTs: string): boolean {
  if (!refTs || !turnTs) return false;
  if (refTs === turnTs || turnTs.startsWith(refTs) || refTs.startsWith(turnTs.slice(0, 19))) return true;

  // Transcript readers can emit a Postgres-style local timestamp
  // (`2026-08-23 10:58:57.808-04`) while refs use ISO-8601 (`T` plus a
  // colonized offset) or UTC. Compare parsed instants at second precision so
  // equivalent representations still resolve, while preserving the existing
  // seconds-truncated ref behavior.
  const refMs = Date.parse(refTs);
  const turnMs = Date.parse(turnTs);
  return Number.isFinite(refMs) && Number.isFinite(turnMs) && Math.floor(refMs / 1000) === Math.floor(turnMs / 1000);
}

/**
 * Verify each ref against the caller's own transcript. Fail-soft: a ref whose
 * session can't be resolved at all returns found:false, checked:false (never
 * throws) — the stamp degrades to "unverifiable", it does not block the
 * write.
 *
 * EI-19297300002186512: a ref does not have to point at the CURRENT session.
 * A cold carry-respawn mints a fresh native session id while an earlier
 * checkpoint's [turn:…] ref still names the OLDER one — both live in the
 * same owner's claude isolation dir. Previously this function only ever
 * loaded the current/newest transcript (resolveSelfSession's return) and
 * flatly missed any ref whose session prefix didn't match it, even though
 * the cited turn was real and one directory over. Each distinct session
 * prefix among the refs is now resolved (and its transcript read) on its
 * own — the current session first (no extra IO), falling back to a
 * same-owner isolation-dir lookup by prefix for any ref that doesn't match
 * it — with the resolved turns cached per prefix so refs sharing a session
 * only pay the read once. `opts.filePath` (used by tests to pin an explicit
 * transcript) disables this fallback: a caller who pinned a specific file
 * gets exactly that file, no owner-chain scan.
 */
export async function verifyTurnRefs(
  ownerId: string,
  refs: TurnRef[],
  opts: VerifyTurnRefsOptions = {},
): Promise<TurnRefVerdict[]> {
  if (refs.length === 0) return [];
  const miss = (r: TurnRef, checked: boolean, scope?: TurnRefScope): TurnRefVerdict => ({
    ref: r.raw,
    found: false,
    verdict: null,
    origin: null,
    snippet: null,
    quote: r.quote ?? null,
    quoteMatch: null,
    checked,
    ...(scope ? { scope } : {}),
  });

  let filePath = opts.filePath;
  let sessionId = opts.sessionId;
  if (!filePath) {
    const self = await resolveSelfSession(ownerId, {
      home: opts.home,
      loadActiveSessions: opts.loadActiveSessions,
    }).catch(() => null);
    if (self) {
      filePath = self.filePath;
      sessionId = sessionId ?? self.sessionId;
    }
  }
  const currentFilePath = filePath ?? null;
  const currentSidLower = (sessionId ?? '').toLowerCase();
  // Once a caller pins an explicit transcript (tests), no owner-chain
  // fallback — a ref for a different session stays unresolvable against it.
  const allowOwnerChainFallback = !opts.filePath;
  const allowCrossSessionFallback = opts.scope === 'cross-session';
  const indexedTurnLoader = opts.loadIndexedTurns ?? loadIndexedTurnsByPrefix;

  // Cache of sessionPrefix -> resolved turns (or null when unresolvable), so
  // refs sharing a prefix — the common case, everything anchored to the
  // current session — only pay the IO once.
  const turnsByPrefix = new Map<
    string,
    { turns: RecordedUserTurn[]; scope: Extract<TurnRefScope, 'current-session' | 'owner-chain'> } | null
  >();
  async function turnsFor(
    sessionPrefix: string,
  ): Promise<{ turns: RecordedUserTurn[]; scope: Extract<TurnRefScope, 'current-session' | 'owner-chain'> } | null> {
    if (turnsByPrefix.has(sessionPrefix)) return turnsByPrefix.get(sessionPrefix) ?? null;
    let path: string | null = null;
    let scope: Extract<TurnRefScope, 'current-session' | 'owner-chain'> = 'current-session';
    if (currentFilePath && (!currentSidLower || currentSidLower.startsWith(sessionPrefix))) {
      // No pinned sessionId to compare (rare) — fall back to the current
      // transcript, same as pre-fix behavior; or the prefix matches it.
      path = currentFilePath;
    } else if (allowOwnerChainFallback) {
      const resolved = await resolveOwnerIsolatedSessionByPrefix(ownerId, sessionPrefix, {
        home: opts.home,
        loadActiveSessions: opts.loadActiveSessions,
      }).catch(() => null);
      path = resolved?.filePath ?? null;
      scope = 'owner-chain';
    }
    if (!path) {
      turnsByPrefix.set(sessionPrefix, null);
      return null;
    }
    try {
      const parsed = parseUserTurns(await readTail(path, opts.scanBytes ?? SCAN_BYTES));
      const resolved = { turns: parsed, scope };
      turnsByPrefix.set(sessionPrefix, resolved);
      return resolved;
    } catch {
      turnsByPrefix.set(sessionPrefix, null);
      return null;
    }
  }

  const indexedTurnsByPrefix = new Map<string, IndexedRecordedTurn[] | null>();
  async function indexedTurnsFor(sessionPrefix: string): Promise<IndexedRecordedTurn[] | null> {
    if (indexedTurnsByPrefix.has(sessionPrefix)) return indexedTurnsByPrefix.get(sessionPrefix) ?? null;
    const rows = await indexedTurnLoader(sessionPrefix, 'cross-session').catch(() => null);
    indexedTurnsByPrefix.set(sessionPrefix, rows);
    return rows;
  }

  const out: TurnRefVerdict[] = [];
  for (const r of refs) {
    const resolved = await turnsFor(r.sessionPrefix);
    if (!resolved) {
      if (allowCrossSessionFallback) {
        const indexed = await indexedTurnsFor(r.sessionPrefix);
        const turn = indexed?.find(
          (candidate) =>
            candidate.sessionId.toLowerCase().startsWith(r.sessionPrefix) &&
            typeof candidate.ts === 'string' &&
            tsMatches(r.ts, candidate.ts),
        );
        if (turn) {
          const cls = classifyIndexedTurn(turn);
          out.push({
            ref: r.raw,
            found: true,
            verdict: cls.verdict,
            origin: cls.origin,
            snippet: turn.text.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CHARS),
            quote: r.quote ?? null,
            quoteMatch: r.quote ? quoteMatchesTurn(r.quote, turn.text) : null,
            checked: true,
            scope: 'cross-session',
          });
          continue;
        }
      }
      // A missing raw transcript and a missing/failed index lookup are both
      // unresolvable. Keep checked:false: the verifier did not establish an
      // authoritative absence.
      out.push(miss(r, false, allowCrossSessionFallback ? 'cross-session' : undefined));
      continue;
    }
    const turn = resolved.turns.find((t) => tsMatches(r.ts, t.ts));
    if (!turn) {
      out.push(miss(r, true, resolved.scope));
      continue;
    }
    const cls = classifyRecordedUserTurn(turn);
    out.push({
      ref: r.raw,
      found: true,
      verdict: cls.verdict,
      origin: cls.origin,
      snippet: turn.text.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CHARS),
      quote: r.quote ?? null,
      // Compared against the FULL turn text, not the truncated snippet above —
      // a match sitting past SNIPPET_CHARS must still count as a match.
      quoteMatch: r.quote ? quoteMatchesTurn(r.quote, turn.text) : null,
      checked: true,
      scope: resolved.scope,
    });
  }
  return out;
}

export interface CurrentTurnStamp {
  /** A ready-to-copy ref to the current (latest recorded) user turn. */
  ref: string;
  verdict: RecordedTurnVerdict;
  origin: string | null;
}

/**
 * The system-side origin stamp for "the turn this write happened in": the
 * latest recorded user turn of the caller's own transcript, classified. This
 * is what replaces trusting a hand-written [owner:…] tag — the WRITE records
 * what kind of turn drove it. Fail-soft: null when the transcript is
 * unreachable (the write proceeds unstamped).
 */
export async function resolveCurrentTurnStamp(
  ownerId: string,
  opts: { filePath?: string; sessionId?: string } = {},
): Promise<CurrentTurnStamp | null> {
  let { filePath, sessionId } = opts;
  if (!filePath || !sessionId) {
    const self = await resolveSelfSession(ownerId).catch(() => null);
    if (!self) return null;
    filePath = filePath ?? self.filePath;
    sessionId = sessionId ?? self.sessionId;
  }
  let turns: RecordedUserTurn[];
  try {
    turns = parseUserTurns(await readTail(filePath, SCAN_BYTES));
  } catch {
    return null;
  }
  // Latest turn that is a real prompt (skip synthetic plumbing so a local
  // command echo doesn't mask the actual driving turn).
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const cls = classifyRecordedUserTurn(turns[i]);
    if (cls.verdict === 'synthetic') continue;
    return {
      ref: formatTurnRef(sessionId, turns[i].ts),
      verdict: cls.verdict,
      origin: cls.origin,
    };
  }
  return null;
}
