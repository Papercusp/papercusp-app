/**
 * P-017 third-party engine adapters (plan `gitnexus-deterministic-integration-
 * 2026-10-05`, D-011, D-013): codegraph and trace-mcp, the permissively
 * licensed candidates the 2026-10-02 harness had no arm for.
 *
 * D-013 rules every adapter here follows:
 *  - RAW answers: the engine's answer is passed through unfiltered. The only
 *    filter is the one the question defines — symbol-search and definition keep
 *    results whose name equals the subject.
 *  - UNIFORM inputs: subject, plus anchorFile and depth when the case has them
 *    and the engine accepts them. Limits are raised so nothing truncates
 *    silently; a truncated answer says so in its note.
 *  - Engine-owned resolution only: a symbol id the engine reports without a line
 *    is resolved with the engine's own lookup, never with ours.
 *  - Isolation: an isolated HOME plus the admission record's telemetry-off env.
 *
 * The output parsers are exported and pure so they are tested against captured
 * engine output without the engine installed.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { isAbsolute, relative } from 'node:path';
import { gitnexusStartLineBase, type SymbolSite } from './contracts';
import type { PhaseCost } from './engine-comparison';
import { analyzePhaseOf, execTimed, gitnexusAnalyzeInvocation, phaseOf, type ArmDeps } from './engine-comparison-arms';
import { cbmProjectName, parseSearchCode, parseSearchGraph, parseTrace, unwrapCbmEnvelope, withDaemonPeak, type CbmDeclaration } from './engine-comparison-cbm';
import type { ArmCapabilities, FairCase, FairIntent } from './fair-comparison';
import { guardedArm, type AcceptedEngineFault, type FairArm, type RawReply } from './fair-comparison-arms';

export interface EngineArmConfig {
  readonly version: string;
  /** Absolute path of the engine's CLI. */
  readonly bin: string;
  /** The tree the engine indexes and answers about (its own copy, D-013). */
  readonly treeRoot: string;
  /** Isolated HOME: the engine's global state and caches never touch the operator's. */
  readonly home: string;
  /** The admission record's env (telemetry off). */
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

const posix = (p: string): string => p.split('\\').join('/').replace(/^\.\//, '');
const site = (path: string | undefined, line1: number | null | undefined, kind: string | null | undefined): SymbolSite => ({
  path: posix(path ?? ''),
  line1: typeof line1 === 'number' ? line1 : null,
  kind: kind ? kind.toLowerCase() : null,
});

// ─── codegraph (MIT, npm @colbymchenry/codegraph) ────────────────────────────

export const CODEGRAPH_INTENTS: readonly FairIntent[] = ['callers', 'callees', 'impact', 'definition', 'symbol-search'];

/** The codegraph CLI call for one case. codegraph has no references or text-search command. */
export function codegraphArgv(kase: FairCase): string[] {
  const file = kase.anchorFile ? ['-f', kase.anchorFile] : [];
  switch (kase.intent) {
    case 'callers':
    case 'callees':
      return [kase.intent, kase.subject, '-j', '-l', '10000', ...file];
    case 'impact':
      return ['impact', kase.subject, '-j', '-d', String(kase.depth ?? 2), ...file];
    case 'definition':
    case 'symbol-search':
      return ['query', kase.subject, '-j', '-l', '1000'];
    default:
      throw new Error(`declined: codegraph has no command for intent '${kase.intent}'`);
  }
}

interface CgNode {
  readonly name?: string;
  readonly kind?: string;
  readonly filePath?: string;
  readonly startLine?: number;
}

/**
 * Parse codegraph's `-j` output. An unknown symbol prints a notice instead of
 * JSON (exit 0): that is an answer — the engine is confident there is nothing —
 * so it returns no sites. Any other non-JSON output, or JSON without the
 * expected array, throws: a changed output shape must surface as a crash.
 */
export function parseCodegraph(kase: FairCase, stdout: string, stderr = ''): { sites: SymbolSite[]; note: string | null } {
  const start = stdout.search(/^[[{]/m);
  if (start < 0) {
    if (/\bnot found\b/i.test(`${stdout}\n${stderr}`)) return { sites: [], note: 'codegraph: symbol not found' };
    throw new Error(`codegraph printed no JSON: ${`${stdout}${stderr}`.trim().slice(0, 200)}`);
  }
  const json = JSON.parse(stdout.slice(start)) as unknown;
  let nodes: readonly CgNode[] | undefined;
  let truncated = false;
  if (kase.intent === 'definition' || kase.intent === 'symbol-search') {
    if (!Array.isArray(json)) throw new Error('codegraph query: expected a JSON array');
    nodes = (json as Array<{ node?: CgNode }>).map((r) => r.node ?? {}).filter((n) => n.name === kase.subject);
  } else {
    const obj = json as Record<string, unknown>;
    const field = kase.intent === 'impact' ? 'affected' : kase.intent;
    if (!Array.isArray(obj[field])) throw new Error(`codegraph ${kase.intent}: no '${field}' array in output`);
    nodes = obj[field] as CgNode[];
    truncated = obj.truncated === true;
  }
  return { sites: nodes.map((n) => site(n.filePath, n.startLine, n.kind)), note: truncated ? 'codegraph: truncated at --limit' : null };
}

export function createCodegraphArm(cfg: EngineArmConfig, deps: ArmDeps, now?: () => number): FairArm {
  const exec = deps.exec ?? execTimed;
  // CODEGRAPH_NO_WATCHDOG: CodeGraph's watchdog kills a process whose main
  // thread is unresponsive for ~60s (upstream #850). Indexing this tree trips
  // it, so the 2026-10-06 run killed the indexer and the arm answered no case.
  // The watchdog guards a long-lived server; it changes no answer. The 4h index
  // timeout below still bounds a real hang.
  const env = { ...cfg.env, HOME: cfg.home, NO_COLOR: '1', CODEGRAPH_NO_WATCHDOG: '1' };
  const run = (args: readonly string[], timeoutMs = cfg.timeoutMs ?? 120_000) => exec(cfg.bin, args, { cwd: cfg.treeRoot, env, timeoutMs });
  const capabilities: ArmCapabilities = { armId: 'codegraph', version: cfg.version, intents: CODEGRAPH_INTENTS, licence: 'permissive' };
  return guardedArm({
    capabilities,
    unavailable: null,
    ...(now ? { now } : {}),
    // `index` rebuilds from scratch; on a tree never initialised it fails, and `init` builds the first index.
    async index(): Promise<PhaseCost> {
      const r = await run(['index', '.'], 4 * 3_600_000);
      return phaseOf(r.code === 0 ? r : await run(['init', '.'], 4 * 3_600_000), deps);
    },
    async ask(kase): Promise<RawReply> {
      const r = await run(codegraphArgv(kase));
      if (r.code !== 0) return { sites: [], error: `codegraph ${kase.intent} exit ${r.code}: ${r.stderr.trim().slice(-300)}` };
      const { sites, note } = parseCodegraph(kase, r.stdout, r.stderr);
      return { sites, error: null, note };
    },
  });
}

// ─── trace-mcp (MIT) — answers only over MCP stdio ───────────────────────────

export const TRACE_MCP_INTENTS: readonly FairIntent[] = ['callers', 'callees', 'impact', 'definition', 'references', 'symbol-search', 'text-search'];

/** The JSON body of an MCP tool result. trace-mcp returns one text part holding JSON. */
/** The JSON an MCP tool returned as text content. Non-JSON text throws, so a changed output shape surfaces as a crash. */
export function mcpToolJson(result: unknown, engine: string): { json: Record<string, unknown>; isError: boolean } {
  const r = result as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  const text = (r.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`${engine} returned non-JSON: ${text.slice(0, 200)}`);
  }
  return { json, isError: r.isError === true };
}

interface TraceItem {
  readonly symbol_id?: string;
  readonly name?: string;
  readonly kind?: string;
  readonly file?: string;
  readonly line?: number;
}

/** Exact-name symbols from a `search` result, narrowed to anchorFile when any of them lives there. */
export function traceCandidates(kase: FairCase, searchJson: Record<string, unknown>): TraceItem[] {
  const items = ((searchJson.items as TraceItem[] | undefined) ?? []).filter((i) => i.name === kase.subject);
  const inAnchor = kase.anchorFile ? items.filter((i) => posix(i.file ?? '') === kase.anchorFile) : [];
  return inAnchor.length > 0 ? inAnchor : items;
}

/** Sites from a `search_text` result, and whether it hit its result cap. */
export function traceTextSites(json: Record<string, unknown>): { sites: SymbolSite[]; truncated: boolean } {
  const files = (json.files as Array<{ file?: string; hits?: Array<{ line?: number }> }> | undefined) ?? [];
  const sites = files.flatMap((f) => (f.hits ?? []).map((h) => site(f.file, h.line, null)));
  return { sites, truncated: json.truncated === true || json.timed_out === true };
}

/** Sites from `get_call_graph`: `called_by` for callers, `calls` for callees. */
export function traceCallSites(json: Record<string, unknown>, intent: 'callers' | 'callees'): SymbolSite[] {
  const root = json.root as { called_by?: TraceItem[]; calls?: TraceItem[] } | undefined;
  if (!root) throw new Error('trace-mcp get_call_graph: no root in output');
  return ((intent === 'callers' ? root.called_by : root.calls) ?? []).map((n) => site(n.file, n.line, n.kind));
}

/** Sites from `find_usages`. trace-mcp names the referencing symbol; its line is the scope's (D-013 alias rule). */
export function traceUsageSites(json: Record<string, unknown>): SymbolSite[] {
  const refs = (json.references as Array<{ file?: string; line?: number; symbol?: { line_start?: number; kind?: string } }> | undefined) ?? [];
  return refs.map((r) => site(r.file, r.line ?? r.symbol?.line_start, r.symbol?.kind ?? null));
}

/** Symbol ids from `get_change_impact`; trace-mcp gives no lines, so each is resolved with its own get_symbol. */
export function traceImpactSymbolIds(json: Record<string, unknown>): string[] {
  const deps = (json.dependents as Array<{ symbols?: Array<{ symbolId?: string }> }> | undefined) ?? [];
  return deps.flatMap((d) => (d.symbols ?? []).map((s) => s.symbolId).filter((s): s is string => typeof s === 'string'));
}

export interface McpSession {
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

/** Start an engine's MCP server in the tree (`<bin> <serveArgs>`) and talk MCP to it over stdio. */
export async function openMcpSession(
  cfg: EngineArmConfig,
  serveArgs: readonly string[],
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<McpSession> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
  Object.assign(env, cfg.env, extraEnv, { HOME: cfg.home, NO_COLOR: '1' });
  const transport = new StdioClientTransport({ command: cfg.bin, args: [...serveArgs], cwd: cfg.treeRoot, env, stderr: 'ignore' });
  const client = new Client({ name: 'papercusp-fair-comparison', version: '1' });
  await client.connect(transport);
  const timeout = cfg.timeoutMs ?? 120_000;
  return {
    call: (name, args) => client.callTool({ name, arguments: args }, undefined, { timeout }),
    close: () => client.close(),
  };
}

/** Answer one case through an open trace-mcp session (exported for tests with a fake session). */
export async function askTrace(session: Pick<McpSession, 'call'>, kase: FairCase): Promise<RawReply> {
  const call = async (name: string, args: Record<string, unknown>) => {
    const { json, isError } = mcpToolJson(await session.call(name, args), 'trace-mcp');
    if (isError) {
      const err = json.error as { code?: string; message?: string } | undefined;
      if (err?.code === 'NOT_FOUND') return null;
      throw new Error(`trace-mcp ${name}: ${err?.message ?? JSON.stringify(json).slice(0, 200)}`);
    }
    return json;
  };

  if (kase.intent === 'text-search') {
    const json = await call('search_text', { query: kase.subject, case_sensitive: true, max_results: 200 });
    const { sites, truncated } = json ? traceTextSites(json) : { sites: [], truncated: false };
    return { sites, error: null, note: truncated ? 'trace-mcp: search_text hit its 200-result cap' : null };
  }

  const found = await call('search', { query: kase.subject, limit: 500 });
  const candidates = found ? traceCandidates(kase, found) : [];
  if (kase.intent === 'symbol-search' || kase.intent === 'definition') {
    return { sites: candidates.map((c) => site(c.file, c.line, c.kind)), error: null };
  }
  if (candidates.length === 0) return { sites: [], error: null, note: 'trace-mcp: symbol not found' };

  const sites: SymbolSite[] = [];
  for (const c of candidates) {
    const id = c.symbol_id;
    if (!id) continue;
    if (kase.intent === 'callers' || kase.intent === 'callees') {
      const json = await call('get_call_graph', { symbol_id: id, depth: 1 });
      if (json) sites.push(...traceCallSites(json, kase.intent));
    } else if (kase.intent === 'references') {
      const json = await call('find_usages', { symbol_id: id, limit: 1000 });
      if (json) sites.push(...traceUsageSites(json));
    } else if (kase.intent === 'impact') {
      const json = await call('get_change_impact', { symbol_id: id, depth: kase.depth ?? 2, max_dependents: 5000 });
      for (const dep of json ? traceImpactSymbolIds(json) : []) {
        const sym = await call('get_symbol', { symbol_id: dep, max_lines: 1 });
        sites.push(sym ? site(sym.file as string | undefined, sym.line_start as number | undefined, sym.kind as string | undefined) : site(dep.split('::')[0], null, null));
      }
    }
  }
  return { sites, error: null };
}

export function createTraceMcpArm(cfg: EngineArmConfig, deps: ArmDeps, now?: () => number): FairArm {
  const exec = deps.exec ?? execTimed;
  const capabilities: ArmCapabilities = { armId: 'trace-mcp', version: cfg.version, intents: TRACE_MCP_INTENTS, licence: 'permissive' };
  let session: Promise<McpSession> | null = null;
  return guardedArm({
    capabilities,
    unavailable: null,
    ...(now ? { now } : {}),
    index: async () =>
      phaseOf(await exec(cfg.bin, ['index', '.', '--force'], { cwd: cfg.treeRoot, env: { ...cfg.env, HOME: cfg.home }, timeoutMs: 4 * 3_600_000 }), deps),
    async ask(kase) {
      session ??= openMcpSession(cfg, ['serve']);
      return askTrace(await session, kase);
    },
    async close() {
      if (session) await (await session).close();
      session = null;
    },
  });
}

// ─── CodeGraphContext (MIT, PyPI codegraphcontext) — answers over MCP stdio ──

/**
 * CGC's intents. It has no references query (`analyze variable` covers
 * variables only). Its text search is a full-text index over function sources
 * and docstrings: it answers with the enclosing function, and module-level text
 * is not indexed. That is CGC's text search, so it is declared and measured.
 */
export const CGC_INTENTS: readonly FairIntent[] = ['callers', 'callees', 'impact', 'definition', 'symbol-search', 'text-search'];

/**
 * CGC caps every tool at 15-50 results by default. It reads `TOOL_RESULT_LIMITS`
 * from its environment, so the arm raises every cap it uses (D-013 rule 2).
 */
export const CGC_RESULT_LIMITS: string = JSON.stringify(
  Object.fromEntries(['find_code', 'analyze_code_relationships', 'find_callers', 'find_callees', 'find_all_callers'].map((k) => [k, 1_000_000])),
);

/** The one CGC tool call for a case. `context` is CGC's own file scope; it resolves a repo-relative path against the server's cwd. */
export function cgcRequest(kase: FairCase): { tool: string; args: Record<string, unknown> } {
  const scope = kase.anchorFile ? { context: kase.anchorFile } : {};
  const relationship = (query_type: string, extra: Record<string, unknown> = {}) => ({
    tool: 'analyze_code_relationships',
    args: { query_type, target: kase.subject, ...scope, ...extra },
  });
  switch (kase.intent) {
    case 'callers':
      return relationship('find_callers');
    case 'callees':
      return relationship('find_callees');
    case 'impact':
      return relationship('find_all_callers', { depth: kase.depth ?? 2 });
    case 'definition':
    case 'symbol-search':
    case 'text-search':
      return { tool: 'find_code', args: { query: kase.subject, fuzzy_search: false } };
    default:
      throw new Error(`declined: CodeGraphContext has no query for intent '${kase.intent}'`);
  }
}

type CgcRow = Record<string, unknown>;
const rows = (v: unknown, what: string): CgcRow[] => {
  if (!Array.isArray(v)) throw new Error(`cgc: expected a '${what}' array`);
  return v as CgcRow[];
};
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** CGC prints absolute paths; the score is on repo-relative ones. A path outside the tree stays absolute and scores as wrong. */
export function cgcPath(treeRoot: string, p: string | undefined): string | undefined {
  if (p === undefined) return undefined;
  const rel = relative(treeRoot, p);
  return rel.startsWith('..') || isAbsolute(rel) ? p : rel;
}

/**
 * Read one CGC tool reply (the JSON CGC prints as text content). Raw (D-013):
 * callers keep every reported call line (lines in one scope are aliases of one
 * unit, D-012); callees and impact keep the declaration lines CGC reports;
 * definition and symbol-search keep exact-name symbols; text-search keeps every
 * content match. A query error CGC reports inside a successful envelope is an
 * error, never an empty answer.
 */
export function parseCgc(kase: FairCase, json: Record<string, unknown>, treeRoot: string): RawReply {
  if (json.success === false) return { sites: [], error: `cgc: ${String(json.error ?? json.message ?? 'success=false').slice(0, 300)}` };
  const results = json.results as Record<string, unknown> | undefined;
  if (!results || typeof results !== 'object') throw new Error('cgc: reply has no results object');
  if (typeof results.error === 'string') return { sites: [], error: `cgc ${kase.intent}: ${results.error.slice(0, 300)}` };
  const at = (p: unknown, line: unknown, kind: string | undefined) => site(cgcPath(treeRoot, str(p)), num(line), kind);

  if (kase.intent === 'definition' || kase.intent === 'symbol-search') {
    const buckets: Array<[string, string]> = [['functions_by_name', 'function'], ['classes_by_name', 'class'], ['variables_by_name', 'variable']];
    const sites = buckets.flatMap(([field, kind]) =>
      rows(results[field] ?? [], field).filter((r) => r.name === kase.subject).map((r) => at(r.path, r.line_number, kind)),
    );
    return { sites, error: null };
  }
  if (kase.intent === 'text-search') {
    return { sites: rows(results.content_matches ?? [], 'content_matches').map((r) => at(r.path, r.line_number, str(r.type))), error: null };
  }
  const list = rows(results.results, 'results');
  const truncated = results.truncated === true;
  const sites =
    kase.intent === 'callers'
      ? list.map((r) => at(r.caller_file_path, r.call_line_number, 'call'))
      : kase.intent === 'callees'
        ? list.map((r) => at(r.called_file_path, r.called_line_number, 'function'))
        : list.map((r) => at(r.caller_file_path, r.caller_line_number, 'function'));
  return { sites, error: null, note: truncated ? `cgc: truncated at result_limit ${String(results.result_limit)}` : null };
}

/** Answer one case through an open CGC session (exported for tests with a fake session). */
export async function askCgc(session: Pick<McpSession, 'call'>, kase: FairCase, treeRoot: string): Promise<RawReply> {
  const { tool, args } = cgcRequest(kase);
  const { json, isError } = mcpToolJson(await session.call(tool, args), 'cgc');
  if (isError) return { sites: [], error: `cgc ${tool}: ${JSON.stringify(json).slice(0, 300)}` };
  return parseCgc(kase, json, treeRoot);
}

const CGC_IMPACT_CRASH =
  'CodeGraphContext 0.6.13 find_all_callers fails for every target on its default KuzuDB backend ("Binder exception: Expression in WITH must be aliased"). ' +
  'Reproduced by calling analyze_code_relationships {query_type:"find_all_callers"} on its own MCP server, outside the adapter (2026-10-06).';

/**
 * Micro-repo defects shown to be CGC's own (AcceptedEngineFault): measured on
 * the real corpus like any other answer, never blocking the arm. Each must stop
 * occurring before it is removed; runConformance reports a stale one.
 */
export const CGC_ACCEPTED_FAULTS: readonly AcceptedEngineFault[] = Object.freeze([
  { caseId: 'micro-impact-doubled', outcome: 'crashed', detail: /Binder exception/, evidence: CGC_IMPACT_CRASH },
  { caseId: 'micro-impact-scale', outcome: 'crashed', detail: /Binder exception/, evidence: CGC_IMPACT_CRASH },
  {
    caseId: 'micro-text-search-grand-total',
    outcome: 'wrong',
    evidence:
      'CGC content search is a single-token full-text index over function sources and docstrings. Its own CLI, `cgc find content "grand total"`, ' +
      'also prints "No content matches found"; `cgc find content grand` finds only the enclosing function report (report.ts:19). The literal on ' +
      'report.ts:3 is a module-level constant, which CGC does not index (2026-10-06).',
  },
]);

/**
 * The CGC arm. CGC keeps its graph under `$HOME/.codegraphcontext` in global
 * mode, so `cfg.home` must be unique per tree: two trees under one HOME share a
 * graph and answer for each other.
 */
export function createCgcArm(cfg: EngineArmConfig, deps: ArmDeps, now?: () => number): FairArm {
  const exec = deps.exec ?? execTimed;
  const capabilities: ArmCapabilities = { armId: 'codegraphcontext', version: cfg.version, intents: CGC_INTENTS, licence: 'permissive' };
  const env = { TOOL_RESULT_LIMITS: CGC_RESULT_LIMITS };
  let session: Promise<McpSession> | null = null;
  return guardedArm({
    capabilities,
    unavailable: null,
    ...(now ? { now } : {}),
    index: async () =>
      phaseOf(
        await exec(cfg.bin, ['index', '.', '--force', '--no-progress'], {
          cwd: cfg.treeRoot,
          env: { ...cfg.env, ...env, HOME: cfg.home, NO_COLOR: '1' },
          timeoutMs: 4 * 3_600_000,
        }),
        deps,
      ),
    async ask(kase) {
      session ??= openMcpSession(cfg, ['mcp', 'start'], env);
      return askCgc(await session, kase, cfg.treeRoot);
    },
    async close() {
      if (session) await (await session).close();
      session = null;
    },
  });
}

// ─── shared: same-name candidates ────────────────────────────────────────────

/**
 * Exact-name candidates narrowed to anchorFile when any of them lives there,
 * otherwise all of them (D-013 rule 2: with no usable anchor the union is
 * scored). The same rule trace-mcp's adapter applies, so every engine that
 * resolves by name first is disambiguated identically.
 */
export function narrowToAnchor<T>(kase: FairCase, items: readonly T[], fileOf: (t: T) => string | undefined): T[] {
  const inAnchor = kase.anchorFile ? items.filter((t) => posix(fileOf(t) ?? '') === kase.anchorFile) : [];
  return inAnchor.length > 0 ? inAnchor : [...items];
}

// ─── GitNexus (PolyForm-Noncommercial-1.0.0) — answers over MCP stdio ────────
//
// Why not fromEngineArm over the 2026-10-02 GitNexus arm (D-015): that arm reads
// through the production facade, which caps every answer at 100 sites, reduces
// impact to a count and a risk grade, and receives only the subject, never
// anchorFile or depth. Each of those breaks a D-013 rule, so this adapter talks
// to the engine directly and reuses only the production analyze invocation and
// the measured line base per version.

/**
 * GitNexus's intents. `context` answers callers, callees and the symbol itself;
 * `impact` walks upstream to a depth. It has no references query (its incoming
 * edges are calls) and no literal text search (`query` is concept search), so
 * neither is declared.
 */
export const GITNEXUS_INTENTS: readonly FairIntent[] = ['callers', 'callees', 'impact', 'definition', 'symbol-search'];

/** The JSON of a GitNexus MCP reply. GitNexus appends `\n---` next-step hints after the JSON; they are not part of the answer. */
export function gitnexusJson(result: unknown): { json: Record<string, unknown>; isError: boolean } {
  const r = result as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  const text = (r.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
  try {
    return { json: JSON.parse(text.split('\n---')[0]!) as Record<string, unknown>, isError: r.isError === true };
  } catch {
    throw new Error(`gitnexus returned non-JSON (${text.length} chars): ${text.slice(0, 200)}`);
  }
}

interface GnxNode {
  readonly uid?: string;
  readonly id?: string;
  readonly name?: string;
  readonly kind?: string;
  readonly filePath?: string;
  readonly startLine?: number;
  /** The line on an `ambiguous` candidate (same base as startLine). */
  readonly line?: number;
}

/** A one-based line from a GitNexus raw line, given the version's measured base (contracts.ts). */
export const gitnexusLine1 = (raw: number | undefined, base: 0 | 1): number | null =>
  typeof raw === 'number' ? raw + (base === 0 ? 1 : 0) : null;

/** The node kind GitNexus encodes as the uid prefix (`Function:src/a.ts:f`, `File:src/a.ts`). */
const gnxKind = (uid: string): string | null => (uid.includes(':') ? uid.slice(0, uid.indexOf(':')) : null);

/** Answer one case through an open GitNexus MCP session (exported for tests with a fake session). */
export async function askGitnexus(session: Pick<McpSession, 'call'>, kase: FairCase, base: 0 | 1): Promise<RawReply> {
  const call = async (tool: string, args: Record<string, unknown>) => {
    const { json, isError } = gitnexusJson(await session.call(tool, args));
    if (isError) throw new Error(`gitnexus ${tool}: ${JSON.stringify(json).slice(0, 300)}`);
    return json;
  };
  const notes: string[] = [];
  const first = await call('context', { name: kase.subject });
  let targets: Array<{ node: GnxNode; ctx: Record<string, unknown> | null }>;
  if (first.status === 'found') {
    targets = [{ node: (first.symbol as GnxNode | undefined) ?? {}, ctx: first }];
  } else if (first.status === 'ambiguous') {
    const listed = (first.candidates as GnxNode[] | undefined) ?? [];
    // GitNexus lists at most 30 candidates (LIMIT 30 in its context resolver).
    if (listed.length >= 30) notes.push('gitnexus: candidate list may be capped at 30');
    targets = narrowToAnchor(kase, listed.filter((c) => c.name === kase.subject), (c) => c.filePath).map((node) => ({ node, ctx: null }));
  } else if (typeof first.error === 'string' && /not found/i.test(first.error)) {
    return { sites: [], error: null, note: 'gitnexus: symbol not found' };
  } else {
    throw new Error(`gitnexus context: unrecognized reply ${JSON.stringify(first).slice(0, 200)}`);
  }
  const note = () => (notes.length > 0 ? notes.join('; ') : null);

  if (kase.intent === 'definition' || kase.intent === 'symbol-search') {
    const exact = targets.filter((t) => t.node.name === kase.subject);
    return { sites: exact.map((t) => site(t.node.filePath, gitnexusLine1(t.node.startLine ?? t.node.line, base), t.node.kind)), error: null, note: note() };
  }

  // Edge rows carry only uid/name/filePath. A File node is the file's top level
  // (D-013 module scope: line 1); any other node's line comes from GitNexus's own
  // context lookup by uid (D-013 rule 3).
  const lines = new Map<string, number | null>();
  const edgeSite = async (uid: string, filePath: string | undefined): Promise<SymbolSite> => {
    if (uid.startsWith('File:')) return site(filePath ?? uid.slice(5), 1, 'file');
    if (!lines.has(uid)) {
      const j = await call('context', { uid });
      lines.set(uid, j.status === 'found' ? gitnexusLine1((j.symbol as GnxNode | undefined)?.startLine, base) : null);
    }
    return site(filePath, lines.get(uid) ?? null, gnxKind(uid));
  };

  const sites: SymbolSite[] = [];
  for (const t of targets) {
    const uid = t.node.uid;
    if (!uid) throw new Error(`gitnexus: candidate without a uid for ${kase.subject}`);
    if (kase.intent === 'callers' || kase.intent === 'callees') {
      const ctx = t.ctx ?? (await call('context', { uid }));
      const side = ctx[kase.intent === 'callers' ? 'incoming' : 'outgoing'] as { calls?: GnxNode[] } | undefined;
      for (const e of side?.calls ?? []) sites.push(await edgeSite(e.uid ?? '', e.filePath));
    } else if (kase.intent === 'impact') {
      const j = await call('impact', {
        target: kase.subject,
        target_uid: uid,
        direction: 'upstream',
        maxDepth: kase.depth ?? 2,
        includeTests: true,
        limit: 100_000,
      });
      if (typeof j.error === 'string') return { sites: [], error: `gitnexus impact: ${j.error.slice(0, 300)}` };
      if (j.pagination || j.partial === true || j.truncated === true) notes.push('gitnexus: impact answer paginated or partial');
      for (const rows of Object.values((j.byDepth as Record<string, GnxNode[]> | undefined) ?? {})) {
        for (const r of rows) sites.push(await edgeSite(r.id ?? r.uid ?? '', r.filePath));
      }
    } else {
      throw new Error(`declined: gitnexus has no query for intent '${kase.intent}'`);
    }
  }
  return { sites, error: null, note: note() };
}

/**
 * The GitNexus arm. Indexing runs the production `analyze` invocation
 * (gitnexusAnalyzeInvocation: heap, stack and WAL pins); queries go to
 * `gitnexus mcp` under the same isolated HOME, whose registry holds only this
 * tree. The version's raw line base is measured, never assumed: an unmeasured
 * version refuses to build the arm.
 */
export function createGitnexusFairArm(cfg: EngineArmConfig, deps: ArmDeps, now?: () => number): FairArm {
  const base = gitnexusStartLineBase(cfg.version);
  if (base === null) throw new Error(`gitnexus ${cfg.version}: no measured startLine base in GITNEXUS_START_LINE_BASE_BY_VERSION (contracts.ts)`);
  const exec = deps.exec ?? execTimed;
  const capabilities: ArmCapabilities = { armId: 'gitnexus', version: cfg.version, intents: GITNEXUS_INTENTS, licence: 'noncommercial' };
  let session: Promise<McpSession> | null = null;
  return guardedArm({
    capabilities,
    unavailable: null,
    ...(now ? { now } : {}),
    async index() {
      const inv = gitnexusAnalyzeInvocation(cfg, ['analyze', '--skip-agents-md', '--force', '.']);
      return analyzePhaseOf(await exec(inv.cmd, inv.args, { cwd: cfg.treeRoot, env: { ...cfg.env, ...inv.env }, timeoutMs: 4 * 3_600_000 }), deps);
    },
    async ask(kase) {
      session ??= openMcpSession(cfg, ['mcp']);
      return askGitnexus(await session, kase, base);
    },
    async close() {
      if (session) await (await session).close();
      session = null;
    },
  });
}

// ─── codebase-memory (MIT, DeusData/codebase-memory-mcp) — MCP stdio ─────────
//
// Why not fromEngineArm over the 2026-10-02 codebase-memory arm (D-015): it ran
// trace_path at CBM's default depth 3 (so "callers" returned callers of callers)
// with the default 100-row / 3200-token budget, ran search_code at its default
// 10 results x 8 matches, and never received anchorFile or depth. This adapter
// reuses that arm's parsers and its daemon-RSS sampling for indexing.

/** CBM's intents. It has no references query, so references is not declared. */
export const CBM_INTENTS: readonly FairIntent[] = ['callers', 'callees', 'impact', 'definition', 'symbol-search', 'text-search'];

/** Every CBM cap the arm touches, at the engine's own maximum (D-013 rule 2). */
export const CBM_LIMITS = Object.freeze({
  searchGraph: { limit: 500, max_output_tokens: 1_000_000 },
  tracePath: { limit: 5000, max_output_tokens: 1_000_000, include_tests: true },
  searchCode: { result_limit: 500, match_limit: 500, raw_limit: 100, max_output_tokens: 1_000_000 },
});

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * An exact-name alternation CBM's `name_pattern` accepts. CBM's regex engine has
 * no non-capturing group: `^report$` matches, `^(?:report)$` matches NOTHING and
 * reports no error (measured on the micro repo, 2026-10-06). A plain group works.
 */
export const cbmNameAlternation = (names: readonly string[]): string => `^(${[...new Set(names)].map(escapeRe).join('|')})$`;

const cbmQn =(d: Pick<CbmDeclaration, 'qnPrefix' | 'name'>): string => (d.qnPrefix ? `${d.qnPrefix}.${d.name}` : d.name);

/** Answer one case through an open CBM MCP session (exported for tests with a fake session). */
export async function askCbm(session: Pick<McpSession, 'call'>, kase: FairCase, project: string): Promise<RawReply> {
  const notes: string[] = [];
  const call = async (tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const u = unwrapCbmEnvelope(JSON.stringify(await session.call(tool, { project, format: 'json', ...args })));
    if (u.isError || u.payload === null) throw new Error(`cbm ${tool}: ${u.text.slice(0, 300)}`);
    return u.payload;
  };
  const graph = async (pattern: string): Promise<CbmDeclaration[]> => {
    const p = await call('search_graph', { name_pattern: pattern, ...CBM_LIMITS.searchGraph });
    if (p.has_more === true || p.truncated === true) notes.push('cbm: search_graph hit its 500-row cap');
    return parseSearchGraph(p);
  };
  const note = () => (notes.length > 0 ? [...new Set(notes)].join('; ') : null);

  if (kase.intent === 'text-search') {
    const p = await call('search_code', { pattern: kase.subject, mode: 'compact', ...CBM_LIMITS.searchCode });
    const iOmitted = Array.isArray(p.cols) ? p.cols.indexOf('matches_omitted') : -1;
    const omitted = iOmitted >= 0 && Array.isArray(p.rows) && p.rows.some((r) => Array.isArray(r) && typeof r[iOmitted] === 'number' && r[iOmitted] > 0);
    if (p.has_more === true || p.raw_has_more === true || p.truncated === true || omitted) notes.push('cbm: search_code answer truncated');
    return { sites: parseSearchCode(p), error: null, note: note() };
  }

  const candidates = narrowToAnchor(kase, (await graph(`^${escapeRe(kase.subject)}$`)).filter((d) => d.name === kase.subject), (d) => d.path);
  if (kase.intent === 'definition' || kase.intent === 'symbol-search') {
    return { sites: candidates.map((d) => site(d.path, d.line1, d.kind)), error: null, note: note() };
  }
  if (kase.intent !== 'callers' && kase.intent !== 'callees' && kase.intent !== 'impact') {
    throw new Error(`declined: codebase-memory has no query for intent '${kase.intent}'`);
  }
  if (candidates.length === 0) return { sites: [], error: null, note: 'cbm: symbol not found' };

  // trace_path names each related function (qn prefix + name) without a line;
  // one search_graph call resolves the names to CBM's own declaration lines.
  const direction = kase.intent === 'callees' ? 'outbound' : 'inbound';
  const depth = kase.intent === 'impact' ? (kase.depth ?? 2) : 1;
  const hits: Array<{ qnPrefix: string; name: string }> = [];
  for (const c of candidates) {
    const t = await call('trace_path', { function_name: cbmQn(c), direction, depth, ...CBM_LIMITS.tracePath });
    if (t.status === 'ambiguous') throw new Error(`cbm trace_path: '${cbmQn(c)}' is ambiguous`);
    const side = direction === 'inbound' ? 'callers' : 'callees';
    if (t[`${side}_total_relation`] !== undefined && t[`${side}_total_relation`] !== 'eq') notes.push(`cbm: trace_path ${side} total is a bound, not exact`);
    if (t.next_cursor || t.has_more === true) notes.push('cbm: trace_path answer paginated');
    hits.push(...parseTrace(t, direction));
  }
  if (hits.length === 0) return { sites: [], error: null, note: note() };
  const want = new Set(hits.map((h) => cbmQn(h)));
  const decls = await graph(cbmNameAlternation(hits.map((h) => h.name)));
  return { sites: decls.filter((d) => want.has(cbmQn(d))).map((d) => site(d.path, d.line1, d.kind)), error: null, note: note() };
}

export interface CbmFairConfig extends EngineArmConfig {
  /** Scratch CBM_CACHE_DIR holding the project database, unique per tree. */
  readonly cacheDir: string;
  /** Daemon RSS sample period in ms (default 500). */
  readonly sampleMs?: number;
}

/**
 * The codebase-memory arm. Indexing is the one-shot `cli index_repository`
 * with the indexing daemon's peak RSS sampled (the CLI client alone reads
 * ~17 MB); queries go to the stdio MCP server over the same cache. `install`
 * is never run: it writes agent hooks and MCP config.
 */
export function createCbmFairArm(cfg: CbmFairConfig, deps: ArmDeps, now?: () => number, sample?: () => Promise<number>): FairArm {
  const exec = deps.exec ?? execTimed;
  const capabilities: ArmCapabilities = { armId: 'codebase-memory', version: cfg.version, intents: CBM_INTENTS, licence: 'permissive' };
  const extraEnv = { CBM_CACHE_DIR: cfg.cacheDir };
  let project = cbmProjectName(cfg.treeRoot);
  let session: Promise<McpSession> | null = null;
  return guardedArm({
    capabilities,
    unavailable: null,
    ...(now ? { now } : {}),
    async index() {
      const env = { ...cfg.env, ...extraEnv, HOME: cfg.home };
      const r = await withDaemonPeak(
        () => exec(cfg.bin, ['cli', '--json', 'index_repository', '--repo-path', cfg.treeRoot], { cwd: cfg.treeRoot, env, timeoutMs: 4 * 3_600_000 }),
        cfg.sampleMs ?? 500,
        sample,
      );
      const { payload, isError } = unwrapCbmEnvelope(r.stdout);
      if (typeof payload?.project === 'string') project = payload.project;
      return phaseOf(r, deps, r.code === 0 && !isError);
    },
    async ask(kase) {
      session ??= openMcpSession(cfg, [], extraEnv);
      return askCbm(await session, kase, project);
    },
    async close() {
      if (session) await (await session).close();
      session = null;
    },
  });
}
