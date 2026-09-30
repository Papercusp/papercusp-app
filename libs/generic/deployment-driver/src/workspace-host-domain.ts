import type { WorkspaceHostBootstrapRelease } from "./workspace-host-bootstrap";

/** Stable customer workspace/data identity. A replacement host must retain this value. */
export interface WorkspaceHostIdentity {
  workspaceId: string;
  hostId: string;
  /** Increases only when a new Host replaces the prior Host for the same Workspace. */
  hostGeneration: number;
}

/** The authenticated, non-secret identity proved by provider connection validation. */
export interface WorkspaceHostAuthenticatedConnection {
  connectionId: string;
  providerTarget: string;
  authenticatedIdentity: string;
}

/** URL/key-free persisted projection of the signed runtime installed on a Host. */
export interface WorkspaceHostRuntimeRelease {
  version: string;
  bundleSha256: string;
  signingKeySha256: string;
  protocolVersion: string;
  schemaVersion: string;
}

/** Controller identity plus a monotonic fencing token. */
export interface WorkspaceHostControllerAuthority {
  controllerId: string;
  fence: number;
}

export interface WorkspaceHostDomainState extends WorkspaceHostIdentity {
  connectionId: string;
  desiredRevision: number;
  observedRevision: number;
  runtimeRelease?: WorkspaceHostRuntimeRelease;
  controllerAuthority?: WorkspaceHostControllerAuthority;
}

export function workspaceHostRuntimeRelease(
  release: WorkspaceHostBootstrapRelease,
  protocolVersion: string,
  schemaVersion: string,
): WorkspaceHostRuntimeRelease {
  return {
    version: nonEmpty(release.version, "runtime release version"),
    bundleSha256: sha256(release.bundleSha256, "runtime bundleSha256"),
    signingKeySha256: sha256(
      release.signingKeySha256,
      "runtime signingKeySha256",
    ),
    protocolVersion: nonEmpty(protocolVersion, "runtime protocolVersion"),
    schemaVersion: nonEmpty(schemaVersion, "runtime schemaVersion"),
  };
}

export function assertWorkspaceHostDomainState(
  state: WorkspaceHostDomainState,
): void {
  nonEmpty(state.workspaceId, "workspaceId");
  nonEmpty(state.hostId, "hostId");
  nonEmpty(state.connectionId, "connectionId");
  positive(state.hostGeneration, "hostGeneration");
  positive(state.desiredRevision, "desiredRevision");
  nonNegative(state.observedRevision, "observedRevision");
  if (state.observedRevision > state.desiredRevision) {
    throw new Error("observedRevision must not exceed desiredRevision");
  }
  if (state.controllerAuthority) {
    nonEmpty(state.controllerAuthority.controllerId, "controllerId");
    positive(state.controllerAuthority.fence, "controller fence");
  }
  if (state.runtimeRelease) {
    workspaceHostRuntimeRelease(
      {
        ...state.runtimeRelease,
        bundleUrl: "https://runtime.invalid/bundle",
        signatureUrl: "https://runtime.invalid/signature",
        signingPublicKey:
          "persisted projection intentionally omits key material",
      },
      state.runtimeRelease.protocolVersion,
      state.runtimeRelease.schemaVersion,
    );
  }
}

/**
 * Prove that replacing a VM creates a new Host while retaining Workspace/data identity.
 * This is deliberately independent of placement: v1 may still choose one VM per workspace.
 */
export function assertWorkspaceHostReplacement(
  previous: WorkspaceHostDomainState,
  replacement: WorkspaceHostDomainState,
): void {
  assertWorkspaceHostDomainState(previous);
  assertWorkspaceHostDomainState(replacement);
  if (replacement.workspaceId !== previous.workspaceId) {
    throw new Error("replacement Host must preserve Workspace/data identity");
  }
  if (replacement.hostId === previous.hostId) {
    throw new Error("replacement Host must have a new hostId");
  }
  if (replacement.hostGeneration <= previous.hostGeneration) {
    throw new Error("replacement Host must increase hostGeneration");
  }
  if (replacement.desiredRevision < previous.desiredRevision) {
    throw new Error("replacement Host must not regress desiredRevision");
  }
}

export const WORKSPACE_HOST_VENDOR_CONTROL_METADATA_FIELDS = [
  "workspaceId",
  "hostId",
  "connectionId",
  "operationId",
  "providerTarget",
  "desiredRevision",
  "observedRevision",
  "hostGeneration",
  "runtimeVersion",
  "runtimeBundleSha256",
  "runtimeSigningKeySha256",
  "runtimeProtocolVersion",
  "runtimeSchemaVersion",
  "controllerId",
  "controllerFence",
  "lifecycleState",
  "region",
  "size",
] as const;

export type WorkspaceHostVendorControlMetadataField =
  (typeof WORKSPACE_HOST_VENDOR_CONTROL_METADATA_FIELDS)[number];
export type WorkspaceHostVendorControlScalar = string | number | boolean | null;
export type WorkspaceHostVendorControlMetadata = Partial<
  Record<
    WorkspaceHostVendorControlMetadataField,
    WorkspaceHostVendorControlScalar
  >
>;

const VENDOR_CONTROL_FIELDS = new Set<string>(
  WORKSPACE_HOST_VENDOR_CONTROL_METADATA_FIELDS,
);

/**
 * Admit only the closed scalar metadata set into a vendor control plane.
 * Unknown keys fail closed: a new prompt/transcript/source/diagnostic field cannot leak merely
 * because a caller spread a larger customer-local object into this boundary.
 */
export function projectWorkspaceHostVendorControlMetadata(
  input: Readonly<Record<string, unknown>>,
): WorkspaceHostVendorControlMetadata {
  const projected: Record<string, WorkspaceHostVendorControlScalar> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!VENDOR_CONTROL_FIELDS.has(key)) {
      throw new Error(
        `workspace-host vendor metadata field '${key}' is not allowlisted`,
      );
    }
    if (
      value !== null &&
      !["string", "number", "boolean"].includes(typeof value)
    ) {
      throw new Error(
        `workspace-host vendor metadata field '${key}' must be scalar`,
      );
    }
    projected[key] = value as WorkspaceHostVendorControlScalar;
  }
  return projected as WorkspaceHostVendorControlMetadata;
}

function nonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} must not be empty`);
  return trimmed;
}

function positive(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${field} must be a positive safe integer`);
  return value;
}

function nonNegative(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${field} must be a non-negative safe integer`);
  return value;
}

function sha256(value: string, field: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized))
    throw new Error(`${field} must be a SHA-256 digest`);
  return normalized;
}
