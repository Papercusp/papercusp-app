/**
 * Content pin at publish — cupboard-release-pipeline-content-trust-2026-09-16
 * P-001 (D-003: the Worker is the content authority and fetches the bytes
 * itself; D-005: it verifies, never launders).
 *
 * For a SELF-DESCRIBING kind (a listing that installs from a `<listing_ref>/`
 * directory of the repo) the Worker resolves the repo's default-branch head and
 * computes the canonical tree digest of that directory at that commit, using the
 * publisher's own token (they must read the repo they are publishing). Both
 * values are stored on the listing row (migration 028) and are what the
 * installer (P-002) verifies against.
 *
 * Pure over an injected `fetch`, so the route test can stub GitHub and a future
 * host (the GitHub App's push re-scan, P-006) can reuse it verbatim.
 */
import {
  canonicalTreeDigest,
  collectIdentityValues,
  scanIdentityLeaks,
  type ContentIdentityLeakKind,
  type TreeDigestEntry,
} from '@papercusp/artifact-registry';
import type { ListingKind } from './db.ts';

/** Kinds that install from a `<listing_ref>/` directory through
 *  `install-self-describing-core` (operator-core). Exactly the five install
 *  cores on that seam; a kind not listed here is a CODE kind whose content
 *  identity comes from the release gate (Phase 4), not from a tree pin. */
export const SELF_DESCRIBING_KINDS: readonly ListingKind[] = ['rubric', 'plan', 'recipe', 'goal', 'theme'];

export function isSelfDescribingKind(kind: ListingKind): boolean {
  return SELF_DESCRIBING_KINDS.includes(kind);
}

/** A self-describing package is a handful of JSON/Markdown files. These bounds
 *  are far above any legitimate package and exist so a hostile `<listing_ref>/`
 *  cannot make the pin (or the P-002 install, or the P-003 re-scan) walk a
 *  repository-sized tree. */
export const PIN_FILE_BUDGET = 2_000;
export const PIN_BYTE_BUDGET = 32 * 1024 * 1024;

export interface ContentPin {
  ok: true;
  /** The default-branch head at publish time — what the installer fetches. */
  commitSha: string;
  /** `canonicalTreeDigest` of every blob under `<listing_ref>/` at that commit. */
  treeDigest: string;
  fileCount: number;
  byteCount: number;
}

export interface ContentIdentityLeakSite {
  path: string;
  pattern: ContentIdentityLeakKind;
  occurrences: number;
}

export type ContentPinRefusal =
  /** GitHub could not tell us the head or the tree — the publisher's token or
   *  the repo state is at fault, not the package; same class as
   *  `github_repo_unreachable`. */
  | { ok: false; code: 'github_tree_unreachable'; step: 'ref' | 'tree'; status: number }
  /** No blob lives under `<listing_ref>/` at the head: the pointer names a
   *  directory that does not exist, so there is nothing to pin (SPEC-P-001b). */
  | { ok: false; code: 'listing_ref_missing'; commitSha: string }
  /** GitHub truncated the recursive tree (>100k entries / >7 MB): the directory
   *  cannot be enumerated, so it cannot be verified — refuse rather than pin a
   *  partial view. */
  | { ok: false; code: 'tree_truncated'; commitSha: string }
  | { ok: false; code: 'github_blob_unreachable'; commitSha: string; path: string; status: number }
  | { ok: false; code: 'identity_leak'; commitSha: string; hits: ContentIdentityLeakSite[] }
  | {
      ok: false;
      code: 'listing_ref_too_large';
      commitSha: string;
      fileCount: number;
      byteCount: number;
      fileBudget: number;
      byteBudget: number;
    };

export interface PinListingContentInput {
  token: string;
  owner: string;
  name: string;
  defaultBranch: string;
  listingRef: string;
  /** Injected for tests / alternate hosts; defaults to the ambient `fetch`. */
  fetchImpl?: typeof fetch;
}

interface GitRefResponse {
  object?: { sha?: unknown };
}
interface GitTreeResponse {
  tree?: Array<{ path?: unknown; type?: unknown; sha?: unknown; size?: unknown }>;
  truncated?: unknown;
}
interface GitBlobResponse {
  content?: unknown;
  encoding?: unknown;
}

const seg = (s: string) => encodeURIComponent(s);

export async function pinListingContent(input: PinListingContentInput): Promise<ContentPin | ContentPinRefusal> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const headers = {
    Authorization: `Bearer ${input.token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'papercusp-cupboard',
  };
  const repo = `https://api.github.com/repos/${seg(input.owner)}/${seg(input.name)}`;

  // A branch name may contain '/', which GitHub's ref path takes UNENCODED
  // (`git/ref/heads/feature/x`); encode each segment, keep the separators.
  const branchPath = input.defaultBranch.split('/').map(seg).join('/');
  const refRes = await fetchImpl(`${repo}/git/ref/heads/${branchPath}`, { headers });
  if (!refRes.ok) return { ok: false, code: 'github_tree_unreachable', step: 'ref', status: refRes.status };
  const ref = (await refRes.json()) as GitRefResponse;
  const commitSha = ref.object?.sha;
  if (typeof commitSha !== 'string' || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commitSha)) {
    return { ok: false, code: 'github_tree_unreachable', step: 'ref', status: refRes.status };
  }

  const treeRes = await fetchImpl(`${repo}/git/trees/${commitSha}?recursive=1`, { headers });
  if (!treeRes.ok) return { ok: false, code: 'github_tree_unreachable', step: 'tree', status: treeRes.status };
  const tree = (await treeRes.json()) as GitTreeResponse;
  if (tree.truncated === true) return { ok: false, code: 'tree_truncated', commitSha };

  const prefix = `${input.listingRef.replace(/\/+$/, '')}/`;
  const entries: TreeDigestEntry[] = [];
  let byteCount = 0;
  for (const node of tree.tree ?? []) {
    if (node.type !== 'blob') continue; // sub-trees are implied by their blobs; submodules ('commit') carry no bytes we can verify
    if (typeof node.path !== 'string' || !node.path.startsWith(prefix)) continue;
    if (typeof node.sha !== 'string') continue;
    entries.push({ path: node.path, sha: node.sha });
    byteCount += typeof node.size === 'number' && node.size > 0 ? node.size : 0;
  }
  if (entries.length === 0) return { ok: false, code: 'listing_ref_missing', commitSha };
  if (entries.length > PIN_FILE_BUDGET || byteCount > PIN_BYTE_BUDGET) {
    return {
      ok: false,
      code: 'listing_ref_too_large',
      commitSha,
      fileCount: entries.length,
      byteCount,
      fileBudget: PIN_FILE_BUDGET,
      byteBudget: PIN_BYTE_BUDGET,
    };
  }

  // P-003: the Worker verifies the bytes it is about to trust, not only the
  // tree shape. Harvest identity-bearing JSON fields first, then scan every
  // serialized blob so a copied handle in prose cannot pass by hiding outside
  // the structured key that revealed it.
  const packageParts: Array<{ path: string; text: string }> = [];
  const identityValues = new Set<string>();
  for (const entry of entries) {
    const blobRes = await fetchImpl(`${repo}/git/blobs/${seg(entry.sha)}`, { headers });
    if (!blobRes.ok) {
      return { ok: false, code: 'github_blob_unreachable', commitSha, path: entry.path, status: blobRes.status };
    }
    const blob = (await blobRes.json()) as GitBlobResponse;
    if (blob.encoding !== 'base64' || typeof blob.content !== 'string') {
      return { ok: false, code: 'github_blob_unreachable', commitSha, path: entry.path, status: blobRes.status };
    }
    let text: string;
    try {
      const binary = atob(blob.content.replace(/\s/g, ''));
      text = new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
    } catch {
      return { ok: false, code: 'github_blob_unreachable', commitSha, path: entry.path, status: blobRes.status };
    }
    packageParts.push({ path: entry.path, text });
    if (/\.json$/i.test(entry.path)) {
      try {
        for (const value of collectIdentityValues(JSON.parse(text))) identityValues.add(value);
      } catch {
        // Non-JSON bytes are still scanned for host-shaped leaks below.
      }
    }
  }
  // Keep findings scoped to the blob that contains them. Never echo the
  // matched value in an HTTP response: it may itself be a credential.
  const leaks = packageParts.flatMap(({ path, text }) =>
    scanIdentityLeaks(text, { knownIdentityValues: [...identityValues], osUser: null })
      .map(({ kind, occurrences }) => ({ path, pattern: kind, occurrences })),
  );
  if (leaks.length > 0) return { ok: false, code: 'identity_leak', commitSha, hits: leaks };

  const treeDigest = await canonicalTreeDigest(entries);
  return { ok: true, commitSha, treeDigest, fileCount: entries.length, byteCount };
}
