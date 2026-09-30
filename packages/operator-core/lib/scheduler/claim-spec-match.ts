/**
 * Pure claim-spec predicate evaluation for assignment-admission checks.
 *
 * The atomic scheduler compiles feature-family filters to SQL. Assignment seams
 * also need to answer the inverse question for one already-known (or not-yet-
 * created) item: "would this target member's spec admit this item?" Keeping the
 * evaluator here gives by-id claims, create+assign, plan-item dispatch, and the
 * issue-family fallback one shared decision instead of four approximations.
 */
import type { WorkItem } from '../work-items';
import type { ClaimSpec, FilterLeaf, FilterNode } from './claim-spec';

export interface ClaimSpecSubject {
  id: string | null;
  title: string | null;
  /** EI-20240035377782004: the work-item summary/body text — see FIELD_MAP.summary. */
  summary: string | null;
  kind: string | null;
  priority: number | null;
  tags: string[];
  paths: string[];
  plan: string | null;
  planItem: string[];
  /** EI-13524: fleet lane stamp (`payload.fleet_slug`), or null when unstamped. */
  fleet: string | null;
  /**
   * EI-16052: improvement-triage decision (`payload.ideaLifecycle.triageDecision` —
   * 'place'|'gate'|'gym'|'reject'), or null when the row was never triaged. 'gate' marks a
   * HUMAN gate: a design draft or an owner is required before implementation.
   */
  triageGate: string | null;
  age: number | null;
  riskTier: string | null;
  redundancy: number | null;
  estCost: number | null;
  assignee: string | null;
  /** WI-6675: issue-family severity (critical|major|minor|nit), or null when unset. */
  severity: string | null;
  /** WI-37711: the goal this item was filed under (`work_items.goal_id`), or null when unstamped. */
  goal: string | null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function finiteNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * Derive the plan slug an item belongs to from its payload, single-sourced so
 * every consumer (the spec subject below, the `work-item:claimable` event
 * payload — EI-15185) agrees on the exact same derivation. Returns null when the
 * item is plan-less.
 */
export function planSlugOfWorkItem(item: WorkItem): string | null {
  const payload = record(item.payload);
  // WI-5832 / EI-18666217180294576 follow-up (confirmed by direct code read against
  // plan-items/convert.ts, NOT hypothetical): scheduled-recurring-plans (D-016) mint a
  // plan-RUN work-item with `sourcePlanSlug: opts.planRun?.templateSlug ?? opts.planSlug`
  // (written to the `source_plan_slug` COLUMN, which the SQL FIELD_MAP.plan compiler
  // reads FIRST) while `payload.plan_item.plan_slug` gets the RUN's own (different)
  // slug — the two are DELIBERATELY distinct identities by design, not a data bug. This
  // evaluator used to fall through to `plan_item.plan_slug` without ever considering
  // `payload.plan_run`, so on any plan-run item a `plan = '<template slug>'` claim-spec
  // matched via the SQL admission path (get-next.ts, reads the column) but NOT via this
  // JS evaluator (work_items:claim / by-id admission / the work-item:claimable event
  // payload) — a real split-brain the moment the first scheduled-recurring plan fires
  // (none has yet in production, which is why this was still dormant). Check
  // `payload.plan_run.templateSlug` FIRST so both evaluators agree on the STABLE
  // template identity for a plan-run item, exactly mirroring the column's write-time
  // derivation above.
  // WI-38326: the COLUMN itself, now that the projection carries it — FIELD_MAP's FIRST
  // COALESCE leg, so this is the one ordering that mirrors SQL rather than approximating it.
  //
  // Note what this does to the `plan_run` check below: that leg was only ever a PROXY for this
  // column. WI-5832 could not read `source_plan_slug`, so it reconstructed the value from the
  // payload the column was WRITTEN from (`planRun?.templateSlug ?? planSlug`). Reading the
  // column directly subsumes it — and is strictly better, because a row whose column and
  // payload disagree (a rehome, a hand-edit, a backfill) now resolves the way SQL resolves it
  // instead of the way the payload predicts it should have been written.
  //
  // The proxy STAYS as the next leg, and deleting it would be a regression: the issue-family
  // projection does not carry this column (the `engineer_issues` view exposes none of the five
  // — see WI-38326's follow-up), so for those rows `sourcePlanSlug` is undefined and WI-5832's
  // fix must still govern.
  if (typeof item.sourcePlanSlug === 'string' && item.sourcePlanSlug) return item.sourcePlanSlug;
  const planRun = record(payload.plan_run);
  if (typeof planRun.templateSlug === 'string' && planRun.templateSlug) return planRun.templateSlug;
  const planItem = record(payload.plan_item ?? payload.planItem);
  return (
    (typeof planItem.plan_slug === 'string' && planItem.plan_slug) ||
    (typeof planItem.slug === 'string' && planItem.slug) ||
    (typeof payload.source_plan_slug === 'string' && payload.source_plan_slug) ||
    null
  );
}

/**
 * Derive the item's own STATIC `payload.tags` (never the viewer-relative
 * `topicTags` a caller may merge in on top) — single-sourced so the spec
 * subject below AND the `work-item:claimable` event payload (EI-14161) agree
 * on exactly the same tag set. Returns `[]` when the item carries no tags.
 */
export function staticTagsOfWorkItem(item: WorkItem): string[] {
  // WI-38326: mirror FIELD_MAP's `COALESCE(tags, payload->'tags')` — COLUMN first, payload
  // second. `item.tags` is undefined for a family whose projection does not carry the column
  // (issue-family today), which must fall through to the payload leg; a column that is present
  // but empty is a real answer and does NOT fall through, exactly as COALESCE treats '[]'.
  if (item.tags != null) return item.tags.filter((t) => typeof t === 'string');
  return strings(record(item.payload).tags);
}

/** Project the fields available on an issue-family WorkItem into spec vocabulary. */
export function claimSpecSubjectFromWorkItem(item: WorkItem, topicTags: string[] = []): ClaimSpecSubject {
  const payload = record(item.payload);
  const planItem = record(payload.plan_item ?? payload.planItem);
  const plan = planSlugOfWorkItem(item);
  const itemId =
    (typeof planItem.item_id === 'string' && planItem.item_id) ||
    (typeof planItem.itemId === 'string' && planItem.itemId) ||
    (typeof planItem.item === 'string' && planItem.item) ||
    null;
  const createdMs = Date.parse(item.createdAt);
  // WI-5272: quarantine/de-quarantine-family items (testing:flakiness) stamp a single
  // `payload.filePath` string, not the plural `payload.paths` array most other creators
  // use — fold it in so a `paths`-based spec filter can see it too. Without this, a claim
  // spec has no structural signal to distinguish "a de-quarantine item whose TITLE happens
  // to name a file under lib/memory/**" from a genuine p2p/federation/rig item, and falls
  // back to an unreliable title-substring glob (see the *federation* false-positive class:
  // WI-5184/WI-5270 refused admission for merely naming federation-slug-stamp.test.ts).
  const filePathPaths = typeof payload.filePath === 'string' && payload.filePath ? [payload.filePath] : [];
  return {
    id: item.id,
    title: item.title,
    // EI-20240035377782004: mirror FIELD_MAP.summary — a real physical column on the base
    // table for both families, no payload fallback needed (same shape as `title`).
    summary: item.summary ?? null,
    kind: item.kind,
    priority: item.priority,
    tags: [...new Set([...staticTagsOfWorkItem(item), ...topicTags])],
    paths: [...new Set([...strings(payload.paths), ...filePathPaths])],
    plan,
    // EI-20288961198837165: mirror FIELD_MAP.plan_item's COALESCE order. The projected physical
    // column is authoritative when present (including []); payload plan-item ids are the fallback
    // for rows whose provenance was written only to JSONB.
    planItem:
      item.sourcePlanItemIds != null
        ? item.sourcePlanItemIds
        : itemId
          ? [itemId]
          : strings(payload.source_plan_item_ids),
    fleet: typeof payload.fleet_slug === 'string' && payload.fleet_slug ? payload.fleet_slug : null,
    // EI-16052: mirrors FIELD_MAP.triage_gate — see triageGateOfPayload for why the null
    // semantics have to match the SQL leg exactly.
    triageGate: triageGateOfPayload(payload),
    age: Number.isFinite(createdMs) ? createdMs : null,
    riskTier: typeof payload.risk_tier === 'string' ? payload.risk_tier : null,
    // WI-38326: `COALESCE(redundancy, 1)`. The default is the whole fix for this field, not a
    // tidy-up: the column is NULL on 25,698 of 25,698 live rows and `payload.redundancy` is
    // populated on NONE, so SQL answered 1 for every row while JS answered null for every row —
    // making `redundancy = 1` admit ALL on one path and NONE on the other. Defaulting here
    // agrees with SQL on every row whose column is NULL, which is currently all of them, and
    // matches the claim FLOORS (`redundancy IS NULL OR redundancy <= 1`).
    // The `1` is COALESCE's, so it applies to a projected-but-NULL column WITHOUT consulting
    // payload (SQL never does); the payload leg survives only for an unprojected family.
    redundancy:
      item.redundancy !== undefined
        ? (item.redundancy ?? 1)
        : (finiteNumber(payload.redundancy) ?? 1),
    // WI-38326: bare `expected_cost_cents` column — see the plan_item note above for why a
    // projected column must not fall through to payload.
    estCost:
      item.expectedCostCents !== undefined
        ? item.expectedCostCents
        : finiteNumber(payload.est_cost ?? payload.expected_cost_cents),
    assignee: item.assignee,
    // WI-6675 / WI-6674: read the TYPED accessor first. `WorkItem.severity` is already
    // mapped from the issue relation by work-items.ts (`severity: i.severity`), so taking
    // it here single-sources this evaluator with the rest of the codebase instead of
    // re-deriving a payload path — which is precisely the WI-6674 hazard, where severity
    // has two access paths (the TABLE keeps it at `payload._ei.severity`; the VIEW exposes
    // a real column, and until migration 1096 also DROPPED the `_ei` blob) and using the
    // wrong one for a relation returns NULL for every row WITHOUT erroring, yielding a
    // well-formed, plausible, wrong answer. 1096 restored the blob, so on the VIEW both
    // paths now resolve and agree except on NULL-payload rows — which makes the wrong
    // accessor quieter, not safer, and is why this reads the typed accessor regardless. The `_ei`/top-level payload legs below are defense-in-depth for a
    // subject built from a raw row that never went through that mapping — the same shape
    // as FIELD_MAP's `COALESCE(item_kind, kind)` in get-next.ts, and deliberately in the
    // SAME precedence order as the SQL side so the two admission evaluators cannot
    // disagree about one field (the WI-5781 split-brain class).
    severity:
      item.severity ??
      (typeof record(payload._ei).severity === 'string' ? (record(payload._ei).severity as string) : null) ??
      (typeof payload.severity === 'string' ? payload.severity : null),
    // WI-37711: `work_items.goal_id` is a PHYSICAL column on the base table for both
    // families (migration 785 / P-002) and is NOT mirrored into payload by anything, so —
    // unlike `severity` above — there is no payload leg to fall back to and inventing one
    // would be dead code. The mapped `WorkItem.goalId` is the single source; migration 790
    // exposes the column on the `engineer_issues` view so `issueToWorkItem` can populate it
    // for the issue family, which is the family a goal-scoped drain fleet actually claims.
    goal: item.goalId ?? null,
  };
}

function valueFor(subject: ClaimSpecSubject, field: FilterLeaf['field']): string | number | string[] | null {
  switch (field) {
    case 'id': return subject.id;
    case 'title': return subject.title;
    case 'summary': return subject.summary;
    case 'kind': return subject.kind;
    case 'priority': return subject.priority;
    case 'tags': return subject.tags;
    case 'paths': return subject.paths;
    case 'plan': return subject.plan;
    case 'plan_item': return subject.planItem;
    case 'fleet': return subject.fleet;
    case 'triage_gate': return subject.triageGate;
    case 'age': return subject.age;
    case 'risk_tier': return subject.riskTier;
    case 'redundancy': return subject.redundancy;
    case 'est_cost': return subject.estCost;
    case 'assignee': return subject.assignee;
    case 'severity': return subject.severity;
    case 'goal': return subject.goal;
  }
  return null;
}

function globRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

/** Escape a literal string for safe interpolation into a JS regex. */
function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * EI-18690730909662985: `word` is a case-insensitive WHOLE-WORD substring match,
 * unlike `glob`'s bare `*literal*` substring match, which false-positives
 * whenever the literal appears inside a larger word (e.g. a `*p2p*`
 * title-exclusion wrongly matching a fleet named "nonp2p-bug-drain", whose own
 * title mentions its own name).
 *
 * The boundary is `[^A-Za-z0-9]` (or string edge) — NOT `\b`. `\b` counts `_` as
 * a WORD character, so `\breplication\b` does not match "replication_soak", and
 * this pot names its soak/test identifiers in snake_case (replication_soak,
 * no_replicator, connected_never_replicated) — precisely the titles a p2p fence
 * most needs to catch. That blind spot leaked WI-5639 ("replication_soak: ...")
 * into fleet nonp2p-bug-drain-0725, whose mission excludes P2P work; adding the
 * obvious `word:'replication'` fence term did NOT fix it, and the failure looked
 * intermittent because the hyphenated "[replication-liveness]" DID match.
 *
 * Alphanumeric-only boundaries keep the EI-18690730909662985 fix intact
 * ("nonp2p-bug-drain" is still admitted: `p2p` is preceded by the letter "n")
 * while also matching across `_`.
 *
 * Mirrored byte-for-byte in get-next.ts's SQL compiler (Postgres has the SAME
 * `_`-is-a-word-char behaviour for `\m`/`\M`) and claim-spec-payload-filter.ts's
 * `matches` translation — keep all three in sync.
 */
function wordBoundaryRegex(literal: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9])${escapeRegexLiteral(literal)}(?![A-Za-z0-9])`, 'i');
}

function compareScalar(actual: string | number | null, leaf: FilterLeaf): boolean {
  if (actual == null) {
    // A NULL/absent field has NO value, so it matches no positive predicate (`=`, `glob`,
    // `in`, relational) — but it IS distinct from every concrete value, so `!=` MATCHES.
    // This mirrors the SQL compiler's `IS DISTINCT FROM` (get-next.ts) and the array
    // branches in matchLeaf below, where `!=` on an absent field is likewise true.
    // (EI-13306: the previous blanket `return false` claimed to "mirror SQL NULL comparison
    // semantics" — it did not. SQL's bare `NOT (...)` DROPS null rows while this evaluator's
    // `!matchLeaf(...)` ADMITS them, so the two evaluators of one spec language disagreed on
    // exactly the filter shape that starved a 10-agent fleet twice. Both are now null-safe
    // and claim-spec-null-semantics.integration.test.ts pins their parity.)
    return leaf.op === '!=';
  }
  const values = Array.isArray(leaf.value) ? leaf.value : [leaf.value];
  if (leaf.op === 'in') return values.some((v) => String(actual) === String(v));
  if (leaf.op === 'glob') return globRegex(String(leaf.value)).test(String(actual));
  if (leaf.op === 'word') return wordBoundaryRegex(String(leaf.value)).test(String(actual));
  if (leaf.op === 'contains') return String(actual).toLowerCase().includes(String(leaf.value).toLowerCase());

  if (typeof actual === 'number') {
    const rhs = Number(leaf.value);
    if (!Number.isFinite(rhs)) return false;
    switch (leaf.op) {
      case '=': return actual === rhs;
      case '!=': return actual !== rhs;
      case '<': return actual < rhs;
      case '<=': return actual <= rhs;
      case '>': return actual > rhs;
      case '>=': return actual >= rhs;
      default: return false;
    }
  }

  const rhs = String(leaf.value);
  switch (leaf.op) {
    case '=': return actual === rhs;
    case '!=': return actual !== rhs;
    case '<': return actual < rhs;
    case '<=': return actual <= rhs;
    case '>': return actual > rhs;
    case '>=': return actual >= rhs;
    default: return false;
  }
}

function matchLeaf(subject: ClaimSpecSubject, leaf: FilterLeaf): boolean {
  const actual = valueFor(subject, leaf.field);
  if (Array.isArray(actual)) {
    const wanted = (Array.isArray(leaf.value) ? leaf.value : [leaf.value]).map(String);
    if (leaf.op === 'in') return actual.some((v) => wanted.includes(v));
    if (leaf.op === 'glob') return actual.some((v) => globRegex(String(leaf.value)).test(v));
    if (leaf.op === 'word') return actual.some((v) => wordBoundaryRegex(String(leaf.value)).test(v));
    if (leaf.op === '!=') return !actual.includes(String(leaf.value));
    // SQL compiler treats array '=' and 'contains' as membership.
    return actual.includes(String(leaf.value));
  }

  // priority is stored physically as feature_order (lower = more important), so
  // the SQL compiler inverts relational comparators. Mirror that logical mapping.
  if (leaf.field === 'priority') {
    switch (leaf.op) {
      case '<': return compareScalar(actual, { ...leaf, op: '>' });
      case '<=': return compareScalar(actual, { ...leaf, op: '>=' });
      case '>': return compareScalar(actual, { ...leaf, op: '<' });
      case '>=': return compareScalar(actual, { ...leaf, op: '<=' });
    }
  }
  return compareScalar(actual, leaf);
}

/**
 * EI-16052: read `payload.ideaLifecycle.triageDecision` the way FIELD_MAP.triage_gate's
 * `payload->'ideaLifecycle'->>'triageDecision'` does.
 *
 * The two-level guard is the point, not defensive noise. Postgres `->` on a non-object
 * yields NULL and `->>` on a missing key yields NULL — neither ever throws and neither ever
 * returns a non-text scalar. So the JS leg has to answer null in exactly those same cases:
 * a missing key, a null/array/non-object `ideaLifecycle`, and a `triageDecision` that is not
 * a string. WI-38326 is the recorded cost of these two legs disagreeing about one field's
 * null semantics — `redundancy` read null in JS and 1 in SQL, so the same filter admitted
 * every row on one path and no row on the other, silently.
 */
export function triageGateOfPayload(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object') return null;
  const lifecycle = (payload as { ideaLifecycle?: unknown }).ideaLifecycle;
  if (lifecycle === null || typeof lifecycle !== 'object' || Array.isArray(lifecycle)) return null;
  const decision = (lifecycle as { triageDecision?: unknown }).triageDecision;
  return typeof decision === 'string' && decision ? decision : null;
}

export function matchesClaimSpecFilter(subject: ClaimSpecSubject, filter: FilterNode | undefined): boolean {
  if (!filter) return true;
  if ('field' in filter) return matchLeaf(subject, filter);
  if ('all' in filter) return filter.all.every((node) => matchesClaimSpecFilter(subject, node));
  if ('any' in filter) return filter.any.some((node) => matchesClaimSpecFilter(subject, node));
  return !matchesClaimSpecFilter(subject, filter.not);
}

export function matchesWorkItemClaimSpec(item: WorkItem, spec: ClaimSpec, topicTags: string[] = []): boolean {
  return matchesClaimSpecFilter(claimSpecSubjectFromWorkItem(item, topicTags), spec.view.filter);
}
