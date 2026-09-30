/**
 * gen-doc-tool-catalog.ts — project a COARSE, grouped tool catalog into a Starlight
 * reference page (starlight-projection-generators-2026-06-05 P-004).
 *
 * Source of truth: the live `defineTool` registry (`listAllProjectedTools()`), the
 * same surface `gen-tool-catalog.ts` projects to JSON and `agent_tools:list` serves
 * to agents. Here we emit a HUMAN page — but deliberately COARSE: group → verb count
 * → verb names + capability tags, NOT the 297KB full-schema dump. Coarse grouping
 * keeps churn low (changes only on a verb add/remove/rename, not a guidance tweak),
 * but the full-registry import is heavy + fleet-fragile, so the `:check` is ADVISORY
 * (docs-and-memory D-009 / this plan's D-002). For full schemas an agent uses
 * `agent_tools:list` / `tools/list` at runtime.
 *
 *   npx tsx scripts/gen-doc-tool-catalog.ts          # write
 *   npx tsx scripts/gen-doc-tool-catalog.ts --check  # warn (advisory) if drifted
 */
import '@papercusp/operator-core/lib/agent-tools/index.ts';
import { listAllProjectedTools } from '@papercusp/agent-mcp';
import { emitOrCheck, generatedBanner, frontmatter, cell } from './lib/doc-projection';

interface GroupInfo {
  verbs: string[];
  capabilities: Set<string>;
}

function build(): string {
  const tools = listAllProjectedTools();

  const groups = new Map<string, GroupInfo>();
  let httpOnly = 0;
  let total = 0;

  for (const t of tools) {
    const mcpName: string | null = t.expose?.mcp?.name ?? null;
    if (!mcpName) {
      httpOnly += 1;
      continue;
    }
    total += 1;
    const sep = mcpName.indexOf(':');
    const group = sep > 0 ? mcpName.slice(0, sep) : mcpName;
    const verb = sep > 0 ? mcpName.slice(sep + 1) : mcpName;
    const g = groups.get(group) ?? { verbs: [], capabilities: new Set<string>() };
    g.verbs.push(verb);
    for (const c of t.capabilities ?? []) g.capabilities.add(c);
    groups.set(group, g);
  }

  const sortedGroups = [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [, g] of sortedGroups) g.verbs.sort();

  const lines: string[] = [];
  lines.push(
    frontmatter({
      title: 'Tool catalog (grouped)',
      description:
        'A coarse, grouped map of the MCP tool surface — one row per tool group with its verbs + capabilities. Generated from the defineTool registry. Full per-tool schemas: agent_tools:list / tools/list at runtime.',
      sidebarOrder: 4,
    }),
  );
  lines.push('');
  lines.push(generatedBanner('gen:doc-tool-catalog'));
  lines.push('');
  lines.push('# Tool catalog (grouped)');
  lines.push('');
  lines.push(
    'Every MCP tool is authored once via `defineTool` and projected onto HTTP/MCP/IPC. This is a **coarse** map of that surface — grouped by verb prefix, listing each group\'s verbs + capability tags. It is intentionally NOT the full per-tool schema dump (that churns on every guidance tweak across the fleet); for full schemas + guidance an agent calls `agent_tools:list { asRole }` or reads `tools/list` at runtime.',
  );
  lines.push('');
  lines.push(`**${total} MCP tools** across **${sortedGroups.length} groups**${httpOnly > 0 ? ` (+ ${httpOnly} HTTP-only routes with no MCP verb)` : ''}.`);
  lines.push('');

  lines.push('## Groups');
  lines.push('');
  lines.push('| Group | Verbs | Names | Capabilities |');
  lines.push('|---|---|---|---|');
  for (const [group, g] of sortedGroups) {
    const names = g.verbs.map((v) => `\`${cell(v)}\``).join(' ');
    const caps = [...g.capabilities].sort().slice(0, 12).map((c) => `\`${cell(c)}\``).join(' ');
    lines.push(`| \`${cell(group)}\` | ${g.verbs.length} | ${names} | ${caps || '—'} |`);
  }
  lines.push('');

  return lines.join('\n');
}

emitOrCheck('tool-catalog.md', build(), { advisory: true });
// The agent-tools registry import opens keep-alive handles (pools/timers), so the
// process never exits naturally — exit explicitly or every caller (the umbrella,
// CI, a piped shell) hangs until an external timeout kills it.
process.exit(0);
