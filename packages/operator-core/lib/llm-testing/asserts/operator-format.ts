/**
 * Operator-specific format asserts.
 *
 * Plan: operator-behavior-tests-2026-05-14.md §4.1.
 *
 * Each helper is a `kind: 'custom'` evaluator registered against
 * `name === '<helperName>'`. Scenarios reference them as:
 *
 *   { kind: 'custom', name: 'continueAlwaysPairedWithSay', eval: continueAlwaysPairedWithSay }
 *
 * Helpers are pure functions over RunSummary so they can be unit-
 * tested against synthetic transcripts without PG/LLM.
 */

import { CLAUDE_BUILTIN_TOOLS } from '@papercusp/papercusp-shared/agent';
import { clampSay } from '../../operator-converse-tags';
import type { RunSummary, Violation, TurnResult } from '@papercusp/testing-shell/llm';

// =============================================================================
// 1. <continue/> paired with non-empty <say>
// =============================================================================

/** Strip all `<tag>...</tag>` and self-closing `<tag/>` blocks from text. */
function stripAllTags(text: string): string {
  return text
    .replace(/<say[^>]*>([\s\S]*?)<\/say>/gi, '$1')
    .replace(/<set_mode[^>]*>[\s\S]*?<\/set_mode>/gi, '')
    .replace(/<(continue|sleep|spawn)(\s[^>]*)?\/?>/gi, '');
}

function extractSayContent(text: string): string {
  const matches = [...text.matchAll(/<say[^>]*>([\s\S]*?)<\/say>/gi)];
  return matches.map((m) => m[1]).join(' ').trim();
}

function hasContinueTag(text: string): boolean {
  return /<continue(\s[^>]*)?\/?>/i.test(text);
}

function hasSleepTag(text: string): boolean {
  return /<sleep(\s[^>]*)?\/?>/i.test(text);
}

export function continueAlwaysPairedWithSay(run: RunSummary): Violation[] {
  const violations: Violation[] = [];
  for (let i = 0; i < run.turns.length; i++) {
    const t = run.turns[i];
    if (!hasContinueTag(t.assistantText)) continue;
    const sayContent = extractSayContent(t.assistantText).trim();
    if (!sayContent) {
      violations.push({
        assertKind: 'continueAlwaysPairedWithSay',
        severity: 'error',
        evidenceTurnIdx: i,
        claim: `Turn ${i} emitted <continue/> without a non-empty <say>. Production prompt requires narration alongside continue.`,
        suggestion: "Update the brain's prompt to always emit <say> before <continue/>.",
      });
    }
  }
  return violations;
}

// =============================================================================
// 2. <sleep/> with empty (or absent) <say>
// =============================================================================

export function sleepNeverWithSay(run: RunSummary): Violation[] {
  const violations: Violation[] = [];
  for (let i = 0; i < run.turns.length; i++) {
    const t = run.turns[i];
    if (!hasSleepTag(t.assistantText)) continue;
    const sayContent = extractSayContent(t.assistantText).trim();
    if (sayContent) {
      violations.push({
        assertKind: 'sleepNeverWithSay',
        severity: 'error',
        evidenceTurnIdx: i,
        claim: `Turn ${i} emitted <sleep> AND a non-empty <say> ('${sayContent.slice(0, 60)}…'). <sleep> is silent acknowledgement — going quiet IS the response.`,
        suggestion: 'Remove the <say> when emitting <sleep>.',
      });
    }
  }
  return violations;
}

// =============================================================================
// 3. ≤1 question mark per turn (adversarial: ignore ? inside JSON tool args,
//    inside ` backtick code blocks, and URL-encoded %3F)
// =============================================================================

function countMeaningfulQuestionMarks(text: string): number {
  // Drop backtick-quoted code blocks.
  let stripped = text.replace(/```[\s\S]*?```/g, '');
  stripped = stripped.replace(/`[^`]*`/g, '');
  // Drop JSON object/string literals (best-effort: any "...?..." inside quotes).
  stripped = stripped.replace(/"[^"\n]*"/g, (m) => m.replace(/\?/g, ''));
  // Drop URL-encoded ?: %3F (case-insensitive).
  stripped = stripped.replace(/%3F/gi, '');
  return (stripped.match(/\?/g) ?? []).length;
}

export function oneQuestionMarkPerTurn(run: RunSummary): Violation[] {
  const violations: Violation[] = [];
  for (let i = 0; i < run.turns.length; i++) {
    const sayContent = extractSayContent(run.turns[i].assistantText);
    const count = countMeaningfulQuestionMarks(sayContent);
    if (count > 1) {
      violations.push({
        assertKind: 'oneQuestionMarkPerTurn',
        severity: 'error',
        evidenceTurnIdx: i,
        claim: `Turn ${i} stacked ${count} questions. Per operator prompt: 'Do not stack multiple questions in one turn.'`,
        suggestion: 'Ask one thing per turn; defer the others.',
      });
    }
  }
  return violations;
}

// =============================================================================
// 4. <spawn role="worker"/> always has chunk=
// =============================================================================

export function spawnWorkerHasChunk(run: RunSummary): Violation[] {
  const violations: Violation[] = [];
  const SPAWN_RE = /<spawn\s+([^/>]*?)\/?>/gi;
  for (let i = 0; i < run.turns.length; i++) {
    const text = run.turns[i].assistantText;
    for (const m of text.matchAll(SPAWN_RE)) {
      const attrs = m[1];
      const isWorker = /role\s*=\s*"worker"/i.test(attrs);
      const hasChunk = /chunk\s*=\s*"/i.test(attrs);
      if (isWorker && !hasChunk) {
        violations.push({
          assertKind: 'spawnWorkerHasChunk',
          severity: 'error',
          evidenceTurnIdx: i,
          claim: `Turn ${i} spawned a worker without chunk= attribute. Orchestrator rejects worker without chunk; prompt requires scoper-first.`,
          suggestion: 'Either include chunk= in the worker spawn, or spawn a scoper first.',
        });
      }
    }
  }
  return violations;
}

// =============================================================================
// 5. <continue/> and chat:ask_choice never in same turn
// =============================================================================

export function noContinueWithAskChoice(run: RunSummary): Violation[] {
  const violations: Violation[] = [];
  for (let i = 0; i < run.turns.length; i++) {
    const t = run.turns[i];
    const hasContinue = hasContinueTag(t.assistantText);
    const hasAskChoice = t.toolCalls.some((tc) => tc.name === 'chat:ask_choice');
    if (hasContinue && hasAskChoice) {
      violations.push({
        assertKind: 'noContinueWithAskChoice',
        severity: 'error',
        evidenceTurnIdx: i,
        claim: `Turn ${i} emitted BOTH <continue/> AND chat:ask_choice. After ask_choice the turn must end — buttons ARE the prompt.`,
        suggestion: 'Pick one: either ask via card (turn ends) or continue narrating (no card).',
      });
    }
  }
  return violations;
}

// =============================================================================
// 6. Opener never literally "what can I help with"
// =============================================================================

const WHAT_CAN_I_HELP_RE = /what\s+can\s+i\s+help/i;

export function noBareWhatCanIHelp(run: RunSummary): Violation[] {
  const violations: Violation[] = [];
  // Check turn 0 specifically — the opener.
  const t = run.turns[0];
  if (!t) return violations;
  const say = extractSayContent(t.assistantText);
  if (WHAT_CAN_I_HELP_RE.test(say)) {
    violations.push({
      assertKind: 'noBareWhatCanIHelp',
      severity: 'error',
      evidenceTurnIdx: 0,
      claim: `Opener used the banned phrase 'what can I help…'. Per operator prompt: 'Open with substance — never with "what can I help with".'`,
      suggestion: "Lead with an observed fact + one concrete invitation (e.g. '3 harnesses active — sheets is busiest…').",
    });
  }
  return violations;
}

// =============================================================================
// 7. Each <say> block ≤220 chars — the PRODUCT contract (voice-persona P-002)
// =============================================================================
//
// Measured 3× (sonnet brain, sonnet judge, 2026-06-07): even a hardened
// instruction leaves ~3-5% char overruns (226-231 of 220) — models cannot
// count characters. Per P-002, the deterministic layer is therefore the
// contract: the runtime (`clampSay`, operator-converse-tags.ts) trims an
// over-cap say at the last complete sentence ≤220, so the USER always hears
// a clean, in-cap utterance. The assert mirrors that contract:
//   - raw ≤220                                    → pass
//   - raw ≤280 AND the runtime clamp lands ≤220   → WARN (behavioral drift
//     tripwire; the spoken text is still correct, only a trailing clause
//     is trimmed)
//   - raw >280, or the clamp can't hold the cap   → ERROR (a list/status
//     dump — the clamp would amputate real content; the original S13
//     failures were 242-549 chars)

const SAY_RAW_TOLERANCE_CHARS = 280;

export function formatLength220(run: RunSummary): Violation[] {
  const violations: Violation[] = [];
  for (let i = 0; i < run.turns.length; i++) {
    const matches = [...run.turns[i].assistantText.matchAll(/<say[^>]*>([\s\S]*?)<\/say>/gi)];
    for (let j = 0; j < matches.length; j++) {
      const content = matches[j][1];
      if (content.length <= 220) continue;
      const spoken = clampSay(content);
      const gracefullyClamped =
        content.length <= SAY_RAW_TOLERANCE_CHARS && spoken.length <= 221; // 220 + ellipsis
      violations.push({
        assertKind: 'formatLength220',
        severity: gracefullyClamped ? 'warn' : 'error',
        evidenceTurnIdx: i,
        claim: gracefullyClamped
          ? `Turn ${i} <say> #${j} is ${content.length} chars raw (target: 220). The runtime clamp trims it to a clean ${spoken.length}-char spoken utterance, so the user hears an in-cap turn — but the persona should land under 220 unaided.`
          : `Turn ${i} <say> #${j} is ${content.length} chars (cap: 220, tolerance: ${SAY_RAW_TOLERANCE_CHARS}). This is a dump — the runtime clamp would amputate real content.`,
        suggestion: 'Tighten to a single concrete observation + one invitation.',
      });
    }
  }
  return violations;
}

// =============================================================================
// 8. No markdown inside <say>
// =============================================================================

// Markdown signals: **bold**, ## heading, - list, ```code```. Avoids false
// positives on apostrophes and URLs.
const MD_BOLD = /\*\*.+?\*\*/;
const MD_HEADING = /^\s*#{1,6}\s+/m;
const MD_LIST = /^\s*[-*]\s+/m;
const MD_CODE_FENCE = /```/;

export function noMarkdownInSay(run: RunSummary): Violation[] {
  const violations: Violation[] = [];
  for (let i = 0; i < run.turns.length; i++) {
    const matches = [...run.turns[i].assistantText.matchAll(/<say[^>]*>([\s\S]*?)<\/say>/gi)];
    for (let j = 0; j < matches.length; j++) {
      const content = matches[j][1];
      const hit = MD_BOLD.test(content)
        || MD_HEADING.test(content)
        || MD_LIST.test(content)
        || MD_CODE_FENCE.test(content);
      if (hit) {
        violations.push({
          assertKind: 'noMarkdownInSay',
          severity: 'error',
          evidenceTurnIdx: i,
          claim: `Turn ${i} <say> contains markdown formatting. <say> output is TTS-safe — no **bold**, no headings, no lists, no code fences.`,
          suggestion: 'Speak in plain prose; cards exist for structured options.',
        });
      }
    }
  }
  return violations;
}

// =============================================================================
// 9. After user_says_ready (terminal/open canvas turn), 2–3 options surface
// =============================================================================

/**
 * Count discrete options the brain offered on the LAST turn:
 *   - If a chat:ask_choice card was emitted: count its options.
 *   - Else: heuristic — count "1." / "2." / "- " / bullet-style lines in <say>.
 */
function countOptionsInLastTurn(turn: TurnResult): number {
  // Cards first.
  const card = turn.cards.find((c) => c.kind === 'chat:ask_choice' || c.kind === 'ask_choice');
  if (card?.options) return card.options.length;
  // Fallback to prose heuristic.
  const say = extractSayContent(turn.assistantText);
  const lines = say.split(/\n/).filter((l) => /^\s*([-*]|\d+[.)])\s+/.test(l));
  return lines.length;
}

export function optionsCountWithinBounds(min: number, max: number) {
  return (run: RunSummary): Violation[] => {
    const last = run.turns[run.turns.length - 1];
    if (!last) {
      return [{
        assertKind: 'optionsCountWithinBounds',
        severity: 'error',
        claim: 'No turns to evaluate options on.',
      }];
    }
    const n = countOptionsInLastTurn(last);
    if (n < min || n > max) {
      return [{
        assertKind: 'optionsCountWithinBounds',
        severity: 'error',
        evidenceTurnIdx: run.turns.length - 1,
        claim: `Last turn surfaced ${n} options (allowed: ${min}..${max}). After user_says_ready the brain should propose 2-3 concrete next steps.`,
        suggestion: 'Either emit a chat:ask_choice card with 2-3 options OR a short prose list of that size.',
      }];
    }
    return [];
  };
}

// =============================================================================
// 10. No internal jargon / raw IDs spoken aloud in <say> (VOICE rule 5)
// =============================================================================
//
// The voice persona (operator-converse-prompt.ts modality block, rule 5) bans
// "internal jargon or raw IDs read aloud" — a non-engineer listener should
// parse every <say>. The judge scores this under `speakability`, but that axis
// is high-variance; this deterministic assert makes the failure reliable.
// NOTE: "harness", "feature", "escalation", "review" are OPERATOR vocabulary
// (its own opener examples say "3 harnesses active") — NOT jargon. Keep the
// lexicon to terms a layperson genuinely wouldn't parse.

/** Feature/ticket IDs spoken aloud: F-001, F-FMT-002, F-FIX-123. */
const FEATURE_ID_RE = /\bF-(?:[A-Z]+-)*\d+\b/;

/**
 * Namespaced tool refs spoken aloud: `harness_status`, `chat:ask_choice`,
 * `orchestrator_spawn`. The separator (`_`/`:`) must be immediately followed
 * by a verb char, so normal "the plan: ship it" (space after the colon) does
 * NOT match — only the no-space tool-name form does.
 */
const TOOL_NAME_RE =
  /\b(?:harness|issues|plans|chat|messages|search|memory|ui|tasks|goals|audit|orchestrator|features|docs|coord|locks)[_:][a-z_]+\b/i;

/** Inline backtick-quoted symbol/code — not speakable. */
const INLINE_BACKTICK_RE = /`[^`]+`/;

/**
 * Curated impl-jargon lexicon: terms a non-engineer listener wouldn't parse.
 * Exported so scenarios/tests can reason about coverage. Deliberately small —
 * a false positive that fires on legitimate speech is worse than a miss.
 */
export const VOICE_JARGON_LEXICON: readonly string[] = [
  'chunk',
  'chunks',
  'dash-delimited',
  'ToolSearch',
  'MCP',
];

const JARGON_WORD_RE = new RegExp(
  `\\b(?:${VOICE_JARGON_LEXICON.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
  'i',
);

export function noJargonInSay(run: RunSummary): Violation[] {
  const violations: Violation[] = [];
  for (let i = 0; i < run.turns.length; i++) {
    const matches = [...run.turns[i].assistantText.matchAll(/<say[^>]*>([\s\S]*?)<\/say>/gi)];
    for (let j = 0; j < matches.length; j++) {
      const content = matches[j][1];
      let hit: string | null = null;
      if (FEATURE_ID_RE.test(content)) hit = 'a raw feature ID';
      else if (TOOL_NAME_RE.test(content)) hit = 'a tool name';
      else if (INLINE_BACKTICK_RE.test(content)) hit = 'a backtick-quoted symbol';
      else if (JARGON_WORD_RE.test(content)) hit = 'internal jargon';
      if (hit) {
        violations.push({
          assertKind: 'noJargonInSay',
          severity: 'error',
          evidenceTurnIdx: i,
          claim: `Turn ${i} <say> #${j} reads ${hit} aloud: '${content.slice(0, 80)}…'. Voice <say> must use plain language a non-engineer listener understands — no raw IDs, tool names, code, or jargon.`,
          suggestion: "Say what it means in plain words (e.g. 'the formatting fix', 'the items waiting on you').",
        });
      }
    }
  }
  return violations;
}

// =============================================================================
// 11. Grounded — no count/state claim before any tool result exists (VOICE rule 4)
// =============================================================================
//
// Rule 4: "never state a count or status before the tool result that supports
// it has come back". The dominant failure (S13 run1) was Turn 0 asserting
// "5 harnesses all in progress" with ZERO tool calls. This assert flags a
// count/state claim made while no tool has been called this run (this turn or
// any earlier). It gives the benefit of the doubt to any turn that DID call a
// tool — so it's strict (low false-positive) and nails the no-tool hallucination.

/** A count of domain things: "3 harnesses", "five features". */
const COUNT_CLAIM_RE =
  /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:harness|feature|issue|escalation|review|plan|task|chunk)\w*/i;

/** A blanket state claim over a set: "all X are passing / blocked / in progress". */
const STATE_CLAIM_RE = /\ball\b[\s\S]{0,40}?\b(?:are|in progress|blocked|failing|passing|ready|done)\b/i;

export function groundedCountBeforeTool(run: RunSummary): Violation[] {
  const violations: Violation[] = [];
  let toolsSoFar = 0;
  for (let i = 0; i < run.turns.length; i++) {
    toolsSoFar += run.turns[i].toolCalls.length;
    const say = extractSayContent(run.turns[i].assistantText);
    const makesClaim = COUNT_CLAIM_RE.test(say) || STATE_CLAIM_RE.test(say);
    if (makesClaim && toolsSoFar === 0) {
      violations.push({
        assertKind: 'groundedCountBeforeTool',
        severity: 'error',
        evidenceTurnIdx: i,
        claim: `Turn ${i} states a count/status ('${say.slice(0, 80)}…') but no tool has been called this run — the claim is ungrounded.`,
        suggestion: 'Call the tool (harness_status / issues_list / …) FIRST, then speak the result. Never invent a number and silently correct it next turn.',
      });
    }
  }
  return violations;
}

// =============================================================================
// 12. No stray built-in tool calls (voice-persona P-008)
// =============================================================================
//
// The converse spawn DENIES every Claude Code built-in (`disallowBuiltins` →
// `--disallowed-tools`, converse.ts) — the brain reaches its world exclusively
// through agentmcp tools and the control tags. The historical failure was the
// brain emitting `Bash({command:'echo …'})` as a no-op "comment" plus
// ToolSearch-flailing over deferred names. converse.ts strips the
// `mcp__agentmcp__` prefix off LEGIT catalog calls before re-emitting them, so
// any observed bare built-in name in the tool-call stream IS a stray — either
// the deny-list regressed or the persona reached for a tool it must not have.

const STRAY_BUILTIN_NAMES: ReadonlySet<string> = new Set([
  ...CLAUDE_BUILTIN_TOOLS,
  // Deliberately NOT in CLAUDE_BUILTIN_TOOLS (workers need them), but the
  // operator brain runs `disableToolSearch` on a non-deferred surface — any
  // of these on a chat turn is the flailing loop coming back.
  'ToolSearch',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
]);

export function noStrayBuiltinCalls(run: RunSummary): Violation[] {
  const violations: Violation[] = [];
  for (let i = 0; i < run.turns.length; i++) {
    for (const tc of run.turns[i].toolCalls) {
      if (STRAY_BUILTIN_NAMES.has(tc.name)) {
        violations.push({
          assertKind: 'noStrayBuiltinCalls',
          severity: 'error',
          evidenceTurnIdx: i,
          claim: `Turn ${i} called built-in tool '${tc.name}'. The operator brain has NO built-ins (disallowBuiltins) — it acts only through its agentmcp catalog and control tags.`,
          suggestion: "If the deny-list regressed, restore disallowBuiltins on the converse spawn; if the persona reached for it, strengthen the 'Calling tools' rules.",
        });
      }
    }
  }
  return violations;
}

// =============================================================================
// 12b. Exactly one <say> per voice turn (voice rule 1)
// =============================================================================
//
// The runtime speaks only the FIRST <say> in a turn (SAY_RE is non-global in
// operator-converse-tags.ts) — any further <say> is silently dropped, so a
// model that emits two (observed live: near-duplicate blocks, each ending in
// a question) is wasting the turn and double-counting questions. Voice
// scenarios enforce the de-facto runtime contract deterministically.

export function oneSayPerTurn(run: RunSummary): Violation[] {
  const violations: Violation[] = [];
  for (let i = 0; i < run.turns.length; i++) {
    const n = [...run.turns[i].assistantText.matchAll(/<say[^>]*>/gi)].length;
    if (n > 1) {
      violations.push({
        assertKind: 'oneSayPerTurn',
        severity: 'error',
        evidenceTurnIdx: i,
        claim: `Turn ${i} emitted ${n} <say> blocks. Only the first is spoken — the rest are dead text (and usually duplicate it).`,
        suggestion: 'Emit exactly ONE <say> per turn; put extra facts in a later turn or a card.',
      });
    }
  }
  return violations;
}

// =============================================================================
// 13. Ambiguous instruction must produce a choice card (voice-persona P-003)
// =============================================================================
//
// For scenarios whose PREMISE is an ambiguous instruction over ≥2 candidates
// (S16's "approve the busy one"), the persona's rule 3 REQUIRES one
// chat_ask_choice card — guessing in prose, or asking a bare spoken question
// with no card, are both failures. Deterministic on purpose: the judge's
// cardUsage axis was too high-variance to hold this behavior (the original
// S16 finding). Only wire this into scenarios that guarantee the ambiguity.

export function disambiguationCardRequired(run: RunSummary): Violation[] {
  const sawChoiceCard = run.turns.some((t) =>
    t.cards.some(
      (c) => /ask_choice/i.test(c.kind) || (c.options?.length ?? 0) >= 2,
    ),
  );
  if (sawChoiceCard) return [];
  const violation: Violation = {
    assertKind: 'disambiguationCardRequired',
    severity: 'error',
    claim: 'The ambiguous instruction never produced a chat_ask_choice card — the brain guessed a candidate or disambiguated in prose.',
    suggestion: 'Per voice rule 3: ≥2 plausible targets → emit ONE chat_ask_choice card (voiceAnswerable:true) listing the candidates; never pick one autonomously.',
  };
  if (run.turns.length > 0) violation.evidenceTurnIdx = run.turns.length - 1;
  return [violation];
}

// =============================================================================
// Helper export (used by tests)
// =============================================================================

export const _internals = {
  stripAllTags,
  extractSayContent,
  countMeaningfulQuestionMarks,
  countOptionsInLastTurn,
};
