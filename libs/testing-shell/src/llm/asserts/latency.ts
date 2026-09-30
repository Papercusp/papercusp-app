import { registerEvaluator } from './index';
import type { Violation } from '../types';

registerEvaluator('latency_under', (a, run) => {
  const v: Violation[] = [];
  const latencies = run.turns.map((t) => t.latencyMs).sort((x, y) => x - y);
  if (latencies.length === 0) return v;
  if (a.p50 !== undefined) {
    const p50 = latencies[Math.floor(latencies.length * 0.5)];
    if (p50 > a.p50) {
      v.push({
        assertKind: 'latency_under',
        severity: 'warn',
        claim: `p50 latency ${p50}ms exceeded budget ${a.p50}ms`,
      });
    }
  }
  if (a.p95 !== undefined) {
    const p95 = latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))];
    if (p95 > a.p95) {
      v.push({
        assertKind: 'latency_under',
        severity: 'warn',
        claim: `p95 latency ${p95}ms exceeded budget ${a.p95}ms`,
      });
    }
  }
  return v;
});

registerEvaluator('cost_under', (a, run) => {
  if (run.totalCostUsd > a.usd) {
    return [{
      assertKind: 'cost_under',
      severity: 'warn',
      claim: `Total cost $${run.totalCostUsd.toFixed(4)} exceeded budget $${a.usd}`,
    }];
  }
  return [];
});

registerEvaluator('finish_reason_is', (a, run) => {
  const last = run.turns[run.turns.length - 1];
  if (!last) {
    return [{ assertKind: 'finish_reason_is', severity: 'error', claim: 'No turns to check finishReason on' }];
  }
  if (last.finishReason !== a.expected) {
    return [{
      assertKind: 'finish_reason_is',
      severity: 'error',
      claim: `Expected finishReason='${a.expected}', got '${last.finishReason}'`,
    }];
  }
  return [];
});

registerEvaluator('custom', (a, run) => {
  return a.eval(run);
});

// Memory + spawn asserts — read from PG-side tool_invocations.
//
// Tool-name matching covers BOTH the historical mem0-prefixed names and the
// live neutral-seam names the operator actually exposes today
// (`memory:remember` / `memory:search` / `memory:list` / `memory:forget` /
// `memory:update`), in every transport spelling: plain (`memory:search`),
// underscore (`memory_search`), dotted alias (`memory.search`), and the
// MCP-prefixed form (`mcp__agentmcp__memory:search`). The original
// `/mem0[:_]…/` patterns predated the tool naming and could never match a
// real invocation (memory-backend-benchmark P-009).
const MEMORY_WRITE_TOOL_RE = /(^|:|__|\.)mem(?:0|ory)[:_.](write|add|remember|update)/i;
const MEMORY_READ_TOOL_RE = /(^|:|__|\.)mem(?:0|ory)[:_.](recall|read|search|list|get)/i;

registerEvaluator('mem0_wrote', (a, run) => {
  const writes = run.toolInvocations.filter((t) => MEMORY_WRITE_TOOL_RE.test(t.toolName));
  if (writes.length === 0) {
    return [{
      assertKind: 'mem0_wrote',
      severity: 'error',
      claim: 'Expected a mem0 write call this run — none seen in tool_invocations.',
    }];
  }
  if (a.matching) {
    const have = new Set<string>();
    for (const w of writes) {
      const md = w.metadataJson as Record<string, unknown> | undefined;
      const kind = typeof md?.memoryKind === 'string' ? (md.memoryKind as string) : null;
      if (kind) have.add(kind);
    }
    const missing = Object.entries(a.matching)
      .filter(([, want]) => want)
      .map(([k]) => k)
      .filter((k) => !have.has(k));
    if (missing.length > 0) {
      return [{
        assertKind: 'mem0_wrote',
        severity: 'warn',
        claim: `mem0 writes were missing kinds: ${missing.join(', ')}`,
      }];
    }
  }
  return [];
});

registerEvaluator('mem0_read', (_a, run) => {
  const reads = run.toolInvocations.filter((t) => MEMORY_READ_TOOL_RE.test(t.toolName));
  if (reads.length === 0) {
    return [{
      assertKind: 'mem0_read',
      severity: 'error',
      claim: 'Expected a mem0 read/recall call this run — none seen in tool_invocations.',
    }];
  }
  return [];
});

registerEvaluator('spawn_dispatched', (a, run) => {
  const spawns = run.toolInvocations.filter((t) => /(^|:|__)harness[:_]spawn$|spawn_dispatch$/i.test(t.toolName));
  if (spawns.length === 0) {
    return [{
      assertKind: 'spawn_dispatched',
      severity: 'error',
      claim: `Expected a spawn dispatch with role='${a.role}' — no harness:spawn invocations found.`,
    }];
  }
  // Role/feature predicate matching depends on args being persisted, which
  // tool_invocations doesn't track. When metadata_json carries them, refine.
  return [];
});
