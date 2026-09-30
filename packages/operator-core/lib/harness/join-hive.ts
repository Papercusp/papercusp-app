/**
 * join-hive — "Join the HIVE", not N harnesses
 * (hive-from-repo-hardening-2026-06-11 P-007 / D-007: joiner symmetry).
 *
 * Before this, joining a discovered hive ran the per-member-link join N times
 * and left the joiner with N loose harnesses — federation worked, but the hive
 * was a first-class entity ONLY on the creator's side (no grouping, no rail,
 * no strip). This composes:
 *
 *   1. the EXISTING per-link join (handleJoinLink — attestation, read-only
 *      clone, gist binding, federation boot, admission) for every member link;
 *   2. a LOCAL registry VIEW: a `kind:'hive'` entry flagged `remote_hive`
 *      (empty state dir under ~/.papercusp/remote-hives — no identity mint, no
 *      owned meta, never announces) + `hive_slug` stamped on each joined
 *      member, plus the member's upstream coords parsed from its join link —
 *      so the Harnesses tab's grouping/rail/strip work for the joiner, and the
 *      fork-PR context chain (P-013 of the parent plan) has registry coords;
 *   3. best-effort `system:git-sync` SEEDING for every joined member clone
 *      (git-sync-any-hive-2026-06-12 P-003): inactive + push:false joiner rows
 *      via B-01's seedGitSyncRoutineForMember — without this, shared hives only
 *      sync on the creator's machine. Never fails the join.
 *
 * Deliberately the SMALLEST model that fixes the asymmetry (D-007): a fuller
 * co-owned hive (shared identity, multi-writer listing) is out of scope.
 * Idempotent: re-joining updates the view + skips already-registered members.
 */

import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join as joinPath } from 'node:path';

import {
  loadHarnessRegistry,
  mutateHarnessRegistry,
  type HarnessRegistry,
  type ProjectEntry,
} from '../harness-registry';
import { parseHarnessLink, type HarnessLink } from './url-scheme';
import {
  handleJoinLink,
  realJoinLinkDeps,
  type JoinLinkDeps,
} from '../endpoint-route/routes/harness/join-link';
import {
  seedGitSyncRoutineForMember,
  type SeedGitSyncRoutineOpts,
  type SeedGitSyncRoutineOutcome,
} from './git-sync/git-sync-routine';
import { deleteHive, getHiveByPubkey, upsertRemoteHiveIdentity } from '../hive-store';
import { adoptRepoKey } from '../sync/pot-git/repo-identity';
import { hiveKeychainId } from '../identity/hive-keypair';

// ── Shapes ─────────────────────────────────────────────────────────────────────

export interface JoinHiveOpts {
  /** The discovered hive's id (becomes the local view slug, collision-suffixed). */
  potId: string;
  /** Display title (defaults to potId). */
  title?: string;
  /** Owner Hive identity pubkey from the discovery listing/invite. */
  hivePubkey?: string;
  /** Owner DEVICE pubkey from the verified discovery listing/announce — stamped
   *  on the registry view so the substrate owner-bootstrap admit resolves the
   *  (hivePubkey → ownerDevicePubkey) binding without directory timing luck. */
  ownerDevicePubkey?: string;
  /** The announce's full per-member join links. */
  memberLinks: string[];
  workspaceId: string;
}

export interface JoinedMember {
  slug: string;
  link: string;
  ok: boolean;
  /** 'joined' | 'already_registered' | the failure detail. Successful joins
   *  additionally carry the git-sync seed outcome appended as
   *  `; git_sync:<seeded|ineligible|routine_exists|error>` (B-03 P-003). */
  detail: string;
}

export interface JoinHiveResult {
  ok: boolean;
  /** The local view's slug (may be suffixed on collision). */
  potSlug?: string;
  members: JoinedMember[];
  error?: string;
  /** The join was a NO-OP because the discovered hive IS a locally-owned hive
   *  (the directory self-echo guard); potSlug is the LOCAL owned slug. */
  self_hive?: true;
}

export interface JoinHiveDeps {
  /** The per-link join (default: the real route core + its real deps). */
  joinLink?: (input: {
    slug: string;
    link: HarnessLink;
    /** WI-10003237: always true from step 1 — join-hive owns the Pot identity row. */
    callerOwnsPotIdentity?: boolean;
  }) => Promise<{ ok: boolean; detail: string }>;
  loadRegistry?: typeof loadHarnessRegistry;
  mutateRegistry?: typeof mutateHarnessRegistry;
  /** mkdir -p for the view's empty state dir. */
  ensureDir?: (path: string) => Promise<void>;
  /** Root for remote-hive view dirs (default ~/.papercusp/remote-hives). */
  remoteHivesRoot?: string;
  /** Best-effort per-member git-sync routine seeding (git-sync-any-hive P-003;
   *  default B-01's seedGitSyncRoutineForMember). NEVER fails the join — every
   *  outcome folds into the member's `detail`. */
  seedGitSync?: (opts: SeedGitSyncRoutineOpts) => Promise<SeedGitSyncRoutineOutcome>;
  /** Resolve the discovered Hive's raw-32 base64 Ed25519 pubkey (default: the
   *  directory's listDiscoveredHives). EI-681: the joiner needs the OWNER's HIVE
   *  pubkey to re-key its joined harnesses onto the SAME federation topic the
   *  owner uses — a member-link carries only the topic HASH, not the pubkey. */
  resolveHivePubkey?: (workspaceId: string, potId: string) => Promise<string | null>;
  /** Get-or-create the remote Hive's identity row (default: insertHiveIfAbsent).
   *  Best-effort — a missing pubkey or a write failure NEVER fails the join. */
  upsertHiveIdentity?: (input: {
    workspaceId: string;
    homeSlug: string;
    pubkeyBase64: string;
    keychainId: string;
  }) => Promise<unknown>;
  /** Find the Pot identity row already holding `pubkeyBase64` in this workspace
   *  (default: hive-store getHiveByPubkey). Diagnostic only — read when
   *  upsertHiveIdentity FAILS, to name the row that won the pubkey (WI-10003237). */
  findHiveByPubkey?: (
    workspaceId: string,
    pubkeyBase64: string,
  ) => Promise<{ homeSlug: string; canonicalHomeSlug: string; keychainId: string } | null>;
  /** Delete one Pot identity row (default: hive-store deleteHive). Used ONLY by
   *  step 2b's WI-10003237 heal, to remove a Pot identity misfiled under one of
   *  THIS join's member slugs by a pre-fix join-link. */
  deleteHive?: (workspaceId: string, homeSlug: string) => Promise<boolean>;
  /** Re-key a joined member's substrate IN PLACE so it re-resolves its swarm
   *  binding (default: boot-all's rekeyHarness, lazily imported). EI-681 step 2c
   *  — the per-member joins booted each substrate on the gh:<repo_id> topic
   *  BEFORE the Hive identity/hive_slug existed; re-keying after materialization
   *  moves them onto the OWNER's Hive-pubkey topic WITHOUT a reboot (a reboot
   *  breaks the owner's corestore serving of its own log). Never fails the join. */
  rekeyHarness?: (workspaceId: string, harnessSlug: string) => Promise<unknown>;
  /** Resolve a LOCALLY-OWNED hive's identity record for the self-echo guard
   *  (default: hive-store's getHiveBySlug). Only pubkeyBase64 is read. */
  getLocalHive?: (
    workspaceId: string,
    homeSlug: string,
  ) => Promise<{ pubkeyBase64: string } | null>;
  /** Resolve the discovered Hive's OWNER device pubkey (default: the local
   *  verified directory's listing — same source as resolveHivePubkey). */
  resolveOwnerDevicePubkey?: (workspaceId: string, potId: string) => Promise<string | null>;
}

/** Resolve a discovered Hive's HIVE-identity pubkey from the local directory's
 *  discovered set (the announce carries it; the member-link only carries the
 *  topic hash). Returns null when absent — the caller skips the identity write. */
async function defaultResolveHivePubkey(
  _workspaceId: string,
  potId: string,
): Promise<string | null> {
  try {
    const { getHiveDirectory } = await import('../hive-directory-deps');
    const hives = await getHiveDirectory().listDiscoveredHives({ includeExpired: true });
    return hives.find((h) => h.potId === potId)?.hivePubkey ?? null;
  } catch {
    return null;
  }
}

/** The discovered Hive's OWNER device pubkey from the same verified directory
 *  listing defaultResolveHivePubkey reads (every descriptor there passed
 *  verifyHiveAnnounce, which binds owner_device_pubkey ↔ hive_pubkey). */
async function defaultResolveOwnerDevicePubkey(
  _workspaceId: string,
  potId: string,
): Promise<string | null> {
  try {
    const { getHiveDirectory } = await import('../hive-directory-deps');
    const hives = await getHiveDirectory().listDiscoveredHives({ includeExpired: true });
    const h = hives.find((x) => x.potId === potId) as { ownerDevicePubkey?: string } | undefined;
    return h?.ownerDevicePubkey ?? null;
  } catch {
    return null;
  }
}

async function defaultJoinLink(input: {
  slug: string;
  link: HarnessLink;
  callerOwnsPotIdentity?: boolean;
}): Promise<{ ok: boolean; detail: string }> {
  const res = await handleJoinLink(
    { slug: input.slug, link: input.link, callerOwnsPotIdentity: input.callerOwnsPotIdentity },
    realJoinLinkDeps as JoinLinkDeps,
  );
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (res.ok && body.ok) return { ok: true, detail: 'joined' };
  return { ok: false, detail: body.error ?? `HTTP ${res.status}` };
}

/** kebab slug from a repo name (matches the create path's derivation). */
function kebab(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/--+/g, '-');
}

function freeSlug(base: string, taken: ReadonlySet<string>): string | null {
  for (let i = 0; i < 9; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    if (!taken.has(candidate)) return candidate;
  }
  return null;
}

// ── The composition ────────────────────────────────────────────────────────────

export async function joinHiveAsView(
  opts: JoinHiveOpts,
  deps: JoinHiveDeps = {},
): Promise<JoinHiveResult> {
  const joinLink = deps.joinLink ?? defaultJoinLink;
  const loadRegistry = deps.loadRegistry ?? loadHarnessRegistry;
  const mutateRegistry = deps.mutateRegistry ?? mutateHarnessRegistry;
  const ensureDir = deps.ensureDir ?? (async (p: string) => void (await mkdir(p, { recursive: true })));
  const remoteHivesRoot =
    deps.remoteHivesRoot ?? joinPath(homedir(), '.papercusp', 'remote-hives');

  const links = opts.memberLinks.map((raw) => ({ raw, parsed: parseHarnessLink(raw) }));
  if (links.length === 0 || links.some((l) => !l.parsed)) {
    return { ok: false, members: [], error: 'invalid_member_links' };
  }

  const reg = await loadRegistry(opts.workspaceId);

  // ── Self-echo guard (2026-07-01 live Brief-3 owner split-brain) ──────────────
  // The hive directory re-announces hives THIS box owns (its own published
  // beacon), so a fresh owner re-discovers its own hive minutes after creating
  // it and — without this guard — joins it as a REMOTE view: the local slug is
  // taken, freeSlug suffixes a phantom `<hive>-2` view, and the member-stamping
  // below REBINDS the owner's own member harnesses' hive_slug onto the phantom
  // (their repos count as `already_registered` joins). Roster/content ops then
  // split across two home bindings and owner→joiner federation silently breaks
  // (observed live: deb-hetzner-revocation baseline INCOMPLETE ×2). Identity is
  // the HIVE PUBKEY when resolvable (hive ids are display names — two distinct
  // hives may legitimately share one); slug equality is only the no-pubkey
  // fallback for a locally-OWNED hive entry.
  const resolveHivePubkey = deps.resolveHivePubkey ?? defaultResolveHivePubkey;
  const getLocalHive =
    deps.getLocalHive ??
    (async (ws: string, slug: string) => (await import('../hive-store')).getHiveBySlug(ws, slug));
  const resolveOwnerDevicePubkey = deps.resolveOwnerDevicePubkey ?? defaultResolveOwnerDevicePubkey;
  const announcedPubkey =
    (typeof opts.hivePubkey === 'string' && opts.hivePubkey.trim()
      ? opts.hivePubkey.trim()
      : null) ??
    // D-007: the member links carry the hive pubkey too — deterministic at join.
    links.map((l) => l.parsed?.hivePubkey).find((v) => !!v) ??
    (await resolveHivePubkey(opts.workspaceId, opts.potId).catch(() => null));
  const localOwnedHives = reg.projects.filter(
    (p) => p.harness_kind === 'hive' && p.remote_hive !== true,
  );
  if (localOwnedHives.length > 0) {
    for (const local of localOwnedHives) {
      if (announcedPubkey) {
        const rec = await getLocalHive(opts.workspaceId, local.slug).catch(() => null);
        if (rec?.pubkeyBase64 === announcedPubkey) {
          return { ok: true, potSlug: local.slug, members: [], self_hive: true };
        }
      } else if (local.slug === opts.potId) {
        return { ok: true, potSlug: local.slug, members: [], self_hive: true };
      }
    }
  }

  // The view slug: reuse an EXISTING remote view for this hive (idempotent
  // re-join); otherwise pick a free slug (a LOCAL harness owning the name is
  // never clobbered — suffix instead).
  const existingView = reg.projects.find(
    (p) => p.remote_hive === true && (p.slug === opts.potId || p.slug.startsWith(`${opts.potId}-`)),
  );
  const taken = new Set(reg.projects.map((p) => p.slug));
  const potSlug = existingView?.slug ?? freeSlug(kebab(opts.potId) || 'remote-hive', taken);
  if (!potSlug) {
    return { ok: false, members: [], error: 'view_slug_exhausted' };
  }

  // 1 — per-member joins (the existing path, unchanged mechanics). A member
  //     whose repo is already registered locally is skipped, not re-joined.
  const members: JoinedMember[] = [];
  const memberTaken = new Set(taken);
  for (const { raw, parsed } of links) {
    const link = parsed!;
    const already = reg.projects.find(
      (p) => typeof p.github_repository_id === 'number' && p.github_repository_id === link.repoId,
    );
    if (already) {
      members.push({ slug: already.slug, link: raw, ok: true, detail: 'already_registered' });
      continue;
    }
    const slug = freeSlug(kebab(link.repoName) || 'member', memberTaken);
    if (!slug) {
      members.push({ slug: '', link: raw, ok: false, detail: 'member_slug_exhausted' });
      continue;
    }
    memberTaken.add(slug);
    // WI-10003237: `slug` is a MEMBER slug — step 2b owns the Pot identity row
    // under the Pot's slug, so the per-link join must not write it here.
    const res = await joinLink({ slug, link, callerOwnsPotIdentity: true }).catch((e) => ({
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
    }));
    members.push({ slug, link: raw, ok: res.ok, detail: res.detail });
  }

  const joinedAny = members.some((m) => m.ok);
  if (!joinedAny) {
    return { ok: false, members, error: 'no_member_joined' };
  }

  // 2 — materialize the registry VIEW: the remote home + hive_slug + upstream
  //     coords on every successfully-joined member (one atomic mutate).
  const viewPath = joinPath(remoteHivesRoot, potSlug);
  await ensureDir(viewPath).catch(() => {});
  const linkBySlug = new Map(
    members.filter((m) => m.ok).map((m) => [m.slug, links.find((l) => l.raw === m.link)?.parsed]),
  );
  // Verified hive identity coords for the view (Brief-3 live finding, 2026-07-01):
  // stamp (hive_pubkey, owner_device_pubkey) on the registry view so the substrate's
  // owner-bootstrap admit resolves the binding from the REGISTRY (works in every
  // process) instead of waiting on the joiner's directory instance to (re-)hear the
  // owner's announce — the multi-minute race that live-blocked owner→joiner
  // federation. Both values trace to verifyHiveAnnounce-gated sources: the caller's
  // announce/listing, or the local verified directory. A wholly absent identity
  // remains best-effort, but a hive_pubkey without its owner binding is a degraded
  // join: reporting it as success would leave the substrate with a partial trust
  // anchor and the canonical bootstrap would never retry the repair.
  const ownerDevicePubkey =
    (typeof opts.ownerDevicePubkey === 'string' && opts.ownerDevicePubkey.trim()
      ? opts.ownerDevicePubkey.trim()
      : null) ??
    // The member links THEMSELVES carry the verified owner binding (D-007:
    // formatHarnessLink emits hivePubkey+ownerDevicePubkey together) — the
    // DETERMINISTIC source present at every real join, no directory timing.
    links.map((l) => l.parsed?.ownerDevicePubkey).find((v) => !!v) ??
    (await resolveOwnerDevicePubkey(opts.workspaceId, opts.potId).catch(() => null));
  const viewIdentityCoords = {
    ...(announcedPubkey ? { hive_pubkey: announcedPubkey } : {}),
    ...(ownerDevicePubkey ? { owner_device_pubkey: ownerDevicePubkey } : {}),
  };
  const viewHasHivePubkey = Boolean(announcedPubkey || existingView?.hive_pubkey);
  const viewHasOwnerDevicePubkey = Boolean(ownerDevicePubkey || existingView?.owner_device_pubkey);
  const partialIdentityStamp = viewHasHivePubkey && !viewHasOwnerDevicePubkey;

  // Post-mutate member entries (hive_slug + upstream coords stamped) — the
  // git-sync seeding below feeds these to the eligibility/seed composition.
  const memberEntries = new Map<string, ProjectEntry>();
  await mutateRegistry((cur: HarnessRegistry) => {
    const hasView = cur.projects.some((p) => p.slug === potSlug);
    const projects = cur.projects.map((p) => {
      if (p.slug === potSlug && p.remote_hive === true) {
        // Idempotent re-join BACKFILLS the identity coords onto an existing view
        // (views created before this stamping existed lack them).
        return { ...p, ...viewIdentityCoords };
      }
      const link = linkBySlug.get(p.slug);
      if (!link) return p;
      const next = {
        ...p,
        hive_slug: potSlug,
        // Upstream coords from the join link (the fork-PR context + future
        // member_repos derivation read these — P-002/P-013 of the parent plan).
        ...(p.github_remote
          ? {}
          : { github_remote: `https://github.com/${link.repoOwner}/${link.repoName}.git` }),
        ...(typeof p.github_repository_id === 'number'
          ? {}
          : { github_repository_id: link.repoId }),
      };
      // EI-18788176839043286: settle the pot-git repoKey now that this member's
      // upstream coords are known. The key names both the bare store on disk and
      // the repo on the wire, so it must never drift afterwards.
      //
      // A3 — ADOPT, don't derive. `link.repoKey` is the key the OWNER's store is
      // actually named; taking it verbatim is the only thing that makes the two
      // devices agree rather than agree by luck. Deriving locally is right only
      // when this device happens to hold the same upstream coords the owner did —
      // precisely the assumption that fails for a pot created local-first and
      // published to GitHub later, where the creator sits on the bare slug and
      // every joiner derives `gh-<id>`. Falls back to `adoptRepoKey`'s local rungs
      // when the owner's build predates A3 (no `repo_key` on the link).
      const adopted = adoptRepoKey(next, link.repoKey);
      next.pot_repo_key = adopted.key;
      next.pot_repo_key_source = adopted.source;
      if (adopted.rekeyedFrom) {
        console.log(
          `[join-hive] ${next.slug}: adopted the pot owner's repoKey ${adopted.key} ` +
            `(was ${adopted.rekeyedFrom}) — the store at the old key is abandoned and ` +
            `this repo will cold-join the peer under the new one`,
        );
      }
      memberEntries.set(next.slug, next);
      return next;
    });
    return {
      ...cur,
      projects: hasView
        ? projects
        : [
            ...projects,
            {
              slug: potSlug,
              path: viewPath,
              harness_kind: 'hive',
              remote_hive: true,
              ...viewIdentityCoords,
            },
          ],
    };
  }, opts.workspaceId);

  // 2b — EI-681: materialize the remote Hive's IDENTITY (the OWNER's HIVE pubkey)
  //      so the joiner re-keys its joined harnesses onto the SAME Hive-pubkey
  //      federation topic the owner uses. resolveHiveSwarmBinding needs
  //      getHiveBySlug(home) to resolve a pubkey for the remote view home;
  //      without this the joiner falls through to the gh:<repo_id> topic and the
  //      two peers sit on DIFFERENT topics → a write never federates. The
  //      member-link carries only the topic HASH, so the pubkey comes from the
  //      discovery announce. Best-effort: a missing pubkey or a write failure
  //      NEVER fails the join (the view + member joins already succeeded). The
  //      keychain_id is a NON-SIGNING placeholder — a joiner never signs or
  //      announces a Hive it does not own (this remote view "never announces",
  //      per the §2 contract above), so the keypair-less identity is correct.
  //      upsertRemoteHiveIdentity repairs rows whose keychain_id is already
  //      remote:* plus the old pre-EI-681 polluted shape for THIS remote view
  //      (`hive:<workspace>:<remote-view>`). A real OWNED identity outside this
  //      registry-proven remote view still wins unchanged.
  const upsertHiveIdentity =
    deps.upsertHiveIdentity ??
    ((input: { workspaceId: string; homeSlug: string; pubkeyBase64: string; keychainId: string }) =>
      upsertRemoteHiveIdentity({
        ...input,
        title: opts.title ?? opts.potId,
        repairKeychainIds: [hiveKeychainId(opts.workspaceId, potSlug)],
      }));
  let identityPubkey: string | null = null;
  try {
    const pubkeyBase64 =
      (typeof opts.hivePubkey === 'string' && opts.hivePubkey.trim() ? opts.hivePubkey.trim() : null) ??
      (await resolveHivePubkey(opts.workspaceId, opts.potId).catch(() => null));
    identityPubkey = pubkeyBase64;
    if (pubkeyBase64) {
      const writeIdentity = () =>
        upsertHiveIdentity({
          workspaceId: opts.workspaceId,
          homeSlug: potSlug,
          pubkeyBase64,
          keychainId: `remote:${opts.potId}`,
        });
      try {
        await writeIdentity();
      } catch (first) {
        // WI-10003237 heal: a pre-fix join-link (WI-10003134) wrote THIS Pot's
        // identity under one of this join's MEMBER slugs, so the pubkey is taken
        // and a re-join would collide forever. A remote:* row holding the Pot's
        // pubkey under a member slug is misfiled by definition (the pubkey is
        // UNIQUE and names the Pot, and remote:* rows are never owned keys) —
        // remove it and write the row where it belongs. Anything else rethrows
        // to the diagnostic logger below.
        const memberSlugs = new Set(members.filter((m) => m.ok && m.slug).map((m) => m.slug));
        const holder = await (deps.findHiveByPubkey ?? getHiveByPubkey)(
          opts.workspaceId,
          pubkeyBase64,
        ).catch(() => null);
        if (
          !holder ||
          holder.homeSlug === potSlug ||
          !holder.keychainId.startsWith('remote:') ||
          !memberSlugs.has(holder.homeSlug)
        ) {
          throw first;
        }
        await (deps.deleteHive ?? deleteHive)(opts.workspaceId, holder.homeSlug);
        console.warn(
          `[join-hive] step 2b: the Pot identity for ${opts.workspaceId}/${potSlug} was misfiled ` +
            `under member slug ${holder.homeSlug} (keychain=${holder.keychainId}) — removed it and ` +
            `re-materialized it under ${potSlug} (WI-10003237).`,
        );
        await writeIdentity();
      }
    }
  } catch (e) {
    // Identity-view write is best-effort: never fail the join over it. But NEVER
    // silently — WI-10003237: when this upsert lost a `pots_public_key_key` race,
    // no pots row existed at (workspace, potSlug), so EVERY federated pot_members
    // apply then failed `pot_members_pot_fkey` (1280x in 9 min on the cert rig) and
    // the only trace was that FK storm, three hops downstream. Name the failure and
    // the row already holding this pubkey here, so the next occurrence is
    // self-diagnosing: a same-workspace holder under another slug is a slug race;
    // none means the pubkey lives in ANOTHER workspace.
    let holder = 'unknown';
    if (identityPubkey) {
      holder = await (deps.findHiveByPubkey ?? getHiveByPubkey)(opts.workspaceId, identityPubkey)
        .then((h) =>
          h
            ? `same-workspace slug=${h.homeSlug} canonical=${h.canonicalHomeSlug} keychain=${h.keychainId}`
            : 'none-in-this-workspace',
        )
        .catch((le) => `lookup-failed: ${le instanceof Error ? le.message : String(le)}`);
    }
    console.warn(
      `[join-hive] step 2b remote Pot identity upsert FAILED for ${opts.workspaceId}/${potSlug} ` +
        `(potId=${opts.potId}): ${e instanceof Error ? e.message : String(e)} — pubkey holder: ${holder}. ` +
        `Without a pots row at this (workspace, slug) every federated pot_members apply fails pot_members_pot_fkey.`,
    );
  }

  // 2c — EI-681: re-key the joined members onto the Hive-pubkey topic. The
  //      per-member joins (step 1) booted each substrate BEFORE the hive_slug +
  //      Hive identity existed (steps 2/2b), so resolveSwarmBinding resolved the
  //      gh:<repo_id> topic and the member sat on a DIFFERENT topic than the
  //      owner's Hive-pubkey topic → a write never federated. Now that the view +
  //      identity are materialized, RE-KEY each joined member IN PLACE so it
  //      re-resolves onto the SAME Hive-pubkey topic the owner uses — in place
  //      (NOT a reboot), because a reboot breaks the owner's corestore serving of
  //      its own log core. Best-effort — a re-key failure must NEVER fail an
  //      otherwise-successful join.
  const rekeyHarness =
    deps.rekeyHarness ??
    (async (ws: string, slug: string) =>
      (await import('../sync/hyperbee/boot-all')).rekeyHarness(ws, slug));
  // 2c′ — WI-971 (joiner home-VIEW drain): boot/rekey the remote-hive VIEW home
  //      itself, not just the members. The view is registered (step 2) + its Hive
  //      identity materialized (step 2b), but NOTHING boots its substrate at
  //      runtime — boot-all's D-057 hive-kind boot only covers it on the NEXT
  //      process restart. Until then any write captured under the home-view slug
  //      (the joiner's own hive_epoch_keys writes, hive-scoped settings/roster
  //      edits) sits in substrate_outbox UNDRAINED — peer_connected but never
  //      federating (pinned live 2026-07-03 on the two-instance content-matrix
  //      pair: B's `default::hello-world-hive` hive_epoch_keys rows undrained
  //      while every member-scope row drained). `rekeyHarness` on the unbooted
  //      view falls back to a fresh `bootSingleHarness`, which resolves the
  //      hive-pubkey binding (2b landed it) and wires the outbox drain +
  //      presence announce via ensureSendSideWired. This is the exact joiner
  //      mirror of the owner-side hive-home re-key in publishCreatedHive step 7
  //      (A-003 a′). Best-effort: a failure must NEVER fail the join — but say
  //      so loudly (same posture as the member-rekey swallow below).
  try {
    await rekeyHarness(opts.workspaceId, potSlug);
  } catch (e) {
     
    console.error(
      `[join-hive] 2c′ home-view boot/rekey FAILED for ${potSlug} — the joiner's hive-home ` +
        `outbox stays undrained until restart: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  for (const m of members) {
    if (!m.ok || !m.slug) continue;
    try {
      await rekeyHarness(opts.workspaceId, m.slug);
    } catch (e) {
      // A re-key failure must NEVER fail an otherwise-successful join — but it
      // must not be SILENT either (WI-1544 defect E): a member whose 2c rekey
      // failed is stranded on the gh:<repo_id> topic — connected to nothing the
      // owner announces on — until a restart, and this swallow was the only
      // trace. Say so loudly + stamp the member detail the caller returns.
       
      console.error(
        `[join-hive] 2c rekey FAILED for member ${m.slug} — member may be stranded off the hive topic until restart: ${e instanceof Error ? e.message : String(e)}`,
      );
      m.detail = `${m.detail}; rekey:failed`;
    }
  }

  // 3 — best-effort git-sync seeding per joined member clone (git-sync-any-hive
  //     P-003): joiner-side rows seed ACTIVE (D-008) + push:false (so a local
  //     commit+fetch+merge mirror only) via the seeder, non-clobber idempotent
  //     (re-join reports routine_exists), and the
  //     remote_hive VIEW is never a member here (eligibility would refuse it
  //     anyway). The cron jitter key is salted per-install — on a shared hive the
  //     same member slug exists on N peer boxes. A failure NEVER fails the join;
  //     the outcome lands in the member's `detail`.
  const seedGitSync = deps.seedGitSync ?? seedGitSyncRoutineForMember;
  for (const m of members) {
    if (!m.ok) continue;
    const entry = memberEntries.get(m.slug);
    if (!entry) continue;
    const outcome = await seedGitSync({
      workspaceId: opts.workspaceId,
      installSlug: m.slug,
      entry,
      joinerSide: true,
      cronKey: `${m.slug}:${opts.workspaceId}`,
    }).catch(
      (e): SeedGitSyncRoutineOutcome => ({
        seeded: false,
        reason: 'error',
        message: e instanceof Error ? e.message : String(e),
      }),
    );
    m.detail = `${m.detail}; git_sync:${outcome.seeded ? 'seeded' : outcome.reason}`;
  }

  if (partialIdentityStamp) {
    console.error(
      `[join-hive] degraded join for ${potSlug}: hive_pubkey is present but ` +
        `owner_device_pubkey is missing; retrying is required to repair the view`,
    );
    return { ok: false, potSlug, members, error: 'partial_identity_stamp' };
  }

  return { ok: true, potSlug, members };
}
