/**
 * capability:list — the `ls` answer, structured, with UTC timestamps and symlinks
 * disclosed. Plan `bash-substitution-reachable-ceiling-2026-08-01`, P-012 / D-068.
 *
 * WHY A NEW VERB RATHER THAN A CASE ON capability:read (reuse-first): read returns
 * FILE CONTENT with line/byte windows, a content index and evidence-class args, and
 * already refuses a directory with `is_a_directory`. Making that path return rows
 * instead would give one tool two unrelated result shapes and force every caller to
 * branch on which it got. The shapes differ, so the verbs differ — and read's refusal
 * now names this tool, which is the part that makes the split navigable.
 *
 * WHY IT EXISTS AT ALL: D-068 measured `ls` at 2,879 atoms / 662 sessions — 85% of the
 * whole genuine needs-tool population and the only fleet-wide bucket in it. D-058
 * already measured bash->tool as token-INFLATING, so this is justified on correctness
 * (UTC mtimes, disclosed symlinks, non-confusable emptiness), never on token savings.
 * The correctness case is not speculative: commit 6cdae6b37b widened the registry's
 * `current-time` pair for the same UTC-vs-local trap (D-066).
 */

import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { resolveCapabilityBaseDir } from './base-dir';
import {
  listDirectory,
  DirectoryListingError,
  DIRECTORY_LISTING_DEFAULT_LIMIT,
} from '../../directory-listing';

export default defineTool({
  name: 'capability:list',
  profile: 'engineer',
  description:
    'List a directory — the `ls` / `ls -la` / `ls -t` answer as structured rows, with modification times in ISO-8601 UTC and symlinks reported with their targets. Filter with `contains`, order with `sort:"mtime"` for newest-first, include dot-entries with `all:true`.',
  capability: 'capability:fs-read',
  guidance: {
    when: 'You want to know what is in a directory, when entries were last modified, or how big they are — and especially when you will COMPARE an mtime against a papercusp timestamp, because those are UTC and `ls`/`stat` render local time.',
    notWhen: 'To read a file\'s contents use capability:read. To search file CONTENT, or to walk a tree recursively, use capability:bash with grep/rg/find — this lists exactly one directory and does not recurse.',
    chaining: 'capability:list → capability:read (open a file it named) or capability:edit.',
    returns:
      '{ path, entries[], matched, total, truncated, hiddenExcluded, symlinkedDirs }. Each entry: { name, type, bytes, mtimeUtc, symlinkTarget, symlinkResolvesTo, statUnreadable }.\n\nTIMESTAMPS ARE UTC BY CONSTRUCTION. `mtimeUtc` is an ISO-8601 `Z` string and there is no formatting option, because the trap this tool exists to close is comparing a locally-rendered `ls -l`/`stat` stamp (-04:00 on this host) against a papercusp timestamp in UTC — a silent 4-hour skew that reads as STALE. Do not reintroduce it by reformatting.\n\nTYPE IS THE ENTRY\'S OWN (lstat), NEVER ITS TARGET\'S. A symlink is always `type:"symlink"`, and `symlinkResolvesTo` says what it points at — `dir`, `file`, or `broken`. `symlinkedDirs` counts entries that are links to directories: this is the class bare `find` silently omits without `-L`, so a non-zero count is a warning that a recursive walk over this path will under-report unless it follows links.\n\nA SHORT LIST IS NOT PROOF OF A SMALL DIRECTORY. `total` is the count AFTER `all`/`contains` filtering but BEFORE `limit`; `truncated:true` means rows were cut. Never infer absence from a truncated listing — check `truncated` first. `hiddenExcluded` counts dot-entries dropped because `all` was not set, so a "missing" file may simply be hidden.\n\nAN EMPTY `entries` ARRAY MEANS THE DIRECTORY IS EMPTY. It never means the read failed: a missing path, a non-directory and a permission denial each return ok:false with `reason` of `not_found` / `not_a_directory` / `permission_denied` / `unreadable`. Those four are the only ways to get "no rows" without the directory genuinely having none.\n\n`statUnreadable` on a row is the per-entry version of the same contract: the entry EXISTS and was named by the directory, but its metadata could not be read, so `bytes`/`mtimeUtc` are null for a reason rather than by absence.',
    seeAlso: [
      'capability:read (read one file, or a line/byte window of it)',
      'capability:bash (recursive walks, content search, anything multi-directory)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES, 'judge'],
  args: z.object({
    path: z
      .string()
      .min(1)
      .describe('Directory to list. Absolute, or relative to the project dir.'),
    all: z.boolean().optional().describe('Include dot-entries (the `ls -a` shape). Default false.'),
    limit: z
      .number()
      .int()
      .positive()
      .max(1000)
      .optional()
      .describe(
        `Max rows (default ${DIRECTORY_LISTING_DEFAULT_LIMIT}). Read "truncated" before inferring absence.`,
      ),
    sort: z
      .enum(['name', 'mtime'])
      .optional()
      .describe('`name` (default) or `mtime` for newest-first — the `ls -t` shape.'),
    contains: z
      .string()
      .min(1)
      .optional()
      .describe('Case-insensitive substring filter on the entry name.'),
  }),
  result: z
    .object({
      path: z.unknown().optional(),
      entries: z.unknown().optional(),
      matched: z.unknown().optional(),
      total: z.unknown().optional(),
      truncated: z.unknown().optional(),
      hiddenExcluded: z.unknown().optional(),
      symlinkedDirs: z.unknown().optional(),
    })
    .passthrough(),
  async handler(args, ctx) {
    const abs = isAbsolute(args.path)
      ? args.path
      : resolve(resolveCapabilityBaseDir(ctx as never), args.path);
    try {
      const listing = listDirectory({
        path: abs,
        all: args.all,
        limit: args.limit,
        sort: args.sort,
        contains: args.contains,
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, ...listing }, null, 2) }],
      };
    } catch (err) {
      const reason = err instanceof DirectoryListingError ? err.code : 'unreadable';
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, reason, path: abs, message }) }],
        isError: true,
      };
    }
  },
});
