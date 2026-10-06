/**
 * Recording reverse proxy for the agent-capacity workload corpus
 * (plan agent-capacity-and-cost-gcp-2026-09-30, P-002).
 *
 * A claude or codex CLI is pointed at this proxy (ANTHROPIC_BASE_URL, or a codex
 * `model_provider` base_url). Every request is forwarded unchanged to the upstream
 * (the local inference gateway, which injects the pooled account's credentials), and
 * the response is streamed back while each chunk is recorded with its offset from the
 * moment the request body finished arriving. The resulting exchanges.jsonl is what the
 * P-003 fake model server replays — same bytes, same delays — so real CLIs and real tool
 * commands run on a test VM without spending model quota.
 *
 * Request bodies are NOT stored: they carry whole conversations and the CLI rebuilds
 * them during replay. A fingerprint (bytes, sha256, model, message/tool counts) is kept
 * so the replay server can check it is feeding the right session in the right order.
 */
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { performance } from 'node:perf_hooks';

/** One recorded response chunk: `t` = ms after the request body completed. */
export interface RecordedChunk {
  t: number;
  /** utf8 text of the chunk, when it decodes losslessly. */
  d?: string;
  /** base64 of the chunk otherwise (binary, or a chunk that splits a utf8 sequence). */
  b64?: string;
}

export interface RequestFingerprint {
  bytes: number;
  sha256: string;
  model: string | null;
  stream: boolean;
  /** `messages.length` (Anthropic) or `input.length` (OpenAI Responses); null if neither. */
  messages: number | null;
  tools: number | null;
  /** Redacted input tool-output metadata; output contents are never persisted. */
  inputToolOutputs?: InputToolOutputSummary;
  /**
   * Exec-session ids the CLI reported as still running in this request's tool outputs, with
   * the `call_id` each output answers (OpenAI Responses only; omitted when there are none).
   * The body itself is not stored, so this is the only record of which call started which
   * recorded process. Replay uses it to pair a recorded id with the replay's own id through
   * the shared call_id instead of by order of appearance.
   */
  execSessions?: ExecSessionReport[];
}

/** One exec session a CLI reported running: the tool call it answered and its process id. */
export interface ExecSessionReport {
  callId: string;
  id: string;
}

/** Safe metadata for one tool result in an API request body. */
export interface InputToolOutputItem {
  type: string;
  callId: string | null;
  /** UTF-8 bytes of the output value (or JSON serialization for non-string values). */
  outputBytes: number | null;
}

/** Bounded request summary: never includes a tool's returned text or structured data. */
export interface InputToolOutputSummary {
  count: number;
  omitted: number;
  items: InputToolOutputItem[];
}

const MAX_INPUT_TOOL_OUTPUT_ITEMS = 64;

function outputByteLength(value: unknown): number | null {
  if (value === undefined) return null;
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  return serialized === undefined ? null : Buffer.byteLength(serialized, 'utf8');
}

/**
 * Describe tool outputs in the request without retaining their contents. OpenAI Responses
 * outputs are top-level `input[]` items; Anthropic tool results are blocks in user messages.
 */
function summarizeInputToolOutputs(j: Record<string, unknown>): InputToolOutputSummary | undefined {
  const items: InputToolOutputItem[] = [];
  if (Array.isArray(j.input)) {
    for (const raw of j.input) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const item = raw as Record<string, unknown>;
      if (typeof item.type !== 'string' || !item.type.endsWith('_output')) continue;
      items.push({
        type: item.type,
        callId: typeof item.call_id === 'string' ? item.call_id : null,
        outputBytes: outputByteLength(item.output),
      });
    }
  } else if (Array.isArray(j.messages)) {
    for (const rawMessage of j.messages) {
      if (!rawMessage || typeof rawMessage !== 'object' || Array.isArray(rawMessage)) continue;
      const message = rawMessage as Record<string, unknown>;
      if (message.role !== 'user' || !Array.isArray(message.content)) continue;
      for (const rawBlock of message.content) {
        if (!rawBlock || typeof rawBlock !== 'object' || Array.isArray(rawBlock)) continue;
        const block = rawBlock as Record<string, unknown>;
        if (block.type !== 'tool_result') continue;
        items.push({
          type: 'tool_result',
          callId: typeof block.tool_use_id === 'string' ? block.tool_use_id : null,
          outputBytes: outputByteLength(block.content),
        });
      }
    }
  } else {
    return undefined;
  }
  const retained = items.slice(0, MAX_INPUT_TOOL_OUTPUT_ITEMS);
  return { count: items.length, omitted: items.length - retained.length, items: retained };
}

// The CLI's own report of a still-running process: an unescaped JSON `"session_id": <n>`
// (Codex code mode returns the tool result as JSON text) or the plain-text "session ID <n>".
// An escaped `\"session_id\"` is command OUTPUT quoted inside that JSON, not the CLI's report.
const REPORTED_SESSION_ID = [/(?<!\\)"session_id"\s*:\s*(\d+)/g, /\bsession ID (\d+)/g];

/**
 * Exec sessions reported in an OpenAI Responses `input[]`: for each tool-output item (type
 * ending in `_output`), the ids its output reports, in conversation order, each id once (at
 * its first report). Model-written items are skipped, so an id the model merely names is
 * never mistaken for one the CLI reported. An output without a string `call_id` contributes
 * `callId: ''`.
 */
export function reportedExecSessions(input: unknown): ExecSessionReport[] {
  if (!Array.isArray(input)) return [];
  const out: ExecSessionReport[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const { type, call_id: callId, output } = item as { type?: unknown; call_id?: unknown; output?: unknown };
    if (typeof type !== 'string' || !type.endsWith('_output')) continue;
    const found: { at: number; id: string }[] = [];
    let base = 0;
    const scan = (v: unknown): void => {
      if (typeof v === 'string') {
        for (const re of REPORTED_SESSION_ID) for (const m of v.matchAll(re)) found.push({ at: base + m.index, id: m[1] });
        base += v.length + 1;
      } else if (Array.isArray(v)) v.forEach(scan);
      else if (v && typeof v === 'object') Object.values(v).forEach(scan);
    };
    scan(output);
    for (const f of found.sort((a, b) => a.at - b.at)) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      out.push({ callId: typeof callId === 'string' ? callId : '', id: f.id });
    }
  }
  return out;
}

export interface RecordedExchange {
  seq: number;
  sessionId: string;
  startedAt: string;
  method: string;
  path: string;
  req: RequestFingerprint;
  status: number;
  contentType: string | null;
  /** ms from request-body-complete to the first response byte; null if none arrived. */
  ttfbMs: number | null;
  totalMs: number;
  resBytes: number;
  chunks: RecordedChunk[];
  error?: string;
}

const HOP_BY_HOP = new Set([
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-length',
  'proxy-connection',
  'upgrade',
  'te',
  'trailer',
]);

export function fingerprintRequest(body: Buffer): RequestFingerprint {
  const fp: RequestFingerprint = {
    bytes: body.length,
    sha256: createHash('sha256').update(body).digest('hex'),
    model: null,
    stream: false,
    messages: null,
    tools: null,
  };
  if (body.length === 0) return fp;
  try {
    const j = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
    if (typeof j.model === 'string') fp.model = j.model;
    fp.stream = j.stream === true;
    if (Array.isArray(j.messages)) fp.messages = j.messages.length;
    else if (Array.isArray(j.input)) {
      fp.messages = j.input.length;
      const execSessions = reportedExecSessions(j.input);
      if (execSessions.length > 0) fp.execSessions = execSessions;
    }
    const inputToolOutputs = summarizeInputToolOutputs(j);
    if (inputToolOutputs) fp.inputToolOutputs = inputToolOutputs;
    if (Array.isArray(j.tools)) fp.tools = j.tools.length;
  } catch {
    // Non-JSON body: bytes + sha256 are still a usable fingerprint.
  }
  return fp;
}

/** Encode a chunk as utf8 text when that round-trips exactly, else base64. */
export function encodeChunk(t: number, chunk: Buffer): RecordedChunk {
  const text = chunk.toString('utf8');
  if (!text.includes('�') && Buffer.byteLength(text, 'utf8') === chunk.length) return { t, d: text };
  return { t, b64: chunk.toString('base64') };
}

export function decodeChunk(c: RecordedChunk): Buffer {
  return c.b64 !== undefined ? Buffer.from(c.b64, 'base64') : Buffer.from(c.d ?? '', 'utf8');
}

export interface RecordProxyOptions {
  /** e.g. http://127.0.0.1:8788 — request paths are appended verbatim. */
  upstream: string;
  /** exchanges.jsonl path (appended). */
  outFile: string;
  sessionId: string;
  /** 0 = pick a free port. */
  port?: number;
}

export interface RecordProxy {
  port: number;
  url: string;
  /** Exchanges recorded so far (in completion order). */
  count(): number;
  close(): Promise<void>;
}

export async function startRecordProxy(opts: RecordProxyOptions): Promise<RecordProxy> {
  const upstream = new URL(opts.upstream);
  const out = createWriteStream(opts.outFile, { flags: 'a' });
  let seq = 0;
  let written = 0;
  const inflight = new Set<Promise<void>>();

  const server = http.createServer((req, res) => {
    const mySeq = seq++;
    const startedAt = new Date().toISOString();
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    const done = new Promise<void>((resolve) => {
      req.on('end', () => {
        const body = Buffer.concat(parts);
        const t0 = performance.now();
        const chunks: RecordedChunk[] = [];
        let resBytes = 0;
        let ttfb: number | null = null;
        const rec = (status: number, contentType: string | null, error?: string) => {
          const ex: RecordedExchange = {
            seq: mySeq,
            sessionId: opts.sessionId,
            startedAt,
            method: req.method ?? 'GET',
            path: req.url ?? '/',
            req: fingerprintRequest(body),
            status,
            contentType,
            ttfbMs: ttfb,
            totalMs: Math.round(performance.now() - t0),
            resBytes,
            chunks,
            ...(error ? { error } : {}),
          };
          out.write(JSON.stringify(ex) + '\n');
          written++;
          resolve();
        };

        const headers: http.OutgoingHttpHeaders = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (!HOP_BY_HOP.has(k.toLowerCase()) && v !== undefined) headers[k] = v;
        }
        // Record plain bytes, never a compressed stream the replay would have to re-frame.
        headers['accept-encoding'] = 'identity';
        headers['content-length'] = String(body.length);

        const up = http.request(
          {
            protocol: upstream.protocol,
            hostname: upstream.hostname,
            port: upstream.port,
            method: req.method,
            path: upstream.pathname.replace(/\/$/, '') + (req.url ?? '/'),
            headers,
          },
          (upRes) => {
            const resHeaders: http.OutgoingHttpHeaders = {};
            for (const [k, v] of Object.entries(upRes.headers)) {
              if (!HOP_BY_HOP.has(k.toLowerCase()) && v !== undefined) resHeaders[k] = v;
            }
            res.writeHead(upRes.statusCode ?? 502, resHeaders);
            upRes.on('data', (c: Buffer) => {
              const t = Math.round(performance.now() - t0);
              if (ttfb === null) ttfb = t;
              resBytes += c.length;
              chunks.push(encodeChunk(t, c));
              res.write(c);
            });
            upRes.on('end', () => {
              res.end();
              rec(upRes.statusCode ?? 0, (upRes.headers['content-type'] as string | undefined) ?? null);
            });
            upRes.on('error', (e) => {
              res.destroy(e);
              rec(upRes.statusCode ?? 0, null, `upstream-response: ${e.message}`);
            });
          },
        );
        up.on('error', (e) => {
          if (!res.headersSent) {
            res.writeHead(502, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { type: 'record_proxy_upstream_error', message: e.message } }));
          } else {
            res.destroy(e);
          }
          rec(502, 'application/json', `upstream-request: ${e.message}`);
        });
        up.end(body);
      });
    });
    inflight.add(done);
    void done.finally(() => inflight.delete(done));
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    count: () => written,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.all([...inflight]);
      await new Promise<void>((resolve) => out.end(resolve));
    },
  };
}
