'use client';

/**
 * /settings/storage — the owner's storage control surface
 * (storage-settings-page-2026-06-15 P-002).
 *
 * Keep-all by default (D-001): nothing prunes automatically. This page shows live
 * usage by CATEGORY (PG tables by federation class + on-disk stores), each with an
 * age distribution, and lets the owner trim selectively — "trim older than
 * 30/90/365 d / custom" or "trim all" — each behind a confirm dialog that shows
 * the projected reclaim. Federated categories are READ-ONLY with a warning
 * (trimming changes what peers see; D-002/D-003).
 *
 * Reads `useSyncQuery('storage.usage')`; trims through the loopback
 * `storage-prune` route (which re-invalidates the query). nuqs holds the filter,
 * the expanded category, and the confirm-dialog target.
 */
import { useCallback, useMemo, useState } from 'react';
import { useQueryState, parseAsString, parseAsStringEnum } from 'nuqs';
import { useSyncQuery, useSyncMutate } from '@papercusp/sync';
import { toast } from 'sonner';
import { useFlag } from '@/lib/flag-hooks';
import { FLAGS } from '@papercusp/flags';
import { Modal } from '@/app/harness/Modal';

/* ── Wire types — mirror StorageUsageRow / PruneResult (operator-core/lib/storage). ── */
type Federation = 'federated' | 'local-diagnostic' | 'bloat-queue';

interface AgeBucket {
  olderThanDays: number | null;
  rows: number;
  bytes: number;
}
interface UsageRow {
  id: string;
  label: string;
  kind: 'pg' | 'disk';
  federation: Federation;
  trimmable: boolean;
  bloats: boolean;
  totalBytes: number;
  totalRows: number | null;
  ageBuckets: AgeBucket[];
  ageColumnType?: 'timestamptz' | 'epoch_ms';
  minOlderThanDays?: number;
  description: string;
  note?: string;
}
interface PruneResult {
  ok: boolean;
  removed: number;
  reclaimedBytes: number;
  reclaimEstimated: boolean;
  vacuumed: boolean;
  dryRun: boolean;
  note?: string;
  partial?: boolean;
  reason?: string;
}

interface TrimArgs {
  category: string;
  olderThanDays: number | null;
  dryRun?: boolean;
}

/** REST fallback the sync-mutate hook calls (desktop SSE / WS / REST). */
async function storageTrimRest(args: TrimArgs): Promise<PruneResult> {
  const r = await fetch('/api/agent-mcp/storage-prune', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  const text = await r.text();
  let data: Partial<PruneResult> & { error?: string } = {};
  try {
    data = JSON.parse(text) as PruneResult & { error?: string };
  } catch {
    /* non-JSON */
  }
  if (!r.ok || data.ok === false) {
    throw new Error(data.error ?? data.reason ?? `HTTP ${r.status}`);
  }
  return data as PruneResult;
}

const FILTERS = ['all', 'trimmable', 'federated'] as const;
type Filter = (typeof FILTERS)[number];

/** "trim older than" presets the page offers (mirrors TRIM_THRESHOLD_DAYS). */
const PRESETS = [
  { mode: '30', label: '30 d' },
  { mode: '90', label: '90 d' },
  { mode: '365', label: '1 yr' },
  { mode: 'custom', label: 'Custom' },
  { mode: 'all', label: 'All' },
] as const;
type TrimMode = (typeof PRESETS)[number]['mode'];

const FED_LABEL: Record<Federation, string> = {
  federated: 'Federated',
  'local-diagnostic': 'Local',
  'bloat-queue': 'Bloat queue',
};
const FED_TONE: Record<Federation, string> = {
  federated: 'var(--warn)',
  'local-diagnostic': 'var(--fg-mute)',
  'bloat-queue': 'var(--accent)',
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const v = bytes / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function modeDays(mode: TrimMode, custom: number | null): number | null {
  if (mode === 'all') return null;
  if (mode === 'custom') return custom;
  return Number(mode);
}

/** The projected reclaim for a fixed preset, read from the usage buckets. */
function presetProjection(row: UsageRow, days: number | null): { rows: number; bytes: number } | null {
  const b = row.ageBuckets.find((x) => x.olderThanDays === days);
  return b ? { rows: b.rows, bytes: b.bytes } : null;
}

export default function StorageSettingsPage() {
  const { data, loading, error } = useSyncQuery<UsageRow>({ queryName: 'storage.usage' });
  const rows = useMemo<UsageRow[]>(() => data ?? [], [data]);

  const [filter, setFilter] = useQueryState(
    'filter',
    parseAsStringEnum<Filter>([...FILTERS]).withDefault('all'),
  );
  const [selected, setSelected] = useQueryState('cat', parseAsString);
  // The confirm dialog target, encoded as "<categoryId>:<mode>" so it lives in
  // the URL (agent-controllable + survives reload).
  const [trim, setTrim] = useQueryState('trim', parseAsString);
  const [trimming, setTrimming] = useState<Set<string>>(new Set());

  const doTrim = useSyncMutate<TrimArgs, PruneResult>('storage.trim', storageTrimRest);

  const totalBytes = useMemo(() => rows.reduce((a, r) => a + r.totalBytes, 0), [rows]);
  const reclaimable = useMemo(
    () => rows.filter((r) => r.trimmable).reduce((a, r) => a + r.totalBytes, 0),
    [rows],
  );

  const visible = useMemo(
    () =>
      rows.filter((r) =>
        filter === 'all' ? true : filter === 'federated' ? !r.trimmable : r.trimmable,
      ),
    [rows, filter],
  );

  const trimTarget = useMemo(() => {
    if (!trim) return null;
    const [catId, mode] = trim.split(':');
    const row = rows.find((r) => r.id === catId);
    if (!row || !mode) return null;
    return { row, mode: mode as TrimMode };
  }, [trim, rows]);

  const runTrim = useCallback(
    async (row: UsageRow, days: number | null) => {
      setTrimming((s) => new Set(s).add(row.id));
      try {
        const res = await doTrim({ category: row.id, olderThanDays: days });
        const reclaim = formatBytes(res.reclaimedBytes);
        const what = row.kind === 'pg' ? `${res.removed} rows` : `${res.removed} items`;
        toast.success(
          `Trimmed ${row.label}: ${what}, ~${reclaim} reclaimed${res.vacuumed ? ' (vacuumed)' : ''}${
            res.partial ? ' — more remain, run again' : ''
          }.`,
        );
        setTrim(null);
      } catch (err) {
        toast.error(`Couldn't trim ${row.label}: ${err instanceof Error ? err.message : 'failed'}`);
      } finally {
        setTrimming((s) => {
          const n = new Set(s);
          n.delete(row.id);
          return n;
        });
      }
    },
    [doTrim, setTrim],
  );

  return (
    <div>
      <h1>Storage</h1>
      <p className="pc-settings-intro">
        Papercup keeps everything by default — nothing is pruned automatically. Here you can see what
        each category is using and trim it selectively. Federated categories (shared with peers) are
        read-only here; trimming them would change what peers see.
      </p>

      <div
        role="status"
        style={{
          marginBottom: 16,
          padding: '10px 14px',
          borderRadius: 8,
          fontSize: 13,
          border: '1px solid var(--border)',
          background: 'var(--bg-2)',
          color: 'var(--fg)',
          display: 'flex',
          gap: 24,
          flexWrap: 'wrap',
        }}
      >
        <span>
          <strong>{formatBytes(totalBytes)}</strong> total
        </span>
        <span>
          <strong>{formatBytes(reclaimable)}</strong> in trimmable categories
        </span>
      </div>

      {error && (
        <p role="alert" style={{ color: 'var(--bad)', marginBottom: 16, fontSize: 13 }}>
          Couldn’t load storage usage: {error.message}
        </p>
      )}
      {loading && rows.length === 0 && (
        <p role="status" style={{ color: 'var(--fg-mute)', marginBottom: 24, fontSize: 13 }}>
          Measuring storage…
        </p>
      )}

      <div role="tablist" aria-label="Filter categories" style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        {FILTERS.map((f) => {
          const active = filter === f;
          return (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => void setFilter(f === 'all' ? null : f)}
              style={{
                padding: '4px 12px',
                borderRadius: 6,
                fontSize: 13,
                textTransform: 'capitalize',
                cursor: 'pointer',
                border: '1px solid var(--border)',
                background: active ? 'var(--accent)' : 'var(--bg-2)',
                color: active ? 'var(--accent-fg, #fff)' : 'var(--fg)',
              }}
            >
              {f}
            </button>
          );
        })}
      </div>

      <section className="pc-settings-section" aria-label="Storage categories">
        {visible.map((row) => {
          const isSelected = selected === row.id;
          const busy = trimming.has(row.id);
          return (
            <div
              key={row.id}
              data-testid={`storage-cat-${row.id}`}
              style={{
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: '10px 14px',
                marginBottom: 8,
                background: 'var(--bg)',
                opacity: busy ? 0.6 : 1,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  onClick={() => void setSelected(isSelected ? null : row.id)}
                  aria-expanded={isSelected}
                  style={{
                    flex: '1 1 auto',
                    minWidth: 0,
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 8,
                    textAlign: 'left',
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    padding: 0,
                    font: 'inherit',
                  }}
                >
                  <span style={{ fontWeight: 600, color: 'var(--fg)' }}>{row.label}</span>
                  <span
                    title={FED_LABEL[row.federation]}
                    style={{
                      flex: '0 0 auto',
                      fontSize: 10,
                      fontWeight: 600,
                      color: FED_TONE[row.federation],
                      border: `1px solid ${FED_TONE[row.federation]}`,
                      borderRadius: 4,
                      padding: '0 5px',
                    }}
                  >
                    {FED_LABEL[row.federation]}
                  </span>
                </button>
                <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: 'var(--fg)' }}>
                  {formatBytes(row.totalBytes)}
                </span>
              </div>

              {/* Trim controls — disabled + warned for federated categories. */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                {row.trimmable ? (
                  <>
                    <span style={{ fontSize: 11, color: 'var(--fg-mute)', marginRight: 4 }}>Trim older than</span>
                    {PRESETS.map((p) => (
                      <button
                        key={p.mode}
                        type="button"
                        disabled={busy}
                        data-testid={`trim-${row.id}-${p.mode}`}
                        onClick={() => void setTrim(`${row.id}:${p.mode}`)}
                        style={{
                          padding: '3px 10px',
                          borderRadius: 6,
                          fontSize: 12,
                          cursor: busy ? 'default' : 'pointer',
                          border: '1px solid var(--border)',
                          background: p.mode === 'all' ? 'color-mix(in srgb, var(--bad), transparent 88%)' : 'var(--bg-2)',
                          color: 'var(--fg)',
                        }}
                      >
                        {p.label}
                      </button>
                    ))}
                  </>
                ) : (
                  <span style={{ fontSize: 11, color: 'var(--warn)' }}>
                    Read-only — federated; trimming would change what peers see.
                  </span>
                )}
              </div>

              {row.note && (
                <p style={{ marginTop: 6, fontSize: 11, color: 'var(--fg-mute)' }}>{row.note}</p>
              )}

              {isSelected && (
                <div
                  style={{
                    marginTop: 8,
                    paddingTop: 8,
                    borderTop: '1px dashed var(--border)',
                    fontSize: 12,
                    color: 'var(--fg-mute)',
                  }}
                >
                  <p style={{ margin: '0 0 6px' }}>{row.description}</p>
                  <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                    <span>{row.kind === 'pg' ? `≈${row.totalRows ?? 0} rows` : `${row.totalRows ?? 0} items`}</span>
                    {row.trimmable &&
                      row.ageBuckets
                        .filter((b) => b.olderThanDays !== null)
                        .map((b) => (
                          <span key={b.olderThanDays}>
                            &gt;{b.olderThanDays}d: {formatBytes(b.bytes)}
                          </span>
                        ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {!loading && visible.length === 0 && (
          <p style={{ color: 'var(--fg-mute)', fontSize: 13 }}>No categories match this filter.</p>
        )}
      </section>

      <RetentionSection />

      {trimTarget && (
        <TrimDialog
          row={trimTarget.row}
          mode={trimTarget.mode}
          busy={trimming.has(trimTarget.row.id)}
          onCancel={() => void setTrim(null)}
          onConfirm={(days) => void runTrim(trimTarget.row, days)}
        />
      )}
    </div>
  );
}

/* ── Automatic retention: the pre-existing background prunes (read + disable) ──
 * D-001: surface the full retention picture and let the owner disable any. Each
 * maps to a default-on STORAGE_RETAIN_* flag the DBOS tick honors (fail-safe). */
const RETENTIONS = [
  {
    flag: FLAGS.STORAGE_RETAIN_TELEMETRY,
    label: 'Telemetry archive',
    detail: 'Auto-deletes local telemetry rows older than 30 days.',
  },
  {
    flag: FLAGS.STORAGE_RETAIN_SCRATCH,
    label: 'Tool-output scratch',
    detail: 'Auto-GCs scratch dirs older than 24 h (plus a 5 GB per-workspace quota).',
  },
  {
    flag: FLAGS.STORAGE_RETAIN_TEST_RUNS,
    label: 'Test runs',
    detail: 'Keeps only the 50 most recent test runs per file/branch.',
  },
] as const;

function RetentionSection() {
  const telemetry = useFlag(FLAGS.STORAGE_RETAIN_TELEMETRY);
  const scratch = useFlag(FLAGS.STORAGE_RETAIN_SCRATCH);
  const testRuns = useFlag(FLAGS.STORAGE_RETAIN_TEST_RUNS);
  const enabledByFlag: Record<string, boolean> = {
    [FLAGS.STORAGE_RETAIN_TELEMETRY]: telemetry,
    [FLAGS.STORAGE_RETAIN_SCRATCH]: scratch,
    [FLAGS.STORAGE_RETAIN_TEST_RUNS]: testRuns,
  };
  const [busy, setBusy] = useState<string | null>(null);

  const toggle = useCallback(async (flag: string, next: boolean) => {
    setBusy(flag);
    try {
      const r = await fetch('/api/flags/set', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: flag, enabled: next }),
      });
      const d = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!r.ok || d.ok === false) throw new Error(d.error ?? `HTTP ${r.status}`);
      toast.success(`Automatic retention ${next ? 'enabled' : 'disabled'} — keeping forever${next ? ' off' : ''}.`);
    } catch (e) {
      toast.error(`Couldn’t update: ${e instanceof Error ? e.message : 'failed'}`);
    } finally {
      setBusy(null);
    }
  }, []);

  return (
    <section className="pc-settings-section" aria-label="Automatic retention" style={{ marginTop: 24 }}>
      <h2 style={{ fontSize: 14, margin: '0 0 4px' }}>Automatic retention</h2>
      <p style={{ fontSize: 12, color: 'var(--fg-mute)', margin: '0 0 12px' }}>
        These background prunes already run on a schedule. Turn any off to keep that data forever.
      </p>
      {RETENTIONS.map((r) => {
        const on = enabledByFlag[r.flag];
        return (
          <div
            key={r.flag}
            data-testid={`retention-${r.flag}`}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '8px 12px',
              border: '1px solid var(--border)',
              borderRadius: 8,
              marginBottom: 6,
            }}
          >
            <div style={{ flex: '1 1 auto', minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>{r.label}</div>
              <div style={{ fontSize: 11, color: 'var(--fg-mute)' }}>{r.detail}</div>
            </div>
            <button
              type="button"
              disabled={busy === r.flag}
              aria-pressed={on}
              data-testid={`retention-toggle-${r.flag}`}
              onClick={() => void toggle(r.flag, !on)}
              style={{
                padding: '4px 14px',
                borderRadius: 6,
                fontSize: 12,
                fontWeight: 600,
                cursor: busy === r.flag ? 'default' : 'pointer',
                border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
                background: on ? 'color-mix(in srgb, var(--accent), transparent 85%)' : 'var(--bg-2)',
                color: 'var(--fg)',
              }}
            >
              {on ? 'On' : 'Off'}
            </button>
          </div>
        );
      })}
    </section>
  );
}

/* ── Confirm dialog: projected reclaim + federated/floor warnings ──────────── */

function TrimDialog({
  row,
  mode,
  busy,
  onCancel,
  onConfirm,
}: {
  row: UsageRow;
  mode: TrimMode;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (days: number | null) => void;
}) {
  const [customDays, setCustomDays] = useState<string>('180');
  const [preview, setPreview] = useState<{ rows: number; bytes: number } | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const custom = mode === 'custom' ? (customDays.trim() === '' ? null : Number(customDays)) : null;
  const days = modeDays(mode, custom);
  const customValid = mode !== 'custom' || (Number.isInteger(custom) && (custom as number) >= 0);

  // Fixed presets read the projection straight from the usage buckets; custom
  // needs a dry-run round-trip for an accurate number.
  const projection = mode === 'custom' ? preview : presetProjection(row, days);

  const runPreview = useCallback(async () => {
    if (!customValid) return;
    setPreviewing(true);
    try {
      const res = await storageTrimRest({ category: row.id, olderThanDays: days, dryRun: true });
      setPreview({ rows: res.removed, bytes: res.reclaimedBytes });
    } catch {
      toast.error('Couldn’t preview reclaim.');
    } finally {
      setPreviewing(false);
    }
  }, [row.id, days, customValid]);

  const floored =
    row.minOlderThanDays != null && days != null && days < row.minOlderThanDays
      ? row.minOlderThanDays
      : null;
  const effectiveDescr =
    mode === 'all' ? 'everything' : `older than ${floored ?? days} day${(floored ?? days) === 1 ? '' : 's'}`;

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title={`Trim ${row.label}`}
      overlayStyle={{ background: 'rgba(0,0,0,0.45)' }}
      contentStyle={{
        width: 'min(440px, 92vw)',
        background: 'var(--bg)',
        border: '1px solid var(--border)',
        borderRadius: 12,
        padding: 20,
        color: 'var(--fg)',
        boxShadow: '0 10px 40px rgba(0,0,0,0.3)',
      }}
    >
      <div
        data-testid="trim-dialog"
      >
        <h2 style={{ margin: '0 0 8px', fontSize: 16 }}>
          Trim {row.label}
        </h2>
        <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--fg-mute)' }}>
          Permanently delete {row.kind === 'pg' ? 'rows' : 'entries'} {effectiveDescr}. This can’t be undone.
        </p>

        {mode === 'custom' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <label htmlFor="trim-custom-days" style={{ fontSize: 13 }}>
              Older than
            </label>
            <input
              id="trim-custom-days"
              type="number"
              min={0}
              value={customDays}
              onChange={(e) => {
                setCustomDays(e.target.value);
                setPreview(null);
              }}
              style={{
                width: 90,
                padding: '4px 8px',
                borderRadius: 6,
                border: '1px solid var(--border)',
                background: 'var(--bg-2)',
                color: 'var(--fg)',
              }}
            />
            <span style={{ fontSize: 13, color: 'var(--fg-mute)' }}>days</span>
            <button
              type="button"
              onClick={() => void runPreview()}
              disabled={!customValid || previewing}
              style={{
                marginLeft: 'auto',
                padding: '4px 10px',
                borderRadius: 6,
                fontSize: 12,
                cursor: customValid ? 'pointer' : 'default',
                border: '1px solid var(--border)',
                background: 'var(--bg-2)',
                color: 'var(--fg)',
              }}
            >
              {previewing ? 'Previewing…' : 'Preview'}
            </button>
          </div>
        )}

        <div
          role="status"
          data-testid="trim-projection"
          style={{
            padding: '10px 12px',
            borderRadius: 8,
            background: 'var(--bg-2)',
            border: '1px solid var(--border)',
            fontSize: 13,
            marginBottom: 12,
          }}
        >
          {projection ? (
            <>
              Projected reclaim: <strong>{formatBytes(projection.bytes)}</strong>{' '}
              <span style={{ color: 'var(--fg-mute)' }}>
                ({projection.rows} {row.kind === 'pg' ? 'rows' : 'items'})
                {row.bloats ? ' — includes a VACUUM FULL to return disk' : ''}
              </span>
            </>
          ) : mode === 'custom' ? (
            <span style={{ color: 'var(--fg-mute)' }}>Enter a day count and press Preview.</span>
          ) : (
            <span style={{ color: 'var(--fg-mute)' }}>Reclaim estimate unavailable; trim will report the actual amount.</span>
          )}
        </div>

        {floored != null && (
          <p role="alert" style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--warn)' }}>
            Live and resumable sessions are always protected — this will be floored to{' '}
            {row.minOlderThanDays} days.
          </p>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              padding: '6px 14px',
              borderRadius: 6,
              fontSize: 13,
              cursor: 'pointer',
              border: '1px solid var(--border)',
              background: 'var(--bg-2)',
              color: 'var(--fg)',
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="trim-confirm"
            disabled={busy || !customValid}
            onClick={() => onConfirm(floored ?? days)}
            style={{
              padding: '6px 14px',
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 600,
              cursor: busy || !customValid ? 'default' : 'pointer',
              border: '1px solid var(--bad)',
              background: 'var(--bad)',
              color: '#fff',
            }}
          >
            {busy ? 'Trimming…' : mode === 'all' ? 'Trim all' : 'Trim'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
