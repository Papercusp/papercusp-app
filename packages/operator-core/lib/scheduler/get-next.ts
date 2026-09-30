/**
 * get-next.ts — the deterministic, spec-driven `get_next` resolver
 * (hybrid-bee-scheduler-work-stealing-2026-06-22, Phase 3 / D-002, D-003, D-010).
 *
 * A bee calls `getNextWorkItem(spec, bee)`; the resolver atomically claims the single
 * top-ranked eligible work-item by compiling:
 *
 *     (GLOBAL HARD FLOORS)  AND  (compiled spec.view.filter)
 *     ORDER BY (compiled spec.rank)
 *     LIMIT 1 FOR UPDATE SKIP LOCKED
 *
 * The model (D-002 — "centralize JUDGMENT, decentralize PICKUP"):
 *  - **Floors are the resolver's, never the spec's.** The eligibility floors
 *    (workspace + feature-family kind, G2 admission, unclaimed, claimable status,
 *    swarm affinity, redundancy fan-out, and the readiness/blocking `NOT EXISTS`
 *    clause) are the SHARED `claimFloorsWhereSql` fragment from work-items.ts — the
 *    EXACT floors `claimNextWorkItem` ANDs in, so the two claim paths can never drift.
 *    A spec can only NARROW (filter) + REORDER (rank); it can never widen past or
 *    re-assert a floor. (The validator already rejects a `blocked`/`cursed` filter
 *    term, so a validated spec is structurally floor-safe before it reaches here.)
 *  - **View, not copy** (D-003): the filter is compiled to a WHERE fragment evaluated
 *    against the LIVE DAG at claim time — never a frozen subgraph.
 *  - **SQL safety is structural.** The validator constrains the field/op/rank-term
 *    vocabulary to a closed set, so every field/op maps to a hand-written, SAFE
 *    `sql` fragment and every spec-supplied VALUE is bound as a parameter — a spec
 *    value is NEVER string-interpolated into SQL.
 *  - **`DEFAULT_CLAIM_SPEC` reproduces today's ordering** (the Queen's intended
 *    `(affinity) → feature_order → created_ts`): handing a bee no spec is equivalent
 *    to handing it the default, so the feature is a strict superset with zero behavior
 *    change until the Queen authors a narrower spec.
 *
 * Descoped-but-validated rank terms (D-010): `model_fit`, `tag_weight`, and
 * `redundancy_need` are in the spec vocabulary (so specs that reference them validate)
 * but the resolver compiles them to a NEUTRAL constant — they don't reorder until the
 * per-MODEL capability lane / tag-weight table ship behind their own flags. `affinity`
 * IS live (it's the reason within-hive push was chosen, preserved as a rank term).
 *
 * `states` (drain-claim-spec-hardening-2026-07-13 D-002, fixes EI-11300): the claimable-
 * status floor is likewise spec-carriable — `opts.states` (the caller's per-call arg) wins
 * when given; otherwise the resolver falls back to `spec.states` (the fleet leader's
 * standing policy) before `claimFloorsWhereSql`'s own `['todo']` default. Same NARROW-only
 * discipline as the filter/rank: a spec can set this floor's DEFAULT, never widen past it
 * (the values are still drawn from `CLAIM_STATES_ALLOWLIST`, so `blocked`/`cursed`/terminal
 * remain unreachable).
 */
import type postgres from 'postgres';
import {
  type ClaimSpec,
  type FilterNode,
  type FilterLeaf,
  type RankTerm,
  DEFAULT_CLAIM_SPEC,
  positiveIdCohortIds,
  claimSpecReferencesField,
} from './claim-spec';
import { getOrgPg } from '@papercusp/db-org';
import { boundedOrgTxn, OrgTxnTimeoutError } from '../pg-bounded-txn';
import { activeWorkspaceId } from '../workspace-registry';
import {
  claimFloorsWhereSql,
  schedulerMaintainedReadyEnabled,
  schedulerIssuesClaimableEnabled,
  claimNextIssueWorkItem,
  guardPlanItemSiblingClaim,
  armWorkItemHolderInterests,
  featureRowToWorkItem,
  familyOf,
  FEATURE_COLS,
  ISSUE_FAMILY_KINDS,
  ISSUE_FAMILY_CLAIMABLE_STATES,
  releaseCooldownSec,
  claimHoldExclusionSql,
  needsOwnerActionExclusionSql,
  observationLaneExclusionSql,
  externalBlockersExclusionSql,
  depsBlockedExclusionSql,
  issueCooldownExclusionSql,
  reservedPlanLaneExclusionSql,
  federationDetectorExclusionSql,
  loopIterationNoiseExclusionSql,
  alreadyTerminallyCompletedExclusionSql,
  crossMachineRigExclusionSql,
  watchdogRecoveryWindowExclusionSql,
  type FeatureRowDb,
  type OrgSql,
  type WorkItem,
} from '../work-items';
import { resolveIssuesScopeWorkspace } from '../issues-engineer';
import {
  admittedWhereSqlWi,
  isIssueLocallyClaimableWhereSql,
  liveGateOpsSelfSelectExclusionSql,
  stopTheLineExclusionSql,
} from '../work-items-admission';
import { trackDetached } from '../detached-imports';
import { agentReviewNormalExclusionSql, readAgentReviewState } from '../harness/improvements/agent-review-policy';
import {
  classifyAuditAge,
  classifyDurableParkReleaseLiveness,
  classifyUnparkCondition,
  type AuditAge,
  type DurableParkReleaseLiveness,
  type UnparkConditionStatus,
} from '../work-items-durable-park-audit';

/** A composed `sql` WHERE/ORDER-BY fragment (porsager pending-query — the type a bare
 *  `sql`...`` tagged template returns, so fragments compose by `${}` interpolation). */
type SqlFragment = postgres.PendingQuery<postgres.Row[]>;

/**
 * The pulling bee's own state — the `bee.*` half of the spec vocabulary. Supplied by
 * the caller (launch handoff / durable spawn record); only `held_paths` is consulted
 * today (the live `affinity` rank term). `model` / `load` / `current_plan` are accepted
 * so a spec referencing them resolves, but they are neutral until their lanes ship.
 */
export interface BeeContext {
  /** The claiming agent id — written to `taken_by` (the claim owner). */
  assignee: string;
  /** Paths this bee already holds open — the `affinity` rank-term input (D-001). */
  heldPaths?: string[];
  /**
   * Repo paths held by OTHER live agents right now. Candidate items whose declared
   * payload.paths overlap these are soft-demoted behind independent work. They are
   * never excluded: if every candidate conflicts, the best conflicting item still wins.
   */
  contendedPaths?: string[];
  /** The bee's model class (`model_fit`, descoped-neutral until P-004). */
  model?: string;
  /** Current load (accepted for vocabulary completeness; neutral today). */
  load?: number;
  /** The bee's current plan (accepted for vocabulary completeness; neutral today). */
  currentPlan?: string;
}

export interface GetNextOpts {
  harness: string;
  /**
   * Optional caller-owned SQL client. The scheduler tool supplies a small dedicated
   * transactional pool so claim pickup cannot queue behind unrelated MCP reads on the
   * process-wide org pool. Omitted preserves every existing caller/test path.
   */
  client?: OrgSql;
  /**
   * WI-5261: the caller's already-resolved workspace (e.g. resolveClaimSpecWorkspace's
   * output in getNextForBee) — explicitly threaded through so tier 1/2/3 don't have to
   * re-derive it via activeWorkspaceId()/issuesScopeWorkspace(), which depend on the
   * AsyncLocalStorage request-scope still being intact at the exact moment of the call.
   * Undefined ⇒ unchanged legacy behavior (falls back to activeWorkspaceId() /
   * issuesScopeWorkspace() exactly as before) — purely additive, no breaking change for
   * callers (tests, other entry points) that don't pass one.
   */
  workspaceId?: string;
  /** THIS Swarm's id — when set, the affinity/redundancy FLOORS honor it (per-Hive lease). */
  swarmId?: string;
  /** EI-13524: claimant fleet used to authorize its own fleet-stamped plan lane. */
  fleetSlug?: string;
  /**
   * EI-18805386252364731: override the claim ladder's time budget in ms (default
   * CLAIM_LADDER_BUDGET_MS, per-attempt capped at CLAIM_ATTEMPT_BUDGET_MS). Lets a caller with
   * a tighter SLA than the transport bound the pull, and lets the recurrence guard assert that
   * an exhausted budget raises a TYPED error instead of a drain-shaped miss.
   */
  claimBudgetMs?: number;
  /** Skip high-stakes (redundancy > 1) items (redundancy flag on). */
  excludeRedundant?: boolean;
  /**
   * Claimable statuses floor (default ['todo']). An explicit `states` here is the caller's
   * per-call OVERRIDE and always wins; when omitted, `getNextWorkItem` falls back to the
   * claim spec's own `states` (D-002, EI-11300) before the ['todo'] default.
   */
  states?: string[];
  /** WI-2796: caller has/coordinates a live ≥2-machine rig — see crossMachineRigExclusionSql. */
  rigAvailable?: boolean;
  /** Abort the active claim transaction when the scheduler caller's bounded deadline fires. */
  signal?: AbortSignal;
}

export interface GetNextResult {
  workItem: WorkItem;
  /** Provenance (D-003/D-006): WHICH spec revision selected this item. */
  claimedUnder: { specId: string; revision: number };
}

// ────────────────────────────────────────────────────────────────────────────
// Vocabulary → column mapping. The validator guarantees only these fields reach us.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Map a spec ITEM field to a SAFE, hand-written column expression over
 * `harness_features_consolidated`. Returns the `sql` fragment for the column AND its
 * kind (scalar vs. array/json), so the op-compiler can pick the right comparison.
 *
 * Notes on the non-obvious ones:
 *  - `priority` ⇒ `feature_order`, an INVERTED scale (LOWER feature_order = HIGHER
 *    priority, the Queen's steer lever). The op/rank compilers flip direction so a
 *    spec author's `priority desc` ("highest priority first") maps to
 *    `feature_order ASC` at the column.
 *  - `age` ⇒ `created_ts`. "Age asc" = oldest-first = `created_ts ASC` (the legacy
 *    work-stealing order); the column is the creation timestamp, so direction passes
 *    through unflipped (earlier ts sorts first under ASC).
 *  - `risk_tier` / `paths` are NOT first-class columns — they live in `payload` jsonb
 *    (`payload->>'risk_tier'`, `payload->'paths'`), so a spec can filter on them without
 *    a schema change. `risk_tier` is filter-ONLY: the jsonb accessor yields TEXT, so a
 *    bare rank on it sorts lexically (EI-19286311763526137 — see its FIELD_MAP entry).
 *  - `plan_item` ⇒ `source_plan_item_ids` (a text[]), the only array item-field.
 */
/**
 * Time budget for ONE claim attempt, and for the whole fallback ladder (EI-18805386252364731).
 *
 * The ladder runs its query up to three tiers plus a release-and-retry loop, so these are two
 * genuinely different bounds: the per-attempt value caps a single pathological statement, and
 * the ladder value caps their SUM — without the latter, several individually-affordable
 * attempts still add up to a pull that never returns.
 *
 * Sized to stay comfortably under the MCP transport's own patience so the failure surfaces as a
 * typed error from US, with a spec to blame, rather than as an opaque client-side abort.
 */
const CLAIM_ATTEMPT_BUDGET_MS = 5_000;
const CLAIM_LADDER_BUDGET_MS = 15_000;

type FieldKind = 'scalar-text' | 'scalar-num' | 'json-array' | 'text-array';
interface FieldMap {
  /** The column/expression `sql` fragment. */
  col: (sql: OrgSql) => SqlFragment;
  kind: FieldKind;
  /** True when the field is an INVERTED scale (rank/op direction flips). */
  inverted?: boolean;
}

const FIELD_MAP: Record<string, FieldMap> = {
  priority: { col: (sql) => sql`feature_order`, kind: 'scalar-num', inverted: true },
  // `kind` — EI-11291/D-001 (drain-claim-spec-hardening-2026-07-13): the discriminator is
  // `item_kind` (NOT NULL, defaulted 'feature' by mig 136), never the legacy `kind` column
  // (unrelated free-text metadata on a handful of rows — 'security'/'infra'/etc — NOT an
  // item-kind value; always NULL for the vast majority of rows). COALESCE(item_kind, kind)
  // per D-001: item_kind is structurally never NULL today, so this is defense-in-depth (a
  // future schema regression that let item_kind go NULL would silently fall back to the
  // legacy column instead of never matching), not a behavior change.
  kind: { col: (sql) => sql`COALESCE(item_kind, kind)`, kind: 'scalar-text' },
  age: { col: (sql) => sql`created_ts`, kind: 'scalar-num' },
  // `severity` — WI-6675. Issue-family severity (critical|major|minor|nit) as a FILTER
  // field, so a drain lane can scope itself with `severity in ['critical','major']`.
  // The accessor is `payload->'_ei'->>'severity'` FIRST with a top-level fallback, which
  // is WI-6674's finding and matches this file's own projection at the claimable query
  // below: severity has two access paths (the TABLE keeps it under the `_ei` fold from
  // migration 374; the VIEW explodes `_ei` into real columns and, since migration 1096,
  // ALSO keeps the blob — so on the VIEW both accessors resolve and agree except on
  // NULL-payload rows, where only the `severity` column reports its 'minor' default).
  // The wrong path for a relation yields NULL for EVERY row without erroring — a query
  // that returns a well-formed, plausible, wrong answer. Measured 2026-08-01 against the
  // TABLE, where it still holds: 0 of 13,711 open rows via the top-level path vs 13,711
  // via the `_ei` path, reporting 30 genuine criticals as none. The JS evaluator (claim-spec-match.ts) resolves this field in the
  // SAME precedence order deliberately — the two admission evaluators MUST agree on one
  // field's logical source or the same spec admits an item on one family's path and
  // refuses it on the other's (WI-5781, documented on `plan` below).
  // NOT rankable: RANKABLE_ITEM_FIELDS excludes it because severity is TEXT, so a bare
  // `severity desc` would sort nit > minor > major > critical — exactly backwards.
  // BOTH claim queries compile this same fragment, and the asymmetry is intended rather
  // than incidental: the issue-family query reads harness_shared.work_items, where the
  // `_ei` leg resolves; the feature-family query reads harness_features_consolidated,
  // where severity is structurally absent (work-items.ts maps feature rows `severity:
  // null`), so the expression yields NULL and a severity-scoped filter simply refuses
  // every feature row. That is the correct semantic — severity is an issue-family notion,
  // so a lane scoped to `severity in [critical,major]` SHOULD admit no features — and the
  // jsonb operators are valid on both relations (both carry a `payload` column, as the
  // `plan` entry below already relies on), so this is a clean NULL, never an error.
  severity: {
    col: (sql) => sql`COALESCE(payload->'_ei'->>'severity', payload->>'severity')`,
    kind: 'scalar-text',
  },
  // `goal` — WI-37711. A PHYSICAL column on `harness_shared.work_items` (migration 785 /
  // P-002), which is the base table for BOTH families, so no COALESCE/payload fallback is
  // needed here and this compiles identically for features and issues. The JS evaluator's
  // half of the same field is `claim-spec-match.ts`'s `case 'goal'`, reading the mapped
  // `WorkItem.goalId` — the two must resolve from the same logical source (see the
  // EI-18654360178824151 note under `plan` below for what divergence costs).
  //
  // ⚠ NULLABLE and mostly unstamped, so a `not`/`!=` leaf silently drops every unstamped
  // row (WI-5181). A goal lane wants the positive `=`/`in` form.
  goal: { col: (sql) => sql`goal_id`, kind: 'scalar-text' },
  est_cost: { col: (sql) => sql`expected_cost_cents`, kind: 'scalar-num' },
  redundancy: { col: (sql) => sql`COALESCE(redundancy, 1)`, kind: 'scalar-num' },
  assignee: { col: (sql) => sql`taken_by`, kind: 'scalar-text' },
  // `id` — the work-item id. A spec PINS a fixed set with `id in [...]` (scalar-text, so
  // the `in` op compiles to `feature_id::text = ANY(...)`). A STATIC pin (no auto-inflow),
  // the exception for a fixed wave; the floors (ready/lease/dedup) still apply on top.
  id: { col: (sql) => sql`feature_id`, kind: 'scalar-text' },
  // `title` — WI-3268: keyword exclusion (glob/contains/!=) so a constrained fleet can
  // durably filter out a class of work (e.g. `*p2p*`) that carries no `tags` data.
  title: { col: (sql) => sql`title`, kind: 'scalar-text' },
  // `summary` — EI-20240035377782004: same shape as `title` one layer deeper, closing the
  // scope leak where a title-only exclusion fence admits an item whose SUMMARY (not title)
  // names the excluded class. A real physical column on this base table for both families
  // (same as `title`), so no COALESCE/payload fallback is needed.
  summary: { col: (sql) => sql`summary`, kind: 'scalar-text' },
  // EI-18654360178824151: COALESCE the physical column with the SAME payload-derivation
  // fallback `planSlugOfWorkItem()` (claim-spec-match.ts) uses for the issue-family JS
  // evaluator — the two admission evaluators (this SQL compiler for feature-family items,
  // the JS evaluator for everything else) must resolve `plan`/`tags` from the SAME logical
  // source, or the SAME spec admits an item on one family's path and refuses it on the
  // other's (confirmed live: WI-5781 — plan linkage lived only in `payload.plan_item.*`,
  // the column was NULL, the JS-side issue-family path admitted it, the SQL-side
  // feature-family path did not). Mirrors `planSlugOfWorkItem`'s precedence exactly:
  // `payload.plan_item` (or `payload.planItem`) `.plan_slug`/`.slug`, then top-level
  // `payload.source_plan_slug` — column first because it's indexed (hfc_source_plan_slug_idx)
  // and authoritative whenever it's set; the payload legs are a fallback for items whose
  // plan linkage was only ever written to payload.
  plan: {
    col: (sql) => sql`COALESCE(
      source_plan_slug,
      payload->'plan_item'->>'plan_slug',
      payload->'plan_item'->>'slug',
      payload->'planItem'->>'plan_slug',
      payload->'planItem'->>'slug',
      payload->>'source_plan_slug'
    )`,
    kind: 'scalar-text',
  },
  // EI-20288961198837165: plan-item provenance is split across the indexed physical column and
  // payload-only rows. Keep the physical column first (an empty text[] is an intentional answer),
  // then mirror claimSpecSubjectFromWorkItem's payload.plan_item/planItem item-id derivation and
  // finally the legacy payload source-plan-item array. Without these fallbacks, the five live
  // plan_item-scoped specs cannot admit the 3,390 rows whose column is NULL but payload is set.
  plan_item: {
    col: (sql) => sql`COALESCE(
      source_plan_item_ids,
      CASE
        WHEN COALESCE(
          payload->'plan_item'->>'item_id',
          payload->'plan_item'->>'itemId',
          payload->'plan_item'->>'item',
          payload->'planItem'->>'item_id',
          payload->'planItem'->>'itemId',
          payload->'planItem'->>'item'
        ) IS NOT NULL
        THEN ARRAY[COALESCE(
          payload->'plan_item'->>'item_id',
          payload->'plan_item'->>'itemId',
          payload->'plan_item'->>'item',
          payload->'planItem'->>'item_id',
          payload->'planItem'->>'itemId',
          payload->'planItem'->>'item'
        )]
      END,
      CASE
        WHEN jsonb_typeof(payload->'source_plan_item_ids') = 'array'
        THEN ARRAY(SELECT jsonb_array_elements_text(payload->'source_plan_item_ids'))
      END
    )`,
    kind: 'text-array',
  },
  // EI-13524: fleet-owned plan-lane provenance stamped by fleet launch promotion.
  // Filter-only (claim-spec.ts excludes it from rank); shared by both claim families.
  fleet: { col: (sql) => sql`payload->>'fleet_slug'`, kind: 'scalar-text' },
  // EI-16052: improvement-triage decision ('gate' = a human gate — needs a design draft or
  // an owner before implementation). Filter-only (claim-spec.ts excludes it from rank).
  // This leg MUST stay in step with claim-spec-match.ts's `triageGate` subject field: the
  // two evaluate the same spec on different paths, and WI-38326 is the recorded case of them
  // silently disagreeing (SQL answered 1 where JS answered null, so one filter admitted ALL
  // and the other NONE). The nested `->'ideaLifecycle'->>'triageDecision'` reach is the whole
  // reason this needed a FIELD_MAP entry rather than a plain column.
  triage_gate: { col: (sql) => sql`payload->'ideaLifecycle'->>'triageDecision'`, kind: 'scalar-text' },
  // Not first-class columns — projected out of payload jsonb (no schema change).
  // `risk_tier` is FILTER-ONLY (EI-19286311763526137): `payload->>'risk_tier'` is TEXT
  // however numeric the authored value looks, so a bare `risk_tier` rank sorts lexically
  // ('10' before '2'; high < low < medium for word-valued tiers) — severity's inversion
  // trap, which this field was flagged as "the next domino" for. Excluded from
  // RANKABLE_ITEM_FIELDS; filtering is unchanged and is the only way it has been used
  // (0 of 292 live specs rank on it, and no work_items row carries the key at all).
  risk_tier: { col: (sql) => sql`(payload->>'risk_tier')`, kind: 'scalar-text' },
  // EI-18654360178824151: same single-source fix as `plan` above — mirrors
  // `staticTagsOfWorkItem()`'s `payload.tags` fallback so a tags-filtered spec agrees
  // across both admission evaluators.
  tags: { col: (sql) => sql`COALESCE(tags, payload->'tags')`, kind: 'json-array' },
  paths: { col: (sql) => sql`payload->'paths'`, kind: 'json-array' },
};

// ────────────────────────────────────────────────────────────────────────────
// Filter compiler — spec.view.filter → a parameterized WHERE fragment.
// ────────────────────────────────────────────────────────────────────────────

function isLeaf(node: FilterNode): node is FilterLeaf {
  return 'field' in node;
}

/**
 * Compile a single comparison leaf to a SAFE `sql` fragment. EVERY value is BOUND as
 * a parameter (`${value}`) — never interpolated. The op→SQL mapping is hand-written
 * per field kind, so an op that is meaningless for a kind (e.g. `<` on tags) can only
 * arise from a validated-coherent spec (the validator already enforces op/value
 * coherence) and still produces well-typed SQL.
 */
function compileLeaf(sql: OrgSql, leaf: FilterLeaf) {
  const fm = FIELD_MAP[leaf.field];
  if (!fm) {
    // Unreachable for a validated spec (the validator's field allow-list == FIELD_MAP
    // keys). Throw rather than silently emit TRUE — a missing mapping is a CODE bug.
    throw new Error(`get_next: no column mapping for filter field "${leaf.field}"`);
  }
  const col = fm.col(sql);
  const v = leaf.value;

  switch (fm.kind) {
    case 'json-array': {
      // tags / paths are jsonb arrays. `contains` ⇒ the array holds the scalar;
      // `glob` ⇒ ANY element matches the glob (translated to SQL LIKE). `in` ⇒ the
      // array overlaps the supplied set.
      if (leaf.op === 'contains') {
        // jsonb `?` "has top-level string key/element" — value bound as text.
        return sql`${col} ? ${String(v)}`;
      }
      if (leaf.op === 'glob') {
        // ILIKE (not LIKE): glob is used for human-authored keyword matching (e.g. a
        // path prefix or a tag), and WI-3268's title exclusion depends on
        // case-insensitivity — a proper-noun title like "Hyperswarm sidecar
        // isolation" must still match the lowercase pattern `*hyperswarm*`.
        return sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(${col}, '[]'::jsonb)) e WHERE e ILIKE ${globToLike(String(v))})`;
      }
      if (leaf.op === 'word') {
        // Word-boundary literal match — see wordBoundaryPgRegex above.
        return sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(${col}, '[]'::jsonb)) e WHERE e ~* ${wordBoundaryPgRegex(String(v))})`;
      }
      if (leaf.op === 'in') {
        const arr = (Array.isArray(v) ? v : [v]).map(String);
        return sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(${col}, '[]'::jsonb)) e WHERE e = ANY(${arr}::text[]))`;
      }
      // = / != against a json array: compare membership-equality of the WHOLE set.
      //
      // WI-5995: COALESCE the membership test to false BEFORE negating, exactly as
      // `compileFilter`'s `not` branch does (EI-13306) and as the text-array `!=` branch
      // below already did via `COALESCE(col, ARRAY[]::text[])`. Without it, a row whose
      // tags/paths are absent yields `NULL ? 'x'` = NULL, `NOT NULL` = NULL, and the WHERE
      // clause DROPS the row — the same silent-starvation shape EI-13306 fixed for scalars,
      // surviving here because `!=` is a LEAF op and never passes through that `not` branch.
      // The scalar `!=` comment below asserts "the ARRAY branches above already do [admit]":
      // that was true of text-array and FALSE of json-array, which is the gap this closes.
      // Measured on the live backlog (2026-08-12, 25,698 open issue-family rows in
      // papercusp-workspace): `tags != 'p2p-release'` admitted 33 rows; null-safe it admits
      // 25,691 — a 778x collapse of the claimable pool, from a spec that validates clean.
      // `paths != 'x'` was the same shape: 1,472 admitted of 25,698 (24,226 rows carry no
      // paths at all). The JS evaluator has always admitted these (its subject projects an
      // absent array to `[]`, so `!actual.includes(v)` is true), so this was also a live
      // divergence between the two evaluators of one spec language.
      if (leaf.op === '!=') return sql`NOT COALESCE((${col} ? ${String(v)}), false)`;
      return sql`${col} ? ${String(v)}`;
    }
    case 'text-array': {
      // source_plan_item_ids text[] — `contains`/`=` ⇒ membership; `in` ⇒ overlap.
      if (leaf.op === 'in') {
        const arr = (Array.isArray(v) ? v : [v]).map(String);
        return sql`${col} && ${arr}::text[]`;
      }
      if (leaf.op === '!=') return sql`NOT (${String(v)} = ANY(COALESCE(${col}, ARRAY[]::text[])))`;
      // = / contains ⇒ membership of the scalar in the array.
      return sql`${String(v)} = ANY(COALESCE(${col}, ARRAY[]::text[]))`;
    }
    default: {
      // scalar-text / scalar-num.
      if (leaf.op === 'in') {
        const arr = Array.isArray(v) ? v : [v];
        return fm.kind === 'scalar-num'
          ? sql`${col} = ANY(${arr.map(Number)}::numeric[])`
          : sql`${col}::text = ANY(${arr.map(String)}::text[])`;
      }
      if (leaf.op === 'glob') {
        // ILIKE — see the json-array glob branch above: WI-3268's title exclusion
        // (`*hyperswarm*` must match "Hyperswarm sidecar isolation") needs
        // case-insensitive matching, and there is no scalar-text use case that
        // wants case-SENSITIVE glob matching to break instead.
        return sql`${col}::text ILIKE ${globToLike(String(v))}`;
      }
      if (leaf.op === 'word') {
        // Word-boundary literal match — see wordBoundaryPgRegex above.
        return sql`${col}::text ~* ${wordBoundaryPgRegex(String(v))}`;
      }
      if (leaf.op === 'contains') {
        // substring containment for a scalar (text) field — same case-insensitivity
        // rationale as `glob` immediately above.
        return sql`${col}::text ILIKE ${'%' + String(v) + '%'}`;
      }
      // Relational + equality ops on a scalar column. `inverted` (feature_order /
      // priority): flip the comparator so the spec author's intent on the LOGICAL
      // field maps to the physical inverted column.
      const op = fm.inverted ? invertComparator(leaf.op) : leaf.op;
      const bound = fm.kind === 'scalar-num' ? sql`${Number(v)}` : sql`${String(v)}`;
      const cmp = fm.kind === 'scalar-num' ? sql`${col}` : sql`${col}::text`;
      switch (op) {
        case '=':
          // NULL never matches a positive `=` — correct, and matches the JS evaluator.
          return sql`${cmp} = ${bound}`;
        case '!=':
          // IS DISTINCT FROM, not `<>` (EI-13306). A NULL row is DISTINCT from any value, so
          // `plan != 'x'` ADMITS a row with no plan — which is what the author means, and what
          // the ARRAY branches above already do: text-array `!=` compiles to
          // `NOT (v = ANY(COALESCE(col, ARRAY[]::text[])))`, which on a NULL column is
          // `NOT false` = true. Scalar `<>` was the odd one out, yielding NULL -> row dropped.
          // The JS evaluator's compareScalar carries the matching null-admits case for `!=`.
          return sql`${cmp} IS DISTINCT FROM ${bound}`;
        case '<':
          return sql`${cmp} < ${bound}`;
        case '<=':
          return sql`${cmp} <= ${bound}`;
        case '>':
          return sql`${cmp} > ${bound}`;
        case '>=':
          return sql`${cmp} >= ${bound}`;
        default:
          throw new Error(`get_next: unhandled scalar op "${leaf.op}"`);
      }
    }
  }
}

/** Flip a relational comparator for an inverted-scale column (feature_order). */
function invertComparator(op: FilterLeaf['op']): FilterLeaf['op'] {
  switch (op) {
    case '<':
      return '>';
    case '<=':
      return '>=';
    case '>':
      return '<';
    case '>=':
      return '<=';
    default:
      return op; // =, != unaffected
  }
}

/** Translate a restricted glob (`*`, `?`) to a SQL LIKE pattern, escaping LIKE metachars. */
function globToLike(glob: string): string {
  // Escape LIKE's own metacharacters first, then map glob wildcards.
  const escaped = glob.replace(/([%_\\])/g, '\\$1');
  return escaped.replace(/\*/g, '%').replace(/\?/g, '_');
}

/**
 * Escape a literal for interpolation into a Postgres ARE (advanced regular
 * expression), used by the `word` op below. Mirrors claim-spec-match.ts's
 * `escapeRegexLiteral` (JS regex metachars are the same set Postgres ARE uses).
 */
function escapePgRegexLiteral(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The SQL mirror of the JS evaluator's `word` boundary (EI-18690730909662985):
 * a case-insensitive WHOLE-WORD substring match, unlike `glob`'s bare substring
 * ILIKE which false-positives on a literal nested inside a larger word (e.g.
 * `*p2p*` matching "nonp2p-bug-drain").
 *
 * Uses explicit `[^A-Za-z0-9]`/string-edge boundaries, NOT Postgres's `\m`/`\M`
 * word anchors: Postgres counts `_` as a word character exactly as JS `\b` does,
 * so `\mreplication\M` does not match "replication_soak" — the snake_case blind
 * spot that leaked WI-5639 into a non-P2P fleet. Verified both engines agree
 * before AND after this change. Keep in sync with claim-spec-match.ts's
 * `wordBoundaryRegex` (which carries the full rationale) and
 * claim-spec-payload-filter.ts's `wordBoundaryRegexSource`.
 */
function wordBoundaryPgRegex(literal: string): string {
  const lit = escapePgRegexLiteral(literal);
  return `(^|[^A-Za-z0-9])${lit}([^A-Za-z0-9]|$)`;
}

/**
 * fleet-backlog-lessons-2026-07-01 P-005 (WI-1407): strip a top-level `kind` leaf (or one
 * inside a top-level `all`) out of a filter tree, returning the WIDENED filter — used by
 * the resolver's tier-2 fallback so a spec narrowed to one feature-family `kind` widens to
 * the rest of the family before giving up, instead of exiting on that tier alone. Returns
 * `undefined` when there is nothing left to widen from (no `kind` leaf found at a shape this
 * can safely simplify), which the caller reads as "tier 2 is not applicable here" — a `kind`
 * leaf buried inside an `any`/`not` combinator changes OR/NOT semantics if dropped, so this
 * deliberately does NOT attempt to rewrite those shapes (conservative: no widening rather than
 * a wrong widening).
 */
function widenPastKind(filter: FilterNode | undefined): FilterNode | undefined {
  if (!filter) return undefined;
  if (isLeaf(filter)) {
    if (filter.field !== 'kind') return filter;
    // Only a kind leaf that admits a FEATURE-family kind is widenable (EI-7481): an issue-only
    // constraint (e.g. kind='bug') has no feature-family sibling to widen to — dropping it here
    // would let a bug-only member claim a feature/research-task/chunk. Leave it in place so this
    // tier is a no-op and the kind-preserving tier-3 issue fallback handles the lane.
    return kindLeafWidensToFeatureFamily(filter) ? undefined : filter;
  }
  if ('all' in filter) {
    let changed = false;
    const kept = filter.all.filter((node) => {
      // Same family guard for a kind leaf nested in a top-level `all`: only drop a
      // feature-family-admitting kind leaf; keep an issue-only one so the `all` stays lane-safe.
      const isWidenableKindLeaf = isLeaf(node) && node.field === 'kind' && kindLeafWidensToFeatureFamily(node);
      if (isWidenableKindLeaf) changed = true;
      return !isWidenableKindLeaf;
    });
    if (!changed) return filter; // no widenable feature-family kind leaf inside this `all`
    if (kept.length === 0) return undefined;
    return kept.length === 1 ? kept[0] : { all: kept };
  }
  // `any` / `not` — leave unrewritten (see doc comment above).
  return filter;
}

/**
 * Tier-3 companion to {@link widenPastKind}: drop the `kind` leaves that admit ONLY
 * feature-family kinds, leaving the REST of the tree intact, so tier 3 can compile the
 * spec's real narrowings (title/paths/plan/tags/`not` legs) into the ISSUE-family claim
 * query without also carrying the feature-family `kind` constraint it is deliberately
 * widening past.
 *
 * Why this exists (the regression this fixes): threading the full compiled filter into
 * tier 3 (the line that re-unified the CLAIM path with the READ path — see
 * `getNextWorkItem`'s tier-3 block) ALSO carried leaves like `kind = 'feature'` into a
 * query over `harness_shared.work_items`, whose rows are all bug/change/task. That leaf can
 * never be true there, so the compiled filter was an unsatisfiable `FALSE` and tier 3 — the
 * ONLY tier that serves issue-family work — matched zero rows for every feature-narrowed
 * spec, silently re-breaking WI-1407's "feature family dry ⇒ fall through to an adjacent
 * open issue" contract (caught by its regression test).
 *
 * A kind leaf that admits an ISSUE kind (`kind in ['bug','change']`, `kind != 'feature'`,
 * a glob) is KEPT: there it is a genuine lane constraint, and compiling it is exactly the
 * narrowing tier 3 wants. It must NOT be delegated to `issueKindsForFallback` alone —
 * that extraction gives up (returns undefined ⇒ unrestricted) as soon as an `any`/`not`
 * appears anywhere in the tree, so a shape like `all[ kind in ['bug'], any[…] ]` would
 * lose the bug-only narrowing and let tier 3 claim a reserved task.
 *
 * Same conservative shapes as its siblings — a bare leaf, or a leaf directly inside a
 * top-level `all`. A `kind` leaf nested under `any`/`not` is left alone (dropping it would
 * change OR/NOT semantics); it stays compiled, which can only ever narrow, never over-serve.
 */
function stripFeatureOnlyKindLeaves(filter: FilterNode | undefined): FilterNode | undefined {
  const isFeatureOnlyKindLeaf = (node: FilterNode): boolean =>
    isLeaf(node) && node.field === 'kind' && kindLeafAdmitsNoIssueKind(node);

  if (!filter) return undefined;
  if (isLeaf(filter)) return isFeatureOnlyKindLeaf(filter) ? undefined : filter;
  if ('all' in filter) {
    const kept = filter.all.filter((node) => !isFeatureOnlyKindLeaf(node));
    if (kept.length === filter.all.length) return filter; // nothing dropped
    if (kept.length === 0) return undefined;
    return kept.length === 1 ? kept[0] : { all: kept };
  }
  // `any` / `not` — leave unrewritten (see doc comment above).
  return filter;
}

/**
 * True iff a `kind` leaf can admit NO issue-family kind at all — i.e. it is a purely
 * feature-family constraint, the one tier 3 widens past. Only the POSITIVE ops can rule
 * the issue family out; `!=` / glob / contains all still leave issue kinds in scope, so
 * they are (correctly) evaluated rather than dropped.
 */
function kindLeafAdmitsNoIssueKind(leaf: FilterLeaf): boolean {
  if (leaf.op !== '=' && leaf.op !== 'in') return false;
  const values = (Array.isArray(leaf.value) ? leaf.value : [leaf.value]).map(String);
  return values.every((v) => !ISSUE_KIND_SET.has(v));
}

/**
 * EI-7481: true iff a `kind` leaf admits at least one FEATURE-family kind — the only case
 * tier 2's "widen to the rest of the feature family" is meaningful. An issue-only kind
 * constraint (`kind='bug'`, `kind in ['bug','change']`, `kind='task'`) must NOT be widened
 * into the feature family; its lane is issues (the kind-preserving tier-3 fallback). `!=`
 * excludes one kind but still admits the rest of the feature family, so it stays widenable.
 */
function kindLeafWidensToFeatureFamily(leaf: FilterLeaf): boolean {
  const values = (Array.isArray(leaf.value) ? leaf.value : [leaf.value]).map(String);
  if (leaf.op === '=' || leaf.op === 'in') {
    return values.some((v) => familyOf(v) === 'feature');
  }
  // `!=` / glob / contains — a negative or fuzzy kind match still leaves feature-family kinds
  // in scope, so widening to the feature family remains the intended fallback.
  return true;
}

const ISSUE_KIND_SET = new Set<string>(ISSUE_FAMILY_KINDS);
type IssueFallbackKind = (typeof ISSUE_FAMILY_KINDS)[number];

function intersectIssueKinds(
  current: Set<IssueFallbackKind> | undefined,
  next: Iterable<IssueFallbackKind>,
): Set<IssueFallbackKind> {
  const incoming = new Set(next);
  if (!current) return incoming;
  return new Set([...current].filter((kind) => incoming.has(kind)));
}

/**
 * Tier-3 issue fallback normally preserves WI-1407's "feature-family dry ⇒ adjacent
 * issues" behavior. When a spec explicitly names issue-family kinds, however, that
 * is a real lane constraint and must survive the fallback, or a bug-only fleet can
 * claim a task (WI-2118's ping-pong shape).
 *
 * Conservatively inspect `all`/leaf filters only. OR/NOT filters can express more
 * complex set logic; leave those as the legacy unrestricted issue fallback rather
 * than narrowing incorrectly.
 */
function issueKindsForFallback(filter: FilterNode | undefined): readonly IssueFallbackKind[] | undefined {
  let allowed: Set<IssueFallbackKind> | undefined;
  let sawIssueKindConstraint = false;

  function applyLeaf(leaf: FilterLeaf): boolean {
    if (leaf.field !== 'kind') return true;
    const values = (Array.isArray(leaf.value) ? leaf.value : [leaf.value]).map(String);
    const issueValues = values.filter((v): v is IssueFallbackKind => ISSUE_KIND_SET.has(v));
    if (leaf.op === '=' || leaf.op === 'in') {
      if (issueValues.length > 0) {
        sawIssueKindConstraint = true;
        allowed = intersectIssueKinds(allowed, issueValues);
      }
      return true;
    }
    if (leaf.op === '!=') {
      if (issueValues.length > 0) {
        sawIssueKindConstraint = true;
        const base = allowed ?? new Set<IssueFallbackKind>(ISSUE_FAMILY_KINDS);
        for (const kind of issueValues) base.delete(kind);
        allowed = base;
      }
      return true;
    }
    return true;
  }

  function walk(node: FilterNode): boolean {
    if (isLeaf(node)) return applyLeaf(node);
    if ('all' in node) return node.all.every(walk);
    return false;
  }

  if (!filter || !walk(filter) || !sawIssueKindConstraint || !allowed) return undefined;
  return [...allowed];
}

/**
 * WI-5258/WI-5275 companion to tier 3's id handling above: extract the ids a `not`-wrapped id
 * leaf NEGATIVELY excludes — `{ not: { field:'id', op:'='|'in', value:[...] } }`, bare or
 * directly inside a top-level `all` (the same conservative bare/all-only shapes
 * {@link positiveIdCohortIds} and {@link issueKindsForFallback} handle; deeper nesting under
 * `any`/`not` is left alone rather than guessed at). Multiple such leaves union (excluding
 * from set A and set B excludes A∪B).
 *
 * The exclusion must be HONORED regardless of whether a positive id set was also extracted —
 * `claimNextIssueWorkItem` only ever received `issueKinds` + `ids` (the POSITIVE cohort), with
 * no way to see a negative exclusion, so without this a fleet's "already-handled, skip these"
 * ids came right back through the fallback (caught by this WI's own regression test before it
 * shipped: tier 3 claimed the excluded id, not the other open one). Threaded into
 * `claimNextIssueWorkItem`'s `excludeIds` opt.
 */
function negativeIdExclusions(filter: FilterNode | undefined): string[] {
  function idLeafValues(node: FilterNode): string[] | null {
    if (!isLeaf(node) || node.field !== 'id' || (node.op !== '=' && node.op !== 'in')) return null;
    const raw = Array.isArray(node.value) ? node.value : [node.value];
    return raw.map(String);
  }
  function notExclusion(node: FilterNode): string[] | null {
    if (isLeaf(node) || !('not' in node)) return null;
    return idLeafValues(node.not);
  }
  if (!filter) return [];
  const out = new Set<string>();
  const direct = notExclusion(filter);
  if (direct) {
    direct.forEach((v) => out.add(v));
  } else if (!isLeaf(filter) && 'all' in filter) {
    for (const node of filter.all) {
      const vals = notExclusion(node);
      if (vals) vals.forEach((v) => out.add(v));
    }
  }
  return [...out];
}

/**
 * Recursively compile the filter combinator tree to ONE parameterized `sql` fragment.
 * `all` ⇒ AND, `any` ⇒ OR, `not` ⇒ NOT; a leaf ⇒ {@link compileLeaf}. An undefined
 * filter ⇒ `TRUE` (the empty view — every floor-eligible item).
 */
export function compileFilter(sql: OrgSql, filter: FilterNode | undefined) {
  if (!filter) return sql`TRUE`;
  function walk(node: FilterNode): SqlFragment {
    if (isLeaf(node)) return compileLeaf(sql, node);
    if ('all' in node) {
      const parts = node.all.map(walk);
      return parts.reduce((acc, p) => sql`${acc} AND ${p}`);
    }
    if ('any' in node) {
      const parts = node.any.map(walk);
      // Parenthesize the OR so it binds correctly when ANDed into the floors.
      return parts.reduce((acc, p) => sql`(${acc} OR ${p})`);
    }
    // `not` — COALESCE to false BEFORE negating (EI-13306). SQL three-valued logic makes
    // a bare `NOT (...)` silently drop every row whose field is NULL: for a nullable column
    // (plan/assignee/risk_tier/...), `plan = 'x'` on a NULL row is NULL, and `NOT NULL` is
    // NULL — which a WHERE clause treats as not-TRUE, so the row VANISHES. That is the exact
    // inverse of what `not:` means to a spec author ("a row with no plan is certainly not in
    // plan X — admit it"), and it fails SILENT: the spec validates ok, and get_next reports an
    // honest-looking scoped miss while the whole backlog is invisible. It has starved this
    // fleet twice: `not:{plan glob 'p2p-*'}` and `not:{plan = '<slug>'}`, the latter measured
    // collapsing the claimable pool 2341 -> 4.
    //
    // COALESCE(inner, false) maps "unknown" to "did not match", so `not` then ADMITS the row.
    // This is also what the JS evaluator (claim-spec-match.ts `matchesClaimSpecFilter`) has
    // always done — `!matchLeaf(...)` on a null subject is `!false` = true. The two evaluators
    // of one spec language MUST agree; claim-spec-null-semantics.integration.test.ts pins that parity.
    return sql`NOT COALESCE((${walk(node.not)}), false)`;
  }
  return sql`(${walk(filter)})`;
}

/**
 * EI-13965 — the scoped-miss AGGREGATE floor breakdown for the common case
 * `explainIssueClaimFloors` cannot cover: a BROAD spec (a fleet member's plan/kind-scoped
 * view, no `id in [...]` clause to attribute per-id). Live incident (2026-07-17,
 * curation-signals fleet): a member drained its lane and reported "items visible in both
 * bound plans but none match the spec" — the leader took ~6 queries to discover the pool
 * was NOT empty, just stranded behind three DIFFERENT floors (claim-hold, taken-by-
 * outside-agents, plan-item-lane-guard release). A member with a broad spec has no named
 * ids for `explainIssueClaimFloors` to attribute, so it got nothing.
 *
 * ONE aggregate query: how many issue-family rows the caller's OWN `view.filter` selects
 * (`matchedByFilter`, via {@link compileFilter} — the SAME compiled fragment `get_next`'s
 * narrowing applies, so this can never disagree with what the spec would actually admit),
 * then — of the UNTAKEN subset — how many EACH floor independently would exclude (a row
 * can land in more than one bucket; this is "why is the pool stranded", not a partition).
 * Reuses the SAME exported floor predicates `diagnoseClaimNextMiss` /
 * `explainIssueClaimFloors` already evaluate — drift-proof by construction, never a
 * re-implementation that could disagree with the real claim.
 *
 * NOT covered: the plan-item-lane-guard's FINE-grained per-item check (a linked plan
 * item's own resolved status — blocked / cycle / terminal-residue) is deliberately a
 * POST-CLAIM, JS-side check over the plan's JSONB items index (see
 * scheduler/plan-item-lane-guard.ts's module doc) — not a cheap SQL predicate, so it
 * cannot be folded into this aggregate without either re-implementing it in SQL (a new
 * way to drift/lie) or paying a per-row plan-parse cost this "cheap, one aggregate query"
 * diagnosis is not meant to carry. `planLaneReserved` below only reflects the COARSER
 * floor (the linked plan is currently `active` at all) — a caller seeing zero excluded
 * here can still miss via that guard; the advice text says so.
 */
/**
 * Coverage of the path metadata consumed by the live affinity rank term. This is
 * deliberately measured over the POST-FLOOR claimable set, not `matchedByFilter`
 * or a LIMIT-capped row page: those populations do not describe the work the
 * scheduler can actually hand to an agent.
 *
 * A zero denominator is not a below-floor result. There is no claimable work whose
 * affinity input could be measured, so emitting a warning would turn an empty lane
 * into a false substrate alarm.
 */
export interface IssueClaimAffinityCoverage {
  /** The full claimable survivor count — the denominator for this measurement. */
  denominator: number;
  /** Claimable survivors whose `payload.paths` is a non-empty JSON array. */
  nonEmptyPaths: number;
  /** Minimum share of claimable survivors carrying paths for affinity to stay healthy. */
  floor: number;
  /** True only when a non-empty denominator falls strictly below {@link floor}. */
  belowFloor: boolean;
}

/** EI-16028: affinity is shipped, so its item-side input must not silently starve. */
export const AFFINITY_PATH_COVERAGE_FLOOR = 0.5;

/**
 * ONE floor descriptor — the unit of {@link ISSUE_CLAIM_FLOORS}, from which the claim bar,
 * the count SQL, the sample SQL, and both public result shapes are all DERIVED.
 */
export interface IssueClaimFloorSpec {
  /** The `ok_*` boolean decorated by {@link issueClaimCandidateSubquery}. */
  readonly ok: string;
  /** snake_case SQL alias — the count column, the sample column, and the raw row key. */
  readonly bucket: string;
  /** camelCase key in {@link IssueClaimExclusionBreakdown.excluded} and {@link IssueClaimExclusionSample}. */
  readonly field: string;
  /**
   * `ok_untaken` is the ONE floor that must not re-guard on itself. Every other bucket is
   * measured over the UNTAKEN subset only: a taken row is trivially excluded for that
   * reason alone, and counting it again under e.g. claimHold would double up and mislead.
   */
  readonly selfGuarded?: true;
}

/**
 * THE FLOOR REGISTRY — the single source every claim-floor bucket is DERIVED from.
 *
 * WHY THIS EXISTS (EI-22180177490969530). The floor PREDICATES never drifted: each `ok_*`
 * boolean is computed once, by the same exported helper the real claim path ANDs in. What
 * drifted was the BUCKET VOCABULARY — the list of names those booleans are REPORTED under.
 * It was restated by hand in five places (the claim bar, the count SELECT, the count row
 * type, the sample SELECT, the sample row type) plus the two public result shapes, and
 * adding a floor to the subquery without touching every one of them shipped a BUCKET-LESS
 * floor: no SQL error, no type error, no failing test — just a floor that excludes rows and
 * reports nothing. A reader then cannot distinguish "this floor excluded 2,000 rows" from
 * "this floor never ran", because both render as the same absence.
 *
 * NOT HYPOTHETICAL: `ok_watchdog_recovery` had shipped in the claim bar with NO count
 * bucket, NO sample bucket and NO field in {@link IssueClaimExclusionBreakdown} — found by
 * differencing the two hand-maintained lists while building this registry, after the same
 * class had already been patched instance-by-instance three times (EI-22172032354026579,
 * EI-22172757071586188, and EI-22180066397319908, which fixed `stop_line` by appending one
 * more hand-written line to the very list this replaces).
 *
 * THE PROPERTY THIS BUYS: a floor cannot be reported under a name absent from this list, and
 * cannot sit in this list without being reported. The SQL and the TypeScript result shapes
 * are both generated from these entries, so "add a floor, forget a bucket" is not an
 * omission caught later — it is unrepresentable.
 *
 * SAME PATTERN, ALREADY PROVEN IN-TREE: `claim-floor-classification.ts` derives its floor
 * vocabulary from the oracle's own `ISSUE_FLOOR_EXPLANATIONS` for a different consumer,
 * after three divergent hand-rolled copies had silently disagreed (WI-2141964).
 *
 * ADDING A FLOOR: decorate it `ok_<name>` in {@link issueClaimCandidateSubquery}, then add
 * ONE entry here. The claim bar, the counts, the samples and both public shapes follow.
 * `get-next-floor-registry.test.ts` and the live-column guard in
 * `get-next-exclusion-breakdown.integration.test.ts` fail until you do.
 *
 * ORDER is the AND/SELECT order only; it carries no semantics.
 */
export const ISSUE_CLAIM_FLOORS = [
  { ok: 'ok_untaken', bucket: 'taken', field: 'taken', selfGuarded: true },
  { ok: 'ok_claim_hold', bucket: 'claim_hold', field: 'claimHold' },
  // Strict owner capability: credential, physical device, or external-service action.
  { ok: 'ok_needs_owner_action', bucket: 'needs_owner_action', field: 'needsOwnerAction' },
  { ok: 'ok_agent_review', bucket: 'agent_review', field: 'agentReview' },
  { ok: 'ok_observation', bucket: 'observation_lane', field: 'observationLane' },
  { ok: 'ok_external_blocker', bucket: 'external_blocker', field: 'externalBlocker' },
  { ok: 'ok_plan_lane', bucket: 'plan_lane_reserved', field: 'planLaneReserved' },
  { ok: 'ok_federation', bucket: 'federation_detector', field: 'federationDetector' },
  { ok: 'ok_loop_noise', bucket: 'loop_noise', field: 'loopNoise' },
  { ok: 'ok_completed', bucket: 'already_completed', field: 'alreadyCompleted' },
  // EI-22180177490969530: the floor this registry was built to stop losing. It has been in
  // the claim bar since EI-20106946822538304 and, until now, in NO breakdown at all — an
  // eligible watchdog signal held in POOL was refused with the refusal reported nowhere.
  { ok: 'ok_watchdog_recovery', bucket: 'watchdog_recovery', field: 'watchdogRecovery' },
  { ok: 'ok_rig', bucket: 'cross_machine_rig', field: 'crossMachineRig' },
  { ok: 'ok_no_blocker', bucket: 'blocked_dep', field: 'blockedDep' },
  // BOTH caller-relative cooldown reasons, deliberately in ONE bucket (WI-5939): the row was
  // released by THIS caller inside the release window (mig 499), OR it was FILED BY SOMEONE
  // ELSE inside the filing-grace window, which holds a fresh filing for its filer so
  // file-then-fix cannot be raced. Both clear on their own with no action; a row you filed
  // yourself is never in the second leg. Knob: PAPERCUSP_FILING_GRACE_SEC (0 disables).
  { ok: 'ok_cooldown', bucket: 'cooldown', field: 'cooldown' },
  // WI-6409: a true-remote-origin row (federated in from a peer node, not authored by this
  // node — see isIssueLocallyClaimableWhereSql). The real claim path (claimNextIssueWorkItem)
  // and the READY miss-diagnosis have enforced this floor since work-item-status-full-unify
  // (2026-07-20); this oracle did not apply it at all until WI-6409, so it OVER-COUNTED
  // `claimable` by every untaken remote row — the confirmed root cause of the recurring
  // "claim-path/read-path divergence" class (EI-10062/WI-4309/WI-5275/WI-5822/WI-6409): the
  // oracle reported N survivors while `scheduler:get_next` claimed 0, because N of them were
  // remote-origin and only the real claim path refused them.
  { ok: 'ok_origin', bucket: 'remote_origin', field: 'remoteOrigin' },
  // Born-pending duplicate screening has not yet been adjudicated.
  { ok: 'ok_admission', bucket: 'admission_pending', field: 'admissionPending' },
  // EI-22685972259555805: gate-red-streak:/green-stall: condition singletons are
  // exclusive LIVE_GATE_OPS work. They remain directly claimable by id, but never
  // circulate through a generic fleet's opportunistic self-select.
  { ok: 'ok_live_gate_ops', bucket: 'live_gate_ops', field: 'liveGateOps' },
  // P-013/D-012 stop-the-line: the harness's gate-red-streak condition item has been open
  // >24h, and the row is neither a bug nor an alarm-condition item. Non-zero here is a
  // VERDICT ("the line is stopped"), never a drained lane — see stopTheLineExclusionSql /
  // stopTheLineExplanation (work-items-admission).
  { ok: 'ok_stop_line', bucket: 'stop_line', field: 'stopTheLine' },
] as const satisfies readonly IssueClaimFloorSpec[];

type IssueClaimFloorField = (typeof ISSUE_CLAIM_FLOORS)[number]['field'];
type IssueClaimFloorBucket = (typeof ISSUE_CLAIM_FLOORS)[number]['bucket'];

/** Per-floor exclusion COUNTS, one key per {@link ISSUE_CLAIM_FLOORS} entry. Every key is
 *  always present: a floor that excluded nothing reports 0, which is a MEASUREMENT — never
 *  the absence that used to be indistinguishable from "the floor never ran". */
export type IssueClaimExclusionCounts = { [K in IssueClaimFloorField]: number };

/** Per-floor exclusion SAMPLES, one key per {@link ISSUE_CLAIM_FLOORS} entry. Same
 *  always-present rule as {@link IssueClaimExclusionCounts}: an empty array is a measurement. */
export type IssueClaimExclusionSampleBuckets = { [K in IssueClaimFloorField]: string[] };

/** Raw SQL row shapes for the derived bucket columns (snake_case, as Postgres returns them). */
type IssueClaimExclusionCountRow = { [K in IssueClaimFloorBucket]: number };
type IssueClaimExclusionSampleRow = { [K in IssueClaimFloorBucket]: string[] };

/** The per-floor `WHERE` guard prefix for a bucket — see {@link IssueClaimFloorSpec.selfGuarded}.
 *  Shared by the counts and the samples so the two populations can never disagree. */
export function issueClaimFloorBucketGuard(floor: IssueClaimFloorSpec): string {
  return floor.selfGuarded ? '' : 'ok_untaken AND ';
}

/** The count SELECT list, derived from {@link ISSUE_CLAIM_FLOORS}. Pure column identifiers
 *  and literal keywords, no bound values — so `sql.unsafe` is safe here for the same reason
 *  it is safe for {@link ALL_ISSUE_CLAIM_FLOORS_PASS}. Exported for the derivation guard. */
export const ISSUE_CLAIM_EXCLUSION_COUNT_SELECT_SQL = ISSUE_CLAIM_FLOORS.map(
  (f) => `count(*) FILTER (WHERE spec_match AND ${issueClaimFloorBucketGuard(f)}NOT ${f.ok})::int AS ${f.bucket}`,
).join(',\n      ');

/**
 * Which registry floors are NOT reported by a given emitted SELECT list — the derivation
 * guard's one predicate, exported so the guard TEST can exercise it against a deliberately
 * broken input as well as the real one.
 *
 * ⚠ IT MUST FAIL LOUD ON A MIS-SCOPED INSTRUMENT, not quietly pass. An empty or wrong-relation
 * `selectSql` reports EVERY floor as bucket-less rather than none — because "I measured
 * nothing" and "I measured everything and found nothing wrong" are the exact pair this whole
 * work-item exists to stop being the same value. The guard test pins both directions.
 */
export function findBucketlessFloors(floors: readonly IssueClaimFloorSpec[], selectSql: string): string[] {
  return floors
    .filter((f) => !(selectSql.includes(`NOT ${f.ok}`) && new RegExp(`\\bAS\\s+${f.bucket}\\b`).test(selectSql)))
    .map((f) => f.ok);
}

/** Project a raw count row onto the public camelCase shape — one key per registry floor,
 *  always present, 0 when the column is absent from the row. */
export function mapIssueClaimExclusionCounts(
  row: Partial<IssueClaimExclusionCountRow> | undefined,
): IssueClaimExclusionCounts {
  const out: Record<string, number> = {};
  for (const f of ISSUE_CLAIM_FLOORS) out[f.field] = row?.[f.bucket] ?? 0;
  return out as IssueClaimExclusionCounts;
}

/** Sample-side twin of {@link mapIssueClaimExclusionCounts}. */
export function mapIssueClaimExclusionSamples(
  row: Partial<IssueClaimExclusionSampleRow> | undefined,
): IssueClaimExclusionSampleBuckets {
  const out: Record<string, string[]> = {};
  for (const f of ISSUE_CLAIM_FLOORS) out[f.field] = row?.[f.bucket] ?? [];
  return out as IssueClaimExclusionSampleBuckets;
}

export interface IssueClaimExclusionBreakdown {
  /** Issue-family rows (claimable status, this harness/workspace) the spec's OWN
   *  view.filter matches — BEFORE taken/floors. 0 here means the spec itself is the
   *  problem (a kind/plan/tag scoping that matches nothing), not a floor. */
  matchedByFilter: number;
  /** Of matchedByFilter, how many survive spec_match AND EVERY floor — the count a
   *  self-selecting caller would actually see as claimable RIGHT NOW (identical to
   *  {@link listIssueClaimableRows}' total before its LIMIT). NOT `matched − Σexcluded`:
   *  the `excluded` buckets OVERLAP (a row can be counted under several floors at once),
   *  so this is a DISTINCT additive count of rows passing every predicate, computed by the
   *  SAME inner subquery. This is the ONE number the whole claimability-clarity plan makes
   *  trustworthy — the `0 claimable` a wind-down / drain decision hinges on. */
  claimable: number;
  /** EI-16028: machine-readable coverage guard for the live affinity rank input. */
  affinityCoverage: IssueClaimAffinityCoverage;
  /** Of matchedByFilter, counts of why each is NOT self-selectable right now. Every
   *  floor after `taken` is counted only among the UNTAKEN subset (a taken row is
   *  trivially excluded for that reason alone — counting it again under e.g. claimHold
   *  would double up and mislead). Buckets are INDEPENDENT, not a partition: a row can
   *  be counted under more than one floor.
   *
   *  DERIVED from {@link ISSUE_CLAIM_FLOORS} — one key per floor, every key always
   *  present. Per-floor prose lives on the registry entries, beside the floor itself,
   *  rather than in a parallel list that can fall behind it. */
  excluded: IssueClaimExclusionCounts;
  /** Independent queue-control axes over the spec-matched population. These counts
   * deliberately overlap: one row may be actively claimed, lease-held, durably
   * parked, and awaiting agent review at the same instant. The legacy
   * excluded.claimHold/agentReview totals remain unchanged for compatibility. */
  queueControl: {
    activeClaims: number;
    rawClaimHolds: number;
    holdOpenLeases: number;
    durableParks: number;
    unattributedClaimHolds: number;
    pendingAgentReview: number;
    revisionRequestedAgentReview: number;
  };
}

/** The AND of every per-row claim-floor predicate (the `ok_*` booleans decorated by
 *  {@link issueClaimCandidateSubquery}). A row for which this holds AND `spec_match` is
 *  claimable RIGHT NOW. Defined ONCE so the survivors COUNT
 *  ({@link aggregateIssueClaimExclusions}'s `claimable`) and the survivors ROW LIST
 *  ({@link listIssueClaimableRows}) apply the byte-identical bar — add/remove a floor and
 *  both move together. Pure column identifiers, no bound values, so `sql.unsafe` is safe.
 *
 *  SCOPE OF THAT GUARANTEE (WI-5947): identical-bar is a SEMANTIC guarantee, per snapshot.
 *  It does NOT make two separate round-trips atomic — against a concurrently-mutating table
 *  they observe different snapshots and legitimately disagree. Callers that present the
 *  count and the list together as one verdict MUST read them through
 *  {@link readIssueClaimability}, which puts them in one REPEATABLE READ transaction.
 *
 *  ⚠ WHAT THIS CONSTANT STILL DOES NOT GET FOR FREE (EI-20091339613996367). The floor LOGIC
 *  cannot drift — every `ok_*` boolean is computed by the same exported helper the claim path
 *  enforces. The SET used to be hand-maintained here, and a floor decorated by
 *  {@link issueClaimCandidateSubquery} but never ANDed in was computed for every candidate row
 *  and then silently IGNORED, so the count and the row list over-admitted while every per-floor
 *  test still passed. That half is now DERIVED from {@link ISSUE_CLAIM_FLOORS}, so this bar and
 *  the exclusion buckets cannot disagree with each other. What is STILL not free is the tie back
 *  to the subquery: a floor decorated there and never added to the registry remains invisible to
 *  both. Nothing about that failure is loud — no SQL error, no type error, and the seeded-row
 *  agreement tests only catch drift their fixtures happen to exercise, which a newly-added floor
 *  by definition has none of.
 *
 *  Exported for exactly one reason: `get-next-exclusion-breakdown.integration.test.ts`
 *  ("the claimability bar applies EVERY floor the candidate subquery computes") asserts this
 *  set equals the `ok_*` columns the subquery actually returns, read from live result-column
 *  METADATA rather than from source text — so a floor added to the subquery and forgotten
 *  fails immediately instead of silently widening the queue. That test is what pins the
 *  registry to the real columns. Add a floor to the subquery ⇒ add it to
 *  {@link ISSUE_CLAIM_FLOORS}. */
export const ALL_ISSUE_CLAIM_FLOORS_PASS = ISSUE_CLAIM_FLOORS.map((f) => f.ok).join(' AND ');

/**
 * The SHARED inner subquery for issue-family claimability: every candidate issue-family
 * row for the harness/workspace/states, decorated with `spec_match` + one `ok_<floor>`
 * boolean per claim floor — each computed by the SAME exported floor-predicate helper the
 * real claim path (`claimNextIssueWorkItem`) enforces. Both
 * {@link aggregateIssueClaimExclusions} (which COUNTs the booleans) and
 * {@link listIssueClaimableRows} (which SELECTs the rows passing {@link ALL_ISSUE_CLAIM_FLOORS_PASS})
 * wrap this ONE fragment, so the survivors count and the row list can never disagree with
 * each other or with the floors — a second SQL copy is exactly the drift
 * work-item-claimability-clarity removes. Projects `wi.*` so any consumer (a rank ORDER BY,
 * a row projection) can reference any base column; the aggregate wrapper ignores the extra
 * columns (a pure `count(*)` is unaffected).
 *
 * `filterPushdown` bounds single-spec aggregates and `readIssueClaimability`'s snapshot
 * materialization. When present, the compiled filter is applied in this subquery's base
 * `WHERE`, and `spec_match` is the literal `TRUE` because every materialized row already
 * passed that filter. Other callers deliberately omit it so they can retain a broader
 * candidate population (notably `readClaimSpecDelta`, which must cover both sides).
 */
export function issueClaimCandidateSubquery(
  sql: OrgSql,
  args: {
    compiled: SqlFragment;
    assignee: string;
    cooldown: number;
    harness: string;
    states: readonly string[];
    issueWs: string;
    operatorScopeSlug: string;
    rigAvailable?: boolean;
    claimantFleetSlug?: string;
    claimSpecReferencesFleet?: boolean;
    /** EI-21398324268952860: the spec structurally names `goal` and may adopt that plan lane. */
    claimSpecReferencesGoal?: boolean;
    /** Apply this compiled filter while materializing candidates instead of projecting it
     *  as `spec_match`; single-spec aggregates and snapshots can share this pushdown. */
    filterPushdown?: SqlFragment;
    /** Keep the shared snapshot narrow: the base table has 80+ columns (including large
     *  summary/search/embedding fields), while the sibling claimability reads consume only
     *  identity, rank, row projection, and sampling columns. Standalone/delta callers retain
     *  the full projection because they may wrap this fragment with broader consumers. */
    projection?: 'full' | 'claimability-snapshot';
  },
): SqlFragment {
  const {
    compiled,
    assignee,
    cooldown,
    harness,
    states,
    issueWs,
    operatorScopeSlug,
    rigAvailable,
    claimantFleetSlug,
    claimSpecReferencesFleet,
    claimSpecReferencesGoal,
    filterPushdown,
    projection = 'full',
  } = args;
  const baseColumns =
    projection === 'claimability-snapshot'
      ? sql`
          wi.workspace_id,
          wi.harness_slug,
          wi.feature_id,
          wi.title,
          wi.status,
          wi.kind,
          wi.item_kind,
          wi.created_ts,
          wi.updated_ts,
          wi.taken_by,
          wi.taken_at,
          wi.author_pubkey,
          wi.admission,
          wi.terminal_owner,
          wi.terminal_completion_ref,
          wi.authority,
          wi.last_released_by,
          wi.last_released_at,
          wi.source_plan_slug,
          wi.source_plan_item_ids,
          wi.feature_order,
          wi.origin,
          wi.payload,
          -- WI-524804: 'lane' is a STORED generated column (migration 721 / WI-6934) that the
          -- observation-lane floor reads INSTEAD of detoasting payload. It must be projected
          -- here because on the filterPushdown path the outer SELECT's FROM-source is the
          -- 'filtered_claim_candidates wi' CTE, not the base table -- so a column this
          -- projection omits genuinely does not exist for ok_observation below, and the
          -- failure is silent (no type error, and ONLY on the pushdown path). Dropping it is
          -- what produced "column wi.lane does not exist" in EI-21580597231511770, which was
          -- then misdiagnosed as "the generated column was removed" and repaired by reverting
          -- the floor to the slow payload form. The column was never removed. Any floor column
          -- added below must be projected here too -- asserted by
          -- claimability-snapshot-projection-covers-floors.test.ts.
          wi.lane,
          -- P-013/D-012: the stop-the-line floor's exemption leg reads condition_key
          -- (alarm-condition items stay claimable while the line is stopped). Same
          -- pushdown-path rule as wi.lane above: a floor column not projected here
          -- genuinely does not exist for the ok_* expression on the filterPushdown
          -- path, and the failure is silent — asserted by
          -- claimability-snapshot-projection-covers-floors.test.ts.
          wi.condition_key,
          wi.goal_id,
          wi.expected_cost_cents,
          wi.tags,
          wi.redundancy
        `
      : sql`wi.*`;

  // A pushed-down filter is an execution-order contract, not just a logical
  // simplification. Without a materialization barrier PostgreSQL is free to
  // inline the filtered relation and evaluate the correlated claim-floor
  // expressions while scanning the whole issue-family table (the exact fleet
  // read measured ~13s in work_item_claim_floors_v14 before this barrier). The
  // single-spec readers use a narrow projection to keep this intermediate
  // relation cheap to materialize.
  // Keep broad/non-pushed callers unchanged: delta reads need a population wide
  // enough to cover both filters, and unfiltered callers retain their existing
  // SQL shape.
  const baseWhere = sql`
    wi.item_kind IN ('bug', 'change', 'task')
    AND wi.workspace_id = ${issueWs}
    AND (wi.harness_slug = ${harness} OR wi.harness_slug = ${operatorScopeSlug})
    AND wi.status = ANY(${states as string[]}::text[])
  `;
  const pushedSource = filterPushdown
    ? sql`
        WITH filtered_claim_candidates AS MATERIALIZED (
          SELECT ${baseColumns}
          FROM harness_shared.work_items wi
          WHERE ${baseWhere}
            AND (${filterPushdown})
        )
      `
    : sql``;
  const source = filterPushdown ? sql`filtered_claim_candidates wi` : sql`harness_shared.work_items wi`;
  // Non-pushed callers intentionally retain the broad population: their outer
  // predicates may need to compare the current and proposed filters (delta
  // reads), so `compiled` stays a projected `spec_match` there.
  const where = filterPushdown ? sql`` : sql`WHERE ${baseWhere}`;
  return sql`
    ${pushedSource}
    SELECT
      ${baseColumns},
      (${filterPushdown ? sql`TRUE` : compiled})                       AS spec_match,
      (wi.taken_by IS NULL OR wi.taken_by = '')                         AS ok_untaken,
      (${claimHoldExclusionSql(sql)})                                   AS ok_claim_hold,
      (${needsOwnerActionExclusionSql(sql)})                             AS ok_needs_owner_action,
      (${agentReviewNormalExclusionSql(sql)})                            AS ok_agent_review,
      (${observationLaneExclusionSql(sql)})                             AS ok_observation,
      (${externalBlockersExclusionSql(sql)})                            AS ok_external_blocker,
      (${reservedPlanLaneExclusionSql(sql, assignee, 'wi.payload', {
        claimantFleetSlug,
        claimSpecReferencesFleet,
        claimSpecReferencesGoal,
      })})                                                             AS ok_plan_lane,
      (${federationDetectorExclusionSql(sql)})                          AS ok_federation,
      (${loopIterationNoiseExclusionSql(sql)})                          AS ok_loop_noise,
      (${alreadyTerminallyCompletedExclusionSql(sql)})                  AS ok_completed,
      -- EI-20106946822538304: an eligible watchdog signal remains in POOL while the
      -- auto-close sweep gathers its six-ran-tick recovery window, but is not READY
      -- until that window has been evaluated and the signal is still present.
      (${watchdogRecoveryWindowExclusionSql(sql)})                      AS ok_watchdog_recovery,
      (${crossMachineRigExclusionSql(sql, rigAvailable)})               AS ok_rig,
      -- WI-6409: mirror claimNextIssueWorkItem's own-node-aware origin floor (local OR our
      -- own author key) — previously absent from this shared subquery entirely, so a
      -- true-remote-origin row read as claimable here while the real claim refused it.
      (${isIssueLocallyClaimableWhereSql(sql, issueWs)})                AS ok_origin,
      (${admittedWhereSqlWi(sql)})                                      AS ok_admission,
      (${liveGateOpsSelfSelectExclusionSql(sql)})                       AS ok_live_gate_ops,
      -- D-007: was the ONLY floor here that did not call a shared helper, and it drifted —
      -- it kept bi.workspace_id = 'default' (the hardcode migration 719 removed from every
      -- other reader) and left the feature leg unscoped entirely, while the real claim path
      -- scoped both legs to the blocked row's own workspace. Measured live: across the 10 open
      -- issue-family papercusp-workspace items carrying an edge, this copy reported 0 blocked
      -- against the claim path's 5 — so work_items:claimable advertised 5 items the claim door
      -- refuses, burning an agent wake each. Now the SAME fragment claimNextIssueWorkItem
      -- enforces, so the preview and the claim can no longer disagree.
      (${depsBlockedExclusionSql(sql)})                                 AS ok_no_blocker,
      -- Mig 499 + WI-5939: the per-claim cooldown floor — the SAME exported fragment
      -- claimNextIssueWorkItem enforces, so this preview and the real claim door cannot
      -- disagree. It covers BOTH caller-relative reasons (released-by-me, and filed-by-someone-
      -- else inside the filing-grace window); an exclusion for either reports here, under the
      -- one cooldown breakdown bucket, per WI-5939 "do not add a parallel mechanism".
      (${issueCooldownExclusionSql(sql, assignee, cooldown)})            AS ok_cooldown,
      -- P-013/D-012 stop-the-line: while the harness's gate-red-streak condition item has
      -- been open >24h, non-repair rows are not self-selectable (bugs + alarm-condition
      -- items exempt; by-id claims bypass floors by design). Same shared-fragment
      -- contract as every floor above: claimNextIssueWorkItem enforces the identical
      -- predicate via ALL_ISSUE_CLAIM_FLOORS_PASS, so preview and claim cannot disagree.
      (${stopTheLineExclusionSql(sql, 'issue-wi')})                      AS ok_stop_line
    FROM ${source}
    ${where}
  `;
}

/**
 * EI-18802055183255275: the FROM-source for every one of the claimability reads below.
 * By default this re-derives {@link issueClaimCandidateSubquery} inline (unchanged
 * behavior for a standalone caller). When `precomputedTable` is set (readIssueClaimability's
 * shared-snapshot path), it instead points at an ALREADY-MATERIALIZED temp table — so the
 * (expensive: ~60-predicate spec filter × 13 floor predicates, over the whole issue-family
 * population) candidate computation runs ONCE per call to readIssueClaimability instead of
 * once per sibling read (previously 2-4x redundant full scans SERIALIZED in one transaction,
 * which is what made a wide `any`-filter spec like `p2p-release` (63 predicates) exceed the
 * per-statement timeout on `work_items:claimable` — see the bug this fixes for the measured
 * costs). `sub` is unused when precomputed; callers still build it (harmless — postgres-js
 * fragment construction has no DB round-trip) so the call sites below stay uniform.
 */
function candidateFromSource(sql: OrgSql, sub: SqlFragment, precomputedTable?: string): SqlFragment {
  return precomputedTable ? sql`(SELECT * FROM ${sql.unsafe(precomputedTable)})` : sql`(${sub})`;
}

async function aggregateIssueClaimExclusionsOn(
  filter: FilterNode | undefined,
  opts: {
    harness: string;
    /** An already-resolved active workspace to survive async request-scope loss. */
    workspaceId?: string;
    states?: readonly string[];
    assignee?: string;
    rigAvailable?: boolean;
    claimantFleetSlug?: string;
    claimSpecReferencesFleet?: boolean;
    /** EI-21398324268952860: the spec structurally names `goal` and may adopt that plan lane. */
    claimSpecReferencesGoal?: boolean;
    /** Run on this handle instead of a fresh pool checkout — pass the `tx` from
     *  {@link readIssueClaimability} to share ONE snapshot with the sibling reads. */
    client?: OrgSql;
    /** EI-18802055183255275: read from this already-materialized temp table (built once by
     *  {@link readIssueClaimability}) instead of recomputing the candidate subquery. Internal —
     *  only readIssueClaimability passes this; a standalone caller omits it unchanged. */
    precomputedTable?: string;
    /** WI-525554: set ONLY when `precomputedTable` was materialized with the observation-lane
     *  floor pushed into its base WHERE, so the observation rows are ABSENT from the population
     *  these aggregates scan. Both numbers are then measured by the caller against the FULL
     *  candidate population and substituted here, because they are the two figures consumers
     *  read as totals rather than as diagnostics:
     *    - `matchedByFilter` is documented as "the filter matched, BEFORE taken/floors", and
     *      plan-admission-preflight.ts asserts `matchedByFilter > 0 => some excluded bucket > 0`.
     *      Letting it report the post-lane-filter population would both break that invariant and
     *      turn "40 rows matched, all of them observations" into a false "your filter matched 0".
     *    - `observationLane` would otherwise be a structural ZERO — the count of a floor whose
     *      rows were removed before counting — which is the "true diagnostic into a lie" failure
     *      WI-521425 named. A zeroed bucket is indistinguishable from "no observations here".
     *  Every OTHER bucket is deliberately left scoped to the non-observation population: those
     *  are per-floor diagnostics answering "why can't I claim", and an observation row is already
     *  unclaimable for a reason that has its own bucket. */
    laneScopedPopulation?: { matchedByFilter: number; observationLane: number };
    /** Server-side per-statement cap applied by the exported wrapper on the STANDALONE
     *  (no `client`) path only. Ignored when `client` is injected, because that caller's
     *  transaction already carries its own `SET LOCAL statement_timeout`. */
    statementTimeoutMs?: number;
  },
): Promise<IssueClaimExclusionBreakdown> {
  const sql = opts.client ?? getOrgPg().sql;
  const states = [...(opts.states ?? ISSUE_FAMILY_CLAIMABLE_STATES)];
  // Mirror diagnoseClaimNextMiss's own resolution — the issue-family scope workspace,
  // never the caller's harness-scoped workspaceId (they can legitimately differ).
  const issueWs = resolveIssuesScopeWorkspace(opts.workspaceId);
  const operatorScopeSlug = `operator:${issueWs}`;
  const assignee = opts.assignee ?? '';
  const compiled = compileFilter(sql, filter);
  const cooldown = releaseCooldownSec();
  const sub = issueClaimCandidateSubquery(sql, {
    compiled,
    // Every aggregate below counts only spec_match rows. Materialize that same
    // population before evaluating correlated claim floors, as the snapshot
    // reader already does. Otherwise an exact-plan launch can time out while
    // evaluating floors for unrelated issues. Do not push down any claim floor:
    // matched and exclusion counters must still include every matching row.
    ...(filter ? { filterPushdown: compiled, projection: 'claimability-snapshot' as const } : {}),
    assignee,
    cooldown,
    harness: opts.harness,
    states,
    issueWs,
    operatorScopeSlug,
    rigAvailable: opts.rigAvailable,
    claimantFleetSlug: opts.claimantFleetSlug,
    claimSpecReferencesFleet: opts.claimSpecReferencesFleet,
    claimSpecReferencesGoal: opts.claimSpecReferencesGoal,
  });

  const rows = (await sql`
    SELECT
      count(*) FILTER (WHERE spec_match)::int                                         AS matched,
      count(*) FILTER (WHERE spec_match AND ${sql.unsafe(ALL_ISSUE_CLAIM_FLOORS_PASS)})::int AS claimable,
      count(*) FILTER (
        WHERE spec_match
          AND ${sql.unsafe(ALL_ISSUE_CLAIM_FLOORS_PASS)}
          AND jsonb_array_length(
            CASE
              WHEN jsonb_typeof(payload->'paths') = 'array' THEN payload->'paths'
              ELSE '[]'::jsonb
            END
          ) > 0
      )::int AS claimable_with_paths,
      ${sql.unsafe(ISSUE_CLAIM_EXCLUSION_COUNT_SELECT_SQL)},
      count(*) FILTER (
        WHERE spec_match AND NOT ok_claim_hold
          AND NULLIF(BTRIM(COALESCE(payload ->> 'held_open_by', '')), '') IS NOT NULL
      )::int AS hold_open_leases,
      count(*) FILTER (
        WHERE spec_match AND NOT ok_claim_hold
          AND NULLIF(BTRIM(COALESCE(payload ->> 'claim_hold_by', '')), '') IS NOT NULL
      )::int AS durable_parks,
      count(*) FILTER (
        WHERE spec_match AND NOT ok_claim_hold
          AND NULLIF(BTRIM(COALESCE(payload ->> 'held_open_by', '')), '') IS NULL
          AND NULLIF(BTRIM(COALESCE(payload ->> 'claim_hold_by', '')), '') IS NULL
      )::int AS unattributed_claim_holds,
      count(*) FILTER (
        WHERE spec_match AND payload -> 'agentReview' ->> 'status' = 'pending'
      )::int AS pending_agent_review,
      count(*) FILTER (
        WHERE spec_match AND payload -> 'agentReview' ->> 'status' = 'revision-requested'
      )::int AS revision_requested_agent_review
    FROM ${candidateFromSource(sql, sub, opts.precomputedTable)} sub
  `) as Array<
    IssueClaimExclusionCountRow & {
      matched: number;
      claimable: number;
      claimable_with_paths: number;
      hold_open_leases: number;
      durable_parks: number;
      unattributed_claim_holds: number;
      pending_agent_review: number;
      revision_requested_agent_review: number;
    }
  >;
  const r = rows[0];
  const claimable = r?.claimable ?? 0;
  const nonEmptyPaths = r?.claimable_with_paths ?? 0;
  return {
    // WI-525554: see `laneScopedPopulation` — when the scanned population had the observation
    // lane filtered out during materialization, these two come from the caller's full-population
    // counts. `?? ` is wrong here: 0 is a legitimate measured value, so test for presence.
    matchedByFilter: opts.laneScopedPopulation ? opts.laneScopedPopulation.matchedByFilter : (r?.matched ?? 0),
    claimable,
    affinityCoverage: {
      denominator: claimable,
      nonEmptyPaths,
      floor: AFFINITY_PATH_COVERAGE_FLOOR,
      belowFloor: claimable > 0 && nonEmptyPaths / claimable < AFFINITY_PATH_COVERAGE_FLOOR,
    },
    // DERIVED from ISSUE_CLAIM_FLOORS — every floor gets a key, so a new floor cannot ship
    // reporting nothing. The observation-lane substitution is the ONE documented override
    // (see `laneScopedPopulation` above): that bucket alone is measured by the caller
    // against the full candidate population, because a structural zero there is the
    // "true diagnostic into a lie" failure WI-521425 named.
    excluded: {
      ...mapIssueClaimExclusionCounts(r),
      ...(opts.laneScopedPopulation ? { observationLane: opts.laneScopedPopulation.observationLane } : {}),
    },
    queueControl: {
      activeClaims: r?.taken ?? 0,
      rawClaimHolds: r?.claim_hold ?? 0,
      holdOpenLeases: r?.hold_open_leases ?? 0,
      durableParks: r?.durable_parks ?? 0,
      unattributedClaimHolds: r?.unattributed_claim_holds ?? 0,
      pendingAgentReview: r?.pending_agent_review ?? 0,
      revisionRequestedAgentReview: r?.revision_requested_agent_review ?? 0,
    },
  };
}

/**
 * Default server-side cap for a STANDALONE aggregateIssueClaimExclusions call. Matches
 * {@link readIssueClaimability}'s own default for the SAME query family, so the bounded and
 * standalone paths cannot drift into two different ideas of "too slow".
 */
const AGGREGATE_EXCLUSIONS_DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;

/**
 * EI-21863190622583520 — aggregateIssueClaimExclusions is the most expensive query family in
 * this system (independently measured in EI-21336921007507524), and until this wrapper existed
 * every STANDALONE caller ran it with NO server-side bound at all: the inner function takes a
 * bare pool checkout, and `adminPoolStatementTimeoutMs` is a connect-time GUC that only NEW
 * connections carry. MEASURED 2026-08-30 on the live box, load 138/128 cores: one
 * `pcusp:org-admin` backend ran this exact aggregate for >=180s (sampled at 93.6s -> 113.8s ->
 * 180.5s on one monotonic query_start), and two more org-admin backends sat at 161.3s / 112.5s
 * on connections 40.2 / 32.5 minutes old.
 *
 * WHY IT WENT UNNOTICED — and why a caller-side bound was never enough: the get_next miss path
 * wraps this call in `withBoundedTimeout(..., 1_500ms)`, but that bounds only the CALLER.
 * bounded-timeout.ts's own docstring says the query "still runs to completion in the background
 * even after a timeout degrades the caller" (WI-7099 filed that defect separately). So the
 * busiest call site fires the system's most expensive read on EVERY get_next miss, abandons it
 * after 1.5s, and leaves it burning a core and holding a pooled connection for minutes. The
 * caller sees a tidy fallback; the database sees unbounded work.
 *
 * The bound therefore has to live server-side, which is what this wrapper adds. Injecting a
 * `client` still opts out, because that path (readIssueClaimability) is already inside its own
 * bounded transaction and shares one snapshot + temp table with its sibling reads — opening a
 * second transaction there would break both properties.
 *
 * SAFE BY CONSTRUCTION: all three standalone callers already degrade on failure —
 * fleet-scope-admission and drain-stamp `catch { return null }`, lane-health `catch`es, and the
 * get_next miss path takes `withBoundedTimeout`'s fallback (it catches rejections, not just its
 * own timer). So a cap converts wasted DB work into the null these callers already handle.
 */
export async function aggregateIssueClaimExclusions(
  filter: FilterNode | undefined,
  opts: Parameters<typeof aggregateIssueClaimExclusionsOn>[1],
): Promise<IssueClaimExclusionBreakdown> {
  if (opts.client) return aggregateIssueClaimExclusionsOn(filter, opts);
  return boundedOrgTxn((tx) => aggregateIssueClaimExclusionsOn(filter, { ...opts, client: tx }), {
    statementTimeoutMs: Math.max(
      100,
      Math.trunc(opts.statementTimeoutMs ?? AGGREGATE_EXCLUSIONS_DEFAULT_STATEMENT_TIMEOUT_MS),
    ),
  });
}

/** Bounded per-floor SAMPLE of excluded row ids — the companion read to
 *  {@link aggregateIssueClaimExclusions}'s counts. Each array is capped at the caller's
 *  `sampleLimit`; buckets OVERLAP exactly like the counts (a row can appear in more than
 *  one floor's sample). `taken` samples rows failing `ok_untaken` alone (mirrors how the
 *  counts treat it); every other bucket samples the UNTAKEN subset, same as the counts. */
export interface IssueClaimExclusionSample extends IssueClaimExclusionSampleBuckets {
  queueControl: IssueQueueControlSample;
}

export interface IssueQueueControlSample {
  activeClaims: Array<{ id: string; owner: string; claimedAt: string | null }>;
  holdOpenLeases: Array<{
    id: string;
    holder: string;
    reason: string | null;
    heldAt: string | null;
    age: AuditAge;
  }>;
  durableParks: Array<{
    id: string;
    parker: string | null;
    reason: string | null;
    parkedAt: string | null;
    age: AuditAge;
    unparkCondition: { status: UnparkConditionStatus; text: string | null };
    releaseLiveness: DurableParkReleaseLiveness;
  }>;
  agentReview: Array<{
    id: string;
    status: 'pending' | 'revision-requested' | 'approved';
    submittedBy: string;
    ledgerIdeaId: string;
    round: number;
  }>;
}

/**
 * Bounded per-floor sample of excluded row IDS — answers "which items, not just how many"
 * without a hand-rolled raw-SQL query against `harness_shared.work_items` (a query that
 * silently returns 0 rows if it filters the table's legacy free-text `kind` column —
 * feature sub-category, e.g. infra/security — instead of the real family discriminator
 * `item_kind`; EI-18682848605075155). Wraps the SAME {@link issueClaimCandidateSubquery} +
 * floor predicates {@link aggregateIssueClaimExclusions} counts, materialized ONCE via a
 * `WITH` CTE and sampled per floor, so a sampled id applies the identical bar to what the
 * counts call excluded.
 * READ-ONLY, no claim side-effect — this is purely a diagnostic companion to the counts.
 *
 * ⚠ THIS DOCSTRING USED TO PROMISE SAFETY IT DID NOT HAVE (EI-22180177490969530). It said
 * "adding/removing a floor there automatically applies here too" — true of the `ok_*`
 * PREDICATES, false of the BUCKET NAMES, which were a hand-written list right below it. A
 * floor added to the counts and forgotten here sampled nothing while the prose said it
 * could not happen. Both lists are now generated from {@link ISSUE_CLAIM_FLOORS}, so the
 * claim is finally structural rather than aspirational — do not re-hand-write either one.
 *
 * ⚠ That agreement is PER SNAPSHOT (WI-5947). Called on its own this is a SEPARATE
 * round-trip from the counts, so under concurrent claims a sampled id CAN disagree with the
 * counts it is shown beside. To present the two together, read both through
 * {@link readIssueClaimability} — one REPEATABLE READ transaction over all of them.
 */
export async function sampleIssueClaimExclusions(
  filter: FilterNode | undefined,
  opts: {
    harness: string;
    /** An already-resolved active workspace to survive async request-scope loss. */
    workspaceId?: string;
    states?: readonly string[];
    assignee?: string;
    rigAvailable?: boolean;
    claimantFleetSlug?: string;
    claimSpecReferencesFleet?: boolean;
    /** EI-21398324268952860: the spec structurally names `goal` and may adopt that plan lane. */
    claimSpecReferencesGoal?: boolean;
    /** Run on this handle instead of a fresh pool checkout — pass the `tx` from
     *  {@link readIssueClaimability} to share ONE snapshot with the sibling reads. */
    client?: OrgSql;
    /** EI-18802055183255275: see {@link aggregateIssueClaimExclusions}'s same-named opt. */
    precomputedTable?: string;
  },
  sampleLimit: number,
): Promise<IssueClaimExclusionSample> {
  const sql = opts.client ?? getOrgPg().sql;
  const states = [...(opts.states ?? ISSUE_FAMILY_CLAIMABLE_STATES)];
  const issueWs = resolveIssuesScopeWorkspace(opts.workspaceId);
  const operatorScopeSlug = `operator:${issueWs}`;
  const assignee = opts.assignee ?? '';
  const compiled = compileFilter(sql, filter);
  const cooldown = releaseCooldownSec();
  const sub = issueClaimCandidateSubquery(sql, {
    compiled,
    assignee,
    cooldown,
    harness: opts.harness,
    states,
    issueWs,
    operatorScopeSlug,
    rigAvailable: opts.rigAvailable,
    claimantFleetSlug: opts.claimantFleetSlug,
    claimSpecReferencesFleet: opts.claimSpecReferencesFleet,
    claimSpecReferencesGoal: opts.claimSpecReferencesGoal,
  });

  // Each floor's sample is its own bounded scalar subquery over the materialized `sub`
  // CTE — cheap (an index-friendly LIMIT-capped scan of an already-computed row set), and
  // structurally tied to the SAME ok_* booleans the counts filter on, never a re-derived
  // predicate that could drift from them.
  const sampleOf = (predicateSql: string, extraGuard = 'ok_untaken AND ') => sql`
    (SELECT COALESCE(array_agg(feature_id), ARRAY[]::text[]) FROM (
       SELECT feature_id FROM sub
        WHERE spec_match AND ${sql.unsafe(extraGuard)}${sql.unsafe(predicateSql)}
        ORDER BY updated_ts DESC NULLS LAST
        LIMIT ${sampleLimit}
     ) t)
  `;

  // DERIVED from ISSUE_CLAIM_FLOORS, exactly like the counts — same registry, same
  // per-floor guard, so the two reads cannot report different bucket vocabularies.
  // `sampleLimit` stays a BOUND parameter inside each fragment; only column identifiers
  // are interpolated as text.
  const sampleSelect = ISSUE_CLAIM_FLOORS.map(
    (f) => sql`${sampleOf(`NOT ${f.ok}`, issueClaimFloorBucketGuard(f))} AS ${sql.unsafe(f.bucket)}`,
  ).reduce((acc, frag) => sql`${acc}, ${frag}`);

  const rows = (await sql`
    WITH sub AS ${candidateFromSource(sql, sub, opts.precomputedTable)}
    SELECT ${sampleSelect}
  `) as Array<IssueClaimExclusionSampleRow>;
  const controlRows = (await sql`
    SELECT * FROM (
      (SELECT 'active-claim'::text AS axis, feature_id, taken_by, taken_at, payload
         FROM ${candidateFromSource(sql, sub, opts.precomputedTable)} c
        WHERE spec_match AND NOT ok_untaken
        ORDER BY updated_ts DESC NULLS LAST LIMIT ${sampleLimit})
      UNION ALL
      (SELECT 'hold-open-lease'::text AS axis, feature_id, taken_by, taken_at, payload
         FROM ${candidateFromSource(sql, sub, opts.precomputedTable)} c
        WHERE spec_match AND NOT ok_claim_hold
          AND NULLIF(BTRIM(COALESCE(payload ->> 'held_open_by', '')), '') IS NOT NULL
        ORDER BY updated_ts DESC NULLS LAST LIMIT ${sampleLimit})
      UNION ALL
      (SELECT 'durable-park'::text AS axis, feature_id, taken_by, taken_at, payload
         FROM ${candidateFromSource(sql, sub, opts.precomputedTable)} c
        WHERE spec_match AND NOT ok_claim_hold
          AND NULLIF(BTRIM(COALESCE(payload ->> 'claim_hold_by', '')), '') IS NOT NULL
        ORDER BY updated_ts DESC NULLS LAST LIMIT ${sampleLimit})
      UNION ALL
      (SELECT 'unattributed-park'::text AS axis, feature_id, taken_by, taken_at, payload
         FROM ${candidateFromSource(sql, sub, opts.precomputedTable)} c
        WHERE spec_match AND NOT ok_claim_hold
          AND NULLIF(BTRIM(COALESCE(payload ->> 'held_open_by', '')), '') IS NULL
          AND NULLIF(BTRIM(COALESCE(payload ->> 'claim_hold_by', '')), '') IS NULL
        ORDER BY updated_ts DESC NULLS LAST LIMIT ${sampleLimit})
      UNION ALL
      (SELECT 'agent-review'::text AS axis, feature_id, taken_by, taken_at, payload
         FROM ${candidateFromSource(sql, sub, opts.precomputedTable)} c
        WHERE spec_match AND payload -> 'agentReview' ->> 'status' IN ('pending', 'revision-requested')
        ORDER BY updated_ts DESC NULLS LAST LIMIT ${sampleLimit})
    ) queue_control
  `) as Array<{
    axis: 'active-claim' | 'hold-open-lease' | 'durable-park' | 'unattributed-park' | 'agent-review';
    feature_id: string;
    taken_by: string | null;
    taken_at: number | null;
    payload: unknown;
  }>;
  const nowMs = Date.now();
  const queueControl: IssueQueueControlSample = {
    activeClaims: [],
    holdOpenLeases: [],
    durableParks: [],
    agentReview: [],
  };
  for (const row of controlRows) {
    const payload =
      row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
        ? (row.payload as Record<string, unknown>)
        : {};
    if (row.axis === 'active-claim' && row.taken_by) {
      queueControl.activeClaims.push({
        id: row.feature_id,
        owner: row.taken_by,
        claimedAt: Number.isFinite(row.taken_at) ? new Date(Number(row.taken_at)).toISOString() : null,
      });
    } else if (row.axis === 'hold-open-lease' && typeof payload.held_open_by === 'string') {
      const heldAt = typeof payload.held_open_at === 'string' ? payload.held_open_at : null;
      queueControl.holdOpenLeases.push({
        id: row.feature_id,
        holder: payload.held_open_by,
        reason: typeof payload.held_open_reason === 'string' ? payload.held_open_reason : null,
        heldAt,
        age: classifyAuditAge(heldAt, nowMs),
      });
    } else if (row.axis === 'durable-park' || row.axis === 'unattributed-park') {
      const parker = typeof payload.claim_hold_by === 'string' ? payload.claim_hold_by : null;
      const reason = typeof payload.claim_hold_reason === 'string' ? payload.claim_hold_reason : null;
      const parkedAt = typeof payload.claim_hold_at === 'string' ? payload.claim_hold_at : null;
      queueControl.durableParks.push({
        id: row.feature_id,
        parker,
        reason,
        parkedAt,
        age: classifyAuditAge(parkedAt, nowMs),
        unparkCondition: classifyUnparkCondition(reason),
        releaseLiveness: classifyDurableParkReleaseLiveness(payload, reason),
      });
    } else if (row.axis === 'agent-review') {
      const review = readAgentReviewState(payload);
      if (review) queueControl.agentReview.push({ id: row.feature_id, ...review });
    }
  }
  const r = rows[0];
  return { ...mapIssueClaimExclusionSamples(r), queueControl };
}

/** One claimable issue-family row surfaced by {@link listIssueClaimableRows} — a lean,
 *  self-selection-oriented projection (id/kind/title/status/severity/plan + the ordering
 *  keys). Full body via `work_items:get { id }`. */
export interface IssueClaimableRow {
  /** The work-item id (feature_id — WI-/EI-…). */
  id: string;
  /** item_kind (bug | change | task), COALESCEd over the legacy free-text `kind`. */
  kind: string;
  title: string | null;
  status: string;
  /** Physical authoring provenance; remote rows are refused by local mutation paths. */
  origin: string | null;
  /** payload.severity for bugs (null when the row carries none). */
  severity: string | null;
  /** source_plan_slug — the plan this item belongs to, if any. */
  plan: string | null;
  /** feature_order (the prioritization key; null = unprioritized, sorts last). */
  featureOrder: number | null;
  /** created_ts (epoch ms). */
  createdTs: number | null;
  /**
   * One-hop dependency leverage: downstream items for which this row is the last
   * unresolved blocker. This is the exact value used by the `dependency_unlock_score`
   * rank term. Null when the active spec does not use that term; computing the graph score
   * only for a policy that consumes it keeps ordinary claimability reads cheap.
   */
  dependencyUnlockScore: number | null;
}

/**
 * The companion row-lister to {@link aggregateIssueClaimExclusions}: the actual issue-family
 * rows that survive `spec_match` AND every claim floor — i.e. what a self-selecting caller
 * under this spec would see as claimable RIGHT NOW, ordered the way `get_next` would hand
 * them out (via {@link compileRank} over the same spec). Wraps the SAME
 * {@link issueClaimCandidateSubquery} + the SAME {@link ALL_ISSUE_CLAIM_FLOORS_PASS} bar the
 * survivors COUNT uses, so within ONE snapshot `rows.length` (uncapped) === the oracle's
 * `claimable` count — the list and the count cannot drift from each other or from the floors.
 * Read-only; NO claim side-effect (this is the diagnostic read `work_items:claimable`
 * exposes, never a claim path).
 *
 * ⚠ "Within one snapshot" is load-bearing (WI-5947). Issued as its OWN round-trip this
 * observes a LATER snapshot than a separately-issued count, and under fleet churn the two
 * genuinely disagree (observed live: `claimableCount:1, returned:0` under a limit of 50).
 * Any caller reporting the count and the list together must go through
 * {@link readIssueClaimability}.
 */
export async function listIssueClaimableRows(
  filter: FilterNode | undefined,
  opts: {
    harness: string;
    /** An already-resolved active workspace to survive async request-scope loss. */
    workspaceId?: string;
    states?: readonly string[];
    assignee?: string;
    rigAvailable?: boolean;
    claimantFleetSlug?: string;
    claimSpecReferencesFleet?: boolean;
    /** EI-21398324268952860: the spec structurally names `goal` and may adopt that plan lane. */
    claimSpecReferencesGoal?: boolean;
    /** The validated claim spec whose rank orders the survivors (defaults to
     *  DEFAULT_CLAIM_SPEC's fixed feature_order→created ordering). Reusing compileRank
     *  makes the listing order match what get_next under this spec would actually claim. */
    spec?: ClaimSpec;
    /** Run on this handle instead of a fresh pool checkout — pass the `tx` from
     *  {@link readIssueClaimability} to share ONE snapshot with the sibling reads. */
    client?: OrgSql;
    /** EI-18802055183255275: see {@link aggregateIssueClaimExclusions}'s same-named opt. */
    precomputedTable?: string;
  },
  limit: number,
): Promise<IssueClaimableRow[]> {
  const sql = opts.client ?? getOrgPg().sql;
  const states = [...(opts.states ?? ISSUE_FAMILY_CLAIMABLE_STATES)];
  const issueWs = resolveIssuesScopeWorkspace(opts.workspaceId);
  const operatorScopeSlug = `operator:${issueWs}`;
  const assignee = opts.assignee ?? '';
  const compiled = compileFilter(sql, filter);
  const cooldown = releaseCooldownSec();
  const cap = Math.max(1, Math.min(Math.floor(limit) || 1, 200));
  // Reuse the resolver's OWN rank compiler so the diagnostic order == the claim order.
  // Empty heldPaths ⇒ the `affinity` term is NEUTRAL (dropped), leaving the spec's
  // deterministic feature_order→created ordering — exactly get_next's for a fresh bee.
  const order = compileRank(sql, opts.spec ?? DEFAULT_CLAIM_SPEC, { assignee });
  // Score only when it explains an active policy term. Keeping the projection NULL for
  // specs that do not use the term avoids paying a graph query per row on every ordinary
  // claimability read, and makes "not part of this ordering" distinct from a real score 0.
  const dependencyUnlockScore = specUsesRankTerm(opts.spec ?? DEFAULT_CLAIM_SPEC, 'dependency_unlock_score')
    ? dependencyUnlockScoreSql(sql)
    : sql`NULL::integer`;
  const sub = issueClaimCandidateSubquery(sql, {
    compiled,
    assignee,
    cooldown,
    harness: opts.harness,
    states,
    issueWs,
    operatorScopeSlug,
    rigAvailable: opts.rigAvailable,
    claimantFleetSlug: opts.claimantFleetSlug,
    claimSpecReferencesFleet: opts.claimSpecReferencesFleet,
    claimSpecReferencesGoal: opts.claimSpecReferencesGoal,
  });

  const rows = (await sql`
    SELECT
      feature_id                AS id,
      COALESCE(item_kind, kind) AS kind,
      title,
      status,
      origin,
      -- WI-6673: severity on harness_shared.work_items lives at payload._ei.severity
      -- (migration 374 fold), NOT top level. The old top-level accessor matched
      -- 1 of 13,731 open issue-family rows -- so EVERY claimable row came back
      -- severity:null, including genuine criticals, and a leader reading this tool
      -- concluded severity was simply not tracked on claimable work. _ei first, with
      -- the legacy top-level as fallback for stragglers that predate the fold.
      COALESCE(payload->'_ei'->>'severity', payload->>'severity') AS severity,
      source_plan_slug          AS plan,
      feature_order,
      created_ts,
      ${dependencyUnlockScore} AS dependency_unlock_score
    FROM ${candidateFromSource(sql, sub, opts.precomputedTable)} sub
    WHERE spec_match AND ${sql.unsafe(ALL_ISSUE_CLAIM_FLOORS_PASS)}
    ORDER BY ${order}
    LIMIT ${cap}
  `) as Array<{
    id: string;
    kind: string;
    title: string | null;
    status: string;
    origin: string | null;
    severity: string | null;
    plan: string | null;
    feature_order: number | string | null;
    created_ts: number | string | null;
    dependency_unlock_score: number | string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    status: r.status,
    origin: r.origin ?? null,
    severity: r.severity,
    plan: r.plan,
    featureOrder: r.feature_order == null ? null : Number(r.feature_order),
    createdTs: r.created_ts == null ? null : Number(r.created_ts),
    dependencyUnlockScore: r.dependency_unlock_score == null ? null : Number(r.dependency_unlock_score),
  }));
}

/**
 * What the ADMITTED set is MADE OF — the composition of the rows that passed, as opposed
 * to {@link IssueClaimExclusionBreakdown} which describes only what was REJECTED.
 *
 * WHY (WI-6673): a claimable COUNT with no composition is the single most misleading
 * number this system produces, because it looks like a measurement rather than an
 * interpretation and therefore resists suspicion. On 2026-08-01 a fleet was launched at a
 * lane reporting 1,252 claimable; 98.7% of it was nit-severity auto-filed OBSERVATIONS,
 * and the true bug backlog was ~285. Every count quoted along the way was arithmetically
 * correct and none of them answered "is this work?". The owner caught it by instinct after
 * three different correct numbers had been reported.
 *
 * This MUST be computed server-side. The obvious caller-side workaround — read the rows
 * and group them yourself — was impossible: the row projection handed back `severity:null`
 * for every row (the sibling half of WI-6673, fixed in the same change), so no amount of
 * caller diligence could characterize the pool.
 */
export interface IssueClaimAdmittedComposition {
  /**
   * Size of the ADMITTED population — the one `lowSeverityShare` is a share OF. Explicit
   * because a consumer that pairs the share with some other count it happens to have (e.g.
   * a spec's pre-floor `matched`) reports a percentage of one population against the size
   * of a larger one. That is precisely the "arithmetically correct, actually wrong" number
   * this whole structure exists to prevent, so the denominator travels WITH the share.
   */
  total: number;
  /** Admitted rows per issue kind (bug/change/task). */
  byKind: Record<string, number>;
  /** Admitted rows per severity; `unset` collects rows carrying none. */
  bySeverity: Record<string, number>;
  /** Fraction of the admitted set that is nit/minor severity, 0..1 (null when empty). */
  lowSeverityShare: number | null;
  /**
   * True when the admitted pool is BOTH large and compositionally degenerate — the
   * "this lane is an observation firehose, not a backlog" shape. Consumers surface this
   * instead of making every caller re-derive the same judgement from the raw buckets.
   */
  degenerate: boolean;
  /** Admitted rows created in the busiest single day, and that day — a burst-filing tell. */
  peakDay: { day: string; count: number } | null;
}

export const DEGENERATE_LOW_SEVERITY_SHARE = 0.8;
export const DEGENERATE_MIN_POOL = 50;

/** One GROUP BY (kind, severity, day) tallied row — the shape {@link summarizeAdmittedRows} folds. */
export interface AdmittedCompositionRow {
  kind: string;
  severity: string;
  day: string | null;
  n: number;
}

/**
 * The PURE fold behind {@link aggregateAdmittedComposition} — grouped tallies in, composition
 * verdict out. Extracted (WI-6673) so the two thresholds that decide `degenerate` are
 * guardable without a database: the SQL above is a plain GROUP BY, but the JUDGEMENT it feeds
 * is the part that silently rots, and a DB-backed test cannot pin a threshold cheaply enough
 * to run on every edit. Keep it total and side-effect free.
 */
export function summarizeAdmittedRows(rows: readonly AdmittedCompositionRow[]): IssueClaimAdmittedComposition {
  const byKind: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  const byDay: Record<string, number> = {};
  let total = 0;
  let low = 0;
  for (const r of rows) {
    byKind[r.kind] = (byKind[r.kind] ?? 0) + r.n;
    bySeverity[r.severity] = (bySeverity[r.severity] ?? 0) + r.n;
    if (r.day) byDay[r.day] = (byDay[r.day] ?? 0) + r.n;
    if (r.severity === 'nit' || r.severity === 'minor') low += r.n;
    total += r.n;
  }
  const lowSeverityShare = total > 0 ? low / total : null;
  // Deterministic peak: ties break on the EARLIER day, so the verdict does not flap between
  // reads just because Object.entries ordering shifted.
  const peak = Object.entries(byDay).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return {
    total,
    byKind,
    bySeverity,
    lowSeverityShare,
    degenerate:
      total >= DEGENERATE_MIN_POOL && lowSeverityShare !== null && lowSeverityShare >= DEGENERATE_LOW_SEVERITY_SHARE,
    peakDay: peak ? { day: peak[0], count: peak[1] } : null,
  };
}

/**
 * Composition of the ADMITTED set, in the caller's snapshot. Same subquery + same floor
 * predicate as {@link listIssueClaimableRows}, so it describes exactly the population the
 * count reports and the queue serves — it cannot drift from either.
 */
export async function aggregateAdmittedComposition(
  filter: FilterNode | undefined,
  opts: {
    harness: string;
    /** An already-resolved active workspace to survive async request-scope loss. */
    workspaceId?: string;
    states?: readonly string[];
    assignee?: string;
    rigAvailable?: boolean;
    claimantFleetSlug?: string;
    claimSpecReferencesFleet?: boolean;
    /** EI-21398324268952860: the spec structurally names `goal` and may adopt that plan lane. */
    claimSpecReferencesGoal?: boolean;
    client?: OrgSql;
    /** EI-18802055183255275: see {@link aggregateIssueClaimExclusions}'s same-named opt. */
    precomputedTable?: string;
  },
): Promise<IssueClaimAdmittedComposition> {
  const sql = opts.client ?? getOrgPg().sql;
  const states = [...(opts.states ?? ISSUE_FAMILY_CLAIMABLE_STATES)];
  const issueWs = resolveIssuesScopeWorkspace(opts.workspaceId);
  const operatorScopeSlug = `operator:${issueWs}`;
  const sub = issueClaimCandidateSubquery(sql, {
    compiled: compileFilter(sql, filter),
    assignee: opts.assignee ?? '',
    cooldown: releaseCooldownSec(),
    harness: opts.harness,
    states,
    issueWs,
    operatorScopeSlug,
    rigAvailable: opts.rigAvailable,
    claimantFleetSlug: opts.claimantFleetSlug,
    claimSpecReferencesFleet: opts.claimSpecReferencesFleet,
    claimSpecReferencesGoal: opts.claimSpecReferencesGoal,
  });

  const rows = (await sql`
    SELECT
      COALESCE(item_kind, kind)                                              AS kind,
      COALESCE(payload->'_ei'->>'severity', payload->>'severity', 'unset')   AS severity,
      to_char(to_timestamp(created_ts / 1000.0) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
      count(*)::int                                                          AS n
    FROM ${candidateFromSource(sql, sub, opts.precomputedTable)} sub
    WHERE spec_match AND ${sql.unsafe(ALL_ISSUE_CLAIM_FLOORS_PASS)}
    GROUP BY 1, 2, 3
  `) as AdmittedCompositionRow[];

  return summarizeAdmittedRows(rows);
}

/** The whole claimability reading — counts, survivor rows, and (optionally) the per-floor
 *  excluded sample — as observed at ONE instant. Returned by {@link readIssueClaimability}. */
export interface IssueClaimabilityReading {
  breakdown: IssueClaimExclusionBreakdown;
  /** Survivors, capped at the caller's `limit`. Empty when `breakdownOnly`. */
  rows: IssueClaimableRow[];
  /** Only when `sampleLimit` was passed. */
  sample?: IssueClaimExclusionSample;
  /** What the admitted set is MADE OF (WI-6673) — always present, same snapshot. */
  admitted: IssueClaimAdmittedComposition;
}

/**
 * Read the FULL claimability picture — {@link aggregateIssueClaimExclusions}'s counts,
 * {@link listIssueClaimableRows}' survivor rows, and optionally
 * {@link sampleIssueClaimExclusions}' per-floor id sample — inside ONE
 * REPEATABLE READ transaction, so all three observe the SAME snapshot.
 *
 * WHY (WI-5947): sharing the inner subquery + the floor predicate makes the three reads
 * SEMANTICALLY identical; it does NOT make them ATOMIC, which is the property their
 * docstrings were actually asserting. Issued as three separate round-trips against a
 * concurrently-mutating table, a peer's claim landing BETWEEN them is counted by one and
 * absent from the next — observed live on 2026-07-26 as `claimableCount:1, returned:0`
 * under a limit of 50 (a limit of 50 cannot truncate one row). That impossible-looking pair
 * is then read as a defect in the claim path: `scheduler:get_next` reported a
 * "CLAIM-PATH/READ-PATH DIVERGENCE" and instructed the agent to file a claim-path bug that
 * did not exist. One snapshot removes the race at the source, and makes the "cannot
 * diverge" guarantee TRUE rather than aspirational.
 *
 * REPEATABLE READ (not SERIALIZABLE): a stable snapshot is the entire requirement — and
 * since nothing here ever writes to a REAL table (the transaction only reads them, plus
 * writes to its own session-local temp table — see EI-18802055183255275 below for why this
 * is no longer marked SQL `READ ONLY`), there is no write-write conflict this transaction
 * could ever be a party to, so it cannot raise a serialization failure and this adds a
 * consistency guarantee without adding a retry path. A stalled read surfaces as a bounded
 * statement_timeout error rather than hanging: the admin pool deliberately carries NO
 * statement_timeout (migrations run on it).
 *
 * The reading is ALL-OR-NOTHING BY DESIGN: if the transaction fails, this throws. It never
 * degrades to unsynchronized reads or to a synthesised zero — "could not measure" must stay
 * distinguishable from "measured none", because the caller's whole purpose is deciding
 * whether a lane is drained, and a fabricated 0 is indistinguishable from a real drain.
 */
export async function readIssueClaimability(
  filter: FilterNode | undefined,
  opts: {
    harness: string;
    /** The caller's already-resolved active workspace; avoids ambient ALS drift after awaits. */
    workspaceId?: string;
    states?: readonly string[];
    assignee?: string;
    rigAvailable?: boolean;
    claimantFleetSlug?: string;
    claimSpecReferencesFleet?: boolean;
    /** EI-21398324268952860: the spec structurally names `goal` and may adopt that plan lane. */
    claimSpecReferencesGoal?: boolean;
    spec?: ClaimSpec;
    /** Inject the sql client (tests / a non-default backend). Default getOrgPg().sql. */
    client?: OrgSql;
  },
  readOpts: {
    /** Max survivor rows to return. Ignored when `breakdownOnly`. */
    limit: number;
    /** Skip the row list entirely (counts only). */
    breakdownOnly?: boolean;
    /** When set, also sample up to this many excluded ids PER FLOOR. */
    sampleLimit?: number;
    /** Per-statement cap for the snapshot txn, ms (default 15000). */
    statementTimeoutMs?: number;
  },
): Promise<IssueClaimabilityReading> {
  const sql = opts.client ?? getOrgPg().sql;
  const stmtMs = Math.max(100, Math.trunc(readOpts.statementTimeoutMs ?? 15_000));
  const shared = {
    harness: opts.harness,
    workspaceId: opts.workspaceId,
    states: opts.states,
    assignee: opts.assignee,
    rigAvailable: opts.rigAvailable,
    claimantFleetSlug: opts.claimantFleetSlug,
    claimSpecReferencesFleet: opts.claimSpecReferencesFleet,
    claimSpecReferencesGoal: opts.claimSpecReferencesGoal,
  };

  return (await sql.begin(async (tx) => {
    // Both must precede the first DATA statement of the transaction: PG rejects
    // SET TRANSACTION once a query has run, which would silently leave the reads on
    // READ COMMITTED — i.e. exactly the unsynchronized behaviour this removes.
    //
    // EI-18802055183255275: REPEATABLE READ only — NOT ", READ ONLY" anymore. A real-DB
    // integration test caught this the moment it exercised the temp-table materialization
    // below against live Postgres (the mocked-pg unit tests in claimability-snapshot.test.ts
    // stub every query, so they could not): Postgres unconditionally refuses `CREATE TABLE
    // AS` — including for a TEMP table — inside a READ ONLY transaction ("cannot execute
    // CREATE TABLE AS in a read-only transaction", PG's read-only guard does not special-case
    // this one command the way it special-cases INSERT/UPDATE/DELETE against a temp
    // relation). REPEATABLE READ alone still gives the ONE property this function actually
    // needs (WI-5947's stable snapshot — every read below observes the same point-in-time
    // view of the real tables); READ ONLY was defense-in-depth against an accidental write to
    // a REAL table, which this function still never performs (every write below targets only
    // the session-local temp table created below).
    await tx.unsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await tx.unsafe(`SET LOCAL statement_timeout = ${stmtMs}`);
    const client = tx as unknown as OrgSql;

    // EI-18802055183255275: materialize the candidate set — the spec `view.filter` is
    // pushed into the candidate subquery's base WHERE, alongside all 13 claim floors, so
    // the expensive floor expressions are evaluated only for rows this caller can match.
    // The filtered set is materialized exactly ONCE into a session-scoped temp table every
    // sibling read below scans instead of recomputing from scratch. Previously each of the
    // (up to) 4 reads
    // below independently re-ran the full filter+floor computation as its OWN statement;
    // measured 2026-08-02 against the real `p2p-release` spec (63-predicate `any` filter,
    // ~14k-row candidate population): ONE such pass costs ~6.2s, so the unmerged 2-4
    // serial passes summed to ~12-25s — comfortably past readIssueClaimability's own
    // per-statement timeout even though no single original statement was individually
    // pathological (this is why `work_items:claimable { spec:'p2p-release' }` timed out,
    // including under `breakdownOnly:true`, which still paid 2 of those passes per the
    // WI-6673 unconditional admitted-composition read). Materializing once turns that into
    // ~1 full pass + several sub-100ms scans of the already-computed ~14k-row temp table.
    // ON COMMIT DROP cleans the temp table up when this transaction ends, so a pooled
    // connection can never carry a stale copy into its next, unrelated checkout — and each
    // concurrent caller gets its OWN connection for the duration of `sql.begin`, so the fixed
    // literal table name never collides across concurrent readIssueClaimability calls
    // (Postgres temp tables are per-backend-session, invisible across connections).
    const states = [...(opts.states ?? ISSUE_FAMILY_CLAIMABLE_STATES)];
    const issueWs = resolveIssuesScopeWorkspace();
    const operatorScopeSlug = `operator:${issueWs}`;
    const assignee = opts.assignee ?? '';
    const compiled = compileFilter(client, filter);
    // WI-525554: push the OBSERVATION-LANE floor into the materialization's base WHERE, not just
    // decorate it as `ok_observation`. Measured 2026-08-28 on the live papercusp population:
    // 66,645 of 71,266 candidate rows (93.5%) are lane='observation' and can never be claimable,
    // yet every one of them was materialized and had all 16 floors evaluated. That materialization
    // was 2,013ms of a 2,278ms call (88%); pushing the lane floor down takes the whole read from
    // 3,174ms to 1,335ms (2.4x) and the temp table from 66 MB to 6.4 MB, with `claimable`
    // byte-identical at 2,837.
    //
    // WHY THE LANE FLOOR SPECIFICALLY, and why this is safe: it is ROW-INTRINSIC (it reads only
    // wi.payload's lane), so it cannot depend on anything the other floors compute, and it is
    // ANDed into ALL_ISSUE_CLAIM_FLOORS_PASS — a row failing it is unclaimable no matter what
    // every other floor says. Filtering it early therefore removes only rows the bar would have
    // rejected anyway. The two counts that must NOT shrink with the population are restored via
    // `laneScopedPopulation` below.
    //
    // ⚠ Do NOT generalise this to the other floors. Measured: all 16 floors evaluated TOGETHER
    // cost 732ms over the full 71k rows and the bare scan is 62ms, so per-floor evaluation was
    // never the expense — the population size was. Pushing more floors down buys ~nothing and
    // costs a breakdown bucket each.
    const laneFloor = observationLaneExclusionSql(client);
    const sub = issueClaimCandidateSubquery(client, {
      compiled,
      filterPushdown: client`(${compiled}) AND (${laneFloor})`,
      projection: 'claimability-snapshot',
      assignee,
      cooldown: releaseCooldownSec(),
      harness: opts.harness,
      states,
      issueWs,
      operatorScopeSlug,
      rigAvailable: opts.rigAvailable,
      claimantFleetSlug: opts.claimantFleetSlug,
      claimSpecReferencesFleet: opts.claimSpecReferencesFleet,
      claimSpecReferencesGoal: opts.claimSpecReferencesGoal,
    });
    const precomputedTable = 'claim_candidate_snapshot';
    await client`CREATE TEMP TABLE ${client.unsafe(precomputedTable)} ON COMMIT DROP AS ${sub}`;

    // WI-525554: the two counts the lane pushdown above would otherwise destroy, measured over the
    // FULL candidate population (observations included). This reuses the SAME
    // issueClaimCandidateSubquery + the SAME floor predicates rather than re-deriving them in a
    // second SQL copy — the drift D-007 measured (a hand-copied floor reporting 0 blocked against
    // the claim path's 5) is exactly what a bespoke count here would reintroduce.
    //
    // It is cheap because it omits `filterPushdown`: with no MATERIALIZED barrier, Postgres prunes
    // the subquery's unreferenced target-list columns, so only the three floors named below are
    // ever evaluated — not all 16, and nothing is materialized.
    const laneScopeSub = issueClaimCandidateSubquery(client, {
      compiled,
      projection: 'claimability-snapshot',
      assignee,
      cooldown: releaseCooldownSec(),
      harness: opts.harness,
      states,
      issueWs,
      operatorScopeSlug,
      rigAvailable: opts.rigAvailable,
      claimantFleetSlug: opts.claimantFleetSlug,
      claimSpecReferencesFleet: opts.claimSpecReferencesFleet,
      claimSpecReferencesGoal: opts.claimSpecReferencesGoal,
    });
    // Both expressions are byte-identical to aggregateIssueClaimExclusions' own `matched` and
    // `observation_lane` columns — keep them that way if either definition moves.
    const [laneScopeRow] = (await client`
      SELECT
        count(*) FILTER (WHERE spec_match)::int                                        AS matched,
        count(*) FILTER (WHERE spec_match AND ok_untaken AND NOT ok_observation)::int  AS observation_lane
      FROM (${laneScopeSub}) lane_scope
    `) as Array<{ matched: number; observation_lane: number }>;

    const breakdown = await aggregateIssueClaimExclusions(filter, {
      ...shared,
      client,
      precomputedTable,
      laneScopedPopulation: {
        matchedByFilter: laneScopeRow?.matched ?? 0,
        observationLane: laneScopeRow?.observation_lane ?? 0,
      },
    });
    const rows = readOpts.breakdownOnly
      ? []
      : await listIssueClaimableRows(filter, { ...shared, spec: opts.spec, client, precomputedTable }, readOpts.limit);
    const sample = readOpts.sampleLimit
      ? await sampleIssueClaimExclusions(filter, { ...shared, client, precomputedTable }, readOpts.sampleLimit)
      : undefined;
    // WI-6673: composition of the ADMITTED set, in the SAME snapshot as the count it
    // describes. Unconditional — it is not an opt-in extra, because the whole failure
    // mode is a caller quoting the count WITHOUT having thought to ask for composition.
    // EI-18802055183255275: this used to be a genuine "fourth serial full scan" cost (see
    // the COST NOTE this replaced) — now it is a cheap scan of the materialized table above.
    const admitted = await aggregateAdmittedComposition(filter, { ...shared, client, precomputedTable });

    return { breakdown, rows, admitted, ...(sample ? { sample } : {}) };
  })) as IssueClaimabilityReading;
}

// ────────────────────────────────────────────────────────────────────────────
// Claim-spec DELTA — what a proposed revision would change, before the write.
// ────────────────────────────────────────────────────────────────────────────

/** Why a row's claimability moved between two specs. `filter` = the two `view.filter`s
 *  disagree about it; `states` = the claimable-status floor changed under it; `both` = the
 *  revision changed the filter AND the states in a way that each independently moves it.
 *  Attribution matters because the two have completely different fixes, and the `states`
 *  case is the one that has starved this fleet repeatedly (an issue-family lane left on the
 *  feature-family `todo` token matches ~nothing, and the spec still validates). */
export type ClaimSpecDeltaCause = 'filter' | 'states' | 'both';

/** One row whose CLAIMABILITY changes between the current and the proposed spec. */
export interface ClaimSpecDeltaRow extends IssueClaimableRow {
  cause: ClaimSpecDeltaCause;
}

/** The whole before/after reading — both sides observed at ONE instant. */
export interface ClaimSpecDeltaReading {
  /** Claimable NOW, under the stored spec. */
  currentClaimable: number;
  /** Claimable if the proposed revision were written. */
  proposedClaimable: number;
  /** Claimable under BOTH (untouched by the change). */
  retained: number;
  /** Full counts — the row lists below are capped, these are not. */
  newlyExcludedCount: number;
  newlyAdmittedCount: number;
  /** Rows the current lane serves that the proposal would DROP, in the order the CURRENT
   *  spec would have handed them out (so the head of the list is the most consequential
   *  loss, not an arbitrary one). Capped at `limit`. */
  newlyExcluded: ClaimSpecDeltaRow[];
  /** Rows the proposal would PICK UP, in the order the PROPOSED spec would hand them out. */
  newlyAdmitted: ClaimSpecDeltaRow[];
  truncated: { newlyExcluded: boolean; newlyAdmitted: boolean };
}

/** One side of a delta: the filter + states a spec would apply. */
export interface ClaimSpecDeltaSide {
  filter?: FilterNode;
  states?: readonly string[];
  /** Orders that side's rows via {@link compileRank} — the order get_next would claim in. */
  spec?: ClaimSpec;
}

/**
 * What a PROPOSED claim spec would change about a lane, item by item, WITHOUT writing it.
 *
 * WHY (agent-epistemics-2026-08-02 P-005): re-steering a fleet is a spec bump, and the only
 * pre-write signal was `set_claim_spec`'s `poolEffect` — a COUNT (matched / pool /
 * previousMatched). A count answers "did the lane get smaller"; it cannot answer "did it drop
 * the four criticals I launched this fleet for". For WI-6995 the audit hand-rolled that
 * item-level delta in raw SQL, and the answer OVERTURNED the proposal it was checking — which
 * is precisely the case for making it a cheap first-class read rather than an ad-hoc query
 * someone has to think to write.
 *
 * WHY IT REUSES THE ORACLE RATHER THAN RE-DERIVING IT: a second SQL copy of the claim floors
 * drifts. That is not hypothetical here — D-007 measured a drifted copy of the blocked-deps
 * floor reporting 0 blocked against the claim path's 5, advertising 5 items the claim door
 * refuses. So this wraps the SAME {@link issueClaimCandidateSubquery} + the SAME
 * {@link ALL_ISSUE_CLAIM_FLOORS_PASS} bar every other claimability read uses.
 *
 * WHY ONE MATERIALIZATION AND NOT TWO READS: the floors do not depend on the filter — only
 * `spec_match` does. So the population is computed ONCE (the expensive part: ~13 floor
 * predicates over the whole issue-family population) and decorated with TWO match columns.
 * That is both cheaper than two {@link readIssueClaimability} calls and — the load-bearing
 * half — ATOMIC BY CONSTRUCTION. Two separate reads observe two snapshots, so a peer's claim
 * landing between them shows up as a row present in the first and absent from the second:
 * indistinguishable from "your proposed spec excludes this item", i.e. a fabricated delta
 * attributed to the caller's change. A preview whose whole purpose is deciding whether to
 * narrow a lane must not invent narrowing that the fleet, not the spec, caused.
 *
 * States are handled by materializing the UNION of both sides' claimable states and testing
 * membership per side, so a revision that changes ONLY `states` is a first-class delta rather
 * than an empty diff over two differently-scoped populations.
 *
 * Read-only, and all-or-nothing like its sibling: a failed read THROWS rather than degrading
 * to a zeroed delta, because "measured no change" is the answer that would wave a starving
 * spec through.
 */
export async function readClaimSpecDelta(
  current: ClaimSpecDeltaSide,
  proposed: ClaimSpecDeltaSide,
  opts: {
    harness: string;
    /** Already-resolved caller workspace; omitted preserves the legacy ambient fallback. */
    workspaceId?: string;
    assignee?: string;
    rigAvailable?: boolean;
    /** Inject the sql client (tests / a non-default backend). Default getOrgPg().sql. */
    client?: OrgSql;
  },
  readOpts: {
    /** Max rows to list PER SIDE (the counts are always exact). */
    limit: number;
    /** Per-statement cap for the snapshot txn, ms (default 15000). */
    statementTimeoutMs?: number;
  },
): Promise<ClaimSpecDeltaReading> {
  const sql = opts.client ?? getOrgPg().sql;
  const stmtMs = Math.max(100, Math.trunc(readOpts.statementTimeoutMs ?? 15_000));
  const cap = Math.max(1, Math.min(Math.floor(readOpts.limit) || 1, 200));
  const currentStates = [...(current.states ?? ISSUE_FAMILY_CLAIMABLE_STATES)];
  const proposedStates = [...(proposed.states ?? ISSUE_FAMILY_CLAIMABLE_STATES)];
  const unionStates = [...new Set([...currentStates, ...proposedStates])];

  return (await sql.begin(async (tx) => {
    // Same ordering constraint as readIssueClaimability: both SETs must precede the first
    // data statement or PG silently leaves the reads on READ COMMITTED — which would
    // reintroduce exactly the two-snapshot misattribution this function exists to prevent.
    await tx.unsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await tx.unsafe(`SET LOCAL statement_timeout = ${stmtMs}`);
    const client = tx as unknown as OrgSql;

    const issueWs = resolveIssuesScopeWorkspace(opts.workspaceId);
    const operatorScopeSlug = `operator:${issueWs}`;
    const assignee = opts.assignee ?? '';
    // `spec_match` on the materialized table is the CURRENT filter; the proposed filter is
    // compiled as a second column over the same rows. Compiled filters reference item
    // columns UNQUALIFIED (see FIELD_MAP), so they evaluate correctly against the derived
    // table below, whose `c.*` carries every base `work_items` column.
    // The candidate population must cover BOTH sides of the delta. Restricting it to the
    // current filter makes a widening revision look like a no-op when it adds a fixed ID cohort
    // alongside an existing plan/property filter: proposed-only rows never reach the
    // `proposed_match` projection, so the preview reports 0 newly admitted even though
    // scheduler:set_claim_spec's whole-pool preview sees and admits them (EI-20414245235902773).
    const candidateFilter: FilterNode | undefined =
      current.filter && proposed.filter
        ? { any: [current.filter, proposed.filter] }
        : (current.filter ?? proposed.filter);
    const currentMatch = compileFilter(client, current.filter);
    const candidateMatch = compileFilter(client, candidateFilter);
    const sub = issueClaimCandidateSubquery(client, {
      // Keep the subquery's spec_match tied to the stored side. candidateMatch below only
      // bounds which rows enter the snapshot; conflating the two would make currentClaimable
      // include proposed-only rows.
      // Deliberately omit `filterPushdown`: the candidate population must remain broad enough
      // to cover the UNION of both sides, and the outer WHERE applies that union after the
      // floor-decorated rows have been materialized.
      compiled: currentMatch,
      assignee,
      cooldown: releaseCooldownSec(),
      harness: opts.harness,
      states: unionStates,
      issueWs,
      operatorScopeSlug,
      rigAvailable: opts.rigAvailable,
    });
    const proposedMatch = compileFilter(client, proposed.filter);
    const explainDependencyUnlock =
      specUsesRankTerm(current.spec ?? DEFAULT_CLAIM_SPEC, 'dependency_unlock_score') ||
      specUsesRankTerm(proposed.spec ?? DEFAULT_CLAIM_SPEC, 'dependency_unlock_score');
    const dependencyUnlockScore = explainDependencyUnlock ? dependencyUnlockScoreSql(client) : client`NULL::integer`;
    const table = 'claim_spec_delta_snapshot';
    // EI-23748103923712230: the snapshot below drops the observation lane BEFORE materializing.
    // Without that floor the temp table holds every union-matching row at FULL payload width
    // (the `SELECT c.*` is load-bearing — see the note under `sided`), so a broad proposed
    // filter — exactly the widening preview this tool exists to serve — overflows the 8MB
    // `temp_buffers` default and PostgreSQL raises its own `no empty local buffer available`
    // (localbuf.c). Measured on the live papercusp lane: both sides narrow SUCCEEDS; flipping
    // ONLY the proposed filter to one matching ~every row FAILS; and a narrow call on the SAME
    // pooled backend immediately after still succeeds — so this is input-size-driven, NOT an
    // accumulating or poisoned backend.
    //
    // Reading the already-projected `ok_observation` column (issueClaimCandidateSubquery
    // decorates it) rather than pushing the floor down is deliberate twice over:
    // `filterPushdown` hardcodes `spec_match` to TRUE, which would silently make
    // currentClaimable / retained / newlyExcluded count every row as matching the stored spec;
    // and calling observationLaneExclusionSql here would need the `wi` alias, which the outer
    // scope does not have.
    //
    // Output is unchanged BY CONSTRUCTION: `ok_observation` is ANDed into
    // ALL_ISSUE_CLAIM_FLOORS_PASS, which BOTH in_current and in_proposed require, so a row
    // failing it is false on both sides and can reach no count and neither row list. Unlike the
    // claim_candidate_snapshot path above, this path measures nothing over the pre-floor
    // population, so there is no laneScopedPopulation-style count to restore.
    await client`
      CREATE TEMP TABLE ${client.unsafe(table)} ON COMMIT DROP AS
      SELECT c.*, (${proposedMatch}) AS proposed_match FROM (${sub}) c
      WHERE (${candidateMatch}) AND c.ok_observation
    `;

    // in_current / in_proposed are the FULL claimability predicate per side: that side's
    // filter AND every floor AND that side's claimable states.
    //
    // `SELECT *` (not a narrow projection) is load-bearing: each side's rows are ORDERed by
    // its OWN spec via compileRank, whose vocabulary reaches base columns this row shape does
    // not carry (`payload`, for one). Projecting narrowly here drops them from the derived
    // table and the ORDER BY fails at runtime with `column "payload" does not exist` — caught
    // by the DB-backed sibling test, invisible to the mocked-pg one. The lean row shape is
    // built in JS instead, from the aliases below.
    const floors = client.unsafe(ALL_ISSUE_CLAIM_FLOORS_PASS);
    const sided = client`
      SELECT
        *,
        feature_id                AS delta_id,
        COALESCE(item_kind, kind) AS delta_kind,
        origin                    AS delta_origin,
        COALESCE(payload->'_ei'->>'severity', payload->>'severity') AS delta_severity,
        source_plan_slug          AS delta_plan,
        ${dependencyUnlockScore}  AS delta_dependency_unlock_score,
        -- Positive comparisons on nullable fields (e.g. plan = '<slug>') evaluate to SQL NULL,
        -- which WHERE correctly treats as a non-match but which NOT in_current would also turn
        -- into NULL and silently omit from newly-admitted counts. Normalize both match columns
        -- before composing the per-side membership predicates (EI-20414245235902773).
        (COALESCE(spec_match, false)     AND ${floors} AND status = ANY(${currentStates}::text[]))  AS in_current,
        (COALESCE(proposed_match, false) AND ${floors} AND status = ANY(${proposedStates}::text[])) AS in_proposed,
        (status = ANY(${currentStates}::text[]))  AS status_in_current,
        (status = ANY(${proposedStates}::text[])) AS status_in_proposed
      FROM ${client.unsafe(table)}
    `;

    const [counts] = (await client`
      SELECT
        count(*) FILTER (WHERE in_current)                       AS current_claimable,
        count(*) FILTER (WHERE in_proposed)                      AS proposed_claimable,
        count(*) FILTER (WHERE in_current AND in_proposed)       AS retained,
        count(*) FILTER (WHERE in_current AND NOT in_proposed)   AS newly_excluded,
        count(*) FILTER (WHERE in_proposed AND NOT in_current)   AS newly_admitted
      FROM (${sided}) d
    `) as Array<Record<string, number | string | null>>;

    // Each side is ordered by ITS OWN spec's rank: a dropped row is most interesting in the
    // order the current lane would have served it, an added row in the order the proposal
    // would. Reusing compileRank keeps both orders identical to what get_next would do.
    const excludedRows = (await client`
      SELECT * FROM (${sided}) d
      WHERE in_current AND NOT in_proposed
      ORDER BY ${compileRank(client, current.spec ?? DEFAULT_CLAIM_SPEC, { assignee })}
      LIMIT ${cap}
    `) as ClaimSpecDeltaSqlRow[];
    const admittedRows = (await client`
      SELECT * FROM (${sided}) d
      WHERE in_proposed AND NOT in_current
      ORDER BY ${compileRank(client, proposed.spec ?? DEFAULT_CLAIM_SPEC, { assignee })}
      LIMIT ${cap}
    `) as ClaimSpecDeltaSqlRow[];

    const num = (v: number | string | null | undefined) => (v == null ? 0 : Number(v));
    const newlyExcludedCount = num(counts?.newly_excluded);
    const newlyAdmittedCount = num(counts?.newly_admitted);
    return {
      currentClaimable: num(counts?.current_claimable),
      proposedClaimable: num(counts?.proposed_claimable),
      retained: num(counts?.retained),
      newlyExcludedCount,
      newlyAdmittedCount,
      newlyExcluded: excludedRows.map((r) => projectDeltaRow(r, 'excluded')),
      newlyAdmitted: admittedRows.map((r) => projectDeltaRow(r, 'admitted')),
      truncated: {
        newlyExcluded: newlyExcludedCount > excludedRows.length,
        newlyAdmitted: newlyAdmittedCount > admittedRows.length,
      },
    };
  })) as ClaimSpecDeltaReading;
}

/** The delta query's row. The `delta_`-prefixed aliases exist because the query projects
 *  `SELECT *` (so compileRank can reach every base column) and several natural names —
 *  `kind`, `severity` — collide with base columns whose values are NOT the resolved ones. */
export interface ClaimSpecDeltaSqlRow {
  delta_id: string;
  delta_kind: string;
  title: string | null;
  status: string;
  delta_origin: string | null;
  delta_severity: string | null;
  delta_plan: string | null;
  feature_order: number | string | null;
  created_ts: number | string | null;
  spec_match: boolean;
  proposed_match: boolean;
  status_in_current: boolean;
  status_in_proposed: boolean;
  delta_dependency_unlock_score?: number | string | null;
}

/**
 * Attribute a moved row to the filter, the states, or both — and project it to the same
 * lean shape {@link listIssueClaimableRows} returns, so a caller reading a delta row and a
 * claimable row side by side sees one shape.
 *
 * A row is only ever passed here when it moved, so its floors passed on the side it was on;
 * the move therefore decomposes exactly into the two spec-settable dimensions.
 *
 * Exported for the unit test: the attribution is the part of this feature a reader ACTS on
 * (a `states` cause and a `filter` cause have entirely different fixes), and it is pure.
 */
export function projectDeltaRow(r: ClaimSpecDeltaSqlRow, side: 'excluded' | 'admitted'): ClaimSpecDeltaRow {
  const byFilter = side === 'excluded' ? r.spec_match && !r.proposed_match : r.proposed_match && !r.spec_match;
  const byStates =
    side === 'excluded' ? r.status_in_current && !r.status_in_proposed : r.status_in_proposed && !r.status_in_current;
  return {
    id: r.delta_id,
    kind: r.delta_kind,
    title: r.title,
    status: r.status,
    origin: r.delta_origin ?? null,
    severity: r.delta_severity,
    plan: r.delta_plan,
    featureOrder: r.feature_order == null ? null : Number(r.feature_order),
    createdTs: r.created_ts == null ? null : Number(r.created_ts),
    dependencyUnlockScore: r.delta_dependency_unlock_score == null ? null : Number(r.delta_dependency_unlock_score),
    cause: byFilter && byStates ? 'both' : byStates ? 'states' : 'filter',
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Rank compiler — spec.rank → an ORDER BY fragment.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Compile a single rank term's EXPRESSION to a sortable `sql` value, ignoring its
 * direction (the caller appends ASC/DESC). Returns null when the term is a NEUTRAL
 * (descoped) function — the caller drops it from the ORDER BY so it doesn't perturb
 * (feature_order) flags the caller to flip the direction.
 */
function dependencyUnlockScoreSql(sql: OrgSql): SqlFragment {
  return sql`harness_shared.work_item_dependency_unlock_score(
    workspace_id,
    harness_slug,
    feature_id,
    COALESCE(item_kind, kind)
  )`;
}

/**
 * P-008's assignment-ready resolver-cluster projection. The resolver writes a
 * JSON number once; claim paths only read it. Guard the cast by JSON type so a
 * malformed/legacy payload degrades to the neutral score 0 instead of aborting
 * the fleet's claim query.
 */
function clusterPrioritySql(sql: OrgSql): SqlFragment {
  return sql`CASE
    WHEN jsonb_typeof(payload->'clusterPriority') = 'number'
      THEN GREATEST((payload->>'clusterPriority')::numeric, 0::numeric)
    ELSE 0::numeric
  END`;
}

function specUsesRankTerm(spec: ClaimSpec, head: string): boolean {
  return spec.rank.terms.some((term) => {
    const exprHead = term.expr.includes('(') ? term.expr.slice(0, term.expr.indexOf('(')).trim() : term.expr.trim();
    return exprHead === head;
  });
}

function compileRankExpr(
  sql: OrgSql,
  expr: string,
  bee: BeeContext,
): { value: SqlFragment; inverted: boolean; numeric: boolean } | null {
  const head = expr.includes('(') ? expr.slice(0, expr.indexOf('(')).trim() : expr.trim();

  // Live function term: affinity(bee.held_paths, item.paths) — count of item paths that
  // share a directory-prefix relationship with any path the bee already holds.
  if (head === 'affinity') {
    const held = (bee.heldPaths ?? []).filter((p) => typeof p === 'string' && p.length > 0);
    // No held paths ⇒ affinity is a constant for every row, so it can't reorder
    // anything: drop it from the ORDER BY (NEUTRAL). This also keeps the DEFAULT spec's
    // affinity term from emitting a bare `0` that PG would mis-read as a column position.
    if (held.length === 0) return null;
    // For each held path, count item paths where one is a prefix of the other. Bound the
    // held paths as a text[] parameter — never interpolated.
    return {
      value: sql`(
        SELECT count(*) FROM jsonb_array_elements_text(COALESCE(payload->'paths', '[]'::jsonb)) ip
         WHERE EXISTS (
           SELECT 1 FROM unnest(${held}::text[]) hp
            WHERE ip LIKE hp || '%' OR hp LIKE ip || '%'
         )
      )`,
      inverted: false,
      // A count() — numerically summable, so it may contribute to a weighted rank.
      numeric: true,
    };
  }

  // Ordinal severity term (EI-19286355119013384) — the supported way to order by severity,
  // and the reason the bare `severity` field stays out of RANKABLE_ITEM_FIELDS. Severity is
  // TEXT, so a bare `severity desc` sorts LEXICALLY (nit > minor > major > critical, exactly
  // backwards); this CASE gives it a real ordinal so `severity_rank desc` means what it reads
  // as. Uses the SAME accessor precedence as the `severity` filter above (payload._ei first,
  // then top-level) — the two MUST agree or a spec would rank on one source and filter on
  // another. An absent/unrecognized severity sorts LAST (0) rather than NULL, so it can never
  // outrank a real one; on the feature-family relation, where severity is structurally
  // absent, every row scores 0 — a clean no-op, never an error.
  if (head === 'severity_rank') {
    return {
      value: sql`CASE COALESCE(payload->'_ei'->>'severity', payload->>'severity')
        WHEN 'critical' THEN 4
        WHEN 'major' THEN 3
        WHEN 'minor' THEN 2
        WHEN 'nit' THEN 1
        ELSE 0
      END`,
      inverted: false,
      // A CASE over integer literals — casts cleanly to ::numeric, so unlike the bare
      // `severity` field this is safe to sum in a weighted rank.
      numeric: true,
    };
  }

  // One-hop dependency leverage (work-item-deps-and-readiness Phase 5). The SQL function
  // consumes only stable row identity columns, so this fragment stays alias-agnostic across
  // feature tiers, issue tier 3, claimability reads and delta previews. It counts ONLY
  // downstream rows for which this candidate is the last unresolved blocker; descendant
  // centrality would over-credit work that remains blocked after the candidate completes.
  if (head === 'dependency_unlock_score') {
    return {
      value: dependencyUnlockScoreSql(sql),
      inverted: false,
      numeric: true,
    };
  }

  // Resolver-cluster leverage (silent-intake-central-resolution P-008). This
  // intentionally does not inspect coord links or derive clusters: P-007 owns
  // that intelligence and stamps payload.clusterPriority on roots + members.
  if (head === 'cluster_priority') {
    return {
      value: clusterPrioritySql(sql),
      inverted: false,
      numeric: true,
    };
  }

  // Descoped-but-validated function terms (D-010) ⇒ NEUTRAL: kept in the vocabulary so
  // specs referencing them validate, but they don't reorder until their lanes ship.
  if (head === 'model_fit' || head === 'tag_weight' || head === 'redundancy_need') {
    return null;
  }

  // Bare item field.
  const fm = FIELD_MAP[head];
  if (!fm) return null; // unreachable for a validated spec; defensively neutral
  // `numeric` gates weighted-mode participation ONLY: a weighted rank casts each term to
  // ::numeric, which on a text/array/jsonb column is a hard PG error that aborts the claim
  // query (measured: text[] ⇒ "cannot cast type text[] to numeric"; item_kind ⇒ "invalid
  // input syntax for type numeric: \"feature\""). The validator now rejects that spec shape
  // up front (claim-spec.ts NUMERIC_ITEM_FIELDS); this flag is the defense-in-depth leg, so
  // a spec stored BEFORE that rule degrades to a neutral term instead of wedging the lane.
  // Lexicographic ordering is unaffected — ORDER BY on a text column is well-defined there.
  return { value: fm.col(sql), inverted: fm.inverted ?? false, numeric: fm.kind === 'scalar-num' };
}

/**
 * Compile `spec.rank` to an ORDER BY `sql` fragment. `lexicographic` ⇒ each term is a
 * hard precedence (term 1, then term 2, …). `weighted` ⇒ a single Σ wᵢ·termᵢ sort key
 * (only numeric terms contribute; affinity/feature_order are numeric). NULLs sort LAST
 * (a NULL feature_order = unprioritized = claimed after prioritized work, matching the
 * legacy `feature_order ASC NULLS LAST`). A trailing `created_ts ASC` tiebreaker makes
 * the order TOTAL ⇒ the resolver is deterministic for a fixed DAG + spec.
 */
export function compileRank(sql: OrgSql, spec: ClaimSpec, bee: BeeContext) {
  const terms = spec.rank.terms;

  // Fleet-member DX P-015: put a SOFT live-lock conflict bit ahead of the authored
  // rank. This is placement affinity, not admission: an item with incomplete/no path
  // metadata scores zero (no invented conflict), and a known-conflicting item remains
  // selectable when no independent candidate exists. The input is a bounded snapshot
  // taken by scheduler:get_next immediately before the atomic claim; every later pull
  // re-reads the lock plane, so release automatically restores the normal rank.
  const contended = (bee.contendedPaths ?? [])
    .filter((p) => typeof p === 'string' && p.trim().length > 0)
    .map((p) => p.trim())
    .slice(0, 500);
  const withLockPlacement = (base: SqlFragment): SqlFragment => {
    if (contended.length === 0) return base;
    const conflict = sql`CASE WHEN EXISTS (
      SELECT 1
        FROM jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(payload->'paths') = 'array'
            THEN payload->'paths'
            ELSE '[]'::jsonb
          END
        ) ip
       WHERE EXISTS (
         SELECT 1 FROM unnest(${contended}::text[]) lp
          WHERE ip = lp
             OR strpos(ip, rtrim(lp, '/') || '/') = 1
             OR strpos(lp, rtrim(ip, '/') || '/') = 1
       )
    ) THEN 1 ELSE 0 END`;
    return sql`${conflict} ASC, ${base}`;
  };

  if (spec.rank.mode === 'weighted') {
    // Σ wᵢ·termᵢ — only terms that compile to a numeric value contribute, which this
    // now ENFORCES rather than merely asserting: a non-numeric term is dropped here
    // instead of reaching the `::numeric` cast below, where it would be a hard PG error
    // that aborts the entire claim query (see compileRankExpr's `numeric`). An inverted
    // field is negated (so "more important" is a LARGER contribution). Sort DESC of the
    // weighted sum = best-first; then the deterministic tiebreaker.
    const contribs = terms
      .map((t) => {
        const compiled = compileRankExpr(sql, t.expr, bee);
        if (!compiled || !compiled.numeric) return null;
        const w = Number.isFinite(t.weight) ? (t.weight as number) : 0;
        const signed = compiled.inverted
          ? sql`(-1 * COALESCE((${compiled.value})::numeric, 0))`
          : sql`COALESCE((${compiled.value})::numeric, 0)`;
        // A `dir: 'asc'` weighted term contributes with a flipped sign (smaller = better).
        const dirSign = t.dir === 'asc' ? sql`(-1 * ${signed})` : signed;
        return sql`(${w} * ${dirSign})`;
      })
      .filter((c): c is SqlFragment => c != null);
    if (contribs.length === 0) return withLockPlacement(sql`created_ts ASC`);
    const sum = contribs.reduce((acc, c) => sql`${acc} + ${c}`);
    return withLockPlacement(sql`(${sum}) DESC, created_ts ASC`);
  }

  // lexicographic: each term ASC/DESC in order, then the total-order tiebreaker.
  const orderings = terms.map((t) => compileTermOrdering(sql, t, bee)).filter((o): o is SqlFragment => o != null);
  if (orderings.length === 0) return withLockPlacement(sql`created_ts ASC`);
  const joined = orderings.reduce((acc, o) => sql`${acc}, ${o}`);
  // created_ts ASC as the final tiebreaker (skip if already the last bare term).
  return withLockPlacement(sql`${joined}, created_ts ASC`);
}

/** One lexicographic term → `<col> ASC|DESC NULLS LAST`, honoring inversion. */
function compileTermOrdering(sql: OrgSql, term: RankTerm, bee: BeeContext): SqlFragment | null {
  const compiled = compileRankExpr(sql, term.expr, bee);
  if (!compiled) return null;
  // An inverted field flips the effective direction: spec `priority desc` ("highest
  // first") ⇒ feature_order ASC.
  const effectiveDesc = compiled.inverted ? term.dir === 'asc' : term.dir === 'desc';
  return effectiveDesc ? sql`${compiled.value} DESC NULLS LAST` : sql`${compiled.value} ASC NULLS LAST`;
}

// ────────────────────────────────────────────────────────────────────────────
// The resolver.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Deterministically claim the next eligible work-item for a bee under its validated
 * claim spec. Atomic: `UPDATE … WHERE (pk) = (SELECT … floors AND filter ORDER BY rank
 * LIMIT 1 FOR UPDATE SKIP LOCKED)`, so two concurrent `get_next` calls claim DIFFERENT
 * items (SKIP LOCKED) and a floored-out item is NEVER claimed even if the spec filter
 * would select it.
 *
 * Returns the claimed item + the spec revision that selected it (provenance), or null
 * when nothing is eligible.
 *
 * PRECONDITION: `spec` is VALIDATED (`validateClaimSpec(spec).ok === true`). The field/
 * op/rank-term vocabulary is closed by the validator, so the compiled SQL is safe; this
 * function does NOT re-validate (the caller — the launch handoff / `set_claim_spec` —
 * validates before persisting the spec on the bee).
 */
export async function getNextWorkItem(
  spec: ClaimSpec,
  bee: BeeContext,
  opts: GetNextOpts,
): Promise<GetNextResult | null> {
  const sql = opts.client ?? getOrgPg().sql;
  // WI-5261: prefer the caller's explicitly-resolved workspace (threaded via opts.workspaceId)
  // over re-deriving it here — activeWorkspaceId() depends on the AsyncLocalStorage request
  // scope still being intact at this exact point in the async call chain (tool handler ->
  // getNextForBee -> here -> tier 3's claimNextIssueWorkItem), several awaits deep. Falls back
  // to the legacy activeWorkspaceId() when omitted (unchanged behavior for other callers).
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const useMaintainedReady = await schedulerMaintainedReadyEnabled();
  const operationClaims = await import('../blueprint/operation-worker-binding');
  const operationClaimRead = await operationClaims.readActiveOperationWorkerClaimBinding(ws, bee.assignee);
  if (operationClaimRead.status === 'unavailable') {
    throw new Error(`operation claim authority unavailable: ${operationClaimRead.reason}`);
  }

  // drain-claim-spec-hardening-2026-07-13 D-002 (fixes EI-11300): `states` is drain-wide
  // POLICY, so it rides the SPEC — a per-call `opts.states` (the caller's explicit
  // override) still WINS; only when the caller omits one do we fall back to the spec's
  // `states` (set once by the fleet leader / queen via scheduler:set_claim_spec, inherited
  // by every member); neither present ⇒ claimFloorsWhereSql's own `['todo']` default.
  const effectiveStates = opts.states ?? spec.states;
  const claimSpecReferencesFleet = claimSpecReferencesField(spec, 'fleet');
  // EI-21398324268952860: the same authorization read for the GOAL field. A per-goal standing
  // drain fleet scopes its spec by `{ field:'goal', op:'=', value:<goalId> }` (claim-spec.ts
  // ITEM_FIELDS `goal`), and its own steward mints plan-stamped work FOR it — which the
  // plan-lane floor then reserved away from the only fleet entitled to it
  // (`matchedByFilter=7, claimable=0, planLaneReserved=7`, drain stalled fleet-wide).
  const claimSpecReferencesGoal = claimSpecReferencesField(spec, 'goal');

  const floorOpts = {
    harness: opts.harness,
    workspaceId: ws,
    states: effectiveStates,
    swarmId: opts.swarmId,
    excludeRedundant: opts.excludeRedundant,
    useMaintainedReady,
    // Release-cooldown floor (P-005 / EI-6956): a row THIS bee just released is
    // excluded for it (and only it) for the cooldown window — no claim/release
    // ping-pong under a stable rank.
    cooldownAssignee: bee.assignee,
    // EI-14806: the cross-machine-rig floor now applies to the FEATURE family too (tiers 1/2
    // query this fragment). Omitted/false ⇒ a payload.needs_2_machine_rig feature is excluded
    // for a single-box caller, matching the issue-family tier-3 floor (claimNextIssueWorkItem).
    rigAvailable: opts.rigAvailable,
    claimantFleetSlug: opts.fleetSlug,
    claimSpecReferencesFleet,
    claimSpecReferencesGoal,
  };

  // EI-18805386252364731: the claim query runs on the `harness_admin` pool, which carries a
  // role-default lock_timeout but DELIBERATELY NO statement_timeout (migrations share it and
  // must run unbounded). An over-cost claim spec therefore did not fail — it HUNG, until the
  // MCP client transport gave up minutes later, and a JS-side AbortController cannot rescue it
  // because postgres-js does not cancel an in-flight query. The member then reads a pull that
  // never returned as "the lane is drained" and parks, while the lane is in fact full.
  //
  // So every attempt runs inside a BOUNDED txn, and the whole ladder shares ONE budget: a spec
  // too expensive to decide now surfaces as a typed OrgTxnTimeoutError the tool reports, never
  // as a drain-shaped `null`. Bounding each attempt alone would not be enough — the ladder runs
  // this query up to three tiers plus a release-and-retry loop, so N individually-affordable
  // attempts can still sum past any caller's patience.
  const ladderBudgetMs = opts.claimBudgetMs ?? CLAIM_LADDER_BUDGET_MS;
  const ladderDeadline = Date.now() + ladderBudgetMs;

  // EI-21288979130080074: prepare the issue-family narrowing once so the optional
  // cross-family priority preclaim and the existing tier-3 fallback use the same
  // issue floors/filter/rank. The feature-side comparator uses the widened feature
  // view because the ladder may fall through tier 2 before tier 3.
  const widened = widenPastKind(spec.view.filter);
  const issueKinds = issueKindsForFallback(spec.view.filter);
  const idValues = positiveIdCohortIds(spec.view.filter) ?? undefined;
  const excludeIds = negativeIdExclusions(spec.view.filter);
  const specFilterSql = compileFilter(sql, stripFeatureOnlyKindLeaves(spec.view.filter));
  const specOrderSql = compileRank(sql, spec, bee);
  const featurePriorityFilterSql = sql`${compileFilter(sql, widened)} AND
    ${operationClaims.operationWorkerClaimWhereSql(sql, operationClaimRead, {
      payload: 'payload', id: 'feature_id', harness: 'harness_slug',
    })}`;
  const claimIssue = (priorityBeforeFeature?: boolean) =>
    claimNextIssueWorkItem(
      {
        harness: opts.harness,
        assignee: bee.assignee,
        states: effectiveStates,
        swarmId: opts.swarmId,
        excludeRedundant: opts.excludeRedundant,
        rigAvailable: opts.rigAvailable,
        claimantFleetSlug: opts.fleetSlug,
        claimSpecReferencesFleet,
        claimSpecReferencesGoal,
      },
      ws,
      {
        client: sql,
        signal: opts.signal,
        issueKinds,
        ids: idValues,
        excludeIds: excludeIds.length ? excludeIds : undefined,
        specFilterSql,
        specOrderSql,
        ...(priorityBeforeFeature
          ? {
              priorityBeforeFeature: {
                featureFilterSql: featurePriorityFilterSql,
                useMaintainedReady,
              },
            }
          : {}),
      },
    );

  // The normal ladder is feature-first, but an issue with an explicit priority may
  // atomically preclaim before it when it is strictly better than every eligible
  // feature candidate. Specs without a priority term retain the legacy family order.
  const hasPriorityRank = spec.rank.terms.some((term) => term.expr === 'priority');
  let issuesClaimable: boolean | undefined;
  const issueClaimsEnabled = async () => {
    if (issuesClaimable === undefined) issuesClaimable = await schedulerIssuesClaimableEnabled();
    return issuesClaimable;
  };

  /** One attempt at the compiled query under a given (possibly widened) filter node. */
  const attempt = async (filterNode: FilterNode | undefined): Promise<WorkItem | null> => {
    const remainingMs = ladderDeadline - Date.now();
    if (remainingMs <= 0) {
      // The budget is gone. Report it as the same typed contention error a per-statement
      // timeout raises — the caller must never mistake this for "nothing matched".
      throw new OrgTxnTimeoutError(
        '57014',
        new Error('claim ladder budget exhausted'),
        'the scheduler claim ladder ran out of its own wall-clock budget',
        'caller-budget',
      );
    }
    const rows = await boundedOrgTxn(
      async (tx) => {
        // Compile against the TRANSACTION client so the fragments belong to the connection
        // that carries the SET LOCAL statement_timeout.
        const floors = claimFloorsWhereSql(tx, floorOpts);
        const order = compileRank(tx, spec, bee);
        const filter = compileFilter(tx, filterNode);
        const rows = await tx<FeatureRowDb[]>`
      UPDATE harness_shared.harness_features_consolidated
         SET taken_by = ${bee.assignee}, taken_at = now(), last_progress_at = NULL, updated_ts = ${Date.now()}
       WHERE (harness_slug, feature_id) = (
         SELECT harness_slug, feature_id
           FROM harness_shared.harness_features_consolidated
          WHERE ${floors}
            AND ${operationClaims.operationWorkerClaimWhereSql(tx, operationClaimRead, {
              payload: 'payload', id: 'feature_id', harness: 'harness_slug',
            })}
            AND ${filter}
          ORDER BY ${order}
          LIMIT 1
          FOR UPDATE SKIP LOCKED
       )
      RETURNING ${tx.unsafe(FEATURE_COLS)}`;
        if (!rows[0]) return rows;
        return (await guardPlanItemSiblingClaim(tx, rows[0], {
          workspaceId: ws,
          assignee: bee.assignee,
          family: 'feature',
        }))
          ? rows
          : [];
      },
      {
        client: sql,
        signal: opts.signal,
        statementTimeoutMs: Math.min(remainingMs, ladderBudgetMs, CLAIM_ATTEMPT_BUDGET_MS),
      },
    );
    return rows[0] ? featureRowToWorkItem(rows[0]) : null;
  };

  // Priority preclaim: this is the only issue-family path that runs before the
  // feature tiers. Equal/worse priorities return null here and preserve feature-first.
  let claimed: WorkItem | null = null;
  if (hasPriorityRank && (await issueClaimsEnabled())) {
    claimed = await claimIssue(true);
  }

  // Tier 1: the spec's view exactly as authored.
  if (!claimed) claimed = await attempt(spec.view.filter);

  // Tier 2 (fallback-ladder P-005, fleet-backlog-lessons-2026-07-01, WI-1407): a spec that
  // narrowed to one feature-family `kind` and drained it must not exit — widen to the REST
  // of the feature family (dropping just the `kind` leaf, keeping every other narrowing —
  // plan/tags/risk_tier/etc — intact) before reporting a miss. `widenPastKind` only rewrites
  // shapes it can simplify safely (a bare leaf or one inside a top-level `all`); when it can't
  // (kind nested in an `any`/`not`), it hands back the SAME node and this tier is a no-op.
  if (!claimed && widened !== spec.view.filter) {
    claimed = await attempt(widened);
  }

  // Tier 3 (SCHEDULER_ISSUES_CLAIMABLE, owner-authority-gated): the whole feature family the
  // spec can see is exhausted — widen to the adjacent ISSUE family too, the SAME additive
  // fallback `claimNextWorkItem` (work-items.ts) applies, so the two claim paths never drift
  // on WHERE the ladder bottoms out. Most feature-family filters still have no issue-family
  // vocabulary, so they preserve WI-1407's unrestricted adjacent-issue fallback. Explicit
  // issue-kind filters are different: carry that lane constraint across so a bug/change fleet
  // does not claim a reserved task.
  //
  // EI-10062: an explicit `id`-allowlist spec has NO `kind` leaf for issueKindsForFallback to
  // find, so it read as "no lane constraint" and this tier claimed ANY open issue-family row —
  // not just the named ids. An id-allowlist is a closed-world set with no wider family to
  // widen into.
  //
  // WI-4309: EI-10062's original fix skipped tier 3 ENTIRELY whenever an id constraint was
  // present — which meant an issue-only id-allowlist spec (e.g. a leader's hand-curated
  // bug-drain wave of EI-/WI- ids, no `kind` leaf) could NEVER be served by get_next, even
  // while its named items sat open+unclaimed: tier 1 only queries the feature-family table
  // and structurally can't match an issue-family id, and tier 2 is a no-op with no `kind`
  // leaf to widen — so with tier 3 also skipped, the ladder had NO path left for such a spec
  // and always reported a false drain. Fix: extract the literal id set (when the shape allows
  // it — positiveIdCohortIds) and THREAD it through tier 3 so it narrows to exactly those ids,
  // instead of either ignoring the constraint (the original leak) or refusing to run at all.
  //
  // WI-5275 (live incident, 2026-07-17, backlog-drain-clean@12): the "when it can't be safely
  // extracted, skip tier 3 entirely" fallback above was ITSELF the bug, not just a conservative
  // edge case. It fires whenever an `id` leaf appears ANYWHERE in the tree (formerly detected by
  // the now-removed `filterHasIdConstraint`, which recursed into `any`) — but an id leaf reached
  // through a positive `any` (OR) branch does NOT establish a closed-world identity set at all:
  // `id in [...] OR <broad-condition>` WIDENS admission (admits strictly MORE than
  // <broad-condition> alone), it never narrows it. The live fleet spec here was exactly this
  // shape — `any: [{id in [WI-5270, WI-5272]}, {not: <p2p-title exclusion>}]`, ANDed with a
  // `kind in [bug,change,task,feature]` leaf — a normal, wide-open drain-spec pinning two extra
  // ids as a widening exception. Because the id leaf could not be *safely extracted* from that
  // `any` (positiveIdCohortIds correctly refuses to guess), the old code treated "can't extract"
  // as "conservatively skip tier 3 altogether" — which meant tier 3 (the ONLY path that serves
  // bug/change/task work; the feature-family tiers 1/2 structurally cannot see issue-family rows)
  // NEVER ran for this spec, permanently starving the WHOLE fleet of its entire non-p2p
  // bug/change/task backlog (hundreds of genuinely admissible, unclaimed items) while
  // scheduler:get_next kept reporting a clean drain.
  //
  // Fix: stop gating tier 3 on "does an id leaf exist anywhere". Just narrow by `ids` whenever
  // positiveIdCohortIds can SAFELY extract a genuine closed-world set (bare leaf, or ANDed at
  // the top level via `all` — unchanged, still exactly EI-10062/WI-4309's guarantee); otherwise
  // run tier 3 UNRESTRICTED by id (kind-narrowed when issueKindsForFallback can extract one) and
  // rely on the SAME safety net a no-id-leaf spec already depends on: getNextForBee's mandatory
  // post-claim `matchesWorkItemClaimSpec` re-check against the FULL filter tree (which correctly
  // evaluates `any`/`not` OR/NOT semantics, unlike this SQL-side narrowing) + its bounded
  // release-and-retry loop. This can never violate a genuine closed-world allowlist (that shape
  // is still always safely extracted and threaded through), and it can never serve a
  // spec-violating item (the post-claim check releases and retries) — it only stops the
  // ENTIRE-lane starvation that a merely-inconvenient-to-extract id leaf used to cause.
  if (!claimed && (await schedulerIssuesClaimableEnabled())) {
    const idValues = positiveIdCohortIds(spec.view.filter) ?? undefined;
    const issueKinds = issueKindsForFallback(spec.view.filter);
    // WI-5258: a positive allowlist (idValues) and a negative exclusion are mutually
    // exclusive in practice (a spec that already names a closed-world positive set has
    // nothing left to additionally exclude), but thread both regardless — the query
    // ANDs them, so an empty excludeIds is simply a no-op.
    const excludeIds = negativeIdExclusions(spec.view.filter);
    // Compile the FULL filter tree (correct `any`/`not` semantics, paths/plan/title/tags —
    // everything the id/kind extraction above structurally cannot express) and hand it to
    // the claim query, so tier 3 atomically claims a SPEC-MATCHING row on the first attempt
    // instead of claiming a violator and depending on claim-spec-store.ts's post-claim
    // release-and-retry to bounce it. That retry shares MAX_PLAN_LANE_ATTEMPTS (5) with the
    // plan-lane-blocked path; for a narrow lane (measured: 26 spec-matching of 1073
    // lane-wide claimable on p2p-release-lane@9 = 2.4%) five draws almost never land a
    // match, so get_next reported a FALSE drain on ~88% of pulls while
    // work_items:claimable — which already compiles this same filter via
    // issueClaimCandidateSubquery — correctly reported 26 claimable. This is the line that
    // re-unifies the CLAIM path with the READ path. The post-claim re-check remains as
    // defense-in-depth (and still covers topicTags, which is not a SQL-side field).
    //
    // EI-18665895916759270: compile the filter with the FEATURE-ONLY `kind` leaves stripped
    // (stripFeatureOnlyKindLeaves — see its doc comment). This query runs over
    // `harness_shared.work_items`, where every row is bug/change/task, so a surviving
    // `kind = 'feature'` leaf would compile to an unsatisfiable predicate and zero out the
    // ONLY tier that serves issue-family work — silently re-breaking WI-1407's "feature
    // family dry ⇒ fall through to an adjacent open issue" contract. Widening past exactly
    // that leaf is what tier 3 IS; every other narrowing (including an issue-kind lane
    // constraint) still compiles through.
    // EI-18805386252364731: do not ENTER tier 3 with the ladder budget already spent — tiers 1/2
    // may have consumed it. This bounds tier-3 ENTRY only: `claimNextIssueWorkItem` still runs
    // its own queries on the raw unbounded `harness_admin` pool, so a stall INSIDE it is not yet
    // rescued (JS cannot cancel an in-flight postgres-js query). Tracked separately — see the
    // residual noted on this item; do not read this line as the issue-family path being bounded.
    if (Date.now() >= ladderDeadline) {
      throw new OrgTxnTimeoutError(
        '57014',
        new Error('claim ladder budget exhausted before tier 3'),
        'the scheduler claim ladder ran out of its own wall-clock budget before tier 3',
        'caller-budget',
      );
    }
    const specFilterSql = compileFilter(sql, stripFeatureOnlyKindLeaves(spec.view.filter));
    // EI-19497592871345016: thread the spec's compiled RANK down too, not just its filter.
    // Tier 3 is the ONLY tier the issue family ever reaches (tiers 1/2 query the
    // feature-family table), so without this every bug/change/task claim ignored spec.rank
    // and fell back to a hardcoded oldest-first — while get_next still stamped the spec as
    // the selecting provenance. Compiled against the outer `sql` for consistency with
    // `specFilterSql` directly above, which has always been compiled here and used inside
    // claimNextIssueWorkItem's own bounded txn.
    const specOrderSql = compileRank(sql, spec, bee);
    claimed = await claimNextIssueWorkItem(
      {
        harness: opts.harness,
        assignee: bee.assignee,
        states: effectiveStates,
        swarmId: opts.swarmId,
        excludeRedundant: opts.excludeRedundant,
        rigAvailable: opts.rigAvailable,
        claimantFleetSlug: opts.fleetSlug,
        claimSpecReferencesFleet,
        claimSpecReferencesGoal,
      },
      ws,
      {
        client: sql,
        signal: opts.signal,
        issueKinds,
        ids: idValues,
        excludeIds: excludeIds.length ? excludeIds : undefined,
        specFilterSql,
        specOrderSql,
      },
    );
  }

  if (!claimed) return null;
  claimed.interestWatch = await armWorkItemHolderInterests(claimed, bee.assignee);
  // Same claimed-event as the legacy claim path (best-effort fanout).
  void trackDetached(import('../work-items-events'))
    .then((m) => m.emitWorkItemClaimedEvent(claimed!, bee.assignee))
    .catch(() => {});
  return { workItem: claimed, claimedUnder: { specId: spec.specId, revision: spec.revision } };
}

/** Convenience: claim under the baseline spec (no spec = today's ordering, D-003). */
export function getNextWorkItemDefault(bee: BeeContext, opts: GetNextOpts): Promise<GetNextResult | null> {
  return getNextWorkItem(DEFAULT_CLAIM_SPEC, bee, opts);
}
