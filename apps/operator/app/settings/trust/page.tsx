'use client';

/**
 * /settings/trust — the owner's trusted-GitHub-user list control surface
 * (shared-hive-trust-admission-2026-06-14 Phase 4 / P-011, Trust A4).
 *
 * View / add / remove the LOCAL trust list the admission gate
 * (work-items-admission.ts) consults so a VERIFIED trusted author's remote work
 * may auto-run in shared hives. Reads the live list via useSyncQuery('trust.list');
 * writes through the loopback /api/agent-mcp/trust-set route (which re-invalidates
 * the query — no optimistic local state). nuqs holds the search filter; the add-form
 * drafts are local useState (mid-edit, render-only). Owner authority — the same
 * posture as the autonomy policy surface.
 *
 * Security note (D-001): trusting a user is a GRANT, not an arming — an UNVERIFIED
 * author is never auto-admitted regardless of this list.
 */
import { useCallback, useMemo, useState, type CSSProperties, type FormEvent } from 'react';
import { useQueryState, parseAsString } from 'nuqs';
import { useSyncQuery, useSyncMutate } from '@papercusp/sync';
import { useLexicon } from '@/lib/useLexicon';
import { toast } from 'sonner';

/* Wire type — mirrors TrustedUser (operator-core/lib/trust/user-trust-list.ts),
 * kept local per the client wire-type decoupling convention. */
interface TrustedUser {
  githubUserId: number;
  note: string | null;
  /** epoch ms */
  createdTs: number;
}

interface TrustSetArgs {
  action: 'add' | 'remove';
  githubUserId: number;
  note?: string | null;
}

/** REST fallback the sync-mutate hook calls (desktop SSE → the loopback route). */
async function trustSetRest(args: TrustSetArgs): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch('/api/agent-mcp/trust-set', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  const text = await r.text();
  let data: { ok?: boolean; error?: string } = {};
  try {
    data = JSON.parse(text) as { ok?: boolean; error?: string };
  } catch {
    /* non-JSON */
  }
  if (!r.ok || data.ok === false) {
    throw new Error(data.error ?? `HTTP ${r.status}`);
  }
  return { ok: true };
}

function fmtDate(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

const inputStyle: CSSProperties = {
  padding: '6px 10px',
  borderRadius: 6,
  border: '1px solid var(--border)',
  background: 'var(--bg-2)',
  color: 'var(--fg)',
  fontSize: 13,
};
const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: '10px 14px',
  marginBottom: 8,
  background: 'var(--bg)',
};
const removeBtnStyle: CSSProperties = {
  flex: '0 0 auto',
  padding: '4px 12px',
  borderRadius: 6,
  border: '1px solid var(--border)',
  background: 'var(--bg-2)',
  color: 'var(--fg-mute)',
  fontSize: 12,
  cursor: 'pointer',
};

export default function TrustSettingsPage() {
  const t = useLexicon();
  const { data, loading, error } = useSyncQuery<TrustedUser>({ queryName: 'trust.list' });
  const rows = useMemo<TrustedUser[]>(() => data ?? [], [data]);

  const [query, setQuery] = useQueryState('q', parseAsString.withDefault(''));
  const setTrust = useSyncMutate<TrustSetArgs, { ok: boolean; error?: string }>('trust.set', trustSetRest);

  // Mid-edit form drafts — render-only, so useState (not nuqs), per the state policy.
  const [draftId, setDraftId] = useState('');
  const [draftNote, setDraftNote] = useState('');
  const [busy, setBusy] = useState(false);

  const onAdd = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      const id = Number(draftId.trim());
      if (!Number.isInteger(id) || id <= 0) {
        toast.error('Enter a positive GitHub user id (a number).');
        return;
      }
      setBusy(true);
      try {
        await setTrust({ action: 'add', githubUserId: id, note: draftNote.trim() || null });
        // The write fires notifySyncInvalidate('trust.list') server-side → the list refetches.
        setDraftId('');
        setDraftNote('');
        toast.success(`Trusted GitHub user ${id}.`);
      } catch (err) {
        toast.error(`Couldn't trust ${id}: ${err instanceof Error ? err.message : 'failed'}`);
      } finally {
        setBusy(false);
      }
    },
    [draftId, draftNote, setTrust],
  );

  const onRemove = useCallback(
    (u: TrustedUser) => {
      // Untrust is a deliberate authority action (narrows what auto-runs) — confirm via the toast action.
      toast(`Untrust GitHub user ${u.githubUserId}? Their remote work will no longer auto-run.`, {
        action: {
          label: 'Untrust',
          onClick: () =>
            void (async () => {
              try {
                await setTrust({ action: 'remove', githubUserId: u.githubUserId });
                toast.success(`Untrusted ${u.githubUserId}.`);
              } catch (err) {
                toast.error(`Couldn't untrust ${u.githubUserId}: ${err instanceof Error ? err.message : 'failed'}`);
              }
            })(),
        },
      });
    },
    [setTrust],
  );

  const q = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      !q
        ? rows
        : rows.filter((r) => String(r.githubUserId).includes(q) || (r.note ?? '').toLowerCase().includes(q)),
    [rows, q],
  );

  return (
    <div>
      <h1>Trusted users</h1>
      <p className="pc-settings-intro">
        GitHub users whose <strong>verified</strong> remote work may auto-run in shared {t('pot', { plural: true, lower: true })} without
        per-item approval. Trusting a user is a security grant you control — an unverified author is
        never auto-admitted regardless. Identify users by their numeric GitHub user id.
      </p>

      {error && (
        <p role="alert" style={{ color: 'var(--bad)', marginBottom: 16, fontSize: 13 }}>
          Couldn’t load the trust list: {error.message}
        </p>
      )}

      <form
        onSubmit={onAdd}
        style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-end', marginBottom: 20 }}
      >
        <label style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12, color: 'var(--fg-mute)' }}>
          GitHub user id
          <input
            type="text"
            inputMode="numeric"
            value={draftId}
            onChange={(e) => setDraftId(e.target.value)}
            placeholder="e.g. 583231"
            style={inputStyle}
            aria-label="GitHub user id to trust"
          />
        </label>
        <label
          style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12, color: 'var(--fg-mute)', flex: '1 1 220px' }}
        >
          Note (optional)
          <input
            type="text"
            value={draftNote}
            onChange={(e) => setDraftNote(e.target.value)}
            maxLength={200}
            placeholder="who is this?"
            style={inputStyle}
            aria-label="Note for this trusted user"
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          style={{
            padding: '7px 16px',
            borderRadius: 6,
            border: '1px solid var(--border)',
            background: 'var(--accent)',
            color: 'var(--accent-fg, #fff)',
            fontSize: 13,
            fontWeight: 600,
            cursor: busy ? 'default' : 'pointer',
            opacity: busy ? 0.6 : 1,
          }}
        >
          Trust user
        </button>
      </form>

      <div style={{ marginBottom: 12 }}>
        <input
          type="search"
          value={query}
          onChange={(e) => void setQuery(e.target.value || null)}
          placeholder="Filter by id or note…"
          aria-label="Filter trusted users"
          style={{ ...inputStyle, width: 240 }}
        />
      </div>

      {loading && rows.length === 0 ? (
        <p role="status" style={{ color: 'var(--fg-mute)', fontSize: 13 }}>
          Loading trusted users…
        </p>
      ) : visible.length === 0 ? (
        <p style={{ color: 'var(--fg-mute)', fontSize: 13 }}>
          {rows.length === 0
            ? 'No trusted users yet. Add a GitHub user id above to let their verified remote work auto-run.'
            : 'No trusted users match this filter.'}
        </p>
      ) : (
        <section className="pc-settings-section" aria-label="Trusted users">
          {visible.map((u) => (
            <div key={u.githubUserId} style={rowStyle}>
              <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                <span style={{ fontWeight: 600, color: 'var(--fg)', fontVariantNumeric: 'tabular-nums' }}>
                  {u.githubUserId}
                </span>
                {u.note && <span style={{ marginLeft: 10, color: 'var(--fg-mute)', fontSize: 13 }}>{u.note}</span>}
                {fmtDate(u.createdTs) && (
                  <span style={{ marginLeft: 10, color: 'var(--fg-mute)', fontSize: 11, opacity: 0.8 }}>
                    trusted {fmtDate(u.createdTs)}
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => onRemove(u)}
                aria-label={`Untrust GitHub user ${u.githubUserId}`}
                style={removeBtnStyle}
              >
                Untrust
              </button>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
