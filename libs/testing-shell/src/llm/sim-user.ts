/**
 * Sim-user — the LLM that drives the conversation as a user persona.
 *
 * Each turn, the sim-user reads the assistant's last message + visible
 * cards + its own goal, and emits a structured action: text reply,
 * choice pick, give up, or declare success. Strict JSON output, one
 * retry on schema fail.
 *
 * Plan §3.5.
 *
 * Decoupled: the concrete LLM transport is injected via the constructor
 * `llmCall` opt (an `LlmCallFn`) rather than imported.
 */

import { composePersonaPrompt } from './personas/traits';
import type { LlmCallFn } from './deps';
import type { CardEvent, GoalSpec, Persona, Scenario, TurnResult } from './types';

/**
 * Resolve what the SIM-USER is told about the scenario — the one place that
 * decides it, so the judge channel and the sim-user channel cannot silently
 * become the same string again.
 *
 * `description` is judge-facing AND sim-user-facing, and the sim-user is told
 * to name concrete details from it, so a fact written there is volunteered to
 * the system under test. `simUserContext` is how an author opts out of that:
 * a string overrides what the sim-user sees, `false` gives it no scenario
 * context at all. Omitted keeps the historical default.
 *
 * Returning `undefined` suppresses the `## Scenario context` block entirely.
 *
 * EI-18767396817867279.
 */
export function resolveSimUserContext(
  scenario: Pick<Scenario, 'description' | 'simUserContext'>,
): string | undefined {
  if (scenario.simUserContext === false) return undefined;
  return scenario.simUserContext ?? scenario.description;
}

export type SimAction =
  | { kind: 'text'; thought: string; text: string }
  | { kind: 'choice'; thought: string; cardId: string; optionId: string; freeText?: string }
  | { kind: 'give_up'; thought: string; reason: string }
  | { kind: 'declare_success'; thought: string; reason: string };

export type SimHistoryEntry =
  | { who: 'sim'; action: SimAction }
  | { who: 'sut'; turn: TurnResult };

/** The user-side evidence that belongs beside one SUT turn. */
export interface SimTurnContext {
  userText: string;
  simThought: string;
  simKind: 'text' | 'choice';
}

/**
 * Convert an action that actually produces a SUT turn into the exact
 * user-facing text sent on the wire. Terminal sim actions do not have a
 * corresponding SUT turn, so they intentionally return no context.
 */
export function simActionToTurnContext(action: SimAction): SimTurnContext | undefined {
  switch (action.kind) {
    case 'text':
      return { userText: action.text, simThought: action.thought, simKind: action.kind };
    case 'choice':
      return {
        userText: `[card ${action.cardId} → ${action.optionId}]${action.freeText ? `: ${action.freeText}` : ''}`,
        simThought: action.thought,
        simKind: action.kind,
      };
    case 'give_up':
    case 'declare_success':
      return undefined;
  }
}

export interface SimUserOpts {
  persona: Persona;
  goal: GoalSpec;
  model: string;
  temperature?: number;
  /** Injected LLM transport — the sim-user calls this for every action. */
  llmCall: LlmCallFn;
  /**
   * Scenario description — concrete, user-facing context for what the
   * persona is trying to accomplish. Plan §3.5 had this as "elsewhere"
   * but the runner never threaded it; sim-users wander without it.
   */
  scenarioDescription?: string;
}

export interface SimNextInput {
  /** Past turns (sim-user actions + SUT replies), oldest first. */
  history: SimHistoryEntry[];
  /** Current visible cards (subset of the last SUT turn's cards that haven't been answered). */
  cards: CardEvent[];
  /** Turn budget — sim is told how many turns remain so it tightens up near the cap. */
  turnsRemaining: number;
}

export class SimUser {
  private readonly opts: SimUserOpts;
  private readonly systemPrompt: string;
  private readonly llmCall: LlmCallFn;
  private totalCostUsd = 0;

  constructor(opts: SimUserOpts) {
    this.opts = opts;
    this.llmCall = opts.llmCall;
    this.systemPrompt = buildSystemPrompt(opts.persona, opts.goal, opts.scenarioDescription);
  }

  get costUsd(): number {
    return this.totalCostUsd;
  }

  async nextAction(input: SimNextInput): Promise<SimAction> {
    const userPrompt = buildUserPrompt(input);
    const result = await this.llmCall({
      model: this.opts.model,
      system: this.systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      maxTokens: 512,
      temperature: this.opts.temperature ?? 0.3,
      responseFormat: 'json',
    });
    this.totalCostUsd += result.costUsd;

    let action = parseAction(result.json);
    if (process.env.LLM_TEST_DEBUG_SIM) {
      console.error('[sim-debug] raw text:', JSON.stringify(result.text).slice(0, 800));
      console.error('[sim-debug] parsed json:', JSON.stringify(result.json).slice(0, 400));
      console.error('[sim-debug] action:', JSON.stringify(action));
    }
    if (!action) {
      // One retry with a stricter nudge.
      const retry = await this.llmCall({
        model: this.opts.model,
        system: this.systemPrompt,
        messages: [
          { role: 'user', content: userPrompt },
          { role: 'assistant', content: result.text },
          {
            role: 'user',
            content:
              'Your previous response was not valid JSON matching the schema. Return ONLY a JSON object with `thought` and `action` fields. No prose, no markdown fences.',
          },
        ],
        maxTokens: 512,
        temperature: 0,
        responseFormat: 'json',
      });
      this.totalCostUsd += retry.costUsd;
      action = parseAction(retry.json);
    }

    if (!action) {
      // Hard fail — return give_up so the runner records it cleanly.
      return {
        kind: 'give_up',
        thought: 'sim-user JSON parse failed twice',
        reason: 'sim-user emitted invalid JSON after retry; aborting',
      };
    }
    return action;
  }
}

function buildSystemPrompt(persona: Persona, goal: GoalSpec, scenarioDescription?: string): string {
  const personaBlock = composePersonaPrompt(persona.traits);
  const goalBlock = describeGoal(goal);
  const sceneBlock = scenarioDescription
    ? `## Scenario context\n${scenarioDescription}\n\nYou are the user in the scenario described above. Drive the conversation toward what THAT user wants. Be specific about concrete things named in the scenario (harness slugs, file paths, feature ids) — a real user would name them, not gesture.`
    : '';
  const parts: string[] = [personaBlock, ''];
  if (sceneBlock) parts.push(sceneBlock, '');
  return [
    ...parts,
    '## Your goal',
    goalBlock,
    '',
    '## Output schema',
    'You MUST return JSON in this exact shape (no prose, no fences):',
    '```',
    '{',
    '  "thought": "private reasoning (the assistant will not see this)",',
    '  "action": {',
    '    "kind": "text" | "choice" | "give_up" | "declare_success",',
    '    "text"?: "string — required when kind=text",',
    '    "cardId"?: "string — required when kind=choice",',
    '    "optionId"?: "string — required when kind=choice",',
    '    "freeText"?: "string — optional, only when kind=choice and a card asks for free-form",',
    '    "reason"?: "string — required when kind=give_up or declare_success"',
    '  }',
    '}',
    '```',
    '',
    '## Rules',
    '- Declare success ONLY when the goal is unambiguously satisfied.',
    '- Give up when the assistant repeatedly refuses, loops, or asks for things you cannot provide.',
    '- Never instruct the assistant about its own internals — speak as a real user would.',
    '- Stay in character. Match your persona traits exactly.',
  ].join('\n');
}

function describeGoal(goal: GoalSpec): string {
  switch (goal.kind) {
    case 'user_satisfied':
      return 'Engage in conversation until you, the user, judge that your need has been satisfied. The scenario description elsewhere tells you what that need is.';
    case 'tool_fired':
      return `Push the assistant toward calling the \`${goal.toolName}\` tool. You do NOT mention the tool by name — you describe the user-facing request that would lead to it.`;
    case 'card_emitted':
      return `Push the assistant toward emitting a \`${goal.cardKind}\` card.`;
    case 'state_reached':
      return `Push the conversation toward a state matching: ${goal.predicate}`;
  }
}

function buildUserPrompt(input: SimNextInput): string {
  const parts: string[] = [];

  parts.push(`## Conversation so far\n`);
  if (input.history.length === 0) {
    parts.push('(empty — this is your first message)');
  } else {
    for (const entry of input.history) {
      if (entry.who === 'sim') {
        parts.push(`**You said:** ${actionToText(entry.action)}`);
      } else {
        parts.push(`**Assistant:** ${entry.turn.assistantText.trim() || '(empty turn)'}`);
        if (entry.turn.cards.length > 0) {
          parts.push(`  (assistant also showed cards: ${entry.turn.cards.map((c) => c.kind).join(', ')})`);
        }
      }
    }
  }

  if (input.cards.length > 0) {
    parts.push('\n## Cards visible to you right now');
    for (const c of input.cards) {
      parts.push(`- **${c.kind}**${c.voiceAnswerable ? ' (voiceAnswerable)' : ''}`);
      if (c.options) {
        for (const o of c.options) parts.push(`    - ${o.id}: ${o.label}`);
      }
    }
  }

  parts.push(`\n## Turns remaining: ${input.turnsRemaining}`);
  parts.push('\nWhat do you do next? Return JSON per the schema.');

  return parts.join('\n');
}

function actionToText(a: SimAction): string {
  switch (a.kind) {
    case 'text': return a.text;
    case 'choice': return `(picked option \`${a.optionId}\` on card \`${a.cardId}\`)${a.freeText ? `: ${a.freeText}` : ''}`;
    case 'give_up': return `(gave up — ${a.reason})`;
    case 'declare_success': return `(declared success — ${a.reason})`;
  }
}

function parseAction(raw: unknown): SimAction | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const thought = typeof obj.thought === 'string' ? obj.thought : '';
  const action = obj.action;
  if (!action || typeof action !== 'object') return null;
  const a = action as Record<string, unknown>;
  const kind = a.kind;
  switch (kind) {
    case 'text':
      if (typeof a.text !== 'string' || !a.text.trim()) return null;
      return { kind: 'text', thought, text: a.text };
    case 'choice':
      if (typeof a.cardId !== 'string' || typeof a.optionId !== 'string') return null;
      return {
        kind: 'choice', thought,
        cardId: a.cardId, optionId: a.optionId,
        freeText: typeof a.freeText === 'string' ? a.freeText : undefined,
      };
    case 'give_up':
      return { kind: 'give_up', thought, reason: typeof a.reason === 'string' ? a.reason : 'no reason given' };
    case 'declare_success':
      return { kind: 'declare_success', thought, reason: typeof a.reason === 'string' ? a.reason : 'no reason given' };
    default:
      return null;
  }
}
