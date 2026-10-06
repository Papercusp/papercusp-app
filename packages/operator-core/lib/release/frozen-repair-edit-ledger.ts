/**
 * P-019 / P-020 (frozen-candidate-stays-frozen-through-all-fixes-2026-09-03, D-008): the edit
 * ledger — the ONLY attribution that works on a git-sync'd shared tree.
 *
 * THE PROBLEM (D-008). Path-exact admission guarantees no OTHER file enters the judged
 * lineage; it cannot guarantee a named file's blob is pure. Two agents routinely edit the
 * same file for unrelated reasons, so staging's blob of a path at admission time can carry
 * the fix AND a stranger's half-finished work. `git blame` and commit subjects are
 * meaningless here (one sweep identity, one subject per sweep — CLAUDE.md), so the only
 * moment a hunk CAN be attributed is when the PostToolUse hook sees it being made.
 *
 * THIS MODULE is the pure core + the two PG verbs:
 *   - `hunksFromToolCall`  — the hook-side extraction (Edit / Write / MultiEdit / the
 *                            capability_* twins / Codex write_file / apply_patch) → one hunk per edit.
 *   - `boundHunk`          — the size cap: an oversize hunk is recorded as attribution only
 *                            (sha + bytes) and can never be replayed hunk-exactly.
 *   - `recordFrozenRepairEdit` / `readFrozenRepairEditLedger` — the PG write/read, keyed by
 *                            (workspace, install, candidate). Idempotent on
 *                            (agent, path, toolUseId, editIndex).
 *   - `replayFrozenRepairHunks` — P-020's replay: apply ONE agent's hunks, in order, onto
 *                            repairHead's blob; a hunk whose `old` is not found is a
 *                            `hunk-conflict` (the fix depends on a foreign change).
 *
 * Nothing here reads the marker file or talks to the hook: the hook posts through
 * `release:repair-queue { op:'record-edit' }`, so the identity the row carries is the SAME
 * per-session owner the lock hook and the agent's own tool calls resolve to.
 */
import { createHash } from 'node:crypto';
import { normalizeRepoPath } from './frozen-candidate-repair-queue';

/** JSON bytes above which a hunk is recorded as attribution-only (`kind:'oversize'`). */
export const FROZEN_REPAIR_EDIT_HUNK_CAP_BYTES = 512 * 1024;

export type FrozenRepairEditHunk =
  | { kind: 'edit'; old: string; new: string; replaceAll: boolean }
  | { kind: 'write'; body: string }
  | { kind: 'oversize'; of: 'edit' | 'write'; bytes: number; sha256: string };

export interface FrozenRepairEditExtract {
  /** The path exactly as the client supplied it (absolute or relative) — the caller normalizes. */
  path: string;
  hunk: FrozenRepairEditHunk;
  /** Position within a MultiEdit (0 for single-edit tools). */
  editIndex: number;
}

/** postgres.js-compatible slice: the one method both the tool and a test double provide. */
export interface FrozenRepairLedgerSql {
  unsafe(query: string, params?: unknown[]): Promise<unknown>;
}

export interface FrozenRepairEditRecordInput {
  workspaceId: string;
  installSlug: string;
  candidate: string;
  agent: string;
  /** Repo-relative (normalized here again — a wrong-shaped path is refused, never guessed). */
  path: string;
  hunk: FrozenRepairEditHunk;
  atMs: number;
  toolUseId: string;
  editIndex?: number;
  workItem?: string | null;
}

export interface FrozenRepairEditLedgerRow {
  id: number;
  candidate: string;
  agent: string;
  path: string;
  hunk: FrozenRepairEditHunk;
  atMs: number;
  toolUseId: string;
  editIndex: number;
  workItem: string | null;
}

export type FrozenRepairEditRecordOutcome =
  | { ok: true; id: number | null; inserted: boolean; oversize: boolean; /** The normalized repo-relative path actually stored. */ path: string }
  | { ok: false; reason: 'invalid-path' | 'invalid-hunk' | 'invalid-agent' | 'invalid-candidate'; detail: string };

function sha256Of(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Stable JSON so the idempotency hash does not depend on key order. */
export function hunkSha256(hunk: FrozenRepairEditHunk): string {
  if (hunk.kind === 'oversize') return hunk.sha256;
  const canonical =
    hunk.kind === 'edit'
      ? JSON.stringify({ kind: 'edit', old: hunk.old, new: hunk.new, replaceAll: hunk.replaceAll })
      : JSON.stringify({ kind: 'write', body: hunk.body });
  return sha256Of(canonical);
}

function hunkJsonBytes(hunk: FrozenRepairEditHunk): number {
  return Buffer.byteLength(JSON.stringify(hunk), 'utf8');
}

/**
 * The size cap. A hunk above the cap keeps its attribution (who touched the path, when) and
 * its content hash, but its content is dropped: P-020 then refuses hunk-exact admission for
 * that path and names `wholeBlob:true, reason` as the explicit exit — never a silent guess.
 */
export function boundHunk(
  hunk: FrozenRepairEditHunk,
  capBytes: number = FROZEN_REPAIR_EDIT_HUNK_CAP_BYTES,
): FrozenRepairEditHunk {
  if (hunk.kind === 'oversize') return hunk;
  const bytes = hunkJsonBytes(hunk);
  if (bytes <= capBytes) return hunk;
  return { kind: 'oversize', of: hunk.kind, bytes, sha256: hunkSha256(hunk) };
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/**
 * Hook-side extraction. Mirrors the PreToolUse lock hook's documented stdin shapes:
 *   Claude   Edit      { file_path, old_string, new_string, replace_all? }
 *            Write     { file_path, content }
 *            MultiEdit { file_path, edits:[{ old_string, new_string, replace_all? }] }
 *   MCP      mcp__*__capability_edit / capability_write / capability_multi_edit — same fields
 *   Codex    write_file { path, content }
 *   Codex    apply_patch — Add/Update patch operations become replayable hunks; unsupported
 *            Delete/Move or malformed patches return [] so attribution never becomes partial.
 * Never throws: a malformed payload yields [] (the hook fails open).
 */
type CodexPatchUpdateHunk = { old: string; new: string; changed: boolean };

/** Find Codex's raw patch text, whether the client sends it directly or wraps it. */
function codexPatchText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return null;
  for (const nested of Object.values(value as Record<string, unknown>)) {
    if (typeof nested === 'string' && nested.includes('*** Begin Patch')) return nested;
  }
  return null;
}

/**
 * Convert Codex's line-oriented patch into the ledger's replayable edit/write hunks.
 *
 * This parser is intentionally stricter than the PreToolUse path reader: one malformed or
 * unsupported operation rejects the WHOLE patch, because recording only an earlier hunk would
 * make a later admission falsely appear hunk-exact. Delete and Move are not replayable by
 * the current ledger schema and therefore fail open.
 */
function hunksFromCodexApplyPatch(toolInput: unknown): FrozenRepairEditExtract[] {
  const text = codexPatchText(toolInput);
  if (text === null) return [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  while (lines.at(-1) === '') lines.pop();
  if (lines.length < 2 || lines[0] !== '*** Begin Patch' || lines.at(-1) !== '*** End Patch') return [];

  type CurrentOperation =
    | { kind: 'add'; path: string; body: string[] }
    | { kind: 'update'; path: string; hunks: CodexPatchUpdateHunk[] };
  const output: FrozenRepairEditExtract[] = [];
  const seenPaths = new Set<string>();
  let current: CurrentOperation | null = null;
  let active: { old: string[]; new: string[]; changed: boolean; hasLine: boolean } | null = null;
  let editIndex = 0;

  const finishActive = (): boolean => {
    if (!active) return true;
    if (!current || current.kind !== 'update' || !active.hasLine || !active.changed) return false;
    const old = active.old.join('');
    const next = active.new.join('');
    if (!old || old === next) return false;
    current.hunks.push({ old, new: next, changed: true });
    active = null;
    return true;
  };

  const finishCurrent = (): boolean => {
    if (!current) return true;
    if (current.kind === 'add') {
      output.push({
        path: current.path,
        hunk: { kind: 'write', body: current.body.join('') },
        editIndex: editIndex++,
      });
      current = null;
      return true;
    }
    if (!finishActive() || current.hunks.length === 0) return false;
    for (const hunk of current.hunks) {
      output.push({
        path: current.path,
        hunk: { kind: 'edit', old: hunk.old, new: hunk.new, replaceAll: false },
        editIndex: editIndex++,
      });
    }
    current = null;
    return true;
  };

  for (let index = 1; index < lines.length - 1; index += 1) {
    const line = lines[index]!;
    const operation = /^\*\*\* (Add|Update) File: (.+)$/.exec(line);
    if (operation) {
      if (!finishCurrent()) return [];
      const path = operation[2]!.trim();
      const key = normalizeRepoPath(path);
      if (!key || seenPaths.has(key)) return [];
      seenPaths.add(key);
      current = operation[1] === 'Add' ? { kind: 'add', path, body: [] } : { kind: 'update', path, hunks: [] };
      active = null;
      continue;
    }
    if (/^\*\*\* (?:Delete File:|Move to:)/.test(line) || /^\*\*\* /.test(line)) return [];
    if (!current) return [];

    if (current.kind === 'add') {
      if (!line.startsWith('+')) return [];
      current.body.push(line.slice(1) + '\n');
      continue;
    }
    if (line.startsWith('@@')) {
      if (!finishActive()) return [];
      active = { old: [], new: [], changed: false, hasLine: false };
      continue;
    }
    if (!active || ![' ', '+', '-'].includes(line[0] ?? '')) return [];
    const content = line.slice(1) + '\n';
    active.hasLine = true;
    if (line.startsWith(' ')) {
      active.old.push(content);
      active.new.push(content);
    } else if (line.startsWith('-')) {
      active.old.push(content);
      active.changed = true;
    } else {
      active.new.push(content);
      active.changed = true;
    }
  }
  if (!finishCurrent() || output.length === 0) return [];
  return output;
}

/**
 * A trimmed psu tool surface reaches capability:edit/write only through `tools:invoke`, so the
 * edit arrives as `{ name: 'capability:edit', args: {…} }` under the invoke tool's own name.
 * Returns the inner call in direct-call form, or null when the envelope is not a file write.
 */
export function unwrapToolsInvoke(toolName: string, toolInput: unknown): { toolName: string; toolInput: unknown } | null {
  if (!/(^|_)tools_invoke$/.test(String(toolName ?? '').toLowerCase())) return null;
  if (!toolInput || typeof toolInput !== 'object') return null;
  const envelope = toolInput as Record<string, unknown>;
  const inner = asString(envelope.name);
  if (!inner || !/^capability:(edit|write|multi_?edit)$/i.test(inner)) return null;
  return { toolName: inner.replace(':', '_'), toolInput: envelope.args };
}

export function hunksFromToolCall(toolName: string, toolInput: unknown): FrozenRepairEditExtract[] {
  const name = String(toolName ?? '').toLowerCase();
  if (name === 'apply_patch') return hunksFromCodexApplyPatch(toolInput);
  if (/(^|_)tools_invoke$/.test(name)) {
    const inner = unwrapToolsInvoke(toolName, toolInput);
    return inner ? hunksFromToolCall(inner.toolName, inner.toolInput) : [];
  }
  if (!toolInput || typeof toolInput !== 'object') return [];
  const input = toolInput as Record<string, unknown>;
  const isMulti = /multi_?edit/.test(name);
  const isEdit = !isMulti && /(^|_)edit(?:_file)?$/.test(name);
  const isWrite = /(^|_)write(_file)?$/.test(name);
  const filePath = asString(input.file_path) ?? asString(input.path);
  if (!filePath) return [];

  if (isMulti) {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    const out: FrozenRepairEditExtract[] = [];
    edits.forEach((raw, index) => {
      if (!raw || typeof raw !== 'object') return;
      const e = raw as Record<string, unknown>;
      const oldStr = asString(e.old_string);
      const newStr = asString(e.new_string);
      if (oldStr === null || newStr === null) return;
      out.push({
        path: asString(e.file_path) ?? filePath,
        hunk: { kind: 'edit', old: oldStr, new: newStr, replaceAll: e.replace_all === true },
        editIndex: index,
      });
    });
    return out;
  }
  if (isEdit) {
    const oldStr = asString(input.old_string);
    const newStr = asString(input.new_string);
    if (oldStr === null || newStr === null) return [];
    return [
      {
        path: filePath,
        hunk: { kind: 'edit', old: oldStr, new: newStr, replaceAll: input.replace_all === true },
        editIndex: 0,
      },
    ];
  }
  if (isWrite) {
    const body = asString(input.content);
    if (body === null) return [];
    return [{ path: filePath, hunk: { kind: 'write', body }, editIndex: 0 }];
  }
  return [];
}

/** Accept a hunk that arrived over the wire (the tool boundary); null when malformed. */
export function parseFrozenRepairEditHunk(value: unknown): FrozenRepairEditHunk | null {
  if (!value || typeof value !== 'object') return null;
  const h = value as Record<string, unknown>;
  if (h.kind === 'edit') {
    if (typeof h.old !== 'string' || typeof h.new !== 'string') return null;
    return { kind: 'edit', old: h.old, new: h.new, replaceAll: h.replaceAll === true };
  }
  if (h.kind === 'write') {
    if (typeof h.body !== 'string') return null;
    return { kind: 'write', body: h.body };
  }
  if (h.kind === 'oversize') {
    if ((h.of !== 'edit' && h.of !== 'write') || typeof h.bytes !== 'number' || typeof h.sha256 !== 'string') return null;
    if (!/^[0-9a-f]{64}$/.test(h.sha256) || !Number.isFinite(h.bytes) || h.bytes < 0) return null;
    return { kind: 'oversize', of: h.of, bytes: h.bytes, sha256: h.sha256 };
  }
  return null;
}

const CANDIDATE_RE = /^[0-9a-f]{40,64}$/;

/**
 * Record one hunk. Idempotent: a retried hook call (same agent, path, toolUseId, editIndex)
 * inserts nothing and reports `inserted:false`. Never throws for a shape problem — the hook
 * fails open on a refusal exactly as it does on a transport error.
 */
export async function recordFrozenRepairEdit(
  sql: FrozenRepairLedgerSql,
  input: FrozenRepairEditRecordInput,
): Promise<FrozenRepairEditRecordOutcome> {
  const candidate = input.candidate.toLowerCase();
  if (!CANDIDATE_RE.test(candidate)) {
    return { ok: false, reason: 'invalid-candidate', detail: `candidate ${input.candidate} is not a 40–64 hex sha` };
  }
  const agent = input.agent.trim();
  if (!agent || agent.length > 200) return { ok: false, reason: 'invalid-agent', detail: 'agent must be 1–200 chars' };
  const path = normalizeRepoPath(input.path);
  if (!path || path.length > 1024 || path.split('/').some((seg) => seg === '..' || seg === '.')) {
    return { ok: false, reason: 'invalid-path', detail: `${input.path} does not normalize to a repo-relative path` };
  }
  const bounded = boundHunk(input.hunk);
  if (!parseFrozenRepairEditHunk(bounded)) return { ok: false, reason: 'invalid-hunk', detail: 'hunk has no recognised shape' };
  const toolUseId = input.toolUseId.trim().slice(0, 200) || `hook-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const rows = (await sql.unsafe(
    `INSERT INTO harness_shared.frozen_repair_edit_ledger
       (workspace_id, install_slug, candidate, agent, path, hunk, hunk_kind, hunk_sha256, at_ms, tool_use_id, edit_index, work_item)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12)
     ON CONFLICT ON CONSTRAINT frozen_repair_edit_ledger_idempotent DO NOTHING
     RETURNING id`,
    [
      input.workspaceId,
      input.installSlug,
      candidate,
      agent,
      path,
      JSON.stringify(bounded),
      bounded.kind,
      hunkSha256(bounded),
      Math.max(1, Math.floor(input.atMs)),
      toolUseId,
      Math.max(0, Math.floor(input.editIndex ?? 0)),
      input.workItem ?? null,
    ],
  )) as Array<{ id: number | string }> | undefined;
  const first = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  return {
    ok: true,
    id: first ? Number(first.id) : null,
    inserted: first !== null,
    oversize: bounded.kind === 'oversize',
    path,
  };
}

export interface FrozenRepairEditLedgerQuery {
  workspaceId: string;
  installSlug: string;
  candidate: string;
  /** Repo-relative paths (normalized here); omit for every path on the lineage. */
  paths?: readonly string[];
  /** Restrict to these agents; omit for every agent. */
  agents?: readonly string[];
  /** Row cap (default 2000) — the replay reads one path at a time and is far below it. */
  limit?: number;
}

/** Rows in the order they were made (at_ms, then id) — the order a replay applies them. */
export async function readFrozenRepairEditLedger(
  sql: FrozenRepairLedgerSql,
  query: FrozenRepairEditLedgerQuery,
): Promise<FrozenRepairEditLedgerRow[]> {
  const params: unknown[] = [query.workspaceId, query.installSlug, query.candidate.toLowerCase()];
  const where = ['workspace_id = $1', 'install_slug = $2', 'candidate = $3'];
  const paths = (query.paths ?? []).map(normalizeRepoPath).filter((p) => p.length > 0);
  if (query.paths && paths.length === 0) return [];
  if (paths.length > 0) {
    params.push(paths);
    where.push(`path = ANY($${params.length}::text[])`);
  }
  const agents = (query.agents ?? []).map((a) => a.trim()).filter((a) => a.length > 0);
  if (query.agents && agents.length === 0) return [];
  if (agents.length > 0) {
    params.push(agents);
    where.push(`agent = ANY($${params.length}::text[])`);
  }
  params.push(Math.min(Math.max(1, Math.floor(query.limit ?? 2000)), 10000));
  const rows = (await sql.unsafe(
    `SELECT id, candidate, agent, path, hunk, at_ms, tool_use_id, edit_index, work_item
       FROM harness_shared.frozen_repair_edit_ledger
      WHERE ${where.join(' AND ')}
      ORDER BY at_ms ASC, id ASC
      LIMIT $${params.length}`,
    params,
  )) as Array<Record<string, unknown>> | undefined;
  const out: FrozenRepairEditLedgerRow[] = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const hunk = parseFrozenRepairEditHunk(typeof r.hunk === 'string' ? safeJson(r.hunk) : r.hunk);
    if (!hunk) continue;
    out.push({
      id: Number(r.id),
      candidate: String(r.candidate),
      agent: String(r.agent),
      path: String(r.path),
      hunk,
      atMs: Number(r.at_ms),
      toolUseId: String(r.tool_use_id ?? ''),
      editIndex: Number(r.edit_index ?? 0),
      workItem: typeof r.work_item === 'string' ? r.work_item : null,
    });
  }
  return out;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export type FrozenRepairReplayOutcome =
  | { ok: true; content: string; applied: number }
  | {
      ok: false;
      reason: 'hunk-conflict' | 'oversize';
      /** Index into the supplied hunk list of the one that failed. */
      index: number;
      detail: string;
    };

/**
 * P-020's replay core: apply hunks IN ORDER onto `base` (repairHead's blob; null when the
 * path does not exist there). Semantics mirror the client tools that made them:
 *   - `edit`  : `old` must occur in the current content — first occurrence is replaced, or
 *               every occurrence when `replaceAll`. `old` absent ⇒ `hunk-conflict`: the
 *               hunk was made on top of content repairHead does not have (a foreign
 *               change), which is exactly the case D-008 forbids admitting silently.
 *   - `write` : the content becomes `body` (a Write replaces the whole file).
 *   - `oversize` ⇒ refused: content was not recorded, so nothing can be replayed.
 * A `write` after edits, or an edit after a write, composes naturally — the file is what the
 * agent last saw it as.
 */
export function replayFrozenRepairHunks(
  base: string | null,
  hunks: readonly FrozenRepairEditHunk[],
): FrozenRepairReplayOutcome {
  let content = base ?? '';
  let applied = 0;
  for (let i = 0; i < hunks.length; i += 1) {
    const h = hunks[i]!;
    if (h.kind === 'oversize') {
      return {
        ok: false,
        reason: 'oversize',
        index: i,
        detail: `hunk #${i + 1} (${h.of}, ${h.bytes} bytes) exceeded the ledger cap and carries no content — it cannot be replayed hunk-exactly`,
      };
    }
    if (h.kind === 'write') {
      content = h.body;
      applied += 1;
      continue;
    }
    if (h.old === '') {
      // An Edit with an empty old_string is a client-level create/append; treat as a whole
      // write of `new` when the file is empty, otherwise refuse — there is no anchor.
      if (content === '') {
        content = h.new;
        applied += 1;
        continue;
      }
      return { ok: false, reason: 'hunk-conflict', index: i, detail: `hunk #${i + 1} has an empty anchor on a non-empty file` };
    }
    const at = content.indexOf(h.old);
    if (at < 0) {
      return {
        ok: false,
        reason: 'hunk-conflict',
        index: i,
        detail: `hunk #${i + 1}: its anchor (${h.old.length} chars, "${h.old.slice(0, 60).replace(/\n/g, '\\n')}${h.old.length > 60 ? '…' : ''}") is not in the content at this point of the replay — the edit was made on top of a change repairHead does not carry`,
      };
    }
    content = h.replaceAll ? content.split(h.old).join(h.new) : content.slice(0, at) + h.new + content.slice(at + h.old.length);
    applied += 1;
  }
  return { ok: true, content, applied };
}

/** Group ledger rows by path, preserving ledger order — the shape the admit op consumes. */
export function groupLedgerRowsByPath(rows: readonly FrozenRepairEditLedgerRow[]): Map<string, FrozenRepairEditLedgerRow[]> {
  const out = new Map<string, FrozenRepairEditLedgerRow[]>();
  for (const row of rows) {
    const list = out.get(row.path);
    if (list) list.push(row);
    else out.set(row.path, [row]);
  }
  return out;
}
