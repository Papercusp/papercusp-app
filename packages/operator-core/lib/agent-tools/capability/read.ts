/**
 * capability:read — read a file, mirroring the native Read tool's ergonomics
 * (offset/limit line windowing, cat -n line numbers, long-line truncation).
 * `raw:true` opts into exact undecorated text for a line window, for callers
 * that will pass the result to a write rather than only inspect it.
 * Read-only, so it takes no file lock. Part of P-010
 * (`agent-capability-confinement-2026-06-13`).
 */

import { closeSync, createReadStream, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { resolveCapabilityBaseDir, resolveCapabilityIntegrationRoot } from './base-dir';
import { CHARS_PER_TOKEN_ESTIMATE, computeTurnDoors } from '../../context-doors';
import { selectUnambiguousEvidenceRoot } from '../../evidence-root-selection';
import { SCRATCH_SCHEME, safeScratchFilesystemPath } from '../../scratch-uri';
import { redactSensitiveText } from '../../sensitive-text';
import {
  SCRATCH_REFERENCE_MAGIC,
  authorizeScratchReference,
  parseScratchReference,
  ScratchReferenceError,
  type ScratchReferenceManifest,
} from '../../scratch-reference';
import { OUTPUT_EVIDENCE_CLASSES } from '../../output-envelope';
import { resolveAgentIdentity, type ResolveIdentityCtx } from '../coordination/identity';

/**
 * Exported so the bash-substitution audit can PIN its model to it
 * (`pairs/model-drift.test.ts`, WI-6157/D-015). `pairs/file-read.ts` scores
 * `head`/`cat` coverage against a hand-copied `READ_DEFAULT_LIMIT`; if this
 * default changes and the copy does not, the audit emits `capability:read`
 * expressions that silently read a different number of lines than the bash
 * they claim to replace.
 */
export const DEFAULT_LIMIT = 2000;
const MAX_LINE_CHARS = 2000;
export const MAX_FILE_BYTES = 50 * 1024 * 1024; // refuse unbounded reads outright
export const MAX_BYTE_PAGE = 4_096;

const LINE_WINDOW_EXCLUSIVITY =
  'Mutually exclusive with byte windows (byte_offset, byte_limit), content_indexes, and evidence_class.';
const BYTE_WINDOW_EXCLUSIVITY =
  'Mutually exclusive with line windows (offset, limit, tail), content_indexes, and evidence_class.';
const CONTENT_INDEX_EXCLUSIVITY =
  'Mutually exclusive with line windows (offset, limit, tail), byte windows (byte_offset, byte_limit), and evidence_class.';
const EVIDENCE_CLASS_EXCLUSIVITY =
  'Text or Markdown scratch spills do not support evidence selection; read them with line or byte windows. Mutually exclusive with content_indexes, line windows (offset, limit, tail), and byte windows (byte_offset, byte_limit).';
const SCRATCH_LINE_WINDOW_SIZE_NOTE =
  'Scratch-reference line windows can be refused when selected text exceeds the response-size limit; reduce limit/tail or use byte_offset+byte_limit for exact large text.';

const CAPABILITY_READ_SEE_ALSO = [
  'capability:edit (exact-string edit)',
  'capability:write (overwrite / create)',
  'capability:bash (grep / rg to search across files)',
] as const;

/**
 * Config/auth files are useful diagnostics but are not safe exact-read inputs:
 * Codex's config.toml carries the per-session MCP bearer, and the other names
 * below commonly carry credentials or server headers as well. Keep ordinary
 * line reads useful by redacting their values, while refusing raw/byte/structured
 * modes so a caller cannot bypass the redaction boundary (or write a redacted
 * placeholder back through the raw-read → edit/write flow).
 */
function isCredentialBearingConfigPath(absPath: string): boolean {
  const normalized = absPath.replaceAll('\\', '/').toLowerCase();
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
  if (
    basename === 'config.toml' ||
    basename === 'auth.json' ||
    basename === 'credential.json' ||
    basename === 'credentials.json' ||
    basename === 'oauth.json' ||
    basename === '.mcp.json' ||
    basename === '.env' ||
    basename.startsWith('.env.')
  ) return true;
  return basename === 'settings.json' &&
    (normalized.includes('/.claude/') || normalized.includes('/.codex/') || normalized.includes('/su-codex-homes/'));
}

/**
 * Machine-oriented read modes promise an exact or structured payload. Appending
 * human guidance to those results corrupts raw JSON recovered from a result-door
 * spill and base64/selection envelopes alike. Keep cross-links on the ordinary
 * human-readable line view only.
 */
export function capabilityReadSeeAlso(
  _result: unknown,
  args: unknown,
): readonly string[] {
  // ToolGuidance.seeAlso deliberately passes `args: unknown`; narrowing the callback
  // parameter itself makes defineTool's role-tool overload inapplicable and TypeScript
  // falls through to the unrelated route overload (EI-21534077294118083). Keep the public
  // callback broad and narrow defensively inside it.
  const readArgs = args && typeof args === 'object' && !Array.isArray(args)
    ? args as {
        raw?: boolean;
        byte_offset?: number;
        byte_limit?: number;
        content_indexes?: number[];
        evidence_class?: string;
      }
    : {};
  if (
    readArgs.raw ||
    readArgs.byte_offset !== undefined ||
    readArgs.byte_limit !== undefined ||
    readArgs.content_indexes !== undefined ||
    readArgs.evidence_class !== undefined
  ) return [];
  return CAPABILITY_READ_SEE_ALSO;
}

/** base64 encodes 3 bytes as 4 chars, padded up to the next multiple of 4. */
function base64Chars(byteCount: number): number {
  return Math.ceil(byteCount / 3) * 4;
}

/** Slack for JSON escaping inside `file_path` and for door-budget arithmetic we
 *  do not want to depend on to the last character. */
const DOOR_MARGIN_CHARS = 256;

/** The normal minimum page size for a caller that asks for a full-sized window.
 *  Explicitly smaller requests remain valid when the path can fit them. */
export const MIN_PAGE_BYTES = 512;

/**
 * WI-39670: the largest page whose base64 payload PLUS this response's own
 * envelope still fits the `resultEach` door.
 *
 * Every tool result passes that door, and an over-budget result is projected —
 * for this tool that means `data` is truncated MID-BASE64. Decoding the result
 * then yields a valid plaintext prefix followed by `invalid input`, i.e. silent
 * corruption of the byte-window recovery path, with `ok:true`, `eof:false` and a
 * well-formed `next_cursor` all still looking healthy. `MAX_BYTE_PAGE` (4096)
 * alone is 5464 chars of base64 — already over the 6000-char door once the
 * envelope is counted, so the maximum page the schema ADVERTISES could never be
 * returned intact.
 *
 * The envelope is measured, not guessed, because `file_path` is absolute and
 * appears TWICE (top level and again in `next_cursor.args`) — a deep scratch path
 * moves this by hundreds of chars, which is why a fixed smaller constant would
 * only move the cliff rather than remove it. Clamping is lossless: `byte_length`
 * and `next_cursor` describe the page actually returned, so paging simply takes
 * more steps.
 *
 * May return LESS than MIN_PAGE_BYTES (including 0) for a pathological path. An
 * explicitly small caller request may still use that smaller fitted page; the
 * handler refuses only when no positive page fits, or when a normal-sized
 * request would be silently reduced below the efficiency floor. Clamping up to
 * a floor would re-emit an over-budget response and reintroduce the silent
 * truncation this exists to prevent.
 */
export function doorSafePageBytes(
  absPath: string,
  requestedBytes: number,
  reference?: ScratchReferenceManifest,
): number {
  const envelopeChars = JSON.stringify({
    ok: true,
    file_path: absPath,
    encoding: 'base64',
    byte_offset: Number.MAX_SAFE_INTEGER,
    byte_length: Number.MAX_SAFE_INTEGER,
    total_bytes: Number.MAX_SAFE_INTEGER,
    ...(reference ? { reference } : {}),
    eof: false,
    data: '',
    next_cursor: {
      tool: 'capability:read',
      args: { file_path: absPath, byte_offset: Number.MAX_SAFE_INTEGER, byte_limit: MAX_BYTE_PAGE },
    },
  }).length;
  // Mirrors how RESULT_DOOR_TOKENS is derived (result-door.ts): the BAKED floor
  // door. A session configured with a WIDER door just gets smaller pages than it
  // strictly needs, which is safe; sizing to a wider door would not be.
  const budgetChars = computeTurnDoors(0).resultEach * CHARS_PER_TOKEN_ESTIMATE;
  const room = budgetChars - envelopeChars - DOOR_MARGIN_CHARS;
  const fits = Math.floor(Math.max(0, room) / 4) * 3;
  return Math.min(requestedBytes, fits);
}

/** Scratch references are returned unchanged by tools:invoke, so an oversized
 * line view would spill into another scratch reference and repeat the same read.
 * Leave the same envelope slack used by byte pages before allowing a text window. */
function scratchLineWindowExceedsDoor(text: string): boolean {
  const budgetBytes = computeTurnDoors(0).resultEach * CHARS_PER_TOKEN_ESTIMATE;
  return Buffer.byteLength(text, 'utf8') > budgetBytes - DOOR_MARGIN_CHARS;
}

const readPathArgs = {
  file_path: z.string().min(1).optional().describe('Absolute path, ~/-relative, or relative to the project dir.'),
  uri: z.string().min(1).optional().describe('A papercusp://scratch URI alias for file_path, as emitted by result-door cursors.'),
};

const lineWindowArgs = z.object({
  ...readPathArgs,
  offset: z.number().int().nonnegative().optional().describe(
    `1-based line to start from. ${SCRATCH_LINE_WINDOW_SIZE_NOTE} ${LINE_WINDOW_EXCLUSIVITY}`,
  ),
  limit: z.number().int().positive().optional().describe(
    `Max lines to read (default ${DEFAULT_LIMIT}). ${SCRATCH_LINE_WINDOW_SIZE_NOTE} ${LINE_WINDOW_EXCLUSIVITY}`,
  ),
  tail: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      `Read the LAST N lines instead of reading forward — the \`tail -n N\` equivalent. Ignores offset. ${SCRATCH_LINE_WINDOW_SIZE_NOTE} ${LINE_WINDOW_EXCLUSIVITY}`,
    ),
  raw: z
    .boolean()
    .optional()
    .describe('Return the selected text window without the path header, line-number prefixes, or paging footer. Use when the result will be written back. Raw text windows are mutually exclusive with byte windows (byte_offset, byte_limit).'),
  byte_offset: z.never().optional().describe(`Only valid for byte windows. ${BYTE_WINDOW_EXCLUSIVITY}`),
  byte_limit: z.never().optional().describe(`Only valid for byte windows. ${BYTE_WINDOW_EXCLUSIVITY}`),
  content_indexes: z.never().optional().describe(`Only valid for content-index selection. ${CONTENT_INDEX_EXCLUSIVITY}`),
  evidence_class: z.never().optional().describe(`Only valid for evidence-class selection. ${EVIDENCE_CLASS_EXCLUSIVITY}`),
});

const byteWindowArgs = z.object({
  ...readPathArgs,
  offset: z.never().optional().describe(`Only valid for line windows. ${LINE_WINDOW_EXCLUSIVITY}`),
  limit: z.never().optional().describe(`Only valid for line windows. ${LINE_WINDOW_EXCLUSIVITY}`),
  tail: z.never().optional().describe(`Only valid for line windows. ${LINE_WINDOW_EXCLUSIVITY}`),
  // Keep this field parseable so callers that accidentally combine modes reach
  // the handler's explicit `mixed_window_modes` diagnostic instead of Zod's
  // opaque `expected never` error at the transport boundary.
  raw: z.boolean().optional().describe('Raw text windows are mutually exclusive with byte windows (byte_offset, byte_limit).'),
  byte_offset: z.number().int().nonnegative().describe(`0-based byte offset for an exact base64 page. Use with byte_limit. ${BYTE_WINDOW_EXCLUSIVITY}`),
  byte_limit: z
    .number()
    .int()
    .positive()
    .max(MAX_BYTE_PAGE)
    .describe(
      `Bytes to return as base64 (max ${MAX_BYTE_PAGE}), an UPPER BOUND — the page is clamped to ` +
        `fit the result door, so read byte_length and follow next_cursor. Use with byte_offset. ${BYTE_WINDOW_EXCLUSIVITY}`,
    ),
  content_indexes: z.never().optional().describe(`Only valid for content-index selection. ${CONTENT_INDEX_EXCLUSIVITY}`),
  evidence_class: z.never().optional().describe(`Only valid for evidence-class selection. ${EVIDENCE_CLASS_EXCLUSIVITY}`),
});

const contentIndexArgs = z.object({
  ...readPathArgs,
  offset: z.never().optional().describe(`Only valid for line windows. ${LINE_WINDOW_EXCLUSIVITY}`),
  limit: z.never().optional().describe(`Only valid for line windows. ${LINE_WINDOW_EXCLUSIVITY}`),
  tail: z.never().optional().describe(`Only valid for line windows. ${LINE_WINDOW_EXCLUSIVITY}`),
  raw: z.boolean().optional().describe('Return the selected content items without altering the stable reference selection.'),
  byte_offset: z.never().optional().describe(`Only valid for byte windows. ${BYTE_WINDOW_EXCLUSIVITY}`),
  byte_limit: z.never().optional().describe(`Only valid for byte windows. ${BYTE_WINDOW_EXCLUSIVITY}`),
  content_indexes: z
    .array(z.number().int().nonnegative())
    .min(1)
    .max(64)
    .describe(`For a stable result-door reference whose payload contains an MCP content array, return only these item indexes. The dispatch-level projection can then pick fields from the selected result. ${CONTENT_INDEX_EXCLUSIVITY}`),
  evidence_class: z.never().optional().describe(`Only valid for evidence-class selection. ${EVIDENCE_CLASS_EXCLUSIVITY}`),
});

const evidenceClassArgs = z.object({
  ...readPathArgs,
  offset: z.never().optional().describe(`Only valid for line windows. ${LINE_WINDOW_EXCLUSIVITY}`),
  limit: z.never().optional().describe(`Only valid for line windows. ${LINE_WINDOW_EXCLUSIVITY}`),
  tail: z.never().optional().describe(`Only valid for line windows. ${LINE_WINDOW_EXCLUSIVITY}`),
  raw: z.boolean().optional().describe('Return the selected evidence values without altering the stable reference selection.'),
  byte_offset: z.never().optional().describe(`Only valid for byte windows. ${BYTE_WINDOW_EXCLUSIVITY}`),
  byte_limit: z.never().optional().describe(`Only valid for byte windows. ${BYTE_WINDOW_EXCLUSIVITY}`),
  content_indexes: z.never().optional().describe(`Only valid for content-index selection. ${CONTENT_INDEX_EXCLUSIVITY}`),
  evidence_class: z.enum(OUTPUT_EVIDENCE_CLASSES).describe(
    `For a stable result-door reference with a JSON MCP content envelope, resolve only the values indexed for this evidence class. ${EVIDENCE_CLASS_EXCLUSIVITY}`,
  ),
});

/**
 * Keep the mutually exclusive read modes in the published JSON Schema as well
 * as in runtime validation. A single optional object plus superRefine only
 * describes the conflict in prose; callers then discover it after dispatch.
 * The `z.never().optional()` fields emit the `not` constraints that make each
 * anyOf branch reject the other window modes.
 */
const readArgs = z.union([lineWindowArgs, byteWindowArgs, contentIndexArgs, evidenceClassArgs]);

/**
 * The handler has two intentional response paths: human-readable MCP text and a
 * code-mode structured twin. The twin is heterogeneous because the same tool
 * also pages bytes and selects content/evidence from scratch references. Keep
 * every branch's stable root field optional and leave room for branch-specific
 * diagnostics; a closed schema would reject a truthful mode-specific result.
 * `body` is deliberately the code-mode text field (not `content`/`text`, which
 * are reserved for the MCP envelope and caused the original facade mismatch).
 */
const capabilityReadResultSchema = z
  .object({
    ok: z.boolean(),
    file_path: z.string().optional(),
    body: z.string().optional(),
    total_lines: z.number().int().nonnegative().optional(),
    start_line: z.number().int().positive().nullable().optional(),
    end_line: z.number().int().positive().nullable().optional(),
    has_more: z.boolean().optional(),
    encoding: z.string().optional(),
    byte_offset: z.number().int().nonnegative().optional(),
    byte_length: z.number().int().nonnegative().optional(),
    total_bytes: z.number().int().nonnegative().optional(),
    data: z.string().optional(),
    eof: z.boolean().optional(),
    next_cursor: z
      .object({
        tool: z.string(),
        args: z.record(z.string(), z.unknown()),
      })
      .passthrough()
      .nullable()
      .optional(),
    reference: z.record(z.string(), z.unknown()).optional(),
    evidence_class: z.string().optional(),
    evidence: z.array(z.unknown()).optional(),
    selected_indexes: z.array(z.number().int().nonnegative()).optional(),
    total_content_items: z.number().int().nonnegative().optional(),
    content: z.array(z.unknown()).optional(),
    isError: z.boolean().optional(),
    reason: z.string().optional(),
    message: z.string().optional(),
  })
  .passthrough();

type LineReadArgs = {
  offset?: number;
  limit?: number;
  tail?: number;
  raw?: boolean;
};

type ByteReadArgs = LineReadArgs & {
  byte_offset?: number;
  byte_limit?: number;
};

type ReadContext = {
  codeMode?: boolean;
  transport?: string;
  requestedStructured?: boolean;
};

type SelectedLine = { line: string; index: number };

type LargeLineWindow = {
  slice: SelectedLine[];
  start: number;
  totalLines: number;
  endedWithNewline: boolean;
};

/**
 * Large logs must not be loaded into one Buffer just to answer a bounded read.
 * Keep only the requested line window while counting the source lines needed by
 * the existing numbered/header/footer response contract.
 */
async function readLargeLineWindow(
  abs: string,
  args: LineReadArgs,
  credentialBearingConfig: boolean,
): Promise<LargeLineWindow> {
  const limit = args.limit ?? DEFAULT_LIMIT;
  const tailLimit = args.tail === undefined ? undefined : Math.min(args.tail, limit);
  const offset = args.offset && args.offset > 0 ? args.offset - 1 : 0;
  const selected: SelectedLine[] = [];
  let pending = '';
  let totalLines = 0;
  let sawBytes = false;

  const consumeLine = (sourceLine: string) => {
    const line = credentialBearingConfig ? redactSensitiveText(sourceLine) : sourceLine;
    const index = totalLines;
    totalLines += 1;
    if (tailLimit !== undefined) {
      selected.push({ line, index });
      if (selected.length > tailLimit) selected.shift();
      return;
    }
    if (index >= offset && index < offset + limit) selected.push({ line, index });
  };

  const decoder = new StringDecoder('utf8');
  const stream = createReadStream(abs);
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      sawBytes = sawBytes || buffer.length > 0;
      const parts = (pending + decoder.write(buffer)).split('\n');
      pending = parts.pop() ?? '';
      for (const line of parts) consumeLine(line);
    }
    pending += decoder.end();
  } finally {
    stream.destroy();
  }

  if (pending.length > 0) consumeLine(pending);

  const start = tailLimit === undefined
    ? offset
    : Math.max(0, totalLines - tailLimit);
  return {
    slice: selected,
    start,
    totalLines,
    endedWithNewline: sawBytes && pending.length === 0,
  };
}

/** Read one exact byte page without materializing the rest of a large file. */
function readBytePage(abs: string, offset: number, limit: number): Buffer {
  const fd = openSync(abs, 'r');
  try {
    const page = Buffer.alloc(limit);
    let bytesRead = 0;
    while (bytesRead < limit) {
      const count = readSync(fd, page, bytesRead, limit - bytesRead, offset + bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }
    return page.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

/**
 * A large scratch reference cannot be authorized by loading its whole payload.
 * Detect its magic prefix and fail closed before a streaming line read could
 * expose an owner/workspace-scoped payload as ordinary text.
 */
function startsWithScratchReference(abs: string): boolean {
  const magic = Buffer.from(SCRATCH_REFERENCE_MAGIC, 'utf8');
  let fd: number | undefined;
  try {
    fd = openSync(abs, 'r');
    const prefix = Buffer.alloc(magic.length);
    const count = readSync(fd, prefix, 0, magic.length, 0);
    return count === magic.length && prefix.equals(magic);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function renderByteWindow(
  abs: string,
  args: ByteReadArgs,
  totalBytes: number,
  readPage: (offset: number, limit: number) => Buffer,
  reference?: ScratchReferenceManifest,
) {
  const effectiveLimit = doorSafePageBytes(abs, args.byte_limit!, reference);
  // A caller asking for a deliberately small page (for example, 256 bytes
  // from a result-door cursor) has already accepted the extra hops. Do not
  // reject it merely because the absolute scratch path leaves less than the
  // normal efficiency floor. Keep refusing a normal-sized request whose fitted
  // page would be sub-floor, and always refuse when no byte fits.
  const noPositivePageFits = effectiveLimit <= 0;
  const normalRequestWouldBeSubFloor = args.byte_limit! >= MIN_PAGE_BYTES && effectiveLimit < MIN_PAGE_BYTES;
  if (noPositivePageFits || normalRequestWouldBeSubFloor) {
    return err(
      'path_too_long_for_byte_window',
      `${abs} is too long a path to page by bytes: its envelope leaves room for only ` +
      `${Math.max(0, effectiveLimit)} bytes per response. Read it by lines (offset/limit/tail), ` +
      `or reach it via a shorter path.`,
    );
  }
  const start = Math.min(args.byte_offset!, totalBytes);
  const page = readPage(start, effectiveLimit);
  const nextOffset = start + page.length;
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        ok: true,
        file_path: abs,
        encoding: 'base64',
        byte_offset: start,
        byte_length: page.length,
        total_bytes: totalBytes,
        ...(reference ? { reference } : {}),
        eof: nextOffset >= totalBytes,
        data: page.toString('base64'),
        next_cursor: nextOffset < totalBytes
          ? { tool: 'capability:read', args: { file_path: abs, byte_offset: nextOffset, byte_limit: effectiveLimit } }
          : null,
      }),
    }],
  };
}

function renderLargeLineWindow(
  abs: string,
  args: LineReadArgs,
  ctx: ReadContext,
  window: LargeLineWindow,
) {
  const { slice, start, totalLines } = window;
  if (args.raw) {
    if (slice.length === 0) {
      return {
        content: [{ type: 'text' as const, text: '' }],
        ...(ctx.codeMode || (ctx.transport === 'mcp' && ctx.requestedStructured)
          ? { structuredContent: { ok: true, file_path: abs, body: '' } }
          : {}),
      };
    }
    const end = start + slice.length;
    const rawBody = slice.map(({ line }) => line).join('\n') +
      (end < totalLines || (end === totalLines && window.endedWithNewline) ? '\n' : '');
    return {
      content: [{ type: 'text' as const, text: rawBody }],
      ...(ctx.codeMode || (ctx.transport === 'mcp' && ctx.requestedStructured)
        ? { structuredContent: { ok: true, file_path: abs, body: rawBody } }
        : {}),
    };
  }

  const numbered = slice
    .map(({ line, index }) => {
      const truncated = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}… [line truncated]` : line;
      return `${String(index + 1).padStart(6)}\t${truncated}`;
    })
    .join('\n');
  const more = start + slice.length < totalLines;
  const footer = more
    ? `\n\n… [${totalLines - (start + slice.length)} more lines — re-read with offset=${start + slice.length + 1}]`
    : '';
  const head = `${abs} (${totalLines} lines${start > 0 || more ? `, showing ${start + 1}–${start + slice.length}` : ''})\n`;
  return {
    content: [{ type: 'text' as const, text: slice.length === 0 ? `${head}(empty)` : head + numbered + footer }],
    ...(ctx.codeMode || (ctx.transport === 'mcp' && ctx.requestedStructured)
      ? {
          structuredContent: {
            ok: true,
            file_path: abs,
            body: slice.map(({ line }) => line).join('\n'),
            total_lines: totalLines,
            start_line: slice.length === 0 ? null : start + 1,
            end_line: slice.length === 0 ? null : start + slice.length,
            has_more: more,
          },
        }
      : {}),
  };
}

export default defineTool({
  name: 'capability:read',
  description:
    'Read a file with line-numbered text windows, exact undecorated text windows (raw:true), or exact resumable byte pages. offset/limit window lines; tail:N reads the last N lines. byte_offset+byte_limit returns base64 bytes with a next cursor, including for a single very long line. Credential-bearing config/auth files are redacted for ordinary line reads and refuse exact/raw/byte/structured modes. Path is absolute, ~/-relative, relative to the project dir, or a papercusp://scratch URI.',
  guidance: {
    when: 'Read a source/text file before editing it, or inspect content. Use offset+limit for line pages, tail:N for a log tail, raw:true when passing text to capability:write/edit, and byte_offset+byte_limit when exact resumable bytes matter or the file may be one long line.',
    notWhen: 'To run a command, use capability:bash. To search across files, use capability:bash with grep/rg.',
    chaining: 'capability:read → capability:edit (exact string replace) or capability:write (overwrite).',
    returns:
      'Across line/raw, byte-page, content/evidence-selection, and error branches: { ok, file_path?, body?, total_lines?, start_line?, end_line?, has_more?, encoding?, byte_offset?, byte_length?, total_bytes?, data?, eof?, next_cursor?, reference?, evidence_class?, evidence?, selected_indexes?, total_content_items?, content?, isError?, reason?, message? }. In code mode, line/raw reads put undecorated text in `body` (not MCP envelope `content`/`text`); byte pages put exact base64 in `data` and expose `next_cursor`.',
    seeAlso: capabilityReadSeeAlso,
  },
  capability: 'capability:fs-read',
  requirePrincipal: false,
  // Evidence-only acceptance judges may read cited files, but remain outside every
  // fs-write/bash tool allowlist and capability grant.
  agentRoles: [...AGENT_ROLES, 'judge'],
  args: readArgs,
  result: capabilityReadResultSchema,
  async handler(args, ctx) {
    const filePath = args.file_path ?? args.uri;
    if (!filePath) return err('missing_path', 'file_path or uri must be supplied.');

    let abs: string;
    try {
      const baseDir = selectCapabilityReadBaseDir(filePath, resolveCapabilityBaseDir(ctx));
      abs = resolveReadPath(filePath, baseDir);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return err('invalid_path', msg);
    }

    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(abs);
      if (stat.isDirectory()) return err('is_a_directory', `${abs} is a directory. List it with capability:list.`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return err('read_failed', msg);
    }

    const credentialBearingConfig = isCredentialBearingConfigPath(abs);
    const exactReadRequested =
      args.raw === true ||
      args.byte_offset !== undefined ||
      args.byte_limit !== undefined ||
      args.content_indexes !== undefined ||
      args.evidence_class !== undefined;
    if (credentialBearingConfig && exactReadRequested) {
      return err(
        'sensitive_file',
        'exact, raw, byte, and structured reads are refused for credential-bearing config files; use an ordinary line read, which redacts secret values.',
      );
    }

    const byteMode = args.byte_offset !== undefined || args.byte_limit !== undefined;
    const boundedLineRead = args.offset !== undefined || args.limit !== undefined || args.tail !== undefined;
    if (stat.size > MAX_FILE_BYTES) {
      if (startsWithScratchReference(abs)) {
        return err(
          'too_large',
          `${abs} is a large scratch reference; use its emitted reference cursor instead of reading the container as a plain file.`,
        );
      }
      try {
        if (byteMode) {
          if (args.byte_offset === undefined || args.byte_limit === undefined) {
            return err('invalid_byte_window', 'byte_offset and byte_limit must be supplied together.');
          }
          if (args.offset !== undefined || args.limit !== undefined || args.tail !== undefined) {
            return err('mixed_window_modes', 'byte_offset/byte_limit cannot be combined with offset/limit/tail.');
          }
          if (args.raw) {
            return err('mixed_window_modes', 'raw text windows cannot be combined with byte_offset/byte_limit; byte windows already return exact bytes.');
          }
          return renderByteWindow(
            abs,
            args as ByteReadArgs,
            stat.size,
            (offset, limit) => readBytePage(abs, offset, limit),
          );
        }
        if (boundedLineRead) {
          return renderLargeLineWindow(
            abs,
            args as LineReadArgs,
            ctx as ReadContext,
            await readLargeLineWindow(abs, args as LineReadArgs, credentialBearingConfig),
          );
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return err('read_failed', msg);
      }
      return err('too_large', `${abs} is ${stat.size} bytes (> ${MAX_FILE_BYTES}). Read a bounded slice with capability:read (offset/limit/tail) or capability:bash.`);
    }

    let bytes: Buffer;
    try {
      bytes = readFileSync(abs);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return err('read_failed', msg);
    }

    let reference: ScratchReferenceManifest | undefined;
    try {
      const parsed = parseScratchReference(bytes);
      if (parsed) {
        reference = parsed.manifest;
        let ownerId: string | null = null;
        if (reference.audience === 'owner') {
          try {
            // The result door writes signed role-session spills under the
            // HMAC-verified client id. Tool dispatch can subsequently install
            // a synthesized role principal (system:judge, etc.); resolving
            // that principal here would name a different owner and reject the
            // creator's own spill. Only a verified signed spawn may bypass
            // the synthesized principal, never an unsigned client id.
            const identityCtx = ctx as ResolveIdentityCtx;
            ownerId = resolveAgentIdentity(
              identityCtx.sigVerifiedSpawn &&
              !identityCtx.isSuperuser &&
              !identityCtx.isPowerUser &&
              identityCtx.uiClientId
                ? { ...identityCtx, principal: undefined }
                : identityCtx,
            ).ownerId;
          } catch {
            ownerId = null;
          }
        }
        authorizeScratchReference(reference, {
          workspaceId: ctx.workspaceId ?? ctx.principal?.workspaceId ?? null,
          ownerId,
        });
        bytes = parsed.payload;
      }
    } catch (e: unknown) {
      if (e instanceof ScratchReferenceError) return err(e.code, e.message);
      return err('invalid_reference', e instanceof Error ? e.message : String(e));
    }

    if (args.evidence_class) {
      if (args.content_indexes || args.byte_offset !== undefined || args.byte_limit !== undefined || args.offset !== undefined || args.limit !== undefined || args.tail !== undefined) {
        return err('mixed_window_modes', 'evidence_class cannot be combined with content, line, or byte windows.');
      }
      if (!reference) return err('not_a_reference', 'evidence_class requires a stable scratch reference.');
      const selectors = (reference.evidence ?? []).filter((entry) => entry.evidenceClass === args.evidence_class);
      if (selectors.length === 0) return err('evidence_class_not_found', `scratch reference has no ${args.evidence_class} evidence.`);
      let decoded: unknown;
      try { decoded = JSON.parse(bytes.toString('utf8')); }
      catch {
        return err(
          'evidence_not_selectable',
          'scratch reference payload is not JSON. Use line or byte windows for text or Markdown spills.',
        );
      }
      const row = decoded && typeof decoded === 'object' ? decoded as Record<string, unknown> : null;
      const content = row?.content;
      if (!Array.isArray(content)) return err('evidence_not_selectable', 'scratch reference payload has no MCP content array.');
      const resolvePointer = (value: unknown, pointer: string): unknown => pointer.split('/').slice(1).reduce<unknown>((cursor, segment) => {
        if (cursor === null || typeof cursor !== 'object') return undefined;
        return (cursor as Record<string, unknown>)[segment.replace(/~1/g, '/').replace(/~0/g, '~')];
      }, value);
      const evidence = selectors.flatMap((selector) => {
        const item = content[selector.contentIndex] as { text?: unknown } | undefined;
        if (!item || typeof item.text !== 'string') return [];
        let parsed: unknown;
        try { parsed = JSON.parse(item.text); } catch { return []; }
        return selector.jsonPointers.map((jsonPointer) => ({
          contentIndex: selector.contentIndex,
          jsonPointer,
          value: resolvePointer(parsed, jsonPointer),
        }));
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify({
        ok: true, file_path: abs, reference, evidence_class: args.evidence_class, evidence,
      }) }] };
    }

    if (args.content_indexes) {
      if (args.byte_offset !== undefined || args.byte_limit !== undefined || args.offset !== undefined || args.limit !== undefined || args.tail !== undefined) {
        return err('mixed_window_modes', 'content_indexes cannot be combined with line or byte windows.');
      }
      if (!reference) return err('not_a_reference', 'content_indexes requires a stable scratch reference.');
      let decoded: unknown;
      try {
        decoded = JSON.parse(bytes.toString('utf8'));
      } catch {
        return err('content_not_selectable', 'scratch reference payload is not JSON. Use line or byte windows.');
      }
      const row = decoded && typeof decoded === 'object' ? decoded as Record<string, unknown> : null;
      const content = row?.content;
      if (!row || !Array.isArray(content)) {
        return err('content_not_selectable', 'scratch reference payload has no MCP content array.');
      }
      const unique = [...new Set(args.content_indexes)];
      const invalid = unique.filter((index) => index >= content.length);
      if (invalid.length > 0) {
        return err('content_index_out_of_range', `content index(es) ${invalid.join(', ')} exceed ${content.length - 1}.`);
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          ok: true,
          file_path: abs,
          reference,
          selected_indexes: unique,
          total_content_items: content.length,
          content: unique.map((index) => content[index]),
          ...(row.isError !== undefined ? { isError: row.isError } : {}),
        }) }],
      };
    }

    if (byteMode) {
      if (args.byte_offset === undefined || args.byte_limit === undefined) {
        return err('invalid_byte_window', 'byte_offset and byte_limit must be supplied together.');
      }
      if (args.offset !== undefined || args.limit !== undefined || args.tail !== undefined) {
        return err('mixed_window_modes', 'byte_offset/byte_limit cannot be combined with offset/limit/tail.');
      }
      if (args.raw) {
        return err('mixed_window_modes', 'raw text windows cannot be combined with byte_offset/byte_limit; byte windows already return exact bytes.');
      }
      return renderByteWindow(
        abs,
        args as ByteReadArgs,
        bytes.length,
        (offset, limit) => bytes.subarray(offset, Math.min(bytes.length, offset + limit)),
        reference,
      );
    }

    const sourceText = bytes.toString('utf8');
    // Redact the complete source before selecting a line window. A secret near
    // a window boundary must not survive merely because the caller requested a
    // narrow diagnostic slice.
    const text = credentialBearingConfig ? redactSensitiveText(sourceText) : sourceText;

    const allLines = text.split('\n');
    // A trailing newline yields a final empty element; drop it so line counts match the file.
    if (allLines.length > 0 && allLines[allLines.length - 1] === '') allLines.pop();

    const limit = args.limit ?? DEFAULT_LIMIT;
    // `tail` addresses the END of the file, which offset (anchored at line 1)
    // cannot reach without first knowing the line count. The 2026-07-26 bash
    // audit found this was the single largest un-substitutable file read:
    // 1,752 `tail -n N FILE` atoms across 63 sessions had no tool form at all.
    const start = args.tail
      ? Math.max(0, allLines.length - args.tail)
      : args.offset && args.offset > 0
        ? args.offset - 1
        : 0;
    const slice = allLines.slice(start, start + (args.tail ? Math.min(args.tail, limit) : limit));

    if (args.raw) {
      if (slice.length === 0) {
        return {
          content: [{ type: 'text' as const, text: '' }],
          // EI-22044192752243601: ordinary/raw text reads return a plain string
          // `text` body, not JSON — unwrapToolResult's JSON.parse throws on it and
          // hands a code:run script the raw STRING primitive. A primitive is not a
          // container, so run-script.ts's field-miss Proxy never wraps it either:
          // `.content` / `.text` property access on that string silently resolves
          // to `undefined`, with NO fieldMiss diagnostic and NO thrown error — the
          // exact silent-clobber shape this bug report is about. Attach the same
          // data as a real object for code-mode, same pattern as capability:bash.
          // `body` (never `content`/`text`) deliberately avoids run-script.ts's
          // ROOT_ENVELOPE_FIELDS — those two names are reserved to make a script's
          // envelope-shaped guess THROW a loud structured_result_shape error
          // instead of returning undefined; reusing either name here would let
          // that exact guess silently "succeed" against the wrong field again.
          ...(ctx.codeMode || (ctx.transport === 'mcp' && ctx.requestedStructured)
            ? { structuredContent: { ok: true, file_path: abs, body: '' } }
            : {}),
        };
      }

      // Reconstruct the exact source span rather than joining a normalized
      // array. This preserves the source's trailing newline (or lack of one)
      // while still honoring offset/limit/tail line windows.
      const startOffset = allLines
        .slice(0, start)
        .reduce((offset, line) => offset + line.length + 1, 0);
      const selected = slice.join('\n');
      const endOffset = startOffset + selected.length;
      const hasSourceNewline = text[endOffset] === '\n';
      const rawBody = text.slice(startOffset, endOffset + (hasSourceNewline ? 1 : 0));
      if (reference && scratchLineWindowExceedsDoor(rawBody)) {
        return err(
          'scratch_line_window_too_large',
          'This scratch-reference line window is too large for one result. Use a smaller offset/limit/tail window, or byte_offset+byte_limit when a single line is too large.',
        );
      }
      return {
        content: [{
          type: 'text' as const,
          text: rawBody,
        }],
        // EI-22044192752243601 — see the empty-slice branch above for why.
        ...(ctx.codeMode || (ctx.transport === 'mcp' && ctx.requestedStructured)
          ? { structuredContent: { ok: true, file_path: abs, body: rawBody } }
          : {}),
      };
    }

    const numbered = slice
      .map((line, i) => {
        const n = start + i + 1;
        const truncated = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}… [line truncated]` : line;
        return `${String(n).padStart(6)}\t${truncated}`;
      })
      .join('\n');

    const more = start + slice.length < allLines.length;
    const footer = more
      ? `\n\n… [${allLines.length - (start + slice.length)} more lines — re-read with offset=${start + slice.length + 1}]`
      : '';
    const head = `${abs} (${allLines.length} lines${start > 0 || more ? `, showing ${start + 1}–${start + slice.length}` : ''})\n`;
    const displayText = slice.length === 0 ? `${head}(empty)` : head + numbered + footer;
    if (reference && scratchLineWindowExceedsDoor(displayText)) {
      return err(
        'scratch_line_window_too_large',
        'This scratch-reference line window is too large for one result. Use a smaller offset/limit/tail window, or byte_offset+byte_limit when a single line is too large.',
      );
    }

    return {
      content: [{ type: 'text' as const, text: displayText }],
      // EI-22044192752243601: same silent-primitive-fallback bug as the raw branch
      // above — the ordinary cat -n view is human/model-readable text, not JSON, so
      // a code:run script reading `.content`/`.text` off it got `undefined` with no
      // diagnostic. `body` carries the UNDECORATED text (no line-number prefixes,
      // no header/footer) since that is what a script processing file content
      // wants, not the display formatting. Field names avoid `content`/`text`
      // (run-script.ts ROOT_ENVELOPE_FIELDS) for the same reason as the raw branch.
      ...(ctx.codeMode || (ctx.transport === 'mcp' && ctx.requestedStructured)
        ? {
            structuredContent: {
              ok: true,
              file_path: abs,
              body: slice.join('\n'),
              total_lines: allLines.length,
              start_line: slice.length === 0 ? null : start + 1,
              end_line: slice.length === 0 ? null : start + slice.length,
              has_more: more,
            },
          }
        : {}),
    };
  },
});

/**
 * Resolve a caller-supplied path to an absolute one.
 *
 * `~/…` must be expanded explicitly: it is a SHELL feature, so Node sees it as
 * a relative path and `resolve(baseDir, '~/x')` silently yields
 * `<projectDir>/~/x` — a file that does not exist, reported as a confusing
 * read_failed rather than as the home-relative read the caller meant. The
 * 2026-07-26 bash audit caught this against real commands (`cat ~/.papercusp/…`,
 * `head -40 ~/mac-verify-build-waiter.sh`).
 */
export function resolveReadPath(filePath: string, baseDir: string): string {
  if (filePath.startsWith(`${SCRATCH_SCHEME}/`)) return safeScratchFilesystemPath(filePath);
  if (filePath.startsWith('papercusp://')) {
    throw new Error(`unsupported URI scheme; expected ${SCRATCH_SCHEME}/…`);
  }
  if (filePath === '~') return homedir();
  if (filePath.startsWith('~/')) return resolve(homedir(), filePath.slice(2));
  return isAbsolute(filePath) ? filePath : resolve(baseDir, filePath);
}

type CapabilityReadRootSource = 'project-dir' | 'integration-root';

/**
 * Recover a project-relative read from a phantom harness root without weakening
 * the loud `read_failed` contract.
 *
 * The caller's project dir remains authoritative whenever the requested path
 * exists there. Only a path that is absent from that tree may use the explicitly
 * published canonical integration checkout, and only when the same relative path
 * exists there. Absolute, home-relative, and URI paths bypass this lattice because
 * their own addressing contract is already unambiguous.
 */
export function selectCapabilityReadBaseDir(
  filePath: string,
  preferredBaseDir: string,
  integrationRoot = resolveCapabilityIntegrationRoot(),
): string {
  if (!isProjectRelativeReadPath(filePath) || !integrationRoot) return preferredBaseDir;

  const selected = selectUnambiguousEvidenceRoot<CapabilityReadRootSource>({
    preferred: { root: preferredBaseDir, source: 'project-dir' },
    fallback: { root: integrationRoot, source: 'integration-root' },
    resolvesEvery: (root) => existsSync(resolve(root, filePath)),
  });
  return selected?.root ?? preferredBaseDir;
}

function isProjectRelativeReadPath(filePath: string): boolean {
  return (
    !isAbsolute(filePath) &&
    filePath !== '~' &&
    !filePath.startsWith('~/') &&
    !filePath.includes('://')
  );
}

function err(reason: string, message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, reason, message }) }],
    isError: true,
  };
}
