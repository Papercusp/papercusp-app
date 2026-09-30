#!/usr/bin/env node
// apps/operator/scripts/hooks/cc/posttooluse-proof-stale-nudge.mjs
//
// PostToolUse (Edit|Write|MultiEdit) advisory: tell the editor, AT THE EDIT, which live
// proof the edit just staled (P-040, review-system-rework-reduction-2026-09-23, R-9).
//
// A `repo-files` spec-evidence binding's freshness is a content hash of the files it
// measured, so editing any of them stales that proof. Nothing said so at the edit: the
// editor — often a PEER of the proof's holder — learned it at the next gate probe.
// Measured 2026-09-23 (owner order #302): su-9306f9c3 staled R-1, R-3 and R-4 by trimming tool
// guidance to fit the prompt budget; on this plan peer edits staled P-001 once, P-002
// twice and P-004 four times (D-006; EI-24053039097767980).
//
// What it does, after a successful edit of a file inside a repository:
//   1. asks the operator `plans:evidence-measuring-paths { paths:[<repo-relative path>] }`
//      which clauses on unshipped plans hold current-revision repo-files proof measuring it;
//   2. prints an advisory naming those clauses and BARs, their holders and the one
//      re-measure call — once per edit burst on that path, not on every keystroke-sized Edit;
//   3. sends each PEER holder (never the editor) ONE coord notice per edit burst per clause.
//
// Advisory only and fail-OPEN everywhere: PostToolUse cannot block, a slow or missing
// operator costs at most one bounded timeout (then a 60s circuit breaker), and any error
// ends silently. Per-path answers are cached for 2 minutes so a burst of edits to one file
// costs one lookup. The lookup tries the primary operator, then the staging operator
// (`:3170`) — a newly shipped tool reaches staging before green `:3070`.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import process from 'node:process';

export const BURST_GAP_MS = 10 * 60 * 1000;
export const LOOKUP_CACHE_TTL_MS = 2 * 60 * 1000;
export const BREAKER_MS = 60 * 1000;
export const LOOKUP_TIMEOUT_MS = 2500;
const STATE_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_ADVISORY_CLAUSES = 8;
const MAX_INLINE_CALLS = 2;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Bundle-safe entry check: compare the PROCESS ENTRY basename, never
 * `resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))` — once inlined into
 * a bundle every module inherits the bundle entry's `import.meta.url`
 * (scripts/check-no-hand-rolled-cli-entry.mjs).
 */
function isDirectCliInvocation(entryPath = process.argv[1]) {
  return typeof entryPath === 'string' && /(?:^|[\\/])posttooluse-proof-stale-nudge\.mjs$/.test(entryPath);
}

export function normalizeRepoPath(value) {
  return String(value ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/{2,}/g, '/');
}

/** The file paths a successful Edit/Write/MultiEdit touched (one for every current tool). */
export function editedPathsFrom(payload) {
  const input = payload?.tool_input ?? {};
  const out = [];
  for (const candidate of [input.file_path, input.filePath, input.path]) {
    if (typeof candidate === 'string' && candidate.trim()) out.push(candidate.trim());
  }
  return [...new Set(out)];
}

/** A failed edit changed nothing, so it staled nothing. */
export function toolCallFailed(payload) {
  const r = payload?.tool_response;
  if (!r || typeof r !== 'object') return false;
  return r.success === false || r.is_error === true || r.isError === true || typeof r.error === 'string';
}

/**
 * `{ root, rel }` for an edited file: the SUPERPROJECT root when the file sits in a
 * submodule (a binding measures superproject-relative paths — every migration lives in
 * libs/papercusp), else the toplevel. Null outside any repository.
 */
export function repoLocation(filePath, cwd = process.cwd(), git = execFileSync) {
  try {
    const abs = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
    let real = abs;
    try {
      real = realpathSync(abs);
    } catch {
      real = abs;
    }
    const lines = String(
      git('git', ['-C', dirname(real), 'rev-parse', '--show-superproject-working-tree', '--show-toplevel'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3000,
      }),
    )
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const root = lines[0];
    if (!root) return null;
    let realRoot = root;
    try {
      realRoot = realpathSync(root);
    } catch {
      realRoot = root;
    }
    const rel = relative(realRoot, real);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
    return { root: realRoot, rel: normalizeRepoPath(rel) };
  } catch {
    return null;
  }
}

/** Editor identity, in the same precedence the lock and frozen-candidate hooks use. */
export function editorIdentity(payload, env = process.env) {
  if (typeof env.PAPERCUSP_LOCK_SID === 'string' && env.PAPERCUSP_LOCK_SID) return env.PAPERCUSP_LOCK_SID;
  if (typeof env.PAPERCUSP_SID === 'string' && env.PAPERCUSP_SID) return env.PAPERCUSP_SID;
  if (typeof payload?.session_id === 'string' && payload.session_id) return payload.session_id;
  return null;
}

/** Parse an MCP `tools/call` HTTP body (plain JSON or SSE-framed) into the tool's JSON data. */
export function parseToolResult(rawText) {
  const text = String(rawText ?? '');
  const candidates = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('data:')) candidates.push(line.slice(5).trim());
  }
  if (candidates.length === 0) candidates.push(text.trim());
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    let envelope;
    try {
      envelope = JSON.parse(candidates[i]);
    } catch {
      continue;
    }
    if (envelope?.error) return { ok: false, detail: String(envelope.error.message ?? 'rpc error').slice(0, 160) };
    const result = envelope?.result;
    if (!result) continue;
    const first = Array.isArray(result.content) ? result.content.find((c) => c?.type === 'text') : null;
    if (!first) continue;
    let data;
    try {
      data = JSON.parse(first.text);
    } catch {
      return { ok: false, detail: String(first.text).slice(0, 160) };
    }
    if (result.isError === true || data?.ok === false) {
      return { ok: false, detail: String(data?.error ?? data?.reason ?? first.text).slice(0, 160), data };
    }
    return { ok: true, data };
  }
  return { ok: false, detail: 'unparseable operator response' };
}

function mcpUrl(baseUrl, owner) {
  return (
    String(baseUrl ?? '').replace(/\/api\/mcp.*$/, '').replace(/\/+$/, '') +
    '/api/mcp?superuser=1&origin=hook&format=json&client=' +
    encodeURIComponent(owner || 'proof-stale-nudge')
  );
}

export async function callTool({ baseUrl, token, owner, name, args, fetchImpl = fetch, timeoutMs = LOOKUP_TIMEOUT_MS }) {
  try {
    const res = await fetchImpl(mcpUrl(baseUrl, owner), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const parsed = parseToolResult(await res.text());
    return res.ok ? parsed : { ...parsed, ok: false, detail: `HTTP ${res.status}: ${parsed.detail ?? ''}` };
  } catch (err) {
    return { ok: false, transport: true, detail: err?.name === 'TimeoutError' ? 'operator timeout' : String(err?.message ?? err).slice(0, 120) };
  }
}

/** Primary operator first; the staging operator carries a newly shipped tool sooner. */
export async function lookupMeasuringClauses({ urls, token, owner, path, fetchImpl = fetch }) {
  let last = { ok: false, detail: 'no operator url' };
  for (const baseUrl of urls) {
    const r = await callTool({ baseUrl, token, owner, name: 'plans:evidence-measuring-paths', args: { paths: [path] }, fetchImpl });
    if (r.ok && Array.isArray(r.data?.clauses)) {
      return {
        ok: true,
        clauses: r.data.clauses,
        totalClauses: Number(r.data.totalClauses ?? r.data.clauses.length),
        holders: Array.isArray(r.data.holders) ? r.data.holders : [],
      };
    }
    last = r;
  }
  return { ok: false, detail: last.detail };
}

/**
 * The burst decision, pure. A path's advisory and each (peer holder, path) notice fire when
 * no edit touched that path within `gapMs`; every edit extends the burst. `holders` is the
 * tool's summary over ALL matched clauses (never cut by its budget), so a peer whose clause
 * fell off a hot file's truncated list is still told. Entries older than a day are pruned
 * so the state file cannot grow without bound.
 */
export function planBurst({ state, holders, editor, path, nowMs, gapMs = BURST_GAP_MS }) {
  const next = {};
  for (const [key, entry] of Object.entries(state ?? {})) {
    if (entry && typeof entry.lastEditAtMs === 'number' && nowMs - entry.lastEditAtMs <= STATE_RETENTION_MS) next[key] = entry;
  }
  const opens = (key) => {
    const prior = next[key];
    const opened = !prior || nowMs - prior.lastEditAtMs > gapMs;
    next[key] = { lastEditAtMs: nowMs };
    return opened;
  };
  const advisoryDue = opens(`advisory|${path}`);
  const notices = new Map();
  for (const h of holders ?? []) {
    if (!h?.holder || h.holder === editor) continue;
    if (!opens(`notice|${h.holder}|${path}`)) continue;
    notices.set(h.holder, h);
  }
  return { advisoryDue, notices, next };
}

function shortId(id) {
  const s = String(id ?? '');
  const m = /^(su-[0-9a-z]{8})/i.exec(s);
  return m ? m[1] : s;
}

function clauseLine(c, editor) {
  const holder = `${shortId(c.holder)}${c.holder === editor ? ' (you)' : ''}${c.holderSource === 'bound-by' ? ' [bound it]' : ''}`;
  const kinds = Array.isArray(c.kinds) && c.kinds.length ? ` · ${c.kinds.join('/')} ×${c.bindingCount ?? 1}` : '';
  return `  • ${c.bar ? 'BAR ' : ''}${c.clause} · plan ${c.plan} · ${c.workItemId} · holder ${holder}${kinds}`;
}

/** The advisory the editor sees. */
export function formatAdvisory({ path, clauses, totalClauses, editor, holders = [], noticed = [], noticeFailures = [] }) {
  const shown = clauses.slice(0, MAX_ADVISORY_CLAUSES);
  const bars = clauses.filter((c) => c.bar).length;
  const lines = [
    `⚠ PROOF STALED — \`${path}\` is measured by live proof on ${totalClauses} clause(s)` +
      `${bars ? ` (${bars} BAR)` : ''} of unshipped plans. Your edit changed its bytes, so each proof below is now source/test-stale until re-measured:`,
    ...shown.map((c) => clauseLine(c, editor)),
  ];
  if (totalClauses > shown.length) lines.push(`  … +${totalClauses - shown.length} more.`);
  if (holders.length) {
    const who = holders.map(
      (h) => `${shortId(h.holder)}${h.holder === editor ? ' (you)' : ''} ${h.clauses}${h.bars ? ` (${h.bars} BAR)` : ''}`,
    );
    lines.push(`Holders across all ${totalClauses} clause(s): ${who.join(', ')}.`);
  }
  const calls = shown.filter((c) => c.remeasure?.call).slice(0, MAX_INLINE_CALLS);
  if (calls.length) {
    lines.push('Re-measure — one call per clause (for test/mutation/counterexample proof, RE-RUN it first and bind the new run):');
    for (const c of calls) lines.push(`  ${c.remeasure.call.tool} ${JSON.stringify(c.remeasure.call.args)}`);
  }
  lines.push(`Every clause's exact call: plans:evidence-measuring-paths { paths:['${path}'] }.`);
  if (noticed.length) lines.push(`Peer holders told once for this edit burst: ${noticed.map(shortId).join(', ')}.`);
  if (noticeFailures.length) lines.push(`Could not notify: ${noticeFailures.map(shortId).join(', ')} — tell them yourself if the edit stands.`);
  lines.push('Advisory only — nothing is blocked. If you meant to change this code, re-measure (or tell the holder) before anyone relies on the proof.');
  return lines.join('\n');
}

/**
 * The coord notice one peer holder receives, from the tool's holder summary; kept under
 * the 600-char inbox body cap so the recipient reads all of it.
 */
export function formatNotice({ editor, path, holder }) {
  const count = Number(holder?.clauses ?? 0);
  const bars = Number(holder?.bars ?? 0);
  const sample = Array.isArray(holder?.sample) ? holder.sample : [];
  const workItems = Array.isArray(holder?.workItems) ? holder.workItems : [];
  const what = `${count} clause(s)${bars ? ` incl. ${bars} BAR` : ''}: ${sample.join(', ')}${count > sample.length ? ', …' : ''}`;
  const summary = `${shortId(editor)} edited ${path}, measured by your live proof on ${what}`.slice(0, 280);
  const text = (
    `${shortId(editor)} edited \`${path}\`. Your repo-files proof on ${what} (${workItems.join(', ')}) measured it, so it is now stale. ` +
    `If the edit stands, re-measure: plans:evidence-measuring-paths { paths:['${path}'] } returns each clause's plans:bind-spec-evidence call ` +
    '(re-run test/mutation proof first). One notice per edit burst.'
  ).slice(0, 590);
  return { summary, text };
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(path, value) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value) + '\n');
  } catch {
    /* advisory bookkeeping — never fail the edit */
  }
}

function readStdin(timeoutMs) {
  return new Promise((resolveStdin) => {
    let data = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolveStdin(data || '{}');
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      finish();
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      finish();
    });
  });
}

export async function run(payload, { env = process.env, nowMs = Date.now(), fetchImpl = fetch, git = execFileSync } = {}) {
  if (toolCallFailed(payload)) return null;
  const editor = editorIdentity(payload, env);
  if (!editor || !SESSION_ID_PATTERN.test(editor)) return null; // no session-owned state, no attribution
  let token = '';
  try {
    token = readFileSync(join(homedir(), '.papercusp', 'superuser-token'), 'utf8').trim();
  } catch {
    return null;
  }
  if (!token) return null;
  const urls = [
    String(env.PAPERCUSP_OPERATOR_URL ?? 'http://127.0.0.1:3070'),
    String(env.PAPERCUSP_STAGING_OPERATOR_URL ?? 'http://127.0.0.1:3170'),
  ].filter((u, i, all) => u && all.indexOf(u) === i);

  const messages = [];
  for (const filePath of editedPathsFrom(payload)) {
    const loc = repoLocation(filePath, payload?.cwd ?? process.cwd(), git);
    if (!loc) continue;
    const statePath = join(loc.root, '.papercusp', 'scratch', `proof-stale-nudge.${editor}.json`);
    const state = readJson(statePath) ?? {};
    const cache = state.cache ?? {};
    let clauses;
    let totalClauses;
    let holders;
    const cached = cache[loc.rel];
    if (cached && nowMs - cached.atMs <= LOOKUP_CACHE_TTL_MS) {
      ({ clauses, totalClauses, holders } = cached);
    } else {
      if (typeof state.breakerAtMs === 'number' && nowMs - state.breakerAtMs < BREAKER_MS) continue;
      const found = await lookupMeasuringClauses({ urls, token, owner: editor, path: loc.rel, fetchImpl });
      if (!found.ok) {
        writeJson(statePath, { ...state, breakerAtMs: nowMs });
        continue;
      }
      clauses = found.clauses;
      totalClauses = found.totalClauses;
      holders = found.holders;
      cache[loc.rel] = { atMs: nowMs, clauses, totalClauses, holders };
    }
    for (const key of Object.keys(cache)) if (nowMs - cache[key].atMs > LOOKUP_CACHE_TTL_MS) delete cache[key];
    if (!clauses?.length) {
      writeJson(statePath, { ...state, cache, breakerAtMs: undefined });
      continue;
    }
    const burst = planBurst({ state: state.burst, holders, editor, path: loc.rel, nowMs });
    const noticed = [];
    const noticeFailures = [];
    for (const [holder, entry] of burst.notices) {
      const { summary, text } = formatNotice({ editor, path: loc.rel, holder: entry });
      const sent = await callTool({
        baseUrl: urls[0],
        token,
        owner: editor,
        name: 'coord:send',
        fetchImpl,
        args: {
          to: [holder],
          expects: 'none',
          summary,
          body: [{ text, forYouBecause: { relation: 'owns', ...(entry.workItems?.[0] ? { ref: entry.workItems[0] } : {}) } }],
        },
      });
      // coord:send reports ok:false when an inbox shows a clipped body; the row still
      // landed, so only a transport failure or a missing msg id counts as "not told".
      const landed = sent.ok || (Array.isArray(sent.data?.results) && sent.data.results.some((r) => r?.msg_id));
      (landed ? noticed : noticeFailures).push(holder);
    }
    writeJson(statePath, { cache, burst: burst.next });
    if (burst.advisoryDue) {
      messages.push(formatAdvisory({ path: loc.rel, clauses, totalClauses, editor, holders: holders ?? [], noticed, noticeFailures }));
    }
  }
  return messages.length ? messages.join('\n\n') : null;
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin(250));
  } catch {
    process.exit(0);
  }
  try {
    const msg = await run(payload);
    if (msg) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: msg } }));
    }
  } catch {
    // Fail OPEN, always. A nudge is never worth breaking an edit over.
  }
  process.exit(0);
}

if (isDirectCliInvocation()) await main();
