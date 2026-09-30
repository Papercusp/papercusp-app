/**
 * Live tool implementations for the GAIA agent (plan `benchmark-suite-gaia-2026-06-17`, P-003) — built from
 * OUR existing surfaces:
 *   - `web_search` → the Brave Search API (BRAVE_API_KEY) — injectable backend.
 *   - `fetch_url`  → HTTP GET + an HTML→text reduction (JS-light pages; a headless browser is a later upgrade).
 *   - `run_python` → a python3 subprocess in the task's scratch dir (the staged attachment is present), bounded
 *                    by a wall-clock timeout.
 *   - `read_file`  → read a staged attachment: text-like types inline; office/binary types via a python
 *                    extraction probe, else a note steering the model to run_python.
 *
 * The PURE pieces (HTML→text, Brave-result parsing, tool specs, type detection) are unit-tested directly; the
 * I/O seams (`fetchFn`, `execFn`, `readFileFn`) are injected so the toolset is testable with fakes — no
 * network, no python, no spend. {@link makeLiveGaiaToolset} wires the production bindings.
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { htmlToText } from '../../html-to-text';
import type { GaiaToolSpec, GaiaToolset, ToolHandler } from './agent';

/* -------------------------------------------------------------------------- */
/* Tool schemas (advertised to the model)                                      */
/* -------------------------------------------------------------------------- */

export const GAIA_TOOL_SPECS: GaiaToolSpec[] = [
  {
    name: 'web_search',
    description:
      'Search the web for current information. Returns a ranked list of {title, url, description}. Use this to find sources, then fetch_url the most authoritative result to read it in full.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' },
        count: { type: 'integer', description: 'How many results (default 8, max 20).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'fetch_url',
    description:
      'Fetch a URL and return its readable text content (HTML reduced to text; JSON/plain returned as-is). Use after web_search to read a page in full, or to fetch a known URL/API.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Absolute http(s) URL.' } },
      required: ['url'],
    },
  },
  {
    name: 'run_python',
    description:
      'Execute a Python 3 snippet in your working directory (any attached file is present there) and return its stdout+stderr. Use for computation, data parsing (pandas/openpyxl/csv), and processing attachments. Print results you need to read.',
    inputSchema: {
      type: 'object',
      properties: { code: { type: 'string', description: 'Python 3 source to execute.' } },
      required: ['code'],
    },
  },
  {
    name: 'read_file',
    description:
      'Read a staged attachment by its file name. Text/CSV/JSON/code is returned inline; PDF/DOCX/XLSX is text-extracted when possible, else read it with run_python.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'The attachment file name (as given in the question).' } },
      required: ['path'],
    },
  },
];

/* -------------------------------------------------------------------------- */
/* HTML → text (pure)                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Re-exported from `lib/html-to-text.ts`, where it now lives.
 *
 * It moved when the Mastodon adapter became its second caller: a status's
 * `content` is documented as HTML, and the alternatives were to import this
 * benchmark module (with its Brave client, python runner and file reader) into
 * the trigger layer, or to keep a second copy. The re-export means every
 * existing caller and its tests are untouched.
 */
export { htmlToText };

/* -------------------------------------------------------------------------- */
/* Brave search (pure parse + injectable backend)                              */
/* -------------------------------------------------------------------------- */

export interface SearchResult {
  title: string;
  url: string;
  description: string;
}

/** Parse a Brave Search API JSON body → top results. Tolerant of a missing `web.results`. */
export function parseBraveResults(body: unknown): SearchResult[] {
  const web = (body as { web?: { results?: unknown[] } })?.web;
  const results = Array.isArray(web?.results) ? web!.results! : [];
  return results.map((r) => {
    const o = r as { title?: string; url?: string; description?: string };
    return { title: String(o.title ?? ''), url: String(o.url ?? ''), description: String(o.description ?? '') };
  });
}

/** Format results for the model. */
export function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) return 'No results.';
  return results
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${htmlToText(r.description)}`)
    .join('\n\n');
}

/* -------------------------------------------------------------------------- */
/* File-type detection (pure)                                                  */
/* -------------------------------------------------------------------------- */

const TEXT_EXTS = new Set([
  'txt', 'md', 'csv', 'tsv', 'json', 'jsonl', 'xml', 'html', 'htm', 'py', 'js', 'ts', 'java', 'c', 'cpp', 'h',
  'go', 'rs', 'rb', 'sh', 'yaml', 'yml', 'ini', 'cfg', 'log', 'sql', 'r',
]);

/** Is `fileName` a plain-text-like type we can read inline (vs an office/binary type needing extraction)? */
export function isTextLikeFile(fileName: string): boolean {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  return TEXT_EXTS.has(ext);
}

/* -------------------------------------------------------------------------- */
/* Injected seams                                                              */
/* -------------------------------------------------------------------------- */

/** HTTP seam: a fetch-like fn. Default = global fetch. */
export type FetchFn = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown>; headers: { get(k: string): string | null } }>;

/** Subprocess seam: run `bin args` with `stdin`, return stdout/stderr/code; hard-kill at `timeoutMs`. */
export type ExecFn = (
  bin: string,
  args: string[],
  opts: { cwd?: string; timeoutMs: number; stdin?: string },
) => Promise<{ stdout: string; stderr: string; code: number }>;

/** Real subprocess exec. */
export const defaultExec: ExecFn = (bin, args, opts) =>
  new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: opts.cwd });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs);
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? -1 });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + String(err), code: -1 });
    });
    if (opts.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.write(opts.stdin);
    }
    child.stdin.end();
  });

export interface LiveToolsConfig {
  /** Scratch dir where the task's attachment is staged + run_python executes. */
  scratchDir: string;
  /** Brave Search API key (default process.env.BRAVE_API_KEY). */
  braveApiKey?: string;
  /** Python interpreter for run_python (default 'python3'). */
  pythonBin?: string;
  /** Per-call run_python timeout ms (default 60000). */
  pythonTimeoutMs?: number;
  /** Per-call fetch timeout ms (default 30000). */
  fetchTimeoutMs?: number;
  /** Max chars returned from fetch_url / read_file (default 24000). */
  maxReadChars?: number;
  fetchFn?: FetchFn;
  execFn?: ExecFn;
  /** Attachment reader (default node fs readFile). Injected for tests. */
  readFileFn?: (path: string) => Promise<Buffer>;
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}\n… [truncated ${s.length - n} chars]`;
}

/* -------------------------------------------------------------------------- */
/* Handlers                                                                    */
/* -------------------------------------------------------------------------- */

/** Build the `web_search` handler (Brave Search API). */
export function makeWebSearchHandler(cfg: LiveToolsConfig): ToolHandler {
  const key = cfg.braveApiKey ?? process.env.BRAVE_API_KEY ?? '';
  const fetchFn = cfg.fetchFn ?? (globalThis.fetch as unknown as FetchFn);
  return async (input) => {
    const query = String(input.query ?? '').trim();
    if (!query) return 'web_search error: empty query';
    if (!key) return 'web_search error: BRAVE_API_KEY not configured';
    const count = Math.min(Math.max(Number(input.count) || 8, 1), 20);
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
    const res = await fetchFn(url, { headers: { Accept: 'application/json', 'X-Subscription-Token': key } });
    if (!res.ok) return `web_search error: HTTP ${res.status}`;
    const body = await res.json();
    return formatSearchResults(parseBraveResults(body));
  };
}

/** Build the `fetch_url` handler (HTTP GET → readable text). */
export function makeFetchUrlHandler(cfg: LiveToolsConfig): ToolHandler {
  const fetchFn = cfg.fetchFn ?? (globalThis.fetch as unknown as FetchFn);
  const maxChars = cfg.maxReadChars ?? 24000;
  return async (input) => {
    const url = String(input.url ?? '').trim();
    if (!/^https?:\/\//i.test(url)) return 'fetch_url error: a valid absolute http(s) URL is required';
    const res = await fetchFn(url, { headers: { 'User-Agent': 'papercusp-gaia-agent/1.0', Accept: 'text/html,application/json,*/*' } });
    if (!res.ok) return `fetch_url error: HTTP ${res.status} for ${url}`;
    const ctype = res.headers.get('content-type') ?? '';
    const raw = await res.text();
    if (/application\/json/i.test(ctype)) return clip(raw, maxChars);
    if (/text\/html|application\/xhtml/i.test(ctype) || /^\s*<(!doctype|html)/i.test(raw)) {
      return clip(htmlToText(raw), maxChars);
    }
    return clip(raw, maxChars);
  };
}

/** Build the `run_python` handler (python3 subprocess in the scratch dir). */
export function makeRunPythonHandler(cfg: LiveToolsConfig): ToolHandler {
  const exec = cfg.execFn ?? defaultExec;
  const python = cfg.pythonBin ?? 'python3';
  const timeoutMs = cfg.pythonTimeoutMs ?? 60000;
  return async (input) => {
    const code = String(input.code ?? '');
    if (!code.trim()) return 'run_python error: empty code';
    const { stdout, stderr, code: rc } = await exec(python, ['-c', code], { cwd: cfg.scratchDir, timeoutMs });
    const out = [stdout && `[stdout]\n${stdout}`, stderr && `[stderr]\n${stderr}`].filter(Boolean).join('\n');
    const tail = rc === 0 ? '' : `\n[exit code ${rc}]`;
    return clip(out || '(no output)', cfg.maxReadChars ?? 24000) + tail;
  };
}

/** Build the `read_file` handler: inline text-like files, python-extract office/binary, else steer to run_python. */
export function makeReadFileHandler(cfg: LiveToolsConfig): ToolHandler {
  const exec = cfg.execFn ?? defaultExec;
  const python = cfg.pythonBin ?? 'python3';
  const readFileFn = cfg.readFileFn ?? ((p: string) => readFile(p));
  const maxChars = cfg.maxReadChars ?? 24000;
  return async (input) => {
    const name = String(input.path ?? '').trim();
    if (!name) return 'read_file error: a file name is required';
    // Resolve within the scratch dir (the attachment is staged there); reject path escapes.
    const safe = name.replace(/^\.?\//, '');
    if (safe.includes('..')) return 'read_file error: path traversal not allowed';
    const full = join(cfg.scratchDir, safe);
    if (isTextLikeFile(safe)) {
      try {
        const buf = await readFileFn(full);
        return clip(buf.toString('utf8'), maxChars);
      } catch (e) {
        return `read_file error: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    // Office/binary: try a best-effort python extraction; on failure, steer the model to run_python.
    const probe = [
      'import sys',
      `p=${JSON.stringify(full)}`,
      'ext=p.rsplit(".",1)[-1].lower()',
      'try:',
      '  if ext=="pdf":',
      '    from pypdf import PdfReader',
      '    print("\\n".join((pg.extract_text() or "") for pg in PdfReader(p).pages))',
      '  elif ext in ("xlsx","xls"):',
      '    import openpyxl',
      '    wb=openpyxl.load_workbook(p, data_only=True)',
      '    for ws in wb.worksheets:',
      '      print("# sheet", ws.title)',
      '      for row in ws.iter_rows(values_only=True):',
      '        print(",".join("" if c is None else str(c) for c in row))',
      '  elif ext=="docx":',
      '    import docx',
      '    print("\\n".join(par.text for par in docx.Document(p).paragraphs))',
      '  else:',
      '    sys.stdout.buffer.write(open(p,"rb").read()[:20000])',
      'except Exception as e:',
      '  print("EXTRACT_FAILED:", e)',
    ].join('\n');
    const { stdout } = await exec(python, ['-c', probe], { cwd: cfg.scratchDir, timeoutMs: cfg.pythonTimeoutMs ?? 60000 });
    if (!stdout.trim() || stdout.includes('EXTRACT_FAILED')) {
      return `read_file: could not auto-extract "${name}" (${stdout.trim() || 'no output'}). Read it with run_python using the right library (pypdf/openpyxl/python-docx).`;
    }
    return clip(stdout, maxChars);
  };
}

/** Assemble the full live toolset for one task. */
export function makeLiveGaiaToolset(cfg: LiveToolsConfig): GaiaToolset {
  return {
    specs: GAIA_TOOL_SPECS,
    handlers: {
      web_search: makeWebSearchHandler(cfg),
      fetch_url: makeFetchUrlHandler(cfg),
      run_python: makeRunPythonHandler(cfg),
      read_file: makeReadFileHandler(cfg),
    },
  };
}
