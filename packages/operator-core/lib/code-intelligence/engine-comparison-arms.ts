/**
 * P-005 — subprocess adapters for the engine comparison (see `engine-comparison.ts`).
 *
 * Every arm is driven through its ONE-SHOT CLI so the four arms see the same
 * invocation shape, each against its OWN copy of the bounded tree and (for the
 * graph engines) its OWN scratch `HOME`, so no arm touches the serving
 * `~/.gitnexus` registry, the serving `.gitnexus` index, or any editor config.
 * `codebase-memory-mcp install` is NEVER invoked: that command writes agent
 * hooks and MCP config, which the plan forbids for this evaluation.
 *
 * Latency caveat recorded with the evidence: a one-shot CLI pays process start
 * + DB open on EVERY query, whereas the served path keeps a long-lived MCP
 * process. Warm numbers are therefore comparable ACROSS arms (same shape) but
 * overstate absolute served latency for the graph engines.
 */
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  analyzeEnv,
  GITNEXUS_ANALYZE_STACK_KB,
  GITNEXUS_ANALYZE_TIMEOUT_MS,
} from '../harness/routines/gitnexus-reindex-action';
import { classifyAnalyzeFailure, describeAnalyzeFailure } from './gitnexus-analyze-failure';
import type { CorpusCase } from './acceptance-corpus';
import type { EngineArm, EngineQueryResult, PhaseCost } from './engine-comparison';
import type { SymbolSite } from './contracts';

export interface ExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly wallMs: number;
  readonly peakRssKb: number | null;
}

export interface ExecOptions {
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

/** Runs `cmd` under `/usr/bin/time -v` so peak RSS is MEASURED, not inferred. */
export async function execTimed(cmd: string, args: readonly string[], opts: ExecOptions): Promise<ExecResult> {
  const dir = await mkdtemp(join(tmpdir(), 'engine-cmp-time-'));
  const timeFile = join(dir, 'time.txt');
  const t0 = performance.now();
  try {
    return await new Promise<ExecResult>((resolve) => {
      // GNU `timeout` (NOT execFile's own `timeout`) enforces the deadline: it runs the command in
      // its own process group and, on expiry, signals the WHOLE group (then SIGKILLs after -k), so a
      // wrapped analyzer/indexer cannot survive as an orphan. execFile's timeout kills only its direct
      // child (`/usr/bin/time`) — measured on this bench: an `analyze --force` grandchild outlived its
      // 30-min deadline, kept writing into the arm tree, and contaminated the next phase. The execFile
      // timeout stays only as a longer backstop for `timeout` itself. Exit 124 = deadline (137 = needed KILL).
      const deadlineMs = opts.timeoutMs ?? 900_000;
      execFile(
        '/usr/bin/timeout', ['-k', '30', String(deadlineMs / 1000), '/usr/bin/time', '-v', '-o', timeFile, cmd, ...args],
        { cwd: opts.cwd, env: { ...process.env, ...opts.env }, timeout: deadlineMs + 120_000, maxBuffer: 256 * 1024 * 1024 },
        async (err, stdout, stderr) => {
          const wallMs = performance.now() - t0;
          let peakRssKb: number | null = null;
          try {
            const m = /Maximum resident set size \(kbytes\):\s*(\d+)/.exec(await readFile(timeFile, 'utf8'));
            peakRssKb = m ? Number(m[1]) : null;
          } catch { /* time file absent: leave null — a null is "not measured", not zero */ }
          const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? ((err as unknown as { code: number }).code) : 1) : 0;
          resolve({ code, stdout: String(stdout), stderr: String(stderr), wallMs, peakRssKb });
        },
      );
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface ArmDeps {
  loadAvg1(): number | null;
  /** Process runner; defaults to `execTimed`. Injected by tests so no real engine is spawned. */
  exec?: typeof execTimed;
}

const phaseOf = (r: ExecResult, deps: ArmDeps, okOverride?: boolean): PhaseCost => ({
  wallMs: r.wallMs,
  peakRssKb: r.peakRssKb,
  ok: okOverride ?? r.code === 0,
  error: (okOverride ?? r.code === 0) ? null : `exit ${r.code}${r.code === 124 || r.code === 137 ? ' (deadline: process group killed)' : ''}: ${r.stderr.trim().slice(-300)}`,
  loadAvg1: deps.loadAvg1(),
});

/**
 * `phaseOf` for a `gitnexus analyze` phase (WI-10005680): a failed run's error leads with the NAMED
 * failure (which knob, which residue) instead of a bare `exit 139: <300-char tail>` — the vendor
 * line that names GITNEXUS_LBUG_MAX_DB_SIZE can sit outside that tail. The raw tail is kept after it.
 */
const analyzePhaseOf = (r: ExecResult, deps: ArmDeps): PhaseCost => {
  const phase = phaseOf(r, deps);
  const failure = phase.ok ? null : classifyAnalyzeFailure(r);
  return failure ? { ...phase, error: `${describeAnalyzeFailure(failure)} | ${phase.error}` } : phase;
};

const posix = (p: string): string => p.split('\\').join('/').replace(/^\.\//, '');

async function dirBytes(root: string, cwd: string): Promise<number | null> {
  const r = await execTimed('du', ['-sb', root], { cwd });
  const n = Number(r.stdout.split(/\s+/)[0]);
  return r.code === 0 && Number.isFinite(n) ? n : null;
}

// ── baseline: scripted rg ───────────────────────────────────────────────────

const RG_GLOBS = ['-g', '*.ts', '-g', '*.tsx', '-g', '*.mts'] as const;
const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'await', 'typeof', 'new', 'super', 'import',
  'require', 'Promise', 'Array', 'Object', 'String', 'Number', 'Boolean', 'Map', 'Set', 'Error', 'JSON', 'Math',
  'Date', 'async', 'void', 'delete', 'throw', 'of', 'in', 'as', 'satisfies',
]);
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function parseRgLines(stdout: string, treeRoot: string): SymbolSite[] {
  const sites: SymbolSite[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^(.+?):(\d+):(.*)$/.exec(line);
    if (!m) continue;
    const path = posix(m[1]!.startsWith(treeRoot) ? m[1]!.slice(treeRoot.length + 1) : m[1]!);
    sites.push({ path, line1: Number(m[2]), kind: null, detail: m[3]!.trim().slice(0, 120) });
  }
  return sites;
}

/** Baseline arm: a scripted `rg` pass — what an agent without a graph does. No index. */
export function createRgBaselineArm(treeRoot: string, deps: ArmDeps, rgBin = process.env.PAPERCUSP_RG_BIN ?? 'rg'): EngineArm {
  const rg = (args: readonly string[]) => execTimed(rgBin, args, { cwd: treeRoot, timeoutMs: 120_000 });
  const defsFor = async (ids: readonly string[]): Promise<ExecResult> => {
    const alt = ids.map(escapeRe).join('|');
    return rg(['-n', '--no-heading', '-e', `^\\s*(export\\s+)?(default\\s+)?(async\\s+)?function\\s+(${alt})\\b`, '-e', `^\\s*(export\\s+)?(const|class)\\s+(${alt})\\b`, ...RG_GLOBS, '-g', '!*.test.ts', '.']);
  };
  return {
    id: 'baseline-lsp-rg', version: `rg ${rgBin}`, treeRoot, unavailable: null,
    async index() { return { wallMs: 0, peakRssKb: 0, ok: true, error: null, loadAvg1: deps.loadAvg1() }; },
    async refresh() {
      // rg has no index; the freshness scan is a full file walk, which is also
      // where an unreadable directory surfaces (rg exits 2 on permission errors).
      return phaseOf(await rg(['--files', ...RG_GLOBS, '.']), deps);
    },
    async indexBytes() { return 0; },
    async query(kase: CorpusCase): Promise<EngineQueryResult> {
      const q = escapeRe(kase.query);
      let res: ExecResult;
      let sites: SymbolSite[] = [];
      if (kase.intent === 'text-search') {
        res = await rg(['-n', '--no-heading', '-F', kase.query, ...RG_GLOBS, '.']);
        sites = parseRgLines(res.stdout, treeRoot);
      } else if (kase.intent === 'symbol-search') {
        res = await defsFor([kase.query]);
        sites = parseRgLines(res.stdout, treeRoot);
      } else if (kase.intent === 'callers') {
        res = await rg(['-n', '--no-heading', '-e', `\\b${q}\\s*[(<]`, ...RG_GLOBS, '.']);
        sites = parseRgLines(res.stdout, treeRoot).filter((s) => !/\bfunction\s/.test(s.detail ?? ''));
      } else {
        const defs = parseRgLines((await defsFor([kase.query])).stdout, treeRoot);
        const target = defs[0];
        if (!target) return { sites: [], responseBytes: 0, error: null };
        const lines = (await readFile(join(treeRoot, target.path), 'utf8')).split('\n');
        const start = (target.line1 ?? 1) - 1;
        let end = lines.findIndex((l, i) => i > start && l.startsWith('}'));
        if (end < 0) end = lines.length - 1;
        const ids = new Set<string>();
        for (const m of lines.slice(start, end + 1).join('\n').matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
          const id = m[1]!;
          if (id !== kase.query && !KEYWORDS.has(id)) ids.add(id);
          if (ids.size >= 60) break;
        }
        res = ids.size === 0 ? { code: 0, stdout: '', stderr: '', wallMs: 0, peakRssKb: null } : await defsFor([...ids]);
        sites = parseRgLines(res.stdout, treeRoot);
      }
      // rg exits 1 for "no match" — an empty answer, not a failure; 2 is a real error.
      const error = res.code === 2 ? `rg exit 2: ${res.stderr.trim().slice(-200)}` : null;
      return { sites, responseBytes: Buffer.byteLength(res.stdout), error };
    },
  };
}

// ── GitNexus (installed + pinned candidate): one-shot CLI → the REAL facade ──

export interface GitnexusArmConfig {
  readonly id: string;
  readonly version: string;
  /** Absolute path of the `gitnexus` bin for THIS arm's version. */
  readonly bin: string;
  readonly treeRoot: string;
  /** Scratch HOME so the serving `~/.gitnexus` registry is never touched. */
  readonly home: string;
  readonly timeoutMs?: number;
  /**
   * Line base of THIS version's raw `startLine` (default 0 = what the production facade assumes
   * via `LINE_INDEX_BASE.gitnexus`). MEASURED, not assumed: for `getLongLivedAdminPool`, declared
   * on 1-based line 145 of long-lived-admin-pool.ts, `gitnexus context` reports startLine 144 on
   * 1.6.9 (0-based) and 145 on 1.6.12 (1-based). The facade adds 1 unconditionally, so a 1-based
   * version comes back one line late for EVERY site and an exact path:line grader scores it 0 by
   * construction. `1` undoes that +1 here, so the bench grades the engine, not the facade's
   * version assumption (the production facade is a separate, tracked finding).
   */
  readonly startLineBase?: 0 | 1;
}

export interface GitnexusAnalyzeInvocation {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/**
 * How the bench spawns `gitnexus analyze`: EXACTLY the way production's `system:gitnexus-reindex` does
 * (`analyzeEnv` pins + `node --stack-size=<kb> <cli> …`), not the vendor's bare defaults.
 *
 * WHY (WI-10005581): the bench used to spawn the `.bin` shim with only `HOME` set, so the installed
 * 1.6.9 analyzer ran on the vendor defaults — a 16 GiB LadybugDB max_db_size, a 2 GiB buffer pool and
 * gitnexus's manual WAL checkpoint (the Windows rename-race driver production switches OFF on Linux).
 * An incremental refresh after the edit fixture then died inside that manual checkpoint with
 * "Buffer manager exception: Maximum database size of 17179869184 bytes has been reached" followed by
 * SIGSEGV (exit 139) instead of a clean error, leaving a 0-byte `lbug.shadow` behind. Measuring the
 * engine under an environment production never runs graded a configuration, not the engine.
 *
 * `analyzeEnv` pins NODE_OPTIONS (heap + semi-space), which makes gitnexus SKIP its own re-exec, and
 * `--stack-size` is not legal in NODE_OPTIONS — so it travels as argv to the resolved CLI entry
 * (`realpathSync` of the `.bin` symlink; works for the installed 1.6.9 and the pinned 1.6.12 candidate).
 * An ambient operator-set pin still wins inside `analyzeEnv`.
 */
export function gitnexusAnalyzeInvocation(
  cfg: Pick<GitnexusArmConfig, 'bin' | 'home'>,
  args: readonly string[],
  base: NodeJS.ProcessEnv = process.env,
): GitnexusAnalyzeInvocation {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(analyzeEnv(base))) if (typeof v === 'string') env[k] = v;
  env.HOME = cfg.home;
  return { cmd: process.execPath, args: [`--stack-size=${GITNEXUS_ANALYZE_STACK_KB}`, realpathSync(cfg.bin), ...args], env };
}

/**
 * `GitnexusDispatch` over the one-shot CLI. The facade parses the envelope, so
 * the CLI arms reuse the PRODUCTION parser instead of growing a second one.
 * `list_repos` is deliberately unsupported (the CLI `list` is human text): the
 * facade then reports index health as UNKNOWN, which the answer records.
 */
export function createGitnexusCliDispatch(cfg: GitnexusArmConfig): (tool: string, args: Record<string, unknown>) => Promise<unknown> {
  return async (tool, args) => {
    const argv: string[] = [];
    if (tool === 'context') {
      if (typeof args.uid === 'string') argv.push('context', '-u', args.uid);
      else argv.push('context', String(args.name ?? ''));
      if (typeof args.file_path === 'string') argv.push('-f', args.file_path);
    } else if (tool === 'impact') {
      argv.push('impact', String(args.target ?? args.name ?? ''));
      if (typeof args.direction === 'string') argv.push('-d', args.direction);
    } else {
      throw new Error(`bench gitnexus CLI dispatch does not support tool '${tool}'`);
    }
    const r = await execTimed(cfg.bin, argv, { cwd: cfg.treeRoot, env: { HOME: cfg.home }, timeoutMs: cfg.timeoutMs ?? 120_000 });
    if (r.code !== 0) throw new Error(`gitnexus ${argv[0]} exit ${r.code}: ${r.stderr.trim().slice(-200)}`);
    return r.stdout;
  };
}

/**
 * The facade normalizes a GitNexus `startLine` with `toOneIndexed('gitnexus', …)`, i.e. +1. For a
 * version whose raw line is already 1-based (`startLineBase: 1`) that is one line late, so undo it;
 * a `null` line (file-level edge) stays `null`. Base 0 (the facade's own assumption) is identity.
 */
export function correctStartLineBase(sites: readonly SymbolSite[], base: 0 | 1 | undefined): readonly SymbolSite[] {
  if (base !== 1) return sites;
  return sites.map((s) => (s.line1 === null || s.line1 === undefined ? s : { ...s, line1: s.line1 - 1 }));
}

export function createGitnexusArm(
  cfg: GitnexusArmConfig,
  deps: ArmDeps,
  facade: (op: string, args: Record<string, unknown>, dispatch: (t: string, a: Record<string, unknown>) => Promise<unknown>) => Promise<{ sites: readonly SymbolSite[]; error?: string | null }>,
  opForIntent: (intent: string) => string | null,
): EngineArm {
  const dispatch = createGitnexusCliDispatch(cfg);
  const exec = deps.exec ?? execTimed;
  // `analyze` (cold index AND incremental refresh) is the ONLY write path, so it alone runs under the
  // production analyze environment. Query commands keep the plain one-shot invocation.
  const run = (args: readonly string[]) => {
    const inv = gitnexusAnalyzeInvocation(cfg, args);
    return exec(inv.cmd, inv.args, { cwd: cfg.treeRoot, env: inv.env, timeoutMs: cfg.timeoutMs ?? GITNEXUS_ANALYZE_TIMEOUT_MS });
  };
  return {
    id: cfg.id,
    version: cfg.version,
    treeRoot: cfg.treeRoot,
    unavailable: null,
    // `--skip-agents-md`: never let the analyzer write AGENTS.md/CLAUDE.md/hooks.
    index: async () => analyzePhaseOf(await run(['analyze', '--skip-agents-md', '--force', '.']), deps),
    // The tool's own update path: a plain re-analyze (no --force) of the working tree.
    refresh: async () => analyzePhaseOf(await run(['analyze', '--skip-agents-md', '.']), deps),
    async query(kase: CorpusCase): Promise<EngineQueryResult> {
      // Disclosed bench mapping: exact-name `symbol-search` is the engine's native `context`
      // lookup, so route it as the facade's `symbol` op (the production facade only routes
      // `definition`). `text-search` has no GitNexus equivalent (`query` is concept search) → declined.
      const op = kase.intent === 'symbol-search' ? 'symbol' : opForIntent(kase.intent);
      if (op === null) {
        return { sites: [], responseBytes: 0, error: `declined: gitnexus facade does not route intent '${kase.intent}'` };
      }
      let bytes = 0;
      const counting = async (t: string, a: Record<string, unknown>): Promise<unknown> => {
        let out = await dispatch(t, a);
        bytes += Buffer.byteLength(typeof out === 'string' ? out : JSON.stringify(out));
        // An agent reads the candidate list and picks one: retry ONCE with the first non-test
        // candidate's uid. Identical rule for every GitNexus arm; both calls' bytes are counted.
        if (t === 'context' && typeof out === 'string' && typeof a.uid !== 'string') {
          try {
            const j = JSON.parse(out) as { status?: string; candidates?: Array<{ uid: string; filePath: string }> };
            if (j.status === 'ambiguous' && j.candidates?.length) {
              const pick = j.candidates.find((c) => !/\.(test|spec)\.|\/__tests__\//.test(c.filePath)) ?? j.candidates[0]!;
              out = await dispatch(t, { ...a, uid: pick.uid });
              bytes += Buffer.byteLength(typeof out === 'string' ? out : JSON.stringify(out));
            }
          } catch { /* not JSON: leave the raw answer for the facade to classify */ }
        }
        return out;
      };
      const ans = await facade(op, { name: kase.query }, counting);
      return { sites: correctStartLineBase(ans.sites, cfg.startLineBase), responseBytes: bytes, error: ans.error ?? null };
    },
    indexBytes: async () => dirBytes(join(cfg.treeRoot, '.gitnexus'), cfg.treeRoot),
  };
}

export { analyzePhaseOf, dirBytes, phaseOf, stat };
