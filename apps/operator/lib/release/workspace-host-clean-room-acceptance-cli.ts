/**
 * Produce the workspace-host clean-room acceptance report that the release gate ratifies.
 *
 * This is the missing UPSTREAM half of the release pipeline. `gcp-image-family-release-cli`
 * consumes a request file whose header calls the gate evidence "already-verified" — but
 * nothing in the tree actually produced it, so `releaseGate.cleanRoomReport` could only ever
 * be hand-written. A hand-written report is an assertion, and the whole point of the gate is
 * to refuse assertions.
 *
 * This CLI boots a pristine stock Ubuntu instance, runs the release fixture's exact signed
 * bootstrap script on it, and emits the resulting report as JSON for splicing into that
 * request file.
 *
 * ORDERING (why this cannot boot the candidate image): the report this emits is consumed by
 * `evaluateWorkspaceHostReleaseGate`, whose verdict AUTHORIZES building the image. The image
 * therefore does not exist yet. The POST-build canary (papercusp-gcp-clean-room) is the other
 * half, and `gcp-image-family.ts:validateCleanBootProof` checks ITS attestation against the
 * one produced here.
 *
 * The report is assembled ONLY by `runWorkspaceHostCleanRoomAcceptance`, which double-builds
 * the fixture to prove determinism, parses the attestation out of the guest's real stdout,
 * and validates it against the fixture's own bootstrap input. This CLI never synthesizes an
 * attestation, and a failed run is emitted as a `passed: false` report rather than an error —
 * a rejection is evidence too, and discarding it would hide why the gate refused.
 */
import { readFile } from "node:fs/promises";

import {
  runWorkspaceHostCleanRoomAcceptance,
  type WorkspaceHostCleanRoomAcceptanceReport,
  type WorkspaceHostCleanRoomInstallSpec,
  type WorkspaceHostImageArtifact,
} from "@papercusp/deployment-driver";
import { isCliEntry } from "@papercusp/operator-core/lib/util/cli-entry";
import {
  GcpWorkspaceHostCleanRoomExecutor,
  type GcpCleanRoomPlacement,
} from "@papercusp/operator-core/lib/workspace-host/workspace-host-clean-room-executor";
import type { WorkspaceHostProviderConnection } from "@papercusp/deployment-driver";
import {
  composeAwsAmiReleaseAdapter,
  probeAwsAmiCredential,
  probeAwsAmiExecutables,
  type AwsAmiCredentialProbe,
  type AwsAmiExecutableProbe,
  type AwsAmiReleaseCompositionOptions,
} from "@papercusp/operator-core/lib/workspace-host/aws-ami-production";
import {
  AwsBootcCleanRoomExecutor,
  type AwsBootcCleanRoomPlacement,
} from "@papercusp/operator-core/lib/workspace-host/aws-bootc-clean-room-executor";
import { coldsnapCompositionOption } from "@papercusp/operator-core/lib/workspace-host/coldsnap-pin";
import {
  workspaceHostReleaseSubjectSha256,
  type WorkspaceHostBootcCloudArtifact,
} from "@papercusp/operator-core/lib/workspace-host/bootc-bake-manifest";

/**
 * AWS placement for a bootc image (WI-10005633): the bake's AWS disk is staged as a transient AMI
 * in the connection's (publisher) account and booted in the clean account. `releaseSha256` and
 * `publisherAccountId` are derived — from the artifact and the connection — never supplied.
 */
export interface AwsCleanRoomCliPlacement {
  provider: "aws";
  region: string;
  cleanAccount: AwsBootcCleanRoomPlacement["cleanAccount"];
  bootcArtifact: WorkspaceHostBootcCloudArtifact;
  architecture: string;
}

export type CleanRoomAcceptanceCliInput =
  | {
      artifact: WorkspaceHostImageArtifact;
      spec: WorkspaceHostCleanRoomInstallSpec;
      placement: GcpCleanRoomPlacement;
    }
  | {
      artifact: WorkspaceHostImageArtifact;
      spec: WorkspaceHostCleanRoomInstallSpec;
      placement: AwsCleanRoomCliPlacement;
      /** The persisted publisher-account connection; credentials come only from it. */
      connection: WorkspaceHostProviderConnection;
    };

function isAwsInput(
  input: CleanRoomAcceptanceCliInput,
): input is Extract<CleanRoomAcceptanceCliInput, { placement: AwsCleanRoomCliPlacement }> {
  return (input.placement as { provider?: unknown }).provider === "aws";
}

export interface CleanRoomAcceptanceCliArgs {
  inputFile: string;
  repositoryRoot?: string;
}

type ArgValue = string;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

/** Parse CLI flags strictly; unknown flags are errors rather than silently ignored. */
export function parseCleanRoomAcceptanceCliArgs(
  argv: readonly string[],
): CleanRoomAcceptanceCliArgs {
  const values: Record<string, ArgValue> = {};
  const valueFlags = new Set(["input-file", "repo-root"]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag?.startsWith("--"))
      throw new Error(`unexpected argument '${flag ?? ""}'`);
    const key = flag.slice(2);
    if (!valueFlags.has(key)) throw new Error(`unknown flag '--${key}'`);
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--"))
      throw new Error(`flag '--${key}' requires a value`);
    values[key] = value;
    index += 1;
  }
  const inputFile = values["input-file"];
  if (!inputFile) throw new Error("--input-file is required");
  return {
    inputFile,
    ...(values["repo-root"] ? { repositoryRoot: values["repo-root"] } : {}),
  };
}

/**
 * Validate only the envelope. The artifact and spec are deliberately NOT re-validated here:
 * `runWorkspaceHostCleanRoomAcceptance` already fails closed on both (compatibility matrix,
 * artifact identity, deterministic fixture), and a second, divergent copy of those rules is
 * exactly how a check drifts into passing something the real gate would reject.
 */
export function parseCleanRoomAcceptanceCliInput(
  value: unknown,
): CleanRoomAcceptanceCliInput {
  if (!isRecord(value)) throw new Error("input must be a JSON object");
  const { artifact, spec, placement } = value;
  if (!isRecord(artifact)) throw new Error("input.artifact must be an object");
  if (!isRecord(spec)) throw new Error("input.spec must be an object");
  if (!isRecord(placement)) throw new Error("input.placement must be an object");
  if (placement.provider === "aws") {
    const { connection } = value;
    if (!isRecord(connection)) throw new Error("input.connection must be an object for an AWS placement");
    if (connection.target !== "aws") {
      throw new Error(`input.connection.target must be 'aws', got '${String(connection.target)}'`);
    }
    const cleanAccount = placement.cleanAccount;
    if (!isRecord(cleanAccount)) throw new Error("placement.cleanAccount must be an object");
    const bootcArtifact = placement.bootcArtifact;
    if (!isRecord(bootcArtifact) || bootcArtifact.cloud !== "aws" || bootcArtifact.type !== "ami") {
      throw new Error("placement.bootcArtifact must be the AWS/ami row of the bake manifest");
    }
    return {
      artifact: artifact as unknown as WorkspaceHostImageArtifact,
      spec: spec as unknown as WorkspaceHostCleanRoomInstallSpec,
      placement: {
        provider: "aws",
        region: requiredString(placement.region, "placement.region"),
        cleanAccount: {
          accountId: requiredString(cleanAccount.accountId, "placement.cleanAccount.accountId"),
          subnetId: requiredString(cleanAccount.subnetId, "placement.cleanAccount.subnetId"),
          instanceProfileArn: requiredString(
            cleanAccount.instanceProfileArn,
            "placement.cleanAccount.instanceProfileArn",
          ),
        },
        bootcArtifact: bootcArtifact as unknown as WorkspaceHostBootcCloudArtifact,
        architecture: requiredString(placement.architecture ?? spec.architecture, "placement.architecture"),
      },
      connection: connection as unknown as WorkspaceHostProviderConnection,
    };
  }

  return {
    artifact: artifact as unknown as WorkspaceHostImageArtifact,
    spec: spec as unknown as WorkspaceHostCleanRoomInstallSpec,
    placement: {
      projectId: requiredString(placement.projectId, "placement.projectId"),
      zone: requiredString(placement.zone, "placement.zone"),
      // Required here as well as in the executor: --no-address without a NAT-backed subnet
      // leaves the guest no egress for the bundle download (EI-21744781090863686), and a
      // boundary that accepts it silently costs a real ~20-minute cloud boot to discover.
      subnetwork: requiredString(placement.subnetwork, "placement.subnetwork"),
      architecture: requiredString(
        placement.architecture ?? spec.architecture,
        "placement.architecture",
      ),
      ...(typeof placement.machineType === "string" && placement.machineType.trim()
        ? { machineType: placement.machineType.trim() }
        : {}),
    },
  };
}

/**
 * Environment override for the acceptance binary, mirroring
 * PAPERCUSP_GCP_CLEAN_ROOM_EXECUTABLE on the release CLI.
 *
 * These binaries are referenced by bare name and resolved through PATH — there is no
 * package.json `bin` entry for any of them — so without an override the CLI is unusable
 * anywhere the binary has not been installed onto PATH.
 */
export const BOOTSTRAP_ACCEPTANCE_EXECUTABLE_ENV =
  "PAPERCUSP_GCP_BOOTSTRAP_ACCEPTANCE_EXECUTABLE";

/** Executable overrides an operator sets in the env; the same names the AWS release CLI reads. */
export function awsCleanRoomCompositionOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AwsAmiReleaseCompositionOptions {
  return {
    // Override, else the checksum-pinned install (coldsnap-pin.ts), else bare `coldsnap` on PATH.
    ...coldsnapCompositionOption(env),
    ...(env.PAPERCUSP_AWS_AMI_SCAN_EXECUTABLE ? { scanExecutable: env.PAPERCUSP_AWS_AMI_SCAN_EXECUTABLE } : {}),
    ...(env.PAPERCUSP_AWS_AMI_CANARY_EXECUTABLE ? { canaryExecutable: env.PAPERCUSP_AWS_AMI_CANARY_EXECUTABLE } : {}),
  };
}

/**
 * Compose the AWS bootc executor. Both probes are read-only and run first: nothing is uploaded or
 * billed until the connection resolves to its own account and coldsnap + the canary are present.
 */
export async function composeAwsBootcCleanRoomExecutor(
  input: Extract<CleanRoomAcceptanceCliInput, { placement: AwsCleanRoomCliPlacement }>,
  options: AwsAmiReleaseCompositionOptions,
  probes: {
    credential?: (connection: WorkspaceHostProviderConnection) => Promise<AwsAmiCredentialProbe>;
    executables?: (options: AwsAmiReleaseCompositionOptions) => Promise<AwsAmiExecutableProbe>;
  } = {},
): Promise<AwsBootcCleanRoomExecutor> {
  const [credential, executables] = await Promise.all([
    (probes.credential ?? probeAwsAmiCredential)(input.connection),
    (probes.executables ?? probeAwsAmiExecutables)(options),
  ]);
  if (!credential.ok) {
    throw new Error(
      `AWS clean-room prerequisite failed: ${credential.error ?? "the connection credential does not resolve to its account"}`,
    );
  }
  // The clean room uploads (coldsnap) and launches (canary); it never runs the scanner.
  const missing = executables.executables.filter((entry) => !entry.ok && entry.role !== "scan");
  if (missing.length > 0) {
    throw new Error(
      `AWS clean-room prerequisite failed: not executable: ${missing.map((entry) => entry.executable).join(", ")}`,
    );
  }
  return new AwsBootcCleanRoomExecutor(composeAwsAmiReleaseAdapter(input.connection, options), {
    publisherAccountId: credential.accountId,
    region: input.placement.region,
    cleanAccount: input.placement.cleanAccount,
    bootcArtifact: input.placement.bootcArtifact,
    architecture: input.placement.architecture,
    releaseSha256: workspaceHostReleaseSubjectSha256(input.artifact),
  });
}

/** Run one already-parsed acceptance request and return the report. */
export async function runCleanRoomAcceptanceCli(
  input: CleanRoomAcceptanceCliInput,
  options: {
    repositoryRoot?: string;
    executable?: string;
    executor?: { execute(fixture: never): Promise<{ stdout: string }> };
    /** AWS only: composition options (executables, repository root) for the release adapter. */
    aws?: AwsAmiReleaseCompositionOptions;
    /** AWS only: read-only prerequisite probes; injected by tests. */
    probes?: {
      credential?: (connection: WorkspaceHostProviderConnection) => Promise<AwsAmiCredentialProbe>;
      executables?: (options: AwsAmiReleaseCompositionOptions) => Promise<AwsAmiExecutableProbe>;
    };
  } = {},
): Promise<WorkspaceHostCleanRoomAcceptanceReport> {
  let executor = options.executor;
  if (!executor && isAwsInput(input)) {
    executor = await composeAwsBootcCleanRoomExecutor(input, {
      ...(options.repositoryRoot ? { repositoryRoot: options.repositoryRoot } : {}),
      ...options.aws,
    }, options.probes);
  }
  if (!executor && !isAwsInput(input)) {
    const executable =
      options.executable ?? process.env[BOOTSTRAP_ACCEPTANCE_EXECUTABLE_ENV]?.trim();
    executor = new GcpWorkspaceHostCleanRoomExecutor({
      ...input.placement,
      ...(executable ? { executable } : {}),
      ...(options.repositoryRoot ? { repositoryRoot: options.repositoryRoot } : {}),
    });
  }
  return runWorkspaceHostCleanRoomAcceptance(
    input.artifact,
    input.spec,
    executor as Parameters<typeof runWorkspaceHostCleanRoomAcceptance>[2],
  );
}

async function main(): Promise<void> {
  const args = parseCleanRoomAcceptanceCliArgs(process.argv.slice(2));
  const raw = await readFile(args.inputFile, "utf8").catch(() => {
    throw new Error(`cannot read JSON input '${args.inputFile}'`);
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`JSON input '${args.inputFile}' is not valid JSON`);
  }
  const input = parseCleanRoomAcceptanceCliInput(parsed);
  const report = await runCleanRoomAcceptanceCli(input, {
    ...(args.repositoryRoot ? { repositoryRoot: args.repositoryRoot } : {}),
    aws: awsCleanRoomCompositionOptionsFromEnv(),
  });

  process.stdout.write(`${JSON.stringify({ cleanRoomReport: report }, null, 2)}\n`);
  // A rejected report is a successful MEASUREMENT of a failing subject, so it is emitted on
  // stdout like any other. The exit code still distinguishes them, so a pipeline cannot
  // splice a failing report into a release request by accident.
  if (!report.passed) process.exitCode = 3;
}

if (isCliEntry(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
