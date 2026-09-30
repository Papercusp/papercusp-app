/**
 * cupboard/types — public-facing API surface for the Phase 9
 * Cupboard registry server per papercusp-dogfood-v5 §10
 * (`papercusp-dogfood-phase9-cupboard-discord-sync-2026-05-24.md`
 * P-051a/P-051b).
 *
 * Types-only and PURE. No HTTP client, no fetch wrapper, no PG.
 * Both sides of the wire consume these:
 *   - The desktop operator client (when Phase 9 client wiring lands)
 *   - The `apps/operator-public/` server itself (when P-051a lands)
 *
 * Thirteenth module in the dogfood-arc types-only spine.
 *
 * Mirrors the §10.2 schema + §10.3 auth endpoints verbatim. When
 * the runtime Cupboard impl drops in, both client + server import
 * these types so wire compatibility is enforced at the type system
 * boundary, not at integration-test time.
 *
 * Why types-first matters here especially: Cupboard is the FIRST
 * cross-server contract in the dogfood arc. Wire-format drift
 * between desktop client and Cupboard server is impossible to
 * unit-test without spinning up both — pinning the types in the
 * shared package means any field-rename, status-string change, or
 * error-code shift is caught by `tsc` on both sides simultaneously.
 */

/**
 * Wire-version of the Cupboard listing shape. Bump if columns
 * change. Clients reject unknown versions to fail fast on
 * server-newer-than-client mismatch.
 */
export const CUPBOARD_SCHEMA_VERSION = 1 as const;
export type CupboardSchemaVersion = typeof CUPBOARD_SCHEMA_VERSION;

/**
 * Lifecycle states for a harness listing per v5 §10.2 CHECK
 * constraint. `claimed` means a verified maintainer has bound the
 * harness to an account; `unclaimed` is the default provisional
 * state; `stale` is reserved for listings whose binding has gone
 * dark; `superseded` is set when an admin replaces the listing.
 */
export const CUPBOARD_CLAIM_STATUSES = [
  'unclaimed',
  'claimed',
  'stale',
  'superseded',
] as const;
export type CupboardClaimStatus = (typeof CUPBOARD_CLAIM_STATUSES)[number];

/**
 * The storefront listing kinds (Cupboard worker migrations 004 + 006 + 008 /
 * distribution plan D-005, tool-distribution-granularity D-001,
 * learning-packs-2026-06-11 D-005). ONE storefront, each kind with its own
 * consumer action:
 *   harness       → view-hive (the repo→Hive lookup index)
 *   blueprint     → install   (clone the blueprint listing into the installed tier)
 *   plugin        → install   (a distributable plugin — a pack WITH a runtime)
 *   pack          → install   (a runtime-less code-tool pack; n≥1 tools —
 *                              RENAMED from 'tool-pack' by worker migration 010
 *                              cupboard-public-release-2026-07-12 P-003; the
 *                              interim 'tool-pack' AND the pre-008 'pack' wire
 *                              values both parse to 'pack' via listingKindOf.
 *                              The plugin manifest already uses kind:'pack'.)
 *   knowledge-pack → install   (a distributable set of curated hive learnings,
 *                              installed into a hive's shared memory through
 *                              the conflict review)
 *   template      → install   (a first-party app-template — a GitHub-repo-backed
 *                              per-`listing_ref` subdir with template.yaml +
 *                              GUIDE.md; installing drops the dir into the user
 *                              template store the materializer reads, cf.
 *                              cupboard-full-dogfood-2026-07-10 P-003)
 *   rubric        → install   (a graded acceptance/quality rubric — a self-describing
 *                              dir of rubric.json + listing.json + optional METHOD.md.
 *                              Installing drops it into the writable user layer of the
 *                              layered rubric store (cupboard/rubric-store.ts), whose
 *                              existing idempotent no-clobber seed carries it into the
 *                              workspace rubric store. cf. cupboard-plan-rubric-recipe
 *                              -sharing-2026-08-21 P-002; the v1 local store was
 *                              explicitly built for this install target.)
 *   plan          → install   (a PLAN TEMPLATE — goal + item DAG + decisions +
 *                              schedule, with live state stripped at publish. Installs
 *                              as a template row, never a live plan; instantiate it
 *                              through the ordinary plans machinery. May declare
 *                              `requires_rubrics`.)
 *   recipe        → install   (a captured multi-step tool orchestration — the
 *                              code_recipes unit — installed into the workspace
 *                              recipe store.)
 *   goal          → install   (a GOAL PACKAGE — title + duties body/kickoff brief +
 *                              standing flag + tripwire/budget-window/launch-setting
 *                              defaults + input/output schemas, per
 *                              work-on-everything-goal-2026-08-23 P-006/D-002.
 *                              Installing lands an INACTIVE goal stub (status
 *                              'paused', no agent, no spend), NO-CLOBBER on the
 *                              package identity; STARTING it is a separate
 *                              deliberate act. May declare `requires_rubrics`,
 *                              same as `plan`.)
 *   theme         → install   (an inert semantic-token theme package. Installing
 *                              adds it to the existing theme picker; selecting it
 *                              is a separate explicit action.)
 *   app           → download  (STANDALONE) | install (BUNDLE) — a whole
 *                              distributable application (cupboard-app-distribution
 *                              -2026-07-14 [owner 2026-07-14]). The
 *                              `delivery_type` field discriminates the two models:
 *                              a `'standalone'` app is a separate downloadable
 *                              product (e.g. Oddsmith, a Tauri desktop app built on
 *                              the papercusp platform) — "install" = DOWNLOAD the
 *                              platform installer from its GitHub release via
 *                              `latest_json_url` (the Cupboard never re-hosts the
 *                              binary); a `'bundle'` app is a papercusp-native
 *                              composition (datatypes + plugins + blueprint) that
 *                              installs into your workspace (Phase 2, deferred).
 *
 * The `snapshot` kind was retired (retire-snapshots-instance-spec-2026-06-09 D-005):
 * the Cupboard distributes RECIPES (blueprints), not binary tarballs; the
 * reproducible clone is the lightweight InstanceSpec, not a published snapshot.
 *
 * Review policy (knowledge-packs D-007): `knowledge-pack` + `blueprint` listings
 * publish PENDING and surface publicly only after operator approval — see
 * `review_status` on the row + `isPendingReview()`.
 */
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
  'theme',
  'datatype',
  'rule',
  'event',
] as const;
export type ListingKind = (typeof LISTING_KINDS)[number];

/**
 * One entry of a listing's `requires_rubrics` (Cupboard worker migration 015 / D-001):
 * a rubric the unit REQUIRES to be present after install. Deliberately field-for-field
 * the consumer half of the event axis (`requires_events`, migration 013): a missing
 * `optional` means REQUIRED, and a required rubric nothing can provide is a HARD
 * install failure — which is exactly why the listing carries it, so the detail page can
 * show the requirement BEFORE the user clicks Install.
 *
 * Resolution order (see resolveRubricRequirements): the installing workspace's own
 * rubric store — INCLUDING the bundled first-party set — counts as PROVIDED; otherwise
 * a `kind='rubric'` Cupboard listing is offered as a co-install; otherwise refuse.
 */
export interface RubricRequirement {
  /** The required rubric's id/ref (matches a rubric listing's `listing_ref`). */
  rubricRef: string;
  /** Absent/false ⇒ REQUIRED (hard-gates the install). True ⇒ nice-to-have. */
  optional?: boolean;
}

/** Tolerant parse of the JSON-encoded `requires_rubrics` column. Never throws: a
 *  malformed/absent value yields [] so a bad row degrades to "declares no rubric
 *  deps" rather than breaking the storefront. Entries lacking a string `rubricRef`
 *  are dropped individually. */
export function parseRequiredRubrics(raw: string | null | undefined): RubricRequirement[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: RubricRequirement[] = [];
    for (const e of parsed) {
      if (typeof e !== 'object' || e === null) continue;
      const o = e as Record<string, unknown>;
      const rubricRef = typeof o.rubricRef === 'string' && o.rubricRef !== '' ? o.rubricRef : null;
      if (!rubricRef) continue;
      out.push({ rubricRef, ...(o.optional === true ? { optional: true } : {}) });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * The delivery model for a `listing_kind: 'app'` row (cupboard-app-distribution
 * -2026-07-14 D-001 [owner 2026-07-14]):
 *   standalone → a separate downloadable product (own installer/binary), e.g. the
 *                Oddsmith Tauri desktop app. "Install" = download the platform
 *                installer from the app's GitHub release; the Cupboard hands off a
 *                download link and never re-hosts the binary.
 *   bundle     → a papercusp-native composition (datatypes + plugins + blueprint)
 *                that installs INTO the user's workspace (Phase 2, deferred).
 * Only meaningful when `listing_kind === 'app'`; absent on every other kind.
 */
export const APP_DELIVERY_TYPES = ['standalone', 'bundle'] as const;
export type AppDeliveryType = (typeof APP_DELIVERY_TYPES)[number];

export function isListingKind(v: unknown): v is ListingKind {
  return typeof v === 'string' && (LISTING_KINDS as readonly string[]).includes(v);
}

/**
 * Catalog visibility (Cupboard worker migration 018 / shared-pot-dao-cupboard-v1
 * P-008, D-027). Kind-agnostic: every one of the eleven listing kinds carries it.
 *
 *   public   → listed in the global catalog. Every pre-018 row backfills to this,
 *              which is what makes the migration safe to apply to a live D1 while
 *              the worker is serving.
 *   unlisted → reachable by direct id/ref, never returned by browse.
 *   private  → visible only within the owning tenant (`tenant_id`).
 *
 * Read paths are FAIL-CLOSED: without a tenant scope only `public` rows are
 * visible. `tenant_scope` is the one widening read and the unauthenticated public
 * route never sets it — see `appendCatalogPredicate` in the worker's src/db.ts.
 * Mirrors LISTING_VISIBILITIES there; the two must stay in step.
 */
export const LISTING_VISIBILITIES = ['public', 'unlisted', 'private'] as const;
export type ListingVisibility = (typeof LISTING_VISIBILITIES)[number];

export function isListingVisibility(v: unknown): v is ListingVisibility {
  return typeof v === 'string' && (LISTING_VISIBILITIES as readonly string[]).includes(v);
}

/**
 * Provider-neutral pricing model (worker migration 018 / P-008, D-025 + D-028).
 *
 * Deliberately says nothing about WHO settles the payment: a settlement adapter
 * maps the listing's opaque `sku_ref` to its own product, so the catalog never
 * learns which adapter is in use and swapping one changes no schema and no type
 * here. Mirrors PRICING_MODELS in the worker's src/db.ts.
 */
export const PRICING_MODELS = ['free', 'one-time', 'subscription', 'per-use'] as const;
export type PricingModel = (typeof PRICING_MODELS)[number];

export function isPricingModel(v: unknown): v is PricingModel {
  return typeof v === 'string' && (PRICING_MODELS as readonly string[]).includes(v);
}

export type ListingAction = 'view-hive' | 'install' | 'download';

/**
 * The consumer action for a listing ROW (comb-retire-per-harness-sharing
 * D-001/D-003). Per-harness sharing is retired: a `kind='harness'` row is the
 * repo→Hive lookup index (worker mig 007), not a joinable unit — hive-bound
 * rows point at the per-Hive rollup; legacy rows (no `hive_pubkey`) have no
 * primary action (`null`). blueprint + plugin/pack → install (clone the listing).
 *
 * An `app` row's action forks on `delivery_type` (cupboard-app-distribution
 * D-001 [owner 2026-07-14]): a STANDALONE app → 'download' (hand off the
 * platform installer link — v1 is download-link handoff only); a BUNDLE app →
 * 'install' (compose it into the workspace, Phase 2). A standalone app row with
 * `delivery_type` absent still defaults to 'download' — the safe, no-side-effect
 * action for a distributed executable.
 */
export function listingActionFor(l: HarnessListing): ListingAction | null {
  switch (listingKindOf(l)) {
    case 'harness':
      return l.hive_pubkey ? 'view-hive' : null;
    case 'blueprint':
    case 'plugin':
    case 'pack':
    case 'knowledge-pack':
    case 'template':
    case 'rubric':
    case 'plan':
    case 'recipe':
    // A rule is an installable behaviour ("when X, fire Y"), so it installs
    // exactly like the recipe it resembles (identities-v1 D-011/D-055, P-028).
    case 'rule':
    case 'goal':
    case 'theme':
    case 'datatype':
    // An event DECLARATION is a registry entry, exactly like the `datatype` it
    // sits beside: installing it is what makes the key RESOLVE locally, so a
    // rule's `on` and an agent's `await` can bind to it (identities-v1 D-057,
    // P-029). Awaiting a key is not the install; registering the declaration is.
    case 'event':
      return 'install';
    case 'app':
      return l.delivery_type === 'bundle' ? 'install' : 'download';
  }
}

/** Human label for a kind's action button. */
export const LISTING_ACTION_LABEL: Record<ListingAction, string> = {
  'view-hive': 'View Hive',
  // blueprint + plugin + pack + knowledge-pack + bundle-app all → 'install' (clone the listing).
  install: 'Install',
  // standalone-app → 'download' (hand off the platform installer link).
  download: 'Download',
};

// ── Display helpers ──────────────────────────────────────────────────────────
// The live Cupboard worker returns a row whose field set (github_owner/name,
// contributor_count, languages JSON, uuid id) differs from the aspirational
// `HarnessListing` fields (slug, github_repo, contributor_count_estimate,
// language). These pure helpers read whichever shape is present so the UI
// renders correctly against real data without per-call branching.

/** A listing's kind, defaulting to 'harness' for pre-004 / aspirational rows.
 *  The interim 'tool-pack' value (migration 008) — from rows on a server not yet
 *  migrated to 010 or an older client — normalizes forward to the canonical
 *  'pack' (cupboard-public-release-2026-07-12 P-003). A pre-008 literal 'pack'
 *  already IS the canonical value, so it passes through isListingKind. */
export function listingKindOf(l: HarnessListing): ListingKind {
  if (l.listing_kind === 'tool-pack') return 'pack';
  return isListingKind(l.listing_kind) ? l.listing_kind : 'harness';
}

/** A blueprint listing whose blueprint.yaml `kind` is 'hive' — an installable HIVE
 *  template (generic-hive, …), the Cupboard "Hives" tab's members (P-018). A blueprint
 *  listing with `blueprint_kind` absent/`'harness'` is an ordinary harness blueprint. */
export function isHiveBlueprintListing(l: HarnessListing): boolean {
  // dual-accept: pre-rename PUBLISHED listings still carry blueprint_kind 'hive'
  // (external cupboard data we don't control); new publishes stamp 'pot'.
  return listingKindOf(l) === 'blueprint' && (l.blueprint_kind === 'pot' || l.blueprint_kind === 'hive');
}

/** Pre-publication review (worker migration 008 / knowledge-packs D-007):
 *  pending/rejected listings are publicly invisible server-side; this badge
 *  helper is for the PUBLISHER's own views (their pending rows + reasons). */
export function isPendingReview(l: HarnessListing): boolean {
  return l.review_status === 'pending';
}

/** `<owner>/<repo>` for the listing, from either field shape. '' if unknown. */
export function listingRepoSlug(l: HarnessListing): string {
  if (l.github_repo) return l.github_repo;
  if (l.github_owner && l.github_name) return `${l.github_owner}/${l.github_name}`;
  return '';
}

/** Contributor count from either shape. */
export function listingContributorCount(l: HarnessListing): number {
  return l.contributor_count ?? l.contributor_count_estimate ?? 0;
}

/** Primary language: the explicit field, else the top language by bytes from the worker's `languages` JSON. */
export function listingTopLanguage(l: HarnessListing): string | null {
  if (l.language) return l.language;
  if (l.languages) {
    try {
      const obj = JSON.parse(l.languages) as Record<string, number>;
      let top: string | null = null;
      let max = -1;
      for (const [lang, bytes] of Object.entries(obj)) {
        if (bytes > max) { max = bytes; top = lang; }
      }
      return top;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The "Hive" a listing belongs to — the project-centric grouping key
 * (D-008 / project-centric-rethink D-014). A Hive is one project, and the
 * Cupboard is "the home for a Hive's distributable facets" (recipe/blueprint ·
 * plugin · harness). Prefer the explicit `project_ref` (the
 * papercupai project remote); fall back to the repo slug for legacy/standalone
 * listings that predate project-centric keying. '' ⇒ ungroupable (no project
 * identity) — callers should hide the per-Hive affordance.
 */
export function listingHiveRef(l: HarnessListing): string {
  if (l.project_ref) return l.project_ref;
  return listingRepoSlug(l);
}

/** One kind's slice of a Hive's listings, for the per-Hive rollup view. */
export interface ListingKindGroup {
  kind: ListingKind;
  listings: HarnessListing[];
}

/**
 * Group listings by kind in canonical `LISTING_KINDS` order, dropping empty
 * kinds. Powers the per-Hive rollup view (distribution D-005 / revive-cupboard
 * D-005): presents a Hive's recipe / plugin / harness facets
 * together, each under its own kind heading. Pure — the caller pre-filters to
 * the Hive (`listingHiveRef(l) === hive`) before grouping.
 */
export function groupListingsByKind(listings: HarnessListing[]): ListingKindGroup[] {
  return LISTING_KINDS.map((kind) => ({
    kind,
    listings: listings.filter((l) => listingKindOf(l) === kind),
  })).filter((g) => g.listings.length > 0);
}

/**
 * The hive-native rollup key for a listing (comb-hive-native-sharing-2026-06-11
 * P-001/P-002): hives are the browsable, joinable unit, so a hive-bound row
 * keys by its owning Hive's identity pubkey — which all member-repo rows share,
 * unlike `project_ref` (the hive publish path doesn't set one). Legacy rows
 * fall back to listingHiveRef. The `?hive=` rollup accepts both forms; see
 * isHivePubkeyRef for the discriminator.
 */
export function listingHiveKey(l: HarnessListing): string {
  return l.hive_pubkey ?? listingHiveRef(l);
}

/** Raw-32-byte base64 (the directory-announce hive_pubkey encoding): exactly
 *  43 base64 chars + one '=' pad. Project/repo refs always carry a '/'. */
const HIVE_PUBKEY_B64_RE = /^[A-Za-z0-9+/]{43}=$/;

/**
 * Does a `?hive=` rollup value name a Hive by identity pubkey (raw-32-byte
 * Ed25519, base64 — the same encoding as `hive_pubkey` on listings and the
 * directory announce) rather than a legacy project/repo ref?
 */
export function isHivePubkeyRef(v: string): boolean {
  return HIVE_PUBKEY_B64_RE.test(v);
}

/** One Hive's slice of the flat browse (comb-hive-native-sharing P-002). */
export interface HiveBrowseGroup {
  hivePubkey: string;
  /** Denormalized display title from the member rows (the directory announce
   *  stays the content authority; null when no row carries one). */
  hiveTitle: string | null;
  /** The hive's member-repo rows present on THIS result page — the worker
   *  paginates, so member/claim counts are per-page, not global. */
  members: HarnessListing[];
  claimedCount: number;
}

/**
 * Group kind='harness' rows by owning Hive for the hive-first browse
 * (comb-hive-native-sharing P-002 / D-001): hive-bound member rows fold into
 * ONE group per hive; rows with no `hive_pubkey` are pre-hive legacy listings.
 * Pure and page-scoped — callers surface the pagination caveat on counts.
 * Non-harness rows are ignored (callers pre-split by kind).
 */
export function groupHarnessRowsByHive(rows: HarnessListing[]): {
  hives: HiveBrowseGroup[];
  legacy: HarnessListing[];
} {
  const hives = new Map<string, HiveBrowseGroup>();
  const legacy: HarnessListing[] = [];
  for (const l of rows) {
    if (listingKindOf(l) !== 'harness') continue;
    if (!l.hive_pubkey) {
      legacy.push(l);
      continue;
    }
    let g = hives.get(l.hive_pubkey);
    if (!g) {
      g = { hivePubkey: l.hive_pubkey, hiveTitle: null, members: [], claimedCount: 0 };
      hives.set(l.hive_pubkey, g);
    }
    g.members.push(l);
    if (!g.hiveTitle && l.hive_title) g.hiveTitle = l.hive_title;
    if (l.claim_status === 'claimed') g.claimedCount += 1;
  }
  return { hives: [...hives.values()], legacy };
}

/**
 * GitHub-side permission ladder per v5 §10.3. Claim verification
 * requires `maintain` or `admin`; supersede requires `admin`.
 */
export const CUPBOARD_GITHUB_PERMISSIONS = [
  'pull',
  'triage',
  'push',
  'maintain',
  'admin',
] as const;
export type CupboardGithubPermission = (typeof CUPBOARD_GITHUB_PERMISSIONS)[number];

/**
 * Permissions sufficient to claim a harness.
 */
export const CLAIM_REQUIRED_PERMISSIONS: ReadonlySet<CupboardGithubPermission> = new Set([
  'maintain',
  'admin',
] as const);

/**
 * Permissions sufficient to supersede a harness.
 */
export const SUPERSEDE_REQUIRED_PERMISSIONS: ReadonlySet<CupboardGithubPermission> = new Set([
  'admin',
] as const);

/**
 * The §10.2 `harnesses` row shape, narrowed to the fields the
 * client/server wire carries. (`id` + `created_at` + `updated_at`
 * are server-assigned but surface in the response.)
 */
export interface HarnessListing {
  id: number;
  slug: string;
  title: string;
  description: string;
  /** Full join URL — `papercusp://harness?topic=...&github=...&repo_id=...`. */
  harness_link: string;

  // ── Storefront listing-kind fields (Cupboard worker migration 004 / D-005) ──
  // The live worker returns these on every row; older servers omit them, so
  // they are optional. `listing_kind` drives the per-kind consumer action
  // (join/fork/install); `project_ref`/`listing_ref` carry the project-centric
  // 1:N identity (D-008). See `listingAction()`.
  /** harness | blueprint | plugin | pack | knowledge-pack | template | app.
   *  Absent ⇒ treat as 'harness'; the interim 'tool-pack' wire value (mig 008)
   *  normalizes to 'pack' via listingKindOf (cupboard-public-release P-003).
   *  'app' (worker migration 014 / cupboard-app-distribution) carries the
   *  `delivery_type` + app-distribution fields below. */
  listing_kind?: ListingKind | 'tool-pack';
  /** Papercupai project remote this listing belongs to (D-008); null = legacy/standalone. */
  project_ref?: string | null;
  /** Within-project discriminator (blueprint stream / plugin/pack slug). */
  listing_ref?: string | null;
  /** For a `listing_kind: 'blueprint'` row: the blueprint.yaml `kind` — 'hive' (a hive
   *  template) | 'harness'. Absent/null for non-blueprint listings + pre-009 rows
   *  (Cupboard migration 009 / hive-blueprint-generalization P-018). Drives the Hives tab. */
  blueprint_kind?: 'pot' | 'hive' | 'harness' | null;

  // ── App-distribution fields (Cupboard worker migration 014 /
  // cupboard-app-distribution-2026-07-14 P-001 [owner 2026-07-14]). Present
  // only for `listing_kind: 'app'` rows; absent/null on every other kind.
  // A STANDALONE app is distributed by download-link handoff (v1): the Cupboard
  // points at the app's own GitHub release, it never re-hosts the binary. ──
  /**
   * Which app delivery model this row uses (only for `listing_kind: 'app'`):
   * 'standalone' (a separate downloadable product) | 'bundle' (a papercusp-native
   * composition, Phase 2). Absent on an app row ⇒ treat as 'standalone' (the safe
   * download-handoff default). Drives `listingActionFor` → 'download' vs 'install'.
   */
  delivery_type?: AppDeliveryType | null;
  /**
   * STANDALONE only: URL of the app's signed `latest.json` updater manifest
   * (`@papercusp/tauri-release-kit` `buildLatestManifest` output —
   * `{ version, platforms: { <os>: { signature, url } }, notes?, pub_date? }`).
   * The download flow fetches this to resolve the platform-specific installer
   * URL. Null ⇒ no release manifest published yet.
   */
  latest_json_url?: string | null;
  /**
   * STANDALONE only: `<owner>/<repo>` of the GitHub repository whose Releases
   * host the app's installers (the download target). Distinct from `github_repo`
   * (the source repo) for apps whose releases live in a dedicated repo. Null ⇒
   * fall back to `github_repo`.
   */
  release_repo?: string | null;
  /**
   * App icon URL for the storefront card/detail (an app is a whole product, so it
   * gets a real icon rather than a kind glyph). Null ⇒ render the default app icon.
   */
  icon_url?: string | null;
  /**
   * Denormalized platform availability for the listing card, JSON-encoded
   * string[] of OS keys present in `latest.json` (e.g. `["darwin-aarch64",
   * "linux-x86_64","windows-x86_64"]`) — lets the card show "macOS · Linux ·
   * Windows" without fetching the manifest. Null ⇒ platforms unknown until the
   * manifest is fetched.
   */
  platforms?: string | null;

  // ── Repo→Hive binding fields (Cupboard worker migration 007 /
  // hive-from-github-url-2026-06-11 P-004, D-004 HYBRID ratified per D-008).
  // The Cupboard is the uniqueness + off-network index for PUBLIC hives: one
  // row per member repo, all carrying the same `hive_pubkey`, so pasting ANY
  // member repo's URL finds the owning Hive. The signed directory announce
  // stays the CONTENT authority — these are lookup keys, not truth. ──
  /**
   * The owning Hive's raw 32-byte Ed25519 public key, base64 — the SAME
   * encoding as the hive directory announce (`HiveAnnounceBody.hive_pubkey`).
   * Absent/null ⇒ pre-hive listing or a plain shared-harness binding.
   */
  hive_pubkey?: string | null;
  /**
   * Denormalized display title of the owning Hive, for off-network browse.
   * The directory announce wins on conflict; null/absent when unknown.
   */
  hive_title?: string | null;
  /**
   * Pack model (worker migration 006): JSON-encoded string[] of the MCP tool
   * names the unit registers when installed (kinds plugin|pack only). The
   * tool→provider resolver (pack-catalog/pack-model) parses it to answer
   * "which Cupboard unit provides tool X?". Absent/null ⇒ no declared tools.
   */
  provides_tools?: string | null;
  /**
   * Tool axis, CONSUMER half (worker migration 033 / WI-10001747): JSON-encoded
   * string[] of the MCP tool names the unit ORCHESTRATES but does not provide
   * (kinds recipe|plan|goal). This is the mirror of `provides_tools`, not a
   * synonym: nothing resolves a provider from it and installing the unit
   * registers none of these tools — it is a declaration of what the unit
   * CALLS, so the storefront can show a recipe's tool surface and a browser
   * can filter by it. Absent/null ⇒ no declared tool usage.
   */
  uses_tools?: string | null;
  /**
   * Event axis, provider half (worker migration 012 / D-003, P-007): JSON-encoded
   * Array<{ family, keyTemplate, describe? }> of the awaitable event-key families
   * the unit registers when installed (kinds plugin|pack only). `resolveEventProvider`
   * parses it to answer "which Cupboard unit provides family X?" — the `installable`
   * rung. Absent/null ⇒ declares no events.
   */
  provides_events?: string | null;
  /**
   * Event axis, consumer half (worker migration 013 / D-003, P-008): JSON-encoded
   * Array<{ family, optional? }> of the event families the unit REQUIRES. A missing
   * `optional` means REQUIRED — and a required family nothing provides is a HARD
   * install failure (P-007's gate), which is exactly why the listing carries this:
   * so the detail page can show the requirement BEFORE the user clicks Install.
   * Absent/null ⇒ declares no event deps.
   */
  requires_events?: string | null;
  /**
   * Rubric axis, consumer half (worker migration 015 / cupboard-plan-rubric-recipe
   * -sharing D-001): JSON-encoded `RubricRequirement[]` naming the rubrics this unit
   * REQUIRES. Primarily carried by `plan` rows (a plan template's acceptance-rubric
   * class plus any rubricRefs it names), but kind-agnostic by design so a future kind
   * can declare rubric deps without another table rebuild. Parse with
   * `parseRequiredRubrics`. Absent/null ⇒ declares no rubric deps.
   *
   * There is deliberately NO `provides_rubrics` counterpart: a `kind='rubric'` row
   * provides exactly the one rubric named by its own `listing_ref`, so the provider
   * half is already keyed and needs no separate column (unlike the event axis, where
   * one plugin can register many families).
   */
  requires_rubrics?: string | null;

  // ── Catalog fields (worker migration 018 / shared-pot-dao-cupboard-v1 P-008,
  // D-024/D-025/D-027..D-029). Six axes over the SAME eleven-kind catalog — who
  // may see a listing, what it costs, what it runs on, what it may do once
  // installed, and which immutable release it points at. Every field is optional
  // because pre-018 servers omit them all; a pre-018 ROW backfills to
  // `visibility: 'public'` with every other field null. ──

  /** public | unlisted | private. Absent ⇒ treat as 'public' (the pre-018 backfill). */
  visibility?: ListingVisibility | null;
  /**
   * Owning shared pot. Null/absent ⇒ the global public catalog. A `private` row
   * is visible only to callers scoped to this tenant; the unauthenticated public
   * route can never widen to one.
   */
  tenant_id?: string | null;

  /**
   * Opaque, provider-neutral SKU identifier (D-028). NOT a Stripe price id, a
   * gateway URL, or any other adapter-specific handle — a settlement adapter
   * resolves it to its own product, so the catalog stays adapter-agnostic.
   * Null ⇒ not for sale through any adapter.
   */
  sku_ref?: string | null;
  /** free | one-time | subscription | per-use. Null ⇒ unpriced. */
  pricing_model?: PricingModel | null;
  /**
   * Price in integer minor units scaled by 1e6, so per-use microcharges and
   * stablecoin amounts are EXACT — float money is never stored or carried.
   * Null ⇒ no price set.
   */
  price_amount_micros?: number | null;
  /** ISO-4217 code or a stablecoin symbol (e.g. 'USD', 'USDC'). */
  price_currency?: string | null;

  /**
   * JSON-encoded `{ runtime?: string, platforms?: string[], architectures?: string[] }`
   * — e.g. `{"runtime":"node>=22","platforms":["darwin-aarch64"]}`. Mirrors the
   * P-006 release manifest's compatibility block so the detail page can show
   * "will this run here?" before install. Null ⇒ compatibility undeclared.
   */
  compatibility_json?: string | null;
  /**
   * JSON-encoded `string[]` of the permissions the unit REQUESTS at install time
   * (e.g. `["fs:read","net:fetch"]`). Carried on the listing so the permission
   * prompt can be shown BEFORE the user clicks Install, not after. Null ⇒
   * requests no permissions.
   */
  required_permissions?: string | null;

  /**
   * Immutable release identity (D-024). A published release is never mutated or
   * deleted: republishing the same `release_version` for one
   * (repo, kind, listing_ref) is a UNIQUE-constraint violation, not an
   * overwrite — and that holds for the canonical `listing_ref: null` row too.
   * Null ⇒ nothing published yet.
   */
  release_version?: string | null;
  /**
   * Content hash of the release payload, `sha256:<64 hex>`. This is content
   * IDENTITY, never a retrieval URL (D-024/D-025) — which is exactly what lets
   * the later P2P storage work swap the ArtifactStore adapter without touching
   * this schema or this type.
   */
  release_content_hash?: string | null;
  /** Digest of the signed release manifest (`listingManifestDigest()`). */
  release_manifest_digest?: string | null;
  /** Detached signature over the manifest digest. */
  release_signature?: string | null;
  /** Epoch ms the release was published. */
  release_published_at?: number | null;
  /**
   * Yank/revoke are ADDITIVE: the row and its version are kept forever so the
   * release stays immutable and already-installed copies remain explainable.
   * A yanked release still occupies its version — it is hidden from new
   * installs, not erased. Null ⇒ not yanked/revoked.
   */
  yanked_at?: number | null;
  yanked_reason?: string | null;
  revoked_at?: number | null;
  revoked_reason?: string | null;

  // ── Pre-publication review (worker migration 008 / knowledge-packs D-007).
  // Policy kinds (knowledge-pack, blueprint) publish 'pending'; the server
  // hides non-approved rows from public reads, so most clients only ever see
  // 'approved' — the pending/rejected values surface on the PUBLISHER's own
  // GET /:id view (with auth) and the operator /admin queue. ──
  review_status?: 'pending' | 'approved' | 'rejected';
  reviewed_at?: number | null;
  review_reason?: string | null;

  // ── Live-worker row fields (the deployed Cupboard returns these; the
  // aspirational fields above predate the worker and may be absent on real
  // data). The per-kind actions read these. ──
  /** `<owner>` of the project remote (worker row). */
  github_owner?: string;
  /** `<repo>` of the project remote (worker row). */
  github_name?: string;
  /** Full `https://github.com/<owner>/<repo>` (worker row). */
  github_url?: string;
  /** Hypercore join topic (worker row); present only for kind='harness'. */
  topic_hex?: string | null;
  /** Contributor count (worker row; the aspirational field is `contributor_count_estimate`). */
  contributor_count?: number;
  /** Star count (worker row). */
  stars?: number;
  /** Language byte-counts as JSON `{lang: bytes}` (worker row; the aspirational field is `language`). */
  languages?: string | null;
  /** Stable numeric GitHub repository id. The canonical-uniqueness
   * key for `harnesses_active_repo_unique`. */
  github_repository_id: number;
  /** `<owner>/<repo>` display string, refreshed from GitHub. */
  github_repo: string;
  /** Whether the repo must be public for the listing to remain
   * visible. v5 default: TRUE. */
  github_repo_must_be_public: boolean;
  published_by_github_user_id: number;
  /** Publisher's GitHub permission on the bound repo at publish time —
   *  'admin'|'maintain'|'write'|'triage'|'read'|'none'. Optional: Cupboard
   *  servers predating migration 002 omit it (rendered as unknown). */
  publisher_permission?: string | null;
  /** Channel-2 (item 1): publisher's device Ed25519 pubkey (base64) +
   *  the gist binding it to their GitHub login. Optional — present only
   *  for attested publishes; cleared by the indexer on revocation. */
  publisher_device_pubkey?: string | null;
  publisher_attestation_gist_id?: string | null;
  provisional_owner_github_user_id: number;
  claim_status: CupboardClaimStatus;
  claimed_at: number | null;
  /** Claimant identity (worker rows; set while claim_status='claimed') —
   *  the "who/when" the claim badge surfaces (comb-hive-native-sharing P-003). */
  claimant_github_user_id?: number | null;
  claimant_github_login?: string | null;
  last_permission_verified_at: number | null;
  superseded_by_harness_id: number | null;
  /** Self-reported contributor count, recomputed weekly. */
  contributor_count_estimate: number;
  /** Epoch ms of most-recent activity for the bound repo. */
  last_activity_at: number | null;
  language: string | null;
  tags: string[];
  created_at: number;
  updated_at: number;
  /** Canonical immutable release manifest when the server exposes it. */
  release_manifest?: import('./listing-manifest').CupboardReleaseManifest | null;
}

/**
 * The §10.2 `harness_claims` row shape. One per (harness, claimant).
 */
export interface HarnessClaim {
  id: number;
  harness_id: number;
  claimant_github_user_id: number;
  /** GitHub permission level at verification time. */
  github_permission: CupboardGithubPermission;
  verified_at: number;
  revoked_at: number | null;
}

/**
 * The §10.2 `reports` row shape. One per abuse report.
 */
export interface CupboardReport {
  id: number;
  harness_id: number;
  reporter_github_user_id: number;
  reason: string;
  details: string | null;
  created_at: number;
  resolved_at: number | null;
  resolution: string | null;
}

/**
 * The CupboardClient interface — 8-op surface per v5 §10.3. Every
 * method returns a `CupboardResult<T>` so error handling is
 * uniform.
 *
 * `lookupRepoBinding` is the most-used method — every desktop
 * "create shared harness" flow calls it BEFORE creating the
 * local Hyperbee to enforce per-repo uniqueness.
 */
export interface CupboardClient {
  /** GET /repo-bindings/github/:repository_id */
  lookupRepoBinding(github_repository_id: number): Promise<CupboardResult<HarnessListing | null>>;

  /** POST /repo-bindings/github */
  createRepoBinding(input: CreateRepoBindingInput): Promise<CupboardResult<HarnessListing>>;

  /** POST /harnesses/:id/claim */
  claim(input: ClaimInput): Promise<CupboardResult<HarnessClaim>>;

  /** POST /harnesses/:id/supersede */
  supersede(input: SupersedeInput): Promise<CupboardResult<HarnessListing>>;

  /** POST /harnesses */
  publish(input: PublishListingInput): Promise<CupboardResult<HarnessListing>>;

  /** GET /harnesses?... */
  listListings(filters?: ListListingsFilter): Promise<CupboardResult<HarnessListing[]>>;

  /** POST /reports */
  report(input: ReportInput): Promise<CupboardResult<CupboardReport>>;

  /** DELETE /harnesses/:id */
  unlist(input: UnlistInput): Promise<CupboardResult<void>>;
}

// ---------- input/output types ----------

export interface CreateRepoBindingInput {
  github_repository_id: number;
  github_repo: string;
  slug: string;
  title: string;
  description: string;
  harness_link: string;
  /**
   * Owning Hive's identity for a repo→Hive binding row (worker migration 007 /
   * hive-from-github-url D-004 HYBRID): raw 32-byte Ed25519 pubkey, base64 —
   * same encoding as the hive directory. One binding row per member repo of a
   * public hive, all carrying the same `hive_pubkey`. Omit for a plain
   * shared-harness binding.
   */
  hive_pubkey?: string;
  /** Denormalized Hive display title (directory announce stays authoritative). */
  hive_title?: string;
  /** OAuth token from `gh auth token` — server re-verifies repo
   * access before accepting the binding. */
  oauth_token: string;
}

export interface ClaimInput {
  harness_id: number;
  oauth_token: string;
}

export interface SupersedeInput {
  /** The harness id being superseded. */
  harness_id: number;
  /** The new harness's id (already created via createRepoBinding). */
  replacement_harness_id: number;
  oauth_token: string;
}

export interface PublishListingInput {
  harness_id: number;
  /** Tags for discovery. */
  tags?: string[];
  oauth_token: string;
}

export interface ListListingsFilter {
  /** Substring match against title + description. */
  q?: string;
  /** Filter to a language (e.g. `'TypeScript'`). */
  language?: string;
  /** Filter to a tag. */
  tag?: string;
  /** Pagination cursor returned from a prior call. */
  cursor?: string;
  /** Max results. Server caps at 100. */
  limit?: number;
}

export interface ReportInput {
  harness_id: number;
  reason: string;
  details?: string;
  oauth_token: string;
}

export interface UnlistInput {
  harness_id: number;
  oauth_token: string;
}

// ---------- result + error envelopes ----------

export type CupboardResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: CupboardError };

export interface CupboardError {
  kind: CupboardErrorKind;
  /** Human-readable message — surfaces in UI toasts + audit logs. */
  message: string;
  /** HTTP status when available. */
  status?: number;
  /** Per-field validation issues when `kind: 'validation'`. */
  field_errors?: Array<{ field: string; message: string }>;
  /** Rate-limit retry-after window, populated for
   * `kind: 'rate_limited'`. */
  retry_after_ms?: number;
}

export const CUPBOARD_ERROR_KINDS = [
  'not_found',
  'unauthorized',
  'forbidden_insufficient_permission',
  'rate_limited',
  'conflict_repo_already_bound',
  'conflict_already_claimed',
  'validation',
  'private_repo_not_publishable',
  'server_error',
  'network_error',
  'unsupported_version',
] as const;
export type CupboardErrorKind = (typeof CUPBOARD_ERROR_KINDS)[number];

// ---------- convenience constructors ----------

export function ok<T>(data: T): CupboardResult<T> {
  return { ok: true, data };
}

export function err(error: CupboardError): CupboardResult<never> {
  return { ok: false, error };
}

// ---------- rate-limit constants (§10.3) ----------

/**
 * Per-user publish rate-limit per v5 §10.3 — "5 publishes per
 * github_user_id per hour."
 */
export const PUBLISH_RATE_LIMIT_PER_HOUR = 5;
export const PUBLISH_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

/**
 * Server-side list-endpoint default + cap. The server caps at this
 * value regardless of what the client requests.
 */
export const LIST_DEFAULT_LIMIT = 25;
export const LIST_MAX_LIMIT = 100;

// ---------- predicates ----------

/**
 * Is the listing currently visible to public-facing browsers?
 * Superseded + stale listings are hidden by default.
 */
export function isPubliclyVisible(listing: HarnessListing): boolean {
  return listing.claim_status !== 'superseded' && listing.claim_status !== 'stale';
}

/**
 * Predicate: does the caller's GitHub permission allow claiming
 * this listing?
 */
export function canClaim(permission: CupboardGithubPermission): boolean {
  return CLAIM_REQUIRED_PERMISSIONS.has(permission);
}

/**
 * Predicate: does the caller's GitHub permission allow superseding
 * this listing?
 */
export function canSupersede(permission: CupboardGithubPermission): boolean {
  return SUPERSEDE_REQUIRED_PERMISSIONS.has(permission);
}

/**
 * Predicate: is the listing eligible to be republished (Cupboard
 * UI shows the "Re-publish" CTA only if true)? Currently: true
 * iff `unclaimed` or `claimed` — superseded/stale require admin
 * action via `supersede` before re-publishing.
 */
export function canRepublish(listing: HarnessListing): boolean {
  return listing.claim_status === 'unclaimed' || listing.claim_status === 'claimed';
}

/**
 * Structural predicate. Verifies that a JSON-parsed response from
 * the Cupboard server is shaped like a `HarnessListing`. Used by
 * the client's response-parsing path defensively against
 * server-side schema drift.
 */
export function isHarnessListing(input: unknown): input is HarnessListing {
  if (input === null || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  if (typeof r.id !== 'number' || !Number.isInteger(r.id)) return false;
  if (typeof r.slug !== 'string' || r.slug.length === 0) return false;
  if (typeof r.title !== 'string') return false;
  if (typeof r.description !== 'string') return false;
  if (typeof r.harness_link !== 'string' || r.harness_link.length === 0) return false;
  if (
    typeof r.github_repository_id !== 'number' ||
    !Number.isInteger(r.github_repository_id) ||
    r.github_repository_id <= 0
  ) {
    return false;
  }
  if (typeof r.github_repo !== 'string' || r.github_repo.length === 0) return false;
  if (typeof r.github_repo_must_be_public !== 'boolean') return false;
  if (
    typeof r.published_by_github_user_id !== 'number' ||
    typeof r.provisional_owner_github_user_id !== 'number'
  ) {
    return false;
  }
  // publisher_permission is optional (servers predating migration 002 omit
  // it). Accept missing/null/string; reject other types.
  if (r.publisher_permission != null && typeof r.publisher_permission !== 'string') {
    return false;
  }
  // Channel-2 attestation fields (migration 003) — also optional.
  if (r.publisher_device_pubkey != null && typeof r.publisher_device_pubkey !== 'string') {
    return false;
  }
  if (r.publisher_attestation_gist_id != null && typeof r.publisher_attestation_gist_id !== 'string') {
    return false;
  }
  // Repo→Hive binding fields (migration 007 / D-004 HYBRID) — also optional.
  if (r.hive_pubkey != null && typeof r.hive_pubkey !== 'string') return false;
  if (r.hive_title != null && typeof r.hive_title !== 'string') return false;
  if (
    typeof r.claim_status !== 'string' ||
    !(CUPBOARD_CLAIM_STATUSES as readonly string[]).includes(r.claim_status)
  ) {
    return false;
  }
  if (r.claimed_at !== null && typeof r.claimed_at !== 'number') return false;
  if (r.last_permission_verified_at !== null && typeof r.last_permission_verified_at !== 'number') {
    return false;
  }
  if (
    r.superseded_by_harness_id !== null &&
    typeof r.superseded_by_harness_id !== 'number'
  ) {
    return false;
  }
  if (typeof r.contributor_count_estimate !== 'number' || r.contributor_count_estimate < 0) {
    return false;
  }
  if (r.last_activity_at !== null && typeof r.last_activity_at !== 'number') return false;
  if (r.language !== null && typeof r.language !== 'string') return false;
  if (!Array.isArray(r.tags)) return false;
  if (typeof r.created_at !== 'number' || typeof r.updated_at !== 'number') return false;
  return true;
}
