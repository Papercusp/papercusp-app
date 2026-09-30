/**
 * Cupboard D1 helpers — typed row shapes + insert/update/select primitives.
 *
 * Table row types are generated from the fully applied migration set. Helpers
 * are thin wrappers around prepared statements; no ORM, no runtime abstraction.
 */

import type { Env } from './env.ts';
import type {
  BannedPublisherPubkeysRow,
  HarnessesRow,
  ReportsRow,
} from './db-row-types.generated.ts';

/** The storefront listing kinds (migrations 004 + 006 + 008 / D-005). The
 *  `snapshot` kind was retired (retire-snapshots-instance-spec-2026-06-09 D-005);
 *  the D1 `tarball_*` columns (migration 005) remain vestigial/nullable.
 *  Migration 008 (learning-packs-2026-06-11 D-005) renamed the runtime-less
 *  code-tool pack `pack` → `tool-pack` and added `learning-pack`. Migration 010
 *  (cupboard-public-release-2026-07-12 P-003) renames it BACK to the canonical
 *  `pack` (packs are the umbrella that also carry event deps), so `tool-pack`
 *  becomes the interim wire alias; both `tool-pack` and the pre-008 `pack` stay
 *  accepted on the wire and normalize to `pack` via normalizeListingKind.
 *  Migration 011 (cupboard-public-release-2026-07-12 P-001) renames
 *  `learning-pack` → `knowledge-pack`; the old `learning-pack` wire value stays
 *  accepted and normalizes forward, same pattern.
 *  `template` (app-templates-2026-07-04; standard-path publish wired in
 *  cupboard-full-dogfood-2026-07-10 P-003): a first-party app-template listing,
 *  GitHub-repo-backed per `listing_ref` like a blueprint. Previously the 11
 *  official template rows were seeded directly (bypassing POST /listings); it is
 *  now accepted on the publish path so templates list "as authored by papercusp"
 *  via the standard flow.
 *  `app` (migration 014 / cupboard-app-distribution-2026-07-14 P-001, D-001
 *  [owner 2026-07-14]): a whole distributable application. A STANDALONE app
 *  (e.g. Oddsmith, a Tauri desktop app built on the papercusp platform) is a
 *  separate downloadable product — "install" DOWNLOADS its platform installer
 *  from the app's own GitHub release (the Cupboard never re-hosts the binary); a
 *  BUNDLE app is a papercusp-native composition installed into the workspace
 *  (Phase 2). The `delivery_type` column discriminates the two.
 *
 *  `rubric` / `plan` / `recipe` (migration 015 / cupboard-plan-rubric-recipe-sharing
 *  -2026-08-21 P-002, D-001 [owner 2026-08-21]): the three reusable JUDGMENT/PROCEDURE
 *  units. A `rubric` is a self-describing rubric dir (rubric.json + listing.json +
 *  optional METHOD.md) installed into the layered rubric store's user layer. A `plan`
 *  is a plan TEMPLATE — goal + item DAG + decisions + schedule with live state stripped
 *  at publish — and may declare `requires_rubrics`. A `recipe` is a captured multi-step
 *  tool orchestration. All three install.
 *
 *  `goal` (migration 016 / work-on-everything-goal-2026-08-23 P-006, D-002
 *  [owner 2026-08-23]): a GOAL PACKAGE — title + duties body/kickoff brief + standing
 *  flag + tripwire/budget-window/launch-setting defaults + input/output schemas, as a
 *  self-describing dir (goal.json + listing.json). Installing lands an INACTIVE goal
 *  stub (no agent, no spend), NO-CLOBBER; starting it is a separate deliberate act.
 *  May declare `requires_rubrics`, same as `plan`. */
export const LISTING_KINDS = [
  'harness',
  'blueprint',
  'plugin',
  'pack',
  'knowledge-pack',
  'template',
  'app',
  'rubric',
  'plan',
  'recipe',
  'goal',
  // migration 024 / cupboard-themes-2026-09-05: inert semantic-token package;
  // install makes it locally selectable through the existing theme runtime.
  'theme',
  // migration 029 / identities-v1-2026-08-30 P-027, D-010: a DATATYPE PACKAGE —
  // the schema + lifecycle a workspace installs so `work_items` and the surfaces
  // over it accept a new item kind. It had grown a SECOND storefront of its own
  // (`datatypes:publish` marking its own pending queue, `datatypes:catalog`
  // browsing it); this folds publish+browse back into the one Cupboard surface,
  // with `datatype_registry` kept as the resolution layer it always was.
  'datatype',
  // migration 030 / identities-v1-2026-08-30 P-028, D-011 / D-054: an installable
  // BEHAVIOUR — "when X, fire Y" — beside `recipe`, which it closely resembles.
  // What makes it portable is that a standalone rule fires a capability CLASS,
  // not a tool id (D-004): the installing pot's own provider binding decides
  // which tool actually runs, so one listing ships across pots with different
  // providers. Resolves into the SAME reaction registry as every built-in and
  // plugin rule — no second engine, no second condition language.
  'rule',
  // migration 031 / identities-v1-2026-08-30 P-029, D-010 / D-011: an EVENT-KEY
  // DECLARATION — a versioned key family plus its payload schema and discovery
  // metadata. The PROVIDER half of an axis whose consumer half already exists:
  // `requires_events` (migration 013) has been able to depend on a family since
  // the Cupboard's first release, and an unresolvable required family is a HARD
  // install failure — but nothing could ever PUBLISH one, so the only families
  // that ever resolved were first-party. This closes that half.
  //
  // An event listing fires nothing; `rule` is what fires. What it does do is
  // make a family RESOLVABLE, which is why it is review-gated rather than inert
  // (see REVIEW_POLICY_KINDS below).
  'event',
] as const;
export type ListingKind = (typeof LISTING_KINDS)[number];

export function isListingKind(v: unknown): v is ListingKind {
  return typeof v === 'string' && (LISTING_KINDS as readonly string[]).includes(v);
}

/** Wire-compat: normalize legacy listing-kind values to their canonical form.
 *
 *  - 'tool-pack'     → 'pack'            (interim alias from migration 008; canonicalized by 010 / P-003)
 *  - 'learning-pack' → 'knowledge-pack'  (renamed by migration 011 / P-001)
 *
 *  A pre-008 literal 'pack' already IS canonical and passes through isListingKind.
 *
 *  This is a TRUE BOUNDARY (knowledge-packs-2026-07-11 D-001): the rename is HARD
 *  internally with no aliases, but an already-published listing row and any client
 *  built against the old API still speak 'learning-pack' on the wire, so it must
 *  keep parsing. It normalizes FORWARD — nothing downstream ever sees the old value. */
export function normalizeListingKind(v: unknown): ListingKind | null {
  if (v === 'tool-pack') return 'pack';
  if (v === 'learning-pack') return 'knowledge-pack';
  return isListingKind(v) ? v : null;
}

/**
 * Pre-publication review policy (knowledge-packs D-007): the INSTRUCTION-
 * CARRYING kinds — content injected into agent context (knowledge packs) or
 * run as agent roles (blueprints) — land `pending` at publish and go public
 * only on operator approval. Code kinds keep install-consent + reactive
 * moderation.
 *
 * `app` (cupboard-app-distribution-2026-07-14 P-001, D-001): an app distributes a
 * runnable EXECUTABLE (a standalone installer) — the highest-trust thing the
 * Cupboard carries — so it is fail-closed here: an app publishes `pending` and is
 * publicly invisible until reviewed. This is the safe default the moment the kind
 * exists, so the eventual publish path (P-003) can never make an app public
 * without review. The moderation *flow* + who reviews is P-006 / the open P-012
 * owner wall on cupboard-public-release-2026-07-12 (which this kind escalates).
 *
 * `rubric` / `plan` / `recipe` (migration 015 / cupboard-plan-rubric-recipe-sharing
 * D-002): all three are fail-closed for the SAME reason knowledge-pack and blueprint
 * are — each is instruction-carrying content that lands in an agent's context or
 * execution path, not inert data:
 *   - a `rubric` supplies the criteria + METHOD.md runbook by which work is GRADED,
 *     so a hostile one silently corrupts every acceptance verdict it touches;
 *   - a `plan` is a goal + item DAG agents EXECUTE — the most directly actuating
 *     content the Cupboard carries short of an app;
 *   - a `recipe` is a runnable multi-step tool orchestration.
 * Being in this list from the moment the kinds exist means no publish path built
 * later can make one of them public without review.
 */
export const REVIEW_POLICY_KINDS: readonly ListingKind[] = [
  'knowledge-pack',
  'blueprint',
  'app',
  'rubric',
  'plan',
  'recipe',
  // migration 016 / work-on-everything-goal-2026-08-23 P-006: a goal package is
  // duties prose an agent EXECUTES (a kickoff brief + launch defaults) — the same
  // fail-closed reasoning as `plan`, in the list from the moment the kind exists.
  'goal',
  // migration 029 / identities-v1-2026-08-30 P-027: a datatype package installs a
  // SCHEMA + LIFECYCLE that governs how `work_items` of that kind behave — it lands
  // in the execution path of every surface over them, so it is actuating, not inert.
  // It is also a PRESERVED semantic, not a new one: the parallel `datatypes:publish`
  // surface this consolidation retires already marked its own listings pending for
  // operator moderation (D-010). Omitting it here would have made folding that
  // surface into the Cupboard a silent downgrade from moderated to auto-approved.
  'datatype',
  // migration 030 / identities-v1-2026-08-30 P-028, D-011 / D-054: a rule is the
  // most actuating kind in this list. `recipe` and `goal` are orchestration a
  // person or agent still chooses to RUN; a rule is "when X, fire Y" — it fires
  // BY ITSELF on a matching event, in the installing pot, under the capability
  // its fired CLASS declares. Auto-approving it would let any publisher put
  // self-firing behaviour into every installing pot with no operator ever
  // looking at it. The criterion this list already applies — actuating publishes
  // pending, inert publishes approved (`theme` is the inert case) — puts `rule`
  // on the pending side a fortiori, so it is in the list from the moment the
  // kind exists rather than being tightened later.
  'rule',
  // migration 031 / identities-v1-2026-08-30 P-029, D-010: an event listing
  // FIRES nothing, so the actuating/inert criterion above does not by itself
  // put it here — `theme` is inert and publishes approved. Two things do.
  //
  // (1) The SAME preserved-semantic reasoning as `datatype` directly above.
  //     The event-key space today is first-party curated (EVENT_CATALOG);
  //     making it third-party-publishable while auto-approving it would be a
  //     silent downgrade from curated to unmoderated, which is exactly the
  //     downgrade `datatype` was added here to avoid.
  // (2) A published key can SQUAT or shadow a first-party family, and an
  //     installed squat changes what every `requires_events` dep and every
  //     rule `on` in that pot resolves to. That is namespace capture, not
  //     execution — but its blast radius is the same.
  //
  // Pending is also the recoverable direction: an over-moderated kind can be
  // loosened, whereas an auto-approved squat is already published and public
  // before anyone looks. When P-029's event-key registry lands a STRUCTURAL
  // namespace guard (publisher-scoped prefixes — the derived-truth answer,
  // since no operator can eyeball a squat without knowing the whole key
  // space), revisit this entry; do not loosen it before that guard exists.
  'event',
];

export type ReviewStatus = 'pending' | 'approved' | 'rejected';

/**
 * Catalog visibility (migration 018 / shared-pot-dao-cupboard-v1-2026-09-04 P-008).
 *
 *   public   — listed in the global catalog. Every pre-018 row defaults here, so
 *              the migration preserves existing browse behavior exactly.
 *   unlisted — reachable by direct id/listing_ref, never returned by browse.
 *   private  — visible only inside the owning tenant (`tenant_id`).
 *
 * Read paths are FAIL-CLOSED: the browse predicate admits only `public` unless a
 * caller supplies a `tenant_scope`, so a new visibility value can never leak by
 * being forgotten in a filter.
 */
export const LISTING_VISIBILITIES = ['public', 'unlisted', 'private'] as const;
export type ListingVisibility = (typeof LISTING_VISIBILITIES)[number];

export function isListingVisibility(v: unknown): v is ListingVisibility {
  return typeof v === 'string' && (LISTING_VISIBILITIES as readonly string[]).includes(v);
}

/**
 * Provider-neutral pricing model (migration 018 / P-008, D-025 + D-028).
 *
 * Deliberately NOT a payment-provider concept: the catalog stores what the unit
 * COSTS and how it is charged, never which adapter collects it. A settlement
 * adapter maps `sku_ref` onto its own product; nothing here may name Stripe, a
 * gateway URL, or a blob provider.
 */
export const PRICING_MODELS = ['free', 'one-time', 'subscription', 'per-use'] as const;
export type PricingModel = (typeof PRICING_MODELS)[number];

export function isPricingModel(v: unknown): v is PricingModel {
  return typeof v === 'string' && (PRICING_MODELS as readonly string[]).includes(v);
}

export type HarnessRow = Omit<
  HarnessesRow,
  'listing_kind' | 'claim_status' | 'review_status' | 'delivery_type' | 'visibility' | 'pricing_model'
> & {
  // Catalog axes (migration 018 / P-008). `visibility` is NOT NULL with a
  // 'public' default so every pre-018 row reads as public; the rest are null on
  // a row that has not declared that axis.
  visibility: ListingVisibility;
  /** Owning shared pot. NULL = the global public catalog. */
  tenant_id: string | null;
  pricing_model: PricingModel | null;
  /** Storefront kind (migration 004). Default 'harness' for pre-004 rows. */
  listing_kind: ListingKind;
  claim_status: 'unclaimed' | 'claimed' | 'stale' | 'superseded';
  // Pre-publication review (migration 008 / knowledge-packs D-007). Policy
  // kinds publish 'pending'; everything else (and every pre-008 row) is
  // 'approved'. reviewed_at/review_reason carry the operator decision.
  review_status: ReviewStatus;
  reviewed_at: number | null;
  review_reason: string | null;
  // App distribution (migration 014 / cupboard-app-distribution-2026-07-14 P-001).
  // All app-only; NULL on every other kind and every pre-014 row.
  // delivery_type discriminates the app model: 'standalone' (a separate
  // downloadable product — "install" is a download-link handoff) | 'bundle' (a
  // papercusp-native composition, Phase 2). NULL ⇒ treated as 'standalone'.
  delivery_type: 'standalone' | 'bundle' | null;
};

export type ReportRow = Omit<ReportsRow, 'status'> & {
  status: 'pending' | 'resolved_unlist' | 'resolved_dismiss';
};

export interface NewHarnessInput {
  id: string;
  /** Storefront kind (migration 004). Defaults to 'harness' when omitted. */
  listing_kind?: ListingKind;
  /** Papercupai project remote id (D-008). */
  project_ref?: string | null;
  /** Within-project discriminator (blueprint stream / snapshot id / plugin slug). */
  listing_ref?: string | null;
  github_repository_id: number;
  github_owner: string;
  github_name: string;
  github_url: string;
  title: string;
  description: string | null;
  /** Required only for kind='harness'; null for the fork/install kinds. */
  topic_hex: string | null;
  publisher_github_user_id: number;
  publisher_github_login: string;
  publisher_permission?: string | null;
  publisher_device_pubkey?: string | null;
  publisher_attestation_gist_id?: string | null;
  /** Pack model (migration 006): JSON string[] of provided tool names; plugin|pack only. */
  provides_tools?: string | null;
  /** Tool axis, consumer half (migration 033 / WI-10001747): JSON string[] of tool names the unit ORCHESTRATES but does not provide; orchestrating kinds only. */
  uses_tools?: string | null;
  /** Event axis (migration 012 / D-003): JSON array of provided event families; plugin|pack only. */
  provides_events?: string | null;
  /** Event axis (migration 013 / D-003): JSON array of REQUIRED event families; plugin|pack only. */
  requires_events?: string | null;
  /** Rubric axis (migration 015 / D-001): JSON array of REQUIRED rubrics
   *  ({ rubricRef, optional? }); primarily `plan`, kind-agnostic. Omit ⇒ none. */
  requires_rubrics?: string | null;
  /** Repo→Hive binding (migration 007): owning Hive's raw-32-byte-base64 Ed25519 pubkey. */
  hive_pubkey?: string | null;
  /** Denormalized Hive display title (directory announce stays authoritative). */
  hive_title?: string | null;
  /** blueprint.yaml `kind` ('hive'|'harness') for a listing_kind='blueprint' publish;
   *  null otherwise (migration 009 / P-018). */
  blueprint_kind?: string | null;
  /** Pre-publication review (migration 008): policy kinds publish 'pending'. */
  review_status?: ReviewStatus;
  // App distribution (migration 014 / cupboard-app-distribution-2026-07-14 P-003).
  // All app-only; null on every other kind. See HarnessRow for column semantics.
  /** 'standalone' | 'bundle'; null ⇒ treated as standalone. app only. */
  delivery_type?: 'standalone' | 'bundle' | null;
  /** STANDALONE: signed latest.json updater-manifest URL the download flow reads. */
  latest_json_url?: string | null;
  /** STANDALONE: `<owner>/<repo>` hosting the release installers, if distinct. */
  release_repo?: string | null;
  /** App icon URL for the storefront card/detail. */
  icon_url?: string | null;
  /** Denormalized JSON string[] of OS keys present in latest.json. */
  platforms?: string | null;

  // ── Catalog axes (migration 018 / shared-pot-dao-cupboard-v1 P-008) ────────
  /** public (default) | unlisted | private. Omit ⇒ 'public'. */
  visibility?: ListingVisibility;
  /** Owning shared pot; null/omitted ⇒ the global public catalog. */
  tenant_id?: string | null;
  /** Opaque provider-neutral SKU identifier a settlement adapter resolves. */
  sku_ref?: string | null;
  pricing_model?: PricingModel | null;
  /** Minor units × 1e6, so per-use microcharges and stablecoin amounts stay exact. */
  price_amount_micros?: number | null;
  /** ISO-4217 code or stablecoin symbol ('USD', 'USDC'). */
  price_currency?: string | null;
  /** JSON { runtime?, platforms?: string[], architectures?: string[] } — mirrors
   *  the P-006 release manifest's `compatibility`. */
  compatibility_json?: string | null;
  /** JSON string[] of permissions the unit requests at install time. */
  required_permissions?: string | null;
  // Immutable release identity. Content identity only — never a retrieval URL,
  // so the later P2P storage migration (D-024) changes no column here.
  release_version?: string | null;
  release_content_hash?: string | null;
  release_manifest_digest?: string | null;
  release_signature?: string | null;
  /**
   * The FULL signed release manifest as canonical JSON (migration 032).
   * The signature is over listingManifestSigningBytes(manifest), whose
   * license/publisher/reviewStatus fields are publisher-supplied and NOT
   * derivable from a clone — so an installer cannot reconstruct the signed
   * bytes from the pins alone. Carrying the whole manifest is what makes the
   * install-time signature check reachable (identities-v1-2026-08-30 D-074).
   */
  release_manifest?: string | null;
  release_published_at?: number | null;
  // Content pin (migration 028 / cupboard-release-pipeline-content-trust P-001).
  // Set by the Worker for self-describing kinds from what IT fetched (D-003);
  // null on code kinds. Both-or-neither.
  pinned_commit_sha?: string | null;
  pinned_tree_digest?: string | null;
  pinned_at?: number | null;
  created_at: number;
}

export async function insertHarness(db: D1Database, h: NewHarnessInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO harnesses
         (id, listing_kind, project_ref, listing_ref,
          github_repository_id, github_owner, github_name, github_url,
          title, description, topic_hex,
          publisher_github_user_id, publisher_github_login, publisher_permission,
          publisher_device_pubkey, publisher_attestation_gist_id,
          provides_tools, uses_tools, provides_events, requires_events, requires_rubrics,
          hive_pubkey, hive_title, blueprint_kind,
          review_status,
          delivery_type, latest_json_url, release_repo, icon_url, platforms,
          visibility, tenant_id, sku_ref, pricing_model,
          price_amount_micros, price_currency,
          compatibility_json, required_permissions,
          release_version, release_content_hash, release_manifest_digest,
          release_signature, release_manifest, release_published_at,
          pinned_commit_sha, pinned_tree_digest, pinned_at,
          claim_status,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unclaimed', ?, ?)`,
    )
    .bind(
      h.id,
      h.listing_kind ?? 'harness',
      h.project_ref ?? null,
      h.listing_ref ?? null,
      h.github_repository_id,
      h.github_owner,
      h.github_name,
      h.github_url,
      h.title,
      h.description,
      h.topic_hex,
      h.publisher_github_user_id,
      h.publisher_github_login,
      h.publisher_permission ?? null,
      h.publisher_device_pubkey ?? null,
      h.publisher_attestation_gist_id ?? null,
      h.provides_tools ?? null,
      h.uses_tools ?? null,
      h.provides_events ?? null,
      h.requires_events ?? null,
      h.requires_rubrics ?? null,
      h.hive_pubkey ?? null,
      h.hive_title ?? null,
      h.blueprint_kind ?? null,
      h.review_status ?? 'approved',
      h.delivery_type ?? null,
      h.latest_json_url ?? null,
      h.release_repo ?? null,
      h.icon_url ?? null,
      h.platforms ?? null,
      h.visibility ?? 'public',
      h.tenant_id ?? null,
      h.sku_ref ?? null,
      h.pricing_model ?? null,
      h.price_amount_micros ?? null,
      h.price_currency ?? null,
      h.compatibility_json ?? null,
      h.required_permissions ?? null,
      h.release_version ?? null,
      h.release_content_hash ?? null,
      h.release_manifest_digest ?? null,
      h.release_signature ?? null,
      h.release_manifest ?? null,
      h.release_published_at ?? null,
      h.pinned_commit_sha ?? null,
      h.pinned_tree_digest ?? null,
      h.pinned_at ?? null,
      h.created_at,
      h.created_at,
    )
    .run();
}

/** Operator decision on a pending listing (knowledge-packs P-019/P-020). */
export async function setReviewStatus(
  db: D1Database,
  id: string,
  status: Exclude<ReviewStatus, 'pending'>,
  reason: string | null,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE harnesses
          SET review_status = ?, reviewed_at = ?, review_reason = ?, updated_at = ?
        WHERE id = ?`,
    )
    .bind(status, now, reason, now, id)
    .run();
}

/** The operator's pending-review queue, oldest first. */
export async function listPendingReview(db: D1Database, limit = 100): Promise<HarnessRow[]> {
  const res = await db
    .prepare(
      `SELECT * FROM harnesses
        WHERE review_status = 'pending' AND unlisted_at IS NULL
        ORDER BY created_at ASC LIMIT ?`,
    )
    .bind(Math.min(Math.max(limit, 1), 200))
    .all<HarnessRow>();
  return res.results ?? [];
}

export async function getHarnessById(db: D1Database, id: string): Promise<HarnessRow | null> {
  const row = await db
    .prepare('SELECT * FROM harnesses WHERE id = ?')
    .bind(id)
    .first<HarnessRow>();
  return row ?? null;
}

/**
 * Look up the shared-HARNESS listing bound to a repo. Scoped to
 * listing_kind='harness' because, post-migration-004, the same project-remote
 * repo id can host N non-harness listings (blueprints/snapshots/plugins) — but
 * the "one shared-harness per repo" 1:1 invariant (binding lookup + harness
 * publish dedup) still holds. An active (listed) row wins over an unlisted one.
 */
export async function getHarnessByGithubRepoId(
  db: D1Database,
  github_repository_id: number,
): Promise<HarnessRow | null> {
  const row = await db
    .prepare(
      `SELECT * FROM harnesses
         WHERE github_repository_id = ? AND listing_kind = 'harness'
         ORDER BY (unlisted_at IS NULL) DESC
         LIMIT 1`,
    )
    .bind(github_repository_id)
    .first<HarnessRow>();
  return row ?? null;
}

/**
 * Batch repo→listing lookup (comb-hive-native-sharing P-011): the active
 * harness-kind listings for a SET of GitHub repo ids, for the search panel's
 * "hive exists" badges (P-010). One query over the existing repo-id index,
 * mirroring getHarnessByGithubRepoId's harness-kind + active-row scoping —
 * batched. The caller validates + caps the id set.
 */
export async function getHarnessesByGithubRepoIds(
  db: D1Database,
  github_repository_ids: number[],
): Promise<HarnessRow[]> {
  if (github_repository_ids.length === 0) return [];
  const placeholders = github_repository_ids.map(() => '?').join(',');
  const stmt = db.prepare(
    `SELECT * FROM harnesses
       WHERE github_repository_id IN (${placeholders})
         AND listing_kind = 'harness' AND unlisted_at IS NULL`,
  );
  // .bind is variadic — spread the ids in one call (same cast as listHarnesses).
  const bound = (stmt as unknown as { bind: (...vs: unknown[]) => D1PreparedStatement }).bind(
    ...github_repository_ids,
  );
  const res = await bound.all<HarnessRow>();
  return res.results ?? [];
}

export interface ListOpts {
  limit?: number;
  cursor?: number | null;          // legacy/internal timestamp pagination
  search?: string;
  claim_status?: 'unclaimed' | 'claimed';
  /** Filter to one storefront kind (migration 004). Omit for all kinds. */
  kind?: ListingKind;
  /** Filter to one project remote (D-008 project rollup). */
  project_ref?: string;
}

/**
 * Catalog-axis filters (migration 018 / P-008).
 *
 * Deliberately on the PUBLIC opts only, not on `ListOpts`. `listHarnesses` is the
 * indexer's internal sweep and must see every row regardless of visibility — if
 * these lived on the shared base, passing `visibility` to it would silently do
 * nothing, which is the quietest kind of filter bug.
 */
export interface CatalogFilterOpts {
  /** NARROW to one visibility WITHIN what the caller may already see. This can
   *  only ever remove rows — it never widens the fail-closed scope below. */
  visibility?: ListingVisibility;
  /**
   * WIDENING tenant scope: additionally admit rows owned by this tenant,
   * whatever their visibility. This is the ONLY thing that exposes an
   * `unlisted`/`private` row, so a caller must have authorized the tenant
   * before passing it. The public HTTP route never sets it — see the
   * `tenant_ref` narrowing filter for the untrusted query-param path.
   */
  tenant_scope?: string;
  /** NARROWING filter to one tenant's rows, within the caller's existing scope.
   *  Safe to drive from an untrusted query param: it cannot reveal a row the
   *  scope did not already admit. */
  tenant_ref?: string;
  pricing_model?: PricingModel;
  /** true ⇒ only priced rows; false ⇒ only free/unpriced rows. */
  paid?: boolean;
  /** Match one entry of `compatibility_json.platforms`. */
  platform?: string;
  /** Match `compatibility_json.runtime` exactly. */
  runtime?: string;
  /** Match one entry of `required_permissions`. */
  permission?: string;
  /** Include yanked/revoked releases (default: excluded from browse). */
  include_withdrawn?: boolean;
}

export interface PublicListOpts extends Omit<ListOpts, 'cursor'>, CatalogFilterOpts {
  cursor?: number | ListingCursor | null;
}

/**
 * Opaque public-list cursor. `last_activity_at` alone is not unique, so the id
 * is part of the keyset boundary even though older clients sent a bare numeric
 * timestamp. The route still accepts that legacy timestamp form.
 */
export interface ListingCursor {
  last_activity_at: number | null;
  id: string;
}

export interface HarnessListPage {
  results: HarnessRow[];
  next_cursor: string | null;
}

export interface HarnessListSummary {
  total: number;
  kind_facets: Record<ListingKind, number>;
}

const LISTING_CURSOR_PREFIX = 'v1:';

export function encodeListingCursor(row: Pick<HarnessRow, 'last_activity_at' | 'id'>): string {
  const activity = row.last_activity_at == null ? 'null' : String(row.last_activity_at);
  return `${LISTING_CURSOR_PREFIX}${activity}:${encodeURIComponent(row.id)}`;
}

export function parseListingCursor(raw: string): number | ListingCursor | null {
  if (/^-?\d+$/.test(raw)) {
    const legacy = Number(raw);
    return Number.isSafeInteger(legacy) ? legacy : null;
  }
  if (!raw.startsWith(LISTING_CURSOR_PREFIX)) return null;
  const separator = raw.indexOf(':', LISTING_CURSOR_PREFIX.length);
  if (separator < 0) return null;
  const activityRaw = raw.slice(LISTING_CURSOR_PREFIX.length, separator);
  const encodedId = raw.slice(separator + 1);
  if (!encodedId) return null;
  const last_activity_at = activityRaw === 'null' ? null : Number(activityRaw);
  if (last_activity_at !== null && !Number.isSafeInteger(last_activity_at)) return null;
  try {
    const id = decodeURIComponent(encodedId);
    return id ? { last_activity_at, id } : null;
  } catch {
    return null;
  }
}

interface ListPredicateOptions {
  includeKind: boolean;
  includeCursor: boolean;
  excludeBanned: boolean;
}

/** Compile the one normalized public-list predicate used by rows + summary. */
function compileHarnessListPredicate(
  opts: PublicListOpts,
  config: ListPredicateOptions,
): { sql: string; binds: unknown[] } {
  const where: string[] = [
    'h.unlisted_at IS NULL',
    `h.review_status = 'approved'`,
  ];
  const binds: unknown[] = [];
  if (config.excludeBanned) {
    where.push(
      'NOT EXISTS (SELECT 1 FROM banned_publisher_pubkeys banned WHERE banned.pubkey = h.publisher_device_pubkey)',
    );
  }
  if (config.includeKind && opts.kind) {
    where.push('h.listing_kind = ?');
    binds.push(opts.kind);
  }
  if (opts.project_ref) {
    where.push('h.project_ref = ?');
    binds.push(opts.project_ref);
  }
  if (config.includeCursor && opts.cursor != null) {
    if (typeof opts.cursor === 'number') {
      // Back-compat for deployed clients that used the old timestamp-only cursor.
      where.push('(h.last_activity_at IS NULL OR h.last_activity_at < ?)');
      binds.push(opts.cursor);
    } else if (opts.cursor.last_activity_at == null) {
      where.push('(h.last_activity_at IS NULL AND h.id > ?)');
      binds.push(opts.cursor.id);
    } else {
      where.push(
        '(h.last_activity_at < ? OR h.last_activity_at IS NULL OR (h.last_activity_at = ? AND h.id > ?))',
      );
      binds.push(opts.cursor.last_activity_at, opts.cursor.last_activity_at, opts.cursor.id);
    }
  }
  if (opts.search) {
    where.push(
      '(h.title LIKE ? OR h.description LIKE ? OR h.github_owner LIKE ? OR h.github_name LIKE ?)',
    );
    const q = `%${opts.search}%`;
    binds.push(q, q, q, q);
  }
  if (opts.claim_status) {
    where.push('h.claim_status = ?');
    binds.push(opts.claim_status);
  }
  // ── Catalog filters (migration 018 / P-008) ────────────────────────────────
  // Appended AFTER every pre-018 clause on purpose: the bind list is consumed
  // positionally (by D1 and by the test fake), so adding here cannot renumber an
  // existing filter's binds.
  appendCatalogPredicate(where, binds, opts, 'h.');
  return { sql: where.join(' AND '), binds };
}

/**
 * The catalog-axis half of the list predicate (migration 018 / P-008), shared by
 * the public browse page and the companion summary CTE so the rows and the facet
 * counts can never disagree about who may see what.
 *
 * TENANT ISOLATION is enforced here and is FAIL-CLOSED: the base rule admits only
 * `visibility = 'public'`, and the ONLY widening is an explicit `tenant_scope`
 * the caller had to authorize. Every other filter can only remove rows. That
 * asymmetry is the property worth testing — a narrowing filter that accidentally
 * widened would leak another tenant's private catalog.
 */
function appendCatalogPredicate(
  where: string[],
  binds: unknown[],
  opts: PublicListOpts,
  prefix: '' | 'h.',
): void {
  if (opts.visibility) {
    where.push(`${prefix}visibility = ?`);
    binds.push(opts.visibility);
  }
  if (opts.tenant_ref) {
    where.push(`${prefix}tenant_id = ?`);
    binds.push(opts.tenant_ref);
  }
  if (opts.pricing_model) {
    where.push(`${prefix}pricing_model = ?`);
    binds.push(opts.pricing_model);
  }
  if (opts.paid === true) {
    where.push(`(${prefix}sku_ref IS NOT NULL AND ${prefix}pricing_model IS NOT NULL AND ${prefix}pricing_model != 'free')`);
  } else if (opts.paid === false) {
    where.push(`(${prefix}sku_ref IS NULL OR ${prefix}pricing_model IS NULL OR ${prefix}pricing_model = 'free')`);
  }
  if (opts.runtime) {
    where.push(`json_extract(${prefix}compatibility_json, '$.runtime') = ?`);
    binds.push(opts.runtime);
  }
  if (opts.platform) {
    // json_valid guards a malformed or NULL column: json_each over one would
    // raise, turning a bad row into a 500 for the whole page.
    where.push(
      `(${prefix}compatibility_json IS NOT NULL AND json_valid(${prefix}compatibility_json)` +
        ` AND EXISTS (SELECT 1 FROM json_each(${prefix}compatibility_json, '$.platforms') WHERE json_each.value = ?))`,
    );
    binds.push(opts.platform);
  }
  if (opts.permission) {
    where.push(
      `(${prefix}required_permissions IS NOT NULL AND json_valid(${prefix}required_permissions)` +
        ` AND EXISTS (SELECT 1 FROM json_each(${prefix}required_permissions) WHERE json_each.value = ?))`,
    );
    binds.push(opts.permission);
  }
  // The fail-closed visibility scope. Keep this LAST so the widening bind is the
  // final catalog bind in every query shape.
  if (opts.tenant_scope) {
    where.push(`(${prefix}visibility = 'public' OR ${prefix}tenant_id = ?)`);
    binds.push(opts.tenant_scope);
  } else {
    where.push(`${prefix}visibility = 'public'`);
  }
  if (!opts.include_withdrawn) {
    where.push(`${prefix}yanked_at IS NULL`);
    where.push(`${prefix}revoked_at IS NULL`);
  }
}

export async function listHarnesses(db: D1Database, opts: ListOpts): Promise<HarnessRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  // Static SQL avoids D1's prepared-statement string concat tax; we filter
  // unlisted always — and non-approved always (knowledge-packs D-007: pending/
  // rejected policy-kind listings are invisible to public browse; the
  // publisher reads their own via GET /:id with auth, operators via /admin).
  const where: string[] = ['unlisted_at IS NULL', `review_status = 'approved'`];
  const binds: unknown[] = [];
  if (opts.kind) {
    where.push('listing_kind = ?');
    binds.push(opts.kind);
  }
  if (opts.project_ref) {
    where.push('project_ref = ?');
    binds.push(opts.project_ref);
  }
  if (opts.cursor != null) {
    where.push('(last_activity_at IS NULL OR last_activity_at < ?)');
    binds.push(opts.cursor);
  }
  if (opts.search) {
    where.push('(title LIKE ? OR description LIKE ? OR github_owner LIKE ? OR github_name LIKE ?)');
    const q = `%${opts.search}%`;
    binds.push(q, q, q, q);
  }
  if (opts.claim_status) {
    where.push('claim_status = ?');
    binds.push(opts.claim_status);
  }
  const sql = `SELECT * FROM harnesses WHERE ${where.join(' AND ')} ORDER BY last_activity_at DESC NULLS LAST, id ASC LIMIT ?`;
  binds.push(limit);
  const stmt = db.prepare(sql);
  // .bind is variadic, spread the binds in one call
  const bound = (stmt as unknown as { bind: (...vs: unknown[]) => D1PreparedStatement }).bind(...binds);
  const res = await bound.all<HarnessRow>();
  return res.results ?? [];
}

/**
 * Public browse page. Banned publishers are excluded before LIMIT, and one
 * extra row is probed so next_cursor means there is actually another page.
 */
export async function listPublicHarnessesPage(
  db: D1Database,
  opts: PublicListOpts,
): Promise<HarnessListPage> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const predicate = compileHarnessListPredicate(opts, {
    includeKind: true,
    includeCursor: true,
    excludeBanned: true,
  });
  const binds = [...predicate.binds, limit + 1];
  const stmt = db.prepare(
    `SELECT h.* FROM harnesses h WHERE ${predicate.sql} ORDER BY h.last_activity_at DESC NULLS LAST, h.id ASC LIMIT ?`,
  );
  const bound = (stmt as unknown as { bind: (...vs: unknown[]) => D1PreparedStatement }).bind(
    ...binds,
  );
  const res = await bound.all<HarnessRow>();
  const fetched = res.results ?? [];
  const results = fetched.slice(0, limit);
  const next_cursor =
    fetched.length > limit && results.length > 0
      ? encodeListingCursor(results[results.length - 1])
      : null;
  return { results, next_cursor };
}

/**
 * One companion-summary query: total honors the selected kind, while kind
 * facets apply every other active filter and deliberately omit kind so each
 * count predicts the result of drilling into that option.
 */
export async function summarizePublicHarnesses(
  db: D1Database,
  opts: PublicListOpts,
): Promise<HarnessListSummary> {
  const population = compileHarnessListPredicate(opts, {
    includeKind: false,
    includeCursor: false,
    excludeBanned: true,
  });
  const matchedWhere = opts.kind ? 'WHERE listing_kind = ?' : '';
  const binds = [...population.binds, ...(opts.kind ? [opts.kind] : [])];
  const stmt = db.prepare(
    `WITH population AS (
       SELECT h.listing_kind
       FROM harnesses h
       WHERE ${population.sql}
     )
     SELECT 'total' AS metric, NULL AS value, COUNT(*) AS n
     FROM population ${matchedWhere}
     UNION ALL
     SELECT 'kind' AS metric, listing_kind AS value, COUNT(*) AS n
     FROM population
     GROUP BY listing_kind`,
  );
  const bound = (stmt as unknown as { bind: (...vs: unknown[]) => D1PreparedStatement }).bind(
    ...binds,
  );
  const res = await bound.all<{ metric: 'total' | 'kind'; value: ListingKind | null; n: number }>();
  const kind_facets = Object.fromEntries(LISTING_KINDS.map((kind) => [kind, 0])) as Record<
    ListingKind,
    number
  >;
  let total = 0;
  for (const row of res.results ?? []) {
    if (row.metric === 'total') total = Number(row.n) || 0;
    else if (row.value && isListingKind(row.value)) kind_facets[row.value] = Number(row.n) || 0;
  }
  return { total, kind_facets };
}

/**
 * Dedup lookup for a non-harness listing: the active row matching
 * (repo, kind, listing_ref) — the uniqueness key of
 * `harnesses_active_listing_unique`. (Harness-kind dedup keeps using
 * getHarnessByGithubRepoId, which matches the 1:1 harness-repo index.)
 */
export async function getActiveListingByRefs(
  db: D1Database,
  github_repository_id: number,
  listing_kind: ListingKind,
  listing_ref: string,
  pinned_commit_sha?: string | null,
): Promise<HarnessRow | null> {
  const pinPredicate = pinned_commit_sha === undefined
    ? ''
    : pinned_commit_sha === null
      ? 'AND pinned_commit_sha IS NULL'
      : 'AND pinned_commit_sha = ?';
  const binds: unknown[] = [github_repository_id, listing_kind, listing_ref];
  if (pinned_commit_sha != null) binds.push(pinned_commit_sha);
  const row = await db
    .prepare(
      `SELECT * FROM harnesses
         WHERE github_repository_id = ? AND listing_kind = ? AND listing_ref = ?
           AND unlisted_at IS NULL
           ${pinPredicate}
         LIMIT 1`,
    )
    .bind(...binds)
    .first<HarnessRow>();
  return row ?? null;
}


export async function markHarnessUnlisted(
  db: D1Database,
  id: string,
  reason: string,
  now_ms: number,
): Promise<void> {
  await db
    .prepare(`UPDATE harnesses SET unlisted_at = ?, unlisted_reason = ?, updated_at = ? WHERE id = ?`)
    .bind(now_ms, reason, now_ms, id)
    .run();
}

/** Retire the prior active version before inserting a changed pinned version. */
export async function supersedeHarnessListing(
  db: D1Database,
  oldId: string,
  successorId: string,
  reason: string,
  now_ms: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE harnesses
          SET superseded_by = ?, claim_status = 'superseded', unlisted_at = ?,
              unlisted_reason = ?, updated_at = ?
        WHERE id = ? AND unlisted_at IS NULL`,
    )
    .bind(successorId, now_ms, reason, now_ms, oldId)
    .run();
}

export async function updateHarnessStats(
  db: D1Database,
  id: string,
  stats: {
    stars: number;
    contributor_count: number;
    last_activity_at: number | null;
    languages: string | null;
  },
  now_ms: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE harnesses
         SET stars = ?,
             contributor_count = ?,
             last_activity_at = ?,
             languages = ?,
             stats_refreshed_at = ?,
             updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      stats.stars,
      stats.contributor_count,
      stats.last_activity_at,
      stats.languages,
      now_ms,
      now_ms,
      id,
    )
    .run();
}

/**
 * Clear a listing's channel-2 attestation (item 1). Called by the indexer
 * when the attestation gist is deleted (revocation) or no longer binds the
 * stored device pubkey to the publisher (invalid). Leaves the listing up —
 * it just loses its verified-publisher signal.
 */
export async function clearHarnessAttestation(
  db: D1Database,
  id: string,
  now_ms: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE harnesses
         SET publisher_device_pubkey = NULL,
             publisher_attestation_gist_id = NULL,
             updated_at = ?
       WHERE id = ?`,
    )
    .bind(now_ms, id)
    .run();
}

export async function setHarnessClaim(
  db: D1Database,
  id: string,
  claim: { user_id: number; login: string },
  now_ms: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE harnesses
         SET claim_status = 'claimed',
             claimant_github_user_id = ?,
             claimant_github_login = ?,
             updated_at = ?
       WHERE id = ?`,
    )
    .bind(claim.user_id, claim.login, now_ms, id)
    .run();
}

export async function insertReport(db: D1Database, r: Omit<ReportRow, 'status' | 'resolved_at' | 'resolved_by_operator_note'>): Promise<void> {
  await db
    .prepare(
      `INSERT INTO reports
         (id, harness_id, reporter_github_user_id, reporter_github_login,
          reason, ip_hash, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .bind(r.id, r.harness_id, r.reporter_github_user_id, r.reporter_github_login, r.reason, r.ip_hash, r.created_at)
    .run();
}

/** A report joined with a thin summary of its target harness, for the
 *  operator moderation list (avoids an N+1 fetch per report). */
export interface ReportWithHarness extends ReportRow {
  harness_title: string | null;
  harness_github_url: string | null;
  harness_unlisted_at: number | null;
}

/**
 * List reports for the operator moderation surface, newest-pending-first.
 * `status` filters to one lifecycle state; omit (or pass 'all') for every
 * report. Joined with the harness so the operator sees what's being reported
 * without a second round-trip.
 */
export async function listReports(
  db: D1Database,
  opts: { status?: ReportRow['status'] | 'all'; limit?: number } = {},
): Promise<ReportWithHarness[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const filterStatus = opts.status && opts.status !== 'all';
  const sql =
    `SELECT r.*,
            h.title AS harness_title,
            h.github_url AS harness_github_url,
            h.unlisted_at AS harness_unlisted_at
       FROM reports r
       LEFT JOIN harnesses h ON h.id = r.harness_id` +
    (filterStatus ? ` WHERE r.status = ?` : ``) +
    ` ORDER BY r.created_at ASC LIMIT ?`;
  const binds: unknown[] = filterStatus ? [opts.status, limit] : [limit];
  const stmt = db.prepare(sql);
  const bound = (stmt as unknown as { bind: (...vs: unknown[]) => D1PreparedStatement }).bind(...binds);
  const res = await bound.all<ReportWithHarness>();
  return res.results ?? [];
}

export async function getReportById(db: D1Database, id: string): Promise<ReportRow | null> {
  const row = await db
    .prepare('SELECT * FROM reports WHERE id = ?')
    .bind(id)
    .first<ReportRow>();
  return row ?? null;
}

/**
 * Resolve a pending report. Idempotency guard: the WHERE pins `status =
 * 'pending'`, so resolving an already-resolved report changes 0 rows — the
 * caller treats `changes === 0` as "already handled / not found". Returns the
 * number of rows changed.
 */
export async function resolveReport(
  db: D1Database,
  id: string,
  opts: { status: 'resolved_unlist' | 'resolved_dismiss'; note: string | null; now_ms: number },
): Promise<number> {
  const res = await db
    .prepare(
      `UPDATE reports
          SET status = ?, resolved_at = ?, resolved_by_operator_note = ?
        WHERE id = ? AND status = 'pending'`,
    )
    .bind(opts.status, opts.now_ms, opts.note, id)
    .run();
  return (res as { meta?: { changes?: number } }).meta?.changes ?? 0;
}

export async function audit(
  db: D1Database,
  ts: number,
  kind: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await db
    .prepare('INSERT INTO audit (ts, kind, detail) VALUES (?, ?, ?)')
    .bind(ts, kind, JSON.stringify(detail))
    .run();
}

// ── Authenticated creator drafts (P-007) ────────────────────────

export type CreatorDraftState =
  | 'draft'
  | 'submitted'
  | 'approved'
  | 'rejected'
  | 'published'
  | 'yanked'
  | 'revoked';

export interface CreatorDraftRow {
  id: string;
  owner_github_user_id: number;
  owner_github_login: string;
  listing_kind: ListingKind;
  listing_ref: string | null;
  title: string;
  description: string | null;
  manifest_json: string;
  provenance_json: string;
  state: CreatorDraftState;
  artifact_key: string | null;
  artifact_content_hash: string | null;
  artifact_size_bytes: number | null;
  artifact_content_type: string | null;
  upload_token_hash: string | null;
  upload_expires_at: number | null;
  reviewed_at: number | null;
  reviewed_by_github_user_id: number | null;
  review_reason: string | null;
  published_listing_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface NewCreatorDraftInput {
  id: string;
  owner_github_user_id: number;
  owner_github_login: string;
  listing_kind: ListingKind;
  listing_ref: string | null;
  title: string;
  description: string | null;
  manifest_json: string;
  provenance_json: string;
  upload_token_hash: string;
  upload_expires_at: number;
  created_at: number;
}

export async function insertCreatorDraft(db: D1Database, draft: NewCreatorDraftInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO creator_drafts
       (id, owner_github_user_id, owner_github_login, listing_kind, listing_ref,
        title, description, manifest_json, provenance_json, state,
        upload_token_hash, upload_expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
    )
    .bind(
      draft.id,
      draft.owner_github_user_id,
      draft.owner_github_login,
      draft.listing_kind,
      draft.listing_ref,
      draft.title,
      draft.description,
      draft.manifest_json,
      draft.provenance_json,
      draft.upload_token_hash,
      draft.upload_expires_at,
      draft.created_at,
      draft.created_at,
    )
    .run();
}

export async function getCreatorDraft(db: D1Database, id: string): Promise<CreatorDraftRow | null> {
  const row = await db.prepare('SELECT * FROM creator_drafts WHERE id = ?').bind(id).first<CreatorDraftRow>();
  return row ?? null;
}

export async function listCreatorDrafts(
  db: D1Database,
  opts: { ownerId?: number; state?: CreatorDraftState; limit?: number } = {},
): Promise<CreatorDraftRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 200);
  const where: string[] = [];
  const binds: unknown[] = [];
  if (opts.ownerId != null) {
    where.push('owner_github_user_id = ?');
    binds.push(opts.ownerId);
  }
  if (opts.state) {
    where.push('state = ?');
    binds.push(opts.state);
  }
  const sql = `SELECT * FROM creator_drafts${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC LIMIT ?`;
  binds.push(limit);
  const stmt = db.prepare(sql);
  const bound = (stmt as unknown as { bind: (...values: unknown[]) => D1PreparedStatement }).bind(...binds);
  const result = await bound.all<CreatorDraftRow>();
  return result.results ?? [];
}

export async function setCreatorDraftArtifact(
  db: D1Database,
  id: string,
  artifact: {
    key: string;
    contentHash: string;
    sizeBytes: number;
    contentType: string;
    now: number;
  },
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE creator_drafts
          SET artifact_key = ?, artifact_content_hash = ?, artifact_size_bytes = ?,
              artifact_content_type = ?, upload_token_hash = NULL, upload_expires_at = NULL,
              updated_at = ?
        WHERE id = ? AND state = 'draft'`,
    )
    .bind(artifact.key, artifact.contentHash, artifact.sizeBytes, artifact.contentType, artifact.now, id)
    .run();
  return (result as { meta?: { changes?: number } }).meta?.changes ?? 0;
}

export async function setCreatorDraftState(
  db: D1Database,
  id: string,
  from: CreatorDraftState,
  to: CreatorDraftState,
  now: number,
  extra: {
    reviewedBy?: number | null;
    reviewReason?: string | null;
    publishedListingId?: string | null;
  } = {},
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE creator_drafts
          SET state = ?, reviewed_at = COALESCE(?, reviewed_at),
              reviewed_by_github_user_id = COALESCE(?, reviewed_by_github_user_id),
              review_reason = COALESCE(?, review_reason),
              published_listing_id = COALESCE(?, published_listing_id), updated_at = ?
        WHERE id = ? AND state = ?`,
    )
    .bind(
      to,
      extra.reviewedBy == null ? null : now,
      extra.reviewedBy ?? null,
      extra.reviewReason ?? null,
      extra.publishedListingId ?? null,
      now,
      id,
      from,
    )
    .run();
  return (result as { meta?: { changes?: number } }).meta?.changes ?? 0;
}

// ── Channel-2 publisher ban-list (item 1) ───────────────────────

export type BannedPubkeyRow = BannedPublisherPubkeysRow;

/** Set of banned publisher device pubkeys, for filtering public listings. */
export async function listBannedPubkeySet(db: D1Database): Promise<Set<string>> {
  const res = await db
    .prepare('SELECT pubkey FROM banned_publisher_pubkeys')
    .all<{ pubkey: string }>();
  return new Set((res.results ?? []).map((r) => r.pubkey));
}

export async function listBannedPubkeys(db: D1Database): Promise<BannedPubkeyRow[]> {
  const res = await db
    .prepare('SELECT * FROM banned_publisher_pubkeys ORDER BY added_at DESC')
    .all<BannedPubkeyRow>();
  return res.results ?? [];
}

export async function banPublisherPubkey(
  db: D1Database,
  pubkey: string,
  reason: string,
  operatorUserId: number | null,
  now_ms: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO banned_publisher_pubkeys (pubkey, reason, added_at, added_by_operator_user_id, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(pubkey) DO UPDATE SET reason = ?, updated_at = ?`,
    )
    .bind(pubkey, reason, now_ms, operatorUserId, now_ms, reason, now_ms)
    .run();
}

export async function unbanPublisherPubkey(db: D1Database, pubkey: string): Promise<void> {
  await db.prepare('DELETE FROM banned_publisher_pubkeys WHERE pubkey = ?').bind(pubkey).run();
}

export function clientIp(req: Request): string {
  // Cloudflare Workers attaches the originating IP here.
  return req.headers.get('cf-connecting-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '';
}

export async function ipHash(ip: string, pepper: string): Promise<string> {
  if (!ip) return '';
  const enc = new TextEncoder();
  const buf = enc.encode(`${ip}:${pepper}`);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}
