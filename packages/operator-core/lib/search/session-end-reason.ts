/**
 * session-end-reason — WHY did this session stop?
 *
 * EI-10889. A session row carried turns/prompts/tools/timestamps but nothing about
 * its terminal state, and the states an operator actually cares about are not
 * structural at all — they arrive as an ordinary assistant turn whose TEXT happens
 * to be a provider error:
 *
 *   "Your organization has disabled Claude subscription access for Claude Code"
 *   "You've hit your session limit · resets 4am"
 *   "API Error: 400 This model does not support effort level 'xhigh'"
 *
 * Those are indistinguishable from normal output to every query in the system, so
 * the only way to learn that a session is WEDGED is to read its transcript. During
 * the 2026-07-13 audit that is exactly what happened: a warm-loop program session
 * had been dead on an auth wall for hours, its loop routine flagged only as a
 * generic "dead routine", and nobody could see the cause without opening the tail.
 *
 * Classifying it once, here, makes the wedge queryable — and lets the fleet tell
 * the difference between "this agent finished" and "this agent was killed by the
 * provider and is silently doing nothing".
 *
 * Deliberately pattern-based over the last assistant turn: the provider messages
 * ARE the only signal that exists. Patterns are ordered hard-stop first, and every
 * match carries the matched EVIDENCE so a caller never has to trust the label
 * blindly (and so a drifting provider string shows up as `settled` with a visible
 * tail rather than a confidently wrong reason).
 */

import { MODEL_CAPACITY_RE } from '@papercusp/papercusp-shared/agent';

export type SessionEndReason =
  /** Provider/org killed the session: the account cannot run Claude Code at all. */
  | 'auth_wall'
  /** Rate/usage/session cap hit — recovers on its own when the window resets. */
  | 'usage_limit'
  /** The call was rejected on its own parameters (bad model, bad effort level, 4xx). */
  | 'model_error'
  /** Context/prompt overflow. */
  | 'context_limit'
  /** Alive and taking turns right now. */
  | 'active'
  /** Alive but parked on something only a human can clear. */
  | 'awaiting_owner'
  /** Ended normally (wrote a closing turn, no error signature). */
  | 'settled'
  /** No last turn to classify. */
  | 'unknown';

/** True when the reason means the session is STUCK — it is not going to make
 *  progress on its own and a human/relaunch is required. The distinction that
 *  matters operationally: `settled` is fine, `auth_wall` is an outage. */
export function isWedged(reason: SessionEndReason): boolean {
  return reason === 'auth_wall' || reason === 'model_error' || reason === 'context_limit';
}

interface Pattern {
  reason: SessionEndReason;
  re: RegExp;
}

/**
 * Ordered hard-stop-first. `auth_wall` precedes `usage_limit` because an org-level
 * disablement often *also* mentions limits, and the two demand opposite responses:
 * a usage limit resolves itself on reset; an auth wall never does.
 */
/**
 * `model_error` is the one reason whose signature mixes two very different precisions, so it
 * is kept as two halves and re-joined below (never hand-copied into a second list, which is
 * how the two would silently drift apart).
 *
 * MACHINE — anchored / structurally machine-emitted text an agent's own prose essentially
 * never reproduces verbatim ("API Error:" only counts at the START of the turn text). Precise
 * enough to scan BLIND against an opaque turn tail.
 */
/**
 * The Codex CLI's model-capacity wall ("⚠ Selected model is at capacity. Please try a different
 * model.") belongs in the MACHINE half — it is a provider wall that kills the turn, and the live
 * evidence is that it arrives as the FIRST line of the transcript. It is derived from the shared
 * taxonomy's `MODEL_CAPACITY_RE` rather than re-typed, so this venue and `classifyTurnError`
 * cannot drift apart.
 *
 * ANCHORED on purpose. The bare wording is short, ordinary English and therefore exactly the
 * collision shape EI-22102700164999066 was filed for: `classifyLoopLifecycleTurn` scans this half
 * BLIND over a turn's own prose, so an agent that merely DISCUSSED this failure (a session working
 * on the capacity-retry fix itself does so repeatedly) would be recorded as a dead wake —
 * `recordFire('error')`, fire-gate backoff, and a spurious death escalation against a healthy
 * loop. Requiring it at the START of the text — after at most a short run of non-word decoration,
 * which is what absorbs Codex's `⚠ ` prefix — keeps the half precise enough to scan blind.
 */
const MODEL_CAPACITY_ANCHORED_SRC = `^[\\s\\W]{0,8}${MODEL_CAPACITY_RE.source}`;
const MODEL_ERROR_MACHINE_RE = new RegExp(
  `^\\s*API Error(?::|\\s+[4-5]\\d{2}\\b)|does not support effort level|invalid_request_error|model .* not found|${MODEL_CAPACITY_ANCHORED_SRC}`,
  'i',
);
/**
 * LOOSE — bare topic words that collide with ordinary dev conversation ("discussed the rate
 * limit fix", "why 429 handling matters"). Safe ONLY for a session ALREADY KNOWN to be dead,
 * where the question is *why* it died rather than *whether* it did. Never scan this blind.
 */
const MODEL_ERROR_LOOSE_RE = /rate.?limit(?:ed)?\b|\b429\b/i;

/** The full `model_error` signature = MACHINE ∪ LOOSE, derived so the halves cannot drift. */
const MODEL_ERROR_RE = new RegExp(`${MODEL_ERROR_MACHINE_RE.source}|${MODEL_ERROR_LOOSE_RE.source}`, 'i');
// Blind callers may accept only a provider-shaped usage-limit opening. The broad
// `limit … resets` clause below remains useful for a known session tail, but it
// also matches a provider sentence quoted later in ordinary assistant prose.
const USAGE_LIMIT_MACHINE_RE =
  /^(?:(?:you(?:'|’)ve hit your|you have hit your|you have exceeded your|hit your) (?:session|usage|weekly|monthly|daily) limit|usage limit reached|quota exceeded)\b/i;

const PATTERNS: readonly Pattern[] = [
  { reason: 'auth_wall', re: /organization has disabled|subscription access.*disabled|disabled Claude subscription|use an Anthropic API key instead|ask your admin to enable|\b402\b[^\n]{0,120}\binsufficient credits\b|\binsufficient credits\b[^\n]{0,120}\b402\b/i },
  { reason: 'usage_limit', re: /hit your (?:session|usage) limit|usage limit reached|limit(?:\s|·|,)*resets|quota exceeded/i },
  { reason: 'context_limit', re: /prompt is too long|context (?:window )?(?:exceeded|overflow|too long)|maximum context length/i },
  { reason: 'model_error', re: MODEL_ERROR_RE },
];

/**
 * Does this text carry a MACHINE-emitted `model_error` signature (as opposed to merely
 * *mentioning* rate limits / 429s)?
 *
 * EI-22102700164999066: `classifyWedgeText` below deliberately drops `model_error` entirely
 * because its loose half is "far too loose to scan blind". But `classifyLoopLifecycleTurn`
 * (reconcile-loop-routines.ts) also scans blind — over `last_assistant_text_after_fire` — and
 * DOES honour `model_error`, so a loop turn that merely ENDED BY DISCUSSING a 429 was recorded
 * as a dead wake: `recordFire('error')`, fire-gate backoff, and a spurious death escalation.
 * Dropping `model_error` there instead would have re-opened the original bug, because a real
 * `API Error: Request rejected (429) …` death is exactly what that leg must still catch — so
 * the split lets a blind caller keep the precise half and leave the collision-prone half.
 */
export function isMachineModelErrorText(text: string | null | undefined): boolean {
  const t = (text ?? '').trim();
  return t.length > 0 && MODEL_ERROR_MACHINE_RE.test(t);
}

/**
 * Does this text START with a provider-shaped usage-limit signature?
 *
 * `classifySessionEnd` deliberately keeps the broader `limit … resets` pattern
 * for classifying a known terminal session tail. A blind scan of assistant prose
 * must use this narrower check so quoting that provider message does not look like
 * a provider kill.
 */
export function isMachineUsageLimitText(text: string | null | undefined): boolean {
  const t = (text ?? '').trim();
  return t.length > 0 && USAGE_LIMIT_MACHINE_RE.test(t);
}

export interface ClassifySessionEndInput {
  /** The session's LAST assistant turn — where a provider error lands. */
  lastAssistantText: string | null | undefined;
  /** Epoch ms of the session's last activity. */
  lastTsMs: number | null | undefined;
  /** Now, epoch ms. */
  nowMs: number;
  /** The agent has an open owner-gated wall (loop carry-note / needs-human item). */
  hasOpenWall?: boolean;
  /** Consider the session ACTIVE if it spoke within this window (default 10 min). */
  activeWithinMs?: number;
}

export interface SessionEndClassification {
  reason: SessionEndReason;
  /** The matched substring (bounded) — so a caller can verify the label, never trust it blind. */
  evidence: string | null;
  wedged: boolean;
}

const EVIDENCE_MAX = 200;

export function classifySessionEnd(input: ClassifySessionEndInput): SessionEndClassification {
  const text = (input.lastAssistantText ?? '').trim();
  const activeWithin = input.activeWithinMs ?? 10 * 60 * 1000;

  // A provider kill is terminal REGARDLESS of recency — in fact a fresh auth-wall
  // turn is the most urgent case there is (the session is being woken and dying on
  // every wake), so error classification must run BEFORE the liveness check. Doing
  // it the other way round labels a session that is failing once a minute "active".
  for (const p of PATTERNS) {
    const m = p.re.exec(text);
    if (m) {
      const at = Math.max(0, m.index - 20);
      return {
        reason: p.reason,
        evidence: text.slice(at, at + EVIDENCE_MAX),
        wedged: isWedged(p.reason),
      };
    }
  }

  if (!text) return { reason: 'unknown', evidence: null, wedged: false };

  if (input.hasOpenWall) {
    return { reason: 'awaiting_owner', evidence: null, wedged: false };
  }

  const lastMs = input.lastTsMs ?? null;
  if (lastMs != null && input.nowMs - lastMs <= activeWithin) {
    return { reason: 'active', evidence: null, wedged: false };
  }

  return { reason: 'settled', evidence: null, wedged: false };
}

/**
 * EI-13818: a NARROW, high-precision subset of the classification above, safe to run
 * blind against an OPAQUE output tail (not a live session's known-last text) — e.g. a
 * just-exited subprocess whose exit code alone can't tell you whether it died wedged.
 * Deliberately excludes `model_error` (its pattern's `rate.?limit(?:ed)?\b` clause is
 * intentionally broad for classifying a session ALREADY KNOWN to be dead, but far too
 * loose to scan blind — "discussed the rate limit fix" would trip it) and `context_limit`
 * (phrases like "context window exceeded" are plausible in ordinary dev conversation
 * about the very bug being fixed). `auth_wall` and provider-shaped `usage_limit` are the
 * two used here; the broad reset phrase remains exclusive to known session tails because
 * ordinary prose can quote it. See resume-turn-outcome.ts's `classifyResumeTurnExit`, the
 * caller this exists for.
 */
export function classifyWedgeText(
  text: string | null | undefined,
): { reason: 'auth_wall' | 'usage_limit'; evidence: string } | null {
  const t = (text ?? '').trim();
  if (!t) return null;
  for (const p of PATTERNS) {
    if (p.reason !== 'auth_wall' && p.reason !== 'usage_limit') continue;
    if (p.reason === 'usage_limit' && !isMachineUsageLimitText(t)) continue;
    const m = p.re.exec(t);
    if (m) {
      const at = Math.max(0, m.index - 20);
      return { reason: p.reason, evidence: t.slice(at, at + EVIDENCE_MAX) };
    }
  }
  return null;
}
