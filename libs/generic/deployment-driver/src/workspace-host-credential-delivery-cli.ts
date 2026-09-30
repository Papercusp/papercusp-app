/**
 * The executable wrapper around the credential-delivery operation (D-215).
 *
 * A SEPARATE entrypoint from `workspace-host-remote-initializer-cli`, for the same reason the
 * protocol is separate: these two programs have opposite relationships with secret material. The
 * initializer must never receive any and asserts so on both directions; this one receives it by
 * definition. Sharing one entrypoint would mean one argv-dispatched program where that rule
 * depends on a branch, and the safest version of that branch is still a branch.
 *
 * MATERIAL ARRIVES ON STDIN, NEVER IN ARGV. Anything in argv is world-readable on the host for the
 * lifetime of the process — `/proc/<pid>/cmdline`, `ps`, the audit log, and any transport that
 * echoes the command it ran. Stdin is a private pipe between the controller's transport and this
 * process, so the bytes never exist anywhere a second process can read them.
 *
 * STDOUT CARRIES THE RECEIPT AND NOTHING ELSE. Diagnostics go to stderr, and the error path below
 * deliberately writes only `name: message` — never the request — because the request is the one
 * object in this system that must not be logged.
 */
import {
  assertWorkspaceHostCredentialDeliveryArgv,
  handleWorkspaceHostCredentialDeliveryPayload,
  NodeWorkspaceHostCredentialDeliveryFilesystem,
  WORKSPACE_HOST_CREDENTIAL_MATERIAL_MAX_BYTES,
  type WorkspaceHostCredentialDeliveryDeps,
} from './workspace-host-credential-delivery';

export interface WorkspaceHostCredentialDeliveryCliIo {
  readonly argv: readonly string[];
  readonly stdin: AsyncIterable<Buffer | string>;
  readonly writeStdout: (text: string) => void;
  readonly writeStderr: (text: string) => void;
}

/**
 * Read the whole request, bounded.
 *
 * The bound is the material cap plus room for the envelope and base64's 4/3 expansion. A separate
 * reader from the initializer's `readAllStdin` because the two limits answer to different things:
 * that one bounds a metadata step, this one bounds a credential.
 */
export async function readDeliveryStdin(
  stream: AsyncIterable<Buffer | string>,
  maxBytes = Math.ceil(WORKSPACE_HOST_CREDENTIAL_MATERIAL_MAX_BYTES * 1.4) + 8 * 1024,
): Promise<string> {
  let text = '';
  let bytes = 0;
  for await (const chunk of stream) {
    const part = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    bytes += Buffer.byteLength(part);
    if (bytes > maxBytes) throw new Error('credential delivery request exceeded the input limit');
    text += part;
  }
  return text;
}

export function createProductionWorkspaceHostCredentialDeliveryDeps(
  materialRoot: string,
  now?: () => Date,
): WorkspaceHostCredentialDeliveryDeps {
  return {
    filesystem: new NodeWorkspaceHostCredentialDeliveryFilesystem(),
    materialRoot,
    ...(now ? { now } : {}),
  };
}

/**
 * Run one delivery cycle. Returns the process exit code.
 *
 * Failure is a non-zero exit plus a stderr diagnostic, matching the initializer's contract so the
 * controller's transport handling is identical for both programs.
 */
export async function runWorkspaceHostCredentialDeliveryCli(
  io: WorkspaceHostCredentialDeliveryCliIo,
  deps: WorkspaceHostCredentialDeliveryDeps,
): Promise<number> {
  try {
    assertWorkspaceHostCredentialDeliveryArgv(io.argv);
    const payload = await readDeliveryStdin(io.stdin);
    const receipt = await handleWorkspaceHostCredentialDeliveryPayload(payload, deps);
    io.writeStdout(receipt);
    return 0;
  } catch (error) {
    io.writeStderr(
      `${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n`,
    );
    return 1;
  }
}
