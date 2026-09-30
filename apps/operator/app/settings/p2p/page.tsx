'use client';

/**
 * /settings/p2p — the P2P work-sharing owner surface
 * (p2p-work-distribution-2026-07-02 P-002).
 *
 * Sections: Identity & devices (attestation state per device — missing/stale =
 * RED badge, never silent) · Peers (capability matrix; store = Lane A's P-001,
 * renders a LOUD pending state until its resolver lands) · Work opt-in
 * (per-fleet / any-fleet, concurrency cap, schedule windows) · Budgets (the
 * live P-201 allotment board) · Live foreign work NOW (the P-104 host-local
 * registry) · Audit · the GLOBAL KILL-SWITCH (M10: stop new claims + graceful
 * wind-down with receipts, never freeze; X13: bounded — grace T then mechanical
 * kill) · the m18 one-click starter profile.
 *
 * Layering (the queen/overwatch pattern): every opt-in edit targets a chosen
 * LAYER — the current-workspace OVERRIDE or the all-workspaces DEFAULT — and
 * the effective settings are the field-level merge. nuqs holds the layer
 * selector (agent → UI control surface reads the URL); mid-edit drafts are
 * local useState per the state policy.
 *
 * Reads `p2p.settings` / `p2p.devices` / `p2p.audit` via useSyncQuery; writes
 * through the loopback /api/agent-mcp/p2p-settings-set route (which fires the
 * name-only notifySyncInvalidate('p2p.settings')). Flag-gated behind
 * FLAGS.P2P (default ON — the fleet kill-switch; inertness is structural:
 * opt-in off + zero grants by default).
 */
import Link from 'next/link';
import { useCallback, useMemo, useState, type CSSProperties } from 'react';
import { useQueryState, parseAsString, parseAsStringEnum } from 'nuqs';
import { useSyncQuery, useSyncMutate } from '@papercusp/sync';
import { toast } from 'sonner';
import { useLexicon } from '@/lib/useLexicon';
import { Select } from '../../harness/Select';
import { Checkbox } from '../../harness/Checkbox';
import { Table } from '../../harness/Table';

/* ── Wire types — mirror operator-core/lib/p2p/settings.ts, kept local per the
 *    client wire-type decoupling convention. ── */
interface P2pScheduleWindow {
  days: number[];
  startMin: number;
  endMin: number;
}
type P2pOptInMode = 'off' | 'selected-fleets' | 'any-fleet';
interface P2pWorkOptIn {
  mode: P2pOptInMode;
  fleets: string[];
  maxConcurrentForeign: number;
  windows: P2pScheduleWindow[];
}
interface P2pKillSwitch {
  engaged: boolean;
  engagedAtMs: number | null;
  reason: string | null;
  windDownGraceSec: number;
}
interface P2pSettings {
  optIn: P2pWorkOptIn;
  killSwitch: P2pKillSwitch;
}
interface P2pSettingsLayers {
  workspaceId: string;
  baked: P2pSettings;
  defaultLayer: Partial<P2pSettings> | null;
  overrideLayer: Partial<P2pSettings> | null;
  effective: P2pSettings;
  unavailable?: true;
  unavailableKind?: 'pre-migration' | 'read-failed';
  unavailableReason?: string;
}

interface UnavailableRow {
  kind: 'unavailable';
  unavailable: true;
  unavailableKind: 'pre-migration' | 'read-failed';
  unavailableReason: string;
}

type DeviceRow =
  | { kind: 'identity'; githubUserId: number | null; devicePubkey: string | null }
  | {
      kind: 'device';
      potHomeSlug: string;
      devicePubkey: string;
      deviceLabel: string | null;
      attestedAtMs: number | null;
      gistUrl: string | null;
      revoked: boolean;
      isThisDevice: boolean;
    }
  | { kind: 'missing'; potHomeSlug: string }
  | UnavailableRow;

/* Wire type — mirrors PeerGrant (operator-core/lib/p2p/grant-store.ts), kept
 * local per the client wire-type decoupling convention. */
interface PeerGrant {
  potSlug: string;
  grantorGithubUserId: number;
  grantorLogin: string | null;
  granteeKind: 'fleet' | 'pool';
  granteeRef: string;
  capabilities: string[];
  preset: string | null;
  status: 'active' | 'revoked';
  grantorEpoch: number;
  wakeRateCapPerHour: number | null;
  excludedDevicePubkeys: string[];
  note: string | null;
}

/** Preset labels mirror P2P_PRESETS (operator-core/lib/p2p/capabilities.ts);
 *  the route expands them server-side so stored capabilities never drift. */
const GRANT_PRESETS = ['Observer', 'Collaborator', 'Delegate', 'Operator'] as const;

interface GrantSetArgs {
  action: 'set' | 'revoke';
  potSlug: string;
  granteeKind: 'fleet' | 'pool';
  granteeRef: string;
  preset?: string | null;
  note?: string | null;
}

/** REST fallback for grant writes (desktop SSE → the loopback route). */
async function p2pGrantSetRest(args: GrantSetArgs): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch('/api/agent-mcp/p2p-grant-set', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  const text = await r.text();
  let data: { ok?: boolean; error?: string; detail?: string } = {};
  try {
    data = JSON.parse(text) as typeof data;
  } catch {
    /* non-JSON */
  }
  if (!r.ok || data.ok === false) throw new Error(data.detail ?? data.error ?? `HTTP ${r.status}`);
  return { ok: true };
}

interface AuditRow {
  id: string;
  ts: number;
  actor: string;
  action: string;
  subject: string;
  details: Record<string, unknown> | null;
}

function isUnavailableRow(row: unknown): row is UnavailableRow {
  return Boolean(
    row
      && typeof row === 'object'
      && (row as { kind?: unknown }).kind === 'unavailable'
      && (row as { unavailable?: unknown }).unavailable === true,
  );
}

/** Host-local execution registry row — mirrors p2p/foreign-workspaces.ts.
 * Paths stay server-side: the owner surface needs lifecycle identity/status,
 * not a disclosure of local filesystem layout. */
interface ForeignWorkspaceRow {
  workspaceId: string;
  offerId: string;
  fleetSlug: string;
  sessionId: string | null;
  state: 'provisioning' | 'active' | 'winding-down' | 'parked' | 'reaped';
  parkReason: string | null;
  updatedAt: number;
}

interface SetArgs {
  action: 'set' | 'clear-layer' | 'kill-switch' | 'starter-profile';
  layer?: 'default' | 'workspace';
  patch?: unknown;
  engage?: boolean;
  reason?: string | null;
}
interface SetResp {
  ok: boolean;
  error?: string;
  layers?: P2pSettingsLayers;
}

/** REST fallback the sync-mutate hook calls (desktop SSE → the loopback route). */
async function p2pSettingsSetRest(args: SetArgs): Promise<SetResp> {
  const r = await fetch('/api/agent-mcp/p2p-settings-set', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  const text = await r.text();
  let data: SetResp = { ok: false };
  try {
    data = JSON.parse(text) as SetResp;
  } catch {
    /* non-JSON */
  }
  if (!r.ok || data.ok === false) throw new Error(data.error ?? `HTTP ${r.status}`);
  return data;
}

/* ── Small helpers ── */
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const minToHHMM = (m: number): string =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const hhmmToMin = (s: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return v >= 0 && v < 1440 ? v : null;
};
const fmtTs = (ms: number | null): string =>
  ms && Number.isFinite(ms) ? new Date(ms).toLocaleString() : '';
const shortKey = (k: string | null): string => (k ? `${k.slice(0, 10)}…${k.slice(-6)}` : '');

const inputStyle: CSSProperties = {
  padding: '6px 10px',
  borderRadius: 6,
  border: '1px solid var(--border)',
  background: 'var(--bg-2)',
  color: 'var(--fg)',
  fontSize: 13,
};
const sectionStyle: CSSProperties = { marginBottom: 28 };
const h2Style: CSSProperties = { margin: '0 0 8px', fontSize: 15 };
const muteStyle: CSSProperties = { color: 'var(--fg-mute)', fontSize: 12.5 };
const redBadge: CSSProperties = {
  display: 'inline-block',
  padding: '1px 8px',
  borderRadius: 999,
  fontSize: 11.5,
  fontWeight: 700,
  color: 'var(--bad)',
  background: 'color-mix(in srgb, var(--bad), transparent 86%)',
};
const okBadge: CSSProperties = { ...redBadge, color: 'var(--good, #2c9c46)', background: 'color-mix(in srgb, var(--good, #2c9c46), transparent 86%)' };
const pendingBadge: CSSProperties = {
  ...redBadge,
  color: 'var(--fg-mute)',
  background: 'color-mix(in srgb, var(--fg-mute), transparent 88%)',
};
const btnStyle: CSSProperties = { fontSize: 12.5, padding: '6px 14px', cursor: 'pointer', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-2)', color: 'var(--fg)' };
const pendingNote: CSSProperties = {
  fontSize: 12.5,
  color: 'var(--fg-mute)',
  background: 'var(--bg-2)',
  border: '1px dashed var(--border)',
  borderRadius: 6,
  padding: '10px 12px',
};

/* ── Opt-in editor (drafts are mid-edit → useState; remounts on layer change) ── */
function OptInEditor({
  layer,
  stored,
  effective,
  onSave,
  onClearLayer,
  busy,
}: {
  layer: 'workspace' | 'default';
  stored: Partial<P2pWorkOptIn> | undefined;
  effective: P2pWorkOptIn;
  onSave: (optIn: P2pWorkOptIn) => Promise<void>;
  onClearLayer: () => Promise<void>;
  busy: boolean;
}) {
  const [mode, setMode] = useState<P2pOptInMode>(effective.mode);
  const [fleetsText, setFleetsText] = useState(effective.fleets.join(', '));
  const [cap, setCap] = useState(String(effective.maxConcurrentForeign));
  const [windows, setWindows] = useState<P2pScheduleWindow[]>(effective.windows);

  const save = useCallback(async () => {
    const capN = Number(cap);
    await onSave({
      mode,
      fleets: fleetsText.split(',').map((f) => f.trim()).filter(Boolean),
      maxConcurrentForeign: Number.isFinite(capN) ? capN : effective.maxConcurrentForeign,
      windows,
    });
  }, [mode, fleetsText, cap, windows, onSave, effective.maxConcurrentForeign]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
        <span style={muteStyle}>Accept work from</span>
        <Select
          value={mode}
          onChange={(v) => setMode(v as P2pOptInMode)}
          ariaLabel="Work opt-in mode"
          options={[
            { value: 'off', label: 'No one (off)' },
            { value: 'selected-fleets', label: 'Selected fleets' },
            { value: 'any-fleet', label: 'Any fleet' },
          ]}
        />
      </label>
      {mode === 'selected-fleets' && (
        <label style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12, color: 'var(--fg-mute)' }}>
          Opted-in fleet slugs (comma-separated)
          <input
            type="text"
            value={fleetsText}
            onChange={(e) => setFleetsText(e.target.value)}
            placeholder="fleet-a, fleet-b"
            style={inputStyle}
            aria-label="Opted-in fleet slugs"
          />
        </label>
      )}
      <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color: 'var(--fg-mute)' }}>
        Max concurrent foreign sessions
        <input
          type="number"
          min={0}
          max={64}
          value={cap}
          onChange={(e) => setCap(e.target.value)}
          style={{ ...inputStyle, width: 80 }}
          aria-label="Max concurrent foreign sessions"
        />
      </label>

      <div>
        <div style={{ ...muteStyle, marginBottom: 6 }}>
          Schedule windows (host-local time; empty = always while opted in — windows gate NEW claims, not running work)
        </div>
        {windows.map((w, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 6 }}>
            {DAY_LABELS.map((d, di) => (
              <label key={d} style={{ fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                <Checkbox
                  ariaLabel={d}
                  checked={w.days.includes(di)}
                  onChange={(checked) =>
                    setWindows((ws) =>
                      ws.map((x, xi) =>
                        xi === i
                          ? { ...x, days: checked ? [...x.days, di].sort() : x.days.filter((v) => v !== di) }
                          : x,
                      ),
                    )
                  }
                />
                {d}
              </label>
            ))}
            <input
              type="time"
              value={minToHHMM(w.startMin)}
              onChange={(e) => {
                const v = hhmmToMin(e.target.value);
                if (v !== null) setWindows((ws) => ws.map((x, xi) => (xi === i ? { ...x, startMin: v } : x)));
              }}
              style={{ ...inputStyle, padding: '3px 6px' }}
              aria-label={`Window ${i + 1} start`}
            />
            <span style={muteStyle}>→</span>
            <input
              type="time"
              value={minToHHMM(w.endMin)}
              onChange={(e) => {
                const v = hhmmToMin(e.target.value);
                if (v !== null) setWindows((ws) => ws.map((x, xi) => (xi === i ? { ...x, endMin: v } : x)));
              }}
              style={{ ...inputStyle, padding: '3px 6px' }}
              aria-label={`Window ${i + 1} end`}
            />
            <button type="button" style={btnStyle} onClick={() => setWindows((ws) => ws.filter((_, xi) => xi !== i))}>
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          style={btnStyle}
          onClick={() => setWindows((ws) => [...ws, { days: [1, 2, 3, 4, 5], startMin: 540, endMin: 1020 }])}
        >
          Add window
        </button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button type="button" onClick={() => void save()} disabled={busy} style={{ ...btnStyle, fontWeight: 600 }}>
          {busy ? 'Saving…' : layer === 'workspace' ? 'Save workspace override' : 'Save default (all workspaces)'}
        </button>
        <button
          type="button"
          onClick={() => void onClearLayer()}
          disabled={busy || stored === undefined}
          style={{ ...btnStyle, opacity: stored === undefined ? 0.5 : 1 }}
        >
          Clear this layer
        </button>
        {stored !== undefined && <span style={{ fontSize: 11, color: 'var(--fg-mute)' }}>layer has stored values</span>}
      </div>
    </div>
  );
}

/* ── Add-grant form (mid-edit drafts → useState per the state policy) ── */
function AddGrantForm({
  hive,
  busy,
  onAdd,
}: {
  hive: string;
  busy: boolean;
  onAdd: (args: GrantSetArgs) => Promise<void>;
}) {
  const [kind, setKind] = useState<'fleet' | 'pool'>('fleet');
  const [ref, setRef] = useState('');
  const [preset, setPreset] = useState<string>('Delegate');
  const [note, setNote] = useState('');

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-end' }}>
      <Select
        value={kind}
        onChange={(v) => setKind(v as 'fleet' | 'pool')}
        ariaLabel="Grantee kind"
        options={[
          { value: 'fleet', label: 'fleet' },
          { value: 'pool', label: 'pool' },
        ]}
      />
      <input
        type="text"
        value={ref}
        onChange={(e) => setRef(e.target.value)}
        placeholder={kind === 'fleet' ? 'fleet slug' : 'pool id'}
        style={inputStyle}
        aria-label="Grantee reference"
      />
      <Select
        value={preset}
        onChange={setPreset}
        ariaLabel="Capability preset"
        options={GRANT_PRESETS.map((p) => ({ value: p, label: p }))}
      />
      <input
        type="text"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="note (optional)"
        style={{ ...inputStyle, flex: '1 1 160px' }}
        aria-label="Grant note"
      />
      <button
        type="button"
        disabled={busy || ref.trim().length === 0}
        style={{ ...btnStyle, fontWeight: 600 }}
        onClick={() =>
          void onAdd({ action: 'set', potSlug: hive, granteeKind: kind, granteeRef: ref.trim(), preset, note: note.trim() || null }).then(() => {
            setRef('');
            setNote('');
          })
        }
      >
        Grant
      </button>
    </div>
  );
}

export default function P2pSettingsPage() {
  const t = useLexicon();
  const { data: settingsData, error: settingsError } = useSyncQuery<P2pSettingsLayers>({
    queryName: 'p2p.settings',
  });
  const layers = settingsData?.[0] ?? null;
  const settingsUnavailable = layers?.unavailable === true ? layers : null;
  const settingsReadError = settingsError?.message ?? settingsUnavailable?.unavailableReason ?? null;
  const settingsReadable = Boolean(layers) && settingsReadError === null;

  const { data: deviceData, error: devicesError } = useSyncQuery<DeviceRow>({ queryName: 'p2p.devices' });
  const deviceRows = useMemo<DeviceRow[]>(() => deviceData ?? [], [deviceData]);
  const deviceUnavailable = useMemo(() => deviceRows.find(isUnavailableRow) ?? null, [deviceRows]);
  const visibleDeviceRows = useMemo(() => deviceRows.filter((row) => !isUnavailableRow(row)), [deviceRows]);
  const deviceReadError = devicesError?.message ?? deviceUnavailable?.unavailableReason ?? null;

  const { data: auditData, error: auditError } = useSyncQuery<AuditRow | UnavailableRow>({ queryName: 'p2p.audit', args: { limit: 50 } });
  const auditUnavailable = useMemo(() => auditData?.find(isUnavailableRow) ?? null, [auditData]);
  const auditRows = useMemo<AuditRow[]>(
    () => (auditData ?? []).filter((row): row is AuditRow => !isUnavailableRow(row)),
    [auditData],
  );
  const auditReadError = auditError?.message ?? auditUnavailable?.unavailableReason ?? null;

  const {
    data: foreignWorkspaceData,
    error: foreignWorkspacesError,
    loading: foreignWorkspacesLoading,
    invalidate: invalidateForeignWorkspaces,
  } = useSyncQuery<ForeignWorkspaceRow>({ queryName: 'p2p.foreignWorkspaces' });
  const foreignWorkspaceRows = useMemo(
    () => (foreignWorkspaceData ?? []).filter((row) => row.state !== 'reaped'),
    [foreignWorkspaceData],
  );

  // Hive selector for the Peers matrix — grants federate per hive home slug.
  // Options derive from this identity's hive memberships (the devices read).
  const hiveOptions = useMemo(() => {
    const slugs = new Set<string>();
    for (const r of visibleDeviceRows) {
      if (r.kind === 'device' || r.kind === 'missing') slugs.add(r.potHomeSlug);
    }
    return [...slugs].sort();
  }, [visibleDeviceRows]);
  const [hiveParam, setHiveParam] = useQueryState('hive', parseAsString);
  const hive = hiveParam ?? hiveOptions[0] ?? null;

  // Peers matrix — the P-001 grant store (mig 463). Args-scoped subscription:
  // the grant-set route re-invalidates with the SAME {potSlug} args.
  // `hive` is null until the devices read resolves (and stays null for an
  // identity with no memberships), so without the gate this fetches
  // `{potSlug:''}` on every poll — a round-trip that can never resolve to a
  // hive (no-http-anywhere-2026-07-28 P-027).
  const { data: grantsData, error: grantsError } = useSyncQuery<PeerGrant | UnavailableRow>({
    queryName: 'p2p.grants',
    args: { potSlug: hive ?? '' },
    enabled: Boolean(hive),
  });
  const grantsUnavailable = useMemo(() => grantsData?.find(isUnavailableRow) ?? null, [grantsData]);
  const grantRows = useMemo<PeerGrant[]>(
    () => (hive ? (grantsData ?? []).filter((row): row is PeerGrant => !isUnavailableRow(row)) : []),
    [grantsData, hive],
  );
  const grantsReadError = grantsError?.message ?? grantsUnavailable?.unavailableReason ?? null;
  const setGrant = useSyncMutate<GrantSetArgs, { ok: boolean; error?: string }>('p2p.grantSet', p2pGrantSetRest);

  const [layer, setLayer] = useQueryState(
    'layer',
    parseAsStringEnum<'workspace' | 'default'>(['workspace', 'default']).withDefault('workspace'),
  );
  const [busy, setBusy] = useState(false);
  const [ksReason, setKsReason] = useState('');
  const setP2p = useSyncMutate<SetArgs, SetResp>('p2p.settingsSet', p2pSettingsSetRest);

  const mutate = useCallback(
    async (args: SetArgs, okMsg: string) => {
      setBusy(true);
      try {
        await setP2p(args);
        toast.success(okMsg);
      } catch (e) {
        toast.error(`Couldn't save: ${e instanceof Error ? e.message : 'failed'}`);
      } finally {
        setBusy(false);
      }
    },
    [setP2p],
  );

  const identity = visibleDeviceRows.find((r): r is Extract<DeviceRow, { kind: 'identity' }> => r.kind === 'identity');
  const devices = visibleDeviceRows.filter((r): r is Extract<DeviceRow, { kind: 'device' }> => r.kind === 'device');
  const missing = visibleDeviceRows.filter((r): r is Extract<DeviceRow, { kind: 'missing' }> => r.kind === 'missing');
  const identityUnresolved = !identity || identity.githubUserId === null || identity.devicePubkey === null;

  const ks = settingsReadable ? layers?.effective.killSwitch : null;
  const storedOptIn = (layer === 'workspace' ? layers?.overrideLayer : layers?.defaultLayer)?.optIn;

  return (
    <div>
      <h1>P2P work sharing</h1>
      <p className="pc-settings-intro">
        Opt this host into pull-based work hand-off across {t('pot', { lower: true })} peers — and control exactly what it
        accepts. In v1 a peer can take work here only through a seat this host offers, only while this
        host&apos;s opt-in admits it, and, for {t('pot', { lower: true })}-scoped offers, only if the peer is on your trust
        list; everything defaults to off. Capability grants (Peers, below) are recorded but not yet enforced.
        Settings here are host-local — your machine&apos;s sovereignty; grants federate, your opt-in does not.
      </p>

      {settingsReadError && (
        <p role="alert" style={{ color: 'var(--bad)', fontSize: 13 }}>
          Couldn&apos;t load P2P settings
          {settingsUnavailable?.unavailableKind ? ` (${settingsUnavailable.unavailableKind})` : ''}: {settingsReadError}. Mutations are disabled until a verified snapshot loads.
        </p>
      )}

      {/* ── GLOBAL KILL-SWITCH (M10/X13) ── */}
      <section
        className="pc-settings-section"
        aria-label="Global kill-switch"
        style={{
          ...sectionStyle,
          border: `1px solid ${ks?.engaged || settingsReadError ? 'var(--bad)' : 'var(--border)'}`,
          borderRadius: 8,
          padding: 14,
          background: ks?.engaged ? 'color-mix(in srgb, var(--bad), transparent 92%)' : 'var(--bg)',
        }}
      >
        <h2 style={h2Style}>
          Global kill-switch{' '}
          {settingsReadError ? (
            <span style={redBadge}>STATE UNKNOWN — settings unavailable</span>
          ) : !layers ? (
            <span style={pendingBadge}>loading…</span>
          ) : ks?.engaged ? (
            <span style={redBadge}>ENGAGED — all foreign work paused</span>
          ) : (
            <span style={okBadge}>clear</span>
          )}
        </h2>
        <p style={{ ...muteStyle, margin: '0 0 10px' }}>
          Engaging stops NEW foreign claims immediately and winds down in-flight foreign work
          gracefully with receipts (never a hard freeze). Wind-down is bounded: after the grace
          period ({ks ? ks.windDownGraceSec : '—'}s) remaining sessions are mechanically terminated
          and a receipt is emitted. A mid-run grant downgrade routes through the same wind-down.
        </p>
        {ks?.engaged ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12.5 }}>
              engaged {fmtTs(ks.engagedAtMs)}
              {ks.reason ? ` — “${ks.reason}”` : ''}
            </span>
            <button
              type="button"
              disabled={busy || !settingsReadable}
              style={{ ...btnStyle, fontWeight: 600 }}
              onClick={() => void mutate({ action: 'kill-switch', engage: false }, 'Kill-switch disengaged — foreign work may resume.')}
            >
              Disengage
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <input
              type="text"
              disabled={busy || !settingsReadable}
              value={ksReason}
              onChange={(e) => setKsReason(e.target.value)}
              placeholder="reason (lands on receipts + audit)"
              style={{ ...inputStyle, width: 280 }}
              aria-label="Kill-switch reason"
            />
            <button
              type="button"
              disabled={busy || !settingsReadable}
              style={{ ...btnStyle, color: 'var(--bad)', fontWeight: 600 }}
              onClick={() =>
                toast(`Pause ALL foreign work on this host?`, {
                  action: {
                    label: 'Engage kill-switch',
                    onClick: () =>
                      void mutate(
                        { action: 'kill-switch', engage: true, reason: ksReason.trim() || null },
                        'Kill-switch engaged — new claims stopped, in-flight work winding down.',
                      ),
                  },
                })
              }
            >
              Engage kill-switch
            </button>
          </div>
        )}
      </section>

      {/* ── Identity & devices ── */}
      <section className="pc-settings-section" aria-label="Identity and devices" style={sectionStyle}>
        <h2 style={h2Style}>Identity &amp; devices</h2>
        {deviceReadError ? (
          <p role="alert" style={{ color: 'var(--bad)', fontSize: 13 }}>
            Device and membership state unavailable
            {deviceUnavailable?.unavailableKind ? ` (${deviceUnavailable.unavailableKind})` : ''}: {deviceReadError}. No membership or attestation conclusion is available.
          </p>
        ) : identityUnresolved ? (
          <p style={{ fontSize: 13 }}>
            <span style={redBadge}>IDENTITY UNRESOLVED</span>{' '}
            <span style={muteStyle}>
              No GitHub identity / device key resolved on this host — P2P grants resolve only through
              attested devices, so this host is P2P-inert until GitHub auth + device attestation exist.
            </span>
          </p>
        ) : (
          <>
            <p style={{ fontSize: 12.5, margin: '0 0 8px' }}>
              GitHub user <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{identity.githubUserId}</strong>{' '}
              · this device <code style={{ fontSize: 11.5 }}>{shortKey(identity.devicePubkey)}</code>
            </p>
            {missing.map((m) => (
              <p key={m.potHomeSlug} style={{ fontSize: 12.5, margin: '4px 0' }}>
                <span style={redBadge}>MISSING</span>{' '}
                <span style={muteStyle}>
                  this device has no live attestation on {t('pot', { lower: true })} <strong>{m.potHomeSlug}</strong> — attest it
                  before it can offer or accept P2P work there.
                </span>
              </p>
            ))}
            {devices.length === 0 && missing.length === 0 && (
              <p style={muteStyle}>No {t('pot', { lower: true })} memberships found for this identity in the workspace.</p>
            )}
            {devices.map((d) => (
              <div key={`${d.potHomeSlug}:${d.devicePubkey}`} style={{ fontSize: 12.5, padding: '4px 0', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                {d.revoked ? <span style={redBadge}>REVOKED</span> : <span style={okBadge}>attested</span>}
                <span>
                  {d.deviceLabel ?? 'device'} <code style={{ fontSize: 11 }}>{shortKey(d.devicePubkey)}</code>
                  {d.isThisDevice && <strong> (this device)</strong>}
                </span>
                <span style={muteStyle}>
                  {t('pot', { lower: true })} {d.potHomeSlug}
                  {d.attestedAtMs ? ` · attested ${fmtTs(d.attestedAtMs)}` : ''}
                </span>
              </div>
            ))}
          </>
        )}
      </section>

      {/* ── Peers (capability matrix — P-001 store) ── */}
      <section className="pc-settings-section" aria-label="Peers" style={sectionStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
          <h2 style={{ ...h2Style, margin: 0 }}>Peers — capability grants</h2>
          <span style={pendingBadge}>not enforced in v1</span>
          {hiveOptions.length > 0 && (
            <Select
              value={hive ?? ''}
              onChange={(v) => void setHiveParam(v || null)}
              ariaLabel={`${t('pot')} for grants`}
              options={hiveOptions.map((s) => ({ value: s, label: s }))}
            />
          )}
        </div>
        <p style={{ ...muteStyle, margin: '0 0 10px' }}>
          Not enforced in v1: a grant does not change what a peer may start on this host. v1 authorization is
          seat delegation plus your trust list; grants are recorded now so enforcement can follow a later release.
          Grants are issued by YOU (your numeric GitHub id), keyed per {t('pot', { lower: true })}, resolved only through
          attested devices. Presets: Observer (chat) · Collaborator (+steer) · Delegate (+work-offer,
          wake) · Operator (+spawn). A capability downgrade is revocation-class and bumps your
          grantor epoch.
        </p>
        {deviceReadError ? (
          <div style={pendingNote} role="alert">
            Memberships are unavailable because device state could not be read: {deviceReadError}. Grant state is not inferred from this absence.
          </div>
        ) : !hive ? (
          <div style={pendingNote} role="status">
            No {t('pot', { lower: true })} memberships resolved for this identity — join or create a {t('pot', { lower: true })} first; grants
            attach to a {t('pot', { lower: true })}.
          </div>
        ) : grantsReadError ? (
          <div style={pendingNote} role="alert">
            Couldn&apos;t read grants for {t('pot', { lower: true })} {hive}
            {grantsUnavailable?.unavailableKind ? ` (${grantsUnavailable.unavailableKind})` : ''}: {grantsReadError} — nothing is granted while
            this read is unavailable (structurally inert).
          </div>
        ) : (
          <>
            {grantRows.length === 0 ? (
              <p style={muteStyle}>No capability grants on {t('pot', { lower: true })} {hive} yet.</p>
            ) : (
              <div style={{ overflowX: 'auto', marginBottom: 10 }}>
                <Table<PeerGrant>
                  style={{ minWidth: 560 }}
                  rows={grantRows}
                  getRowKey={(g) => `${g.granteeKind}:${g.granteeRef}:${g.grantorGithubUserId}`}
                  rowStyle={(g) => (g.status === 'revoked' ? { opacity: 0.55 } : undefined)}
                  columns={[
                    {
                      key: 'grantee',
                      header: 'grantee',
                      cellStyle: { whiteSpace: 'nowrap' },
                      render: (g) => (
                        <>
                          {g.granteeKind}:<strong>{g.granteeRef}</strong>
                        </>
                      ),
                    },
                    { key: 'preset', header: 'preset', render: (g) => g.preset ?? '—' },
                    {
                      key: 'capabilities',
                      header: 'capabilities',
                      render: (g) => <code style={{ fontSize: 11 }}>{g.capabilities.join(', ')}</code>,
                    },
                    {
                      key: 'epoch',
                      header: 'epoch',
                      cellStyle: { fontVariantNumeric: 'tabular-nums' },
                      render: (g) => g.grantorEpoch,
                    },
                    { key: 'wakeCap', header: 'wake cap/h', render: (g) => g.wakeRateCapPerHour ?? '—' },
                    {
                      key: 'status',
                      header: 'status',
                      render: (g) =>
                        g.status === 'revoked' ? <span style={redBadge}>revoked</span> : <span style={okBadge}>active</span>,
                    },
                    {
                      key: 'actions',
                      header: '',
                      render: (g) =>
                        g.status === 'active' ? (
                          <button
                            type="button"
                            style={btnStyle}
                            disabled={busy}
                            onClick={() =>
                              toast(`Revoke ${g.granteeKind}:${g.granteeRef}? In-flight foreign work winds down (M16).`, {
                                action: {
                                  label: 'Revoke',
                                  onClick: () =>
                                    void (async () => {
                                      try {
                                        await setGrant({ action: 'revoke', potSlug: hive, granteeKind: g.granteeKind, granteeRef: g.granteeRef });
                                        toast.success(`Revoked ${g.granteeRef}.`);
                                      } catch (e) {
                                        toast.error(`Couldn't revoke: ${e instanceof Error ? e.message : 'failed'}`);
                                      }
                                    })(),
                                },
                              })
                            }
                          >
                            Revoke
                          </button>
                        ) : null,
                    },
                  ]}
                />
              </div>
            )}
            <AddGrantForm
              hive={hive}
              busy={busy}
              onAdd={async (args) => {
                try {
                  await setGrant(args);
                  toast.success(`Granted ${args.preset} to ${args.granteeKind}:${args.granteeRef}.`);
                } catch (e) {
                  toast.error(`Couldn't grant: ${e instanceof Error ? e.message : 'failed'}`);
                }
              }}
            />
          </>
        )}
      </section>

      {/* ── Work opt-in ── */}
      <section className="pc-settings-section" aria-label="Work opt-in" style={sectionStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
          <h2 style={{ ...h2Style, margin: 0 }}>Work opt-in</h2>
          <Select
            value={layer}
            onChange={(v) => void setLayer(v as 'workspace' | 'default')}
            ariaLabel="Settings layer"
            options={[
              { value: 'workspace', label: 'This workspace (override)' },
              { value: 'default', label: 'All workspaces (default)' },
            ]}
          />
          <button
            type="button"
            disabled={busy || !settingsReadable}
            style={btnStyle}
            onClick={() =>
              void mutate(
                { action: 'starter-profile' },
                'Starter profile applied — any granted fleet, 2 concurrent sessions, no schedule limits.',
              )
            }
          >
            Apply starter profile
          </button>
        </div>
        <p style={{ ...muteStyle, margin: '0 0 10px' }}>
          Effective now: <strong>{layers?.effective.optIn.mode ?? '…'}</strong>
          {layers ? ` · cap ${layers.effective.optIn.maxConcurrentForeign} · ${layers.effective.optIn.windows.length === 0 ? 'no schedule limits' : `${layers.effective.optIn.windows.length} window(s)`}` : ''}
          {' '}(field-level merge: baked ← default ← workspace override)
        </p>
        {layers && settingsReadable && (
          <OptInEditor
            key={`${layer}:${JSON.stringify(storedOptIn ?? null)}`}
            layer={layer}
            stored={storedOptIn}
            effective={layers.effective.optIn}
            busy={busy}
            onSave={(optIn) => mutate({ action: 'set', layer, patch: { optIn } }, `Saved opt-in (${layer} layer).`)}
            onClearLayer={() => mutate({ action: 'clear-layer', layer }, `Cleared the ${layer} layer.`)}
          />
        )}
      </section>

      {/* ── Budgets (P-201 two-axis — live on /res) ── */}
      <section className="pc-settings-section" aria-label="Budgets" style={sectionStyle}>
        <h2 style={h2Style}>Budgets — per-fleet allotments</h2>
        <p style={{ ...muteStyle, margin: '0 0 10px' }}>
          Two-axis allotments are live: a REMOTE axis (account pools / model-class capacity) and a
          LOCAL axis (GPU and agent slots). An explicit allotment and the opt-in above are both
          required before this host contributes capacity.
        </p>
        <Link href="/res" style={{ color: 'var(--accent)', fontSize: 13, fontWeight: 600 }}>
          Manage allotments in Resources
        </Link>
      </section>

      {/* ── Live foreign work NOW (P-104 host-local registry) ── */}
      <section className="pc-settings-section" aria-label="Foreign work running now" style={sectionStyle}>
        <h2 style={h2Style}>Foreign work running now</h2>
        {foreignWorkspacesError ? (
          <div role="alert" style={{ ...pendingNote, borderColor: 'var(--bad)', color: 'var(--bad)' }}>
            <div>Couldn&apos;t load the host&apos;s foreign-work registry: {foreignWorkspacesError.message}</div>
            <button
              type="button"
              style={{ ...btnStyle, marginTop: 8 }}
              onClick={() => void invalidateForeignWorkspaces()}
            >
              Retry
            </button>
          </div>
        ) : foreignWorkspacesLoading && foreignWorkspaceData === undefined ? (
          <div style={pendingNote} role="status" aria-live="polite">
            Loading foreign work…
          </div>
        ) : foreignWorkspaceRows.length === 0 ? (
          <div style={pendingNote} role="status">
            No foreign work is registered on this host. New accepted offers appear here automatically;
            completed and reaped history stays in the audit trail below.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <Table<ForeignWorkspaceRow>
              style={{ minWidth: 700 }}
              rows={foreignWorkspaceRows}
              getRowKey={(row) => row.offerId}
              columns={[
                {
                  key: 'state',
                  header: 'state',
                  render: (row) => (
                    <span style={row.state === 'active' ? okBadge : row.state === 'winding-down' ? redBadge : pendingBadge}>
                      {row.state}
                    </span>
                  ),
                },
                { key: 'fleet', header: 'fleet', render: (row) => row.fleetSlug },
                { key: 'offer', header: 'offer', render: (row) => <code style={{ fontSize: 11.5 }}>{row.offerId}</code> },
                { key: 'session', header: 'session', render: (row) => row.sessionId ?? 'not bound' },
                { key: 'updated', header: 'updated', cellStyle: { whiteSpace: 'nowrap' }, render: (row) => fmtTs(row.updatedAt) },
                { key: 'reason', header: 'reason', render: (row) => row.parkReason ?? '—' },
              ]}
            />
          </div>
        )}
      </section>

      {/* ── Audit ── */}
      <section className="pc-settings-section" aria-label="P2P audit trail" style={sectionStyle}>
        <h2 style={h2Style}>Audit</h2>
        {auditReadError ? (
          <div style={pendingNote} role="alert">
            P2P audit history unavailable
            {auditUnavailable?.unavailableKind ? ` (${auditUnavailable.unavailableKind})` : ''}: {auditReadError}. An unavailable trail is not an empty trail.
          </div>
        ) : auditRows.length === 0 ? (
          <p style={muteStyle}>No P2P audit events yet. Kill-switch flips, starter-profile applies, grant changes and refusal receipts land here.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <Table<AuditRow>
              style={{ minWidth: 480 }}
              rows={auditRows}
              getRowKey={(r) => r.id}
              columns={[
                { key: 'when', header: 'when', cellStyle: { whiteSpace: 'nowrap' }, render: (r) => fmtTs(r.ts) },
                { key: 'actor', header: 'actor', render: (r) => r.actor },
                {
                  key: 'action',
                  header: 'action',
                  render: (r) => <code style={{ fontSize: 11.5 }}>{r.action}</code>,
                },
                {
                  key: 'details',
                  header: 'details',
                  cellStyle: {
                    color: 'var(--fg-mute)',
                    maxWidth: 380,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  },
                  render: (r) => (r.details ? JSON.stringify(r.details) : ''),
                },
              ]}
            />
          </div>
        )}
      </section>
    </div>
  );
}
