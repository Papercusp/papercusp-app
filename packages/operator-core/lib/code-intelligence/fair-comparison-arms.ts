/**
 * P-017 arm adapters (plan `gitnexus-deterministic-integration-2026-10-05`,
 * D-011): one interface every engine answers the fair corpus through, and the
 * conformance check that separates ADAPTER defects from engine weakness.
 *
 * Scoring lives in fair-comparison.ts and is pure. This file holds what talks to
 * the outside world: wrapping a 2026-10-02 `EngineArm` (rg, reused rather than
 * re-written), classifying how a query failed, and writing the micro repo to
 * disk. GitNexus and codebase-memory have their own adapters in
 * fair-comparison-engines.ts (D-015): their 2026-10-02 arms cap answers and
 * never receive anchorFile or depth.
 *
 * A failed query is never an empty answer. D-011 requires declined, crashed,
 * timed-out and stale-index outcomes to be reported apart from wrong answers, so
 * every adapter returns an `AnswerStatus` and `sites` is empty unless the arm
 * actually answered.
 */
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CorpusCase } from './acceptance-corpus';
import type { EngineArm, PhaseCost } from './engine-comparison';
import { createRgBaselineArm, type ArmDeps } from './engine-comparison-arms';
import type { AnswerKey, AnswerStatus, ArmAnswer, ArmCapabilities, CaseScore, FairCase, FairIntent, OutcomeClass } from './fair-comparison';
import { scoreCase } from './fair-comparison';
import { MICRO_REPO_FILES } from './fair-comparison-micro-repo';

/** One engine as the fair comparison sees it. */
export interface FairArm {
  readonly capabilities: ArmCapabilities;
  /** Non-null when the arm cannot run on this host (binary missing, licence not admitted): reported, never scored. */
  readonly unavailable: string | null;
  index(): Promise<PhaseCost>;
  query(kase: FairCase): Promise<ArmAnswer>;
  /** Release a long-lived engine process (an MCP server session), when the arm holds one. */
  close?(): Promise<void>;
}

/**
 * How a query failed, from the error text an arm produced. `null` means it
 * answered. Order matters: a decline names itself, a deadline is reported by
 * `timeout` as exit 124 (or 137 after the kill grace), and anything else that
 * failed is a crash.
 */
export function classifyArmError(error: string | null): AnswerStatus {
  if (error === null) return 'answered';
  const e = error.trim();
  if (/^declined\b/i.test(e)) return 'declined';
  if (/\bstale[- ]index\b|\bindex is stale\b|\bstale\b.*\bindex\b/i.test(e)) return 'stale-index';
  if (/\bexit (124|137)\b|\bdeadline\b|\btimed?[- ]?out\b|\bETIMEDOUT\b/i.test(e)) return 'timed-out';
  return 'crashed';
}

/** The CorpusCase shape the 2026-10-02 arms read: only id, intent and the query text drive them. */
export function toCorpusCase(kase: FairCase): CorpusCase {
  return {
    id: kase.id,
    planCase: 0,
    intent: kase.intent,
    title: kase.id,
    query: kase.subject,
    gradeMode: 'must-contain',
    expectedSites: [],
    eligibleBackends: [],
    falsifies: 'P-017 fair-comparison case (scored by fair-comparison.ts, not by gradeMode)',
  };
}

const answer = (kase: FairCase, status: AnswerStatus, latencyMs: number, sites: ArmAnswer['sites'], detail: string | null): ArmAnswer => ({
  caseId: kase.id,
  status,
  sites: status === 'answered' ? sites : [],
  latencyMs,
  ...(detail === null ? {} : { detail }),
});

/** What one engine call produced: sites, or an error string (null = answered), plus an optional note on an answer. */
export interface RawReply {
  readonly sites: ArmAnswer['sites'];
  readonly error: string | null;
  readonly note?: string | null;
}

/**
 * The one query path every adapter goes through. An intent the arm does not
 * declare is declined without querying (the scorer counts it `undeclared`, not
 * wrong); an error string or a thrown error becomes a typed status instead of an
 * empty answer; latency is the wall time of the engine call alone.
 */
export function guardedArm(spec: {
  capabilities: ArmCapabilities;
  unavailable: string | null;
  index(): Promise<PhaseCost>;
  ask(kase: FairCase): Promise<RawReply>;
  close?(): Promise<void>;
  now?: () => number;
}): FairArm {
  const now = spec.now ?? (() => performance.now());
  return {
    capabilities: spec.capabilities,
    unavailable: spec.unavailable,
    index: () => spec.index(),
    ...(spec.close ? { close: spec.close } : {}),
    async query(kase) {
      if (!spec.capabilities.intents.includes(kase.intent)) {
        return answer(kase, 'declined', 0, [], `undeclared intent '${kase.intent}'`);
      }
      const t0 = now();
      try {
        const r = await spec.ask(kase);
        return answer(kase, classifyArmError(r.error), now() - t0, r.sites, r.error ?? r.note ?? null);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return answer(kase, classifyArmError(msg), now() - t0, [], msg);
      }
    },
  };
}

/** Wrap a 2026-10-02 EngineArm (rg, GitNexus, codebase-memory) — reused, not re-written. */
export function fromEngineArm(engine: EngineArm, capabilities: ArmCapabilities, now: () => number = () => performance.now()): FairArm {
  return guardedArm({
    capabilities,
    unavailable: engine.unavailable,
    index: () => engine.index(),
    ask: (kase) => engine.query(toCorpusCase(kase)),
    now,
  });
}

/**
 * The rg baseline's intents: what scripted grep can be asked. It has no symbol
 * table, so definition, references and impact are not declared.
 */
export const RG_INTENTS: readonly FairIntent[] = ['callers', 'callees', 'symbol-search', 'text-search'];

/** The 2026-10-02 scripted-rg baseline as a fair arm. */
export function createRgFairArm(treeRoot: string, deps: ArmDeps, rgBin?: string): FairArm {
  const engine = createRgBaselineArm(treeRoot, deps, ...(rgBin ? [rgBin] : []));
  return fromEngineArm(engine, { armId: 'rg', version: engine.version, intents: RG_INTENTS, licence: 'permissive' });
}

export interface AdapterDefect {
  readonly caseId: string;
  readonly outcome: OutcomeClass;
  readonly why: string;
}

/**
 * A defect shown to be the engine's own, not the adapter's: reproduced by
 * calling the engine directly, outside the adapter, with the evidence recorded.
 * It matches one case and one outcome, and for a crash one error pattern, so a
 * different failure on the same case is still a defect.
 */
export interface AcceptedEngineFault {
  readonly caseId: string;
  readonly outcome: OutcomeClass;
  /** Required for `crashed`: the engine's error must match it. */
  readonly detail?: RegExp;
  readonly evidence: string;
}

export interface ConformanceReport {
  readonly armId: string;
  readonly scores: readonly CaseScore[];
  /** Plain declared cases not answered exactly, and any crash: adapter defects until shown otherwise. */
  readonly defects: readonly AdapterDefect[];
  /** Defects matched by an AcceptedEngineFault: measured engine faults, reported, never blocking. */
  readonly acceptedFaults: readonly (AdapterDefect & { readonly evidence: string })[];
  /** Accepted faults that did not occur this run: the engine changed, so the acceptance is stale and should be removed. */
  readonly unusedAcceptances: readonly string[];
  readonly ok: boolean;
}

/**
 * A partial answer with perfect precision: every site is right, some units are
 * missing. On a plain micro case that is an engine answering at a coarser
 * granularity than D-012's unit (trace-mcp names the referencing file, not each
 * line), not an adapter bug — a bad parser or line base returns WRONG sites.
 */
const coarser = (s: CaseScore): boolean => s.outcome === 'partial' && s.precision === 1;

/**
 * Run an arm over the micro repo and name every adapter defect. A PLAIN case
 * (no hardness tag) that the arm declares must come back `correct`, or partial
 * with perfect precision (`coarser`): the engine supports the intent and the
 * micro repo has no trap, so a wrong site or an empty answer is our parser,
 * line base or intent mapping until shown otherwise. A crash on ANY case is a
 * defect too. Hard cases are reported in `scores` but never counted as defects:
 * that is the engine being measured.
 */
export async function runConformance(
  arm: FairArm,
  cases: readonly FairCase[],
  keys: readonly AnswerKey[],
  accepted: readonly AcceptedEngineFault[] = [],
): Promise<ConformanceReport> {
  for (const a of accepted) {
    if (a.outcome === 'crashed' && !a.detail) throw new Error(`accepted crash on ${a.caseId} needs a detail pattern`);
    if (!a.evidence.trim()) throw new Error(`accepted fault on ${a.caseId} has no evidence`);
  }
  const keyOf = new Map(keys.map((k) => [k.caseId, k]));
  const scores: CaseScore[] = [];
  const defects: AdapterDefect[] = [];
  const acceptedFaults: (AdapterDefect & { evidence: string })[] = [];
  const used = new Set<AcceptedEngineFault>();
  const record = (d: AdapterDefect, detail: string) => {
    const hit = accepted.find((a) => a.caseId === d.caseId && a.outcome === d.outcome && (!a.detail || a.detail.test(detail)));
    if (!hit) return defects.push(d);
    used.add(hit);
    return acceptedFaults.push({ ...d, evidence: hit.evidence });
  };
  for (const kase of cases) {
    const key = keyOf.get(kase.id);
    if (!key) throw new Error(`no answer key for micro case ${kase.id}`);
    const ans = await arm.query(kase);
    const score = scoreCase(kase, arm.capabilities, key, ans);
    scores.push(score);
    if (score.outcome === 'crashed') {
      record({ caseId: kase.id, outcome: score.outcome, why: ans.detail ?? 'crashed without detail' }, ans.detail ?? '');
    } else if (kase.tags.length === 0 && score.outcome !== 'undeclared' && score.outcome !== 'correct' && !coarser(score)) {
      const got = ans.sites.map((s) => `${s.path}:${s.line1 ?? '?'}`).join(', ') || '(none)';
      record(
        { caseId: kase.id, outcome: score.outcome, why: `plain case: expected ${key.sites.join(', ')}; got ${got}${ans.detail ? ` (${ans.detail})` : ''}` },
        ans.detail ?? '',
      );
    }
  }
  const unusedAcceptances = accepted.filter((a) => !used.has(a)).map((a) => `${a.caseId}:${a.outcome}`);
  return { armId: arm.capabilities.armId, scores, defects, acceptedFaults, unusedAcceptances, ok: defects.length === 0 };
}

const git = (cwd: string, args: readonly string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile('git', [...args], { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } }, (err, _out, stderr) =>
      err ? reject(new Error(`git ${args[0]} failed: ${String(stderr).trim() || err.message}`)) : resolve(),
    );
  });

/**
 * Write the micro repo (markers stripped) into `dir`, and by default make it a
 * one-commit git repository: several engines index only tracked files.
 */
export async function materializeMicroRepo(dir: string, opts: { git?: boolean } = {}): Promise<void> {
  for (const [rel, body] of Object.entries(MICRO_REPO_FILES)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, body, 'utf8');
  }
  if (opts.git === false) return;
  await git(dir, ['init', '-q', '-b', 'main']);
  await git(dir, ['add', '-A']);
  await git(dir, ['-c', 'user.name=fair-comparison', '-c', 'user.email=fair-comparison@localhost', 'commit', '-q', '-m', 'micro repo']);
}
