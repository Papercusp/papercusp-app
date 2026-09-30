/**
 * bg-host-quiesce-guard — refuse `dev:restart {target:'bg-host'}` while a P-101
 * seed cut (or similar) holds bg-host deliberately quiesced.
 *
 * WI-2140796: `cut-seed-quiesced.sh` (papercusp-desktop/bin/cut-seed-quiesced.sh)
 * already makes its quiesce tamper-evident two ways — it `systemctl --user mask
 * --runtime`s papercusp-bg-host.service for the cut's duration, and it publishes a
 * marker file at `$XDG_RUNTIME_DIR/papercusp-seed-cut.quiesce` (pid/reason/since/
 * log) — but NOTHING ever consulted either signal before this. A peer's raw
 * `systemctl start` failed loudly against the mask ("Unit is masked"), but
 * `dev:restart`'s own restart command runs detached with stdio ignored (see
 * restart.ts's `spawn(...)` call), so that failure was invisible: the tool still
 * reported `ok:true, restarted:true` a second before systemd silently no-op'd
 * against the mask. Before the mask existed at all, the same gap let a real
 * `dev:restart {target:'bg-host'}` land mid-cut and boot-loop against the
 * corestore fd-lock the cut held (`boot_fail … File descriptor could not be
 * locked`, every ~4min) — the cut survived only because the flock, not this
 * guard, protected the data.
 *
 * This module is the preflight that closes the gap: read BEFORE the drain,
 * the same slot `preflightRestartTarget`'s boot-integrity check occupies, so a
 * quiesced bg-host is refused cheaply — no lock taken, nobody drained — instead
 * of silently un-quiescing (or wastefully attempting a restart that would just
 * fail against the mask).
 *
 * Only bg-host is quiesce-sensitive today: cut-seed-quiesced.sh is the only
 * writer of this mask/marker. Fails OPEN throughout, matching every other
 * dev:restart preflight in this directory: a probe failure is `probeFailed:true`
 * and is NEVER itself treated as "quiesced" — a guard that cannot run must never
 * be the reason a wedged host stays wedged.
 *
 * Deliberately its OWN module rather than living in restart-preflight.ts or
 * systemd-service-probe.ts, for the same reason restart-preflight.ts gives for
 * its own separateness: restart.test.ts mocks sibling modules with a
 * NON-spreading `vi.mock`, which silently blanks anything else parked there.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { RESTART_TARGET_UNITS } from './restart-target-units';

let run: ((...args: any[]) => Promise<any>) | undefined;
const execFileP = (...args: any[]) => (run ??= promisify(execFile) as any)(...args);

export const QUIESCE_SENSITIVE_RESTART_TARGETS = ['bg-host'] as const;
export type QuiesceSensitiveTarget = (typeof QUIESCE_SENSITIVE_RESTART_TARGETS)[number];

export function isQuiesceSensitiveTarget(target: string): target is QuiesceSensitiveTarget {
  return (QUIESCE_SENSITIVE_RESTART_TARGETS as readonly string[]).includes(target);
}

/** The marker cut-seed-quiesced.sh writes at `$XDG_RUNTIME_DIR/papercusp-seed-cut.quiesce`. */
export interface QuiesceMarker {
  pid: number | null;
  unit: string | null;
  reason: string | null;
  since: string | null;
  log: string | null;
}

export interface QuiesceProbe {
  /** true only when the unit's UnitFileState reads masked/masked-runtime — the
   *  authoritative, tamper-evident signal (it is what actually makes systemd
   *  refuse the restart). */
  masked: boolean;
  maskProbeFailed: boolean;
  marker: QuiesceMarker | null;
  /** true when the marker file exists but could not be read/parsed. A plain
   *  ENOENT (no cut running) is NOT a probe failure. */
  markerReadFailed: boolean;
}

export interface QuiesceVerdict {
  target: string;
  quiesced: boolean;
  blocked: boolean;
  overridden: boolean;
  marker: QuiesceMarker | null;
  probeFailed: boolean;
  note: string;
}

/** Reads one systemd unit's UnitFileState. `systemctl --user show <unit> -p
 *  UnitFileState --value` exits 0 even for an unknown unit (empty value), so —
 *  unlike `systemctl is-enabled` — there is no nonzero-exit stdout-capture
 *  problem to route around; this mirrors restart-preflight.ts's WorkingDirectory
 *  read on purpose. */
export type UnitFileStateReader = (unit: string) => Promise<string>;

const defaultReadUnitFileState: UnitFileStateReader = async (unit) => {
  const { stdout } = await execFileP('systemctl', ['--user', 'show', unit, '-p', 'UnitFileState', '--value'], {
    timeout: 3000,
  });
  return stdout.trim();
};

function quiesceMarkerPath(): string {
  const runtimeDir = process.env.XDG_RUNTIME_DIR?.trim() || `/run/user/${process.getuid?.() ?? ''}`;
  return join(runtimeDir, 'papercusp-seed-cut.quiesce');
}

export type MarkerReader = () => Promise<string>;
const defaultReadMarker: MarkerReader = () => readFile(quiesceMarkerPath(), 'utf8');

function parseMarker(raw: string): QuiesceMarker | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      pid: typeof parsed.pid === 'number' ? parsed.pid : null,
      unit: typeof parsed.unit === 'string' ? parsed.unit : null,
      reason: typeof parsed.reason === 'string' ? parsed.reason : null,
      since: typeof parsed.since === 'string' ? parsed.since : null,
      log: typeof parsed.log === 'string' ? parsed.log : null,
    };
  } catch {
    return null;
  }
}

export interface QuiesceProbeDeps {
  readUnitFileState?: UnitFileStateReader;
  readMarker?: MarkerReader;
}

/** Probe only — no judgement. Never throws. */
export async function probeBgHostQuiesce(unit: string, deps?: QuiesceProbeDeps): Promise<QuiesceProbe> {
  const readUnitFileState = deps?.readUnitFileState ?? defaultReadUnitFileState;
  const readMarker = deps?.readMarker ?? defaultReadMarker;

  let masked = false;
  let maskProbeFailed = false;
  try {
    const state = await readUnitFileState(unit);
    masked = state === 'masked' || state === 'masked-runtime';
  } catch {
    maskProbeFailed = true;
  }

  let marker: QuiesceMarker | null = null;
  let markerReadFailed = false;
  try {
    const raw = await readMarker();
    marker = parseMarker(raw);
    if (marker === null) markerReadFailed = true; // present but unparseable
  } catch (err) {
    // ENOENT is the ordinary "no cut running right now" case, not a probe failure.
    markerReadFailed = (err as { code?: string } | undefined)?.code !== 'ENOENT';
  }

  return { masked, maskProbeFailed, marker, markerReadFailed };
}

/** Pure judgement over an already-gathered probe. */
export function judgeBgHostQuiesce(input: { target: string; probe: QuiesceProbe; override: boolean }): QuiesceVerdict {
  const { target, probe, override } = input;
  const probeFailed = probe.maskProbeFailed || probe.markerReadFailed;
  const quiesced = probe.masked;
  const holderNote = probe.marker
    ? ` (pid ${probe.marker.pid ?? '?'}, since ${probe.marker.since ?? 'unknown'}: ${probe.marker.reason ?? 'no reason recorded'})`
    : probe.markerReadFailed
      ? ' (marker file present but unreadable — treat the mask alone as authoritative)'
      : '';
  return {
    target,
    quiesced,
    blocked: quiesced && !override,
    overridden: quiesced && override,
    marker: probe.marker,
    probeFailed,
    note: quiesced
      ? override
        ? `⚠ ${target} is quiesced${holderNote} — proceeding anyway because override_quiesce:true was passed. This can un-quiesce an in-flight seed cut; only do this once you have confirmed with the holder that it is safe.`
        : `${target}'s unit is masked${holderNote} — a P-101 seed cut (or similar) has it deliberately quiesced. Restarting now would either no-op against the mask or race the wrapper's own unmask/restart. Confirm with the holder, then pass override_quiesce:true only if truly needed.`
      : probeFailed
        ? `${target} quiesce state could not be fully verified (mask probe ${probe.maskProbeFailed ? 'failed' : 'ok'}, marker read ${probe.markerReadFailed ? 'failed' : 'ok'}) — proceeding as NOT quiesced; this is not a clean bill of health.`
        : `${target} is not quiesced.`,
  };
}

/** Probe + judge, the one call `dev:restart` makes. Never throws. */
export async function checkBgHostQuiesce(
  target: string,
  override: boolean,
  deps?: QuiesceProbeDeps,
): Promise<QuiesceVerdict> {
  if (!isQuiesceSensitiveTarget(target)) {
    return judgeBgHostQuiesce({
      target,
      probe: { masked: false, maskProbeFailed: false, marker: null, markerReadFailed: false },
      override,
    });
  }
  const unit = RESTART_TARGET_UNITS[target];
  const probe = await probeBgHostQuiesce(unit, deps);
  return judgeBgHostQuiesce({ target, probe, override });
}
