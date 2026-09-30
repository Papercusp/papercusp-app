/**
 * Scout lens registry (P-004, D-004) — the forced-diversity engine.
 *
 * A single "be creative" prompt regresses to the median idea. Novelty comes from
 * structurally forcing each ideator away from the mode: N ideators, each a
 * *distinct* {@link CreativeLens}, the analogical lens additionally seeded with a
 * *distant domain* so even multiple analogical ideators diverge. This file owns:
 *
 *  - {@link LENS_REGISTRY} — the four lenses + their generative stances.
 *  - {@link DISTANT_DOMAINS} — the priming pool for the analogical lens.
 *  - {@link buildIdeatorPrompt} — pure (system, user) construction per ideator.
 *  - {@link flattenDigest} / {@link renderDigest} — the grounded substrate the
 *    ideators read (each pattern carries a `ref` the idea must cite).
 *
 * Everything here is pure + deterministic (no LLM, no clock) so the
 * anti-mode-collapse property is unit-tested directly: distinct lenses ⇒
 * pairwise-distinct system prompts; distinct distant domains ⇒ distinct prompts.
 */
import type { CorpusDigest, CreativeLens, MetaPattern, MetaPatternCategory } from './types';
import { CREATIVE_LENSES } from './types';

/** A distant domain + the one-line mechanism it offers, used to prime analogical ideation. */
export interface DistantDomain {
  key: string;
  /** How this domain solves a structurally-general problem — the transplant source. */
  prime: string;
}

/**
 * The distant-domain priming pool (D-004). The plan names immune systems,
 * markets, ant colonies, and CPU schedulers explicitly; the rest widen the
 * search so repeated analogical cycles keep finding fresh transplants.
 */
export const DISTANT_DOMAINS: readonly DistantDomain[] = [
  {
    key: 'immune-systems',
    prime:
      'distinguishes self from non-self, builds durable memory of past threats, and mounts a graduated, escalating response while tolerating the benign — with no central controller.',
  },
  {
    key: 'markets',
    prime:
      'allocate scarce resources through decentralized price signals; local actors reacting to one number make surplus and shortage self-correct.',
  },
  {
    key: 'ant-colony-stigmergy',
    prime:
      'coordinate through environmental traces (pheromone gradients) that evaporate over time — indirect coordination among memoryless agents that still converges on short paths.',
  },
  {
    key: 'cpu-schedulers',
    prime:
      'multiplex many jobs over few cores via priority, aging to prevent starvation, preemption, and work-stealing across per-core queues.',
  },
  {
    key: 'ecology-food-webs',
    prime:
      'keep a system stable through redundancy and keystone species; energy flows through trophic levels and diversity buffers shocks.',
  },
  {
    key: 'memory-consolidation-sleep',
    prime:
      'replays the day offline, compresses episodic events into durable schemas, and prunes the unimportant — separating capture from consolidation.',
  },
  {
    key: 'epidemiology-contagion',
    prime:
      'models spread via R0, super-spreaders, and herd immunity; ring-fencing and contact-tracing contain an outbreak before it saturates.',
  },
  {
    key: 'control-theory-feedback',
    prime:
      'holds a setpoint with PID feedback — proportional/integral/derivative terms damp oscillation and reject disturbance without manual tuning each step.',
  },
  {
    key: 'mycelial-networks',
    prime:
      'route nutrients across a forest through a fungal mesh, reinforcing productive links and rerouting around damage — a self-healing logistics fabric.',
  },
  {
    key: 'jazz-improvisation',
    prime:
      'produces novel coherent output in real time from a shared harmonic frame, trading the lead, and "comping" to support whoever is soloing.',
  },
] as const;

/** A lens definition: its label and the generative stance that makes it distinct. */
export interface LensDef {
  lens: CreativeLens;
  label: string;
  /** The lens-specific creative stance — the divergent core of the system prompt. */
  stance: string;
  /** Whether this lens is primed with a distant domain (only `analogical`). */
  usesDistantDomain: boolean;
}

/**
 * The four lenses (D-004). Each stance is *structurally* different so the
 * ideators explore different regions of idea-space and cannot collapse to the
 * same median proposal.
 */
export const LENS_REGISTRY: Record<CreativeLens, LensDef> = {
  analogical: {
    lens: 'analogical',
    label: 'Analogical transfer',
    usesDistantDomain: true,
    stance: [
      'Map a solution from a DISTANT domain onto a Hive bottleneck.',
      'You are primed with one distant domain (below). Study HOW that domain solves a',
      'structurally similar problem, then transplant the *mechanism* — not the surface',
      'vocabulary — onto a specific friction in the digest. The leap is the transplant:',
      'name the structural correspondence explicitly, then the Hive mechanism it implies.',
    ].join(' '),
  },
  'first-principles': {
    lens: 'first-principles',
    label: 'First-principles redesign',
    usesDistantDomain: false,
    stance: [
      'Ignore how the Hive does this TODAY. Take the underlying goal a friction or gap',
      'in the digest is really serving, and derive the ideal mechanism from scratch —',
      'as if nothing existed yet. Reason from the goal backward to the simplest design',
      'that would achieve it, unconstrained by the current architecture. The leap is the',
      'gap between the from-scratch ideal and what exists.',
    ].join(' '),
  },
  reframing: {
    lens: 'reframing',
    label: 'Reframing / problem-finding',
    usesDistantDomain: false,
    stance: [
      'Do NOT solve the stated problems. Find the REAL constraint nobody named.',
      'For a cluster of frictions in the digest, ask what single deeper constraint',
      'generates them all — reframe what the actual bottleneck is. The best ideas',
      'redefine the problem so the original symptoms dissolve. Output the reframing',
      'plus the idea it unlocks.',
    ].join(' '),
  },
  'constraint-removal': {
    lens: 'constraint-removal',
    label: 'Constraint removal',
    usesDistantDomain: false,
    stance: [
      'Identify a load-bearing ASSUMPTION in how the Hive currently operates (one the',
      'digest reveals everyone treats as fixed), then imagine it were FALSE. What',
      'becomes possible that is impossible today? Propose the idea that assumption was',
      'silently blocking. The leap is naming the assumption and the capability its',
      'removal unlocks.',
    ].join(' '),
  },
};

/**
 * Collapse a {@link CorpusDigest} into one flat list of patterns, stamping each
 * with the category lane it came from. Used both to render the grounded prompt
 * and to validate an idea's `addressesPatternRefs` against real refs.
 */
export function flattenDigest(digest: CorpusDigest): MetaPattern[] {
  const lanes: Array<[MetaPatternCategory, MetaPattern[]]> = [
    ['recurring-friction', digest.recurringFriction ?? []],
    ['time-token-sink', digest.timeTokenSinks ?? []],
    ['chronic-deferral', digest.chronicDeferrals ?? []],
    ['capability-gap', digest.capabilityGaps ?? []],
    // P-006: structured rubric measurements ride the same flatten so the ideators
    // leap from them. `?? []` keeps a 4-lane (pre-rubric) digest byte-identical.
    ['rubric-rating', digest.rubricRatings ?? []],
    // L1c (queen-memory-hybrid): standing facts ride the flatten too — the
    // fleet's deterministic conclusions as ideation substrate.
    ['standing-fact', digest.standingFacts ?? []],
    // NOV-1 (gym-unwedge): the QD niche map — occupied behavior-space niches
    // steer generation toward unexplored territory.
    ['niche-map', digest.nicheMap ?? []],
    // P-007 (blender-self-learning): chronic watchdog signals ride the flatten
    // so ideation targets measured infrastructure pain directly.
    ['watchdog-health', digest.watchdogHealth ?? []],
    ['pty-host-health', digest.ptyHostHealth ?? []],
    ['ci-test-health', digest.ciTestHealth ?? []],
    ['workspace-host-health', digest.workspaceHostHealth ?? []],
    ['system-health-flap', digest.systemHealthFlaps ?? []],
    ['rework-lesson', digest.reworkLessons ?? []],
    ['browser-crash-health', digest.browserCrashHealth ?? []],
    // P-010 (blender-self-learning): the release ship-path incident rides the
    // flatten so ideation targets chronic gate/pipeline pain directly.
    ['gate-pipeline-health', digest.gatePipelineHealth ?? []],
    // P-008 (blender-self-learning): coordination breakdown rides the flatten so
    // ideation targets escalation storms / unanswered mail / wake floods directly.
    ['coord-health', digest.coordHealth ?? []],
    // P-009 (blender-self-learning): measured tool DX friction rides the flatten so
    // ideation targets failing / slow / arg-limit-rejecting / over-called tools directly.
    ['tool-telemetry', digest.toolTelemetry ?? []],
    // P-011: four deferred curation signals, projected from existing ledgers.
    ['spend-anomaly', digest.spendAnomalies ?? []],
    ['owner-correction', digest.ownerCorrections ?? []],
    ['knowledge-reuse-gap', digest.knowledgeReuseGaps ?? []],
    ['plan-health', digest.planHealth ?? []],
    // NOV-2 (autonomous-loop-prod-audit-2026-07-02 / WI-4635): recent-commit churn
    // hotspots ride the flatten so ideation also sees where the tree is actively
    // morphing right now, independent of whether a work-item tracked the edit.
    ['recent-commit', digest.recentCommits ?? []],
  ];
  const out: MetaPattern[] = [];
  for (const [category, patterns] of lanes) {
    for (const p of patterns) {
      out.push({ ...p, category: p.category ?? category });
    }
  }
  return out;
}

/** The set of valid refs in a digest (for grounding an idea's citations). */
export function digestRefSet(digest: CorpusDigest): Set<string> {
  return new Set(flattenDigest(digest).map((p) => p.ref));
}

/** Human-readable category label for the rendered prompt. */
function categoryLabel(c: MetaPatternCategory): string {
  switch (c) {
    case 'recurring-friction':
      return 'Recurring friction';
    case 'time-token-sink':
      return 'Time / token sink';
    case 'chronic-deferral':
      return 'Chronic deferral';
    case 'capability-gap':
      return 'Capability gap';
    case 'rubric-rating':
      return 'Rubric rating';
    case 'standing-fact':
      return 'Standing fact (deterministic conclusion — ground truth unless retracted)';
    case 'niche-map':
      return 'QD niche map (novelty guidance — occupied niches; propose in UNEXPLORED behavior-space)';
    case 'watchdog-health':
      return 'Watchdog health (chronic measured infrastructure signal — 15min collectors)';
    case 'pty-host-health':
      return 'PTY host health (persisted delivery failures and recovered retries)';
    case 'ci-test-health':
      return 'CI test health (repeated gate file failures and same-commit local divergence)';
    case 'workspace-host-health':
      return 'Workspace host health (managed operation failures and later host recovery)';
    case 'system-health-flap':
      return 'System health flap (critical transitions and time back to OK)';
    case 'rework-lesson':
      return 'Rework lesson (explicit reason attached to a deprecated work item)';
    case 'browser-crash-health':
      return 'Browser render crash (redacted local telemetry)';
    case 'gate-pipeline-health':
      return 'Gate / pipeline health (release ship-path — standing reds, promotion/deploy stall, chronic pipeline failures)';
    case 'coord-health':
      return 'Coord health (coordination breakdown — escalation storms, unanswered directed mail, inbox/wake floods, claim conflicts)';
    case 'tool-telemetry':
      return 'Tool telemetry (measured DX friction — per-tool error rates, arg-limit rejections, retry/batching-waste loops, chronic p95 latency)';
    case 'spend-anomaly':
      return 'Spend anomaly (cost attribution or concentration outside the raw spend-sink view)';
    case 'owner-correction':
      return 'Owner correction (explicit low grade or verified owner-turn conclusion)';
    case 'knowledge-reuse-gap':
      return 'Knowledge reuse gap (repeated zero-hit demand or reusable knowledge aging unused)';
    case 'plan-health':
      return 'Plan health (lifecycle drift, drained-but-unclosed work, or stale planning backlog)';
    case 'recent-commit':
      return 'Recent-commit churn (repo areas under active edit right now — exogenous entropy, not resampled from the tracked-completions view)';
  }
}

/** One rendered pattern line — the format the ideators cite refs from. */
function patternLine(p: MetaPattern): string {
  const cat = p.category ? categoryLabel(p.category) : 'Pattern';
  const detail = p.detail ? ` — ${p.detail}` : '';
  return `- [${cat}] (ref: ${p.ref}) ${p.summary}${detail}`;
}

/**
 * Render the digest as the grounded substrate for an ideator's user prompt:
 * each meta-pattern as a line tagged with its category and its `ref` (which the
 * ideator must cite in `addressesPatternRefs`). Deterministic ordering.
 *
 * DELTA-FIRST (blender-self-learning-2026-07-12 P-003 / WI-4319): when the
 * cycle seam stamped {@link CorpusDigest.previousCycleRefs} (the refs the
 * previous fired cycle's persisted snapshot carried — scout_digest_snapshots,
 * migration 582), the render SPLITS — "NEW since your last cycle" first,
 * standing patterns after — so the ideators weight fresh signal instead of
 * re-pitching the standing corpus into dedup declines. No stamp (first-ever
 * cycle, empty snapshot store, or the legacy path) ⇒ the flat whole-digest
 * render, byte-identical to the pre-delta output.
 */
export function renderDigest(digest: CorpusDigest): string {
  const lines: string[] = [];
  if (digest.headline) lines.push(`State of the Hive: ${digest.headline}`, '');
  // DEDUP-BURN saturation banner (P-007 / WI-39479): the guard measured the last
  // N cycles burning ≥ threshold of their ideas as dedup declines — tell the
  // ideators plainly, before any patterns, that the obvious pitches are spent.
  const saturation = digest.dedupSaturation;
  if (saturation) {
    lines.push(
      `⚠ CORPUS SATURATED — your last ${saturation.consecutiveSaturated} cycle(s) were burned almost entirely as duplicates of already-tried ideas.`,
      'The obvious ideas from the standing corpus are SPENT. Pitch ONLY angles you have not seen tried: cross-domain transfers, inversions of a standing pattern, or ideas grounded in the freshest signal below.',
      '',
    );
  }
  const flat = flattenDigest(digest);
  if (flat.length === 0) {
    lines.push('(no meta-patterns surfaced this cycle)');
    return lines.join('\n');
  }
  const prev = digest.previousCycleRefs;
  if (prev && prev.length > 0) {
    const prevSet = new Set(prev);
    const fresh = flat.filter((p) => !prevSet.has(p.ref));
    const standing = flat.filter((p) => prevSet.has(p.ref));
    lines.push('## NEW since your last cycle — weight these MOST');
    lines.push(
      fresh.length > 0
        ? fresh.map(patternLine).join('\n')
        : '(no new patterns since your last cycle — lean on the standing ones only where you see a genuinely untried angle)',
    );
    // Saturation REFRESH (P-007): with fresh signal available, DROP the standing
    // patterns entirely — a saturated corpus re-shown is a saturated corpus
    // re-pitched. With no fresh signal, the standing render stays (an empty
    // prompt grounds nothing), carrying the banner's warning instead.
    if (standing.length > 0 && !(saturation && fresh.length > 0)) {
      lines.push(
        '',
        '## Standing patterns (already seen last cycle — the obvious ideas were likely already pitched; leap from these only with a NEW angle)',
        standing.map(patternLine).join('\n'),
      );
    }
    return lines.join('\n');
  }
  for (const p of flat) {
    lines.push(patternLine(p));
  }
  return lines.join('\n');
}

/**
 * The default ideator MISSION framing (P-010 scout prompt-overlay seam,
 * domain-generic-hive-architecture-2026-06-18 D-004) — who the scout is + what it
 * scouts FOR. Coding/Papercusp-flavored by default; a `work` hive overrides it via
 * the blueprint `scout.framing.ideatorMission` block so ideation is framed for its
 * domain. This is the DOMAIN framing only — the lens stances, grounding rules, and
 * JSON output contract are the engine MECHANISM and stay hardcoded (P-011).
 *
 * Exported so {@link DEFAULT_SCOUT_FRAMING} (config.ts) is built FROM it (anti-drift,
 * same discipline as DEFAULT_SCOUT_CONFIG). The literal newline separates the two
 * framing lines, so substituting it back yields byte-identical output to the
 * pre-seam prompt.
 */
export const DEFAULT_IDEATOR_MISSION = [
  'You are a SCOUT — an autonomous ideator for the Hive, a multi-agent coding platform that improves itself.',
  'Your job is the deliberate creative LEAP: broad, novel ideas that day-to-day work never surfaces.',
].join('\n');

/** Inputs to building one ideator's prompt. */
export interface BuildIdeatorPromptInput {
  lens: CreativeLens;
  digest: CorpusDigest;
  /** The distant domain this analogical ideator is primed with (required iff usesDistantDomain). */
  seedDomain?: DistantDomain;
  /** Max ideas this ideator should return (default 3). */
  maxIdeas?: number;
  /**
   * Per-blueprint MISSION framing override (P-010). Replaces the default
   * coding-platform framing with the hive's domain framing. Absent ⇒
   * {@link DEFAULT_IDEATOR_MISSION} (byte-identical to the pre-seam prompt).
   */
  mission?: string;
  /**
   * Optional gym-QD stepping-stone priming (P-012 archive→Scout): a formatted block
   * of diverse elites the gym has already discovered, appended to the grounded
   * substrate so the ideator builds on / leaps away from them rather than
   * re-deriving them. Empty/absent ⇒ no priming (pre-archive cold start).
   */
  priming?: string;
  /**
   * Explicit niche-map guidance (P-006/P-007): the crowded niches to avoid and
   * empty-adjacent niches to target. Kept separate from generic priming so it
   * lands as a dedicated section beside the lens framing.
   */
  nicheMapPriming?: string;
  /**
   * DETERMINISTIC rubric seeding (blender-self-learning-2026-07-12 P-004): a
   * formatted block of the worst measured rubric criteria this cycle. When set,
   * the ideator is REQUIRED to ground at least one idea in one of these refs —
   * the audit (WI-4250) found 0/116 routed ideas EVER cited a rubric pattern
   * because the lane just rode the flat digest and hoped for salience. The
   * roster gives this to a designated slot each cycle (ideators.ts), so rubric
   * measurements reliably generate ideas instead of hopefully.
   */
  rubricFocus?: string;
}

/**
 * PURE: the deterministic rubric-focus block for this cycle — the first
 * `limit` patterns of the digest's rubricRatings lane (the digest builder
 * orders them worst-first), rendered with their citable refs. Undefined when
 * the lane is empty (no rubric measurements ⇒ no forced focus).
 */
export function buildRubricFocus(digest: CorpusDigest, limit = 3): string | undefined {
  const pats = digest.rubricRatings ?? [];
  if (pats.length === 0) return undefined;
  return pats
    .slice(0, Math.max(1, limit))
    .map((p) => `- (ref: ${p.ref}) ${p.summary}${p.detail ? ` — ${p.detail}` : ''}`)
    .join('\n');
}

/**
 * Build the (system, user) prompt for one ideator. Pure + deterministic. The
 * system encodes the shared Scout framing + the lens's distinct stance + the
 * strict JSON output contract; the user carries the grounded digest. Distinct
 * lenses (and distinct distant domains) yield distinct system prompts — the
 * anti-mode-collapse invariant the tests pin.
 */
export function buildIdeatorPrompt(input: BuildIdeatorPromptInput): { system: string; user: string } {
  const def = LENS_REGISTRY[input.lens];
  const maxIdeas = input.maxIdeas ?? 3;

  // P-010: the domain MISSION framing is blueprint-overridable; the lens stance +
  // rules + output contract below are the engine mechanism and stay hardcoded.
  const system: string[] = [input.mission ?? DEFAULT_IDEATOR_MISSION, '', `## Your lens: ${def.label}`, def.stance];

  if (def.usesDistantDomain) {
    const dom = input.seedDomain;
    system.push(
      '',
      '## Your primed distant domain',
      dom ? `${dom.key}: ${dom.prime}` : '(no domain assigned — pick one genuinely distant from software and name it)',
    );
  }

  if (input.nicheMapPriming && input.nicheMapPriming.trim()) {
    system.push('', '## Federated niche guidance', input.nicheMapPriming.trim());
  }

  if (input.rubricFocus && input.rubricFocus.trim()) {
    system.push(
      '',
      '## Rubric focus — MEASURED regressions from the fleet scorecards',
      'These are the worst-measured rubric criteria right now. At least ONE of your ideas MUST address one of them — cite its exact ref in `addressesPatternRefs`:',
      input.rubricFocus.trim(),
    );
  }

  system.push(
    '',
    '## Rules',
    '- Do NOT propose the obvious, incremental, or already-tried. Each idea must be a genuine leap through your lens.',
    "- GROUND every idea in the Hive's real history: cite the `ref`(s) of the digest meta-pattern(s) it addresses in `addressesPatternRefs`. An idea that grounds in nothing will be rejected downstream.",
    '- If federated mutation seeds are provided, ADAPT them to local friction instead of copying them. Cite any foreign elite you actively reuse in optional `seededByRefs`.',
    '- State the concrete `mechanism` — HOW it would work. No hand-waving.',
    '- Diverge: prefer one strong unexpected idea over three safe ones.',
    "- EXISTENCE CHECK: this is a mature, actively-developed platform. A well-known operational category (rate-limit ladders, per-account throttling, egress rotation, circuit breakers, retries, caching, scheduling) is more likely to already exist here than not. You have no code access, so NEVER assert a gap exists as fact — phrase it as an explicit, falsifiable claim the reader must verify (e.g. \"I found no evidence of X in the digest above; verify before building\"), and say so in `body`.",
    '- EVIDENCE-CLASS CHECK: if you cite a specific incident/log/ticket as support, its own description must be the SAME CLASS of event as your hypothesis (e.g. a local rate-governor pause is NOT an upstream HTTP 429 — do not conflate them). Citing evidence that contradicts your own claim is worse than citing none.',
    '',
    '## Output',
    `Return ONLY a JSON object (no prose, no code fences), at most ${maxIdeas} ideas:`,
    '{"ideas":[{"title":"<short>","body":"<what it is and why it could matter>","mechanism":"<how it works>","addressesPatternRefs":["<ref>",...]' +
      ',"seededByRefs":["<elite-ref>",...]' +
      (def.usesDistantDomain ? ',"seedDomain":"<the domain key you transplanted>"' : '') +
      '}]}',
  );

  const user: string[] = [
    '## The state of the Hive (your grounded substrate)',
    'Each line is a cross-corpus meta-pattern with a `ref` to drill back. Anchor your leaps to these.',
    '',
    renderDigest(input.digest),
  ];

  // P-012 archive→Scout: stepping-stones the gym's QD archive has already discovered.
  if (input.priming && input.priming.trim()) {
    user.push('', input.priming.trim());
  }

  return { system: system.join('\n'), user: user.join('\n') };
}

/**
 * Assign a distant domain to the i-th analogical ideator, rotating the pool so
 * repeated analogical ideators in one cycle each get a *different* domain
 * (preserving intra-lens diversity). `order` overrides the pool for determinism
 * in tests.
 */
export function assignDistantDomain(index: number, order: readonly DistantDomain[] = DISTANT_DOMAINS): DistantDomain {
  return order[index % order.length];
}

/** The default ideator roster: one ideator per lens (the four-way divergence). */
export function defaultLensRoster(): readonly CreativeLens[] {
  return CREATIVE_LENSES;
}
