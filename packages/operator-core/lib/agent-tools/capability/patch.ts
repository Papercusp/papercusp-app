/**
 * capability:patch — apply a set of exact-string hunks across SEVERAL files as one
 * all-or-nothing unit, under managed authority and the per-path file locks.
 *
 * Closes the adapter half of the `patch-notebook-adapters` gap inventoried by P-001
 * (`libs/papercusp/packages/orchestrator/src/managed-capability-contract.ts`, family
 * `edit-write-patch-notebook`). Its falsifier: "Hermetic and real-client tests prove
 * atomic multi-file patch and notebook semantics through managed authority and locks."
 *
 * Why this is not a loop of `capability:edit` calls. A caller looping single edits
 * holds each file's lock only for its own hunk, so a peer can interleave between
 * them, and a hunk that fails halfway leaves the earlier files already mutated — a
 * half-applied refactor on a shared checkout that typechecks nowhere and that no
 * single actor owns. This door takes EVERY target path's lock for the whole
 * operation and validates EVERY hunk before writing ANY file.
 *
 * Honest atomicity (plan D-005 — never claim equivalence the mechanism does not have):
 * this is validate-then-write with rollback, NOT a filesystem transaction. Every hunk
 * is resolved in memory first, so the ordinary failure (a stale or ambiguous
 * old_string) writes nothing at all. If a write fails midway — a disk or permission
 * fault after some files already landed — previously written files are restored from
 * their captured contents and the result says so via `rolledBack`. A rollback that
 * itself fails is reported per path rather than swallowed. The result never says
 * "atomic" without naming which of these happened.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { fileLockedResult, guardFileLock } from '../locks/file-lock-guard';
import { resolveCapabilityBaseDir } from './base-dir';
import { occurrences, spliceLiteral, squashWhitespace } from './text-splice';

/** Bound the blast radius of one call; a larger refactor should be staged deliberately. */
const MAX_HUNKS = 100;

const hunkSchema = z.object({
  file_path: z.string().min(1).describe('Absolute path, or relative to the project dir.'),
  old_string: z.string().describe('The exact text to replace.'),
  new_string: z.string().describe('The replacement text (must differ from old_string).'),
  replace_all: z.boolean().optional().describe('Replace every occurrence in this file (default false → require a unique match).'),
});

export default defineTool({
  name: 'capability:patch',
  description:
    'Apply exact-string hunks across several files as ONE all-or-nothing unit, holding every target path\'s file lock for the whole operation. Every hunk is validated before any file is written, so a stale or ambiguous old_string writes nothing. Use instead of looping capability:edit when the change must land together.',
  guidance: {
    when: 'A change that is only correct if every file lands together — a rename across call sites, moving a symbol, or a signature change plus its callers.',
    notWhen: 'One independent file (capability:edit), a whole-file rewrite (capability:write), or a notebook cell (capability:notebook_edit).',
    chaining: 'capability:read each hunk verbatim → capability:patch → capability:inspect. On file_locked, no file was written; wait or coordinate with the holder.',
    seeAlso: ['capability:edit (a single file)', 'capability:write (create or overwrite)', 'capability:read (copy old_string exactly)'],
  },
  capability: 'capability:fs-write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    edits: z
      .array(hunkSchema)
      .min(1)
      .max(MAX_HUNKS)
      .describe('Hunks to apply. Several may target the same file; they are applied in order against that file.'),
  }),
  async handler(args, ctx) {
    const baseDir = resolveCapabilityBaseDir(ctx);

    // Resolve to the paths we will ACTUALLY write and lock THOSE, never the raw
    // arguments (the same rule as edit.ts / write.ts — EI-20881501070735530).
    const resolved = args.edits.map((e) => ({ ...e, abs: isAbsolute(e.file_path) ? e.file_path : resolve(baseDir, e.file_path) }));
    const paths = [...new Set(resolved.map((e) => e.abs))];

    const noOp = resolved.findIndex((e) => e.old_string === e.new_string);
    if (noOp !== -1) return err('no_op', `edits[${noOp}]: old_string and new_string are identical.`);

    const outcome = await guardFileLock(ctx, paths, { intent: `capability:patch (${paths.length} file(s))` }, async () => {
      // ---- Phase 1: read every target. Nothing is written in this phase. ----
      const original = new Map<string, string>();
      for (const p of paths) {
        try {
          original.set(p, readFileSync(p, 'utf8'));
        } catch (e: unknown) {
          return err('read_failed', `${p}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // ---- Phase 2: resolve EVERY hunk in memory. One failure aborts the whole patch. ----
      const next = new Map<string, string>(original);
      const replacements = new Map<string, number>();
      for (let i = 0; i < resolved.length; i++) {
        const h = resolved[i]!;
        const current = next.get(h.abs)!;
        const count = occurrences(current, h.old_string);
        if (count === 0) {
          return err('hunk_not_found', `edits[${i}] (${h.abs}): old_string not found.${diagnoseMiss(current, h)} No file was written.`);
        }
        if (count > 1 && !h.replace_all) {
          return err(
            'hunk_not_unique',
            `edits[${i}] (${h.abs}): old_string matches ${count} times; pass replace_all or add surrounding context. No file was written.`,
          );
        }
        next.set(h.abs, spliceLiteral(current, h.old_string, h.new_string, h.replace_all === true));
        replacements.set(h.abs, (replacements.get(h.abs) ?? 0) + (h.replace_all ? count : 1));
      }

      // ---- Phase 3: write. Every hunk already validated, so this is the only failure left. ----
      const changed = paths.filter((p) => next.get(p) !== original.get(p));
      const written: string[] = [];
      for (const p of changed) {
        try {
          writeFileSync(p, next.get(p)!, 'utf8');
          written.push(p);
        } catch (e: unknown) {
          // A partial write is the one state this door must never leave behind silently.
          const rollback = restore(written, original);
          return err(
            'write_failed',
            `${p}: ${e instanceof Error ? e.message : String(e)}. ${
              rollback.failed.length === 0
                ? `Rolled back ${rollback.restored.length} already-written file(s); the tree is unchanged.`
                : `ROLLBACK INCOMPLETE — restored ${rollback.restored.length}, FAILED to restore: ${rollback.failed.join(', ')}. These files are mid-patch and need manual repair.`
            }`,
            { rolledBack: rollback.restored, rollbackFailed: rollback.failed },
          );
        }
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              // Named, not asserted: this is validate-then-write, not a filesystem transaction.
              atomicity: 'validated-all-hunks-before-writing',
              hunks: resolved.length,
              filesLocked: paths.length,
              filesWritten: changed.length,
              files: changed.map((p) => ({ path: p, replacements: replacements.get(p) ?? 0 })),
              unchanged: paths.filter((p) => !changed.includes(p)),
            }),
          },
        ],
      };
    });

    return outcome.acquired ? outcome.result : await fileLockedResult(outcome.busy, outcome.reader);
  },
});

/** Restore already-written files from their captured originals. Reports both sides. */
function restore(written: readonly string[], original: ReadonlyMap<string, string>): { restored: string[]; failed: string[] } {
  const restored: string[] = [];
  const failed: string[] = [];
  for (const p of written) {
    try {
      writeFileSync(p, original.get(p)!, 'utf8');
      restored.push(p);
    } catch {
      failed.push(p);
    }
  }
  return { restored, failed };
}

/**
 * Failure-path only, so it costs no prompt weight. Same reasoning as edit.ts's
 * diagnosis (EI-20225459009961868): a bare "not found" leaves the caller unable to
 * separate "a peer changed it" from "my old_string was wrong", and on a shared
 * checkout they assume the first and retry. Here it matters more — one bad hunk
 * rejects the WHOLE patch, so the caller needs to know which hypothesis to act on.
 */
function diagnoseMiss(current: string, h: { old_string: string; new_string: string }): string {
  if (h.new_string !== '' && current.includes(h.new_string)) {
    return ' new_string is ALREADY present, so this hunk may have been applied already — re-read before retrying rather than re-applying.';
  }
  const near = occurrences(squashWhitespace(current), squashWhitespace(h.old_string));
  if (near > 0) {
    return ` A whitespace-insensitive match exists (${near}×), so the text IS present but its exact spacing/indentation differs — re-read the hunk with capability:read and copy it verbatim.`;
  }
  return '';
}

function err(reason: string, message: string, extra?: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, reason, message, ...extra }) }],
    isError: true,
  };
}
