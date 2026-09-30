/**
 * The seeded Hive-evaluation scenario corpus (P-020). 4 scenarios spanning serial /
 * wide-parallel / deep-dependency / diamond shapes, each over the same `seed-app`
 * fixture sandbox with an OBJECTIVE optimum (known-good end state + acceptance gate +
 * planted defect + computable parallelism ideal — D-004).
 *
 * The DAG (`workItems[].dependsOn`) encodes the shape; `computeParallelismStructure`
 * derives the ideal wall-clock + ideal bee-count (asserted against these comments in
 * scenario.test.ts). The throwaway Hive (hive-subject.ts live ports) materializes a git
 * repo from {@link SEED_APP_DIR} at a pinned commit, drains the work-items, then the
 * acceptance command is the ground-truth bar.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HiveScenario } from './scenario';

/** Absolute path to the seed-app fixture the live ports clone into a throwaway repo. */
export const SEED_APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'seed-app');

/** The seeded sandbox shared by every scenario (the live ports pin a commit on clone). */
const SEED_SANDBOX = { source: SEED_APP_DIR, commit: 'seed', setup: 'npm install --no-audit --no-fund' } as const;

/** Planted defect #1 — the latent off-by-one in `src/ranker.js#topN` (README ground truth). */
const RANKER_BUG = {
  location: 'src/ranker.js#topN',
  defect: 'off-by-one: slice(0, n - 1) returns n-1 items, not n',
  detectionSignature: 'topN(items, n) returns n-1 items; topN(.,3).length is 2 not 3',
} as const;

/** Planted defect #2 — the missing empty-segment guard in `src/parser.js#parseRecord`. */
const PARSER_BUG = {
  location: 'src/parser.js#parseRecord',
  defect: 'no empty-segment guard: a trailing or doubled ";" leaks a "" key',
  detectionSignature: "parseRecord('a=1;;b=2') has an empty-string key",
} as const;

export const HIVE_EVAL_SCENARIOS: readonly HiveScenario[] = [
  {
    id: 'serial-pipeline',
    title: 'Serial pipeline — strict 4-stage chain',
    shape: 'serial',
    sandbox: SEED_SANDBOX,
    // w1 → w2 → w3 → w4. Critical path 4, ideal bees 1 (no overlap): the run is
    // genuinely serial, so a low critical-path ratio here means the Hive correctly
    // did NOT over-parallelize work that cannot be parallelized.
    workItems: [
      {
        id: 'w1',
        title: 'Add a top-N formatter',
        spec: 'Create src/formatter.js exporting formatTop(items, n): string[] — one formatted line per item in topN(items, n) (import topN from ./ranker.js). Review the ranking code you touch.',
        dependsOn: [],
      },
      {
        id: 'w2',
        title: 'Expose a formatted pipeline',
        spec: 'Extend src/pipeline.js with formattedPipeline(rawList, n) = formatTop(runPipeline(rawList), n).',
        dependsOn: ['w1'],
      },
      {
        id: 'w3',
        title: 'Add a CLI entry',
        spec: 'Add src/main.js that reads a small built-in input, calls formattedPipeline, and returns the lines.',
        dependsOn: ['w2'],
      },
      {
        id: 'w4',
        title: 'Emit the result artifact',
        spec: 'Make src/main.js write dist/result.json ({ lines: string[] }) so acceptance can verify the end state.',
        dependsOn: ['w3'],
      },
    ],
    plantedBug: { ...RANKER_BUG, inWorkItem: 'w1' },
    acceptance: {
      kind: 'command',
      description: 'dist/result.json emitted and topN off-by-one fixed',
      command: 'node acceptance.mjs --scenario serial-pipeline',
    },
    rationale:
      'Pure serial chain: ideal bees = 1. Tests that the Hive recognizes an unparallelizable task and does not waste bees (high-parallelism would be a useless-bee anti-pattern here).',
  },
  {
    id: 'wide-fanout',
    title: 'Wide fan-out — base, 4 parallel feats, aggregate',
    shape: 'wide-parallel',
    sandbox: SEED_SANDBOX,
    // w0 → {w1,w2,w3,w4} → w5. Critical path 3, ideal bees 4: the four feats are
    // independent, so a Hive that serializes them has a bad critical-path ratio.
    workItems: [
      {
        id: 'w0',
        title: 'Add the feature registry base',
        spec: 'Create src/registry.js exporting an empty register(name, fn) + registry map the feats attach to.',
        dependsOn: [],
      },
      { id: 'w1', title: 'Feat A — count', spec: 'Create src/feat-a.js: register("count", items => items.length).', dependsOn: ['w0'] },
      {
        id: 'w2',
        title: 'Feat B — parse-and-sum',
        spec: 'Create src/feat-b.js using parseAll from ./parser.js to parse records and sum their weights. Review the parser you touch.',
        dependsOn: ['w0'],
      },
      { id: 'w3', title: 'Feat C — max-signal', spec: 'Create src/feat-c.js: register("maxSignal", items => Math.max(...items.map(i => i.signal ?? 0))).', dependsOn: ['w0'] },
      { id: 'w4', title: 'Feat D — labels', spec: 'Create src/feat-d.js: register("labels", items => items.map(i => i.label)).', dependsOn: ['w0'] },
      {
        id: 'w5',
        title: 'Aggregate the feats',
        spec: 'Create src/features.js importing feat-a..d and exporting `features` (the populated registry map with all 4).',
        dependsOn: ['w1', 'w2', 'w3', 'w4'],
      },
    ],
    plantedBug: { ...PARSER_BUG, inWorkItem: 'w2' },
    acceptance: {
      kind: 'command',
      description: 'src/features.js aggregates 4 feats and the parser empty-segment guard is fixed',
      command: 'node acceptance.mjs --scenario wide-fanout',
    },
    rationale:
      'Four independent feats: ideal bees = 4, critical path = 3. Tests that the Hive parallelizes independent work (high parallelism utilization) without collisions on the shared registry base.',
  },
  {
    id: 'deep-chain',
    title: 'Deep dependency — 5-deep chain with one branch',
    shape: 'deep-dependency',
    sandbox: SEED_SANDBOX,
    // w1→w2→w3→w4→w5 chain, w6 branches off w2. Critical path 5, ideal bees 2.
    // The run is SLOW because the work is genuinely deep, not because it's serialized —
    // the critical-path ratio must stay ~1 here even though wall-clock is large.
    workItems: [
      { id: 'w1', title: 'Stage 1 — normalize', spec: 'Create src/chain.js exporting stage1(raw) that normalizes input to items[].', dependsOn: [] },
      {
        id: 'w2',
        title: 'Stage 2 — rank',
        spec: 'Add stage2(items) to src/chain.js that ranks via rankItems/topN from ./ranker.js. Review the ranking code you touch.',
        dependsOn: ['w1'],
      },
      { id: 'w3', title: 'Stage 3 — score', spec: 'Add stage3(ranked) to src/chain.js that annotates each with a composite score.', dependsOn: ['w2'] },
      { id: 'w4', title: 'Stage 4 — window', spec: 'Add stage4(scored) to src/chain.js that takes the top window.', dependsOn: ['w3'] },
      { id: 'w5', title: 'Stage 5 — finalize', spec: 'Add stage5(windowed) to src/chain.js producing the final result (the deep terminal).', dependsOn: ['w4'] },
      { id: 'w6', title: 'Branch — audit log', spec: 'Add auditLog(ranked) to src/chain.js (a side artifact off stage2). Independent of stages 3-5.', dependsOn: ['w2'] },
    ],
    plantedBug: { ...RANKER_BUG, inWorkItem: 'w2' },
    acceptance: {
      kind: 'command',
      description: 'src/chain.js#stage5 implemented and topN off-by-one fixed',
      command: 'node acceptance.mjs --scenario deep-chain',
    },
    rationale:
      'A long critical path (5) with one short branch (ideal bees 2). The critical-path ratio separates "slow because deep" (fine — ratio ~1) from "slow because serialized" (bad).',
  },
  {
    id: 'diamond',
    title: 'Diamond — base, 3 parallel branches, merge',
    shape: 'diamond',
    sandbox: SEED_SANDBOX,
    // w1 → {w2,w3,w4} → w5. Critical path 3, ideal bees 3.
    workItems: [
      { id: 'w1', title: 'Base loader', spec: 'Create src/merge.js exporting load(raw) returning items[] (the diamond source).', dependsOn: [] },
      {
        id: 'w2',
        title: 'Branch — parse extras',
        spec: 'Add parseExtras(raw) to src/merge.js using parseRecord from ./parser.js. Review the parser you touch.',
        dependsOn: ['w1'],
      },
      { id: 'w3', title: 'Branch — rank', spec: 'Add rankBranch(items) to src/merge.js using rankItems from ./ranker.js.', dependsOn: ['w1'] },
      { id: 'w4', title: 'Branch — tally', spec: 'Add tally(items) to src/merge.js returning a count summary.', dependsOn: ['w1'] },
      {
        id: 'w5',
        title: 'Merge the branches',
        spec: 'Add merge(raw) to src/merge.js combining parseExtras + rankBranch + tally into one result (the diamond sink).',
        dependsOn: ['w2', 'w3', 'w4'],
      },
    ],
    plantedBug: { ...PARSER_BUG, inWorkItem: 'w2' },
    acceptance: {
      kind: 'command',
      description: 'src/merge.js#merge implemented and the parser empty-segment guard is fixed',
      command: 'node acceptance.mjs --scenario diamond',
    },
    rationale:
      'Classic diamond (critical path 3, ideal bees 3): three independent branches that must all complete before the merge. Tests parallel dispatch + a correct join/completion barrier.',
  },
];

/** Lookup a scenario by id (the corpus key). */
export function getScenario(id: string): HiveScenario | undefined {
  return HIVE_EVAL_SCENARIOS.find((s) => s.id === id);
}
