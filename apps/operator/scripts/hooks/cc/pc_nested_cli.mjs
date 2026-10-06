/**
 * pc_nested_cli.mjs — the cached nested-CLI verdict for NODE hooks (WI-10004945, WI-10004953).
 *
 * A `claude`/`codex` run from an su's Bash tool, or under a capability:bash job, inherits
 * that su's PAPERCUSP_SID, so every global hook it fires would act AS the su. The bash
 * reader `pc_nested_cli.sh` beside this file answers "is the CLI running this hook nested?"
 * from a per-CLI-process cache (python decides once per CLI, in pc_nested_cli.py). This is
 * the one node entry to it, shared by every .mjs hook and by the inject dispatcher, so the
 * spawn-and-read logic exists once.
 *
 * FAILS OPEN: a missing reader, a missing bash, a timeout or any throw answers false
 * ("not nested"), so the calling hook behaves exactly as it did before the guard.
 *
 * The walk starts at the HOOK's parent by default (`process.ppid`): the reader climbs past
 * shells to the first non-shell ancestor, which is the CLI that fired the hook.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const NESTED_CLI_READER = fileURLToPath(new URL('./pc_nested_cli.sh', import.meta.url));

/** Bound on the reader; a cache hit is ~4ms, a miss starts python once (~50ms). */
const READER_TIMEOUT_MS = 2000;

/**
 * True when the agent CLI running this hook is nested inside another agent.
 * @param {{ startPid?: number, env?: NodeJS.ProcessEnv, reader?: string }} [opts]
 * @returns {boolean}
 */
export function nestedCliCached(opts = {}) {
  const { startPid = process.ppid, env = process.env, reader = NESTED_CLI_READER } = opts;
  try {
    const r = spawnSync('bash', [reader], {
      env: { ...env, PC_NESTED_CLI_START_PID: String(startPid) },
      stdio: 'ignore',
      timeout: READER_TIMEOUT_MS,
    });
    return r.status === 0;
  } catch {
    return false;
  }
}
