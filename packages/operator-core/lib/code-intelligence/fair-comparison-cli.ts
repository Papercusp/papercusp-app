/**
 * P-017 Phase E driver (plan `gitnexus-deterministic-integration-2026-10-05`,
 * D-011..D-016). Run from the repo root:
 *
 *   npx tsx packages/operator-core/lib/code-intelligence/fair-comparison-cli.ts prereg --out <dir> [--reps 3] [--seed 20261006]
 *   npx tsx packages/operator-core/lib/code-intelligence/fair-comparison-cli.ts run --arm <id> --out <dir>
 *   npx tsx packages/operator-core/lib/code-intelligence/fair-comparison-cli.ts score --out <dir>
 *
 * `prereg` freezes corpus, seed keys, arms (version + intents), reps and bars
 * into `<dir>/prereg.json` BEFORE any arm runs; `run` refuses anything that
 * differs. Run ONE arm per process: the in-process arms report the process's
 * peak RSS. Each arm indexes its own hardlinked copy of the frozen snapshot
 * (`<bench>/trees/<arm>`, D-013 rule 4) with its own HOME, and the copy carries
 * what `npm install` gives a real checkout for workspace packages
 * (node_modules/<name> links) plus a single git commit, identical for every arm.
 * `score` pools answers, writes `pending.json` (sites awaiting adjudication) and
 * `report.json`; verdicts go in `verdicts.json` as { caseId: AdjudicationVerdict[] }.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { homedir, loadavg } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';
import type { ArmDeps } from './engine-comparison-arms';
import { preregister, type ArmCapabilities, type Preregistration } from './fair-comparison';
import { admitArm } from './fair-comparison-admission';
import { createRgFairArm, type FairArm } from './fair-comparison-arms';
import { FAIR_CORPUS, FAIR_CORPUS_COMMIT, initialKeys } from './fair-comparison-corpus';
import { createCbmFairArm, createCgcArm, createCodegraphArm, createGitnexusFairArm, createTraceMcpArm } from './fair-comparison-engines';
import { createLspQueryArm, createNoThirdPartyArm, loadVendoredTypescript } from './fair-comparison-first-party';
import { runArm, scoreRuns, type ArmRun } from './fair-comparison-run';

const run = promisify(execFile);
const BENCH = process.env.P017_BENCH ?? join(homedir(), '.papercusp', 'bench', 'fair-comparison-2026-10');
const SNAPSHOT = join(BENCH, `snapshot-${FAIR_CORPUS_COMMIT.slice(0, 12)}`);
const VENDOR_LSP = join(homedir(), '.papercusp', 'vendor', 'lsp');
const deps: ArmDeps = { loadAvg1: () => loadavg()[0] ?? null };

export const FAIR_ARM_IDS = ['rg', 'lsp-query', 'no-third-party', 'gitnexus', 'codebase-memory', 'codegraph', 'trace-mcp', 'codegraphcontext'] as const;
export type FairArmId = (typeof FAIR_ARM_IDS)[number];

/** A file inside the operator-core tsconfig project: the lsp-query warm-up loads that one project. */
export const LSP_WARMUP_ANCHOR = 'packages/operator-core/lib/code-intelligence/contracts.ts';

const treeOf = (id: FairArmId): string => join(BENCH, 'trees', id);
const homeOf = (id: FairArmId): string => join(BENCH, 'homes', id);

/** Construct an arm. Construction starts nothing: engines spawn on index()/query(). */
export async function buildArm(id: FairArmId): Promise<FairArm> {
  const treeRoot = treeOf(id);
  const home = homeOf(id);
  switch (id) {
    case 'rg':
      return createRgFairArm(treeRoot, deps);
    case 'lsp-query': {
      const { createLspAdapterDoor } = await import('./fair-comparison-lsp-door');
      const ts = loadVendoredTypescript(VENDOR_LSP);
      return createLspQueryArm(
        {
          version: `typescript-language-server (vendored) / typescript ${ts.version}`,
          treeRoot,
          warmupAnchor: LSP_WARMUP_ANCHOR,
          loadAvg1: deps.loadAvg1,
        },
        createLspAdapterDoor(),
      );
    }
    case 'no-third-party':
      return createNoThirdPartyArm({ treeRoot, ts: loadVendoredTypescript(VENDOR_LSP), loadAvg1: deps.loadAvg1 });
    case 'gitnexus':
      return createGitnexusFairArm({ version: '1.6.9', bin: join(homedir(), '.papercusp/vendor/gitnexus/node_modules/.bin/gitnexus'), treeRoot, home, env: admitArm('gitnexus').env }, deps);
    case 'codebase-memory':
      return createCbmFairArm(
        {
          version: 'dev',
          bin: join(homedir(), '.papercusp/bench/engine-comparison-2026-10/vendor/cbm/build/bench/codebase-memory-mcp'),
          treeRoot,
          home,
          cacheDir: join(home, 'cache'),
          env: admitArm('codebase-memory').env,
        },
        deps,
      );
    case 'codegraph':
      return createCodegraphArm({ version: '1.6.2', bin: join(BENCH, 'arms/codegraph/node_modules/.bin/codegraph'), treeRoot, home, env: admitArm('codegraph').env }, deps);
    case 'trace-mcp':
      return createTraceMcpArm({ version: '3.34.6', bin: join(BENCH, 'arms/trace-mcp/node_modules/.bin/trace-mcp'), treeRoot, home, env: admitArm('trace-mcp').env }, deps);
    case 'codegraphcontext':
      return createCgcArm({ version: '0.6.13', bin: join(BENCH, 'arms/cgc/.venv/bin/cgc'), treeRoot, home, env: admitArm('codegraphcontext').env }, deps);
  }
}

/** Expand the root package.json `workspaces` (exact dirs and one trailing `/*`) to package dirs. */
export async function workspaceDirs(root: string, patterns: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const p of patterns) {
    if (!p.endsWith('/*')) {
      out.push(p);
      continue;
    }
    const parent = p.slice(0, -2);
    const entries = await readdir(join(root, parent), { withFileTypes: true }).catch(() => []);
    for (const e of entries) if (e.isDirectory()) out.push(`${parent}/${e.name}`);
  }
  return out.filter((d) => existsSync(join(root, d, 'package.json')));
}

/** node_modules/<name> -> workspace dir links, exactly what npm install creates for workspaces. */
async function linkWorkspaces(tree: string): Promise<number> {
  const pkg = JSON.parse(await readFile(join(tree, 'package.json'), 'utf8')) as { workspaces?: string[] };
  let n = 0;
  for (const dir of await workspaceDirs(tree, pkg.workspaces ?? [])) {
    const { name } = JSON.parse(await readFile(join(tree, dir, 'package.json'), 'utf8')) as { name?: string };
    if (!name) continue;
    const link = join(tree, 'node_modules', name);
    if (existsSync(link)) continue;
    await mkdir(dirname(link), { recursive: true });
    await symlink(relative(dirname(link), join(tree, dir)), link);
    n += 1;
  }
  return n;
}

/** The arm's own copy of the frozen snapshot: hardlinks, workspace links, one git commit. */
async function prepareTree(id: FairArmId): Promise<void> {
  const tree = treeOf(id);
  await mkdir(homeOf(id), { recursive: true });
  if (existsSync(join(tree, '.p017-ready'))) return;
  if (!existsSync(SNAPSHOT)) throw new Error(`frozen snapshot missing: ${SNAPSHOT}`);
  await mkdir(dirname(tree), { recursive: true });
  if (!existsSync(tree)) await run('cp', ['-al', SNAPSHOT, tree], { maxBuffer: 1 << 26 });
  const links = await linkWorkspaces(tree);
  const git = (args: string[]) => run('git', ['-c', 'user.name=p017', '-c', 'user.email=p017@local', '-c', 'commit.gpgsign=false', ...args], { cwd: tree, maxBuffer: 1 << 26 });
  if (!existsSync(join(tree, '.git'))) {
    await git(['init', '-q']);
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', `P-017 snapshot ${FAIR_CORPUS_COMMIT}`]);
  }
  await writeFile(join(tree, '.p017-ready'), JSON.stringify({ commit: FAIR_CORPUS_COMMIT, workspaceLinks: links, at: new Date().toISOString() }));
}

const arg = (name: string, fallback?: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : fallback;
  if (v === undefined) throw new Error(`--${name} is required`);
  return v;
};
const readJson = async <T>(p: string): Promise<T> => JSON.parse(await readFile(p, 'utf8')) as T;
const cases = FAIR_CORPUS.map((e) => e.kase);

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const out = arg('out');
  await mkdir(out, { recursive: true });
  if (cmd === 'prereg') {
    if (existsSync(join(out, 'prereg.json'))) throw new Error(`${out}/prereg.json exists: a preregistration is never rewritten`);
    const arms: ArmCapabilities[] = [];
    for (const id of FAIR_ARM_IDS) arms.push((await buildArm(id)).capabilities);
    const prereg = preregister({ cases, keys: initialKeys(FAIR_CORPUS), arms, reps: Number(arg('reps', '3')), seed: Number(arg('seed', '20261006')) });
    await writeFile(join(out, 'prereg.json'), JSON.stringify(prereg, null, 2));
    console.log(`prereg ${prereg.hash} cases=${prereg.corpusIds.length} arms=${arms.length} reps=${prereg.reps}`);
  } else if (cmd === 'run') {
    const id = arg('arm') as FairArmId;
    if (!FAIR_ARM_IDS.includes(id)) throw new Error(`unknown arm ${id}; one of ${FAIR_ARM_IDS.join(', ')}`);
    const prereg = await readJson<Preregistration>(join(out, 'prereg.json'));
    await prepareTree(id);
    const result = await runArm(await buildArm(id), cases, prereg);
    await writeFile(join(out, `${id}.run.json`), JSON.stringify(result, null, 2));
    const answered = result.reps.flatMap((r) => r.answers).filter((a) => a.status === 'answered').length;
    console.log(`${id} index ok=${result.index?.ok} wallMs=${Math.round(result.index?.wallMs ?? 0)} reps=${result.reps.length} answered=${answered}`);
  } else if (cmd === 'score') {
    const prereg = await readJson<Preregistration>(join(out, 'prereg.json'));
    const runs: ArmRun[] = [];
    for (const f of (await readdir(out)).filter((n) => n.endsWith('.run.json')).sort()) runs.push(await readJson<ArmRun>(join(out, f)));
    const verdicts = existsSync(join(out, 'verdicts.json')) ? await readJson<Record<string, never[]>>(join(out, 'verdicts.json')) : {};
    const scored = scoreRuns(runs, cases, initialKeys(FAIR_CORPUS), verdicts, prereg);
    await writeFile(join(out, 'pending.json'), JSON.stringify(scored.pending, null, 2));
    await writeFile(join(out, 'report.json'), JSON.stringify({ prereg: prereg.hash, aggregates: scored.aggregates, decision: scored.decision, keys: scored.keys }, null, 2));
    console.log(`score runs=${runs.length} pendingSites=${scored.pending.reduce((n, p) => n + p.sites.length, 0)} decision=${scored.decision.kind}`);
  } else {
    throw new Error('usage: fair-comparison-cli.ts prereg|run|score --out <dir> [--arm <id>] [--reps N] [--seed N]');
  }
}

if (process.argv[1] && /fair-comparison-cli\.ts$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack : err);
    process.exit(1);
  });
}
