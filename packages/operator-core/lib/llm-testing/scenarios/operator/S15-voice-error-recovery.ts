/**
 * S15 — graceful voice recovery on a tool/lookup failure
 *
 * When a voice turn hits a tool error, the brain must STILL wrap a non-empty
 * <say> around its spoken content — never let a raw error or bare control tags
 * (<set_mode>/<spawn>) get read aloud by TTS. This is the exact regression the
 * elevenlabs-conv ask_operator path warns about ("voice turn returned without
 * <say> tag; the raw body will be spoken"), checked at the brain level.
 *
 * P-019 of plan voice-production-test-coverage-2026-06-01.
 */
import { VOICE_USER } from '@papercusp/testing-shell/llm';
import { OPERATOR_RUBRIC } from '../../rubrics/operator';
import { noMarkdownInSay, groundedCountBeforeTool, noStrayBuiltinCalls, oneSayPerTurn } from '../../asserts/operator-format';
import type { Scenario, RunSummary, Violation } from '@papercusp/testing-shell/llm';

function extractSay(text: string): string {
  return [...text.matchAll(/<say[^>]*>([\s\S]*?)<\/say>/gi)].map((m) => m[1]).join(' ').trim();
}

/** Every spoken turn (non-empty output that isn't a silent <sleep>) must wrap
 *  its content in a non-empty <say> so TTS never reads raw text/tags. */
const everyVoiceTurnHasSay = (run: RunSummary): Violation[] => {
  const out: Violation[] = [];
  for (let i = 0; i < run.turns.length; i++) {
    const t = run.turns[i];
    if (!t.assistantText.trim()) continue; // produced nothing this turn
    if (/<sleep(\s[^>]*)?\/?>/i.test(t.assistantText)) continue; // sleep is silent
    if (!extractSay(t.assistantText)) {
      out.push({
        assertKind: 'everyVoiceTurnHasSay',
        severity: 'error',
        evidenceTurnIdx: i,
        claim: `Turn ${i} produced spoken output with no <say> wrapper — the raw body (incl. any tags or error text) would be read aloud by TTS.`,
        suggestion: 'Wrap every voice turn’s spoken content in <say>…</say>, even when a tool failed.',
      });
    }
  }
  return out;
};

export const S15_VOICE_ERROR_RECOVERY: Scenario = {
  id: 'op-S15-voice-error-recovery',
  version: 1,
  target: 'operator',
  description:
    'A voice-mode user asks the operator to act on something that does not exist ("open the harness called zzz-nope-404"), forcing a tool/lookup failure. The operator must recover gracefully in speech: a non-empty <say> on every spoken turn (never a raw error or bare control tag read aloud), and no markdown.',
  persona: VOICE_USER,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 4, maxWallSecs: 90, maxCostUsd: 0.8 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  asserts: [
    { kind: 'custom', name: 'everyVoiceTurnHasSay', eval: everyVoiceTurnHasSay },
    { kind: 'custom', name: 'noMarkdownInSay', eval: noMarkdownInSay },
    { kind: 'custom', name: 'groundedCountBeforeTool', eval: groundedCountBeforeTool },
    { kind: 'custom', name: 'noStrayBuiltinCalls', eval: noStrayBuiltinCalls },
    { kind: 'custom', name: 'oneSayPerTurn', eval: oneSayPerTurn },
  ],
  rubric: OPERATOR_RUBRIC,
};

export default S15_VOICE_ERROR_RECOVERY;
