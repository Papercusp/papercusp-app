/**
 * capability:edit — exact-string replacement in a file, mirroring the native
 * Edit tool (old_string → new_string, replace_all). The body runs ONLY while
 * the per-path file lock is held (`guardFileLock`, P-013). Part of P-010
 * (`agent-capability-confinement-2026-06-13`).
 */

import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { fileLockedResult, guardFileLock } from '../locks/file-lock-guard';
import { resolveCapabilityBaseDir } from './base-dir';
import { occurrences, spliceLiteral, squashWhitespace } from './text-splice';

export default defineTool({
  name: 'capability:edit',
  description:
    'Exact string replacement in a file, like the native Edit tool. old_string must match exactly and (unless replace_all) be unique. Acquires the per-path file lock server-side before editing. Path is absolute or relative to the project dir.',
  guidance: {
    when: 'Make a targeted in-place change to an existing file. Include enough surrounding context in old_string to make it unique, or set replace_all.',
    notWhen: 'Creating a file or replacing it wholesale — use capability:write. Reading — use capability:read.',
    chaining: 'capability:read → capability:edit. On a file_locked result, wait/pivot/coordinate with the holder.',
    seeAlso: [
      'capability:read (read / get the exact string first)',
      'capability:write (overwrite or create a whole file)',
      'capability:inspect (typecheck / test to verify the edit)',
    ],
  },
  capability: 'capability:fs-write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    file_path: z.string().min(1).describe('Absolute path, or relative to the project dir.'),
    old_string: z.string().describe('The exact text to replace.'),
    new_string: z.string().describe('The replacement text (must differ from old_string).'),
    replace_all: z.boolean().optional().describe('Replace every occurrence (default false → require a unique match).'),
  }),
  async handler(args, ctx) {
    if (args.old_string === args.new_string) return err('no_op', 'old_string and new_string are identical.');
    const baseDir = resolveCapabilityBaseDir(ctx);
    const abs = isAbsolute(args.file_path) ? args.file_path : resolve(baseDir, args.file_path);

    // Lock the path we are ACTUALLY going to edit (`abs`), never the raw argument —
    // see the same note in write.ts (EI-20881501070735530).
    const outcome = await guardFileLock(ctx, [abs], { intent: 'capability:edit' }, async () => {
      let raw: string;
      try {
        raw = readFileSync(abs, 'utf8');
      } catch (e: unknown) {
        return err('read_failed', e instanceof Error ? e.message : String(e));
      }
      const count = occurrences(raw, args.old_string);
      if (count === 0) return err('not_found', `old_string not found in ${abs}.${diagnoseMiss(raw, args, abs)}`);
      if (count > 1 && !args.replace_all) {
        return err('not_unique', `old_string matches ${count} times; pass replace_all or add surrounding context to make it unique.`);
      }
      // EI-18693907749585513: NEVER use String.prototype.replace(old, new) with a
      // string searchValue — the REPLACEMENT string is still pattern-interpreted
      // ($&, $`, $', $1, $$, ...) regardless of whether the search side is a plain
      // string. `` $` `` in particular expands to "everything before the match",
      // which silently spliced an entire file into itself when new_string happened
      // to contain a literal `$` followed by a backtick (e.g. prose quoting shell
      // expansion markers). spliceLiteral (shared with capability:patch, so the fix
      // has ONE home rather than one per mutation door) is immune on both paths:
      // split/join for replace_all, an index splice otherwise. The index splice is
      // safe here because the caller already enforced (above) that old_string occurs
      // exactly once when !replace_all.
      const next = spliceLiteral(raw, args.old_string, args.new_string, args.replace_all === true);
      try {
        writeFileSync(abs, next, 'utf8');
      } catch (e: unknown) {
        return err('write_failed', e instanceof Error ? e.message : String(e));
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, path: abs, replacements: args.replace_all ? count : 1 }) }],
      };
    });

    return outcome.acquired ? outcome.result : await fileLockedResult(outcome.busy, outcome.reader);
  },
});

/** Below this, a write is recent enough that a peer edit since the caller's read is plausible. */
const RECENT_WRITE_SEC = 120;

/**
 * EI-20225459009961868 — a bare "old_string not found" leaves the caller holding two
 * hypotheses it cannot separate: "a peer edited this shared file after I read it" or
 * "my old_string was simply wrong". On a ~100-agent shared checkout the first is real,
 * so callers assume it — they re-read and retry even when the file has not been touched
 * in days and the string was never right, and they re-apply an edit that already landed.
 *
 * Every signal needed to separate them is already in hand at the miss (the current
 * content, both strings, and the file's own mtime), so spend it here instead of making
 * the caller guess. This is FAILURE-PATH ONLY: it never renders on a successful edit and
 * adds nothing to the always-on tool schema, so it costs no prompt weight.
 */
function diagnoseMiss(raw: string, args: { old_string: string; new_string: string }, abs: string): string {
  const notes: string[] = [];

  if (args.new_string !== '' && raw.includes(args.new_string)) {
    // Leads, because it is the one reading where RETRYING IS THE HARMFUL MOVE: the
    // change may already be in the file (an earlier attempt that landed, or a peer
    // making the same fix), so warn before anything suggests re-applying.
    notes.push(
      'new_string is ALREADY present, so this edit may have been applied already (by an earlier attempt of yours, or by a peer) — re-read before retrying rather than re-applying.',
    );
  } else {
    const near = occurrences(squashWhitespace(raw), squashWhitespace(args.old_string));
    if (near > 0) {
      notes.push(
        `a whitespace-insensitive match exists (${near}×), so the text IS present but its exact spacing/indentation/line-endings differ — re-read the hunk with capability:read and copy it verbatim.`,
      );
    }
  }

  const age = secondsSinceWrite(abs);
  if (age !== null) {
    // Both directions are load-bearing. A recent write points at a peer race; an OLD
    // one RULES IT OUT, and that negative is the reading that stops a fruitless hunt
    // for a peer who never touched the file. Neither branch asserts who wrote it —
    // mtime cannot tell us that, and a confident wrong attribution is worse than none.
    notes.push(
      age <= RECENT_WRITE_SEC
        ? `the file was last written ${formatAge(age)} ago — if that write was not your own, a peer changed it after you read it; re-read the exact hunk.`
        : `the file has not been written for ${formatAge(age)}, so a peer edit since your read is unlikely — check old_string itself.`,
    );
  }

  return notes.length > 0 ? ` ${notes.join(' ')}` : '';
}

function secondsSinceWrite(abs: string): number | null {
  try {
    return Math.max(0, (Date.now() - statSync(abs).mtimeMs) / 1000);
  } catch {
    return null;
  }
}

function formatAge(sec: number): string {
  if (sec < 90) return `${Math.round(sec)}s`;
  if (sec < 5400) return `${Math.round(sec / 60)}m`;
  if (sec < 172800) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}

function err(reason: string, message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, reason, message }) }],
    isError: true,
  };
}
