import os from 'node:os';
import path from 'node:path';

/**
 * Where the operator's mem0 SQLite event history lives: the process's
 * `PAPERCUSP_HOME` when set, otherwise `~/.papercusp` (WI-10003279).
 *
 * `PAPERCUSP_HOME` is the operator's state-directory override, and a process
 * that sets it (a test running the operator in-process, an isolated stack)
 * means every file of operator state to go there. A directory captured from
 * `os.homedir()` when the memory host is installed ignored it, so those
 * processes opened the live operators' history database and failed on
 * `database is locked` while one of them held it.
 *
 * Deliberately not `papercuspRoot()`: that resolves per REQUEST workspace,
 * and the mem0 client is one per process, built by whichever request comes
 * first. Its history file must not depend on which request that was.
 *
 * Read at client-build time, never at import, so an override applied after
 * this module loads is honoured.
 */
export function operatorMemoryStoreDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PAPERCUSP_HOME?.trim();
  return override ? override : path.join(os.homedir(), '.papercusp');
}
