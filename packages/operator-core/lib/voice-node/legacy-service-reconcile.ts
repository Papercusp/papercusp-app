/**
 * Reconcile the user-level VoiceMode services with the operator-owned local voice lifecycle.
 *
 * VoiceMode's installer leaves two independent systemd units behind.  That is useful as a
 * developer-host compatibility layer, but it is unsafe when the units become a second owner:
 * the historical Whisper unit points at a deleted script and can consume a restart budget
 * forever, while the Kokoro unit used to install dependencies and download model files on every
 * restart.  The operator provisioner/runtime is the canonical owner (plan D-006), so this module
 * gives boot and explicit provisioning one small, injectable reconciliation seam.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** User-level units shipped by the legacy VoiceMode installer. */
export const LEGACY_VOICE_UNITS = {
  whisper: 'voicemode-whisper.service',
  kokoro: 'voicemode-kokoro.service',
} as const;

export type LegacyVoiceUnitAction =
  | 'disabled'
  | 'already-absent'
  | 'retained'
  | 'failed'
  | 'unsupported';

export interface LegacyVoiceUnitResult {
  unit: string;
  ok: boolean;
  action: LegacyVoiceUnitAction;
  /**
   * Did the mask VERIFIABLY take effect (systemd reports LoadState=masked)?
   *
   * `undefined` when no mask was requested. `false` means systemctl reported
   * success and the unit is still startable — see maskVerification. Never infer
   * this from the exit code; that is the bug this field exists to expose
   * (WI-934065).
   */
  masked?: boolean;
  /** What the readback actually saw, so a caller never has to re-derive it. */
  maskVerification?: { loadState: string; effective: boolean };
  detail?: string;
}

export interface LegacyVoiceReconcileResult {
  whisper: LegacyVoiceUnitResult;
  kokoro: LegacyVoiceUnitResult;
}

export interface LegacyVoiceReconcileDeps {
  /** Injectable systemctl seam; production calls are bounded to 15 seconds. */
  runSystemctl?: (args: string[]) => Promise<{ stdout: string; stderr: string }>;
  /** Tests can force the platform branch; defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** Retire the compatibility Kokoro unit too. Defaults to false. */
  retireKokoro?: boolean;
  /** Runtime-mask the broken Whisper unit after disabling it. Defaults to false for compatibility. */
  maskWhisper?: boolean;
}

async function defaultSystemctl(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync('systemctl', args, { timeout: 15_000 });
  return { stdout: result.stdout, stderr: result.stderr };
}

function isAbsentUnitError(error: unknown): boolean {
  return /not found|not loaded|no such file|could not be found|not installed/i.test(
    error instanceof Error ? error.message : String(error),
  );
}

async function disableUnit(
  unit: string,
  runSystemctl: (args: string[]) => Promise<{ stdout: string; stderr: string }>,
  mask = false,
): Promise<LegacyVoiceUnitResult> {
  try {
    await runSystemctl(['--user', 'disable', '--now', unit]);
  } catch (error) {
    if (isAbsentUnitError(error)) {
      return { unit, ok: true, action: 'already-absent', detail: 'legacy unit is not installed' };
    }
    return {
      unit,
      ok: false,
      action: 'failed',
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  if (mask) {
    try {
      // Runtime masking prevents an old installer/desktop target from immediately re-enabling the
      // broken unit, while avoiding a permanent /dev/null file that would surprise a later
      // explicit migration. The disabled state itself remains durable across manager restarts.
      await runSystemctl(['--user', 'mask', '--runtime', unit]);
    } catch (error) {
      // Disable+stop is still the useful repair. Keep it successful but make the missing mask
      // visible to the caller so a health surface can report the weakened protection.
      return {
        unit,
        ok: true,
        action: 'disabled',
        masked: false,
        detail:
          `disabled and stopped, but runtime mask failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    // ── VERIFY THE MASK. DO NOT TRUST THE EXIT CODE. (WI-934065) ────────────
    //
    // `systemctl --user mask --runtime` can SUCCEED — exit 0, "Created symlink
    // … → /dev/null" — and leave the unit fully startable. The catch block
    // above cannot see that, because nothing threw. Measured on this host
    // (systemd 255): the mask landed in /run/user/1000/systemd/user, which
    // `systemd-analyze --user unit-paths` ranks NINTH, while the legacy unit
    // file lives in ~/.config/systemd/user, ranked FIFTH. The higher-precedence
    // fragment shadows the mask, so LoadState stayed `loaded`, FragmentPath
    // stayed the real unit, and `systemctl --user start` brought the broken
    // unit up. For a unit installed under ~/.config/systemd/user, --runtime
    // masking is STRUCTURALLY incapable of masking it — and the persistent mask
    // is refused outright ("File … already exists"), so neither systemctl mask
    // form can protect it while that fragment is on disk.
    //
    // A reconciler that reports "runtime-masked" on the exit code therefore
    // reports protection the host does not have, which is worse than reporting
    // nothing: a health surface goes green over a unit anyone can start.
    let loadState = 'unknown';
    try {
      const shown = await runSystemctl(['--user', 'show', unit, '-p', 'LoadState', '--value']);
      loadState = shown.stdout.trim() || 'unknown';
    } catch {
      loadState = 'unknown';
    }
    const effective = loadState === 'masked';
    if (!effective) {
      return {
        unit,
        ok: true,
        action: 'disabled',
        masked: false,
        maskVerification: { loadState, effective },
        detail:
          `disabled and stopped, but the mask DID NOT TAKE EFFECT: systemctl reported success and ` +
          `LoadState is "${loadState}", not "masked" — the unit is still startable. A unit file in a ` +
          `higher-precedence directory (typically ~/.config/systemd/user) shadows the runtime mask; ` +
          `retire that fragment before masking. Treat this host as UNPROTECTED.`,
      };
    }
    return {
      unit,
      ok: true,
      action: 'disabled',
      masked: true,
      maskVerification: { loadState, effective },
      detail:
        'disabled, stopped, and runtime-masked (VERIFIED LoadState=masked); operator-managed local voice is canonical',
    };
  }

  return {
    unit,
    ok: true,
    action: 'disabled',
    detail: 'disabled and stopped; operator-managed local voice is canonical',
  };
}

/**
 * Disable the broken legacy Whisper owner and optionally retire the legacy Kokoro accelerator.
 *
 * The function is intentionally best-effort and data-returning: a missing systemd user manager
 * on macOS/Windows, or a transient systemctl failure, must not make the portable in-process
 * voice provisioner report a false model failure. Callers can log `ok:false` and continue with
 * the canonical lifecycle. Repeated calls are idempotent (`disable --now` on an absent unit is a
 * successful `already-absent` result).
 */
export async function reconcileLegacyVoiceServices(
  deps: LegacyVoiceReconcileDeps = {},
): Promise<LegacyVoiceReconcileResult> {
  if ((deps.platform ?? process.platform) !== 'linux') {
    return {
      whisper: {
        unit: LEGACY_VOICE_UNITS.whisper,
        ok: true,
        action: 'unsupported',
        detail: 'user systemd reconciliation is Linux-only',
      },
      kokoro: {
        unit: LEGACY_VOICE_UNITS.kokoro,
        ok: true,
        action: 'unsupported',
        detail: 'user systemd reconciliation is Linux-only',
      },
    };
  }

  const runSystemctl = deps.runSystemctl ?? defaultSystemctl;
  const whisper = await disableUnit(LEGACY_VOICE_UNITS.whisper, runSystemctl, deps.maskWhisper ?? false);
  const kokoro = deps.retireKokoro
    ? await disableUnit(LEGACY_VOICE_UNITS.kokoro, runSystemctl)
    : {
        unit: LEGACY_VOICE_UNITS.kokoro,
        ok: true,
        action: 'retained' as const,
        detail: 'retained as an optional compatibility accelerator',
      };
  return { whisper, kokoro };
}

