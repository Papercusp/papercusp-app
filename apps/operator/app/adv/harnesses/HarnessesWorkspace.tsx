'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import { Plus } from 'lucide-react';
import { parseAsString, parseAsStringEnum, useQueryState } from 'nuqs';
import { HARNESS_SCOPE_MODES, type HarnessScopeMode } from '@papercusp/operator-core/lib/harness/scope';
import { HarnessLexiconProvider, useLexicon } from '@/lib/useLexicon';
import { useWorkspaceLabel } from '@/lib/useWorkspaceLabel';
import HarnessTopBar from './HarnessTopBar';
import HarnessesDock from './HarnessesDock';
import HarnessWelcome from './HarnessWelcome';
import PotMemberRail from './PotMemberRail';
import PotWorkspaceCards from './PotWorkspaceCards';
import { CreateHarnessPicker } from '../../harness/CreateHarnessPicker';
import { useSyncQuery } from '@papercusp/sync';
import { hiveMembers, resolveFocusedMember, resolveDockSlug, isHarnessParamStale } from './harness-axis';
import { groupByHive } from './harness-pot-groups';
import './adv-dock.css';
import './adv-panel-chrome.css';

export interface AdvProjectEntry {
  slug: string;
  path: string;
  hasState: boolean;
  hasSpec: boolean;
  // projects/lite also carries the hive-grouping fields (P-012): parent_slug
  // + harness_kind drive the member axis, is_shared the rail badge. Optional
  // so older payloads / fixtures stay valid.
  parent_slug?: string | null;
  harness_kind?: string | null;
  is_shared?: boolean;
  /** One-line brief (SPEC.md first prose line) — powers the All-Pots list Description column. */
  description?: string | null;
}

/**
 * /adv/harnesses — the hive-aware Harnesses workspace (replaces the legacy
 * /harness OPS surface).
 *
 * Two URL axes (harnesses-tab-hive-model-2026-06-07 D-001): `?slug=` is the
 * HIVE / root scope (owned by the shell selector); `?harness=` is the MEMBER
 * focus within that hive (owned here). `?scope=all` (the shell's "All Pots")
 * switches to the hive-grouped workspace overview (D-003).
 *
 * The member rail (P-002) is the in-tab place to select among a hive's
 * member harnesses — the affordance the tab was missing. Harness creation is
 * reached via the empty-state CTAs and the all-mode workspace cards (the
 * bottom-right "New harness" FAB is removed — deprecated).
 */
export default function HarnessesWorkspace() {
  const t = useLexicon();
  const workspaceLabel = useWorkspaceLabel();
  // `?slug=` is the HIVE / root scope (owned by the shell selector). The new
  // `?harness=` axis is the MEMBER focus within that hive — which member's
  // dock is open. Nullable: unset means "use the hive's default member"
  // (D-001). Only this tab reads `?harness=`, so `?slug=` semantics stay
  // untouched everywhere else (P-001).
  const [slug, setSlug] = useQueryState('slug', parseAsString.withDefault(''));
  const [harness, setHarness] = useQueryState('harness', parseAsString);
  // `?scope=` is the shell's orthogonal scope axis; `all` is "All Pots". We
  // read it here to swap the single-hive dock for the hive-grouped workspace
  // cards (P-003 / D-003), and write it on drill-in to exit all-mode.
  const [scopeMode, setScopeMode] = useQueryState(
    'scope',
    parseAsStringEnum<HarnessScopeMode>([...HARNESS_SCOPE_MODES]).withDefault('expanded'),
  );
  const [createOpen, setCreateOpen] = useState(false);

  // EI-206: the registry list rides @papercusp/sync (queryName
  // harnessProjects.lite, invalidated from the registry write seam in
  // harness-registry.ts), so a harness created/deleted from ANY window or
  // agent process appears here without a remount. Rows are the lite
  // `projects` array; the hive grouping is recomputed via the shared
  // groupByHive (the same module the server grouping used, P-021).
  const projectsQuery = useSyncQuery<AdvProjectEntry>({
    queryName: 'harnessProjects.lite',
    args: { includeHiveHomes: true },
  });
  const projects = projectsQuery.data ?? [];
  const projectsError = projectsQuery.error ? projectsQuery.error.message : null;
  const refreshProjects = useCallback(
    () => projectsQuery.invalidate(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectsQuery.invalidate],
  );

  const allMode = scopeMode === 'all';

  // The hive's members (root first, then parent_slug children) and the
  // focused member the dock should render. Pure logic in ./harness-axis so
  // it's unit-tested + shared with the member rail (P-002).
  const members = useMemo(() => hiveMembers(projects, slug || null), [projects, slug]);
  // Whether the active `?slug=` resolves to a live kind:'hive' home — gates the
  // CreateHarnessPicker's into-hive "Add to <hive>" fork. The URL param outlives
  // the entity, so a removed hive or a non-hive harness must NOT enable into-hive
  // (submitting it posts intoHive=<slug> → backend `hive_not_found`).
  const activeIsHive = useMemo(
    () => projects.some((p) => p.slug === slug && p.harness_kind === 'hive'),
    [projects, slug],
  );
  const focusedMember = useMemo(
    () => resolveFocusedMember({ members, urlHarness: harness }),
    [members, harness],
  );
  // The harness the dock + meta line + work-items panel target. A FORMAL hive
  // home (harness_kind:'hive') is excluded from its own member list, so without
  // resolveDockSlug a hive-home selection with no explicit ?harness= would
  // auto-focus members[0] (its first child) and the work-items panel would query
  // the wrong harness — the "papercusp parent still shows hive-canary items"
  // bug. resolveDockSlug shows the selected hive's OWN content instead. (Still
  // falls back to the focused member for a drill-in / ghost root, and to the raw
  // slug while projects/lite loads so the solo case mounts with no flash.)
  const dockSlug = resolveDockSlug({
    slug: slug || null,
    urlHarness: harness,
    members,
    projects,
    focusedMember,
  });

  // Zero-new-poller liveness hint for the rail (P-002): `hasState` from the
  // already-fetched projects/lite payload (the harness has been set up).
  const livenessBySlug = useMemo(
    () => Object.fromEntries(projects.map((p) => [p.slug, !!p.hasState])),
    [projects],
  );

  // All-mode (P-003): every hive in the workspace, grouped by root subtree.
  const groups = useMemo(() => groupByHive(projects), [projects]);

  // Drop a stale `?harness=` when the shell selector switches `?slug=` to a
  // different hive (the value no longer names a member). Guarded inside
  // isHarnessParamStale on members-loaded so a valid deep link isn't cleared
  // before projects/lite arrives.
  useEffect(() => {
    if (isHarnessParamStale(members, harness)) void setHarness(null);
  }, [members, harness, setHarness]);

  const handleCreated = useCallback(
    (newSlug: string, opts?: { hive?: string }) => {
      void refreshProjects();
      if (opts?.hive && opts.hive === slug) {
        // Added INTO the current hive (P-011): land the new member focused in the
        // rail — keep `?slug=` on the hive, set `?harness=` to the new member.
        void setHarness(newSlug);
      } else {
        // A new hive / standalone harness becomes the focused scope.
        void setSlug(newSlug);
        void setHarness(null);
      }
    },
    [refreshProjects, setSlug, setHarness, slug],
  );

  // Drill from an all-mode card into one member (D-003). Writes are SEQUENTIAL
  // — a same-tick scope+slug+harness triple collides in the nuqs adapter (last
  // write wins), the exact pattern AdvShell documents for its own onChange. We
  // exit all-mode (scope=expanded), set the hive, then the member (null when
  // it's the root — the default focus, keeping URLs clean).
  const drillIntoMember = useCallback(
    async (potSlug: string, memberSlug: string) => {
      await setScopeMode('expanded');
      await setSlug(potSlug);
      await setHarness(memberSlug === potSlug ? null : memberSlug);
    },
    [setScopeMode, setSlug, setHarness],
  );

  const hiveLabel = t('pot');
  const hivesLabel = t('pot', { plural: true });

  // NOTE (owner ask 2026-07-27): the HiveHeaderStrip that used to render here —
  // the pot's "face" (name · 👑 POT · directory badge · N Harnesses · N/N set up ·
  // Share… · beacon toggle) — is GONE, component and all. The pot bar (AdvPotBar,
  // added the same day) sits directly above this tab and already carries the pot
  // identity, the selector, and Share, so the strip was a second, staler copy of
  // the same row. Its two controls with no other home — the beacon toggle and
  // (via HarnessTopBar) Workspaces / Register sub-pots — moved onto the pot bar,
  // which renders on every pot-scoped tab. Do not reintroduce a per-tab pot header
  // here: if a pot-level affordance is missing, it belongs on the pot bar.

  return (
    <div className="pc-adv-harnesses pc-adv-dock">
      {allMode ? (
        // All-mode (D-003): the hive-grouped workspace overview replaces the
        // stale single-harness dock the tab used to keep showing.
        <PotWorkspaceCards
          groups={groups}
          workspaceLabel={workspaceLabel}
          onDrill={(hive, member) => void drillIntoMember(hive, member)}
          onCreate={() => setCreateOpen(true)}
        />
      ) : (
        <HarnessLexiconProvider harnessSlug={dockSlug ?? ''}>
          {/* The dock, meta line, and welcome all key off the FOCUSED MEMBER
              (`?harness=` resolved against the hive's members), not the raw hive
              `?slug=` — so a hive with several member harnesses shows the picked
              one. Solo harnesses resolve dockSlug === slug (zero regression). */}
          <HarnessTopBar slug={dockSlug ?? ''} />
          <div className="pc-adv-harnesses__body">
            {/* The member rail (P-002) — the in-tab harness selector. Renders
                nothing for solo hives (single member → no choice). */}
            <PotMemberRail
              members={members}
              activeSlug={dockSlug}
              onSelect={(memberSlug) => void setHarness(memberSlug)}
              livenessBySlug={livenessBySlug}
            />
            <div className="pc-adv-harnesses__dock">
              {dockSlug ? (
                <>
                  <HarnessesDock slug={dockSlug} />
                  {/* No-work welcome overlay (spec-md-ui-deprecation P-005 /
                      D-002): shows the owner's onboarding copy over the dock
                      while the harness has zero features + zero issues. */}
                  <HarnessWelcome slug={dockSlug} />
                </>
              ) : (
                <div className="pc-adv-harnesses__empty">
                  {projectsError ? (
                    <>Failed to load {hivesLabel.toLowerCase()}: {projectsError}</>
                  ) : projects.length === 0 ? (
                    <>
                      <div>No {hivesLabel.toLowerCase()} yet.</div>
                      <button
                        type="button"
                        className="pc-adv-harnesses__create-cta"
                        onClick={() => setCreateOpen(true)}
                      >
                        <Plus size={14} aria-hidden /> Create a {hiveLabel.toLowerCase()}
                      </button>
                    </>
                  ) : (
                    <>
                      {/* Hive-aware empty state (P-004) — replaces the retired
                          single-harness "Pick a harness from the selector above". */}
                      <div>Select a {hiveLabel.toLowerCase()} from the selector above to open it.</div>
                      <button
                        type="button"
                        className="pc-adv-harnesses__create-cta"
                        onClick={() => setCreateOpen(true)}
                      >
                        <Plus size={14} aria-hidden /> Create a {hiveLabel.toLowerCase()}
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </HarnessLexiconProvider>
      )}

      <CreateHarnessPicker
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={handleCreated}
        hiveScope={activeIsHive ? slug : null}
        hiveLabel={hiveLabel}
      />

      <style>{`
        .pc-adv-harnesses {
          flex: 1;
          min-height: 0;
          display: flex;
          flex-direction: column;
          height: 100%;
          position: relative;
        }
        .pc-adv-harnesses__body {
          flex: 1;
          min-height: 0;
          display: flex;
          min-width: 0;
        }
        .pc-adv-harnesses__dock {
          flex: 1;
          min-height: 0;
          min-width: 0;
          position: relative;
        }
        .pc-adv-harnesses__empty {
          height: 100%;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 14px;
          padding: 24px;
          color: var(--fg-mute, #7f9bb4);
          font-size: 13px;
          text-align: center;
        }
        .pc-adv-harnesses__create-cta {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 8px 14px;
          background: color-mix(in oklab, var(--accent, #38bdf8), transparent 80%);
          color: var(--fg, #e7f7ff);
          border: 1px solid color-mix(in oklab, var(--accent, #38bdf8), transparent 55%);
          border-radius: 6px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
        }
        .pc-adv-harnesses__create-cta:hover {
          background: color-mix(in oklab, var(--accent, #38bdf8), transparent 65%);
        }
        /* Blue-frost dock theme now lives in the shared ./adv-dock.css
           (scoped to .pc-adv-dock — applied here and on the Git dock). */
      `}</style>
    </div>
  );
}
