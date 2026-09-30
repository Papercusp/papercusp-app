/**
 * `system:gc-verify-instances` — the registration seam for {@link gcVerifyInstances}.
 *
 * Thin by design, matching `gc-dead-loops-action.ts`: every safety condition and the
 * reason for it lives in `gc-verify-instances.ts`; this file only puts it on a cadence.
 *
 * Config (routine `trigger_config`, all optional):
 *   - `ttl_hours`   — override VERIFY_INSTANCE_TTL_HOURS_DEFAULT (6).
 *   - `max_per_run` — override VERIFY_INSTANCE_MAX_PER_RUN_DEFAULT (50).
 *   - `tmp_dirs`    — override the scan ROOT SET (string array). Default
 *                     `defaultVerifyScanRoots()`: /tmp, os.tmpdir() and every checkout's
 *                     `.papercusp/tmp`. Scanning /tmp alone missed 20GB of cross-device
 *                     source snapshots on 2026-09-23 (WI-10002867).
 *   - `dry_run`     — report matches without killing or deleting.
 * A managed verifier task that ended is eligible after a short teardown grace;
 * this hourly sweep therefore clears deadline-killed scratch on its next tick.
 *
 * HOST-LOCAL, not workspace-scoped: it reaps files and processes on the machine the
 * tick runs on. `ctx.workspaceId` is deliberately unused — nothing here is
 * multi-tenant.
 *
 * The log line names the freed bytes and a sample of dirs rather than a bare count:
 * an unattended sweep that deletes 300GB should say what it deleted.
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { gcVerifyInstances } from './gc-verify-instances';
import { getTask } from '../../task-manager/store';
import { isTerminalState } from '../../task-manager/types';

function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)}GiB`;
}

registerSystemAction('gc-verify-instances', async (ctx: SystemActionCtx) => {
  const cfg = ctx.triggerConfig ?? {};
  const ttlHours = Number(cfg.ttl_hours);
  const maxPerRun = Number(cfg.max_per_run);
  const roots = Array.isArray(cfg.tmp_dirs)
    ? cfg.tmp_dirs.filter((d: unknown): d is string => typeof d === 'string' && d.length > 0)
    : [];
  const result = await gcVerifyInstances({
    dryRun: cfg.dry_run === true,
    isTaskTerminal: async (taskId) => {
      const row = await getTask(taskId);
      return Boolean(row && row.endedAt && isTerminalState(row.state));
    },
    ...(roots.length > 0 ? { roots } : {}),
    ...(Number.isFinite(ttlHours) && ttlHours > 0 ? { ttlHours } : {}),
    ...(Number.isFinite(maxPerRun) && maxPerRun > 0 ? { maxPerRun } : {}),
  });
  if (result.reaped > 0) {
    const sample = result.instances
      .filter((i) => !i.skipped)
      .slice(0, 5)
      .map((i) => `${i.dir} (${Math.round(i.ageHours)}h)`)
      .join(', ');
    console.log(
      `[gc-verify-instances] ${result.dryRun ? 'would reap' : 'reaped'} ${result.reaped} abandoned ` +
        `verify instance(s) older than ${result.ttlHours}h across ${result.roots.length} root(s), ` +
        `freeing ${gib(result.bytesFreed)} — ${sample}`,
    );
  }
  // A refusal is worth a line of its own: it is the guard doing its job, and silence
  // would make a permanently-skipped dir invisible.
  const refused = result.instances.filter((i) => i.skipped?.includes('refusing'));
  if (refused.length > 0) {
    console.warn(
      `[gc-verify-instances] REFUSED ${refused.length} dir(s): ` +
        refused.map((i) => `${i.dir.split('/').pop()} — ${i.skipped}`).join('; '),
    );
  }
});
