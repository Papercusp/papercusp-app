'use client';

/**
 * /fleet-status — papercusp fleet status at a glance
 * (platform-ops-batch-2026-07-09 P-004, WI-3518). Deliberately minimal:
 * just the panel, dashboard-reachable at this route. Data rides the
 * `fleet.status` sync query (@papercusp/sync), which reuses the SAME
 * presence-snapshot assembly coord:presence shares — see
 * packages/operator-core/lib/sync-resolver/index.ts.
 */
import FleetStatusPanel from '@/app/_components/FleetStatusPanel';

export default function FleetStatusPage() {
  return (
    <div style={{ padding: '2rem' }}>
      <h1>Fleet status</h1>
      <FleetStatusPanel />
    </div>
  );
}
