/**
 * resolve-listing-by-kind — resolve ONE Cupboard listing of a given kind to the
 * (mirror repo URL, within-repo ref) pair an installer needs
 * (cupboard-plan-rubric-recipe-sharing-2026-08-21 P-004, D-003).
 *
 * WHY GENERIC
 * -----------
 * `templates.ts:resolveTemplateListing` already implements this resolution — detail
 * endpoint by uuid first, then a kind-filtered scan matched by ref, with a kind
 * check so an installer cannot be pointed at a listing of a different kind. So does
 * `install-blueprint-io` for blueprints, in its own shape. Adding rubric, plan and
 * recipe would have forked it three more times, and the kind check is a SECURITY
 * property (it is what stops `cupboard:install-rubric { listingId }` from cloning a
 * plugin repo into the rubric store) — precisely the kind of guard that must not
 * exist in five hand-maintained copies.
 *
 * The two existing callers keep their own wrappers (they return richer kind-specific
 * shapes); new kinds use this directly.
 *
 * NOT a fetch-everything helper: it deliberately resolves ONE listing and returns
 * only what an installer consumes. Browsing a kind's storefront is a separate
 * concern (`cupboard:search`).
 */
import { resolveCupboardBaseUrl } from './base-url';
import type { ListingKind } from './types';

const UA = { 'User-Agent': 'papercusp-operator' } as const;
const TIMEOUT_MS = 8000;

export interface ResolvedListingCoords {
  /** The mirror repo to clone. */
  githubUrl: string;
  /** The within-repo subdir (the listing's `listing_ref`). */
  ref: string;
  /** The listing's uuid, when the resolution went through the detail endpoint. */
  listingId?: string;
  /** The listing's declared rubric dependencies, still JSON-encoded (migration 015).
   *  Parse with `parseRequiredRubrics`. Undefined ⇒ the row declared none. */
  requiresRubrics?: string;
  /** `free` | `one-time` | `subscription` | `per-use`; undefined ⇒ the row is unpriced.
   *  Carried so the install-door gate can decide whether a MISSING release chain is
   *  fatal (a paid listing) or ordinary (a free one) — see `install-door-gate`. */
  priceModel?: string;
  /** Undefined ⇒ no price set. Paired with `priceModel`: a model with no amount is an
   *  unfinished storefront row, not a paid unit. */
  priceAmountMicros?: number;
  /** The version the storefront currently serves, when the row names one. */
  releaseVersion?: string;
  /** The Worker's publish-time content pin (migration 028: `pinned_commit_sha` +
   *  `pinned_tree_digest`). Undefined ⇒ the row carries none (pre-028, or a code
   *  kind), so an install can only place the branch tip UNVERIFIED. Present ⇒ the
   *  installer must fetch exactly this commit and verify the digest (P-002). */
  pin?: { commitSha: string; treeDigest: string };
}

export type ResolveListingResult = ResolvedListingCoords | { error: string; status: number };

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** A finite number, from either a JSON number or a numeric string. Storefront rows
 *  serve `price_amount_micros` both ways depending on the backend, and reading only
 *  one of them would silently price a paid listing at zero. */
const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const parsed = Number(v);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

/** Pull the installer-relevant coordinates out of a raw listing row. Null when the
 *  row carries no usable repo URL — a listing we cannot clone is not resolvable,
 *  however well-formed the rest of it is. */
function coordsFromRow(row: Record<string, unknown>): ResolvedListingCoords | null {
  const githubUrl =
    str(row.github_url) ??
    (str(row.github_owner) && str(row.github_name)
      ? `https://github.com/${str(row.github_owner)}/${str(row.github_name)}`
      : null);
  if (!githubUrl) return null;
  const ref = str(row.listing_ref);
  if (!ref) return null;
  return {
    githubUrl,
    ref,
    ...(str(row.id) ? { listingId: str(row.id) as string } : {}),
    // Both halves or neither: a lone sha or digest is not a pin an installer can act on.
    ...(str(row.pinned_commit_sha) && str(row.pinned_tree_digest)
      ? {
          pin: {
            commitSha: str(row.pinned_commit_sha) as string,
            treeDigest: str(row.pinned_tree_digest) as string,
          },
        }
      : {}),
    ...(str(row.requires_rubrics) ? { requiresRubrics: str(row.requires_rubrics) as string } : {}),
    ...(str(row.price_model) ? { priceModel: str(row.price_model) as string } : {}),
    ...(num(row.price_amount_micros) !== null
      ? { priceAmountMicros: num(row.price_amount_micros) as number }
      : {}),
    ...(str(row.release_version) ?? str(row.latest_version) ?? str(row.version)
      ? {
          releaseVersion: (str(row.release_version) ??
            str(row.latest_version) ??
            str(row.version)) as string,
        }
      : {}),
  };
}

/**
 * Resolve a listing of `kind` by uuid OR by its `listing_ref` handle.
 *
 * Order: the detail endpoint first (the uuid path; a ref usually 404s there), then a
 * kind-filtered scan matched on ref/id. A listing whose `listing_kind` is present
 * and DIFFERENT from `kind` is rejected 422 rather than installed — the guard that
 * keeps one kind's installer from being aimed at another kind's repo. A row with NO
 * `listing_kind` is accepted only from the kind-filtered scan (where the server
 * already constrained it), never from the detail endpoint.
 */
export async function resolveListingByKind(
  idOrRef: string,
  kind: ListingKind,
): Promise<ResolveListingResult> {
  const key = (idOrRef ?? '').trim();
  if (!key) return { error: `${kind} id or ref required`, status: 400 };
  const base = resolveCupboardBaseUrl();

  try {
    const res = await fetch(`${base}/listings/${encodeURIComponent(key)}`, {
      headers: UA,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) {
      const data = (await res.json()) as Record<string, unknown> | null;
      const row =
        (data?.harness as Record<string, unknown> | undefined) ??
        (data?.listing as Record<string, unknown> | undefined) ??
        (data as Record<string, unknown> | undefined);
      if (row) {
        // Absent kind is NOT treated as a match here: the detail endpoint serves
        // every kind, so accepting an unlabelled row would defeat the guard.
        if (row.listing_kind !== kind) {
          return {
            error: `listing ${key} is kind=${String(row.listing_kind ?? 'unknown')}, not a ${kind}`,
            status: 422,
          };
        }
        const coords = coordsFromRow(row);
        if (coords) return coords;
      }
    }
  } catch {
    /* fall through to the ref scan */
  }

  const url = new URL(`${base}/listings`);
  url.searchParams.set('kind', kind);
  url.searchParams.set('limit', '200');
  try {
    const res = await fetch(url.toString(), { headers: UA, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return { error: 'cupboard_unreachable', status: 503 };
    const data = (await res.json()) as { results?: Array<Record<string, unknown>> } | null;
    for (const row of data?.results ?? []) {
      if (str(row.listing_ref) === key || str(row.id) === key) {
        const coords = coordsFromRow(row);
        if (coords) return coords;
      }
    }
    return { error: `no ${kind} listing found for "${key}"`, status: 404 };
  } catch {
    return { error: 'cupboard_unreachable', status: 503 };
  }
}
