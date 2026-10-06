/**
 * The controller side of desktop-connector enrollment over GCP IAP (D-403).
 *
 * The controller hands the host ONE single-use enrollment ticket; the host's root program redeems
 * it at the control plane and keeps the bearer it receives. So the controller never holds the
 * bearer, and the only secret on this wire is a ticket that expires in minutes and dies on first
 * use.
 *
 * Same transport discipline as credential delivery (`gcp-iap-credential-delivery.ts`): the shared
 * `buildGcpIapSshInvocation` owns the SSH options, the remote argv is fixed, and the ticket travels
 * on stdin because `/proc/<pid>/cmdline` is world-readable. The receipt is rebuilt from named
 * fields, so nothing else a host prints can reach a durable record.
 */
import {
  WORKSPACE_HOST_CONNECTOR_ENROLLMENT_ARGV,
  WORKSPACE_HOST_CONNECTOR_ENROLLMENT_CONDUIT,
  WORKSPACE_HOST_CONNECTOR_ENROLLMENT_PROTOCOL_VERSION,
} from '@papercusp/deployment-driver';

import {
  NodeGcpIapWorkspaceHostInitializationCommandRunner,
  buildWorkspaceHostSshInvocation,
  type GcpIapWorkspaceHostInitializationCommand,
  type GcpIapWorkspaceHostInitializationCommandRunner,
  type WorkspaceHostSshTransportProfile,
} from './gcp-iap-initialization-operations';

const ENROLLMENT_TICKET = /^ht_[A-Za-z0-9_-]{43}$/;

export interface GcpIapWorkspaceHostConnectorEnrollmentReceipt {
  readonly protocolVersion: typeof WORKSPACE_HOST_CONNECTOR_ENROLLMENT_PROTOCOL_VERSION;
  /** The connector generation the host registered; must equal the one the controller enrolled. */
  readonly generation: number;
  readonly registered: true;
}

/**
 * Exit codes the host program uses, named so a failed step says what happened rather than a
 * number: 64 argv refused, 65 ticket refused locally, 69 control plane unreachable, 75 service
 * restart failed, 76 no credential in the answer, 77 the control plane refused the ticket.
 */
export class GcpIapWorkspaceHostConnectorEnrollmentError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.name = 'GcpIapWorkspaceHostConnectorEnrollmentError';
    this.exitCode = exitCode;
  }
}

export function buildGcpIapWorkspaceHostConnectorEnrollmentCommand(
  profile: WorkspaceHostSshTransportProfile,
  ticket: string,
): GcpIapWorkspaceHostInitializationCommand {
  if (!ENROLLMENT_TICKET.test(ticket)) {
    throw new GcpIapWorkspaceHostConnectorEnrollmentError('connector enrollment ticket is malformed', 1);
  }
  return buildWorkspaceHostSshInvocation(profile, {
    entrypoint: WORKSPACE_HOST_CONNECTOR_ENROLLMENT_CONDUIT,
    entrypointLabel: 'Connector enrollment conduit',
    args: [...WORKSPACE_HOST_CONNECTOR_ENROLLMENT_ARGV],
    stdin: `${ticket}\n`,
  });
}

export function parseGcpIapWorkspaceHostConnectorEnrollmentReceipt(
  stdout: string,
): GcpIapWorkspaceHostConnectorEnrollmentReceipt {
  const line = stdout.trim().split('\n').at(-1) ?? '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new GcpIapWorkspaceHostConnectorEnrollmentError('connector enrollment receipt is not JSON', 1);
  }
  const record = (parsed ?? {}) as Record<string, unknown>;
  if (
    record.protocolVersion !== WORKSPACE_HOST_CONNECTOR_ENROLLMENT_PROTOCOL_VERSION ||
    record.registered !== true ||
    !Number.isSafeInteger(record.generation) ||
    (record.generation as number) < 1
  ) {
    throw new GcpIapWorkspaceHostConnectorEnrollmentError('connector enrollment receipt has an unexpected shape', 1);
  }
  return {
    protocolVersion: WORKSPACE_HOST_CONNECTOR_ENROLLMENT_PROTOCOL_VERSION,
    generation: record.generation as number,
    registered: true,
  };
}

export async function enrollGcpIapWorkspaceHostConnector(
  profile: WorkspaceHostSshTransportProfile,
  ticket: string,
  runner: GcpIapWorkspaceHostInitializationCommandRunner = new NodeGcpIapWorkspaceHostInitializationCommandRunner(),
): Promise<GcpIapWorkspaceHostConnectorEnrollmentReceipt> {
  const result = await runner.run(buildGcpIapWorkspaceHostConnectorEnrollmentCommand(profile, ticket));
  if (result.exitCode !== 0) {
    throw new GcpIapWorkspaceHostConnectorEnrollmentError(
      `connector enrollment failed with exit ${result.exitCode}: ${result.stderr.trim() || '(no diagnostic output)'}`,
      result.exitCode,
    );
  }
  return parseGcpIapWorkspaceHostConnectorEnrollmentReceipt(result.stdout);
}
