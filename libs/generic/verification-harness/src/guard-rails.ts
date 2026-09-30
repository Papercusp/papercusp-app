/**
 * Executable guard rails: a lesson one campaign learned the expensive way, carried as a probe
 * the next campaign's preflight runs automatically.
 *
 * A probe is a shell command plus the result that means the rail HOLDS, plus scope tags. A
 * harness contract declares its own `scopeTags`; its preflight runs every probe that shares at
 * least one tag. A probe must name at least one tag (a rail says where it applies); a harness
 * that declares no tags matches no probe.
 *
 * Where probes come from is the caller's business (this package is domain-free): the TS runner
 * takes an already-loaded list, and shell harnesses name a source command through
 * VH_GUARD_RAIL_SOURCE (see bin/vh.sh).
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface GuardRailExpect {
  /** Exit status that means the rail holds. */
  exitCode: number;
  /** When set, stdout must also contain this literal. */
  stdoutIncludes?: string;
}

export interface GuardRailProbe {
  /** Stable id of the lesson (upstream: the fact key). Named in the failure reasonCode. */
  key: string;
  command: string;
  expect: GuardRailExpect;
  scope: readonly string[];
  /** The lesson itself, echoed on failure so the reader sees WHY the rail exists. */
  lesson?: string;
}

export interface GuardRailResult {
  key: string;
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  /** null when ok; `exit:<n>`, `stdout-missing`, `timeout` or `spawn-error` otherwise. */
  reasonCode: string | null;
  stdoutTail: string;
  stderrTail: string;
  elapsedMs: number;
  lesson?: string;
}

export interface GuardRailRun {
  ok: boolean;
  results: GuardRailResult[];
  firstFailure: GuardRailResult | null;
}

export const GUARD_RAIL_TIMEOUT_MS = 30_000;
const TAIL_CHARS = 2_000;

/** Tag grammar shared with the upstream store: lowercase, digits and `:._-`, at most 64 chars. */
export const GUARD_RAIL_TAG = /^[a-z0-9][a-z0-9:._-]{0,63}$/;

/** Returns an error message, or null when the probe is well-formed. PURE. */
export function validateGuardRailProbe(p: GuardRailProbe): string | null {
  if (!p.key) return 'guard rail probe has no key';
  if (!p.command.trim()) return `guard rail ${p.key}: empty command`;
  if (!Number.isInteger(p.expect.exitCode) || p.expect.exitCode < 0 || p.expect.exitCode > 255) {
    return `guard rail ${p.key}: expect.exitCode must be an integer 0..255`;
  }
  if (p.scope.length === 0) return `guard rail ${p.key}: scope must name at least one tag`;
  const bad = p.scope.find((t) => !GUARD_RAIL_TAG.test(t));
  if (bad !== undefined) return `guard rail ${p.key}: invalid scope tag ${JSON.stringify(bad)}`;
  return null;
}

/** The probes whose scope shares a tag with the harness's. Keeps input order. PURE. */
export function selectGuardRails(probes: readonly GuardRailProbe[], harnessTags: readonly string[]): GuardRailProbe[] {
  if (harnessTags.length === 0) return [];
  const tags = new Set(harnessTags);
  return probes.filter((p) => p.scope.some((t) => tags.has(t)));
}

function tail(s: string): string {
  return s.length > TAIL_CHARS ? s.slice(-TAIL_CHARS) : s;
}

export function runGuardRailProbe(
  probe: GuardRailProbe,
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<GuardRailResult> {
  const t0 = Date.now();
  const timeoutMs = opts.timeoutMs ?? GUARD_RAIL_TIMEOUT_MS;
  const secs = Math.max(1, Math.ceil(timeoutMs / 1000));
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    // coreutils timeout signals the probe's whole process group (TERM, then KILL 2s later),
    // so a probe that forks cannot outlive its budget.
    const child = spawn('timeout', ['-k', '2', String(secs), 'bash', '-c', probe.command], {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d: Buffer) => {
      stdout = tail(stdout + d.toString('utf8'));
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr = tail(stderr + d.toString('utf8'));
    });
    const finish = (exitCode: number | null, spawnError?: Error) => {
      const timedOut = (exitCode === 124 || exitCode === 137) && Date.now() - t0 >= secs * 1000;
      let reasonCode: string | null = null;
      if (spawnError) reasonCode = 'spawn-error';
      else if (timedOut) reasonCode = 'timeout';
      else if (exitCode !== probe.expect.exitCode) reasonCode = `exit:${exitCode}`;
      else if (probe.expect.stdoutIncludes !== undefined && !stdout.includes(probe.expect.stdoutIncludes)) {
        reasonCode = 'stdout-missing';
      }
      resolve({
        key: probe.key,
        ok: reasonCode === null,
        exitCode,
        timedOut,
        reasonCode,
        stdoutTail: stdout,
        stderrTail: spawnError ? spawnError.message : stderr,
        elapsedMs: Date.now() - t0,
        ...(probe.lesson ? { lesson: probe.lesson } : {}),
      });
    };
    child.on('error', (err) => finish(null, err));
    child.on('close', (code) => finish(code));
  });
}

/**
 * Runs every probe (never stops at the first failure, so one run reports every broken rail),
 * sequentially so probes that touch the same rig do not race. Writes guard-rails.json into
 * `evidenceDir` when given.
 */
export async function runGuardRails(
  probes: readonly GuardRailProbe[],
  opts: { cwd?: string; timeoutMs?: number; evidenceDir?: string } = {},
): Promise<GuardRailRun> {
  const results: GuardRailResult[] = [];
  for (const p of probes) {
    const invalid = validateGuardRailProbe(p);
    results.push(
      invalid
        ? { key: p.key, ok: false, exitCode: null, timedOut: false, reasonCode: 'invalid-probe', stdoutTail: '', stderrTail: invalid, elapsedMs: 0 }
        : await runGuardRailProbe(p, opts),
    );
  }
  const run: GuardRailRun = { ok: results.every((r) => r.ok), results, firstFailure: results.find((r) => !r.ok) ?? null };
  if (opts.evidenceDir) {
    await mkdir(opts.evidenceDir, { recursive: true });
    await writeFile(path.join(opts.evidenceDir, 'guard-rails.json'), `${JSON.stringify(run, null, 2)}\n`);
  }
  return run;
}

/**
 * What a run records about its guard rails. `source` says where the probes came from;
 * 'unconfigured' means the harness declared scope tags but no source was named, so no rail
 * was checked (visible in the summary line, never silent).
 */
export interface GuardRailReport {
  source: 'arg' | 'command' | 'unconfigured';
  selected: number;
  results: GuardRailResult[];
}

/** Env var naming the probe-source command for harnesses that are not handed a list. */
export const GUARD_RAIL_SOURCE_ENV = 'VH_GUARD_RAIL_SOURCE';

/**
 * Loads probes from a source command: it runs under bash with VH_SCOPE_TAGS set to the
 * harness's tags (comma-separated) and must print a JSON array of GuardRailProbe on stdout.
 * Throws on a non-zero exit or unparsable output: a source that cannot answer must not read
 * as "no rails apply".
 */
export async function loadGuardRailsFromCommand(
  command: string,
  tags: readonly string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<GuardRailProbe[]> {
  const secs = Math.max(1, Math.ceil((opts.timeoutMs ?? 60_000) / 1000));
  const { code, stdout, stderr } = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    let out = '';
    let err = '';
    const child = spawn('timeout', ['-k', '2', String(secs), 'bash', '-c', command], {
      cwd: opts.cwd,
      env: { ...process.env, VH_SCOPE_TAGS: tags.join(',') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Decode at the stream (StringDecoder-backed) so a multi-byte UTF-8 char split
    // across two 'data' chunks is not corrupted into replacement characters.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      out += d;
    });
    child.stderr.on('data', (d: string) => {
      err = tail(err + d);
    });
    child.on('error', reject);
    child.on('close', (c) => resolve({ code: c, stdout: out, stderr: err }));
  });
  if (code !== 0) throw new Error(`guard rail source exited ${code}: ${stderr.trim().slice(-300)}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`guard rail source printed non-JSON: ${stdout.slice(0, 200)}`);
  }
  if (!Array.isArray(parsed)) throw new Error('guard rail source must print a JSON array');
  return parsed as GuardRailProbe[];
}

/** One-line detail for a failed rail: what broke and the lesson it guards. */
export function describeGuardRailFailure(r: GuardRailResult): string {
  const got = r.reasonCode === 'stdout-missing' ? 'expected text not in stdout' : (r.reasonCode ?? 'failed');
  return `guard rail ${r.key} does not hold (${got})${r.lesson ? ` — ${r.lesson}` : ''}`;
}
