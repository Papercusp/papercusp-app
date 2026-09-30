/**
 * sandbox-deps.ts — formal host-dependency check for the fleet OS sandbox
 * (fleet-spawn-sandbox-2026-06-01 P-011).
 *
 * The fleet sandbox is DEFAULT-ON (invoke.ts `fleetSandboxEnabled`, P-013/D-015)
 * and `failIfUnavailable:true` — a host missing its dependencies fails spawns
 * loudly rather than running unsandboxed. This module is the *diagnostic* that
 * tells an operator/agent WHY before (or after) that happens, per platform:
 *
 *   Linux  — claude-code's native sandbox needs `bwrap` (bubblewrap) for the
 *            filesystem/userns layer and `socat` for the network-proxy leg;
 *            codex containment additionally needs the `srt` wrapper (P-015).
 *            Ubuntu 24.04+ restricts unprivileged user namespaces via AppArmor
 *            (`kernel.apparmor_restrict_unprivileged_userns=1`) — bwrap then
 *            needs the distro's bwrap AppArmor profile (D-008).
 *   macOS  — Seatbelt (`sandbox-exec`) ships with the OS; only `srt` is an
 *            extra install (for codex containment).
 *   Windows— no native sandbox support; spawns run sandboxed only under WSL.
 *
 * Container nuance: inside a container (docker/podman) nested user namespaces
 * are often unavailable — claude's sandbox wants `enableWeakerNestedSandbox`
 * there; we DETECT and report, we don't auto-weaken (that's a policy call).
 *
 * Pure-ish: all probes go through an injectable `probes` seam so tests cover
 * every platform/shape without a real bwrap install. No PG, no spawning.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { platform as osPlatform } from 'node:os';

export interface SandboxDepCheck {
  /** Stable check id, e.g. 'bwrap', 'socat', 'srt', 'apparmor-userns', 'container'. */
  name: string;
  /** Whether the check passed (for informational checks: whether no action is needed). */
  ok: boolean;
  /** required=true checks gate `report.ok`; the rest are advisory. */
  required: boolean;
  detail: string;
  /** What to do when not ok. */
  remedy?: string;
}

export interface SandboxDepsReport {
  platform: NodeJS.Platform;
  /** Whether the fleet sandbox supports this platform at all. */
  supported: boolean;
  /** fleetSandboxEnabled() at probe time (PAPERCUSP_FLEET_SANDBOX, default on). */
  enabled: boolean;
  /** True when running inside a container (nested-sandbox caveat applies). */
  container: boolean;
  /** All required checks pass on a supported platform. */
  ok: boolean;
  checks: SandboxDepCheck[];
}

export interface SandboxDepOptions {
  /**
   * Whether this host may spawn CODEX-backed agents. Defaults to true.
   *
   * srt's requiredness is DERIVED from this plus `enabled`, mirroring the
   * runtime guard in invoke.ts exactly; it is never hand-asserted. Pass false
   * only for a host you know spawns claude-code exclusively — claude-code
   * sandboxes without srt, so the check is genuinely advisory there.
   */
  codexSpawns?: boolean;
}

/** Injectable probe seam (tests cover platforms/shapes without real installs). */
export interface SandboxDepProbes {
  platform: () => NodeJS.Platform;
  env: () => NodeJS.ProcessEnv;
  fileExists: (p: string) => boolean;
  readFile: (p: string) => string | null;
}

const realProbes: SandboxDepProbes = {
  platform: osPlatform,
  env: () => process.env,
  fileExists: (p) => existsSync(p),
  readFile: (p) => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  },
};

/** First PATH entry containing `bin`, else null (same scan as invoke.ts srtBinOnPath). */
function binOnPath(bin: string, probes: SandboxDepProbes): string | null {
  for (const d of (probes.env().PATH ?? '').split(':').filter(Boolean)) {
    const p = join(d, bin);
    if (probes.fileExists(p)) return p;
  }
  return null;
}

/** Mirrors invoke.ts fleetSandboxEnabled() without importing the whole module. */
function sandboxEnabled(probes: SandboxDepProbes): boolean {
  const v = (probes.env().PAPERCUSP_FLEET_SANDBOX ?? '').trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off';
}

/** docker/podman container detection (the nested-sandbox caveat). */
function inContainer(probes: SandboxDepProbes): boolean {
  return (
    probes.fileExists('/.dockerenv') ||
    probes.fileExists('/run/.containerenv') ||
    (probes.env().container ?? '') !== ''
  );
}

/**
 * Run the host-dependency check for the fleet spawn sandbox. Read-only and
 * side-effect free; safe to call from a diagnostic tool or at operator boot.
 */
export function checkFleetSandboxHostDeps(
  probes: SandboxDepProbes = realProbes,
  options: SandboxDepOptions = {},
): SandboxDepsReport {
  const platform = probes.platform();
  const enabled = sandboxEnabled(probes);
  const container = platform === 'linux' && inContainer(probes);
  const checks: SandboxDepCheck[] = [];

  if (platform === 'win32') {
    return {
      platform,
      supported: false,
      enabled,
      container: false,
      ok: false,
      checks: [
        {
          name: 'platform',
          ok: false,
          required: true,
          detail: 'No native Windows sandbox support (Linux bwrap / macOS Seatbelt only).',
          remedy:
            'Run fleet spawns under WSL, or opt out with PAPERCUSP_FLEET_SANDBOX=0 (unsandboxed).',
        },
      ],
    };
  }

  if (platform === 'linux') {
    const bwrap = binOnPath('bwrap', probes);
    checks.push({
      name: 'bwrap',
      ok: bwrap !== null,
      required: true,
      detail: bwrap
        ? `bubblewrap found at ${bwrap}`
        : 'bubblewrap (bwrap) not on PATH — the claude-code sandbox filesystem/userns layer needs it; with the default failIfUnavailable:true every sandboxed spawn fails.',
      ...(bwrap
        ? {}
        : {
            remedy:
              'sudo apt install bubblewrap   (or opt the host out: PAPERCUSP_FLEET_SANDBOX=0)',
          }),
    });

    const socat = binOnPath('socat', probes);
    checks.push({
      name: 'socat',
      ok: socat !== null,
      required: true,
      detail: socat
        ? `socat found at ${socat}`
        : 'socat not on PATH — the sandbox network-proxy leg (egress allowlist enforcement) needs it.',
      ...(socat ? {} : { remedy: 'sudo apt install socat' }),
    });

    // Ubuntu 24.04+ AppArmor userns restriction: when the sysctl is 1, bwrap
    // needs the distro bwrap AppArmor profile or user namespaces are denied.
    const restrict = probes.readFile(
      '/proc/sys/kernel/apparmor_restrict_unprivileged_userns',
    );
    if (restrict !== null && restrict.trim() === '1') {
      const profile =
        probes.fileExists('/etc/apparmor.d/bwrap') ||
        probes.fileExists('/etc/apparmor.d/bwrap-userns-restrict');
      checks.push({
        name: 'apparmor-userns',
        ok: profile,
        required: true,
        detail: profile
          ? 'AppArmor restricts unprivileged userns (Ubuntu 24.04+ default) and a bwrap profile is installed — OK.'
          : 'AppArmor restricts unprivileged user namespaces (kernel.apparmor_restrict_unprivileged_userns=1) and no bwrap AppArmor profile found — bwrap will be denied userns and every sandboxed spawn fails.',
        ...(profile
          ? {}
          : {
              remedy:
                'Install the distro bwrap profile (Ubuntu 24.04+: apparmor-profiles ships /etc/apparmor.d/bwrap), or sysctl kernel.apparmor_restrict_unprivileged_userns=0.',
            }),
      });
    } else {
      checks.push({
        name: 'apparmor-userns',
        ok: true,
        required: false,
        detail:
          restrict === null
            ? 'No AppArmor userns restriction sysctl present (pre-24.04 kernel or non-Ubuntu) — no profile needed.'
            : 'AppArmor userns restriction is off — no profile needed.',
      });
    }

    if (container) {
      checks.push({
        name: 'container',
        ok: false,
        required: false,
        detail:
          'Running inside a container — nested user namespaces are often unavailable, so the full bwrap sandbox may fail to start.',
        remedy:
          "Set the claude sandbox option enableWeakerNestedSandbox for spawns in this deployment (a deliberate policy weakening — see the docs page), or run spawns on the host.",
      });
    }
  }

  if (platform === 'darwin') {
    const seatbelt = probes.fileExists('/usr/bin/sandbox-exec');
    checks.push({
      name: 'seatbelt',
      ok: seatbelt,
      required: true,
      detail: seatbelt
        ? 'macOS Seatbelt (sandbox-exec) present (ships with the OS).'
        : 'sandbox-exec not found at /usr/bin/sandbox-exec — unexpected on macOS.',
    });
  }

  // srt — the external wrapper that contains codex spawns (P-015).
  //
  // Requiredness is DERIVED from the same condition invoke.ts's guard uses
  // (`fleetSandboxEnabled() && backendUsesSrt(agentBackend)` -> throw, with no
  // fallback), never hand-asserted. It used to be a flat `required: false`,
  // which kept this report at `ok: true` on a host where EVERY codex fleet
  // spawn was guaranteed to throw before producing a turn — the release-fixer
  // arm died at ~1.7s for hours behind exactly that false-healthy verdict
  // (WI-600814). "Advisory" is true only when no codex spawn can happen.
  const codexSpawns = options.codexSpawns ?? true;
  const srtRequired = enabled && codexSpawns;
  const srt = binOnPath('srt', probes);
  checks.push({
    name: 'srt',
    ok: srt !== null,
    required: srtRequired,
    detail: srt
      ? `srt found at ${srt}`
      : srtRequired
        ? 'srt (@anthropic-ai/sandbox-runtime) not on PATH — every codex fleet spawn on this host THROWS before producing a turn (the invoke.ts srt guard is fail-loud, no fallback). claude-code spawns are unaffected.'
        : `srt (@anthropic-ai/sandbox-runtime) not on PATH — advisory here because ${
            enabled
              ? 'this host declares it does not spawn codex agents'
              : 'the fleet sandbox is off (PAPERCUSP_FLEET_SANDBOX=0)'
          }; codex spawns would fail loudly if that changed.`,
    ...(srt ? {} : { remedy: 'npm install -g @anthropic-ai/sandbox-runtime' }),
  });

  const ok = checks.filter((c) => c.required).every((c) => c.ok);
  return { platform, supported: true, enabled, container, ok, checks };
}
