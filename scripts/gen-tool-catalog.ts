/**
 * gen-tool-catalog.ts — regenerate .papercusp/tool-catalog.json from the live
 * `defineTool` registry (the single source of truth for every endpoint/tool).
 *
 * docs-and-memory-as-projections-2026-06-05 D-002/D-004: the "what" (the tool +
 * route surface) is DERIVABLE from code, so we project it instead of hand-writing
 * it. The output doubles as a route-map (each tool's HTTP path + methods) and a tool
 * catalog (name + capability + roles + one-line guidance). The full input
 * JSON-Schemas are intentionally omitted to keep it compact and review-able; the
 * live `agent_tools:list` / `tools/list` surfaces carry the schemas for agents at
 * runtime (the D-004 agent form, already shipped).
 *
 *   Run:  npx tsx scripts/gen-tool-catalog.ts          (write .papercusp/tool-catalog.json)
 *         npx tsx scripts/gen-tool-catalog.ts --check  (fail if the written artifact is stale)
 *
 * ⚠ CORRECTED 2026-08-12 (WI-38239) — this header used to say the artifact was "NOT
 * committed", and a sibling generator's header cited that claim to justify its own
 * stance. MEASURED against the tree, it is FALSE: `.papercusp/tool-catalog.json` IS
 * TRACKED (1.1MB, not gitignored). Reason 2 below described the intent, and the tree
 * went the other way — so a real committed artifact has a real drift invariant here,
 * and `gen:tool-catalog:check` is a genuine wire candidate (it sits in this repo's
 * ACKNOWLEDGED_UNREACHABLE set), NOT the category error its openapi sibling was.
 *
 * CI-gated since WI-38239, with the edit→commit drift window closed by WI-39922:
 * git-sync conditionally runs this writer immediately before its superproject
 * commit whenever a dirty path can affect the catalog. The import cost was measured
 * at ~10s (3/3 completions), with no database or network dependency. Because the
 * shared tree can expose a peer's half-written tool module during that cold import,
 * git-sync bounds the child and treats every throw/nonzero/timeout as fail-soft: it
 * logs and continues the commit, leaving this downstream check as the final detector
 * rather than letting a projection repair wedge all fleet commits.
 *
 * Importing the agent-tools barrel registers every operator-core + agent-mcp tool
 * (side-effect imports); `listAllProjectedTools()` then reads the populated registry.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// Resolve from THIS generator's checkout, never through the nearest ancestor's
// node_modules. Frozen-candidate repair worktrees intentionally have no local
// node_modules; the bare @papercusp/operator-core alias therefore escaped to the
// canonical staging checkout and projected current-tip tools into an older repair
// head. A source-relative import keeps the registry and OUT in the same immutable
// worktree while the remaining shared packages can still resolve through the
// canonical checkout's hoisted node_modules.
import '../packages/operator-core/lib/agent-tools/index.ts';
import { listAllProjectedTools } from '@papercusp/agent-mcp';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(REPO_ROOT, '.papercusp', 'tool-catalog.json');

interface CatalogEntry {
  name: string | null;
  http: { path: string; methods: string[] } | null;
  description: string;
  capabilities: string[];
  agentRoles?: string[];
  profile?: string;
  harness?: string;
  public?: boolean;
  guidance?: { when?: string; notWhen?: string; chaining?: string };
}

function methodsOf(http: { methods?: readonly string[]; method?: string } | undefined): string[] {
  if (!http) return [];
  if (http.methods && http.methods.length > 0) return [...http.methods];
  if (http.method) return [http.method];
  return ['POST']; // the framework default
}

const entries: CatalogEntry[] = listAllProjectedTools().map((t) => {
  const mcpName = t.expose?.mcp?.name ?? null;
  const http = t.expose?.http
    ? { path: t.expose.http.path, methods: methodsOf(t.expose.http) }
    : null;
  const g = t.guidance;
  const guidance = g
    ? {
        ...(g.when ? { when: g.when } : {}),
        ...(g.notWhen ? { notWhen: g.notWhen } : {}),
        ...(g.chaining ? { chaining: g.chaining } : {}),
      }
    : undefined;
  return {
    name: mcpName,
    http,
    description: t.description,
    capabilities: [...t.capabilities],
    ...(t.agentRoles && t.agentRoles.length > 0 ? { agentRoles: [...t.agentRoles] } : {}),
    ...(t.profile ? { profile: t.profile } : {}),
    ...(t.harness ? { harness: t.harness } : {}),
    ...(t.public ? { public: true } : {}),
    ...(guidance && Object.keys(guidance).length > 0 ? { guidance } : {}),
  };
});

// Stable sort key so the artifact diffs cleanly: MCP name, else HTTP path.
const sortKey = (e: CatalogEntry): string => e.name ?? e.http?.path ?? '';
entries.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));

const catalog = {
  _comment:
    'GENERATED from the defineTool registry by scripts/gen-tool-catalog.ts — do not hand-edit. Run `npm run gen:tool-catalog` after adding/changing a tool. The compact, CI-gated projection of the tool + route surface (docs-and-memory-as-projections D-002).',
  count: entries.length,
  tools: entries,
};

const jsonOut = JSON.stringify(catalog, null, 2) + '\n';

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(OUT, 'utf8');
  } catch {
    /* missing → treat as stale */
  }
  if (current !== jsonOut) {
    process.stderr.write('✗ .papercusp/tool-catalog.json is stale. Run: npm run gen:tool-catalog\n');
    process.exit(1);
  }
  process.stdout.write(`✓ .papercusp/tool-catalog.json is up to date (${entries.length} tools)\n`);
} else {
  writeFileSync(OUT, jsonOut);
  process.stdout.write(`✓ wrote ${entries.length} tools to .papercusp/tool-catalog.json\n`);
}
// The agent-tools registry import opens keep-alive handles (pools/timers), so the
// process never exits naturally — exit explicitly or callers hang until killed.
process.exit(0);
