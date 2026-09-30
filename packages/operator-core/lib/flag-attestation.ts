/**
 * Process-native feature-flag attestation.
 *
 * The value comes from @papercusp/flags/server's real resolver, not a parallel
 * reconstruction from source/default files. The process descriptor is kept
 * beside it so a federated caller can distinguish two services that loaded
 * different code or still hold different override-cache generations.
 */
import { ALL_FLAG_KEYS, type FlagKey } from '@papercusp/flags';
import { getFlagAttestation, type FlagAttestation } from '@papercusp/flags/server';
import { getServingHostIdentity } from './serving-host-identity';

export const OPERATOR_FLAG_ATTEST_PATH = '/api/internal/flags-attest';
export const GATEWAY_FLAG_ATTEST_PATH = '/internal/flags-attest';

export interface FlagAttestationProcess {
  role: string;
  label: string;
  port: number | null;
  pid: number;
  processId: string | null;
  buildSha: string | null;
}

export interface ProcessFlagAttestation extends FlagAttestation {
  ok: true;
  process: FlagAttestationProcess;
}

export function isKnownFlagKey(key: string): key is FlagKey {
  return (ALL_FLAG_KEYS as readonly string[]).includes(key);
}

export function assertKnownFlagKey(key: string): asserts key is FlagKey {
  if (!isKnownFlagKey(key)) {
    throw new Error(
      `Unknown flag key "${key}" — not in this process's live flag registry. ` +
        'Use flags:list to discover the current keys.',
    );
  }
}

export async function buildProcessFlagAttestation(
  key: FlagKey,
  distinctId: string,
  processDescriptor: {
    role: string;
    label: string;
    port?: number | null;
    pid?: number;
  },
): Promise<ProcessFlagAttestation> {
  const identity = getServingHostIdentity();
  const attestation = await getFlagAttestation(key, distinctId);
  return {
    ok: true,
    ...attestation,
    process: {
      role: processDescriptor.role,
      label: processDescriptor.label,
      port: processDescriptor.port ?? null,
      pid: processDescriptor.pid ?? process.pid,
      processId: identity.processId,
      buildSha: identity.buildSha,
    },
  };
}
