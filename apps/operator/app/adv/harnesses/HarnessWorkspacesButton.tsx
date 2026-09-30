'use client';

/**
 * HarnessWorkspacesButton — the /adv harness-scoped "Workspaces" affordance
 * (Phase 4 of harnesses-across-workspaces). Surfaces which workspaces the
 * current harness is linked into, and the link / move / remove membership
 * actions:
 *
 *   read:  harnessWorkspaces.byHarness sync query
 *   POST /api/harness/:slug/membership        → { op:'add'|'remove'|'move', … }
 *
 * Semantics (all registry-only — the folder is never moved/copied; D-1):
 *   • Link    — add the harness to another workspace (same path → same link).
 *               This is the "copy" action: it now lives in N workspaces.
 *   • Move    — atomic add-to-target + remove-from-source. Offered only when
 *               the harness is in exactly ONE workspace, so "from where" is
 *               unambiguous. With multiple memberships use Link + Remove.
 *   • Remove  — unlink from a workspace. Disabled on the last membership so a
 *               harness can never be orphaned out of every workspace.
 *
 * Popover anchored to the trigger button.
 */
import { useEffect, useMemo, useState } from 'react';
import { useSyncQuery } from '@papercusp/sync';
import { Boxes } from 'lucide-react';
import { toast } from 'sonner';
import { Popover } from '../../harness/Popover';
import { Tooltip } from '../../harness/Tooltip';
import { listWorkspaces, type Workspace } from '@papercusp/operator-core/lib/workspaces-tauri';

interface Props {
  slug: string;
}

export default function HarnessWorkspacesButton({ slug }: Props) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState<Workspace[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const membershipQuery = useSyncQuery<{ workspaceId: string }>({
    queryName: 'harnessWorkspaces.byHarness',
    args: slug ? { harnessSlug: slug } : undefined,
    enabled: !!slug && open,
  });
  const members = useMemo(
    () => (membershipQuery.data ? membershipQuery.data.map((row) => row.workspaceId) : null),
    [membershipQuery.data],
  );

  const refresh = () => {
    membershipQuery.invalidate?.();
    listWorkspaces()
      .then((reg) => {
        setAll(reg.workspaces);
        setCurrent(reg.current ?? null);
      })
      .catch(() => {});
  };

  // Load membership lazily on first open, and re-load each open so it tracks
  // changes made elsewhere (e.g. the WorkspaceSwitcher create/delete).
  useEffect(() => {
    if (open) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, slug]);

  const post = async (body: Record<string, string>, okMsg: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/harness/${encodeURIComponent(slug)}/membership`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await r.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!r.ok || !data?.ok) {
        toast.error(`membership: ${data?.error ?? `HTTP ${r.status}`}`);
        return;
      }
      toast.success(okMsg);
      refresh();
    } catch (e) {
      toast.error(`membership: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const nameOf = (id: string) => all.find((w) => w.id === id)?.name ?? id;
  const memberCount = members?.length ?? 0;
  const memberSet = new Set(members ?? []);
  const nonMembers = all.filter((w) => !memberSet.has(w.id));
  // "Move" is only unambiguous with a single source workspace.
  const soleSource = memberCount === 1 ? members![0] : null;

  return (
    <span className="pc-hws" style={{ position: 'relative' }}>
      <Popover
        open={open}
        onOpenChange={setOpen}
        side="bottom"
        align="end"
        sideOffset={4}
        zIndex={200}
        ariaLabel="Harness workspaces"
        contentClassName="pc-hws__menu pc-animate-in pc-animate-in--down pc-animate-in--fast"
        contentStyle={{
          minWidth: 260,
          maxHeight: '70vh',
          overflowY: 'auto',
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
          className="pc-hws__trigger"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Harness workspaces"
        >
          <Boxes size={13} aria-hidden />
          Workspaces{members ? ` (${memberCount})` : ''}
        </button>
        }
      >
        <div role="menu">
          <div className="pc-hws__title" style={titleStyle}>
            Linked into{members ? ` — ${memberCount}` : ''}
          </div>
          {members === null && <div style={mutedRow}>loading…</div>}
          {members?.length === 0 && (
            <div style={mutedRow}>not registered in any workspace</div>
          )}
          {(members ?? []).map((id) => {
            const isCurrent = id === current;
            const isLast = memberCount <= 1;
            return (
              <div key={id} className="pc-hws__row" style={rowStyle}>
                <span style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6 }}>
                  {nameOf(id)}
                  {isCurrent && <span style={badgeStyle}>active</span>}
                </span>
                <Tooltip label={isLast ? 'Cannot remove the only workspace — link it elsewhere first' : `Unlink from ${nameOf(id)} (folder untouched)`}>
                  <button
                    type="button"
                    className="pc-hws__act"
                    disabled={busy || isLast}
                    onClick={() => post({ op: 'remove', workspace: id }, `Unlinked '${slug}' from ${nameOf(id)}`)}
                    style={{ ...actStyle, opacity: busy || isLast ? 0.35 : 1, cursor: busy || isLast ? 'not-allowed' : 'pointer' }}
                    aria-label={`Remove from ${nameOf(id)}`}
                  >
                    ✕
                  </button>
                </Tooltip>
              </div>
            );
          })}

          {nonMembers.length > 0 && (
            <>
              <div style={dividerStyle} />
              <div className="pc-hws__title" style={titleStyle}>Add to</div>
              {nonMembers.map((w) => (
                <div key={w.id} className="pc-hws__row" style={rowStyle}>
                  <span style={{ flex: 1 }}>{w.name}</span>
                  {soleSource && (
                    <Tooltip label={`Move from ${nameOf(soleSource)} to ${w.name} (unlink source, link here)`}>
                      <button
                        type="button"
                        className="pc-hws__act pc-hws__act--move"
                        disabled={busy}
                        onClick={() => post({ op: 'move', fromWorkspace: soleSource, toWorkspace: w.id }, `Moved '${slug}' to ${w.name}`)}
                        style={{ ...pillStyle, opacity: busy ? 0.5 : 1 }}
                      >
                        Move here
                      </button>
                    </Tooltip>
                  )}
                  <Tooltip label={`Link '${slug}' into ${w.name} — same folder, now in both workspaces`}>
                    <button
                      type="button"
                      className="pc-hws__act pc-hws__act--link"
                      disabled={busy}
                      onClick={() => post({ op: 'add', toWorkspace: w.id }, `Linked '${slug}' into ${w.name}`)}
                      style={{ ...pillStyle, opacity: busy ? 0.5 : 1 }}
                    >
                      Link
                    </button>
                  </Tooltip>
                </div>
              ))}
            </>
          )}

          <div style={dividerStyle} />
          <div style={{ ...mutedRow, fontSize: 11, lineHeight: 1.4 }}>
            🔗 Membership is registry-only — the folder is never moved or copied.
          </div>
        </div>
      </Popover>

      <style>{`
        .pc-hws__trigger {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          padding: 4px 10px;
          border: 1px solid color-mix(in oklab, #a855f7, transparent 60%);
          border-radius: 999px;
          background: color-mix(in oklab, #a855f7, transparent 84%);
          color: #e7f7ff;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0;
          cursor: pointer;
        }
        .pc-hws__trigger:hover { background: color-mix(in oklab, #a855f7, transparent 70%); }
        .pc-hws__act:hover:not(:disabled) { color: var(--fg, #e7f7ff); border-color: var(--accent, #38bdf8); }
      `}</style>
    </span>
  );
}

const titleStyle: React.CSSProperties = {
  padding: '4px 8px',
  color: 'var(--fg-mute, #777)',
  fontSize: 11,
  textTransform: 'uppercase',
};
const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '4px 8px',
  borderRadius: 3,
  fontSize: 13,
  color: 'var(--fg, #e7f7ff)',
};
const mutedRow: React.CSSProperties = { padding: '4px 8px', color: 'var(--fg-mute, #777)', fontSize: 12 };
const badgeStyle: React.CSSProperties = {
  fontSize: 10,
  textTransform: 'uppercase',
  color: '#10b981',
  border: '1px solid color-mix(in oklab, #10b981, transparent 60%)',
  borderRadius: 999,
  padding: '0 5px',
};
const actStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'var(--fg-mute, #777)',
  padding: '0 4px',
  fontSize: 13,
};
const pillStyle: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--border, #2a3344)',
  color: 'var(--fg-dim, #b9d4e8)',
  borderRadius: 999,
  padding: '2px 9px',
  fontSize: 11,
  fontWeight: 600,
  cursor: 'pointer',
};
const dividerStyle: React.CSSProperties = { height: 1, background: 'var(--border, #2a2a2a)', margin: '4px 0' };
