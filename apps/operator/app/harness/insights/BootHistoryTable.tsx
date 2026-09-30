'use client';

/**
 * BootHistoryTable — Phase 5a diagnostic table.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24.
 *
 * Compact table rendering boot-history entries. One row per event;
 * 4 columns (time / workspace + slug / kind / message). Color-coded
 * per kind. Empty state when no events.
 *
 * Pure UI; consumer feeds the `entries` field from
 * /api/admin/dogfood-substrate-boot-history.
 */

import type { CSSProperties, ReactNode } from 'react';
import { RichGrid, type ColumnDef } from '@papercusp/grid-core';
import { BOOT_HISTORY_KIND_COLOR, BOOT_HISTORY_KIND_FALLBACK } from '../theme';

// The kind union and the entry shape are DERIVED from the canonical module
// (`lib/sync/hyperbee/boot-history.ts`), never copied. This file used to carry a
// hand-maintained duplicate of `BootHistoryKind`, and it drifted behind the
// canonical union five recorded times (peer_cap_near, replication_frozen,
// epoch_gate_skipped, three replication_repair_* kinds, and finally
// 'policy_drop', which red-pinned the release gate's lint:tsc:workspaces leg on
// 2026-09-02 — dogfood-substrate/page.tsx feeds the canonical BootHistoryEntry[]
// into this table, so any missing kind is a build break, not a cosmetic gap).
// A type-only import is erased at build time, so this client component gains no
// runtime dependency on operator-core. The re-export keeps every consumer's
// import path (BootHistoryTableClient, the tests) unchanged.
//
// KIND_MARK below stays `Record<BootHistoryKind, string>` ON PURPOSE: that is the
// compile-time pin that forces a mark for every NEW canonical kind (the build
// break moves from an opaque TS2322 on the prop to a named missing key here).
// Kind hues live centrally in harness/theme.ts (BOOT_HISTORY_KIND_COLOR — the
// status-map lint's one home for these) and fall back for an unmapped kind.
import type {
  BootHistoryEntry,
  BootHistoryKind,
} from '@papercusp/operator-core/lib/sync/hyperbee/boot-history';

export type { BootHistoryEntry, BootHistoryKind };

export interface BootHistoryTableProps {
  entries: ReadonlyArray<BootHistoryEntry>;
  /** Optional: override now-millis used for relative-time labels (test). */
  nowMs?: number;
}

// EI-18726542722265915: RichGrid's getRowId is 1-param — (row: TRow) => string —
// every internal call site (rows.map(getRowId), getRowId(r), …) passes only the
// row, never an index, so widening the prop's signature to 2-param would be
// misleading (the index arg would always be undefined at every real call site
// except this one). Instead thread the disambiguating index onto the row itself
// before it reaches RichGrid, so getRowId stays a plain 1-param function while
// keeping the same uniqueness guarantee for exact-duplicate entries.
type BootHistoryRow = BootHistoryEntry & { _rowIndex: number };

const KIND_MARK: Record<BootHistoryKind, string> = {
  boot_start: '·',
  boot_ok: '✓',
  boot_fail: '✗',
  close: '×',
  peer_connected: '⇄',
  join_started: '▶',
  join_succeeded: '🔗',
  swarm_join_failed: '⚠',
  peer_rejected: '⛔',
  peer_rate_limited: '🛑',
  peer_cap_near: '📶',
  peer_dial_throttled: '⚖',
  peer_capped: '✂',
  // P-005: the periodic own-log compaction (anchor / start / appended / failed).
  own_log_compaction: '🗜',
  peer_revoked: '🚫',
  peer_unrevoked: '↩',
  // WI-10002600: an own-log supersession re-keyed an admitted log. The device
  // stays admitted (nothing is blocklisted), so this is deliberately NOT the
  // peer_revoked '🚫' — it is a replacement, not an eviction.
  peer_log_superseded: '♻',
  replication_stalled: '🧊',
  replication_frozen: '❄',
  announce_admitted: '➕',
  announce_pending: '⏳',
  announce_rejected: '⛔',
  // WI-2039866: a REMOTE op the owner-policy seam dropped (see boot-history.ts).
  policy_drop: '⊘',
  announce_clock_skew: '🕒',
  announce_error: '✗',
  merge_error: '✗',
  // WI-10003427: a wedged merge pass (names its stage) / its settle / an admission starved behind it.
  merge_stalled: '⧗',
  merge_stall_cleared: '✓',
  announce_admission_stalled: '⧗',
  rekey_grant_failed: '✗',
  rekey_grant_skipped: '⤼',
  rekey_boundary_skipped: '⤳',
  rekey_boundary_applied: '🔑',
  epoch_gate_built: '🔐',
  epoch_boot_device: '📱',
  epoch_gate_skipped: '🔐✗',
  epoch_gate_seen: '👁',
  epoch_defer: '⏸',
  epoch_decrypt_fail: '🔓',
  epoch_applied: '✓',
  dht_universe_ok: '🌐',
  dht_universe_mismatch: '🌐⚠',
  replication_repair: '🔧',
  replication_repair_failed: '🔧✗',
  replication_repair_exhausted: '🔧⛔',
  replication_repair_rejoin_failed: '🔧⚠',
  replication_repair_confirmation_failed: '🔧⏸',
  replication_repair_confirmed: '🔧✓',
  replication_repair_confirmation_deferred: '🔧⏳',
  replication_repair_confirmation_abandoned: '🔧🏳',
};

const EMPTY: CSSProperties = {
  fontSize: 12,
  color: 'var(--fg-dim)',
  padding: '12px 0',
};

function relTime(ts: number, now: number): string {
  const ageMs = now - ts;
  if (ageMs < 0) return 'just now';
  const sec = Math.floor(ageMs / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const d = Math.floor(hr / 24);
  return `${d}d`;
}

function columns(now: number): ColumnDef<BootHistoryEntry>[] {
  return [
    {
      key: 'when',
      header: 'When',
      width: 0.85,
      toCopyText: (e) => `${relTime(e.ts, now)} ago`,
      render: ({ row }) => `${relTime(row.ts, now)} ago`,
    },
    {
      key: 'workspace',
      header: 'Workspace',
      width: 1.4,
      toCopyText: (e) => e.workspaceId,
      render: ({ row }) => <code>{row.workspaceId}</code>,
    },
    {
      key: 'harness',
      header: 'Harness',
      width: 1.4,
      toCopyText: (e) => e.harnessSlug,
      render: ({ row }) => <code>{row.harnessSlug}</code>,
    },
    {
      key: 'kind',
      header: 'Kind',
      width: 1.4,
      toCopyText: (e) => e.kind,
      render: ({ row }) => <span style={{ color: BOOT_HISTORY_KIND_COLOR[row.kind] ?? BOOT_HISTORY_KIND_FALLBACK, whiteSpace: 'nowrap' }}>{KIND_MARK[row.kind]} {row.kind}</span>,
    },
    {
      key: 'message',
      header: 'Message',
      width: 2.4,
      toCopyText: (e) => e.message ?? '',
      render: ({ row }) => <span style={{ color: 'var(--fg-dim)' }}>{row.message ?? ''}</span>,
    },
  ];
}

export function BootHistoryTable(props: BootHistoryTableProps): ReactNode {
  const { entries } = props;
  const now = props.nowMs ?? Date.now();
  if (entries.length === 0) {
    return (
      <div style={EMPTY} data-testid="boot-history-empty">
        No substrate boot events yet.
      </div>
    );
  }
  return (
    <div style={{ height: Math.min(520, 32 + entries.length * 30 + 4) }} data-testid="boot-history-table">
      <RichGrid<BootHistoryRow>
        columns={columns(now)}
        rows={entries.map((e, i) => ({ ...e, _rowIndex: i }))}
        getRowId={(row) => `${row.ts}-${row.workspaceId}-${row.harnessSlug}-${row.kind}-${row._rowIndex}`}
        rowMinHeight={30}
        headerHeight={32}
        rowProps={({ row }) => ({ 'data-testid': `boot-history-row-${row.kind}` })}
      />
    </div>
  );
}
