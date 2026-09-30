/**
 * Best-effort mode classifier for agent utterances.
 *
 * Per /docs/agents/operator-persona §4 + §10e: EL Conv AI doesn't tell
 * us which mode the model picked, so the post-call webhook can't tag
 * rows directly. This regex-based classifier infers mode from text
 * features so the drift report has signal where it'd otherwise be
 * `(null)`.
 *
 * Order of precedence: apologetic > sober > wry > assertive > default.
 * "default" is the catch-all when nothing more specific matches.
 *
 * Pure function. The persona plan §15 documents this as best-effort —
 * if the heuristic is too noisy in the report, tighten the regexes
 * here rather than expanding the row schema.
 */

export type Mode =
  | 'default'
  | 'assertive'
  | 'sober'
  | 'apologetic'
  | 'wry';

const APOLOGETIC = /\b(my mistake|i was wrong|i misread|i confused|sorry,|apologies|that was on me)\b/i;

const SOBER = /\b(failed|fail:|cannot reach|can'?t reach|unreachable|timed out|crashed|errored|degraded|outage|broken|deprecated|missing|not found)\b/i;

// Wry markers — light, ironic register. Includes specific persona-bank
// flavor lines like "new record I'm not proud of".
const WRY = /\b(not proud of|first time anything|don'?t get used to it|new record|fewer than usual|quieter than expected)\b/i;

// Assertive cues — "heads up" pattern, calibrated warnings.
const ASSERTIVE = /\b(heads up|fair warning|worth (knowing|flagging)|you should know|going to (?:cost|lose|overwrite)|will (?:overwrite|destroy|lose))\b/i;

export function classifyUtteranceMode(text: string): Mode {
  if (!text || !text.trim()) return 'default';
  if (APOLOGETIC.test(text)) return 'apologetic';
  if (SOBER.test(text))      return 'sober';
  if (WRY.test(text))        return 'wry';
  if (ASSERTIVE.test(text))  return 'assertive';
  return 'default';
}
