/**
 * Cross-platform process-environment inspection at the host boundary.
 *
 * SECURITY: a process environment routinely contains credentials. This module
 * is an internal primitive, not a diagnostic response shape. Callers must
 * project an explicit allowlist (or redact values) before anything crosses a
 * log, UI, MCP, or persistence boundary.
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';

export type ProcessEnvironment = Readonly<Record<string, string>>;
export type ProcessEnvironmentSource = 'spawn-snapshot' | 'procfs' | 'ps';
export type ProcessEnvironmentFidelity = 'exact' | 'best-effort';

export type ProcessEnvironmentInspection =
  | {
      ok: true;
      environment: ProcessEnvironment;
      source: ProcessEnvironmentSource;
      fidelity: ProcessEnvironmentFidelity;
    }
  | {
      ok: false;
      reason: 'invalid-pid' | 'unsupported-platform' | 'unreadable';
      detail: string;
    };

export interface ProcessEnvironmentReaderDeps {
  platform?: NodeJS.Platform;
  /** Exact environment captured by an owning spawn seam, when one exists. */
  readSpawnSnapshot?: (
    pid: number,
  ) => Promise<ProcessEnvironment | string | null | undefined>;
  /** Linux `/proc/<pid>/environ` reader. */
  readProcEnvironment?: (pid: number) => Promise<string>;
  /** macOS `ps -eww -p <pid> -o command=` reader. */
  readPsCommand?: (pid: number) => Promise<string>;
}

const ENVIRONMENT_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Parse the exact NUL-delimited shape exposed by procfs and spawn snapshots. */
export function parseNulSeparatedEnvironment(raw: string): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const entry of raw.split('\0')) {
    const separator = entry.indexOf('=');
    if (separator <= 0) continue;
    const key = entry.slice(0, separator);
    if (!ENVIRONMENT_KEY.test(key) || key in environment) continue;
    environment[key] = entry.slice(separator + 1);
  }
  return environment;
}

/**
 * Parse BSD `ps eww` output without splitting values on ordinary whitespace.
 *
 * `ps` flattens argv + environment into one text stream, so this is explicitly
 * BEST-EFFORT rather than an exact serialization. Assignment boundaries are
 * whitespace followed by a valid environment identifier. Later duplicate keys
 * win: an argv token such as `MODE=preview` precedes the real appended process
 * environment and must not shadow it.
 */
export function parsePsEwwEnvironment(raw: string): Record<string, string> {
  const matches = [...raw.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=/g)].flatMap((match) =>
    match.index === undefined
      ? []
      : [{ index: match.index, length: match[0].length, key: match[1]! }],
  );
  const environment: Record<string, string> = {};
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!;
    const valueStart = match.index + match.length;
    const valueEnd = matches[index + 1]?.index ?? raw.length;
    environment[match.key] = raw.slice(valueStart, valueEnd).trimEnd();
  }
  return environment;
}

function normalizeSpawnSnapshot(snapshot: ProcessEnvironment | string): Record<string, string> | null {
  if (typeof snapshot !== 'string') {
    const environment: Record<string, string> = {};
    for (const [key, value] of Object.entries(snapshot)) {
      if (ENVIRONMENT_KEY.test(key) && !(key in environment) && typeof value === 'string') {
        environment[key] = value;
      }
    }
    return environment;
  }
  const trimmed = snapshot.trim();
  if (!trimmed.startsWith('{')) return parseNulSeparatedEnvironment(snapshot);
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') return null;
    return normalizeSpawnSnapshot(parsed as Record<string, string>);
  } catch {
    return null;
  }
}

function defaultReadProcEnvironment(pid: number): Promise<string> {
  return readFile(`/proc/${pid}/environ`, 'utf8');
}

function defaultReadPsCommand(pid: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      '/bin/ps',
      ['-eww', '-p', String(pid), '-o', 'command='],
      { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(String(stdout));
      },
    );
  });
}

/**
 * Inspect one process through the strongest available source.
 *
 * An owning spawn snapshot is exact and avoids an OS call. Linux procfs is
 * exact and NUL-delimited. macOS exposes only flattened `ps eww` text here, so
 * its result is labelled best-effort and callers must not treat absence as a
 * proof that a variable was unset.
 */
export async function inspectProcessEnvironment(
  pid: number,
  deps: ProcessEnvironmentReaderDeps = {},
): Promise<ProcessEnvironmentInspection> {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return { ok: false, reason: 'invalid-pid', detail: `pid must be a positive safe integer; received ${pid}` };
  }

  if (deps.readSpawnSnapshot) {
    try {
      const snapshot = await deps.readSpawnSnapshot(pid);
      if (snapshot != null) {
        const environment = normalizeSpawnSnapshot(snapshot);
        if (environment) {
          return { ok: true, environment, source: 'spawn-snapshot', fidelity: 'exact' };
        }
      }
    } catch {
      // A missing/stale snapshot is expected; continue to the host source.
    }
  }

  const platform = deps.platform ?? process.platform;
  if (platform === 'linux') {
    try {
      const raw = await (deps.readProcEnvironment ?? defaultReadProcEnvironment)(pid);
      return {
        ok: true,
        environment: parseNulSeparatedEnvironment(raw),
        source: 'procfs',
        fidelity: 'exact',
      };
    } catch (error) {
      return {
        ok: false,
        reason: 'unreadable',
        detail: `could not read process ${pid} through procfs: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  if (platform === 'darwin') {
    try {
      const raw = await (deps.readPsCommand ?? defaultReadPsCommand)(pid);
      return {
        ok: true,
        environment: parsePsEwwEnvironment(raw),
        source: 'ps',
        fidelity: 'best-effort',
      };
    } catch (error) {
      return {
        ok: false,
        reason: 'unreadable',
        detail: `could not read process ${pid} through ps: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  return {
    ok: false,
    reason: 'unsupported-platform',
    detail: `process-environment inspection is unsupported on ${platform}`,
  };
}
