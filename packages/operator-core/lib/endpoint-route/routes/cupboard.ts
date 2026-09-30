/**
 * Cupboard proxy routes (Phase 9 P-052 browse + D-002 operator moderation).
 *
 * Thin proxy from the operator to the external Cupboard server.
 * URL resolved from NEXT_PUBLIC_CUPBOARD_URL env (falls back to
 * PAPERCUSP_CUPBOARD_URL). When unset, returns empty list / 503.
 *
 *   GET  /api/cupboard/listings                      — list + search (public)
 *   GET  /api/cupboard/listings/:id                  — detail (public)
 *   GET  /api/cupboard/tools                         — tool discovery (local pack
 *        catalog merged with Cupboard provides_tools; tool-distribution P-006)
 *   POST /api/cupboard/listings/:id/claim            — claim a listing (gh token
 *        added server-side; the worker enforces maintain/admin — comb P-003)
 *   GET  /api/cupboard/admin/reports                 — operator: list reports
 *   POST /api/cupboard/admin/reports/:id/resolve     — operator: resolve a report
 *   POST /api/cupboard/admin/harnesses/:id/unlist    — operator: takedown
 *
 * The /admin/* routes add the maintainer's gh-token server-side (the browser
 * never holds it), exactly like the publish proxy — the Cupboard worker then
 * gates on its CUPBOARD_OPERATOR_GITHUB_IDS allowlist.
 */

import { defineTool } from '@papercusp/agent-mcp';
import { getGhAuthToken } from '../../identity/gh-token';
import { resolveCupboardBaseUrl } from '../../cupboard/base-url';
import { derivePackCatalog } from '../../cupboard/pack-catalog';
import {
  buildToolsDiscovery,
  buildToolProvenance,
  collectToolMeta,
} from '../../cupboard/tools-discovery';
import { getPluginHost } from '../../plugin-host-runtime';

// Base URL for the external Cupboard worker. Single source of truth is
// resolveCupboardBaseUrl() (PAPERCUSP_CUPBOARD_URL or the canonical default) —
// the same resolver the publish + admin proxies use. NOTE: the systemd dev unit
// sources .env.local, NOT ~/.papercusp/env, so reading process.env directly here
// (the old behavior) yielded an empty URL and a silently-empty listing
// (`cupboard_url_missing`); the resolver's hardcoded default fixes that.

/**
 * Upstream timeout for every Cupboard-worker proxy hop.
 *
 * The worker answers in ~0.3s, so this budget exists only to bound a HUNG
 * upstream — and an unreachable host is exactly the failure mode that hurts:
 * a dead DNS target accepts TCP :443 and then never completes the TLS
 * handshake, so the request hangs for the full budget before the UI can show
 * anything (cupboard-dead-default-host-2026-07-19 — the branded host did this
 * for every unconfigured process). 10s of dead air per Cupboard call made the
 * storefront feel wedged rather than degraded; 5s still leaves ~16x headroom
 * over a healthy response while halving the worst-case stall.
 */
const CUPBOARD_UPSTREAM_TIMEOUT_MS = 5_000;

// ─── GET /cupboard/listings ───────────────────────────────────────

const listCupboardListings = defineTool({
  method: 'GET',
  path: '/cupboard/listings',
  auth: 'public',
  async handler(req) {
    const url = new URL(req.url);
    // The Cupboard worker serves the generalized /listings surface (kind-aware,
    // migration 004) and returns the bounded page plus independent pagination
    // and summary metadata. We forward all query
    // params verbatim — incl. `kind` (harness|blueprint|plugin|pack|all) and
    // `project` (project_ref) — plus q / claim / cursor / limit.
    const base = resolveCupboardBaseUrl();
    const upstream = new URL(`${base}/listings`);
    url.searchParams.forEach((v, k) => upstream.searchParams.set(k, v));

    try {
      let res = await fetch(upstream.toString(), {
        headers: { 'User-Agent': 'papercusp-operator/1' },
        signal: AbortSignal.timeout(CUPBOARD_UPSTREAM_TIMEOUT_MS),
      });
      // Transitional: a worker not yet on migration 004 has no /listings — fall
      // back to /harnesses (harness-kind only). Self-heals once the worker ships
      // /listings; until then, non-harness kinds simply return empty (none exist
      // on the old worker anyway).
      if (res.status === 404) {
        const fallback = new URL(`${base}/harnesses`);
        url.searchParams.forEach((v, k) => {
          if (k !== 'kind' && k !== 'project') fallback.searchParams.set(k, v);
        });
        res = await fetch(fallback.toString(), {
          headers: { 'User-Agent': 'papercusp-operator/1' },
          signal: AbortSignal.timeout(CUPBOARD_UPSTREAM_TIMEOUT_MS),
        });
      }
      if (!res.ok) {
        // Transitional: a worker predating a kind (e.g. 'pack' before its
        // migration 006) rejects the kind filter with invalid_field:kind. To
        // the browser that's "no listings of this kind yet", not an error —
        // same degradation fetchCupboardUnits applies for the pack catalog.
        if (res.status === 400 && url.searchParams.get('kind')) {
          const err = (await res.json().catch(() => null)) as { error?: string; field?: string } | null;
          if (err?.error === 'invalid_field' && err.field === 'kind') {
            return Response.json({ listings: [] });
          }
        }
        return Response.json(
          { error: `cupboard: HTTP ${res.status}` },
          { status: res.status },
        );
      }
      const data = await res.json();
      // Worker shape is { results, next_cursor, total, kind_facets }; tolerate
      // legacy { harnesses }/{ listings } without fabricating exact metadata.
      const listings = data?.results ?? data?.harnesses ?? data?.listings ?? [];
      const envelope: Record<string, unknown> = { listings };
      if (data && Object.prototype.hasOwnProperty.call(data, 'next_cursor')) {
        envelope.next_cursor = typeof data.next_cursor === 'string' ? data.next_cursor : null;
      }
      if (typeof data?.total === 'number' && Number.isFinite(data.total)) {
        envelope.total = data.total;
      }
      if (data?.kind_facets && typeof data.kind_facets === 'object' && !Array.isArray(data.kind_facets)) {
        envelope.kind_facets = data.kind_facets;
      }
      return Response.json(envelope);
    } catch (err) {
      return Response.json({ error: String(err) }, { status: 503 });
    }
  },
});

// ─── GET /cupboard/listings/:id ──────────────────────────────────

const getCupboardListing = defineTool({
  method: 'GET',
  path: '/cupboard/listings/:id',
  auth: 'public',
  async handler(_req, ctx) {
    const id = ctx.params.id as string;
    const base = resolveCupboardBaseUrl();
    try {
      let res = await fetch(`${base}/listings/${encodeURIComponent(id)}`, {
        headers: { 'User-Agent': 'papercusp-operator/1' },
        signal: AbortSignal.timeout(CUPBOARD_UPSTREAM_TIMEOUT_MS),
      });
      // Transitional fallback for a pre-migration-004 worker (see list handler).
      if (res.status === 404) {
        res = await fetch(`${base}/harnesses/${encodeURIComponent(id)}`, {
          headers: { 'User-Agent': 'papercusp-operator/1' },
          signal: AbortSignal.timeout(CUPBOARD_UPSTREAM_TIMEOUT_MS),
        });
      }
      if (!res.ok) {
        return Response.json({ error: `cupboard: HTTP ${res.status}` }, { status: res.status });
      }
      const data = await res.json();
      // Worker returns the bare listing row; tolerate { harness }/{ listing } wrappers.
      const listing = data?.harness ?? data?.listing ?? data;
      return Response.json({ listing });
    } catch (err) {
      return Response.json({ error: String(err) }, { status: 503 });
    }
  },
});

// ─── GET /cupboard/bindings ──────────────────────────────────────
// Batch repo→Hive lookup proxy (comb-hive-native-sharing P-011): forwards a
// page of GitHub-search result repo ids to the worker's GET /bindings so the
// picker's search panel can badge "Hive exists / claimed" per result (P-010).
// Public read (no token, like the single /binding lookup). It degrades to an
// empty list when the worker predates the route (404) or is unreachable, so
// the badges are a silent enhancement — never a hard dependency on the worker
// deploy landing (the P-011 worker deploy is owner-coordinated).

export const getCupboardBindings = defineTool({
  method: 'GET',
  path: '/cupboard/bindings',
  auth: 'public',
  async handler(req) {
    const repoIds = (new URL(req.url).searchParams.get('repo_ids') ?? '').trim();
    if (!repoIds) return Response.json({ bindings: [] });
    const base = resolveCupboardBaseUrl();
    try {
      const res = await fetch(`${base}/bindings?repo_ids=${encodeURIComponent(repoIds)}`, {
        headers: { 'User-Agent': 'papercusp-operator/1' },
        signal: AbortSignal.timeout(CUPBOARD_UPSTREAM_TIMEOUT_MS),
      });
      // A worker predating P-011 (no /bindings route) or any upstream failure ⇒
      // "no badges yet", not an error: the search panel stays fully functional.
      if (!res.ok) return Response.json({ bindings: [], unavailable: true });
      const data = (await res.json().catch(() => null)) as { bindings?: unknown } | null;
      const bindings = Array.isArray(data?.bindings) ? data.bindings : [];
      return Response.json({ bindings });
    } catch {
      return Response.json({ bindings: [], unavailable: true });
    }
  },
});

// ─── GET /cupboard/tools ─────────────────────────────────────────
// The marketplace's Tools discovery section (tool-distribution-granularity
// P-006/D-005 + tool-distribution-discovery P-005/P-007): every known tool
// resolved to its provider — the merged local pack catalog (built-ins +
// installed plugins/packs) plus the Cupboard's provides_tools declarations.
// NOT a proxy: the local registries are half the answer, so this derives the
// catalog in-process and folds the Cupboard in. `q` runs capability search
// (relevance-ranked over name/category/capability/provider/description);
// `category` + `status` narrow; `categories` facets ride back for the UI.

const listCupboardTools = defineTool({
  method: 'GET',
  path: '/cupboard/tools',
  auth: 'public',
  async handler(req) {
    const url = new URL(req.url);
    const q = url.searchParams.get('q') ?? undefined;
    const category = url.searchParams.get('category') ?? undefined;
    const statusRaw = url.searchParams.get('status');
    const status =
      statusRaw === 'available' || statusRaw === 'installable' ? statusRaw : undefined;
    if (statusRaw != null && statusRaw !== '' && !status) {
      return Response.json({ error: 'invalid_field', field: 'status' }, { status: 400 });
    }
    try {
      // The projected-tool registry only carries plugin tools once the plugin
      // host has loaded them (lazy on first use) — warm it so a cold operator's
      // first discovery call doesn't under-report installed units.
      await getPluginHost();
      const cat = await derivePackCatalog({ timeoutMs: 8_000 });
      const meta = collectToolMeta();
      return Response.json(buildToolsDiscovery(cat, { q, status, category }, meta));
    } catch (err) {
      return Response.json({ error: String(err) }, { status: 503 });
    }
  },
});

// ─── GET /cupboard/provides ──────────────────────────────────────
// "What provides X" — the human-facing inverse of the dependency resolver
// (tool-distribution-discovery P-006). Given a tool name (`?tool=`, exact) or
// a capability phrase (`?q=`), return the providing pack/plugin/listing +
// install action. An installable match carries `provider.listingId` + `unit`,
// which the UI routes to the listing's install-consent flow (D-005) — the same
// surface the dep gate's `cupboard:install-deps` acts on.

const resolveCupboardProvides = defineTool({
  method: 'GET',
  path: '/cupboard/provides',
  auth: 'public',
  async handler(req) {
    const url = new URL(req.url);
    const tool = url.searchParams.get('tool')?.trim() || undefined;
    const q = url.searchParams.get('q')?.trim() || undefined;
    if (!tool && !q) {
      return Response.json(
        { error: 'missing_query', detail: 'pass ?tool=<name> or ?q=<capability>' },
        { status: 400 },
      );
    }
    try {
      await getPluginHost();
      const cat = await derivePackCatalog({ timeoutMs: 8_000 });
      const meta = collectToolMeta();
      return Response.json(buildToolProvenance(cat, { tool, q }, meta));
    } catch (err) {
      return Response.json({ error: String(err) }, { status: 503 });
    }
  },
});

// ─── Authed forwarding (claim + /cupboard/admin/*) ───────────────────
// Adds the operator's gh-token server-side (browser never holds it), like
// the publish proxy; the Cupboard worker enforces its own per-route gate
// (operator allowlist for /admin/*, repo maintain/admin for claim).

async function forwardToCupboardAuthed(
  pathAndQuery: string,
  init: { method: 'GET' | 'POST'; body?: string },
): Promise<Response> {
  const tokenRes = await getGhAuthToken();
  if (tokenRes.kind !== 'ok') {
    return Response.json({ error: 'gh_auth_required', detail: tokenRes.error.kind }, { status: 401 });
  }
  const url = `${resolveCupboardBaseUrl()}${pathAndQuery}`;
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${tokenRes.token}`,
        'User-Agent': 'papercusp-operator-cupboard-proxy',
        ...(init.body != null ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body,
      signal: AbortSignal.timeout(CUPBOARD_UPSTREAM_TIMEOUT_MS),
    });
  } catch (e) {
    return Response.json(
      { error: 'cupboard_unreachable', detail: (e as Error).message.slice(0, 200) },
      { status: 502 },
    );
  }
  const text = await upstream.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return Response.json(
      { error: 'cupboard_bad_response', detail: text.slice(0, 200), upstream_status: upstream.status },
      { status: 502 },
    );
  }
  return Response.json(parsed, { status: upstream.status });
}

// ─── POST /cupboard/listings/:id/claim ───────────────────────────
// The storefront's Claim CTA (comb-hive-native-sharing-2026-06-11 P-003,
// O-1 resolved per D-005): the CTA shows to any signed-in viewer; the WORKER
// is the enforcement point (maintain/admin via the GitHub API), so this proxy
// only adds the operator's gh token and passes the worker's verdict through
// honestly — 401 gh_auth_required (no local gh login), 403
// insufficient_permission, 409 already_claimed, 410 unlisted.

const claimCupboardListing = defineTool({
  method: 'POST',
  path: '/cupboard/listings/:id/claim',
  auth: 'loopback',
  async handler(_req, ctx) {
    const id = ctx.params.id as string;
    return forwardToCupboardAuthed(`/listings/${encodeURIComponent(id)}/claim`, {
      method: 'POST',
    });
  },
});

const listCupboardReports = defineTool({
  method: 'GET',
  path: '/cupboard/admin/reports',
  auth: 'public',
  async handler(req) {
    const status = new URL(req.url).searchParams.get('status');
    const qs = status ? `?status=${encodeURIComponent(status)}` : '';
    return forwardToCupboardAuthed(`/admin/reports${qs}`, { method: 'GET' });
  },
});

const resolveCupboardReport = defineTool({
  method: 'POST',
  path: '/cupboard/admin/reports/:id/resolve',
  auth: 'loopback',
  async handler(req, ctx) {
    const id = ctx.params.id as string;
    const body = await req.text();
    return forwardToCupboardAuthed(`/admin/reports/${encodeURIComponent(id)}/resolve`, {
      method: 'POST',
      body: body || '{}',
    });
  },
});

const unlistCupboardHarness = defineTool({
  method: 'POST',
  path: '/cupboard/admin/harnesses/:id/unlist',
  auth: 'loopback',
  async handler(req, ctx) {
    const id = ctx.params.id as string;
    const body = await req.text();
    return forwardToCupboardAuthed(`/admin/harnesses/${encodeURIComponent(id)}/unlist`, {
      method: 'POST',
      body: body || '{}',
    });
  },
});

// Pre-publication review queue (learning-packs-2026-06-11 P-020, D-007):
// the desktop moderation surface's view of pending policy-kind listings +
// the approve/reject decision, both forwarded with the operator's gh token.
const listCupboardPending = defineTool({
  method: 'GET',
  path: '/cupboard/admin/pending',
  auth: 'public',
  async handler() {
    return forwardToCupboardAuthed('/admin/pending', { method: 'GET' });
  },
});

const reviewCupboardListing = defineTool({
  method: 'POST',
  path: '/cupboard/admin/listings/:id/review',
  auth: 'loopback',
  async handler(req, ctx) {
    const id = ctx.params.id as string;
    const body = await req.text();
    return forwardToCupboardAuthed(`/admin/listings/${encodeURIComponent(id)}/review`, {
      method: 'POST',
      body: body || '{}',
    });
  },
});

export default [
  listCupboardListings,
  getCupboardListing,
  getCupboardBindings,
  listCupboardTools,
  resolveCupboardProvides,
  claimCupboardListing,
  listCupboardReports,
  resolveCupboardReport,
  unlistCupboardHarness,
  listCupboardPending,
  reviewCupboardListing,
];
