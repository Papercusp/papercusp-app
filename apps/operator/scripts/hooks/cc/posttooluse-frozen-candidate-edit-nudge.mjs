#!/usr/bin/env node
// apps/operator/scripts/hooks/cc/posttooluse-frozen-candidate-edit-nudge.mjs
//
// PostToolUse (Edit|Write|MultiEdit) hook with TWO jobs, both only while a gate candidate is
// FROZEN (there is a marker file); otherwise it exits after one failed read:
//
//   1. EDIT LEDGER (P-019 of frozen-candidate-stays-frozen-through-all-fixes-2026-09-03,
//      D-008 layer 1). Record the EXACT hunk this edit made — { old, new } for an Edit, the
//      body for a Write, one row per MultiEdit entry — attributed to the per-session owner,
//      via `release:repair-queue { op:'record-edit' }`. This is the only attribution that
//      works here: git blame and commit subjects are meaningless under git-sync, but this
//      hook sees the hunk at the moment it is made. Hunk-exact admission (P-020) replays
//      ONLY the calling agent's ledgered hunks, so a stranger's concurrent work in the same
//      file never rides into the judged lineage.
//
//   2. ADVISORY NUDGE (P-004/P-005 of frozen-candidate-compliance-enforcement-2026-08-30,
//      D-007 #2 of the 2026-09-03 plan). If the edited path is in the repair RADIUS (a
//      failing path, or any manifest leg's subject path), say the CONSEQUENCE, not the rule:
//      this edit is NOT judged until admitted; here is the one call; your hunks are (or are
//      not) recorded.
//
// THE TRAP
//   On the first real code red the gate opens ONE frozen repair queue and every later run
//   RESUMES that exact candidate rather than a newer tip (freeze-and-converge, D-007). An
//   agent who fixes a named failing test on `staging` therefore lands the fix ABOVE the sha
//   under judgment. Nothing fails. The gate keeps reporting the same red, the agent reports
//   "fixed N gate reds", and both are locally true while the gate cannot see any of it.
//   Measured 2026-08-30: 3 of 10 reds on candidate 4184805d were already fixed at tip.
//
// CONTRACT
//   - ADVISORY ONLY. PostToolUse cannot block and must not try to. Editing a failing path is
//     often exactly right; what is wrong is doing it believing the gate will see it.
//   - COSTS ~NOTHING WHEN NOTHING IS FROZEN. The signal is inverted: no frozen repair means
//     no marker file, so the hook exits after one failed read. There is deliberately no
//     database round-trip on that path — this fires on every edit, fleet-wide.
//   - The marker is projected by `writeFrozenCandidateRepairQueue`, the one production write
//     path for the queue, so it cannot describe a previous round.
//   - NORMALIZATION IS PINNED, NOT COPIED-AND-HOPED. `normalizeRepoPath` and `hunksFrom`
//     below must agree with the gate's own (`frozen-candidate-repair-queue.ts`,
//     `frozen-repair-edit-ledger.ts`); `frozen-repair-edit-hook-parity.test.ts` imports both
//     sides and fails the build if they ever diverge.
//   - FAILS OPEN after bounded recovery on every internal error. A transport failure on the
//     primary operator is retried through the request-only staging operator (`:3170`) because
//     both doors write the same idempotent ledger key; an application refusal remains
//     authoritative and is never rerouted. If both doors refuse or cannot be reached, the
//     nudge says the hunks were NOT recorded, so admission needs `wholeBlob:true, reason`.
//   - `--self-test` runs the embedded cases (no stdin, no network) and exits non-zero on failure.
//
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';

/** MUST match packages/operator-core/lib/release/frozen-candidate-repair-queue.ts. */
export function normalizeRepoPath(value) {
  return String(value ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
}

export function markerPath() {
  const base = process.env.PAPERCUSP_STATE_DIR ?? join(homedir(), '.papercusp', 'state');
  return join(base, 'frozen-repair-edit-marker.json');
}

export function readMarker(path = markerPath()) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.candidate !== 'string' || typeof parsed.repairHead !== 'string') return null;
    if (!Array.isArray(parsed.failingPaths)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * P-019: the repair RADIUS — the failing paths plus every P-021 manifest leg's subject paths
 * (a pre-P-022 marker has no `legs`, so the radius is the failing set alone). Normalized.
 */
export function repairRadius(marker) {
  const out = new Set();
  for (const p of marker?.failingPaths ?? []) out.add(normalizeRepoPath(p));
  for (const leg of Array.isArray(marker?.legs) ? marker.legs : []) {
    for (const p of Array.isArray(leg?.subjectPaths) ? leg.subjectPaths : []) out.add(normalizeRepoPath(p));
  }
  out.delete('');
  return out;
}

/**
 * P-005 / D-007 #2: name the CONSEQUENCE, not the rule. "Remember freeze-and-converge" is the
 * prose that already failed — it asks the reader to recall a regime and derive what it
 * implies. Returns null when there is nothing to say (path outside the radius).
 *
 * `ledger` is the P-019 outcome for this path: `{ recorded: true }`, `{ recorded: false,
 * detail }`, or null when no recording was attempted (self-test / no hunk extracted).
 *
 * @param {any} marker
 * @param {string} editedPath
 * @param {{ recorded: boolean, detail?: string } | null} [ledger]
 * @returns {string | null}
 */
export function warningFor(marker, editedPath, ledger = null) {
  if (!marker) return null;
  const p = normalizeRepoPath(editedPath);
  if (!p) return null;
  const inRepairRadius = repairRadius(marker).has(p);
  if (!inRepairRadius) {
    // A failed ledger write is an attribution loss even when this path is not one
    // of the paths the gate currently reports as red. Keep this warning separate
    // from radius admission guidance: there is no judged-path consequence to
    // explain for an outside-radius edit, only the fact that recording failed.
    if (ledger?.recorded === false) {
      return `⚠ Your hunks for ${p} were NOT recorded in the frozen candidate's edit ledger (${ledger.detail ?? 'ledger unavailable'}).`;
    }
    return null;
  }
  const lines = [
    '⛔ THIS FIX WILL NOT REACH THE GATE UNTIL YOU ADMIT IT.',
    `   ${p} is in the frozen candidate's repair radius, and the gate is judging ${String(
      marker.repairHead,
    ).slice(0, 12)} (frozen candidate ${String(marker.candidate).slice(0, 12)}, phase ${
      marker.phase ?? 'unknown'
    }) — NOT the staging tip your edit lands on.`,
    '   So the gate will keep failing on this exact file however correct your fix is, and a',
    '   "fixed the gate red" claim off this edit would be false (work_items:complete refuses it).',
    '   Put it on the judged lineage with ONE call, after git-sync commits the edit:',
    `     release:repair-queue { op:'admit', paths:['${p}'] }`,
  ];
  if (ledger && ledger.recorded === true) {
    lines.push('   Your hunks are RECORDED in the edit ledger; admission will carry only them (D-008),');
    lines.push("   never a peer's concurrent work in the same file.");
  } else if (ledger && ledger.recorded === false) {
    lines.push(
      `   ⚠ Your hunks were NOT recorded (${ledger.detail ?? 'ledger unavailable'}) — hunk-exact admission has`,
    );
    lines.push("   nothing to replay for this edit; admit it with wholeBlob:true and a reason, explicitly.");
  }
  lines.push('   It reports whether the judged sha now carries your fix. Do NOT fire');
  lines.push('   release:checkpoint-run and do NOT retire the queue to "make the gate move".');
  return lines.join('\n');
}

/** Every path an Edit/Write/MultiEdit payload touched. */
/**
 * A trimmed psu surface reaches capability:edit/write only through tools:invoke — MUST match
 * `unwrapToolsInvoke` in frozen-repair-edit-ledger.ts. Returns the payload in direct-call form;
 * an invoke of any other tool keeps its name with an empty input, so it extracts nothing.
 */
export function unwrapToolsInvoke(payload) {
  const name = String(payload?.tool_name ?? '').toLowerCase();
  if (!/(^|_)tools_invoke$/.test(name)) return payload;
  const input = payload?.tool_input;
  const inner = typeof input?.name === 'string' ? input.name : '';
  if (!/^capability:(edit|write|multi_?edit)$/i.test(inner)) return { ...payload, tool_input: {} };
  return { ...payload, tool_name: inner.replace(':', '_'), tool_input: input.args };
}

export function editedPathsFrom(rawPayload) {
  const payload = unwrapToolsInvoke(rawPayload);
  const input = payload?.tool_input ?? {};
  const name = String(payload?.tool_name ?? '').toLowerCase();
  if (name === 'apply_patch') return codexPatchPaths(input);
  const paths = [];
  if (typeof input.file_path === 'string') paths.push(input.file_path);
  else if (typeof input.path === 'string') paths.push(input.path);
  if (Array.isArray(input.edits)) {
    for (const e of input.edits) if (typeof e?.file_path === 'string') paths.push(e.file_path);
  }
  return paths;
}

/**
 * P-019: the hunks a payload made — MUST match `hunksFromToolCall` in
 * packages/operator-core/lib/release/frozen-repair-edit-ledger.ts (pinned by the parity test).
 *   Edit / capability_edit         { file_path, old_string, new_string, replace_all? }
 *   Write / capability_write       { file_path, content }
 *   MultiEdit / capability_multi_edit { file_path, edits:[{ old_string, new_string, replace_all? }] }
 *   tools_invoke                   { name:'capability:edit'|…, args } — unwrapped to the shape above
 *   Codex write_file               { path, content }
 *   Codex edit_file                { path, old_string, new_string, replace_all? }
 *   Codex apply_patch              Add/Update patch operations become replayable hunks;
 *                                  unsupported Delete/Move or malformed patches are absent.
 */
function codexPatchText(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return null;
  for (const nested of Object.values(value)) {
    if (typeof nested === 'string' && nested.includes('*** Begin Patch')) return nested;
  }
  return null;
}

function codexPatchPaths(value) {
  const text = codexPatchText(value);
  if (text === null) return [];
  const paths = [];
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const operation = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line);
    if (operation) paths.push(operation[1].trim());
    const move = /^\*\*\* Move to: (.+)$/.exec(line);
    if (move) paths.push(move[1].trim());
  }
  return paths.filter(Boolean);
}

function hunksFromCodexApplyPatch(toolInput) {
  const text = codexPatchText(toolInput);
  if (text === null) return [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  while (lines.at(-1) === '') lines.pop();
  if (lines.length < 2 || lines[0] !== '*** Begin Patch' || lines.at(-1) !== '*** End Patch') return [];

  const output = [];
  const seenPaths = new Set();
  let current = null;
  let active = null;
  let editIndex = 0;

  const finishActive = () => {
    if (!active) return true;
    if (!current || current.kind !== 'update' || !active.hasLine || !active.changed) return false;
    const old = active.old.join('');
    const next = active.new.join('');
    if (!old || old === next) return false;
    current.hunks.push({ old, new: next });
    active = null;
    return true;
  };

  const finishCurrent = () => {
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
    const line = lines[index];
    const operation = /^\*\*\* (Add|Update) File: (.+)$/.exec(line);
    if (operation) {
      if (!finishCurrent()) return [];
      const path = operation[2].trim();
      const key = normalizeRepoPath(path);
      if (!key || seenPaths.has(key)) return [];
      seenPaths.add(key);
      current = operation[1] === 'Add'
        ? { kind: 'add', path, body: [] }
        : { kind: 'update', path, hunks: [] };
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

export function hunksFrom(rawPayload) {
  const payload = unwrapToolsInvoke(rawPayload);
  const input = payload?.tool_input;
  const name = String(payload?.tool_name ?? '').toLowerCase();
  if (name === 'apply_patch') return hunksFromCodexApplyPatch(input);
  if (!input || typeof input !== 'object') return [];
  const isMulti = /multi_?edit/.test(name);
  const isEdit = !isMulti && /(^|_)edit(?:_file)?$/.test(name);
  const isWrite = /(^|_)write(_file)?$/.test(name);
  const filePath = typeof input.file_path === 'string' ? input.file_path : typeof input.path === 'string' ? input.path : null;
  if (!filePath) return [];
  const str = (v) => (typeof v === 'string' ? v : null);
  if (isMulti) {
    const out = [];
    (Array.isArray(input.edits) ? input.edits : []).forEach((e, index) => {
      if (!e || typeof e !== 'object') return;
      const o = str(e.old_string);
      const n = str(e.new_string);
      if (o === null || n === null) return;
      out.push({ path: str(e.file_path) ?? filePath, hunk: { kind: 'edit', old: o, new: n, replaceAll: e.replace_all === true }, editIndex: index });
    });
    return out;
  }
  if (isEdit) {
    const o = str(input.old_string);
    const n = str(input.new_string);
    if (o === null || n === null) return [];
    return [{ path: filePath, hunk: { kind: 'edit', old: o, new: n, replaceAll: input.replace_all === true }, editIndex: 0 }];
  }
  if (isWrite) {
    const body = str(input.content);
    if (body === null) return [];
    return [{ path: filePath, hunk: { kind: 'write', body }, editIndex: 0 }];
  }
  return [];
}

/** Did the client report the edit itself failed? A failed edit made no hunk to record. */
export function toolCallFailed(payload) {
  const r = payload?.tool_response ?? payload?.toolResponse;
  if (!r || typeof r !== 'object') return false;
  return r.is_error === true || r.isError === true || Boolean(r.error);
}

/**
 * Per-session owner — the SAME resolution order as pretooluse-locks-acquire.sh, so the
 * ledger row, the lock row and the agent's own `admit` call carry ONE identity.
 */
export function ownerIdentity(payload, env = process.env, readFile = (p) => readFileSync(p, 'utf8')) {
  const lockSid = env.PAPERCUSP_LOCK_SID;
  if (typeof lockSid === 'string' && lockSid) return lockSid;
  try {
    if (env.CODEX_HOME) {
      const diag = JSON.parse(readFile(join(env.CODEX_HOME, 'papercusp-diagnostics.json')));
      if (typeof diag?.lockOwnerSid === 'string' && diag.lockOwnerSid) return diag.lockOwnerSid;
    }
  } catch {
    /* no codex diagnostics */
  }
  if (typeof env.PAPERCUSP_SID === 'string' && env.PAPERCUSP_SID) return env.PAPERCUSP_SID;
  if (typeof payload?.session_id === 'string' && payload.session_id) return payload.session_id;
  try {
    const id = readFile(join(homedir(), '.papercusp', 'su-agent-id')).trim();
    if (id) return id;
  } catch {
    /* not installed */
  }
  return null;
}

/**
 * Repo-relative path for an edited file: the SUPERPROJECT root when the file sits in a
 * submodule (the gate's queue names paths from the superproject), else the toplevel. Null
 * when the file is outside any repository — nothing to attribute to a lineage then.
 */
export function repoRelativePath(filePath, cwd = process.cwd(), git = execFileSync) {
  try {
    const abs = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
    let real = abs;
    try {
      real = realpathSync(abs);
    } catch {
      real = abs; // a Write may create the file after we run — the parent dir still resolves
    }
    const dir = dirname(real);
    const out = String(
      git('git', ['-C', dir, 'rev-parse', '--show-superproject-working-tree', '--show-toplevel'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3000,
      }),
    )
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const root = out[0];
    if (!root) return null;
    const rel = relative(realpathSafe(root), real);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
    return normalizeRepoPath(rel);
  } catch {
    return null;
  }
}

function realpathSafe(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

const OUTPUT_ENVELOPE_SCHEMA_VERSION = 'papercusp.output-envelope/v1';
const SCRATCH_URI_PREFIX = 'papercusp://scratch/';
const STAGING_OPERATOR_URL = 'http://127.0.0.1:3170';

/**
 * Filesystem root for result-door spill files. Keep this in lockstep with
 * apps/operator/scripts/ptool.mjs; the hook is a detached plain Node process,
 * so it cannot import the TypeScript scratch-uri module.
 */
function scratchRootDir(env = process.env) {
  const override = typeof env.PAPERCUSP_SCRATCH_ROOT === 'string' ? env.PAPERCUSP_SCRATCH_ROOT.trim() : '';
  return override || join(homedir(), '.papercusp', 'scratch');
}

/** Map a trusted papercusp://scratch URI to a path below the configured root. */
export function scratchUriToPath(uri, env = process.env) {
  if (typeof uri !== 'string' || !uri.startsWith(SCRATCH_URI_PREFIX)) return '';
  const rest = uri.slice(SCRATCH_URI_PREFIX.length);
  if (!rest || rest.includes('\0') || /(^|\/)\.\.(\/|$)/.test(rest)) return '';
  const root = scratchRootDir(env);
  const candidate = resolve(root, rest);
  if (candidate !== root && !candidate.startsWith(root + sep)) return '';
  return candidate;
}

function tryParseJsonObject(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Result-door spill files contain a magic line, a manifest, then JSON payload. */
async function readSpilledPayload(path) {
  const text = await readFile(path, 'utf8');
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  if (lines.length === 0) throw new Error(`empty spill file: ${path}`);
  return JSON.parse(lines[lines.length - 1]);
}

/**
 * Unwrap a papercusp.output-envelope/v1 result, including a reference whose
 * spill payload may put advisory text before the actual JSON result.
 *
 * This mirrors ptool.mjs rather than trusting content[0]: result-door may move
 * advisory items ahead of the payload, and a failed read must leave the
 * envelope untouched instead of fabricating a refusal or success.
 */
export async function unwrapOutputEnvelope(
  parsed,
  { readSpill = readSpilledPayload, fileExists = existsSync, env = process.env } = {},
) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed;
  if (!Array.isArray(parsed.content)) return parsed;
  if (Object.prototype.hasOwnProperty.call(parsed, 'ok')) return parsed;

  for (const part of parsed.content) {
    const inline = tryParseJsonObject(part?.text);
    if (inline) {
      const unwrapped = await unwrapOutputEnvelope(inline, { readSpill, fileExists, env });
      return unwrapped === inline ? inline : unwrapped;
    }

    if (part?.kind !== 'reference' && part?.type !== 'reference') continue;
    const path = scratchUriToPath(part.uri, env);
    if (!path || !fileExists(path)) continue;

    let spilled;
    try {
      spilled = await readSpill(path);
    } catch {
      continue;
    }
    for (const spilledPart of spilled?.content ?? []) {
      const candidate = tryParseJsonObject(spilledPart?.text);
      if (!candidate) continue;
      const unwrapped = await unwrapOutputEnvelope(candidate, { readSpill, fileExists, env });
      return unwrapped === candidate ? candidate : unwrapped;
    }
  }
  return parsed;
}

function resultContentText(result) {
  return (result?.content ?? [])
    .map((part) => (part && part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .join(' ')
    .slice(0, 200);
}

/**
 * Parse the MCP endpoint's JSON, SSE, or output-envelope response into the
 * inner tool result. Async because output-envelope references are recoverable
 * spill files, not inline text.
 */
export async function parseMcpToolResult(rawText, options = {}) {
  let result = null;
  let rpcError = null;
  for (let line of String(rawText ?? '').split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('event:')) continue;
    if (line.startsWith('data:')) line = line.slice(5).trim();
    const candidate = tryParseJsonObject(line);
    if (!candidate) continue;
    if ('result' in candidate) {
      result = candidate.result;
      break;
    }
    if ('error' in candidate) {
      rpcError = candidate.error;
      break;
    }
    // A direct CallToolResult/output envelope is also useful in tests and in
    // older local MCP proxies that omit the JSON-RPC wrapper.
    if (Array.isArray(candidate.content) || Object.prototype.hasOwnProperty.call(candidate, 'ok')) {
      result = candidate;
      break;
    }
  }
  if (rpcError) {
    return {
      ok: false,
      detail: `rpc: ${rpcError.message ?? JSON.stringify(rpcError)}`,
      error: rpcError,
    };
  }
  if (!result || typeof result !== 'object') return { ok: false, detail: 'no result' };

  const unwrapped = await unwrapOutputEnvelope(result, options);
  if (unwrapped !== result) result = unwrapped;
  if (result?.isError === true) {
    return { ok: false, detail: `tool error: ${resultContentText(result) || 'unknown'}` };
  }
  if (Object.prototype.hasOwnProperty.call(result, 'ok')) {
    return { ok: true, inner: result };
  }
  for (const item of result.content ?? []) {
    if (!item || item.type !== 'text') continue;
    const inner = tryParseJsonObject(item.text);
    if (!inner) continue;
    const nested = await unwrapOutputEnvelope(inner, options);
    return { ok: true, inner: nested };
  }
  return { ok: false, detail: 'no text result' };
}

function normalizedOperatorOrigin(operatorUrl) {
  try {
    const url = new URL(String(operatorUrl));
    const host = ['localhost', '127.0.0.1', '::1'].includes(url.hostname) ? 'loopback' : url.hostname;
    return `${url.protocol}//${host}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`;
  } catch {
    return String(operatorUrl ?? '').replace(/\/api\/mcp.*$/, '').replace(/\/+$/, '');
  }
}

function isUnknownOperationFailure(value) {
  const texts = [];
  const collect = (entry) => {
    if (typeof entry === 'string') {
      texts.push(entry);
      return;
    }
    if (!entry || typeof entry !== 'object') return;
    for (const key of ['code', 'reason', 'verdict', 'detail', 'message']) {
      if (typeof entry[key] === 'string') texts.push(entry[key]);
    }
    if (entry.error) collect(entry.error);
    if (entry.inner) collect(entry.inner);
  };
  collect(value);
  return texts.some((text) => {
    const lower = text.toLowerCase();
    return (
      /^(?:unknown[-\s]?(?:op|operation|tool))$/.test(lower.trim()) ||
      /\bunknown[-\s]?(?:op|operation|tool)\b/.test(lower) ||
      /\b(?:op|operation|tool)\b[^.\n]{0,100}\b(?:unknown|not found|not registered|unsupported|unrecognized)\b/.test(lower) ||
      /\b(?:unknown|not found|not registered|unsupported|unrecognized)\b[^.\n]{0,100}\b(?:op|operation|tool)\b/.test(lower)
    );
  });
}

/**
 * The MCP admission gate sheds before a tool runs. Preserve this typed signal so the hook can
 * retry the idempotent ledger write through staging; treating it as an ordinary refusal loses
 * the hunk even though the request is explicitly retry-safe.
 */
function isRetryableAdmissionShedding(value) {
  const seen = new Set();
  const visit = (entry) => {
    if (!entry || typeof entry !== 'object' || seen.has(entry)) return false;
    seen.add(entry);
    const data = entry.data;
    if (
      data &&
      typeof data === 'object' &&
      data.retryable === true &&
      String(data.reason ?? '').toLowerCase() === 'loop_pressure_critical'
    ) {
      return true;
    }
    return visit(entry.error) || visit(entry.rpcError) || visit(entry.inner);
  };
  return visit(value);
}

function recordEditUrl(operatorUrl, owner) {
  return (
    String(operatorUrl ?? '').replace(/\/api\/mcp.*$/, '').replace(/\/+$/, '') +
    '/api/mcp?superuser=1&origin=hook&format=json&client=' +
    encodeURIComponent(owner)
  );
}

async function recordAtOperatorUrl({
  operatorUrl,
  token,
  owner,
  marker,
  path,
  hunk,
  toolUseId,
  editIndex,
  atMs,
  fetchImpl,
}) {
  const url = recordEditUrl(operatorUrl, owner);
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'release:repair-queue',
      arguments: {
        op: 'record-edit',
        path,
        hunk,
        toolUseId: toolUseId || undefined,
        editIndex,
        atMs,
        candidate: marker.candidate,
      },
    },
  });
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body,
      signal: AbortSignal.timeout(4000),
    });
    const text = await res.text();
    const parsed = await parseMcpToolResult(text);
    if (!parsed.ok) {
      const detail = res.ok ? parsed.detail : `HTTP ${res.status}: ${parsed.detail}`;
      return {
        recorded: false,
        detail,
        unknownOperation: isUnknownOperationFailure(parsed),
        retryableAdmission: isRetryableAdmissionShedding(parsed),
      };
    }
    const inner = parsed.inner;
    if (inner.ok === true && inner.recorded === true) {
      return { recorded: true, inserted: inner.inserted !== false, inner };
    }
    const detail = inner.reason ?? inner.verdict ?? inner.detail ?? `HTTP ${res.status}`;
    return {
      recorded: false,
      detail: res.ok ? detail : `HTTP ${res.status}: ${detail}`,
      inner,
      unknownOperation: isUnknownOperationFailure(inner),
      retryableAdmission: isRetryableAdmissionShedding(inner),
    };
  } catch (err) {
    return {
      recorded: false,
      detail: err?.name === 'TimeoutError' ? 'operator timeout' : String(err?.message ?? err).slice(0, 120),
      unknownOperation: false,
      transportFailure: true,
    };
  }
}

/**
 * POST one `record-edit` through the same door the lock hook uses (bearer + ?client=owner so
 * the server attributes the row to the per-session owner). Never throws.
 */
export async function recordOneHunk({ operatorUrl, token, owner, marker, path, hunk, toolUseId, editIndex, atMs, fetchImpl = fetch }) {
  const primary = await recordAtOperatorUrl({
    operatorUrl,
    token,
    owner,
    marker,
    path,
    hunk,
    toolUseId,
    editIndex,
    atMs,
    fetchImpl,
  });
  const hasStableToolUseId = typeof toolUseId === 'string' && toolUseId.trim().length > 0;
  if (
    !primary.recorded &&
    (primary.unknownOperation || primary.transportFailure || primary.retryableAdmission) &&
    hasStableToolUseId &&
    normalizedOperatorOrigin(operatorUrl) !== normalizedOperatorOrigin(STAGING_OPERATOR_URL)
  ) {
    // A release operator can legitimately be older than the hook's record-edit
    // protocol, the admission gate can shed a retry-safe request, and the primary
    // operator/proxy can transiently be unreachable.
    // The ledger key is idempotent, so retry those transport/protocol/admission cases
    // through staging. Ordinary application refusals stay authoritative and must
    // not be retried as a different write.
    return recordAtOperatorUrl({
      operatorUrl: STAGING_OPERATOR_URL,
      token,
      owner,
      marker,
      path,
      hunk,
      toolUseId,
      editIndex,
      atMs,
      fetchImpl,
    });
  }
  return primary;
}

async function readStdin() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    return; // fail open
  }
  const marker = readMarker();
  if (!marker) return; // the common case: nothing frozen
  if (toolCallFailed(payload)) return; // a failed edit made no hunk

  // P-019: record every hunk this edit made, whatever the path — hunk-exact admission needs
  // the SOURCE fix as much as the failing test, and the failing set cannot name the source.
  const ledgerByPath = new Map();
  const hunks = hunksFrom(payload).slice(0, 20);
  if (hunks.length > 0) {
    const tokenPath = join(homedir(), '.papercusp', 'superuser-token');
    let token = '';
    try {
      token = readFileSync(tokenPath, 'utf8').trim();
    } catch {
      token = '';
    }
    const owner = ownerIdentity(payload);
    const operatorUrl = String(process.env.PAPERCUSP_OPERATOR_URL ?? 'http://localhost:3070').replace(/\/api\/mcp.*$/, '');
    if (token && owner) {
      const toolUseId = String(payload.tool_use_id ?? payload.tool_call_id ?? '');
      const atMs = Date.now();
      const results = await Promise.all(
        hunks.map(async (h) => {
          const rel = repoRelativePath(h.path, payload.cwd ?? process.cwd());
          if (!rel) return null;
          const r = await recordOneHunk({ operatorUrl, token, owner, marker, path: rel, hunk: h.hunk, toolUseId, editIndex: h.editIndex, atMs });
          return { rel, r };
        }),
      );
      for (const entry of results) {
        if (!entry) continue;
        const prev = ledgerByPath.get(entry.rel);
        // A path is "recorded" only if EVERY hunk for it landed.
        if (!prev) ledgerByPath.set(entry.rel, entry.r);
        else if (prev.recorded && !entry.r.recorded) ledgerByPath.set(entry.rel, entry.r);
      }
    } else {
      for (const h of hunks) {
        const rel = repoRelativePath(h.path, payload.cwd ?? process.cwd());
        if (rel) ledgerByPath.set(rel, { recorded: false, detail: token ? 'no session identity' : 'papercusp not installed' });
      }
    }
  }

  const seen = new Set();
  const messages = [];
  for (const path of editedPathsFrom(payload)) {
    const rel = repoRelativePath(path, payload.cwd ?? process.cwd()) ?? normalizeRepoPath(path);
    const msg = warningFor(marker, rel, ledgerByPath.get(rel) ?? null);
    if (msg && !seen.has(msg)) {
      seen.add(msg);
      messages.push(msg);
    }
  }
  if (messages.length) process.stdout.write(`${messages.join('\n\n')}\n`);
}

async function selfTest() {
  const marker = {
    candidate: 'c'.repeat(40),
    repairHead: 'r'.repeat(40),
    phase: 'repair-in-progress',
    failingPaths: ['packages/x/lib/a.test.ts'],
    legs: [{ legId: 'lint:tsc', status: 'red', subjectPaths: ['packages/x/lib/src.ts'] }],
  };
  let failures = 0;
  const fail = (m) => {
    failures += 1;
    process.stderr.write(`self-test FAIL: ${m}\n`);
  };
  const cases = [
    ['./packages/x/lib/a.test.ts', true],
    ['packages/x/lib/a.test.ts', true],
    ['packages\\x\\lib\\a.test.ts', true],
    ['packages/x/lib/src.ts', true], // P-019: a manifest leg's subject path is in the radius
    ['packages/x/lib/other.test.ts', false],
    ['', false],
  ];
  for (const [path, shouldWarn] of cases) {
    if ((warningFor(marker, path) !== null) !== shouldWarn) fail(`${JSON.stringify(path)} expected ${shouldWarn}`);
  }
  if (warningFor(null, 'packages/x/lib/a.test.ts') !== null) fail('a null marker must be silent');
  const msg = warningFor(marker, 'packages/x/lib/a.test.ts') ?? '';
  if (!msg.includes("op:'admit'")) fail('the message must name the sanctioned command (admit)');
  if (msg.includes("op:'converge'")) fail('the message must not name the retired converge spelling');
  if (!warningFor(marker, 'packages/x/lib/a.test.ts', { recorded: true })?.includes('RECORDED')) fail('recorded hunks must be named');
  if (!warningFor(marker, 'packages/x/lib/a.test.ts', { recorded: false, detail: 'x' })?.includes('NOT recorded')) fail('an unrecorded hunk must be named');
  // hunksFrom: the shapes the matcher admits
  const edit = hunksFrom({ tool_name: 'Edit', tool_input: { file_path: '/r/a.ts', old_string: 'o', new_string: 'n' } });
  if (edit.length !== 1 || edit[0].hunk.kind !== 'edit' || edit[0].hunk.replaceAll !== false) fail('Edit → one edit hunk');
  const write = hunksFrom({ tool_name: 'mcp__papercusp-su__capability_write', tool_input: { file_path: '/r/a.ts', content: 'b' } });
  if (write.length !== 1 || write[0].hunk.kind !== 'write' || write[0].hunk.body !== 'b') fail('capability_write → one write hunk');
  const multi = hunksFrom({
    tool_name: 'MultiEdit',
    tool_input: { file_path: '/r/a.ts', edits: [{ old_string: 'a', new_string: 'b' }, 'junk', { old_string: 'c', new_string: 'd', replace_all: true }] },
  });
  if (multi.length !== 2 || multi[1].editIndex !== 2 || multi[1].hunk.replaceAll !== true) fail('MultiEdit → N hunks with positions');
  const patch = ['*** Begin Patch', '*** Update File: /r/a.ts', '@@', '-old', '+new', '*** End Patch'].join('\n');
  const patchHunks = hunksFrom({ tool_name: 'apply_patch', tool_input: patch });
  if (patchHunks.length !== 1 || patchHunks[0].hunk.kind !== 'edit' || patchHunks[0].hunk.old !== 'old\n' || patchHunks[0].hunk.new !== 'new\n') fail('apply_patch → one edit hunk');
  const wrappedPatch = hunksFrom({ tool_name: 'apply_patch', tool_input: { input: patch } });
  if (wrappedPatch.length !== 1 || wrappedPatch[0].path !== '/r/a.ts') fail('wrapped apply_patch → one edit hunk');
  const added = hunksFrom({ tool_name: 'apply_patch', tool_input: ['*** Begin Patch', '*** Add File: /r/new.ts', '+new', '*** End Patch'].join('\n') });
  if (added.length !== 1 || added[0].hunk.kind !== 'write' || added[0].hunk.body !== 'new\n') fail('apply_patch Add → write hunk');
  if (editedPathsFrom({ tool_name: 'apply_patch', tool_input: patch }).join(',') !== '/r/a.ts') fail('apply_patch paths');
  if (hunksFrom({ tool_name: 'apply_patch', tool_input: 'diff' }).length !== 0) fail('malformed apply_patch extracts nothing');
  if (hunksFrom({ tool_name: 'Read', tool_input: { file_path: 'x' } }).length !== 0) fail('a read extracts nothing');
  if (!toolCallFailed({ tool_response: { is_error: true } }) || toolCallFailed({ tool_response: { ok: true } })) fail('toolCallFailed');
  // parseMcpToolResult: JSON, SSE, rpc error, isError
  const okJson = await parseMcpToolResult(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{"ok":true,"recorded":true}' }] } }));
  if (!okJson.ok || okJson.inner.recorded !== true) fail('parse JSON envelope');
  const okSse = await parseMcpToolResult('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\\"ok\\":true}"}]}}\n');
  if (!okSse.ok) fail('parse SSE envelope');
  if ((await parseMcpToolResult('{"jsonrpc":"2.0","id":1,"error":{"message":"nope"}}')).ok) fail('rpc error is not ok');
  if ((await parseMcpToolResult('{"jsonrpc":"2.0","id":1,"result":{"isError":true,"content":[{"type":"text","text":"bad"}]}}')).ok) fail('isError is not ok');
  if (ownerIdentity({ session_id: 's1' }, { PAPERCUSP_LOCK_SID: 'lock-1' }, () => '') !== 'lock-1') fail('owner: lock sid wins');
  if (ownerIdentity({ session_id: 's1' }, {}, () => { throw new Error('x'); }) !== 's1') fail('owner: session id fallback');
  process.stdout.write(failures === 0 ? 'self-test OK\n' : `self-test: ${failures} failure(s)\n`);
  process.exit(failures === 0 ? 0 : 1);
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (process.argv.includes('--self-test')) selfTest();
else if (invokedDirectly) main().catch(() => {});
