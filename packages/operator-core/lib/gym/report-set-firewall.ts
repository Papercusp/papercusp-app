/**
 * Gym ↔ report-set firewall (impartial-benchmark-suite-2026-06-15 P-012 / D-005).
 *
 * THE INVARIANT: the sets the gym is allowed to TUNE on (optimize-on) and the sets
 * the impartial benchmark suite REPORTS on (report-on) must stay *strictly disjoint*.
 * If the gym ever optimizes a prompt/champion against a benchmark we then publish a
 * score on, we have tuned-to-test and contaminated our own impartiality claim — the
 * exact thing a sophisticated third party discounts to zero (D-005: "we neither author
 * nor grade"). So this is enforced in code, not left to discipline.
 *
 * The firewall has two layers, both checkable by the colocated CI test:
 *
 *   1. SET-LEVEL (static, always checkable). Every evaluation set is declared here with
 *      a `usage` discipline. `assertReportSetFirewall()` proves no set is declared both
 *      optimize-on and report-on — i.e. the two id-collections are disjoint. This catches
 *      the realistic regression: someone adds `'swe-bench-pro'` to the gym's source list
 *      "because it's great training data."
 *
 *   2. TASK-LEVEL (data, checkable when a report-on manifest is in hand). Even with
 *      distinct set ids, a specific task (repo @ commit) could appear in both an
 *      optimize-on corpus and a report-on set. `reportSetTaskIntersection()` /
 *      `assertGymCorpusDisjoint()` compare normalized task fingerprints; the external-bench
 *      ingestion side (P-005/P-019) calls them once it has concrete report-on task lists.
 *
 * The runtime choke point is `assertGymTaskNotContaminated()`, wired into `insertTask`
 * (store.ts) so no report-on-originated task can enter `harness_gym.gym_tasks` at all.
 *
 * AUTHORITY: per D-005 this firewall is the canonical source of truth for "what the
 * impartial suite reports on" — `REPORT_ON_SUITES[].id` IS the `run_result.suite`
 * vocabulary (P-010/P-011). Keep the two in lock-step; a suite reported on but not listed
 * here is a hole in the firewall.
 */

/** An evaluation set's usage discipline — the firewall axis. */
export type BenchSetUsage =
  /** The impartial suite publishes scores on it → the gym must NEVER tune on it. */
  | 'report-on'
  /** The gym may tune (optimize prompts/champions) on it. */
  | 'optimize-on';

export interface BenchSet {
  /**
   * Canonical, stable slug. For `report-on` sets this MUST equal the value used in
   * `run_result.suite` (P-010/P-011) — the firewall and the results schema share one
   * vocabulary so "reported on" and "fenced off from the gym" can never drift apart.
   */
  readonly id: string;
  readonly usage: BenchSetUsage;
  readonly title: string;
  /** Why this set carries this discipline — the auditable rationale. */
  readonly rationale: string;
}

/**
 * The impartial suite's REPORT-ON sets (plan "benchmark suite (tiered)" + D-003 + D-008).
 * Every id here is fenced off from gym tuning AND is a legal `run_result.suite` value.
 * Add a benchmark to the published suite ⇒ add it here in the SAME change.
 */
export const REPORT_ON_SUITES: readonly BenchSet[] = Object.freeze([
  {
    id: 'swe-bench-pro',
    usage: 'report-on',
    title: 'SWE-bench Pro (Scale; public + held-out commercial split)',
    rationale:
      'Contamination-resistant core (what OpenAI now points to after retiring Verified); the pilot backbone (M1 diff-batch grader, D-008).',
  },
  {
    id: 'terminal-bench',
    usage: 'report-on',
    title: 'Terminal-Bench 2.0/2.1 (Snorkel + Stanford + Laude)',
    rationale: 'Execution/DevOps core; in-container grading (M2, D-008). Native-harness arm is ~free via Harbor --agent claude-code.',
  },
  {
    id: 'swe-rebench',
    usage: 'report-on',
    title: 'SWE-rebench (~21k auto-mined post-cutoff issues)',
    rationale: 'Contamination-proof freshness — the strongest impartiality lever (added once the adapter is proven, P-013).',
  },
  {
    id: 'swe-bench-live',
    usage: 'report-on',
    title: 'SWE-bench-Live (weekly auto-updating, multi-language/OS)',
    rationale: 'Contamination-proof freshness — maintained post-cutoff so no hand-built fresh set is needed.',
  },
  {
    id: 'swe-evo',
    usage: 'report-on',
    title: 'SWE-EVO (48 tasks, avg 21 files / 874 tests each)',
    rationale: 'Long-horizon set where coordination is actually exercised (single agents are weak here — the headroom the spine should open).',
  },
  {
    id: 'roadmapbench',
    usage: 'report-on',
    title: 'RoadmapBench (115 version-upgrade tasks, 17 repos, 5 langs)',
    rationale: 'Long-horizon, multi-file, decomposable — where hand-offs / decomposition / review have something to do.',
  },
  {
    id: 'swe-lancer',
    usage: 'report-on',
    title: 'SWE-Lancer ($1M of real freelance tasks, E2E-graded)',
    rationale: 'Optional economic framing ("X dollars of work completed"); still report-on, still fenced off from gym tuning.',
  },
  {
    id: 'harness-bench',
    usage: 'report-on',
    title: 'Harness-Bench (arXiv 2605.27922 — fixes task/budget/timeout/grader, varies the harness)',
    rationale: 'Harness-isolation air cover; run Papercusp through it if P-001 shows onboarding is tractable. Never a gym tuning target.',
  },
  {
    id: 'metr-hcast',
    usage: 'report-on',
    title: 'METR HCAST / time-horizon (arXiv:2503.14499 + 2503.17354; ~31 open Task-Standard tasks)',
    rationale:
      'Long-horizon-autonomy headline: a derived 50%/80%-time-horizon fit + the hive-vs-single-opus LIFT. Third-party-authored + self-grading (each task ships its own score()) → never a gym tuning target (D-005). Absolute horizon on the open subset is illustrative-only; the LIFT is the defensible signal (plan benchmark-suite-metr-hcast-2026-06-17 D-002).',
  },
  {
    id: 'agentsnet',
    usage: 'report-on',
    title: 'AgentsNet (coordination-native multi-agent; arXiv:2507.08616)',
    rationale:
      'The DIRECT coordination dimension: one opus agent per graph node, local-neighbor-only message passing, five distributed-computing tasks (coloring/consensus/leader-election/matching/vertex-cover) with deterministic get_score(). Reported on as a model-coordination number (optionally carried over our substrate, route B); NEVER a gym tuning target — D-002: it is decentralized/local-only, so our global-view queen would cheat it (plan benchmark-suite-agentsnet-2026-06-17).',
  },
  {
    id: 'swarmbench',
    usage: 'report-on',
    title: 'SwarmBench (decentralized swarm coordination; arXiv:2505.04364)',
    rationale:
      'Coordination-NATIVE 2D-grid swarm sim (Pursuit/Synchronization/Foraging/Flocking/Transport): N agents under local k×k view + local messaging, deterministic per-task sim score. The headline is the decentralized-peers-vs-centralized-coordinator topology delta — a coordination result no diff-batch suite can express. NEVER a gym tuning target — D-005; and per D-001 a global-view queen would violate the local-only premise (plan benchmark-suite-swarmbench-2026-06-17).',
  },
  {
    id: 'frontier-swe',
    usage: 'report-on',
    title: 'FrontierSWE (Proximal Labs; ultra-long-horizon implementation / perf-eng / ML-research)',
    rationale:
      '17 ultra-long-horizon tasks (5 implementation / 9 performance / 3 ML-research), hours→tens-of-hours, 5 trials/task, CONTINUOUS [0,1] score (no model fully solves the implementation tasks). M2 in-container + own-scorer (each task ships its own scorer: a Rust benchmark-runner + *.expected fixtures); headline = mean@5/best@5 + AVG-RANK/dominance across a coordination-topology arm pool. Third-party-authored + self-grading → NEVER a gym tuning target (D-005) (plan benchmark-suite-frontier-swe-2026-06-18).',
  },
]);

/**
 * The gym's OPTIMIZE-ON source sets — the only corpora the gym may tune on. These are
 * internal/synthetic by construction (the firewall's whole point is that none of them is
 * an external published benchmark). Introduce a new gym task source ⇒ declare it here, so
 * `assertReportSetFirewall()` proves it is disjoint from the report-on set the same day.
 */
export const GYM_OPTIMIZE_ON_SETS: readonly BenchSet[] = Object.freeze([
  {
    id: 'gym-synthetic',
    usage: 'optimize-on',
    title: 'Intent-first synthetic feature tasks (task-generator.ts)',
    rationale: 'Model-generated tasks over the Papercusp substrate — authored by us for self-improvement, explicitly NOT a third-party benchmark.',
  },
  {
    id: 'gym-real-anchor',
    usage: 'optimize-on',
    title: 'Real-feature replay on the real Papercusp repo (papercusp-substrate.ts — falsifiability anchor + train source)',
    // The substrate is OUR repo at a pinned commit, never an external benchmark repo,
    // so tuning on it cannot contaminate an impartial score. NOTE (D-006): tasks are
    // built by rewinding ONE implementation file inside a pinned real checkout — NOT by
    // replaying at "the commit before the fix", which is meaningless here because
    // git-sync squashes the whole shared tree into one commit every few minutes.
    rationale: 'Papercusp\'s OWN shipped changes replayed inside our real repo at a pinned commit; the substrate is our repo, never an external benchmark repo.',
  },
]);

/** The full registry — every known evaluation set, both disciplines. */
export const BENCH_SET_REGISTRY: readonly BenchSet[] = Object.freeze([
  ...REPORT_ON_SUITES,
  ...GYM_OPTIMIZE_ON_SETS,
]);

/** Thrown when the firewall is breached (a set or a task crosses the optimize/report line). */
export class ReportSetFirewallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportSetFirewallError';
  }
}

export function reportOnSetIds(registry: readonly BenchSet[] = BENCH_SET_REGISTRY): Set<string> {
  return new Set(registry.filter((s) => s.usage === 'report-on').map((s) => s.id));
}

export function optimizeOnSetIds(registry: readonly BenchSet[] = BENCH_SET_REGISTRY): Set<string> {
  return new Set(registry.filter((s) => s.usage === 'optimize-on').map((s) => s.id));
}

/** Is `id` a set the gym is FORBIDDEN to tune on (one the impartial suite reports on)? */
export function isReportOnSet(id: string, registry: readonly BenchSet[] = BENCH_SET_REGISTRY): boolean {
  return reportOnSetIds(registry).has(id);
}

/** Is `id` a declared gym optimize-on source? */
export function isOptimizeOnSet(id: string, registry: readonly BenchSet[] = BENCH_SET_REGISTRY): boolean {
  return optimizeOnSetIds(registry).has(id);
}

/**
 * LAYER 1 — the static firewall. Proves the optimize-on and report-on id collections are
 * strictly disjoint (no set is declared both) and that ids are unique. This is the CI
 * guard's load-bearing assertion: it throws the moment a report-on suite is also listed as
 * a gym source. Pass a doctored registry to exercise the failure path.
 */
export function assertReportSetFirewall(registry: readonly BenchSet[] = BENCH_SET_REGISTRY): void {
  // Group every id → the set of usages it was declared with.
  const usagesById = new Map<string, Set<BenchSetUsage>>();
  const dupes: string[] = [];
  const seen = new Set<string>();
  for (const s of registry) {
    if (seen.has(`${s.id}\x00${s.usage}`)) dupes.push(`${s.id} (${s.usage})`);
    seen.add(`${s.id}\x00${s.usage}`);
    const u = usagesById.get(s.id) ?? new Set<BenchSetUsage>();
    u.add(s.usage);
    usagesById.set(s.id, u);
  }

  const crossed = [...usagesById.entries()]
    .filter(([, u]) => u.has('report-on') && u.has('optimize-on'))
    .map(([id]) => id);

  const problems: string[] = [];
  if (crossed.length > 0) {
    problems.push(
      `set(s) declared BOTH optimize-on and report-on (the gym would tune on a set we report on): ${crossed.join(', ')}`,
    );
  }
  if (dupes.length > 0) {
    problems.push(`duplicate (id, usage) entries: ${dupes.join(', ')}`);
  }
  if (problems.length > 0) {
    throw new ReportSetFirewallError(
      `gym↔report-set firewall breached (P-012/D-005): ${problems.join('; ')}`,
    );
  }
}

/**
 * Fail-CLOSED gate for an explicitly-declared source set: a gym task may only be tuned on
 * if its source is a KNOWN optimize-on set. Throws if the source is report-on (the breach)
 * or unknown (an undeclared source — declare it in GYM_OPTIMIZE_ON_SETS first, so the
 * static firewall vets it). Use wherever the gym acts on a declared source id.
 */
export function assertGymMayOptimizeOn(setId: string, registry: readonly BenchSet[] = BENCH_SET_REGISTRY): void {
  if (isReportOnSet(setId, registry)) {
    throw new ReportSetFirewallError(
      `gym may not optimize on '${setId}' — it is a REPORT-ON set the impartial suite publishes scores on (P-012/D-005).`,
    );
  }
  if (!isOptimizeOnSet(setId, registry)) {
    throw new ReportSetFirewallError(
      `gym source '${setId}' is undeclared — add it to GYM_OPTIMIZE_ON_SETS so the firewall vets it (fail-closed, P-012).`,
    );
  }
}

/**
 * Normalize a repo URL + commit into a stable comparison fingerprint, so the same task
 * surfaced as `https://github.com/x/y`, `git@github.com:x/y.git`, or `.../y/` all collapse
 * to one key. Commit is lowercased (hex SHAs). This is the unit of task-level disjointness.
 */
export function taskFingerprint(repoUrl: string, repoCommit: string): string {
  const repo = repoUrl
    .trim()
    .toLowerCase()
    .replace(/^git\+/, '')
    .replace(/^[a-z]+:\/\//, '') // strip scheme (https://, ssh://, git://)
    .replace(/^git@/, '') // strip scp-style user
    .replace(/:/g, '/') // scp-style host:path → host/path
    .replace(/\.git$/, '')
    .replace(/\/+$/, ''); // trailing slashes
  return `${repo}@${repoCommit.trim().toLowerCase()}`;
}

/**
 * LAYER 2 — task-level disjointness. Returns the fingerprints present in BOTH the gym's
 * optimize-on corpus and the report-on sets (empty = clean). Pure; both inputs are
 * fingerprint iterables (build them with `taskFingerprint`).
 */
export function reportSetTaskIntersection(
  optimizeOnFingerprints: Iterable<string>,
  reportOnFingerprints: Iterable<string>,
): string[] {
  const reportOn = reportOnFingerprints instanceof Set ? reportOnFingerprints : new Set(reportOnFingerprints);
  const hit = new Set<string>();
  for (const fp of optimizeOnFingerprints) {
    if (reportOn.has(fp)) hit.add(fp);
  }
  return [...hit];
}

/** Throwing form of {@link reportSetTaskIntersection} for the external-bench ingestion side. */
export function assertGymCorpusDisjoint(
  optimizeOnFingerprints: Iterable<string>,
  reportOnFingerprints: Iterable<string>,
): void {
  const overlap = reportSetTaskIntersection(optimizeOnFingerprints, reportOnFingerprints);
  if (overlap.length > 0) {
    throw new ReportSetFirewallError(
      `gym corpus overlaps the report-on sets at ${overlap.length} task(s) — tuned-to-test contamination (P-012/D-005): ${overlap
        .slice(0, 10)
        .join(', ')}${overlap.length > 10 ? ' …' : ''}`,
    );
  }
}

/** The contamination-relevant slice of a gym task at ingestion time. */
export interface GymTaskOrigin {
  readonly taskId: string;
  readonly repoUrl?: string;
  readonly repoCommit?: string;
  /** Explicitly-declared source set, if the producer tags one (vetted fail-closed). */
  readonly sourceSet?: string;
  /** Free-form provenance (model id, 'real-feature-replay', …) — checked for a report-on slug. */
  readonly generatedBy?: string;
}

/**
 * The runtime ingestion guard — wired into `insertTask` so a report-on-originated task can
 * never enter the gym corpus. Throws on any contamination signal:
 *   • a declared `sourceSet` that isn't a legal gym optimize-on set (fail-closed);
 *   • a `generatedBy` that names a report-on suite (the "wired external-bench → gym" vector);
 *   • (when a report-on manifest is supplied) a repo@commit fingerprint that is in it.
 *
 * Fail-OPEN on an unrecognized free-form `generatedBy` (model names, 'real-feature-replay'):
 * legitimate gym tasks carry no source tag and the substrate is our own repos, so they pass
 * untouched — the guard only fires on a POSITIVE contamination signal.
 */
export function assertGymTaskNotContaminated(
  task: GymTaskOrigin,
  opts: { reportOnFingerprints?: ReadonlySet<string>; registry?: readonly BenchSet[] } = {},
): void {
  const registry = opts.registry ?? BENCH_SET_REGISTRY;

  if (task.sourceSet !== undefined) {
    assertGymMayOptimizeOn(task.sourceSet, registry);
  }

  if (task.generatedBy !== undefined && isReportOnSet(task.generatedBy, registry)) {
    throw new ReportSetFirewallError(
      `gym task '${task.taskId}' is generated_by report-on set '${task.generatedBy}' — the impartial suite reports on it; the gym must not tune on it (P-012/D-005).`,
    );
  }

  if (opts.reportOnFingerprints && task.repoUrl && task.repoCommit) {
    const fp = taskFingerprint(task.repoUrl, task.repoCommit);
    if (opts.reportOnFingerprints.has(fp)) {
      throw new ReportSetFirewallError(
        `gym task '${task.taskId}' (${fp}) is a member of a report-on benchmark set — refusing to admit it to the gym corpus (P-012/D-005).`,
      );
    }
  }
}
