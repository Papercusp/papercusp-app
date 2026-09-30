/**
 * (WI-39599) Fixture: the OPERATOR in the desktop→operator→sidecar topology.
 *
 * Its only job is to own the read ends of both sidecars' stdio pipes and then
 * be SIGKILLed by the test, which is what closes those pipes and reproduces the
 * abrupt-death condition. It must not be the test process itself — the test
 * cannot kill its own runner.
 *
 * Driven by lib/process-supervision/stdio-peer-guard.integration.test.ts.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const childPath = process.env.CHILD_PATH;
const pidsPath = process.env.PIDS_PATH;
if (!childPath || !pidsPath) throw new Error('CHILD_PATH and PIDS_PATH are required');

const pids: Record<string, number> = {};
for (const [name, guard] of [
  ['guarded', '1'],
  ['unguarded', '0'],
] as const) {
  const child = spawn(process.execPath, ['--import', 'tsx', childPath], {
    // The real packaged-sidecar stdio shape: our pipes, our read ends.
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GUARD: guard },
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  if (child.pid) pids[name] = child.pid;
}

writeFileSync(pidsPath, JSON.stringify(pids));

// Stay alive (and stay the owner of those pipe read ends) until killed.
setTimeout(() => process.exit(0), 600_000);
