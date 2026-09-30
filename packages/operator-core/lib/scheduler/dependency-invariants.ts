/**
 * dependency-invariants.ts — the dependency subsystem's invariants, named and executable.
 *
 * Plan: dependency-subsystem-thorough-testing-2026-08-02 (P-001).
 *
 * WHY THIS FILE EXISTS. The dependency subsystem is not under-tested by volume:
 * ~85 test files and 1,500+ tests touch it. It is heavily tested and it still
 * shipped, for months, an oracle hardcoded to workspace 'default'; six promotion
 * edges that gated nothing; and every issue-family edge `syncFeatureBlockEdges`
 * wrote, inert by construction. Every one of those escapes had green coverage at
 * the time.
 *
 * The reason coverage could not help is that the CLAIMS were never written down.
 * "A written edge gates nothing" was not a proposition anyone had stated, so no
 * test could be said to be missing it. This registry states them. Each entry is a
 * proposition that is either true of the system or is a bug — never a description
 * of how the code currently behaves.
 *
 * HOW IT IS USED. Tests cite the invariants they prove via `@covers INV-NN` in a
 * describe/it title or a comment, and `coveredInvariants()` extracts them. Coverage
 * then reads as "which invariants are PROVEN", not as a line percentage — the
 * escaped bugs were all inside covered lines, so a line percentage was exactly the
 * metric that could not see them.
 *
 * THIS FILE IS DATA, NOT LOGIC. It imports nothing from the subsystem it describes,
 * so it can never drift into asserting the implementation against itself, and a test
 * may import it without pulling in PG or the claim path.
 */

/** Which part of the subsystem an invariant binds. */
export type InvariantArea =
  | 'ref-vocabulary'
  | 'effectiveness'
  | 'claim-doors'
  | 'graph-shape'
  | 'tenancy'
  | 'observability';

export interface DependencyInvariant {
  /** Stable id. NEVER renumber or reuse — tests cite these by string. */
  readonly id: string;
  readonly area: InvariantArea;
  /** One sentence, stated as a proposition that is true of a correct system. */
  readonly statement: string;
  /**
   * What going wrong looks like in production — concrete, and drawn from a real
   * incident wherever one exists. This is the field that makes an invariant
   * testable: it names the observable, not the intention.
   */
  readonly violationLooksLike: string;
  /** Code paths bound by this invariant. Repo-relative, no globs. */
  readonly binds: readonly string[];
  /** Incident/decision refs that motivated it, for anyone tempted to relax it. */
  readonly provenance: readonly string[];
  /**
   * Set when an invariant has been CORRECTED — what it used to say, why that was wrong, and
   * how the correct statement was established.
   *
   * An invariant is a claim about the system, so it can be wrong, and a silently-edited one
   * is worse than a wrong one: the next reader sees a confident proposition with no trace of
   * the reasoning that moved it, and the natural next edit moves it back. Provenance covers
   * "why does this exist"; this covers "why does it say THIS and not the obvious thing".
   */
  readonly note?: string;
}

/** The shared consumers that must render the same dependency-policy result. */
export const DEPENDENCY_POLICY_SURFACES = ['admission', 'lint', 'monitor', 'tool', 'ui'] as const;
export type DependencyPolicySurface = (typeof DEPENDENCY_POLICY_SURFACES)[number];

/** Hard findings reject, advisory findings surface, and healthy shapes suppress noise. */
export type DependencyPolicyClassification = 'hard-block' | 'advisory' | 'healthy';
export type DependencyPolicyAction = 'reject' | 'alert' | 'suppress';
export type DependencyPolicyConfidence = 'deterministic' | 'high' | 'medium';
export type DependencyPolicySuppression = 'never' | 'structured-rationale' | 'automatic';
export type DependencyPolicyEvidence =
  | 'exact-nodes'
  | 'exact-edges'
  | 'path'
  | 'before-after'
  | 'lifecycle-state'
  | 'scope-resolution'
  | 'batch-members'
  | 'provenance'
  | 'topology-metrics'
  | 'external-condition';

/**
 * Machine-readable policy attached to one graph-shape or transition code.
 *
 * Finding instances add the concrete evidence named by `evidence`; this static
 * row supplies the classification, confidence, provenance, suppression contract,
 * and suggested action that every tool and UI projection must share.
 */
export interface DependencyPolicyRule {
  /** Stable kebab-case code emitted by analysers and mutation admission. */
  readonly code: string;
  readonly classification: DependencyPolicyClassification;
  readonly action: DependencyPolicyAction;
  readonly confidence: DependencyPolicyConfidence;
  readonly suppression: DependencyPolicySuppression;
  readonly summary: string;
  readonly evidence: readonly DependencyPolicyEvidence[];
  /** Null only for an explicitly healthy shape that needs no corrective action. */
  readonly suggestedAction: string | null;
  /** Registry propositions this policy realizes. */
  readonly invariantIds: readonly string[];
  /** Decision/requirement refs carried into every materialized finding. */
  readonly provenance: readonly string[];
}

/** Concrete classifier result shared by lint, admission, tools, monitors, and UI. */
export interface DependencyPolicyFinding {
  code: string;
  classification: DependencyPolicyClassification;
  confidence: DependencyPolicyConfidence;
  nodes: string[];
  edges: Array<{ subject: string; dependency: string }>;
  evidence: Record<string, unknown>;
  provenance: string[];
  suggestedAction: string | null;
  suppressedBy?: { kind: 'structured-rationale'; refs: string[] };
}

/**
 * The invariants.
 *
 * Ordering is by area, not importance. INV-01..INV-04 are the ones with a
 * documented escape behind them; treat a proposed change to those as a design
 * change, not a test change.
 */
export const DEPENDENCY_INVARIANTS: readonly DependencyInvariant[] = [
  // ---- ref vocabulary -----------------------------------------------------
  {
    id: 'INV-01',
    area: 'ref-vocabulary',
    statement:
      "A dependency endpoint's ref FORM is determined by that endpoint's OWN family: feature-family endpoints are harness-qualified ('<harness>#<id>'), issue-family endpoints are bare ('<id>').",
    violationLooksLike:
      "An edge row is written whose blocker_ref is harness-qualified while the blocker is an issue-family row. The row is well-formed, passes count and symmetry checks, and the blocking oracle's join never matches it — so the edge exists and withholds nothing.",
    binds: [
      'packages/operator-core/lib/dbos/work-item-deps-store.ts',
      'packages/operator-core/lib/dbos/feature-blockers-edges.ts',
    ],
    provenance: ['work-item-dependency-edges-2026-08-02#D-009', 'work-item-dependency-edges-2026-08-02#D-017'],
  },
  {
    id: 'INV-02',
    area: 'ref-vocabulary',
    statement: "An edge endpoint's declared *_kind agrees with the family of the row it actually resolves to.",
    violationLooksLike:
      "An edge declares kind 'feature' while its target id resolves to an engineer_issues row. Form-valid, inert. Three such rows were live on 2026-08-02.",
    binds: ['packages/operator-core/lib/dbos/work-item-deps-store.ts'],
    provenance: ['EI-19325959789634791', 'work-item-dependency-edges-2026-08-02#D-017'],
  },
  {
    id: 'INV-03',
    area: 'ref-vocabulary',
    statement: 'Renaming a pot/harness leaves NO dependency edge or coord_link still naming the old slug.',
    violationLooksLike:
      "After a rename, 8 edges still carried 'papercusp-public-site#WI-54xx' while the items lived under 'papercusp-public-site-pot'. Every one of those blocking relationships was silently deactivated, and the items became claimable.",
    binds: [
      // The seam is SQL, not TypeScript: an AFTER UPDATE OF harness_slug trigger, because a
      // re-home can arrive from a migration/backfill that never touches app code (649 did
      // exactly that). This entry previously named a `lib/repoint-qualified-refs-on-rehome.ts`
      // that has never existed, and the dangling pointer sent a later reader looking for it.
      'libs/papercusp/libs/db/sql/734-repoint-qualified-refs-on-rehome.sql',
      'packages/operator-core/lib/dbos/work-item-deps-store.ts',
    ],
    provenance: ['EI-19374236094682800'],
  },

  // ---- effectiveness ------------------------------------------------------
  {
    id: 'INV-04',
    area: 'effectiveness',
    statement:
      'Every dependency edge that EXISTS and whose blocker is non-terminal is EFFECTIVE — it causes the blocked item to be withheld by every claim door.',
    violationLooksLike:
      'The whole point. An edge is present in work_item_deps, mirrors correctly, and the graph is acyclic — and the blocked item is served anyway. Row-shape evidence cannot distinguish this from correct behaviour, which is why three green checks missed six such edges.',
    binds: [
      'packages/operator-core/lib/work-items.ts',
      'packages/operator-core/lib/scheduler/claim-spec-store.ts',
      'libs/papercusp/libs/db/sql (work_item_is_blocked)',
    ],
    provenance: ['work-item-dependency-edges-2026-08-02#D-017', 'work-item-dependency-edges-2026-08-02#D-019'],
  },
  {
    id: 'INV-05',
    area: 'effectiveness',
    statement:
      'When the last non-terminal blocker of an item becomes terminal, the item becomes claimable — blocking is released, not merely recorded.',
    violationLooksLike:
      'An item stays unclaimable after its blockers are all done: work silently stalls and no error is raised anywhere. The inverse of INV-04 and equally invisible to row-shape checks.',
    binds: ['packages/operator-core/lib/work-items.ts', 'packages/operator-core/lib/scheduler/readiness-reconcile.ts'],
    provenance: ['work-item-deps-and-readiness-2026-06-22'],
  },

  // ---- claim doors --------------------------------------------------------
  {
    id: 'INV-06',
    area: 'claim-doors',
    statement:
      'EVERY claim entry point applies the SAME blocking verdict for the same item — there is no door through which a blocked item can be claimed.',
    violationLooksLike:
      'scheduler:get_next withholds an item while a direct claim-by-id hands it out. The audit that proves this is point-in-time and rots the moment someone adds a door.',
    binds: [
      'packages/operator-core/lib/work-items.ts',
      'packages/operator-core/lib/scheduler/claim-spec-store.ts',
      'packages/operator-core/lib/scheduler/get-next.ts',
    ],
    provenance: ['work-item-dependency-edges-2026-08-02#P-012', 'work-item-dependency-edges-2026-08-02#P-014'],
  },
  {
    id: 'INV-07',
    area: 'claim-doors',
    statement:
      'The post-claim plan-item lane guard never SERVES a row it has confirmed blocked — on retry-budget exhaustion it fails CLOSED and releases.',
    violationLooksLike:
      'WI-3503/P-401 was handed out via scheduler:get_next with a 7-deep blockedBy chain still open, because exhaustion used to fail OPEN and serve the last candidate.',
    binds: [
      'packages/operator-core/lib/scheduler/claim-spec-store.ts',
      'packages/operator-core/lib/scheduler/plan-item-lane-guard.ts',
    ],
    provenance: ['EI-9108'],
  },

  // ---- graph shape --------------------------------------------------------
  {
    id: 'INV-08',
    area: 'graph-shape',
    statement:
      'The blocks graph is acyclic, and a candidate write that would introduce a cycle is rejected before any offending edge enters the graph.',
    violationLooksLike:
      'A cycle makes every nonterminal item in it permanently unclaimable, while the write reports success or returns only a generic invalid-graph error with no cycle path.',
    binds: [
      'packages/operator-core/lib/dbos/work-item-deps-store.ts',
      'packages/operator-core/lib/plan-workitem-promotion-run.ts',
    ],
    provenance: [
      'work-item-dependency-edges-2026-08-02#D-012',
      'dependency-graph-admission-and-health-2026-08-26#D-007',
    ],
    note: 'CORRECTED 2026-08-27 (P-003). This invariant previously required edge-granularity rejection and said one bad edge must never reject a whole promotion. That conflicts with the approved batch-atomic contract: callers request a final graph, so partial edge success creates a graph nobody requested. INV-08 now states only the acyclicity guarantee its existing citations prove; INV-17 separately names whole-batch atomicity so that stronger claim cannot borrow acyclicity coverage.',
  },
  {
    id: 'INV-09',
    area: 'graph-shape',
    statement:
      "An item is withheld while ANY DIRECT blocker is non-terminal. Chains of unfinished work are therefore withheld to arbitrary depth (a blocked item is itself non-terminal), and the release frontier advances ONE link per completion — but a blocker that has REACHED a terminal state releases its dependent regardless of that blocker's own upstream.",
    violationLooksLike:
      "Either direction is a bug, and they are opposite. Too weak: the frontier collapses — satisfying a chain's ROOT frees the whole chain at once, serving work whose immediate prerequisite was never done. Too strong: a genuinely FULLY-transitive rule, which deadlocks any item whose completed prerequisite happens to sit downstream of an abandoned root, and which no correct implementation should have.",
    binds: ['libs/papercusp/libs/db/sql (work_item_is_blocked)', 'packages/operator-core/lib/work-items.ts'],
    provenance: ['dependency-subsystem-thorough-testing-2026-08-02#D-001'],
    note: "CORRECTED 2026-08-02 (P-005). This invariant was first written as 'blocking is transitive: an item with a BLOCKED blocker is itself withheld', citing EI-9108. Both halves were wrong. (1) The system is one-hop-with-terminality, and that is CORRECT, not a leak — 'terminal' means the work is done, so a completed prerequisite satisfies its dependent whatever sits behind it; the transitive reading would deadlock legitimate work. Verified live: claim-respects-blocking.integration.test.ts, 'THE DISCRIMINATING CASE'. (2) EI-9108 was never a depth leak in the oracle — it was the lane guard's retry-budget exhaustion failing OPEN, which is INV-07. The mis-citation mattered: as written, INV-09 was unfalsifiable by depth alone (every intermediate in an unfinished chain is non-terminal, so one-hop and transitive agree on every chain anyone would naturally seed), so a test could look like it proved it while proving nothing.",
  },
  {
    id: 'INV-10',
    area: 'graph-shape',
    statement:
      'A backfill UNIONs with existing edges; it never REPLACES them. Replace-semantics is safe only at promotion, where the item was just minted.',
    violationLooksLike:
      'A backfill run silently deletes hand-authored or previously-repaired edges, and the graph quietly loses gating it used to have.',
    binds: ['packages/operator-core/lib/dbos/feature-blockers-edges.ts'],
    provenance: ['work-item-dependency-edges-2026-08-02#D-015'],
  },

  // ---- tenancy ------------------------------------------------------------
  {
    id: 'INV-11',
    area: 'tenancy',
    statement:
      "Every dependency read and write is scoped by (workspace_id, harness) — none assumes the 'default' workspace.",
    violationLooksLike:
      "The SQL oracle hardcoded workspace 'default'. Every test constructed its fixture in 'default', so the suite was green for months while blocking was inert for every other tenant. The bug lived on the axis the tests held constant.",
    binds: [
      'libs/papercusp/libs/db/sql (work_item_is_blocked)',
      'packages/operator-core/lib/work-items.ts',
      'packages/operator-core/lib/scheduler/readiness-reconcile.ts',
    ],
    provenance: ['work-item-dependency-edges-2026-08-02#P-001'],
  },

  // ---- observability ------------------------------------------------------
  {
    id: 'INV-12',
    area: 'observability',
    statement:
      'The endpoint detector FIRES on a seeded defect and stays SILENT on a clean graph — both halves, or its zero means nothing.',
    violationLooksLike:
      'A detector run against already-repaired data returns 0 whether or not it works. Indistinguishable from working, and reported as health.',
    binds: ['packages/operator-core/lib/scheduler/work-item-deps-integrity.ts'],
    provenance: ['work-item-dependency-edges-2026-08-02#D-019', 'work-item-dependency-edges-2026-08-02#D-020'],
  },
  {
    id: 'INV-13',
    area: 'observability',
    statement:
      'The detector distinguishes an endpoint that exists NOWHERE (stale ⇒ delete the edge) from one that exists under ANOTHER slug (⇒ re-point it).',
    violationLooksLike:
      'Both report as "resolves to nothing", so the natural repair (delete) destroys live dependencies. This nearly removed 8 real blocking edges on 2026-08-02.',
    binds: ['packages/operator-core/lib/scheduler/work-item-deps-integrity.ts'],
    provenance: ['EI-19374236094682800'],
  },
  {
    id: 'INV-14',
    area: 'observability',
    statement:
      'Every lane-guard bounce is recorded with its lane verdict, and a clear lane records nothing — so the bounce COUNT is the churn count.',
    violationLooksLike:
      'The bounce was invisible by construction: claim, check, release, return nothing, record nowhere. "Has churn dropped?" was unanswerable rather than merely hard, and any number reported for it was fabricated.',
    binds: ['packages/operator-core/lib/scheduler/claim-spec-store.ts'],
    provenance: ['work-item-dependency-edges-2026-08-02#D-020', 'WI-7141'],
  },
  {
    id: 'INV-15',
    area: 'observability',
    statement:
      'The SQL oracle and the maintained readiness sidecar agree for every item; disagreement is drift and is reported, never silently reconciled away.',
    violationLooksLike:
      'The cache says claimable, the oracle says blocked. Whichever the claim path consults wins, and the other is a latent second source of truth.',
    binds: ['packages/operator-core/lib/scheduler/readiness-reconcile.ts'],
    provenance: ['work-item-dependency-edges-2026-08-02#P-004'],
  },
  {
    id: 'INV-16',
    area: 'graph-shape',
    statement:
      'Every supported dependency mutation validates its complete affected post-state at the canonical transaction boundary and may not increase the deterministically stranded nonterminal set.',
    violationLooksLike:
      'A preflight sees a clean snapshot, a concurrent or bypass writer commits a conflicting edge, and both mutations succeed even though the committed graph contains newly stranded work.',
    binds: [
      'packages/operator-core/lib/scheduler/dependency-graph-analysis.ts',
      'packages/operator-core/lib/dbos/work-item-deps-store.ts',
      'packages/operator-core/lib/agent-tools/plans/_write-scope.ts',
    ],
    provenance: [
      'dependency-graph-admission-and-health-2026-08-26#D-001',
      'dependency-graph-admission-and-health-2026-08-26#D-002',
    ],
  },
  {
    id: 'INV-17',
    area: 'effectiveness',
    statement:
      'A dependency mutation is atomic per affected graph or plan: every requested edge and companion state change commits together, or rows, claims, revisions, events, and notifications all remain unchanged.',
    violationLooksLike:
      'One edge in a multi-edge request is invalid, yet the valid prefix commits, advances a revision, or emits a notification, leaving a partial graph and side effects the caller never requested.',
    binds: [
      'packages/operator-core/lib/dbos/work-item-deps-store.ts',
      'packages/operator-core/lib/agent-tools/plans/_write-scope.ts',
    ],
    provenance: ['dependency-graph-admission-and-health-2026-08-26#D-007'],
  },
  {
    id: 'INV-18',
    area: 'tenancy',
    statement:
      'Dependency admission analyses one canonical typed graph across supported work-item families and harnesses, while rejecting any cross-workspace edge that every claim door cannot evaluate.',
    violationLooksLike:
      'A same-harness feature projection reports no cycle while an issue-to-feature or cross-harness return edge closes a real cycle; alternatively an inert cross-workspace edge is stored and gates no claim door.',
    binds: [
      'packages/operator-core/lib/scheduler/dependency-graph-analysis.ts',
      'packages/operator-core/lib/dbos/work-item-deps-store.ts',
    ],
    provenance: ['dependency-graph-admission-and-health-2026-08-26#D-003'],
  },
  {
    id: 'INV-19',
    area: 'effectiveness',
    statement:
      'A reachability-changing lifecycle transition either reconciles dependent claims, states, and notifications in the same transaction or refuses the contradictory partial transition.',
    violationLooksLike:
      'A blocker is added or reopened while its dependent remains claimed or in progress as though the dependency were still satisfied, with no atomic park, release, disposition, or holder notification.',
    binds: [
      'packages/operator-core/lib/work-items.ts',
      'packages/operator-core/lib/plan-items/liveness.ts',
      'packages/operator-core/lib/scheduler/readiness-reconcile.ts',
    ],
    provenance: ['dependency-graph-admission-and-health-2026-08-26#Requirements'],
  },
  {
    id: 'INV-20',
    area: 'observability',
    statement:
      'Admission, lint, monitoring, tools, and UI use one policy row for each dependency finding, including its hard/advisory/healthy class, confidence, evidence contract, provenance, suppression rule, and suggested action.',
    violationLooksLike:
      'One surface blocks a topology another calls advisory, a healthy diamond emits recurring noise, or an alert names no exact edge, evidence, provenance, or corrective action and therefore cannot be audited or safely suppressed.',
    binds: [
      'packages/operator-core/lib/scheduler/dependency-invariants.ts',
      'packages/operator-core/lib/agent-tools/plans/lint.ts',
      'packages/operator-core/lib/sync-resolver/dependency-graph-edges.ts',
    ],
    provenance: [
      'dependency-graph-admission-and-health-2026-08-26#D-005',
      'dependency-graph-admission-and-health-2026-08-26#D-009',
    ],
  },
] as const;

/**
 * Shared hard-block/advisory/healthy policy vocabulary.
 *
 * These are stable result codes, not prose hints. Admission, lint, monitors,
 * tools, and the dependency pane consume the same rows through `getDependencyPolicy`.
 */
export const DEPENDENCY_POLICY_RULES: readonly DependencyPolicyRule[] = [
  // ---- deterministic hard blocks -----------------------------------------
  {
    code: 'cycle',
    classification: 'hard-block',
    action: 'reject',
    confidence: 'deterministic',
    suppression: 'never',
    summary: 'A self-loop, alias-loop, or strongly connected component makes the active AND graph unsatisfiable.',
    evidence: ['exact-nodes', 'exact-edges', 'path'],
    suggestedAction: 'Remove or redirect at least one edge named by the cycle path, then retry the complete mutation.',
    invariantIds: ['INV-08', 'INV-16'],
    provenance: ['dependency-graph-admission-and-health-2026-08-26#Definitions and policy'],
  },
  {
    code: 'executable-endpoint-missing',
    classification: 'hard-block',
    action: 'reject',
    confidence: 'deterministic',
    suppression: 'never',
    summary: 'An executable dependency endpoint does not resolve to a canonical object.',
    evidence: ['exact-edges', 'scope-resolution'],
    suggestedAction: 'Create or repair the endpoint, or remove the dependency before activation or execution.',
    invariantIds: ['INV-02', 'INV-16'],
    provenance: ['dependency-graph-admission-and-health-2026-08-26#D-004'],
  },
  {
    code: 'endpoint-identity-mismatch',
    classification: 'hard-block',
    action: 'reject',
    confidence: 'deterministic',
    suppression: 'never',
    summary: 'An endpoint kind, ref form, or declared scope disagrees with the canonical row it resolves to.',
    evidence: ['exact-edges', 'scope-resolution'],
    suggestedAction: 'Rewrite the endpoint with the canonical family-specific kind and ref returned by resolution.',
    invariantIds: ['INV-01', 'INV-02', 'INV-18'],
    provenance: ['dependency-graph-admission-and-health-2026-08-26#D-003'],
  },
  {
    code: 'cross-workspace-inert-edge',
    classification: 'hard-block',
    action: 'reject',
    confidence: 'deterministic',
    suppression: 'never',
    summary: 'A cross-workspace edge cannot be evaluated consistently by every claim door in the supported graph.',
    evidence: ['exact-edges', 'scope-resolution'],
    suggestedAction:
      'Keep the dependency inside one workspace or represent the remote condition through a typed external blocker.',
    invariantIds: ['INV-11', 'INV-18'],
    provenance: ['dependency-graph-admission-and-health-2026-08-26#Requirements'],
  },
  {
    code: 'stranded-set-increase',
    classification: 'hard-block',
    action: 'reject',
    confidence: 'deterministic',
    suppression: 'never',
    summary: 'The candidate post-state adds one or more nonterminal nodes to the deterministically stranded closure.',
    evidence: ['exact-nodes', 'path', 'before-after'],
    suggestedAction: 'Repair the named bad roots or remove the candidate edges that newly connect nodes to them.',
    invariantIds: ['INV-16'],
    provenance: ['dependency-graph-admission-and-health-2026-08-26#D-002'],
  },
  {
    code: 'dangling-identity-transition',
    classification: 'hard-block',
    action: 'reject',
    confidence: 'deterministic',
    suppression: 'never',
    summary: 'A deletion, re-home, or identity rewrite leaves an incoming or outgoing dependency endpoint dangling.',
    evidence: ['exact-nodes', 'exact-edges', 'before-after'],
    suggestedAction: 'Repoint, remove, or explicitly disposition every affected edge inside the same transaction.',
    invariantIds: ['INV-03', 'INV-19'],
    provenance: ['dependency-graph-admission-and-health-2026-08-26#Definitions and policy'],
  },
  {
    code: 'active-dependant-unreconciled',
    classification: 'hard-block',
    action: 'reject',
    confidence: 'deterministic',
    suppression: 'never',
    summary: 'Adding a blocker would leave an actively claimed or progressing dependant in a contradictory state.',
    evidence: ['exact-nodes', 'exact-edges', 'lifecycle-state'],
    suggestedAction: 'Atomically park or release the dependant, record the disposition, and notify its holder.',
    invariantIds: ['INV-19'],
    provenance: ['dependency-graph-admission-and-health-2026-08-26#Requirements'],
  },
  {
    code: 'reopened-blocker-unreconciled',
    classification: 'hard-block',
    action: 'reject',
    confidence: 'deterministic',
    suppression: 'never',
    summary:
      'Reopening a settled blocker would leave progressed dependants believing the dependency remains satisfied.',
    evidence: ['exact-nodes', 'exact-edges', 'lifecycle-state'],
    suggestedAction:
      'Reconcile affected dependants and explicitly disposition terminal descendants in the same transaction.',
    invariantIds: ['INV-19'],
    provenance: ['dependency-graph-admission-and-health-2026-08-26#Requirements'],
  },
  {
    code: 'partial-dependency-batch',
    classification: 'hard-block',
    action: 'reject',
    confidence: 'deterministic',
    suppression: 'never',
    summary: 'A per-graph or per-plan dependency batch would apply only a subset of the requested final state.',
    evidence: ['batch-members', 'before-after'],
    suggestedAction: 'Correct the invalid batch members and retry the entire affected graph or plan atomically.',
    invariantIds: ['INV-17'],
    provenance: ['dependency-graph-admission-and-health-2026-08-26#D-007'],
  },
  {
    code: 'executable-plan-invalid',
    classification: 'hard-block',
    action: 'reject',
    confidence: 'deterministic',
    suppression: 'never',
    summary:
      'A ready, active, or started plan has a cycle, dangling ref, or no executable frontier because of structural invalidity.',
    evidence: ['exact-nodes', 'exact-edges', 'path', 'lifecycle-state'],
    suggestedAction: 'Repair the plan graph before activation or any write that would invalidate an executable plan.',
    invariantIds: ['INV-08', 'INV-16'],
    provenance: ['dependency-graph-admission-and-health-2026-08-26#D-004'],
  },
  {
    code: 'promotion-edge-divergence',
    classification: 'hard-block',
    action: 'reject',
    confidence: 'deterministic',
    suppression: 'never',
    summary: 'Plan promotion omitted or inertly encoded a canonical work edge required by the plan dependency graph.',
    evidence: ['exact-nodes', 'exact-edges', 'before-after'],
    suggestedAction: 'Repair the canonical promoted edge set and rerun promotion as one atomic batch.',
    invariantIds: ['INV-04', 'INV-17'],
    provenance: ['dependency-graph-admission-and-health-2026-08-26#Requirements'],
  },
  {
    code: 'required-outcome-impossible',
    classification: 'hard-block',
    action: 'reject',
    confidence: 'deterministic',
    suppression: 'never',
    summary: 'An explicit dependency outcome requirement is authoritatively impossible to satisfy.',
    evidence: ['exact-nodes', 'exact-edges', 'external-condition'],
    suggestedAction:
      'Change the explicit outcome requirement or replace the blocker with one that can still satisfy it.',
    invariantIds: ['INV-16'],
    provenance: ['dependency-graph-admission-and-health-2026-08-26#D-006'],
  },
  {
    code: 'typed-blocked-without-resolver',
    classification: 'hard-block',
    action: 'reject',
    confidence: 'deterministic',
    suppression: 'never',
    summary:
      'After typed-blocker migration, a stored blocked state has no live dependency, external condition, or registered resolver.',
    evidence: ['exact-nodes', 'lifecycle-state', 'external-condition'],
    suggestedAction: 'Clear the stale blocked state or register the typed resolver that can settle it.',
    invariantIds: ['INV-16', 'INV-19'],
    provenance: ['dependency-graph-admission-and-health-2026-08-26#Definitions and policy'],
  },

  // ---- probable mistakes: surface evidence, never rewrite intent ----------
  {
    code: 'satisfied-edge-retained',
    classification: 'advisory',
    action: 'alert',
    confidence: 'high',
    suppression: 'structured-rationale',
    summary: 'A dependency edge remains after its blocker reached a terminal state.',
    evidence: ['exact-nodes', 'exact-edges', 'lifecycle-state'],
    suggestedAction: 'Remove stale clutter or record structured history provenance for intentional retention.',
    invariantIds: ['INV-05', 'INV-20'],
    provenance: ['dependency-graph-admission-and-health-2026-08-26#Definitions and policy'],
  },
  {
    code: 'terminal-dependant-live-blocker',
    classification: 'advisory',
    action: 'alert',
    confidence: 'high',
    suppression: 'structured-rationale',
    summary: 'A terminal dependant still names a nonterminal blocker.',
    evidence: ['exact-nodes', 'exact-edges', 'lifecycle-state'],
    suggestedAction: 'Confirm early completion was intentional or remove the obsolete dependency edge.',
    invariantIds: ['INV-19', 'INV-20'],
    provenance: ['dependency-graph-admission-and-health-2026-08-26#Definitions and policy'],
  },
  {
    code: 'legacy-blocked-without-resolver',
    classification: 'advisory',
    action: 'alert',
    confidence: 'high',
    suppression: 'structured-rationale',
    summary:
      'Before typed-blocker migration completes, a stored blocked state has no unresolved graph edge or typed resolver.',
    evidence: ['exact-nodes', 'lifecycle-state', 'external-condition'],
    suggestedAction: 'Migrate the legacy blocker to a typed resolver or clear the stale blocked token after review.',
    invariantIds: ['INV-15', 'INV-20'],
    provenance: ['dependency-graph-admission-and-health-2026-08-26#Definitions and policy'],
  },
  {
    code: 'promoted-graph-extra-edge',
    classification: 'advisory',
    action: 'alert',
    confidence: 'high',
    suppression: 'structured-rationale',
    summary:
      'The promoted work graph contains an extra hand-authored edge beyond the plan-required canonical edge set.',
    evidence: ['exact-nodes', 'exact-edges', 'provenance'],
    suggestedAction:
      'Confirm and document the extra prerequisite, or remove it if promotion drift created it accidentally.',
    invariantIds: ['INV-15', 'INV-20'],
    provenance: ['dependency-graph-admission-and-health-2026-08-26#Definitions and policy'],
  },
  {
    code: 'phase-inversion',
    classification: 'advisory',
    action: 'alert',
    confidence: 'medium',
    suppression: 'structured-rationale',
    summary: 'An earlier plan phase depends on work declared in a later phase.',
    evidence: ['exact-nodes', 'exact-edges', 'provenance'],
    suggestedAction: 'Reverse the edge or reorder phases unless phase labels are intentionally descriptive.',
    invariantIds: ['INV-20'],
    provenance: ['dependency-graph-admission-and-health-2026-08-26#D-005'],
  },
  {
    code: 'gate-foundation-inversion',
    classification: 'advisory',
    action: 'alert',
    confidence: 'medium',
    suppression: 'structured-rationale',
    summary: 'A release, beta, or distribution gate blocks foundational build work.',
    evidence: ['exact-nodes', 'exact-edges', 'provenance'],
    suggestedAction: 'Check whether the gate direction is reversed or document why foundational work is conditional.',
    invariantIds: ['INV-20'],
    provenance: ['dependency-graph-admission-and-health-2026-08-26#D-005'],
  },
  {
    // EI-22089706217678704. `gate-foundation-inversion` above catches a gate whose edge points the
    // WRONG WAY. Nothing caught the strictly worse shape: a gate with NO prerequisite edge at all.
    // A mis-directed gate is at least gated; an edgeless one is CLAIMABLE, so promotion mints it
    // unblocked and the scheduler serves it to a drain member who can only park it again. Measured
    // on the reporting incident: two such items were claimed and parked back-to-back inside 11
    // minutes, each costing a member turn and a leader wake, and nothing advanced.
    code: 'gate-without-dependency',
    classification: 'advisory',
    action: 'alert',
    confidence: 'high',
    suppression: 'structured-rationale',
    summary:
      'A release or acceptance gate item has no prerequisite edges while foundational build work is still open.',
    evidence: ['exact-nodes', 'lifecycle-state'],
    suggestedAction:
      'Encode the prerequisites with plans:set-item-blocked-by, or record why the gate is deliberately independent.',
    invariantIds: ['INV-20'],
    provenance: ['dependency-graph-admission-and-health-2026-08-26#D-005'],
  },
  {
    code: 'transitive-redundancy',
    classification: 'advisory',
    action: 'alert',
    confidence: 'high',
    suppression: 'structured-rationale',
    summary: 'A direct edge duplicates a dependency path already implied transitively by nonterminal work.',
    evidence: ['exact-nodes', 'exact-edges', 'path'],
    suggestedAction: 'Remove the redundant edge or record why the direct prerequisite is intentionally explicit.',
    invariantIds: ['INV-09', 'INV-20'],
    provenance: ['dependency-graph-admission-and-health-2026-08-26#D-005'],
  },
  {
    code: 'narrow-or-deep-topology',
    classification: 'advisory',
    action: 'alert',
    confidence: 'medium',
    suppression: 'structured-rationale',
    summary: 'The executable graph has very low width or an unusually deep critical path.',
    evidence: ['exact-nodes', 'path', 'topology-metrics'],
    suggestedAction: 'Review whether independent work can be exposed without weakening real prerequisites.',
    invariantIds: ['INV-20'],
    provenance: ['dependency-graph-admission-and-health-2026-08-26#D-005'],
  },
  {
    code: 'high-degree-node',
    classification: 'advisory',
    action: 'alert',
    confidence: 'medium',
    suppression: 'structured-rationale',
    summary: 'A node has unusually high dependency fan-in or dependant fan-out.',
    evidence: ['exact-nodes', 'exact-edges', 'topology-metrics'],
    suggestedAction: 'Review the node as a fragility bottleneck and split or document it when appropriate.',
    invariantIds: ['INV-20'],
    provenance: ['dependency-graph-admission-and-health-2026-08-26#D-005'],
  },
  {
    code: 'cross-harness-without-provenance',
    classification: 'advisory',
    action: 'alert',
    confidence: 'high',
    suppression: 'structured-rationale',
    summary: 'A valid cross-harness dependency has no explicit rationale or provenance.',
    evidence: ['exact-nodes', 'exact-edges', 'scope-resolution', 'provenance'],
    suggestedAction:
      'Add structured coupling provenance or replace the edge with a more stable shared-infrastructure contract.',
    invariantIds: ['INV-18', 'INV-20'],
    provenance: ['dependency-graph-admission-and-health-2026-08-26#D-005'],
  },
  {
    code: 'dependency-added-after-wip',
    classification: 'advisory',
    action: 'alert',
    confidence: 'high',
    suppression: 'structured-rationale',
    summary: 'A new dependency was added after the dependant entered active work.',
    evidence: ['exact-nodes', 'exact-edges', 'lifecycle-state', 'provenance'],
    suggestedAction: 'Notify the holder and record whether the dependant is parked, released, or safe to continue.',
    invariantIds: ['INV-19', 'INV-20'],
    provenance: ['dependency-graph-admission-and-health-2026-08-26#D-005'],
  },
  {
    code: 'external-condition-uncertain',
    classification: 'advisory',
    action: 'alert',
    confidence: 'medium',
    suppression: 'structured-rationale',
    summary:
      'An external blocker is fired, expired, cancelled, unregistered, or lacks a resolvable next action without authoritative impossibility.',
    evidence: ['exact-nodes', 'external-condition', 'provenance'],
    suggestedAction:
      'Resolve or re-register the external condition; keep reachability unknown until authority proves impossibility.',
    invariantIds: ['INV-20'],
    provenance: ['dependency-graph-admission-and-health-2026-08-26#Design'],
  },
  {
    code: 'duplicate-plan-coverage',
    classification: 'advisory',
    action: 'alert',
    confidence: 'medium',
    suppression: 'structured-rationale',
    summary:
      'Multiple plan items or promoted rows appear to cover the same work without an explicit redundancy policy.',
    evidence: ['exact-nodes', 'provenance'],
    suggestedAction:
      'Deduplicate the work or attach the structured redundancy policy that makes the overlap intentional.',
    invariantIds: ['INV-20'],
    provenance: ['dependency-graph-admission-and-health-2026-08-26#D-005'],
  },

  // ---- explicitly healthy: suppress false-positive topology noise --------
  {
    code: 'isolated-or-wide-roots',
    classification: 'healthy',
    action: 'suppress',
    confidence: 'deterministic',
    suppression: 'automatic',
    summary: 'Isolated nodes and wide independent executable roots are healthy by graph shape alone.',
    evidence: ['exact-nodes', 'topology-metrics'],
    suggestedAction: null,
    invariantIds: ['INV-20'],
    provenance: ['dependency-graph-admission-and-health-2026-08-26#Definitions and policy'],
  },
  {
    code: 'diamond-or-multiple-blockers',
    classification: 'healthy',
    action: 'suppress',
    confidence: 'deterministic',
    suppression: 'automatic',
    summary: 'A diamond or an item with multiple blockers is healthy by shape when every endpoint and path is valid.',
    evidence: ['exact-nodes', 'exact-edges'],
    suggestedAction: null,
    invariantIds: ['INV-09', 'INV-20'],
    provenance: ['dependency-graph-admission-and-health-2026-08-26#Definitions and policy'],
  },
  {
    code: 'intentional-serialization',
    classification: 'healthy',
    action: 'suppress',
    confidence: 'high',
    suppression: 'automatic',
    summary: 'An intentionally serial plan is healthy when its dependency chain is valid and carries explicit intent.',
    evidence: ['exact-nodes', 'path', 'provenance'],
    suggestedAction: null,
    invariantIds: ['INV-20'],
    provenance: ['dependency-graph-admission-and-health-2026-08-26#Definitions and policy'],
  },
  {
    code: 'cross-harness-with-provenance',
    classification: 'healthy',
    action: 'suppress',
    confidence: 'high',
    suppression: 'automatic',
    summary:
      'A cross-harness edge is healthy when both endpoints resolve and structured coupling provenance is present.',
    evidence: ['exact-nodes', 'exact-edges', 'scope-resolution', 'provenance'],
    suggestedAction: null,
    invariantIds: ['INV-18', 'INV-20'],
    provenance: ['dependency-graph-admission-and-health-2026-08-26#Definitions and policy'],
  },
  {
    code: 'settled-terminal-blocker',
    classification: 'healthy',
    action: 'suppress',
    confidence: 'deterministic',
    suppression: 'automatic',
    summary:
      'A done, dropped, deprecated, or family-equivalent terminal blocker satisfies an ordinary settled dependency.',
    evidence: ['exact-nodes', 'exact-edges', 'lifecycle-state'],
    suggestedAction: null,
    invariantIds: ['INV-05', 'INV-09'],
    provenance: ['dependency-graph-admission-and-health-2026-08-26#D-006'],
  },
  {
    code: 'retained-history-edge',
    classification: 'healthy',
    action: 'suppress',
    confidence: 'high',
    suppression: 'automatic',
    summary:
      'A terminal edge retained with explicit history provenance is healthy and should not emit stale-edge noise.',
    evidence: ['exact-nodes', 'exact-edges', 'lifecycle-state', 'provenance'],
    suggestedAction: null,
    invariantIds: ['INV-20'],
    provenance: ['dependency-graph-admission-and-health-2026-08-26#Definitions and policy'],
  },
] as const;

/** Total count, exported so a test can assert the registry did not silently shrink. */
export const DEPENDENCY_INVARIANT_COUNT = DEPENDENCY_INVARIANTS.length;
export const DEPENDENCY_POLICY_RULE_COUNT = DEPENDENCY_POLICY_RULES.length;

const BY_ID: ReadonlyMap<string, DependencyInvariant> = new Map(DEPENDENCY_INVARIANTS.map((i) => [i.id, i]));
const POLICY_BY_CODE: ReadonlyMap<string, DependencyPolicyRule> = new Map(
  DEPENDENCY_POLICY_RULES.map((rule) => [rule.code, rule]),
);

/** Look one up by id. Returns undefined for an unknown id — callers decide whether that is fatal. */
export function getInvariant(id: string): DependencyInvariant | undefined {
  return BY_ID.get(id);
}

/** One stable policy row for a machine-emitted finding code. */
export function getDependencyPolicy(code: string): DependencyPolicyRule | undefined {
  return POLICY_BY_CODE.get(code);
}

/** Policy rows grouped for admission/tool/UI rendering without re-encoding class logic. */
export function dependencyPoliciesByClassification(
  classification: DependencyPolicyClassification,
): readonly DependencyPolicyRule[] {
  return DEPENDENCY_POLICY_RULES.filter((rule) => rule.classification === classification);
}

/** All invariants binding a given area. */
export function invariantsByArea(area: InvariantArea): readonly DependencyInvariant[] {
  return DEPENDENCY_INVARIANTS.filter((i) => i.area === area);
}

/**
 * Every invariant id that names `path` in its `binds` list.
 *
 * Substring match on purpose: `binds` entries carry a parenthetical for SQL
 * objects (e.g. 'libs/.../sql (work_item_is_blocked)'), so an exact compare
 * would silently return nothing for precisely the paths that matter most.
 */
export function invariantsBindingPath(path: string): readonly DependencyInvariant[] {
  return DEPENDENCY_INVARIANTS.filter((i) => i.binds.some((b) => b.includes(path) || path.includes(b)));
}

/** Matches `@covers INV-01`, `@covers INV-01, INV-02`, `@covers INV-01 INV-02`. */
const COVERS_RE = /@covers\s+((?:INV-\d+[\s,]*)+)/g;

/**
 * Extract the invariant ids a source text claims to cover.
 *
 * Deliberately a pure string function over text the CALLER read: it does no IO,
 * so it is unit-testable and cannot be blamed for a missing file. Unknown ids are
 * returned as-is — `unknownCoveredIds` is what separates a typo from a real claim,
 * and a typo'd citation must never read as coverage.
 */
export function coveredInvariants(source: string): readonly string[] {
  const found = new Set<string>();
  for (const m of source.matchAll(COVERS_RE)) {
    for (const id of m[1].split(/[\s,]+/)) {
      if (id) found.add(id);
    }
  }
  return [...found].sort();
}

/** Cited ids that are not in the registry — a typo, or a renumbered invariant. */
export function unknownCoveredIds(source: string): readonly string[] {
  return coveredInvariants(source).filter((id) => !BY_ID.has(id));
}

/** Registry ids with no citation anywhere in `sources`. The coverage question, answered by name. */
export function uncoveredInvariantIds(sources: readonly string[]): readonly string[] {
  const covered = new Set<string>();
  for (const s of sources) for (const id of coveredInvariants(s)) covered.add(id);
  return DEPENDENCY_INVARIANTS.map((i) => i.id).filter((id) => !covered.has(id));
}
