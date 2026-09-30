'use client';

/**
 * FleetStatusPanel — papercusp fleet status at a glance
 * (platform-ops-batch-2026-07-09 P-004). Reads via `@papercusp/sync`
 * (fleet.status), never a hand-rolled fetch/poll — the resolver reuses
 * the same presence-snapshot assembly coord:presence/coord:inbox share,
 * so this panel never diverges from the live coordination roster.
 */
import { useSyncQuery } from '@papercusp/sync';
import { Table, type TableColumn } from '../harness/Table';
import { useLexicon } from '@/lib/useLexicon';
import { agentDisplayLabel, agentRoleLabel } from '../harness/agent-display';
import FleetRoleGlyph from './FleetRoleGlyph';

interface FleetStatusRow {
  ownerId: string;
  label: string;
  role: string | null;
  intent: string | null;
  planSlug: string | null;
  potSlug: string | null;
  fleetSlug: string | null;
  fleetRole: string | null;
  sessionState: string | null;
  lastActiveSecAgo: number | null;
}

function formatLastActive(secAgo: number | null): string {
  if (secAgo == null) return 'unknown';
  if (secAgo < 60) return `${Math.round(secAgo)}s ago`;
  if (secAgo < 3600) return `${Math.round(secAgo / 60)}m ago`;
  return `${Math.round(secAgo / 3600)}h ago`;
}

export default function FleetStatusPanel() {
  const lex = useLexicon();
  const { data, error, loading } = useSyncQuery<FleetStatusRow>({
    queryName: 'fleet.status',
    args: {},
  });

  if (loading) {
    return (
      <div className="pc-fleet-status" role="status">
        Loading fleet status…
      </div>
    );
  }
  if (error) {
    return (
      <div className="pc-fleet-status pc-fleet-status--error" role="status">
        Fleet status unavailable — {String(error)}
      </div>
    );
  }
  const rows = data ?? [];
  if (rows.length === 0) {
    return (
      <div className="pc-fleet-status" role="status">
        No live agents right now.
      </div>
    );
  }

  return (
    <Table
      className="pc-fleet-status"
      caption={`${rows.length} live agent${rows.length === 1 ? '' : 's'}`}
      columns={columnsFor(lex)}
      rows={rows}
      getRowKey={(row) => row.ownerId}
    />
  );
}

/** Column defs for the fleet-status table (shared design-primitives Table —
 *  WI-3537, replacing the hand-rolled native table markup that redded the
 *  design-primitives lint). Module-scope: pure renders, no component state. */
function columnsFor(lex: ReturnType<typeof useLexicon>): TableColumn<FleetStatusRow>[] {
  return [
  { key: 'agent', header: 'Agent', render: (row) => agentDisplayLabel(row.label, lex) },
  { key: 'role', header: 'Role', render: (row) => row.role ? agentRoleLabel(row.role, lex) : '—' },
  {
    key: 'fleet',
    header: 'Fleet',
    // Role reads as the SHARED 👑/👤 glyph, not "(leader)"/"(member)" text —
    // the same iconography the terminal title/statusline already uses, so one
    // agent looks identical in both places (owner directive 2026-07-26).
    render: (row) =>
      row.fleetSlug ? (
        <>
          {row.fleetSlug}
          {row.fleetRole ? <FleetRoleGlyph role={row.fleetRole} /> : null}
        </>
      ) : (
        '—'
      ),
  },
  { key: 'claim', header: 'Current claim', render: (row) => row.planSlug ?? row.intent ?? '—' },
  { key: 'state', header: 'State', render: (row) => row.sessionState ?? '—' },
  { key: 'last-activity', header: 'Last activity', render: (row) => formatLastActive(row.lastActiveSecAgo) },
  ];
}
