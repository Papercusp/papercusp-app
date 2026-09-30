/**
 * Pure contract checks for the optional VoiceMode/Kokoro compatibility service.
 *
 * The operator-owned in-process Kokoro engine is the portable canonical path.  A user-level
 * `voicemode-kokoro.service` may still accelerate a developer host, but it must be a normal
 * long-lived service: dependency/model provisioning happens explicitly, the hot start is
 * offline and deterministic, and a missing install exits with a code systemd does not endlessly
 * restart.  Keeping these checks independent of systemd and Python lets unit tests exercise the
 * recurrence guard without a GPU, a user manager, or network access.
 */

export const KOKORO_SERVICE_UNIT = 'voicemode-kokoro.service';
export const KOKORO_SERVICE_CONFIG_EXIT = 78; // EX_CONFIG: install/provision before starting
export const KOKORO_MODEL_RELATIVE_PATH = 'api/src/models/v1_0/kokoro-v1_0.pth';
export const KOKORO_CONFIG_RELATIVE_PATH = 'api/src/models/v1_0/config.json';
export const KOKORO_VOICES_RELATIVE_PATH = 'api/src/voices/v1_0';

export interface KokoroServiceContractInput {
  unitText: string;
  startScriptText: string;
  provisionScriptText: string;
  /** Optional shared implementation text when start/provision wrappers delegate to it. */
  runtimeStartScriptText?: string;
  runtimeProvisionScriptText?: string;
}

export interface KokoroServiceContractResult {
  ok: boolean;
  violations: string[];
}

/** Remove shell comments for checks that describe executable behaviour. */
function executableLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+#.*$/, '').trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

function hasLine(text: string, pattern: RegExp): boolean {
  return text.split(/\r?\n/).some((line) => pattern.test(line));
}

/**
 * Validate the unit + start/provision scripts as one contract.
 *
 * Violations are stable, human-readable strings because this result is shown by the live stack
 * checker and is also useful in a work-item completion record.  No filesystem or process I/O is
 * performed here.
 */
export function inspectKokoroServiceContract(
  input: KokoroServiceContractInput,
): KokoroServiceContractResult {
  const violations: string[] = [];
  const unitLines = executableLines(input.unitText);
  const startLines = executableLines(`${input.startScriptText}\n${input.runtimeStartScriptText ?? ''}`);
  const provisionLines = executableLines(`${input.provisionScriptText}\n${input.runtimeProvisionScriptText ?? ''}`);
  const start = startLines.join('\n');
  const provision = provisionLines.join('\n');

  if (!hasLine(input.unitText, /^\s*Restart\s*=\s*always\s*$/i)) {
    violations.push('unit must use Restart=always so an intentional exit-0 recycle self-heals');
  }
  const restartPrevent = unitLines.find((line) => /^RestartPreventExitStatus\s*=/i.test(line));
  if (!restartPrevent || !new RegExp(`(?:^|\\s)${KOKORO_SERVICE_CONFIG_EXIT}(?:\\s|$)`).test(restartPrevent.split('=', 2)[1] ?? '')) {
    violations.push(`unit must include RestartPreventExitStatus=${KOKORO_SERVICE_CONFIG_EXIT} for an unprovisioned install`);
  }
  if (unitLines.some((line) => /UVICORN_LIMIT_MAX_REQUESTS\s*=/i.test(line))) {
    violations.push('unit must not set UVICORN_LIMIT_MAX_REQUESTS: one uvicorn process is not a worker pool');
  }
  if (!hasLine(input.unitText, /^\s*ExecStart=.*start-gpu\.sh(?:\s|$)/i)) {
    violations.push('unit ExecStart must point at the repository/service start-gpu.sh entrypoint');
  }
  if (!hasLine(input.unitText, new RegExp(`^\\s*ConditionPathExists=.*${escapeRegExp(KOKORO_MODEL_RELATIVE_PATH)}\\s*$`, 'i'))) {
    violations.push(`unit should guard startup on ${KOKORO_MODEL_RELATIVE_PATH}`);
  }
  if (!hasLine(input.unitText, /TimeoutStartSec\s*=\s*\d+/i)) {
    violations.push('unit must bound model-load startup with TimeoutStartSec');
  }

  const forbiddenHotPath: Array<[RegExp, string]> = [
    [/\buv\s+pip\s+install\b/i, 'uv pip install'],
    [/\bpip(?:3)?\s+install\b/i, 'pip install'],
    [/\buv\s+(?:sync|lock)\b/i, 'uv sync/lock'],
    [/download_model\.py/i, 'download_model.py'],
    [/\b(?:curl|wget)\b/i, 'network download command'],
    [/\burlretrieve\b/i, 'urlretrieve'],
  ];
  for (const [pattern, label] of forbiddenHotPath) {
    if (pattern.test(start)) violations.push(`start script must be offline; found ${label}`);
  }
  if (!/\bexec\b[\s\S]*\b(?:python|uvicorn)\b/i.test(start)) {
    violations.push('start script must exec the already-provisioned uvicorn process');
  }
  if (!start.includes(KOKORO_MODEL_RELATIVE_PATH) && !start.includes('kokoro-v1_0.pth')) {
    violations.push('start script must verify the Kokoro model file before serving');
  }
  if (!start.includes(KOKORO_CONFIG_RELATIVE_PATH) && !start.includes('config.json')) {
    violations.push('start script must verify the Kokoro config before serving');
  }
  if (!start.includes(KOKORO_VOICES_RELATIVE_PATH) || !/\*\.pt|compgen\s+-G|find[^\n]*\.pt/i.test(start)) {
    violations.push(`start script must verify that at least one voice pack is present under ${KOKORO_VOICES_RELATIVE_PATH}`);
  }
  if (!new RegExp(`exit\\s+${KOKORO_SERVICE_CONFIG_EXIT}\\b`).test(start)) {
    violations.push(`start script must return exit ${KOKORO_SERVICE_CONFIG_EXIT} when prerequisites are missing`);
  }

  if (!/\b(?:uv\s+)?pip(?:3)?\s+install\b/i.test(provision)) {
    violations.push('provision script must own dependency installation (uv pip install)');
  }
  if (!/download_model\.py/i.test(provision)) {
    violations.push('provision script must own the one-time model download');
  }

  return { ok: violations.length === 0, violations };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
