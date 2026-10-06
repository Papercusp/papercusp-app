/** Read the active file-lock lease that marks an in-tree mutation window. */
import { execFile, fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { terminateSpawnTree } from '@papercusp/backup/hook';
import { createHash } from 'node:crypto';
import { env as processEnv, getuid } from 'node:process';
import { promisify } from 'node:util';
import ts from 'typescript';
import { ensureBootstrap, getTxPool, readQueue } from '../locks/su-lock-store';
import { acquireWithContentionRetry } from '../locks/contention-retry';
import type { Closure } from './mutation-probe-closure';

/**
 * Return active mutation-probe paths for one physical checkout. The lock is a
 * checkout-wide marker: which test files it fences is decided by
 * `mutationProbeRefusal` below, not by path overlap with the requested tests.
 */
export async function activeMutationProbePaths(checkoutRoot: string): Promise<string[]> {
  const coordinationDomain = await realpath(checkoutRoot);
  await ensureBootstrap();
  // readQueue has a 1s statement_timeout. Match locks:queue and the file-lock
  // summary: a transient 57014/55P03 must not turn a cheap safety preflight into
  // mutation_probe_state_unknown, but persistent or non-contention failures still
  // fail closed in mutationProbeRefusal below.
  const queue = await acquireWithContentionRetry(() =>
    readQueue(getTxPool(), { coordinationDomain }),
  );
  return queue.active_locks
    .filter((lock) => String(lock.intent ?? '').trim().toLowerCase() === 'mutation probe')
    .map((lock) => lock.path)
    .sort();
}

export type MutationProbeRefusal = {
  error: 'mutation_probe_active' | 'mutation_probe_state_unknown';
  hint: string;
};

export const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const CLOSURE_BUDGET_MS = 20_000;
/**
 * Test-side code that reaches source through the FILESYSTEM or a child process instead of an
 * import. The import closure cannot see those reads, so a match refuses the run. A heuristic
 * that can only over-refuse: a false hit costs a retry, a miss would admit a mutant.
 */
export const OUT_OF_GRAPH_ACCESS =
  /(?<![\w$])(?:readdirSync|readdir|opendirSync|opendir|globSync|glob|fastGlob|spawn|spawnSync|execSync|execFile|execFileSync|execa|fork)\s*\(|(?<![\w$.])exec\s*\(|import\.meta\.glob/;
const TEST_SIDE_FILE = /(^|[\\/])(__tests__|tests?|fixtures?)[\\/]|\.(test|spec)\.|test-?(helpers?|utils?)/i;

/**
 * A closure build owns its compiler service. Its Go heap and protocol buffers
 * must not survive in a long-lived HTTP worker, and a deadline must stop work.
 * Compiler processes have separate esbuild module state, so stopping this service
 * cannot interrupt transforms or another simultaneous closure in the caller.
 */
export async function testImportClosures(root: string, tests: string[],
  options: { workerPath?: string; budgetMs?: number } = {},
): Promise<Closure> {
  let worker: ChildProcess;
  const here = typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url);
  const bundled = join(dirname(here), 'mutation-probe-closure.worker.mjs');
  const workerPath = options.workerPath ?? (existsSync(bundled) ? bundled : join(dirname(here), 'mutation-probe-closure.worker.ts'));
  const budgetMs = options.budgetMs ?? CLOSURE_BUDGET_MS;
  const detached = process.platform !== 'win32';
  try { worker = fork(workerPath, [], { serialization: 'advanced', execArgv: [], silent: true, detached }); }
  catch (error) { return { status: 'incomplete', reason: String(error).slice(0, 200) }; }
  let stderr = '';
  worker.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(0, 1000); });
  worker.stdout?.resume();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exited = new Promise<void>(resolve => {
    worker.once('exit', () => resolve());
    // Failed spawn emits error without exit. A later IPC/kill error on an
    // existing child does not end its lifetime: cleanup must still await exit.
    worker.once('error', () => { if (!worker.pid) resolve(); });
  });
  try {
    return await new Promise<Closure>(resolve => {
      timer = setTimeout(() => resolve({ status: 'incomplete', reason: `closure exceeded ${budgetMs}ms` }), budgetMs);
      worker.once('message', (result: Closure) => {
        if (result?.status === 'incomplete' && typeof result.reason === 'string' ||
          result?.status === 'complete' && result.files instanceof Map && result.unfollowable instanceof Map) resolve(result);
        else resolve({ status: 'incomplete', reason: 'compiler worker returned an invalid closure' });
      });
      worker.once('error', error => resolve({ status: 'incomplete', reason: error.message.slice(0, 200) }));
      worker.once('exit', code => {
        const cause = stderr.split(/\r?\n/).find(line => /^[A-Za-z]*Error(?: \[[^\]]+\])?:/.test(line));
        resolve({ status: 'incomplete', reason: (cause ?? stderr.trim()).slice(0, 200) || `compiler worker exited before returning a closure (${code})` });
      });
      worker.send({ root, tests }, error => { if (error) resolve({ status: 'incomplete', reason: error.message.slice(0, 200) }); });
    });
  } finally {
    clearTimeout(timer);
    // Thread termination alone leaves spawned esbuild children alive (the real
    // deadline guard caught it). Reuse the owned-process-group kill mechanism.
    if (!detached && worker.pid) await new Promise<void>(resolve => {
      execFile('taskkill', ['/PID', String(worker.pid), '/T', '/F'], () => resolve());
    });
    terminateSpawnTree(worker, detached);
    await exited;
    worker.stdout?.destroy(); worker.stderr?.destroy();
  }
}

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

/** True when the probe's verified-restore record still matches the subject's current bytes. */
async function verifiedRestored(admissionDir: string, realRoot: string, subject: string): Promise<boolean> {
  const record = await readFile(join(admissionDir, 'restored', sha256(subject))).catch(() => null);
  if (!record) return false;
  const fields = record.toString('utf8').split('\0');
  if (fields.length !== 4 || fields[3] !== '' || fields[0] !== realRoot || fields[1] !== subject) return false;
  if (!/^[0-9a-f]{64}$/.test(fields[2]!)) return false;
  const current = await readFile(subject).catch(() => null);
  return current !== null && sha256(current) === fields[2];
}

/**
 * EI-24720263797874266: the probed paths that could expose a mutant to an admitted test. A
 * 'mutation probe' file lock outlives the in-tree dirty window: its holder takes it before the
 * probe starts and the probe heartbeats it to 1200s, while the mutant exists only between
 * manifest publication and verified restore. Fencing on the lock alone therefore refused
 * unrelated tests (and every acceptance grade) for up to 20 minutes per probe. A path is
 * COVERED, and never reaches the closure fence, when either:
 *  - the live original-byte manifest names it: every testing:run child enters the admission
 *    overlay, which binds the published original over the mutant; or
 *  - its current bytes still hash to the record the probe wrote after verifying its restore:
 *    the file IS its pre-probe original, and a protocol probe cannot mutate it again while an
 *    admitted test holds the overlay's shared admission lock.
 *  - its working-tree bytes still hash to its committed HEAD blob (WI-10004508; see
 *    `committedUnchanged`): no uncommitted change, and so no in-tree mutant, exists in it.
 * A hand mutation or later edit changes the bytes, so that path stays uncovered and fenced.
 */
async function uncoveredProbePaths(realRoot: string, probePaths: string[]): Promise<string[]> {
  // Share the same configurable admission base as the probe writer and overlay.
  // Tests set a private per-file base so a killed fixture cannot leave manifests
  // in the production /tmp namespace; production remains /tmp by default.
  const admissionBase = processEnv.PAPERCUSP_MUTATION_PROBE_ADMISSION_ROOT || '/tmp';
  const admissionDir = join(admissionBase, `papercusp-mutation-probe-${getuid?.() ?? 0}-${sha256(realRoot)}`);
  const manifest = await readFile(join(admissionDir, 'original.manifest')).catch(() => null);
  let overlaid: string | null = null;
  if (manifest) {
    const fields = manifest.toString('utf8').split('\0');
    if (fields.length === 5 && fields[4] === '' && fields[0] === realRoot) overlaid = fields[1]!;
  }
  const remaining: string[] = [];
  for (const path of probePaths) {
    const subject = resolve(realRoot, path);
    if (subject === overlaid) continue;
    if (await verifiedRestored(admissionDir, realRoot, subject)) continue;
    remaining.push(path);
  }
  // The per-call git timeout cannot bound an execFile that never calls back; this deadline does,
  // and a stalled proof only keeps the closure fence in force.
  const unchanged = await Promise.race([
    committedUnchanged(realRoot, remaining),
    new Promise<Set<string>>((done) => setTimeout(() => done(new Set()), 2 * GIT_TIMEOUT_MS).unref()),
  ]);
  return remaining.filter((path) => !unchanged.has(path));
}

const GIT_TIMEOUT_MS = 5_000;

/**
 * WI-10004508: the locked paths whose working-tree bytes equal their committed HEAD blob.
 *
 * A 'mutation probe' lock is taken BEFORE its probe publishes the original-byte manifest, and
 * mutation-probe.sh admits ONE in-tree probe per checkout (a second one dies on "another
 * mutation probe has an active snapshot" without touching its subject). So a holder that runs
 * probes back to back keeps the next subject locked, unpublished and UNMUTATED while the
 * current probe runs. Copy-out and historical probes taken under the lock never publish a
 * manifest at all. Measured 2026-09-30: remember.ts was locked 22:09:05Z while the manifest
 * named jev-substance.ts (restored 22:12:43Z); remember.ts published and was restored at
 * 22:14:16Z. A testing:run at 22:12Z was refused on remember.ts although nothing had mutated it.
 *
 * Equality with HEAD proves what the fence needs to know: there is no UNCOMMITTED mutant in this
 * path. git-sync excludes actively locked paths from its sweep, so a mutant made under the lock
 * cannot reach HEAD, and any hand mutation or uncommitted edit makes the bytes differ, so the path
 * stays fenced. A protocol probe that starts after this check must first take the admission lock
 * exclusively, which an admitted testing:run child holds shared, and its subject is then overlaid
 * by its published manifest. Two accepted edges, both of which show only COMMITTED code: a hand
 * mutation that exactly reverts an uncommitted edit back to HEAD, and a mutant that a sweep
 * committed before the lock existed (already in history, so every checkout sees it).
 *
 * `git hash-object` applies the same clean filters a commit would. Any git failure (no repository,
 * untracked path, timeout) leaves the path uncovered: the closure fence remains the fallback.
 */
async function committedUnchanged(realRoot: string, paths: string[]): Promise<Set<string>> {
  const unchanged = new Set<string>();
  if (paths.length === 0) return unchanged;
  // An inherited GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE would point `-C realRoot` elsewhere.
  const env = { ...processEnv };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR']) delete env[key];
  const committed = new Map<string, string>();
  let git: (args: string[]) => Promise<string>;
  try {
    // Bound at call time, not module scope: a test that replaces node:child_process must not
    // break this module's import. Without a usable execFile the path simply stays fenced.
    const run = promisify(execFile);
    git = (args) => run('git', ['-C', realRoot, ...args], { env, timeout: GIT_TIMEOUT_MS, maxBuffer: 1 << 20 })
      .then((result) => String(result.stdout));
    for (const entry of (await git(['ls-tree', '-z', 'HEAD', '--', ...paths])).split('\0')) {
      const match = /^\d+ blob ([0-9a-f]{40,64})\t(.+)$/.exec(entry);
      if (match) committed.set(match[2]!, match[1]!);
    }
  } catch {
    return unchanged;
  }
  const tracked = paths.filter((path) => committed.has(path));
  if (tracked.length === 0) return unchanged;
  // ONE fork for the whole set (EI-24852529885337741). Each operator-side fork costs ~160 ms of
  // synchronous main-thread time, and this preflight runs on every testing:run while any probe
  // lock is held: measured 2026-10-02 09:47-09:57Z on :3170 as 386 single-path forks in 10 min.
  // `git hash-object -- <a> <b> ...` prints one blob per path, in argument order, applying each
  // path's own clean filters exactly as N single calls would. It aborts on the first unreadable
  // path, so on any failure (or a short reply) every path is re-proved on its own, which keeps
  // the per-path semantics: one missing file leaves only itself fenced.
  const batch = await git(['hash-object', '--', ...tracked])
    .then((out) => out.split('\n').filter(Boolean))
    .catch(() => null);
  if (batch?.length === tracked.length) {
    tracked.forEach((path, i) => {
      if (batch[i] === committed.get(path)) unchanged.add(path);
    });
    return unchanged;
  }
  await Promise.all(tracked.map(async (path) => {
    const current = await git(['hash-object', '--', path]).catch(() => null);
    if (current?.trim() === committed.get(path)) unchanged.add(path);
  }));
  return unchanged;
}

/** A literal names a complete filename at a path boundary, including its extension. */
function hasPathSegment(value: string, filename: string): boolean {
  if (!filename) return false;
  let from = 0;
  while (from <= value.length - filename.length) {
    const at = value.indexOf(filename, from);
    if (at < 0) return false;
    const before = value[at - 1];
    const after = value[at + filename.length];
    const beginsSegment = at === 0 || before === '/' || before === '\\';
    const endsSegment = after === undefined || after === '/' || after === '\\';
    if (beginsSegment && endsSegment) return true;
    from = at + 1;
  }
  return false;
}

/** Evaluate only literal strings and statically concatenated literal strings. */
function staticStringValue(node: ts.Expression): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return staticStringValue(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticStringValue(node.left);
    const right = staticStringValue(node.right);
    return left === null || right === null ? null : left + right;
  }
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) {
      const expression = staticStringValue(span.expression);
      if (expression === null) return null;
      value += expression + span.literal.text;
    }
    return value;
  }
  return null;
}

/** Return a probed filename named by a literal or static string concatenation, if any. */
function namedPathLiteral(file: string, text: string, filenames: string[]): string | null {
  if (filenames.length === 0) return null;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  let found: string | null = null;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isExpression(node)) {
      const value = staticStringValue(node);
      if (value !== null && (found = filenames.find((name) => hasPathSegment(value, name)) ?? null)) return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * Why one test file may observe a probed source, or null when its closure provably cannot.
 * Shared with the restricted-write fence (restricted-hold-fence.ts), whose held paths are
 * "probes" in exactly this sense.
 */
export async function reachReason(
  closure: Set<string>, test: string, probes: string[], unfollowable: Map<string, string>,
): Promise<string | null> {
  const hit = probes.find((probe) => closure.has(probe));
  if (hit) return `imports ${hit}`;
  for (const [file, why] of unfollowable) {
    if (closure.has(file)) return `${file} ${why}`;
  }
  // Match the full probed filename so generic path segments such as "sessions" do not collide.
  // Static string concatenations still catch paths assembled at runtime ("sessions" + ".ts").
  const filenames = probes.map((probe) => basename(probe));
  for (const file of closure) {
    if (!CODE_EXTENSIONS.has(extname(file))) continue;
    const text = await readFile(file, 'utf8').catch(() => null);
    if (text === null) return `could not read ${file}`;
    const named = namedPathLiteral(file, text, filenames);
    if (named) return `${file} names ${named}`;
    if ((file === test || TEST_SIDE_FILE.test(file)) && OUT_OF_GRAPH_ACCESS.test(text)) {
      return `${file} reads the filesystem or spawns a process`;
    }
  }
  return null;
}

/**
 * The mutation-probe preflight for one checkout, or null when the run may proceed. Called
 * BEFORE anything durable is written for the run (EI-24100872054224181): a refusal that
 * starts no test process must not leave evidence rows behind.
 *
 * An in-tree probe holds its subject mutated for the dirty window. A requested test file is
 * admitted only when its whole static import closure resolves, excludes every probed path,
 * never names one, and does no filesystem walk or spawn from test-side code. Anything the walk
 * cannot establish refuses the run, as does a probed path that is not a code module (only the
 * filesystem reaches it). The lock read is fail-closed: without a current answer this runner
 * cannot claim it avoided a mutant.
 */
export async function mutationProbeRefusal(
  root: string,
  files: string[],
  deps: { probePaths?: typeof activeMutationProbePaths } = {},
): Promise<MutationProbeRefusal | null> {
  if (!existsSync(root)) return null;
  let probePaths: string[];
  let realRoot: string;
  try {
    realRoot = await realpath(root);
    probePaths = await (deps.probePaths ?? activeMutationProbePaths)(root);
  } catch (error) {
    return {
      error: 'mutation_probe_state_unknown',
      hint: `could not verify whether an in-tree mutation probe is active; no test process was started (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  if (probePaths.length === 0) return null;
  // The in-tree probe publishes its immutable original before changing the
  // subject, and records a verified restore after. Every testing:run child
  // enters the admission wrapper, which holds a shared flock through the whole
  // test and binds the published copy over the mutant. A locked path whose bytes
  // still equal its HEAD blob carries no uncommitted mutant at all (WI-10004508).
  // Only a path none of these proves safe (an uncommitted hand mutation or edit)
  // still needs the closure fence below.
  const uncovered = await uncoveredProbePaths(realRoot, probePaths);
  if (uncovered.length === 0) return null;
  const refuse = (why: string): MutationProbeRefusal => ({
    error: 'mutation_probe_active',
    hint: `no test process was started because this checkout has an active mutation probe on ${uncovered.join(', ')} and ${why}; retry after the probe restores its source`,
  });
  const probes = uncovered.map((path) => resolve(realRoot, path));
  const nonModule = uncovered.find((path) => !CODE_EXTENSIONS.has(extname(path)));
  if (nonModule) return refuse(`${nonModule} is not a code module, so only a filesystem read can reach it`);
  const tests: string[] = [];
  for (const file of files) {
    const absolute = resolve(realRoot, file);
    if (!existsSync(absolute)) return refuse(`${file} could not be resolved for an import-closure check`);
    tests.push(await realpath(absolute));
  }
  const closure = await testImportClosures(realRoot, tests);
  if (closure.status === 'incomplete') return refuse(`the import closure could not be established (${closure.reason})`);
  for (const test of tests) {
    const reason = await reachReason(closure.files.get(test)!, test, probes, closure.unfollowable);
    if (reason) return refuse(`${test.startsWith(realRoot + sep) ? test.slice(realRoot.length + 1) : test} may observe it: ${reason}`);
  }
  return null;
}
