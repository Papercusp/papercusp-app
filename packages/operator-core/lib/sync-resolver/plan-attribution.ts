/**
 * plan-attribution — enrich the plans.* sync payloads (UI data layer) with
 * resolved author identities for the ownership/attribution badges
 * (shared-hive-collaboration-2026-06-14 P-001, B1, D-001).
 *
 * This is UI enrichment, deliberately kept OUT of the agent-facing plans:* tool
 * output: the badges are a desktop surfacing concern, so the resolution + extra
 * reads live at the sync-resolver layer (callPlansRead → enrich here) rather than
 * in the canonical read tool. Additive + best-effort: any failure leaves the base
 * payload untouched (the UI simply renders no badge).
 *
 * Reads are scoped to the plan's REAL workspace — derived per-harness for a single
 * plan (resolveWorkspaceForHarness, P-005), or the active workspace for the cross-plan
 * list/items enrichers (the UI lists one workspace at a time). NEVER a silent 'default'
 * (which mis-attributed badges across the WI-148 workspace split — D-003):
 *   - latest plan_revisions row per plan → the LAST EDITOR (author_id+author_kind).
 *   - harness_plan_parts.author per item → the PER-ITEM author. NOTE: on a single
 *     box the part author is the 'local'/'remote' origin sentinel (no device
 *     keypair), so per-item identity only carries real data under multi-machine
 *     federation; sentinel/empty authors are dropped (no badge) here.
 *
 * Identity resolution + always-renders fallback live in
 * lib/identity/resolve-plan-author-identity.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { createReadDeadline } from './read-deadline';
import { activeWorkspaceId } from '../workspace-registry';
import { resolveWorkspaceForHarness } from '../harness/workspace-for-harness';
import {
  resolvePlanAuthorIdentities,
  planAuthorKey,
  type PlanAuthorInput,
  type ResolvedAuthor,
} from '../identity/resolve-plan-author-identity';

/** Part authors that carry no real identity (single-box origin sentinels). */
const SENTINEL_AUTHORS = new Set(['', 'local', 'remote']);

/**
 * Whole-enrichment deadline for {@link enrichPlanDetail} (WI-39823). Badges are
 * cosmetic, so this sits WELL under the 6s the data-bearing learning.* reads
 * carry: 3s already leaves ~5x headroom over the p90 measured for this family,
 * and spending more of a shared resolver budget on a decoration than on the
 * payload would be the wrong trade.
 */
const PLAN_ATTRIBUTION_BUDGET_MS = 3_000;

function pg(sql?: Sql): Sql {
  return sql ?? getOrgPg().sql;
}

/**
 * A plan row/payload's REAL harness (its origin stamp), trimmed — or '' when absent.
 *
 * NEVER falls back to `operatorHomeHarnessSlug()`. Attribution reads are keyed
 * (harnessSlug, plan_slug); collapsing an omitted harness to the operator home silently
 * re-keys the lookup to a same-slug plan in the WRONG harness/workspace and mis-attributes
 * (or drops) its badges — the named-default twin of the WI-148 silent `'default'` workspace
 * leak (WI-374, detector-failure class, D-003). A missing harness ⇒ no harness-keyed badge
 * (graceful no-badge), never a home-harness guess. The harness is a PROPERTY OF THE PLAN
 * (plans:get stamps it as `harness` = row.harnessSlug), so callers pass the real plan and we
 * read it here — they don't (and must not) supply a default.
 */
function planHarnessSlug(h: unknown): string {
  return typeof h === 'string' && h.trim() ? h.trim() : '';
}

interface LatestRevisionRow {
  harness_slug: string;
  plan_slug: string;
  author_id: string;
  author_kind: string;
}

/** Latest (max-seq) revision author per plan, batched (one query, no N+1). */
async function latestRevisionAuthors(
  workspaceId: string,
  planSlugs: string[],
  sql: Sql,
): Promise<Map<string, { authorId: string; authorKind: 'human' | 'agent' }>> {
  const out = new Map<string, { authorId: string; authorKind: 'human' | 'agent' }>();
  if (planSlugs.length === 0) return out;
  const rows = (await sql.unsafe(
    `SELECT DISTINCT ON (harness_slug, plan_slug) harness_slug, plan_slug, author_id, author_kind
       FROM harness_shared.plan_revisions
      WHERE workspace_id = $1 AND plan_slug = ANY($2)
      ORDER BY harness_slug, plan_slug, seq DESC`,
    [workspaceId, planSlugs],
  )) as unknown as LatestRevisionRow[];
  for (const r of rows) {
    out.set(`${r.harness_slug}:${r.plan_slug}`, {
      authorId: r.author_id,
      authorKind: r.author_kind === 'human' ? 'human' : 'agent',
    });
  }
  return out;
}

/** Per-item part authors for one plan (item:P-NNN → author), sentinels dropped. */
async function planItemAuthors(
  workspaceId: string,
  harnessSlug: string,
  planSlug: string,
  sql: Sql,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const rows = (await sql.unsafe(
    `SELECT part_key, author FROM harness_shared.harness_plan_parts
      WHERE workspace_id = $1 AND harness_slug = $2 AND plan_slug = $3
        AND part_key LIKE 'item:%' AND tombstone = false`,
    [workspaceId, harnessSlug, planSlug],
  )) as unknown as Array<{ part_key: string; author: string | null }>;
  for (const r of rows) {
    const author = (r.author ?? '').trim();
    if (!author || SENTINEL_AUTHORS.has(author)) continue;
    out.set(r.part_key.slice('item:'.length), author);
  }
  return out;
}

interface PlanListRowLike {
  slug?: unknown;
  owner?: unknown;
  harness?: unknown;
  [k: string]: unknown;
}

/**
 * Drop a resolved identity's `avatarUrl` when it is null, for the LIST feeds
 * (EI-19455103442009801). Measured live on :3170: null on 1,475/1,475 occurrences
 * of the plans.list superset read = 25,075 B, ~3.5% of that payload, carrying no
 * information the key's absence does not already carry.
 *
 * WHY HERE AND NOT IN THE UI PROJECTION. `projectPlansReadForUi` is the natural
 * home for this and CANNOT host it: read-dispatch projects first, then the
 * plans.list / plans.byHive resolvers call this enricher, which deletes and
 * RE-ATTACHES both identity keys. A descent added to that projection is a
 * structural no-op — verified live, it moved the payload by 0 bytes.
 *
 * ⚠ NEVER MUTATE the argument: `resolvePlanAuthorIdentities` returns a Map whose
 * values are SHARED across every row referencing the same author (949 rows carry
 * a lastEditor here, drawn from far fewer distinct people), so an in-place delete
 * would edit other rows' identities too. Copy-on-null; pass the original through
 * untouched when a real avatar exists, which also keeps the common verified-member
 * case allocation-free.
 *
 * The field stays DECLARED (`avatarUrl?: string | null`) and is still mapped from
 * a real column, so a hive-membership row with a genuine avatar keeps it — the
 * all-null measurement is a fact about this read's current data, not the field's
 * purpose. Consumers read it with truthiness; see {@link ResolvedAuthor}.
 */
function withoutNullAvatarUrl(identity: ResolvedAuthor): ResolvedAuthor {
  if (identity.avatarUrl != null) return identity;
  const { avatarUrl: _omitted, ...rest } = identity;
  return rest;
}

/**
 * Enrich plans.list rows in place-by-copy with `ownerIdentity` + `lastEditor`.
 * One hive_members index query + one batched latest-revision query, total.
 */
export async function enrichPlanListRows(
  rows: unknown[],
  opts?: { sql?: Sql; workspaceId?: string },
): Promise<unknown[]> {
  const list = rows as PlanListRowLike[];
  if (!Array.isArray(list) || list.length === 0) return rows;
  const sql = pg(opts?.sql);
  // The list is scoped to ONE workspace (the UI shows the active workspace's plans); use
  // it for the attribution reads rather than a silent 'default' (P-005 / D-003).
  const workspaceId = opts?.workspaceId ?? activeWorkspaceId();

  const slugs = list.map((r) => (typeof r.slug === 'string' ? r.slug : null)).filter((s): s is string => !!s);
  let latest: Map<string, { authorId: string; authorKind: 'human' | 'agent' }>;
  try {
    latest = await latestRevisionAuthors(workspaceId, slugs, sql);
  } catch {
    latest = new Map();
  }

  const inputs: PlanAuthorInput[] = [];
  for (const r of list) {
    if (typeof r.owner === 'string' && r.owner.trim()) inputs.push({ kind: 'email', value: r.owner.trim() });
    const harness = planHarnessSlug(r.harness); // origin stamp, never a home-harness default (WI-374)
    const slug = typeof r.slug === 'string' ? r.slug : '';
    const le = latest.get(`${harness}:${slug}`);
    if (le) inputs.push({ kind: 'authorId', value: le.authorId, authorKind: le.authorKind });
  }
  const resolved = await resolvePlanAuthorIdentities(workspaceId, inputs, { sql });

  // ⚠ SET THE KEY ONLY WHEN IT RESOLVES — never `ownerIdentity: null` (WI-7045).
  // Same rule one level down: `withoutNullAvatarUrl` drops the identity's own
  // null `avatarUrl` (EI-19455103442009801). It has to happen HERE rather than in
  // the UI projection for exactly the reason the next comment block describes —
  // this enrichment runs after that projection and re-attaches these objects, so
  // a null stripped there would be put straight back by the lines below.
  // This enrichment runs AFTER `projectPlansReadForUi` has already omitted the
  // row's null-valued keys (read-dispatch.ts projects, then the plans.list /
  // plans.byHive resolvers enrich), so writing an unconditional null here puts
  // 432 of them back on a live 934-row payload — and, worse, contradicts the
  // wire contract that omission establishes: the client's `PlanListRow` declares
  // these `?: AuthorIdentity`, so shipping an explicit null makes that
  // declaration a lie in the opposite direction. Absent means unresolved.
  return list.map((r) => {
    const harness = planHarnessSlug(r.harness); // origin stamp, never a home-harness default (WI-374)
    const slug = typeof r.slug === 'string' ? r.slug : '';
    const ownerIdentity =
      typeof r.owner === 'string' && r.owner.trim()
        ? resolved.get(planAuthorKey('email', r.owner.trim()))
        : undefined;
    const le = latest.get(`${harness}:${slug}`);
    const lastEditor = le ? resolved.get(planAuthorKey('authorId', le.authorId)) : undefined;
    const out: PlanListRowLike = { ...r };
    delete out.ownerIdentity;
    delete out.lastEditor;
    if (ownerIdentity) out.ownerIdentity = withoutNullAvatarUrl(ownerIdentity);
    if (lastEditor) out.lastEditor = withoutNullAvatarUrl(lastEditor);
    return out;
  });
}

interface PlanItemRowLike {
  plan?: unknown;
  item?: { id?: unknown; [k: string]: unknown };
  [k: string]: unknown;
}

/**
 * Enrich plans.items (cross-plan) rows with per-item `item.lastEditedBy`. One
 * batched plan_parts query across the listed plans + one resolver pass. Sentinel
 * (local/remote/null) authors are dropped, so on a single box this is a no-op
 * (graceful); it lights up when real per-op author pubkeys federate.
 */
export async function enrichPlanItemsRows(
  rows: unknown[],
  opts?: { sql?: Sql; workspaceId?: string },
): Promise<unknown[]> {
  const list = rows as PlanItemRowLike[];
  if (!Array.isArray(list) || list.length === 0) return rows;
  const sql = pg(opts?.sql);
  // Cross-plan, but within ONE workspace (the active one) — use it, not a silent 'default'.
  const workspaceId = opts?.workspaceId ?? activeWorkspaceId();

  const planSlugs = [
    ...new Set(list.map((r) => (typeof r.plan === 'string' ? r.plan : '')).filter(Boolean)),
  ];
  const authorByItem = new Map<string, string>();
  try {
    if (planSlugs.length > 0) {
      const partRows = (await sql.unsafe(
        `SELECT plan_slug, part_key, author FROM harness_shared.harness_plan_parts
          WHERE workspace_id = $1 AND plan_slug = ANY($2)
            AND part_key LIKE 'item:%' AND tombstone = false`,
        [workspaceId, planSlugs],
      )) as unknown as Array<{ plan_slug: string; part_key: string; author: string | null }>;
      for (const r of partRows) {
        const author = (r.author ?? '').trim();
        if (!author || SENTINEL_AUTHORS.has(author)) continue;
        authorByItem.set(`${r.plan_slug}:${r.part_key.slice('item:'.length)}`, author);
      }
    }
  } catch {
    /* leave empty → graceful no-badge */
  }
  if (authorByItem.size === 0) return rows;

  const inputs: PlanAuthorInput[] = [...new Set(authorByItem.values())].map((value) => ({
    kind: 'pubkey' as const,
    value,
  }));
  const resolved = await resolvePlanAuthorIdentities(workspaceId, inputs, { sql });

  // ⚠ SET THE KEY ONLY WHEN IT RESOLVES — never `lastEditedBy: null` (WI-7086,
  // the same defect WI-7045 fixed one function up in enrichPlanListRows). This
  // enrichment runs AFTER `projectPlansReadForUi` has omitted the item's
  // null-valued keys (read-dispatch.ts projects, then the plans.items resolver
  // enriches), so an unconditional null here lands BEHIND that omission and puts
  // 2,542 of 3,327 nulls straight back on a live payload (~50 KB) — invisible to
  // the projection's own test, catchable only by counting residual nulls in the
  // SERVED bytes. It also contradicts the contract omission establishes: the
  // client's `PlanItem` declares this `?: AuthorIdentity`, so an explicit null
  // makes that declaration a lie in the opposite direction. Absent = unresolved.
  return list.map((r) => {
    const plan = typeof r.plan === 'string' ? r.plan : '';
    const id = r.item && typeof r.item.id === 'string' ? r.item.id : '';
    const author = plan && id ? authorByItem.get(`${plan}:${id}`) : undefined;
    const lastEditedBy: ResolvedAuthor | undefined = author
      ? resolved.get(planAuthorKey('pubkey', author))
      : undefined;
    if (!r.item) return r;
    const item = { ...r.item };
    delete item.lastEditedBy;
    if (lastEditedBy) item.lastEditedBy = lastEditedBy;
    return { ...r, item };
  });
}

interface PlanDetailLike {
  /** The plan's REAL harness, stamped by plans:get (`harness` = row.harnessSlug). The
   *  authoritative attribution scope — read here so a caller never has to (and never
   *  silently defaults it to the operator home). */
  harness?: unknown;
  /** The plan's REAL slug, stamped by plans:get (`slug` = row.planSlug, WI-7259). The
   *  authoritative identity — read here in preference to `frontmatter.slug`, which is
   *  a scheduled-run snapshot's PARENT slug (the snapshot copies its parent's markdown
   *  verbatim, frontmatter included). */
  slug?: unknown;
  frontmatter?: { slug?: unknown; owner?: unknown; [k: string]: unknown };
  items?: Array<{ id?: unknown; [k: string]: unknown }>;
  [k: string]: unknown;
}

/**
 * Enrich a single plans.get payload with plan-level `ownerIdentity` +
 * `lastEditor` and per-item `lastEditedBy` (when a real, non-sentinel part
 * author resolves). Best-effort.
 */
export async function enrichPlanDetail(
  plan: unknown,
  opts?: { sql?: Sql; workspaceId?: string; harnessSlug?: string; budgetMs?: number },
): Promise<unknown> {
  const p = plan as PlanDetailLike;
  if (!p || typeof p !== 'object' || !p.frontmatter) return plan;
  const sql = pg(opts?.sql);
  // BOUNDED (WI-39823). This file's contract is stated at the top — "additive +
  // best-effort: any failure leaves the base payload untouched (the UI simply
  // renders no badge)" — and the `try`/`catch` below delivers that for a leg that
  // THROWS. A leg that HANGS was never covered: `Promise.all` waits for the
  // slowest, so one wedged author read held the whole plan-detail sync query past
  // the resolver timeout, which is not "no badge", it is no PLAN. The deadline is
  // what makes the documented best-effort promise true for a slow store too.
  const withinBudget = createReadDeadline(opts?.budgetMs ?? PLAN_ATTRIBUTION_BUDGET_MS);
  // WI-7259 (sibling of WI-7246): prefer the payload's own stamped `slug`
  // (plans:get → row.planSlug, the canonical identity) over
  // `frontmatter.slug` — a scheduled-run snapshot copies its parent plan's
  // body verbatim, frontmatter included, so the frontmatter form reads the
  // PARENT's slug and would attribute the badges from the WRONG plan's
  // revision/part-author history. Frontmatter stays the fallback for any
  // caller (or test fixture) that predates the `slug` stamp.
  const slug =
    typeof p.slug === 'string' ? p.slug : typeof p.frontmatter.slug === 'string' ? p.frontmatter.slug : '';
  // The attribution harness is the plan's REAL harness: an explicit caller override
  // (`opts.harnessSlug`), else the plan payload's own stamped `harness` (plans:get →
  // row.harnessSlug — the authoritative origin). NEVER a silent `?? operatorHomeHarnessSlug()`
  // (the WI-374 mis-attribution: an omitted harness collapsed to the operator home reads a
  // same-slug plan's badges from the wrong harness/workspace). No harness from either source
  // ⇒ leave the payload un-enriched (graceful no-badge), never a home-harness guess.
  const harnessSlug = planHarnessSlug(opts?.harnessSlug) || planHarnessSlug(p.harness);
  if (!slug || !harnessSlug) return plan;
  // Derive the workspace from THIS plan's harness (P-005) — best-effort: if the harness
  // can't be resolved to a workspace, leave the payload un-enriched (graceful no-badge),
  // never a silent cross-workspace 'default' read (D-003).
  let workspaceId: string;
  try {
    workspaceId = await resolveWorkspaceForHarness(harnessSlug, opts?.workspaceId);
  } catch {
    return plan;
  }

  let latest = new Map<string, { authorId: string; authorKind: 'human' | 'agent' }>();
  let itemAuthors = new Map<string, string>();
  try {
    [latest, itemAuthors] = await Promise.all([
      withinBudget(latestRevisionAuthors(workspaceId, [slug], sql), 'plan-detail revision-authors'),
      withinBudget(planItemAuthors(workspaceId, harnessSlug, slug, sql), 'plan-detail item-authors'),
    ]);
  } catch {
    /* leave empty → graceful no-badge (now reached by a lapsed budget too) */
  }

  const owner = typeof p.frontmatter.owner === 'string' ? p.frontmatter.owner.trim() : '';
  const le = latest.get(`${harnessSlug}:${slug}`);
  const inputs: PlanAuthorInput[] = [];
  if (owner) inputs.push({ kind: 'email', value: owner });
  if (le) inputs.push({ kind: 'authorId', value: le.authorId, authorKind: le.authorKind });
  for (const author of itemAuthors.values()) inputs.push({ kind: 'pubkey', value: author });
  // The identity resolve is a THIRD store read on this path and, unlike the pair
  // above, it sat outside any `catch` — so a failure here took the plan payload
  // down, contradicting this file's own best-effort header. Bounded by the SAME
  // deadline (never a second budget: two 3s budgets would total 6s and defeat the
  // ceiling the bound exists to stay under) and degraded to no-badge.
  const resolved = await withinBudget(
    resolvePlanAuthorIdentities(workspaceId, inputs, { sql }),
    'plan-detail author identities',
  ).catch(() => new Map<string, ResolvedAuthor>());

  const ownerIdentity = owner ? resolved.get(planAuthorKey('email', owner)) ?? null : null;
  const lastEditor = le ? resolved.get(planAuthorKey('authorId', le.authorId)) ?? null : null;

  const items = Array.isArray(p.items)
    ? p.items.map((it) => {
        const id = typeof it.id === 'string' ? it.id : '';
        const author = id ? itemAuthors.get(id) : undefined;
        const lastEditedBy: ResolvedAuthor | null = author
          ? resolved.get(planAuthorKey('pubkey', author)) ?? null
          : null;
        return { ...it, lastEditedBy };
      })
    : p.items;

  return { ...p, ownerIdentity, lastEditor, items };
}
