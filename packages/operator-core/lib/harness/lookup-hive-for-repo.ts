/**
 * lookup-hive-for-repo — the paste-time repo→Hive resolver
 * (hive-from-github-url-2026-06-11 P-005; the D-004/D-008 HYBRID lookup).
 *
 * Answers "does a Hive (or a legacy shared harness) already exist for this
 * GitHub repo?" by composing the three lookup legs in order:
 *
 *   1. GitHub identity (binding-service.resolveRepoIdentity) — canonical
 *      owner/repo + the immutable numeric repo id + any LOCAL cached binding
 *      row. Best-effort: an unauthenticated/offline box degrades to the parsed
 *      owner/repo (id-less matching still works against the directory).
 *   2. The P2P hive directory (offline PG cache hydrated + live discovered set)
 *      — `member_repos` matching via hiveMatchesRepo. The directory announce is
 *      the CONTENT authority (D-004): a hit here is the canonical Hive record.
 *   3. The Cupboard central index (uniqueness + off-network authority for
 *      PUBLIC hives) — behind an injectable seam. Cupboard unreachable/unwired
 *      NEVER blocks the answer: the result is flagged `bindingUnverified: true`
 *      and creation may proceed (reconciled on the 5-min re-announce tick).
 *
 * Pure over injected deps — unit-tests without GitHub, PG, or a swarm.
 */

import type { DiscoveredHive, HiveDirectory } from '../hive-directory';
import { getHiveDirectory } from '../hive-directory-deps';
import { hiveMatchesRepo } from '../hive-member-repos';
import { parseGithubUrl } from './clone-github';

// ── Result shapes ──────────────────────────────────────────────────────────────

/** Canonical repo coordinates the lookup resolved (or parsed) for the input. */
export interface RepoCoords {
  owner: string;
  repo: string;
  /** GitHub's immutable numeric id — absent when identity resolution failed. */
  githubRepositoryId?: number;
  /** Repo visibility per GitHub — absent when identity resolution failed. */
  private?: boolean;
  /** True when the GitHub API leg ran (id + canonical casing are authoritative). */
  identityResolved: boolean;
}

/** A Hive hit (directory or Cupboard) — the join-offer payload. */
export interface HiveHit {
  potId: string;
  title: string;
  ownerGithubLogin?: string;
  /** Raw-32-byte base64 Ed25519 Hive identity pubkey, when the Hive minted one. */
  hivePubkey?: string;
  /** Full `papercusp://harness?...` join links per member harness (one-click join). */
  memberLinks?: string[];
  /** Cupboard claim trust state, when known. */
  claimStatus?: string;
}

/** A pre-hive shared-harness binding hit (OQ-3 legacy path). */
export interface LegacyBindingHit {
  harnessSlug: string;
  harnessLink?: string;
  claimStatus?: string;
}

export type RepoHiveLookup =
  | { kind: 'invalid_url'; message: string }
  | { kind: 'none'; coords: RepoCoords; bindingUnverified: boolean }
  | {
      kind: 'hive';
      coords: RepoCoords;
      hive: HiveHit;
      source: 'directory' | 'cupboard';
      bindingUnverified: boolean;
    }
  | {
      kind: 'legacy_shared_harness';
      coords: RepoCoords;
      binding: LegacyBindingHit;
      source: 'local-cache' | 'cupboard';
      bindingUnverified: boolean;
    };

// ── Injectable deps ────────────────────────────────────────────────────────────

/** What the Cupboard leg answers (P-004's listing, projected). */
export interface CupboardRepoListing {
  hive_pubkey?: string;
  hive_title?: string;
  harness_slug?: string;
  harness_link?: string;
  claim_status?: string;
  publisher_github_login?: string;
}

export type CupboardRepoLookupFn = (q: {
  githubRepositoryId: number;
}) => Promise<{ ok: true; listing: CupboardRepoListing | null } | { ok: false; error: string }>;

export interface LookupHiveDeps {
  /** binding-service.resolveRepoIdentity (throws on GitHub failure) — injected for tests. */
  resolveIdentity?: (githubUrl: string) => Promise<{
    github_repository_id: number;
    github_owner: string;
    github_repo: string;
    private: boolean;
    existing_binding: {
      harness_slug: string;
      harness_link?: string;
      claim_status?: string;
    } | null;
  }>;
  /** The directory service (default: process singleton, cache-hydrated). */
  getDirectory?: () => Pick<HiveDirectory, 'listDiscoveredHives' | 'hydrateFromCache'>;
  /**
   * The Cupboard central-index leg. Default: GET <cupboard>/binding/:repoId
   * (the worker's public lookup, P-004 mig 007). Unreachable NEVER blocks —
   * the resolver reports bindingUnverified instead.
   */
  cupboardLookup?: CupboardRepoLookupFn;
}

/** The worker's GET /binding/:id response (apps/operator-public routes/binding.ts). */
interface CupboardBindingResponse {
  exists: boolean;
  harness?: {
    github_repository_id: number;
    github_url: string | null;
    title: string | null;
    topic_hex: string | null;
    claim_status: string | null;
    publisher_github_login: string | null;
    hive_pubkey: string | null;
    hive_title: string | null;
  };
}

const defaultCupboardLookup: CupboardRepoLookupFn = async ({ githubRepositoryId }) => {
  try {
    const { resolveCupboardBaseUrl } = await import(
      '../cupboard/base-url'
    );
    const res = await fetch(`${resolveCupboardBaseUrl()}/binding/${githubRepositoryId}`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return { ok: false, error: `cupboard_http_${res.status}` };
    const body = (await res.json()) as CupboardBindingResponse;
    if (!body.exists || !body.harness) return { ok: true, listing: null };
    const h = body.harness;
    // Reconstruct the one-click join link from the listing's coords when complete.
    let harnessLink: string | undefined;
    const parsedRepo = h.github_url ? parseGithubUrl(h.github_url) : null;
    if (h.topic_hex && parsedRepo) {
      const { formatHarnessLink } = await import('./url-scheme');
      harnessLink = formatHarnessLink({
        topic: h.topic_hex,
        github: `${parsedRepo.owner}/${parsedRepo.repo}`,
        repoOwner: parsedRepo.owner,
        repoName: parsedRepo.repo,
        repoId: h.github_repository_id,
      });
    }
    return {
      ok: true,
      listing: {
        ...(h.hive_pubkey ? { hive_pubkey: h.hive_pubkey } : {}),
        ...(h.hive_title ? { hive_title: h.hive_title } : {}),
        ...(harnessLink ? { harness_link: harnessLink } : {}),
        ...(h.claim_status ? { claim_status: h.claim_status } : {}),
        ...(h.publisher_github_login
          ? { publisher_github_login: h.publisher_github_login }
          : {}),
      },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
};

// ── The resolver ───────────────────────────────────────────────────────────────

export async function lookupHiveForRepo(
  githubUrl: string,
  deps: LookupHiveDeps = {},
): Promise<RepoHiveLookup> {
  const parsed = parseGithubUrl(githubUrl);
  if (!parsed) {
    return { kind: 'invalid_url', message: `not a recognized GitHub URL: ${githubUrl}` };
  }

  // Leg 1 — GitHub identity + local binding cache (best-effort).
  let coords: RepoCoords = { owner: parsed.owner, repo: parsed.repo, identityResolved: false };
  let localBinding: LegacyBindingHit | null = null;
  try {
    const resolveIdentity =
      deps.resolveIdentity ??
      (await import('./binding-service')).resolveRepoIdentity;
    const id = await resolveIdentity(parsed.cloneUrl);
    coords = {
      owner: id.github_owner,
      repo: id.github_repo,
      githubRepositoryId: id.github_repository_id,
      private: id.private,
      identityResolved: true,
    };
    if (id.existing_binding) {
      localBinding = {
        harnessSlug: id.existing_binding.harness_slug,
        ...(id.existing_binding.harness_link
          ? { harnessLink: id.existing_binding.harness_link }
          : {}),
        ...(id.existing_binding.claim_status
          ? { claimStatus: id.existing_binding.claim_status }
          : {}),
      };
    }
  } catch {
    /* offline / unauthenticated — owner/repo matching still works */
  }

  // Leg 2 — the P2P directory (content authority).
  try {
    const dir = deps.getDirectory ? deps.getDirectory() : getHiveDirectory();
    await dir.hydrateFromCache().catch(() => 0);
    const discovered: DiscoveredHive[] = dir.listDiscoveredHives();
    const hit = discovered.find((h) =>
      hiveMatchesRepo(h.memberRepos, {
        ...(coords.githubRepositoryId !== undefined
          ? { githubRepositoryId: coords.githubRepositoryId }
          : {}),
        owner: coords.owner,
        repo: coords.repo,
      }),
    );
    if (hit) {
      // Directory answered — Cupboard confirmation is optional enrichment here;
      // the directory record IS the canonical content (D-004).
      return {
        kind: 'hive',
        coords,
        hive: {
          potId: hit.potId,
          title: hit.title,
          ownerGithubLogin: hit.ownerGithubLogin,
          ...(hit.hivePubkey ? { hivePubkey: hit.hivePubkey } : {}),
          ...(hit.memberLinks?.length ? { memberLinks: [...hit.memberLinks] } : {}),
        },
        source: 'directory',
        bindingUnverified: false,
      };
    }
  } catch {
    /* directory unavailable — fall through to the central index */
  }

  // Leg 3 — the Cupboard central index (uniqueness / off-network authority).
  let bindingUnverified = false;
  if (coords.githubRepositoryId !== undefined) {
    const cupboardLookup = deps.cupboardLookup ?? defaultCupboardLookup;
    const res = await cupboardLookup({ githubRepositoryId: coords.githubRepositoryId }).catch(
      () => ({ ok: false as const, error: 'cupboard_lookup_threw' }),
    );
    if (res.ok) {
      const listing = res.listing;
      if (listing?.hive_pubkey) {
        // WI-559 — DO NOT hand back a display TITLE as the `potId` identity.
        //
        // The Cupboard listing carries no home-slug field, so this leg used to set
        // `potId: listing.hive_title ?? owner/repo` — the same expression feeding both
        // `potId` and `title`, which is the tell that one of them is a stand-in. On the
        // 2-machine rig that produced `kebab('octocat/Spoon-Knife')` =
        // 'octocat-spoon-knife' as the joiner's view slug while the owner's home slug
        // was 'spoon-knife-pot'. (That mismatch no longer causes the federation blackout
        // it once did — the demux key is resolved from the hive PUBKEY now, see
        // canonicalHiveHomeSlug — but a display string must still not masquerade as an
        // identity, and a joiner whose slug matches the owner's is plainly better.)
        //
        // The owner's signed announce is the authority, so prefer the directory entry
        // for THIS hive_pubkey; the title-derived value stays only as the last-resort
        // LOCAL naming affordance (join-hive freeSlug-suffixes it anyway).
        const announcedPotId = ((): string | undefined => {
          try {
            const dir = deps.getDirectory ? deps.getDirectory() : getHiveDirectory();
            const byPubkey = dir
              .listDiscoveredHives()
              .find((h) => h.hivePubkey === listing.hive_pubkey && h.potIdSynthetic !== true);
            const slug = byPubkey?.potId?.trim();
            return slug && slug.length > 0 ? slug : undefined;
          } catch {
            return undefined; // directory unavailable — fall back to the local derivation
          }
        })();
        return {
          kind: 'hive',
          coords,
          hive: {
            potId: announcedPotId ?? listing.hive_title ?? `${coords.owner}/${coords.repo}`,
            title: listing.hive_title ?? `${coords.owner}/${coords.repo}`,
            ...(listing.publisher_github_login
              ? { ownerGithubLogin: listing.publisher_github_login }
              : {}),
            hivePubkey: listing.hive_pubkey,
            ...(listing.harness_link ? { memberLinks: [listing.harness_link] } : {}),
            ...(listing.claim_status ? { claimStatus: listing.claim_status } : {}),
          },
          source: 'cupboard',
          bindingUnverified: false,
        };
      }
      if (listing?.harness_slug || listing?.harness_link) {
        return {
          kind: 'legacy_shared_harness',
          coords,
          binding: {
            harnessSlug: listing.harness_slug ?? '',
            ...(listing.harness_link ? { harnessLink: listing.harness_link } : {}),
            ...(listing.claim_status ? { claimStatus: listing.claim_status } : {}),
          },
          source: 'cupboard',
          bindingUnverified: false,
        };
      }
      // verified absence — fall through with bindingUnverified false
    } else {
      bindingUnverified = true;
    }
  } else {
    // No repo id (identity leg failed) → the central index could not be asked.
    bindingUnverified = true;
  }

  // Local cached binding (pre-hive shared harness) as the last positive answer.
  if (localBinding) {
    return {
      kind: 'legacy_shared_harness',
      coords,
      binding: localBinding,
      source: 'local-cache',
      bindingUnverified,
    };
  }

  return { kind: 'none', coords, bindingUnverified };
}
