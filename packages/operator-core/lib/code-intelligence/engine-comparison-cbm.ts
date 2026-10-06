/**
 * P-005 — Codebase-Memory (CBM) arm for the engine comparison (`engine-comparison.ts`).
 *
 * Driven ONLY through the one-shot `codebase-memory-mcp cli <tool>` surface under a
 * scratch `HOME` + `CBM_CACHE_DIR`, so the evaluation never touches the serving
 * stack. `install` is NEVER invoked (it writes agent hooks + MCP config, which the
 * plan forbids), and `--persistence` stays at its default (false), so no
 * `.codebase-memory/graph.db.zst` is written into the arm's tree.
 *
 * Disclosed bench mappings (identical rule for every case, none tuned per case):
 *   - `symbol-search` / `definition` → `search_graph --name-pattern '^<name>$'`
 *   - `callers` / `callees`          → `trace_path --direction inbound|outbound`, then ONE
 *     `search_graph` call that resolves the returned names to declaration lines. CBM's
 *     `trace_path` reports (qn_prefix, name, hop) but no file/line, so the second call
 *     is the minimum an agent needs to get a navigable `path:line`; its bytes are counted.
 *   - `text-search`                  → `search_code` (literal pattern)
 *   - every other intent             → declined (recorded as an error, never guessed)
 * Default CBM depth/limit/token budgets are used (no per-case tuning); only
 * `--format json` is forced so the answer is parseable. Response bytes are the MCP
 * text payload an agent would read, not the CLI envelope that duplicates it.
 *
 * Peak RSS: the CLI client is tiny (~17 MB) and the real work happens in a daemon
 * the client spawns, which `/usr/bin/time -v` does NOT see. `withDaemonPeak`
 * therefore samples the daemon's own `VmHWM` while a phase runs (a LOWER BOUND:
 * a daemon that exits between two samples can under-report by its last interval).
 */
import { readFile } from 'node:fs/promises';
import type { CorpusCase } from './acceptance-corpus';
import type { SymbolSite } from './contracts';
import type { EngineArm, EngineQueryResult } from './engine-comparison';
import { dirBytes, execTimed, phaseOf, type ArmDeps, type ExecOptions, type ExecResult } from './engine-comparison-arms';

export interface CbmArmConfig {
  readonly id: string;
  readonly version: string;
  /** Absolute path of the pinned, locally built `codebase-memory-mcp` binary. */
  readonly bin: string;
  readonly treeRoot: string;
  /** Scratch HOME — nothing is written to the real home. */
  readonly home: string;
  /** Scratch `CBM_CACHE_DIR` that holds the project database. */
  readonly cacheDir: string;
  /** Override only if the engine's name normalisation is not the derived one. */
  readonly project?: string;
  readonly timeoutMs?: number;
  /** Daemon RSS sample period in ms (default 500). */
  readonly sampleMs?: number;
}

export type CbmExec = (cmd: string, args: readonly string[], opts: ExecOptions) => Promise<ExecResult>;

/** CBM's project key: the absolute path with the leading slash dropped and `/` → `-`. */
export const cbmProjectName = (treeRoot: string): string => treeRoot.replace(/^\/+/, '').replace(/\//g, '-');

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The MCP text payload an agent reads (`content[0].text`) and its parsed JSON. */
export function unwrapCbmEnvelope(stdout: string): { text: string; payload: Json | null; isError: boolean } {
  let env: unknown;
  try { env = JSON.parse(stdout); } catch { return { text: stdout, payload: null, isError: true }; }
  if (!isObj(env)) return { text: stdout, payload: null, isError: true };
  const content = Array.isArray(env.content) ? env.content : [];
  const first = content.find((c): c is Json => isObj(c) && typeof c.text === 'string');
  const text = first ? String(first.text) : '';
  const isError = env.isError === true;
  if (isObj(env.structuredContent)) return { text, payload: env.structuredContent, isError };
  try {
    const p: unknown = JSON.parse(text);
    return { text, payload: isObj(p) ? p : null, isError };
  } catch { return { text, payload: null, isError: true }; }
}

const colIndex = (cols: unknown, name: string): number =>
  Array.isArray(cols) ? cols.findIndex((c) => c === name) : -1;

const startLine = (lines: unknown): number | null => {
  const m = /^(\d+)/.exec(String(lines ?? ''));
  return m ? Number(m[1]) : null;
};

export interface CbmDeclaration extends SymbolSite {
  readonly qnPrefix: string;
  readonly name: string;
}

/** `search_graph` json → one declaration per row, with its module key for joining. */
export function parseSearchGraph(payload: Json | null): CbmDeclaration[] {
  const out: CbmDeclaration[] = [];
  if (!payload || !Array.isArray(payload.groups)) return out;
  const iName = colIndex(payload.cols, 'name');
  const iLabel = colIndex(payload.cols, 'label');
  const iLines = colIndex(payload.cols, 'lines');
  for (const g of payload.groups) {
    if (!isObj(g) || typeof g.file !== 'string' || !Array.isArray(g.rows)) continue;
    for (const row of g.rows) {
      if (!Array.isArray(row)) continue;
      const line1 = startLine(row[iLines < 0 ? 2 : iLines]);
      const name = String(row[iName < 0 ? 0 : iName] ?? '');
      if (line1 === null || name === '') continue;
      out.push({
        path: g.file, line1, kind: iLabel < 0 ? null : String(row[iLabel] ?? '') || null,
        detail: name, qnPrefix: String(g.qn_prefix ?? ''), name,
      });
    }
  }
  return out;
}

/** `trace_path` json → the distinct (qn_prefix, name) pairs on the requested side. */
export function parseTrace(payload: Json | null, direction: 'inbound' | 'outbound'): Array<{ qnPrefix: string; name: string }> {
  const side = payload?.[direction === 'inbound' ? 'callers' : 'callees'];
  const out: Array<{ qnPrefix: string; name: string }> = [];
  if (!isObj(side) || !Array.isArray(side.groups)) return out;
  const seen = new Set<string>();
  for (const g of side.groups) {
    if (!isObj(g) || !Array.isArray(g.rows)) continue;
    const qnPrefix = String(g.qn_prefix ?? '');
    for (const row of g.rows) {
      const name = Array.isArray(row) ? String(row[0] ?? '') : '';
      const key = `${qnPrefix}\u0000${name}`;
      if (name === '' || seen.has(key)) continue;
      seen.add(key);
      out.push({ qnPrefix, name });
    }
  }
  return out;
}

/** `search_code` json → every matching `path:line` (compact rows + raw line matches). */
export function parseSearchCode(payload: Json | null): SymbolSite[] {
  const sites: SymbolSite[] = [];
  if (!payload) return sites;
  const iFile = colIndex(payload.cols, 'file');
  const iMatches = colIndex(payload.cols, 'matches');
  const iLabel = colIndex(payload.cols, 'label');
  if (Array.isArray(payload.rows)) {
    for (const row of payload.rows) {
      if (!Array.isArray(row) || iFile < 0 || iMatches < 0) continue;
      const file = String(row[iFile] ?? '');
      const matches = Array.isArray(row[iMatches]) ? (row[iMatches] as unknown[]) : [];
      for (const m of matches) {
        if (typeof m === 'number') sites.push({ path: file, line1: m, kind: iLabel < 0 ? null : String(row[iLabel] ?? '') || null, detail: null });
      }
    }
  }
  const raw = isObj(payload.raw_matches) ? payload.raw_matches : null;
  if (raw && Array.isArray(raw.rows)) {
    const rFile = colIndex(raw.cols, 'file');
    const rLine = colIndex(raw.cols, 'line');
    for (const row of raw.rows) {
      if (Array.isArray(row) && rFile >= 0 && rLine >= 0 && typeof row[rLine] === 'number') {
        sites.push({ path: String(row[rFile]), line1: row[rLine] as number, kind: null, detail: null });
      }
    }
  }
  const seen = new Set<string>();
  return sites.filter((s) => (seen.has(`${s.path}:${s.line1}`) ? false : (seen.add(`${s.path}:${s.line1}`), true)));
}

async function daemonRssKb(): Promise<number> {
  let total = 0;
  const pids = await (async () => {
    const r = await execTimed('pgrep', ['-x', 'codebase-memory'], { cwd: '/' });
    return r.stdout.split('\n').map((s) => s.trim()).filter((s) => /^\d+$/.test(s));
  })();
  for (const pid of pids) {
    try {
      const m = /VmHWM:\s*(\d+)\s*kB/.exec(await readFile(`/proc/${pid}/status`, 'utf8'));
      if (m) total += Number(m[1]);
    } catch { /* process exited between pgrep and the read */ }
  }
  return total;
}

/** Run `fn` while sampling the CBM daemon's peak RSS; fold the larger of the two into `peakRssKb`. */
export async function withDaemonPeak(fn: () => Promise<ExecResult>, sampleMs: number, sample: () => Promise<number> = daemonRssKb): Promise<ExecResult> {
  let stop = false;
  let peak = 0;
  const loop = (async () => {
    while (!stop) {
      try { peak = Math.max(peak, await sample()); } catch { /* sampling is best-effort; a null stays "not measured" */ }
      await new Promise((r) => setTimeout(r, sampleMs));
    }
  })();
  const r = await fn();
  stop = true;
  await loop;
  const best = Math.max(r.peakRssKb ?? 0, peak);
  return { ...r, peakRssKb: best > 0 ? best : null };
}

export function createCodebaseMemoryArm(cfg: CbmArmConfig, deps: ArmDeps, exec: CbmExec = execTimed, sample?: () => Promise<number>): EngineArm {
  let project = cfg.project ?? cbmProjectName(cfg.treeRoot);
  const env = { HOME: cfg.home, CBM_CACHE_DIR: cfg.cacheDir };
  const call = (tool: string, args: readonly string[]) =>
    exec(cfg.bin, ['cli', '--json', tool, ...args], { cwd: cfg.treeRoot, env, timeoutMs: cfg.timeoutMs ?? 600_000 });
  const reindex = async () => {
    const r = await withDaemonPeak(() => call('index_repository', ['--repo-path', cfg.treeRoot]), cfg.sampleMs ?? 500, sample);
    const { payload, isError } = unwrapCbmEnvelope(r.stdout);
    if (typeof payload?.project === 'string') project = payload.project;
    return phaseOf(r, deps, r.code === 0 && !isError);
  };

  const graphSearch = async (pattern: string, bytes: { n: number }): Promise<{ decls: CbmDeclaration[]; error: string | null }> => {
    const r = await call('search_graph', ['--project', project, '--name-pattern', pattern, '--limit', '500', '--format', 'json']);
    if (r.code !== 0) return { decls: [], error: `search_graph exit ${r.code}: ${r.stderr.trim().slice(-200)}` };
    const u = unwrapCbmEnvelope(r.stdout);
    bytes.n += Buffer.byteLength(u.text);
    return u.payload === null || u.isError ? { decls: [], error: `search_graph unparseable: ${u.text.slice(0, 160)}` } : { decls: parseSearchGraph(u.payload), error: null };
  };

  return {
    id: cfg.id,
    version: cfg.version,
    treeRoot: cfg.treeRoot,
    unavailable: null,
    index: reindex,
    // The tool's own update path is the same `index_repository` call; its cost is what is measured.
    refresh: reindex,
    async query(kase: CorpusCase): Promise<EngineQueryResult> {
      const bytes = { n: 0 };
      const done = (sites: readonly SymbolSite[], error: string | null = null): EngineQueryResult => ({ sites, responseBytes: bytes.n, error });
      try {
        if (kase.intent === 'symbol-search' || kase.intent === 'definition') {
          const { decls, error } = await graphSearch(`^${escapeRe(kase.query)}$`, bytes);
          return done(decls, error);
        }
        if (kase.intent === 'callers' || kase.intent === 'callees') {
          const direction = kase.intent === 'callers' ? 'inbound' : 'outbound';
          const r = await call('trace_path', ['--project', project, '--function-name', kase.query, '--direction', direction, '--format', 'json']);
          if (r.code !== 0) return done([], `trace_path exit ${r.code}: ${r.stderr.trim().slice(-200)}`);
          const u = unwrapCbmEnvelope(r.stdout);
          bytes.n += Buffer.byteLength(u.text);
          if (u.payload === null || u.isError) return done([], `trace_path unparseable: ${u.text.slice(0, 160)}`);
          const hits = parseTrace(u.payload, direction);
          if (hits.length === 0) return done([]);
          const names = [...new Set(hits.map((h) => h.name))];
          // A plain group: CBM's regex engine has no `(?:…)` and silently matches nothing for it
          // (measured 2026-10-06, P-017 D-015) — which emptied every callers/callees answer here.
          const { decls, error } = await graphSearch(`^(${names.map(escapeRe).join('|')})$`, bytes);
          const want = new Set(hits.map((h) => `${h.qnPrefix}\u0000${h.name}`));
          return done(decls.filter((d) => want.has(`${d.qnPrefix}\u0000${d.name}`)), error);
        }
        if (kase.intent === 'text-search') {
          const r = await call('search_code', ['--project', project, '--pattern', kase.query, '--mode', 'compact', '--format', 'json']);
          if (r.code !== 0) return done([], `search_code exit ${r.code}: ${r.stderr.trim().slice(-200)}`);
          const u = unwrapCbmEnvelope(r.stdout);
          bytes.n += Buffer.byteLength(u.text);
          return u.payload === null || u.isError ? done([], `search_code unparseable: ${u.text.slice(0, 160)}`) : done(parseSearchCode(u.payload));
        }
        return done([], `declined: codebase-memory bench mapping does not route intent '${kase.intent}'`);
      } catch (e) {
        return done([], e instanceof Error ? e.message : String(e));
      }
    },
    // The project DB + WAL live in the scratch cache dir (logs are a few KB).
    indexBytes: async () => dirBytes(cfg.cacheDir, cfg.treeRoot),
  };
}
