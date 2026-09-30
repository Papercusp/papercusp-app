import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import { HarnessDock } from '@/app/harness/dock/HarnessDock';
import { registerWorkbenchPanels } from '@/app/harness/dock/workbench-panels';
import { registerWorkbenchVoicePanel } from '../components/workbench/WorkbenchVoicePanel';
import { registerWorkbenchHiveDirectoryPanel } from '../components/workbench/WorkbenchPotDirectoryPanel';
import { onDockApiBind, listPanels, setPanelParams } from '@/app/harness/dock/dock-actions';
import { Select } from '@/app/harness/Select';
import { Tooltip } from '@/app/harness/Tooltip';
import { useLexicon } from '@/lib/useLexicon';

/**
 * /workbench — the top-level desktop workbench
 * (plan `desktop-workbench-shell-2026-06-05`, P-001;
 *  pui pane retired by `native-terminal-desktop-2026-06-06` D-002/D-008).
 *
 * Two GUI panes (left→right): the **main /adv app** and a **voice/video**
 * comms pane. The standalone operator-chat pane is retired (D-001) — the
 * operator chat lives inside the /adv app pane. The **pui/terminal is no
 * longer a pane**: a webview can't host a native terminal, so it runs as a
 * native sibling window glued to the GUI (launched by the Tauri shell).
 *
 * A separate URL from `/adv`, so it doesn't replace the current shell until
 * verified (the plan's isolation guard). The active harness is `?harness=`
 * (nuqs, agent-driveable + deep-linkable); it's patched into the voice panel
 * at runtime (the dock-preview pattern), since the static seed bakes an empty
 * slug. The /adv app pane self-manages its own harness selector.
 */
export const Route = createFileRoute('/workbench')({
  component: WorkbenchPage,
});

interface ProjectLite {
  slug: string;
  title?: string;
}

function WorkbenchPage() {
  // Active brand-pack term resolver (the-hive-lexicon). Reactive to the flag.
  const t = useLexicon();
  const [harness, setHarness] = useQueryState('harness', parseAsString.withDefault(''));
  // LIVE harness registry list (harnessProjects.lite) — auto-updates on
  // create/delete/rename/fork from any operator process (EI-206), replacing the
  // old one-shot /api/harness/projects/lite fetch (data-sync-push P-010).
  const { data: projectsData } = useSyncQuery<ProjectLite>({
    queryName: 'harnessProjects.lite',
    args: { includeHiveHomes: true },
    staleTime: 60_000,
  });
  const projects = projectsData ?? [];

  // Register the workbench panel types before the dock walks the layout.
  // pui + app come from @/app; voice is registered here (operator-vite) since
  // it mounts the operator-vite VideoGrid.
  useEffect(() => {
    registerWorkbenchPanels();
    registerWorkbenchVoicePanel();
    registerWorkbenchHiveDirectoryPanel();
  }, []);

  // Default the selection to the first project when nothing is pinned in the
  // URL yet. One-shot: a ref guards against re-defaulting once the live query
  // pushes a later update (e.g. a new harness lands) or the user picks another.
  const defaultedRef = useRef(false);
  useEffect(() => {
    if (defaultedRef.current || harness || projects.length === 0) return;
    defaultedRef.current = true;
    void setHarness(projects[0].slug);
  }, [harness, projects, setHarness]);

  // Patch the active harness into the voice panel whenever it changes.
  // Mirrors dock-preview: the seed bakes an empty slug, the route fills it in
  // once the dock API is bound (and again on each harness change).
  useEffect(() => {
    return onDockApiBind((api) => {
      if (!api) return;
      const patch = () => {
        try {
          for (const p of listPanels()) {
            if (p.type === 'workbench:voice') {
              if (p.params?.harnessSlug !== harness) {
                setPanelParams(p.id, { ...p.params, harnessSlug: harness });
              }
            }
          }
        } catch {
          /* layout not hydrated yet — re-fires on the next api bind */
        }
      };
      patch();
      api.onDidAddPanel(patch);
    });
  }, [harness]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', minHeight: 0 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '6px 12px',
          borderBottom: '1px solid var(--border, #2a2a2a)',
          background: 'var(--bg-2, #16181d)',
          fontSize: 12,
          color: 'var(--fg)',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <strong>Workbench</strong>
        <span style={{ color: 'var(--fg-mute, #888)' }}>app · peers · terminal (native sibling)</span>
        <div style={{ flex: 1 }} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: 'var(--fg-mute, #888)' }}>{t('pot')}</span>
          <Select
            value={harness || '_none'}
            onChange={(value) => {
              if (value !== '_none') void setHarness(value);
            }}
            testId="workbench-harness-select"
            options={[
              ...(harness === '' ? [{ value: '_none', label: 'select', disabled: true }] : []),
              ...projects.map((p) => ({ value: p.slug, label: p.title ?? p.slug })),
            ]}
            ariaLabel={`${t('pot')} picker`}
            triggerStyle={{ minWidth: 180 }}
          />
        </label>
        <Tooltip label="Reset the workbench layout to the default 3-pane arrangement">
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent('papercusp:dock-reset-layout'))}
            data-testid="workbench-reset-layout"
            style={{ fontSize: 11 }}
          >
            Reset layout
          </button>
        </Tooltip>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <HarnessDock layoutName="workbench" slug={harness} />
      </div>
    </div>
  );
}
