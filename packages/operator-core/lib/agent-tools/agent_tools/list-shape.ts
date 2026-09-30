/**
 * agent_tools:list payload-tier shapers (context-trimming-tiers-2026-07-01
 * P-023). 7d MCP telemetry: avg 108KB/call — the full ~550-tool catalog with
 * descriptions + resolved guidance per row. A trimmed session is discovering
 * a tool NAME (tools:find is the semantic front door) — it needs name /
 * capability / allowed + a description excerpt, not the whole playbook.
 *
 * Contract (D-004): uniform keys per tier, a visible `(truncated)` notice row
 * naming the filter/onlyAllowed/payloadTier escapes; `count` stays the TRUE
 * pre-cap total.
 */

export const AGENT_TOOLS_TIER_CAPS = {
  trimmed: { rows: 150, description: 100, when: 0 },
  standard: { rows: 250, description: 200, when: 150 },
} as const;

type AgentToolsTier = keyof typeof AGENT_TOOLS_TIER_CAPS;

const clip = (s: unknown, n: number): string | null =>
  typeof s === "string" ? (s.length > n ? `${s.slice(0, n - 1)}…` : s) : null;

export function shapeAgentToolsList(data: unknown, tier: AgentToolsTier): unknown {
  const d = data as
    | ({ tools?: unknown[] } & Record<string, unknown>)
    | null
    | undefined;
  if (!d || !Array.isArray(d.tools)) return data;
  const c = AGENT_TOOLS_TIER_CAPS[tier];

  const project = (row: unknown): Record<string, unknown> => {
    const r = (row ?? {}) as Record<string, unknown>;
    const base = {
      name: r.name ?? null,
      capability: r.capability ?? null,
      allowed: r.allowed !== false,
      description: clip(r.description, c.description),
    };
    if (tier === "trimmed") return base;
    return {
      ...base,
      reason: r.reason ?? null,
      composition: r.composition ?? null,
      when: clip((r.guidance as { when?: unknown } | null)?.when, c.when),
    };
  };

  const tools = d.tools.slice(0, c.rows).map(project);
  if (d.tools.length > c.rows) {
    tools.push({
      ...project({}),
      name: "(truncated)",
      description: `showing ${c.rows} of ${d.tools.length} — narrow with filter/onlyAllowed, tools:find for semantic search, or payloadTier:"full" (full guidance)`,
    });
  }
  return { ...d, tools };
}
