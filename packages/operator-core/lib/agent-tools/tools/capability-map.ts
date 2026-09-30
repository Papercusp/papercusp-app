/**
 * capability-map — the compact "menu" for the dynamic tool surface
 * (dynamic-tool-surface-2026-07-01, D-011).
 *
 * A trimmed session sees only the ~20-tool core spine, so this map — injected into the MCP
 * `initialize.instructions` (mcpInstructionsForServer) — is what preserves DISCOVERABILITY:
 * it tells the model WHAT capabilities exist (by category, with a few example tool names) so
 * it knows what to search for, at ~1–2k tokens instead of the ~165k of full descriptions the
 * old full-catalog load paid. The model then calls `tools:find("<intent>")` to surface +
 * activate the specific tool (or `tools:invoke({name,args})` to call it directly). Without the
 * map, a seeded model doesn't know a capability exists → never searches for it; with it, we
 * keep the browse-the-menu affordance for pennies.
 *
 * Built once from the projected-tool registry and cached; rebuilt only on catalog size drift
 * (a plugin (un)registering tools). Pure + side-effect-free.
 */
import { listAllProjectedTools } from '@papercusp/agent-mcp';
import { categoryOf } from '../../cupboard/tools-search';

/** Example tool names shown per category before eliding into "…(+N)". */
const PER_CATEGORY = 6;

let _cached: string | null = null;
let _cachedSize = -1;

/** Group the exposed MCP tools by their category (namespace prefix). Exported for tests. */
export function groupToolsByCategory(): Map<string, string[]> {
  const byCat = new Map<string, string[]>();
  for (const t of listAllProjectedTools()) {
    const name = t.expose?.mcp?.name;
    if (!name) continue;
    const cat = categoryOf(name);
    const arr = byCat.get(cat);
    if (arr) arr.push(name);
    else byCat.set(cat, [name]);
  }
  return byCat;
}

/**
 * Render the compact capability map (directive + category menu). Cached across calls; the
 * cache invalidates when the exposed-tool count changes.
 */
export function capabilityMapText(): string {
  const byCat = groupToolsByCategory();
  const total = [...byCat.values()].reduce((n, a) => n + a.length, 0);
  if (_cached !== null && _cachedSize === total) return _cached;

  const rows: string[] = [];
  for (const cat of [...byCat.keys()].sort()) {
    const names = byCat.get(cat)!.slice().sort();
    const shown = names.slice(0, PER_CATEGORY);
    const more = names.length - shown.length;
    rows.push(`- **${cat}** (${names.length}): ${shown.join(', ')}${more > 0 ? ` …(+${more})` : ''}`);
  }

  _cached = [
    `## Your tool surface is DYNAMIC — the whole ${total}-tool catalog is reachable on demand`,
    ``,
    `Your loaded tool list is usually a small CORE set (the default). Any tool NOT in it is still`,
    `reachable — you do not need everything loaded up front:`,
    `- **\`tools:find("<what you want to do>")\`** — intent search; matched tools are activated so you can call them directly next.`,
    `- **\`tools:invoke({ name, args })\`** — call ANY tool by exact name without loading it (the universal fallback).`,
    `When you need a capability that isn't in your loaded set, SEARCH for it — don't assume it doesn't exist.`,
    `⚠ Your CLIENT's own tool search (Claude Code ToolSearch, OMP search_tool_bm25) indexes ONLY this`,
    `advertised subset — a zero-hit search THERE does NOT mean the tool doesn't exist (EI-9011: agents`,
    `hit this and degraded to polling). Any tool name you read in an error message, hook text, doc, or`,
    `peer message is callable RIGHT NOW via \`tools:invoke { name, args }\`, and \`tools:find\` searches the`,
    `FULL server-side catalog regardless of what your client advertises.`,
    `If a found tool still errors "not found" when called directly, run it via \`tools:invoke\` — never guess alternative names.`,
    ``,
    `Capability map — the categories that exist (use \`tools:find\` within any):`,
    ...rows,
  ].join('\n');
  _cachedSize = total;
  return _cached;
}
