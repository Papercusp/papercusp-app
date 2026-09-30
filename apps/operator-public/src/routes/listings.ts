/**
 * /listings — the generalized storefront surface (migration 004 / D-005).
 *
 * ONE storefront, five listing kinds:
 *   harness   → join     (shared-harness via the Hypercore topic_hex)
 *   blueprint → fork     (a blueprint stream within a project)
 *   snapshot  → fork     (a captured snapshot)
 *   plugin    → install  (a distributable plugin — a pack WITH a runtime)
 *   pack      → install  (a runtime-less code-tool pack; migration 006,
 *                         tool-distribution-granularity D-001/D-004)
 *
 * Project-centric 1:N (D-008): listings key on the papercupai project remote
 * (`project_ref`) and a project hosts N non-harness listings, discriminated by
 * `listing_ref`. GitHub-repo-backed identity stays for v1, so every kind still
 * carries the project remote's github repo fields + the publisher-collaborator
 * trust signal.
 *
 * Endpoints (registered under BOTH /listings and /harnesses):
 *   GET    /listings            — list (public, paginated, ?kind= / ?project= filters)
 *   GET    /listings/:id        — single listing detail
 *   POST   /listings            — publish (GitHub auth + 5/hr cap; body.listing_kind)
 *   DELETE /listings/:id        — unlist (publisher or claimant)
 *   POST   /listings/:id/claim  — claim by maintain/admin perm
 *
 * /harnesses* is the same surface pinned to kind='harness' — the back-compat
 * view the deployed desktop client + operator proxy use today. Once the
 * operator proxy is cut over to /listings?kind=harness, /harnesses can be
 * dropped (it carries no behavior the generalized surface doesn't).
 */

import { Hono } from 'hono';
import type { Env } from '../env.ts';
import {
  audit,
  clientIp,
  getActiveListingByRefs,
  getHarnessById,
  getHarnessByGithubRepoId,
  insertHarness,
  isListingKind,
  isListingVisibility,
  isPricingModel,
  listBannedPubkeySet,
  listPublicHarnessesPage,
  markHarnessUnlisted,
  normalizeListingKind,
  parseListingCursor,
  REVIEW_POLICY_KINDS,
  setHarnessClaim,
  supersedeHarnessListing,
  summarizePublicHarnesses,
  type ListingKind,
  type ListingVisibility,
  type PricingModel,
  type PublicListOpts,
} from '../db.ts';
import {
  AuthError,
  extractBearer,
  resolveGithubBearer,
  checkRepoPermission,
} from '../auth.ts';
import { checkAndRecordUserPublishHourly, checkIpListPerMinute, RateLimitError } from '../ratelimit.ts';
import { isSelfDescribingKind, pinListingContent, type ContentPin } from '../content-pin.ts';

interface PublishBody {
  listing_kind?: string;             // migration 004; defaults to 'harness'
  blueprint_kind?: string;           // migration 009 / P-018: blueprint.yaml kind ('hive'|'harness'), blueprint listings only
  project_ref?: string;              // papercupai project remote (D-008)
  listing_ref?: string;              // within-project discriminator; REQUIRED for non-harness kinds
  github_repository_id: number;
  github_owner: string;
  github_name: string;
  github_url: string;
  title?: string;
  description?: string;
  topic_hex?: string;                // 32-byte hex Hypercore topic; REQUIRED for kind='harness'
  attestation_gist_id?: string;      // channel-2 (item 1): gist binding device pubkey ↔ login
  publisher_device_pubkey?: string;  // channel-2 (item 1): device Ed25519 pubkey (base64)
  // Pack model (migration 006). MCP tool names the unit registers when
  // installed; kinds plugin|pack only. Stored as a JSON TEXT column and
  // returned verbatim on GET (the operator's resolver parses it).
  provides_tools?: unknown;          // expected: string[]
  // Tool axis, consumer half (migration 033 / WI-10001747). MCP tool names the
  // unit ORCHESTRATES but does not provide; orchestrating kinds (recipe|plan|goal)
  // only. Same bounded shape and storage posture as provides_tools — but nothing
  // resolves a provider from it, because the unit registers none of these.
  uses_tools?: unknown;              // expected: string[]
  // Event axis (migration 012 / D-003 / P-007). The awaitable event-key FAMILIES
  // the unit registers when installed; kinds plugin|pack only. Stored as a JSON
  // TEXT column and returned verbatim on GET (the operator's resolver parses it).
  provides_events?: unknown;         // expected: Array<{ family, keyTemplate, describe? }>
  // Event axis, consumer half (migration 013 / D-003 / P-008). The event-key
  // FAMILIES the unit REQUIRES; kinds plugin|pack only. Same storage posture.
  requires_events?: unknown;         // expected: Array<{ family, optional? }>
  requires_rubrics?: unknown;        // expected: Array<{ rubricRef, optional? }> (migration 015)
  // Repo→Hive binding (migration 007 / hive-from-github-url D-004 HYBRID):
  // owning Hive's raw-32-byte-base64 Ed25519 pubkey + denormalized title.
  hive_pubkey?: unknown;             // expected: 44-char base64 (32 bytes)
  hive_title?: unknown;              // expected: string ≤200; requires hive_pubkey
  // App distribution (migration 014 / cupboard-app-distribution-2026-07-14 P-003).
  // ALL app-only — the worker 400s them on any non-app kind. A STANDALONE app's
  // "install" is a download-link handoff: the Cupboard stores latest_json_url and
  // never re-hosts the binary. delivery_type discriminates standalone|bundle.
  delivery_type?: unknown;           // expected: 'standalone' | 'bundle'
  latest_json_url?: unknown;         // expected: https URL; REQUIRED for a standalone app
  release_repo?: unknown;            // expected: '<owner>/<repo>'
  icon_url?: unknown;                // expected: https URL
  platforms?: unknown;               // expected: string[] of OS keys present in latest.json
  // ── Catalog axes (migration 018 / shared-pot-dao-cupboard-v1 P-008) ────────
  // Kind-agnostic, unlike the app_fields block above: any kind can be private,
  // priced, compatibility-scoped, permission-declaring, or release-pinned.
  visibility?: unknown;              // expected: 'public' | 'unlisted' | 'private'
  tenant_id?: unknown;               // expected: string — owning shared pot
  sku_ref?: unknown;                 // expected: string — provider-neutral SKU id
  pricing_model?: unknown;           // expected: 'free'|'one-time'|'subscription'|'per-use'
  price_amount_micros?: unknown;     // expected: non-negative integer, minor units × 1e6
  price_currency?: unknown;          // expected: string — ISO-4217 or stablecoin symbol
  compatibility?: unknown;           // expected: { runtime?, platforms?: string[], architectures?: string[] }
  required_permissions?: unknown;    // expected: string[]
  release_version?: unknown;         // expected: string
  release_content_hash?: unknown;    // expected: 'sha256:<64 hex>'
  release_manifest_digest?: unknown; // expected: string — listingManifestDigest()
  release_signature?: unknown;       // expected: string
  release_manifest?: unknown;        // expected: string — canonical JSON of the signed CupboardReleaseManifest
  identity_surface?: unknown;        // expected: string — canonical JSON IdentityListingSurface; blueprint_kind 'identity' only
}

/** provides_tools caps (migration 006): bounded so a listing can't smuggle a payload. */
const PROVIDES_TOOLS_MAX_ENTRIES = 200;
const PROVIDES_TOOLS_MAX_NAME_LEN = 128;

/**
 * Kinds that may declare `uses_tools` (migration 033 / WI-10001747): the units
 * that ORCHESTRATE tools rather than register them. Deliberately disjoint from
 * the plugin|pack gate on `provides_tools` — a unit that provides tools is
 * resolved as their provider at install; a unit that merely uses them is not.
 */
const USES_TOOLS_KINDS = ['recipe', 'plan', 'goal'] as const;

/** provides_events caps (migration 012): same posture — a declaration, not a payload. */
const PROVIDES_EVENTS_MAX_ENTRIES = 200;
const PROVIDES_EVENTS_MAX_FAMILY_LEN = 128;
const PROVIDES_EVENTS_MAX_TEMPLATE_LEN = 256;
const PROVIDES_EVENTS_MAX_DESCRIBE_LEN = 300;

/** requires_events caps (migration 013): a declaration, not a payload. */
const REQUIRES_EVENTS_MAX_ENTRIES = 200;
const REQUIRES_EVENTS_MAX_FAMILY_LEN = 128;

/** requires_rubrics caps (migration 015): same posture. The ref cap matches
 *  LISTING_REF_RE's 200, since a rubricRef is matched against a rubric listing's
 *  listing_ref — a longer one could never resolve. */
const REQUIRES_RUBRICS_MAX_ENTRIES = 200;
const REQUIRES_RUBRICS_MAX_REF_LEN = 200;

const TOPIC_HEX_RE = /^[0-9a-f]{64}$/;
// Standard base64 of exactly 32 raw bytes (an Ed25519 pubkey): 43 chars + '='.
// Same encoding as the hive directory announce's hive_pubkey (migration 007).
const HIVE_PUBKEY_RE = /^[A-Za-z0-9+/]{43}=$/;
const HIVE_TITLE_MAX = 200;
// Slug-ish: blueprint stream name / snapshot id / plugin slug. Permits path-y
// refs (a/b) and dotted versions; bounded length.
const LISTING_REF_RE = /^[A-Za-z0-9._/-]{1,200}$/;
const PROJECT_REF_MAX = 300;

// App distribution (migration 014). An https installer-handoff url must not be
// downgradeable; a release_repo is a bare `<owner>/<repo>`; platforms is a small
// denormalized set of OS keys (a hint, not a payload).
const APP_URL_MAX = 500;
const HTTPS_URL_RE = /^https:\/\/[^\s]{1,494}$/;
const RELEASE_REPO_RE = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
/** Immutable-release content identity (migration 018 / P-008) — the SAME shape
 *  `validateListingManifest` enforces on `contentHash`, so a listing row and the
 *  signed manifest it points at cannot disagree about what a content hash is. */
const CONTENT_HASH_RE = /^sha256:[0-9a-f]{64}$/i;
const APP_PLATFORMS_MAX_ENTRIES = 20;
const APP_PLATFORM_KEY_MAX_LEN = 64;

function uuidv4(): string {
  // crypto.randomUUID is available in Workers + Node 19+ + browser
  return (crypto as { randomUUID: () => string }).randomUUID();
}

/**
 * Derive a single permission level from GitHub's repo `permissions`
 * object (booleans), returned by GET /repos/:owner/:repo when fetched
 * with a user token. Highest applicable wins. For a PUBLIC repo a
 * non-collaborator still gets `pull: true` ⇒ 'read'; an actual
 * collaborator gets push/maintain/admin. So 'read'/'none' ⇒ not a
 * collaborator. Item 2 of the cupboard-provisional-listing-trust memo.
 */
export function derivePublisherPermission(
  perms: Record<string, boolean> | undefined | null,
): 'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none' {
  if (!perms) return 'none';
  if (perms.admin) return 'admin';
  if (perms.maintain) return 'maintain';
  if (perms.push) return 'write';
  if (perms.triage) return 'triage';
  if (perms.pull) return 'read';
  return 'none';
}

interface MountOpts {
  /** When set, the mount serves exactly this kind (the /harnesses back-compat view). */
  fixedKind?: ListingKind;
}

/** Register the five listing endpoints under `base`, kind-pinned or kind-aware. */
function registerListingEndpoints(
  app: Hono<{ Bindings: Env }>,
  base: string,
  opts: MountOpts = {},
): void {
  const { fixedKind } = opts;

  // GET base — public listing.
  app.get(base, async (c) => {
    const ip = clientIp(c.req.raw);
    try {
      await checkIpListPerMinute(c.env, ip);
    } catch (e) {
      if (e instanceof RateLimitError) return c.json({ error: 'rate_limited' }, 429);
      throw e;
    }
    const url = new URL(c.req.url);
    const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? '30', 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 30;
    const cursorRaw = url.searchParams.get('cursor');
    const cursor = cursorRaw == null ? null : parseListingCursor(cursorRaw);
    if (cursorRaw != null && cursor == null) {
      return c.json({ error: 'invalid_field', field: 'cursor' }, 400);
    }
    const search = url.searchParams.get('q') ?? undefined;
    const claim_status_raw = url.searchParams.get('claim');
    const claim_status: PublicListOpts['claim_status'] =
      claim_status_raw === 'claimed'
        ? 'claimed'
        : claim_status_raw === 'unclaimed'
          ? 'unclaimed'
          : undefined;
    // Kind: pinned on /harnesses; from ?kind= on /listings (omit ⇒ all kinds).
    let kind: ListingKind | undefined = fixedKind;
    if (!kind) {
      const kindRaw = url.searchParams.get('kind');
      if (kindRaw != null && kindRaw !== '' && kindRaw !== 'all') {
        // normalizeListingKind maps the interim 'tool-pack' + pre-008 'pack'
        // wire aliases to the canonical 'pack' (migration 010 / P-003).
        const normalized = normalizeListingKind(kindRaw);
        if (!normalized) return c.json({ error: 'invalid_field', field: 'kind' }, 400);
        kind = normalized;
      }
    }
    const project_ref = url.searchParams.get('project') ?? undefined;

    // ── Catalog filters (migration 018 / shared-pot-dao-cupboard-v1 P-008) ───
    // Every one of these NARROWS. `tenant_scope` — the only widening option, the
    // one that can surface an unlisted/private row — is deliberately NOT
    // reachable from a query param: this endpoint is unauthenticated, so a
    // `?tenant=` that widened would hand any caller another pot's private
    // catalog. `?tenant=` maps to the narrowing `tenant_ref` instead.
    const visibilityRaw = url.searchParams.get('visibility');
    let visibility: ListingVisibility | undefined;
    if (visibilityRaw != null && visibilityRaw !== '' && visibilityRaw !== 'all') {
      if (!isListingVisibility(visibilityRaw)) {
        return c.json({ error: 'invalid_field', field: 'visibility' }, 400);
      }
      visibility = visibilityRaw;
    }
    const pricingRaw = url.searchParams.get('pricing');
    let pricing_model: PricingModel | undefined;
    if (pricingRaw != null && pricingRaw !== '' && pricingRaw !== 'all') {
      if (!isPricingModel(pricingRaw)) {
        return c.json({ error: 'invalid_field', field: 'pricing' }, 400);
      }
      pricing_model = pricingRaw;
    }
    const paidRaw = url.searchParams.get('paid');
    let paid: boolean | undefined;
    if (paidRaw != null && paidRaw !== '') {
      if (paidRaw !== '1' && paidRaw !== '0' && paidRaw !== 'true' && paidRaw !== 'false') {
        return c.json({ error: 'invalid_field', field: 'paid' }, 400);
      }
      paid = paidRaw === '1' || paidRaw === 'true';
    }
    // Blueprint facet (migrations 009/035): ?blueprint_kind=identity lists identities.
    const blueprintKindRaw = url.searchParams.get('blueprint_kind');
    let blueprint_kind: string | undefined;
    if (blueprintKindRaw != null && blueprintKindRaw !== '' && blueprintKindRaw !== 'all') {
      if (blueprintKindRaw !== 'hive' && blueprintKindRaw !== 'harness' && blueprintKindRaw !== 'identity') {
        return c.json({ error: 'invalid_field', field: 'blueprint_kind' }, 400);
      }
      blueprint_kind = blueprintKindRaw;
    }
    const filters = {
      limit,
      cursor,
      search,
      claim_status,
      kind,
      blueprint_kind,
      project_ref,
      visibility,
      tenant_ref: url.searchParams.get('tenant') ?? undefined,
      pricing_model,
      paid,
      platform: url.searchParams.get('platform') ?? undefined,
      runtime: url.searchParams.get('runtime') ?? undefined,
      permission: url.searchParams.get('permission') ?? undefined,
    };
    const [{ results, next_cursor }, { total, kind_facets }] = await Promise.all([
      listPublicHarnessesPage(c.env.DB, filters),
      summarizePublicHarnesses(c.env.DB, filters),
    ]);
    return c.json({ results, next_cursor, total, kind_facets });
  });

  // GET base/:id — single listing.
  app.get(`${base}/:id`, async (c) => {
    const id = c.req.param('id');
    const row = await getHarnessById(c.env.DB, id);
    if (!row || row.unlisted_at) return c.json({ error: 'not_found' }, 404);
    // On the kind-pinned mount, a row of another kind is not found here.
    if (fixedKind && row.listing_kind !== fixedKind) return c.json({ error: 'not_found' }, 404);
    if (row.publisher_device_pubkey) {
      const banned = await listBannedPubkeySet(c.env.DB);
      if (banned.has(row.publisher_device_pubkey)) return c.json({ error: 'not_found' }, 404);
    }
    // Pre-publication review (knowledge-packs D-007): a pending/rejected
    // listing is publicly invisible — only its PUBLISHER reads it (the
    // "pending approval" state + a rejection's reason); operators use /admin.
    if (row.review_status !== 'approved') {
      let viewerId: number | null = null;
      try {
        viewerId = (await resolveGithubBearer(c.req.raw)).id;
      } catch {
        /* unauthenticated viewer */
      }
      if (viewerId !== row.publisher_github_user_id) return c.json({ error: 'not_found' }, 404);
    }
    return c.json(row);
  });

  // POST base — publish.
  app.post(base, async (c) => {
    let user;
    try {
      user = await resolveGithubBearer(c.req.raw);
    } catch (e) {
      if (e instanceof AuthError) return c.json({ error: 'auth', reason: e.reason }, 401);
      throw e;
    }
    const now = Date.now();

    try {
      await checkAndRecordUserPublishHourly(c.env, user.id, now);
    } catch (e) {
      if (e instanceof RateLimitError) {
        await audit(c.env.DB, now, 'publish_rate_limited', { user_id: user.id });
        return c.json({ error: 'rate_limited', bucket: e.bucket }, 429);
      }
      throw e;
    }

    let body: PublishBody;
    try {
      body = (await c.req.json()) as PublishBody;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    // Resolve the kind: pinned on /harnesses; from body on /listings (default
    // harness). normalizeListingKind maps the interim 'tool-pack' + pre-008
    // 'pack' wire aliases to the canonical 'pack' (migration 010 / P-003).
    let kind: ListingKind;
    if (fixedKind) {
      kind = fixedKind;
    } else if (body.listing_kind == null) {
      kind = 'harness';
    } else {
      const normalized = normalizeListingKind(body.listing_kind);
      if (!normalized) return c.json({ error: 'invalid_field', field: 'listing_kind' }, 400);
      kind = normalized;
    }

    // Common field validation (every kind is project-remote-backed in v1).
    if (typeof body.github_repository_id !== 'number' || body.github_repository_id <= 0) {
      return c.json({ error: 'invalid_field', field: 'github_repository_id' }, 400);
    }
    if (typeof body.github_owner !== 'string' || !body.github_owner) {
      return c.json({ error: 'invalid_field', field: 'github_owner' }, 400);
    }
    if (typeof body.github_name !== 'string' || !body.github_name) {
      return c.json({ error: 'invalid_field', field: 'github_name' }, 400);
    }
    if (typeof body.github_url !== 'string' || !/^https:\/\/github\.com\//.test(body.github_url)) {
      return c.json({ error: 'invalid_field', field: 'github_url' }, 400);
    }
    if (body.description != null && (typeof body.description !== 'string' || body.description.length > 280)) {
      return c.json({ error: 'invalid_field', field: 'description' }, 400);
    }
    if (body.title != null && (typeof body.title !== 'string' || body.title.length > 200)) {
      return c.json({ error: 'invalid_field', field: 'title' }, 400);
    }

    // Kind-specific shape.
    //  harness   → topic_hex REQUIRED (the Hypercore join topic).
    //  non-harness → topic_hex optional; listing_ref REQUIRED (the within-project
    //               discriminator); project_ref optional.
    if (kind === 'harness') {
      if (typeof body.topic_hex !== 'string' || !TOPIC_HEX_RE.test(body.topic_hex)) {
        return c.json({ error: 'invalid_field', field: 'topic_hex' }, 400);
      }
    } else {
      if (body.topic_hex != null && (typeof body.topic_hex !== 'string' || !TOPIC_HEX_RE.test(body.topic_hex))) {
        return c.json({ error: 'invalid_field', field: 'topic_hex' }, 400);
      }
      if (typeof body.listing_ref !== 'string' || !LISTING_REF_RE.test(body.listing_ref)) {
        return c.json({ error: 'invalid_field', field: 'listing_ref' }, 400);
      }
    }
    if (
      body.project_ref != null &&
      (typeof body.project_ref !== 'string' || body.project_ref.length < 1 || body.project_ref.length > PROJECT_REF_MAX)
    ) {
      return c.json({ error: 'invalid_field', field: 'project_ref' }, 400);
    }

    // provides_tools (migration 006) — pack-model tool metadata. Only the
    // installable kinds (plugin|pack) register tools; a bounded array of
    // non-empty tool-name strings, stored as JSON TEXT.
    let providesToolsJson: string | null = null;
    if (body.provides_tools != null) {
      if (kind !== 'plugin' && kind !== 'pack') {
        return c.json({ error: 'invalid_field', field: 'provides_tools', reason: 'plugin_or_pack_kind_only' }, 400);
      }
      const pt = body.provides_tools;
      if (!Array.isArray(pt) || pt.length === 0 || pt.length > PROVIDES_TOOLS_MAX_ENTRIES) {
        return c.json({ error: 'invalid_field', field: 'provides_tools', reason: 'array_1_to_200' }, 400);
      }
      if (!pt.every((t) => typeof t === 'string' && t.trim().length > 0 && t.length <= PROVIDES_TOOLS_MAX_NAME_LEN)) {
        return c.json({ error: 'invalid_field', field: 'provides_tools', reason: 'non_empty_strings_max_128' }, 400);
      }
      providesToolsJson = JSON.stringify(pt);
    }

    // uses_tools (migration 033 / WI-10001747) — the CONSUMER half of the tool
    // axis. A recipe/plan/goal ORCHESTRATES tools it does not provide, so it
    // declares them here rather than in provides_tools, whose plugin|pack gate
    // above is deliberately left alone: overloading one column by kind would
    // let a future installer try to RESOLVE tools the unit never provided.
    // Same bounded shape (JSON TEXT, 1..200 non-empty names, each ≤128 chars).
    let usesToolsJson: string | null = null;
    if (body.uses_tools != null) {
      if (!USES_TOOLS_KINDS.includes(kind as (typeof USES_TOOLS_KINDS)[number])) {
        return c.json({ error: 'invalid_field', field: 'uses_tools', reason: 'orchestrating_kind_only' }, 400);
      }
      const ut = body.uses_tools;
      if (!Array.isArray(ut) || ut.length === 0 || ut.length > PROVIDES_TOOLS_MAX_ENTRIES) {
        return c.json({ error: 'invalid_field', field: 'uses_tools', reason: 'array_1_to_200' }, 400);
      }
      if (!ut.every((t) => typeof t === 'string' && t.trim().length > 0 && t.length <= PROVIDES_TOOLS_MAX_NAME_LEN)) {
        return c.json({ error: 'invalid_field', field: 'uses_tools', reason: 'non_empty_strings_max_128' }, 400);
      }
      usesToolsJson = JSON.stringify(ut);
    }

    // provides_events (migration 012 / D-003) — the event half of the pack
    // model's dependency axis. Same posture as provides_tools: installable
    // kinds only, bounded, stored as JSON TEXT.
    //
    // Validated STRUCTURALLY, not just as strings, because a malformed family
    // here is not inert: the operator resolves an awaiter's key template BY
    // FAMILY ID, so a declaration missing its keyTemplate (or carrying a
    // duplicate family) would resolve to a key nothing emits and park the
    // awaiting agent forever. Rejecting it at publish is the cheap place to
    // catch that — the alternative is an agent hanging in silence, days later,
    // on someone else's host.
    let providesEventsJson: string | null = null;
    if (body.provides_events != null) {
      const bad = (reason: string) =>
        c.json({ error: 'invalid_field', field: 'provides_events', reason }, 400);
      if (kind !== 'plugin' && kind !== 'pack') return bad('plugin_or_pack_kind_only');
      const pe = body.provides_events;
      if (!Array.isArray(pe) || pe.length === 0 || pe.length > PROVIDES_EVENTS_MAX_ENTRIES) {
        return bad('array_1_to_200');
      }
      const families = new Set<string>();
      const clean: Array<{ family: string; keyTemplate: string; describe?: string }> = [];
      for (const raw of pe) {
        if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return bad('entries_must_be_objects');
        const { family, keyTemplate, describe } = raw as Record<string, unknown>;
        if (typeof family !== 'string' || family.trim().length === 0 || family.length > PROVIDES_EVENTS_MAX_FAMILY_LEN) {
          return bad('family_non_empty_string_max_128');
        }
        if (
          typeof keyTemplate !== 'string' ||
          keyTemplate.trim().length === 0 ||
          keyTemplate.length > PROVIDES_EVENTS_MAX_TEMPLATE_LEN
        ) {
          return bad('key_template_non_empty_string_max_256');
        }
        // A duplicate family id makes "who provides X?" ambiguous within a single
        // unit — reject rather than silently picking one.
        if (families.has(family)) return bad('duplicate_family');
        families.add(family);
        if (describe != null && (typeof describe !== 'string' || describe.length > PROVIDES_EVENTS_MAX_DESCRIBE_LEN)) {
          return bad('describe_string_max_300');
        }
        clean.push({ family, keyTemplate, ...(typeof describe === 'string' ? { describe } : {}) });
      }
      providesEventsJson = JSON.stringify(clean);
    }

    // requires_events (migration 013 / D-003 / P-008) — the CONSUMER half. Same
    // posture again: installable kinds only, bounded, JSON TEXT, structural.
    //
    // Note what is NOT validated here: whether anything actually PROVIDES the
    // required family. That is deliberately not the Cupboard's question — it has
    // no host catalog and no idea what the installing box already has. The
    // storefront stores the DECLARATION; the operator's resolver answers
    // availability against the local catalog at install time. Trying to enforce
    // resolvability at publish would reject a perfectly good unit whose provider
    // simply hasn't been published yet, and would still be wrong by the time
    // anyone installed it.
    let requiresEventsJson: string | null = null;
    if (body.requires_events != null) {
      const bad = (reason: string) =>
        c.json({ error: 'invalid_field', field: 'requires_events', reason }, 400);
      if (kind !== 'plugin' && kind !== 'pack') return bad('plugin_or_pack_kind_only');
      const re = body.requires_events;
      if (!Array.isArray(re) || re.length === 0 || re.length > REQUIRES_EVENTS_MAX_ENTRIES) {
        return bad('array_1_to_200');
      }
      const families = new Set<string>();
      const clean: Array<{ family: string; optional?: boolean }> = [];
      for (const raw of re) {
        if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return bad('entries_must_be_objects');
        const { family, optional } = raw as Record<string, unknown>;
        if (
          typeof family !== 'string' ||
          family.trim().length === 0 ||
          family.length > REQUIRES_EVENTS_MAX_FAMILY_LEN
        ) {
          return bad('family_non_empty_string_max_128');
        }
        if (optional != null && typeof optional !== 'boolean') return bad('optional_must_be_boolean');
        // A duplicate family with CONFLICTING optionality is ambiguous in the one
        // way that matters — is this dep hard or soft? — so reject rather than
        // pick. (The operator's parser resolves dupes REQUIRED-WINS when reading
        // an already-stored declaration; that's a safe read of legacy data, not a
        // licence to publish a self-contradicting one.)
        if (families.has(family)) return bad('duplicate_family');
        families.add(family);
        clean.push({ family, ...(optional === true ? { optional: true } : {}) });
      }
      requiresEventsJson = JSON.stringify(clean);
    }

    // requires_rubrics (migration 015 / cupboard-plan-rubric-recipe-sharing D-001)
    // — the rubric axis's consumer half, structurally the same declaration as
    // requires_events above and validated the same way.
    //
    // Two deliberate differences from requires_events:
    //   1. KIND SCOPE is 'plan' + 'goal' (widened by migration 016 /
    //      work-on-everything-goal-2026-08-23 P-006 — both kinds' installers run
    //      the SAME operator-side rubric-requirements resolver). The COLUMN is
    //      kind-agnostic on purpose (so a future kind needs no table rebuild),
    //      but accepting the field from a kind with no install-time resolver
    //      would store a declaration nothing ever reads — a silent no-op is
    //      worse than a 400. Widening this check is the only change needed to
    //      admit another kind.
    //   2. There is no provides_rubrics counterpart to cross-check (D-002): a
    //      kind='rubric' row provides exactly the rubric named by its listing_ref.
    //
    // As with requires_events, resolvability is NOT validated here: the Cupboard
    // has no idea which rubrics the installing workspace already holds (its bundled
    // first-party set alone may satisfy the whole declaration). The storefront
    // stores the DECLARATION; the operator resolves it at install time.
    let requiresRubricsJson: string | null = null;
    if (body.requires_rubrics != null) {
      const bad = (reason: string) =>
        c.json({ error: 'invalid_field', field: 'requires_rubrics', reason }, 400);
      if (kind !== 'plan' && kind !== 'goal') return bad('plan_or_goal_kind_only');
      const rr = body.requires_rubrics;
      if (!Array.isArray(rr) || rr.length === 0 || rr.length > REQUIRES_RUBRICS_MAX_ENTRIES) {
        return bad('array_1_to_200');
      }
      const refs = new Set<string>();
      const clean: Array<{ rubricRef: string; optional?: boolean }> = [];
      for (const raw of rr) {
        if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return bad('entries_must_be_objects');
        const { rubricRef, optional } = raw as Record<string, unknown>;
        if (
          typeof rubricRef !== 'string' ||
          rubricRef.trim().length === 0 ||
          rubricRef.length > REQUIRES_RUBRICS_MAX_REF_LEN
        ) {
          return bad('rubricRef_non_empty_string_max_200');
        }
        if (optional != null && typeof optional !== 'boolean') return bad('optional_must_be_boolean');
        // Same reasoning as duplicate_family above: a duplicate ref with
        // CONFLICTING optionality is ambiguous in the one way that matters.
        if (refs.has(rubricRef)) return bad('duplicate_rubric_ref');
        refs.add(rubricRef);
        clean.push({ rubricRef, ...(optional === true ? { optional: true } : {}) });
      }
      requiresRubricsJson = JSON.stringify(clean);
    }

    // App distribution fields (migration 014 / cupboard-app-distribution P-003).
    // ALL app-only: a non-app listing carrying any of them is a client bug, so
    // reject rather than silently drop (same posture as provides_tools's
    // plugin_or_pack_kind_only). For a STANDALONE app, latest_json_url is
    // REQUIRED — it is the download handoff target; a standalone app row without
    // it is born un-downloadable. The Cupboard shape-validates the url but never
    // FETCHES it (that is the publish tool's assertAppManifestResolves gate,
    // client-side); the storefront stores the publisher's claim like topic_hex.
    const anyAppField =
      body.delivery_type != null ||
      body.latest_json_url != null ||
      body.release_repo != null ||
      body.icon_url != null ||
      body.platforms != null;
    let deliveryType: 'standalone' | 'bundle' | null = null;
    let latestJsonUrl: string | null = null;
    let releaseRepo: string | null = null;
    let iconUrl: string | null = null;
    let platformsJson: string | null = null;
    if (anyAppField && kind !== 'app') {
      return c.json({ error: 'invalid_field', field: 'app_fields', reason: 'app_kind_only' }, 400);
    }
    if (kind === 'app') {
      const badApp = (field: string, reason: string) =>
        c.json({ error: 'invalid_field', field, reason }, 400);
      if (body.delivery_type != null) {
        if (body.delivery_type !== 'standalone' && body.delivery_type !== 'bundle') {
          return badApp('delivery_type', 'standalone_or_bundle');
        }
        deliveryType = body.delivery_type;
      }
      // NULL delivery_type ⇒ standalone (the safe download-handoff default).
      const effectiveDelivery = deliveryType ?? 'standalone';
      if (body.latest_json_url != null) {
        if (
          typeof body.latest_json_url !== 'string' ||
          body.latest_json_url.length > APP_URL_MAX ||
          !HTTPS_URL_RE.test(body.latest_json_url)
        ) {
          return badApp('latest_json_url', 'https_url_max_500');
        }
        latestJsonUrl = body.latest_json_url;
      }
      if (effectiveDelivery === 'standalone' && latestJsonUrl == null) {
        // A standalone app IS its latest.json handoff — refuse a dead listing.
        return badApp('latest_json_url', 'required_for_standalone_app');
      }
      if (body.release_repo != null) {
        if (typeof body.release_repo !== 'string' || !RELEASE_REPO_RE.test(body.release_repo)) {
          return badApp('release_repo', 'owner_slash_repo');
        }
        releaseRepo = body.release_repo;
      }
      if (body.icon_url != null) {
        if (
          typeof body.icon_url !== 'string' ||
          body.icon_url.length > APP_URL_MAX ||
          !HTTPS_URL_RE.test(body.icon_url)
        ) {
          return badApp('icon_url', 'https_url_max_500');
        }
        iconUrl = body.icon_url;
      }
      if (body.platforms != null) {
        const p = body.platforms;
        if (!Array.isArray(p) || p.length === 0 || p.length > APP_PLATFORMS_MAX_ENTRIES) {
          return badApp('platforms', 'array_1_to_20');
        }
        if (
          !p.every(
            (k) => typeof k === 'string' && k.trim().length > 0 && k.length <= APP_PLATFORM_KEY_MAX_LEN,
          )
        ) {
          return badApp('platforms', 'non_empty_strings_max_64');
        }
        platformsJson = JSON.stringify(p);
      }
    }

    // Repo→Hive binding fields (migration 007 / hive-from-github-url D-004
    // HYBRID). Shape-validated only — the signed directory announce is the
    // content authority; the Cupboard stores the publisher's claim like any
    // other publish-body field (same trust posture as topic_hex/project_ref).
    // hive_title is display sugar for the pubkey — meaningless without it.
    if (
      body.hive_pubkey != null &&
      (typeof body.hive_pubkey !== 'string' || !HIVE_PUBKEY_RE.test(body.hive_pubkey))
    ) {
      return c.json({ error: 'invalid_field', field: 'hive_pubkey' }, 400);
    }
    if (body.hive_title != null) {
      if (
        typeof body.hive_title !== 'string' ||
        body.hive_title.length < 1 ||
        body.hive_title.length > HIVE_TITLE_MAX
      ) {
        return c.json({ error: 'invalid_field', field: 'hive_title' }, 400);
      }
      if (body.hive_pubkey == null) {
        return c.json({ error: 'invalid_field', field: 'hive_title', reason: 'requires_hive_pubkey' }, 400);
      }
    }

    // Channel-2 attestation (item 1) — optional, but both-or-neither.
    const hasGist = body.attestation_gist_id != null;
    const hasPubkey = body.publisher_device_pubkey != null;
    if (hasGist !== hasPubkey) {
      return c.json(
        { error: 'invalid_field', field: 'attestation_gist_id|publisher_device_pubkey', reason: 'both_or_neither' },
        400,
      );
    }
    if (
      hasGist &&
      (typeof body.attestation_gist_id !== 'string' ||
        body.attestation_gist_id.length > 100 ||
        !/^[A-Za-z0-9]+$/.test(body.attestation_gist_id))
    ) {
      return c.json({ error: 'invalid_field', field: 'attestation_gist_id' }, 400);
    }
    if (
      hasPubkey &&
      (typeof body.publisher_device_pubkey !== 'string' ||
        body.publisher_device_pubkey.length < 1 ||
        body.publisher_device_pubkey.length > 200)
    ) {
      return c.json({ error: 'invalid_field', field: 'publisher_device_pubkey' }, 400);
    }

    // Reject if the GitHub repo is private. Check via authed GitHub API
    // — we already have the publisher's token, and they must have at
    // least read perm on a repo they're publishing.
    const ghCheck = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(body.github_owner)}/${encodeURIComponent(body.github_name)}`,
      {
        headers: {
          Authorization: `Bearer ${extractBearer(c.req.raw)}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'papercusp-cupboard',
        },
      },
    );
    if (!ghCheck.ok) {
      return c.json({ error: 'github_repo_unreachable', status: ghCheck.status }, 400);
    }
    const repoMeta = (await ghCheck.json()) as {
      id?: number;
      private?: boolean;
      permissions?: Record<string, boolean>;
      default_branch?: string;
    };
    if (repoMeta.private) {
      return c.json({ error: 'private_repo_rejected' }, 400);
    }
    if (repoMeta.id !== body.github_repository_id) {
      return c.json({ error: 'repository_id_mismatch', expected: repoMeta.id }, 400);
    }
    // Publisher-permission signal (item 2): same trust signal for every kind.
    const publisher_permission = derivePublisherPermission(repoMeta.permissions);

    // Content pin before dedup: a new default-branch SHA is a new listing
    // version, while an exact SHA remains an idempotent retry (P-004).
    let pin: ContentPin | null = null;
    if (isSelfDescribingKind(kind)) {
      if (typeof repoMeta.default_branch !== 'string' || repoMeta.default_branch === '') {
        return c.json({ error: 'github_repo_unreachable', reason: 'no_default_branch' }, 400);
      }
      const pinned = await pinListingContent({
        token: extractBearer(c.req.raw),
        owner: body.github_owner,
        name: body.github_name,
        defaultBranch: repoMeta.default_branch,
        listingRef: body.listing_ref as string,
      });
      if (!pinned.ok) {
        if (pinned.code === 'github_tree_unreachable') {
          return c.json({ error: pinned.code, step: pinned.step, status: pinned.status }, 400);
        }
        if (pinned.code === 'github_blob_unreachable') {
          return c.json({ error: pinned.code, path: pinned.path, status: pinned.status }, 400);
        }
        if (pinned.code === 'identity_leak') {
          return c.json({ error: pinned.code, commitSha: pinned.commitSha, hits: pinned.hits }, 422);
        }
        const { ok: _ok, code, ...detail } = pinned;
        return c.json({ error: code, ...detail }, 422);
      }
      pin = pinned;
    }

    // Dedup. Harness → one active listing per repo. Non-harness → one active
    // listing per (repo, kind, listing_ref). A dedup hit returns the existing
    // listing rather than minting a second.
    const existing =
      kind === 'harness'
        ? await getHarnessByGithubRepoId(c.env.DB, body.github_repository_id)
        : await getActiveListingByRefs(c.env.DB, body.github_repository_id, kind, body.listing_ref as string, pin?.commitSha);
    const priorVersion =
      kind !== 'harness' && pin != null && existing == null
        ? await getActiveListingByRefs(c.env.DB, body.github_repository_id, kind, body.listing_ref as string)
        : existing;
    if (existing && !existing.unlisted_at) {
      await audit(c.env.DB, now, 'publish_dedup', {
        listing_kind: kind,
        github_repository_id: body.github_repository_id,
        listing_ref: existing.listing_ref,
        existing_id: existing.id,
        user_id: user.id,
      });
      return c.json({ ok: true, id: existing.id, harness: existing, listing: existing, dedup: true });
    }

    // Pre-publication review (knowledge-packs D-007): instruction-carrying
    // kinds land PENDING — invisible to public browse until an operator
    // approves. The response carries review_status so the publisher's client
    // can say "pending approval" instead of "live".
    const review_status = REVIEW_POLICY_KINDS.includes(kind) ? ('pending' as const) : ('approved' as const);

    // ── Catalog fields (migration 018 / shared-pot-dao-cupboard-v1 P-008) ────
    // Kind-agnostic: every kind can be private, priced, compatibility-scoped,
    // permission-declaring, and pinned to an immutable release.
    const badCatalog = (field: string, reason: string) =>
      c.json({ error: 'invalid_field', field, reason }, 400);
    const CATALOG_STR_MAX = 200;
    const optionalStr = (v: unknown, max = CATALOG_STR_MAX): string | null | false =>
      v == null ? null : typeof v === 'string' && v.trim() !== '' && v.length <= max ? v : false;

    let visibilityOut: ListingVisibility = 'public';
    if (body.visibility != null) {
      if (!isListingVisibility(body.visibility)) return badCatalog('visibility', 'public_unlisted_or_private');
      visibilityOut = body.visibility;
    }
    const tenantId = optionalStr(body.tenant_id);
    if (tenantId === false) return badCatalog('tenant_id', 'non_empty_string_max_200');
    // Fail-closed: a private listing with no owning tenant would be invisible to
    // everyone including its publisher, so refuse the row rather than store one
    // that can never be read back.
    if (visibilityOut === 'private' && tenantId == null) {
      return badCatalog('tenant_id', 'required_for_private_visibility');
    }

    const skuRef = optionalStr(body.sku_ref);
    if (skuRef === false) return badCatalog('sku_ref', 'non_empty_string_max_200');
    let pricingModel: PricingModel | null = null;
    if (body.pricing_model != null) {
      if (!isPricingModel(body.pricing_model)) return badCatalog('pricing_model', 'free_one_time_subscription_or_per_use');
      pricingModel = body.pricing_model;
    }
    let priceAmountMicros: number | null = null;
    if (body.price_amount_micros != null) {
      if (!Number.isSafeInteger(body.price_amount_micros) || (body.price_amount_micros as number) < 0) {
        return badCatalog('price_amount_micros', 'non_negative_integer');
      }
      priceAmountMicros = body.price_amount_micros as number;
    }
    const priceCurrency = optionalStr(body.price_currency, 16);
    if (priceCurrency === false) return badCatalog('price_currency', 'non_empty_string_max_16');
    // A priced listing must be COMPLETE: a settlement adapter resolves sku_ref
    // and charges amount+currency, so a half-declared price is an unchargeable
    // listing that only fails at purchase time.
    if (pricingModel != null && pricingModel !== 'free') {
      if (skuRef == null) return badCatalog('sku_ref', 'required_for_priced_listing');
      if (priceAmountMicros == null) return badCatalog('price_amount_micros', 'required_for_priced_listing');
      if (priceCurrency == null) return badCatalog('price_currency', 'required_for_priced_listing');
    }

    let compatibilityJson: string | null = null;
    if (body.compatibility != null) {
      const compat = body.compatibility;
      if (typeof compat !== 'object' || Array.isArray(compat)) return badCatalog('compatibility', 'must_be_object');
      const { runtime, platforms, architectures } = compat as Record<string, unknown>;
      if (runtime != null && (typeof runtime !== 'string' || runtime.trim() === '' || runtime.length > CATALOG_STR_MAX)) {
        return badCatalog('compatibility.runtime', 'non_empty_string_max_200');
      }
      const strArray = (v: unknown): string[] | null =>
        Array.isArray(v) && v.length <= 64 &&
        v.every((e) => typeof e === 'string' && e.trim() !== '' && e.length <= CATALOG_STR_MAX)
          ? (v as string[])
          : null;
      let platformList: string[] | undefined;
      if (platforms != null) {
        const parsed = strArray(platforms);
        if (!parsed) return badCatalog('compatibility.platforms', 'string_array_max_64');
        platformList = parsed;
      }
      let archList: string[] | undefined;
      if (architectures != null) {
        const parsed = strArray(architectures);
        if (!parsed) return badCatalog('compatibility.architectures', 'string_array_max_64');
        archList = parsed;
      }
      compatibilityJson = JSON.stringify({
        ...(typeof runtime === 'string' ? { runtime } : {}),
        ...(platformList ? { platforms: platformList } : {}),
        ...(archList ? { architectures: archList } : {}),
      });
    }

    let requiredPermissionsJson: string | null = null;
    if (body.required_permissions != null) {
      const perms = body.required_permissions;
      if (
        !Array.isArray(perms) || perms.length === 0 || perms.length > 200 ||
        !perms.every((p) => typeof p === 'string' && p.trim() !== '' && p.length <= CATALOG_STR_MAX)
      ) {
        return badCatalog('required_permissions', 'non_empty_string_array_max_200');
      }
      if (new Set(perms as string[]).size !== perms.length) {
        return badCatalog('required_permissions', 'duplicate_permission');
      }
      requiredPermissionsJson = JSON.stringify(perms);
    }

    // Immutable release identity. CONTENT identity only — no retrieval URL, so a
    // later storage-provider migration (D-024) touches no field here.
    const releaseVersion = optionalStr(body.release_version, 100);
    if (releaseVersion === false) return badCatalog('release_version', 'non_empty_string_max_100');
    const releaseSignature = optionalStr(body.release_signature, 1000);
    if (releaseSignature === false) return badCatalog('release_signature', 'non_empty_string_max_1000');
    const releaseManifestDigest = optionalStr(body.release_manifest_digest, 128);
    if (releaseManifestDigest === false) return badCatalog('release_manifest_digest', 'non_empty_string_max_128');
    // The FULL signed manifest (migration 032). The pins above can prove the
    // CLOSURE is untampered, but only these bytes let an installer recompute
    // listingManifestSigningBytes() and check the publisher signature — without
    // them the install-side verifier is unreachable (identities-v1 D-071/D-074).
    // Stored opaquely: this Worker deliberately does not import operator-core's
    // manifest validator, so it bounds and well-forms the value and leaves the
    // SEMANTIC check to the installer, which is the side that must not be fooled.
    const releaseManifest = optionalStr(body.release_manifest, 16000);
    if (releaseManifest === false) return badCatalog('release_manifest', 'non_empty_string_max_16000');
    if (releaseManifest != null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(releaseManifest);
      } catch {
        return badCatalog('release_manifest', 'json_object');
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return badCatalog('release_manifest', 'json_object');
      }
    }
    // An identity listing's declared surface (migration 035 / portable-identity-
    // packages P-016): what the storefront previews before install. The publisher
    // derives it from the closure it signs and the installer recomputes it from the
    // verified clone, so — like release_manifest — it is bounded and well-formed
    // here and checked semantically by the side that must not be fooled. Required
    // on, and exclusive to, the identity facet: a preview that is absent would
    // describe less than what installs.
    const isIdentityListing = kind === 'blueprint' && body.blueprint_kind === 'identity';
    const identitySurface = optionalStr(body.identity_surface, 16000);
    if (identitySurface === false) return badCatalog('identity_surface', 'non_empty_string_max_16000');
    if (identitySurface != null && !isIdentityListing) {
      return badCatalog('identity_surface', 'blueprint_identity_only');
    }
    if (isIdentityListing && identitySurface == null) {
      return badCatalog('identity_surface', 'required_with_identity_blueprint_kind');
    }
    if (identitySurface != null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(identitySurface);
      } catch {
        return badCatalog('identity_surface', 'json_object');
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return badCatalog('identity_surface', 'json_object');
      }
    }
    let releaseContentHash: string | null = null;
    if (body.release_content_hash != null) {
      if (typeof body.release_content_hash !== 'string' || !CONTENT_HASH_RE.test(body.release_content_hash)) {
        return badCatalog('release_content_hash', 'sha256_colon_64_hex');
      }
      releaseContentHash = body.release_content_hash.toLowerCase();
    }
    // A version names a release; a release without content identity cannot be
    // verified on delivery, which is the whole point of pinning one.
    if (releaseVersion != null && releaseContentHash == null) {
      return badCatalog('release_content_hash', 'required_with_release_version');
    }
    if (releaseContentHash != null && releaseVersion == null) {
      return badCatalog('release_version', 'required_with_release_content_hash');
    }

    // ── Content pin (cupboard-release-pipeline-content-trust P-001; D-003) ──
    // A self-describing kind installs from `<listing_ref>/` of the repo. The
    // Worker resolves the default-branch head and digests that directory NOW,
    // with the publisher's own token, so what the installer (P-002) verifies is
    // what the Worker saw — never what the client reported. Code kinds pin
    // through the release gate instead (Phase 4) and are untouched here.
    const id = uuidv4();
    await insertHarness(c.env.DB, {
      id,
      listing_kind: kind,
      review_status,
      project_ref: body.project_ref ?? null,
      listing_ref: kind === 'harness' ? null : (body.listing_ref ?? null),
      github_repository_id: body.github_repository_id,
      github_owner: body.github_owner,
      github_name: body.github_name,
      github_url: body.github_url,
      title: body.title ?? body.github_name,
      description: body.description ?? null,
      topic_hex: body.topic_hex ?? null,
      publisher_github_user_id: user.id,
      publisher_github_login: user.login,
      publisher_permission,
      publisher_device_pubkey: body.publisher_device_pubkey ?? null,
      publisher_attestation_gist_id: body.attestation_gist_id ?? null,
      provides_tools: providesToolsJson,
      uses_tools: usesToolsJson,
      provides_events: providesEventsJson,
      requires_events: requiresEventsJson,
      requires_rubrics: requiresRubricsJson,
      hive_pubkey: (body.hive_pubkey as string | undefined) ?? null,
      hive_title: (body.hive_title as string | undefined) ?? null,
      // P-018: the blueprint.yaml `kind` for a blueprint listing (the Hives-tab
      // discriminator), or the identity facet (P-016). Only meaningful for
      // kind='blueprint'; lenient — an absent/bad value ⇒ null (treated as a
      // harness-blueprint), never blocks a publish.
      blueprint_kind:
        kind === 'blueprint' &&
        (body.blueprint_kind === 'hive' || body.blueprint_kind === 'harness' || body.blueprint_kind === 'identity')
          ? body.blueprint_kind
          : null,
      identity_surface: identitySurface,
      // App distribution (migration 014). App-only — null on every other kind
      // (the validation above rejects an app field on a non-app publish).
      delivery_type: deliveryType,
      latest_json_url: latestJsonUrl,
      release_repo: releaseRepo,
      icon_url: iconUrl,
      platforms: platformsJson,
      // Catalog axes (migration 018 / P-008). Kind-agnostic.
      visibility: visibilityOut,
      tenant_id: tenantId,
      sku_ref: skuRef,
      pricing_model: pricingModel,
      price_amount_micros: priceAmountMicros,
      price_currency: priceCurrency,
      compatibility_json: compatibilityJson,
      required_permissions: requiredPermissionsJson,
      release_version: releaseVersion,
      release_content_hash: releaseContentHash,
      release_manifest_digest: releaseManifestDigest,
      release_signature: releaseSignature,
      release_manifest: releaseManifest,
      release_published_at: releaseVersion != null ? now : null,
      // Content pin (P-001): self-describing kinds only; null on code kinds.
      pinned_commit_sha: pin?.commitSha ?? null,
      pinned_tree_digest: pin?.treeDigest ?? null,
      pinned_at: pin ? now : null,
      created_at: now,
    });
    if (priorVersion && pin != null && priorVersion.pinned_commit_sha !== pin.commitSha) {
      await supersedeHarnessListing(c.env.DB, priorVersion.id, id, 'superseded_by_new_content_pin', now);
    }
    await audit(c.env.DB, now, 'published', {
      id,
      listing_kind: kind,
      github_repository_id: body.github_repository_id,
      listing_ref: kind === 'harness' ? null : body.listing_ref,
      publisher_github_user_id: user.id,
      review_status,
    });
    const listing = await getHarnessById(c.env.DB, id);
    return c.json({
      ok: true,
      id,
      harness: listing,
      listing,
      review_status,
      ...(review_status === 'pending'
        ? { pending_review: true, hint: 'This listing kind requires operator approval before it is publicly visible. You will see it as pending; everyone else sees it once approved.' }
        : {}),
    });
  });

  // DELETE base/:id — unlist (publisher or claimant).
  app.delete(`${base}/:id`, async (c) => {
    let user;
    try {
      user = await resolveGithubBearer(c.req.raw);
    } catch (e) {
      if (e instanceof AuthError) return c.json({ error: 'auth', reason: e.reason }, 401);
      throw e;
    }
    const id = c.req.param('id');
    const row = await getHarnessById(c.env.DB, id);
    if (!row) return c.json({ error: 'not_found' }, 404);
    if (row.unlisted_at) return c.json({ ok: true, already_unlisted: true });
    const isPublisher = row.publisher_github_user_id === user.id;
    const isClaimant = row.claimant_github_user_id === user.id;
    if (!isPublisher && !isClaimant) return c.json({ error: 'forbidden' }, 403);
    const now = Date.now();
    await markHarnessUnlisted(c.env.DB, id, 'by_publisher', now);
    await audit(c.env.DB, now, 'unlisted', { id, listing_kind: row.listing_kind, by_user_id: user.id });
    return c.json({ ok: true });
  });

  // POST base/:id/claim — claim by maintain/admin perm.
  app.post(`${base}/:id/claim`, async (c) => {
    let user;
    try {
      user = await resolveGithubBearer(c.req.raw);
    } catch (e) {
      if (e instanceof AuthError) return c.json({ error: 'auth', reason: e.reason }, 401);
      throw e;
    }
    const id = c.req.param('id');
    const row = await getHarnessById(c.env.DB, id);
    if (!row) return c.json({ error: 'not_found' }, 404);
    if (row.unlisted_at) return c.json({ error: 'unlisted' }, 410);
    if (row.claim_status === 'claimed') {
      return c.json({ error: 'already_claimed', claimant_github_user_id: row.claimant_github_user_id }, 409);
    }
    const perm = await checkRepoPermission(
      extractBearer(c.req.raw),
      row.github_owner,
      row.github_name,
      'maintain',
    );
    if (!perm.has_permission) {
      return c.json({ error: 'insufficient_permission', required: 'maintain' }, 403);
    }
    const now = Date.now();
    await setHarnessClaim(c.env.DB, id, { user_id: user.id, login: user.login }, now);
    await audit(c.env.DB, now, 'claimed', { id, listing_kind: row.listing_kind, user_id: user.id, permission: perm.permission });
    const updated = await getHarnessById(c.env.DB, id);
    return c.json({ ok: true, harness: updated, listing: updated });
  });
}

/**
 * The generalized storefront route. Registers the kind-aware /listings surface
 * AND the kind='harness' /harnesses back-compat view (same handlers).
 */
export function listingsRoute(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  registerListingEndpoints(app, '/listings');
  registerListingEndpoints(app, '/harnesses', { fixedKind: 'harness' });
  return app;
}
