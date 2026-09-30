'use client';

/**
 * Cupboard listing detail view.
 *
 * Shows full metadata + claim status + the per-listing primary action
 * (View Hive / Fork / Install — D-005, reframed by
 * comb-retire-per-harness-sharing-2026-06-11: per-harness Join is RETIRED; a
 * `kind='harness'` row is the repo→Hive lookup index, so hive-bound rows point
 * at the owning Hive and legacy rows have no primary action). Renders against
 * either the live-worker row shape or the aspirational HarnessListing shape
 * via the cupboard/types helpers.
 *
 * The fork/install kinds execute their action directly from here:
 *   - blueprint Fork → POST /api/cupboard/install-blueprint (clone + validate +
 *     dep-check → ~/.papercusp/blueprints/<id>/, the installed tier of the
 *     local→installed→built-in resolution —
 *     official-blueprints-cupboard-publish-2026-06-05 P-004/D-001/D-004).
 *     The first pass never auto-installs declared plugin/provider deps. When an
 *     identity grants capability classes, the same CTA becomes an explicit
 *     provider choice → full transitive review → consent flow before any
 *     provider package, binding, or identity bytes are written.
 *   - plugin / pack Install → POST /api/cupboard/install-plugin (clone the
 *     listing's repo into global-plugins — EI-27). The global install only
 *     REGISTERS the unit; the manifest's requested capabilities are surfaced in
 *     the toast but NOT granted here — per-harness capability consent
 *     (acceptCapabilities) stays an explicit act at enable-time (D-009). This
 *     replaces the dead `/harness?cupboardListing=…` navigation that nothing
 *     consumed.
 */

import React, { useCallback, useEffect, useState } from 'react';
import * as Collapsible from '@radix-ui/react-collapsible';
import { useParams, useRouter } from '@/lib/router-compat/navigation';
import { useLexicon } from '@/lib/useLexicon';
import {
  ShieldCheck, ExternalLink, Users, Clock, GitBranch,
  ArrowLeft, Loader2, AlertTriangle, Plug, Globe, Hexagon,
  Download, MonitorDown,
} from 'lucide-react';
import type { HarnessListing, ListingAction } from '@papercusp/operator-core/lib/cupboard/types';
import type {
  CapabilityGrantResolutionVerdict,
  CapabilityProviderCandidate,
  ResolvedCapabilityGrant,
} from '@papercusp/operator-core/lib/cupboard/capability-grant-resolver';
import type { CapabilityProviderPackageClosureReview } from '@papercusp/operator-core/lib/cupboard/capability-provider-package-closure';
import {
  appPlatformFamilies,
  viewerOsFamily,
  parseLatestManifest,
  installersFromManifest,
  resolveInstallerForViewer,
  type LatestManifest,
} from '../app-download';
import {
  listingActionFor,
  listingKindOf,
  isHiveBlueprintListing,
  listingRepoSlug,
  listingContributorCount,
  listingTopLanguage,
  listingHiveRef,
  LISTING_ACTION_LABEL,
} from '@papercusp/operator-core/lib/cupboard/types';
import { COLORS, FONTS, RADIUS, SIZES } from '../cupboard-theme';
import { CupboardErrorState, cupboardHttpError } from '../CupboardErrorState';
import KnowledgePackInstall from './KnowledgePackInstall';
import BundleAppInstall from './BundleAppInstall';
import ThemeInstall from './ThemeInstall';
import { ClaimStatusBadge } from '../../_components/ClaimStatusBadge';
import { Button } from '../../harness/Button';
import { Tooltip } from '../../harness/Tooltip';
import { Select } from '../../harness/Select';
import { useResolvedHarnessSlug } from '../../adv/create/use-create-data';
import { toast } from 'sonner';

interface ProvidedEvent { family: string; keyTemplate: string; describe: string | null }
interface RequiredEvent { family: string; optional: boolean }
/** One entry of a `plan` listing's `requires_rubrics` (worker migration 015 /
 *  cupboard-plan-rubric-recipe-sharing P-012). */
interface RequiredRubric { rubricRef: string; optional: boolean }
/** The public, self-describing subset of rubric.json rendered before install
 *  (cupboard-plan-rubric-recipe-sharing P-005). Kept local to the storefront:
 *  the operator-core store reader is Node/fs-backed and must not enter this
 *  client bundle. */
interface PublicRubricCriterion {
  key: string;
  title: string;
  model: string;
  method: string;
  driftMarkers: string;
  replication: string | null;
  ratingScale: string[];
}
interface PublicRubricManifest {
  title: string;
  characteristic: string;
  description: string;
  ratingScale: string[];
  criteria: PublicRubricCriterion[];
}

interface BlueprintCapabilityFlow {
  stage: 'choice' | 'consent' | 'blocked' | 'done';
  message: string;
  grants: CapabilityGrantResolutionVerdict | null;
  review: CapabilityProviderPackageClosureReview | null;
}

interface BlueprintInstallResponse {
  ok?: boolean;
  id?: string;
  version?: string | null;
  depCheck?: { installable?: { plugins?: string[] } } | null;
  capabilityGrants?: CapabilityGrantResolutionVerdict | null;
  capabilityProviderReview?: CapabilityProviderPackageClosureReview | null;
  error?: string;
  detail?: string;
  data?: unknown;
}

function capabilityPayload(value: unknown): {
  grants: CapabilityGrantResolutionVerdict | null;
  review: CapabilityProviderPackageClosureReview | null;
} {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return { grants: null, review: null };
  }
  const record = value as Record<string, unknown>;
  const nested = record.capabilityGrants;
  const grants = nested && typeof nested === 'object'
    ? nested as CapabilityGrantResolutionVerdict
    : Array.isArray(record.requirements)
      ? record as unknown as CapabilityGrantResolutionVerdict
      : null;
  const review = record.capabilityProviderReview && typeof record.capabilityProviderReview === 'object'
    ? record.capabilityProviderReview as CapabilityProviderPackageClosureReview
    : null;
  return { grants, review };
}

function providerRef(candidate: Pick<CapabilityProviderCandidate, 'providerPackage' | 'providerVersion'>): string {
  return `${candidate.providerPackage}@${candidate.providerVersion}`;
}

function selectedProviders(
  grants: CapabilityGrantResolutionVerdict | null,
  previous: Record<string, string>,
): Record<string, string> {
  if (!grants) return previous;
  const next = { ...previous };
  for (const requirement of grants.requirements) {
    if (requirement.selection) {
      next[requirement.classRef] = providerRef(requirement.selection);
    }
  }
  return next;
}

/**
 * Parse a listing's JSON-TEXT array column, dropping any entry the mapper
 * rejects. Fail-soft by design — see the call sites: a third party's malformed
 * declaration must degrade one section, never blank the listing page.
 */
function parseJsonArray<T>(raw: string | null | undefined, map: (e: Record<string, unknown>) => T | null): T[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: T[] = [];
    for (const e of parsed) {
      if (e == null || typeof e !== 'object' || Array.isArray(e)) continue;
      const mapped = map(e as Record<string, unknown>);
      if (mapped) out.push(mapped);
    }
    return out;
  } catch {
    return [];
  }
}

/** Icon for a listing's action (null = legacy harness row — kind icon only). */
function ActionIcon({ action, size = 14 }: { action: ListingAction | null; size?: number }) {
  switch (action) {
    case 'view-hive': return <Hexagon size={size} />;
    case 'install': return <Plug size={size} />;
    // standalone app → download the platform installer (link handoff).
    case 'download': return <Download size={size} />;
    default: return <Globe size={size} />;
  }
}

export default function CupboardDetailPage() {
  const params = useParams();
  const router = useRouter();
  const t = useLexicon();
  const id = params?.id as string;
  const [listing, setListing] = useState<HarnessListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // In-flight lifecycle flags for the direct-execution action (blueprint
  // install) and the claim CTA — render-lifecycle state, not URL state.
  const [busy, setBusy] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const activeHarnessSlug = useResolvedHarnessSlug();
  const [capabilityFlow, setCapabilityFlow] = useState<BlueprintCapabilityFlow | null>(null);
  const [capabilityProviderSelections, setCapabilityProviderSelections] = useState<Record<string, string>>({});

  const fetchListing = useCallback(() => {
    if (!id) return;
    setLoading(true);
    setError(null);
    fetch(`/api/cupboard/listings/${id}`)
      // cupboardHttpError (not a bare `HTTP ${status}`) folds in the upstream
      // cause the proxy forwards in its JSON body — the operator collapses
      // EVERY upstream failure into a 503, so that body is the ONLY place the
      // real reason ("TimeoutError…", "ENOTFOUND", "cupboard: HTTP 500")
      // survives. Dropping it is why a dead Cupboard host reported nothing
      // beyond "may be briefly unavailable" (cupboard-dead-default-host-2026-07-19).
      .then(async (r) => (r.ok ? r.json() : Promise.reject(await cupboardHttpError(r))))
      .then((data: { listing: HarnessListing }) => { setListing(data.listing); })
      .catch((err: unknown) => { setError(String(err)); })
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => { fetchListing(); }, [fetchListing]);

  const handleAction = () => {
    if (!listing) return;
    const kind = listingKindOf(listing);
    if (listingActionFor(listing) === 'view-hive') {
      // The owning Hive's rollup in the storefront (per-harness join is retired).
      router.push(`/cupboard?hive=${encodeURIComponent(listingHiveRef(listing))}`);
      return;
    }
    // Blueprint fork installs the listing into the local installed tier
    // (~/.papercusp/blueprints/<id>/), where it shadows a same-id built-in and
    // becomes resolvable to harness:create / blueprint:extend.
    if (kind === 'blueprint') {
      void installBlueprintFromCupboard();
      return;
    }
    // knowledge-pack (P-016, owner ruling 2026-07-12 "the Cupboard is the pack
    // surface"): the in-place install panel (KnowledgePackInstall, rendered
    // below) owns install-into-pot + the conflict review, so this kind has no
    // primary-button action — guard against a stray call.
    if (kind === 'knowledge-pack') {
      return;
    }
    // app (cupboard-app-distribution P-005/P-008): a STANDALONE app's
    // AppDownloadPanel owns the download handoff (fetch latest.json → resolve
    // the viewer-OS installer → hand off the link; the Cupboard never
    // re-hosts); a BUNDLE app's BundleAppInstall panel owns install + the
    // conflict review. Neither kind has a generic primary-button action —
    // guard against a stray call (both panels render their own button).
    if (kind === 'app') {
      return;
    }
    // ThemeInstall owns the inert package lifecycle and keeps installation
    // separate from the explicit Use theme preference action.
    if (kind === 'theme') {
      return;
    }
    // template (cupboard-full-dogfood P-003 / public-release P-002): clone the
    // app/aspect template dir into the local user template store so
    // `templates:new-app` materializes it via the standard path. MUST branch
    // before the plugin fall-through — a template is NOT a plugin manifest.
    if (kind === 'template') {
      void installTemplateFromCupboard();
      return;
    }
    // plugin | pack — the remaining install kinds — clone into
    // global-plugins directly (EI-27). Replaces the dead
    // `/harness?cupboardListing=…` navigation no consumer ever read.
    void installPluginFromCupboard();
  };

  const installBlueprintFromCupboard = async (installReviewedProviders = false) => {
    if (!listing || busy) return;
    setBusy(true);
    try {
      const r = await fetch('/api/cupboard/install-blueprint', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          listingId: listing.id,
          ...(activeHarnessSlug ? { potSlug: activeHarnessSlug } : {}),
          ...(Object.keys(capabilityProviderSelections).length > 0
            ? { capabilityProviderSelections }
            : {}),
          // This second pass is reachable only after the complete provider
          // closure has rendered below. The server re-reviews and pins every
          // package receipt before it writes bindings or identity bytes.
          ...(installReviewedProviders ? { installPlugins: true } : {}),
        }),
      });
      const d = (await r.json().catch(() => ({}))) as BlueprintInstallResponse;
      if (!r.ok || !d.ok) {
        const payload = capabilityPayload(d.data);
        if (payload.grants) {
          setCapabilityProviderSelections((previous) => selectedProviders(payload.grants, previous));
        }
        if (d.error === 'capability_provider_choice_required') {
          setCapabilityFlow({
            stage: 'choice',
            message: 'Choose providers for every required capability, then review the exact package closure.',
            ...payload,
          });
          return;
        }
        if (d.error === 'capability_provider_install_consent_required') {
          setCapabilityFlow({
            stage: 'consent',
            message: 'Review the complete transitive package and permission set before installing.',
            ...payload,
          });
          return;
        }
        if (
          d.error === 'capability_provider_unavailable' ||
          d.error === 'capability_provider_package_unavailable' ||
          d.error === 'capability_grants_need_pot'
        ) {
          setCapabilityFlow({
            stage: 'blocked',
            message: d.error === 'capability_grants_need_pot'
              ? 'This identity grants capability classes. Select a pot in the workspace first, then return to install it.'
              : d.detail ?? 'A required capability provider is unavailable; the identity was not installed.',
            ...payload,
          });
          return;
        }
        toast.error(`Install failed: ${d.error ?? `HTTP ${r.status}`}${d.detail ? ` — ${d.detail}` : ''}`);
        return;
      }
      const installedPayload = capabilityPayload(d);
      if (installedPayload.grants) {
        setCapabilityFlow({
          stage: 'done',
          message: 'Capability bindings and the reviewed provider packages were installed with this identity.',
          ...installedPayload,
        });
      } else {
        setCapabilityFlow(null);
      }
      const installable = d.depCheck?.installable?.plugins ?? [];
      toast.success(
        `Blueprint "${d.id}" installed${d.version ? ` v${d.version}` : ''} — usable in harness:create / blueprint:extend.` +
          (installable.length > 0
            ? ` Declares plugin deps you can install from their listings: ${installable.join(', ')}.`
            : ''),
      );
    } catch (e) {
      toast.error(`Install crashed: ${(e as Error)?.message ?? String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const chooseCapabilityProvider = (classRef: string, value: string) => {
    setCapabilityProviderSelections((previous) => ({ ...previous, [classRef]: value }));
    setCapabilityFlow((previous) => previous
      ? {
          ...previous,
          stage: 'choice',
          review: null,
          message: 'Provider choice changed. Review the exact package closure before installing.',
        }
      : previous);
  };

  // Claim (comb-hive-native-sharing P-003, O-1 per D-005): offered on unclaimed
  // hive member rows to any viewer — the WORKER enforces maintain/admin via the
  // GitHub API and a refusal is surfaced honestly, not hidden.
  const claimListing = async () => {
    if (!listing || claiming) return;
    setClaiming(true);
    try {
      const r = await fetch(`/api/cupboard/listings/${encodeURIComponent(String(listing.id))}/claim`, {
        method: 'POST',
      });
      const d = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (r.ok && d.ok) {
        toast.success('Listing claimed — your maintainer vouch is now the trust signal on this listing.');
        fetchListing();
      } else if (d.error === 'gh_auth_required') {
        toast.error('Claiming needs a GitHub sign-in on this box — run `gh auth login`, then retry.');
      } else if (d.error === 'insufficient_permission') {
        toast.error('GitHub says you don’t have maintain/admin on this repo — claiming needs maintainer access.');
      } else if (d.error === 'already_claimed') {
        toast.error('Someone else claimed this listing first.');
        fetchListing();
      } else {
        toast.error(`Claim failed: ${d.error ?? `HTTP ${r.status}`}`);
      }
    } catch (e) {
      toast.error(`Claim crashed: ${(e as Error)?.message ?? String(e)}`);
    } finally {
      setClaiming(false);
    }
  };

  // template Install (cupboard-full-dogfood P-003): clone the app/aspect
  // template dir into the writable user template store (shadows the bundled
  // floor). After install, `templates:new-app` materializes it via the same
  // local path as a bundled template.
  const installTemplateFromCupboard = async () => {
    if (!listing || busy) return;
    setBusy(true);
    try {
      const r = await fetch('/api/cupboard/install-template', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ listingId: listing.id }),
      });
      const d = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        id?: string;
        ref?: string;
        title?: string;
        version?: string;
        installedTo?: string;
        error?: string;
        detail?: string;
      };
      if (!r.ok || !d.ok) {
        toast.error(`Install failed: ${d.error ?? `HTTP ${r.status}`}${d.detail ? ` — ${d.detail}` : ''}`);
        return;
      }
      toast.success(
        `Template "${d.title ?? d.id ?? d.ref}"${d.version ? ` v${d.version}` : ''} installed — ` +
          `use it with templates:new-app (or the app-create flow) to scaffold a new app.`,
      );
    } catch (e) {
      toast.error(`Install crashed: ${(e as Error)?.message ?? String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  // plugin / pack Install: clone the listing's repo into global-plugins. We do
  // NOT pass harness/acceptCapabilities — the global install only registers the
  // unit; per-harness capability consent stays explicit at enable-time (D-009).
  // The toast surfaces the manifest's requested capabilities + any installable
  // declared deps for transparency.
  const installPluginFromCupboard = async () => {
    if (!listing || busy) return;
    setBusy(true);
    try {
      const r = await fetch('/api/cupboard/install-plugin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ listingId: listing.id }),
      });
      const d = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        name?: string;
        version?: string;
        kind?: string;
        capabilities?: string[];
        installableDependencies?: { tools?: string[]; packs?: string[]; plugins?: string[] } | null;
        error?: string;
        detail?: string;
      };
      if (!r.ok || !d.ok) {
        toast.error(`Install failed: ${d.error ?? `HTTP ${r.status}`}${d.detail ? ` — ${d.detail}` : ''}`);
        return;
      }
      const unit = d.kind === 'pack' ? 'Pack' : 'Plugin';
      const caps = d.capabilities ?? [];
      const installable = [
        ...(d.installableDependencies?.tools ?? []),
        ...(d.installableDependencies?.packs ?? []),
        ...(d.installableDependencies?.plugins ?? []),
      ];
      toast.success(
        `${unit} "${d.name}" installed${d.version ? ` v${d.version}` : ''}.` +
          (caps.length > 0
            ? ` Requests capabilities (granted per-harness on enable): ${caps.join(', ')}.`
            : '') +
          (installable.length > 0
            ? ` Declares installable deps: ${installable.join(', ')}.`
            : ''),
      );
    } catch (e) {
      toast.error(`Install crashed: ${(e as Error)?.message ?? String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div style={{ padding: SIZES.lg, display: 'flex', alignItems: 'center', gap: 8, color: COLORS.textMuted }}>
        <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> Loading…
      </div>
    );
  }

  if (error || !listing) {
    return (
      <div style={{ padding: SIZES.lg }}>
        <button onClick={() => router.back()} style={backBtnStyle}>
          <ArrowLeft size={13} /> Back
        </button>
        <div style={{ marginTop: SIZES.md }}>
          {error ? (
            <CupboardErrorState raw={error} what="this listing" onRetry={fetchListing} />
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--bad)' }}>
              <AlertTriangle size={14} />
              Listing not found.
            </div>
          )}
        </div>
      </div>
    );
  }

  const kind = listingKindOf(listing);
  // D-002: a pot blueprint reads as "pot template" on its detail page too.
  const isPotTemplate = isHiveBlueprintListing(listing);
  const repoSlug = listingRepoSlug(listing);
  const contributors = listingContributorCount(listing);
  const language = listingTopLanguage(listing);
  const action = listingActionFor(listing);
  // provides_tools (worker migration 006): JSON string[] of the MCP tool names
  // a plugin/pack unit registers — surfaced so the user sees what installing buys.
  const providesTools: string[] = (() => {
    if (!listing.provides_tools) return [];
    try {
      const parsed: unknown = JSON.parse(listing.provides_tools);
      return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
    } catch {
      return [];
    }
  })();
  // uses_tools (worker migration 033 / WI-10001747): the CONSUMER half — tool
  // names a recipe/plan/goal ORCHESTRATES but does not provide. Rendered as a
  // distinct row from "Provides tools" on purpose: installing this unit
  // registers none of them, so conflating the two would promise a tool surface
  // the unit does not actually supply.
  const usesTools: string[] = (() => {
    if (!listing.uses_tools) return [];
    try {
      const parsed: unknown = JSON.parse(listing.uses_tools);
      return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
    } catch {
      return [];
    }
  })();
  // The EVENT axis (D-003; worker migrations 012 + 013 / P-007 + P-008) — the
  // mirror of provides_tools, both halves:
  //   provides_events  what this unit lets you AWAIT once installed
  //   requires_events  what this unit NEEDS something else to emit
  //
  // Requires is the half that changes a decision. A REQUIRED family that nothing
  // on your host provides is a HARD install failure (P-007's gate refuses it),
  // so this is where the user gets to see that coming instead of meeting it as a
  // refusal toast after clicking Install. Optional deps are listen-if-present and
  // never block — labelled as such rather than silently blended in with the hard
  // ones, because "this install will fail" and "this feature stays dormant" are
  // very different things to be told.
  //
  // Parsed FAIL-SOFT (a malformed entry is skipped, never thrown): the row is a
  // third party's declaration, and a bad one must degrade this section, not blank
  // out the whole listing page. The worker structurally validates on publish, so
  // this is the belt to that braces.
  const providesEvents: ProvidedEvent[] = parseJsonArray(listing.provides_events, (e) =>
    typeof e.family === 'string' && e.family.length > 0 && typeof e.keyTemplate === 'string' && e.keyTemplate.length > 0
      ? { family: e.family, keyTemplate: e.keyTemplate, describe: typeof e.describe === 'string' ? e.describe : null }
      : null,
  );
  const requiresEvents: RequiredEvent[] = parseJsonArray(listing.requires_events, (e) =>
    typeof e.family === 'string' && e.family.length > 0
      ? { family: e.family, optional: e.optional === true }
      : null,
  );
  // The RUBRIC axis, consumer half (worker migration 015 / P-011 + P-012). Carried
  // by `plan` listings: the rubrics a plan template must be gradeable against.
  //
  // Shown for exactly the reason `requires_events` is: the install RESOLVES this
  // before it downloads anything, and a required rubric nothing provides REFUSES.
  // Meeting that as a refusal after clicking Install is the outcome this section
  // exists to prevent. There is deliberately no `provides_rubrics` counterpart to
  // pair it with (D-002) — a kind='rubric' row provides exactly the one rubric its
  // own listing_ref names, so the provider side needs no separate declaration.
  //
  // Parsed FAIL-SOFT, same as the event axis: a third party's malformed entry
  // degrades this section rather than blanking the page.
  const requiresRubrics: RequiredRubric[] = parseJsonArray(listing.requires_rubrics, (e) =>
    typeof e.rubricRef === 'string' && e.rubricRef.length > 0
      ? { rubricRef: e.rubricRef, optional: e.optional === true }
      : null,
  );

  return (
    <div style={{ padding: SIZES.lg, maxWidth: 700, margin: '0 auto' }}>
      <button onClick={() => router.back()} style={backBtnStyle}>
        <ArrowLeft size={13} /> Back to {t('cupboard')}
      </button>

      <div style={{ marginTop: SIZES.lg }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <h1 style={{ fontFamily: FONTS.ui, fontWeight: 700, fontSize: 20, color: COLORS.text, margin: 0 }}>
            {listing.title || listing.slug || repoSlug || 'Untitled'}
          </h1>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            <span className="pc-badge" style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              background: COLORS.surfaceRaised, border: `1px solid ${COLORS.border}`,
              color: COLORS.textMuted,
            }} data-testid="cupboard-detail-kind" data-kind={kind} data-pot-template={isPotTemplate ? 'true' : undefined}>
              <ActionIcon action={action} size={12} /> {isPotTemplate ? `${t('pot', { lower: true })} template` : kind}
            </span>
            <ClaimStatusBadge
              status={listing.claim_status}
              claimantLogin={listing.claimant_github_login}
              claimedAt={listing.claimed_at}
            />
          </span>
        </div>

        {/* Description */}
        <p style={{ fontFamily: FONTS.ui, fontSize: SIZES.sm, color: COLORS.textMuted, marginTop: 8 }}>
          {listing.description || 'No description.'}
        </p>

        {/* Metadata grid */}
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SIZES.sm,
          background: COLORS.surface, border: `1px solid ${COLORS.border}`,
          borderRadius: RADIUS.lg, padding: SIZES.md, marginTop: SIZES.md,
        }}>
          {repoSlug && (
            <MetaRow label="GitHub repo">
              <a
                href={`https://github.com/${repoSlug}`}
                target="_blank" rel="noopener noreferrer"
                style={{ color: 'var(--accent-soft)', fontFamily: FONTS.mono, fontSize: SIZES.sm, display: 'inline-flex', alignItems: 'center', gap: 4 }}
              >
                {repoSlug} <ExternalLink size={11} />
              </a>
            </MetaRow>
          )}
          {listing.listing_ref && (
            <MetaRow label={kind === 'plugin' ? 'Plugin' : kind === 'pack' ? 'Pack' : kind === 'knowledge-pack' ? 'Knowledge pack' : 'Listing'}>
              <span style={{ fontFamily: FONTS.mono, fontSize: SIZES.sm, color: COLORS.text }}>{listing.listing_ref}</span>
            </MetaRow>
          )}
          {providesTools.length > 0 && (
            <MetaRow label="Provides tools">
              <span
                data-testid="cupboard-detail-provides-tools"
                style={{ fontFamily: FONTS.mono, fontSize: SIZES.sm, color: COLORS.text }}
              >
                {providesTools.join(', ')}
              </span>
            </MetaRow>
          )}
          {usesTools.length > 0 && (
            <MetaRow label="Uses tools">
              <span
                data-testid="cupboard-detail-uses-tools"
                style={{ fontFamily: FONTS.mono, fontSize: SIZES.sm, color: COLORS.text }}
              >
                {usesTools.join(', ')}
              </span>
            </MetaRow>
          )}
          {/* The event axis (P-008). Full-width rows: a family carries a key
              template (and often a description), which does not fit the 2-up
              grid the scalar metadata uses. */}
          {providesEvents.length > 0 && (
            <MetaRow label="Provides events" span>
              <ul
                data-testid="cupboard-detail-provides-events"
                style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}
              >
                {providesEvents.map((ev) => (
                  <li key={ev.family} data-testid="cupboard-detail-provided-event" data-family={ev.family}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <code style={eventFamilyStyle}>{ev.family}</code>
                      {/* The key template is the thing an awaiter actually parks
                          on — show it, don't just name the family. */}
                      <code style={{ fontFamily: FONTS.mono, fontSize: 11, color: COLORS.textMuted }}>
                        {ev.keyTemplate}
                      </code>
                    </div>
                    {ev.describe && (
                      <div style={{ fontFamily: FONTS.ui, fontSize: 11.5, color: COLORS.textMuted, marginTop: 2 }}>
                        {ev.describe}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </MetaRow>
          )}
          {requiresEvents.length > 0 && (
            <MetaRow label="Requires events" span>
              <ul
                data-testid="cupboard-detail-requires-events"
                style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}
              >
                {requiresEvents.map((ev) => (
                  <li
                    key={ev.family}
                    data-testid="cupboard-detail-required-event"
                    data-family={ev.family}
                    data-optional={ev.optional ? 'true' : 'false'}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}
                  >
                    <code style={eventFamilyStyle}>{ev.family}</code>
                    {/* Required vs optional is the whole point of showing this:
                        a required family nothing provides FAILS the install; an
                        optional one just stays dormant. Never blend them. */}
                    <span style={ev.optional ? optionalDepStyle : requiredDepStyle}>
                      {ev.optional ? 'optional' : 'required'}
                    </span>
                  </li>
                ))}
              </ul>
              <p style={{ fontFamily: FONTS.ui, fontSize: 11.5, color: COLORS.textMuted, margin: '6px 0 0' }}>
                Installing resolves each required family against what this machine already provides — a built-in, an
                installed unit, or another Cupboard unit it can pull in. A required family that nothing provides will
                stop the install. Optional families are listen-if-present and never block.
              </p>
            </MetaRow>
          )}
          {requiresRubrics.length > 0 && (
            <MetaRow label="Requires rubrics" span>
              <ul
                data-testid="cupboard-detail-requires-rubrics"
                style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}
              >
                {requiresRubrics.map((rb) => (
                  <li
                    key={rb.rubricRef}
                    data-testid="cupboard-detail-required-rubric"
                    data-rubric-ref={rb.rubricRef}
                    data-optional={rb.optional ? 'true' : 'false'}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}
                  >
                    <code style={eventFamilyStyle}>{rb.rubricRef}</code>
                    {/* Same required/optional split as the event axis, and for the
                        same reason: a required rubric nothing provides STOPS the
                        install; an optional one is simply not graded. */}
                    <span style={rb.optional ? optionalDepStyle : requiredDepStyle}>
                      {rb.optional ? 'optional' : 'required'}
                    </span>
                  </li>
                ))}
              </ul>
              <p style={{ fontFamily: FONTS.ui, fontSize: 11.5, color: COLORS.textMuted, margin: '6px 0 0' }}>
                Installing resolves each required rubric against this workspace first — a rubric you already have, or
                one from the bundled first-party set, counts as provided. A required rubric only a Cupboard listing
                supplies is offered as a co-install; one nothing provides will stop the install.
              </p>
            </MetaRow>
          )}
          {listing.project_ref && (
            <MetaRow label="Project">
              <span style={{ fontFamily: FONTS.mono, fontSize: SIZES.sm, color: COLORS.text }}>{listing.project_ref}</span>
            </MetaRow>
          )}
          <MetaRow label="Claim status">
            <span
              data-testid="cupboard-detail-claim-status"
              style={{ fontFamily: FONTS.ui, fontSize: SIZES.sm, color: COLORS.text }}
            >
              <span style={{ textTransform: 'capitalize' }}>{listing.claim_status}</span>
              {listing.claim_status === 'claimed' && listing.claimant_github_login && (
                <> by <strong>@{listing.claimant_github_login}</strong></>
              )}
              {listing.claim_status === 'claimed' && listing.claimed_at && (
                <> · {new Date(listing.claimed_at).toLocaleDateString()}</>
              )}
            </span>
          </MetaRow>
          {contributors > 0 && (
            <MetaRow label="Contributors">
              <span style={valueStyle}><Users size={12} /> {contributors}</span>
            </MetaRow>
          )}
          {listing.last_activity_at && (
            <MetaRow label="Last activity">
              <span style={valueStyle}><Clock size={12} /> {new Date(listing.last_activity_at).toLocaleDateString()}</span>
            </MetaRow>
          )}
          {language && (
            <MetaRow label="Language">
              <span style={valueStyle}><GitBranch size={12} /> {language}</span>
            </MetaRow>
          )}
          {listing.tags && listing.tags.length > 0 && (
            <MetaRow label="Tags">
              <span style={valueStyle}>{listing.tags.join(', ')}</span>
            </MetaRow>
          )}
        </div>

        {/* knowledge-pack: every learning is readable BEFORE install — the
            pre-install trust surface (knowledge-packs P-015, D-007). */}
        {kind === 'knowledge-pack' && repoSlug && (
          <KnowledgePackContents repoSlug={repoSlug} listingRef={listing.listing_ref ?? null} />
        )}

        {/* rubric: the criteria + METHOD.md are the instruction-carrying trust
            surface. A user must be able to inspect both BEFORE installing the
            rubric that will grade their work (P-005 / D-002). */}
        {kind === 'rubric' && repoSlug && (
          <RubricContents repoSlug={repoSlug} listingRef={listing.listing_ref ?? null} />
        )}

        {/* knowledge-pack install-into-pot with the per-item conflict review, in
            place (P-016). Owns the Install action for this kind — the generic
            primary button below is suppressed for knowledge packs. */}
        {kind === 'knowledge-pack' && (
          <KnowledgePackInstall listing={listing} />
        )}

        {/* app / standalone (cupboard-app-distribution P-005): the download panel
            fetches the app's latest.json, resolves the viewer-OS installer, and
            hands off the link — the Cupboard never re-hosts. Owns the download
            action for this kind; the generic primary button below is suppressed
            for a download app. */}
        {kind === 'app' && action === 'download' && (
          <AppDownloadPanel listing={listing} />
        )}

        {/* app / bundle (cupboard-app-distribution P-008): the bundle-app install
            panel fetches + parses bundle.yaml server-side and runs the one
            conflict review across every declared unit before installing —
            generalizes the P-016 knowledge-pack install pattern. Owns the
            install action for this kind; the generic primary button below is
            suppressed for a bundle app. */}
        {kind === 'app' && action === 'install' && (
          <BundleAppInstall listing={listing} />
        )}

        {/* Themes have a dedicated lifecycle because Install must not silently
            select, while Update/Remove operate on the installed package and
            Use theme alone writes the active preference. */}
        {kind === 'theme' && (
          <ThemeInstall listing={listing} />
        )}

        {kind === 'blueprint' && capabilityFlow && (
          <BlueprintCapabilityReview
            flow={capabilityFlow}
            selections={capabilityProviderSelections}
            targetPot={activeHarnessSlug}
            onSelect={chooseCapabilityProvider}
          />
        )}

        {/* Per-listing primary CTA — hidden for legacy harness rows (per-harness
            join is retired; nothing to act on), for knowledge packs (the
            KnowledgePackInstall panel owns their Install action), and for an
            app (the AppDownloadPanel / BundleAppInstall panel owns its
            download/install action per delivery_type). */}
        <div style={{ marginTop: SIZES.lg, display: 'flex', gap: 8 }}>
          {action && kind !== 'knowledge-pack' && kind !== 'app' && kind !== 'theme' && (
          <Button
            size="lg"
            variant="primary"
            disabled={busy || (
              capabilityFlow?.stage === 'choice' &&
              !!capabilityFlow.grants?.requirements.some(
                (requirement) =>
                  !requirement.optional &&
                  requirement.state === 'choosable' &&
                  !capabilityProviderSelections[requirement.classRef],
              )
            )}
            data-testid="cupboard-detail-action"
            data-action={action}
            data-capability-stage={capabilityFlow?.stage ?? 'initial'}
            onClick={() => {
              if (kind === 'blueprint') {
                void installBlueprintFromCupboard(capabilityFlow?.stage === 'consent');
                return;
              }
              handleAction();
            }}
            style={{
              cursor: busy ? 'default' : 'pointer',
              opacity: busy ? 0.7 : 1,
            }}
          >
            {busy ? (
              <><Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> Installing {kind}…</>
            ) : capabilityFlow?.stage === 'choice' ? (
              <><ShieldCheck size={14} /> Review provider set</>
            ) : capabilityFlow?.stage === 'consent' ? (
              <><ShieldCheck size={14} /> Install reviewed set</>
            ) : (
              <><ActionIcon action={action} /> {LISTING_ACTION_LABEL[action]}{action === 'install' ? ` ${kind}` : ''}</>
            )}
          </Button>
          )}
          {/* Claim CTA (P-003): hive member rows only, while unclaimed. Shown
              to any viewer (O-1 per D-005) — the worker enforces maintain/admin
              and a refusal is surfaced honestly in the toast. */}
          {kind === 'harness' && !!listing.hive_pubkey && listing.claim_status === 'unclaimed' && (
            <Tooltip label="Claim vouches for this listing as a verified repo maintainer — a trust signal, not ownership of the code. GitHub enforces maintain/admin; without it the claim is refused and says so.">
              <Button
                size="lg"
                variant="accent"
                onClick={() => void claimListing()}
                disabled={claiming}
                data-testid="cupboard-detail-claim"
                style={{ opacity: claiming ? 0.7 : 1, cursor: claiming ? 'default' : 'pointer' }}
              >
                {claiming ? (
                  <><Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> Claiming…</>
                ) : (
                  <><ShieldCheck size={13} /> Claim</>
                )}
              </Button>
            </Tooltip>
          )}
          {repoSlug && (
            <Button asChild size="lg" variant="accent">
              <a href={`https://github.com/${repoSlug}`} target="_blank" rel="noopener noreferrer">
                <ExternalLink size={13} /> View on GitHub
              </a>
            </Button>
          )}
        </div>

        {/* Trust note for code-pulling kinds (D-007/D-009). Knowledge packs pull
            no code and carry no capabilities — their trust surface is the
            browse-before-install list + the install panel's conflict review. */}
        {action === 'install' && kind !== 'knowledge-pack' && kind !== 'theme' && (
          <p style={{ fontFamily: FONTS.ui, fontSize: 12, color: COLORS.textMuted, marginTop: SIZES.sm }}>
            Installing pulls code from this listing. Plugin capabilities are gated by manifest + your install-time consent; review the source on GitHub first.
          </p>
        )}

        {/* Harness rows are the repo→Hive lookup index (comb-retire D-003). */}
        {kind === 'harness' && action === 'view-hive' && listing.hive_title && (
          <p style={{ fontFamily: FONTS.ui, fontSize: 12, color: COLORS.textMuted, marginTop: SIZES.sm }}>
            This repo belongs to the {t('pot', { lower: true })} <strong>{listing.hive_title}</strong> — sharing and joining happen at the {t('pot', { lower: true })} level.
          </p>
        )}
        {kind === 'harness' && !action && (
          <p data-testid="cupboard-detail-legacy-note" style={{ fontFamily: FONTS.ui, fontSize: 12, color: COLORS.textMuted, marginTop: SIZES.sm }}>
            Per-harness sharing is retired — this is a legacy listing with no owning {t('pot', { lower: true })}. Share the {t('pot', { lower: true })} instead.
          </p>
        )}

        {listing.claim_status === 'unclaimed' && kind === 'harness' && (
          <p style={{ fontFamily: FONTS.ui, fontSize: 12, color: COLORS.textMuted, marginTop: SIZES.sm }}>
            This listing is unclaimed — no verified maintainer of the repo has bound it to their account yet.
          </p>
        )}
      </div>
    </div>
  );
}

function BlueprintCapabilityReview({
  flow,
  selections,
  targetPot,
  onSelect,
}: {
  flow: BlueprintCapabilityFlow;
  selections: Record<string, string>;
  targetPot: string | null;
  onSelect: (classRef: string, provider: string) => void;
}) {
  const requirements = flow.grants?.requirements ?? [];
  const stillMissing = flow.review
    ? [
        ...flow.review.stillMissing.tools.map((value) => `tool:${value}`),
        ...flow.review.stillMissing.packs.map((value) => `pack:${value}`),
        ...flow.review.stillMissing.plugins.map((value) => `plugin:${value}`),
        ...flow.review.stillMissing.events.map((value) => `event:${value.family}${value.optional ? ' (optional)' : ''}`),
      ]
    : [];
  return (
    <section
      data-testid="cupboard-capability-review"
      data-stage={flow.stage}
      style={{
        marginTop: SIZES.md,
        padding: SIZES.md,
        border: `1px solid ${flow.stage === 'blocked' ? 'var(--bad)' : COLORS.border}`,
        borderRadius: RADIUS.lg,
        background: COLORS.surface,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: COLORS.text }}>
        <ShieldCheck size={15} />
        <strong style={{ fontFamily: FONTS.ui, fontSize: SIZES.sm }}>Capability provider review</strong>
        {targetPot && <code data-testid="cupboard-capability-target-pot" style={{ fontSize: 11 }}>{targetPot}</code>}
      </div>
      <p style={{ margin: '7px 0 0', color: COLORS.textMuted, fontFamily: FONTS.ui, fontSize: 12 }}>
        {flow.message}
      </p>

      {requirements.length > 0 && (
        <div data-testid="cupboard-capability-requirements" style={{ display: 'grid', gap: 9, marginTop: 12 }}>
          {requirements.map((requirement) => (
            <CapabilityRequirementRow
              key={requirement.classRef}
              requirement={requirement}
              value={selections[requirement.classRef] ?? ''}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}

      {flow.review && (
        <div data-testid="cupboard-capability-provider-closure" style={{ marginTop: 14 }}>
          <strong style={{ fontFamily: FONTS.ui, fontSize: 12, color: COLORS.text }}>
            Full transitive provider set · {flow.review.units.length} package{flow.review.units.length === 1 ? '' : 's'}
          </strong>
          {flow.review.roots.map((root) => (
            <div key={`${root.providerPackage}@${root.providerVersion}`} style={{ marginTop: 6, fontSize: 11.5, color: COLORS.textMuted }}>
              <code>{root.providerPackage}@{root.providerVersion}</code> provides {root.classRefs.join(', ')} · {root.status}
            </div>
          ))}
          <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
            {flow.review.units.map((unit) => {
              const deps = unit.review.dependencies;
              const dependencyLabels = [
                ...deps.tools.map((value) => `tool:${value}`),
                ...deps.packs.map((value) => `pack:${value}`),
                ...deps.plugins.map((value) => `plugin:${value}`),
                ...deps.events.map((value) => `event:${value.family}${value.optional ? ' (optional)' : ''}`),
              ];
              return (
                <details key={`${unit.name}@${unit.version}`} data-testid="cupboard-capability-provider-package" open>
                  <summary style={{ cursor: 'pointer', color: COLORS.text, fontFamily: FONTS.mono, fontSize: 11.5 }}>
                    {unit.name}@{unit.version} · {unit.kind}
                  </summary>
                  <div style={{ margin: '5px 0 0 16px', color: COLORS.textMuted, fontSize: 11.5 }}>
                    <div>Permissions: {unit.review.capabilities.length > 0 ? unit.review.capabilities.join(', ') : 'none declared'}</div>
                    <div>Dependencies: {dependencyLabels.length > 0 ? dependencyLabels.join(', ') : 'none'}</div>
                    <div>Trigger pack: {unit.review.triggerPack
                      ? `${unit.review.triggerPack.targetCount} targets · ${unit.review.triggerPack.bindingCount} bindings · ${unit.review.triggerPack.edgeCount} edges · disarmed`
                      : 'none'}</div>
                  </div>
                </details>
              );
            })}
          </div>
          {flow.review.advisory.length > 0 && (
            <ul data-testid="cupboard-capability-review-advisory" style={{ color: 'var(--warn)', fontSize: 11.5 }}>
              {flow.review.advisory.map((message) => <li key={message}>{message}</li>)}
            </ul>
          )}
          {stillMissing.length > 0 && (
            <p data-testid="cupboard-capability-review-missing" style={{ color: 'var(--bad)', fontSize: 11.5 }}>
              Still missing from the reviewed closure: {stillMissing.join(', ')}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function CapabilityRequirementRow({
  requirement,
  value,
  onSelect,
}: {
  requirement: ResolvedCapabilityGrant;
  value: string;
  onSelect: (classRef: string, provider: string) => void;
}) {
  const candidates = requirement.candidates ?? [];
  const hasSelection = value.length > 0 || requirement.selection != null;
  const visibleGap = requirement.state === 'absent' || (
    requirement.optional && requirement.state !== 'satisfied' && !hasSelection
  );
  return (
    <div
      data-testid="cupboard-capability-requirement"
      data-class-ref={requirement.classRef}
      data-state={requirement.state}
      data-optional={requirement.optional ? 'true' : 'false'}
      style={{ borderTop: `1px solid ${COLORS.border}`, paddingTop: 8 }}
    >
      <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap' }}>
        <code style={{ fontSize: 11.5 }}>{requirement.classRef}</code>
        <span style={requirement.optional ? optionalDepStyle : requiredDepStyle}>
          {requirement.optional ? 'optional' : 'required'}
        </span>
        <span style={{ color: requirement.state === 'absent' ? 'var(--bad)' : COLORS.textMuted, fontSize: 11.5 }}>
          {requirement.state}
        </span>
        {requirement.state === 'satisfied' && requirement.binding && (
          <span style={{ color: COLORS.textMuted, fontSize: 11.5 }}>
            {requirement.binding.providerPackage}@{requirement.binding.providerVersion} (existing pot binding)
          </span>
        )}
        {requirement.state === 'choosable' && (
          <Select
            value={value}
            onChange={(provider) => onSelect(requirement.classRef, provider)}
            options={candidates.map((candidate) => ({
              value: providerRef(candidate),
              label: providerRef(candidate),
            }))}
            placeholder="Choose provider"
            ariaLabel={`Provider for ${requirement.classRef}`}
            testId={`cupboard-capability-select-${requirement.classRef}`}
          />
        )}
      </div>
      {requirement.selectionProblem && (
        <div style={{ color: 'var(--warn)', fontSize: 11.5, marginTop: 4 }}>{requirement.selectionProblem}</div>
      )}
      {visibleGap && (
        <div data-testid="cupboard-capability-gap" style={{ color: requirement.optional ? 'var(--warn)' : 'var(--bad)', fontSize: 11.5, marginTop: 4 }}>
          {requirement.optional
            ? 'Optional gap: the identity can install, but this capability remains unavailable.'
            : 'Required gap: installation is blocked until a conformant provider exists.'}
        </div>
      )}
      {candidates.length > 0 && (
        <ul style={{ listStyle: 'none', margin: '6px 0 0', padding: 0, display: 'grid', gap: 4 }}>
          {candidates.map((candidate) => {
            const ref = providerRef(candidate);
            const publisherDefault = requirement.selection?.reason === 'publisher-suggestion' &&
              providerRef(requirement.selection) === ref;
            return (
              <li
                key={ref}
                data-testid="cupboard-capability-candidate"
                data-provider={ref}
                data-default={publisherDefault ? 'publisher' : undefined}
                style={{ color: COLORS.textMuted, fontSize: 11.5 }}
              >
                <code>{ref}</code>{publisherDefault ? ' · publisher default' : ''} · conformance {candidate.conformanceStatus}
                {' · '}behavior {candidate.behavioralStatus}
                {' · '}structural {candidate.passingStructuralRuns}/{candidate.totalStructuralRuns}
                {' · '}adoption {candidate.activePotBindings == null ? 'unknown' : candidate.activePotBindings}
                {' · '}price {candidate.price == null
                  ? 'unknown'
                  : `${candidate.price.amount} ${candidate.price.currency}/${candidate.price.billingUnit}`}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * AppDownloadPanel — the standalone-app download handoff
 * (cupboard-app-distribution-2026-07-14 P-005 [owner 2026-07-14]).
 *
 * A standalone app is a separate downloadable product; the Cupboard never
 * re-hosts the binary. At publish time the gate proved the app's `latest.json`
 * resolves (validate-app-manifest), and stored its URL on the listing. Here we
 * FETCH that manifest, resolve the viewer-OS installer entry
 * (`platforms[<os>].url`), and hand off the download link — v1 is a
 * download-link handoff only (no in-shell install / auto-update registration;
 * that's a fast-follow, not v1). We surface the version, release notes, and the
 * signature for transparency (WI-4839).
 *
 * FAIL-SOFT: if the manifest can't be fetched or parsed at view time (a network
 * miss, a since-broken release), we degrade to the denormalized platform-family
 * availability + a "View the release on GitHub" link, never an error wall — the
 * card already showed the app is available; the detail page must not dead-end it.
 */
function AppDownloadPanel({ listing }: { listing: HarnessListing }) {
  const [manifest, setManifest] = useState<LatestManifest | null>(null);
  // 'loading' only while a fetch is genuinely in flight; a listing with no
  // manifest url is 'unavailable' from the first paint (no spinner flash).
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>(
    listing.latest_json_url ? 'loading' : 'unavailable',
  );

  useEffect(() => {
    const url = listing.latest_json_url;
    if (!url) {
      setState('unavailable');
      return;
    }
    let cancelled = false;
    setState('loading');
    setManifest(null);
    (async () => {
      try {
        const r = await fetch(url, { headers: { Accept: 'application/json' } });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const parsed = parseLatestManifest(await r.text());
        if (cancelled) return;
        if (parsed) {
          setManifest(parsed);
          setState('ready');
        } else {
          setState('unavailable');
        }
      } catch {
        if (!cancelled) setState('unavailable');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [listing.latest_json_url]);

  // Availability fallback from the denormalized `platforms` column (P-003) —
  // shown when the live manifest can't be resolved, so the page still tells the
  // viewer which OSes the app ships for.
  const families = appPlatformFamilies(listing.platforms);
  // The release page to link when a direct installer can't be resolved.
  const releaseSlug = listing.release_repo || listingRepoSlug(listing) || null;

  const installers = manifest ? installersFromManifest(manifest) : [];
  const primary = manifest ? resolveInstallerForViewer(manifest, viewerOsFamily()) : null;
  // The non-primary platforms (everything but the viewer's own OS build).
  const others = installers.filter((i) => i.platformKey !== primary?.platformKey);

  return (
    <div
      data-testid="cupboard-app-download"
      data-state={state}
      style={{
        marginTop: SIZES.md,
        background: COLORS.surface,
        border: `1px solid ${COLORS.border}`,
        borderRadius: RADIUS.lg,
        padding: SIZES.md,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: FONTS.ui, fontSize: SIZES.sm, fontWeight: 600, color: COLORS.text }}>
        <Download size={14} /> Download
        {manifest && (
          <span data-testid="cupboard-app-version" style={{ fontFamily: FONTS.mono, fontSize: 12, color: COLORS.textMuted, fontWeight: 400 }}>
            v{manifest.version}
          </span>
        )}
        {manifest?.pub_date && (
          <span style={{ fontFamily: FONTS.ui, fontSize: 11.5, color: COLORS.textMuted, fontWeight: 400 }}>
            · {new Date(manifest.pub_date).toLocaleDateString()}
          </span>
        )}
      </div>

      {state === 'loading' && (
        <p style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: FONTS.ui, fontSize: 12, color: COLORS.textMuted, margin: '8px 0 0' }}>
          <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> Resolving the latest release…
        </p>
      )}

      {state === 'ready' && manifest && (
        <>
          <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {primary ? (
              <Button asChild size="lg" variant="primary">
                <a
                  href={primary.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  download
                  data-testid="cupboard-app-download-primary"
                  data-platform-key={primary.platformKey}
                >
                  <Download size={14} /> Get for {primary.osFamily}
                </a>
              </Button>
            ) : (
              // Viewer OS undetectable or no build for it — no single primary;
              // every platform is offered below as an equal option instead.
              <span data-testid="cupboard-app-download-no-primary" style={{ fontFamily: FONTS.ui, fontSize: 12, color: COLORS.textMuted }}>
                Choose your platform to download:
              </span>
            )}
          </div>

          {(primary ? others : installers).length > 0 && (
            <div
              data-testid="cupboard-app-download-options"
              style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 8 }}
            >
              {(primary ? others : installers).map((inst) => (
                <Button key={inst.platformKey} asChild size="sm" variant="accent">
                  <a
                    href={inst.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    download
                    data-testid="cupboard-app-download-option"
                    data-platform-key={inst.platformKey}
                    data-os-family={inst.osFamily}
                  >
                    <MonitorDown size={13} /> {inst.osFamily}
                  </a>
                </Button>
              ))}
            </div>
          )}

          {manifest.notes && (
            <details data-testid="cupboard-app-notes" style={{ marginTop: 10 }}>
              <summary style={{ cursor: 'pointer', fontFamily: FONTS.ui, fontSize: 12, color: COLORS.textMuted }}>
                Release notes
              </summary>
              <pre style={{ whiteSpace: 'pre-wrap', fontFamily: FONTS.mono, fontSize: 11.5, color: COLORS.textMuted, margin: '6px 0 0' }}>
                {manifest.notes}
              </pre>
            </details>
          )}

          <p style={{ fontFamily: FONTS.ui, fontSize: 11.5, color: COLORS.textMuted, margin: '10px 0 0' }}>
            This is a standalone app — the download comes straight from the publisher&rsquo;s release, not the {' '}
            {/* honest about the trust model: the Cupboard is an index, not a mirror */}
            Cupboard. Verify the source before running an installer.
          </p>
        </>
      )}

      {state === 'unavailable' && (
        <div data-testid="cupboard-app-download-unavailable" style={{ marginTop: 8 }}>
          <p style={{ fontFamily: FONTS.ui, fontSize: 12, color: COLORS.textMuted, margin: 0 }}>
            {families.length > 0 ? (
              <>Available for <strong>{families.join(', ')}</strong>, but the latest release couldn&rsquo;t be resolved right now.</>
            ) : (
              <>The latest release couldn&rsquo;t be resolved right now.</>
            )}
            {releaseSlug ? ' Grab it from the publisher&rsquo;s releases:' : ''}
          </p>
          {releaseSlug && (
            <div style={{ marginTop: 8 }}>
              <Button asChild size="lg" variant="primary">
                <a
                  href={`https://github.com/${releaseSlug}/releases`}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="cupboard-app-download-github"
                >
                  <ExternalLink size={13} /> View releases on GitHub
                </a>
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * KnowledgePackContents — read every learning BEFORE installing
 * (learning-packs-2026-06-11 P-015): the pre-install trust surface for
 * instruction-carrying content. Fetched straight from the public GitHub repo
 * (contents API + raw download; unauthenticated, so a rate-limit or network
 * miss degrades to the "browse on GitHub" link, never an error wall).
 * Convention: the pack lives at `knowledge-packs/<listing_ref>/` (P-016's
 * export shape) — repo-root manifests also resolve.
 */
function KnowledgePackContents({ repoSlug, listingRef }: { repoSlug: string; listingRef: string | null }) {
  const t = useLexicon();
  const [items, setItems] = useState<Array<{ name: string; text: string }> | null>(null);
  const [contentsError, setContentsError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open || items !== null) return;
    let cancelled = false;
    (async () => {
      try {
        const dir = listingRef ? `knowledge-packs/${listingRef}` : '';
        const listRes = await fetch(
          `https://api.github.com/repos/${repoSlug}/contents/${dir}`,
          { headers: { Accept: 'application/vnd.github+json' } },
        );
        if (!listRes.ok) throw new Error(`GitHub contents → ${listRes.status}`);
        const files = (await listRes.json()) as Array<{ name: string; download_url: string | null; type: string }>;
        const mds = files.filter((f) => f.type === 'file' && f.name.endsWith('.md') && f.download_url).slice(0, 50);
        const fetched = await Promise.all(
          mds.map(async (f) => {
            const r = await fetch(f.download_url as string);
            return { name: f.name.replace(/\.md$/, ''), text: r.ok ? await r.text() : '(unreadable)' };
          }),
        );
        if (!cancelled) setItems(fetched);
      } catch (e) {
        if (!cancelled) setContentsError((e as Error).message ?? String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, items, repoSlug, listingRef]);

  return (
    <div style={{ marginTop: SIZES.md, background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: RADIUS.lg, padding: SIZES.md }} data-testid="knowledge-pack-contents">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: COLORS.text, fontFamily: FONTS.ui, fontSize: SIZES.sm, fontWeight: 600, padding: 0 }}
        aria-expanded={open}
      >
        {open ? '▾' : '▸'} Browse the learnings before installing
      </button>
      <p style={{ fontFamily: FONTS.ui, fontSize: 11.5, color: COLORS.textMuted, margin: '4px 0 0' }}>
        These texts are injected into your agents&rsquo; recall once installed into a {t('pot', { lower: true })} — read them first.
        Installing also runs a per-item conflict review against the {t('pot', { lower: true })}&rsquo;s existing learnings.
      </p>
      {open && (
        <div style={{ marginTop: 10 }}>
          {contentsError ? (
            <p style={{ fontFamily: FONTS.ui, fontSize: 12, color: COLORS.textMuted }}>
              Couldn&rsquo;t fetch the pack contents ({contentsError}) —{' '}
              <a
                href={`https://github.com/${repoSlug}${listingRef ? `/tree/HEAD/knowledge-packs/${listingRef}` : ''}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: 'var(--accent-soft)' }}
              >
                browse it on GitHub
              </a>
              .
            </p>
          ) : items === null ? (
            <p style={{ fontFamily: FONTS.ui, fontSize: 12, color: COLORS.textMuted }}>Loading…</p>
          ) : (
            items
              .filter((f) => f.name !== 'README')
              .map((f) => (
                <Collapsible.Root key={f.name} style={{ marginBottom: 6 }}>
                  <Collapsible.Trigger style={{ background: 'none', border: 'none', padding: 0, fontFamily: FONTS.mono, fontSize: 12, color: COLORS.text, cursor: 'pointer', textAlign: 'left' }}>
                    {f.name}
                  </Collapsible.Trigger>
                  <Collapsible.Content>
                    <pre style={{ whiteSpace: 'pre-wrap', fontFamily: FONTS.mono, fontSize: 11.5, color: COLORS.textMuted, margin: '4px 0 0 14px' }}>{f.text}</pre>
                  </Collapsible.Content>
                </Collapsible.Root>
              ))
          )}
        </div>
      )}
    </div>
  );
}

/**
 * RubricContents — render the rubric's actual grading contract before install
 * (cupboard-plan-rubric-recipe-sharing P-005).
 *
 * A rubric listing is a pointer, deliberately not a second copy of its criteria
 * (publish-rubric-core). Read the same public self-describing directory the
 * installer consumes: rubric.json + optional METHOD.md. This follows the
 * existing KnowledgePackContents GitHub-contents pattern and fails soft to a
 * source link when GitHub is unavailable or a third-party manifest is invalid.
 */
function RubricContents({ repoSlug, listingRef }: { repoSlug: string; listingRef: string | null }) {
  const [manifest, setManifest] = useState<PublicRubricManifest | null>(null);
  const [method, setMethod] = useState<string | null>(null);
  const [contentsError, setContentsError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const dir = listingRef ? encodeURIComponent(listingRef) : '';
        const listRes = await fetch(
          `https://api.github.com/repos/${repoSlug}/contents/${dir}`,
          { headers: { Accept: 'application/vnd.github+json' } },
        );
        if (!listRes.ok) throw new Error(`GitHub contents → ${listRes.status}`);
        const files = (await listRes.json()) as Array<{
          name: string;
          download_url: string | null;
          type: string;
        }>;
        const rubricFile = files.find(
          (f) => f.type === 'file' && f.name === 'rubric.json' && f.download_url,
        );
        if (!rubricFile?.download_url) throw new Error('rubric.json missing');

        const rubricRes = await fetch(rubricFile.download_url);
        if (!rubricRes.ok) throw new Error(`rubric.json → ${rubricRes.status}`);
        const parsed = parsePublicRubricManifest(await rubricRes.json());
        if (!parsed) throw new Error('rubric.json is not a valid rubric manifest');

        const methodFile = files.find(
          (f) => f.type === 'file' && f.name === 'METHOD.md' && f.download_url,
        );
        let methodText: string | null = null;
        if (methodFile?.download_url) {
          const methodRes = await fetch(methodFile.download_url);
          if (methodRes.ok) methodText = await methodRes.text();
        }
        if (!cancelled) {
          setManifest(parsed);
          setMethod(methodText);
        }
      } catch (e) {
        if (!cancelled) setContentsError((e as Error).message ?? String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repoSlug, listingRef]);

  const sourcePath = listingRef ? `/tree/HEAD/${encodeURIComponent(listingRef)}` : '';

  return (
    <div
      data-testid="cupboard-rubric-contents"
      style={{
        marginTop: SIZES.md,
        background: COLORS.surface,
        border: `1px solid ${COLORS.border}`,
        borderRadius: RADIUS.lg,
        padding: SIZES.md,
      }}
    >
      <div style={{ fontFamily: FONTS.ui, fontSize: SIZES.sm, fontWeight: 600, color: COLORS.text }}>
        Rubric criteria
      </div>
      <p style={{ fontFamily: FONTS.ui, fontSize: 11.5, color: COLORS.textMuted, margin: '4px 0 0' }}>
        This rubric will grade work after install. Review its criteria and runbook before trusting its verdicts.
      </p>

      {contentsError ? (
        <p data-testid="cupboard-rubric-contents-error" style={{ fontFamily: FONTS.ui, fontSize: 12, color: COLORS.textMuted }}>
          Couldn&rsquo;t fetch the rubric contents ({contentsError}) —{' '}
          <a
            href={`https://github.com/${repoSlug}${sourcePath}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: 'var(--accent-soft)' }}
          >
            browse it on GitHub
          </a>
          .
        </p>
      ) : manifest === null ? (
        <p style={{ fontFamily: FONTS.ui, fontSize: 12, color: COLORS.textMuted }}>Loading rubric…</p>
      ) : (
        <>
          <div style={{ marginTop: 10 }}>
            <div style={{ fontFamily: FONTS.ui, fontSize: 12, color: COLORS.text }}>
              <strong>{manifest.title}</strong> · {manifest.characteristic}
            </div>
            {manifest.description && (
              <p style={{ fontFamily: FONTS.ui, fontSize: 11.5, color: COLORS.textMuted, margin: '4px 0 0' }}>
                {manifest.description}
              </p>
            )}
          </div>
          <ol
            data-testid="cupboard-rubric-criteria"
            style={{ margin: '10px 0 0', paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 10 }}
          >
            {manifest.criteria.map((criterion) => (
              <li key={criterion.key} data-testid="cupboard-rubric-criterion" data-criterion-key={criterion.key}>
                <div style={{ fontFamily: FONTS.ui, fontSize: 12, color: COLORS.text }}>
                  <strong>{criterion.title}</strong>{' '}
                  <code style={{ fontFamily: FONTS.mono, fontSize: 10.5, color: COLORS.textMuted }}>
                    {criterion.key}
                  </code>
                </div>
                <div style={{ fontFamily: FONTS.ui, fontSize: 11.5, color: COLORS.textMuted, marginTop: 3 }}>
                  <strong>Measure:</strong> {criterion.model}
                </div>
                <div style={{ fontFamily: FONTS.ui, fontSize: 11.5, color: COLORS.textMuted, marginTop: 2 }}>
                  <strong>Method:</strong> {criterion.method}
                </div>
                <div style={{ fontFamily: FONTS.ui, fontSize: 11.5, color: COLORS.textMuted, marginTop: 2 }}>
                  <strong>Drift markers:</strong> {criterion.driftMarkers}
                </div>
                {criterion.replication && (
                  <div style={{ fontFamily: FONTS.ui, fontSize: 11.5, color: COLORS.textMuted, marginTop: 2 }}>
                    <strong>Replication:</strong> {criterion.replication}
                  </div>
                )}
                {(criterion.ratingScale.length > 0 || manifest.ratingScale.length > 0) && (
                  <div style={{ fontFamily: FONTS.ui, fontSize: 11.5, color: COLORS.textMuted, marginTop: 2 }}>
                    <strong>Scale:</strong>{' '}
                    {(criterion.ratingScale.length > 0 ? criterion.ratingScale : manifest.ratingScale).join(' · ')}
                  </div>
                )}
              </li>
            ))}
          </ol>
          <details data-testid="cupboard-rubric-method" style={{ marginTop: 12 }}>
            <summary style={{ cursor: 'pointer', fontFamily: FONTS.ui, fontSize: 12, color: COLORS.text }}>
              METHOD.md runbook
            </summary>
            {method ? (
              <pre style={{ whiteSpace: 'pre-wrap', fontFamily: FONTS.mono, fontSize: 11.5, color: COLORS.textMuted, margin: '6px 0 0' }}>
                {method}
              </pre>
            ) : (
              <p style={{ fontFamily: FONTS.ui, fontSize: 11.5, color: COLORS.textMuted, margin: '6px 0 0' }}>
                No METHOD.md runbook was published with this rubric.
              </p>
            )}
          </details>
        </>
      )}
    </div>
  );
}

/** Strict-enough client reader for the public rubric trust surface. A malformed
 * third-party manifest degrades this one panel rather than crashing the page. */
function parsePublicRubricManifest(value: unknown): PublicRubricManifest | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  const title = typeof o.title === 'string' && o.title ? o.title : null;
  const characteristic = typeof o.characteristic === 'string' && o.characteristic ? o.characteristic : null;
  if (!title || !characteristic || !Array.isArray(o.criteria) || o.criteria.length === 0) return null;

  const criteria: PublicRubricCriterion[] = [];
  for (const valueCriterion of o.criteria) {
    if (valueCriterion == null || typeof valueCriterion !== 'object' || Array.isArray(valueCriterion)) return null;
    const c = valueCriterion as Record<string, unknown>;
    const key = typeof c.key === 'string' && c.key ? c.key : null;
    const criterionTitle = typeof c.title === 'string' && c.title ? c.title : null;
    const model = typeof c.model === 'string' && c.model ? c.model : null;
    const criterionMethod = typeof c.method === 'string' && c.method ? c.method : null;
    const driftMarkers = typeof c.driftMarkers === 'string' && c.driftMarkers ? c.driftMarkers : null;
    if (!key || !criterionTitle || !model || !criterionMethod || !driftMarkers) return null;
    criteria.push({
      key,
      title: criterionTitle,
      model,
      method: criterionMethod,
      driftMarkers,
      replication: typeof c.replication === 'string' && c.replication ? c.replication : null,
      ratingScale: Array.isArray(c.ratingScale)
        ? c.ratingScale.filter((rating): rating is string => typeof rating === 'string')
        : [],
    });
  }

  return {
    title,
    characteristic,
    description: typeof o.description === 'string' ? o.description : '',
    ratingScale: Array.isArray(o.ratingScale)
      ? o.ratingScale.filter((rating): rating is string => typeof rating === 'string')
      : [],
    criteria,
  };
}

/** `span` = take the full width of the 2-up metadata grid (for list-shaped values). */
function MetaRow({ label, children, span = false }: { label: string; children: React.ReactNode; span?: boolean }) {
  return (
    <div style={span ? { gridColumn: '1 / -1' } : undefined}>
      <div style={{ fontFamily: FONTS.ui, fontSize: 11, color: COLORS.textMuted, marginBottom: 2, textTransform: 'uppercase' }}>
        {label}
      </div>
      {children}
    </div>
  );
}

const eventFamilyStyle: React.CSSProperties = {
  fontFamily: FONTS.mono,
  fontSize: 12,
  color: COLORS.text,
  background: 'var(--bg-1)',
  border: `1px solid ${COLORS.border}`,
  borderRadius: 999,
  padding: '2px 8px',
};

/** A hard dep — an unresolvable one FAILS the install (P-007's gate). */
const requiredDepStyle: React.CSSProperties = {
  fontFamily: FONTS.ui,
  fontSize: 11,
  color: 'var(--warn)',
  border: '1px solid color-mix(in srgb, var(--warn), transparent 70%)',
  background: 'color-mix(in srgb, var(--warn), transparent 88%)',
  borderRadius: 999,
  padding: '2px 8px',
};

/** Listen-if-present — never blocks. */
const optionalDepStyle: React.CSSProperties = {
  fontFamily: FONTS.ui,
  fontSize: 11,
  color: COLORS.textMuted,
  border: `1px solid ${COLORS.border}`,
  background: 'var(--bg-1)',
  borderRadius: 999,
  padding: '2px 8px',
};

const valueStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  fontFamily: FONTS.ui, fontSize: SIZES.sm, color: COLORS.text,
};

const backBtnStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 5,
  background: 'none', border: 'none', cursor: 'pointer',
  color: COLORS.textMuted, fontFamily: FONTS.ui, fontSize: SIZES.sm, padding: 0,
};
