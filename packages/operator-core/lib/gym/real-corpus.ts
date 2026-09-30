/**
 * THE REAL GYM CORPUS — test-anchored tasks extracted from genuinely shipped fixes
 * (plan gym-real-fitness-signal-2026-07-27, P-001; design ruling D-003).
 *
 * WHAT THIS REPLACES. Until now the gym's entire fitness function was three toy tasks
 * ("add /health", "expose /version", "add /ready") against a substrate the gym generated
 * itself: `index.js` = `export function handle(req){ return { status: 404 }; }`, sole
 * build gate `node --check`. A champion crowned there proved only that it can edit a toy
 * file. Six release scorecards certified that as learning health.
 *
 * WHAT A REAL TASK IS (D-003). Three artifacts taken from a real shipped fix and nothing
 * else:
 *   1. SPEC    — the real requirement, as a task statement;
 *   2. ORACLE  — the REAL test file that shipped with the fix, verbatim;
 *   3. SUBSTRATE — the implementation reduced to a STUB, plus only what the test needs
 *                  to run (vitest; nothing heavier).
 * The agent must make the real tests pass. Fitness is the OBSERVED test result, never a
 * judge's composite (D-002).
 *
 * WHAT IT DELIBERATELY DOES NOT MEASURE — do not let a green bar say more than it earns:
 * these tasks measure implementing a well-specified unit against a precise oracle. They
 * do NOT measure locating a problem in a large codebase, integration behaviour, or
 * anything needing the full monorepo build. A stronger claim needs a different corpus and
 * its own bar.
 *
 * HOW TO ADD A TASK. Pick a shipped fix whose tests are dependency-free, copy the test
 * file VERBATIM into `oracleTest`, stub the implementation's exported signatures into
 * `stubFile`, write `spec`/`intent` from the real rationale, and cite the work-item or
 * commit in `sourceRef`. Verbatim matters: a paraphrased test is no longer the oracle a
 * human actually trusted, and the moment it drifts the task stops being real.
 */
import type { GymTaskPool } from './task-generator';

export interface RealGymTask {
  taskId: string;
  pool: GymTaskPool;
  /** The real requirement, phrased as the task the agent is given. */
  spec: string;
  /** Why it was needed — the real rationale, for the agent's context. */
  intent: string;
  /** Work-item / plan / commit this was extracted from. Auditable provenance. */
  sourceRef: string;
  /** Path of the file the agent must implement (relative to the substrate root). */
  implPath: string;
  /** The implementation reduced to signatures that throw — the agent's starting point. */
  stubFile: string;
  /** Path of the real test file (relative to the substrate root). */
  testPath: string;
  /** The REAL test file, verbatim. This is the oracle; do not paraphrase it. */
  oracleTest: string;
}

/**
 * Task 1 — the sliding-window retry log from the desktop chunk-crash fix.
 *
 * Real failure it came from: a long-open desktop window whose lazy chunk 404'd after a
 * rebuild sat on a fatal error card. A lifetime retry counter left tabs permanently
 * manual after an outage, so the fix made it a sliding window. Subtleties a real
 * implementation must get right and a toy task would never exercise: tolerate garbage
 * and a LEGACY SCALAR format in storage, and treat entries exactly on the window
 * boundary correctly.
 */
const RETRY_LOG_TASK: RealGymTask = {
  taskId: 'real-retry-log-window',
  pool: 'train',
  sourceRef: 'papercusp 2026-07-26 desktop chunk-crash fix (RouteErrorBoundary sliding-window retry cap)',
  spec:
    'Implement `pruneRetryLog(raw, nowMs)` in retry-log.ts. It parses a JSON array of epoch-ms timestamps out of `raw` ' +
    'and returns only those still inside a 30-minute sliding window ending at `nowMs`. It must never throw: unparsable ' +
    'input, a non-array, a bare legacy scalar, and non-numeric members all yield an empty list or are skipped. Export ' +
    'the window length as `WINDOW_MS`.',
  intent:
    'A crash-recovery path capped its automatic retries with a lifetime counter, so a tab that exhausted its retries ' +
    'during an outage stayed permanently manual. A sliding window lets it heal once the window drains — but only if ' +
    'malformed and legacy stored values degrade quietly instead of throwing inside the recovery path.',
  implPath: 'retry-log.js',
  stubFile: `/** Sliding window length in ms. */
export const WINDOW_MS = 30 * 60_000;

/**
 * Parse + prune a stored retry log to the timestamps still inside the sliding window.
 * @param {string|null} raw JSON array of epoch-ms numbers, or garbage.
 * @param {number} nowMs
 * @returns {number[]}
 */
export function pruneRetryLog(raw, nowMs) {
  throw new Error('not implemented');
}
`,
  testPath: 'retry-log.test.js',
  oracleTest: `import { describe, expect, it } from 'vitest';
import { WINDOW_MS, pruneRetryLog } from './retry-log.js';

describe('pruneRetryLog', () => {
  it('drops timestamps outside the sliding window so an exhausted caller heals', () => {
    const now = 10_000_000;
    const stale = now - WINDOW_MS - 1;
    const fresh = now - 1_000;
    expect(pruneRetryLog(JSON.stringify([stale, fresh]), now)).toEqual([fresh]);
  });

  it('tolerates garbage and legacy scalar values', () => {
    expect(pruneRetryLog('not json', 1_000)).toEqual([]);
    expect(pruneRetryLog('5', 1_000)).toEqual([]);
    expect(pruneRetryLog(null, 1_000)).toEqual([]);
    expect(pruneRetryLog(JSON.stringify(['x', 500]), 1_000)).toEqual([500]);
  });

  it('keeps an entry strictly inside the window and drops one exactly on the boundary', () => {
    const now = 1_000_000;
    expect(pruneRetryLog(JSON.stringify([now - WINDOW_MS]), now)).toEqual([]);
    expect(pruneRetryLog(JSON.stringify([now - WINDOW_MS + 1]), now)).toEqual([now - WINDOW_MS + 1]);
  });
});
`,
};

/**
 * Task 2 — the age-based prune policy from the dist chunk-retention work.
 *
 * Real failure it came from: rebuilds deleted hashed chunks an open webview still needed,
 * so retention was introduced and growth had to be bounded by age instead. The subtlety a
 * real implementation must respect: a file exactly ON the TTL boundary is KEPT — the
 * conservative choice, because over-pruning a chunk a live page still needs is the very
 * failure retention existed to prevent.
 */
const PRUNE_POLICY_TASK: RealGymTask = {
  taskId: 'real-stale-chunk-prune',
  pool: 'dev-anchor',
  sourceRef: 'papercusp dev-dist-prune (adv-build-churn-retain-chunks-2026-06-03; dist-chunk-retention-default-2026-07-26)',
  spec:
    'Implement `selectStaleChunks(files, nowMs, ttlMs)` in prune.js. Given files as `{name, mtimeMs}`, return the names ' +
    'of those last modified STRICTLY MORE than `ttlMs` before `nowMs`. A file exactly on the boundary must be KEPT. ' +
    'The function must be pure: no disk access, no clock read.',
  intent:
    'A build system retains old hashed asset chunks so an already-open page never 404s a lazy import it is pinned to, ' +
    'and bounds the resulting growth by deleting only chunks untouched beyond a TTL. Over-pruning re-creates the exact ' +
    'breakage retention was introduced to stop, so the boundary case must be conservative.',
  implPath: 'prune.js',
  stubFile: `/**
 * Names of files last modified strictly MORE than ttlMs before nowMs.
 * Pure: no disk access, no clock read. A file exactly on the boundary is KEPT.
 * @param {{name: string, mtimeMs: number}[]} files
 * @param {number} nowMs
 * @param {number} ttlMs
 * @returns {string[]}
 */
export function selectStaleChunks(files, nowMs, ttlMs) {
  throw new Error('not implemented');
}
`,
  testPath: 'prune.test.js',
  oracleTest: `import { describe, expect, it } from 'vitest';
import { selectStaleChunks } from './prune.js';

describe('selectStaleChunks', () => {
  const now = 1_000_000;
  const ttl = 60_000;

  it('selects only files older than the TTL', () => {
    const files = [
      { name: 'old.js', mtimeMs: now - ttl - 1 },
      { name: 'fresh.js', mtimeMs: now - 1 },
    ];
    expect(selectStaleChunks(files, now, ttl)).toEqual(['old.js']);
  });

  it('KEEPS a file exactly on the boundary (conservative — never over-prune)', () => {
    expect(selectStaleChunks([{ name: 'edge.js', mtimeMs: now - ttl }], now, ttl)).toEqual([]);
  });

  it('is pure and total: an empty list yields an empty list', () => {
    expect(selectStaleChunks([], now, ttl)).toEqual([]);
  });

  it('returns every stale name, preserving input order', () => {
    const files = [
      { name: 'a.js', mtimeMs: now - ttl - 5 },
      { name: 'keep.js', mtimeMs: now },
      { name: 'b.js', mtimeMs: now - ttl - 2 },
    ];
    expect(selectStaleChunks(files, now, ttl)).toEqual(['a.js', 'b.js']);
  });
});
`,
};

/**
 * Task 3 — the one-way corpus default (the REAL-ANCHOR task, scored but never optimized).
 *
 * Extracted from THIS plan's own P-003. Its subtlety is a safety asymmetry: unknown,
 * absent or partial provenance must resolve to 'synthetic', never 'real' — the property
 * that stops a champion from claiming a real pedigree it did not earn.
 */
const CORPUS_DEFAULT_TASK: RealGymTask = {
  taskId: 'real-corpus-one-way-default',
  pool: 'real-anchor',
  sourceRef: 'papercusp gym-real-fitness-signal-2026-07-27 P-003 (task-corpus.ts one-way default)',
  spec:
    'Implement `judgedCorpus(tasks)` in corpus.js. Each task may carry a `corpus` of "synthetic" or "real". Return ' +
    '"real" only when every task is real; "mixed" when both kinds are present; and "synthetic" for an empty list or ' +
    'when no task is real. Any unrecognised or missing value counts as synthetic.',
  intent:
    'Provenance labelling must fail one way: an unknown or partial pedigree can never be reported as fully real, or a ' +
    'single genuine item launders a set of stubs. This asymmetry is the whole safety property of the label.',
  implPath: 'corpus.js',
  stubFile: `/**
 * The corpus a judgement rests on: 'real' | 'mixed' | 'synthetic'.
 * Unknown/missing values count as synthetic; an empty list is synthetic.
 * @param {{corpus?: unknown}[]} tasks
 * @returns {'real'|'mixed'|'synthetic'}
 */
export function judgedCorpus(tasks) {
  throw new Error('not implemented');
}
`,
  testPath: 'corpus.test.js',
  oracleTest: `import { describe, expect, it } from 'vitest';
import { judgedCorpus } from './corpus.js';

describe('judgedCorpus', () => {
  it('is synthetic for an empty list (no tasks ⇒ no real signal)', () => {
    expect(judgedCorpus([])).toBe('synthetic');
  });

  it('is real only when every task is real', () => {
    expect(judgedCorpus([{ corpus: 'real' }, { corpus: 'real' }])).toBe('real');
  });

  it('is MIXED — never real — when any synthetic task is present', () => {
    expect(judgedCorpus([{ corpus: 'real' }, { corpus: 'synthetic' }])).toBe('mixed');
    expect(judgedCorpus([{ corpus: 'real' }, { corpus: 'synthetic' }, { corpus: 'synthetic' }])).toBe('mixed');
  });

  it('treats unknown or missing provenance as synthetic, never real', () => {
    expect(judgedCorpus([{ corpus: 'real' }, {}])).toBe('mixed');
    expect(judgedCorpus([{}, {}])).toBe('synthetic');
    expect(judgedCorpus([{ corpus: 'REAL' }])).toBe('synthetic');
    expect(judgedCorpus([{ corpus: 'real' }, { corpus: 'bogus' }])).toBe('mixed');
  });
});
`,
};

/** The corpus, one entry per pool: train drives the proposer, dev-anchor guards
 *  optimization, real-anchor is scored but never optimized (the falsifiability check). */
export const REAL_GYM_TASKS: readonly RealGymTask[] = Object.freeze([
  RETRY_LOG_TASK,
  PRUNE_POLICY_TASK,
  CORPUS_DEFAULT_TASK,
]);

/** A substrate file the gym writes into the task repo before the agent starts. */
export interface SubstrateFile {
  path: string;
  content: string;
}

/**
 * Build the substrate for the real corpus: a minimal vitest package, plus each task's
 * stub + its real test file.
 *
 * The gate is `npm test` → `vitest run`, so the OBSERVED signal is whether the real tests
 * pass (D-002). Contrast the toy substrate, whose only gate was `node --check` — a syntax
 * check, which is why a worker could "declare done after only a syntax check" and still
 * score. Here a syntactically perfect stub fails every test.
 */
export function buildRealCorpusSubstrate(
  tasks: readonly RealGymTask[] = REAL_GYM_TASKS,
): SubstrateFile[] {
  const files: SubstrateFile[] = [
    {
      path: 'package.json',
      content:
        JSON.stringify(
          {
            name: 'gym-real-substrate',
            version: '0.0.0',
            private: true,
            type: 'module',
            // `vitest run` with the DEFAULT reporter. Verified by actually executing this
            // substrate: `--reporter=basic` was removed in vitest 4 and makes the gate
            // itself explode with ERR_LOAD_URL before a single test runs — which would
            // have scored every agent as failing for a reason it could not fix. A task's
            // gate command must be executed, not assumed.
            scripts: { test: 'vitest run', typecheck: 'node --check' },
            devDependencies: { vitest: '^4.1.8' },
          },
          null,
          2,
        ) + '\n',
    },
    {
      path: 'README.md',
      content:
        '# gym real-corpus substrate\n\n' +
        'Each task is a REAL requirement from a shipped Papercusp fix, paired with the REAL test file\n' +
        'that shipped with it. Implement the stub so its tests pass — `npm test` is the gate, and the\n' +
        'test result is the score. Do not edit the test files: they are the oracle.\n',
    },
  ];
  for (const t of tasks) {
    files.push({ path: t.implPath, content: t.stubFile });
    files.push({ path: t.testPath, content: t.oracleTest });
  }
  return files;
}

/**
 * The gym-task rows for the real corpus — `corpus: 'real'`, with each task's provenance
 * folded into the context the agent sees.
 *
 * `repoUrl`/`repoCommit` stay caller-supplied placeholders exactly as the synthetic path
 * does (the runner pins them when it materialises the substrate repo).
 */
export function realCorpusTasks(tasks: readonly RealGymTask[] = REAL_GYM_TASKS): Array<{
  taskId: string;
  pool: GymTaskPool;
  spec: string;
  intent: string;
  projectContext: string;
  corpus: 'real';
  repoUrl: string;
  repoCommit: string;
}> {
  return tasks.map((t) => ({
    taskId: t.taskId,
    pool: t.pool,
    spec: t.spec,
    intent: t.intent,
    projectContext:
      `A small ESM package. Implement ${t.implPath}; ${t.testPath} is the REAL test file that shipped with this fix ` +
      `and is the oracle — do not edit it. \`npm test\` (vitest) is the gate. Provenance: ${t.sourceRef}.`,
    corpus: 'real' as const,
    repoUrl: '__SET_AT_RUNTIME__',
    repoCommit: '__SET_AT_RUNTIME__',
  }));
}
