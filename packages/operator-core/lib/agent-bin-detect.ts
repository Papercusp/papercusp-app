/**
 * Resolve absolute paths of the coding-agent CLIs on the host.
 *
 * ONE resolver, every consumer (WI-39538). Before this module owned the
 * fallbacks, "is codex installed?" had two independent answers that could
 * disagree — `detectBinaries()` here (a bare `which`) and `detectCodex()` in
 * `preflight-binaries.ts` (a `--version` probe over a hand-kept candidate
 * list) — and on 2026-08-16 BOTH were wrong on the same box while codex was
 * installed and working. The settings page said "✗ not found" for a
 * `codex-cli 0.147.0` that agent sessions were driving successfully.
 *
 * Why a bare `which` is not enough: the operator runs under systemd with a
 * fixed PATH, NOT the owner's login-shell PATH. The psu/papercusp/ptool
 * wrappers each prepend their own PATH before exec'ing, which is why agent
 * sessions kept working and hid the gap for as long as they did.
 *
 * ⚠ THE ORDER BELOW IS LOAD-BEARING — `process.execPath`'s directory comes
 * SECOND, ahead of the static candidate list, and it is the entry that
 * actually fixed the reported bug. An npm-installed CLI lands in the `bin/`
 * of the SAME node prefix that runs the operator, so the sibling-of-node
 * lookup finds it wherever that prefix lives and survives a node upgrade
 * (`~/.local/node25` → `~/.local/node26`) that any hardcoded path would not.
 * Prefer adding a DERIVED location over another literal when this list grows.
 *
 * ⚠ Every candidate is checked with `accessSync(X_OK)`, which FOLLOWS
 * symlinks — so a dangling shim is skipped rather than returned as a hit.
 * That is not hypothetical: `~/.papercusp/bin/codex` on the reporting box
 * pointed at a linuxbrew path that had been removed, and linuxbrew sits
 * FIRST on the operator's PATH, so codex resolved there until it silently
 * stopped. A resolver that only tested existence would have reported that
 * corpse as installed.
 */
import { accessSync, constants } from 'node:fs';
import { execFile, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** The agent CLIs this module knows how to locate. */
export const AGENT_BINARY_NAMES = ['claude', 'codex', 'omp', 'pi'] as const;
export type AgentBinaryName = (typeof AGENT_BINARY_NAMES)[number];

export interface DetectedBinaries {
  claude: string | null;
  codex: string | null;
  omp: string | null;
  pi: string | null;
}

/** Is `path` present AND executable? Follows symlinks, so a dangling shim is false. */
function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Non-PATH install locations to try for `bin`, in priority order.
 *
 * Exported because `preflight-binaries.ts` runs the SAME list through a
 * stronger `--version` probe: two probe strategies, one list, so the wizard's
 * answer and the settings page's answer cannot drift apart again.
 */
export function agentBinaryCandidates(bin: string): string[] {
  const home = process.env.HOME ?? '';
  const winHome = process.env.USERPROFILE ?? '';
  const candidates: string[] = [];

  // 1. The bin/ of the node prefix RUNNING THIS PROCESS. An npm/npx-installed
  //    CLI is a sibling of the `node` that launched us, so this follows the
  //    operator to whatever prefix it is started from. Derived, never pinned.
  try {
    if (process.execPath) candidates.push(join(dirname(process.execPath), bin));
  } catch { /* execPath unavailable — fall through to the static list */ }

  if (home) {
    // 2. The papercusp-managed shim dir the cross-platform installer writes.
    candidates.push(join(home, '.papercusp', 'bin', bin));
    candidates.push(join(home, '.papercusp', 'runtime', 'node_modules', '.bin', bin));
    // 3. Common per-user install prefixes (claude.ai/install.sh lands in ~/.local/bin).
    candidates.push(join(home, '.local', 'bin', bin));
    candidates.push(join(home, '.bun', 'bin', bin));
    candidates.push(join(home, '.npm-global', 'bin', bin));
    candidates.push(join(home, '.cargo', 'bin', bin));
    if (bin === 'claude') candidates.push(join(home, '.claude', 'bin', bin));
  }

  // 4. System-wide prefixes.
  candidates.push(`/usr/local/bin/${bin}`);
  candidates.push(`/opt/homebrew/bin/${bin}`);

  // 5. Windows has no $HOME; the installer targets %USERPROFILE%\.papercusp\bin.
  if (winHome) candidates.push(join(winHome, '.papercusp', 'bin', `${bin}.exe`));

  return candidates.filter(Boolean);
}

/** First candidate that is present and executable, else null. */
function firstExecutableCandidate(bin: string): string | null {
  for (const path of agentBinaryCandidates(bin)) {
    if (isExecutable(path)) return path;
  }
  return null;
}

function whichSync(bin: string): string | null {
  const r = spawnSync('which', [bin], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

async function whichAsync(bin: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('which', [bin]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Absolute path to `bin`, or null. PATH first (cheapest and honours an
 * operator-set override), then the candidate list.
 *
 * Callers that SPAWN one of these CLIs must use this rather than passing the
 * bare name to `spawn` — a bare name re-resolves against the spawning
 * process's PATH, which is exactly the gap that made the codex-cli bridge
 * unable to run a codex that was installed and working.
 */
export function resolveAgentBinarySync(bin: string): string | null {
  return whichSync(bin) ?? firstExecutableCandidate(bin);
}

/** Async twin of `resolveAgentBinarySync` (the `which` probe runs off-thread). */
export async function resolveAgentBinary(bin: string): Promise<string | null> {
  return (await whichAsync(bin)) ?? firstExecutableCandidate(bin);
}

/** Synchronous detection — kept only for callers that are already sync
 *  (setup-wizard pty route). It runs four serial blocking spawnSync('which')
 *  calls, so never call it from a per-request operator handler: the
 *  agent-config route used to and showed up in :3170 main-thread saturation
 *  profiles (WI-10003266). Use `detectBinariesCached`/`detectBinariesAsync`. */
export function detectBinaries(): DetectedBinaries {
  return {
    claude: resolveAgentBinarySync('claude'),
    codex: resolveAgentBinarySync('codex'),
    omp: resolveAgentBinarySync('omp'),
    pi: resolveAgentBinarySync('pi'),
  };
}

/** Parallel async detection: the 4 lookups run CONCURRENTLY instead of
 *  serially (the sync path blocks on 4 back-to-back spawnSync — a measurable chunk
 *  of the tutorial-script endpoint's first-paint latency). */
export async function detectBinariesAsync(): Promise<DetectedBinaries> {
  const [claude, codex, omp, pi] = await Promise.all([
    resolveAgentBinary('claude'),
    resolveAgentBinary('codex'),
    resolveAgentBinary('omp'),
    resolveAgentBinary('pi'),
  ]);
  return { claude, codex, omp, pi };
}

/** Short-TTL process memo for hot read paths (the tutorial-script endpoint
 *  re-detects on every launch). The setup-wizard's fresh-detection polling keeps
 *  using the uncached `detectBinaries`/`detectBinariesAsync`, so the TTL is a
 *  safety net, not a correctness contract. */
let binCache: { at: number; bins: DetectedBinaries } | null = null;
export async function detectBinariesCached(ttlMs = 30_000): Promise<DetectedBinaries> {
  const now = Date.now();
  if (binCache && now - binCache.at < ttlMs) return binCache.bins;
  const bins = await detectBinariesAsync();
  binCache = { at: now, bins };
  return bins;
}
