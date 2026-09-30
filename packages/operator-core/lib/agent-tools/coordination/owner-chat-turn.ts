/**
 * Owner CHAT-PANE turns — the owner's HUD-chat message delivered as the turn
 * itself (EI-20130618357432548 / EI-20130675657060052).
 *
 * ── What was wrong ───────────────────────────────────────────────────────────
 *
 * [owner 2026-08-11] "make it so that the response shows in the chat gui
 * like in the screenshot … it should show in the turn history same as if I had
 * the turn in the tui".
 *
 * The owner types "hi" in the session chat popup. That posts a plain coord:send
 * (`/api/admin/coord/send`, `?client=pc-admin-coord-ui`), and a PARKED recipient
 * is woken through the ordinary await pump — so what actually landed in the
 * agent's transcript as the user turn was the pump's own envelope:
 *
 *     ⟦turn-origin:wake-pump nonce:…⟧
 *     [await-event] coord:inbox-wake:su-… fired — hi. (event-wake delivery
 *     #12672 — a delivery-log id, not your wake count; …) NOTE (inbox-wake): …
 *
 * ONE substitution, both filed bugs:
 *
 *  1. The chat pane merges the owner's own sends into the transcript by EXACT
 *     trimmed text equality (`sent-message-echo.ts`). "hi" never equals that
 *     blob, so absorption always failed and the echo was APPENDED — the owner's
 *     message rendered BELOW the reply it preceded by 48s, and appeared TWICE
 *     (once as the blob, once as their own bubble).
 *  2. It reads as agent-to-agent mail from `pc-admin-coord-ui`, so the woken
 *     agent "replies to the sender" over coord — which returns `recipients_gone`
 *     (a UI pseudo-agent has no live session) — and then hedges with a second
 *     send to `human`. Two coord sends, one of them an error, for an answer the
 *     owner was only ever going to read in the transcript.
 *
 * ── What this module does, and the one thing it deliberately does NOT do ─────
 *
 * The send path stamps {@link OWNER_CHAT_TURN_MARKER} + the owner's FULL text on
 * the wake payload; `wake-executor`'s `wakeTurnText` then delivers that text
 * VERBATIM as the turn, with a single delimited {@link OWNER_CHAT_NOTE_TAG}
 * note, and the chat pane strips both machine annotations before rendering. The
 * owner sees exactly what they typed, once, in chronological order, and the
 * agent's ordinary turn response is the reply — same as a TUI turn.
 *
 * ⛔ It does NOT deliver the turn UNENROLLED (no envelope), which is the obvious
 * way to make it "identical to a TUI turn" and is UNSAFE. An unenrolled turn
 * classifies OWNER (interactive) — and `/api/admin/coord/send` admits a
 * no-Origin localhost POST (CSRF backstop only), so any agent with a shell could
 * `curl` it and mint an owner-stamped turn in a PEER's session. The provenance
 * hook auto-registers an AUTO/DRAIN mode grant on that branch and ONLY that
 * branch (`userpromptsubmit-provenance.sh`), so that is a direct agent→peer
 * privilege escalation — precisely the confusion class the turn-provenance
 * protocol exists to kill (see `inbox-reply.ts`'s SECURITY note). The wake stays
 * enrolled and keeps minting the EXISTING `coord-inject:owner` origin: the
 * trust boundary is unchanged by this fix. Reopening that route requires fixing
 * the admin route's authentication first — the seam is the weak link, not the
 * envelope.
 *
 * ── Leaf-only imports, on purpose ────────────────────────────────────────────
 *
 * `wake-executor` → `inbox-wake` → `engine` → `wake-executor` is a real import
 * cycle (it is why `wake-executor.ts` hand-duplicates `COORD_INBOX_WAKE_PREFIX`
 * rather than importing it). This module is a leaf, so the send path, the wake
 * executor and the browser-side chat pane can all share ONE definition of the
 * marker and the delimiters instead of three copies drifting apart. It is also
 * why it is safe to import from client code across the
 * `@papercusp/operator-core/lib/...` seam.
 *
 * The ONE import here (`turn-provenance/machine-surface-catalogue`) does not
 * weaken that: it is itself a zero-import leaf of pure data and pure functions,
 * so it adds no cycle and nothing Node-only to the client bundle. It is imported
 * rather than copied deliberately — see {@link ownerVisiblePromptText}. Adding
 * an import of anything that is NOT such a leaf breaks this module's contract.
 */

import {
  ENVELOPE_RE as ENVELOPE_GRAMMAR_RE,
  ENVELOPE_STRIP_RE,
  unwrapWholePaste,
} from '../../turn-provenance/envelope-grammar';
import { isUnenrolledMachineSurface } from '../../turn-provenance/machine-surface-catalogue';

/** Payload flag `wakeTurnText` reads to choose the owner-chat turn shape.
 *  Mirrors the `INBOX_OWNER_REPLY_MARKER` convention in `inbox-reply.ts`. */
export const OWNER_CHAT_TURN_MARKER = 'ownerChatTurn' as const;

/** Payload field carrying the owner's message VERBATIM.
 *
 *  The wake's `summary` cannot be used for this: the composer truncates it to 80
 *  chars with an ellipsis (`use-owner-session-chat.ts`), so a longer message
 *  would reach the agent cut in half. */
export const OWNER_CHAT_TEXT_FIELD = 'ownerChatText' as const;

/** Opens the one machine-authored line appended to an owner-chat turn. Chosen to
 *  match the ⟦…⟧ family already used by the turn-origin envelope, so a human
 *  reading a raw transcript recognises it as plumbing at a glance. */
export const OWNER_CHAT_NOTE_TAG = '⟦owner-chat⟧';

/**
 * The note appended to the owner's text in the delivered turn.
 *
 * This is the whole fix for the second bug. An agent that receives a coord
 * message genuinely CANNOT tell that this particular sender is a UI pseudo-agent
 * the owner reads a transcript through rather than a peer awaiting a reply — and
 * the standing coordination rule ("an answer not SENT back was never delivered")
 * is correct everywhere else, which is exactly why it produced two sends here.
 * So the turn says it explicitly, at the moment of action.
 */
export const OWNER_CHAT_TURN_NOTE =
  `${OWNER_CHAT_NOTE_TAG} Your owner typed the message above in their session chat pane, and that ` +
  'pane renders YOUR TRANSCRIPT — so answer in THIS TURN, in your ordinary response, and they will ' +
  'see it. Do NOT coord:send a reply: the sender id is a UI pseudo-agent with no live session, so a ' +
  'reply addressed to it fails with recipients_gone, and mirroring it to `human` puts your answer in ' +
  'the Inbox rather than the chat they are looking at. Zero coord sends are needed to answer this.';

/**
 * The owner's typed text out of a coord message body, whichever shape it is in.
 *
 * ⚠ THE SHAPE IS NOT THE ONE THE GUI POSTS. The chat composer sends `body` as a
 * plain string, but it never reaches the send tool that way: the GUI wrapper
 * (`applyOwnerMessageDefaults` in `owner-message.ts`) rewrites it to a SECTION
 * ARRAY — `[{ text, forYouBecause }]` — before dispatch, because agent-authored
 * coord messages require that shape. So the send path sees an array, and a
 * `typeof body === 'string'` guard at the call site silently yields "" for every
 * real owner message: the marker is never stamped, the wake falls back to the
 * generic envelope, and NOTHING fails loudly. That is exactly how this shipped
 * broken the first time — the unit tests covered the string shape only, stayed
 * green, and the live send still delivered the old blob. Both shapes are pinned
 * in the suite now.
 *
 * Normalising HERE rather than at the call site is the point: a caller that has
 * to ask "is this a string or sections?" is a caller that can get it wrong.
 */
export function ownerChatTextFromBody(body: unknown): string {
  if (typeof body === 'string') return body.trim();
  if (Array.isArray(body)) {
    return body
      .map((section) => {
        if (!section || typeof section !== 'object') return '';
        const text = (section as Record<string, unknown>).text;
        return typeof text === 'string' ? text : '';
      })
      .filter((t) => t.trim().length > 0)
      .join('\n\n')
      .trim();
  }
  return '';
}

/** The wake-payload fields that turn an ordinary coord wake into an owner-chat
 *  turn. Spread into the payload by the send path.
 *
 *  Takes the RAW body — string or section array, see {@link ownerChatTextFromBody}
 *  — so the call site never has to know which it got. Returns nothing to spread
 *  when there is no text, so a body-less send degrades to the ordinary wake shape
 *  rather than delivering an empty turn. */
export function ownerChatWakePayloadFields(body: unknown): Record<string, unknown> {
  const text = ownerChatTextFromBody(body);
  if (!text) return {};
  return { [OWNER_CHAT_TURN_MARKER]: true, [OWNER_CHAT_TEXT_FIELD]: text };
}

/**
 * The owner's message when this delivery payload is an owner-chat turn, else
 * null. Pure and defensive — it runs on the wake executor's hot path against an
 * untyped `unknown` payload, and a malformed one must fall through to the
 * ordinary wake text rather than throw.
 */
export function readOwnerChatTurnText(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (p[OWNER_CHAT_TURN_MARKER] !== true) return null;
  const text = p[OWNER_CHAT_TEXT_FIELD];
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  return trimmed ? trimmed : null;
}

/** The delivered turn body: the owner's words first, one delimited machine note
 *  last. The order matters — the owner's text leads so the agent reads the
 *  actual message first, and the note is trailing + delimited so the chat pane
 *  can strip it back off deterministically. */
export function ownerChatTurnText(ownerText: string): string {
  return `${ownerText.trim()}\n\n${OWNER_CHAT_TURN_NOTE}`;
}

/** Matches the canonical turn-origin envelope prefix, plus the trailing newline
 *  so stripping it does not leave a blank first line.
 *
 *  Was a hand-retyped LOCKSTEP MIRROR of `ENVELOPE_RE`, on the stated grounds
 *  that `turn-provenance.ts` is not a leaf and this module must stay import-light
 *  to cross the client seam. Both halves of that were true; the CONCLUSION was
 *  not. The grammar now lives in `../../turn-provenance/envelope-grammar`, a
 *  true zero-import leaf — the same shape as `machine-surface-catalogue`, which
 *  this module already imports — so the seam is preserved AND the copy is gone. */
const TURN_ORIGIN_ENVELOPE_RE = ENVELOPE_STRIP_RE;

/**
 * Strip papercusp's machine annotations from a transcript user turn for DISPLAY.
 *
 * The chat pane renders `turn.prompt.text` raw, which is why the owner saw the
 * turn-origin envelope and the wake blob in their own conversation. Two things
 * come off, and only these two — anything else the agent was genuinely sent
 * stays, because silently hiding delivered content is a worse failure than
 * showing plumbing:
 *
 *   1. a leading `⟦turn-origin:… nonce:…⟧` envelope (pure injection plumbing,
 *      never meaningful to a human reader), and
 *   2. a trailing `⟦owner-chat⟧ …` note (machine-authored, addressed to the
 *      agent, and the owner did not type it).
 *
 * PURE → unit-tested. Returns the input unchanged when neither is present, so
 * every ordinary turn is byte-identical.
 */
export function stripMachineTurnAnnotations(text: string): string {
  if (!text) return text;
  let out = text.replace(TURN_ORIGIN_ENVELOPE_RE, '');
  const noteAt = out.indexOf(OWNER_CHAT_NOTE_TAG);
  if (noteAt >= 0) out = out.slice(0, noteAt);
  return out.trim();
}

/**
 * The turn-provenance origin minted for a turn the AUTHENTICATED HUMAN authored
 * through an admin-only surface — today the HUD chat pane and the owner Inbox
 * reply, which are the same authority and deliberately share one origin.
 *
 * It lives HERE, in the import-free leaf, because two very different files must
 * agree on it EXACTLY: `wake-executor.ts` MINTS it, and `ownerVisiblePromptText`
 * below KEYS THE DISPLAY FILTER ON IT. If those two ever drift apart, the failure
 * is silent and points the wrong way — the owner's own messages stop matching and
 * VANISH from their chat pane, which is far worse than the plumbing leak this
 * filter exists to stop. A shared constant makes that drift impossible.
 */
export const OWNER_CHAT_TURN_ORIGIN = 'coord-inject:owner';

/** Same envelope as TURN_ORIGIN_ENVELOPE_RE, but CAPTURING: `[1]` origin, `[2]` nonce.
 *  (The canonical grammar always captures both; this site reads only the origin.) */
const TURN_ORIGIN_CAPTURE_RE = ENVELOPE_GRAMMAR_RE;

/** A Stop-hook coaching block: written BY the harness TO the agent, recorded as a
 *  `user`-role turn purely because that is the injection channel. */
const HOOK_FEEDBACK_PREFIX = 'Stop hook feedback:';

/**
 * Legacy wake rows can predate the delivery-seam provenance envelope (or come
 * from a pre-envelope client transcript). They are still machine-authored, but
 * their durable text is all the owner-facing readers have. Keep this protocol
 * prefix as the narrow compatibility rail; new wakes are enrolled by
 * wake-executor before they reach a session.
 */
const UNENVELOPED_WAKE_RE = /^\[await-event\]\s+\S+\s+fired(?:\s|[.!?])/;

/**
 * What a `user`-role transcript turn should show in the OWNER'S CHAT PANE —
 * `''` when the turn is machine-authored and belongs to no conversation.
 *
 * EI-20135573616431912, owner-reported. `stripMachineTurnAnnotations` removes the
 * envelope but RETURNS THE BODY, so every machine wake rendered as a message from
 * the owner: loop-fire wake instructions, wake-pump envelopes, and Stop-hook
 * coaching walls all appeared in their chat as things they had apparently said.
 * The owner's report was "I said hi and it replied with all this" — he was reading
 * the agent's private supervision, attributed to himself.
 *
 * MEASURED, not guessed (3 days of `session_turns` where speaker='user'):
 *   1756 turn-origin envelopes · 1540 genuine owner turns · 71 coord injections ·
 *   44 Stop-hook walls. So the machine half is the MAJORITY of that pane's
 *   user-role rows, and the hook walls the owner happened to paste are the small
 *   part of it.
 *
 * The rule is an ALLOW-LIST ON PROVENANCE, not a deny-list of markers — a
 * deny-list rots silently every time a new wake kind is added, and it fails
 * OPEN (leaking machine text) which is the direction that produced this bug:
 *   - envelope present, origin === OWNER_CHAT_TURN_ORIGIN → the human authored it → SHOW
 *   - envelope present, any other origin                  → machine-injected     → HIDE
 *   - no envelope, Stop-hook wall                         → harness coaching     → HIDE
 *   - no envelope, `[await-event] <key> fired …`          → legacy wake         → HIDE
 *   - no envelope, curated un-enrollable machine surface  → the CLI's own text  → HIDE
 *   - no envelope, anything else                          → typed by the human   → SHOW
 *
 * ⚠ THE ALLOW-LIST BRANCH IS NEARLY INERT — the fallthrough is where the leak is.
 * Measured over 7 days: `coord-inject:owner` (the only origin the allow-list
 * SHOWS) matched ONE row, against 1,809 that reached the un-enveloped branch. So
 * ~99.9% of what the owner sees is decided by the last two rules, not the first
 * two. That is why the curated-catalogue rule is load-bearing and the ordering
 * above is not merely documentation.
 *
 * THE CURATED RULE IS A CALL, NOT A COPY (plan P-003 / D-004). Some machine text
 * has no envelope because no papercusp injector authored it — the CLI did, so
 * there is no seam to enrol and no ledger row could ever vouch for it. That
 * population was ALREADY catalogued in `turn-provenance/machine-surface-catalogue`;
 * it was simply module-private, so this filter could not call it and fell through
 * to SHOW. 487 of the 1,051 machine rows above — including the single largest
 * shape, the 368-row compaction preamble — matched a pattern that already existed
 * and was unreachable. **The defect was a missing call, not a missing pattern**,
 * and the fix is to import the one list rather than grow a fifth private copy
 * beside the four this repo already has (D-004; the same lesson
 * `memory/human-turn-tail.ts` records).
 *
 * ⛔ Do NOT add shapes here. New patterns go in the catalogue, where every
 * consumer gets them at once. And note what the catalogue deliberately CANNOT
 * separate: an injected role prompt opening `# Mug — …` from an owner's `# my
 * notes`. A matcher aggressive enough for that starts hiding the owner's own
 * words — the unrecoverable direction (D-002/D-003). That residue is fixed by
 * stamping provenance AT INGEST (P-004), never by a better matcher here.
 *
 * This is a RENDER filter only. Nothing is deleted: the full turn stays in the
 * transcript stores and in every audit/session-search path. The narrower reading
 * of "never hide delivered content" in `stripMachineTurnAnnotations` above still
 * holds for what it governs — a wake blob was delivered to the AGENT, and this
 * pane is the OWNER's conversation, so it was never theirs to be shown.
 *
 * PURE → unit-tested.
 */
export function ownerVisiblePromptText(text: string): string {
  const { verdict, visible } = classifyOwnerVisibility(text);
  return verdict === 'show' ? visible : '';
}

/**
 * Why a turn is not being shown — the distinction a BOUNDED HEAD needs.
 *
 * `hide` means a rule MATCHED and claimed the turn as machine-authored.
 * `inconclusive` means no rule matched and there was simply no visible content
 * in the text we were handed. For a whole turn those collapse (both render
 * nothing). For a bounded head they must NOT: `inconclusive` on a head means
 * *the deciding content may lie past the bound*, and a caller that reads it as
 * `hide` drops a turn a human wrote — see
 * {@link OWNER_VISIBILITY_DECIDING_PREFIX_CHARS}, divergence 2.
 */
export type OwnerVisibilityVerdict = 'show' | 'hide' | 'inconclusive';

/**
 * The single classifier both public forms derive from (WI-37910).
 *
 * Deliberately ONE function rather than a second copy of the branch order: a
 * predicate and its tri-state twin drifting apart is the same failure mode
 * `isOwnerVisiblePrompt` was derived from `ownerVisiblePromptText` to prevent.
 */
function classifyOwnerVisibility(text: string): { verdict: OwnerVisibilityVerdict; visible: string } {
  if (!text) return { verdict: 'inconclusive', visible: '' };
  // WI-10002461: a PTY-injected turn arrives as ONE Claude Code paste block, which
  // pushes its envelope off the head. Read the origin from the pasted text. A
  // bounded head cannot contain the closing tag, so it is not unwrapped and fails
  // toward SHOW — divergence 1 below, the safe direction.
  const origin = unwrapWholePaste(text).match(TURN_ORIGIN_CAPTURE_RE)?.[1];
  if (origin !== undefined) {
    if (origin !== OWNER_CHAT_TURN_ORIGIN) return { verdict: 'hide', visible: '' };
  } else {
    const trimmed = text.trimStart();
    if (trimmed.startsWith(HOOK_FEEDBACK_PREFIX) || UNENVELOPED_WAKE_RE.test(trimmed)) {
      return { verdict: 'hide', visible: '' };
    }
    // The curated catalogue — head-bounded inside the predicate, so an owner
    // QUOTING one of these shapes mid-sentence keeps their turn.
    if (isUnenrolledMachineSurface(trimmed)) return { verdict: 'hide', visible: '' };
  }
  // No HIDE rule claimed it. `stripMachineTurnAnnotations` trims, so an empty
  // result here means "nothing visible in THIS text" — not a provenance verdict.
  const visible = stripMachineTurnAnnotations(text);
  return visible === ''
    ? { verdict: 'inconclusive', visible: '' }
    : { verdict: 'show', visible };
}

/**
 * The tri-state form, for callers holding a BOUNDED HEAD rather than a whole
 * turn — today the transcript search's post-filter.
 *
 * A head is DECISIVE only when it carries a marker or visible content. With
 * neither it returns `inconclusive`, and the caller must fail OPEN. Reading
 * `inconclusive` as `hide` is exactly the bug this exists to prevent
 * (WI-37910). PURE → unit-tested.
 */
export function ownerVisibilityVerdict(text: string): OwnerVisibilityVerdict {
  return classifyOwnerVisibility(text).verdict;
}

/**
 * How much of a user turn's LEADING text is enough to decide owner-visibility.
 *
 * Every branch of {@link ownerVisiblePromptText} keys on a LEADING marker — the
 * `⟦turn-origin:… nonce:…⟧` envelope (~40-120 chars) or the
 * `Stop hook feedback:` prefix (19), or the legacy
 * `[await-event] <key> fired` prefix — so a bounded head of the turn decides the
 * verdict identically to the whole thing. That matters because the second
 * consumer of this predicate is a SEARCH path (WI-37883) that hydrates metadata
 * for a page of hits: pulling whole transcript turns there to answer a
 * yes/no question would move megabytes per keystroke.
 *
 * 512 is ~4× the longest envelope, which leaves room for the marker to grow
 * without anyone having to remember this constant exists.
 *
 * ⚠ THERE ARE TWO DIVERGENCES, NOT ONE, AND THEY POINT IN OPPOSITE DIRECTIONS.
 * This block used to claim a single divergence that always failed toward
 * SHOWING. That was false, and a test named PREFIX-SAFE certified it (WI-37910,
 * found by independent verification of WI-37883). Both are stated here because
 * the next person to widen this predicate will reason from this comment:
 *
 *   1. HEAD SHOWS, WHOLE HIDES — the head is unmarked but the full text strips
 *      to empty. Fails toward showing: the safe side, and genuinely deliberate.
 *
 *   2. HEAD HIDES, WHOLE SHOWS — the first
 *      {@link OWNER_VISIBILITY_DECIDING_PREFIX_CHARS} characters are entirely
 *      WHITESPACE (with or without a leading owner envelope), so the head strips
 *      to empty and reads HIDE, while the real text begins past the bound and
 *      reads SHOW. This fails toward HIDING something a human wrote — the
 *      direction the whole predicate exists to prevent.
 *
 * Divergence 2 is NOT fixed here, and deliberately so. This function cannot see
 * whether it was handed a head or a whole turn, so "a content-free window means
 * inconclusive, not hide" is a statement only the CALLER can make — and making
 * it here would render a blank row for a genuinely whitespace-only turn. It is
 * closed at the one seam that hydrates a bounded head: `filterOwnerVisibleTurnHits`
 * in `adv-session-search.ts` keeps a hit whose head has no visible content,
 * instead of asking this predicate a question the head cannot answer.
 *
 * So the invariant to carry forward is not "the head always agrees with the
 * whole". It is: **a head is DECISIVE only when it carries a marker or visible
 * content; with neither it makes no claim, and a caller must fail open.** Any
 * new consumer that hydrates a bounded head owes the same guard.
 *
 * It takes ≥512 leading whitespace characters to reach, so no owner turn is
 * believed to have been hidden by it. The defect worth fixing was the false
 * guarantee, not the traffic.
 */
export const OWNER_VISIBILITY_DECIDING_PREFIX_CHARS = 512;

/**
 * Would this `user`-role turn appear in the owner's chat pane at all?
 *
 * The boolean form of {@link ownerVisiblePromptText}, for callers that need the
 * VERDICT rather than the display text — today the owner-facing transcript
 * search, which must not offer the owner a hit inside text the pane hides
 * (WI-37883: the excerpt leaks machine plumbing, and the deep-link into it
 * cannot anchor because the target message was never rendered).
 *
 * Deriving it from the same function rather than re-stating the rule is the
 * whole point: a second copy of the allow-list is exactly the drift the parent
 * fix (EI-20135573616431912) was shaped to make impossible.
 *
 * Safe on a bounded head of the turn — see
 * {@link OWNER_VISIBILITY_DECIDING_PREFIX_CHARS}. PURE → unit-tested.
 */
export function isOwnerVisiblePrompt(text: string): boolean {
  return ownerVisiblePromptText(text) !== '';
}
