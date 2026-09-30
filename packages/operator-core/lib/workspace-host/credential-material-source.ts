/**
 * Where credential MATERIAL comes from on the controller (P-046 / WI-40474, plan decision D-216).
 *
 * D-215 built the delivery mechanism and deliberately left open which identities a workspace host
 * authenticates as. That left a concrete gap the moment delivery was wired into the resolver: the
 * controller could deliver material and had nowhere to get it. This module is the answer to WHERE,
 * and it is deliberately silent on WHICH — the identity behind a reference is a value written into
 * a store, not a branch in this file, which is what keeps D-215's question changeable without code.
 *
 * PROVIDER-NEUTRAL ON PURPOSE. The seam lives here rather than beside the GCP delivery sender
 * because nothing about "resolve a reference to bytes" is GCP-shaped: an AWS or Azure adapter will
 * need the same answer, and a seam defined inside one provider's file is a seam the next provider
 * has to either import awkwardly or redefine.
 *
 * WHY THE OPERATOR CREDENTIAL STORE AND NOT A FILE OR AN ENV VAR (D-216 point 1). The repo's
 * storage policy is that a secret never goes into a tree file, and
 * `harness_shared.operator_integration_credentials` (migration 526) is the surface that already
 * exists for exactly this: PG-backed, pgcrypto-encrypted at rest, one row per workspace, an opaque
 * name→value map that needs no migration per key, and explicitly outside the zero publication so
 * values are never broadcast. Process env would be worse in a way that matters here specifically —
 * the controller spawns the host program over SSH, and an env var is inherited by children.
 */
import {
  WORKSPACE_HOST_CREDENTIAL_FAMILY_SPECS,
  WorkspaceHostCredentialMaterial,
  parseWorkspaceHostCredentialReference,
  workspaceHostCredentialReferenceDigest,
  type WorkspaceHostCredentialChannel,
  type WorkspaceHostCredentialFamily,
} from '@papercusp/deployment-driver';

import { readIntegrationKey } from '../integration-credentials';

/**
 * One binding's need for material, as the controller sees it.
 *
 * `family` is DERIVED from `credentialRef` by the caller, exactly as the delivery request derives
 * it, and for the same reason: two fields naming one fact can disagree, and the disagreement gets
 * settled silently in favour of whichever field the reader happened to consult.
 */
export interface WorkspaceHostCredentialMaterialRequest {
  readonly channel: WorkspaceHostCredentialChannel;
  readonly credentialRef: string;
  readonly family: WorkspaceHostCredentialFamily;
  readonly generation: number;
}

/**
 * The controller-side seam that turns a public credential REFERENCE into the bytes it names.
 *
 * The initialization contract has always said material arrives "out of band" and that the resolver
 * named by the typed reference produces it; this is that resolver's interface, and it is
 * deliberately the ONLY thing in the controller allowed to hold material.
 */
export interface WorkspaceHostCredentialMaterialSource {
  resolve(request: WorkspaceHostCredentialMaterialRequest): Promise<WorkspaceHostCredentialMaterial>;
}

/**
 * Raised when a binding needs delivered material and the controller has no source for it.
 *
 * This refuses on the CONTROLLER, before the tunnel opens, rather than letting the host answer
 * `delivered material for family 'X' is not present on the host`. Those are the same underlying
 * gap, but the host's version blames the host — it is the message that made this defect look like
 * a broken VM for six holders of this item (D-215's "Measured" section). Naming the missing
 * controller configuration is the whole difference.
 */
export class WorkspaceHostCredentialMaterialUnavailableError extends Error {
  readonly channel: WorkspaceHostCredentialChannel;
  readonly family: WorkspaceHostCredentialFamily;
  readonly generation: number;

  constructor(request: WorkspaceHostCredentialMaterialRequest, detail: string) {
    super(
      `Cannot deliver channel '${request.channel}' (family '${request.family}', generation ` +
        `${request.generation}): ${detail} This family requires material to be written to the ` +
        `host before bind, so binding it would otherwise fail on the host with a message that ` +
        `blames the host rather than this configuration.`,
    );
    this.name = 'WorkspaceHostCredentialMaterialUnavailableError';
    this.channel = request.channel;
    this.family = request.family;
    this.generation = request.generation;
  }
}

/**
 * The default source: none. Refuses every request, naming the gap.
 *
 * A source that returned empty bytes would be worse than this error in the one way that matters —
 * `bind()` only checks that the path EXISTS, so empty material would make every binding step pass
 * and the canary go green against credentials that authenticate nothing.
 */
export const UNCONFIGURED_WORKSPACE_HOST_CREDENTIAL_MATERIAL_SOURCE: WorkspaceHostCredentialMaterialSource =
  {
    resolve(request: WorkspaceHostCredentialMaterialRequest): Promise<WorkspaceHostCredentialMaterial> {
      return Promise.reject(
        new WorkspaceHostCredentialMaterialUnavailableError(
          request,
          'no credential material source is configured on this controller.',
        ),
      );
    },
  };

/** The prefix every derived key carries, so the store's other keys are never mistaken for one. */
export const WORKSPACE_HOST_MATERIAL_KEY_PREFIX = 'WORKSPACE_HOST_MATERIAL';

function screamingSnake(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

/**
 * Derive the store key for one (reference, generation) — D-216 points 2 and 3.
 *
 * TWO HALVES, EACH DOING A DIFFERENT JOB. The readable half (family + segments + generation) is
 * what makes a stored key greppable and writable by a person. The digest half is what makes the
 * mapping INJECTIVE: `screamingSnake` folds `-`, `.` and `/` all onto `_`, so on its own it could
 * map two genuinely different subjects (`my-repo` and `my.repo`) onto one key — and the failure
 * that produces is delivering one repository's credential for another, which authenticates
 * successfully and is therefore invisible. The digest is taken over the REFERENCE, which is public
 * metadata; `workspaceHostCredentialReferenceDigest` exists precisely because digesting the
 * reference is safe where digesting the material would be an oracle.
 *
 * The GENERATION is in the key because rotation requires a strictly increasing generation carrying
 * DIFFERENT material. A generation-less key would make the pre- and post-rotation values one row,
 * so performing a rotation would mean destroying the generation the host may still be asked to
 * bind.
 */
export function workspaceHostCredentialMaterialKey(
  credentialRef: string,
  channel: WorkspaceHostCredentialChannel,
  generation: number,
): string {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error(`credential generation must be a positive safe integer, got ${generation}`);
  }
  const reference = parseWorkspaceHostCredentialReference(credentialRef, channel);
  const readable = [screamingSnake(reference.family), ...reference.segments.map(screamingSnake)].join('__');
  const digest = workspaceHostCredentialReferenceDigest(credentialRef).slice(0, 16).toUpperCase();
  return `${WORKSPACE_HOST_MATERIAL_KEY_PREFIX}__${readable}__G${generation}__${digest}`;
}

/** Reads one named secret from the operator's encrypted store. Seam so tests do no real I/O. */
export type WorkspaceHostCredentialMaterialKeyReader = (name: string) => Promise<string | undefined>;

/**
 * The production source: the operator's encrypted credential store, keyed by the derivation above.
 *
 * NO FALLBACK, DELIBERATELY (D-216 point 5). A missing key refuses and names itself, so the
 * operator is told exactly which value to write. Falling back to an env var, a file, or empty bytes
 * would each turn a configuration gap into a canary that passes: `bind()` observes only that the
 * material path exists, so ANY bytes satisfy it — which is why "some bytes" is the one answer this
 * function must never give.
 */
export function createOperatorWorkspaceHostCredentialMaterialSource(
  readKey: WorkspaceHostCredentialMaterialKeyReader = readIntegrationKey,
): WorkspaceHostCredentialMaterialSource {
  return {
    async resolve(
      request: WorkspaceHostCredentialMaterialRequest,
    ): Promise<WorkspaceHostCredentialMaterial> {
      // An ambient family must never reach a store lookup: it has no on-host artifact at all, and
      // a key existing for one would be a standing invitation to deliver a file that must not
      // exist (D-215 point 4). The delivering adapter already skips these; this is the second half
      // of that guard, on the side that would have to hold the value.
      if (!WORKSPACE_HOST_CREDENTIAL_FAMILY_SPECS[request.family].requiresDeliveredMaterial) {
        throw new WorkspaceHostCredentialMaterialUnavailableError(
          request,
          'this family is answered ambiently by the host environment and must never have stored material.',
        );
      }
      const key = workspaceHostCredentialMaterialKey(
        request.credentialRef,
        request.channel,
        request.generation,
      );
      const value = await readKey(key);
      if (value === undefined || value.length === 0) {
        throw new WorkspaceHostCredentialMaterialUnavailableError(
          request,
          `no material is stored under '${key}' in operator_integration_credentials. Write it ` +
            `there (setup:save_integration_key) — never into the tree, the environment, or the ` +
            `initialization request.`,
        );
      }
      return new WorkspaceHostCredentialMaterial(Buffer.from(value, 'utf8'));
    },
  };
}
