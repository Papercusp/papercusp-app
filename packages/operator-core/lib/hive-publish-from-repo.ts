/**
 * hive-publish-from-repo — the visibility-gated publish step of
 * create-a-Hive-from-a-GitHub-URL (hive-from-github-url-2026-06-11 P-007;
 * D-002 auto-publish · D-003 private/invite rules · D-004/D-008 HYBRID).
 *
 * For a freshly-created from-repo Hive:
 *   public  → directory announce (member_repos + one-click member links over
 *             the HIVE federation topic) + a Cupboard listing row PER MEMBER
 *             REPO (all carrying hive_pubkey — the uniqueness/off-network
 *             index) + local binding-cache rows.
 *   invite  → directory announce on the invite-secret topic ONLY. NO Cupboard
 *             rows (repo-discoverability would leak the hive to non-holders).
 *   private → never reaches this module (the caller skips it; D-003 zero
 *             external writes).
 *
 * Every leg is best-effort and individually reported — a publish failure NEVER
 * fails the create (re-publish rides discovery:set_pot / the boot tick).
 */

import { randomBytes } from 'node:crypto';

import { loadHarnessRegistry, type ProjectEntry } from './harness-registry';
import { getHiveDirectory } from './hive-directory-deps';
import { deriveHiveMemberRepoRefs } from './hive-member-repos';
import {
  publishHiveToDirectory,
  type HiveDirectoryMeta,
  type HiveOwnerIdentity,
} from './hive-publish';
import { saveOwnedHiveMeta } from './hive-directory-meta';
import { parseGithubUrl } from './harness/clone-github';
import { formatHarnessLink } from './harness/url-scheme';
import { canonicalRepoKey } from './sync/pot-git/repo-identity';
import { formatHiveInviteLink } from './harness/hive-invite-link';
import {
  deriveHiveFederationTopic,
  topicAsHex,
} from './sync/hyperbee/derive-swarm-topic';
import type { HiveVisibility } from './sync/hyperbee/hive-announce';

// ── Result shape ───────────────────────────────────────────────────────────────

export interface PublishCreatedHiveOutcome {
  announced: boolean;
  /** Deceptive-publish fix: swarm peers the announce actually reached (0 = the
   *  frame was broadcast into the void; registered but not yet discoverable). */
  reachablePeers: number;
  /** Returned for invite hives so the creator can hand the secret to invitees. */
  inviteSecret?: string;
  /**
   * Hardening P-006 (D-006): the shareable invite ARTIFACT —
   * `papercusp://pot?pubkey=…&secret=…&title=…` — formatted whenever an
   * inviteSecret is minted (secret-only when the pubkey isn't loadable).
   */
  inviteLink?: string;
  /** The hive's Ed25519 identity pubkey (base64, 32 bytes), when loadable. */
  hivePubkey?: string;
  /**
   * The one-click `papercusp://harness?...` member-join links over the HIVE
   * federation topic — the SAME set the directory announce carries (member loop
   * below) and the `existing` join-offer surfaces (lookup-hive-for-repo
   * HiveHit.memberLinks). Surfaced on the outcome so a freshly-created hive's
   * `created` response yields a join target a joiner can pass straight to POST
   * /api/discovery/join-pot `{ potId, memberLinks, hivePubkey }` WITHOUT a
   * second directory round-trip (WI-931). Absent when no joinable topic exists
   * (no hive pubkey) or no id-bearing member repo is registered yet.
   */
  memberLinks?: string[];
  cupboard: {
    attempted: boolean;
    /** Why the Cupboard leg was skipped, when it was. */
    skipped?: 'invite' | 'private_repo' | 'no_hive_pubkey' | 'no_member_repo_ids';
    rowsCreated?: number;
    /** Rows already present (the worker's per-repo uniqueness, HTTP 409) —
     *  expected on re-publish/visibility flips, not a failure. */
    rowsExisted?: number;
    rowsFailed?: number;
    /** Hardening D-002 auto-claim: rows claimed by the creator at create time
     *  (the worker verified maintain/admin via its OWN claim path). A row left
     *  unclaimed because the creator lacks permission is the normal
     *  provisional posture, not a failure. */
    rowsClaimed?: number;
    errors?: string[];
  };
  localBindings?: { created: number; existed: number; failed: number };
  error?: string;
}

export interface PublishCreatedHiveOpts {
  workspaceId: string;
  /** The Hive home slug (== directory potId). */
  potSlug: string;
  title: string;
  description: string;
  visibility: Exclude<HiveVisibility, 'private'>;
  /** GitHub repo visibility — a private repo never gets a Cupboard row (the
   *  public registry refuses private repos, same gate as the ShareWizard). */
  repoIsPrivate?: boolean;
}

// ── Injectable seams ───────────────────────────────────────────────────────────

export interface PublishCreatedHiveDeps {
  saveMeta?: typeof saveOwnedHiveMeta;
  ensureWired?: (workspaceId: string, opts?: { force?: boolean }) => Promise<unknown>;
  resolveOwner?: () => Promise<HiveOwnerIdentity>;
  loadPubkey?: (workspaceId: string, potSlug: string) => Promise<string | null>;
  loadRegistry?: typeof loadHarnessRegistry;
  deriveMemberRepos?: typeof deriveHiveMemberRepoRefs;
  publishDirectory?: typeof publishHiveToDirectory;
  getDirectory?: typeof getHiveDirectory;
  publishListing?: (
    input: Record<string, unknown>,
  ) => Promise<{
    ok: boolean;
    error?: string;
    status?: number;
    upstream_status?: number;
    /** The worker's create response (carries the new listing's `id`). */
    data?: unknown;
  }>;
  /**
   * Hardening D-002: drive the worker's OWN claim path (POST
   * /listings/:id/claim — the same endpoint the claim CTA uses; the worker
   * verifies maintain/admin itself). Best-effort; insufficient permission is
   * the normal provisional outcome.
   */
  claimListing?: (
    listingId: string | number,
  ) => Promise<{ ok: boolean; status?: number; error?: string }>;
  createLocalBinding?: (input: {
    githubUrl: string;
    privacy: 'shared-private' | 'shared-public';
    harness_topic: string;
    harness_slug: string;
  }) => Promise<unknown>;
  /**
   * EI-681: after publish, re-key the local member harnesses that just went
   * shared onto the Hive-pubkey topic (the "go shared" re-key). The hyperbee
   * substrate only boots once at host-bootstrap, and nothing re-keys a harness
   * that becomes federation-active at RUNTIME — so an owner's published harness
   * never joins the Hive topic or drains its outbox until a restart, and its
   * features never federate out (the join side handles this via join-hive 2c).
   * `rekeyHarness` re-resolves the now-present binding and joins the Hive topic
   * IN PLACE — NOT a reboot, because a reboot breaks the owner's corestore
   * serving of its own log core (the owner would admit + connect but never UPLOAD
   * its log → feature never crosses). Defaults to the real `rekeyHarness`, lazily
   * imported so this publish module never pulls the swarm stack at load.
   */
  rekeyHarness?: (workspaceId: string, harnessSlug: string) => Promise<unknown>;
  /** Owned-meta read for republishHiveAfterMemberAdd. */
  getMeta?: (potId: string, workspaceId: string) => Promise<HiveDirectoryMeta | null>;
  now?: () => number;
  randomSecret?: () => string;
}

async function defaultClaimListing(
  listingId: string | number,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  try {
    const { getGhAuthToken } = await import('./identity/gh-token');
    const tokenRes = await getGhAuthToken();
    if (tokenRes.kind !== 'ok') return { ok: false, error: 'gh_auth_required' };
    const { resolveCupboardBaseUrl } = await import(
      './cupboard/base-url'
    );
    const res = await fetch(`${resolveCupboardBaseUrl()}/listings/${listingId}/claim`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenRes.token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { ok: true, status: res.status };
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, status: res.status, error: body.error ?? `cupboard_http_${res.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function defaultResolveOwner(): Promise<HiveOwnerIdentity> {
  const { resolveLocalAnnounceIdentity } = await import('./sync/hyperbee/local-announce-identity');
  const id = await resolveLocalAnnounceIdentity({ logCoreKeyHex: '0'.repeat(64) });
  return {
    githubLogin: id.githubLogin,
    githubUserId: id.githubUserId,
    devicePubkey: id.devicePubkeyBase64,
    attestationGistId: id.attestationGistId,
  };
}

// ── The publish step ───────────────────────────────────────────────────────────

export async function publishCreatedHive(
  opts: PublishCreatedHiveOpts,
  deps: PublishCreatedHiveDeps = {},
): Promise<PublishCreatedHiveOutcome> {
  const saveMeta = deps.saveMeta ?? saveOwnedHiveMeta;
  const now = deps.now ?? Date.now;
  const randomSecret = deps.randomSecret ?? (() => randomBytes(32).toString('hex'));

  const inviteSecret = opts.visibility === 'invite' ? randomSecret() : undefined;

  // 1 — persist the listing meta (the durable half; the boot tick re-publishes it).
  const meta: HiveDirectoryMeta = {
    potId: opts.potSlug,
    title: opts.title,
    description: opts.description,
    workspaceId: opts.workspaceId, // P-004: announce-build enrichment key
    visibility: opts.visibility,
    memberTopics: [],
    createdAt: now(),
    ...(inviteSecret ? { inviteSecret } : {}),
  };
  try {
    await saveMeta(meta, opts.workspaceId);
  } catch (e) {
    return {
      announced: false,
      reachablePeers: 0,
      cupboard: { attempted: false },
      error: `save_meta_failed: ${e instanceof Error ? e.message : e}`,
      ...(inviteSecret
        ? { inviteSecret, inviteLink: formatHiveInviteLink({ secret: inviteSecret, title: opts.title }) }
        : {}),
    };
  }

  const out = await publishListingForMeta(
    meta,
    { workspaceId: opts.workspaceId, ...(opts.repoIsPrivate !== undefined ? { repoIsPrivate: opts.repoIsPrivate } : {}) },
    deps,
  );
  // P-006 (D-006): one shareable artifact — the full invite link, carrying the
  // hive pubkey when the publish leg loaded it (secret-only otherwise).
  const inviteLink = inviteSecret
    ? formatHiveInviteLink({
        ...(out.hivePubkey ? { pubkeyBase64: out.hivePubkey } : {}),
        secret: inviteSecret,
        title: opts.title,
      })
    : undefined;
  return { ...out, ...(inviteSecret ? { inviteSecret, inviteLink } : {}) };
}

/**
 * P-009 — re-publish an EXISTING hive's listing after a member was added
 * (into-hive mode): re-derives member repos/links, re-announces, and registers
 * the NEW member repo's Cupboard + local rows only (`onlyRepoIds` — re-posting
 * existing rows would just trip the worker's per-repo uniqueness). A hive that
 * was never published (private / no meta) is left untouched.
 */
export async function republishHiveAfterMemberAdd(
  opts: {
    workspaceId: string;
    potSlug: string;
    /** Restrict the Cupboard/local-binding legs to these repo ids (the new member). */
    onlyRepoIds?: number[];
    repoIsPrivate?: boolean;
  },
  deps: PublishCreatedHiveDeps = {},
): Promise<PublishCreatedHiveOutcome | { skipped: 'unpublished_hive' }> {
  const getMeta =
    deps.getMeta ??
    (async (potId: string, ws: string) =>
      (await import('./hive-directory-meta')).getOwnedHiveMeta(potId, ws));
  const meta = await getMeta(opts.potSlug, opts.workspaceId).catch(() => null);
  if (!meta || meta.visibility === 'private') return { skipped: 'unpublished_hive' };
  return publishListingForMeta(
    meta as HiveDirectoryMeta & { visibility: Exclude<HiveVisibility, 'private'> },
    {
      workspaceId: opts.workspaceId,
      ...(opts.repoIsPrivate !== undefined ? { repoIsPrivate: opts.repoIsPrivate } : {}),
      ...(opts.onlyRepoIds ? { onlyRepoIds: opts.onlyRepoIds } : {}),
    },
    deps,
  );
}

/** The shared announce + Cupboard + local-binding legs (steps 2–6). */
async function publishListingForMeta(
  meta: HiveDirectoryMeta & { visibility: Exclude<HiveVisibility, 'private'> },
  opts: { workspaceId: string; repoIsPrivate?: boolean; onlyRepoIds?: number[] },
  deps: PublishCreatedHiveDeps = {},
): Promise<PublishCreatedHiveOutcome> {
  const resolveOwner = deps.resolveOwner ?? defaultResolveOwner;
  const loadRegistry = deps.loadRegistry ?? loadHarnessRegistry;
  const deriveMemberRepos = deps.deriveMemberRepos ?? deriveHiveMemberRepoRefs;
  const publishDirectory = deps.publishDirectory ?? publishHiveToDirectory;
  const getDirectory = deps.getDirectory ?? getHiveDirectory;

  // 2 — best-effort transport wire (a box that gh-authed after boot).
  try {
    const ensureWired =
      deps.ensureWired ??
      (async (ws: string, wireOpts?: { force?: boolean }) =>
        (await import('./hive-directory-boot')).ensureHiveDirectoryWired(ws, wireOpts));
    await ensureWired(opts.workspaceId, { force: true });
  } catch {
    /* announce below degrades to registered-not-broadcast */
  }

  // 3 — enrichment: identity pubkey + member repos + one-click member links over
  //     the HIVE federation topic (the joiner clones the repo + joins that topic).
  const loadPubkey =
    deps.loadPubkey ??
    (async (ws: string, slug: string) =>
      (await import('./identity/hive-keypair')).loadHivePubkey(ws, slug).catch(() => null));
  const hivePubkey = await loadPubkey(opts.workspaceId, meta.potId).catch(() => null);
  const memberRepos = await deriveMemberRepos(opts.workspaceId, meta.potId).catch(
    () => [] as string[],
  );

  const reg = await loadRegistry(opts.workspaceId).catch(() => ({ projects: [] as ProjectEntry[] }));
  const members = reg.projects.filter(
    (p) =>
      (p.slug === meta.potId || p.hive_slug === meta.potId) &&
      typeof p.github_remote === 'string' &&
      p.github_remote.length > 0,
  );

  const hiveTopicHex = hivePubkey ? topicAsHex(deriveHiveFederationTopic(hivePubkey)) : null;

  // D-007 (from-repo-seed receive-side fix): resolve the owner identity ONCE
  // up-front (best-effort) so each hive MEMBER link can carry the VERIFIED owner
  // binding (hivePubkey → ownerDevicePubkey + ownerGithubUserId + attestationGistId).
  // A DIRECT-LINK joiner uses this to seed its hive_directory_cache at join (channel-2
  // re-verified there) so the owner-log bootstrap-admit fires WITHOUT waiting to catch
  // the live announce beacon — the run-20 "0 announce → empty roster → drop all owner
  // content" receive failure. Degrades gracefully: if the owner can't be resolved the
  // link is emitted without the binding (joiner falls back to the beacon). Reused by
  // the directory announce below (no double-resolve).
  let owner: HiveOwnerIdentity | null = null;
  try {
    owner = await resolveOwner();
  } catch {
    owner = null;
  }

  const memberLinks: string[] = [];
  if (hiveTopicHex) {
    for (const m of members) {
      const parsed = m.github_remote ? parseGithubUrl(m.github_remote) : null;
      if (!parsed || typeof m.github_repository_id !== 'number') continue;
      // D-047/D-048 (shared-hive join blocker): a member-JOIN link must point at a real MEMBER
      // repo a fresh joiner can `git clone`, NEVER the hive HOME itself. A hive built from <repo>
      // has hive slug <repo>-hive which is GIST-BACKED (NOT a GitHub repo) — emitting a link with
      // github=<owner>/<repo>-hive made EVERY fresh joiner's `git clone …/<repo>-hive.git` 404, so
      // the joiner never booted onto the swarm topic → 0 cross-machine federation (the live blocker;
      // non-deterministic because the good <repo> link + this bad one both landed in memberLinks and
      // the picker took whichever enumerated first). The hive home is the federation identity, not a
      // cloneable member — skip it (by slug AND by a repo-name == hive-slug belt).
      if (m.slug === meta.potId || parsed.repo === meta.potId) continue;
      memberLinks.push(
        formatHarnessLink({
          topic: hiveTopicHex,
          github: `${parsed.owner}/${parsed.repo}`,
          repoOwner: parsed.owner,
          repoName: parsed.repo,
          repoId: m.github_repository_id,
          // A3 (EI-18788176839043286): publish the repoKey this member's pot-git
          // store is ACTUALLY named, so the joiner adopts it instead of deriving
          // its own and landing on a store nobody else is talking to.
          repoKey: canonicalRepoKey(m),
          // D-007: thread the verified owner binding so a direct-link joiner can
          // seed hive_directory_cache at join (re-verified channel-2 there). hivePubkey
          // is required (the joiner re-derives the topic from it; the link topic is a
          // one-way hash). The three channel-1 fields are all-or-nothing in
          // formatHarnessLink; `attestationGistId` is NOT (WI-38345) — an owner whose
          // gist create 422'd passes '' here and still publishes a usable binding.
          ...(owner && hivePubkey
            ? {
                hivePubkey,
                ownerDevicePubkey: owner.devicePubkey,
                ownerGithubUserId: owner.githubUserId,
                attestationGistId: owner.attestationGistId,
              }
            : {}),
        }),
      );
    }
  }

  // 4 — directory announce (the content authority, D-004).
  let announced = false;
  let reachablePeers = 0;
  let announceError: string | undefined;
  try {
    // D-007: reuse the up-front owner (resolved for the member-link binding); only
    // re-resolve if that failed, preserving the original announce behavior.
    const ownerForAnnounce = owner ?? (await resolveOwner());
    const res = await publishDirectory(
      getDirectory(),
      {
        ...meta,
        ...(hivePubkey ? { hivePubkey } : {}),
        ...(memberRepos.length ? { memberRepos } : {}),
        ...(memberLinks.length ? { memberLinks } : {}),
      },
      ownerForAnnounce,
    );
    announced = res.announced;
    reachablePeers = res.reachablePeers; // deceptive-publish: real swarm reach
  } catch (e) {
    announceError = e instanceof Error ? e.message : String(e);
  }

  // 5 — the Cupboard index (PUBLIC hives only; D-003 invite leak rule; the
  //     public registry refuses private repos).
  const cupboard: PublishCreatedHiveOutcome['cupboard'] = { attempted: false };
  if (meta.visibility !== 'public') {
    cupboard.skipped = 'invite';
  } else if (opts.repoIsPrivate) {
    cupboard.skipped = 'private_repo';
  } else if (!hivePubkey || !hiveTopicHex) {
    cupboard.skipped = 'no_hive_pubkey';
  } else {
    const withIds = members.filter(
      (m) =>
        typeof m.github_repository_id === 'number' &&
        (!opts.onlyRepoIds || opts.onlyRepoIds.includes(m.github_repository_id)),
    );
    if (withIds.length === 0) {
      cupboard.skipped = 'no_member_repo_ids';
    } else {
      cupboard.attempted = true;
      cupboard.rowsCreated = 0;
      cupboard.rowsExisted = 0;
      cupboard.rowsFailed = 0;
      cupboard.rowsClaimed = 0;
      cupboard.errors = [];
      const claimListing = deps.claimListing ?? defaultClaimListing;
      const publishListing =
        deps.publishListing ??
        (async (input: Record<string, unknown>) =>
          (await import('./cupboard/publish-listing')).publishListingToCupboard(
            input as never,
          ));
      for (const m of withIds) {
        const parsed = parseGithubUrl(m.github_remote!);
        if (!parsed) continue;
        const res = await publishListing({
          listing_kind: 'harness',
          github_repository_id: m.github_repository_id!,
          github_owner: parsed.owner,
          github_name: parsed.repo,
          github_url: parsed.cloneUrl,
          title: meta.title,
          description: meta.description,
          topic_hex: hiveTopicHex,
          hive_pubkey: hivePubkey,
          hive_title: meta.title,
        }).catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
        if (res.ok) {
          cupboard.rowsCreated! += 1;
          // D-002 auto-claim: the worker's own claim path verifies maintain/
          // admin. 403 insufficient_permission = the normal provisional
          // posture; 409 already_claimed = someone beat us — both silent.
          const listingId = (('data' in res ? res.data : undefined) as { id?: string | number } | undefined)?.id;
          if (listingId !== undefined && listingId !== null) {
            const claim = await claimListing(listingId).catch(() => ({ ok: false as const }));
            if (claim.ok) cupboard.rowsClaimed! += 1;
          }
        } else if (
          ('status' in res && (res.status === 409 || res.upstream_status === 409)) ||
          /exists|conflict/i.test(res.error ?? '')
        ) {
          cupboard.rowsExisted! += 1; // re-publish/flip over an existing row — fine
        } else {
          cupboard.rowsFailed! += 1;
          if (res.error) cupboard.errors!.push(`${parsed.owner}/${parsed.repo}: ${res.error}`);
        }
      }
      if (cupboard.errors!.length === 0) delete cupboard.errors;
    }
  }

  // 6 — local binding-cache rows (the first-hop lookup leg). Public + invite —
  //     a LOCAL row leaks nothing off-box.
  const localBindings = { created: 0, existed: 0, failed: 0 };
  if (hiveTopicHex) {
    const createLocalBinding =
      deps.createLocalBinding ??
      (async (input: {
        githubUrl: string;
        privacy: 'shared-private' | 'shared-public';
        harness_topic: string;
        harness_slug: string;
      }) => (await import('./harness/binding-service')).createUnclaimedBinding(input));
    for (const m of members) {
      if (typeof m.github_repository_id !== 'number' || !m.github_remote) continue;
      if (opts.onlyRepoIds && !opts.onlyRepoIds.includes(m.github_repository_id)) continue;
      try {
        await createLocalBinding({
          githubUrl: m.github_remote,
          privacy: meta.visibility === 'public' ? 'shared-public' : 'shared-private',
          harness_topic: hiveTopicHex,
          harness_slug: m.slug,
        });
        localBindings.created += 1;
      } catch (e) {
        if ((e as { code?: string }).code === 'BINDING_EXISTS') localBindings.existed += 1;
        else localBindings.failed += 1;
      }
    }
  }

  // 7 — EI-681: the "go shared" RE-KEY. The local member harnesses just got a
  //     binding (step 6) but their substrate was booted (if at all) before that
  //     binding existed — so it joined no Hive topic and started no outbox drain.
  //     Nothing else re-keys a runtime-shared harness (the substrate boots once
  //     at host-bootstrap; the join side re-keys via join-hive 2c, but the
  //     OWNER/publish side had no equivalent). Without this, an owner's published
  //     feature writes sit in `substrate_outbox` undrained and never federate out
  //     until a restart. `rekeyHarness` re-resolves the now-present binding and
  //     joins the Hive topic IN PLACE (not a reboot — a reboot breaks the owner's
  //     corestore serving of its own log core). Re-key EXACTLY the harnesses step
  //     6 just bound (same `members` set + `onlyRepoIds` filter). Best-effort +
  //     fire-and-forget: a failure (or sync throw) must NEVER fail or slow publish.
  if (hiveTopicHex) {
    const rekeyHarness =
      deps.rekeyHarness ??
      (async (ws: string, slug: string) =>
        (await import('./sync/hyperbee/boot-all')).rekeyHarness(ws, slug));
    // A-003 (a′): re-key the hive-HOME harness (`meta.potId`) onto the Hive topic
    // too, so its substrate joins the topic + drains its outbox → hive_members /
    // hive_settings federate to joiners. The hive-home is repo-less (not in
    // `members`), so the per-member re-key below skips it. Now SAFE on the shared
    // topic: dc9db's (a′) announce extension carries MULTIPLE log announces per
    // topic (member-log + hive-home-log), and the boot.ts onAnnounce slug-filter
    // scopes admission so the owner's hive-home never cross-merges a member-log. A
    // joiner's member harness admits the hive-home log (its `joinerPotHomeSlug`
    // rebind) + applies hive_members/hive_settings under the home slug. Re-key IN
    // PLACE with the same owner-safe `rekeyHarness` as the members (a full reboot
    // would break the owner's corestore replication-serving — EI-681). NOT
    // `onlyRepoIds`-gated: the hive itself re-keys on every (re)publish. Best-effort
    // + fire-and-forget, like the member loop.
    try {
      const ph = rekeyHarness(opts.workspaceId, meta.potId) as Promise<unknown> | undefined;
      if (ph && typeof ph.catch === 'function') ph.catch(() => {});
    } catch {
      /* a sync throw from the hive-home re-key must never fail or slow publish */
    }
    for (const m of members) {
      if (typeof m.github_repository_id !== 'number' || !m.github_remote) continue;
      if (opts.onlyRepoIds && !opts.onlyRepoIds.includes(m.github_repository_id)) continue;
      try {
        const p = rekeyHarness(opts.workspaceId, m.slug) as Promise<unknown> | undefined;
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch {
        /* a sync throw from a re-key must never fail the publish or skip peers */
      }
    }
  }

  return {
    announced,
    reachablePeers,
    cupboard,
    localBindings,
    ...(hivePubkey ? { hivePubkey } : {}),
    // WI-931: surface the join target the announce already carried, so the
    // from-repo `created` response yields memberLinks a joiner can pass to
    // join-hive (mirrors how `hivePubkey` already flows out here).
    ...(memberLinks.length ? { memberLinks } : {}),
    ...(announceError ? { error: announceError } : {}),
  };
}
