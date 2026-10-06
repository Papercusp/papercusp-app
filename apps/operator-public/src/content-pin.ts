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

/**
 * The Worker's OWN verdict on a recipe's authority (P-007, D-005, D-010) — computed
 * from the script bytes it fetched, never read from a publisher-supplied manifest field.
 */
export interface RecipeAuthorityVerdict {
  /** TRUE unless the Worker PROVED the script resolvable. Every failure path (analyzer
   *  unavailable, manifest missing or unreadable) is `true` — "could not analyze" is
   *  never reported as "safe". */
  unresolved: boolean;
  /** The analyzer's cause kind, or the Worker's own `analyzer-unavailable` /
   *  `recipe-manifest-missing` / `recipe-manifest-invalid`; null only when resolved. */
  cause: string | null;
}

/** The manifest file the `recipe` kind installs from (`recipe-store.ts` RECIPE_MANIFEST). */
export const RECIPE_MANIFEST_FILE = 'recipe.json';

/** Injected analyzer seam: the production default is `deriveRecipeAuthority`. */
export type RecipeAuthorityAnalyzer = (
  script: string,
) => Promise<{ unresolved: boolean; unresolvedCause?: { kind: string } | null }>;

/** Derive the Worker-side recipe authority verdict from the fetched package parts. */
export async function deriveWorkerRecipeAuthority(
  parts: ReadonlyArray<{ path: string; text: string }>,
  listingRef: string,
  analyzer?: RecipeAuthorityAnalyzer,
): Promise<RecipeAuthorityVerdict> {
  const manifestPath = `${listingRef.replace(/\/+$/, '')}/${RECIPE_MANIFEST_FILE}`;
  const manifest = parts.find((part) => part.path === manifestPath);
  if (!manifest) return { unresolved: true, cause: 'recipe-manifest-missing' };
  let script: unknown;
  try {
    script = (JSON.parse(manifest.text) as { script?: unknown } | null)?.script;
  } catch {
    return { unresolved: true, cause: 'recipe-manifest-invalid' };
  }
  if (typeof script !== 'string' || script.trim() === '') {
    return { unresolved: true, cause: 'recipe-manifest-invalid' };
  }
  try {
    // Lazy: the TypeScript compiler is ~1.7 MiB gzipped and costs ~360 ms CPU to initialise
    // (D-010), so only a recipe publish pays for it — never a cold start or another kind.
    const analyze =
      analyzer ?? (await import('@papercusp/operator-core/lib/recipe-authority-derive')).deriveRecipeAuthority;
    const descriptor = await analyze(script);
    const unresolved = descriptor.unresolved === true;
    return { unresolved, cause: unresolved ? (descriptor.unresolvedCause?.kind ?? 'analyzer-unavailable') : null };
  } catch {
    return { unresolved: true, cause: 'analyzer-unavailable' };
  }
}

export interface ContentPin {
  ok: true;
  /** The default-branch head at publish time — what the installer fetches. */
  commitSha: string;
  /** `canonicalTreeDigest` of every blob under `<listing_ref>/` at that commit. */
  treeDigest: string;
  fileCount: number;
  byteCount: number;
  /** The Worker's own authority verdict — present for the `recipe` kind only (P-007). */
  recipeAuthority?: RecipeAuthorityVerdict;
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
  /** P-008: pin THIS commit instead of resolving the default-branch head — the
   *  review approve path re-pins a drifted row to the SHA the operator actually
   *  read. `defaultBranch` is ignored when it is set. */
  commitSha?: string;
  /** The listing kind. `recipe` makes the pin also compute the Worker's own authority
   *  verdict from the fetched script (P-007); any other value (or none) skips it. */
  kind?: ListingKind;
  /** Test seam for the recipe authority analyzer; defaults to `deriveRecipeAuthority`. */
  authorityAnalyzer?: RecipeAuthorityAnalyzer;
  /** Injected for tests / alternate hosts; defaults to the ambient `fetch`. */
  fetchImpl?: typeof fetch;
}

/** A full git object id (SHA-1, or SHA-256 repos' 64 hex). */
export const COMMIT_SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

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

interface FetchListingEntriesInput {
  repo: string;
  headers: Record<string, string>;
  fetchImpl: typeof fetch;
  commitSha: string;
  listingRef: string;
}

type FetchListingEntriesResult =
  | { ok: true; entries: TreeDigestEntry[]; byteCount: number }
  | Extract<ContentPinRefusal, { code: 'github_tree_unreachable' | 'tree_truncated' | 'listing_ref_missing' }>;

/** The blobs under `<listing_ref>/` at one commit — the tree walk shared by the
 *  pin (P-001) and the review diff (P-008), so what an operator is SHOWN is
 *  enumerated by the same code that decides what is PINNED. */
async function fetchListingEntries(input: FetchListingEntriesInput): Promise<FetchListingEntriesResult> {
  const { repo, headers, fetchImpl, commitSha } = input;
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
  return { ok: true, entries, byteCount };
}

/**
 * HTTP rendering of a pin refusal — the status + body the publish route returns,
 * shared so the review re-pin (P-008) answers a refusal identically. Never echoes
 * a matched identity value (see `identity_leak` above).
 */
export function pinRefusalToHttp(refusal: ContentPinRefusal): { status: 400 | 422; body: Record<string, unknown> } {
  if (refusal.code === 'github_tree_unreachable') {
    return { status: 400, body: { error: refusal.code, step: refusal.step, status: refusal.status } };
  }
  if (refusal.code === 'github_blob_unreachable') {
    return { status: 400, body: { error: refusal.code, path: refusal.path, status: refusal.status } };
  }
  if (refusal.code === 'identity_leak') {
    return { status: 422, body: { error: refusal.code, commitSha: refusal.commitSha, hits: refusal.hits } };
  }
  const { ok: _ok, code, ...detail } = refusal;
  return { status: 422, body: { error: code, ...detail } };
}

export interface ListingFileDiffEntry {
  path: string;
  status: 'added' | 'removed' | 'modified';
  /** Blob sha at the previously approved commit (null for `added`). */
  fromSha: string | null;
  /** Blob sha at the commit under review (null for `removed`). */
  toSha: string | null;
}

export interface DiffListingContentInput {
  token: string;
  owner: string;
  name: string;
  listingRef: string;
  /** The commit under review (the pending row's pin). */
  toCommitSha: string;
  /** The previously approved commit; null for the first-ever version. */
  fromCommitSha: string | null;
  fetchImpl?: typeof fetch;
}

export type DiffListingContentResult =
  | {
      ok: true;
      fromCommitSha: string | null;
      toCommitSha: string;
      files: ListingFileDiffEntry[];
      /** Paths present in both commits with the same blob — counted, not listed. */
      unchangedCount: number;
    }
  | Extract<ContentPinRefusal, { code: 'github_tree_unreachable' | 'tree_truncated' | 'listing_ref_missing' }>;

/**
 * File-level diff of `<listing_ref>/` between the previously approved commit and
 * the commit under review (P-008). Blob shas ARE content addresses, so comparing
 * them per path is an exact added/removed/modified verdict with no byte
 * transfer. The first-ever version (`fromCommitSha: null`) is every file `added`.
 * A previously approved commit that no longer has the directory (the publisher
 * deleted it) diffs as an empty "from" side — everything under review is `added`.
 */
export async function diffListingContent(input: DiffListingContentInput): Promise<DiffListingContentResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const headers = {
    Authorization: `Bearer ${input.token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'papercusp-cupboard',
  };
  const repo = `https://api.github.com/repos/${seg(input.owner)}/${seg(input.name)}`;

  const to = await fetchListingEntries({ repo, headers, fetchImpl, commitSha: input.toCommitSha, listingRef: input.listingRef });
  if (!to.ok) return to;
  let fromEntries: TreeDigestEntry[] = [];
  if (input.fromCommitSha != null) {
    const from = await fetchListingEntries({ repo, headers, fetchImpl, commitSha: input.fromCommitSha, listingRef: input.listingRef });
    if (from.ok) fromEntries = from.entries;
    else if (from.code !== 'listing_ref_missing') return from;
  }

  const fromByPath = new Map(fromEntries.map((e) => [e.path, e.sha]));
  const toByPath = new Map(to.entries.map((e) => [e.path, e.sha]));
  const files: ListingFileDiffEntry[] = [];
  let unchangedCount = 0;
  for (const [path, toSha] of toByPath) {
    const fromSha = fromByPath.get(path);
    if (fromSha === undefined) files.push({ path, status: 'added', fromSha: null, toSha });
    else if (fromSha !== toSha) files.push({ path, status: 'modified', fromSha, toSha });
    else unchangedCount += 1;
  }
  for (const [path, fromSha] of fromByPath) {
    if (!toByPath.has(path)) files.push({ path, status: 'removed', fromSha, toSha: null });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { ok: true, fromCommitSha: input.fromCommitSha, toCommitSha: input.toCommitSha, files, unchangedCount };
}

export async function pinListingContent(input: PinListingContentInput): Promise<ContentPin | ContentPinRefusal> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const headers = {
    Authorization: `Bearer ${input.token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'papercusp-cupboard',
  };
  const repo = `https://api.github.com/repos/${seg(input.owner)}/${seg(input.name)}`;

  let commitSha: string;
  if (input.commitSha !== undefined) {
    // P-008 re-pin: the operator named the exact commit they reviewed.
    if (!COMMIT_SHA_RE.test(input.commitSha)) {
      return { ok: false, code: 'github_tree_unreachable', step: 'ref', status: 422 };
    }
    commitSha = input.commitSha;
  } else {
    // A branch name may contain '/', which GitHub's ref path takes UNENCODED
    // (`git/ref/heads/feature/x`); encode each segment, keep the separators.
    const branchPath = input.defaultBranch.split('/').map(seg).join('/');
    const refRes = await fetchImpl(`${repo}/git/ref/heads/${branchPath}`, { headers });
    if (!refRes.ok) return { ok: false, code: 'github_tree_unreachable', step: 'ref', status: refRes.status };
    const ref = (await refRes.json()) as GitRefResponse;
    const headSha = ref.object?.sha;
    if (typeof headSha !== 'string' || !COMMIT_SHA_RE.test(headSha)) {
      return { ok: false, code: 'github_tree_unreachable', step: 'ref', status: refRes.status };
    }
    commitSha = headSha;
  }

  const listed = await fetchListingEntries({ repo, headers, fetchImpl, commitSha, listingRef: input.listingRef });
  if (!listed.ok) return listed;
  const { entries, byteCount } = listed;
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
  // P-007 (D-005): the verdict is computed only after the bytes passed the identity scan, from
  // the SAME blobs the digest covers — so it describes exactly the commit that is pinned.
  const recipeAuthority =
    input.kind === 'recipe'
      ? await deriveWorkerRecipeAuthority(packageParts, input.listingRef, input.authorityAnalyzer)
      : undefined;
  return {
    ok: true,
    commitSha,
    treeDigest,
    fileCount: entries.length,
    byteCount,
    ...(recipeAuthority ? { recipeAuthority } : {}),
  };
}
