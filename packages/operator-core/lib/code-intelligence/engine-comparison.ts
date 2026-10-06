/**
 * P-005 — bounded, comparable code-intelligence ENGINE evaluation
 * (plan `gitnexus-selective-hardening-and-comparison-2026-09-13`, R-8 / R-9).
 *
 * Four arms answer the SAME frozen tasks on a byte-identical bounded source
 * tree: scripted `rg` baseline, the installed GitNexus, one pinned GitNexus
 * upgrade candidate, and the Codebase-Memory CLI. This file is the arm-agnostic
 * RUNNER + SCORER; the subprocess adapters live in `engine-comparison-arms.ts`
 * and the evidence-producing CLI in `engine-comparison-cli.ts`.
 *
 * ## What is reused (extend, don't fork)
 *  - `SELECTIVE_ACCEPTANCE_CORPUS` is the question set and `gradeSites` is the
 *    ONE grader — an arm never grades itself.
 *  - `@papercusp/bench-metrics` `buildFairnessAudit` audits the comparison:
 *    every (arm, case) becomes a `TaskRunResult` row, tool-level, so tokens are
 *    ZERO and response bytes are reported separately as the context cost.
 *
 * ## Four distinct measurements (never conflated)
 *  cold INDEX (wall, peak RSS, disk) · first-query-after-index (cold cache) ·
 *  WARM query (median of N) · update/recovery (edit, delete, refresh-failure).
 *
 * ## The disposition rule is PRE-REGISTERED here
 * `decideDisposition` is a pure function of the measured reports with its bars
 * as named constants, written BEFORE any run so the keep/upgrade/replace call
 * cannot be reverse-fitted to the data. An unavailable or errored required arm
 * is explicit NONPASSING RESIDUE — never self-waived.
 */
import { buildFairnessAudit, type FairnessAudit, type TaskRunResult } from '@papercusp/bench-metrics';
import type { CorpusCase } from './acceptance-corpus';
import { gradeSites, median, type GradeResult } from './code-intel-bench';
import type { SymbolSite } from './contracts';

export type EngineArmId =
  | 'baseline-lsp-rg'
  | 'gitnexus-installed'
  | 'gitnexus-candidate'
  | 'codebase-memory'
  | (string & {});

export interface EngineQueryResult {
  readonly sites: readonly SymbolSite[];
  /** Bytes the engine returned to the caller — the context-cost proxy. */
  readonly responseBytes: number;
  readonly error: string | null;
}

export interface PhaseCost {
  readonly wallMs: number;
  readonly peakRssKb: number | null;
  readonly ok: boolean;
  readonly error: string | null;
  readonly loadAvg1: number | null;
}

export interface EngineArm {
  readonly id: EngineArmId;
  readonly version: string;
  /** This arm's OWN copy of the bounded tree (own index, own scratch HOME). */
  readonly treeRoot: string;
  /** Non-null ⇒ the arm could not be run; recorded as explicit residue. */
  readonly unavailable: string | null;
  index(): Promise<PhaseCost>;
  refresh(): Promise<PhaseCost>;
  query(kase: CorpusCase): Promise<EngineQueryResult>;
  indexBytes(): Promise<number | null>;
}

export interface EngineComparisonDeps {
  now(): number;
  loadAvg1(): number | null;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  rm(path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  /** Restore tracked paths from the arm tree's own git baseline commit. */
  gitRestore(root: string, relPaths: readonly string[]): Promise<void>;
  treeFingerprint(root: string): Promise<string | null>;
}

// ── fixtures ────────────────────────────────────────────────────────────────

export const EDIT_FIXTURE = Object.freeze({
  file: 'packages/operator-core/lib/scheduler/get-next.ts',
  symbol: 'engineBenchEditProbe',
  appended: '\nexport function engineBenchEditProbe(): string {\n  return typeof getNextWorkItem;\n}\n',
});

export const DELETE_FIXTURE = Object.freeze({
  /** Defines the production design consumer pinned by `selective-external-consumer`. */
  file: 'packages/operator-core/lib/design-compare/acceptance.ts',
  /** The corpus case whose answer must stop naming the deleted file. */
  caseId: 'selective-external-consumer',
});

export const REFRESH_FAILURE_FIXTURE = Object.freeze({
  /** Made unreadable during refresh; no graded expected site lives under it. */
  dir: 'scripts',
});

// ── report shapes ───────────────────────────────────────────────────────────

export interface CaseMeasurement {
  readonly caseId: string;
  readonly intent: string;
  readonly coldQueryMs: number;
  readonly warmQueryMs: number | null;
  readonly warmSamplesMs: readonly number[];
  readonly responseBytes: number;
  /** bytes/4 — a crude, identical-for-every-arm token estimate. */
  readonly estTokens: number;
  readonly correct: boolean;
  /** found expected sites / expected sites (consumer-coverage recall). */
  readonly recall: number;
  readonly grade: GradeResult;
  readonly returnedSites: readonly string[];
  readonly error: string | null;
}

export interface UpdateFixtureResult {
  readonly name: 'edit' | 'delete' | 'refresh-failure';
  readonly pass: boolean;
  readonly detail: string;
  readonly refreshCost: PhaseCost | null;
  readonly recoveryCost: PhaseCost | null;
  /** refresh-failure only: did the engine REPORT the failed refresh. */
  readonly faultSurfaced: boolean | null;
}

export interface ArmReport {
  readonly armId: EngineArmId;
  readonly version: string;
  readonly unavailable: string | null;
  readonly treeFingerprint: string | null;
  readonly coldIndex: PhaseCost | null;
  readonly indexBytes: number | null;
  readonly cases: readonly CaseMeasurement[];
  readonly fixtures: readonly UpdateFixtureResult[];
  readonly error: string | null;
  /**
   * ISO instant the arm run FINISHED, recorded INSIDE the report by the CLI at arm-run time. Run identity
   * (`deriveRunMeta`) is derived from this CONTENT, never from file mtimes (which a copy/clone resets) or the
   * wall clock at aggregate time (EI-24858052475884275). Absent on legacy reports → epoch fallback.
   */
  readonly measuredAt?: string;
}

export interface RunOptions {
  readonly warmSamples: number;
  readonly cases: readonly CorpusCase[];
}

const sitesKey = (s: readonly SymbolSite[]): string[] =>
  s.map((x) => `${x.path}:${x.line1 ?? '?'}`);

const recallOf = (kase: CorpusCase, sites: readonly SymbolSite[]): number => {
  if (kase.expectedSites.length === 0) return 1;
  const got = new Set(sitesKey(sites));
  const found = kase.expectedSites.filter((e) => got.has(`${e.path}:${e.line1}`)).length;
  return found / kase.expectedSites.length;
};

/**
 * Did the engine ANSWER? `error` is a caveat channel, not a failure flag: the GitNexus facade puts
 * non-failure notices there (index health unmeasured — the bench CLI dispatch has no `list_repos` —,
 * FILE-level edge counts, truncation) beside real sites. Only "error AND nothing returned" is a
 * failed/declined query. Grading every non-null `error` as a failure scored both GitNexus arms 0 by
 * construction while baseline/CBM (which never set `error` on success) were graded on content (WI-10001405).
 */
export const answered = (res: Pick<EngineQueryResult, 'error' | 'sites'>): boolean => !(res.error !== null && res.sites.length === 0);

const withNote = (reason: string, res: Pick<EngineQueryResult, 'error'>): string => (res.error === null ? reason : `${reason} [engine note: ${res.error}]`);

async function measureCase(
  arm: EngineArm,
  kase: CorpusCase,
  warmSamples: number,
  deps: EngineComparisonDeps,
): Promise<CaseMeasurement> {
  const t0 = deps.now();
  const first = await arm.query(kase);
  const coldQueryMs = deps.now() - t0;
  const samples: number[] = [];
  let last = first;
  for (let i = 0; i < warmSamples; i += 1) {
    const s = deps.now();
    last = await arm.query(kase);
    samples.push(deps.now() - s);
  }
  const grade = gradeSites(kase, first.sites);
  return {
    caseId: kase.id,
    intent: kase.intent,
    coldQueryMs,
    warmQueryMs: median(samples),
    warmSamplesMs: samples,
    responseBytes: first.responseBytes,
    estTokens: Math.ceil(first.responseBytes / 4),
    correct: answered(first) && grade.correct,
    recall: answered(first) ? recallOf(kase, first.sites) : 0,
    grade,
    returnedSites: sitesKey(first.sites).slice(0, 25),
    error: first.error ?? last.error,
  };
}

const failedPhase = (e: unknown, deps: EngineComparisonDeps): PhaseCost => ({
  wallMs: 0, peakRssKb: null, ok: false, error: e instanceof Error ? e.message : String(e), loadAvg1: deps.loadAvg1(),
});

async function runEditFixture(arm: EngineArm, deps: EngineComparisonDeps): Promise<UpdateFixtureResult> {
  const abs = `${arm.treeRoot}/${EDIT_FIXTURE.file}`;
  const original = await deps.readFile(abs);
  const expectedLine = original.split('\n').length + 1;
  const kase: CorpusCase = {
    id: 'fixture-edit-new-symbol', planCase: 0, intent: 'symbol-search',
    title: 'A symbol added after the index was built', query: EDIT_FIXTURE.symbol,
    gradeMode: 'must-contain',
    expectedSites: [{ path: EDIT_FIXTURE.file, line1: expectedLine, symbolOnLine: `export function ${EDIT_FIXTURE.symbol}` }],
    eligibleBackends: [], falsifies: 'A stale index never sees the edit.',
  };
  let refreshCost: PhaseCost | null = null;
  let recoveryCost: PhaseCost | null = null;
  try {
    await deps.writeFile(abs, original + EDIT_FIXTURE.appended);
    refreshCost = await arm.refresh();
    const res = await arm.query(kase);
    const grade = gradeSites(kase, res.sites);
    return { name: 'edit', pass: answered(res) && refreshCost.ok && grade.correct, detail: withNote(grade.reason, res), refreshCost, recoveryCost: null, faultSurfaced: null };
  } catch (e) {
    return { name: 'edit', pass: false, detail: e instanceof Error ? e.message : String(e), refreshCost, recoveryCost, faultSurfaced: null };
  } finally {
    await deps.writeFile(abs, original);
    recoveryCost = await arm.refresh().catch((e) => failedPhase(e, deps));
  }
}

async function runDeleteFixture(arm: EngineArm, kase: CorpusCase, deps: EngineComparisonDeps): Promise<UpdateFixtureResult> {
  const abs = `${arm.treeRoot}/${DELETE_FIXTURE.file}`;
  let refreshCost: PhaseCost | null = null;
  try {
    await deps.rm(abs);
    refreshCost = await arm.refresh();
    const res = await arm.query(kase);
    const stale = sitesKey(res.sites).filter((k) => k.startsWith(`${DELETE_FIXTURE.file}:`));
    return {
      name: 'delete', pass: answered(res) && refreshCost.ok && stale.length === 0,
      detail: withNote(
        !answered(res) ? 'query FAILED (error and no sites)' : stale.length ? `STALE sites still returned for deleted file: ${stale.join(', ')}` : 'no site from the deleted file is returned',
        res,
      ),
      refreshCost, recoveryCost: null, faultSurfaced: null,
    };
  } catch (e) {
    return { name: 'delete', pass: false, detail: e instanceof Error ? e.message : String(e), refreshCost, recoveryCost: null, faultSurfaced: null };
  } finally {
    await deps.gitRestore(arm.treeRoot, [DELETE_FIXTURE.file]).catch(() => undefined);
    await arm.refresh().catch((e) => failedPhase(e, deps));
  }
}

async function runRefreshFailureFixture(
  arm: EngineArm,
  cases: readonly CorpusCase[],
  coldCorrect: number,
  deps: EngineComparisonDeps,
): Promise<UpdateFixtureResult> {
  const dir = `${arm.treeRoot}/${REFRESH_FAILURE_FIXTURE.dir}`;
  let refreshCost: PhaseCost | null = null;
  let recoveryCost: PhaseCost | null = null;
  let correctWhileBroken = 0;
  try {
    await deps.chmod(dir, 0o000);
    refreshCost = await arm.refresh().catch((e) => failedPhase(e, deps));
    for (const kase of cases) {
      const res = await arm.query(kase).catch((e): EngineQueryResult => ({ sites: [], responseBytes: 0, error: String(e) }));
      if (answered(res) && gradeSites(kase, res.sites).correct) correctWhileBroken += 1;
    }
  } finally {
    await deps.chmod(dir, 0o755);
    recoveryCost = await arm.refresh().catch((e) => failedPhase(e, deps));
  }
  let correctAfter = 0;
  for (const kase of cases) {
    const res = await arm.query(kase).catch((e): EngineQueryResult => ({ sites: [], responseBytes: 0, error: String(e) }));
    if (answered(res) && gradeSites(kase, res.sites).correct) correctAfter += 1;
  }
  const faultSurfaced = refreshCost !== null && !refreshCost.ok;
  const recovered = recoveryCost.ok && correctAfter >= coldCorrect;
  // The fixture asks "does the engine keep answering as well as it did cold while a refresh is broken, and recover?".
  // With nothing correct cold, `>= 0` holds for ANY engine — a vacuous pass that would credit an engine that never
  // answered a case. Not measurable ⇒ not a pass (WI-10001405).
  const vacuous = coldCorrect === 0;
  return {
    name: 'refresh-failure',
    pass: !vacuous && recovered && correctWhileBroken >= coldCorrect,
    detail: `fault ${faultSurfaced ? 'SURFACED' : 'SILENT'}; correct cold=${coldCorrect} while-broken=${correctWhileBroken} after-restore=${correctAfter}; recovery refresh ok=${recoveryCost.ok}${vacuous ? '; NOT MEASURABLE: no case was correct cold, so a pass would be vacuous' : ''}`,
    refreshCost, recoveryCost, faultSurfaced,
  };
}

/** Run one arm end-to-end. Never throws: a failure becomes `error` residue. */
export async function runEngineArm(arm: EngineArm, opts: RunOptions, deps: EngineComparisonDeps): Promise<ArmReport> {
  const base = { armId: arm.id, version: arm.version, unavailable: arm.unavailable };
  if (arm.unavailable) {
    return { ...base, treeFingerprint: null, coldIndex: null, indexBytes: null, cases: [], fixtures: [], error: null };
  }
  try {
    const treeFingerprint = await deps.treeFingerprint(arm.treeRoot);
    const coldIndex = await arm.index();
    const indexBytes = await arm.indexBytes();
    if (!coldIndex.ok) {
      return { ...base, treeFingerprint, coldIndex, indexBytes, cases: [], fixtures: [], error: `cold index failed: ${coldIndex.error}` };
    }
    const cases: CaseMeasurement[] = [];
    for (const kase of opts.cases) cases.push(await measureCase(arm, kase, opts.warmSamples, deps));
    const coldCorrect = cases.filter((c) => c.correct).length;
    const deleteCase = opts.cases.find((c) => c.id === DELETE_FIXTURE.caseId);
    const fixtures: UpdateFixtureResult[] = [];
    fixtures.push(await runEditFixture(arm, deps));
    if (deleteCase) fixtures.push(await runDeleteFixture(arm, deleteCase, deps));
    fixtures.push(await runRefreshFailureFixture(arm, opts.cases, coldCorrect, deps));
    return { ...base, treeFingerprint, coldIndex, indexBytes, cases, fixtures, error: null };
  } catch (e) {
    return { ...base, treeFingerprint: null, coldIndex: null, indexBytes: null, cases: [], fixtures: [], error: e instanceof Error ? e.message : String(e) };
  }
}

// ── scoring ─────────────────────────────────────────────────────────────────

export interface ArmSummary {
  readonly armId: EngineArmId;
  readonly available: boolean;
  readonly correct: number;
  readonly total: number;
  readonly meanRecall: number;
  readonly coldIndexMs: number | null;
  readonly peakRssKb: number | null;
  readonly indexBytes: number | null;
  readonly warmMedianMs: number | null;
  readonly responseBytes: number;
  readonly fixturesPassed: number;
  readonly fixturesTotal: number;
  readonly faultSurfaced: boolean | null;
}

export function summarizeArm(r: ArmReport): ArmSummary {
  const warm = r.cases.map((c) => c.warmQueryMs).filter((x): x is number => x !== null);
  return {
    armId: r.armId,
    available: r.unavailable === null && r.error === null && r.coldIndex?.ok === true,
    correct: r.cases.filter((c) => c.correct).length,
    total: r.cases.length,
    meanRecall: r.cases.length === 0 ? 0 : r.cases.reduce((s, c) => s + c.recall, 0) / r.cases.length,
    coldIndexMs: r.coldIndex?.wallMs ?? null,
    peakRssKb: r.coldIndex?.peakRssKb ?? null,
    indexBytes: r.indexBytes,
    warmMedianMs: median(warm),
    responseBytes: r.cases.reduce((s, c) => s + c.responseBytes, 0),
    fixturesPassed: r.fixtures.filter((f) => f.pass).length,
    fixturesTotal: r.fixtures.length,
    faultSurfaced: r.fixtures.find((f) => f.name === 'refresh-failure')?.faultSurfaced ?? null,
  };
}

/** Pre-registered bars. A candidate must clear ALL of them to change the serving backend. */
export const DISPOSITION_BARS = Object.freeze({
  /** A challenger must not be MORE than this factor worse than installed on any resource. */
  maxResourceRegression: 1.25,
  /** …and to count as a resource WIN it must be at least this factor better. */
  resourceWinFactor: 0.8,
});

export type Disposition = 'keep' | 'upgrade' | 'replace' | 'inconclusive';

export interface DispositionVerdict {
  readonly decision: Disposition;
  readonly reasons: readonly string[];
  /** Required arms that were unavailable/errored — NONPASSING residue, never waived. */
  readonly residue: readonly string[];
}

const ratio = (a: number | null, b: number | null): number | null =>
  a === null || b === null || b === 0 ? null : a / b;

function clears(ch: ArmSummary, ref: ArmSummary): { pass: boolean; wins: string[]; fails: string[] } {
  const wins: string[] = [];
  const fails: string[] = [];
  if (ch.correct < ref.correct) fails.push(`correct ${ch.correct}/${ch.total} < installed ${ref.correct}/${ref.total}`);
  else if (ch.correct > ref.correct) wins.push(`correct ${ch.correct} > ${ref.correct}`);
  if (ch.meanRecall + 1e-9 < ref.meanRecall) fails.push(`recall ${ch.meanRecall.toFixed(2)} < ${ref.meanRecall.toFixed(2)}`);
  else if (ch.meanRecall > ref.meanRecall + 1e-9) wins.push(`recall ${ch.meanRecall.toFixed(2)} > ${ref.meanRecall.toFixed(2)}`);
  if (ch.fixturesPassed < ch.fixturesTotal) fails.push(`update fixtures ${ch.fixturesPassed}/${ch.fixturesTotal}`);
  else if (ch.fixturesPassed > ref.fixturesPassed) wins.push(`update fixtures ${ch.fixturesPassed} > ${ref.fixturesPassed}`);
  for (const [label, a, b] of [
    ['coldIndexMs', ch.coldIndexMs, ref.coldIndexMs],
    ['peakRssKb', ch.peakRssKb, ref.peakRssKb],
    ['indexBytes', ch.indexBytes, ref.indexBytes],
    ['warmMedianMs', ch.warmMedianMs, ref.warmMedianMs],
  ] as const) {
    const r = ratio(a, b);
    if (r === null) continue;
    if (r > DISPOSITION_BARS.maxResourceRegression) fails.push(`${label} ${r.toFixed(2)}x installed`);
    else if (r <= DISPOSITION_BARS.resourceWinFactor) wins.push(`${label} ${r.toFixed(2)}x installed`);
  }
  return { pass: fails.length === 0, wins, fails };
}

/**
 * keep | upgrade | replace — from measured summaries only. Installed GitNexus is
 * the reference; the candidate yields `upgrade`, Codebase-Memory yields `replace`.
 */
export function decideDisposition(reports: readonly ArmReport[]): DispositionVerdict {
  const by = new Map(reports.map((r) => [r.armId, summarizeArm(r)] as const));
  const installed = by.get('gitnexus-installed');
  const required: EngineArmId[] = ['baseline-lsp-rg', 'gitnexus-installed', 'gitnexus-candidate', 'codebase-memory'];
  const residue = required.filter((id) => !by.get(id)?.available).map((id) => `${id}: unavailable or errored — nonpassing residue`);
  if (!installed?.available) {
    return { decision: 'inconclusive', reasons: ['installed GitNexus reference arm did not run; no comparison is possible'], residue };
  }
  const reasons: string[] = [];
  const cand = by.get('gitnexus-candidate');
  const cbm = by.get('codebase-memory');
  // GN-BENCH-PROVENANCE: a winner may only be declared when every executed arm ran on the SAME
  // source snapshot. A mismatched tree fingerprint cannot attribute a win to the engine, so it
  // downgrades a would-be upgrade/replace to `inconclusive` (it never creates or hides a `keep`).
  const parity = sourceParity(reports);
  const parityBlock = parity.same
    ? null
    : `source parity failed — arms ran on different tree fingerprints (${Object.entries(parity.fingerprints)
        .map(([id, fp]) => `${id}=${fp ?? 'null'}`)
        .join(', ')}); no winner can be declared`;
  const cbmClear = cbm?.available ? clears(cbm, installed) : null;
  if (cbmClear?.pass && cbmClear.wins.length > 0) {
    reasons.push(`Codebase-Memory clears every bar and wins: ${cbmClear.wins.join('; ')}`);
    if (parityBlock) return { decision: 'inconclusive', reasons: [...reasons, parityBlock], residue };
    return { decision: 'replace', reasons, residue };
  }
  if (cbmClear) reasons.push(`Codebase-Memory does not replace: ${cbmClear.fails.join('; ') || 'no win over installed'}`);
  const candClear = cand?.available ? clears(cand, installed) : null;
  if (candClear?.pass && candClear.wins.length > 0) {
    reasons.push(`candidate clears every bar and wins: ${candClear.wins.join('; ')}`);
    if (parityBlock) return { decision: 'inconclusive', reasons: [...reasons, parityBlock], residue };
    return { decision: 'upgrade', reasons, residue };
  }
  if (candClear) reasons.push(`candidate does not upgrade: ${candClear.fails.join('; ') || 'no win over installed'}`);
  if (residue.length > 0 && !(cand?.available && cbm?.available)) {
    return { decision: 'inconclusive', reasons: [...reasons, 'a required challenger arm did not run'], residue };
  }
  return { decision: 'keep', reasons, residue };
}

// ── fairness (bench-metrics) ────────────────────────────────────────────────

export interface EngineRunMeta {
  readonly runId: string;
  readonly seed: number;
  readonly createdAt: string;
  readonly preregHash: string;
}

/** One tool-level `TaskRunResult` per (arm, case): zero LLM tokens, identical grader. */
export function toTaskRunRows(reports: readonly ArmReport[], meta: EngineRunMeta): TaskRunResult[] {
  const rows: TaskRunResult[] = [];
  for (const r of reports) {
    for (const c of r.cases) {
      rows.push({
        runId: meta.runId, suite: 'code-intel-engine-comparison', modality: 'qa',
        taskId: c.caseId, arm: r.armId, seed: meta.seed,
        resolved: c.correct, graderStatus: c.error ? 'error' : c.correct ? 'passed' : 'failed',
        graderFamily: 'code-intel-gradeSites', graderVersion: 'gradeSites@selective-corpus-v1',
        score: c.recall,
        tokensIn: 0, tokensOut: 0, tokensTotal: 0, costUsd: 0, priceTableVersion: 'none-tool-level',
        wallClockMs: Math.round(c.coldQueryMs), turns: 1 + c.warmSamplesMs.length,
        budgetTokens: null, capped: false, generationStatus: c.error ? 'error' : 'completed',
        armMeta: { responseBytes: c.responseBytes, estTokens: c.estTokens },
        modelId: 'none-tool-only', harnessVersion: r.version, preregHash: meta.preregHash,
        rolloutId: `${meta.runId}:${r.armId}:${c.caseId}`, createdAt: meta.createdAt,
      } as TaskRunResult);
    }
  }
  return rows;
}

export function buildEngineFairnessAudit(reports: readonly ArmReport[], meta: EngineRunMeta): FairnessAudit {
  return buildFairnessAudit(toTaskRunRows(reports, meta), { referenceArm: 'gitnexus-installed' });
}

/** Source-parity evidence: every available arm must report the SAME tree fingerprint. */
export function sourceParity(reports: readonly ArmReport[]): { same: boolean; fingerprints: Record<string, string | null> } {
  const fingerprints: Record<string, string | null> = {};
  for (const r of reports) if (!r.unavailable) fingerprints[r.armId] = r.treeFingerprint;
  const vals = Object.values(fingerprints);
  return { same: vals.length > 0 && vals.every((v) => v !== null && v === vals[0]), fingerprints };
}

export function formatComparisonMarkdown(reports: readonly ArmReport[]): string {
  const head = '| arm | version | correct | recall | cold index s | peak RSS MB | index MB | warm med ms | resp KB | fixtures | fault |';
  const sep = '|---|---|---|---|---|---|---|---|---|---|---|';
  const f = (n: number | null, d: number, div = 1): string => (n === null ? 'n/a' : (n / div).toFixed(d));
  const rows = reports.map((r) => {
    const s = summarizeArm(r);
    if (!s.available) return `| ${r.armId} | ${r.version} | UNAVAILABLE: ${r.unavailable ?? r.error ?? 'index failed'} |||||||||`;
    return `| ${r.armId} | ${r.version} | ${s.correct}/${s.total} | ${s.meanRecall.toFixed(2)} | ${f(s.coldIndexMs, 1, 1000)} | ${f(s.peakRssKb, 0, 1024)} | ${f(s.indexBytes, 0, 1048576)} | ${f(s.warmMedianMs, 0)} | ${f(s.responseBytes, 1, 1024)} | ${s.fixturesPassed}/${s.fixturesTotal} | ${s.faultSurfaced === null ? 'n/a' : s.faultSurfaced ? 'surfaced' : 'SILENT'} |`;
  });
  return [head, sep, ...rows].join('\n');
}
