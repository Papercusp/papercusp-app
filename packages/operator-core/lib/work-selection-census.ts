/**
 * Work-selection census — every path that SELECTS or COUNTS work in harness_shared.work_items,
 * what item kinds it admits today, and whether a non-work datatype instance can reach it.
 *
 * Plan enterprise-data-sources-2026-10-01, item P-007 (WI-10005043). Long form, live counts and
 * the verdict on the plan's [inferred] claim: docs/evidence/work-selection-census-2026-10-01.md.
 *
 * Two consumers:
 *   - P-009 (the single work predicate, D-001/D-008) rewires every `selection` row below to read
 *     one nature-derived predicate. A row whose `admits` is not the predicate is a remaining decider.
 *   - P-012 (the recurrence guard) seeds WORK_SELECTION_SEED_ROWS into an isolated DB and asserts
 *     every `selection` path returns only rows with `expectAgentClaimable: true`.
 *
 * The `anchor` of each row is a literal string that must appear in `file`; the sibling test pins
 * it, so a refactor that moves or deletes the decider fails here instead of leaving this census
 * silently describing code that no longer exists (derived-truth ladder, rung 2: PIN).
 */

export type CensusRole =
  /** Hands an item to an agent (claim, get-next, by-id claim, dispatch). */
  | 'selection'
  /** Counts or lists "the queue"; never claims, but drives what an agent believes is work. */
  | 'listing'
  /** Mints work_items rows; P-009/D-008 make these stamp nature. */
  | 'writer'
  /** Reads work_items for another purpose (embedding, dedupe, admission bookkeeping). */
  | 'auxiliary'
  /** SQL object (view, function, index) that encodes a kind split. */
  | 'sql';

/** How the row's `admits`/`reachesNonWork` statement was established. */
export type CensusEvidence =
  /** Read from the code at `file`/`anchor`. */
  | 'code'
  /** Read from code AND measured against the live operator DB on 2026-10-01. */
  | 'code+live'
  /** Grep found no kind predicate; the absence is not yet proven by reading the full path. */
  | 'unverified';

/**
 * A handler file that reaches the row's decider without a kind decision of its own: it passes an
 * id or a filter straight through. The completeness scan counts the file as covered by the row,
 * and the sibling test pins `anchor` in `file` exactly like a row's own anchor.
 */
export interface WorkSelectionSite {
  /** Repo-relative path (from the papercusp superproject root). */
  file: string;
  /** Literal substring of `file` at the call into the row's decider. */
  anchor: string;
  /** The decider function the site calls. */
  via: string;
}

export interface WorkSelectionCensusRow {
  id: string;
  role: CensusRole;
  surface: string;
  /** Repo-relative path (from the papercusp superproject root). */
  file: string;
  /** Literal substring of `file` that locates the kind decider. Pinned by the test. */
  anchor: string;
  /** Handler files that delegate to this row's decider (see WorkSelectionSite). */
  sites?: readonly WorkSelectionSite[];
  /** For a `sql` row over a view: the view name (without schema) the SQL-leg scan keys on. */
  sqlObject?: string;
  /** Item kinds the path admits today, in plain words. */
  admits: string;
  /** Can a non-work or human-audience generic-kind instance (e.g. email-draft-proposal) reach it? */
  reachesNonWork: 'no' | 'yes' | 'no-by-convention' | 'unknown';
  /** Existing discriminators the path applies besides kind. */
  discriminators: string[];
  evidence: CensusEvidence;
  note?: string;
}

export const WORK_SELECTION_CENSUS: readonly WorkSelectionCensusRow[] = [
  // ── selection ──────────────────────────────────────────────────────────────────────────
  {
    id: 'get-next-issue',
    role: 'selection',
    surface: 'scheduler:get_next (issue path)',
    file: 'packages/operator-core/lib/scheduler/get-next.ts',
    anchor: "AND ${agentWorkWhereSql(sql, 'wi')}",
    admits: 'issue-routed kinds (issueFamilyRouteSql) that satisfy work_item_is_agent_work (P-009, D-022)',
    reachesNonWork: 'no',
    discriminators: ['work predicate (nature/audience)', 'needs-owner-action exclusion', 'claim floors', 'lane=observation'],
    evidence: 'code',
    sites: [{ file: 'packages/operator-core/lib/agent-tools/scheduler/get_next.ts', anchor: 'getNextForBee({', via: 'getNextForBee' }],
  },
  {
    id: 'claim-floors-feature',
    role: 'selection',
    surface: 'scheduler:get_next (feature path) and work_items:claim_next feature tier, via claimFloorsWhereSql',
    file: 'packages/operator-core/lib/work-items.ts',
    anchor: 'AND ${frontierPlacementKindClause(sql, opts.workspaceId)}',
    admits: 'feature-family rows that satisfy work_item_is_agent_work, via frontierPlacementKindClause (P-009, D-022)',
    reachesNonWork: 'no',
    discriminators: ['work predicate (nature/audience)', 'claim floors', 'admission', 'rig floor'],
    evidence: 'code+live',
    note: 'Pre-P-009 this was tag-gated. Live 2026-10-01 23:52Z: the predicate admits all 386 open feature rows and excludes the 129 open email-draft-proposal rows (work/human).',
  },
  {
    id: 'frontier-placement-clause',
    role: 'selection',
    surface: 'frontierPlacementKindClause (shared by claim floors, pot survey, wake-frontier guard, composition rig)',
    file: 'packages/operator-core/lib/datatype-frontier-placement.ts',
    anchor: '${agentWorkConsolidatedWhereSql(sql, null)}',
    admits: 'every non-issue-routed kind whose row is agent work (nature work, audience agent)',
    reachesNonWork: 'no',
    discriminators: ['work predicate (nature/audience)', 'issue-family route'],
    evidence: 'code+live',
    note: 'P-009 replaced the per-row datatype_registry tag subquery (the JOIN shape D-008 retires) with the row-column predicate.',
  },
  {
    id: 'claim-next-tool',
    role: 'selection',
    surface: 'work_items:claim_next',
    file: 'packages/operator-core/lib/agent-tools/work_items/claim_next.ts',
    anchor: "kind: z.enum(['feature']).optional()",
    admits: 'feature family via claimFloorsWhereSql, then additive fall-through to the issue family; routes to getNextForBee in a fleet',
    reachesNonWork: 'no-by-convention',
    discriminators: ['fleet scope', 'fleet pause', 'claim floors'],
    evidence: 'code',
  },
  {
    id: 'fleet-scope-admission',
    role: 'selection',
    surface: 'fleet claim spec admission (getNextForBee)',
    file: 'packages/operator-core/lib/scheduler/claim-spec-store.ts',
    anchor: 'SELECT feature_id AS id, item_kind AS kind',
    admits: 'whatever the spec names, then delegates to get-next floors',
    reachesNonWork: 'no-by-convention',
    discriminators: ['claim spec view', 'get-next floors'],
    evidence: 'code',
  },
  {
    id: 'claimable-tool',
    role: 'selection',
    surface: 'work_items:claimable',
    file: 'packages/operator-core/lib/agent-tools/work_items/claimable.ts',
    anchor: 'const ISSUE_KINDS = ISSUE_FAMILY_ROUTE_KINDS;',
    admits: 'bug, change, task via the shared route list ISSUE_FAMILY_ROUTE_KINDS (P-009 removed the local copy)',
    reachesNonWork: 'no',
    discriminators: ['work_items_claimable view'],
    evidence: 'code+live',
    note: 'Live claimable by kind 2026-10-01: change 1292, task 765, bug 513; zero generic-kind rows.',
  },
  {
    id: 'by-id-claim',
    role: 'selection',
    surface: 'work_items:claim { id } -> claimWorkItem -> claimIssue (and leader dispatch)',
    file: 'packages/operator-core/lib/work-items.ts',
    anchor: "AND ${agentWorkCategoryWhereSql(sql, 'target')}",
    admits:
      'feature family: ids passing admittedWhereSql/autoPickableWhereSql AND the category half of work_item_is_agent_work (nature work, audience agent; D-024). Issue family: bug, change, task via claimIssue, all work/agent in the registry',
    reachesNonWork: 'no',
    discriminators: [
      'work predicate category (nature/audience, D-024)',
      'admission',
      'auto-pickable',
      'leaderDispatchAdmission bypass (WI-5826)',
    ],
    evidence: 'code',
    note: 'Pre-P-009 this was reachesNonWork yes: email-draft-proposal rows carry admission NULL, lane NULL, needsOwnerAction NULL, so no discriminator refused them. D-024 gates only nature/audience on this path (lane and owner action stay advisory for an explicit id). claim.ts names the refusal not_agent_work. Executed against real PG by the P-009 / D-024 describe in work-items-claim.integration.test.ts.',
    sites: [
      {
        file: 'packages/operator-core/lib/agent-tools/work_items/claim.ts',
        anchor: "error: 'not_agent_work',",
        via: 'claimWorkItem',
      },
      {
        file: 'packages/operator-core/lib/agent-tools/coordination/actionable-work-item-dispatch.ts',
        anchor: 'claim: (id, assignee, opts) => claimWorkItem(id, assignee, opts),',
        via: 'claimWorkItem',
      },
      {
        file: 'packages/operator-core/lib/agent-tools/fleet/place_batch.ts',
        anchor: 'const claim = await claimWorkItem(task.id, reservedSpawnId',
        via: 'claimWorkItem',
      },
      {
        file: 'packages/operator-core/lib/agent-tools/loop/arm.ts',
        anchor: 'const wi = await claimWorkItem(drivenCandidate, ownerId, { harness });',
        via: 'claimWorkItem',
      },
      {
        file: 'packages/operator-core/lib/agent-tools/release/checkpoint-run.ts',
        anchor: 'const transferred = await claimWorkItem(ownership.workItem, callerOwnerId, {',
        via: 'claimWorkItem',
      },
    ],
  },
  {
    id: 'diagnose-claim-next-miss',
    role: 'listing',
    surface: 'diagnoseClaimNextMiss (claim_next empty-result diagnosis)',
    file: 'packages/operator-core/lib/work-items.ts',
    anchor: 'AND ${frontierPlacementKindClause(sql, ws)}',
    admits: 'feature + tag-gated generic kinds for the feature count',
    reachesNonWork: 'no-by-convention',
    discriminators: ['claim floors'],
    evidence: 'code',
  },
  // ── listing ────────────────────────────────────────────────────────────────────────────
  {
    id: 'list-search-count',
    role: 'listing',
    surface: 'work_items:list / work_items:search / countWorkItems / countWorkItemsByState',
    file: 'packages/operator-core/lib/work-items.ts',
    anchor: 'function featureFamilyKindClause(',
    admits: "feature + EVERY active generic-kind datatype (no tag gate); 'chunk' only when asked",
    reachesNonWork: 'yes',
    discriminators: ['includeObservations:false default (lane)'],
    evidence: 'code+live',
    note: 'Live 2026-10-01: work_items:list { notTerminal:true } shows the 129 open email-draft-proposal rows beside real work. This is the surface a drain enumerates from.',
    sites: [
      { file: 'packages/operator-core/lib/agent-tools/work_items/list.ts', anchor: 'listWorkItems(filter),', via: 'listWorkItems' },
      // D-041 (2547a3d8eb) added the withheld-count pair; countWorkItems applies the same featureFamilyKindClause decider.
      {
        file: 'packages/operator-core/lib/agent-tools/work_items/list.ts',
        anchor: 'countable ? countWorkItems(filter) : Promise.resolve(null),',
        via: 'countWorkItems',
      },
      { file: 'packages/operator-core/lib/agent-tools/work_items/search.ts', anchor: 'await searchWorkItems(args.query, {', via: 'searchWorkItems' },
      {
        file: 'packages/operator-core/lib/agent-tools/work_items/export.ts',
        anchor: ': await listWorkItems({ ...filter, limit: args.limit });',
        via: 'listWorkItems',
      },
      {
        file: 'packages/operator-core/lib/agent-tools/pot/get.ts',
        anchor: "const todo = await listWorkItems({ harness: pot.slug, state: 'open', limit: 500 });",
        via: 'listWorkItems',
      },
    ],
  },
  {
    id: 'issues-list',
    role: 'listing',
    surface: 'issues:list / issues:* (engineer_issues view)',
    file: 'packages/operator-core/lib/issues-engineer.ts',
    anchor: "export const ISSUE_KINDS: readonly IssueKind[] = ['bug', 'change'];",
    admits: "view: bug, change, task; issues-engineer ISSUE_KINDS: bug, change (hardcoded list #3, disagrees with #1 and #2 on 'task')",
    reachesNonWork: 'no',
    discriminators: ['engineer_issues view kind filter'],
    evidence: 'code+live',
    note: 'engineer_issues spells kind/title/created_at where work_items has item_kind/summary/created_ts.',
  },
  {
    id: 'leader-brief-backlog',
    role: 'listing',
    surface: 'fleet:leader-brief backlog figures',
    file: 'packages/operator-core/lib/agent-tools/fleet/leader-brief.ts',
    anchor: 'work_items:claimable',
    admits: 'inherits work_items:claimable (bug, change, task)',
    reachesNonWork: 'no',
    discriminators: ['claim spec'],
    evidence: 'code',
  },
  {
    id: 'burn-down',
    role: 'listing',
    surface: 'work_items:burn_down',
    file: 'packages/operator-core/lib/agent-tools/work_items/burn_down.ts',
    anchor: "(payload as Record<string, unknown>).lane === 'observation',",
    admits: 'excludes lane=observation in JS; kind handling not read',
    reachesNonWork: 'unknown',
    discriminators: ['lane'],
    evidence: 'unverified',
  },
  {
    id: 'unclaimed-digest',
    role: 'listing',
    surface: 'daily unclaimed-work digest routine',
    file: 'packages/operator-core/lib/harness/routines/unclaimed-work-digest-action.ts',
    anchor: 'unclaimed',
    admits: 'no item_kind / lane / ISSUE_KINDS predicate found by grep',
    reachesNonWork: 'unknown',
    discriminators: [],
    evidence: 'unverified',
  },
  {
    id: 'drain-mode',
    role: 'listing',
    surface: 'DRAIN mode backlog enumeration',
    file: 'packages/operator-core/lib/operating-modes-policy.ts',
    anchor: '"drain the queue" / "clear the backlog" ⇒ \\`drain\\`',
    admits: 'no enumerator of its own: the drain overlay is prompt text, so the backlog is whichever surface the agent reads',
    reachesNonWork: 'yes',
    discriminators: [],
    evidence: 'code',
    note: 'Through work_items:list (list-search-count) a drain sees email-draft-proposal; through scheduler:get_next it does not; through work_items:claim { id } it can claim one. The P-012 LLM scenario covers this path.',
  },
  {
    id: 'walls-needs-human',
    role: 'listing',
    surface: 'coord:walls (needs-human items)',
    file: 'packages/operator-core/lib/agent-tools/coordination/tools/walls.ts',
    anchor: "AND status = 'needs-human'",
    admits: 'any kind in status needs-human; no item_kind or lane predicate',
    reachesNonWork: 'unknown',
    discriminators: ['status=needs-human', 'harness', 'holder'],
    evidence: 'code',
    note: 'Found by the WI-10005121 completeness scan. A needs-human generic-kind row would surface as a wall; not measured live.',
  },
  {
    id: 'drain-flow',
    role: 'listing',
    surface: 'work_items drain-flow counters (filed vs terminaled)',
    file: 'packages/operator-core/lib/agent-tools/work_items/drain-flow.ts',
    anchor: "AND item_kind = 'bug'",
    admits: 'bug only',
    reachesNonWork: 'no',
    discriminators: ['item_kind=bug', 'harness', 'created_by / terminal_owner'],
    evidence: 'code',
    note: 'Found by the WI-10005121 completeness scan.',
  },
  {
    id: 'search-issues',
    role: 'listing',
    surface: 'search:* issue source (engineer_issues)',
    file: 'packages/operator-core/lib/agent-tools/search/sources.ts',
    anchor: 'FROM harness_shared.engineer_issues ${lex.join}',
    admits: 'inherits the engineer_issues view: bug, change, task',
    reachesNonWork: 'no',
    discriminators: ['engineer_issues view kind filter'],
    evidence: 'code',
    note: 'Found by the WI-10005121 completeness scan.',
  },
  // ── auxiliary ──────────────────────────────────────────────────────────────────────────
  {
    id: 'admission-promoter',
    role: 'auxiliary',
    surface: 'work-items admission promoter',
    file: 'packages/operator-core/lib/work-items-admission-promoter.ts',
    anchor: 'wi.status, wi.item_kind, wi.admission, wi.condition_key, wi.created_ts,',
    admits: 'reads item_kind and admission; per-kind behaviour not read',
    reachesNonWork: 'unknown',
    discriminators: ['admission', 'needsOwnerAction count'],
    evidence: 'unverified',
  },
  {
    id: 'embed-backfill',
    role: 'auxiliary',
    surface: 'search embedding backfill ordering',
    file: 'packages/operator-core/lib/search/embed-backfill.ts',
    anchor: "(lane IS DISTINCT FROM 'observation' AND NOT harness_shared.work_item_status_is_terminal(status)) DESC,",
    admits: 'all kinds; observation and terminal rows only deprioritized',
    reachesNonWork: 'yes',
    discriminators: ['lane (ordering only)'],
    evidence: 'code',
    note: 'Owned by shared-vector-search-libraries-2026-09-29 (D-009c).',
  },
  {
    id: 'composition-rig',
    role: 'auxiliary',
    surface: 'shared-pot-loop composition rig (test DDL mirror)',
    file: 'packages/operator-core/lib/shared-pot-loop/composition-rig.ts',
    anchor: "item_kind           TEXT NOT NULL DEFAULT 'feature',",
    admits: 'mirrors claimFloorsWhereSql incl. frontierPlacementKindClause',
    reachesNonWork: 'no-by-convention',
    discriminators: ['claim floors'],
    evidence: 'code',
    note: 'D-008: the nature column lands here and in HFC_DDL in the same change.',
  },
  {
    id: 'spec-enforcement-latency',
    role: 'auxiliary',
    surface: 'plans spec-enforcement latency metric',
    file: 'packages/operator-core/lib/agent-tools/plans/spec-enforcement-latency.ts',
    anchor: "AND w.lane IS DISTINCT FROM 'observation'",
    admits: 'every kind in one harness except lane=observation; reads timestamps for a latency figure',
    reachesNonWork: 'yes',
    discriminators: ['lane', 'harness'],
    evidence: 'code',
    note: 'Found by the WI-10005121 completeness scan. A metric, not a queue: a non-work row only skews the latency figure.',
  },
  // ── sql ────────────────────────────────────────────────────────────────────────────────
  {
    id: 'sql-claimable-view',
    role: 'sql',
    surface: 'harness_shared.work_items_claimable view',
    file: 'libs/papercusp/libs/db/sql/864-migrate-legacy-human-parks-to-agent-review.sql',
    anchor: 'VIEW harness_shared.work_items_claimable',
    sqlObject: 'work_items_claimable',
    admits: "item_kind = ANY(bug, change, task); payload lane <> observation; payload needsOwnerAction <> true; zero claim floors",
    reachesNonWork: 'no',
    discriminators: ['payload lane', 'payload needsOwnerAction', 'work_item_claim_floors'],
    evidence: 'code+live',
    note: 'Definition read live via pg_get_viewdef 2026-10-01. Migration 1301 recreates it (D-009a); any recreation here lands after 1301.',
  },
  {
    id: 'sql-design-keyset-index',
    role: 'sql',
    surface: 'partial index work_items_design_created_keyset_idx',
    file: 'libs/papercusp/libs/db/sql/885-design-features-created-keyset.sql',
    anchor: 'work_items_design_created_keyset_idx',
    admits: 'hardcoded item_kind family split in the index predicate',
    reachesNonWork: 'unknown',
    discriminators: [],
    evidence: 'unverified',
  },
  {
    id: 'sql-engineer-issues-view',
    role: 'sql',
    surface: 'harness_shared.engineer_issues view (issues:*, search issue source)',
    file: 'libs/papercusp/libs/db/sql/803-work-item-parent-update.sql',
    anchor: 'VIEW harness_shared.engineer_issues',
    sqlObject: 'engineer_issues',
    admits: 'item_kind = ANY(bug, change, task)',
    reachesNonWork: 'no',
    discriminators: ['item_kind list'],
    evidence: 'code+live',
    note: 'Definition read live via pg_get_viewdef 2026-10-01 (WI-10005121).',
  },
  {
    id: 'sql-features-consolidated-view',
    role: 'sql',
    surface: 'harness_shared.harness_features_consolidated view (feature-family reads)',
    file: 'libs/papercusp/libs/db/sql/677-work-item-authority-state.sql',
    anchor: 'VIEW harness_shared.harness_features_consolidated',
    sqlObject: 'harness_features_consolidated',
    admits: 'item_kind <> ALL(bug, change, task): feature, chunk and every generic kind',
    reachesNonWork: 'yes',
    discriminators: [],
    evidence: 'code+live',
    note: 'Definition read live via pg_get_viewdef 2026-10-01 (WI-10005121). The complement of the issue-kind list, so a new generic kind lands here by default.',
  },
  {
    id: 'sql-triage-routed-items-view',
    role: 'sql',
    surface: 'harness_shared.triage_routed_items view (Scout routing outcomes)',
    file: 'libs/papercusp/libs/db/sql/894-triage-corpus-views.sql',
    anchor: 'VIEW harness_shared.triage_routed_items',
    sqlObject: 'triage_routed_items',
    admits: "every kind Scout routed (routed_ref 'wi:%'); no item_kind predicate; exposes non_terminal and non_observation flags",
    reachesNonWork: 'unknown',
    discriminators: ['scout routing join'],
    evidence: 'code+live',
    note: 'Definition read live via pg_get_viewdef 2026-10-01 (WI-10005121). Reaches a non-work row only if Scout routed one.',
  },
];

/**
 * Why a scanned site is NOT a census row. Each basis means the site neither selects nor counts
 * the open work population, so a non-work row reaching it cannot be handed to an agent as work.
 */
export type ScanExclusionBasis =
  /** Reads one row by an id it already holds (or validates/records ids); never enumerates. */
  | 'by-id'
  /** Reads what a named holder currently holds (taken_by / owner), i.e. presence, not the queue. */
  | 'holder'
  /** Finds rows a filer itself created (condition key, identity fingerprint) before minting. */
  | 'filing-identity'
  /** Duplicate detection at create time: compares a candidate against existing rows. */
  | 'dedupe'
  /** Reads rows by their source plan / plan item to evaluate the plan, not to pick work. */
  | 'plan-provenance'
  /** Reads only lane=observation rows (reflections), which are never work. */
  | 'observation-lane'
  /** The object no longer exists in that form (a view later replaced by a table). */
  | 'superseded';

export interface WorkSelectionScanExclusion {
  /** `agent-tool`: a repo-relative file; `sql-view`: a view name without schema. */
  leg: 'agent-tool' | 'sql-view';
  target: string;
  basis: ScanExclusionBasis;
  reason: string;
}

/**
 * What the completeness scan in work-selection-census.test.ts enumerates. A site is a non-test
 * .ts file under `agentToolsDir` whose comment-stripped text reads one of the work tables or
 * calls one of the work deciders, or a view in `sqlDir` whose body reads a work table. Every
 * site must be a census row (`file`, a `sites` entry, or `sqlObject`) or an exclusion below.
 */
export const WORK_SELECTION_SCAN = {
  agentToolsDir: 'packages/operator-core/lib/agent-tools',
  sqlDir: 'libs/papercusp/libs/db/sql',
  tableRead: /\b(?:FROM|JOIN)\s+harness_shared\.(?:work_items|work_items_claimable|engineer_issues)\b/,
  deciderCall:
    /\b(?:listWorkItems|searchWorkItems|countWorkItems|countWorkItemsByState|claimWorkItem|getNextForBee|claimFloorsWhereSql|claimNext)\b/,
  /** Matches one CREATE VIEW statement; group 1 is the (possibly schema-qualified) name. */
  createView: /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:"?\w+"?\.)?"?\w+"?)\s[\s\S]*?;/gi,
  viewBodyRead: /\b(?:harness_shared\.)?(?:work_items|work_items_claimable|engineer_issues)\b/,
} as const;

const AT = 'packages/operator-core/lib/agent-tools/';
const ex = (target: string, basis: ScanExclusionBasis, reason: string): WorkSelectionScanExclusion => ({
  leg: 'agent-tool',
  target: AT + target,
  basis,
  reason,
});

/** Classified 2026-10-01 for WI-10005121 by reading each site's WHERE clause or call context. */
export const WORK_SELECTION_SCAN_EXCLUSIONS: readonly WorkSelectionScanExclusion[] = [
  ex('coordination/agent-goal-sources.ts', 'holder', "reads the items an agent holds to derive its goal"),
  ex('coordination/compaction-staleness.ts', 'holder', "reads the holder's items to judge carry staleness"),
  ex('coordination/coupled-topic-sources.ts', 'holder', "reads coupled peers' held items for topic context"),
  ex('coordination/derive-awaiting.ts', 'holder', 'reads held items to derive what an agent awaits'),
  ex('coordination/presence-tier1.ts', 'holder', 'reads held items for the presence roster'),
  ex('coordination/rebind-identity.ts', 'holder', 'moves holds from an old identity to a new one'),
  ex('coordination/tools/glance.ts', 'holder', 'fleet-health glance over current holds'),
  ex('fleet/fleet-audit.ts', 'holder', "audits fleet members' held items"),
  ex('fleet/fleet-campaign.ts', 'holder', "reads a campaign's held items"),
  ex('fleet_registry/pause-holds.ts', 'holder', 'pauses or resumes existing holds'),
  ex('coordination/blocked-on-status.ts', 'by-id', 'reads the status of named blocker ids'),
  ex('coordination/directive-effect.ts', 'by-id', 'reads items a directive names'),
  ex('plans/cited-work-item-refs.ts', 'by-id', 'validates work-item ids cited in plan text'),
  ex('plans/evidence-measuring-paths.ts', 'by-id', 'reads named items for evidence paths'),
  ex('plans/spec-evidence-store.ts', 'by-id', 'reads named items for spec evidence'),
  ex('scout/grade-idea.ts', 'by-id', 'reads the one work item whose id equals the graded idea id, to refuse a ledger-key collision'),
  ex('work_items/complete.ts', 'by-id', 'completes the id it is given'),
  ex('work_items/expand.ts', 'by-id', 'expands the id it is given'),
  ex('work_items/rehome.ts', 'by-id', 'rehomes the id it is given'),
  ex('coordination/coupling-sources.ts', 'observation-lane', 'reads lane=observation reflections only'),
  ex('improvements/filing-classes.ts', 'filing-identity', 'finds an existing row for a filing class before minting'),
  ex('plans/acceptance-drain-filing.ts', 'filing-identity', 'finds its own acceptance-drain filing'),
  ex('plans/acceptance-drain-sweep.ts', 'filing-identity', 'sweeps its own acceptance-drain filings'),
  ex('plans/spec-triad-filing.ts', 'filing-identity', 'finds its own spec-triad filing'),
  ex('plans/spec-triad-sweep.ts', 'filing-identity', 'sweeps its own spec-triad filings'),
  ex('testing/flakiness.ts', 'dedupe', 'finds an existing flaky-test item before filing'),
  ex('work_items/_create-core.ts', 'dedupe', 'create-time duplicate and identity checks'),
  ex('work_items/fulltext-lexical-dupe-guard.ts', 'dedupe', 'create-time lexical duplicate guard'),
  ex('work_items/recent-lexical-dupe-guard.ts', 'dedupe', 'create-time recent-duplicate guard'),
  ex('work_items/semantic-dupe-guard.ts', 'dedupe', 'create-time semantic duplicate guard'),
  ex('plans/plan-admission-preflight.ts', 'plan-provenance', "reads a plan's own items before admitting it"),
  ex('plans/plan-scope-cascade-deps.ts', 'plan-provenance', "reads a plan's items to cascade scope"),
  ex('scorecards/emit.ts', 'plan-provenance', "reads a subject plan's items while emitting a scorecard"),
  {
    leg: 'sql-view',
    target: 'fleet_assignment',
    basis: 'holder',
    reason: 'rows only where taken_by is set: who holds what, not the queue',
  },
  {
    leg: 'sql-view',
    target: 'work_items',
    basis: 'superseded',
    reason: 'the union view of migrations 159/178/358 was replaced by the work_items table',
  },
];

/** Natures from D-001, plus the two internal row classes D-009(e) keeps in work_items. */
export type SeedNature = 'work' | 'record' | 'document' | 'event' | 'internal-excluded' | 'retired';

export interface WorkSelectionSeedRow {
  itemKind: string;
  nature: SeedNature;
  audience: 'agent' | 'human' | null;
  /** Extra payload to stamp (lane, needsOwnerAction). */
  payload: Record<string, unknown>;
  status: string;
  /** What every `selection` path must do with this row after P-009. */
  expectAgentClaimable: boolean;
  source: string;
}

/**
 * One row per (nature, audience) class that exists today, for P-012's isolated-DB guard.
 * Documents and events have no work_items instances yet (D-003/D-005 give them their own
 * tables), so P-012 adds their seeds when those tables land.
 */
export const WORK_SELECTION_SEED_ROWS: readonly WorkSelectionSeedRow[] = [
  { itemKind: 'bug', nature: 'work', audience: 'agent', payload: {}, status: 'open', expectAgentClaimable: true, source: 'built-in kind' },
  { itemKind: 'change', nature: 'work', audience: 'agent', payload: {}, status: 'open', expectAgentClaimable: true, source: 'built-in kind' },
  { itemKind: 'task', nature: 'work', audience: 'agent', payload: {}, status: 'open', expectAgentClaimable: true, source: 'built-in kind' },
  { itemKind: 'feature', nature: 'work', audience: 'agent', payload: {}, status: 'open', expectAgentClaimable: true, source: 'built-in kind' },
  { itemKind: 'calendar-meeting-prep', nature: 'work', audience: 'agent', payload: {}, status: 'open', expectAgentClaimable: true, source: 'D-007' },
  { itemKind: 'email-draft-proposal', nature: 'work', audience: 'human', payload: {}, status: 'open', expectAgentClaimable: false, source: 'D-007; 129 open live' },
  { itemKind: 'pipeline-deal', nature: 'record', audience: null, payload: {}, status: 'open', expectAgentClaimable: false, source: 'D-007' },
  { itemKind: 'bet', nature: 'record', audience: null, payload: {}, status: 'open', expectAgentClaimable: false, source: 'D-007' },
  { itemKind: 'wager', nature: 'record', audience: null, payload: {}, status: 'open', expectAgentClaimable: false, source: 'D-007' },
  { itemKind: 'forecast', nature: 'record', audience: null, payload: {}, status: 'open', expectAgentClaimable: false, source: 'D-007' },
  { itemKind: 'calibration-record', nature: 'record', audience: null, payload: {}, status: 'open', expectAgentClaimable: false, source: 'D-007' },
  { itemKind: 'change', nature: 'internal-excluded', audience: null, payload: { lane: 'observation' }, status: 'open', expectAgentClaimable: false, source: 'D-009(e): observation reflections and scorecards (scorecards are lane=observation rows)' },
  { itemKind: 'bug', nature: 'work', audience: 'human', payload: { needsOwnerAction: true }, status: 'open', expectAgentClaimable: false, source: 'existing needs-owner-action discriminator' },
  { itemKind: 'chunk', nature: 'retired', audience: null, payload: {}, status: 'open', expectAgentClaimable: false, source: "retired kind; 12 live rows (status 'passed')" },
];
