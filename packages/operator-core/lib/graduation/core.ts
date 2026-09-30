/**
 * Graduation evidence tracker — pure core (self-learning-frontier-2026-06-12
 * P-045/P-046 / FB-19, D-008).
 *
 * The designed dial for "the system implements its own suggestions": a finding
 * CLASS earns wider automation by EVIDENCE — N consecutive auto-implemented
 * items of that class resolved with verification evidence, zero recurrence
 * over the decay window, zero gym/EKG regression in each pass's window. This
 * module only COUNTS and REPORTS; the widening act itself (the autoKinds /
 * policy config edit) is NEVER automatic — it stays a reviewed config change
 * riding the release gate, executed by the owner after ratification (P-046).
 *
 * Inputs are evidence rows the PG glue (evidence.ts) assembles from rails that
 * already exist — nothing here re-derives their semantics:
 *   - "resolved with evidence" — resolve-core's `fixed` path (testsRun is
 *     enforced there) advancing payload.ideaLifecycle to 'applied';
 *   - "zero recurrence over 14d" — the decay sweep's applied→verified edge
 *     (lifecycle.ts checkDecayOutcome); 'verified' IS that fact, 'recurred'
 *     is its negation. This core never recomputes decay.
 *   - "auto-implemented" — a dispatch-ledger row (improvement_dispatches)
 *     whose outcome is 'fixed': the auto lane actually dispatched and
 *     resolved it (a human-lane fix of the same class is neither a pass nor
 *     counter-evidence — it is skipped).
 *   - "zero gym/EKG regression" — regression events from the two outcome
 *     rails (gym_champion_outcomes verdict='regressed', fleet_ekg_shifts
 *     severity='major'), checked against each pass's recurrence window. Both
 *     rails are dark until P-001 arms them — an inactive rail contributes no
 *     events (vacuous pass) and the scan reports which legs were live, so the
 *     owner reads the evidence with the right confidence.
 *
 * Class identity is `payload.findingClass` (FB-18 / P-044 — the machine-
 * classifiable `<miner>:<shape>` slug stamped at the filing edge), with
 * defensive fallbacks for rows filed before the taxonomy landed.
 *
 * Pure logic — no DB, no IO, no Date.now() — exhaustively unit-testable.
 */

export interface GraduationPolicy {
  /** Consecutive clean passes a class needs before an eligibility report files
   *  (P-046 proposal: 10). Streak tiers (10, 20, 30 …) key the report dedup, so
   *  a re-report only fires when the evidence has grown by another threshold. */
  threshold: number;
  /** The zero-recurrence window in days — must mirror the decay sweep's
   *  applied→verified bar (lifecycle.ts: 14). Used here only to (a) estimate
   *  each pass's regression-check window and (b) label pending passes. */
  recurrenceWindowDays: number;
  /**
   * The never-auto protected set at CLASS level (P-046: "the loop itself,
   * auth, deploy, budgets graduates NEVER"). Substring matchers over the
   * findingClass slug. This is belt-and-braces ON TOP of policy.ts — protected
   * paths/keywords force the human tier regardless of autoKinds — so no
   * graduation REPORT ever even proposes widening into these families.
   */
  neverGraduateClassPatterns: string[];
}

export const DEFAULT_GRADUATION_POLICY: GraduationPolicy = {
  threshold: 10,
  recurrenceWindowDays: 14,
  neverGraduateClassPatterns: [
    // The loop itself (bootstrapping) — including this tracker.
    'improvement-loop',
    'graduation',
    'governor',
    // Deploy / release machinery.
    'deploy',
    'release',
    'git-sync',
    'migration',
    // Auth / security surfaces.
    'auth',
    'credential',
    'security',
    // Budgets / spend controls + the master switches.
    'budget',
    'quota',
    'flag',
    // The lock authority.
    'lock',
  ],
};

/** One resolved improvement item, mapped to graduation evidence (evidence.ts). */
export interface GraduationEvidenceItem {
  id: string;
  /** Resolved class slug — findingClassOf() at the read seam. */
  findingClass: string;
  /** Best-estimate ms timestamp of the RESOLUTION (lifecycle 'applied' flip);
   *  for already-verified rows this is back-derived from decayDays. */
  resolvedAtMs: number;
  /** The idea lifecycle verdict the decay sweep wrote (lifecycle.ts). */
  lifecycle: 'applied' | 'verified' | 'recurred';
  /** True when the dispatch ledger shows the AUTO lane resolved it. */
  autoDispatched: boolean;
  /** True when the resolution carried verification evidence (resolve-core's
   *  testsRun-enforced 'fixed' path — i.e. the lifecycle exists at all). */
  hasEvidence: boolean;
}

/** A fleet-level regression event from the gym/EKG outcome rails. */
export interface RegressionEvent {
  atMs: number;
  source: 'gym' | 'ekg';
  label: string;
}

export type PassVerdict =
  | 'clean' // verified + evidenced + auto + regression-free window → counts
  | 'pending-window' // applied; the decay sweep has not graded it yet → neither counts nor resets
  | 'recurred' // the signature re-surfaced → RESETS the streak
  | 'no-evidence' // auto-resolved without the evidenced lifecycle → RESETS (a dirty pass)
  | 'window-regression' // a gym/EKG regression landed inside the pass's window → RESETS
  | 'not-auto'; // human-lane resolution → skipped entirely

export interface GradedPass {
  id: string;
  verdict: PassVerdict;
  resolvedAtMs: number;
  /** For 'window-regression': the events that dirtied the window. */
  regressions?: RegressionEvent[];
}

export interface ClassGraduationStanding {
  findingClass: string;
  /** Trailing consecutive clean passes (the graduation counter). */
  cleanStreak: number;
  totalClean: number;
  totalRecurred: number;
  totalDirty: number; // no-evidence + window-regression
  pendingWindow: number;
  /** True when the class matches the never-graduate set — never eligible. */
  neverGraduate: boolean;
  eligible: boolean;
  /** The threshold tier the streak has reached (10, 20, 30 …) or null. */
  eligibleTier: number | null;
  /** Human-readable counting trail (for the report + tests). */
  reasons: string[];
  passes: GradedPass[];
}

/**
 * Resolve a row's class slug — `payload.findingClass` first (P-044), then the
 * watchdog signal family, then the triage taxonomy, then the bare kind.
 */
export function findingClassOf(item: {
  findingClass?: string;
  watchdogKey?: string;
  ideaType?: string;
  kind?: string;
}): string {
  if (item.findingClass) return item.findingClass;
  if (item.watchdogKey) {
    const source = item.watchdogKey.split(':')[0]?.trim();
    if (source) return `${source}:unclassified`;
  }
  if (item.ideaType) return `${item.ideaType}:unclassified`;
  return `${item.kind ?? 'unknown'}:unclassified`;
}

export function isNeverGraduateClass(
  findingClass: string,
  policy: GraduationPolicy = DEFAULT_GRADUATION_POLICY,
): boolean {
  const hay = findingClass.toLowerCase();
  return policy.neverGraduateClassPatterns.some((p) => hay.includes(p.toLowerCase()));
}

const DAY_MS = 86_400_000;

function gradePass(
  item: GraduationEvidenceItem,
  regressions: readonly RegressionEvent[],
  policy: GraduationPolicy,
  nowMs: number,
): GradedPass {
  const base = { id: item.id, resolvedAtMs: item.resolvedAtMs };
  if (!item.autoDispatched) return { ...base, verdict: 'not-auto' };
  if (!item.hasEvidence) return { ...base, verdict: 'no-evidence' };
  if (item.lifecycle === 'recurred') return { ...base, verdict: 'recurred' };
  if (item.lifecycle === 'applied') {
    // The decay sweep is the verification authority — an applied row past the
    // window that the sweep has not flipped yet still does NOT count (we never
    // re-derive decay here); it just waits.
    return { ...base, verdict: 'pending-window' };
  }
  // verified: regression-check the pass's window.
  const windowEndMs = item.resolvedAtMs + policy.recurrenceWindowDays * DAY_MS;
  const hits = regressions.filter((r) => r.atMs >= item.resolvedAtMs && r.atMs <= Math.min(windowEndMs, nowMs));
  if (hits.length > 0) return { ...base, verdict: 'window-regression', regressions: hits };
  return { ...base, verdict: 'clean' };
}

/**
 * Compute per-class graduation standings: order each class's auto-lane passes
 * by resolution time and count the TRAILING consecutive clean streak —
 * recurrence, missing evidence, or an in-window fleet regression resets it;
 * a pass still inside its decay window neither counts nor resets.
 */
export function computeGraduationStandings(
  items: readonly GraduationEvidenceItem[],
  regressions: readonly RegressionEvent[],
  policy: GraduationPolicy = DEFAULT_GRADUATION_POLICY,
  nowMs: number = 0,
): ClassGraduationStanding[] {
  const byClass = new Map<string, GraduationEvidenceItem[]>();
  for (const item of items) {
    const list = byClass.get(item.findingClass);
    if (list) list.push(item);
    else byClass.set(item.findingClass, [item]);
  }

  const standings: ClassGraduationStanding[] = [];
  for (const [findingClass, classItems] of byClass) {
    const ordered = [...classItems].sort((a, b) => a.resolvedAtMs - b.resolvedAtMs || a.id.localeCompare(b.id));
    const passes = ordered.map((i) => gradePass(i, regressions, policy, nowMs));

    let streak = 0;
    let totalClean = 0;
    let totalRecurred = 0;
    let totalDirty = 0;
    let pendingWindow = 0;
    for (const p of passes) {
      switch (p.verdict) {
        case 'clean':
          streak += 1;
          totalClean += 1;
          break;
        case 'recurred':
          streak = 0;
          totalRecurred += 1;
          break;
        case 'no-evidence':
        case 'window-regression':
          streak = 0;
          totalDirty += 1;
          break;
        case 'pending-window':
          pendingWindow += 1;
          break;
        case 'not-auto':
          break; // human-lane: neither pass nor counter-evidence
      }
    }

    const neverGraduate = isNeverGraduateClass(findingClass, policy);
    const tier = Math.floor(streak / policy.threshold) * policy.threshold;
    const eligible = !neverGraduate && streak >= policy.threshold;

    const reasons: string[] = [
      `${streak} consecutive clean auto-pass(es) (threshold ${policy.threshold}); ` +
        `${totalClean} clean / ${totalRecurred} recurred / ${totalDirty} dirty / ${pendingWindow} still in the ${policy.recurrenceWindowDays}d window`,
    ];
    if (neverGraduate) {
      reasons.push(
        `class matches the never-graduate protected set (P-046: the loop itself, auth, deploy, budgets graduate NEVER) — not eligible regardless of streak`,
      );
    } else if (eligible) {
      reasons.push(`graduation-eligible at tier n${tier} — owner ratification required (NEVER an automatic autoKinds edit)`);
    }

    standings.push({
      findingClass,
      cleanStreak: streak,
      totalClean,
      totalRecurred,
      totalDirty,
      pendingWindow,
      neverGraduate,
      eligible,
      eligibleTier: eligible ? tier : null,
      reasons,
      passes,
    });
  }

  // Most-evidenced first — the scan's report cap takes the strongest classes.
  return standings.sort((a, b) => b.cleanStreak - a.cleanStreak || a.findingClass.localeCompare(b.findingClass));
}

/**
 * The owner-report dedup identity: one report per (class, threshold tier).
 * Tier n10 files once ever (dedupScope 'all'); when the streak reaches n20 the
 * KEY changes, so a fresh report files with doubled evidence — escalating
 * evidence without nagging a rejected ask every tick.
 */
export function graduationWatchdogKey(findingClass: string, tier: number): string {
  return `graduation:${findingClass}:n${tier}`;
}

/** The findingClass the report itself files under (machine-routable, P-044). */
export const GRADUATION_REPORT_CLASS = 'graduation:eligibility-report';

export interface GraduationReport {
  title: string;
  body: string;
  watchdogKey: string;
}

/**
 * Build the "class X is graduation-eligible" owner report. The report is an
 * OWNER RATIFICATION ASK (P-046) — it rides the normal capture → ranked queue
 * → Queen triage rails (D-008), where the Queen routes it 'gate'. It names
 * policy.ts as its implementation path, which sits under the protected-path
 * patterns — so the report itself is STRUCTURALLY barred from the auto lane.
 */
export function buildGraduationReport(
  standing: ClassGraduationStanding,
  policy: GraduationPolicy = DEFAULT_GRADUATION_POLICY,
): GraduationReport {
  const tier = standing.eligibleTier ?? policy.threshold;
  const title = `Graduation evidence: class '${standing.findingClass}' reached ${standing.cleanStreak} consecutive clean auto-passes (tier n${tier})`;
  const body = [
    `**Owner ratification ask (P-046 @ self-learning-frontier-2026-06-12 — graduation is NEVER automatic).**`,
    '',
    `Finding class \`${standing.findingClass}\` has accumulated the evidence the trust-graduation policy asks for:`,
    '',
    `- **${standing.cleanStreak} consecutive clean passes** — each one auto-implemented, resolved with verification evidence (testsRun-enforced), and decay-VERIFIED (${policy.recurrenceWindowDays}d zero recurrence), with no gym/EKG regression inside its window.`,
    `- Lifetime: ${standing.totalClean} clean / ${standing.totalRecurred} recurred / ${standing.totalDirty} dirty / ${standing.pendingWindow} still in-window.`,
    '',
    `**The act, if you ratify:** widen the auto-implementation policy for this class — a REVIEWED config edit to`,
    `\`packages/operator-core/lib/harness/improvements/policy.ts\` (autoKinds / class allowlist) riding the release gate.`,
    `This report only presents evidence; nothing widens automatically. The protected path/keyword sets stay`,
    `human-gated indefinitely regardless of any graduation (policy.ts D-004/D-008).`,
    '',
    `Counting trail: ${standing.reasons.join(' · ')}`,
  ].join('\n');
  return { title, body, watchdogKey: graduationWatchdogKey(standing.findingClass, tier) };
}
