'use client';


/**
 * CupboardClient — the storefront for the Cupboard registry.
 *
 * ONE storefront, four listing kinds (distribution plan D-005;
 * tool-distribution-granularity D-001), each with its own consumer action:
 *   harness   → view-hive (the repo→Hive lookup row, mig 007) or none (legacy —
 *               per-harness join is RETIRED, comb-retire-per-harness-sharing)
 *   blueprint → install   (clone the listing into the installed tier)
 *   plugin    → install   (a distributable plugin — a pack WITH a runtime)
 *   pack      → install   (a runtime-less code-tool pack)
 * Plus the **Tools** discovery view (`?kind=tools`) — tool-level discovery over
 * `GET /api/cupboard/tools`, where each tool resolves to its providing unit.
 *
 * - Kind filter is URL-backed (nuqs `?kind=`), forwarded to the worker via the
 *   `/api/cupboard/listings` proxy.
 * - The per-listing action comes from `listingActionFor()`. Hive-bound harness
 *   rows enter the per-Hive rollup; `blueprint`/`plugin`/`pack` route to the
 *   listing detail where the fork/install is confirmed (the fork/install
 *   EXECUTION engine is owned by E1/E2 `init --from` + the plugin-host
 *   install-consent path — the storefront surfaces the listing + routes to it).
 * - Rendering reads either the live-worker row shape or the aspirational
 *   HarnessListing shape via the `listing*` helpers in cupboard/types.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from '@/lib/router-compat/navigation';
import { useQueryState, parseAsString, parseAsStringEnum } from 'nuqs';
import { Search, Globe, RefreshCw, ExternalLink, GitBranch, Users, Clock, ShieldCheck, AlertTriangle, Plug, Boxes, Hexagon, Package, ArrowLeft, Box, Wrench, Sparkles, Brain, Loader2, KeyRound, ChevronRight, LayoutTemplate, AppWindow, Download, MonitorDown, Ruler, ListChecks, Workflow, Goal, Palette, Fingerprint } from 'lucide-react';
import * as Collapsible from '@radix-ui/react-collapsible';
import { toast } from 'sonner';
import type { HarnessListing, ListingKind, HiveBrowseGroup } from '@papercusp/operator-core/lib/cupboard/types';
import {
  isPubliclyVisible,
  listingActionFor,
  listingKindOf,
  isHiveBlueprintListing,
  isIdentityBlueprintListing,
  listingRepoSlug,
  listingContributorCount,
  listingTopLanguage,
  listingHiveRef,
  listingHiveKey,
  isHivePubkeyRef,
  groupHarnessRowsByHive,
  groupListingsByKind,
  LISTING_ACTION_LABEL,
  type ListingAction,
} from '@papercusp/operator-core/lib/cupboard/types';
import { COLORS, FONTS, RADIUS, SIZES } from './cupboard-theme';
// The standalone-app OS/platform helpers are shared with the detail-page download
// flow (P-005) — one definition of "which OS is this key / this viewer".
import { appPlatformFamilies, viewerOsFamily } from './app-download';
import { ClaimStatusBadge, CLAIM_STATUS_COPY } from '../_components/ClaimStatusBadge';
import { HowSharingWorks } from '../_components/HowSharingWorks';
import { Button } from '../harness/Button';
import { Tooltip } from '../harness/Tooltip';
import { CUPBOARD_LISTING_KIND_TONE } from '../harness/theme';
import { CupboardErrorState, cupboardHttpError } from './CupboardErrorState';
import { ToolsSection } from './ToolsSection';
import InstalledPacksSection from './InstalledPacksSection';
import { useLexicon } from '@/lib/useLexicon';

type ClaimFilter = 'all' | 'claimed' | 'unclaimed';
type KindFilter = 'all' | ListingKind;
/** The tab row's domain: listing-kind filters + the tool-level discovery view.
 *  (cupboard-public-release-2026-07-12 D-002: the old 'hive-blueprint' facet is
 *  RETIRED — pot blueprints now fold into the single 'blueprint' tab, badged
 *  distinctly per-card; the 'template' listing kind gets its own tab for the
 *  app/aspect templates.) */
type ViewFilter = KindFilter | 'tools';

interface CupboardListingsEnvelope {
  listings?: HarnessListing[];
  next_cursor?: string | null;
  total?: number;
  kind_facets?: Partial<Record<ListingKind, number>>;
}

// cupboard-plan-rubric-recipe-sharing-2026-08-21 P-005: 'rubric', 'plan' and
// 'recipe' get their own tabs. They sit AFTER the code kinds and before 'tools'
// because they are the judgment/procedure family (what grades work, what work to
// do, how to do it) rather than things that add runtime surface.
const VIEW_FILTERS: ViewFilter[] = ['all', 'harness', 'app', 'theme', 'blueprint', 'template', 'plugin', 'pack', 'knowledge-pack', 'rubric', 'plan', 'recipe', 'goal', 'tools'];
// Tab labels resolve inside the component via the lexicon — see the
// VIEW_FILTER_LABEL memo in CupboardClient. The `harness` view lists hive-bound
// listings, so its label is the project term ("Pots"/"Hives"), not "Harnesses".

/** Per-kind icon for the card badge + action button. */
function KindIcon({ kind, size = 11 }: { kind: ListingKind; size?: number }) {
  switch (kind) {
    // harness listings are hive-bound (view-hive) on the Comb — the project
    // hexagon matches the "Hives" label + the view-hive action icon.
    case 'harness': return <Hexagon size={size} />;
    case 'blueprint': return <Boxes size={size} />;
    case 'plugin': return <Plug size={size} />;
    case 'pack': return <Box size={size} />;
    case 'knowledge-pack': return <Brain size={size} />;
    case 'template': return <LayoutTemplate size={size} />;
    // an app is a whole distributable application (cupboard-app-distribution).
    case 'app': return <AppWindow size={size} />;
    // The judgment/procedure family (cupboard-plan-rubric-recipe-sharing):
    // a rubric GRADES work, a plan is the work to do, a recipe is how to do it.
    case 'rubric': return <Ruler size={size} />;
    case 'plan': return <ListChecks size={size} />;
    case 'recipe': return <Workflow size={size} />;
    case 'goal': return <Goal size={size} />;
    case 'theme': return <Palette size={size} />;
    default: return <Package size={size} />; // forward-compat: unknown kind from a newer worker
  }
}

/** Icon for a listing's action button (view-hive/install/download). */
function ActionIcon({ action, size = 13 }: { action: ListingAction; size?: number }) {
  switch (action) {
    case 'view-hive': return <Hexagon size={size} />;
    case 'install': return <Plug size={size} />;
    // standalone app → download the platform installer (link handoff).
    case 'download': return <Download size={size} />;
  }
}

const filterButtonStyle = (active: boolean): React.CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  background: active
    ? 'color-mix(in srgb, var(--accent), transparent 78%)'
    : 'var(--bg-2)',
  color: active ? 'var(--accent-soft)' : 'var(--fg-mute)',
  border: active
    ? '1px solid color-mix(in srgb, var(--accent-strong), transparent 54%)'
    : '1px solid var(--border)',
  borderRadius: RADIUS.sm,
  padding: '7px 13px',
  cursor: 'pointer',
  fontSize: 12,
  fontFamily: FONTS.ui,
  boxShadow: 'none',
});

const ghostButtonStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  background: 'var(--bg-2)',
  border: '1px solid var(--border)',
  borderRadius: RADIUS.sm,
  padding: '7px 12px',
  cursor: 'pointer',
  color: 'var(--fg-mute)',
  fontSize: 12,
  fontFamily: FONTS.ui,
};

export default function CupboardClient() {
  const router = useRouter();
  // The project-grouping concept renders via the lexicon (label resolves per the
  // the-hive brand pack) — never hardcoded (unify-launch-mechanics D-003 / P-007).
  const t = useLexicon();
  // Comb storefront filter-tab labels. The project-grouping view (`harness`
  // listings became hive-bound view-hive rows once per-harness sharing was
  // retired and the Hive became the sharing unit —
  // comb-retire-per-harness-sharing-2026-06-11) renders via the lexicon project
  // term: "Pots" (classic) / "Hives" (the-hive). The rest are static labels.
  const VIEW_FILTER_LABEL = useMemo<Record<ViewFilter, string>>(
    () => ({
      all: 'All',
      harness: t('pot', { plural: true }),
      blueprint: 'Blueprints',
      template: 'Templates',
      plugin: 'Plugins',
      pack: 'Packs',
      'knowledge-pack': 'Knowledge Packs',
      // The judgment/procedure family (cupboard-plan-rubric-recipe-sharing P-005).
      // "Plans" is deliberately plain: what installs is a plan TEMPLATE, but the
      // tab names the thing a user is looking for, and the card/detail says so.
      rubric: 'Rubrics',
      plan: 'Plans',
      recipe: 'Recipes',
      goal: 'Goals',
      // The Apps tab itself (adding 'app' to VIEW_FILTERS) lands in P-004; this
      // label keeps the Record<ViewFilter> exhaustive now the 'app' kind exists.
      app: 'Apps',
      theme: 'Themes',
      // datatype/rule/event follow the same precedent as 'app' above: the LABEL
      // lands with the listing kind so Record<ViewFilter> stays exhaustive,
      // while adding each to VIEW_FILTERS (its own tab) is the storefront lane's
      // call. Without these three the map stops compiling the moment the kind
      // exists — which is exactly how this reached the release gate.
      datatype: 'Datatypes',
      rule: 'Rules',
      event: 'Events',
      tools: 'Tools',
    }),
    [t],
  );
  const [q, setQ] = useQueryState('q', parseAsString.withDefault(''));
  const [claimFilter, setClaimFilter] = useQueryState<ClaimFilter>(
    'claim',
    {
      defaultValue: 'all',
      parse: (v) => (['all', 'claimed', 'unclaimed'].includes(v) ? (v as ClaimFilter) : 'all'),
      serialize: (v) => v,
    },
  );
  const [kindFilter, setKindFilter] = useQueryState<ViewFilter>(
    'kind',
    parseAsStringEnum<ViewFilter>(VIEW_FILTERS).withDefault('all'),
  );
  const toolsView = kindFilter === 'tools';
  // Per-Hive rollup (D-005): when set, the storefront narrows to one project
  // ("Hive") and presents its recipe/snapshot/plugin/harness facets grouped by
  // kind. `null` = normal flat browse. A Hive is identified by `project_ref`
  // (or the repo slug for legacy rows) — see `listingHiveRef`.
  const [hive, setHive] = useQueryState('hive', parseAsString);
  // Tools-view discovery filters (P-007) — URL-backed so agents can drive them.
  const [toolStatus, setToolStatus] = useQueryState(
    'toolStatus',
    parseAsStringEnum<'all' | 'available' | 'installable'>(['all', 'available', 'installable']).withDefault('all'),
  );
  const [cat, setCat] = useQueryState('cat', parseAsString);
  const [listings, setListings] = useState<HarnessListing[]>([]);
  const listingsRef = useRef<HarnessListing[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [kindFacets, setKindFacets] = useState<Partial<Record<ListingKind, number>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchListings = useCallback(async (cursor?: string, append = false) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    if (append) setLoadingMore(true);
    else {
      setLoading(true);
      setLoadingMore(false);
      setNextCursor(null);
      setTotal(null);
      setKindFacets(null);
    }
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set('limit', '100');
      if (q) params.set('q', q);
      // The worker's filter param is `claim` (claimed|unclaimed) — `claim_status`
      // was silently ignored, so the filter pills never narrowed anything.
      if (claimFilter !== 'all') params.set('claim', claimFilter);
      if (hive && !isHivePubkeyRef(hive)) {
        // Legacy project rollup: fetch every kind for this project (the
        // worker's server-side `project` filter, forwarded by the proxy) so
        // the rollup can present all facets grouped. The kind tabs are hidden
        // in this mode, so `kind` is intentionally not forwarded.
        params.set('project', hive);
      }
      // A page is bounded. Server-filter selected kinds so a kind whose first
      // row is beyond page one remains discoverable and fetchable.
      if (!hive && kindFilter !== 'all' && kindFilter !== 'tools') {
        params.set('kind', kindFilter);
      }
      // Hive-pubkey rollup has no worker filter yet, so it walks unfiltered
      // pages and narrows client-side. Legacy project rollups use `project`.
      if (cursor) params.set('cursor', cursor);
      const res = await fetch(`/api/cupboard/listings?${params}`, { signal: ctrl.signal });
      if (!res.ok) throw await cupboardHttpError(res);
      const data = (await res.json()) as CupboardListingsEnvelope;
      if (!ctrl.signal.aborted) {
        const incoming = (data.listings ?? []).filter(isPubliclyVisible);
        const prior = append ? listingsRef.current : [];
        const seen = new Set(prior.map((listing) => String(listing.id)));
        const merged = [
          ...prior,
          ...incoming.filter((listing) => {
            const id = String(listing.id);
            if (seen.has(id)) return false;
            seen.add(id);
            return true;
          }),
        ];
        const grew = merged.length > prior.length;
        listingsRef.current = merged;
        setListings(merged);
        setNextCursor(
          append && !grew
            ? null
            : typeof data.next_cursor === 'string'
              ? data.next_cursor
              : null,
        );
        setTotal(typeof data.total === 'number' && Number.isFinite(data.total) ? data.total : null);
        setKindFacets(data.kind_facets && typeof data.kind_facets === 'object' ? data.kind_facets : null);
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setError(String(err));
      }
    } finally {
      if (!ctrl.signal.aborted) {
        if (append) setLoadingMore(false);
        else setLoading(false);
      }
    }
  }, [q, claimFilter, hive, kindFilter]);

  useEffect(() => {
    // The Tools view has its own fetch (ToolsSection); skip the listings read.
    if (toolsView && !hive) return;
    void fetchListings();
  }, [fetchListings, toolsView, hive]);

  // Hive rollup: narrow to the one hive. A pubkey ref matches the member rows'
  // `hive_pubkey` (the hive-native key — comb-hive-native-sharing P-001); a
  // legacy ref matches listingHiveRef (client-side safety filter on top of the
  // server `project` filter). Empty unless `hive` is set.
  const hiveListings = hive
    ? listings.filter((l) =>
        isHivePubkeyRef(hive) ? l.hive_pubkey === hive : listingHiveRef(l) === hive,
      )
    : [];
  const hiveGroups = hive ? groupListingsByKind(hiveListings) : [];
  // The server already filters a selected kind. Keep a client guard for legacy
  // workers that ignore `kind`, and for a page restored during a transition.
  // cupboard-public-release D-002: the old hive-blueprint/blueprint SPLIT is
  // gone — the single 'blueprint' tab now shows ALL blueprint listings (role +
  // pot), distinguished per-card by the pot-template badge. The hive ROLLUP
  // (hiveListings) keeps the raw set.
  const viewListings =
    kindFilter === 'all'
      ? listings
      : listings.filter((l) => listingKindOf(l) === kindFilter);
  const groupedListings = groupListingsByKind(viewListings);
  const facetCount = groupedListings.length;
  // Per-kind counts come from the server's corpus summary.
  //
  // EVERY kind tab is ALWAYS visible, including at count 0
  // [owner 2026-09-15 "make the pills still show just with a 0 counter"].
  // This RETIRES cupboard-public-release-2026-07-12 P-015 ("all tabs non-empty
  // or hidden"), which the owner has now overridden three times — harness
  // 2026-07-14, app 2026-07-14, and every remaining kind here; see that plan's
  // Decisions for the retirement ruling.
  //
  // The rationale that carried the two earlier exceptions generalises: the tab
  // strip is a CATALOGUE of what this Cupboard can share, not an index of what
  // happens to be shared today. Hiding a kind at 0 makes an unpublished surface
  // undiscoverable exactly when it most needs advertising, and it is
  // self-perpetuating — nobody publishes the first plan/recipe/goal because the
  // tab that would show them is hidden until someone does.
  //
  // The counter below renders a real `0` from kindCounts; `—` is retained for
  // the genuinely-unknown state (kindFacets still loading), which is a
  // different fact from zero and must keep reading differently.
  const kindCounts = useMemo(
    () => new Map(
      Object.entries(kindFacets ?? {})
        .filter((entry): entry is [ListingKind, number] => typeof entry[1] === 'number'),
    ),
    [kindFacets],
  );
  const visibleFilters = VIEW_FILTERS;
  const allKindsTotal = kindFacets == null
    ? null
    : Object.values(kindFacets).reduce(
        (sum, count) => sum + (typeof count === 'number' ? count : 0),
        0,
      );
  const summaryMatchesView = !hive || !isHivePubkeyRef(hive);
  const exactViewTotal = summaryMatchesView ? total : null;
  const exactFacetCount = summaryMatchesView && kindFacets
    ? Object.values(kindFacets).filter((count) => typeof count === 'number' && count > 0).length
    : null;
  // Flat hive-first browse (P-002): harness member rows fold into ONE card per
  // owning hive; legacy (pre-hive) harness rows collapse into their own
  // section. Other kinds render as plain listing cards, unchanged.
  const hiveFirstBrowse =
    !hive && !toolsView && (kindFilter === 'all' || kindFilter === 'harness');
  const browseSplit = hiveFirstBrowse
    ? groupHarnessRowsByHive(listings.filter((l) => listingKindOf(l) === 'harness'))
    : null;
  const browseOthers = hiveFirstBrowse
    ? listings.filter((l) => listingKindOf(l) !== 'harness')
    : viewListings;
  const loadedViewCount = hive ? hiveListings.length : viewListings.length;
  const activeViewLabel = toolsView && !hive
    ? 'Tool discovery'
    : hive
      ? `${t('pot')} rollup`
      : kindFilter === 'all'
        ? 'All facets'
        : VIEW_FILTER_LABEL[kindFilter];

  const gridStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
    gap: 14,
  };

  // Per-listing primary action. Hive-bound harness rows enter the per-Hive
  // rollup (per-harness join is retired — comb-retire-per-harness-sharing);
  // blueprint/plugin/pack open the listing detail where the install
  // is confirmed + executed (the engine is E1/E2 / plugin-host — see file head).
  const handleAction = useCallback(
    (listing: HarnessListing) => {
      if (listingActionFor(listing) === 'view-hive') {
        // Hive-native key: the owning hive's pubkey (all member rows share it),
        // so the rollup aggregates the WHOLE hive, not one repo's listings.
        void setHive(listingHiveKey(listing));
        return;
      }
      // fork / install → the listing detail (act-on surface).
      router.push(`/cupboard/${listing.id}`);
    },
    [router, setHive],
  );

  return (
    <div
      style={{
        minHeight: '100%',
        padding: 24,
        background: 'var(--bg)',
      }}
    >
      <div style={{ maxWidth: 1180, margin: '0 auto' }}>
      {/* Header */}
      <div
        style={{
          position: 'relative',
          overflow: 'hidden',
          border: `1px solid ${COLORS.border}`,
          borderRadius: 18,
          padding: 24,
          marginBottom: 16,
          background: 'var(--bg-2)',
          boxShadow: 'none',
        }}
      >
        <div
          aria-hidden
          style={{
            position: 'absolute',
            inset: 0,
            display: 'none',
            pointerEvents: 'none',
          }}
        />
        <div style={{ position: 'relative', display: 'flex', justifyContent: 'space-between', gap: 18, flexWrap: 'wrap' }}>
          <div style={{ maxWidth: 680 }}>
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                color: 'var(--accent-soft)',
                border: '1px solid color-mix(in srgb, var(--accent-strong), transparent 78%)',
                background: 'color-mix(in srgb, var(--accent), transparent 90%)',
                borderRadius: 999,
                padding: '5px 10px',
                fontFamily: FONTS.ui,
                fontSize: 11,
                marginBottom: 12,
              }}
            >
              <Sparkles size={12} /> Distribution shelf
            </div>
            <h1 style={{ fontFamily: FONTS.ui, fontWeight: 760, fontSize: 30, lineHeight: 1.05, color: COLORS.text, margin: 0 }}>
              {t('cupboard')}
            </h1>
            <p style={{ fontFamily: FONTS.ui, fontSize: 13, lineHeight: 1.6, color: COLORS.textMuted, margin: '10px 0 0' }}>
              Discover installable {t('pot', { plural: true, lower: true })}, blueprints, templates, plugins, packs, and tools from the shared Papercusp registry.
            </p>
            {/* P-012: the in-UI "how sharing works" explainer (D-004). */}
            <div style={{ margin: '8px 0 0' }}>
              <HowSharingWorks linkStyle={{ fontFamily: FONTS.ui, fontSize: 12.5, color: COLORS.accent }} />
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(92px, 1fr))', gap: 10, minWidth: 300, flex: '0 1 360px' }}>
            <MetricTile
              label={toolsView && !hive ? 'Mode' : exactViewTotal == null ? 'Loaded' : 'Listings'}
              value={toolsView && !hive ? 'Tools' : String(exactViewTotal ?? loadedViewCount)}
            />
            <MetricTile
              label={exactFacetCount == null ? 'Loaded facets' : 'Facets'}
              value={toolsView && !hive ? '1' : String(exactFacetCount ?? (hive ? hiveGroups.length : facetCount))}
            />
            <MetricTile label="View" value={activeViewLabel} />
          </div>
        </div>
      </div>

      {/* Kind filter tabs (+ the Tools discovery view) — hidden in Hive rollup
          mode (the rollup shows all kinds, grouped) */}
      {!hive && (
        <div
          style={{
            display: 'flex',
            gap: 6,
            marginBottom: 12,
            flexWrap: 'wrap',
            padding: 6,
            border: `1px solid ${COLORS.border}`,
            borderRadius: 999,
            background: 'var(--bg-2)',
            width: 'fit-content',
            maxWidth: '100%',
          }}
        >
          {visibleFilters.map((k) => (
            <button
              key={k}
              onClick={() => void setKindFilter(k === 'all' ? null : k)}
              data-testid={`cupboard-kind-tab-${k}`}
              aria-pressed={kindFilter === k}
              style={filterButtonStyle(kindFilter === k)}
            >
              {k === 'tools' ? (
                <Wrench size={11} />
              ) : k !== 'all' ? (
                <KindIcon kind={k} />
              ) : null}
              {VIEW_FILTER_LABEL[k]}
              {k !== 'tools' && (
                <span data-testid={`cupboard-kind-count-${k}`} style={{ opacity: 0.72 }}>
                  {k === 'all' ? allKindsTotal ?? '—' : kindCounts.get(k as ListingKind) ?? '—'}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Hive rollup header — "this Hive and its facets together" (D-005) */}
      {hive && (
        <div
          data-testid="cupboard-hive-header"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: SIZES.sm,
            marginBottom: 12,
            flexWrap: 'wrap',
            padding: 12,
            border: `1px solid ${COLORS.border}`,
            borderRadius: RADIUS.lg,
            background: 'var(--bg-2)',
          }}
        >
          <button
            onClick={() => void setHive(null)}
            data-testid="cupboard-hive-back"
            style={ghostButtonStyle}
          >
            <ArrowLeft size={13} /> All listings
          </button>
          <span
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              fontFamily: FONTS.ui, fontSize: 13, color: COLORS.text,
            }}
          >
            <Package size={14} /> {t('pot')}:{' '}
            <strong style={{ fontFamily: FONTS.mono }} data-testid="cupboard-hive-name">
              {hiveListings.find((l) => l.hive_title)?.hive_title ?? hive}
            </strong>
          </span>
        </div>
      )}

      {/* Hive header card — the hive as the joinable unit (P-001): title,
          member count, claim rollup, directory visibility, Join CTA. Hidden
          while the page is still loading so the empty-state stays honest. */}
      {hive && !loading && !error && (
        <HiveRollupHeaderCard
          hiveRef={hive}
          members={hiveListings.filter((l) => listingKindOf(l) === 'harness')}
          onClaimed={() => void fetchListings()}
        />
      )}

      {/* Search + claim filter bar */}
      <div
        style={{
          display: 'flex',
          gap: SIZES.sm,
          marginBottom: 16,
          flexWrap: 'wrap',
          alignItems: 'center',
          padding: 12,
          border: `1px solid ${COLORS.border}`,
          borderRadius: RADIUS.lg,
          background: 'var(--bg-2)',
          boxShadow: 'none',
        }}
      >
        <div style={{ position: 'relative', flex: 1, minWidth: 200 }}>
          <Search
            size={14}
            style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: COLORS.textMuted }}
          />
          <input
            value={q}
            onChange={(e) => void setQ(e.target.value || null)}
            placeholder={`Search the ${t('cupboard')}…`}
            className="pc-input"
            style={{ paddingLeft: 32, fontFamily: FONTS.ui }}
          />
        </div>

        {!toolsView && <div style={{ display: 'flex', gap: 4 }}>
          {(['all', 'claimed', 'unclaimed'] as ClaimFilter[]).map((f) => (
            <button
              key={f}
              onClick={() => void setClaimFilter(f)}
              style={{ ...filterButtonStyle(claimFilter === f), textTransform: 'capitalize' }}
            >
              {f}
            </button>
          ))}
        </div>}

        {!toolsView && <Tooltip label="Refresh"><button
          onClick={() => void fetchListings()}
          disabled={loading || loadingMore}
          style={ghostButtonStyle}

        >
          <RefreshCw size={14} style={loading ? { animation: 'spin 1s linear infinite' } : {}} />
        </button></Tooltip>}

        {/* WI-3259: an explicit, unmissable loading affordance — the spinning
            refresh icon alone was too subtle (owner report: "no indication
            that anything is being loaded"). Shown for any in-flight fetch
            (initial load AND refetch), listing view only (Tools has its own). */}
        {!toolsView && loading && (
          <span
            data-testid="cupboard-loading-indicator"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              fontFamily: FONTS.ui, fontSize: 12, color: COLORS.textMuted,
            }}
          >
            <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} />
            Loading…
          </span>
        )}
      </div>

      {/* Tools discovery view (?kind=tools) — tool-level discovery with its own
          fetch/empty/error handling; the listing branches below are skipped. */}
      {toolsView && !hive ? (
        <ToolsSection
          q={q}
          onOpenListing={(id) => router.push(`/cupboard/${id}`)}
          status={toolStatus}
          category={cat}
          onStatusChange={(s) => void setToolStatus(s === 'all' ? null : s)}
          onCategoryChange={(c) => void setCat(c)}
        />
      ) : (
        <>
      {/* Per-pot installed-packs overview (P-016): on the Knowledge Packs tab in
          flat browse, show what packs are installed in a chosen pot — each row
          deep-links to its detail page for the actual manage controls. */}
      {kindFilter === 'knowledge-pack' && !hive && (
        <InstalledPacksSection listings={listings} onOpen={(id) => router.push(`/cupboard/${id}`)} />
      )}

      {/* Error — friendly copy + inline Retry (EI-215) */}
      {error && !loading && (
        <CupboardErrorState raw={error} what="listings" onRetry={() => void fetchListings()} />
      )}

      {/* Results — empty state (kind-aware in flat mode, Hive-aware in rollup mode) */}
      {!loading && !error && (hive ? hiveGroups.length === 0 : listings.length === 0) && (
        <div
          style={{
            color: COLORS.textMuted,
            fontSize: 12,
            textAlign: 'center',
            padding: '44px 18px',
            border: `1px dashed ${COLORS.borderStrong}`,
            borderRadius: RADIUS.lg,
            background: 'var(--bg-2)',
          }}
        >
          {hive
            ? isHivePubkeyRef(hive)
              ? `No ${t('cupboard')} listings found for this ${t('pot', { lower: true })} on this page${q ? ` matching "${q}"` : ''}.`
              : `No listings found for ${t('pot')} "${hive}"${q ? ` matching "${q}"` : ''}.`
            : `No ${kindFilter === 'all' ? 'listings' : VIEW_FILTER_LABEL[kindFilter].toLowerCase()} found${q ? ` matching "${q}"` : ''}.`}
        </div>
      )}

      {/* WI-3259: a refetch (q/claim/hive change — kind-tab switches no longer
          refetch at all) used to leave the PREVIOUS tab's cards frozen with no
          affordance until the new data swapped in. Dim + suspend interaction
          on the stale grid while a fetch with existing data is in flight, so
          the freeze reads as "loading" instead of "broken". Never applies to
          the true first load (nothing to dim yet — the empty/error states
          above own that path). */}
      <div
        data-testid="cupboard-results"
        aria-busy={loading}
        style={
          loading && (hive ? hiveGroups.length > 0 : listings.length > 0)
            ? { opacity: 0.45, pointerEvents: 'none', transition: 'opacity 120ms ease' }
            : { transition: 'opacity 120ms ease' }
        }
      >
      {hive ? (
        /* Hive rollup — the Hive's facets grouped by kind (D-005) */
        <div data-testid="cupboard-hive-rollup">
          {hiveGroups.map((group) => (
            <section
              key={group.kind}
              data-testid={`cupboard-hive-group-${group.kind}`}
              style={{ marginBottom: SIZES.lg }}
            >
              <h2
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  fontFamily: FONTS.ui, fontWeight: 600, fontSize: 14, color: COLORS.text,
                  margin: `0 0 ${SIZES.sm}`,
                }}
              >
                <KindIcon kind={group.kind} size={13} />
                {VIEW_FILTER_LABEL[group.kind]}
                <span style={{ color: COLORS.textMuted, fontWeight: 400, fontSize: 12 }}>
                  {group.listings.length}
                </span>
              </h2>
              <div style={gridStyle}>
                {group.listings.map((listing) => (
                  <ListingCard
                    key={listing.id}
                    listing={listing}
                    onAction={() => handleAction(listing)}
                    onDetail={() => router.push(`/cupboard/${listing.id}`)}
                    suppressViewHive
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : browseSplit ? (
        /* Hive-first flat browse (P-002): one card per hive, plain cards for
           the other kinds, legacy pre-hive harness rows collapsed below. */
        <>
          {/* Pots-tab empty state [owner 2026-07-14]: the Pots tab always
              renders (see visibleFilters), so when no public pot has been
              published it must explain itself + point at how to publish, rather
              than showing a blank grid. Scoped to the Pots view only — on 'all'
              the other kinds fill the grid, so a "no pots" notice would be noise. */}
          {kindFilter === 'harness' &&
            browseSplit.hives.length === 0 &&
            browseSplit.legacy.length === 0 && (
              <div
                data-testid="cupboard-pots-empty"
                style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
                  textAlign: 'center', padding: '32px 20px', marginBottom: SIZES.lg,
                  border: `1px dashed ${COLORS.border}`, borderRadius: RADIUS.lg,
                  background: COLORS.surface,
                }}
              >
                <Package size={22} style={{ color: COLORS.textMuted }} />
                <span style={{ fontFamily: FONTS.ui, fontWeight: 600, fontSize: 15, color: COLORS.text }}>
                  No shared {t('pot', { plural: true, lower: true })} yet
                </span>
                <p style={{ fontFamily: FONTS.ui, fontSize: 13, color: COLORS.textMuted, maxWidth: 460, margin: 0, lineHeight: 1.55 }}>
                  {t('pot', { plural: true })} are shared workspaces — a team's agents, knowledge, and tools
                  in one place. When someone publishes a {t('pot', { lower: true })} publicly, it appears here
                  to discover and join. Publish one of yours from its settings to be the first.
                </p>
              </div>
            )}
          <div style={gridStyle}>
            {browseSplit.hives.map((group) => (
              <HiveBrowseCard
                key={group.hivePubkey}
                group={group}
                onOpen={() => void setHive(group.hivePubkey)}
              />
            ))}
            {browseOthers.map((listing) => (
              <ListingCard
                key={listing.id}
                listing={listing}
                hiveRef={listingHiveKey(listing)}
                onHive={() => void setHive(listingHiveKey(listing))}
                onAction={() => handleAction(listing)}
                onDetail={() => router.push(`/cupboard/${listing.id}`)}
              />
            ))}
          </div>
          {browseSplit.legacy.length > 0 && (
            <Collapsible.Root data-testid="cupboard-legacy-section" style={{ marginTop: SIZES.lg }}>
              <Collapsible.Trigger asChild>
                <button style={{ ...ghostButtonStyle, gap: 4 }} data-testid="cupboard-legacy-toggle">
                  <ChevronRight size={13} className="pc-collapsible-chevron" />
                  Legacy listings ({browseSplit.legacy.length}) — pre-{t('pot', { lower: true })} shared harnesses
                </button>
              </Collapsible.Trigger>
              <Collapsible.Content>
                <p style={{ fontFamily: FONTS.ui, fontSize: 12, color: COLORS.textMuted, margin: '10px 0' }}>
                  These listings predate {t('pot', { plural: true, lower: true })}, and per-harness joining is retired — they are
                  reference rows only. Sharing and joining happen at the {t('pot', { lower: true })} level now.
                </p>
                <div style={gridStyle}>
                  {browseSplit.legacy.map((listing) => (
                    <ListingCard
                      key={listing.id}
                      listing={listing}
                      onAction={() => handleAction(listing)}
                      onDetail={() => router.push(`/cupboard/${listing.id}`)}
                    />
                  ))}
                </div>
              </Collapsible.Content>
            </Collapsible.Root>
          )}
        </>
      ) : (
        /* Flat browse (single non-harness kind) — each card links to its Hive
           via the Hive chip. */
        <>
          {/* Apps-tab empty state [owner 2026-07-14 "1. yes" — Apps tab
              always-visible]: the Apps tab always renders (see visibleFilters), so
              when no app has been published (and other kinds populate `listings`,
              so the generic empty state above doesn't fire) it must explain itself
              rather than show a blank grid. Scoped to the Apps view only. */}
          {kindFilter === 'app' && browseOthers.length === 0 && (
            <div
              data-testid="cupboard-apps-empty"
              style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
                textAlign: 'center', padding: '32px 20px', marginBottom: SIZES.lg,
                border: `1px dashed ${COLORS.border}`, borderRadius: RADIUS.lg,
                background: COLORS.surface,
              }}
            >
              <AppWindow size={22} style={{ color: COLORS.textMuted }} />
              <span style={{ fontFamily: FONTS.ui, fontWeight: 600, fontSize: 15, color: COLORS.text }}>
                No apps yet
              </span>
              <p style={{ fontFamily: FONTS.ui, fontSize: 13, color: COLORS.textMuted, maxWidth: 460, margin: 0, lineHeight: 1.55 }}>
                Apps are whole applications built on the platform — a teammate publishes one and
                you download and run it right from here. When someone publishes an app, it appears
                here to discover and install.
              </p>
            </div>
          )}
          <div style={gridStyle}>
            {browseOthers.map((listing) => (
              <ListingCard
                key={listing.id}
                listing={listing}
                hiveRef={listingHiveKey(listing)}
                onHive={() => void setHive(listingHiveKey(listing))}
                onAction={() => handleAction(listing)}
                onDetail={() => router.push(`/cupboard/${listing.id}`)}
              />
            ))}
          </div>
        </>
      )}
      </div>
      {!loading && !error && (nextCursor || exactViewTotal != null) && (
        <div
          data-testid="cupboard-pagination"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12,
            marginTop: SIZES.lg, fontFamily: FONTS.ui, fontSize: 12, color: COLORS.textMuted,
          }}
        >
          <span>
            {exactViewTotal == null
              ? `${loadedViewCount} loaded`
              : `Showing ${loadedViewCount} of ${exactViewTotal}`}
          </span>
          {nextCursor && (
            <button
              type="button"
              data-testid="cupboard-load-more"
              onClick={() => void fetchListings(nextCursor, true)}
              disabled={loadingMore}
              style={ghostButtonStyle}
            >
              {loadingMore ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : null}
              {loadingMore ? 'Loading…' : 'Load more'}
            </button>
          )}
        </div>
      )}
        </>
      )}
      </div>
    </div>
  );
}

// ─── ListingCard ─────────────────────────────────────────────────

export function ListingCard({
  listing,
  onAction,
  onDetail,
  hiveRef,
  onHive,
  suppressViewHive,
}: {
  listing: HarnessListing;
  onAction: () => void;
  onDetail: () => void;
  /** The Hive (project) this listing belongs to. When set with `onHive`, renders
   *  a clickable chip that enters the per-Hive rollup. Omit in rollup mode. */
  hiveRef?: string;
  onHive?: () => void;
  /** Rollup mode (P-001): the card already sits inside the hive's rollup, so a
   *  per-row View Hive button is redundant — suppress it. Fork/Install stay. */
  suppressViewHive?: boolean;
}) {
  const t = useLexicon();
  const kind = listingKindOf(listing);
  // D-002: a pot blueprint (blueprint_kind='pot') is a POT TEMPLATE — badged
  // distinctly inside the single Blueprints tab (the old separate tab is gone).
  const isPotTemplate = isHiveBlueprintListing(listing);
  // portable-identity-packages P-016: an identity blueprint is badged too.
  const isIdentity = isIdentityBlueprintListing(listing);
  const rawAction = listingActionFor(listing);
  const action = suppressViewHive && rawAction === 'view-hive' ? null : rawAction;
  const repoSlug = listingRepoSlug(listing);
  const contributors = listingContributorCount(listing);
  const language = listingTopLanguage(listing);
  const tone = CUPBOARD_LISTING_KIND_TONE[kind];
  // App distribution (P-004): a standalone app advertises the OS families its
  // latest.json carries; its download CTA is platform-aware ("Get for macOS")
  // when the viewer's OS is one of them, else a plain "Download". (The actual
  // OS-specific installer resolution is the detail page's job — P-005.)
  const appFamilies = kind === 'app' ? appPlatformFamilies(listing.platforms) : [];
  const appDownloadLabel =
    kind === 'app' && action === 'download'
      ? (() => {
          const os = viewerOsFamily();
          return os && appFamilies.includes(os) ? `Get for ${os}` : LISTING_ACTION_LABEL.download;
        })()
      : null;
  return (
    <div
      className="pc-card"
      style={{
        padding: 16,
        borderRadius: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        cursor: 'default',
        minHeight: 208,
      }}
    >
      <div
        aria-hidden
        style={{
          position: 'absolute',
          inset: '0 0 auto',
          height: 3,
          background: tone.fg,
          opacity: 0.86,
        }}
      />
      {/* Title + kind + claim badge */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <button
          onClick={onDetail}
          style={{
            background: 'none',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
            fontFamily: FONTS.ui,
            fontWeight: 600,
            fontSize: 15,
            lineHeight: 1.3,
            color: COLORS.text,
            textAlign: 'left',
          }}
        >
          {listing.title || listing.slug || repoSlug || 'Untitled'}
        </button>
        <span style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <KindBadge kind={kind} potTemplate={isPotTemplate} identity={isIdentity} />
          <ClaimStatusBadge
            status={listing.claim_status}
            claimantLogin={listing.claimant_github_login}
            claimedAt={listing.claimed_at}
          />
        </span>
      </div>

      {/* Description */}
      {listing.description && (
        <p
          style={{
            fontFamily: FONTS.ui,
            fontSize: 12,
            lineHeight: 1.5,
            color: COLORS.textMuted,
            margin: 0,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {listing.description}
        </p>
      )}

      {/* Tier-A stats (P-076) */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {contributors > 0 && (
          <Stat icon={<Users size={11} />} label={`${contributors} contributors`} />
        )}
        {listing.last_activity_at != null && (
          <Stat
            icon={<Clock size={11} />}
            label={formatRelativeTime(listing.last_activity_at)}
          />
        )}
        {language && (
          <Stat icon={<GitBranch size={11} />} label={language} />
        )}
      </div>

      {/* App platform availability (P-004): the OS families the standalone app's
          latest.json advertises, so the card shows reach without a manifest fetch. */}
      {kind === 'app' && appFamilies.length > 0 && (
        <div
          data-testid="cupboard-app-platforms"
          style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}
        >
          {appFamilies.map((fam) => (
            <span
              key={fam}
              data-platform={fam}
              className="pc-badge"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 3,
                background: tone.bg,
                border: `1px solid ${tone.border}`,
                color: tone.fg,
              }}
            >
              <MonitorDown size={10} /> {fam}
            </span>
          ))}
        </div>
      )}

      <PublisherSignal permission={listing.publisher_permission} />

      {/* Hive chip — enters the per-Hive rollup (D-005). Hidden when ungroupable
          (no project identity) or in rollup mode (no onHive passed). */}
      {hiveRef && onHive && (
        <Tooltip label={`View all of ${hiveRef}'s listings`}><button
          onClick={onHive}
          data-testid="cupboard-hive-chip"
          data-hive={hiveRef}

          style={{
            alignSelf: 'flex-start',
            display: 'inline-flex', alignItems: 'center', gap: 4,
            background: 'var(--bg-2)',
            border: `1px solid ${COLORS.border}`,
            borderRadius: 999,
            padding: '3px 8px',
            cursor: 'pointer',
            fontSize: 10,
            fontFamily: FONTS.mono,
            color: COLORS.textMuted,
          }}
        >
          <Package size={10} /> {hiveRef}
        </button></Tooltip>
      )}

      {/* Footer — per-listing action. Legacy harness rows (no owning Hive)
          have no primary action: per-harness join is retired. */}
      <div style={{ display: 'flex', gap: 8, marginTop: 'auto', paddingTop: 4 }}>
        {action && (
        <Button
          size="lg"
          variant="primary"
          onClick={onAction}
          data-testid="cupboard-action"
          data-action={action}
          style={{ flex: 1 }}
        >
          <ActionIcon action={action} /> {action === 'view-hive' ? `View ${t('pot')}` : (appDownloadLabel ?? LISTING_ACTION_LABEL[action])}
        </Button>
        )}
        {repoSlug && (
          <Button asChild size="lg" variant="accent">
            <a
              href={`https://github.com/${repoSlug}`}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Open github.com/${repoSlug}`}
            >
              <ExternalLink size={13} />
            </a>
          </Button>
        )}
      </div>
    </div>
  );
}

/** Small kind tag on a card. A pot blueprint (`potTemplate`) reads as
 *  "pot template" with a hexagon glyph, distinguishing it inside the single
 *  Blueprints tab (D-002) from an ordinary role blueprint. */
function KindBadge({ kind, potTemplate, identity }: { kind: ListingKind; potTemplate?: boolean; identity?: boolean }) {
  const t = useLexicon();
  const tone = CUPBOARD_LISTING_KIND_TONE[kind];
  const label = potTemplate ? `${t('pot', { lower: true })} template` : identity ? 'identity' : kind;
  const icon = potTemplate ? <Hexagon size={10} /> : identity ? <Fingerprint size={10} /> : <KindIcon kind={kind} size={10} />;
  return (
    <span
      data-testid="cupboard-kind-badge"
      data-kind={kind}
      data-pot-template={potTemplate ? 'true' : undefined}
      data-identity={identity ? 'true' : undefined}
      className="pc-badge"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 3,
        background: tone.bg,
        border: `1px solid ${tone.border}`,
        color: tone.fg,
      }}
    >
      {icon} {label}
    </span>
  );
}

function Stat({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        color: COLORS.textMuted,
        fontSize: 11,
        fontFamily: FONTS.ui,
        border: `1px solid ${COLORS.border}`,
        background: 'var(--bg-1)',
        borderRadius: 999,
        padding: '3px 7px',
      }}
    >
      {icon}
      {label}
    </div>
  );
}

function MetricTile({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        minWidth: 0,
        border: `1px solid ${COLORS.border}`,
        borderRadius: RADIUS.lg,
        padding: '11px 12px',
        background: 'var(--bg-1)',
      }}
    >
      <div style={{ fontFamily: FONTS.ui, fontSize: 10, textTransform: 'uppercase', color: COLORS.textDim }}>
        {label}
      </div>
      <div style={{ marginTop: 4, fontFamily: FONTS.ui, fontSize: 15, fontWeight: 700, color: COLORS.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {value}
      </div>
    </div>
  );
}

/** GitHub repo permission levels that mean the publisher is an actual
 *  collaborator on the bound repo (not just a public-repo reader). */
const PUBLISHER_COLLAB_ROLES = new Set(['admin', 'maintain', 'write', 'triage']);

/**
 * Trust signal: was this listing published by an actual repo collaborator,
 * or by some GitHub user who merely can read a public repo? Provisional
 * (unclaimed) listings are NOT ownership claims (see the
 * cupboard-provisional-listing-trust memo), so the unverified case is
 * flagged rather than hidden. `null`/undefined permission (legacy rows
 * predating Cupboard migration 002) renders nothing.
 */
function PublisherSignal({ permission }: { permission?: string | null }) {
  if (permission == null) return null;
  const isCollaborator = PUBLISHER_COLLAB_ROLES.has(permission);
  return (
    <div
      data-testid="cupboard-publisher-signal"
      data-collaborator={isCollaborator ? 'true' : 'false'}
      title={
        isCollaborator
          ? `Published by a repo collaborator (${permission} access).`
          : 'Published by someone who is not a collaborator on this repo. A provisional listing is not an ownership claim.'
      }
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        alignSelf: 'flex-start',
        fontSize: 11,
        fontFamily: FONTS.ui,
        color: isCollaborator ? 'var(--good)' : 'var(--warn)',
        border: `1px solid ${isCollaborator ? 'color-mix(in srgb, var(--good), transparent 76%)' : 'var(--warn-border)'}`,
        background: isCollaborator ? 'color-mix(in srgb, var(--good), transparent 88%)' : 'var(--warn-bg)',
        borderRadius: 999,
        padding: '3px 8px',
      }}
    >
      {isCollaborator ? (
        <>
          <ShieldCheck size={11} /> publisher: collaborator
        </>
      ) : (
        <>
          <AlertTriangle size={11} /> publisher: not a collaborator
        </>
      )}
    </div>
  );
}

function formatRelativeTime(epochMs: number): string {
  const diff = Date.now() - epochMs;
  const days = Math.floor(diff / 86400000);
  if (days === 0) return 'active today';
  if (days === 1) return '1 day ago';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months === 1) return '1 month ago';
  return `${months} months ago`;
}

// ─── Hive-first browse + rollup (comb-hive-native-sharing-2026-06-11) ───────

/**
 * Claim rollup for a hive's member listings — "x/y claimed" as a trust signal.
 * Counts are page-scoped (the worker paginates), which the tooltip says.
 */
function ClaimRollupPill({ claimed, total }: { claimed: number; total: number }) {
  if (total === 0) return null;
  const all = claimed === total && total > 0;
  return (
    <Tooltip
      label={`${claimed} of ${total} member-repo listings are claimed. ${CLAIM_STATUS_COPY.claimed} Counts reflect the listings on this page of results.`}
    >
      <span
        data-testid="cupboard-claim-rollup"
        className="pc-badge"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          color: all ? 'var(--good)' : 'var(--fg-dim)',
          background: all ? 'color-mix(in srgb, var(--good), transparent 88%)' : 'var(--bg-2)',
          border: `1px solid ${all ? 'color-mix(in srgb, var(--good), transparent 76%)' : 'var(--border)'}`,
        }}
      >
        <ShieldCheck size={10} /> {claimed}/{total} claimed
      </span>
    </Tooltip>
  );
}

/**
 * One Hive in the flat browse (P-002): member repos grouped under the hive's
 * title with a claim rollup; the primary action enters the per-Hive rollup.
 */
export function HiveBrowseCard({ group, onOpen }: { group: HiveBrowseGroup; onOpen: () => void }) {
  const t = useLexicon();
  const title = group.hiveTitle ?? listingRepoSlug(group.members[0]) ?? `Untitled ${t('pot', { lower: true })}`;
  const repos = group.members.map(listingRepoSlug).filter(Boolean);
  const shown = repos.slice(0, 4);
  return (
    <div
      className="pc-card"
      data-testid="cupboard-hive-card"
      data-hive-pubkey={group.hivePubkey}
      style={{
        padding: 16,
        borderRadius: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        cursor: 'default',
        minHeight: 208,
      }}
    >
      <div
        aria-hidden
        style={{
          position: 'absolute',
          inset: '0 0 auto',
          height: 3,
          background: 'var(--accent-soft)',
          opacity: 0.86,
        }}
      />
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <span
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            fontFamily: FONTS.ui, fontWeight: 600, fontSize: 15, lineHeight: 1.3, color: COLORS.text,
          }}
        >
          <Hexagon size={14} style={{ color: 'var(--accent-soft)', flexShrink: 0 }} /> {title}
        </span>
        <ClaimRollupPill claimed={group.claimedCount} total={group.members.length} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {shown.map((slug) => (
          <span key={slug} style={{ fontFamily: FONTS.mono, fontSize: 11, color: COLORS.textMuted, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <GitBranch size={10} /> {slug}
          </span>
        ))}
        {repos.length > shown.length && (
          <span style={{ fontFamily: FONTS.ui, fontSize: 11, color: COLORS.textDim }}>
            +{repos.length - shown.length} more
          </span>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 'auto', paddingTop: 4, alignItems: 'center' }}>
        <Button
          size="lg"
          variant="primary"
          onClick={onOpen}
          data-testid="cupboard-hive-card-open"
          style={{ flex: 1 }}
        >
          <Hexagon size={13} /> View {t('pot')}
        </Button>
        <Tooltip label={`Member-repo listings on this page of results — the ${t('pot', { lower: true })} may list more.`}>
          <span style={{ fontFamily: FONTS.ui, fontSize: 11, color: COLORS.textMuted, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Users size={11} /> {group.members.length}
          </span>
        </Tooltip>
      </div>
    </div>
  );
}

/** The /api/discovery/pots row shape (the directory's HTTP projection). */
interface DirectoryHiveRow {
  potId: string;
  title: string;
  description: string;
  owner: string;
  visibility: 'public' | 'invite';
  memberLinks: string[];
  memberCount: number;
  hivePubkey: string | null;
}

/**
 * The hive header card in rollup mode (P-001): the hive as the joinable unit.
 * Resolves the live directory announce by `hive_pubkey` (the directory is the
 * content authority; the Cupboard rows are the lookup index) for visibility +
 * member links, joins via the composed join-hive flow, and — when no announce
 * is resolvable (offline directory / invite or private hive) — shows an honest
 * empty state with the invite-link affordance. Claim (P-003, O-1 per D-005):
 * offered on unclaimed member listings to any viewer; the worker enforces
 * maintain/admin and a refusal surfaces honestly.
 */
export function HiveRollupHeaderCard({
  hiveRef,
  members,
  onClaimed,
}: {
  hiveRef: string;
  members: HarnessListing[];
  onClaimed: () => void;
}) {
  const t = useLexicon();
  const hivePubkey = isHivePubkeyRef(hiveRef)
    ? hiveRef
    : members.find((m) => m.hive_pubkey)?.hive_pubkey ?? null;
  // Directory + join + claim state is all fetch/lifecycle state (useState per
  // the nuqs rule); the rollup selection itself lives in ?hive=.
  const [dirRows, setDirRows] = useState<DirectoryHiveRow[] | null>(null);
  const [dirError, setDirError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [joinMsg, setJoinMsg] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [inviteLink, setInviteLink] = useState('');
  const [inviteMsg, setInviteMsg] = useState<string | null>(null);

  const loadDirectory = useCallback(async () => {
    try {
      const res = await fetch('/api/discovery/pots');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { rows?: DirectoryHiveRow[] };
      setDirRows(data.rows ?? []);
      setDirError(null);
    } catch (e) {
      setDirRows([]);
      setDirError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void loadDirectory();
  }, [loadDirectory]);

  const announce = hivePubkey
    ? dirRows?.find((r) => r.hivePubkey === hivePubkey) ?? null
    : null;
  const title =
    members.find((m) => m.hive_title)?.hive_title ??
    announce?.title ??
    (isHivePubkeyRef(hiveRef) ? t('pot') : hiveRef);
  const claimedCount = members.filter((m) => m.claim_status === 'claimed').length;
  const unclaimed = members.filter((m) => m.claim_status === 'unclaimed');
  const joinable = !!announce && announce.memberLinks.length > 0;

  const join = useCallback(async () => {
    if (!announce || announce.memberLinks.length === 0) return;
    setJoining(true);
    setJoinMsg('Joining…');
    // Join the HIVE, not N loose harnesses — the composed join-hive call runs
    // every member join and materializes the local hive view (same treatment
    // as the workbench directory panel).
    try {
      const res = await fetch('/api/discovery/join-pot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          potId: announce.potId,
          title: announce.title,
          memberLinks: announce.memberLinks,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        potSlug?: string;
        members?: { ok: boolean }[];
        error?: string;
      };
      const okCount = body.members?.filter((m) => m.ok).length ?? 0;
      setJoinMsg(
        res.ok && body.ok
          ? `Joined ${t('pot', { lower: true })} '${body.potSlug}' — ${okCount}/${announce.memberLinks.length} member(s)`
          : `Join failed: ${body.error ?? `HTTP ${res.status}`}${okCount ? ` (${okCount} member(s) joined)` : ''}`,
      );
    } catch (e) {
      setJoinMsg(`Join failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    setJoining(false);
  }, [announce, t]);

  // Claim every unclaimed member listing through the loopback proxy; the
  // worker is the enforcement point, so report its per-repo verdicts honestly.
  const claimAll = useCallback(async () => {
    if (unclaimed.length === 0 || claiming) return;
    setClaiming(true);
    let ok = 0;
    const failures: string[] = [];
    for (const m of unclaimed) {
      const repo = listingRepoSlug(m) || String(m.id);
      try {
        const res = await fetch(`/api/cupboard/listings/${encodeURIComponent(String(m.id))}/claim`, {
          method: 'POST',
        });
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (res.ok && body.ok) {
          ok += 1;
        } else if (body.error === 'gh_auth_required') {
          failures.push(`${repo}: GitHub sign-in required (run \`gh auth login\` on this box)`);
        } else if (body.error === 'insufficient_permission') {
          failures.push(`${repo}: GitHub says you don't have maintain/admin on this repo`);
        } else if (body.error === 'already_claimed') {
          failures.push(`${repo}: already claimed by someone else`);
        } else {
          failures.push(`${repo}: ${body.error ?? `HTTP ${res.status}`}`);
        }
      } catch (e) {
        failures.push(`${repo}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (ok > 0) toast.success(`Claimed ${ok} listing${ok === 1 ? '' : 's'}.`);
    if (failures.length > 0) toast.error(`Not claimed — ${failures.join('; ')}`);
    setClaiming(false);
    if (ok > 0) onClaimed();
  }, [unclaimed, claiming, onClaimed]);

  // Invitee path: joining the invite-scoped directory topic ingests the hive's
  // announce, after which the Join CTA above lights up.
  const submitInvite = useCallback(async () => {
    const link = inviteLink.trim();
    if (!link) return;
    setInviteMsg('Joining the invite topic…');
    try {
      const res = await fetch('/api/discovery/join-invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ link }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (res.ok && body.ok) {
        setInviteMsg(`Invite topic joined — waiting for the ${t('pot', { lower: true })} to announce. Refreshing…`);
        setTimeout(() => void loadDirectory(), 1500);
      } else {
        setInviteMsg(`Invite failed: ${body.error ?? `HTTP ${res.status}`}`);
      }
    } catch (e) {
      setInviteMsg(`Invite failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [inviteLink, loadDirectory, t]);

  return (
    <div
      data-testid="cupboard-hive-rollup-card"
      className="pc-card"
      style={{
        padding: 16,
        borderRadius: 16,
        marginBottom: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        cursor: 'default',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontFamily: FONTS.ui, fontWeight: 650, fontSize: 16, color: COLORS.text }}>
          <Hexagon size={15} style={{ color: 'var(--accent-soft)' }} />
          <span data-testid="cupboard-hive-rollup-title">{title}</span>
          {announce && (
            <Tooltip
              label={
                announce.visibility === 'public'
                  ? 'Published on the public P2P directory — anyone can discover and join it.'
                  : 'Listed via an invite topic — only peers holding the invite link discover it.'
              }
            >
              <span
                data-testid="cupboard-hive-visibility"
                data-visibility={announce.visibility}
                className="pc-badge"
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  color: 'var(--fg-dim)', background: 'var(--bg-2)', border: '1px solid var(--border)',
                }}
              >
                {announce.visibility === 'public' ? <Globe size={10} /> : <KeyRound size={10} />}
                {announce.visibility}
              </span>
            </Tooltip>
          )}
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Tooltip label={announce ? `Member count from the ${t('pot', { lower: true })}'s live directory announce.` : `Member-repo listings on this page of results — the ${t('pot', { lower: true })} may list more.`}>
            <span style={{ fontFamily: FONTS.ui, fontSize: 11, color: COLORS.textMuted, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Users size={11} /> {announce ? announce.memberCount : members.length} member{(announce ? announce.memberCount : members.length) === 1 ? '' : 's'}
            </span>
          </Tooltip>
          <ClaimRollupPill claimed={claimedCount} total={members.length} />
        </span>
      </div>

      {announce?.owner && (
        <span style={{ fontFamily: FONTS.ui, fontSize: 11, color: COLORS.textMuted }}>
          owner: {announce.owner}
        </span>
      )}

      {dirRows === null ? (
        <span style={{ fontFamily: FONTS.ui, fontSize: 12, color: COLORS.textMuted, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> Checking the {t('pot', { lower: true })} directory…
        </span>
      ) : joinable ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Button
            size="lg"
            variant="primary"
            onClick={() => void join()}
            disabled={joining}
            data-testid="cupboard-hive-join"
            style={{ opacity: joining ? 0.7 : 1, cursor: joining ? 'default' : 'pointer' }}
          >
            {joining ? (
              <><Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> Joining…</>
            ) : (
              <><Hexagon size={13} /> Join {t('pot', { lower: true })}</>
            )}
          </Button>
          {joinMsg && (
            <span data-testid="cupboard-hive-join-msg" style={{ fontFamily: FONTS.ui, fontSize: 12, color: COLORS.textMuted }}>
              {joinMsg}
            </span>
          )}
        </div>
      ) : (
        /* Honest empty-state (P-001): no resolvable announce — offline
           directory, invite-only, or private hive. Offer the invite-link path. */
        <div data-testid="cupboard-hive-join-unavailable" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span style={{ fontFamily: FONTS.ui, fontSize: 12, color: COLORS.textMuted, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <AlertTriangle size={12} />
            {announce
              ? `This ${t('pot', { lower: true })} announces topics only — a full member join link is required to join from here.`
              : dirError
                ? `The ${t('pot', { lower: true })} directory is unreachable (${dirError}) — joining needs a live announce.`
                : `This ${t('pot', { lower: true })} isn't announcing on the directory from here — it may be invite-only, offline, or not yet discovered.`}
          </span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              value={inviteLink}
              onChange={(e) => setInviteLink(e.target.value)}
              placeholder="papercusp://pot?pubkey=…&secret=… invite link"
              data-testid="cupboard-hive-invite-input"
              className="pc-input"
              style={{ flex: 1, minWidth: 220, fontFamily: FONTS.mono, fontSize: 12 }}
            />
            <Button
              size="lg"
              variant="accent"
              onClick={() => void submitInvite()}
              disabled={!inviteLink.trim()}
              data-testid="cupboard-hive-invite-submit"
            >
              <KeyRound size={12} /> Join via invite
            </Button>
          </div>
          {inviteMsg && (
            <span data-testid="cupboard-hive-invite-msg" style={{ fontFamily: FONTS.ui, fontSize: 12, color: COLORS.textMuted }}>
              {inviteMsg}
            </span>
          )}
        </div>
      )}

      {unclaimed.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Tooltip label={`Claim vouches for the ${unclaimed.length === 1 ? 'listing' : 'listings'} as a verified repo maintainer — a trust signal, not ownership of the code. GitHub enforces maintain/admin; without it the claim is refused and says so.`}>
            <Button
              size="lg"
              variant="accent"
              onClick={() => void claimAll()}
              disabled={claiming}
              data-testid="cupboard-hive-claim"
              style={{ opacity: claiming ? 0.7 : 1, cursor: claiming ? 'default' : 'pointer' }}
            >
              {claiming ? (
                <><Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> Claiming…</>
              ) : (
                <><ShieldCheck size={12} /> Claim {unclaimed.length === members.length ? 'listings' : `${unclaimed.length} unclaimed`}</>
              )}
            </Button>
          </Tooltip>
        </div>
      )}
    </div>
  );
}
