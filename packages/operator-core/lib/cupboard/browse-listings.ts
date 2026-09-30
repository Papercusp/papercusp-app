/**
 * browse-listings — the typed read of the Cupboard storefront's generalized
 * `/listings` surface (kind-aware, migration 004), shared by the agent-callable
 * `cupboard:search` tool (cupboard-agent-tool-coverage-2026-07-14 P-008).
 *
 * The public `GET /api/cupboard/listings` route is an UNTYPED verbatim proxy for
 * the browser; this core is the typed subset an agent needs (kind / q / project /
 * limit / cursor) with a structured result. Best-effort: a transient worker
 * outage or a kind the worker predates degrades to an empty/So-503 result rather
 * than throwing.
 */
import { resolveCupboardBaseUrl } from './base-url';
import type { ListingKind, ListingVisibility, PricingModel } from './types';

export interface BrowseCupboardListingsInput {
  /** harness | blueprint | plugin | pack | knowledge-pack | template | app | all. */
  kind?: ListingKind | 'all';
  /** Free-text search across the storefront (title/description/etc.). */
  q?: string;
  /** Filter to a project_ref (owner/repo). */
  project?: string;
  /** Page size (default 50). */
  limit?: number;
  /** Opaque pagination cursor from a prior page's next_cursor. */
  cursor?: string;

  // ── Catalog filters (worker migration 018 / shared-pot-dao-cupboard-v1 P-008).
  // Every one NARROWS the unauthenticated public read, which already sees only
  // `visibility='public'` rows. There is deliberately NO widening option here:
  // the route's one widening input (`tenant_scope`) is not reachable from a
  // query param, because this endpoint is unauthenticated and a widening
  // `?tenant=` would hand any caller another pot's private catalog. `tenant`
  // below maps to the route's NARROWING `tenant_ref`. ──

  /** Narrow to one visibility. Omitted ⇒ whatever the public read already allows. */
  visibility?: ListingVisibility | 'all';
  /** Narrow to listings owned by one shared pot (narrowing `tenant_ref`; never widening). */
  tenant?: string;
  /** Narrow to one pricing model. */
  pricing?: PricingModel | 'all';
  /** true ⇒ only listings with a price; false ⇒ only free listings. */
  paid?: boolean;
  /** Narrow to listings whose compatibility declares this platform (e.g. 'linux-x86_64'). */
  platform?: string;
  /** Narrow to listings whose compatibility declares this runtime (e.g. 'node>=22'). */
  runtime?: string;
  /** Narrow to listings that request this install-time permission (e.g. 'fs:read'). */
  permission?: string;
}

/**
 * Query params this client sends for the migration-018 catalog axes. A worker
 * predating that migration rejects each with `400 invalid_field`, which is
 * degraded to an EMPTY result rather than an error — see the fail-closed note at
 * the rejection site.
 */
const CATALOG_FILTER_FIELDS = [
  'visibility',
  'pricing',
  'paid',
  'platform',
  'runtime',
  'permission',
] as const;

/** Whether THIS call actually sent the catalog filter the worker rejected. */
function sentCatalogFilter(input: BrowseCupboardListingsInput, field: string): boolean {
  switch (field) {
    case 'visibility':
      return input.visibility !== undefined && input.visibility !== 'all';
    case 'pricing':
      return input.pricing !== undefined && input.pricing !== 'all';
    case 'paid':
      return input.paid !== undefined;
    case 'platform':
      return Boolean(input.platform);
    case 'runtime':
      return Boolean(input.runtime);
    case 'permission':
      return Boolean(input.permission);
    default:
      return false;
  }
}

export type BrowseCupboardListingsResult =
  | {
      ok: true;
      listings: Record<string, unknown>[];
      next_cursor?: string;
      total?: number;
      kind_facets?: Partial<Record<ListingKind, number>>;
    }
  | { ok: false; status: number; error: string };

export async function browseCupboardListings(
  input: BrowseCupboardListingsInput,
): Promise<BrowseCupboardListingsResult> {
  const base = resolveCupboardBaseUrl();
  const url = new URL(`${base}/listings`);
  if (input.kind && input.kind !== 'all') url.searchParams.set('kind', input.kind);
  if (input.q) url.searchParams.set('q', input.q);
  if (input.project) url.searchParams.set('project', input.project);
  url.searchParams.set('limit', String(input.limit ?? 50));
  if (input.cursor) url.searchParams.set('cursor', input.cursor);
  if (input.visibility && input.visibility !== 'all') {
    url.searchParams.set('visibility', input.visibility);
  }
  if (input.tenant) url.searchParams.set('tenant', input.tenant);
  if (input.pricing && input.pricing !== 'all') url.searchParams.set('pricing', input.pricing);
  if (input.paid !== undefined) url.searchParams.set('paid', input.paid ? '1' : '0');
  if (input.platform) url.searchParams.set('platform', input.platform);
  if (input.runtime) url.searchParams.set('runtime', input.runtime);
  if (input.permission) url.searchParams.set('permission', input.permission);

  try {
    const res = await fetch(url.toString(), {
      headers: { 'User-Agent': 'papercusp-operator/1' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // A worker predating a kind (e.g. 'pack' before its migration) rejects the
      // kind filter with invalid_field:kind — to a browser that's "none of this
      // kind yet", not an error. Mirror the proxy's degradation.
      if (res.status === 400) {
        const err = (await res.json().catch(() => null)) as { error?: string; field?: string } | null;
        if (err?.error === 'invalid_field' && input.kind && err.field === 'kind') {
          return { ok: true, listings: [] };
        }
        // A worker predating migration 018 rejects a catalog filter it has no
        // column for. Degrading to EMPTY is the FAIL-CLOSED choice and the only
        // safe one: the caller asked to NARROW, so answering with the unfiltered
        // page would hand back exactly the rows they filtered out. Only degrade
        // for a field this call actually sent — a rejection naming anything else
        // is a real error and stays one.
        if (
          err?.error === 'invalid_field' &&
          typeof err.field === 'string' &&
          (CATALOG_FILTER_FIELDS as readonly string[]).includes(err.field) &&
          sentCatalogFilter(input, err.field)
        ) {
          return { ok: true, listings: [] };
        }
      }
      return { ok: false, status: res.status, error: `cupboard_http_${res.status}` };
    }
    const data = (await res.json()) as {
      results?: Record<string, unknown>[];
      harnesses?: Record<string, unknown>[];
      listings?: Record<string, unknown>[];
      next_cursor?: string | null;
      total?: number;
      kind_facets?: Partial<Record<ListingKind, number>>;
    };
    const listings = data.results ?? data.harnesses ?? data.listings ?? [];
    return {
      ok: true,
      listings,
      ...(typeof data.next_cursor === 'string' ? { next_cursor: data.next_cursor } : {}),
      ...(typeof data.total === 'number' && Number.isFinite(data.total) ? { total: data.total } : {}),
      ...(data.kind_facets && typeof data.kind_facets === 'object'
        ? { kind_facets: data.kind_facets }
        : {}),
    };
  } catch (e) {
    return { ok: false, status: 503, error: e instanceof Error ? e.message : String(e) };
  }
}
