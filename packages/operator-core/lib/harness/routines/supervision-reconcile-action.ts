/**
 * `system:supervision-reconcile` — the failed-unit reconciler's routine-engine registration
 * (critical-process-supervisor-2026-07-04 P-002). The actual parse/decide/act logic lives in
 * `../../supervision/unit-reconciler.ts` (pure + testable, no PG/DBOS dependency); this module
 * is just the thin adapter that wires it into the ephemeral-executor's dispatch (`system-actions.ts`)
 * with production deps (real `systemctl --user`, the coord broadcast, `FLAGS.SUPERVISOR_AUTO_RESTART`).
 *
 * Seeded as a bespoke `tier:'ephemeral'` routine (60s cadence) by
 * `seed-supervision-reconcile-routine.ts` — see that file for why this is a bespoke seed rather
 * than a per-install blueprint `triggers.schedule` entry (an operator-HOME-level concern, not a
 * per-blueprint-install one — mirrors `hive-git-gc-routine.ts`'s documented deviation).
 */
import { resolve } from 'node:path';
import { moduleRepoRoot } from '../../module-repo-root';
import {
  registerSystemAction,
  type SystemAction,
  type SystemActionCtx,
} from './system-actions';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { sendMessage } from '../../agent-tools/coordination/messages';
import type { AgentIdentity } from '../../agent-tools/coordination/identity';
import { reconcileTick, type ReconcilerDeps } from '../../supervision/unit-reconciler';
import {
  fileSystemdDropInInstallEi,
  resolveSystemdDropInInstallEi,
  type SystemdDropInInstallEpisode,
} from '../../supervision/systemd-dropin-install-ei';
import { probeNamedService } from '../../service-health';
import { fileSupervisionGiveUpEi, resolveSupervisionGiveUpEi } from '../../supervision/give-up-ei';
import { fileSupervisionPausedEi, resolveSupervisionPausedEi } from '../../supervision/paused-unit-ei';
import { execFileViaSidecar } from '../../fleet/git-via-sidecar';

// Not a fixed `../` climb: inside the host bundle that lands outside the checkout and the
// drop-in check reports `unavailable` on every run (P-016). See module-repo-root.ts.
const REPO_ROOT = moduleRepoRoot(import.meta.url);
const DROP_IN_INSTALL_CHECK = resolve(REPO_ROOT, 'scripts/check-systemd-dropins-installed.mjs');

/** Coord identity for the reconciler's own broadcasts (mirrors service-health.ts's HEALTH_IDENTITY
 *  + git-sync-action.ts's own static-client identity). */
const SUPERVISION_IDENTITY: AgentIdentity = {
  ownerId: 'supervision-reconciler',
  ownerLabel: 'supervision-reconciler',
  source: 'static-client',
  workspaceId: null,
  userId: null,
};

/** Per-site kill-switch for the reconciler's sidecar route (`0` = force a local spawn). */
export const SUPERVISION_RECONCILE_SIDECAR_VAR = 'PAPERCUSP_SUPERVISION_RECONCILE_SPAWN_SIDECAR';

/** Real `systemctl --user <args>` exec, 10s timeout (a hung systemctl must never wedge the
 *  60s-cadence tick indefinitely). Rejects on nonzero exit OR spawn failure — the caller
 *  (`reconcileTick`) treats any rejection uniformly as "systemctl unreachable this tick".
 *  Forked by the spawner sidecar where the host has one (WI-10004975: this tick's systemctl
 *  calls were ~17% of a 13 GB bg-host's spawn samples); a rejection still carries the
 *  child's `.stdout`, which `readSystemctlShows` recovers (EI-19966318801100410). */
export async function execSystemctlUser(args: string[]): Promise<string> {
  const { stdout } = await execFileViaSidecar('systemctl', ['--user', ...args], {
    timeoutMs: 10_000,
    subsystem: 'supervision-reconcile',
    sidecarVar: SUPERVISION_RECONCILE_SIDECAR_VAR,
  });
  return stdout;
}

/**
 * Bounded journald fallback for a failed unit. `systemctl status` can omit the prior failed
 * attempt once `Restart=` has already brought a new process up; the journal retains it.
 */
export async function readSystemdUserJournal(unit: string): Promise<string> {
  const { stdout } = await execFileViaSidecar(
    'journalctl',
    ['--user', '-u', unit, '--since=-10min', '--no-pager', '--lines=200'],
    { timeoutMs: 10_000, subsystem: 'supervision-reconcile', sidecarVar: SUPERVISION_RECONCILE_SIDECAR_VAR },
  );
  return stdout;
}

function productionDeps(ctx: SystemActionCtx): ReconcilerDeps {
  return {
    execUser: execSystemctlUser,
    readUnitJournal: readSystemdUserJournal,
    now: () => Date.now(),
    notify: async ({ summary, kind }) =>
      void (await sendMessage(SUPERVISION_IDENTITY, {
        to: ['*'],
        summary,
        category: kind === 'escalation' ? undefined : 'supervision',
        kind: kind === 'escalation' ? 'escalation' : 'message',
        harnessSlug: ctx.installSlug,
      })),
    autoRestartFlagOn: () => getFlag(FLAGS.SUPERVISOR_AUTO_RESTART, 'system').catch(() => false),
    // reboot-residue-service-repairs-2026-10-03 D-004: report failed, non-transient user units the
    // static registry does not cover (host-specific services such as agenticmail / llama-ornith).
    failedUnitCensus: true,
    // EI-22777309029828628: systemd `ActiveState=active` is only the first half of a staging
    // recovery verdict. The reconciler invokes this named HTTP probe (with its own bounded
    // timeout) only after systemd classifies the unit healthy/recovered, so :3170 must also accept
    // the canonical `/api/desktop/version` request before recovery is announced or resolved.
    probeService: probeNamedService,
    // EI-19966318801100410: file/resolve a durable EI around a give-up escalation so the down
    // unit enters the claim queue instead of depending on someone reading the `*` broadcast.
    fileGiveUpEi: fileSupervisionGiveUpEi,
    resolveGiveUpEi: resolveSupervisionGiveUpEi,
    // EI-20003974512096022: same treatment for the PAUSE path — a supervised unit sitting
    // administratively disabled past the threshold becomes a claimable EI instead of an
    // indefinitely-repeating broadcast nobody owns.
    filePausedEi: fileSupervisionPausedEi,
    resolvePausedEi: resolveSupervisionPausedEi,
  };
}

export interface DropInInstallCheckEntry {
  unit: string;
  confName: string;
}

export interface DropInInstallCheckResult {
  status: 'healthy' | 'missing' | 'skipped' | 'unavailable';
  installed: number | null;
  missingCount: number | null;
  unitAbsent: number | null;
  missing: DropInInstallCheckEntry[];
  reason?: string;
}

export type DropInCheckExecutor = (
  command: string,
  args: string[],
  options: { cwd: string; encoding: 'utf8'; timeout: number; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;

/** Parse the stable summary emitted by the existing host checker. */
export function parseSystemdDropInCheckOutput(output: string): DropInInstallCheckResult {
  if (/SKIPPED.*no user systemd manager reachable/i.test(output)) {
    return {
      status: 'skipped',
      installed: null,
      missingCount: null,
      unitAbsent: null,
      missing: [],
      reason: 'no user systemd manager is reachable',
    };
  }

  // An empty inventory is not proof that the host is healthy. Keep any prior condition open
  // until the check has a non-empty population to measure.
  if (/no tracked \*\.service\.d\/\*\.conf found/i.test(output)) {
    return {
      status: 'unavailable',
      installed: null,
      missingCount: null,
      unitAbsent: null,
      missing: [],
      reason: 'the checker found no tracked user service drop-ins',
    };
  }

  const counts = output.match(/^installed=(\d+) missing=(\d+) unit-absent=(\d+)$/m);
  if (!counts) {
    return {
      status: 'unavailable',
      installed: null,
      missingCount: null,
      unitAbsent: null,
      missing: [],
      reason: 'the checker output did not include its population summary',
    };
  }

  const installed = Number(counts[1]);
  const missingCount = Number(counts[2]);
  const unitAbsent = Number(counts[3]);
  const installedRows = [...output.matchAll(/^\s*INSTALLED\s+\S+\s+\S+\s*$/gm)];
  const missing = [...output.matchAll(/^\s*MISSING\s+(\S+)\s+(\S+)\s*$/gm)].map((match) => ({
    unit: match[1],
    confName: match[2],
  }));
  const unitAbsentRows = [...output.matchAll(/^\s*UNIT-ABSENT\s+\S+\s+\S+\s+\(.+\)\s*$/gm)];
  const unreadableUnitRows = [
    ...output.matchAll(/^\s*UNIT-ABSENT\s+\S+\s+\S+\s+\(systemctl show failed\)\s*$/gm),
  ];

  if (
    installed + missingCount + unitAbsent === 0 ||
    installedRows.length !== installed ||
    missing.length !== missingCount ||
    unitAbsentRows.length !== unitAbsent
  ) {
    return {
      status: 'unavailable',
      installed,
      missingCount,
      unitAbsent,
      missing,
      reason: 'the checker summary and measured entry rows disagree',
    };
  }

  if (unreadableUnitRows.length > 0) {
    return {
      status: 'unavailable',
      installed,
      missingCount,
      unitAbsent,
      missing,
      reason: 'systemctl could not read DropInPaths for one or more units',
    };
  }

  return {
    status: missingCount > 0 ? 'missing' : 'healthy',
    installed,
    missingCount,
    unitAbsent,
    missing,
  };
}

/** Run the existing checker once per supervision tick with a hard bound. */
export async function runSystemdDropInInstallCheck(
  // WI-10005118: this runs every 60 s inside the multi-GB bg-host, so fork it from the spawner
  // sidecar like the reconcile's systemctl/journalctl calls above (a local fork's cost grows
  // with the parent's RSS and blocks the main thread). Reject semantics match execFile.
  execute: DropInCheckExecutor = async (command, args, options) => {
    const { stdout, stderr } = await execFileViaSidecar(command, args, {
      timeoutMs: options.timeout,
      cwd: options.cwd,
      maxBuffer: options.maxBuffer,
      subsystem: 'supervision-dropin-check',
      sidecarVar: SUPERVISION_RECONCILE_SIDECAR_VAR,
    });
    return { stdout, stderr };
  },
): Promise<DropInInstallCheckResult> {
  try {
    const { stdout } = await execute(
      process.execPath,
      [DROP_IN_INSTALL_CHECK, '--list'],
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: 30_000, maxBuffer: 256 * 1024 },
    );
    return parseSystemdDropInCheckOutput(stdout);
  } catch (error) {
    return {
      status: 'unavailable',
      installed: null,
      missingCount: null,
      unitAbsent: null,
      missing: [],
      reason: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
    };
  }
}

export interface SupervisionReconcileHandlerDeps {
  reconcile: (ctx: SystemActionCtx) => Promise<unknown>;
  checkDropIns: () => Promise<DropInInstallCheckResult>;
  fileMissing: (episode: SystemdDropInInstallEpisode) => Promise<string | null>;
  resolveMissing: () => Promise<string[]>;
}

/**
 * Compose the existing 60-second supervision routine with the drop-in check. A skipped or
 * unreadable sample leaves an existing condition untouched; only a measured clean sample resolves
 * it. Returning diagnostics makes each routine fire's measurement inspectable after the turn.
 */
export function createSupervisionReconcileHandler(deps: SupervisionReconcileHandlerDeps): SystemAction {
  return async (ctx) => {
    await deps.reconcile(ctx);

    let check: DropInInstallCheckResult;
    try {
      check = await deps.checkDropIns();
    } catch (error) {
      check = {
        status: 'unavailable',
        installed: null,
        missingCount: null,
        unitAbsent: null,
        missing: [],
        reason: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      };
    }

    let conditionAction: 'file' | 'resolve' | 'unchanged' = 'unchanged';
    let conditionIds: string[] = [];
    let conditionError: string | undefined;

    try {
      if (check.status === 'missing' && check.missingCount !== null) {
        conditionAction = 'file';
        const id = await deps.fileMissing({ missingCount: check.missingCount, entries: check.missing });
        conditionIds = id ? [id] : [];
      } else if (check.status === 'healthy') {
        conditionAction = 'resolve';
        conditionIds = await deps.resolveMissing();
      }
    } catch (error) {
      conditionError = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
    }

    return {
      diagnostics: {
        systemdDropInInstall: {
          status: check.status,
          installed: check.installed,
          missingCount: check.missingCount,
          unitAbsent: check.unitAbsent,
          ...(check.reason ? { reason: check.reason } : {}),
        },
        conditionAction,
        conditionIds,
        ...(conditionError ? { conditionError } : {}),
      },
    };
  };
}

registerSystemAction(
  'supervision-reconcile',
  createSupervisionReconcileHandler({
    reconcile: (ctx) => reconcileTick(productionDeps(ctx)),
    checkDropIns: runSystemdDropInInstallCheck,
    fileMissing: fileSystemdDropInInstallEi,
    resolveMissing: resolveSystemdDropInInstallEi,
  }),
  // WI-10005745: checkDropIns runs node <module repo root>/scripts/check-systemd-dropins-installed.mjs.
  { executesIntegrationTreeCode: true },
);
