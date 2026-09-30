/**
 * Reusable Cupboard listing-publish core (revive-cupboard-distribution-2026-06-04).
 *
 * THE one server-side publish path: add the gh-token + channel-2 attestation,
 * POST the generalized `/listings` surface — no internal HTTP hop. Hive
 * member-repo rows, blueprint and plugin/pack publishes all ride this core.
 * (The per-harness ShareWizard publish route that used to sit beside it was
 * retired — comb-retire-per-harness-sharing-2026-06-11 P-006.)
 *
 * The `/harnesses` fallback (for a pre-migration-004 worker) is harness-only —
 * a non-harness kind can't be stored by the old worker, so it surfaces the 404.
 */
import { getGhAuthToken } from '../identity/gh-token';
import { resolveCupboardBaseUrl } from './base-url';
import { listingManifestDigest, unsignedListingManifest } from './listing-manifest';
import { prepareReleaseForPublish, type ReleaseGateInput } from './publish-release-gate';
import { resolvePublisherAttestation } from './publisher-attestation';
import type { ListingKind, ListingVisibility, RubricRequirement } from './types';
import type { ProvidedEventFamily, RequiredEventFamily } from '@papercusp/blueprint-distribution';

/** A validated listing-publish payload (mirrors the Cupboard `/listings` body). */
export interface CupboardListingInput {
  listing_kind: ListingKind;
  /** Papercupai project remote (D-008). */
  project_ref?: string;
  /** Within-project discriminator — REQUIRED for non-harness kinds (plugin slug / pack id). */
  listing_ref?: string;
  github_repository_id: number;
  github_owner: string;
  github_name: string;
  github_url: string;
  title?: string;
  description?: string;
  /** Required only for kind='harness' (the Hypercore join topic). */
  topic_hex?: string;
  /**
   * Repo→Hive binding (worker migration 007 / hive-from-github-url P-004,
   * D-004 HYBRID): the owning Hive's raw 32-byte Ed25519 pubkey, base64 (same
   * encoding as the hive directory announce). One row per member repo of a
   * public hive, all carrying the same pubkey. Omit for non-hive listings.
   */
  hive_pubkey?: string;
  /** Denormalized Hive display title (the directory announce stays the content authority). */
  hive_title?: string;
  /** For a `listing_kind: 'blueprint'` publish: the blueprint.yaml `kind` — 'hive' (a hive
   *  template) | 'harness'. The Cupboard "Hives" tab discriminator (worker migration 009 /
   *  hive-blueprint-generalization P-018). Omit for non-blueprint kinds. */
  blueprint_kind?: 'pot' | 'hive' | 'harness';
  /**
   * Pack model (worker migration 006 / tool-distribution-granularity): the MCP
   * tool names the unit registers when installed. Kinds plugin|pack only — the
   * worker 400s it elsewhere. Powers the Cupboard's tool→provider discovery.
   */
  provides_tools?: string[];
  /**
   * The EVENT half of the same pack model (worker migration 012 / D-003, P-007):
   * the awaitable event-key families this unit provides when installed. Kinds
   * plugin|pack only — the worker 400s it elsewhere.
   *
   * ⚠ This field is why the event axis WORKS AT ALL in production. P-007 landed
   * the column, the worker's accept+validate, the catalog read, the resolver and
   * the install gate — but nothing ever SENT it, so `cupboardEventIndex` was
   * permanently empty, `resolveEventProvider` could never return 'installable',
   * and an event dep could never pull its providing unit in. The whole
   * installable rung was inert. Every publish path that lists a plugin/pack must
   * populate this from the manifest's `provides.events`, or its listing is
   * invisible to event resolution.
   */
  provides_events?: ProvidedEventFamily[];
  /**
   * The event families this unit REQUIRES (worker migration 013 / D-003, P-008),
   * from the manifest's `dependencies.events`. Kinds plugin|pack only.
   *
   * Published so a user can see a unit's requirements BEFORE installing: the
   * P-007 install gate HARD-FAILS an install whose required family nothing
   * provides, so without this the refusal arrives as a surprise toast after the
   * click. It is a DECLARATION, never a resolution — whether family X is
   * actually available is the resolver's answer, against the local catalog.
   */
  requires_events?: RequiredEventFamily[];
  /**
   * The rubrics this unit REQUIRES (worker migration 015 /
   * cupboard-plan-rubric-recipe-sharing D-001, P-009). Kind `plan` only today — the
   * worker 400s (`plan_kind_only`) on any other kind, deliberately, so a declaration
   * no install-time resolver reads can never be stored as a silent no-op.
   *
   * Published for the same reason as `requires_events`: the install gate
   * (rubric-requirements.ts) HARD-FAILS an install whose required rubric nothing
   * provides, and a refusal that arrives only after the click is a worse refusal. It
   * is a DECLARATION, never a resolution — whether the installing workspace already
   * has the rubric (its BUNDLED first-party set often does) is the resolver's answer.
   */
  requires_rubrics?: RubricRequirement[];
  /**
   * App distribution (worker migration 014 / cupboard-app-distribution-2026-07-14
   * P-003, D-001). Kind `app` only — the worker 400s these on any other kind.
   * `delivery_type` discriminates the model: 'standalone' (a separate downloadable
   * product — "install" DOWNLOADS the platform installer from its own release;
   * the Cupboard never re-hosts the binary) | 'bundle' (a papercusp-native
   * composition, Phase 2). Omitted ⇒ the worker treats it as 'standalone'.
   */
  delivery_type?: 'standalone' | 'bundle';
  /**
   * STANDALONE: URL of the app's signed `latest.json` updater manifest
   * (@papercusp/tauri-release-kit `buildLatestManifest` output). The download
   * flow (P-005) reads it to resolve the platform-specific installer URL. The
   * `cupboard:publish-app` tool VALIDATES this RESOLVES before publishing
   * (assertAppManifestResolves) so a broken release can't publish a dead listing.
   */
  latest_json_url?: string;
  /** STANDALONE: `<owner>/<repo>` whose GitHub Releases host the installers, when
   *  distinct from the source repo. Omit ⇒ falls back to the listing's repo. */
  release_repo?: string;
  /** App icon URL for the storefront card/detail (an app is a whole product, so
   *  it gets a real icon rather than a kind glyph). */
  icon_url?: string;
  /** Denormalized OS keys present in `latest.json` (e.g.
   *  ["darwin-aarch64","linux-x86_64"]) so the card shows availability without
   *  fetching the manifest. Derived from the validated manifest by the tool. */
  platforms?: string[];

  // ── Catalog axes (worker migration 018 / shared-pot-dao-cupboard-v1 P-008,
  // D-045 §3b). Kind-agnostic, unlike the app-only block above.
  //
  // ⚠ These were the `provides_events` bug again, one axis over. The worker
  // validates and stores them (`routes/listings.ts` → `insertListing`), the row
  // type carries them, and the read paths are fail-closed around them — but
  // NOTHING could send them, because this input type could not express them. So
  // every listing published through the one server-side path landed on the
  // worker's `visibility` default of 'public', and a private listing was
  // unpublishable however the caller asked for it.
  //
  // The commerce axes the same migration added (`sku_ref`, `pricing_model`,
  // `price_*`) are deliberately NOT here: they belong to the P-011 commerce
  // doors, not to this decision's publish chain. ──

  /** public (default) | unlisted | private. Omitted ⇒ the worker's 'public'. */
  visibility?: ListingVisibility;
  /**
   * Owning shared pot. REQUIRED by the worker when `visibility: 'private'` — a
   * private row is visible only to callers scoped to this tenant, so a private
   * listing with no tenant would be visible to nobody, including its publisher.
   */
  tenant_id?: string;

  /**
   * The release this listing distributes, when it ships bytes. Runs the D-041
   * publish-time content-address check (and, for a private listing, the
   * encrypt/package/wrap pass) BEFORE anything is POSTed, then pins the
   * resulting release identity onto the row.
   *
   * ⚠ NEVER forwarded to the Cupboard. It carries publisher-only material —
   * plaintext bytes and the content key on the private path — so
   * `publishListingToCupboard` strips it from the request body by construction.
   */
  release?: ReleaseGateInput;
}

export type CupboardPublishResult =
  | { ok: true; status: number; data: unknown }
  | { ok: false; status: number; error: string; detail?: unknown; upstream_status?: number };

const DEFAULT_PUBLISHER_ATTESTATION_TIMEOUT_MS = 10_000;
const DEFAULT_CUPBOARD_POST_TIMEOUT_MS = 15_000;

export interface CupboardPublishTimeouts {
  /** Test/diagnostic override. Production callers use the bounded default. */
  attestationMs?: number;
  /** Covers the complete worker request, including response-body consumption. */
  upstreamMs?: number;
}

class PublishStageTimeoutError extends Error {
  constructor(
    readonly stage: 'publisher_attestation' | 'cupboard_post',
    readonly timeoutMs: number,
  ) {
    super(`publish_stage_timeout:${stage}`);
    this.name = 'PublishStageTimeoutError';
  }
}

async function runPublishStage<T>(
  stage: PublishStageTimeoutError['stage'],
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new PublishStageTimeoutError(stage, timeoutMs);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(controller.signal), timedOut]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Publish a listing of any kind to the Cupboard `/listings` surface. Adds the
 * caller's gh-token (the browser/agent never holds it) + a best-effort channel-2
 * publisher attestation, then POSTs the worker. Returns a structured result the
 * caller maps to its own response. Never throws — network failures become a
 * `cupboard_unreachable` 502.
 */
export async function publishListingToCupboard(
  input: CupboardListingInput,
  timeouts: CupboardPublishTimeouts = {},
): Promise<CupboardPublishResult> {
  // Strip the publisher-only release block up front, so no later edit can leak
  // plaintext or the content key into the request body by adding a spread.
  const { release, ...listing } = input;

  // Refuse locally what the worker would refuse anyway, but with the reason.
  // A private row is scoped to its tenant, so a private listing with no tenant
  // is visible to nobody at all — including whoever just published it.
  if (listing.visibility === 'private' && !listing.tenant_id) {
    return {
      ok: false,
      status: 400,
      error: 'tenant_required_for_private_visibility',
      detail: "visibility 'private' scopes the listing to tenant_id; without one the row would be visible to nobody",
    };
  }

  const tokenRes = await getGhAuthToken();
  if (tokenRes.kind !== 'ok') {
    return { ok: false, status: 401, error: 'gh_auth_required', detail: tokenRes.error.kind };
  }

  // The publish-time release gate (D-045 §3b). Runs after auth — there is no
  // point encrypting a large artifact for a publish that cannot proceed — and
  // before the POST, so an unpublishable release never reaches the catalog.
  let releasePins: Record<string, string> = {};
  if (release) {
    const prepared = await prepareReleaseForPublish(release);
    if (!prepared.ok) {
      return { ok: false, status: 422, error: `release_${prepared.code.replace(/-/g, '_')}`, detail: prepared.detail };
    }
    // Pin the IDENTITY of the validated release. Content identity only, never a
    // retrieval URL, so a later storage migration changes nothing here.
    const releaseManifest = prepared.manifest.release;
    releasePins = {
      release_version: releaseManifest.releaseVersion,
      release_content_hash: releaseManifest.contentHash,
      release_manifest_digest: listingManifestDigest(unsignedListingManifest(releaseManifest)),
      release_signature: releaseManifest.signature,
      // The WHOLE signed manifest, so an installer can verify the signature
      // over the bytes it was signed over instead of reconstructing them
      // (identities-v1 D-074). The pins above are an INDEX into this; three of
      // the signed fields (license, publisher, reviewStatus) exist nowhere else
      // on the row, so without this a verifier cannot re-derive the bytes at all.
      release_manifest: JSON.stringify(releaseManifest),
    };
  }

  // Best-effort channel-2 attestation (idempotent device-binding gist). null on
  // any failure → publish proceeds unattributed.
  let attestation: Awaited<ReturnType<typeof resolvePublisherAttestation>> = null;
  try {
    attestation = await runPublishStage(
      'publisher_attestation',
      timeouts.attestationMs ?? DEFAULT_PUBLISHER_ATTESTATION_TIMEOUT_MS,
      async () => resolvePublisherAttestation(),
    );
  } catch {
    // Channel 2 is deliberately best-effort. A slow GitHub/keychain path must
    // not consume the enclosing MCP call's entire 60-second budget.
    attestation = null;
  }
  const publishBody = {
    ...listing,
    ...releasePins,
    ...(attestation ?? {}),
  };

  const base = resolveCupboardBaseUrl();
  const headers = {
    Authorization: `Bearer ${tokenRes.token}`,
    'Content-Type': 'application/json',
    'User-Agent': 'papercusp-operator-cupboard-proxy',
  };
  const payload = JSON.stringify(publishBody);

  let upstream: Response;
  let responseText: string;
  try {
    ({ upstream, responseText } = await runPublishStage(
      'cupboard_post',
      timeouts.upstreamMs ?? DEFAULT_CUPBOARD_POST_TIMEOUT_MS,
      async (signal) => {
        let response = await fetch(`${base}/listings`, { method: 'POST', headers, body: payload, signal });
        // Transitional: a worker not yet on migration 004 has no /listings. Only a
        // harness publish can fall back to /harnesses; non-harness kinds surface 404.
        if (response.status === 404 && input.listing_kind === 'harness') {
          response = await fetch(`${base}/harnesses`, { method: 'POST', headers, body: payload, signal });
        }
        return { upstream: response, responseText: await response.text() };
      },
    ));
  } catch (e) {
    if (e instanceof PublishStageTimeoutError) {
      return {
        ok: false,
        status: 504,
        error: 'cupboard_timeout',
        detail: { stage: e.stage, timeoutMs: e.timeoutMs },
      };
    }
    return { ok: false, status: 502, error: 'cupboard_unreachable', detail: (e as Error).message.slice(0, 200) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    return { ok: false, status: 502, error: 'cupboard_bad_response', detail: responseText.slice(0, 200), upstream_status: upstream.status };
  }
  if (!upstream.ok) {
    return { ok: false, status: upstream.status, error: 'cupboard_error', detail: parsed, upstream_status: upstream.status };
  }
  return { ok: true, status: 200, data: parsed };
}
