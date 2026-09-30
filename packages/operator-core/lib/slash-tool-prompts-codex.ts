/**
 * slash-tool-prompts-codex.ts — the Codex FILE emitter for slash exposure
 * (slash-exposure-tool-catalog-2026-06-12 P-009).
 *
 * Codex does not surface MCP prompts as slash commands (P-008: the binary
 * speaks prompts/get for its own MCP-server side, but the TUI's slash
 * prompts come only from `$CODEX_HOME/prompts/*.md`). So for Codex
 * sessions the same projection is materialized as prompt FILES at launch:
 * one file per session-visible, slash-exposed tool, rendered with the same
 * tooldef instruction the MCP-prompt path serves, with `$ARGUMENTS` in the
 * supplied-args slot (Codex substitutes the text typed after the command).
 *
 * Ownership: these files carry their OWN managed marker, deliberately NOT
 * containing the saved-prompts `<!-- papercusp:managed -->` substring —
 * each writer's prune then ignores the other's files, so the two emitters
 * are order-independent in the shared flat `prompts/` dir. Hand-authored
 * (unmanaged) files are never touched.
 *
 * Server-only.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  listMcpProjections,
  lookupByMcpName,
  slashPromptNameFor,
  renderSlashPrompt,
  resolveSlashExposure,
} from '@papercusp/agent-mcp';
import type { AgentRole } from '@papercusp/plugin-sdk';
import { advertisedArgsSchema } from '@papercusp/result-encoding';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';

/**
 * Distinct from saved-prompts' MANAGED_MARKER on purpose — and verified by
 * test to not CONTAIN it — so `pruneManagedCommands` (saved prompts) skips
 * these files and `pruneSlashToolFiles` (below) skips theirs.
 */
export const SLASH_TOOL_MARKER = '<!-- papercusp-slash-tool:managed -->';

/**
 * Codex command name for a slash prompt: `tool:plans:list` → `tool-plans-list`
 * (file `tool-plans-list.md`, invoked as `/tool-plans-list`). Codex command
 * names are file basenames, so `:` and `.` collapse to `-`.
 */
export function codexSlashFileBase(promptName: string): string {
  return promptName.replaceAll(/[:.]/g, '-').toLowerCase();
}

function isSlashToolFile(path: string): boolean {
  try {
    return readFileSync(path, 'utf8').includes(SLASH_TOOL_MARKER);
  } catch {
    return false;
  }
}

/** Remove OUR stale tool-prompt files (marker-gated); leave everything else. */
function pruneSlashToolFiles(dir: string, keep: Set<string>): number {
  if (!existsSync(dir)) return 0;
  let removed = 0;
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.md')) continue;
    const base = entry.slice(0, -3);
    if (keep.has(base)) continue;
    const path = join(dir, entry);
    if (!isSlashToolFile(path)) continue;
    rmSync(path, { force: true });
    removed++;
  }
  return removed;
}

export interface EmitCodexSlashResult {
  written: number;
  skipped: number;
  pruned: number;
  /** Wall-clock spent, for the P-009 materialization-time measurement. */
  ms: number;
}

/**
 * Emit one Codex prompt file per session-visible, slash-exposed tool into
 * `<codexHome>/prompts`. The visible set is the SAME role/profile walk
 * tools/list serves (parity, plan P-004). Flag-gated on SLASH_EXPOSURE —
 * when off, prunes any previously-emitted files and writes nothing.
 */
export async function emitCodexSlashToolPrompts(
  codexHome: string,
  role?: AgentRole,
  profile?: 'engineer' | 'power' | 'generic',
): Promise<EmitCodexSlashResult> {
  const start = performance.now();
  const dir = join(codexHome, 'prompts');
  if (!(await getFlag(FLAGS.SLASH_EXPOSURE, 'system'))) {
    const pruned = pruneSlashToolFiles(dir, new Set());
    return { written: 0, skipped: 0, pruned, ms: performance.now() - start };
  }
  let written = 0;
  let skipped = 0;
  const keep = new Set<string>();
  // GENERIC profile (P-025) gets engineer-like tool visibility (the filter only gates
  // power); coerce so the narrow listMcpProjections profile param need not carry 'generic'.
  for (const listing of listMcpProjections(role, profile === 'generic' ? 'engineer' : profile)) {
    const tool = lookupByMcpName(listing.name);
    if (!tool || resolveSlashExposure(tool) === null) continue;
    const promptName = slashPromptNameFor(tool);
    if (!promptName) continue;
    const base = codexSlashFileBase(promptName);
    keep.add(base);
    const rendered = renderSlashPrompt(
      tool,
      {},
      advertisedArgsSchema(listing.name, listing.inputSchema),
      {
        suppliedArgsText:
          '$ARGUMENTS\n(raw text typed after the slash command; may be empty — treat it as the argument values in schema order or `key=value` pairs)',
      },
    );
    const body = rendered.messages[0]!.content.text;
    const path = join(dir, `${base}.md`);
    // Never clobber a file we don't own (hand-authored or saved-prompt).
    if (existsSync(path) && !isSlashToolFile(path)) {
      skipped++;
      continue;
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, `${SLASH_TOOL_MARKER}\n${body}\n`, { mode: 0o644 });
    written++;
  }
  const pruned = pruneSlashToolFiles(dir, keep);
  return { written, skipped, pruned, ms: performance.now() - start };
}
