/**
 * Gym task CORPUS — what a champion was actually judged on.
 *
 * WHY THIS EXISTS (plan gym-real-fitness-signal-2026-07-27, P-003; owner escalation
 * 2026-07-27). Every gym champion to date was crowned on three hardcoded toy tasks
 * (`gym-loop-health` / `-version` / `-ready`) against a synthetic 4-line service the
 * gym generates itself — `index.js` is literally
 * `export function handle(req){ return { status: 404 }; }` and the sole build gate is
 * `node --check`. Nothing recorded that, so a prompt promoted on toy work read
 * exactly like one promoted on real work, and six release scorecards passed green
 * because every criterion measured MECHANISM health (cycle error rate, ledger
 * reconciliation, lens diversity) while none asked whether the fitness signal was
 * real.
 *
 * Making the corpus a typed, persisted fact is what lets P-011 hang a release-gate
 * criterion off it: `fitness-signal-is-real` FAILS while the active corpus is
 * synthetic, so a green gate over a stub benchmark becomes impossible rather than
 * merely embarrassing.
 *
 * Deliberately a tiny standalone module: the DB layer, the gym runner, the read API
 * and the release gate all need the same vocabulary, and a shared literal beats four
 * copies of `'synthetic' | 'real'` drifting apart.
 */

/** Which corpus a single gym task belongs to. */
export type GymTaskCorpus = 'synthetic' | 'real';

/**
 * What a CHALLENGER was judged on. `mixed` exists only for the transition window in
 * which a harness runs both kinds at once — a champion earned partly on stubs must
 * not be able to claim 'real'.
 */
export type GymJudgedCorpus = GymTaskCorpus | 'mixed';

export const GYM_TASK_CORPORA: readonly GymTaskCorpus[] = Object.freeze([
  'synthetic',
  'real',
]);

/** The honest default for anything unlabelled: everything before P-003 was a stub. */
export const DEFAULT_GYM_TASK_CORPUS: GymTaskCorpus = 'synthetic';

export function isGymTaskCorpus(v: unknown): v is GymTaskCorpus {
  return typeof v === 'string' && (GYM_TASK_CORPORA as readonly string[]).includes(v);
}

/** Coerce a DB/wire value, defaulting UNKNOWN to 'synthetic' — never to 'real'. */
export function asGymTaskCorpus(v: unknown): GymTaskCorpus {
  return isGymTaskCorpus(v) ? v : DEFAULT_GYM_TASK_CORPUS;
}

/**
 * The corpus a cycle's judgement rests on, from the tasks it actually scored.
 *
 * Rules, in the order that matters:
 *  - no tasks at all ⇒ 'synthetic' (we cannot claim a real signal from nothing);
 *  - any synthetic task mixed with any real one ⇒ 'mixed' (NOT 'real' — a champion
 *    part-earned on stubs must never read as fully real);
 *  - all real ⇒ 'real'.
 */
export function judgedCorpusFromTasks(
  tasks: readonly { corpus?: unknown }[],
): GymJudgedCorpus {
  if (tasks.length === 0) return 'synthetic';
  let sawReal = false;
  let sawSynthetic = false;
  for (const t of tasks) {
    if (asGymTaskCorpus(t.corpus) === 'real') sawReal = true;
    else sawSynthetic = true;
  }
  if (sawReal && sawSynthetic) return 'mixed';
  return sawReal ? 'real' : 'synthetic';
}

/**
 * Does this task set constitute a REAL fitness signal for release purposes?
 *
 * The release gate's question is deliberately strict: a corpus that is entirely
 * synthetic is not a fitness signal at all, and a partly-synthetic one cannot be
 * reported as if it were. Only an all-real corpus passes; 'mixed' is surfaced with
 * its counts so the gate reads as "in transition", not "fine".
 */
export function fitnessSignalIsReal(tasks: readonly { corpus?: unknown }[]): {
  real: boolean;
  judged: GymJudgedCorpus;
  realCount: number;
  syntheticCount: number;
  total: number;
} {
  let realCount = 0;
  for (const t of tasks) if (asGymTaskCorpus(t.corpus) === 'real') realCount += 1;
  const total = tasks.length;
  const judged = judgedCorpusFromTasks(tasks);
  return {
    real: total > 0 && judged === 'real',
    judged,
    realCount,
    syntheticCount: total - realCount,
    total,
  };
}
