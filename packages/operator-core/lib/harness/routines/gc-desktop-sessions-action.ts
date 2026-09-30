/**
 * `system:gc-desktop-sessions` — the registration seam for {@link gcDesktopSessions}.
 *
 * Thin by design, matching `gc-verify-instances-action.ts`: every safety condition
 * and the reason for it lives in `gc-desktop-sessions.ts`; this file only puts it
 * on a cadence and decides what is worth a log line.
 *
 * Config (routine `trigger_config`, all optional):
 *   - `max_per_run` — override DESKTOP_GC_MAX_PER_RUN_DEFAULT (25).
 *   - `dry_run`     — classify and report, actuate nothing.
 *
 * HOST-LOCAL, not workspace-scoped: it freezes and kills cgroups on the machine
 * the tick runs on, so `ctx.workspaceId` is deliberately unused. CPU on the box is
 * shared by every tenant it serves.
 *
 * WHAT GETS LOGGED, and why it is not just a count: a sweep that suspends other
 * people's desktops has to be auditable from the journal alone. So an acting run
 * names the sessions, a REFUSAL always prints (a permanently-skipped session that
 * says nothing is indistinguishable from a governor that is not running), and a
 * FAILURE always prints (an unfreezable desktop is waste the governor can see and
 * cannot stop — someone should fix its enrolment).
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { gcDesktopSessions } from './gc-desktop-sessions';

registerSystemAction('gc-desktop-sessions', async (ctx: SystemActionCtx) => {
  const cfg = ctx.triggerConfig ?? {};
  const maxPerRun = Number(cfg.max_per_run);
  const result = await gcDesktopSessions({
    dryRun: cfg.dry_run === true,
    ...(Number.isFinite(maxPerRun) && maxPerRun > 0 ? { maxPerRun } : {}),
  });

  const acted = result.idled + result.frozen + result.reaped;
  if (acted > 0) {
    const sample = result.sessions
      .filter((s) => s.applied || result.dryRun)
      .slice(0, 5)
      .map((s) => `${s.kind}${s.display} ${s.action} (${s.reason})`)
      .join('; ');
    console.log(
      `[gc-desktop-sessions] ${result.dryRun ? 'would apply' : 'applied'} ` +
        `${result.idled} idle, ${result.frozen} freeze, ${result.reaped} reap ` +
        `across ${result.scanned} live session(s) — ${sample}`,
    );
  }

  const refused = result.sessions.filter((s) => s.refused);
  if (refused.length > 0) {
    console.warn(
      `[gc-desktop-sessions] REFUSED ${refused.length} session(s): ` +
        refused.map((s) => `${s.display} — ${s.reason}`).join('; '),
    );
  }

  const failures = result.sessions.filter((s) => s.failed);
  if (failures.length > 0) {
    console.warn(
      `[gc-desktop-sessions] ${failures.length} session(s) could not be governed: ` +
        failures.map((s) => `${s.kind}${s.display} ${s.action} — ${s.failed}`).join('; '),
    );
  }
});
