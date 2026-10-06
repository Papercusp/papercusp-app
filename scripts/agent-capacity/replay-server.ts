/**
 * Fake model server for the agent-capacity load driver
 * (plan agent-capacity-and-cost-gcp-2026-09-30, P-003).
 *
 * Serves the responses recorded by `record-proxy.ts` back to real claude / codex CLIs, with
 * the recorded first-byte and inter-chunk delays, so N agents run their real tool commands on
 * a test VM without spending model quota. One server process serves any number of concurrent
 * replays:
 *
 *   base URL for one agent = http://<host>:<port>/r/<sessionId>/<instance>
 *     claude: ANTHROPIC_BASE_URL=<base>            (the CLI appends /v1/messages?beta=true)
 *     codex:  model_providers.<p>.base_url=<base>/v1
 *
 * `<sessionId>` names a directory under the corpus; `<instance>` is any token the driver picks,
 * so N agents can replay the SAME recording, each with its own consumption state.
 *
 * Matching. Request bodies were not recorded (they rebuild during replay), only a fingerprint.
 * Claude Code runs a subagent's requests concurrently with the main thread's, so arrival order
 * is not a reliable key. Each request takes the EARLIEST unconsumed recorded exchange at the
 * best tier available:
 *   exact — same method, path, model, message count and tool count
 *   shape — same method, path and model (the conversation diverged)
 *   path  — same method and path
 * When nothing is left the server answers 400 `replay_exhausted`: neither CLI retries a 400,
 * so a diverged replay ends at once instead of spinning in retry backoff. Every served request
 * is logged with its tier so the driver can reject a replay that diverged.
 *
 *   npx tsx scripts/agent-capacity/replay-server.ts --corpus <dir> [--port 18700] [--speed 1] \
 *     [--log <served.jsonl>]
 *
 * `--speed` divides every recorded delay (2 = twice as fast; 0 = no delays at all).
 */
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, type WriteStream } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  decodeChunk,
  encodeChunk,
  fingerprintRequest,
  reportedExecSessions,
  type ExecSessionReport,
  type InputToolOutputSummary,
  type RecordedChunk,
  type RecordedExchange,
  type RequestFingerprint,
} from './record-proxy';

export type MatchTier = 'exact' | 'shape' | 'path';

export interface IncomingRequest {
  method: string;
  /** Path relative to the replay base, e.g. `/v1/messages?beta=true`. */
  path: string;
  fp: RequestFingerprint;
}

export interface ReplayState {
  sessionId: string;
  instance: string;
  exchanges: readonly RecordedExchange[];
  consumed: boolean[];
  counts: Record<MatchTier | 'exhausted', number>;
}

export function newReplayState(sessionId: string, instance: string, exchanges: readonly RecordedExchange[]): ReplayState {
  return {
    sessionId,
    instance,
    exchanges,
    consumed: exchanges.map(() => false),
    counts: { exact: 0, shape: 0, path: 0, exhausted: 0 },
  };
}

function tierOf(ex: RecordedExchange, req: IncomingRequest): MatchTier | null {
  if (ex.method !== req.method || ex.path !== req.path) return null;
  if (ex.req.model !== req.fp.model) return 'path';
  if (ex.req.messages !== req.fp.messages || ex.req.tools !== req.fp.tools) return 'shape';
  return 'exact';
}

const RANK: Record<MatchTier, number> = { exact: 0, shape: 1, path: 2 };

/**
 * Pick (and consume) the recorded exchange this request should receive: the earliest
 * unconsumed one at the best tier. Returns null when nothing on this method+path is left.
 */
export function takeExchange(state: ReplayState, req: IncomingRequest): { exchange: RecordedExchange; tier: MatchTier } | null {
  let best = -1;
  let bestTier: MatchTier | null = null;
  for (let i = 0; i < state.exchanges.length; i++) {
    if (state.consumed[i]) continue;
    const tier = tierOf(state.exchanges[i], req);
    if (tier === null) continue;
    if (bestTier === null || RANK[tier] < RANK[bestTier]) {
      best = i;
      bestTier = tier;
      if (tier === 'exact') break;
    }
  }
  if (bestTier === null) {
    state.counts.exhausted++;
    return null;
  }
  state.consumed[best] = true;
  state.counts[bestTier]++;
  return { exchange: state.exchanges[best], tier: bestTier };
}

export function parseExchanges(jsonl: string): RecordedExchange[] {
  const out: RecordedExchange[] = [];
  for (const line of jsonl.split('\n')) if (line.trim()) out.push(JSON.parse(line) as RecordedExchange);
  // Recorded in COMPLETION order; replay ranks by request order.
  return out.sort((a, b) => a.seq - b.seq);
}

// ---------------------------------------------------------------------------------------------
// Work-dir rewriting.
//
// A recording's tool calls name ABSOLUTE paths inside the checkout it ran in
// (`~/.cache/agent-capacity/work/<sessionId>`). Served unchanged, a replay's Write lands outside
// its own checkout and the next Bash fails, so the tool work no longer follows the recording
// even while every request matches `exact`. Each instance therefore gets the recorded work dir
// rewritten to its own.
//
// The path is rarely whole inside one SSE event: tool input streams as `input_json_delta`
// (Anthropic) or `*.delta` (OpenAI Responses) fragments that split it anywhere. So the rewrite
// reassembles each delta stream, replaces across the fragment boundaries, and redistributes
// the result over the same events; non-delta events get a recursive string replace.
// ---------------------------------------------------------------------------------------------

export interface PathRewrite {
  from: string;
  to: string;
}

/**
 * Replace `from` with `to` in the concatenation of `pieces`, then cut the result back into the
 * same number of pieces at the mapped boundaries. A boundary that fell inside a match moves to
 * the end of its replacement. Returns `pieces` itself when nothing matched.
 */
export function replaceAcross(pieces: readonly string[], from: string, to: string): readonly string[] {
  const s = pieces.join('');
  if (!from || from === to || !s.includes(from)) return pieces;
  const edits: Edit[] = [];
  for (let i = s.indexOf(from); i >= 0; i = s.indexOf(from, i + from.length)) edits.push({ start: i, end: i + from.length, to });
  return spliceAcross(pieces, edits);
}

/** One replacement in the concatenation of a piece list: `[start, end)` becomes `to`. */
export interface Edit {
  start: number;
  end: number;
  to: string;
}

/**
 * Apply sorted, non-overlapping `edits` to the concatenation of `pieces`, then cut the result
 * back into the same number of pieces at the mapped boundaries. A boundary that fell inside an
 * edited span moves to the end of its replacement. Returns `pieces` itself when no edit changes
 * anything.
 */
export function spliceAcross(pieces: readonly string[], edits: readonly Edit[]): readonly string[] {
  const s = pieces.join('');
  const real = edits.filter((e) => s.slice(e.start, e.end) !== e.to);
  if (real.length === 0) return pieces;
  let out = '';
  let at = 0;
  for (const e of real) {
    out += s.slice(at, e.start) + e.to;
    at = e.end;
  }
  out += s.slice(at);
  const mapCut = (cut: number): number => {
    let shift = 0;
    for (const e of real) {
      if (e.end <= cut) shift += e.to.length - (e.end - e.start);
      else if (e.start < cut) return e.start + shift + e.to.length;
      else break;
    }
    return cut + shift;
  };
  const res: string[] = [];
  let oldEnd = 0;
  let newStart = 0;
  for (let k = 0; k < pieces.length; k++) {
    oldEnd += pieces[k].length;
    const newEnd = k === pieces.length - 1 ? out.length : mapCut(oldEnd);
    res.push(out.slice(newStart, newEnd));
    newStart = newEnd;
  }
  return res;
}

/** Both spellings a path can take: raw (text, already-parsed JSON) and JSON-escaped (partial_json source). */
function variants(rw: PathRewrite): PathRewrite[] {
  const esc = (s: string) => JSON.stringify(s).slice(1, -1);
  const out = [rw];
  if (esc(rw.from) !== rw.from) out.push({ from: esc(rw.from), to: esc(rw.to) });
  return out;
}

/**
 * Rewrites the concatenation of a piece list and hands back the same number of pieces (see
 * `spliceAcross`), or the input array itself when nothing changed.
 */
export type PieceRewriter = (pieces: readonly string[]) => readonly string[];

function pathRewriter(rw: PathRewrite): PieceRewriter {
  return (pieces) => {
    let cur = pieces;
    for (const v of variants(rw)) cur = replaceAcross(cur, v.from, v.to);
    return cur;
  };
}

/** Recursive string rewrite; returns the input itself when nothing changed. */
function deepReplace(v: unknown, fn: PieceRewriter): unknown {
  if (typeof v === 'string') {
    const [r] = fn([v]);
    return r;
  }
  if (Array.isArray(v)) {
    let changed = false;
    const out = v.map((x) => {
      const y = deepReplace(x, fn);
      if (y !== x) changed = true;
      return y;
    });
    return changed ? out : v;
  }
  if (v && typeof v === 'object') {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const y = deepReplace(x, fn);
      if (y !== x) changed = true;
      out[k] = y;
    }
    return changed ? out : v;
  }
  return v;
}

interface SseEvent {
  /** Raw event text including its blank-line terminator (or the unterminated tail). */
  text: string;
  /** Recorded time of the chunk that completed this event. */
  t: number;
  data: Record<string, unknown> | null;
  modified: boolean;
}

/** Split recorded chunks into SSE events, each stamped with the time its last byte arrived. */
export function sseEvents(chunks: readonly RecordedChunk[]): SseEvent[] {
  const bufs = chunks.map(decodeChunk);
  const body = Buffer.concat(bufs);
  const ends: number[] = [];
  let acc = 0;
  for (const b of bufs) ends.push((acc += b.length));
  const tAt = (byte: number): number => {
    for (let i = 0; i < ends.length; i++) if (byte < ends[i]) return chunks[i].t;
    return chunks.at(-1)?.t ?? 0;
  };
  const events: SseEvent[] = [];
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== 0x0a) continue;
    const blank = (i >= 1 && body[i - 1] === 0x0a) || (i >= 2 && body[i - 1] === 0x0d && body[i - 2] === 0x0a);
    if (!blank) continue;
    events.push(parseEvent(body.subarray(start, i + 1).toString('utf8'), tAt(i)));
    start = i + 1;
  }
  if (start < body.length) events.push(parseEvent(body.subarray(start).toString('utf8'), tAt(body.length - 1)));
  return events;
}

function parseEvent(text: string, t: number): SseEvent {
  const lines = text.split(/\r?\n/);
  const dataLines = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, ''));
  let data: Record<string, unknown> | null = null;
  if (dataLines.length) {
    try {
      const j = JSON.parse(dataLines.join('\n'));
      if (j && typeof j === 'object' && !Array.isArray(j)) data = j as Record<string, unknown>;
    } catch {
      // `[DONE]` and other non-JSON payloads pass through untouched.
    }
  }
  return { text, t, data, modified: false };
}

function serializeEvent(e: SseEvent): string {
  if (!e.modified || !e.data) return e.text;
  const nl = e.text.includes('\r\n') ? '\r\n' : '\n';
  const body = e.text.replace(/\r?\n\r?\n$/, '');
  const out: string[] = [];
  let wroteData = false;
  for (const l of body.split(/\r?\n/)) {
    if (!l.startsWith('data:')) out.push(l);
    else if (!wroteData) {
      out.push(`data: ${JSON.stringify(e.data)}`);
      wroteData = true;
    }
  }
  return out.join(nl) + nl + nl;
}

/** The string-valued field of a streamed delta event, and the stream it belongs to. */
function deltaSlot(d: Record<string, unknown>): { key: string; get: () => string; set: (s: string) => void } | null {
  const type = typeof d.type === 'string' ? d.type : '';
  if (type === 'content_block_delta' && d.delta && typeof d.delta === 'object') {
    const delta = d.delta as Record<string, unknown>;
    const field = delta.type === 'input_json_delta' ? 'partial_json' : delta.type === 'text_delta' ? 'text' : null;
    if (!field || typeof delta[field] !== 'string') return null;
    return { key: `cb:${String(d.index)}:${field}`, get: () => delta[field] as string, set: (s) => (delta[field] = s) };
  }
  if (type.endsWith('.delta') && typeof d.delta === 'string') {
    const key = [type, d.item_id, d.output_index, d.content_index, d.summary_index].map((x) => String(x ?? '')).join('|');
    return { key, get: () => d.delta as string, set: (s) => (d.delta = s) };
  }
  return null;
}

/**
 * The exchange with every occurrence of `rw.from` in its response replaced by `rw.to`, or the
 * same object when nothing referenced it. Rewritten SSE responses are re-chunked one chunk per
 * set of events completed at the same recorded time, so a client sees each event when the
 * recording delivered its last byte.
 */
export function rewriteExchange(ex: RecordedExchange, rewrite: PathRewrite | PieceRewriter): RecordedExchange {
  if (typeof rewrite !== 'function' && (!rewrite.from || rewrite.from === rewrite.to)) return ex;
  if (ex.chunks.length === 0) return ex;
  const rw = typeof rewrite === 'function' ? rewrite : pathRewriter(rewrite);
  if (!(ex.contentType ?? '').includes('event-stream')) {
    const body = Buffer.concat(ex.chunks.map(decodeChunk)).toString('utf8');
    const [out] = rw([body]);
    if (out === body) return ex;
    return { ...ex, chunks: [encodeChunk(ex.chunks.at(-1)!.t, Buffer.from(out, 'utf8'))] };
  }
  const events = sseEvents(ex.chunks);
  const streams = new Map<string, { events: SseEvent[]; slots: NonNullable<ReturnType<typeof deltaSlot>>[] }>();
  for (const e of events) {
    if (!e.data) continue;
    const slot = deltaSlot(e.data);
    if (slot) {
      const s = streams.get(slot.key) ?? { events: [], slots: [] };
      s.events.push(e);
      s.slots.push(slot);
      streams.set(slot.key, s);
      continue;
    }
    const next = deepReplace(e.data, rw);
    if (next !== e.data) {
      e.data = next as Record<string, unknown>;
      e.modified = true;
    }
  }
  for (const s of streams.values()) {
    const before = s.slots.map((x) => x.get());
    const after = rw(before);
    if (after === before) continue;
    after.forEach((piece, i) => {
      if (piece === before[i]) return;
      s.slots[i].set(piece);
      s.events[i].modified = true;
    });
  }
  if (!events.some((e) => e.modified)) return ex;
  const chunks: RecordedChunk[] = [];
  let pending = '';
  let pendingT: number | null = null;
  for (const e of events) {
    if (pendingT !== null && e.t !== pendingT) {
      chunks.push(encodeChunk(pendingT, Buffer.from(pending, 'utf8')));
      pending = '';
    }
    pending += serializeEvent(e);
    pendingT = e.t;
  }
  if (pendingT !== null) chunks.push(encodeChunk(pendingT, Buffer.from(pending, 'utf8')));
  return { ...ex, chunks };
}

// ---------------------------------------------------------------------------------------------
// Exec-session id rewriting (Codex unified exec).
//
// A Codex command still running when its tool call yields comes back to the model as
// `session_id: <n>`, and the model polls or interrupts it later with
// `tools.write_stdin({session_id:<n>, ...})`. The CLI picks <n> at random, so a replay's ids
// differ from the recording's and every served poll named a process that did not exist:
// `write_stdin failed: Unknown process id`. The polls fail fast, the first run is never read
// or interrupted, and the replay's tool work (and its CPU and memory) stops following the
// recording while every request still matches `exact`.
//
// EXACT pairing (recordings whose request fingerprints carry `execSessions`): the recording
// says which call_id reported each recorded id, and the replay's own tool output for that same
// call_id (served from the recording, so the call_ids agree) reports the replay id. A recorded
// id whose call has not reported a replay process stays UNMAPPED rather than borrowing one, so
// a command that finished inside its yield in the replay is never paired with another process.
//
// ORDER pairing (the 2026-09-30 corpus, recorded before fingerprints kept `execSessions`): a
// recorded id is visible only where the model names it (served responses), and a replay id
// only where the CLI reports it. Each instance pairs them in order of first appearance: the
// i-th distinct recorded id the model names maps to the i-th distinct id the replay reported.
// That is exact when the model first polls its processes in the order it started them. It
// drifts when the model first polls a later process, or when a command still running in the
// replay had already finished in the recording. (In that corpus, 11 Codex recordings poll
// processes and 4 of them alternate between several.) Each served record logs the map it
// applied, the mode, and any named id left unmapped, so a drifted replay is visible.
// ---------------------------------------------------------------------------------------------

/** The id in a model-written `session_id:<n>` (JS argument or JSON, raw or JSON-escaped). */
const NAMED_SESSION_ID = /(session_id\\*"?\s*:\s*)(\d+)/g;

/** Distinct exec-session ids the model names in this exchange's response, in order. */
export function namedExecSessionIds(ex: RecordedExchange): string[] {
  const body = Buffer.concat(ex.chunks.map(decodeChunk)).toString('utf8');
  const out: string[] = [];
  for (const m of body.matchAll(NAMED_SESSION_ID)) if (!out.includes(m[2])) out.push(m[2]);
  return out;
}

/** A rewriter that replaces each mapped id in `session_id:<n>`; ids sharing a prefix are safe. */
export function execSessionRewriter(map: ReadonlyMap<string, string>): PieceRewriter {
  return (pieces) => {
    if (map.size === 0) return pieces;
    const s = pieces.join('');
    const edits: Edit[] = [];
    for (const m of s.matchAll(NAMED_SESSION_ID)) {
      const to = map.get(m[2]);
      if (to === undefined) continue;
      const start = m.index + m[1].length;
      edits.push({ start, end: start + m[2].length, to });
    }
    return spliceAcross(pieces, edits);
  };
}

/**
 * Distinct exec-session ids the CLI reported in the tool outputs of an OpenAI Responses
 * request (`input[]` items whose type ends in `_output`), in conversation order. Model-written
 * items are skipped, so a served recorded id is never mistaken for a replay one.
 */
export function reportedExecSessionIds(body: Buffer): string[] {
  let input: unknown;
  try {
    input = (JSON.parse(body.toString('utf8')) as { input?: unknown }).input;
  } catch {
    return [];
  }
  return reportedExecSessions(input).map((r) => r.id);
}

/**
 * Recorded exec-session id -> the call_id whose output first reported it, from the request
 * fingerprints of a recording. Null when the recording predates `execSessions` (no exchange
 * carries the field), which selects order pairing.
 */
export function recordedExecCalls(exchanges: readonly RecordedExchange[]): Map<string, string> | null {
  let any = false;
  const out = new Map<string, string>();
  for (const ex of exchanges) {
    const reports = ex.req.execSessions;
    if (!reports) continue;
    any = true;
    for (const r of reports) if (r.callId && !out.has(r.id)) out.set(r.id, r.callId);
  }
  return any ? out : null;
}

/** Per-instance pairing of recorded exec-session ids with the replay's own. */
export interface ExecSessionIds {
  /** Recorded ids in the order the served responses first named them. */
  recorded: string[];
  /** Replay ids in the order the instance's tool outputs first reported them. */
  replay: string[];
  /** call_id -> the replay id its output reported (exact pairing). */
  replayByCall?: Map<string, string>;
}

/** Record ids (and, when known, the call_id each answered) newly reported by an incoming request. */
export function learnReplayIds(ids: ExecSessionIds, reported: readonly (string | ExecSessionReport)[]): void {
  for (const r of reported) {
    const { id, callId } = typeof r === 'string' ? { id: r, callId: '' } : r;
    if (!ids.replay.includes(id)) ids.replay.push(id);
    if (callId) {
      ids.replayByCall ??= new Map();
      if (!ids.replayByCall.has(callId)) ids.replayByCall.set(callId, id);
    }
  }
}

/**
 * The recorded->replay map for the ids this response names, registering ids named for the
 * first time, plus the named ids that have no replay id yet. With `recordedCalls` (the
 * recording's id -> call_id map) an id the recording attributes to a call is paired through
 * that call only; an id it does not attribute falls back to order pairing.
 */
export function pairFor(
  ids: ExecSessionIds,
  named: readonly string[],
  recordedCalls?: ReadonlyMap<string, string> | null,
): { map: Map<string, string>; unmapped: string[]; by: 'call_id' | 'order' } {
  const map = new Map<string, string>();
  const unmapped: string[] = [];
  let byOrder = false;
  for (const id of named) {
    if (!ids.recorded.includes(id)) ids.recorded.push(id);
    const callId = recordedCalls?.get(id);
    let replay: string | undefined;
    if (callId !== undefined) replay = ids.replayByCall?.get(callId);
    else {
      byOrder = true;
      replay = ids.replay[ids.recorded.indexOf(id)];
    }
    if (replay === undefined) unmapped.push(id);
    else map.set(id, replay);
  }
  return { map, unmapped, by: byOrder ? 'order' : 'call_id' };
}

// ---------------------------------------------------------------------------------------------
// Background-task output files (Claude Code).
//
// A Claude Bash command that outlives its timeout (or runs in the background) is moved to a
// background task, and the tool result tells the model where its output is written:
//   /tmp/claude-<uid>/<project>/<session uuid>/tasks/<task id>.output
// <project> is the CLI's sanitized cwd. Every part differs in a replay: the uid of the VM's
// account, the checkout (so the project), and the session uuid and task id (both random).
// Served unchanged, the model's later `tail <path>` reads a file that does not exist, and the
// replay's tool work stops following the recording while every request still matches `exact`
// (measured 2026-10-01 on P-005: claude-mea-typical-2 TOOL_DIVERGED on every run, WI-10004641).
//
// The replay's own path is visible only in its requests (the tool result the CLI sends back),
// and the recorded one only where the model names it (served responses). So each instance
// pairs task ids in order of first appearance, like exec-session ORDER pairing above, and maps
// the prefix (uid, project, session) to the first path the replay reported. A recorded task
// whose command finished inside its timeout in the replay has no replay task: it stays
// unmapped, and the served record logs it.
// ---------------------------------------------------------------------------------------------

/** A task-output path: uid and task always, project and session when written literally (not globbed). */
export interface TaskOutputRef {
  uid: string;
  task: string;
  project?: string;
  session?: string;
  /** The tool call whose result reported this path, when the request carried it. */
  callId?: string;
  /** True when this ref is a replay-owned file made from an inline tool result. */
  inline?: boolean;
}

function taskOutputFile(ref: TaskOutputRef): string {
  if (!ref.project || !ref.session) throw new Error(`task output ${ref.task} has no literal project/session prefix`);
  return path.join('/tmp', `claude-${ref.uid}`, ref.project, ref.session, 'tasks', `${ref.task}.output`);
}

const TASK_OUTPUT = /\/tmp\/claude-(\d+)\/((?:[^\s"'\\/]+\/)*?)tasks\/([A-Za-z0-9_-]+)\.output/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Every task-output path in `text`, in order, including globbed ones (`/tmp/claude-1000/*\/*\/tasks/x.output`). */
export function taskOutputRefs(text: string): TaskOutputRef[] {
  const out: TaskOutputRef[] = [];
  for (const m of text.matchAll(TASK_OUTPUT)) {
    const segs = m[2].split('/').filter(Boolean);
    const literal = segs.length === 2 && UUID.test(segs[1]) && !/[*?[\]{}]/.test(segs[0]);
    out.push(literal ? { uid: m[1], task: m[3], project: segs[0], session: segs[1] } : { uid: m[1], task: m[3] });
  }
  return out;
}

/** Distinct tasks (by id) the model names in this exchange's response, in order, with deltas reassembled. */
export function namedTaskOutputs(ex: RecordedExchange): TaskOutputRef[] {
  const out: TaskOutputRef[] = [];
  const scan = (s: string) => {
    for (const r of taskOutputRefs(s)) {
      const seen = out.find((o) => o.task === r.task);
      if (!seen) out.push(r);
      else if (!seen.project && r.project) Object.assign(seen, r);
    }
  };
  rewriteExchange(ex, (pieces) => {
    scan(pieces.join(''));
    return pieces;
  });
  return out;
}

/** The first literal task-output path any response of a recording names (its uid, project and session). */
export function recordedTaskPrefix(exchanges: readonly RecordedExchange[]): TaskOutputRef | null {
  for (const ex of exchanges) {
    const hit = namedTaskOutputs(ex).find((r) => r.project);
    if (hit) return hit;
  }
  return null;
}

/**
 * Literal task-output paths the CLI reported in the user-role content of an Anthropic Messages
 * request (tool results and notifications), in conversation order. Assistant turns are skipped:
 * they echo served responses, so they name recorded paths.
 */
export function reportedTaskOutputs(body: Buffer): TaskOutputRef[] {
  if (!body.includes('/tmp/claude-')) return [];
  let messages: unknown;
  try {
    messages = (JSON.parse(body.toString('utf8')) as { messages?: unknown }).messages;
  } catch {
    return [];
  }
  if (!Array.isArray(messages)) return [];
  const out: TaskOutputRef[] = [];
  const add = (s: string, callId?: string) => {
    for (const r of taskOutputRefs(s)) {
      if (!r.project) continue;
      const seen = out.find((o) => o.task === r.task);
      if (!seen) out.push(callId ? { ...r, callId } : r);
      else if (!seen.callId && callId) seen.callId = callId;
    }
  };
  const walk = (c: unknown, callId?: string): void => {
    if (typeof c === 'string') return add(c, callId);
    if (Array.isArray(c)) return c.forEach((item) => walk(item, callId));
    if (!c || typeof c !== 'object') return;
    const b = c as Record<string, unknown>;
    if (b.type === 'tool_use') return;
    const resultCallId = b.type === 'tool_result' && typeof b.tool_use_id === 'string' ? b.tool_use_id : callId;
    if (typeof b.text === 'string') add(b.text, resultCallId);
    if (b.content !== undefined) walk(b.content, resultCallId);
  };
  for (const m of messages) if (m && typeof m === 'object' && (m as { role?: unknown }).role === 'user') walk((m as { content?: unknown }).content);
  return out;
}

/** Recorded task id -> tool_use_id, recovered from the corpus CLI stream-json user results. */
export function recordedTaskCallIds(cliJsonl: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of cliJsonl.split('\n')) {
    if (!line.trim() || !line.includes('/tmp/claude-')) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row || typeof row !== 'object') continue;
    const message = (row as { message?: unknown }).message;
    if (!message || typeof message !== 'object' || (message as { role?: unknown }).role !== 'user') continue;
    const reports = reportedTaskOutputs(Buffer.from(JSON.stringify({ messages: [message] })));
    for (const report of reports) if (report.callId && !out.has(report.task)) out.set(report.task, report.callId);
  }
  return out;
}

const MAX_INLINE_TASK_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Extract plain text results for recorded task calls that completed inline during replay. */
function reportedInlineTaskOutputs(
  body: Buffer,
  recordedCallIds: ReadonlySet<string>,
  backgroundCallIds: ReadonlySet<string>,
): Map<string, string> {
  let messages: unknown;
  try {
    messages = (JSON.parse(body.toString('utf8')) as { messages?: unknown }).messages;
  } catch {
    return new Map();
  }
  if (!Array.isArray(messages)) return new Map();
  const out = new Map<string, string>();
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const m = message as { role?: unknown; content?: unknown };
    if (m.role !== 'user' || !Array.isArray(m.content)) continue;
    for (const raw of m.content) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const block = raw as { type?: unknown; tool_use_id?: unknown; content?: unknown };
      if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
      const callId = block.tool_use_id;
      if (!recordedCallIds.has(callId) || backgroundCallIds.has(callId)) continue;
      const parts: string[] = [];
      let valid = false;
      const collect = (value: unknown): boolean => {
        if (typeof value === 'string') {
          parts.push(value);
          valid = true;
          return true;
        }
        if (!Array.isArray(value)) return false;
        for (const item of value) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
          const textBlock = item as { type?: unknown; text?: unknown };
          if (textBlock.type !== 'text' || typeof textBlock.text !== 'string') return false;
          parts.push(textBlock.text);
          valid = true;
        }
        return true;
      };
      if (!collect(block.content) || !valid || out.has(callId)) continue;
      const text = parts.join('');
      if (Buffer.byteLength(text, 'utf8') <= MAX_INLINE_TASK_OUTPUT_BYTES) out.set(callId, text);
    }
  }
  return out;
}

/** Per-instance pairing of recorded background-task ids with the replay's own. */
export interface TaskOutputIds {
  /** Recorded task ids in the order the served responses first named them. */
  recorded: string[];
  /** Replay task paths in the order the instance's requests first reported them. */
  replay: TaskOutputRef[];
  /** Replay paths indexed by their originating tool call, including inline fallback files. */
  replayByCall?: Map<string, TaskOutputRef>;
}

/**
 * Register task paths newly reported by an incoming request. A recorded id is never learned as
 * a replay task: a replay that runs `tail <recorded path>` gets an error quoting that path back.
 */
export function learnReplayTasks(ids: TaskOutputIds, reported: readonly TaskOutputRef[]): void {
  for (const r of reported) {
    if (!r.project || !r.session) continue;
    if (ids.recorded.includes(r.task)) continue;
    if (r.callId) {
      const byCall = (ids.replayByCall ??= new Map());
      const current = byCall.get(r.callId);
      if (current && (!current.inline || r.inline)) continue;
      if (current) {
        const index = ids.replay.indexOf(current);
        if (index >= 0) ids.replay[index] = r;
        else if (!ids.replay.some((x) => x.task === r.task)) ids.replay.push(r);
      } else if (!ids.replay.some((x) => x.task === r.task)) {
        ids.replay.push(r);
      }
      byCall.set(r.callId, r);
    } else if (!ids.replay.some((x) => x.task === r.task)) {
      ids.replay.push(r);
    }
  }
}

/** recorded task id -> replay task id, preferring the corpus' exact tool-call correlation. */
export function pairTasks(
  ids: TaskOutputIds,
  named: readonly string[],
  recordedCalls?: ReadonlyMap<string, string>,
): { map: Map<string, string>; unmapped: string[] } {
  const map = new Map<string, string>();
  const unmapped: string[] = [];
  for (const id of named) {
    if (!ids.recorded.includes(id)) ids.recorded.push(id);
    const callId = recordedCalls?.size ? recordedCalls.get(id) : undefined;
    const replay = recordedCalls?.size
      ? callId ? ids.replayByCall?.get(callId) : undefined
      : ids.replay[ids.recorded.indexOf(id)];
    if (replay) map.set(id, replay.task);
    else unmapped.push(id);
  }
  return { map, unmapped };
}

/**
 * A rewriter that moves recorded task-output paths onto the replay's: the `/tmp/claude-<uid>/`
 * prefix, the project and session segments (from `recorded`, the recording's literal prefix, to
 * `replay`, the first path the replay reported), and each mapped task id wherever it appears
 * (paths, globs, and `task_id` arguments alike).
 */
export function taskOutputRewriter(recorded: TaskOutputRef, replay: TaskOutputRef, tasks: ReadonlyMap<string, string>): PieceRewriter {
  const pairs: PathRewrite[] = [{ from: `/tmp/claude-${recorded.uid}/`, to: `/tmp/claude-${replay.uid}/` }];
  if (recorded.project && replay.project) pairs.push({ from: recorded.project, to: replay.project });
  if (recorded.session && replay.session) pairs.push({ from: recorded.session, to: replay.session });
  for (const [from, to] of tasks) pairs.push({ from, to });
  return (pieces) => {
    let cur = pieces;
    for (const p of pairs) for (const v of variants(p)) cur = replaceAcross(cur, v.from, v.to);
    return cur;
  };
}

const TOKEN = /^[A-Za-z0-9._-]+$/;

/** Split `/r/<sessionId>/<instance>/<rest>`; null for anything else (or an unsafe token). */
export function parseReplayUrl(url: string): { sessionId: string; instance: string; rest: string } | null {
  const m = /^\/r\/([^/?]+)\/([^/?]+)(\/.*|\?.*)?$/.exec(url);
  if (!m || !TOKEN.test(m[1]) || !TOKEN.test(m[2]) || m[1].startsWith('.')) return null;
  const rest = m[3] ?? '/';
  return { sessionId: m[1], instance: m[2], rest: rest.startsWith('?') ? `/${rest}` : rest };
}

export interface ServedRecord {
  at: string;
  sessionId: string;
  instance: string;
  method: string;
  path: string;
  tier: MatchTier | 'exhausted';
  seq: number | null;
  status: number;
  reqBytes: number;
  recordedReqBytes: number | null;
  messages: number | null;
  recordedMessages: number | null;
  /** Redacted tool outputs in the replay request; contents are never logged. */
  inputToolOutputs?: InputToolOutputSummary | null;
  /** Redacted tool outputs in the recording, or null for a pre-instrumentation recording. */
  recordedInputToolOutputs?: InputToolOutputSummary | null;
  /** ms from request-body-complete to the last byte written. */
  servedMs: number;
  recordedMs: number | null;
  /** True when the instance's work-dir rewrite changed this response. */
  rewritten?: boolean;
  /** Recorded->replay exec-session ids rewritten in this response (Codex `write_stdin`). */
  execSessionIds?: Record<string, string>;
  /** Exec-session ids this response names that the replay never reported (served unchanged). */
  execSessionUnmapped?: string[];
  /** How the named ids were paired: through the recorded call_id (exact) or by order. */
  execSessionPairing?: 'call_id' | 'order';
  /** Recorded->replay Claude background-task ids rewritten in this response. */
  taskOutputIds?: Record<string, string>;
  /** Background-task ids this response names that the replay never reported (no prefix rewrite either when none was reported). */
  taskOutputUnmapped?: string[];
  /** ms this reply was held before release (HoldPlan); absent for an unheld reply. */
  heldMs?: number;
}

/**
 * P-015 parked agents: hold ONE streamed reply per matching instance until `releaseHolds()`, so its
 * CLI sits idle mid-session with its whole heap (an agent waiting on the model), then wake every
 * held agent at once. A held reply sends its headers at once and an SSE comment every
 * `keepaliveMs`: SSE parsers ignore `:` lines, and the steady bytes keep the client's
 * headers/body timeouts (undici's are 300 s) from firing during a long hold.
 */
export interface HoldPlan {
  /** Instances whose name starts with this are held. */
  instancePrefix: string;
  /** Hold the instance's first streamed reply at or after this request number (1-based). */
  atRequest: number;
  /** Default 15000. */
  keepaliveMs?: number;
}

/** Whether this request is the one to hold: once per instance, streamed replies only, never after release. */
export function shouldHold(
  plan: HoldPlan | undefined,
  h: { instance: string; requestNumber: number; contentType: string | null | undefined; alreadyHeld: boolean; released: boolean },
): boolean {
  if (!plan || h.released || h.alreadyHeld) return false;
  if (!h.instance.startsWith(plan.instancePrefix) || h.requestNumber < plan.atRequest) return false;
  return /event-stream/i.test(h.contentType ?? '');
}

export interface ReplayServerOptions {
  corpusDir: string;
  port?: number;
  host?: string;
  /** Delay divisor: 1 = recorded timing, 2 = twice as fast, 0 = no delays. */
  speed?: number;
  logFile?: string;
  hold?: HoldPlan;
}

export interface ReplayServer {
  port: number;
  url: string;
  /** Replay base URL for one agent. */
  baseUrl(sessionId: string, instance: string): string;
  /** Serve this instance its recording with `rw.from` (the recorded work dir) rewritten to `rw.to`. */
  rewritePaths(sessionId: string, instance: string, rw: PathRewrite): void;
  states(): ReplayState[];
  /** Replies held right now (see HoldPlan). */
  held(): number;
  /** Release every held reply at once and stop holding; returns how many were held. Idempotent. */
  releaseHolds(): number;
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function startReplayServer(opts: ReplayServerOptions): Promise<ReplayServer> {
  const speed = opts.speed ?? 1;
  const delayOf = (ms: number) => (speed > 0 ? ms / speed : 0);
  const recordings = new Map<string, RecordedExchange[]>();
  const states = new Map<string, ReplayState>();
  const log: WriteStream | null = opts.logFile ? createWriteStream(opts.logFile, { flags: 'a' }) : null;
  const inflight = new Set<Promise<void>>();
  const rewrites = new Map<string, PathRewrite>();
  // HoldPlan: one shared release; `heldKeys` makes the hold once per instance.
  let released = false;
  let releaseAll!: () => void;
  const releasedSignal = new Promise<void>((r) => (releaseAll = r));
  const heldKeys = new Set<string>();
  let heldNow = 0;
  const keepaliveMs = opts.hold?.keepaliveMs ?? 15_000;
  // Exchanges already found not to mention a given `from`: every later instance skips the parse.
  const untouched = new WeakMap<RecordedExchange, string>();
  const served = (ex: RecordedExchange, rw: PathRewrite | undefined): RecordedExchange => {
    if (!rw || untouched.get(ex) === rw.from) return ex;
    const out = rewriteExchange(ex, rw);
    if (out === ex) untouched.set(ex, rw.from);
    return out;
  };
  const execIds = new Map<string, ExecSessionIds>();
  const execCalls = new WeakMap<readonly RecordedExchange[], Map<string, string> | null>();
  const execCallsOf = (exchanges: readonly RecordedExchange[]): Map<string, string> | null => {
    if (!execCalls.has(exchanges)) execCalls.set(exchanges, recordedExecCalls(exchanges));
    return execCalls.get(exchanges) ?? null;
  };
  const named = new WeakMap<RecordedExchange, string[]>();
  const namedIn = (ex: RecordedExchange): string[] => {
    let hit = named.get(ex);
    if (!hit) named.set(ex, (hit = namedExecSessionIds(ex)));
    return hit;
  };
  // Claude background-task output paths: same shape as the exec-session ids above.
  interface ReplayTaskState extends TaskOutputIds {
    outputPrefix: TaskOutputRef;
  }
  const taskIds = new Map<string, ReplayTaskState>();
  const replayTaskRoots = new Set<string>();
  const recordedTaskCalls = new Map<string, Map<string, string>>();
  const tasksNamed = new WeakMap<RecordedExchange, TaskOutputRef[]>();
  const tasksIn = (ex: RecordedExchange): TaskOutputRef[] => {
    let hit = tasksNamed.get(ex);
    if (!hit) tasksNamed.set(ex, (hit = namedTaskOutputs(ex)));
    return hit;
  };
  const taskPrefixes = new WeakMap<readonly RecordedExchange[], TaskOutputRef | null>();
  const taskPrefixOf = (exchanges: readonly RecordedExchange[]): TaskOutputRef | null => {
    if (!taskPrefixes.has(exchanges)) taskPrefixes.set(exchanges, recordedTaskPrefix(exchanges));
    return taskPrefixes.get(exchanges) ?? null;
  };
  const taskCallsOf = (sessionId: string): Map<string, string> => {
    const hit = recordedTaskCalls.get(sessionId);
    if (hit) return hit;
    const file = path.join(opts.corpusDir, sessionId, 'cli.jsonl');
    const calls = existsSync(file) ? recordedTaskCallIds(readFileSync(file, 'utf8')) : new Map<string, string>();
    recordedTaskCalls.set(sessionId, calls);
    return calls;
  };
  const taskIdsOf = (key: string): ReplayTaskState => {
    let ids = taskIds.get(key);
    if (!ids) {
      const uid = String(typeof process.getuid === 'function' ? process.getuid() : 0);
      const project = `papercusp-replay-${createHash('sha256').update(key).digest('hex').slice(0, 12)}`;
      const session = randomUUID();
      const outputRoot = path.join('/tmp', `claude-${uid}`, project, session);
      replayTaskRoots.add(outputRoot);
      taskIds.set(key, (ids = { recorded: [], replay: [], outputPrefix: { uid, project, session, task: '' } }));
    }
    return ids;
  };

  const registerReplayTaskPaths = (ids: ReplayTaskState, reported: readonly TaskOutputRef[], recordedCalls: ReadonlyMap<string, string>) => {
    for (const ref of reported) {
      if (!ref.project || !ref.session || ids.recorded.includes(ref.task) || recordedCalls.has(ref.task)) continue;
      const current = ref.callId ? ids.replayByCall?.get(ref.callId) : undefined;
      if (current && !current.inline) continue;
      const replay = { ...ids.outputPrefix, task: ref.task, ...(ref.callId ? { callId: ref.callId } : {}) };
      const source = taskOutputFile(ref);
      const target = taskOutputFile(replay);
      mkdirSync(path.dirname(target), { recursive: true });
      if (current?.inline) rmSync(target, { force: true });
      if (path.resolve(source) !== path.resolve(target)) {
        try {
          symlinkSync(source, target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      }
      learnReplayTasks(ids, [replay]);
    }
  };
  const registerInlineTaskOutputs = (
    ids: ReplayTaskState,
    inline: ReadonlyMap<string, string>,
    recordedCalls: ReadonlyMap<string, string>,
  ) => {
    const recordedByCall = new Map<string, string>();
    for (const [task, callId] of recordedCalls) if (!recordedByCall.has(callId)) recordedByCall.set(callId, task);
    for (const [callId, text] of inline) {
      if (!recordedByCall.has(callId)) continue;
      const current = ids.replayByCall?.get(callId);
      if (current && !current.inline) continue;
      const task = `inline-${createHash('sha256').update(callId).digest('hex').slice(0, 12)}`;
      const replay = { ...ids.outputPrefix, task, callId, inline: true };
      const output = taskOutputFile(replay);
      mkdirSync(path.dirname(output), { recursive: true });
      writeFileSync(output, text);
      learnReplayTasks(ids, [replay]);
    }
  };

  const recording =(sessionId: string): RecordedExchange[] | null => {
    const hit = recordings.get(sessionId);
    if (hit) return hit;
    const file = path.join(opts.corpusDir, sessionId, 'exchanges.jsonl');
    if (!existsSync(file)) return null;
    const ex = parseExchanges(readFileSync(file, 'utf8'));
    recordings.set(sessionId, ex);
    return ex;
  };

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/healthz') return json(res, 200, { ok: true, sessions: recordings.size, replays: states.size });
    if (url === '/stats') {
      return json(res, 200, {
        replays: [...states.values()].map((s) => ({
          sessionId: s.sessionId,
          instance: s.instance,
          recorded: s.exchanges.length,
          remaining: s.consumed.filter((c) => !c).length,
          counts: s.counts,
        })),
      });
    }
    const parsed = parseReplayUrl(url);
    if (!parsed) return json(res, 404, { error: { type: 'not_found', message: `not a replay url: ${url}` } });
    const exchanges = recording(parsed.sessionId);
    if (!exchanges) return json(res, 404, { error: { type: 'not_found', message: `no recording ${parsed.sessionId}` } });
    const key = `${parsed.sessionId}/${parsed.instance}`;
    let state = states.get(key);
    if (!state) {
      state = newReplayState(parsed.sessionId, parsed.instance, exchanges);
      states.set(key, state);
    }
    const st = state;
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    const done = new Promise<void>((resolve) => {
      req.on('end', () => {
        const body = Buffer.concat(parts);
        // The fingerprint parses the body once and lifts the CLI's exec-session reports (with
        // the call_id each answered) out of an OpenAI Responses request.
        const fp = fingerprintRequest(body);
        if (fp.execSessions && fp.execSessions.length > 0) {
          const ids = execIds.get(key) ?? { recorded: [], replay: [] };
          execIds.set(key, ids);
          learnReplayIds(ids, fp.execSessions);
        }
        const calls = taskCallsOf(st.sessionId);
        const reportedTasks = reportedTaskOutputs(body);
        const inlineTasks = reportedInlineTaskOutputs(
          body,
          new Set(calls.values()),
          new Set(reportedTasks.flatMap((task) => task.callId ? [task.callId] : [])),
        );
        if (reportedTasks.length > 0 || inlineTasks.size > 0) {
          const ids = taskIdsOf(key);
          registerReplayTaskPaths(ids, reportedTasks, calls);
          registerInlineTaskOutputs(ids, inlineTasks, calls);
        }
        const method = req.method ?? 'GET';
        const t0 = performance.now();
        const picked = takeExchange(st, { method, path: parsed.rest, fp });
        const write = (r: Omit<ServedRecord, 'at' | 'sessionId' | 'instance' | 'method' | 'path' | 'reqBytes' | 'messages' | 'servedMs'>) => {
          const rec: ServedRecord = {
            at: new Date().toISOString(),
            sessionId: st.sessionId,
            instance: st.instance,
            method,
            path: parsed.rest,
            reqBytes: body.length,
            messages: fp.messages,
            servedMs: Math.round(performance.now() - t0),
            ...(fp.inputToolOutputs ? { inputToolOutputs: fp.inputToolOutputs } : {}),
            ...(picked ? { recordedInputToolOutputs: picked.exchange.req.inputToolOutputs ?? null } : {}),
            ...r,
          };
          log?.write(JSON.stringify(rec) + '\n');
          resolve();
        };
        if (!picked) {
          json(res, 400, {
            type: 'error',
            error: { type: 'invalid_request_error', message: `replay_exhausted: no recorded ${method} ${parsed.rest} left for ${key}` },
          });
          write({ tier: 'exhausted', seq: null, status: 400, recordedReqBytes: null, recordedMessages: null, recordedMs: null });
          return;
        }
        const { tier } = picked;
        const requestNumber = st.counts.exact + st.counts.shape + st.counts.path + st.counts.exhausted;
        const hold = shouldHold(opts.hold, {
          instance: parsed.instance,
          requestNumber,
          contentType: picked.exchange.contentType,
          alreadyHeld: heldKeys.has(key),
          released,
        });
        if (hold) heldKeys.add(key);
        let ex = served(picked.exchange, rewrites.get(key));
        const rewritten = ex !== picked.exchange;
        let sessions: Pick<ServedRecord, 'execSessionIds' | 'execSessionUnmapped' | 'execSessionPairing'> = {};
        const names = namedIn(picked.exchange);
        if (names.length > 0) {
          const ids = execIds.get(key) ?? { recorded: [], replay: [] };
          execIds.set(key, ids);
          const { map, unmapped, by } = pairFor(ids, names, execCallsOf(exchanges));
          if (map.size > 0) ex = rewriteExchange(ex, execSessionRewriter(map));
          sessions = {
            ...(map.size > 0 ? { execSessionIds: Object.fromEntries(map) } : {}),
            ...(unmapped.length > 0 ? { execSessionUnmapped: unmapped } : {}),
            execSessionPairing: by,
          };
        }
        let tasks: Pick<ServedRecord, 'taskOutputIds' | 'taskOutputUnmapped'> = {};
        const namedTasks = tasksIn(picked.exchange);
        if (namedTasks.length > 0) {
          const ids = taskIdsOf(key);
          const { map, unmapped } = pairTasks(
            ids,
            namedTasks.map((t) => t.task),
            calls,
          );
          const recordedPrefix = taskPrefixOf(exchanges) ?? namedTasks[0];
          if (ids.replay.length > 0 && map.size > 0 && unmapped.length === 0) {
            ex = rewriteExchange(ex, taskOutputRewriter(recordedPrefix, ids.replay[0], map));
          }
          tasks = {
            ...(map.size > 0 ? { taskOutputIds: Object.fromEntries(map) } : {}),
            ...(unmapped.length > 0 ? { taskOutputUnmapped: unmapped } : {}),
          };
        }
        void (async () => {
          let aborted = false;
          res.on('close', () => {
            if (!res.writableFinished) aborted = true;
          });
          const headers: http.OutgoingHttpHeaders = {};
          if (ex.contentType) headers['content-type'] = ex.contentType;
          let held: { heldMs?: number } = {};
          if (hold) {
            // Parked: headers now, keepalive comments until the shared release, then the recording.
            const t0 = Date.now();
            res.writeHead(ex.status, headers);
            heldNow++;
            while (!released && !aborted) {
              await Promise.race([sleep(keepaliveMs), releasedSignal]);
              if (!released && !aborted) res.write(': papercusp-capacity hold\n\n');
            }
            heldNow--;
            held = { heldMs: Date.now() - t0 };
          }
          const first = ex.chunks[0];
          if (first) await sleep(delayOf(first.t));
          if (aborted) return write({ tier, seq: ex.seq, status: 499, recordedReqBytes: ex.req.bytes, recordedMessages: ex.req.messages, recordedMs: ex.totalMs, rewritten, ...sessions, ...tasks, ...held });
          if (!hold) res.writeHead(ex.status, headers);
          let prevT = first?.t ?? 0;
          for (const c of ex.chunks) {
            const gap = c.t - prevT;
            if (gap > 0) await sleep(delayOf(gap));
            prevT = c.t;
            if (aborted) break;
            res.write(decodeChunk(c));
          }
          const tail = ex.totalMs - prevT;
          if (!aborted && tail > 0 && ex.chunks.length === 0) await sleep(delayOf(tail));
          res.end();
          write({ tier, seq: ex.seq, status: aborted ? 499 : ex.status, recordedReqBytes: ex.req.bytes, recordedMessages: ex.req.messages, recordedMs: ex.totalMs, rewritten, ...sessions, ...tasks, ...held });
        })();
      });
    });
    inflight.add(done);
    void done.finally(() => inflight.delete(done));
  });

  const host = opts.host ?? '127.0.0.1';
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, host, resolve));
  const port = (server.address() as { port: number }).port;
  const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;
  return {
    port,
    url,
    baseUrl: (sessionId, instance) => `${url}/r/${sessionId}/${instance}`,
    rewritePaths: (sessionId, instance, rw) => void rewrites.set(`${sessionId}/${instance}`, rw),
    states:() => [...states.values()],
    held: () => heldNow,
    releaseHolds: () => {
      const n = heldNow;
      if (!released) {
        released = true;
        releaseAll();
      }
      return n;
    },
    close: async () => {
      // A held reply would otherwise keep its connection (and close()) waiting for a release.
      if (!released) {
        released = true;
        releaseAll();
      }
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.all([...inflight]);
      for (const root of replayTaskRoots) rmSync(root, { recursive: true, force: true });
      if (log) await new Promise<void>((r) => log.end(r));
    },
  };
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const corpusDir = arg('corpus');
  if (!corpusDir) throw new Error('--corpus <dir> required');
  const srv = await startReplayServer({
    corpusDir,
    port: Number(arg('port', '18700')),
    host: arg('host', '127.0.0.1'),
    speed: Number(arg('speed', '1')),
    logFile: arg('log'),
  });
  console.log(`REPLAY_SERVER ${srv.url} corpus=${corpusDir}`);
  const stop = () => void srv.close().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (process.argv[1] && /replay-server\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
