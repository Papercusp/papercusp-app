/**
 * capability:write — write (create/overwrite) a file, mirroring the native
 * Write tool. The body runs ONLY while the per-path file lock is held
 * (`guardFileLock`, P-013) — the server-side replacement for the client
 * PreToolUse lock hook, so a fleet agent's write serializes with every other
 * agent (SU sessions included) on the same physical file. Part of P-010
 * (`agent-capability-confinement-2026-06-13`).
 */

import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { fileLockedResult, guardFileLock } from '../locks/file-lock-guard';
import { resolveCapabilityBaseDir } from './base-dir';

const GLOB_METACHARS = new Set(['*', '?', '[', ']']);

/**
 * Return the first glob metacharacter in a destination path, if any.
 *
 * capability:write takes one concrete destination, not a shell/pathspec glob.
 * Letting a glob-shaped argument through creates a literal file whose name is
 * usually the serialized tool-call payload's own source path (EI-21390906760757289).
 */
export function findWritePathGlobMetacharacter(filePath: string): string | null {
  for (const character of filePath) {
    if (GLOB_METACHARS.has(character)) return character;
  }
  return null;
}

/**
 * Would writing `content` destroy existing bytes at the destination?
 *
 * Empty content is the one write whose damage is entirely SILENT: the handler
 * reports ok:true with bytes:0, and the loss surfaces only on a later
 * byte-compare. Every upstream mistake converges here — a failed parse, an
 * undefined variable, and above all a bare-string tool result guarded as
 * `result.content ?? ''`, which yields '' because a code:run tool result is the
 * unwrapped text and has no `.content` property (EI-21824594852517420).
 *
 * The predicate is deliberately narrower than `content === ''`: creating a new
 * empty file, and re-writing an already-empty one, destroy nothing and stay
 * allowed. Only an empty write over existing bytes is refused, and only without
 * the explicit opt-in — deliberate truncation remains one flag away.
 *
 * Exported so the destructive case is testable directly, without depending on
 * reaching the filesystem.
 */
export function emptyWriteWouldDestroy(content: string, existingBytes: number | null): boolean {
  return content === '' && existingBytes !== null && existingBytes > 0;
}

/**
 * Does `content` look like capability:read's DISPLAY view rather than file text?
 *
 * The default read view is `<abs path> (N lines)` followed by a right-aligned
 * line number and a TAB before every source line. Writing that back is the
 * corruption THIS item was actually filed for: the destination grows by the
 * width of each line-number prefix and stops being valid source, while the
 * write reports ok:true (measured: a 33,955-byte source produced a 38,626-byte
 * destination, caught only by a manual byte-compare). `capability:read
 * { raw: true }` is the correct source for text destined for a write.
 *
 * Requires BOTH signals — the header AND several numbered body lines — so a
 * file that merely opens with a parenthesised line count is not refused.
 */
export function looksLikeDisplayFormattedRead(content: string): boolean {
  const lines = content.split('\n');
  if (lines.length < 4) return false;
  if (!/^\S.*\s\(\d+ lines(?:, showing \d+–\d+)?\)$/.test(lines[0])) return false;
  let numbered = 0;
  for (let i = 1; i < Math.min(lines.length, 21); i += 1) {
    if (/^\s{0,6}\d+\t/.test(lines[i])) numbered += 1;
  }
  return numbered >= 3;
}

/** Size of an existing regular file, or null when absent / not a regular file. */
function existingFileByteLength(abs: string): number | null {
  try {
    const stat = statSync(abs);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

export default defineTool({
  name: 'capability:write',
  description:
    'Write a file (create or overwrite) like the native Write tool. Acquires the per-path file lock server-side before writing (busy → returns who holds it). Path is absolute or relative to the project dir.',
  guidance: {
    when: 'Create a new file, or fully replace an existing one. For a partial change to an existing file prefer capability:edit.',
    notWhen: 'A small in-place change — use capability:edit (exact string replacement). Reading first — use capability:read.',
    chaining: 'capability:read (if overwriting) → capability:write. On a file_locked result, wait/pivot/coordinate with the holder.',
    seeAlso: [
      'capability:read (read before overwriting)',
      'capability:edit (surgical edit instead of overwrite)',
    ],
  },
  capability: 'capability:fs-write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    file_path: z.string().min(1).describe('Absolute path, or relative to the project dir.'),
    content: z.string().describe('Full file content to write (overwrites any existing file).'),
    allow_empty_overwrite: z
      .boolean()
      .optional()
      .describe('Permit empty content to replace an existing non-empty file (deliberate truncation). Without it that one case is refused.'),
    allow_display_formatted_content: z
      .boolean()
      .optional()
      .describe('Permit content that looks like capability:read\'s line-numbered display view (normally a sign the text should have come from raw:true).'),
  }),
  async handler(args, ctx) {
    const globMetacharacter = findWritePathGlobMetacharacter(args.file_path);
    if (globMetacharacter) {
      return invalidPath(
        `file_path contains the glob metacharacter ${JSON.stringify(globMetacharacter)}; capability:write requires a concrete destination path`,
      );
    }
    const baseDir = resolveCapabilityBaseDir(ctx);
    const abs = isAbsolute(args.file_path) ? args.file_path : resolve(baseDir, args.file_path);

    // Lock the path we are ACTUALLY going to write (`abs`), never the raw argument —
    // handing the guard a relative path makes it re-resolve against its own base, and
    // any disagreement between the two resolutions keys the lock off a file this
    // handler never touches (EI-20881501070735530).
    const outcome = await guardFileLock(ctx, [abs], { intent: 'capability:write' }, async () => {
      // Inside the lock: the size read and the write must not straddle a peer's write.
      const existingBytes = existingFileByteLength(abs);
      if (!args.allow_empty_overwrite && emptyWriteWouldDestroy(args.content, existingBytes)) {
        return emptyOverwriteRefused(abs, existingBytes ?? 0);
      }
      if (!args.allow_display_formatted_content && looksLikeDisplayFormattedRead(args.content)) {
        return displayFormattedRefused(abs);
      }
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, args.content, 'utf8');
      const bytes = Buffer.byteLength(args.content, 'utf8');
      const lines = args.content === '' ? 0 : args.content.split('\n').length;
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, path: abs, bytes, lines }) }] };
    });

    return outcome.acquired ? outcome.result : await fileLockedResult(outcome.busy, outcome.reader);
  },
});

/**
 * Refuse the silent-destruction case, and teach the fix AT the failure site
 * rather than in the always-loaded tool description (prompt weight is charged
 * every turn; this text is charged only when someone is about to lose a file).
 */
function emptyOverwriteRefused(abs: string, existingBytes: number) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        ok: false,
        reason: 'empty_overwrite_refused',
        path: abs,
        existingBytes,
        message:
          `refusing to replace ${abs} (${existingBytes} bytes) with empty content. ` +
          'This is almost always an upstream mistake rather than an intended truncation. ' +
          'The common cause is guarding a tool result as `result.content ?? \'\'`: a code:run tool result ' +
          'is the already-unwrapped text, so `.content` is undefined and the guard silently yields \'\'. ' +
          'Use the string result directly, and pass capability:read { raw: true } when the text is ' +
          'destined for a write — the default line view is display-formatted (path header + line-number ' +
          'prefixes) and writing it back corrupts the file. ' +
          'If you really mean to truncate, pass allow_empty_overwrite: true.',
      }),
    }],
    isError: true,
  };
}

/** Refuse writing capability:read's display view back to disk, and name the correct source. */
function displayFormattedRefused(abs: string) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        ok: false,
        reason: 'display_formatted_content',
        path: abs,
        message:
          `refusing to write ${abs}: the content looks like capability:read's DISPLAY view — a ` +
          '`<path> (N lines)` header followed by right-aligned line numbers and a TAB before each ' +
          'line — rather than file text. Writing it back corrupts the file (it grows by the width ' +
          'of every line-number prefix) while still reporting ok:true. ' +
          'Re-read the source with capability:read { raw: true }, which returns the exact ' +
          'undecorated text, and write that. ' +
          'If this content is genuinely meant to be a captured read transcript, pass ' +
          'allow_display_formatted_content: true.',
      }),
    }],
    isError: true,
  };
}

function invalidPath(message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, reason: 'invalid_path', message }) }],
    isError: true,
  };
}
