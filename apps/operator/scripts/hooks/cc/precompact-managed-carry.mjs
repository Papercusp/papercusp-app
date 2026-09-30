#!/usr/bin/env node
/**
 * Managed Codex PreCompact bridge.
 *
 * Native automatic compaction bypasses Papercusp's deterministic carry,
 * checkpoint gate, lifecycle marker, and successor authority assembly. Codex's
 * synchronous PreCompact hook is the one supported point that can stop that
 * cut before it happens. This bridge asks the existing
 * session:request-compaction tool to schedule the managed boundary, then
 * returns continue:false: a refused or unavailable managed boundary leaves the
 * current process intact and reports the actionable reason; it never falls
 * through to an unmanaged native compaction.
 *
 * ONE exception (WI-10002522): a thread that is a native FORK and has not
 * sampled a single model turn since it was cut. Legacy managed carry successors
 * and explicit user forks can inherit the predecessor's whole model context.
 * Current managed carry starts fresh (EI-24046655564306940), but older hosts
 * and explicit forks still need this recovery guard. When inherited context trips auto-compaction,
 * another managed boundary cannot shed it — the next successor forks the same
 * context and trips again before its first sample. Measured 2026-09-23: 13 cuts
 * in 10 minutes with zero model turns for one agent at 784140/784800 tokens.
 * The managed boundary has already been applied to that thread (its carry
 * document is installed in AGENTS.md), so the bridge lets Codex compact the
 * inherited history natively instead of re-forking it forever.
 *
 * PAPERCUSP_MCP_URL is the exact per-session URL already written to the managed
 * CODEX_HOME. Keeping that exact URL preserves workspace, harness, role, tool
 * allowlist, signature, and owner route. Superuser homes additionally set
 * PAPERCUSP_MCP_AUTH=superuser-token; the bearer is read from its mode-0600 file
 * at execution time, never embedded in hooks.json or exposed in argv.
 */

import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MAX_INPUT_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 590_000;
/** Same bound psu-launcher's latestCodexRollout applies to a rollout it trusts. */
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

function objectOrNull(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function parseJsonObject(text) {
  try {
    return objectOrNull(JSON.parse(String(text)));
  } catch {
    return null;
  }
}

/** Parse JSON, JSON-RPC/SSE, and CallToolResult envelopes into the tool body. */
export function parseManagedCarryResponse(rawText) {
  let rpcResult = null;
  let rpcError = null;
  for (let line of String(rawText ?? '').split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('event:')) continue;
    if (line.startsWith('data:')) line = line.slice(5).trim();
    const frame = parseJsonObject(line);
    if (!frame) continue;
    if (Object.prototype.hasOwnProperty.call(frame, 'error')) {
      rpcError = frame.error;
      break;
    }
    if (Object.prototype.hasOwnProperty.call(frame, 'result')) {
      rpcResult = frame.result;
      break;
    }
    if (Array.isArray(frame.content) || Object.prototype.hasOwnProperty.call(frame, 'ok')) {
      rpcResult = frame;
      break;
    }
  }
  if (rpcError) {
    return { ok: false, detail: String(rpcError?.message ?? 'JSON-RPC error') };
  }
  const result = objectOrNull(rpcResult);
  if (!result) return { ok: false, detail: 'operator returned no MCP result' };
  if (Object.prototype.hasOwnProperty.call(result, 'ok')) {
    return { ok: true, inner: result, isError: result.isError === true };
  }
  // MCP clients may negotiate an object result in `structuredContent` instead
  // of a JSON text content block. Keep this bridge tolerant of either valid
  // result representation; the request below still pins JSON text so older
  // result doors do not silently return compact/TOON to this JSON parser.
  const structured = result.structuredContent;
  if (structured && typeof structured === 'object' && !Array.isArray(structured)) {
    return { ok: true, inner: structured, isError: result.isError === true };
  }
  if (typeof structured === 'string') {
    const inner = parseJsonObject(structured);
    if (inner) return { ok: true, inner, isError: result.isError === true };
  }
  for (const part of result.content ?? []) {
    if (part?.type !== 'text' || typeof part.text !== 'string') continue;
    const inner = parseJsonObject(part.text);
    if (inner) return { ok: true, inner, isError: result.isError === true };
  }
  return {
    ok: false,
    detail: result.isError === true
      ? boundedDetail(
        (result.content ?? [])
          .filter((part) => part?.type === 'text' && typeof part.text === 'string')
          .map((part) => part.text)
          .join(' '),
        'session:request-compaction returned an unreadable tool error',
      )
      : 'MCP result carried no JSON text',
  };
}

function boundedDetail(value, fallback) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return (text || fallback).slice(0, 700);
}

/** Convert every managed outcome to Codex's fail-closed PreCompact response. */
export function preCompactDecision(parsed) {
  const stopReason =
    'Papercusp intercepted automatic native compaction; only the managed carry boundary may replace this session.';
  if (!parsed?.ok || !parsed.inner) {
    return {
      continue: false,
      stopReason,
      systemMessage:
        'Managed carry could not be requested, so native compaction was stopped and this process remains intact. ' +
        `Retry session:request-compaction at a clean boundary. Detail: ${boundedDetail(parsed?.detail, 'unknown transport response')}`,
    };
  }
  const inner = parsed.inner;
  const queued = inner.ok === true && inner.requested === true && inner.respawn === 'queued';
  if (queued) {
    return {
      continue: false,
      stopReason,
      systemMessage:
        'Managed carry-respawn is QUEUED, not yet completed. Native compaction was stopped. ' +
        'Finish the atomic step, flush current work-item/loop state, then let the turn go quiet so the managed host can cut and resume this logical session.',
    };
  }
  const error = inner.error ?? inner.reason ??
    (parsed.isError ? 'tool-refused' : 'managed-boundary-not-queued');
  const note = inner.note ?? inner.message ?? inner.detail ?? '';
  return {
    continue: false,
    stopReason,
    systemMessage:
      `Managed carry was NOT queued (${boundedDetail(error, 'unknown refusal')}); native compaction was stopped and this process remains intact. ` +
      boundedDetail(note, 'Resolve the named prerequisite and retry session:request-compaction at a clean boundary.'),
  };
}

/**
 * Classify the thread Codex wants to compact from its own rollout: is it a
 * native fork, and has it sampled a model turn yet? Codex writes a fork's
 * `session_meta.forked_from_id` on the first line and references the parent's
 * history instead of copying it, so a fork rollout carries no `token_count`
 * until the fork itself samples. Fail-soft: anything unreadable reports
 * `readable:false`, and the caller keeps the managed boundary. `sampled` is
 * only measured for a fork (null = not checked), so a large original rollout
 * is never scanned.
 * @param {unknown} transcriptPath
 * @returns {{ readable: boolean, forkedFromId: string | null, sampled: boolean | null }}
 */
export function inspectCodexTranscript(transcriptPath) {
  const unreadable = { readable: false, forkedFromId: null, sampled: null };
  if (typeof transcriptPath !== 'string' || !transcriptPath.trim()) return unreadable;
  let text;
  try {
    const stat = statSync(transcriptPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_TRANSCRIPT_BYTES) return unreadable;
    text = readFileSync(transcriptPath, 'utf8');
  } catch {
    return unreadable;
  }
  const firstBreak = text.indexOf('\n');
  const meta = parseJsonObject(firstBreak >= 0 ? text.slice(0, firstBreak) : text);
  if (meta?.type !== 'session_meta') return unreadable;
  const forkedFrom = objectOrNull(meta.payload)?.forked_from_id;
  const forkedFromId = typeof forkedFrom === 'string' && forkedFrom.trim() ? forkedFrom : null;
  if (!forkedFromId) return { readable: true, forkedFromId: null, sampled: null };
  for (const line of text.split('\n')) {
    if (!line.includes('"token_count"')) continue;
    const payload = objectOrNull(parseJsonObject(line)?.payload);
    if (payload?.type === 'token_count' && objectOrNull(payload.info)) {
      return { readable: true, forkedFromId, sampled: true };
    }
  }
  return { readable: true, forkedFromId, sampled: false };
}

/**
 * The one PreCompact outcome that lets native compaction run: an unsampled
 * fork whose over-limit context is inherited (see the file header).
 * @param {string} forkedFromId
 */
export function inheritedContextDecision(forkedFromId) {
  return {
    continue: true,
    systemMessage:
      `Managed carry already applied: this thread is a fork of ${boundedDetail(forkedFromId, 'its predecessor')} and has not sampled a turn yet, ` +
      'so the context over the limit is INHERITED. Another managed carry would fork the same context and loop (WI-10002522), ' +
      'so Codex will compact this successor natively instead. The deterministic carry document is in AGENTS.md.',
  };
}

function readSuperuserToken(env) {
  if (env.PAPERCUSP_MCP_AUTH !== 'superuser-token') return '';
  const path = env.PAPERCUSP_SUPERUSER_TOKEN_PATH ||
    join(homedir(), '.papercusp', 'superuser-token');
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * Run the bridge with injectable transport/token readers for hermetic tests.
 * @param {Record<string, unknown>} payload
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   fetchImpl?: typeof globalThis.fetch,
 *   readToken?: (env: Record<string, string | undefined>) => string,
 *   inspectTranscript?: (transcriptPath: unknown) => { readable: boolean, forkedFromId: string | null, sampled: boolean | null },
 * }} [options]
 */
export async function runManagedPreCompact(payload, options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const input = objectOrNull(payload);
  if (!input || input.hook_event_name !== 'PreCompact' || input.trigger !== 'auto') {
    return preCompactDecision({
      ok: false,
      detail: 'invalid PreCompact payload (expected hook_event_name=PreCompact and trigger=auto)',
    });
  }
  const transcript = (options.inspectTranscript ?? inspectCodexTranscript)(input.transcript_path);
  if (transcript.readable && transcript.forkedFromId && transcript.sampled === false) {
    return inheritedContextDecision(transcript.forkedFromId);
  }
  const mcpUrl = String(env.PAPERCUSP_MCP_URL ?? '').trim();
  const sid = String(env.PAPERCUSP_SID ?? '').trim();
  if (!mcpUrl || !sid || typeof fetchImpl !== 'function') {
    return preCompactDecision({ ok: false, detail: 'managed MCP URL or session identity is missing' });
  }
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  const token = options.readToken ? options.readToken(env) : readSuperuserToken(env);
  if (env.PAPERCUSP_MCP_AUTH === 'superuser-token') {
    if (!token) {
      return preCompactDecision({ ok: false, detail: 'superuser token is missing or unreadable' });
    }
    headers.Authorization = `Bearer ${token}`;
  }
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    // Raw MCP callers must negotiate JSON explicitly. The result door defaults
    // to compact/TOON for eligible tools, which is not parseable by this hook.
    params: {
      name: 'session:request-compaction',
      arguments: {},
      _meta: { format: 'json' },
    },
  });
  try {
    const response = await fetchImpl(mcpUrl, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const raw = await response.text();
    const parsed = parseManagedCarryResponse(raw);
    if (!response.ok && !parsed.ok) parsed.detail = `HTTP ${response.status}: ${parsed.detail}`;
    return preCompactDecision(parsed);
  } catch (error) {
    return preCompactDecision({
      ok: false,
      detail: error?.name === 'TimeoutError'
        ? 'operator request timed out'
        : boundedDetail(error?.message, 'operator request failed'),
    });
  }
}

async function readStdin() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_INPUT_BYTES) throw new Error('hook input exceeds 1 MiB');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * This file is installed verbatim under ~/.papercusp/hooks/cc and runs from an
 * arbitrary cwd. It must not import the source-only operator-core workspace
 * package: Node resolves bare packages from the hook's directory ancestry, not
 * from the Papercusp checkout, so that import fails with ERR_MODULE_NOT_FOUND
 * on a normal installed hook. Pin the direct-entry check to this installed
 * filename instead; it is bundle-safe and has no repository dependency.
 */
export function isDirectCliInvocation(entryPath = process.argv[1]) {
  return typeof entryPath === 'string' && /(?:^|[\\/])precompact-managed-carry\.mjs$/.test(entryPath);
}

async function main() {
  let payload = null;
  try {
    payload = JSON.parse(await readStdin());
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify(preCompactDecision({ ok: false, detail: error?.message ?? 'invalid JSON input' }))}\n`,
    );
    return;
  }
  process.stdout.write(`${JSON.stringify(await runManagedPreCompact(payload))}\n`);
}

if (isDirectCliInvocation()) {
  await main();
}
