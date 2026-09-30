/**
 * Cupboard prod-hygiene scan (EI-11118: durable fix for
 * cupboard-public-release-2026-07-12 P-009 — E2E/federation/smoke flows that
 * exercise the REAL publish path against the LIVE prod worker leave junk
 * listings behind (22× `psu-fed-e2e-<epoch>` harness rows, `cupboard-verify-
 * smoke`, classic-repo seeds like `octocat/Hello-World` / `is-even` /
 * `hellogitworld`, …). P-009 purged 39 such rows once; without a standing
 * detector the storefront silently re-accumulates them until the next manual
 * sweep.
 *
 * This module is the ONE shared pattern for "does this row look like test
 * junk" — reused by both the manual fresh-install acceptance script
 * (`fresh-install-acceptance.mts`) and the automated release-gate hook
 * (`apps/operator/lib/release/cupboard-hygiene-gate.ts`), so the definition of
 * "junk" never drifts between the two call sites.
 *
 * Pure scan logic (`scanForTestRows`) takes an injected browse function — no
 * IO here — so it is hermetically unit-testable; `browseCupboardListings`
 * (real IO, live prod fetch) is the default wiring for callers that want it.
 */
import { browseCupboardListings } from './browse-listings';
import { LISTING_KINDS, type ListingKind } from './types';

/**
 * Matches the exact junk patterns purged in P-009: the federation/shared-hive
 * E2E harness-name prefix, the cupboard-verify smoke listing, and the classic
 * "public demo repo" seeds (octocat/Hello-World, is-even/is-odd,
 * hellogitworld, generic `test`/`dummy`/`foobar` titles). Kept identical to
 * `fresh-install-acceptance.mts`'s prior inline TEST_RE — moved here so both
 * call sites share ONE definition (reuse-first).
 */
export const CUPBOARD_TEST_ROW_PATTERN =
  /psu-fed-e2e|psu-shared-hive-e2e|shared_hive_test|cupboard-verify-smoke|octocat|is-even|is-odd|hellogitworld|githubtraining|defunkt\/|\bgithub\/gitignore\b|sindresorhus\/slash|\btest\b|dummy|foobar/i;

export interface CupboardTestRow {
  kind: ListingKind;
  id?: string;
  ref: string;
}

/** Minimal shape this scan reads off a listing row — matches browse-listings'
 *  untyped `Record<string, unknown>` rows loosely so it works against both the
 *  real worker response and hand-built test fixtures. */
export type CupboardListingRow = Record<string, unknown>;

/** Injected browse — one call per kind, returning that kind's rows.
 *  Real wiring: `kind => browseCupboardListings({ kind, limit: 200 })`. */
export type CupboardBrowseFn = (
  kind: ListingKind,
) => Promise<{ ok: boolean; listings: CupboardListingRow[]; error?: string }>;

function rowHaystack(row: CupboardListingRow): string {
  const title = row.title ?? '';
  const owner = row.github_owner ?? '';
  const name = row.github_name ?? '';
  const ref = row.listing_ref ?? '';
  return `${title} ${owner}/${name} ${ref}`;
}

function rowRef(row: CupboardListingRow): string {
  const ref = row.listing_ref ?? row.title ?? row.id;
  return ref === undefined || ref === null ? '(unknown)' : String(ref);
}

/**
 * Scan every listing kind (or a caller-supplied subset) via `browse` and
 * return every row whose title/owner/repo/ref matches
 * {@link CUPBOARD_TEST_ROW_PATTERN}. A browse failure for one kind is
 * reported in `errors` and does NOT stop the scan of the remaining kinds
 * (best-effort — a transient worker hiccup must not manufacture a false
 * "clean" verdict OR crash the caller).
 */
export async function scanCupboardForTestRows(
  browse: CupboardBrowseFn,
  kinds: readonly ListingKind[] = LISTING_KINDS,
): Promise<{ testRows: CupboardTestRow[]; errors: Array<{ kind: ListingKind; error: string }> }> {
  const testRows: CupboardTestRow[] = [];
  const errors: Array<{ kind: ListingKind; error: string }> = [];

  for (const kind of kinds) {
    const result = await browse(kind).catch((e) => ({
      ok: false as const,
      listings: [],
      error: e instanceof Error ? e.message : String(e),
    }));
    if (!result.ok) {
      errors.push({ kind, error: result.error ?? 'browse_failed' });
      continue;
    }
    for (const row of result.listings) {
      if (CUPBOARD_TEST_ROW_PATTERN.test(rowHaystack(row))) {
        testRows.push({ kind, id: row.id === undefined ? undefined : String(row.id), ref: rowRef(row) });
      }
    }
  }

  return { testRows, errors };
}

/** Real IO: browse the LIVE prod (or `PAPERCUSP_CUPBOARD_URL`-overridden)
 *  worker via {@link browseCupboardListings}. */
export const liveCupboardBrowse: CupboardBrowseFn = async (kind) => {
  const res = await browseCupboardListings({ kind, limit: 200 });
  if (!res.ok) return { ok: false, listings: [], error: res.error };
  return { ok: true, listings: res.listings };
};
