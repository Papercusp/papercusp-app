/**
 * installed-hook-drift-watchdog (WI-10002031) — the RUNNER for
 * `detectInstalledHookDrift`. A pure detector nobody calls is a library, not a
 * detector; this is the leg that makes the hook-drift class self-reporting.
 *
 * THE CLASS. The CC agent hooks are authored in the repo under
 * `<integrationRoot>/apps/operator/scripts/hooks/cc` and INSTALLED, by copy, to
 * `~/.papercusp/hooks/cc`. The installed copy is what actually executes on every
 * agent turn. Nothing re-copies it on its own, so the moment a canonical hook is
 * edited the two diverge and every agent keeps running the stale copy — silently,
 * because a stale hook is a perfectly valid script that simply lacks the fix. The
 * divergence has recurred twice and was caught BOTH times only by an agent
 * hand-diffing the two files after a fix mysteriously failed to take effect
 * (wall:cc-hook-fix-inert-deployed-copy-is-stale, EI-23749662191699491).
 *
 * ── DESIGN DECISION 1: A REFUSAL ESCALATES. ────────────────────────────────────
 * This is the decision that makes the watchdog worth having, and a successor
 * should not "simplify" it away. `detectInstalledHookDrift` is fail-closed: when
 * a directory is unreadable it returns `refused: <reason>` with `clean:false` and
 * `drifted: []`. So a runner that alarms on `drifted.length > 0` alone would go
 * PERFECTLY QUIET on a failed measurement — reproducing, one layer up, the exact
 * bug this item exists to kill (the predecessor guard sat inert for ~6 weeks
 * because "measured nothing" and "found nothing" rendered identically). We
 * therefore escalate on BOTH branches, with different severities and different
 * dedup identities, and the refusal escalation says NOT MEASURED rather than
 * reporting a count.
 *
 * ── DESIGN DECISION 2: CANONICAL COMES FROM THE INTEGRATION ROOT. ─────────────
 * `resolveOperatorAppRoot()` in desktop-install derives the app root from
 * `import.meta.url` — the CALLING PROCESS's own tree. For an installer that is
 * right (it copies from the tree it is running out of). For this sweep it is
 * precisely wrong: the question is "did the installed dir diverge from the
 * canonical integration root", and answering it against whatever tree the
 * operator happens to be executing from is the very confusion that produces the
 * drift. We resolve `PAPERCUSP_INTEGRATION_ROOT` (the seam the operator services
 * actually set), fall back to `PAPERCUSP_RELEASE_ROOT`, and REFUSE rather than
 * guess when neither is set — a guessed baseline would manufacture false drift.
 *
 * ── DESIGN DECISION 3: FULLY INJECTED, SO TESTS TOUCH NO AMBIENT STATE. ───────
 * Every dep is overridable and the tests pass fakes. The sweep must never read
 * the real `~/.papercusp/hooks/cc` under test: the installed copy is LEGITIMATELY
 * divergent between a canonical fix landing and that fix reaching :3070 with an
 * operator restart, so an ambient-reading test would be red for reasons that are
 * not bugs — and would fail for every psu-launched agent while passing in CI
 * (the failure closed as WI-10002057).
 */
import path from 'node:path';
import os from 'node:os';

import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';

import { openEscalation } from '../agent-tools/coordination/escalations';
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import {
  detectInstalledHookDrift,
  formatHookDriftSummary,
  type HookDriftReport,
} from '../desktop-install/installed-hook-drift';

/**
 * Hourly. Hook sources change on the order of days, and the condition is
 * persistent once it starts (nothing self-heals it), so a tighter cadence buys
 * nothing and a looser one leaves agents running a stale hook for most of a day.
 */
export const INSTALLED_HOOK_DRIFT_SWEEP_INTERVAL_MS = 60 * 60_000;

const WATCHDOG_IDENTITY: AgentIdentity = {
  ownerId: 'installed-hook-drift-watchdog',
  ownerLabel: 'system · installed hook drift',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

export type CanonicalDirResolution =
  | { ok: true; dir: string; source: 'integration-root' | 'release-root' }
  | { ok: false; reason: string };

/**
 * Resolve the CANONICAL `scripts/hooks/cc` dir from the environment.
 *
 * Deliberately env-only — see DESIGN DECISION 2. Returning a structured refusal
 * instead of a best-effort path keeps "I could not establish a baseline" from
 * being silently rendered as "the baseline is my own tree", which would report
 * drift that does not exist (or, worse, hide drift that does).
 */
export function resolveCanonicalCcHookDir(
  env: NodeJS.ProcessEnv = process.env,
): CanonicalDirResolution {
  const fromIntegration = env.PAPERCUSP_INTEGRATION_ROOT?.trim();
  if (fromIntegration) {
    return {
      ok: true,
      dir: path.join(fromIntegration, 'apps', 'operator', 'scripts', 'hooks', 'cc'),
      source: 'integration-root',
    };
  }
  const fromRelease = env.PAPERCUSP_RELEASE_ROOT?.trim();
  if (fromRelease) {
    return {
      ok: true,
      dir: path.join(fromRelease, 'apps', 'operator', 'scripts', 'hooks', 'cc'),
      source: 'release-root',
    };
  }
  return {
    ok: false,
    reason:
      'neither PAPERCUSP_INTEGRATION_ROOT nor PAPERCUSP_RELEASE_ROOT is set, so the canonical ' +
      'hook dir cannot be established; refusing to fall back to this process’s own tree',
  };
}

/** The installed dir that actually executes on every agent turn. */
export function resolveInstalledCcHookDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.papercusp', 'hooks', 'cc');
}

export interface InstalledHookDriftSweepDeps {
  resolveCanonical: () => CanonicalDirResolution;
  resolveInstalled: () => string;
  detect: (opts: { canonicalDir: string; installedDir: string }) => HookDriftReport;
  escalateDrift: (report: HookDriftReport) => Promise<void>;
  escalateNotMeasured: (info: { reason: string; canonicalDir?: string; installedDir?: string }) => Promise<void>;
}

function sweepDeps(overrides: Partial<InstalledHookDriftSweepDeps>): InstalledHookDriftSweepDeps {
  return {
    resolveCanonical: () => resolveCanonicalCcHookDir(),
    resolveInstalled: () => resolveInstalledCcHookDir(),
    detect: (opts) => detectInstalledHookDrift(opts),
    escalateDrift: defaultEscalateDrift,
    escalateNotMeasured: defaultEscalateNotMeasured,
    ...overrides,
  };
}

async function defaultEscalateDrift(report: HookDriftReport): Promise<void> {
  const n = report.drifted.length;
  const names = report.drifted.map((d) => `${d.name} (${d.status})`).sort();
  await openEscalation(WATCHDOG_IDENTITY, {
    severity: 'advisory',
    summary:
      `Installed agent hooks diverged from canonical: ${n} hook${n === 1 ? '' : 's'} ` +
      `in ~/.papercusp/hooks/cc no longer match the integration root`,
    body:
      `${formatHookDriftSummary(report)}\n\n` +
      `WHY THIS IS NOT COSMETIC: the INSTALLED copy is what executes on every agent turn. ` +
      `A stale hook is a valid script that merely lacks the fix, so it fails silently — an ` +
      `agent lands a hook fix, the behaviour does not change, and the fix looks wrong. This ` +
      `class has recurred twice and was caught both times only by an agent hand-diffing the ` +
      `two files.\n\n` +
      `ORDERING CAVEAT — read before calling this a bug: a divergence is EXPECTED and correct ` +
      `in the window between a canonical hook fix landing and that fix reaching :3070 with an ` +
      `operator restart that re-installs. Check dev:pipeline_position for the canonical file ` +
      `before treating this as stale-install rather than not-yet-deployed.\n\n` +
      `Canonical: ${report.canonicalDir}\nInstalled:  ${report.installedDir}`,
    meta: {
      dedupKind: 'installed-hook-drift',
      // Keyed on WHICH hooks diverged, not on the count: a persistent divergence
      // dedups instead of re-alarming hourly, while a newly-diverged hook opens a
      // fresh escalation rather than hiding behind the existing one.
      subjectSignature: names.join(','),
      driftedCount: n,
      drifted: names,
      canonicalDir: report.canonicalDir,
      installedDir: report.installedDir,
    },
  });
}

async function defaultEscalateNotMeasured(info: {
  reason: string;
  canonicalDir?: string;
  installedDir?: string;
}): Promise<void> {
  await openEscalation(WATCHDOG_IDENTITY, {
    severity: 'advisory',
    summary: `Installed hook drift NOT MEASURED: ${info.reason}`,
    body:
      `The installed-hook-drift sweep could not complete, so this is a FAILED MEASUREMENT — ` +
      `not a clean machine. Reason: ${info.reason}.\n\n` +
      `This escalation exists precisely because the previous generation of this guard was ` +
      `silently inert for ~6 weeks: "measured nothing" and "found nothing" rendered ` +
      `identically, so a broken detector was indistinguishable from a healthy machine. A quiet ` +
      `sweep must mean "measured and clean" or it means nothing at all.\n\n` +
      (info.canonicalDir ? `Canonical: ${info.canonicalDir}\n` : '') +
      (info.installedDir ? `Installed:  ${info.installedDir}\n` : ''),
    meta: {
      dedupKind: 'installed-hook-drift-not-measured',
      subjectSignature: info.reason,
      canonicalDir: info.canonicalDir ?? null,
      installedDir: info.installedDir ?? null,
    },
  });
}

export type InstalledHookDriftSweepOutcome =
  | { verdict: 'clean'; checked: number; escalated: 0 }
  | { verdict: 'drifted'; checked: number; drifted: number; escalated: 1 }
  | { verdict: 'not-measured'; reason: string; escalated: 1 };

export async function runInstalledHookDriftSweepOnce(
  overrides: Partial<InstalledHookDriftSweepDeps> = {},
): Promise<InstalledHookDriftSweepOutcome> {
  const deps = sweepDeps(overrides);

  const canonical = deps.resolveCanonical();
  if (!canonical.ok) {
    await deps.escalateNotMeasured({ reason: canonical.reason });
    return { verdict: 'not-measured', reason: canonical.reason, escalated: 1 };
  }

  const installedDir = deps.resolveInstalled();
  const report = deps.detect({ canonicalDir: canonical.dir, installedDir });

  // Fail-closed branch FIRST: a refusal carries drifted:[] and would otherwise
  // read as clean. See DESIGN DECISION 1.
  if (report.refused) {
    const reason = String(report.refused);
    await deps.escalateNotMeasured({
      reason,
      canonicalDir: report.canonicalDir,
      installedDir: report.installedDir,
    });
    return { verdict: 'not-measured', reason, escalated: 1 };
  }

  if (report.drifted.length > 0) {
    await deps.escalateDrift(report);
    return {
      verdict: 'drifted',
      checked: report.checked.length,
      drifted: report.drifted.length,
      escalated: 1,
    };
  }

  return { verdict: 'clean', checked: report.checked.length, escalated: 0 };
}

let watchdogTimer: ManagedHandle | null = null;

export function startInstalledHookDriftWatchdog(opts: { intervalMs?: number } = {}): void {
  const intervalMs = opts.intervalMs ?? INSTALLED_HOOK_DRIFT_SWEEP_INTERVAL_MS;
  if (watchdogTimer) watchdogTimer.stop();
  let sweeping = false;
  watchdogTimer = managedSetInterval(
    'installed-hook-drift-watchdog',
    intervalMs,
    () => {
      if (sweeping) return;
      sweeping = true;
      void runInstalledHookDriftSweepOnce()
        .catch((e) => {
          console.warn(
            `[installed-hook-drift-watchdog] sweep failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
          );
        })
        .finally(() => {
          sweeping = false;
        });
    },
    // 'must-sample': the installed dir is plain files on disk written by an
    // installer that emits no change event, so there is nothing to subscribe to
    // for "the installed copy diverged" — it has to be read.
    { category: 'watchdog', classification: 'must-sample' },
  );
}

export function stopInstalledHookDriftWatchdog(): void {
  if (watchdogTimer) watchdogTimer.stop();
  watchdogTimer = null;
}
