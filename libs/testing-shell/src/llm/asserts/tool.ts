import { registerEvaluator } from './index';
import type { Violation, RunSummary } from '../types';

/**
 * Count calls of `name` across both SSE-captured tool_calls and the
 * PG telemetry pull. SSE captures only the tools the operator brain
 * directly invoked; PG carries every tool dispatched through the
 * harness (including in-tool nested calls). Union → fewer false
 * negatives.
 *
 * Tool names in tool_invocations are stored without the `mcp__*__` MCP
 * prefix (per plugin_name + tool_name); the SSE tape carries the brain-
 * facing alias. Comparing `endsWith(':' + tail)` is loose but matches
 * the operator's actual naming surface (e.g. `harness:status`,
 * `docs:get`, `issues:list`).
 */
function countCalls(name: string, run: RunSummary, argsMatch?: Record<string, unknown>): { count: number; firstTurn?: number } {
  let count = 0;
  let firstTurn: number | undefined;
  for (let i = 0; i < run.turns.length; i++) {
    for (const tc of run.turns[i].toolCalls) {
      if (matchesName(tc.name, name) && argsMatchHelper(tc.input, argsMatch)) {
        count++;
        if (firstTurn === undefined) firstTurn = i;
      }
    }
  }
  for (const ti of run.toolInvocations) {
    if (matchesName(ti.toolName, name)) count++;
  }
  return { count, firstTurn };
}

function matchesName(actual: string, expected: string): boolean {
  if (actual === expected) return true;
  // Tail-match: 'harness:status' matches 'mcp__harness__status' or '...:status'.
  const tail = expected.includes(':') ? expected.split(':').pop()! : expected;
  return actual.endsWith(`:${tail}`) || actual.endsWith(`__${tail}`);
}

registerEvaluator('tool_called', (a, run) => {
  const { count, firstTurn } = countCalls(a.name, run, a.withArgsMatching);
  const min = a.minTimes ?? 1;
  const max = a.maxTimes ?? Infinity;
  const v: Violation[] = [];
  if (count < min) {
    v.push({
      assertKind: 'tool_called',
      severity: 'error',
      claim: `Expected tool '${a.name}' to be called at least ${min}× — saw ${count}`,
      suggestion: `Verify the SUT prompt routes this kind of request to '${a.name}'.`,
    });
  }
  if (count > max) {
    v.push({
      assertKind: 'tool_called',
      severity: 'warn',
      evidenceTurnIdx: firstTurn,
      claim: `Tool '${a.name}' called ${count}× — cap was ${max}`,
    });
  }
  return v;
});

registerEvaluator('tool_not_called', (a, run) => {
  const { count, firstTurn } = countCalls(a.name, run);
  if (count > 0) {
    return [{
      assertKind: 'tool_not_called',
      severity: 'error',
      evidenceTurnIdx: firstTurn,
      claim: `Tool '${a.name}' was called ${count}× but the scenario forbids it.`,
    }];
  }
  return [];
});

function argsMatchHelper(actual: unknown, expected: Record<string, unknown> | undefined): boolean {
  if (!expected) return true;
  if (typeof actual !== 'object' || actual === null) return false;
  for (const [k, v] of Object.entries(expected)) {
    if ((actual as Record<string, unknown>)[k] !== v) return false;
  }
  return true;
}
