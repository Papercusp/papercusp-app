/**
 * POST /api/harness/join-link — Entry 4 harness-link join (P-009).
 *
 * Body: {
 *   slug: string,              // desired harness slug
 *   harnessLinkUrl: string,    // papercusp://harness?topic=...&github=...&repo_id=...
 *   existingGistId?: string,   // optional: re-use a pre-existing attestation gist
 * }
 *
 * The joiner's GitHub identity (token, githubUserId, githubLogin) is resolved
 * SERVER-SIDE from the local `gh` CLI auth (D-004). The client no longer needs
 * to supply these. If the local `gh` auth is missing the endpoint returns 401
 * with `{ code: 'gh_auth_required' }`.
 *
 * The device keychain id is DERIVED server-side from the verified
 * `githubUserId` via `resolveDeviceKeychainId` (`<github_user_id>:<machine-
 * fingerprint>`) — the SAME canonical id the swarm announce resolves, so the
 * contributor file signed here verifies against the announced device_pubkey.
 * It is NOT taken from the request body.
 *
 * Response: { ok: true, state: JoinState } on success.
 * Errors: 400 for bad input, 401 for missing gh auth, 409 for slug conflict,
 *         502 for join failure.
 *
 * Steps 3/4/5/8 (Hyperswarm/Hyperbee) produce phase_0_pending status but
 * don't fail the request — the client can inspect `state.steps` for detail.
 */

import { defineTool } from '@papercusp/agent-mcp';
import { loadHarnessRegistry, mutateHarnessRegistry, upsertLinkJoinedEntry } from '../../../harness-registry';
import type { ProjectEntry } from '../../../harness-registry';
import { scaffoldHarnessSchema } from '../../../scaffold-harness-schema';
import { parseHarnessLink } from '../../../harness/url-scheme';
import { joinSharedHarness, JoinStepError } from '../../../harness/join-shared-harness';
import {
  seedGitSyncRoutineForMember,
  type SeedGitSyncRoutineOpts,
  type SeedGitSyncRoutineOutcome,
} from '../../../harness/git-sync/git-sync-routine';
import { activeWorkspaceId } from '../../../workspace-registry';
import { resolveDeviceKeychainId } from '../../../identity/device-keychain-id';
import {
  resolveLocalGithubIdentity,
  type LocalGithubIdentity,
  type ResolveLocalGithubIdentityOpts,
} from '../../../identity/resolve-local-github-identity';
import type { HarnessLink } from '../../../harness/url-scheme';
import type { JoinState } from '../../../harness/join-shared-harness';
import type { UpsertRemoteHiveIdentityInput } from '../../../hive-store';

// ─── injectable deps ──────────────────────────────────────────────────────────

export interface JoinLinkDeps {
  resolveIdentity: (opts?: ResolveLocalGithubIdentityOpts) => Promise<LocalGithubIdentity>;
  loadRegistry: typeof loadHarnessRegistry;
  /** EI-82 hardening (2026-07-03): registration is an ATOMIC upsert-or-enrich —
   *  never a load→push→save whole-payload overwrite (which silently clobbered /
   *  was clobbered by any concurrent registry writer). */
  mutateRegistry: typeof mutateHarnessRegistry;
  joinHarness: (opts: Parameters<typeof joinSharedHarness>[0]) => Promise<JoinState>;
  scaffold: (slug: string) => Promise<void>;
  /** EI-382: seed the joined clone's git-sync routine (best-effort). */
  seedGitSync: (opts: SeedGitSyncRoutineOpts) => Promise<SeedGitSyncRoutineOutcome>;
  /** Active workspace id for the seed (injectable for hermetic tests). */
  resolveWorkspaceId: () => string;
  /** D-007 (from-repo-seed receive-side fix): seed hive_directory_cache with the
   *  VERIFIED owner binding a hive MEMBER link carries, so the joiner's owner-log
   *  bootstrap-admit fires at boot WITHOUT catching the live announce beacon (the
   *  run-20 "0 announce → empty roster → drop all owner content" receive failure).
   *  Channel-2 re-verifies the device against the attestation gist BEFORE seeding —
   *  the link is transport, not the trust anchor. Best-effort: a failure NEVER fails
   *  the join (the beacon path still backfills). Injectable for hermetic tests. */
  seedOwnerBinding: (input: SeedOwnerBindingInput) => Promise<SeedOwnerBindingOutcome>;
  /** WI-10003134: materialize the joined Pot's identity row (the OWNER's Hive
   *  pubkey under a remote:* keychain id) — the FK parent every inbound
   *  pot_members op needs. Same writer join-hive's step 2b uses. */
  upsertHiveIdentity: (input: UpsertRemoteHiveIdentityInput) => Promise<void>;
}

/** D-007 input for the verified owner-binding seed (all fields from the member link). */
export interface SeedOwnerBindingInput {
  workspaceId: string;
  /** base64 raw-32 Ed25519 hive pubkey — the hive_directory_cache key. */
  hivePubkey: string;
  /** base64 owner device pubkey to channel-2 verify + bind. */
  ownerDevicePubkey: string;
  /** owner numeric GitHub user id (channel-2 verify target). */
  ownerGithubUserId: number;
  /** owner GitHub login (for the DiscoveredHive entry). */
  ownerGithubLogin: string;
  /** owner device-attestation gist id (channel-2 anchor). */
  attestationGistId: string;
  /** the hive federation topic (hex) for the synthetic DiscoveredHive's memberTopics. */
  topic: string;
  /** best-effort hive id for the cache entry (consumer keys on hivePubkey, not this). */
  potId: string;
}

export interface SeedOwnerBindingOutcome {
  /** true when a NEW verified binding was written (false = unverified, or already present). */
  seeded: boolean;
  reason?: string;
}

/**
 * D-007 default seed: channel-2 re-verify the owner device against its
 * attestation gist, then ADD-IF-ABSENT a synthetic DiscoveredHive carrying the
 * verified (hivePubkey → ownerDevicePubkey) binding into hive_directory_cache.
 * Add-if-absent (keyed on hivePubkey) so a later, richer beacon-sourced entry is
 * never clobbered. Dynamic imports keep the route module light + avoid PG/identity
 * pulled into its static graph. Never throws — returns {seeded:false} on any issue.
 */
async function defaultSeedOwnerBinding(
  input: SeedOwnerBindingInput,
): Promise<SeedOwnerBindingOutcome> {
  try {
    const { verifyAttestation } = await import('../../../identity/attest');
    const res = await verifyAttestation(
      input.attestationGistId,
      input.ownerDevicePubkey,
      input.ownerGithubUserId,
    ).catch(() => null);
    if (!res || !res.valid) return { seeded: false, reason: 'attestation_unverified' };

    const { updateOperatorState } = await import('../../../operator-state-pg');
    type DiscoveredHive = import('../../../hive-directory').DiscoveredHive;
    const now = Date.now();
    let didSeed = false;
    await updateOperatorState<{ hives: DiscoveredHive[] }>(
      'pot_directory_cache',
      { hives: [] },
      (cur) => {
        const hives = Array.isArray(cur?.hives) ? cur.hives : [];
        // Add-if-absent by hivePubkey — never clobber a richer beacon entry.
        if (hives.some((h) => h && h.hivePubkey === input.hivePubkey)) return { hives };
        didSeed = true;
        const entry: DiscoveredHive = {
          potId: input.potId,
          // WI-559: this potId is a DERIVED GUESS (`${repoName}-pot`), not an
          // owner-authored slug — there is no announce here to take one from. Mark it so
          // identity consumers (loadAnnouncedHiveHomeSlug → the federation demux key)
          // skip it; display/keying consumers are unaffected.
          potIdSynthetic: true,
          title: '',
          description: '',
          ownerGithubLogin: input.ownerGithubLogin,
          ownerGithubUserId: input.ownerGithubUserId,
          ownerDevicePubkey: input.ownerDevicePubkey,
          hivePubkey: input.hivePubkey,
          memberTopics: [input.topic],
          visibility: 'public',
          createdAt: now,
          announcedTs: now,
          lastSeenMs: now,
          attested: true,
        };
        return { hives: [...hives, entry] };
      },
      input.workspaceId,
    );
    return { seeded: didSeed };
  } catch (e) {
    return { seeded: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export const realJoinLinkDeps: JoinLinkDeps = {
  resolveIdentity: resolveLocalGithubIdentity,
  loadRegistry: loadHarnessRegistry,
  mutateRegistry: mutateHarnessRegistry,
  joinHarness: joinSharedHarness,
  scaffold: scaffoldHarnessSchema,
  seedGitSync: (opts) => seedGitSyncRoutineForMember(opts),
  resolveWorkspaceId: activeWorkspaceId,
  seedOwnerBinding: defaultSeedOwnerBinding,
  upsertHiveIdentity: async (input) => {
    const { upsertRemoteHiveIdentity } = await import('../../../hive-store');
    await upsertRemoteHiveIdentity(input);
  },
};

// ─── core handler (injectable, exported for tests) ────────────────────────────

export interface JoinLinkInput {
  slug: string;
  link: HarnessLink;
  existingGistId?: string;
  /** WI-10003237: the CALLER materializes the joined Pot's identity row itself,
   *  under the Pot's own slug, so skip the WI-10003134 upsert below. join-hive
   *  sets this: it calls handleJoinLink once per MEMBER harness, where `slug` is
   *  the member's slug (`hello-world`), not the Pot's (`hello-world-pot`), yet a
   *  member link still carries the POT's hivePubkey. Upserting it here claimed the
   *  Pot pubkey (UNIQUE pots_public_key_key) under the member slug; join-hive's
   *  step 2b then collided writing the correct row, no pots row existed at the Pot
   *  slug, and every federated pot_members apply failed pot_members_pot_fkey
   *  (live-fed cert 20260926-071526: the joiner never converged). */
  callerOwnsPotIdentity?: boolean;
}

export async function handleJoinLink(
  input: JoinLinkInput,
  deps: JoinLinkDeps = realJoinLinkDeps,
): Promise<Response> {
  const { slug, link, existingGistId, callerOwnsPotIdentity } = input;

  // Resolve GitHub identity server-side.
  const id = await deps.resolveIdentity();
  if (id.kind === 'gh_auth_required') {
    return Response.json(
      { error: 'GitHub authentication required', code: 'gh_auth_required' },
      { status: 401 },
    );
  }

  const keychainId = resolveDeviceKeychainId(id.githubUserId);

  // Slug uniqueness check.
  const reg = await deps.loadRegistry();
  if (reg.projects.some((p) => p.slug === slug)) {
    return Response.json({ error: 'slug already exists', code: 'slug_conflict' }, { status: 409 });
  }

  // Run the join orchestrator.
  let state: JoinState;
  try {
    state = await deps.joinHarness({
      link,
      slug,
      token: id.token,
      githubUserId: id.githubUserId,
      githubLogin: id.githubLogin,
      keychainId,
      existingGistId,
    });
  } catch (e: unknown) {
    if (e instanceof JoinStepError) {
      return Response.json(
        {
          error: e.message,
          code: e.code,
          stepId: e.stepId,
          state: undefined,
        },
        { status: 502 },
      );
    }
    throw e;
  }

  // Register the harness in the workspace registry — an ATOMIC upsert-or-enrich
  // (EI-82 hardening, 2026-07-03, WI-971 adjacent). The join orchestrator's
  // boot_federate step already registers the clone pre-boot (the substrate boot
  // resolves the harness path through the registry), historically as a MINIMAL
  // { slug, path } row — which made this block's EI-1623 self-describing
  // enrichment DEAD CODE (the slug-present check skipped it) and left the clone
  // invisible to the hive_slug/joined_via_link-keyed git-sync reconcile. The
  // old shape here was also a racy load→push→save whole-payload overwrite that
  // could silently clobber (or be clobbered by) any concurrent registry writer
  // — the suspected mechanism behind a joined-hive row that federated for hours
  // then vanished at restart (mac-VM P-003 repro, 2026-07-03). Now: absent →
  // insert the full self-describing row; present-but-minimal → fill ONLY the
  // missing coord fields in place; already-enriched → no-op. The shape itself
  // (incl. the WI-3891 hive stamp) lives in upsertLinkJoinedEntry, shared with
  // the orchestrator's pre-boot write and the boot heal (WI-10003277).
  if (state.cloneDir) {
    const cloneDir = state.cloneDir;
    await deps.mutateRegistry((reg) =>
      upsertLinkJoinedEntry(reg, { slug, path: cloneDir, github: link.github, repoId: link.repoId }),
    );

    // WI-10003134: materialize the joined Pot's identity row, exactly as
    // join-hive's step 2b does. `pot_members_pot_fkey` needs it as the FK parent
    // for every inbound roster op; without it the fold aborts at the first
    // hive-members op and the joiner never converges (P-007 W2, 2026-09-25: frozen
    // at 251019/251057 until the row existed, converged 3 s after it did), and
    // reconcilePotCanonicalSlug declines with no_identity_row. Only a member link
    // carries the Hive pubkey; a bare link cannot know it here. keychain_id is a
    // NON-SIGNING remote:* placeholder — a joiner never signs for a Pot it does
    // not own. Best-effort: a failure NEVER fails the join.
    // A DIRECT join-link call joins the Pot's own self-repo, so `slug` IS the
    // Pot's slug. join-hive's per-member calls set callerOwnsPotIdentity instead:
    // there `slug` is a MEMBER slug and join-hive writes the row under the Pot's
    // slug itself (step 2b) — WI-10003237.
    if (link.hivePubkey && !callerOwnsPotIdentity) {
      try {
        await deps.upsertHiveIdentity({
          workspaceId: deps.resolveWorkspaceId(),
          homeSlug: slug,
          pubkeyBase64: link.hivePubkey,
          keychainId: `remote:${link.repoName}-pot`,
        });
      } catch {
        // Non-fatal — the fold retries each pass, so a later write still unwedges it.
      }
    }

    // Scaffold the harness schema (best-effort — don't fail the join if this fails).
    try {
      await deps.scaffold(slug);
    } catch {
      // Non-fatal — harness is still usable without schema.
    }

    // EI-382: seed the joined clone's git-sync routine. A bare-link join
    // registers a minimal { slug, path } entry with no `hive_slug`, so neither
    // joinHiveAsView's per-member loop (the only OTHER join-side seeder) nor the
    // `hive_slug`-filtered boot reconcile would ever seed it — the clone would
    // silently never sync, contradicting the "git-sync owns the tree" contract.
    // Joiner-side ⇒ push:false (D-002: a local commit+fetch+merge mirror; the
    // owner's pushes / a fork-PR is the contribution path), active per D-008,
    // and the cron jitter key is salted per-install (D-004) because the same
    // shared repo may be joined under the same slug on N peer boxes. Best-effort
    // exactly like joinHiveAsView: a seed failure NEVER fails the join (the
    // routine can be backfilled later).
    try {
      const workspaceId = deps.resolveWorkspaceId();
      const entry: ProjectEntry = {
        slug,
        path: state.cloneDir,
        github_remote: `https://github.com/${link.github}`,
        github_repository_id: link.repoId,
      };
      await deps.seedGitSync({
        workspaceId,
        installSlug: slug,
        entry,
        joinerSide: true,
        cronKey: `${slug}:${workspaceId}`,
      });
    } catch {
      // Non-fatal — the boot reconcile / a manual seed can backfill later.
    }

    // D-007 (from-repo-seed receive-side fix): if this is a hive MEMBER link
    // carrying the owner binding, seed hive_directory_cache with the VERIFIED
    // (hivePubkey → ownerDevicePubkey) so the owner-log bootstrap-admit fires at
    // boot without waiting to catch the live announce beacon — closing the run-20
    // "0 announce → empty roster → drop all owner content" receive failure. The
    // seed channel-2 re-verifies the device; best-effort, NEVER fails the join.
    if (
      link.hivePubkey &&
      link.ownerDevicePubkey &&
      typeof link.ownerGithubUserId === 'number' &&
      link.attestationGistId
    ) {
      try {
        await deps.seedOwnerBinding({
          workspaceId: deps.resolveWorkspaceId(),
          hivePubkey: link.hivePubkey,
          ownerDevicePubkey: link.ownerDevicePubkey,
          ownerGithubUserId: link.ownerGithubUserId,
          ownerGithubLogin: link.repoOwner,
          attestationGistId: link.attestationGistId,
          topic: link.topic,
          // cup-lexicon-full-rename-2026-07-09: pot slugs are suffixed `-pot`
          // (createPotFromRepo's deriveSlugs), matching what a real owner
          // announce stamps as `hive_id` (HiveDirectory.announceLocalHive
          // sends `hive_id: desc.potId`). A stale `-hive` suffix here doesn't
          // match, so the synthetic seed keeps HiveDirectory.discovered keyed
          // on the wrong potId (its `discovered.set(h.potId, h)` keys on this
          // literal string) — the later real beacon then lands as a SEPARATE,
          // duplicate entry instead of merging, visible in the federation UI
          // panels (PotFederationStatus / WorkbenchPotDirectoryPanel, both
          // keyed/displayed by `h.potId`). Doesn't affect bootstrap-admit
          // itself (loadHiveOwnerDeviceBindings matches on hivePubkey only).
          potId: `${link.repoName}-pot`,
        });
      } catch {
        // Non-fatal — the announce-beacon ingest can still seed it later.
      }
    }
  }

  return Response.json({ ok: true, state });
}

// ─── defineTool handler (wires real deps + parses request) ────────────────────

const joinLink = defineTool({
  method: 'POST',
  path: '/harness/join-link',
  auth: 'loopback',
  // A real join runs gist publish + git clone + substrate boot + DHT announce —
  // routinely >30s (the default route timeout 408'd every real join; the
  // orchestrator kept going server-side and the client saw a spurious failure).
  timeoutSec: 300,
  async handler(req) {
    const body = (await req.json()) as Record<string, unknown>;

    const slug = String(body.slug ?? '').trim();
    if (!slug) return Response.json({ error: 'slug required' }, { status: 400 });

    const harnessLinkUrl = String(body.harnessLinkUrl ?? '').trim();
    const link = parseHarnessLink(harnessLinkUrl);
    if (!link) {
      return Response.json(
        { error: 'invalid harness link URL', code: 'invalid_link' },
        { status: 400 },
      );
    }

    const existingGistId =
      typeof body.existingGistId === 'string' ? body.existingGistId.trim() || undefined : undefined;

    return handleJoinLink({ slug, link, existingGistId }, realJoinLinkDeps);
  },
});

export default joinLink;
