/** Safe process metadata for diagnostic/client boundaries.
 *
 * `/proc/<pid>/cmdline` is useful for classification but not display: scripted
 * agent prompts are part of argv. Only this allowlisted projection crosses out.
 */
import { readFileSync, readlinkSync } from 'node:fs';
import { readFile, readlink } from 'node:fs/promises';

export type StableProcessMetadata = {
  executable: string | null;
  role: string | null;
  build: string | null;
};

type MetadataSource = {
  cmdline?: string | null;
  executablePath?: string | null;
  environ?: string | null;
  fallbackRole?: string | null;
};

const ALLOWED_ENV_KEYS = new Set([
  'PAPERCUSP_AGENT',
  'PAPERCUSP_AGENT_ROLE',
  'PAPERCUSP_FLEET_ROLE',
  'PAPERCUSP_BUILD_VERSION',
  'PAPERCUSP_BUILD_SHA',
]);
const SAFE_VALUE = /^[A-Za-z0-9._:/@+~-]+$/;

function safeValue(value: string | null | undefined, maxLength = 160): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed && trimmed.length <= maxLength && SAFE_VALUE.test(trimmed) ? trimmed : null;
}

function basenameOf(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return null;
  return safeValue(trimmed.replaceAll('\\', '/').split('/').pop());
}

function firstArg(cmdline: string | null | undefined): string | null {
  const value = cmdline?.trim() ?? '';
  return value ? value.split(/\0|\s+/, 1)[0] ?? null : null;
}

/**
 * First value of `key` in a NUL-separated environ block, or undefined — the same
 * first-occurrence-wins answer parseNulSeparatedEnvironment gives for that key.
 */
function firstEnvironValue(environ: string, key: string): string | undefined {
  const needle = `${key}=`;
  let at: number;
  if (environ.startsWith(needle)) {
    at = 0;
  } else {
    const hit = environ.indexOf(`\0${needle}`);
    if (hit < 0) return undefined;
    at = hit + 1;
  }
  const valueStart = at + needle.length;
  const end = environ.indexOf('\0', valueStart);
  return environ.slice(valueStart, end < 0 ? undefined : end);
}

/**
 * Parse only stable metadata keys; prompts and credentials are ignored.
 *
 * Looks up the five allowlisted keys directly instead of materialising every
 * entry: the task-manager live scan runs this for thousands of processes, and the
 * full parse was ~5% of the operator main thread while a scan ran
 * (EI-24342043796392664). Semantics match parseNulSeparatedEnvironment
 * restricted to the allowlist — pinned by process-metadata.test.ts.
 */
export function parseAllowlistedProcessEnv(environ: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!environ) return out;
  for (const key of ALLOWED_ENV_KEYS) {
    const value = safeValue(firstEnvironValue(environ, key));
    if (value !== null) out[key] = value;
  }
  return out;
}

/** Pure projection from proc facts. Raw argv never appears in the result. */
export function projectProcessMetadata(source: MetadataSource = {}): StableProcessMetadata {
  const env = parseAllowlistedProcessEnv(source.environ);
  const version = env.PAPERCUSP_BUILD_VERSION ?? null;
  const sha = env.PAPERCUSP_BUILD_SHA ?? null;
  const build = version && sha ? `${version}+${sha.slice(0, 12)}` : version ?? sha?.slice(0, 12) ?? null;
  return {
    executable: basenameOf(source.executablePath) ?? basenameOf(firstArg(source.cmdline)),
    role:
      env.PAPERCUSP_AGENT_ROLE ??
      env.PAPERCUSP_FLEET_ROLE ??
      env.PAPERCUSP_AGENT ??
      safeValue(source.fallbackRole),
    build,
  };
}

/** Read proc metadata, with a pure cmdline first-token fallback for tests/non-Linux. */
export function readProcessMetadata(
  pid: number,
  cmdline: string | null = null,
  fallbackRole: string | null = null,
): StableProcessMetadata {
  let executablePath: string | null = null;
  let environ: string | null = null;
  if (Number.isInteger(pid) && pid > 0) {
    try {
      executablePath = readlinkSync(`/proc/${pid}/exe`);
    } catch {
      /* process exited or procfs is unavailable */
    }
    try {
      environ = readFileSync(`/proc/${pid}/environ`, 'utf8');
    } catch {
      /* process exited, permissions changed, or non-Linux */
    }
  }
  return projectProcessMetadata({ cmdline, executablePath, environ, fallbackRole });
}

/**
 * {@link readProcessMetadata} without blocking the event loop — the procfs reads
 * go to the libuv pool. Use this on any path that reads many processes inside a
 * request-serving process (the task-manager live scan, EI-24342043796392664).
 */
export async function readProcessMetadataAsync(
  pid: number,
  cmdline: string | null = null,
  fallbackRole: string | null = null,
): Promise<StableProcessMetadata> {
  let executablePath: string | null = null;
  let environ: string | null = null;
  if (Number.isInteger(pid) && pid > 0) {
    [executablePath, environ] = await Promise.all([
      readlink(`/proc/${pid}/exe`).catch(() => null),
      readFile(`/proc/${pid}/environ`, 'utf8').catch(() => null),
    ]);
  }
  return projectProcessMetadata({ cmdline, executablePath, environ, fallbackRole });
}

export function formatProcessStartTime(startedAtMs: number | null | undefined): string | null {
  return startedAtMs != null && Number.isFinite(startedAtMs) ? new Date(startedAtMs).toISOString() : null;
}
