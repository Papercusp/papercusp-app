/**
 * restart-preflight — "would this host actually BOOT?", asked BEFORE we kill it.
 *
 * EI-18661647550414959. `dev:restart` used to be a pure coordination primitive: it
 * drained, killed and restarted, and the first thing that ever asked whether the
 * target could boot was the target itself, from inside its own boot — i.e. after the
 * running process was already gone. On 2026-07-25 that turned a latent node_modules
 * divergence (pruned hours earlier by an unrelated `npm install`) into a fleet-wide
 * routines/git-sync outage: the restart returned `{ok:true, restarted:true}` and the
 * service then crash-looped 5x on `[boot-integrity] FATAL` (exit 78).
 *
 * The asymmetry that makes this worth a preflight: BEFORE the restart the check is
 * free and the host is still up; AFTER, the host is gone and recovery needs a
 * human-equivalent diagnosis. Worse, the failure is LATENT — it lands on whatever
 * unrelated change the next restart happened to be carrying, and gets misattributed
 * to it.
 *
 * WHY A SEPARATE MODULE (the same reasoning as `restart-target-units.ts`): the
 * obvious home is `systemd-service-probe.ts`, but `restart.test.ts` does a
 * NON-spreading `vi.mock('./systemd-service-probe', ...)`, which silently blanks
 * anything parked there. Living here keeps this injectable and mockable on its own
 * terms.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { preflightTreeAt, type TreeIntegrityResult } from '../../boot-integrity-preflight';
import { RESTART_TARGET_UNITS, type RestartTargetName } from './restart-target-units';

let run: ((...args: any[]) => Promise<any>) | undefined;
const execFileP = (...args: any[]) => (run ??= promisify(execFile) as any)(...args);

/** Reads one systemd unit property. Injectable so tests never shell out. */
export type UnitPropertyReader = (unit: string, property: string) => Promise<string>;

const defaultReadUnitProperty: UnitPropertyReader = async (unit, property) => {
  const { stdout } = await execFileP('systemctl', ['--user', 'show', unit, '-p', property, '--value'], { timeout: 3000 });
  return stdout.trim();
};

export interface RestartPreflightResult extends TreeIntegrityResult {
  target: RestartTargetName;
  unit: string;
}

/**
 * Resolve a restart target's tree from systemd and preflight it.
 *
 * ⚠ `systemctl --user show <unknown-unit>` EXITS 0 and prints an EMPTY value rather
 * than failing (documented at release-checkpoint-launch.ts:257 and re-verified here).
 * So an empty/unreadable WorkingDirectory MUST read as NOT CHECKED, never as clean —
 * otherwise a typo'd or renamed unit would silently disable this guard while still
 * reporting `ok:true`.
 *
 * Fails OPEN throughout: any probe failure proceeds with `checked:false` and says so.
 * A guard that cannot run must never be the reason a wedged host stays wedged.
 */
export async function preflightRestartTarget(
  target: RestartTargetName,
  opts?: {
    readUnitProperty?: UnitPropertyReader;
    preflight?: typeof preflightTreeAt;
  },
): Promise<RestartPreflightResult> {
  const unit = RESTART_TARGET_UNITS[target];
  const readUnitProperty = opts?.readUnitProperty ?? defaultReadUnitProperty;
  const preflight = opts?.preflight ?? preflightTreeAt;

  let workingDir = '';
  let probeError: string | undefined;
  try {
    workingDir = await readUnitProperty(unit, 'WorkingDirectory');
  } catch (e) {
    probeError = e instanceof Error ? e.message.split('\n')[0] : String(e);
  }

  // systemd renders an unset WorkingDirectory as '' and, on some versions, as the
  // literal '[not set]'. Both mean "we do not know this unit's tree".
  if (!workingDir || workingDir === '[not set]') {
    const reason = probeError
      ? `could not read ${unit} WorkingDirectory (${probeError})`
      : `${unit} reports no WorkingDirectory (an unknown unit also exits 0 with an empty value)`;
    return {
      target,
      unit,
      checked: false,
      ok: true,
      requestedRoot: '',
      lockRoot: null,
      missing: [],
      extraneous: [],
      reason,
      note: `[boot-integrity] NOT CHECKED (${reason}) — proceeding without a verdict. This is not a clean bill of health.`,
    };
  }

  return { target, unit, ...preflight({ rootDir: workingDir }) };
}
