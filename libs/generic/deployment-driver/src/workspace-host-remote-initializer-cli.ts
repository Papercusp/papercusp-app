/**
 * The executable wrapper around the remote initializer's protocol engine.
 *
 * This is the program `PAPERCUSP_WORKSPACE_HOST_REMOTE_ENTRYPOINT` points at. The controller
 * spawns it once per step over an IAP-tunnelled OpenSSH invocation, writes one JSON request to
 * stdin, and reads one JSON response from stdout.
 *
 * EVERYTHING IS A PARAMETER so the whole cycle is testable without spawning a process: argv, the
 * streams, and the dependencies all arrive as arguments. The real bin file is then a three-line
 * wiring of `process.argv`/`process.stdin` into this function, which is small enough to be
 * obviously correct and is the only part a test cannot reach.
 *
 * STDOUT CARRIES THE PROTOCOL AND NOTHING ELSE. Diagnostics go to stderr, because a single stray
 * log line on stdout makes the response unparseable at the controller and is reported there as a
 * malformed response rather than as whatever actually went wrong.
 */
import {
  assertWorkspaceHostRemoteInitializerArgv,
  handleWorkspaceHostRemoteInitializerPayload,
  type WorkspaceHostRemoteInitializerDeps,
} from './workspace-host-remote-initializer';

/** Read a whole stream to a string, bounded. */
export async function readAllStdin(
  stream: AsyncIterable<Buffer | string>,
  maxBytes = 1024 * 1024,
): Promise<string> {
  let text = '';
  let bytes = 0;
  for await (const chunk of stream) {
    const part = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    bytes += Buffer.byteLength(part);
    if (bytes > maxBytes) throw new Error('initialization request exceeded the input limit');
    text += part;
  }
  return text;
}

export interface WorkspaceHostRemoteInitializerCliIo {
  readonly argv: readonly string[];
  readonly stdin: AsyncIterable<Buffer | string>;
  readonly writeStdout: (text: string) => void;
  readonly writeStderr: (text: string) => void;
}

/**
 * Run one request/response cycle. Returns the process exit code.
 *
 * A thrown error becomes exit 1 with a stderr diagnostic — the controller treats any non-zero
 * exit as a failed step, which is exactly the signal we want, and it never sees a partial or
 * contradictory envelope on stdout because stdout is written only on the success path.
 */
export async function runWorkspaceHostRemoteInitializerCli(
  io: WorkspaceHostRemoteInitializerCliIo,
  deps: WorkspaceHostRemoteInitializerDeps,
): Promise<number> {
  try {
    assertWorkspaceHostRemoteInitializerArgv(io.argv);
    const payload = await readAllStdin(io.stdin);
    const response = await handleWorkspaceHostRemoteInitializerPayload(payload, deps);
    io.writeStdout(response);
    return 0;
  } catch (error) {
    io.writeStderr(
      `${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n`,
    );
    return 1;
  }
}
