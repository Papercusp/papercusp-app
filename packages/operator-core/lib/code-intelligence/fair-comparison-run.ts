/**
 * P-017 Phase E core (plan `gitnexus-deterministic-integration-2026-10-05`,
 * D-011): run one arm against the preregistered corpus, then score every arm's
 * raw answers against the pooled, adjudicated key. Pure apart from the arm it
 * is handed, so the whole pipeline is tested with fake arms; the CLI
 * (fair-comparison-cli.ts) adds files, trees and engines.
 *
 * Order of operations the D-011 design requires, and where each is enforced:
 *  1. preregister (fair-comparison.ts) BEFORE any arm runs: `runArm` refuses an
 *     arm, version, intent set or corpus that differs from the preregistration.
 *  2. each arm indexes once, then answers every case `reps` times in a seeded
 *     shuffled order (order effects such as cache warmth are spread, not fixed).
 *  3. answers are stored RAW; scoring happens later, against keys completed by
 *     pooled adjudication, so no arm's answers shape the key it is scored on
 *     except through a recorded verdict.
 *  4. `scoreRuns` lists every site still unadjudicated; `decideBackend` refuses
 *     to decide while any remain.
 */
import type { PhaseCost } from './engine-comparison';
import {
  aggregateArm,
  applyAdjudication,
  decideBackend,
  poolCandidates,
  scoreCase,
  shuffledArmOrder,
  type AdjudicationVerdict,
  type AnswerKey,
  type ArmAggregate,
  type ArmAnswer,
  type ArmCapabilities,
  type BackendDecision,
  type FairCase,
  type Preregistration,
  type SiteKey,
} from './fair-comparison';
import type { FairArm } from './fair-comparison-arms';

export interface ArmRepAnswers {
  readonly rep: number;
  readonly answers: readonly ArmAnswer[];
}

/** Everything one arm produced, as written to `<arm>.run.json`. */
export interface ArmRun {
  readonly capabilities: ArmCapabilities;
  readonly preregHash: string;
  /** Non-null when the arm could not run on this host: reported, never scored. */
  readonly unavailable: string | null;
  readonly index: PhaseCost | null;
  readonly reps: readonly ArmRepAnswers[];
  readonly startedAt: string;
  readonly finishedAt: string;
}

const sortedIntents = (c: ArmCapabilities): string => JSON.stringify([...c.intents].sort());

/** Why `arm` may not run under `prereg`, or null when it matches. */
export function preregMismatch(caps: ArmCapabilities, cases: readonly FairCase[], prereg: Preregistration): string | null {
  const reg = prereg.arms.find((a) => a.armId === caps.armId);
  if (!reg) return `arm ${caps.armId} is not in preregistration ${prereg.hash.slice(0, 12)}`;
  if (reg.version !== caps.version) return `arm ${caps.armId} version '${caps.version}' differs from preregistered '${reg.version}'`;
  if (sortedIntents(reg) !== sortedIntents(caps)) return `arm ${caps.armId} intents differ from its preregistration`;
  if (reg.licence !== caps.licence) return `arm ${caps.armId} licence differs from its preregistration`;
  const ids = cases.map((c) => c.id).sort();
  if (JSON.stringify(ids) !== JSON.stringify(prereg.corpusIds)) return 'the corpus differs from the preregistered case ids';
  return null;
}

/** Index once, then answer every case `prereg.reps` times in a seeded shuffled order. */
export async function runArm(
  arm: FairArm,
  cases: readonly FairCase[],
  prereg: Preregistration,
  clock: () => string = () => new Date().toISOString(),
): Promise<ArmRun> {
  const mismatch = preregMismatch(arm.capabilities, cases, prereg);
  if (mismatch) throw new Error(`run refused: ${mismatch}`);
  const startedAt = clock();
  const base = { capabilities: arm.capabilities, preregHash: prereg.hash, unavailable: arm.unavailable, startedAt };
  if (arm.unavailable) return { ...base, index: null, reps: [], finishedAt: clock() };
  const reps: ArmRepAnswers[] = [];
  let index: PhaseCost;
  try {
    index = await arm.index();
    if (index.ok) {
      for (let rep = 1; rep <= prereg.reps; rep += 1) {
        const answers: ArmAnswer[] = [];
        for (const kase of shuffledArmOrder(cases, prereg.seed + rep)) answers.push(await arm.query(kase));
        reps.push({ rep, answers });
      }
    }
  } finally {
    await arm.close?.();
  }
  return { ...base, index, reps, finishedAt: clock() };
}

export interface PendingSites {
  readonly caseId: string;
  /** Sites some arm answered that the key does not yet rule on. */
  readonly sites: readonly SiteKey[];
  /** Which arms named each site, so the adjudicator can see who to credit. */
  readonly namedBy: Readonly<Record<SiteKey, readonly string[]>>;
}

export interface ScoredComparison {
  readonly keys: readonly AnswerKey[];
  readonly pending: readonly PendingSites[];
  readonly aggregates: readonly ArmAggregate[];
  readonly decision: BackendDecision;
}

/**
 * Score every arm's raw answers. Keys are the seed keys with the recorded
 * verdicts applied; any answered site no verdict covers is listed in `pending`
 * and keeps the decision inconclusive.
 */
export function scoreRuns(
  runs: readonly ArmRun[],
  cases: readonly FairCase[],
  seedKeys: readonly AnswerKey[],
  verdicts: Readonly<Record<string, readonly AdjudicationVerdict[]>>,
  prereg: Pick<Preregistration, 'reps' | 'hash'>,
): ScoredComparison {
  const foreign = runs.filter((r) => r.preregHash !== prereg.hash).map((r) => r.capabilities.armId);
  if (foreign.length > 0) throw new Error(`score refused: runs from another preregistration (${foreign.join(', ')})`);
  const keys = seedKeys.map((k) => applyAdjudication(k, verdicts[k.caseId] ?? []));
  const keyOf = new Map(keys.map((k) => [k.caseId, k]));
  const caseOf = new Map(cases.map((c) => [c.id, c]));

  const pending: PendingSites[] = [];
  for (const c of cases) {
    const namedBy: Record<SiteKey, string[]> = {};
    for (const r of runs) {
      const answered = r.reps.flatMap((rep) => rep.answers).filter((a) => a.caseId === c.id && a.status === 'answered');
      for (const site of poolCandidates(keyOf.get(c.id)!, answered)) {
        namedBy[site] = [...new Set([...(namedBy[site] ?? []), r.capabilities.armId])];
      }
    }
    const sites = Object.keys(namedBy).sort();
    if (sites.length > 0) pending.push({ caseId: c.id, sites, namedBy });
  }

  const corpusIntents = [...new Set(cases.map((c) => c.intent))];
  const aggregates = runs
    .filter((r) => r.unavailable === null)
    .map((r) =>
      aggregateArm(
        r.capabilities,
        corpusIntents,
        r.reps.map((rep) => ({
          rep: rep.rep,
          scores: rep.answers.map((a) => scoreCase(caseOf.get(a.caseId)!, r.capabilities, keyOf.get(a.caseId)!, a)),
        })),
      ),
    );
  return { keys, pending, aggregates, decision: decideBackend(aggregates, prereg) };
}
