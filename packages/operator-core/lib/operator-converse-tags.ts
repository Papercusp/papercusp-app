/**
 * Parser for the operator-converse turn-output tags:
 *
 *   <say>{utterance}</say>
 *   <set_mode>passive|active</set_mode>
 *   <sleep duration_minutes="N" reason="…">
 *   <spawn role="worker" harness="…" feature="…" chunk="…" extras="K=V,K2=V2">
 *
 * The conversation engine parses each operator turn through this
 * module and dispatches four side-effects:
 *   1. Render the say-text (if any) into the chat transcript + TTS.
 *   2. Flip operator mode (if a set_mode tag was emitted).
 *   3. Set the sleep-until clock (if a sleep tag was emitted).
 *   4. Dispatch each spawn / handoff / delegate_deep tag through the
 *      correct server-side lane.
 *
 * Pure parsing only — no DOM, no fetch, no state writes. Callers
 * thread the parsed result into the OperatorConversation reducer.
 *
 * The voice path (EL Conv AI / OpenAI Realtime) and the text path
 * (`/api/agent-mcp/operator-converse`) both produce the same shape
 * of raw turn string and both feed it through this parser, so the
 * two surfaces can stay in lockstep on tag semantics.
 *
 * Error handling: malformed tags are dropped silently with a console
 * warning. The user's chat keeps moving — a bad sleep tag shouldn't
 * crash the loop. Telemetry on parse failures is the next layer's job.
 */

import { parseReportBlock, type ReportBlock } from '@papercusp/chat-protocol';
import {
  clearOperatorMirror,
  mirrorOperatorMode,
  mirrorOperatorSleep,
} from './operator-window-sync';

export type OperatorMode = 'active' | 'passive';

/**
 * The `<report>` payload schema is THE shared structured-block schema of the
 * card system — it lives in `@papercusp/chat-protocol` as `ReportBlock`
 * (one schema for `<report>`, `CardSpec.report`, and attention items; see
 * report-cards-inbox-reconciliation-2026-06-05 D-001). `ParsedReport` is the
 * operator-converse-facing alias, kept so the parse surface reads naturally.
 */
export type { ReportItem, ReportPlan } from '@papercusp/chat-protocol';
export type ParsedReport = ReportBlock;

export interface SpawnRequest {
  role: string;
  /** Registry slug of the harness to spawn into (the `harness` attribute).
   *  null → the dispatcher falls back to the workspace's single registered
   *  harness, or fails loud when that's ambiguous. */
  harness: string | null;
  featureId: string | null;
  chunkId: string | null;
  extras: string[];
}

/**
 * `<handoff>` — the SENTINEL'S placement seam (sentinel-herald Phase 4,
 * P-014). The Sentinel/Herald never places work itself (its capability envelope
 * denies cup:spawn/placement by design); instead it SUGGESTS + HANDS OFF: it
 * files a HIGH-PRIORITY work_item the user asked for and nudges the Mug, who is
 * the placer. This is the structured twin of `<spawn>` — same parse-server-side,
 * dispatch-side-effect shape — but honored ONLY for role==='sentinel' (the
 * operator path never reads it). The Sentinel must NOT emit `<spawn>`.
 *
 *   <handoff summary="…" harness="…" feature="…" tier="low|medium|high"
 *                   urgent="true" capability="…">
 */
export interface HandoffRequest {
  /** What the user wants done — becomes the work_item title/summary. Required. */
  summary: string;
  /** Harness slug the request is about (sets the work_item scope + Mug context).
   *  null → workspace-scope / the Mug resolves the home harness. */
  harness: string | null;
  /** Feature/chunk the conversation is about, carried so the Mug picks up where
   *  the conversation is (work_item context). null when unscoped. */
  featureId: string | null;
  /** Action tier the Sentinel self-classified (the user-facing approval tier,
   *  P-015): 'low' → just file + nudge; 'medium'/'high' → surface for approval
   *  via the standing-approval system before the Mug acts. The SERVER
   *  re-resolves the authoritative tier from `capability` when present; this is
   *  the brain's hint / the fallback when no capability is named. Default 'high'
   *  (user-asked work is high-priority by default — the persona contract). */
  tier: 'low' | 'medium' | 'high';
  /** The capability the handoff ultimately exercises (e.g. 'cup:spawn'); when
   *  present the server resolves the AUTHORITATIVE tier from the substrate
   *  tier-table (resolveActualTier) rather than trusting the brain's `tier`. null
   *  when the request is generic. */
  capability: string | null;
  /** Urgent → the work_item is filed `urgent` (wakes the Mug NOW via the
   *  hive urgent-wake, not her slow cadence) and the nudge escalates. */
  urgent: boolean;
}

/**
 * `<delegate_deep>` — the SENTINEL'S hard-thinking seam
 * (voice-unified-sentinel-pipeline-2026-07-01, P-005/P-006). The Sentinel stays
 * conversationally responsive; sustained analysis is delegated to the deep lane
 * and the answer is routed back into the conversation later. Honored ONLY for
 * role==='sentinel' — the operator path ignores it.
 *
 *   <delegate_deep summary="…" brief="…" harness="…">
 */
export interface DeepDelegateRequest {
  /** The question to answer. Required. */
  summary: string;
  /** Extra context for the delegated analysis agent. Optional. */
  brief: string | null;
  /** Harness slug the question is about. null → default resolution. */
  harness: string | null;
}

export interface ParsedOperatorTurn {
  /** The user-visible utterance, or null when the operator went silent (sleep tag only). */
  say: string | null;
  /** Mode flip the operator emitted, or null when no flip. */
  setMode: OperatorMode | null;
  /** Sleep tag the operator emitted, or null when no sleep. */
  sleep: { durationMinutes: number; reason: string } | null;
  /** Spawn requests emitted this turn. Empty array when none. */
  spawns: SpawnRequest[];
  /**
   * `<handoff>` requests emitted this turn (sentinel-herald P-014).
   * Empty array when none. The converse dispatch honors these ONLY when the
   * turn's role is 'sentinel' — the operator path ignores them (it spawns
   * directly via `spawns`). Parallel handoffs in one turn are allowed.
   */
  handoffs: HandoffRequest[];
  /**
   * `<delegate_deep>` requests emitted this turn. Empty array when none. The
   * converse dispatch honors these ONLY when the turn's role is 'sentinel' —
   * the operator path ignores them. Parallel deep delegations in one turn are
   * allowed (bounded later by the deep-delegate lane itself).
   */
  deepDelegations: DeepDelegateRequest[];
  /**
   * True when the brain emitted `<continue/>` — it has more user-visible
   * progress to make in the same conversation thread, no user input
   * required. The runtime auto-fires another turn with trigger='continue'.
   *
   * Plan: active-mode-proactive-ticks-2026-05-14.md §C.2. Must be paired
   * with a `<say>` narrating what's about to happen (prompt rule).
   */
  continue: boolean;
  /**
   * Structured `<report>` payload the operator emitted this turn, or null
   * when none. Paired with `<say>` (the say is the clean line, the report
   * is the structured detail). See structured-report-protocol-2026-06-05.
   */
  report: ParsedReport | null;
  /** Raw input, kept for debug/telemetry. Do NOT render this directly. */
  raw: string;
}

const SAY_RE = /<say>([\s\S]*?)<\/say>/i;
const SET_MODE_RE = /<set_mode>\s*(active|passive)\s*<\/set_mode>/i;
// <sleep duration_minutes="N" reason="…"> — self-closing-style; we
// match the opening tag and ignore any trailing content. `reason` is
// optional. Both attributes accept double or single quotes.
const SLEEP_RE = /<sleep\s+([^>]+?)\s*\/?>/i;
// <continue/> — self-closing, no attributes. Signals "I have more
// user-visible progress to make; auto-fire another turn." See
// active-mode-proactive-ticks-2026-05-14.md §C.2. Accept either
// `<continue/>` or `<continue />` (with or without space).
const CONTINUE_RE = /<continue\s*\/?>/i;
// <spawn role="…" feature="…" chunk="…" extras="K=V,K2=V2"> — self-closing.
// role required; feature/chunk/extras optional. Multiple <spawn> tags per
// turn are allowed (parallel fan-out: "review these three plans").
const SPAWN_RE = /<spawn\s+([^>]+?)\s*\/?>/gi;
// <handoff summary="…" harness="…" feature="…" tier="…" urgent="true"
//  capability="…"> — self-closing. summary required; the rest optional. Multiple
// per turn allowed (the Sentinel can hand off a small batch). Same attr-bag shape
// as <spawn>. (sentinel-herald P-014.)
//
// DUAL-ACCEPT, now THREE spellings deep. Each rename kept the previous name
// parseable rather than swapping it, for one reason stated once here:
//   a live session holds its prompt text in-context for the REST OF ITS LIFETIME.
// It cannot learn a new tag mid-conversation, so the turn it emits after a prompt
// change still carries the old spelling. A parser that recognised only the new
// name would not error on that turn — `parseConverseTags` would simply find no
// handoff and drop it, losing the user's request silently. That is the same
// silent-loss class WI-37616 fixed one layer down, which is why the alias is
// additive every time and never a swap.
//   `<handoff_to_queen>` — original (pre cup-lexicon-full-rename-2026-07-09).
//   `<handoff_to_mug>`   — P-006 of that plan.
//   `<handoff>`          — EI-20052781635798548: the Mug/Kettle/cup tier was
//                          RETIRED 2026-08-09, so the destination in the name no
//                          longer exists. Role-neutral, and the name the prompt
//                          now tells the brain to emit.
// Retire an old alternative only when no session can still hold that prompt text.
const HANDOFF_RE = /<handoff(?:_to_(?:mug|queen))?\s+([^>]+?)\s*\/?>/gi;
// <delegate_deep summary="…" brief="…" harness="…"> — self-closing. summary
// required; the rest optional. Multiple per turn allowed; the dispatch lane caps
// actual concurrency.
const DELEGATE_DEEP_RE = /<delegate_deep\s+([^>]+?)\s*\/?>/gi;
// <report>{json}</report> — a single JSON object of per-plan/per-item status
// blocks (D-001). Non-greedy body; we JSON-parse + validate it via
// parseReportBody. Paired with <say> per the prompt (D-004). The whole span
// is also stripped from the no-<say> fallback so a stray report never leaks
// raw JSON into the chat bubble.
const REPORT_RE = /<report>([\s\S]*?)<\/report>/i;
const REPORT_STRIP_RE = /<report>[\s\S]*?<\/report>/gi;
// Strip a self-closing <spawn …>/<handoff …> (all three handoff spellings, see
// HANDOFF_RE) from the no-<say> prose fallback so a stray control tag never leaks
// as raw text into the chat bubble.
//
// ⚠ THIS ALTERNATION MUST STAY IN LOCKSTEP WITH `HANDOFF_RE`. It is the FALLBACK
// path, so a spelling that HANDOFF_RE parses but this one misses does not fail
// loudly — it leaks a raw `<handoff …>` tag into the user's chat bubble as prose,
// on exactly the turns where the model omitted <say>. Add a spelling to both or
// neither; `operator-converse-tags.test.ts` asserts the two agree.
const CONTROL_TAG_STRIP_RE = /<(?:spawn|handoff(?:_to_(?:mug|queen))?|delegate_deep)\s+[^>]*?\/?>/gi;

/**
 * Validate a raw `<report>` JSON body into a `ParsedReport`, or null when
 * it's malformed / empty. Defensive like `parseAttrs` — never throws; a
 * bad payload is dropped (the caller warns) rather than crashing the turn.
 *
 * Thin wrapper: JSON-parse here, then delegate shape validation/normalization
 * to the shared `parseReportBlock` in `@papercusp/chat-protocol` (the one
 * schema — see report-cards-inbox-reconciliation-2026-06-05 D-001).
 */
export function parseReportBody(jsonBody: string): ParsedReport | null {
  let data: unknown;
  try {
    data = JSON.parse(jsonBody);
  } catch {
    return null;
  }
  return parseReportBlock(data);
}

/**
 * Clamp a `<say>` body to TTS-safe bounds: ≤220 chars, no markdown
 * formatting markers, no leading/trailing whitespace. Per the active-mode
 * plan ("1–2 sentences, ≤220 chars, TTS-safe, no markdown").
 *
 * Markdown stripping is deliberately conservative: only the inline
 * markers (`**`, `__`, `_`, `` ` ``, `[…](…)`) — block-level constructs
 * (headings, lists, code fences) shouldn't appear inside a single say
 * body and we don't want to mangle prose with literal asterisks.
 *
 * Over-cap handling is the STRUCTURAL backstop of voice-persona
 * P-002 ("headline + offer to continue"): the persona instruction holds
 * the cap in validated runs, but when a turn DOES overrun, mid-thought
 * truncation is degraded speech — so we cut at the last complete
 * SENTENCE that fits instead (the model's leading sentences are its
 * headline). Word-boundary + ellipsis remains the fallback for a first
 * sentence that itself overruns the cap.
 */
const SAY_MAX_CHARS = 220;
/** Below this many chars, a sentence-boundary cut would keep so little of
 *  the turn that the word-boundary fallback preserves more substance. */
const SAY_MIN_SENTENCE_CUT = 60;

/** Index just past the LAST sentence terminator (., !, ?, …, optionally
 *  followed by a closing quote/bracket) that is followed by whitespace.
 *  -1 when the slice holds no complete sentence. "3.5" / "v2.1" never
 *  match — the terminator must precede whitespace. */
function lastSentenceBoundary(text: string): number {
  const re = /[.!?…]+["')\]]*(?=\s)/g;
  let last = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) last = m.index + m[0].length;
  return last;
}

export function clampSay(s: string): string {
  let out = s.trim();
  // Inline markdown:
  out = out.replace(/\*\*([^*]+)\*\*/g, '$1'); // bold
  out = out.replace(/__([^_]+)__/g, '$1');     // bold (alt)
  out = out.replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, '$1'); // italic
  out = out.replace(/`([^`]+)`/g, '$1');       // inline code
  out = out.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'); // links → just the text
  if (out.length > SAY_MAX_CHARS) {
    const head = out.slice(0, SAY_MAX_CHARS);
    const sentenceEnd = lastSentenceBoundary(head);
    if (sentenceEnd >= SAY_MIN_SENTENCE_CUT) {
      // Sentence-boundary cut: ends on a complete thought, speaks clean.
      // No ellipsis — the terminator IS the natural stop.
      out = head.slice(0, sentenceEnd).trimEnd();
    } else {
      // Fallback: truncate at a word boundary close to the cap. Keep an
      // ellipsis hint so the LLM (reading next-turn context) sees the
      // truncation.
      const cut = head.replace(/\s+\S*$/, '');
      out = (cut.length > 0 ? cut : head) + '…';
    }
  }
  return out;
}

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Match `key="value"` and `key='value'`. Loose enough that small
  // model-side formatting drift (extra spaces, attribute reordering)
  // still parses. `key=value` (no quotes) intentionally NOT supported
  // — we want a simple, predictable tag shape from the model.
  const re = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    out[m[1].toLowerCase()] = m[2] ?? m[3] ?? '';
  }
  return out;
}

/**
 * Parse a raw turn-output string from the operator into structured
 * `say` / `setMode` / `sleep` slots. Always returns a result object;
 * any tag that fails to validate is dropped (with a console warn).
 *
 * Tag-presence rules from operator.converse.md (enforced loosely
 * here — the model is the primary enforcer, this is a safety net):
 *
 *   - `<say>` paired with `<set_mode>` is fine
 *   - `<sleep>` SHOULD NOT pair with `<say>` (silence IS the response).
 *     If both appear, the say wins and sleep is dropped.
 *   - Multiple of the same tag → first wins, rest dropped.
 */
export function parseOperatorTurn(raw: string): ParsedOperatorTurn {
  const result: ParsedOperatorTurn = {
    say: null,
    setMode: null,
    sleep: null,
    spawns: [],
    handoffs: [],
    deepDelegations: [],
    continue: false,
    report: null,
    raw,
  };
  if (CONTINUE_RE.test(raw)) {
    result.continue = true;
  }

  const sayMatch = SAY_RE.exec(raw);
  if (sayMatch) {
    const text = sayMatch[1].trim();
    result.say = text.length > 0 ? clampSay(text) : null;
  } else if (!SLEEP_RE.test(raw)) {
    // Defensive fallback: model emitted bare prose without <say> wrapping.
    // Treat the whole turn as the spoken content so the user actually sees
    // the reply. Strip any <set_mode> tags so they don't show in the
    // bubble. Skipped entirely when the turn contains a <sleep> — that's
    // the going-silent contract (silence IS the response), and any prose
    // around the sleep tag is model debug noise we should drop.
    const stripped = raw
      .replace(REPORT_STRIP_RE, '')
      .replace(CONTROL_TAG_STRIP_RE, '')
      .replace(/<set_mode>[^<]*<\/set_mode>/gi, '')
      .replace(CONTINUE_RE, '')
      .trim();
    if (stripped.length > 0) {
      result.say = clampSay(stripped);
    }
  }

  const modeMatch = SET_MODE_RE.exec(raw);
  if (modeMatch) {
    const mode = modeMatch[1].toLowerCase() as OperatorMode;
    if (mode === 'active' || mode === 'passive') result.setMode = mode;
  }

  const sleepMatch = SLEEP_RE.exec(raw);
  if (sleepMatch) {
    const attrs = parseAttrs(sleepMatch[1]);
    const dur = Number(attrs['duration_minutes']);
    if (!Number.isFinite(dur) || dur <= 0) {
      // Malformed; drop with a warn so we notice if the model drifts.
       
      console.warn('[operator-converse] dropped malformed <sleep>: bad duration_minutes', {
        attrs,
        raw,
      });
    } else {
      result.sleep = {
        // Cap at 1 day. The plan's intent for <sleep> is "give me a
        // minute" / "I'm busy this hour" — anything longer than a day
        // is almost certainly a model formatting bug, and parking the
        // operator for weeks/years on a stray "9999" would be a footgun.
        durationMinutes: Math.min(Math.floor(dur), 60 * 24),
        reason: attrs['reason'] ?? '',
      };
    }
  }

  // Spawn tags — collect every <spawn …> in the turn.
  let spawnMatch: RegExpExecArray | null;
  // Reset regex state because g-flag is sticky.
  SPAWN_RE.lastIndex = 0;
  while ((spawnMatch = SPAWN_RE.exec(raw)) !== null) {
    const attrs = parseAttrs(spawnMatch[1]);
    const role = (attrs['role'] ?? '').trim();
    if (!role) {
       
      console.warn('[operator-converse] dropped malformed <spawn>: missing role', { attrs });
      continue;
    }
    const extrasRaw = attrs['extras'] ?? '';
    const extras = extrasRaw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    result.spawns.push({
      role,
      harness: attrs['harness'] ? attrs['harness'] : null,
      featureId: attrs['feature'] ? attrs['feature'] : null,
      chunkId: attrs['chunk'] ? attrs['chunk'] : null,
      extras,
    });
  }

  // <handoff …> (dual-accept: also the legacy <handoff_to_mug …>/<handoff_to_queen …>, see HANDOFF_RE) —
  // the Sentinel's file-and-nudge placement seam (sentinel-herald P-014). Collect
  // every tag in the turn. Like <spawn>, a missing required attr (here `summary`)
  // drops the tag with a warn. `tier` is constrained to low|medium|high (anything
  // else falls back to 'high', the user-asked-work default); `urgent` is a
  // boolean-ish attr ("true"/"1"/"yes").
  let handoffMatch: RegExpExecArray | null;
  HANDOFF_RE.lastIndex = 0;
  while ((handoffMatch = HANDOFF_RE.exec(raw)) !== null) {
    const attrs = parseAttrs(handoffMatch[1]);
    const summary = (attrs['summary'] ?? '').trim();
    if (!summary) {

      console.warn('[operator-converse] dropped malformed <handoff>: missing summary', {
        attrs,
      });
      continue;
    }
    const tierRaw = (attrs['tier'] ?? '').trim().toLowerCase();
    const tier: HandoffRequest['tier'] =
      tierRaw === 'low' || tierRaw === 'medium' ? tierRaw : tierRaw === 'high' ? 'high' : 'high';
    const urgentRaw = (attrs['urgent'] ?? '').trim().toLowerCase();
    const urgent = urgentRaw === 'true' || urgentRaw === '1' || urgentRaw === 'yes';
    result.handoffs.push({
      summary,
      harness: attrs['harness'] ? attrs['harness'] : null,
      featureId: attrs['feature'] ? attrs['feature'] : null,
      tier,
      capability: attrs['capability'] ? attrs['capability'] : null,
      urgent,
    });
  }

  // <delegate_deep …> — the Sentinel's hard-thinking delegation seam. Collect
  // every tag in the turn. Like the other control tags, a missing required attr
  // drops the tag with a warn; `brief` and `harness` are optional.
  let deepMatch: RegExpExecArray | null;
  DELEGATE_DEEP_RE.lastIndex = 0;
  while ((deepMatch = DELEGATE_DEEP_RE.exec(raw)) !== null) {
    const attrs = parseAttrs(deepMatch[1]);
    const summary = (attrs['summary'] ?? '').trim();
    if (!summary) {
       
      console.warn('[operator-converse] dropped malformed <delegate_deep>: missing summary', {
        attrs,
      });
      continue;
    }
    const brief = (attrs['brief'] ?? '').trim();
    result.deepDelegations.push({
      summary,
      brief: brief.length > 0 ? brief : null,
      harness: attrs['harness'] ? attrs['harness'] : null,
    });
  }

  // <report> — structured per-plan/per-item status, rendered as a card
  // (desktop) / two-tier list (TUI). Validate the JSON body; drop+warn on
  // malformed (like <sleep>) so a bad payload never crashes the turn.
  const reportMatch = REPORT_RE.exec(raw);
  if (reportMatch) {
    const report = parseReportBody(reportMatch[1].trim());
    if (report) {
      result.report = report;
    } else {
       
      console.warn('[operator-converse] dropped malformed <report>: invalid/empty JSON body', {
        raw,
      });
    }
  }

  // Sleep + say is contradictory per the prompt contract. Drop sleep
  // when both present; the user-visible say wins. Log so we notice if
  // the model is making this mistake regularly.
  if (result.sleep && result.say) {
     
    console.warn('[operator-converse] dropped <sleep> because <say> was also emitted (going-silent contract)', {
      raw,
    });
    result.sleep = null;
  }

  return result;
}

// ─── sessionStorage / localStorage hooks for runtime state ──────────────

const MODE_KEY = 'papercusp.operatorMode';
const SLEEP_UNTIL_KEY = 'papercusp.operatorSleepUntilMs';
const MESSAGES_KEY = 'papercusp.operatorMessages';
const PENDING_DISMISSAL_KEY = 'papercusp.operatorPendingDismissalAtMs';
const MESSAGES_MAX = 100; // bound the stored history to keep sessionStorage well under quota

/**
 * Read the operator's current mode from sessionStorage. Returns null
 * when the storage is empty (signals "not yet seeded from settings"
 * to the bootstrap logic in OperatorConversation).
 *
 * Mode is intentionally sessionStorage (not localStorage): every fresh
 * app open re-seeds from the user's `activeOnStartup` setting (default
 * true). Mid-session toggles persist within the tab; refreshing the
 * tab is treated as a fresh session.
 */
export function readOperatorModeFromSession(): OperatorMode | null {
  if (typeof window === 'undefined') return null;
  try {
    // G16: F5/reload should reset mode to "active" per the plan
    // ("Refresh = active again"). sessionStorage survives reload by
    // design; check PerformanceNavigationTiming and clear on a
    // reload navigation so the bootstrap re-seeds from voice prefs.
    // Only do this once per page lifetime — subsequent reads should
    // see the cleared value (null → bootstrap → 'active').
    //
    // C5 of the audit: we also clear SLEEP_UNTIL_KEY. Intentional —
    // a reload is treated as a fresh session, and "active" mode with
    // a stale sleep timer would manifest as a chip that says "Active"
    // but operator-doesn't-talk for an inexplicable interval. If
    // sleep-persists-across-reload becomes a product requirement,
    // gate this on a separate setting; today, freshness wins.
    if (!reloadResetApplied) {
      reloadResetApplied = true;
      try {
        const nav = performance.getEntriesByType('navigation')[0] as
          | PerformanceNavigationTiming
          | undefined;
        if (nav && nav.type === 'reload') {
          window.sessionStorage.removeItem(MODE_KEY);
          window.sessionStorage.removeItem(SLEEP_UNTIL_KEY);
          // G16 is an operator-wide reset: clearing the cross-window mirror
          // propagates it to peer windows (multi-window-chat-coherence P-007)
          // instead of leaving e.g. the Quick Panel on the old mode.
          clearOperatorMirror();
          return null;
        }
      } catch { /* perf API unsupported — fall through */ }
    }
    const v = window.sessionStorage.getItem(MODE_KEY);
    if (v === 'active' || v === 'passive') return v;
    return null;
  } catch {
    return null;
  }
}

let reloadResetApplied = false;

export function writeOperatorModeToSession(mode: OperatorMode): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(MODE_KEY, mode);
    // Keep peer windows (Quick Panel ↔ main app) on the same mode
    // (multi-window-chat-coherence P-007).
    mirrorOperatorMode(mode);
  } catch { /* sandbox / quota */ }
}

/**
 * Read the sleep-until epoch (ms). 0 or negative means "no sleep
 * timer set" or "expired". The "want active?" gate uses this.
 *
 * Stored in sessionStorage so it resets on tab close — the operator's
 * patience-tuning is relevant only for the current session.
 */
export function readSleepUntilMs(): number {
  if (typeof window === 'undefined') return 0;
  try {
    const v = window.sessionStorage.getItem(SLEEP_UNTIL_KEY);
    if (!v) return 0;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function writeSleepUntilMs(epochMs: number): void {
  if (typeof window === 'undefined') return;
  try {
    if (epochMs <= 0) window.sessionStorage.removeItem(SLEEP_UNTIL_KEY);
    else window.sessionStorage.setItem(SLEEP_UNTIL_KEY, String(epochMs));
    // Fan out so the chip + silence-timer effect re-evaluate without
    // having to poll sessionStorage.
    window.dispatchEvent(
      new CustomEvent('papercusp:operatorSleep', { detail: { sleepUntilMs: epochMs } }),
    );
    // Peer windows share the sleep timer (multi-window-chat-coherence P-007).
    mirrorOperatorSleep(epochMs);
  } catch { /* sandbox / quota */ }
}

/** Wake the operator immediately. No-op when no sleep is set. */
export function clearOperatorSleep(): void {
  writeSleepUntilMs(0);
}

/**
 * Pending-dismissal bridge (E1). When a user turn matches the
 * dismissal heuristic, the provider stamps "now" here. The voice tag
 * observer's flush checks this on each parsed assistant turn — if the
 * stamp is recent (≤8s) AND the parsed turn didn't already include
 * `<set_mode>passive</set_mode>`, the observer forces the flip.
 *
 * Symmetry with the text-path enforcement in
 * OperatorConversationProvider.runGeneration: voice users who say
 * "I'm busy" get the same automatic mode flip as text users who type it.
 *
 * sessionStorage rather than a module global so it survives the
 * provider/observer module boundary in dev with Fast Refresh.
 */
const PENDING_DISMISSAL_TTL_MS = 8_000;

export function writePendingDismissalAtMs(epochMs: number): void {
  if (typeof window === 'undefined') return;
  try {
    if (epochMs <= 0) window.sessionStorage.removeItem(PENDING_DISMISSAL_KEY);
    else window.sessionStorage.setItem(PENDING_DISMISSAL_KEY, String(epochMs));
  } catch { /* sandbox / quota */ }
}

export function consumeRecentDismissal(now: number = Date.now()): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const v = window.sessionStorage.getItem(PENDING_DISMISSAL_KEY);
    if (!v) return false;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return false;
    const fresh = now - n <= PENDING_DISMISSAL_TTL_MS;
    // Always clear — even stale stamps shouldn't stick around. A new
    // dismissal will re-stamp.
    window.sessionStorage.removeItem(PENDING_DISMISSAL_KEY);
    return fresh;
  } catch {
    return false;
  }
}

/** Convenience: convert a parsed sleep tag to an absolute epoch ms. */
export function sleepTagToEpochMs(
  sleep: { durationMinutes: number },
  now: number = Date.now(),
): number {
  return now + sleep.durationMinutes * 60 * 1000;
}

// ─── Conversation history persistence ────────────────────────────────────
//
// Stored in sessionStorage to match mode + sleep semantics: persist
// within the tab, reset on a fresh app open. Cross-tab sharing is NOT
// attempted — each tab runs its own conversation. Capped at MESSAGES_MAX
// items to bound the storage footprint; older messages are dropped FIFO.
//
// The provider rehydrates from this on mount and writes after every
// state change. Schema is `{ role, content, tools? }` — same shape as
// ChatConversation's ChatMessage so no extra adapter is needed.

interface PersistedMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  tools?: unknown[];
}

export function readOperatorMessagesFromSession(): PersistedMessage[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.sessionStorage.getItem(MESSAGES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((m): m is PersistedMessage => {
        if (!m || typeof m !== 'object') return false;
        const r = (m as { role?: unknown }).role;
        const c = (m as { content?: unknown }).content;
        if (r !== 'user' && r !== 'assistant' && r !== 'system') return false;
        if (typeof c !== 'string') return false;
        return true;
      })
      .slice(-MESSAGES_MAX);
  } catch {
    return [];
  }
}

export function writeOperatorMessagesToSession(messages: PersistedMessage[]): void {
  if (typeof window === 'undefined') return;
  try {
    const trimmed = messages.length > MESSAGES_MAX
      ? messages.slice(messages.length - MESSAGES_MAX)
      : messages;
    window.sessionStorage.setItem(MESSAGES_KEY, JSON.stringify(trimmed));
  } catch {
    // Quota exceeded or sandboxed — drop silently. The in-memory state
    // remains; we just lose persistence for this tab. Rare in practice
    // because of the MESSAGES_MAX cap.
  }
}

export function clearOperatorMessagesFromSession(): void {
  if (typeof window === 'undefined') return;
  try { window.sessionStorage.removeItem(MESSAGES_KEY); } catch { /* ignore */ }
}
