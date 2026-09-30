'use client';


// Workspace switcher dropdown. Renders in both desktop and webapp modes:
// the underlying wrapper falls back to /api/workspaces HTTP endpoints
// when there's no Tauri runtime. Lists workspaces, lets the user pick
// one (write to registry.json + reload), and surfaces create / rename /
// delete actions.

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useQueryState, parseAsString, parseAsBoolean } from 'nuqs';
import { useProgress } from '@bprogress/react';
import {
  Workspace,
  WorkspaceRegistry,
  createWorkspace,
  deleteWorkspace,
  listWorkspaces,
  openWorkspaceWindow,
  renameWorkspace,
  switchWorkspace,
} from '@papercusp/operator-core/lib/workspaces-tauri';
import { useConfirmDialog } from '../harness/useConfirmDialog';
import { usePromptDialog } from '../harness/usePromptDialog';
import { Popover } from '../harness/Popover';
import { Tooltip } from '../harness/Tooltip';
import { useLexicon } from '@/lib/useLexicon';
import { getBrowserWorkspaceId, resolveActiveWorkspaceId } from '@papercusp/operator-core/lib/browser-workspace';

export default function WorkspaceSwitcher() {
  const t = useLexicon();
  const [reg, setReg] = useState<WorkspaceRegistry | null>(null);
  const [open, setOpen] = useQueryState('wsSwitch', parseAsBoolean.withDefault(false));
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();
  const { prompt: askPrompt, element: promptEl } = usePromptDialog();

  const [, setWsParam] = useQueryState('ws', parseAsString);
  const progress = useProgress();

  useEffect(() => {
    listWorkspaces()
      .then((r) => {
        setReg(r);
        // Mirror THIS WINDOW's active workspace into the URL so refreshes /
        // share-links surface which workspace this view belongs to. Resolved
        // from getBrowserWorkspaceId() (__PAPERCUSP_WS__ / ?ws=), NEVER the
        // process-global reg.current — on a shared dev sidecar that one value
        // drives every window, and writing it here flipped a window that
        // opened a different workspace to whatever the global pointed at (the
        // P-030 reload-flip). reg.current is only the new-window default (D-005).
        const active = resolveActiveWorkspaceId(r, getBrowserWorkspaceId());
        if (active && active !== 'default') void setWsParam(active);
      })
      .catch((e) => toast.error(`workspaces: ${e?.message ?? e}`));
  }, [setWsParam]);

  if (!reg || reg.workspaces.length === 0) return null;

  // The workspace THIS WINDOW is active in (P-030 / D-005) — resolved from the
  // window's own id, not the process-global reg.current. Drives the trigger
  // label, the "active" highlight, and the switch/delete guards. A row is
  // undeletable if the window is operating in it (activeId) or it's the
  // new-window default (reg.current) — removing either pulls a rug out.
  const activeId = resolveActiveWorkspaceId(reg, getBrowserWorkspaceId());
  const current = reg.workspaces.find((w) => w.id === activeId) ?? reg.workspaces[0];
  const undeletable = (id: string) => id === activeId || id === reg.current;

  const refresh = () => listWorkspaces().then(setReg).catch(() => {});

  const onCreate = async () => {
    const name = await askPrompt({
      title: 'New workspace',
      label: 'Workspace name',
      placeholder: 'my-workspace',
      submitLabel: 'Create',
      validate: (v) => v.length > 64 ? 'Max 64 characters' : null,
    });
    if (!name) return;
    let created: Workspace;
    try {
      created = await createWorkspace(name);
    } catch (e: any) {
      toast.error(`create failed: ${e?.message ?? e}`);
      return;
    }
    // Auto-switch this window straight into the freshly created workspace —
    // creating it IS the intent to use it, so (unlike onSwitch) there's no
    // confirm dialog. switchWorkspace persists the registry default then
    // hard-navigates to ?ws=<id>, reloading the view under us; the reload
    // makes refresh() moot. Only if the switch itself fails do we fall back
    // to refreshing the list so the new workspace is at least pickable.
    setOpen(false);
    progress.start(0.08, 0, true);
    try {
      await switchWorkspace(created.id, { resetTo: `/harness?ws=${encodeURIComponent(created.id)}` });
    } catch (e: any) {
      toast.error(`workspace "${name}" created, but switch failed: ${e?.message ?? e}`);
      progress.stop(120);
      await refresh();
    }
  };

  const onSwitch = async (id: string) => {
    if (id === activeId) return setOpen(false);
    const target = reg.workspaces.find((w) => w.id === id)?.name ?? id;
    if (!await askConfirm({
      title: `Switch to "${target}"?`,
      body: 'This window will reload into the selected workspace.',
      confirmLabel: 'Switch',
    })) return;
    progress.start(0.08, 0, true);
    try {
      // Phase E (P-050): no longer a restart. switchWorkspace persists the
      // registry default then navigates THIS window to ?ws=<id> (other windows
      // are untouched, P-031); the navigation reloads the view under us.
      await switchWorkspace(id, { resetTo: `/harness?ws=${encodeURIComponent(id)}` });
    } catch (e: any) {
      toast.error(`switch failed: ${e?.message ?? e}`);
      progress.stop(120);
    }
  };

  // Phase E (P-053): open the workspace in a SEPARATE window against the one
  // shared sidecar (desktop) / a new tab (webapp). Leaves this window as-is.
  const onOpenWindow = async (id: string) => {
    setOpen(false);
    try {
      await openWorkspaceWindow(id);
    } catch (e: any) {
      toast.error(`open window failed: ${e?.message ?? e}`);
    }
  };

  const startRename = (ws: Workspace) => {
    setRenamingId(ws.id);
    setRenameValue(ws.name);
  };

  const commitRename = async () => {
    if (!renamingId) return;
    const trimmed = renameValue.trim();
    if (!trimmed) {
      setRenamingId(null);
      return;
    }
    try {
      await renameWorkspace(renamingId, trimmed);
      await refresh();
    } catch (e: any) {
      toast.error(`rename failed: ${e?.message ?? e}`);
    } finally {
      setRenamingId(null);
    }
  };

  const onDelete = async (ws: Workspace) => {
    if (ws.id === activeId) {
      toast.error('switch to another workspace before deleting this one');
      return;
    }
    if (ws.id === reg.current) {
      toast.error('this is the default workspace new windows open into — set another default first');
      return;
    }
    if (!await askConfirm({
      title: `Delete workspace "${ws.name}"?`,
      body: `Its database, ${t('pot', { plural: true })}, snapshots, and credentials are removed permanently. Type the workspace name to confirm.`,
      confirmLabel: 'Delete workspace',
      destructive: true,
      requireType: ws.name,
    })) return;
    try {
      await deleteWorkspace(ws.id);
      await refresh();
      toast.success(`deleted "${ws.name}"`);
    } catch (e: any) {
      toast.error(`delete failed: ${e?.message ?? e}`);
    }
  };

  return (
    <span ref={wrapRef} className="pc-workspace-switcher" style={{ position: 'relative', fontSize: 13 }}>
      {confirmEl}
      {promptEl}
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setRenamingId(null);
        }}
        side="bottom"
        align="end"
        sideOffset={4}
        zIndex={200}
        ariaLabel="Switch or manage workspaces"
        closeOnEscape={renamingId === null}
        contentClassName="pc-workspace-menu pc-animate-in pc-animate-in--down pc-animate-in--fast"
        contentStyle={{
          minWidth: 240,
          // Solid tokenized surface; Popover portals to <body> so the
          // dropdown escapes `.pc-header`'s sticky stacking context.
          background: 'var(--bg-popover)',
          backdropFilter: 'none',
          WebkitBackdropFilter: 'none',
          border: '1px solid var(--border)',
          borderRadius: 6,
          padding: 4,
          boxShadow: '0 12px 32px color-mix(in oklab, black, transparent 40%), 0 0 0 1px color-mix(in oklab, var(--fg), transparent 96%)',
        }}
        trigger={
        <button
          type="button"
          className="pc-workspace-trigger"
          style={{
            background: 'transparent',
            border: '1px solid var(--border)',
            color: 'var(--fg-dim)',
            padding: '3px 8px',
            borderRadius: 4,
            cursor: 'pointer',
            font: 'inherit',
          }}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Switch or manage workspaces"
        >
          {current?.name ?? 'workspace'} <span className="pc-workspace-trigger-caret" style={{ opacity: 0.6 }}>▾</span>
        </button>
        }
      >
        <div role="menu">
          <div className="pc-workspace-menu-title" style={{ padding: '4px 8px', color: 'var(--fg-mute)', fontSize: 11, textTransform: 'uppercase' }}>
            Workspaces
          </div>
          {reg.workspaces.map((ws) => {
            const isCurrent = ws.id === activeId;
            const isRenaming = ws.id === renamingId;
            return (
              <div
                key={ws.id}
                className={`pc-workspace-menu-row${isCurrent ? ' is-current' : ''}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '4px 8px',
                  borderRadius: 3,
                  background: isCurrent ? 'var(--accent)' : 'transparent',
                }}
              >
                {isRenaming ? (
                  <input
                    autoFocus
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename();
                      if (e.key === 'Escape') setRenamingId(null);
                    }}
                    className="pc-workspace-menu-input"
                    style={{ flex: 1, font: 'inherit', background: 'var(--bg-2)', border: '1px solid var(--border)', color: 'inherit', padding: '2px 6px', borderRadius: 3 }}
                  />
                ) : (
                  <Tooltip label={isCurrent ? 'current workspace' : `switch to ${ws.name}`}><button
                    type="button"
                    onClick={() => onSwitch(ws.id)}
                    className="pc-workspace-menu-target"
                    style={{
                      flex: 1,
                      textAlign: 'left',
                      background: 'transparent',
                      border: 'none',
                      color: 'inherit',
                      cursor: isCurrent ? 'default' : 'pointer',
                      font: 'inherit',
                      padding: 0,
                    }}

                  >
                    {ws.name}
                    {isCurrent && (
                      <span className="pc-workspace-menu-current" style={{ marginLeft: 6, color: 'var(--fg-mute)', fontSize: 11 }}>
                        active
                      </span>
                    )}
                  </button></Tooltip>
                )}
                {!isRenaming && (
                  <>
                    <Tooltip label={`Open "${ws.name}" in a new window`}><button
                      type="button"
                      onClick={() => onOpenWindow(ws.id)}

                      aria-label={`Open ${ws.name} in a new window`}
                      className="pc-workspace-menu-action"
                      style={{ background: 'transparent', border: 'none', color: 'var(--fg-mute)', cursor: 'pointer', padding: '0 4px' }}
                    >
                      ⧉
                    </button></Tooltip>
                    <Tooltip label="Rename"><button
                      type="button"
                      onClick={() => startRename(ws)}

                      aria-label={`Rename ${ws.name}`}
                      className="pc-workspace-menu-action"
                      style={{ background: 'transparent', border: 'none', color: 'var(--fg-mute)', cursor: 'pointer', padding: '0 4px' }}
                    >
                      ✎
                    </button></Tooltip>
                    <Tooltip label="Delete"><button
                      type="button"
                      onClick={() => onDelete(ws)}

                      aria-label={`Delete ${ws.name}`}
                      disabled={undeletable(ws.id) || reg.workspaces.length <= 1}
                      className="pc-workspace-menu-action"
                      style={{ background: 'transparent', border: 'none', color: 'var(--fg-mute)', cursor: undeletable(ws.id) || reg.workspaces.length <= 1 ? 'not-allowed' : 'pointer', padding: '0 4px', opacity: undeletable(ws.id) || reg.workspaces.length <= 1 ? 0.3 : 1 }}
                    >
                      ✕
                    </button></Tooltip>
                  </>
                )}
              </div>
            );
          })}
          <div className="pc-workspace-menu-divider" style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />
          <button
            type="button"
            onClick={onCreate}
            className="pc-workspace-menu-create"
            style={{
              width: '100%',
              textAlign: 'left',
              background: 'transparent',
              border: 'none',
              color: 'inherit',
              cursor: 'pointer',
              font: 'inherit',
              padding: '4px 8px',
              borderRadius: 3,
            }}
          >
            + New workspace…
          </button>
        </div>
      </Popover>
    </span>
  );
}
