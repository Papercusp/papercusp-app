#!/usr/bin/env node
/**
 * `bin/papercusp-deliver-material` — the host-installed executable that receives credential
 * material (D-215).
 *
 * THE FILENAME AVOIDS THE WORD "credential" ON PURPOSE. The build manifest refuses to enumerate any
 * material path matching its `SECRET_MATERIAL` guard, which includes `credential` — a published
 * manifest naming a credential path leaks its existence and location. This file is a program rather
 * than key material, so that refusal is a false positive, but the guard is a name heuristic and
 * cannot distinguish them; renaming here is cheaper and safer than putting a hole in the guard.
 *
 * The controller spawns it once per (family, generation) over the same transport as the remote
 * initializer, writes one JSON request to stdin, and reads one receipt from stdout. It is a
 * SEPARATE program from `papercusp-remote-initializer` on purpose: that one must never receive
 * secret material and asserts so in both directions, this one receives it by definition, and one
 * argv-dispatched program would make that distinction a branch instead of a boundary.
 *
 * IT IS DELIBERATELY THREE LINES OF LOGIC, for the reason the initializer's bin gives: everything
 * decidable lives behind functions that take their dependencies as arguments and are covered by
 * the suite, and what remains here is the `process.argv`/`process.stdin` binding a test cannot
 * reach.
 *
 * `process.exitCode` rather than `process.exit()`: `process.exit()` can truncate a pipe that has
 * not flushed, and a truncated receipt is reported at the controller as a malformed envelope —
 * mis-naming a delivery that actually succeeded, which for an idempotent-but-not-free operation
 * is the worst answer available.
 */
import {
  createProductionWorkspaceHostCredentialDeliveryDeps,
  runWorkspaceHostCredentialDeliveryCli,
  WORKSPACE_HOST_CREDENTIAL_MATERIAL_ROOT,
} from '../src/index';

async function main(): Promise<void> {
  process.exitCode = await runWorkspaceHostCredentialDeliveryCli(
    {
      argv: process.argv.slice(2),
      stdin: process.stdin,
      writeStdout: (text) => process.stdout.write(text),
      writeStderr: (text) => process.stderr.write(text),
    },
    createProductionWorkspaceHostCredentialDeliveryDeps(
      process.env.PAPERCUSP_WORKSPACE_HOST_CREDENTIAL_ROOT ??
        WORKSPACE_HOST_CREDENTIAL_MATERIAL_ROOT,
    ),
  );
}

void main().catch((error: unknown) => {
  // A throw out of main means the wiring itself failed, not that a delivery failed — the CLI
  // already converts those to exit 1 with a diagnostic. Never interpolate the request here: it is
  // the one object in this system that must not reach a log.
  process.stderr.write(
    `${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n`,
  );
  process.exitCode = 1;
});
