/**
 * The PRODUCING half of the workspace-host agent credential pipeline (WI-10001686).
 *
 * WHY THIS FILE EXISTS. Every CONSUMER of agent credential material was built and is enforced:
 * `verifyWorkspaceHostAgentCredentialAdmission` authenticates a stored generation,
 * `verify-initialization` refuses to complete unless each of `WORKSPACE_HOST_CANARY_AGENTS` is
 * ready, and `createOperatorWorkspaceHostCredentialMaterialSource` reads the material by a derived
 * key. Nothing PRODUCED it. Measured 2026-09-16 by call-site census:
 * `encodeWorkspaceHostAgentHomeBundle` had callers only in tests and the barrel re-export, and
 * `workspaceHostCredentialMaterialKey` was called only by the reader. The consequence was not a
 * degraded path but an impossible one — `claude` and `codex` could never be ready on ANY host, so
 * initialization always died at its last step. (`omp` passed throughout, because it is
 * credential-free by contract; that asymmetry is what identifies the defect.)
 *
 * WHY THE GAP SURVIVED. The reader's own unavailable-material error names the intended remedy —
 * "Write it there (setup:save_integration_key)" — and that instruction cannot be followed by hand:
 * the key embeds `workspaceHostCredentialReferenceDigest(credentialRef)`, so the NAME the reader
 * demands is only computable by running code. An operator following the error message verbatim
 * writes a key nothing will ever read. Deriving that name is therefore the load-bearing thing this
 * module provides, and the reason a "just save the secret manually" answer was never actually
 * available.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO.
 *
 * It does not READ credentials from anywhere. `files` is supplied by the caller, so the question
 * of WHOSE credentials a host receives stays at an explicit, auditable call site instead of being
 * silently answered by whatever happens to sit in the ambient HOME of whichever process runs this.
 * That question has a real blast radius — copying a live personal credential to a host can rotate
 * a refresh token out from under the machine it was copied from — and it is not one a storage
 * helper should decide by default.
 *
 * It also takes no secret through a tool argument. Tool invocations are persisted
 * (`tool_invocations.args_json`), so a verb accepting raw credential bytes would durably record
 * them; any surface built over this module must pass a SOURCE SELECTOR and resolve the bytes
 * server-side.
 *
 * BOTH MEMBERS ARE NOW PROJECTED — the asymmetry this comment used to warn about is CLOSED.
 * `encodeWorkspaceHostAgentHomeBundle` neutralizes the codex `refresh_token` (D-311) and, since
 * WI-10001691, the claude `claudeAiOauth.refreshToken` as well: `projectWorkspaceHostClaudeAccessToken`
 * runs the same shape-based refresh-token and api-key walkers over the claude member, writes
 * `refreshToken: ""` (present-and-empty — the value `claude -p` was MEASURED to authenticate with,
 * where a deleted key fails), and `assertWorkspaceHostClaudeProjectionCliReadable` REFUSES at
 * admission any generation that predates the projection. So each half now carries a self-expiring
 * access token (~6h) and neither can mint new ones.
 *
 * ⚠ Do NOT re-read that as "forwarding a live personal credential is free". What the projection
 * bounds is DURATION and MINTING, not exposure: a working access token for that account still
 * lands on the host for its lifetime, which is exactly the blast radius the paragraph above is
 * about. A purpose-minted credential remains preferable — the reason is now the account the token
 * belongs to, not a missing projection.
 */
import {
  assertWorkspaceHostAgentHomeBundleAdmissionEligible,
  encodeWorkspaceHostAgentHomeBundle,
  parseWorkspaceHostAgentHomeBundle,
  type WorkspaceHostAgentHomeBundleFiles,
} from '@papercusp/deployment-driver';

import { workspaceHostCredentialMaterialKey } from './credential-material-source';

/** Raised when material would be stored that the admission gate could never accept. */
export class WorkspaceHostAgentCredentialMaterialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceHostAgentCredentialMaterialError';
  }
}

/**
 * Writes one named secret into the operator's encrypted store. A seam for the same reason the
 * reader has one: tests do no real I/O, and the production binding is chosen at the call site.
 */
export type WorkspaceHostCredentialMaterialKeyWriter = (
  name: string,
  value: string,
) => Promise<void>;

export interface StoreWorkspaceHostAgentCredentialMaterialInput {
  /** `pc-agent-forward://<hostId>/<agentSet>` or `pc-agent-sealed://…` — exactly 2 segments. */
  readonly credentialRef: string;
  /** Strictly increasing per rotation; a generation carries DIFFERENT material by contract. */
  readonly generation: number;
  readonly files: WorkspaceHostAgentHomeBundleFiles;
}

export interface StoreWorkspaceHostAgentCredentialMaterialResult {
  /** The exact `operator_integration_credentials` key the reader will look under. */
  readonly key: string;
  readonly generation: number;
  /** Byte length of the stored material — a size receipt that reveals no content. */
  readonly materialBytes: number;
}

/**
 * Encode and VALIDATE agent-home material, returning the exact bytes the reader expects.
 *
 * The validation is the point. `verifyWorkspaceHostAgentCredentialAdmission` parses the material
 * and asserts admission eligibility on the HOST, at bind time — which is after a VM exists and is
 * billing. Running the identical parse + assert here means material that could never be admitted
 * is refused at the moment it is written, when rejecting it costs nothing. The failure moves from
 * "a provisioned host fails its last initialization step" to "a store call returned an error".
 *
 * Encoding is UTF-8 JSON and not base64 because that is what the reader does with the stored
 * string (`Buffer.from(value, 'utf8')` in `createOperatorWorkspaceHostCredentialMaterialSource`).
 * A base64 round-trip here would store bytes that parse as garbage there, and — since nothing
 * validates until a host binds — would surface as an initialization failure on a paid VM rather
 * than as an error at the write.
 */
export function buildWorkspaceHostAgentCredentialMaterial(
  files: WorkspaceHostAgentHomeBundleFiles,
): string {
  let encoded: Buffer;
  try {
    encoded = encodeWorkspaceHostAgentHomeBundle(files);
  } catch (error) {
    // The thrown error is reduced to its message, which the encoder authors to name the offending
    // FIELD without echoing a decoded byte. Re-wrapping keeps that property at this boundary.
    throw new WorkspaceHostAgentCredentialMaterialError(
      `agent-home material could not be encoded: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }

  // Parse back and run the admission gate the host will run. This is deliberately not trusting
  // the encoder's own output: the two functions enforce different contracts (the encoder checks
  // field SHAPE, the gate checks that the bundle is an admissible CONTRACT VERSION and that the
  // codex projection is CLI-readable), and only the pair together predicts a successful bind.
  try {
    const bundle = parseWorkspaceHostAgentHomeBundle(encoded);
    assertWorkspaceHostAgentHomeBundleAdmissionEligible(bundle);
  } catch (error) {
    throw new WorkspaceHostAgentCredentialMaterialError(
      `agent-home material would be refused by the admission gate at bind time: ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
    );
  }

  return encoded.toString('utf8');
}

/**
 * Derive the reader's key for an agent credential reference + generation.
 *
 * Exposed separately because the derivation is the part no operator can perform by hand, and
 * because a caller frequently needs the NAME without holding any material — to check whether a
 * generation is already stored, or to report which key a host will look for.
 */
export function workspaceHostAgentCredentialMaterialKey(
  credentialRef: string,
  generation: number,
): string {
  // `workspaceHostCredentialMaterialKey` validates the generation and parses the reference for the
  // `agent` channel, so a git/cloud reference passed here is refused rather than silently keyed
  // into the agent namespace.
  return workspaceHostCredentialMaterialKey(credentialRef, 'agent', generation);
}

/**
 * Validate, encode and STORE one agent credential generation under the key the reader derives.
 *
 * Nothing about the stored value is returned or logged — the receipt carries the key, the
 * generation, and a byte count, all of which are public metadata.
 */
export async function storeWorkspaceHostAgentCredentialMaterial(
  input: StoreWorkspaceHostAgentCredentialMaterialInput,
  writeKey: WorkspaceHostCredentialMaterialKeyWriter,
): Promise<StoreWorkspaceHostAgentCredentialMaterialResult> {
  // Derive FIRST. The derivation validates both the reference and the generation, so a malformed
  // request fails before any material is encoded and before the writer is reached.
  const key = workspaceHostAgentCredentialMaterialKey(input.credentialRef, input.generation);
  const material = buildWorkspaceHostAgentCredentialMaterial(input.files);

  await writeKey(key, material);

  return {
    key,
    generation: input.generation,
    materialBytes: Buffer.byteLength(material, 'utf8'),
  };
}
