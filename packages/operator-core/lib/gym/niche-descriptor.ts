/**
 * niche-descriptor — NicheDescriptorV1, the shared behavior-space vocabulary
 * (federated-scout-gym-learning-2026-07-02 F0-1 / D-002).
 *
 * THE MERGE PREREQUISITE: federated QD only works if heterogeneous peers
 * describe niches COMPARABLY — the niche KEY is the join for archive merges and
 * the repulsion map. v1 is a small FIXED schema (~324 niches: 6×6×3×3), owner-
 * ratified, chosen over embedding-space niches for v1 because it is
 * deterministic, versioned, and trivially mergeable; the WIRE FORMAT carries
 * `v`, so a future v2 (embedding buckets) can coexist — merge happens ONLY
 * within a same-`v` space, and {@link mapV1KeyForward} is the reserved seam for
 * a lossless v1→v2 key mapping (pre-planned so the archive never bifurcates).
 *
 * Classification: routing-time LLM classification is the intended primary
 * (the scout router already runs LLM steps); {@link classifyHeuristically} is
 * the DETERMINISTIC fallback (keyword-scored, total — always returns a valid
 * descriptor) and the v1 bootstrap used by the validation gate (classify the
 * existing routed ideas; owner eyeballs the assignments before anything
 * federates — garbage descriptors = meaningless map, the plan's #1 risk).
 */

export const NICHE_DESCRIPTOR_V = 1 as const;

export const NICHE_SURFACES = ['loop', 'substrate', 'ui', 'infra', 'process', 'agent-behavior'] as const;
export type NicheSurface = (typeof NICHE_SURFACES)[number];

export const NICHE_SHAPES = ['guard', 'automation', 'capability', 'integration', 'refactor', 'observability'] as const;
export type NicheShape = (typeof NICHE_SHAPES)[number];

/** 1 = reversible/config, 2 = code within one subsystem, 3 = cross-cutting/irreversible-leaning. */
export type NicheRisk = 1 | 2 | 3;
/** s = one seam/file, m = one subsystem, l = cross-cutting. */
export type NicheSize = 's' | 'm' | 'l';

export interface NicheDescriptorV1 {
  v: typeof NICHE_DESCRIPTOR_V;
  surface: NicheSurface;
  shape: NicheShape;
  risk: NicheRisk;
  size: NicheSize;
}

/** The deterministic merge/join key. NEVER change this format for v=1. */
export function nicheKeyV1(d: NicheDescriptorV1): string {
  return `v1:${d.surface}/${d.shape}/r${d.risk}/${d.size}`;
}

/** Parse a v1 key back (null on anything else — including future versions). */
export function parseNicheKeyV1(key: string): NicheDescriptorV1 | null {
  const m = /^v1:([a-z-]+)\/([a-z-]+)\/r([123])\/([sml])$/.exec(key);
  if (!m) return null;
  const [, surface, shape, risk, size] = m;
  if (!(NICHE_SURFACES as readonly string[]).includes(surface)) return null;
  if (!(NICHE_SHAPES as readonly string[]).includes(shape)) return null;
  return {
    v: NICHE_DESCRIPTOR_V,
    surface: surface as NicheSurface,
    shape: shape as NicheShape,
    risk: Number(risk) as NicheRisk,
    size: size as NicheSize,
  };
}

/** Reserved v1→v2 seam (D-002): identity until v2 exists. Centralizing the
 *  mapping NOW is what prevents an archive bifurcation at the transition. */
export function mapV1KeyForward(key: string): string {
  return key;
}

const SURFACE_KEYWORDS: Record<NicheSurface, RegExp> = {
  loop: /\b(queen|bee|scout|overwatch|hive|placement|wake|autoloop|gym|ideat|routed|brief|dossier)\b/i,
  substrate: /\b(substrate|hyperbee|hyperswarm|peer[- ]log|federat|swarm|announce|admission|epoch|replicat|sidecar)\b/i,
  ui: /\b(ui|panel|tab|dashboard|render|button|view|frontend|nuqs|dialog|popup)\b/i,
  infra: /\b(pg|postgres|database|dsn|systemd|cgroup|gateway|deploy|restart|memory|oom|container|bouncer|migration|routine)\b/i,
  process: /\b(plan|workflow|triage|review|escalat|checklist|discipline|prompt|persona|grading|owner)\b/i,
  'agent-behavior': /\b(agent|session|context|compaction|checkpoint|memory:|facts|lens|novelty|prim(e|ing))\b/i,
};

// Validation-gate rebalance (F0-1 finding, 15:40): the first guard set was too
// greedy (detect/gate/sweep/protect matched everywhere → 9/11 of the real corpus
// collapsed to guard). Each shape now anchors on STRONG, distinctive signals;
// generic verbs live in at most one shape.
const SHAPE_KEYWORDS: Record<NicheShape, RegExp> = {
  guard: /\b(watchdog|backstop|recurrence guard|kill.?switch|circuit.?breaker|dead.?man|tripwire|quarantine)\b/i,
  automation: /\b(cron|schedule[dr]?|routine|auto-?(start|promote|pause|repair|assign)|unattended|pipeline)\b/i,
  capability: /\b(new (tool|verb|surface|table|panel)|introduce|enable a|support for|first-class)\b/i,
  integration: /\b(integrat|wire (in|up|into)|bridge|federat|cross-(hive|machine|harness)|interop|connect(or)? to)\b/i,
  refactor: /\b(refactor|simplif|consolidat|extract|dedup(licat)?|unif(y|ied)|replace|retire|collapse)\b/i,
  observability: /\b(observab|metric|telemetry|dashboard|scorecard|freshness|verbatim|surface (the|every)|diagnos|escalat|alert|report)\b/i,
};

/**
 * DETERMINISTIC total classifier: keyword-score each dimension; ties break by
 * declaration order (stable). Risk/size from cheap textual signals. Always
 * returns a valid descriptor — the routing-time LLM classifier may OVERRIDE it,
 * but merge/map code can rely on this never failing.
 */
export function classifyHeuristically(text: string): NicheDescriptorV1 {
  const pick = <T extends string>(dims: readonly T[], table: Record<T, RegExp>, zeroSignal: T): T => {
    let best: T = dims[0];
    let bestScore = -1;
    for (const d of dims) {
      // One global count per dimension (the first cut double-counted, amplifying
      // whichever regex was greediest — part of the guard-collapse finding).
      const score = (text.match(new RegExp(table[d].source, 'gi')) ?? []).length;
      if (score > bestScore) {
        best = d;
        bestScore = score;
      }
    }
    // VALIDATION-GATE CONCLUSION (F0-1, second pass): short texts (titles) often
    // match NO shape keyword — an implicit first-dim default silently collapsed
    // 7/8 of the real corpus to 'guard'. Zero signal now maps to an EXPLICIT
    // neutral default, and the standing rule is: this heuristic is the FALLBACK;
    // routing-time LLM classification is REQUIRED as primary before any elite
    // federates (D-002 as designed).
    return bestScore > 0 ? best : zeroSignal;
  };
  const surface = pick(NICHE_SURFACES, SURFACE_KEYWORDS, 'process');
  const shape = pick(NICHE_SHAPES, SHAPE_KEYWORDS, 'capability');
  const risk: NicheRisk = /\b(irreversib|destructive|migrat|schema|security|revoc|crypt)\b/i.test(text)
    ? 3
    : /\b(config|toggle|flag|prompt|doc|threshold|tune)\b/i.test(text)
      ? 1
      : 2;
  const size: NicheSize = /\b(cross-cutting|fleet-wide|every (agent|role|hive)|network|all )\b/i.test(text)
    ? 'l'
    : /\b(one[- ](line|file|seam)|single|small|tiny)\b/i.test(text)
      ? 's'
      : 'm';
  return { v: NICHE_DESCRIPTOR_V, surface, shape, risk, size };
}
