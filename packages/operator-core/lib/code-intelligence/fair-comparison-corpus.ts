/**
 * P-017 fair-comparison CORPUS (D-011): the ~50 stratified raw-query cases every
 * code-intelligence arm answers, frozen at one commit, plus the SEED sites each
 * answer key starts from before pooled adjudication completes it.
 *
 * Why a seed and not a full key: a key written up front from one tool favours
 * that tool. The key is completed by pooling every arm's answers and ruling on
 * each new site (`poolCandidates` / `applyAdjudication` in fair-comparison.ts).
 * Seeds are the sites a human verified BEFORE any arm ran, so an arm that finds
 * nothing cannot shrink the key to nothing.
 *
 * ANSWER UNIT per intent — the one identity every arm is scored on. Engines
 * report at different granularities (GitNexus names the calling FUNCTION, LSP
 * names the call LINE); adjudication aliases each to the unit below so neither
 * granularity is punished for being the other one.
 *   callers     one unit per calling SCOPE (function / method / module top level),
 *               canonical = the first line in that scope that calls the subject.
 *               Other call lines in the scope and the scope's declaration line
 *               are aliases of it.
 *   callees     one unit per first-party callee, canonical = its declaration line.
 *               Calls into node built-ins / third-party packages are neutral.
 *   impact      one unit per upstream scope within `depth`, canonical = that
 *               scope's declaration line.
 *   definition  the declaration line(s) of the subject (all overloads alias the
 *               first).
 *   references  one unit per referencing line (imports, re-exports, usages and
 *               type positions). The subject's own declaration is neutral.
 *   symbol-search  declaration lines of every symbol whose name is exactly the
 *               subject.
 *   text-search one unit per line containing the literal.
 *
 * Every non-absence case carries >= 1 seed. A case with NO seeds is an absence
 * claim and must be tagged `absence` — an empty key is never produced by
 * omission.
 */
import type { AnswerKey, FairCase, FairIntent, HardnessTag, SiteKey } from './fair-comparison';
import { FAIR_INTENTS } from './fair-comparison';

/** The commit every arm indexes and every seed is pinned to (staging, 2026-10-06T05:15Z). */
export const FAIR_CORPUS_COMMIT = '90e6465ad21b79142bac4853bb1c9c958f868f41';

/** A verified site: `text` must occur on `line1` of `path` at FAIR_CORPUS_COMMIT. */
export interface SeedSite {
  readonly path: string;
  readonly line1: number;
  readonly text: string;
}

export interface FairCorpusEntry {
  readonly kase: FairCase;
  /** What a wrong engine gets wrong here — the reason the case is in the corpus. */
  readonly why: string;
  readonly seeds: readonly SeedSite[];
  /** Sites neither credited nor penalised (the subject declaration for callers/references). */
  readonly neutral: readonly SeedSite[];
  /** Where the case came from: an earlier corpus id, or the mined demand behind it. */
  readonly origin: string;
}

/** The preregistered shape the corpus must keep (D-011: ~50 stratified, absence + hard cases). */
export const FAIR_CORPUS_SHAPE = Object.freeze({
  minTotal: 45,
  maxTotal: 60,
  minPerIntent: Object.freeze<Record<FairIntent, number>>({
    callers: 10,
    callees: 5,
    impact: 4,
    definition: 5,
    references: 5,
    'symbol-search': 3,
    'text-search': 3,
  }),
  minAbsence: 6,
  /** Every hardness tag appears at least this often. */
  minPerTag: 2,
});

const ALL_TAGS: readonly HardnessTag[] = [
  'absence',
  'barrel-reexport',
  'same-name',
  'dynamic-dispatch',
  'cross-package',
  'submodule',
];

const seedKey = (s: SeedSite): SiteKey => `${s.path}:${s.line1}`;

export interface CorpusShapeReport {
  readonly total: number;
  readonly byIntent: Readonly<Record<FairIntent, number>>;
  readonly byTag: Readonly<Record<HardnessTag, number>>;
  readonly absence: number;
}

export function corpusShape(corpus: readonly FairCorpusEntry[]): CorpusShapeReport {
  const byIntent = Object.fromEntries(FAIR_INTENTS.map((i) => [i, 0])) as Record<FairIntent, number>;
  const byTag = Object.fromEntries(ALL_TAGS.map((t) => [t, 0])) as Record<HardnessTag, number>;
  for (const e of corpus) {
    byIntent[e.kase.intent] += 1;
    for (const t of e.kase.tags) byTag[t] += 1;
  }
  return { total: corpus.length, byIntent, byTag, absence: byTag.absence };
}

/** Structural problems in a corpus — an empty list means it may be preregistered. */
export function validateCorpus(corpus: readonly FairCorpusEntry[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const e of corpus) {
    const { id, intent, tags, depth } = e.kase;
    if (ids.has(id)) problems.push(`duplicate case id ${id}`);
    ids.add(id);
    const absence = tags.includes('absence');
    if (absence && e.seeds.length > 0) problems.push(`${id}: tagged absence but carries ${e.seeds.length} seed(s)`);
    if (!absence && e.seeds.length === 0) problems.push(`${id}: no seeds and not tagged absence — an empty key by omission`);
    if (intent === 'impact' && (depth === undefined || depth < 1)) problems.push(`${id}: impact case needs depth >= 1`);
    if (intent !== 'impact' && depth !== undefined) problems.push(`${id}: depth only applies to impact`);
    // An exact-name search over same-named symbols wants ALL of them, so it is the one
    // same-name intent that needs no disambiguating file.
    if (tags.includes('same-name') && intent !== 'symbol-search' && !e.kase.anchorFile) {
      problems.push(`${id}: same-name case needs an anchorFile`);
    }
    if (!e.why.trim()) problems.push(`${id}: no why`);
    const seen = new Set<SiteKey>();
    for (const s of [...e.seeds, ...e.neutral]) {
      const k = seedKey(s);
      if (seen.has(k)) problems.push(`${id}: site ${k} listed twice`);
      seen.add(k);
      if (!s.text.trim()) problems.push(`${id}: site ${k} has no anchor text`);
      if (s.path.startsWith('/') || s.path.includes('\\')) problems.push(`${id}: site ${k} is not repo-relative POSIX`);
    }
  }
  const shape = corpusShape(corpus);
  if (shape.total < FAIR_CORPUS_SHAPE.minTotal || shape.total > FAIR_CORPUS_SHAPE.maxTotal) {
    problems.push(`total ${shape.total} outside [${FAIR_CORPUS_SHAPE.minTotal}, ${FAIR_CORPUS_SHAPE.maxTotal}]`);
  }
  for (const i of FAIR_INTENTS) {
    if (shape.byIntent[i] < FAIR_CORPUS_SHAPE.minPerIntent[i]) {
      problems.push(`intent ${i}: ${shape.byIntent[i]} < ${FAIR_CORPUS_SHAPE.minPerIntent[i]}`);
    }
  }
  if (shape.absence < FAIR_CORPUS_SHAPE.minAbsence) problems.push(`absence: ${shape.absence} < ${FAIR_CORPUS_SHAPE.minAbsence}`);
  for (const t of ALL_TAGS) {
    if (shape.byTag[t] < FAIR_CORPUS_SHAPE.minPerTag) problems.push(`tag ${t}: ${shape.byTag[t]} < ${FAIR_CORPUS_SHAPE.minPerTag}`);
  }
  return problems;
}

/**
 * Every seed/neutral site's anchor text must sit on its pinned line in the frozen
 * snapshot. `read` returns a file's text at FAIR_CORPUS_COMMIT (or null when the
 * path does not exist there).
 */
export function verifyCorpusSites(corpus: readonly FairCorpusEntry[], read: (path: string) => string | null): string[] {
  const problems: string[] = [];
  const cache = new Map<string, string[] | null>();
  const lines = (p: string): string[] | null => {
    if (!cache.has(p)) {
      const t = read(p);
      cache.set(p, t === null ? null : t.split('\n'));
    }
    return cache.get(p) ?? null;
  };
  for (const e of corpus) {
    for (const s of [...e.seeds, ...e.neutral]) {
      const ls = lines(s.path);
      if (ls === null) {
        problems.push(`${e.kase.id}: ${s.path} absent at ${FAIR_CORPUS_COMMIT.slice(0, 12)}`);
        continue;
      }
      const line = ls[s.line1 - 1];
      if (line === undefined || !line.includes(s.text)) {
        problems.push(`${e.kase.id}: ${seedKey(s)} does not contain ${JSON.stringify(s.text)}`);
      }
    }
  }
  return problems;
}

/** The pre-pooling key for every case: seeds are valid, neutral sites are neutral. */
export function initialKeys(corpus: readonly FairCorpusEntry[]): AnswerKey[] {
  return corpus.map((e) => ({
    caseId: e.kase.id,
    sites: [...new Set(e.seeds.map(seedKey))].sort(),
    aliases: {},
    rejected: [],
    neutral: [...new Set(e.neutral.map(seedKey))].sort(),
  }));
}

const s = (path: string, line1: number, text: string): SeedSite => ({ path, line1, text });

export const FAIR_CORPUS: readonly FairCorpusEntry[] = Object.freeze([
  {
    kase: {id: "callers-managed-spawn",intent: "callers",subject: "managedSpawn",tags: ["cross-package"],source: "acceptance"},
    why: "Production callers span operator-core and apps/operator; counting the declaration, the barrel line or test doubles as callers is wrong.",
    origin: "acceptance-corpus#callers-of-managed-spawn; mined grep demand (4 sessions)",
    seeds: [
      s("packages/operator-core/lib/code-intelligence/lsp-adapter-shutdown.integration.test.ts", 30, "managedSpawn"),
      s("packages/operator-core/lib/code-intelligence/lsp-adapter.integration.test.ts", 26, "managedSpawn"),
      s("packages/operator-core/lib/code-intelligence/lsp-adapter.ts", 1199, "managedSpawn"),
    ],
    neutral: [
      s("packages/operator-core/lib/task-manager/managed-spawn.ts", 255, "managedSpawn"),
    ],
  },
  {
    kase: {id: "callers-measure-repo-files-evidence",intent: "callers",subject: "measureRepoFilesEvidenceAtRoot",tags: ["cross-package"],source: "selective"},
    why: "The design-acceptance consumer lives outside the defining module; text search also returns corpus strings that are not calls.",
    origin: "selective-corpus#selective-external-consumer",
    seeds: [
      s("packages/operator-core/lib/acceptance-bar-contract-snapshot.integration.test.ts", 217, "measureRepoFilesEvidenceAtRoot"),
      s("packages/operator-core/lib/agent-tools/plans/certify-spec-clauses.test.ts", 243, "measureRepoFilesEvidenceAtRoot"),
      s("packages/operator-core/lib/agent-tools/plans/evidence-measurement-pin.test.ts", 123, "measureRepoFilesEvidenceAtRoot"),
    ],
    neutral: [
      s("packages/operator-core/lib/agent-tools/plans/spec-evidence-store.ts", 349, "measureRepoFilesEvidenceAtRoot"),
    ],
  },
  {
    kase: {id: "callers-append-host-event",intent: "callers",subject: "appendHostEvent",tags: [],source: "mined-grep"},
    why: "Implemented in a .mjs host script with a generated .d.mts declaration; an engine that indexes only TypeScript sees a declaration and no implementation.",
    origin: "mined grep demand (7 sessions)",
    seeds: [
      s("apps/operator/lib/psu-adopt-first-turn.test.ts", 40, "appendHostEvent"),
      s("apps/operator/lib/psu-pty-busy-gate-durable-evidence.test.ts", 48, "appendHostEvent"),
      s("apps/operator/lib/psu-pty-busy-gate-durable-evidence.test.ts", 129, "appendHostEvent"),
    ],
    neutral: [
      s("apps/operator/scripts/psu-pty-host.d.mts", 823, "appendHostEvent"),
    ],
  },
  {
    kase: {id: "callers-verdict-of-same-name",intent: "callers",subject: "verdictOf",anchorFile: "packages/operator-core/lib/pot-eval/supervision-metrics.ts",tags: ["same-name"],source: "mined-grep"},
    why: "Two unrelated functions are named verdictOf; callers of the supervision-metrics one must exclude call sites of the other.",
    origin: "mined grep demand (7 sessions)",
    seeds: [
      s("packages/operator-core/lib/pot-eval/supervision-metrics.ts", 144, "verdictOf"),
      s("packages/operator-core/lib/pot-eval/supervision-metrics.ts", 272, "verdictOf"),
    ],
    neutral: [
      s("packages/operator-core/lib/pot-eval/supervision-metrics.ts", 67, "verdictOf"),
    ],
  },
  {
    kase: {id: "callers-classify-projection-body",intent: "callers",subject: "classifyProjectionBody",tags: [],source: "mined-grep"},
    why: "Few callers across three files; a precise engine should be exact here.",
    origin: "mined grep demand (5 sessions)",
    seeds: [
      s("packages/operator-core/lib/continuity-probes.ts", 556, "classifyProjectionBody"),
      s("packages/operator-core/lib/result-door.ts", 416, "classifyProjectionBody"),
      s("packages/operator-core/lib/result-door.ts", 1207, "classifyProjectionBody"),
    ],
    neutral: [
      s("packages/operator-core/lib/result-projection/apply.ts", 263, "classifyProjectionBody"),
    ],
  },
  {
    kase: {id: "callers-recover-index-lock",intent: "callers",subject: "recoverIndexLockContention",tags: [],source: "mined-grep"},
    why: "A module-private async function with several call lines inside one large file; the unit is the calling scope, not the line.",
    origin: "mined grep demand (5 sessions)",
    seeds: [
      s("packages/operator-core/lib/harness/git-sync/run-git-sync.test.ts", 5037, "recoverIndexLockContention"),
      s("packages/operator-core/lib/harness/git-sync/run-git-sync.ts", 1914, "recoverIndexLockContention"),
      s("packages/operator-core/lib/harness/git-sync/run-git-sync.ts", 2039, "recoverIndexLockContention"),
    ],
    neutral: [
      s("packages/operator-core/lib/harness/git-sync/run-git-sync.ts", 2492, "recoverIndexLockContention"),
    ],
  },
  {
    kase: {id: "callers-resolve-installed-event",intent: "callers",subject: "resolveInstalledEvent",tags: [],source: "mined-grep"},
    why: "Small caller set split between production and tests.",
    origin: "mined grep demand (5 sessions)",
    seeds: [
      s("packages/operator-core/lib/blueprint/compile-packages.ts", 194, "resolveInstalledEvent"),
      s("packages/operator-core/lib/cupboard/install-event-io.test.ts", 165, "resolveInstalledEvent"),
      s("packages/operator-core/lib/cupboard/install-event-io.ts", 146, "resolveInstalledEvent"),
    ],
    neutral: [
      s("packages/operator-core/lib/cupboard/event-store.ts", 272, "resolveInstalledEvent"),
    ],
  },
  {
    kase: {id: "callers-seed-acceptance-bars",intent: "callers",subject: "seedAcceptanceBarsInTransaction",tags: [],source: "mined-grep"},
    why: "Callers spread over many files including transaction wrappers; a file-level engine over-reports siblings.",
    origin: "mined grep demand (4 sessions)",
    seeds: [
      s("packages/operator-core/lib/acceptance-bar-contract-snapshot.integration.test.ts", 160, "seedAcceptanceBarsInTransaction"),
      s("packages/operator-core/lib/acceptance-bar-migration.ts", 339, "seedAcceptanceBarsInTransaction"),
      s("packages/operator-core/lib/acceptance-bar-receiver-seed.ts", 167, "seedAcceptanceBarsInTransaction"),
    ],
    neutral: [
      s("packages/operator-core/lib/acceptance-bar-seed.ts", 948, "seedAcceptanceBarsInTransaction"),
    ],
  },
  {
    kase: {id: "callers-seal-implementation-acceptance",intent: "callers",subject: "sealImplementationAcceptance",tags: [],source: "mined-grep"},
    why: "Thirteen referencing files, most of them tests; recall on test callers is part of the answer.",
    origin: "mined grep demand (4 sessions)",
    seeds: [
      s("packages/operator-core/lib/attention/intake-promotion.ts", 569, "sealImplementationAcceptance"),
      s("packages/operator-core/lib/harness/improvements/agent-review-policy.integration.test.ts", 51, "sealImplementationAcceptance"),
      s("packages/operator-core/lib/harness/improvements/agent-review-policy.test.ts", 74, "sealImplementationAcceptance"),
    ],
    neutral: [
      s("packages/operator-core/lib/harness/improvements/agent-review-policy.ts", 487, "sealImplementationAcceptance"),
    ],
  },
  {
    kase: {id: "callers-run-integrator-tick-same-name",intent: "callers",subject: "runIntegratorTick",anchorFile: "packages/operator-core/lib/sync/pot-git/integrator-tick.ts",tags: ["same-name"],source: "mined-grep"},
    why: "A test file declares its own runIntegratorTick; callers of the production function must not include the local helper's call sites.",
    origin: "mined grep demand (3 sessions)",
    seeds: [
      s("packages/operator-core/lib/harness/git-sync/git-sync-action.ts", 6707, "runIntegratorTick"),
      s("packages/operator-core/lib/sync/pot-git/integrator-tick.integration.test.ts", 95, "runIntegratorTick"),
      s("packages/operator-core/lib/sync/pot-git/integrator-tick.integration.test.ts", 272, "runIntegratorTick"),
    ],
    neutral: [
      s("packages/operator-core/lib/sync/pot-git/integrator-tick.ts", 228, "runIntegratorTick"),
    ],
  },
  {
    kase: {id: "callers-mark-spawn-offload-host",intent: "callers",subject: "markSpawnOffloadHost",tags: [],source: "mined-grep"},
    why: "A zero-argument side-effect call; trivially greppable, so any miss is an index defect.",
    origin: "mined grep demand (3 sessions)",
    seeds: [
      s("apps/operator/bin/hono-host-spawn-offload.test.ts", 44, "markSpawnOffloadHost"),
      s("apps/operator/bin/hono-host.ts", 202, "markSpawnOffloadHost"),
      s("packages/operator-core/lib/fleet/git-via-sidecar.test.ts", 113, "markSpawnOffloadHost"),
    ],
    neutral: [
      s("packages/operator-core/lib/fleet/git-via-sidecar.ts", 145, "markSpawnOffloadHost"),
    ],
  },
  {
    kase: {id: "callers-record-scheduled-fire-failure",intent: "callers",subject: "recordScheduledFireFailure",tags: [],source: "mined-grep"},
    why: "One production caller and one test; the smallest non-empty answer in the corpus.",
    origin: "mined grep demand (3 sessions)",
    seeds: [
      s("packages/operator-core/lib/harness/routines/plan-run-action-fire-failure.test.ts", 125, "recordScheduledFireFailure"),
      s("packages/operator-core/lib/harness/routines/plan-run-action.ts", 754, "recordScheduledFireFailure"),
    ],
    neutral: [
      s("packages/operator-core/lib/harness/routines/plan-run-action.ts", 777, "recordScheduledFireFailure"),
    ],
  },
  {
    kase: {id: "callers-apply-min-score-submodule",intent: "callers",subject: "applyMinScore",tags: ["submodule"],source: "authored"},
    why: "Defined inside a git submodule; an engine that skips submodule trees answers with a confident empty.",
    origin: "candidate scan: defined in the libs/generic/search submodule, 11 call lines",
    seeds: [
      s("libs/generic/search/src/hybrid.ts", 300, "applyMinScore"),
      s("libs/generic/search/src/hybrid.ts", 554, "applyMinScore"),
      s("libs/generic/search/src/min-score.test.ts", 62, "applyMinScore"),
    ],
    neutral: [
      s("libs/generic/search/src/min-score.ts", 103, "applyMinScore"),
    ],
  },
  {
    kase: {id: "callers-compare-by-head-of-line-dynamic",intent: "callers",subject: "compareByHeadOfLine",tags: ["dynamic-dispatch"],source: "authored"},
    why: "Only ever passed by reference (to sort); the call edge is the passing site. A direct-call-only engine reports nothing.",
    origin: "candidate scan: exported, never called by name",
    seeds: [
      s("packages/operator-core/lib/work-items-head-of-line.test.ts", 42, "compareByHeadOfLine"),
      s("packages/operator-core/lib/work-items-head-of-line.test.ts", 45, "compareByHeadOfLine"),
      s("packages/operator-core/lib/work-items.ts", 1478, "compareByHeadOfLine"),
    ],
    neutral: [
      s("packages/operator-core/lib/work-items.ts", 1203, "compareByHeadOfLine"),
    ],
  },
  {
    kase: {id: "callers-create-panel-registry-submodule",intent: "callers",subject: "createPanelRegistry",tags: ["submodule"],source: "authored"},
    why: "All callers sit inside the submodule, most in its own test file; an engine that skips submodule trees answers with a confident empty.",
    origin: "sibling export of PanelRegistry in the dock-workbench submodule",
    seeds: [
      s("libs/generic/dock-workbench/src/panel-registry.test.ts", 10, "createPanelRegistry"),
      s("libs/generic/dock-workbench/src/panel-registry.ts", 84, "createPanelRegistry"),
    ],
    neutral: [
      s("libs/generic/dock-workbench/src/panel-registry.ts", 80, "createPanelRegistry"),
    ],
  },
  {
    kase: {id: "callers-absent-seed-fingerprint",intent: "callers",subject: "acceptanceBarSeedFingerprint",tags: ["absence"],source: "authored"},
    why: "Exported and never called while its sibling exports are heavily called; prefix or file-level matching returns sibling call sites.",
    origin: "candidate scan: exported, zero call sites",
    seeds: [],
    neutral: [
      s("packages/operator-core/lib/acceptance-bar-seed.ts", 1337, "acceptanceBarSeedFingerprint"),
    ],
  },
  {
    kase: {id: "callers-absent-apply-sql-file",intent: "callers",subject: "applySqlFile",tags: ["absence","submodule"],source: "authored"},
    why: "A dead export inside a submodule; the correct answer is an explicit empty, not a guess from same-named helpers.",
    origin: "candidate scan: exported in the libs/papercusp submodule, zero call sites",
    seeds: [],
    neutral: [
      s("libs/papercusp/packages/cli/src/pg-client.ts", 93, "applySqlFile"),
    ],
  },
  {
    kase: {id: "callees-get-next-for-bee",intent: "callees",subject: "getNextForBee",tags: [],source: "selective"},
    why: "The scheduler claim path fans out through store helpers; missing an edge hides where a claim is written.",
    origin: "selective-corpus#selective-scheduler-edge",
    seeds: [
      s("packages/operator-core/lib/scheduler/get-next.ts", 2813, "export async function getNextWorkItem"),
    ],
    neutral: [],
  },
  {
    kase: {id: "callees-list-spec-evidence",intent: "callees",subject: "listSpecEvidence",tags: [],source: "selective"},
    why: "The production evidence fingerprint chain; callees include module-private helpers.",
    origin: "selective-corpus#selective-fingerprint-chain",
    seeds: [
      s("packages/operator-core/lib/agent-tools/plans/source.ts", 500, "resolvePlanScope"),
      s("packages/operator-core/lib/agent-tools/plans/spec-evidence-store.ts", 1076, "scorecardIssueIdFromEvidenceRef"),
      s("packages/operator-core/lib/agent-tools/plans/spec-evidence-store.ts", 1081, "parseProvisionalScorecardProof"),
      s("packages/operator-core/lib/agent-tools/plans/spec-evidence-store.ts", 857, "evidenceCurrentInputKey"),
    ],
    neutral: [],
  },
  {
    kase: {id: "callees-recover-index-lock",intent: "callees",subject: "recoverIndexLockContention",tags: [],source: "authored"},
    why: "A private function whose callees are other private helpers in the same large file.",
    origin: "paired with callers-recover-index-lock",
    seeds: [
      s("packages/operator-core/lib/harness/git-sync/run-git-sync.ts", 2251, "isIndexLockFailure"),
      s("packages/operator-core/lib/harness/git-sync/run-git-sync.ts", 2475, "clearStaleIndexLock"),
    ],
    neutral: [],
  },
  {
    kase: {id: "callees-classify-projection-body",intent: "callees",subject: "classifyProjectionBody",tags: [],source: "authored"},
    why: "A pure classifier; callees are small local helpers plus built-ins (neutral).",
    origin: "paired with callers-classify-projection-body",
    seeds: [
      s("packages/operator-core/lib/result-projection/apply.ts", 429, "splitLines"),
    ],
    neutral: [],
  },
  {
    kase: {id: "callees-install-rule-from-cupboard",intent: "callees",subject: "installRuleFromCupboard",tags: [],source: "mined-grep"},
    why: "An IO wrapper calling across modules; cross-module callee resolution.",
    origin: "mined grep demand (3 sessions)",
    seeds: [
      s("packages/operator-core/lib/cupboard/resolve-listing-by-kind.ts", 126, "resolveListingByKind"),
      s("packages/operator-core/lib/cupboard/install-rule-core.ts", 53, "installRuleFromCupboardCore"),
      s("packages/operator-core/lib/cupboard/install-io.ts", 106, "cupboardGitDeps"),
      s("packages/operator-core/lib/cupboard/install-rule-io.ts", 29, "workspaceAsyncRuleChecker"),
    ],
    neutral: [],
  },
  {
    kase: {id: "callees-apply-merge-rule-submodule",intent: "callees",subject: "applyMergeRule",tags: ["submodule"],source: "authored"},
    why: "Callees inside a submodule package.",
    origin: "candidate scan: libs/papercusp orchestrator submodule",
    seeds: [
      s("libs/papercusp/packages/orchestrator/src/blueprint/merge.ts", 169, "intersectConstraint"),
      s("libs/papercusp/packages/orchestrator/src/blueprint/merge.ts", 156, "setUnionArrays"),
      s("libs/papercusp/packages/orchestrator/src/blueprint/merge.ts", 49, "MergeConflictError"),
      s("libs/papercusp/packages/orchestrator/src/blueprint/merge.ts", 134, "keyedOverlayArrays"),
    ],
    neutral: [],
  },
  {
    kase: {id: "impact-is-provenance-only",intent: "impact",subject: "isProvenanceOnlyReprojection",depth: 2,tags: [],source: "mined-grep"},
    why: "Two-hop upstream set of a small predicate; depth must be honoured, not flattened to the whole file.",
    origin: "mined grep demand (4 sessions)",
    seeds: [
      s("packages/operator-core/lib/acceptance-bar-amendment.ts", 484, "barKeyOf"),
    ],
    neutral: [],
  },
  {
    kase: {id: "impact-resolve-installed-event",intent: "impact",subject: "resolveInstalledEvent",depth: 2,tags: [],source: "authored"},
    why: "Two-hop impact crossing a module boundary.",
    origin: "paired with callers-resolve-installed-event",
    seeds: [
      s("packages/operator-core/lib/blueprint/compile-packages.ts", 172, "only"),
      s("packages/operator-core/lib/cupboard/install-event-io.ts", 121, "installEventFromCupboard"),
    ],
    neutral: [],
  },
  {
    kase: {id: "impact-mark-spawn-offload-host",intent: "impact",subject: "markSpawnOffloadHost",depth: 2,tags: [],source: "authored"},
    why: "Two-hop impact of a boot-time side effect.",
    origin: "paired with callers-mark-spawn-offload-host",
    seeds: [
      s("apps/operator/bin/hono-host.ts", 202, "markSpawnOffloadHost"),
    ],
    neutral: [],
  },
  {
    kase: {id: "impact-record-scheduled-fire-failure",intent: "impact",subject: "recordScheduledFireFailure",depth: 2,tags: [],source: "authored"},
    why: "Two-hop impact through a routine action.",
    origin: "paired with callers-record-scheduled-fire-failure",
    seeds: [
      s("packages/operator-core/lib/harness/routines/plan-run-action.ts", 740, "runScheduledPlanFire"),
    ],
    neutral: [],
  },
  {
    kase: {id: "impact-pot-git-gc-tick-dynamic",intent: "impact",subject: "potGitGcTick",depth: 2,tags: ["dynamic-dispatch"],source: "authored"},
    why: "Reached only through the routine registry; the registration is the passing site and the only static upstream edge.",
    origin: "registered with registerSystemAction and invoked by name",
    seeds: [
      s("packages/operator-core/lib/harness/routines/hive-git-gc-action.ts", 105, "potGitGcTick"),
    ],
    neutral: [],
  },
  {
    kase: {id: "impact-absent-clear-operator-sleep",intent: "impact",subject: "clearOperatorSleep",depth: 2,tags: ["absence"],source: "authored"},
    why: "Nothing depends on it; the correct impact set is empty.",
    origin: "candidate scan: exported, zero references",
    seeds: [],
    neutral: [],
  },
  {
    kase: {id: "definition-pin-module-state",intent: "definition",subject: "pinModuleState",anchorFile: "apps/operator/bin/host-bootstrap.ts",tags: ["cross-package"],source: "acceptance"},
    why: "Imported by bare workspace specifier; text matching lands on an import line, and a bundled design-phase copy is a build artifact, not the definition.",
    origin: "acceptance-corpus#definition-cross-package-bare-specifier; mined (8 sessions)",
    seeds: [
      s("libs/generic/module-singleton/src/index.ts", 106, "pinModuleState"),
    ],
    neutral: [],
  },
  {
    kase: {id: "definition-managed-set-interval-shadowed",intent: "definition",subject: "managedSetInterval",anchorFile: "packages/operator-core/lib/pty-bridge.ts",tags: ["same-name"],source: "acceptance"},
    why: "Test mocks and a corpus string share the name; only the scheduled-registry declaration is the definition.",
    origin: "acceptance-corpus#shadowed-symbol-no-cross-contamination",
    seeds: [
      s("libs/generic/scheduled-registry/src/index.ts", 410, "managedSetInterval"),
    ],
    neutral: [],
  },
  {
    kase: {id: "definition-panel-registry-barrel",intent: "definition",subject: "PanelRegistry",anchorFile: "apps/operator/app/harness/dock/panel-registry.ts",tags: ["barrel-reexport","submodule","cross-package"],source: "authored"},
    why: "Asked from an apps/operator consumer that imports by package name; resolving through the barrel must land on the class, not the export-star line.",
    origin: "paired with references-panel-registry-barrel",
    seeds: [
      s("libs/generic/dock-workbench/src/panel-registry.ts", 30, "PanelRegistry"),
    ],
    neutral: [],
  },
  {
    kase: {id: "definition-append-host-event",intent: "definition",subject: "appendHostEvent",tags: [],source: "mined-grep"},
    why: "The implementation is JavaScript; a TypeScript-only engine returns only the .d.mts declaration (adjudicated as an alias).",
    origin: "mined grep demand (7 sessions)",
    seeds: [
      s("apps/operator/scripts/psu-pty-host.mjs", 2324, "appendHostEvent"),
    ],
    neutral: [],
  },
  {
    kase: {id: "definition-verdict-of-same-name",intent: "definition",subject: "verdictOf",anchorFile: "packages/operator-core/lib/pot-eval/supervision-metrics.ts",tags: ["same-name"],source: "mined-grep"},
    why: "Asked from supervision-metrics.ts, the answer is the local declaration only.",
    origin: "mined grep demand (7 sessions)",
    seeds: [
      s("packages/operator-core/lib/pot-eval/supervision-metrics.ts", 67, "verdictOf"),
    ],
    neutral: [],
  },
  {
    kase: {id: "definition-apply-audit-verdict-submodule",intent: "definition",subject: "applyAuditVerdict",tags: ["submodule"],source: "authored"},
    why: "Declared inside a submodule package.",
    origin: "candidate scan: libs/papercusp orchestrator submodule",
    seeds: [
      s("libs/papercusp/packages/orchestrator/src/auditor-dispatch.ts", 154, "applyAuditVerdict"),
    ],
    neutral: [],
  },
  {
    kase: {id: "definition-recover-index-lock",intent: "definition",subject: "recoverIndexLockContention",tags: [],source: "mined-grep"},
    why: "A non-exported declaration deep in a 2,500-line file.",
    origin: "mined grep demand (5 sessions)",
    seeds: [
      s("packages/operator-core/lib/harness/git-sync/run-git-sync.ts", 2492, "recoverIndexLockContention"),
    ],
    neutral: [],
  },
  {
    kase: {id: "references-panel-registry-barrel",intent: "references",subject: "PanelRegistry",tags: ["barrel-reexport","submodule"],source: "acceptance"},
    why: "Stopping at the export-star barrel returns a false-empty consumer set.",
    origin: "acceptance-corpus#references-through-barrel-reexport",
    seeds: [
      s("apps/operator/app/harness/dock/panel-registry.ts", 2, "PanelRegistry"),
      s("libs/generic/dock-workbench/src/DockWorkspace.tsx", 6, "PanelRegistry"),
      s("libs/generic/dock-workbench/src/DockWorkspace.tsx", 13, "PanelRegistry"),
    ],
    neutral: [
      s("libs/generic/dock-workbench/src/panel-registry.ts", 30, "PanelRegistry"),
    ],
  },
  {
    kase: {id: "references-classify-projection-body",intent: "references",subject: "classifyProjectionBody",tags: [],source: "authored"},
    why: "References include the import lines callers omit.",
    origin: "paired with callers-classify-projection-body",
    seeds: [
      s("packages/operator-core/lib/continuity-probes.ts", 15, "classifyProjectionBody"),
      s("packages/operator-core/lib/continuity-probes.ts", 556, "classifyProjectionBody"),
      s("packages/operator-core/lib/result-door.ts", 51, "classifyProjectionBody"),
    ],
    neutral: [
      s("packages/operator-core/lib/result-projection/apply.ts", 263, "classifyProjectionBody"),
    ],
  },
  {
    kase: {id: "references-resolve-installed-event",intent: "references",subject: "resolveInstalledEvent",tags: [],source: "authored"},
    why: "Small reference set; exactness check.",
    origin: "paired with callers-resolve-installed-event",
    seeds: [
      s("packages/operator-core/lib/blueprint/compile-packages.ts", 31, "resolveInstalledEvent"),
      s("packages/operator-core/lib/blueprint/compile-packages.ts", 194, "resolveInstalledEvent"),
      s("packages/operator-core/lib/cupboard/install-event-io.test.ts", 70, "resolveInstalledEvent"),
    ],
    neutral: [
      s("packages/operator-core/lib/cupboard/event-store.ts", 272, "resolveInstalledEvent"),
    ],
  },
  {
    kase: {id: "references-mark-spawn-offload-host",intent: "references",subject: "markSpawnOffloadHost",tags: [],source: "authored"},
    why: "Imports plus calls plus a test mock reference.",
    origin: "paired with callers-mark-spawn-offload-host",
    seeds: [
      s("apps/operator/bin/hono-host-spawn-offload.test.ts", 25, "markSpawnOffloadHost"),
      s("apps/operator/bin/hono-host-spawn-offload.test.ts", 32, "markSpawnOffloadHost"),
      s("apps/operator/bin/hono-host-spawn-offload.test.ts", 36, "markSpawnOffloadHost"),
    ],
    neutral: [
      s("packages/operator-core/lib/fleet/git-via-sidecar.ts", 145, "markSpawnOffloadHost"),
    ],
  },
  {
    kase: {id: "references-integrator-tick-input-type",intent: "references",subject: "IntegratorTickInput",tags: [],source: "authored"},
    why: "A type used only in type positions; call graphs carry no edge for it.",
    origin: "type-only symbol beside runIntegratorTick",
    seeds: [
      s("packages/operator-core/lib/sync/pot-git/integrator-tick.ts", 228, "IntegratorTickInput"),
    ],
    neutral: [
      s("packages/operator-core/lib/sync/pot-git/integrator-tick.ts", 52, "IntegratorTickInput"),
    ],
  },
  {
    kase: {id: "references-handle-pr-poll-dynamic",intent: "references",subject: "handlePrPoll",tags: ["dynamic-dispatch"],source: "authored"},
    why: "The registration that passes the handler is a reference even though it is not a call.",
    origin: "registered with registerSystemAction and invoked by name",
    seeds: [
      s("packages/operator-core/lib/pr-host/poll-daemon.test.ts", 23, "handlePrPoll"),
      s("packages/operator-core/lib/pr-host/poll-daemon.test.ts", 604, "handlePrPoll"),
      s("packages/operator-core/lib/pr-host/poll-daemon.ts", 953, "handlePrPoll"),
    ],
    neutral: [
      s("packages/operator-core/lib/pr-host/poll-daemon.ts", 914, "handlePrPoll"),
    ],
  },
  {
    kase: {id: "references-absent-bundled-recipes-dir",intent: "references",subject: "bundledRecipesDir",tags: ["absence"],source: "authored"},
    why: "Siblings (bundledRubricsDir, bundledTemplatesDir) share a prefix; the subject itself has no references.",
    origin: "candidate scan: exported, zero references",
    seeds: [],
    neutral: [
      s("packages/operator-core/lib/cupboard/recipe-store.ts", 57, "bundledRecipesDir"),
    ],
  },
  {
    kase: {id: "symbol-claim-next-issue-work-item",intent: "symbol-search",subject: "claimNextIssueWorkItem",tags: [],source: "selective"},
    why: "A source symbol an earlier index omitted.",
    origin: "selective-corpus#selective-exact-index-symbol",
    seeds: [
      s("packages/operator-core/lib/work-items.ts", 8540, "claimNextIssueWorkItem"),
    ],
    neutral: [],
  },
  {
    kase: {id: "symbol-verdict-of-same-name",intent: "symbol-search",subject: "verdictOf",tags: ["same-name"],source: "authored"},
    why: "Exact-name search must return every declaration with that name.",
    origin: "paired with callers-verdict-of-same-name",
    seeds: [
      s("packages/operator-core/lib/code-intelligence/engine-comparison-provenance.integration.test.ts", 25, "verdictOf"),
      s("packages/operator-core/lib/plan-provenance-read.ts", 130, "verdictOf"),
      s("packages/operator-core/lib/pot-eval/supervision-metrics.ts", 67, "verdictOf"),
    ],
    neutral: [],
  },
  {
    kase: {id: "symbol-run-integrator-tick-same-name",intent: "symbol-search",subject: "runIntegratorTick",tags: ["same-name"],source: "authored"},
    why: "Exact-name search across a production function and a test-local helper.",
    origin: "paired with callers-run-integrator-tick-same-name",
    seeds: [
      s("packages/operator-core/lib/sync/pot-git/integrator-tick.integration.test.ts", 444, "runIntegratorTick"),
      s("packages/operator-core/lib/sync/pot-git/integrator-tick.ts", 228, "runIntegratorTick"),
    ],
    neutral: [],
  },
  {
    kase: {id: "symbol-absent-v2",intent: "symbol-search",subject: "claimNextIssueWorkItemV2",tags: ["absence"],source: "authored"},
    why: "Fuzzy search returns claimNextIssueWorkItem; exact search must return nothing.",
    origin: "plausible-but-nonexistent name",
    seeds: [],
    neutral: [],
  },
  {
    kase: {id: "text-publish-blueprint-route",intent: "text-search",subject: "/api/cupboard/publish-blueprint",tags: [],source: "selective"},
    why: "A URL literal that crosses the route boundary.",
    origin: "selective-corpus#selective-route-boundary",
    seeds: [
      s("packages/operator-core/lib/code-intelligence/selective-assist.integration.test.ts", 278, "/api/cupboard/publish-blueprint"),
      s("packages/operator-core/lib/code-intelligence/selective-corpus.ts", 81, "/api/cupboard/publish-blueprint"),
      s("packages/operator-core/lib/code-intelligence/selective-corpus.ts", 87, "/api/cupboard/publish-blueprint"),
    ],
    neutral: [],
  },
  {
    kase: {id: "text-shell-function",intent: "text-search",subject: "release_task_prepare_manifest_stage",tags: [],source: "mined-grep"},
    why: "A shell function referenced from bash and asserted on from JavaScript tests; a TypeScript-only index cannot see it.",
    origin: "mined grep demand (5 sessions)",
    seeds: [
      s("papercusp-desktop/test/release-gitleaks.test.js", 2036, "release_task_prepare_manifest_stage"),
      s("papercusp-desktop/test/release-local-linux-reuse.test.js", 1120, "release_task_prepare_manifest_stage"),
      s("papercusp-desktop/test/release-local-mac-sig-collection.test.js", 31, "release_task_prepare_manifest_stage"),
    ],
    neutral: [],
  },
  {
    kase: {id: "text-env-var",intent: "text-search",subject: "PAPERCUSP_RG_BIN",tags: [],source: "authored"},
    why: "An environment variable literal.",
    origin: "env var read by the engine-comparison rg arm",
    seeds: [
      s("packages/operator-core/lib/code-intelligence/engine-comparison-arms.ts", 134, "PAPERCUSP_RG_BIN"),
    ],
    neutral: [],
  },
  {
    kase: {id: "text-sql-table",intent: "text-search",subject: "migration_reservations",tags: [],source: "authored"},
    why: "Spans SQL, TypeScript and Markdown.",
    origin: "a table named in SQL migrations, TypeScript and docs",
    seeds: [
      s("apps/operator/lib/release/migrate.ts", 14, "migration_reservations"),
      s("apps/operator/scripts/hooks/cc/__tests__/pretooluse-unreserved-migration-guard.test.ts", 80, "migration_reservations"),
      s("apps/operator/scripts/hooks/cc/__tests__/pretooluse-unreserved-migration-guard.test.ts", 93, "migration_reservations"),
    ],
    neutral: [],
  },
  {
    kase: {id: "text-absent-literal",intent: "text-search",subject: "PAPERCUSP_DISABLE_GITNEXUS_ROUTING",tags: ["absence"],source: "authored"},
    why: "Does not exist anywhere; any hit is a false positive.",
    origin: "plausible-but-nonexistent env var",
    seeds: [],
    neutral: [],
  },
]);
