/**
 * Run the production GCP workspace-host image-family release composition.
 *
 * The request file contains both the complete release request (including its already-verified
 * artifact/gate evidence) and the persisted provider connection.  The CLI performs read-only
 * credential/executable probes before invoking Packer, then calls the connection-bound concrete
 * adapter.  It never accepts a raw key path or silently falls back to ambient ADC.
 *
 * A post-build failure has already paid for a verified-good candidate image, so
 * `--candidate-image-id` + `--resume-phase scan|publish` resume from it instead of rebuilding.
 * The executor owns the resume rules; this CLI only parses the flags and forwards them.
 */
import { readFile } from "node:fs/promises";

import type { WorkspaceHostProviderConnection } from "@papercusp/deployment-driver";
import { isCliEntry } from "@papercusp/operator-core/lib/util/cli-entry";
import {
  GcpImageFamilyExactPathReadinessError,
  executeConfiguredGcpImageFamilyRelease,
  probeGcpImageFamilyCredential,
  probeGcpImageFamilyExecutables,
  verifyGcpImageFamilyExactPathReadiness,
  type GcpImageFamilyExactPathReadinessConfig,
  type GcpImageFamilyExactPathReadinessEvidence,
  type GcpImageFamilyReleaseCompositionOptions,
} from "@papercusp/operator-core/lib/workspace-host/gcp-image-family-production";
import type {
  GcpImageFamilyReleaseExecutionOptions,
  GcpImageFamilyReleaseRequest,
  GcpImageFamilyReleaseResult,
  GcpImageFamilyReleaseResumePhase,
} from "@papercusp/operator-core/lib/workspace-host/gcp-image-family";

import {
  isRecord,
  parseGuestToolVersions,
  readJsonInput,
} from "./release-cli-input";

export interface GcpImageFamilyReleaseCliInput {
  request: GcpImageFamilyReleaseRequest;
  connection: WorkspaceHostProviderConnection;
  readiness: GcpImageFamilyExactPathReadinessConfig;
}

export interface GcpImageFamilyReleaseCliDeps {
  readFile?: (path: string) => Promise<string>;
  execute?: typeof executeConfiguredGcpImageFamilyRelease;
  verifyReadiness?: typeof verifyGcpImageFamilyExactPathReadiness;
}

export interface GcpImageFamilyReleaseCliResult {
  readiness: GcpImageFamilyExactPathReadinessEvidence;
  result: GcpImageFamilyReleaseResult;
}

export interface GcpImageFamilyReleaseCliArgs {
  requestFile: string;
  repositoryRoot?: string;
  guestToolVersionsFile?: string;
  /** Resume from an already-built candidate instead of rebuilding it. */
  candidateImageId?: string;
  resumePhase?: GcpImageFamilyReleaseResumePhase;
  json: boolean;
}

const RESUME_PHASES: readonly GcpImageFamilyReleaseResumePhase[] = [
  "scan",
  "publish",
];

/**
 * Narrow `--resume-phase` to the library's union so the value is type-correct at the seam.
 *
 * This is PARSING, not validation: the release executor remains the single authority on the
 * resume RULES — that candidateImageId and resumePhase are a required pair in both directions,
 * and that the supplied candidate is the deterministic candidate for this artifact in this
 * project.  Re-implementing those here would create a second copy that can diverge.
 */
function resumePhaseArg(value: string): GcpImageFamilyReleaseResumePhase {
  const phase = RESUME_PHASES.find((candidate) => candidate === value);
  if (!phase)
    throw new Error(
      `--resume-phase must be one of ${RESUME_PHASES.join(", ")}`,
    );
  return phase;
}

type ArgValue = string | boolean;

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

/** Parse CLI flags strictly; unknown flags are errors rather than silently ignored. */
export function parseGcpImageFamilyReleaseCliArgs(
  argv: readonly string[],
): GcpImageFamilyReleaseCliArgs {
  const values: Record<string, ArgValue> = {};
  const valueFlags = new Set([
    "request-file",
    "repo-root",
    "guest-tool-versions-file",
    "candidate-image-id",
    "resume-phase",
  ]);
  const booleanFlags = new Set(["json"]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag?.startsWith("--"))
      throw new Error(`unexpected argument '${flag ?? ""}'`);
    const key = flag.slice(2);
    if (valueFlags.has(key)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--"))
        throw new Error(`--${key} requires a value`);
      values[key] = value;
      index += 1;
    } else if (booleanFlags.has(key)) {
      if (values[key] !== undefined)
        throw new Error(`--${key} may be supplied only once`);
      values[key] = true;
    } else {
      throw new Error(`unknown argument '--${key}'`);
    }
  }
  return {
    requestFile: requiredString(values["request-file"], "--request-file"),
    ...(typeof values["repo-root"] === "string"
      ? { repositoryRoot: values["repo-root"] }
      : {}),
    ...(typeof values["guest-tool-versions-file"] === "string"
      ? { guestToolVersionsFile: values["guest-tool-versions-file"] }
      : {}),
    ...(typeof values["candidate-image-id"] === "string"
      ? { candidateImageId: values["candidate-image-id"] }
      : {}),
    ...(typeof values["resume-phase"] === "string"
      ? { resumePhase: resumePhaseArg(values["resume-phase"]) }
      : {}),
    json: values.json === true,
  };
}

/**
 * The per-run execution options, kept separate from the composition options so the resume
 * intent reaches the executor rather than being absorbed by adapter configuration.
 */
export function executionOptions(
  args: GcpImageFamilyReleaseCliArgs,
): GcpImageFamilyReleaseExecutionOptions {
  return {
    ...(args.candidateImageId
      ? { candidateImageId: args.candidateImageId }
      : {}),
    ...(args.resumePhase ? { resumePhase: args.resumePhase } : {}),
  };
}

/** Validate only the envelope here; the release executor remains the authority for deep fields. */
export function parseGcpImageFamilyReleaseCliInput(
  raw: unknown,
): GcpImageFamilyReleaseCliInput {
  if (
    !isRecord(raw) ||
    !isRecord(raw.request) ||
    !isRecord(raw.connection) ||
    !isRecord(raw.readiness)
  ) {
    throw new Error(
      "request file must contain object fields request, connection, and readiness",
    );
  }
  return {
    request: raw.request as unknown as GcpImageFamilyReleaseRequest,
    connection: raw.connection as unknown as WorkspaceHostProviderConnection,
    readiness:
      raw.readiness as unknown as GcpImageFamilyExactPathReadinessConfig,
  };
}

/**
 * Execute one already-parsed request through the production composition seam.
 *
 * Real arguments come before the test seam: `execution` carries the resume intent and must reach
 * the executor, so it is a parameter here rather than a field folded into `options`.
 */
export async function runGcpImageFamilyReleaseCli(
  input: GcpImageFamilyReleaseCliInput,
  options: GcpImageFamilyReleaseCompositionOptions = {},
  execution: GcpImageFamilyReleaseExecutionOptions = {},
  deps: Pick<GcpImageFamilyReleaseCliDeps, "execute" | "verifyReadiness"> = {},
): Promise<GcpImageFamilyReleaseCliResult> {
  if (
    options.repositoryRoot !== undefined &&
    options.repositoryRoot !== input.readiness.expected.cwd
  ) {
    throw new GcpImageFamilyExactPathReadinessError(
      "wrong-cwd",
      "the adapter repositoryRoot differs from the producer-captured canonical readiness cwd",
    );
  }
  // This is the single enforced boundary: every failure above is read-only, and the injected
  // executor below is the first call that can invoke Packer or a provider mutation.
  const readiness = await (
    deps.verifyReadiness ?? verifyGcpImageFamilyExactPathReadiness
  )(input.readiness);
  const result = await (deps.execute ?? executeConfiguredGcpImageFamilyRelease)(
    input.request,
    input.connection,
    options,
    execution,
  );
  return { readiness, result };
}

function envOptions(
  args: GcpImageFamilyReleaseCliArgs,
  guestToolVersions?: Readonly<Record<string, string>>,
) {
  const env = process.env;
  return {
    ...(args.repositoryRoot ? { repositoryRoot: args.repositoryRoot } : {}),
    ...(guestToolVersions ? { guestToolVersions } : {}),
    ...(env.PAPERCUSP_GCP_PACKER_EXECUTABLE
      ? { packerExecutable: env.PAPERCUSP_GCP_PACKER_EXECUTABLE }
      : {}),
    ...(env.PAPERCUSP_GCP_SCAN_EXECUTABLE
      ? { scanExecutable: env.PAPERCUSP_GCP_SCAN_EXECUTABLE }
      : {}),
    ...(env.PAPERCUSP_GCP_CLEAN_ROOM_EXECUTABLE
      ? { cleanRoomExecutable: env.PAPERCUSP_GCP_CLEAN_ROOM_EXECUTABLE }
      : {}),
    ...(env.PAPERCUSP_GCP_BOOTSTRAP_ACCEPTANCE_EXECUTABLE
      ? {
          bootstrapAcceptanceExecutable:
            env.PAPERCUSP_GCP_BOOTSTRAP_ACCEPTANCE_EXECUTABLE,
        }
      : {}),
  } satisfies GcpImageFamilyReleaseCompositionOptions;
}

async function main(): Promise<void> {
  const args = parseGcpImageFamilyReleaseCliArgs(process.argv.slice(2));
  const read = (path: string) => readFile(path, "utf8");
  const input = parseGcpImageFamilyReleaseCliInput(
    await readJsonInput(args.requestFile, read),
  );
  const guestToolVersions = args.guestToolVersionsFile
    ? parseGuestToolVersions(
        await readJsonInput(args.guestToolVersionsFile, read),
      )
    : undefined;
  const options = envOptions(args, guestToolVersions);

  // Auth is always reconstructed from the persisted connection reference by the composition seam.
  const credential = await probeGcpImageFamilyCredential(input.connection);
  const executables = await probeGcpImageFamilyExecutables(options);
  if (!credential.ok || !executables.ok) {
    const report = {
      ok: false,
      stage: "prerequisite" as const,
      credential: {
        ok: credential.ok,
        projectId: credential.projectId,
        credentialRef: credential.credentialRef,
        ...(credential.identity ? { identity: credential.identity } : {}),
        ...(credential.resolvedProjectId
          ? { resolvedProjectId: credential.resolvedProjectId }
          : {}),
        ...(credential.error ? { error: credential.error } : {}),
      },
      executables,
    };
    process.stderr.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 2;
    return;
  }

  const execution = await runGcpImageFamilyReleaseCli(
    input,
    options,
    executionOptions(args),
  );
  const output = {
    ok: true,
    projectId: credential.projectId,
    credentialRef: credential.credentialRef,
    readiness: execution.readiness,
    result: execution.result,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

if (isCliEntry(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
