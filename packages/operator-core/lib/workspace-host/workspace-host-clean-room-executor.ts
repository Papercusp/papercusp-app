/**
 * Production `WorkspaceHostCleanRoomExecutor` — the real implementer of the seam
 * `runWorkspaceHostCleanRoomAcceptance` injects.
 *
 * Until this existed, the ONLY implementations of that interface in the tree were the
 * hermetic test fakes, so the workspace-host release gate could never be fed a clean-room
 * report backed by a real machine. This class closes that gap by delegating to the
 * `papercusp-gcp-bootstrap-acceptance` binary, which boots a pristine stock Ubuntu instance,
 * runs the fixture's exact signed bootstrap script on it, and returns the guest's own stdout.
 *
 * ⛔ THE ONE RULE THIS CLASS EXISTS TO ENFORCE: it returns ONLY what the guest actually
 * printed. It never synthesizes, repairs, or defaults an attestation. In particular it must
 * never be "helped" by `workspaceHostCleanRoomFixtureAttestation`, which builds a fully
 * healthy attestation (`signatureVerified: true`, every check `ok`) and exists solely as the
 * expected-value builder for FAKE executors. Feeding that into the acceptance report would
 * make the gate ratify its own assumption — asserted success wearing the costume of evidence,
 * which is precisely the failure the clean room is built to catch.
 */
import { resolve } from 'node:path';

import type {
  WorkspaceHostCleanRoomExecutor,
  WorkspaceHostCleanRoomInstallFixture,
} from '@papercusp/deployment-driver';

import {
  NodeGcpImageFamilyCommandRunner,
  parseJsonObject,
  safeExecutable,
  type GcpImageFamilyCommandRunner,
} from './gcp-image-family-adapter';
import { GCP_IMAGE_FAMILY_RELEASE_EXECUTABLES } from './gcp-image-family-production';

/** Where the clean-room instance is placed. Every field is load-bearing. */
export interface GcpCleanRoomPlacement {
  projectId: string;
  zone: string;
  /**
   * REQUIRED, and the field most likely to be forgotten. The instance is created with
   * `--no-address`, so a subnet with Cloud NAT is its ONLY route off the box — and the
   * bootstrap script MUST reach the public Cupboard URL to download and signature-verify the
   * release bundle. Omitting it silently lands the instance on the `default` network with no
   * NAT, where the run dies ~20 minutes later as an opaque curl timeout
   * (EI-21744781090863686).
   */
  subnetwork: string;
  /** Contract architecture, e.g. `x86_64` or `arm64`; selects the stock Ubuntu family. */
  architecture: string;
  /** Overrides the binary's default machine type; required for arm64 (e2 is x86-only). */
  machineType?: string;
}

export interface GcpWorkspaceHostCleanRoomExecutorOptions extends GcpCleanRoomPlacement {
  commandRunner?: GcpImageFamilyCommandRunner;
  executable?: string;
  repositoryRoot?: string;
  /** Total budget for boot + bootstrap + teardown. The bundle install dominates it. */
  timeoutMs?: number;
}

/** Named once, in the registry the rest of the image release protocol already uses. */
const DEFAULT_EXECUTABLE = GCP_IMAGE_FAMILY_RELEASE_EXECUTABLES.bootstrapAcceptance;
/** Boot (12m) + bootstrap (20m) + teardown, with headroom for a slow apt mirror. */
const DEFAULT_TIMEOUT_MS = 45 * 60 * 1_000;
/**
 * The binary's stdout is a JSON envelope that EMBEDS the guest's entire bootstrap output, so
 * this cap bounds a verbose `apt-get` plus bundle download rather than a small result object.
 * Set explicitly: inheriting a smaller default would truncate the envelope into unparseable
 * JSON, and the attestation marker is emitted last — exactly what a truncation destroys.
 */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * How much of a failed run's stderr is quoted inline in the thrown error, and the rule that
 * bounds it. The implementation moved to ./diagnostic-excerpt so the GCP image-family adapter
 * can share it: that module is imported BY this one, so importing it back would have been a
 * cycle. Re-exported here because callers and tests already import it from this module.
 *
 * Everything over the budget is spilled to a file whose path the message names; see
 * {@link spillCleanRoomDiagnostic}.
 */
import { excerptDiagnostic, spillDiagnostic } from './diagnostic-excerpt';

export { excerptDiagnostic } from './diagnostic-excerpt';

/**
 * Write the COMPLETE stderr of a failed run to a file and return its path (null if the spill
 * itself fails — a diagnostics write must never mask the failure it is describing).
 *
 * The clean-room boot is billable and takes ~12 minutes, so its output is expensive evidence.
 * Before this existed the only surviving copy was the bounded excerpt above, which meant a
 * truncated diagnostic could only be recovered by paying for the whole boot again.
 */
function spillCleanRoomDiagnostic(fixtureId: string, stderr: string): string | null {
  return spillDiagnostic(fixtureId, stderr, 'papercusp-clean-room-');
}

/**
 * Runs the real clean-room acceptance boot on GCP.
 *
 * Inject this into `runWorkspaceHostCleanRoomAcceptance`, which owns the honest assembly of
 * the report: it double-builds the fixture to prove determinism, parses the attestation out
 * of the stdout returned here, validates it against the fixture's own bootstrap input, and
 * only then reports `passed: true`. Do not hand-assemble a report around this class.
 */
export class GcpWorkspaceHostCleanRoomExecutor implements WorkspaceHostCleanRoomExecutor {
  private readonly commandRunner: GcpImageFamilyCommandRunner;
  private readonly executable: string;
  private readonly cwd: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: GcpWorkspaceHostCleanRoomExecutorOptions) {
    this.commandRunner = options.commandRunner ?? new NodeGcpImageFamilyCommandRunner();
    this.executable = safeExecutable(options.executable, DEFAULT_EXECUTABLE, 'cleanRoomExecutable');
    this.cwd = resolve(options.repositoryRoot ?? process.cwd());
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async execute(fixture: WorkspaceHostCleanRoomInstallFixture): Promise<{ stdout: string }> {
    const placement = requirePlacement(this.options);
    const input = {
      projectId: placement.projectId,
      zone: placement.zone,
      subnetwork: placement.subnetwork,
      architecture: placement.architecture,
      ...(placement.machineType ? { machineType: placement.machineType } : {}),
      fixture: {
        fixtureId: fixture.fixtureId,
        bootstrapScript: fixture.bootstrapScript,
        bootstrapScriptSha256: fixture.bootstrapScriptSha256,
      },
    };

    const result = await this.commandRunner.run(this.executable, ['--json-stdin'], {
      cwd: this.cwd,
      stdin: `${JSON.stringify(input)}\n`,
      timeoutMs: this.timeoutMs,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    });

    if (result.exitCode !== 0) {
      // stderr carries the binary's structured {tool,error,details} payload, including any
      // residualResourceIds it could not tear down — surface it rather than a bare code.
      //
      // The full text is spilled to a file FIRST and its path named EARLY in the message,
      // because this run costs ~12 billable minutes: whatever the excerpt drops, and
      // whatever a downstream reader truncates, must still be recoverable without paying
      // for the boot a second time.
      const spillPath = spillCleanRoomDiagnostic(fixture.fixtureId, result.stderr);
      throw new Error(
        `clean-room acceptance run failed with exit code ${String(result.exitCode)}` +
          `${spillPath === null ? '' : ` [full guest stderr: ${spillPath}]`}: ` +
          `${excerptDiagnostic(result.stderr) || '<no stderr>'}`,
      );
    }

    const evidence = parseJsonObject(result.stdout, 'clean-room acceptance run');
    const stdout = evidence.stdout;
    if (typeof stdout !== 'string' || stdout.trim() === '') {
      throw new Error('clean-room acceptance run returned no guest stdout to attest from');
    }
    return { stdout };
  }
}

function requirePlacement(placement: GcpCleanRoomPlacement): GcpCleanRoomPlacement {
  for (const field of ['projectId', 'zone', 'subnetwork', 'architecture'] as const) {
    const value = placement[field];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`clean-room placement.${field} is required`);
    }
  }
  return placement;
}
