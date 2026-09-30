'use client';

/**
 * AdvGitDock — the dockview shell for the /adv Git page. A sibling of
 * HarnessesDock, scoped to two panel types: the RichGrid git-graph
 * (`adv:git-graph`) and pull requests (`adv:prs`). Seeded by
 * `defaultAdvGitLayout` (lib/dock-layouts.ts) under the `adv-git:<slug>`
 * layout name.
 *
 * Like HarnessesDock, it rebinds every panel's `harnessSlug` param when the
 * active slug changes so a slug switch refetches without remounting.
 */

import { useEffect } from 'react';
import { HarnessDock } from '../../harness/dock/HarnessDock';
import { panelRegistry } from '../../harness/dock/panel-registry';
import { closePanel, listPanels, onDockApiBind, openPanel, setPanelParams } from '../../harness/dock/dock-actions';
import AdvGitGraphPanel from './AdvGitGraphPanel';
import AdvPrsPanel from './AdvPrsPanel';

/** The git dock holds exactly these two panel types — nothing else. */
const ALLOWED_TYPES = ['adv:git-graph', 'adv:prs'] as const;
type AllowedType = (typeof ALLOWED_TYPES)[number];
function isAllowed(type: string): type is AllowedType {
  return (ALLOWED_TYPES as readonly string[]).includes(type);
}

let registered = false;
function ensureRegistered() {
  if (registered) return;
  panelRegistry.register('adv:git-graph', AdvGitGraphPanel, { title: 'Git graph' });
  panelRegistry.register('adv:prs', AdvPrsPanel, { title: 'Pull requests' });
  registered = true;
}

export default function AdvGitDock({ slug }: { slug: string }) {
  useEffect(() => {
    ensureRegistered();
  }, []);

  // `adv-git2` (bumped from `adv-git`): a git layout persisted before the
  // seed wiring existed fell back to the dashboard layout (features/issues/
  // agents/logs). The new name has no such row, so it seeds fresh from
  // defaultAdvGitLayout (git graph + PRs only).
  const layoutName = slug ? `adv-git2:${slug}` : 'adv-git2';

  // Two jobs on every dock bind:
  //   1. Rebind each panel's harnessSlug when the active slug changes (same
  //      trick HarnessesDock uses) so panels refetch for the new harness.
  //   2. Enforce the git-dock invariant — only git-graph + PRs. The server
  //      seed is authoritative when present, but a stale/legacy layout (e.g.
  //      seeded as the dashboard layout before this dock existed) can hydrate
  //      foreign panels; we prune them, dedupe, and open whichever of the two
  //      git panels is missing. The dock's layout auto-save then persists the
  //      corrected layout, so it self-heals after the first load. `normalize`
  //      is debounced so it runs once after hydration settles, then converges
  //      (re-running after its own opens is a no-op).
  useEffect(() => {
    if (!slug) return;
    let addPanelDispose: { dispose: () => void } | null = null;
    let normTimer: number | null = null;

    const patch = (p: { id: string; params: Record<string, unknown> }) => {
      if (p.params.harnessSlug !== slug) {
        setPanelParams(p.id, { ...p.params, harnessSlug: slug });
      }
    };

    const normalize = () => {
      try {
        const seen = new Set<string>();
        for (const p of listPanels()) {
          if (!isAllowed(p.type) || seen.has(p.type)) {
            closePanel(p.id); // foreign type OR duplicate
          } else {
            seen.add(p.type);
          }
        }
        if (!seen.has('adv:git-graph')) {
          openPanel({ type: 'adv:git-graph', params: { harnessSlug: slug }, title: 'Git graph' });
        }
        if (!seen.has('adv:prs')) {
          openPanel({ type: 'adv:prs', params: { harnessSlug: slug }, title: 'Pull requests' });
        }
      } catch {
        /* dock not hydrated yet; the next onDidAddPanel reschedules */
      }
    };
    const scheduleNormalize = () => {
      if (normTimer !== null) window.clearTimeout(normTimer);
      normTimer = window.setTimeout(normalize, 250);
    };

    const unbind = onDockApiBind((api) => {
      if (addPanelDispose) {
        addPanelDispose.dispose();
        addPanelDispose = null;
      }
      if (!api) return;
      try {
        for (const p of listPanels()) patch(p);
      } catch {
        /* dock not yet hydrated; onDidAddPanel covers it */
      }
      scheduleNormalize();
      addPanelDispose = api.onDidAddPanel((panel) => {
        try {
          const found = listPanels().find((x) => x.id === panel.id);
          if (found && isAllowed(found.type)) patch(found);
        } catch {
          /* ignore */
        }
        scheduleNormalize();
      });
    });
    return () => {
      if (normTimer !== null) window.clearTimeout(normTimer);
      if (addPanelDispose) addPanelDispose.dispose();
      unbind();
    };
  }, [slug]);

  // Absolute fill (see HarnessesDock for the WebKitGTK height:100% rationale).
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <HarnessDock layoutName={layoutName} className="dockview-theme-dark" slug={slug} />
    </div>
  );
}
