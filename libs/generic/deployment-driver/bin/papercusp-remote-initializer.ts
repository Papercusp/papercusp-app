#!/usr/bin/env node
/**
 * `bin/papercusp-remote-initializer` — the host-installed executable the controller spawns.
 *
 * This is the program `WORKSPACE_HOST_REMOTE_INITIALIZER_ENTRYPOINT` names and
 * `PAPERCUSP_WORKSPACE_HOST_REMOTE_ENTRYPOINT` points at. The controller spawns it once per
 * initialization step over an IAP-tunnelled OpenSSH invocation, writes one JSON request to stdin,
 * and reads one JSON response from stdout.
 *
 * IT IS DELIBERATELY THREE LINES OF LOGIC. Everything decidable — argv validation, the protocol
 * envelope, the host operations, the credential wiring — lives in
 * `runWorkspaceHostRemoteInitializerCli` and `createProductionWorkspaceHostRemoteInitializerDeps`,
 * both of which take their dependencies as arguments and are exercised by the suite. What remains
 * here is the binding of `process.argv`/`process.stdin`/`process.stdout` to those functions, which
 * is the only part a test genuinely cannot reach, so it is kept small enough to read as correct.
 *
 * `process.exitCode` rather than `process.exit()`: the CLI writes the response to stdout, and
 * `process.exit()` can truncate a pipe that has not flushed. Setting the code lets node exit
 * normally once stdout has drained — a truncated response is reported at the controller as a
 * malformed envelope, which would mis-name the failure.
 */
import {
  createProductionWorkspaceHostRemoteInitializerDeps,
  runWorkspaceHostRemoteInitializerCli,
} from '../src/index';

async function main(): Promise<void> {
  process.exitCode = await runWorkspaceHostRemoteInitializerCli(
    {
      argv: process.argv.slice(2),
      stdin: process.stdin,
      writeStdout: (text) => process.stdout.write(text),
      writeStderr: (text) => process.stderr.write(text),
    },
    createProductionWorkspaceHostRemoteInitializerDeps(),
  );
}

void main().catch((error: unknown) => {
  // A throw out of main means the wiring itself failed (a dependency could not be constructed),
  // not that a step failed — the CLI already converts step failures to exit 1 with a diagnostic.
  // Reporting it on stderr keeps stdout carrying the protocol and nothing else.
  process.stderr.write(
    `${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n`,
  );
  process.exitCode = 1;
});
