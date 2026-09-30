/**
 * DARK LEARNING-TARGET AUDIT (plan gym-real-fitness-signal-2026-07-27, P-012).
 *
 * WHY THIS EXISTS. `LEARNING_GYM_TARGETS` registers the learning system's own roles —
 * implement-worker, triage-classifier, Scout ideators — to be judged on GROUND TRUTH
 * (`drillResolveRate`, `drillMttsh`, `regressionsFromTests`). That is the real fitness
 * signal the stack was supposed to optimize against. `seed-learning-gym-targets.ts`
 * creates those rows "DARK by construction (D-001)": `enabled:false`, `budget:null`,
 * awaiting an owner arming act.
 *
 * That arming act never came, and NOTHING EVER SAID SO. For weeks the real-signal gym
 * sat dark while a toy-task prompt gym burned the budget, and every wake reported the
 * toy gym's health as learning health. A dark target is not an error, so nothing logged;
 * it is not a failure, so no gate fired; it simply did not exist as far as any report
 * was concerned. Silence about an un-armed capability is indistinguishable from that
 * capability working.
 *
 * So this audit reports, every wake, the difference between what is REGISTERED and what
 * is actually RUNNING — and it reports a never-armed target as loudly as a broken one.
 * Pure over its inputs (a registry list + whatever autoloop rows exist); the caller does
 * the IO.
 */
import { LEARNING_GYM_TARGETS, type LearningGymTarget } from './learning-targets';

/** The autoloop row shape this audit needs (a subset of gym_autoloop_config). */
export interface DarkAuditAutoloopRow {
  harnessSlug: string;
  enabled: boolean;
  budgetUsd: number | null;
  /** Epoch ms of the last cycle, or null when it has never run. */
  lastCycleAt?: number | null;
}

/** Why a registered target is not producing signal. Ordered most→least severe. */
export type DarkTargetReason =
  /** No autoloop row exists at all — the seed never ran, or ran against another harness. */
  | 'unregistered'
  /** Row exists but `enabled:false` — the D-001 dark default, never armed. */
  | 'disabled'
  /** Enabled but `budget:null`/0 — the governor refuses an unbudgeted loop, so it cannot fire. */
  | 'unbudgeted'
  /** Enabled and budgeted but has NEVER completed a cycle — armed on paper only. */
  | 'never-ran';

export interface DarkTargetFinding {
  key: LearningGymTarget['key'];
  title: string;
  /** The ground-truth signals this target WOULD be judged on if it ran. */
  signals: readonly string[];
  reason: DarkTargetReason;
  /** Human-facing one-liner naming the target, the cause, and the remedy. */
  detail: string;
}

export interface DarkTargetAudit {
  /** Registered targets that are NOT producing signal, most severe first. */
  dark: DarkTargetFinding[];
  /** Registered targets that are armed, budgeted and have run at least once. */
  liveKeys: LearningGymTarget['key'][];
  /** How many AUTOLOOP-ELIGIBLE targets the registry declares (the headline denominator). */
  registered: number;
  /**
   * Targets deliberately excluded from the dark check because they have no
   * prompt-override surface to optimize (the triage classifier is a persona, the Scout
   * ideators are code-constructed lenses). Per seed-learning-gym-targets.ts these get
   * NO autoloop row BY DESIGN, so flagging them would be crying wolf — but they are
   * listed rather than dropped, because "excluded by design" and "quietly missing"
   * must not look the same either.
   */
  notAutoloopEligible: LearningGymTarget['key'][];
  /** One line safe to paste into a wake report; empty when nothing is dark. */
  headline: string;
}

const SEVERITY: Record<DarkTargetReason, number> = {
  unregistered: 0,
  disabled: 1,
  unbudgeted: 2,
  'never-ran': 3,
};

const REMEDY: Record<DarkTargetReason, string> = {
  unregistered:
    'no gym_autoloop_config row — run the seed (tsx lib/gym/seed-learning-gym-targets.ts) and confirm its harness prerequisite',
  disabled: 'row exists but enabled:false (the D-001 dark default) — arm it via the gym control plane with an explicit budget',
  unbudgeted: 'enabled but has no budget — the governor refuses an unbudgeted loop, so set a budget or it can never fire',
  'never-ran':
    'armed and budgeted but has never completed a cycle — check the routine actually dispatches it (a stood-down runner looks identical to a dark target)',
};

/**
 * Which targets are dark, and why.
 *
 * A target is matched to an autoloop row by the harness it would run on: the caller
 * passes the rows it read, keyed however it likes, and `resolveHarness` says which
 * harness each target belongs to (the implement-worker's runner harness, etc.). A
 * target whose harness cannot be resolved counts as `unregistered` — deliberately, so
 * a misconfigured prerequisite surfaces instead of silently excusing the target.
 */
export function auditDarkLearningTargets(input: {
  rows: readonly DarkAuditAutoloopRow[];
  /** target → the harness slug whose autoloop row would run it (null ⇒ unresolvable). */
  resolveHarness: (t: LearningGymTarget) => string | null;
  targets?: readonly LearningGymTarget[];
}): DarkTargetAudit {
  const targets = input.targets ?? LEARNING_GYM_TARGETS;
  const byHarness = new Map<string, DarkAuditAutoloopRow>();
  for (const r of input.rows) byHarness.set(r.harnessSlug, r);

  const dark: DarkTargetFinding[] = [];
  const liveKeys: LearningGymTarget['key'][] = [];
  const notAutoloopEligible: LearningGymTarget['key'][] = [];

  for (const t of targets) {
    // Only a prompt-override surface can be auto-optimized by an autoloop; the others
    // are judged corpus-wide and have no row to be "dark" about (see the field doc).
    if (t.promptSurface !== 'prompt-override') {
      notAutoloopEligible.push(t.key);
      continue;
    }
    const harness = input.resolveHarness(t);
    const row = harness ? byHarness.get(harness) : undefined;
    let reason: DarkTargetReason | null = null;
    if (!row) reason = 'unregistered';
    else if (!row.enabled) reason = 'disabled';
    else if (row.budgetUsd == null || row.budgetUsd <= 0) reason = 'unbudgeted';
    else if (row.lastCycleAt == null) reason = 'never-ran';

    if (reason == null) {
      liveKeys.push(t.key);
      continue;
    }
    dark.push({
      key: t.key,
      title: t.title,
      signals: t.signals,
      reason,
      detail:
        `${t.key} is DARK (${reason}) — would be judged on ${t.signals.join(' / ') || 'no declared signals'}` +
        `${harness ? ` on harness '${harness}'` : ''}: ${REMEDY[reason]}`,
    });
  }

  dark.sort((a, b) => SEVERITY[a.reason] - SEVERITY[b.reason] || a.key.localeCompare(b.key));

  const eligible = targets.length - notAutoloopEligible.length;
  return {
    dark,
    liveKeys,
    notAutoloopEligible,
    registered: eligible,
    headline:
      dark.length === 0
        ? ''
        : `${dark.length} of ${eligible} autoloop-eligible learning target(s) produce NO signal: ` +
          `${dark.map((d) => `${d.key} (${d.reason})`).join(', ')}. ` +
          'A dark target is not an error and fires no gate — it is only visible if something says so, which is why this line exists.',
  };
}
