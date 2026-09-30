/**
 * relay-provenance-resolve.ts — the IO half of ./relay-provenance (P-004 / H2):
 * resolve a sender's `relayOf` / `relayQuote` into a platform-verified stamp,
 * SERVER-SIDE, at send time. Zero extra tool calls for the sender; the
 * receiver just reads the stamped envelope.
 *
 *   Tier 1  relayOf: <msg_id>       → load the origin coord message, verify it
 *           exists, capture its text verbatim, extend its chain to root.
 *           A MISS is a LOUD error (relay_origin_not_found): the sender named a
 *           specific id — refusing beats laundering a dangling reference.
 *   Tier 2  relayOf: "owner-turn"   → resolve the CALLER's live transcript
 *           (search/self-session) and capture the human turn it is currently
 *           answering — verbatim, platform-read, never the sender's paraphrase.
 *           Spike-verified 2026-07-11: the human turn is durable at turn START
 *           (~ms lag), so a mid-turn send always sees it. Unresolvable (no pty
 *           record, no transcript, no human turn) → fall to Tier 3 when a
 *           relayQuote was also given, else a loud-but-delivered `unverified`.
 *   Tier 3  relayQuote: "<snippet>" → verify the snippet appears as a HUMAN
 *           turn in the caller's own transcript (normalized substring);
 *           hit → owner-verified(transcript-match), miss → `unverified`
 *           (delivered, loudly stamped — never blocked).
 *
 * Fail-soft BY CONTRACT except the tier-1 dangling id: an IO hiccup degrades
 * the stamp (unverified), never blocks the send.
 *
 * EI-22183379979946324: Tier 2/3 both resolve against the caller's "human
 * turns" — but an owner decision made through Claude Code's AskUserQuestion
 * dialog arrives as a `tool_result` block, not a plain-text turn, so the
 * text-block-only extraction below used to drop it as "tool_result-only
 * plumbing" and every relay of a dialog answer stamped `unverified` even
 * though turn-provenance (classifyRecordedTurn / OWNER_DIALOG_TURN_MARKER)
 * can prove it came from the owner. Mirrors turn-ref.ts's
 * findClaudeOwnerDialogAnswer (EI-22171324436610992, the same asymmetry one
 * layer over) — narrowly gated to Claude `type:'user'` rows, since Codex
 * never emits this shape.
 */

import { open } from 'node:fs/promises';
import { classifyRecordedTurn, findClaudeQueuedCommandTurn, OWNER_DIALOG_TURN_MARKER } from '../../turn-provenance/turn-ref';
import { blockPayloadText, CLAUDE_OWNER_DIALOG_RESULT_PREFIXES } from '../../transcript-wire';
import type { AgentIdentity } from './identity';
import { getMessageById } from './messages';
import { resolveSelfSession } from '../../search/self-session';
import { clampSnippet } from './ref-hydrate';
import {
  OWNER_TURN_SENTINEL,
  RELAY_QUOTE_CHARS,
  readRelayProvenance,
  type RelayProvenanceStamp,
} from './relay-provenance';

/** Multi-hop chain cap — bounds the stamp size on a relay-of-relay-of-… */
const CHAIN_MAX = 8;
/** Tier 2 reads the transcript TAIL (the current turn is always near the end). */
const TAIL_BYTES = 512 * 1024;
/** Tier 3 scans at most this much of the transcript tail. */
const SCAN_BYTES = 4 * 1024 * 1024;

export interface RelayResolveResult {
  stamp: RelayProvenanceStamp | null;
  /** Tier-1 LOUD failure: the named origin msg_id does not exist. */
  error?: 'relay_origin_not_found';
}

/** A human turn parsed from a session JSONL. */
interface HumanTurn {
  ts: string;
  text: string;
}

/** OWNER speech, not just typed prose: `owner-typed` (a plain prompt) and
 *  `owner-dialog` (an AskUserQuestion answer, EI-22183379979946324) are both
 *  proven owner turns — see turn-ref.ts's OWNER_CANDIDATE_TURN_VERDICTS for
 *  the same distinction drawn once, upstream (its third member,
 *  `unenrolled-origin`, is an indexed/cross-session artifact that never
 *  applies to this raw-transcript classifier). Everything else — harness-
 *  synthetic entries (local-command echoes, caveats), machine surfaces
 *  (system-notification banners, compaction continuations), and — P-014 fix —
 *  MACHINE-INJECTED turns (every enrolled injector prefixes a durable
 *  ⟦turn-origin:…⟧ envelope; before that check a wake-pump/loop-fire turn
 *  counted as a "human turn", so a Tier-2/3 relay could stamp an injected
 *  directive owner-verified) — is NOT owner words. Shared classifier:
 *  turn-provenance/turn-ref.ts. */
function isOwnerTurn(text: string): boolean {
  const verdict = classifyRecordedTurn(text).verdict;
  return verdict === 'owner-typed' || verdict === 'owner-dialog';
}

/**
 * A Claude AskUserQuestion answer arrives as a `tool_result` block with no
 * plain-text part — general tool results are NOT owner speech and must stay
 * out of the relay-provenance scan, so this mirrors turn-ref.ts's
 * findClaudeOwnerDialogAnswer exactly: only the two verified dialog-result
 * lead-ins count, and the returned text carries the same durable
 * OWNER_DIALOG_TURN_MARKER prefix so classifyRecordedTurn (above) recognizes
 * it. Gated to the Claude `type:'user'` branch below — Codex never emits
 * this shape.
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
 * Read text blocks from either transcript format used by the supported
 * clients. Claude writes `message.content` blocks with `type: "text"`;
 * Codex writes `response_item.payload.content` blocks with
 * `type: "input_text"`. Keeping this at the parser boundary means the
 * provenance verifier remains client-neutral instead of silently treating a
 * Codex session as a transcript with no owner turns.
 */
function readTextContent(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const texts = content
    .filter(
      (b): b is { type: string; text: string } =>
        !!b &&
        typeof b === 'object' &&
        typeof (b as { type?: unknown }).type === 'string' &&
        typeof (b as { text?: unknown }).text === 'string' &&
        ['text', 'input_text'].includes((b as { type: string }).type),
    )
    .map((b) => b.text);
  return texts.length ? texts.join('\n') : null;
}

function codexTimestamp(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Codex history.jsonl stores Unix seconds, while rollout JSONL stores an
    // ISO timestamp on the envelope row.
    const date = new Date(value * 1000);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
  }
  return '';
}

/** Parse the human (owner-typed OR owner-dialog) turns out of raw JSONL text,
 *  in file order. Skips plain tool_result-only user entries (general tool
 *  output, never owner speech), isMeta rows, and synthetic/machine-injected
 *  turns. Supports Claude JSONL (including an AskUserQuestion dialog answer
 *  and a prompt queued while a turn was running), Codex rollout JSONL, and
 *  Codex history.jsonl. */
export function parseHumanTurns(jsonl: string): HumanTurn[] {
  const out: HumanTurn[] = [];
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // torn first line of a tail read / corrupt row
    }
    let text: string | null = null;
    let ts = typeof o.timestamp === 'string' ? o.timestamp : '';

    if (o.type === 'user' && o.isMeta !== true) {
      // Claude-shaped session rows.
      const m = (o.message ?? {}) as Record<string, unknown>;
      text = readTextContent(m.content);
      // No plain-text block — before writing this off as tool_result-only
      // plumbing, check for a Claude owner-dialog answer (AskUserQuestion).
      if (text == null && Array.isArray(m.content)) {
        text = findClaudeOwnerDialogAnswer(m.content);
      }
    } else if (o.type === 'attachment') {
      // EI-22215681617737293: a prompt the owner typed WHILE A TURN WAS
      // RUNNING is recorded as a top-level `attachment` line (queued, then
      // absorbed mid-turn), never the ordinary `type:'user'` shape above —
      // the exact asymmetry turn-ref.ts's parseUserTurns already fixed for
      // verifyTurnRefs (WI-2141807). Reuse its shape-matcher rather than
      // re-deriving it a third time (session-ingest.ts is the second copy,
      // for the recall index) so this verifier and sessions:search agree on
      // which turns exist instead of drifting apart.
      const queued = findClaudeQueuedCommandTurn(o);
      if (queued) {
        text = queued.text;
        ts = queued.ts || ts;
      }
    } else if (o.type === 'response_item') {
      // Codex rollout rows. `event_msg` also mirrors UserMessage items, but
      // the response_item is the canonical single copy; consuming both would
      // duplicate every turn in the provenance scan.
      const p = (o.payload ?? {}) as Record<string, unknown>;
      if (p.type === 'message' && p.role === 'user') text = readTextContent(p.content);
    } else if (typeof o.text === 'string' && 'session_id' in o) {
      // Codex history.jsonl rows are already flattened to user text.
      text = o.text;
      ts = codexTimestamp(o.ts);
    }

    if (text == null) continue; // tool_result-only / non-user plumbing
    if (!text.trim() || !isOwnerTurn(text)) continue;
    out.push({ ts, text });
  }
  return out;
}

/** Read the last `bytes` of a file (whole file when smaller). */
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

/** Whitespace/case-normalize for the tier-3 verbatim containment check. */
function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Strip the internal OWNER_DIALOG_TURN_MARKER prefix before a turn's text
 *  becomes a reader-facing quote — classification (isOwnerTurn, above) has
 *  already run by this point, so the marker has done its job; a reader
 *  scanning `renderRelayQuoteSuffix` should see the owner's actual words,
 *  not the platform's internal tag. */
function displayQuote(text: string): string {
  return text.startsWith(OWNER_DIALOG_TURN_MARKER)
    ? text.slice(OWNER_DIALOG_TURN_MARKER.length).replace(/^\n/, '')
    : text;
}

async function readCallerHumanTurns(
  ownerId: string,
  bytes: number,
): Promise<{ sessionId: string; turns: HumanTurn[] } | null> {
  const self = await resolveSelfSession(ownerId).catch(() => null);
  if (!self) return null;
  try {
    const tail = await readTail(self.filePath, bytes);
    return { sessionId: self.sessionId, turns: parseHumanTurns(tail) };
  } catch {
    return null;
  }
}

/**
 * Resolve the sender's relay reference into a verified stamp. `null` stamp when
 * neither relayOf nor relayQuote was passed (an ordinary, non-relay send).
 */
export async function resolveRelayProvenance(
  identity: AgentIdentity,
  opts: { relayOf?: string; relayQuote?: string },
): Promise<RelayResolveResult> {
  const relayOf = opts.relayOf?.trim();
  const relayQuote = opts.relayQuote?.trim();
  if (!relayOf && !relayQuote) return { stamp: null };

  // ── Tier 1: coord-origin relay ──
  if (relayOf && relayOf !== OWNER_TURN_SENTINEL) {
    const origin = await getMessageById(relayOf).catch(() => null);
    if (!origin) return { stamp: null, error: 'relay_origin_not_found' };
    const env = origin as unknown as Record<string, unknown>;
    // Relay-of-relay: extend the ORIGIN's own verified chain (root first).
    const originStamp = readRelayProvenance(env);
    const chain = [...(originStamp?.chain ?? []), relayOf].slice(-CHAIN_MAX);
    const content = [origin.summary, origin.body].filter(Boolean).join(' — ');
    return {
      stamp: {
        tier: 'coord-origin',
        quote: clampSnippet(content, RELAY_QUOTE_CHARS),
        originMsgId: relayOf,
        chain,
        origin: originStamp?.origin ?? 'agent',
      },
    };
  }

  // ── Tier 2: owner-turn sentinel — capture the caller's current human turn ──
  if (relayOf === OWNER_TURN_SENTINEL) {
    const read = await readCallerHumanTurns(identity.ownerId, TAIL_BYTES);
    const last = read?.turns.length ? read.turns[read.turns.length - 1] : null;
    if (read && last) {
      return {
        stamp: {
          tier: 'owner-verified-turn',
          quote: clampSnippet(displayQuote(last.text), RELAY_QUOTE_CHARS),
          origin: 'owner',
          sessionId: read.sessionId,
          ...(last.ts ? { turnTs: last.ts } : {}),
        },
      };
    }
    // Live window unreachable → Tier 3 covers it when a quote was supplied.
    if (!relayQuote) return { stamp: { tier: 'unverified', quote: '' } };
  }

  // ── Tier 3: sender-supplied quote, verified against the caller's transcript ──
  if (relayQuote) {
    const read = await readCallerHumanTurns(identity.ownerId, SCAN_BYTES);
    const needle = normalize(relayQuote);
    const hit =
      needle.length > 0 && (read?.turns.some((t) => normalize(t.text).includes(needle)) ?? false);
    return {
      stamp: {
        tier: hit ? 'owner-verified-transcript' : 'unverified',
        quote: clampSnippet(relayQuote, RELAY_QUOTE_CHARS),
        ...(hit ? { origin: 'owner' as const } : {}),
        ...(read?.sessionId && hit ? { sessionId: read.sessionId } : {}),
      },
    };
  }

  return { stamp: null };
}
