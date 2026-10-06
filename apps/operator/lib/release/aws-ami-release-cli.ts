/**
 * Run the production AWS workspace-host AMI release composition — the AWS counterpart of
 * `gcp-image-family-release-cli.ts`.
 *
 * The request file carries the complete release request (including its already-verified release
 * gate evidence) and the persisted publisher-account provider connection.  Before anything is
 * uploaded or billed, the CLI proves read-only that the connection's credential resolves to the
 * publisher account and that coldsnap, the scanner and the clean-account canary are executable;
 * only then does it call the connection-bound SDK adapter.  It never accepts raw keys and never
 * falls back to an ambient profile — credentials come from the persisted connection reference.
 */
import { readFile } from "node:fs/promises";

import type { WorkspaceHostProviderConnection } from "@papercusp/deployment-driver";
import { isCliEntry } from "@papercusp/operator-core/lib/util/cli-entry";
import { coldsnapCompositionOption } from "@papercusp/operator-core/lib/workspace-host/coldsnap-pin";
import {
  executeConfiguredAwsAmiRelease,
  probeAwsAmiCredential,
  probeAwsAmiExecutables,
  type AwsAmiCredentialProbe,
  type AwsAmiExecutableProbe,
  type AwsAmiReleaseCompositionOptions,
} from "@papercusp/operator-core/lib/workspace-host/aws-ami-production";
import type {
  AwsAmiReleaseRequest,
  AwsAmiReleaseResult,
} from "@papercusp/operator-core/lib/workspace-host/aws-ami-release";

import {
  isRecord,
  parseGuestToolVersions,
  readJsonInput,
} from "./release-cli-input";

export interface AwsAmiReleaseCliInput {
  request: AwsAmiReleaseRequest;
  connection: WorkspaceHostProviderConnection;
}

export interface AwsAmiReleaseCliArgs {
  requestFile: string;
  repositoryRoot?: string;
  guestToolVersionsFile?: string;
  /** SSM parameter path prefix for the version manifest and per-region pins. */
  parameterPrefix?: string;
  json: boolean;
}

export interface AwsAmiReleaseCliDeps {
  probeCredential?: (
    connection: WorkspaceHostProviderConnection,
  ) => Promise<AwsAmiCredentialProbe>;
  probeExecutables?: (
    options: AwsAmiReleaseCompositionOptions,
  ) => Promise<AwsAmiExecutableProbe>;
  execute?: (
    request: AwsAmiReleaseRequest,
    connection: WorkspaceHostProviderConnection,
    options: AwsAmiReleaseCompositionOptions,
  ) => Promise<AwsAmiReleaseResult>;
}

export type AwsAmiReleaseCliOutcome =
  | {
      ok: false;
      stage: "prerequisite";
      credential: AwsAmiCredentialProbe;
      executables: AwsAmiExecutableProbe;
    }
  | {
      ok: true;
      accountId: string;
      identityArn?: string;
      result: AwsAmiReleaseResult;
    };

type ArgValue = string | boolean;

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

/** Parse CLI flags strictly; unknown flags are errors rather than silently ignored. */
export function parseAwsAmiReleaseCliArgs(
  argv: readonly string[],
): AwsAmiReleaseCliArgs {
  const values: Record<string, ArgValue> = {};
  const valueFlags = new Set([
    "request-file",
    "repo-root",
    "guest-tool-versions-file",
    "parameter-prefix",
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
      if (values[key] !== undefined)
        throw new Error(`--${key} may be supplied only once`);
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
  const parameterPrefix = values["parameter-prefix"];
  if (typeof parameterPrefix === "string" && !parameterPrefix.startsWith("/"))
    throw new Error("--parameter-prefix must be an absolute SSM path");
  return {
    requestFile: requiredString(values["request-file"], "--request-file"),
    ...(typeof values["repo-root"] === "string"
      ? { repositoryRoot: values["repo-root"] }
      : {}),
    ...(typeof values["guest-tool-versions-file"] === "string"
      ? { guestToolVersionsFile: values["guest-tool-versions-file"] }
      : {}),
    ...(typeof parameterPrefix === "string" ? { parameterPrefix } : {}),
    json: values.json === true,
  };
}

/**
 * Validate only the envelope here; the release executor remains the authority for deep fields.
 * The one deep check is the provider target: a GCP connection handed to the AWS release would
 * otherwise fail late, after the credential probe has already reached a cloud API.
 */
export function parseAwsAmiReleaseCliInput(
  raw: unknown,
): AwsAmiReleaseCliInput {
  if (!isRecord(raw) || !isRecord(raw.request) || !isRecord(raw.connection)) {
    throw new Error(
      "request file must contain object fields request and connection",
    );
  }
  if (raw.connection.target !== "aws") {
    throw new Error(
      `connection.target must be 'aws', got '${String(raw.connection.target)}'`,
    );
  }
  return {
    request: raw.request as unknown as AwsAmiReleaseRequest,
    connection: raw.connection as unknown as WorkspaceHostProviderConnection,
  };
}

/** Composition options from flags plus the executable overrides an operator sets in the env. */
export function awsAmiReleaseCompositionOptions(
  args: AwsAmiReleaseCliArgs,
  guestToolVersions?: Readonly<Record<string, string>>,
  env: NodeJS.ProcessEnv = process.env,
): AwsAmiReleaseCompositionOptions {
  return {
    ...(args.repositoryRoot ? { repositoryRoot: args.repositoryRoot } : {}),
    ...(guestToolVersions ? { guestToolVersions } : {}),
    ...(args.parameterPrefix ? { parameterPrefix: args.parameterPrefix } : {}),
    // Override, else the checksum-pinned install (coldsnap-pin.ts), else bare `coldsnap` on PATH.
    ...coldsnapCompositionOption(env),
    ...(env.PAPERCUSP_AWS_AMI_SCAN_EXECUTABLE
      ? { scanExecutable: env.PAPERCUSP_AWS_AMI_SCAN_EXECUTABLE }
      : {}),
    ...(env.PAPERCUSP_AWS_AMI_CANARY_EXECUTABLE
      ? { canaryExecutable: env.PAPERCUSP_AWS_AMI_CANARY_EXECUTABLE }
      : {}),
  };
}

/**
 * Execute one already-parsed request.  Both probes are read-only and run first; the injected
 * executor is the first call that can upload a snapshot or mutate the publisher account, so a
 * failed probe returns a prerequisite report without reaching it.
 */
export async function runAwsAmiReleaseCli(
  input: AwsAmiReleaseCliInput,
  options: AwsAmiReleaseCompositionOptions = {},
  deps: AwsAmiReleaseCliDeps = {},
): Promise<AwsAmiReleaseCliOutcome> {
  const [credential, executables] = await Promise.all([
    (deps.probeCredential ?? probeAwsAmiCredential)(input.connection),
    (deps.probeExecutables ?? probeAwsAmiExecutables)(options),
  ]);
  if (!credential.ok || !executables.ok) {
    return { ok: false, stage: "prerequisite", credential, executables };
  }
  const result = await (deps.execute ?? executeConfiguredAwsAmiRelease)(
    input.request,
    input.connection,
    options,
  );
  return {
    ok: true,
    accountId: credential.accountId,
    ...(credential.identityArn ? { identityArn: credential.identityArn } : {}),
    result,
  };
}

async function main(): Promise<void> {
  const args = parseAwsAmiReleaseCliArgs(process.argv.slice(2));
  const read = (path: string) => readFile(path, "utf8");
  const input = parseAwsAmiReleaseCliInput(
    await readJsonInput(args.requestFile, read),
  );
  const guestToolVersions = args.guestToolVersionsFile
    ? parseGuestToolVersions(
        await readJsonInput(args.guestToolVersionsFile, read),
      )
    : undefined;
  const outcome = await runAwsAmiReleaseCli(
    input,
    awsAmiReleaseCompositionOptions(args, guestToolVersions),
  );
  if (!outcome.ok) {
    process.stderr.write(`${JSON.stringify(outcome, null, 2)}\n`);
    process.exitCode = 2;
    return;
  }
  process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
}

if (isCliEntry(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
