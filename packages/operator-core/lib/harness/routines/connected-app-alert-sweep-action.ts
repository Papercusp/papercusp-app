/**
 * `system:connected-app-alert-sweep` — the connected-app scheduled sweep alerts' routine-engine
 * registration (external-app-access-to-workspaces-2026-09-29 P-328, D-030).
 *
 * Wiring only: the sweep is `runConnectedAppAlertSweep` in `../../connected-apps/alert-sweep.ts`
 * (pure evaluators + one bounded key read, unit- and integration-tested there). Seeded as a
 * durable 15-minute routine by migration 1267, like migrations 878/888.
 */
import { registerSystemAction } from './system-actions';

registerSystemAction('connected-app-alert-sweep', async () => {
  const { runConnectedAppAlertSweep } = await import('../../connected-apps/alert-sweep');
  const result = await runConnectedAppAlertSweep();
  return {
    diagnostics: {
      keys: result.keys,
      alerts: result.alerts.length,
      failed: result.failed,
      kinds: [...new Set(result.alerts.map((a) => a.kind))],
    },
  };
});
