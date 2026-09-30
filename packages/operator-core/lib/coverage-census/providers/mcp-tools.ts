/**
 * `mcp-tools` — the declared census provider for agent-tool surfaces.
 *
 * Plan: deterministic-coverage-census-2026-08-17 (P-003), Decision D-001.
 *
 * THE POPULATION IS THE LIVE CATALOG. Every tool self-registers by calling `defineTool`, which
 * pushes into the `@papercusp/tooldef` catalog; `getCatalog()` is what the MCP server itself
 * answers `tools/list` from. Enumerating from it means the census population is, by
 * construction, the set of tools an agent can actually call — never a hand-maintained list, and
 * never a glob over `agent-tools/**` (which would count a file that exists but is not imported
 * by the barrel, i.e. a tool no agent can reach).
 *
 * THE CATALOG IS POPULATED BY SIDE EFFECT, WHICH IS THE WHOLE HAZARD. `agent-tools/index.ts` is
 * a barrel of bare `import './group/verb'` statements — the imports ARE the registration. If the
 * census job runs in a process that never imported that barrel, `getCatalog()` returns `[]`,
 * which is indistinguishable from "this build has no tools" and would retire every mcp-tool row.
 * So we import the barrel explicitly before reading, and the empty-guard turns a failed load into
 * a FAILED provider (kinds not retirable) rather than a successful wipe. See `_non-empty.ts`.
 *
 * SCHEMA CAPTURE. `args` is a StandardSchema (zod in practice); `toJsonSchema` projects it
 * through the same adapter the MCP wire format uses, so the captured `schemaRef` is the schema
 * agents are actually validated against — the seed an L2 fuzz depth can drive from.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { listAllProjectedTools } from '@papercusp/tooldef';
import type { CensusContext, ObservedSurface, SurfaceCensusProvider } from '@papercusp/testing-shell/census';
import { assertRegistryNonEmpty } from './_non-empty';

/** The surface kind this provider owns — and therefore the only kind it may retire. */
export const MCP_TOOL_KIND = 'mcp-tool';

/**
 * Directories whose `<group>/<verb>.ts` layout mirrors a tool's `group:verb` name.
 * Used only to CONFIRM a file that already exists — never to assert one that does not.
 */
const TOOL_SOURCE_ROOTS = [
  'packages/operator-core/lib/agent-tools',
  'packages/agent-mcp/src/tools',
] as const;

/**
 * Resolve a tool's implementing file by the `group:verb` → `<root>/<group>/<verb>.ts` convention,
 * returning it ONLY when the file is present on disk.
 *
 * This is a deliberate asymmetry. A confirmed hit is real evidence (the file is there, and the
 * convention is enforced by `defineTool`'s file-path-derived default name). A miss means the tool
 * lives somewhere the convention does not describe — several do — and the honest answer is `null`,
 * not a fabricated path. A fabricated path is worse than an absent one: the reverse map from a
 * plan's changed files would silently attribute coverage to a file that does not exist, and
 * nothing downstream can tell a guessed path from a verified one.
 */
function resolveToolSourceFile(toolName: string, repoRoot: string): string | null {
  const sep = toolName.indexOf(':');
  if (sep <= 0) return null;
  const group = toolName.slice(0, sep);
  const verb = toolName.slice(sep + 1);
  // Reject anything that could escape the roots; tool names are identifiers, not paths.
  if (!/^[\w.-]+$/.test(group) || !/^[\w.-]+$/.test(verb)) return null;

  for (const root of TOOL_SOURCE_ROOTS) {
    const rel = `${root}/${group}/${verb}.ts`;
    try {
      if (fs.existsSync(path.join(repoRoot, rel))) return rel;
    } catch {
      // An unreadable repoRoot is not this provider's problem to fail on — fall through to null.
    }
  }
  return null;
}

export const mcpToolsProvider: SurfaceCensusProvider = {
  provider: 'mcp-tools',
  kinds: [MCP_TOOL_KIND],

  async enumerate(ctx: CensusContext): Promise<ObservedSurface[]> {
    // Registration IS the import. Guarantee the barrel ran before trusting the catalog —
    // otherwise an empty catalog reads as "no tools exist" instead of "nothing loaded".
    await import('../../agent-tools/index');

    // The endpoint system serves the projected registry, not the legacy catalog. `defineTool`
    // mirrors legacy definitions into this registry and endpoint-native tools register here
    // directly, so this is the only population that matches the MCP transport.
    const catalog = listAllProjectedTools().filter((def) => def.expose.mcp != null);

    const surfaces = catalog.map((def): ObservedSurface => ({
      kind: MCP_TOOL_KIND,
      surfaceId: def.expose.mcp!.name,
      sourceFile: resolveToolSourceFile(def.expose.mcp!.name, ctx.repoRoot),
      schemaRef: def.discoveryInputSchema ?? def.inputSchema,
      attrs: {
        capabilities: def.capabilities,
        effect: def.effect ?? null,
        // A composite tool bundles other tools; its coverage question is different from a
        // primitive's, so record it rather than making the census re-derive it.
        replaces: Array.isArray(def.replaces) ? def.replaces : null,
      },
      fidelity: 'declared',
    }));

    return assertRegistryNonEmpty(
      surfaces,
      'listAllProjectedTools() MCP projection (@papercusp/tooldef)',
      'The agent-tools barrel did not register any tool — check that lib/agent-tools/index.ts imported cleanly.',
    ) as ObservedSurface[];
  },
};
