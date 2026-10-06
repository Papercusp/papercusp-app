/**
 * The PRODUCTION host adapter behind the remote initializer's protocol engine (D-110).
 *
 * `workspace-host-remote-initializer.ts` defines `WorkspaceHostRemoteInitializerHost` as a seam so
 * the protocol engine can be tested without a VM. Until this file existed the ONLY implementations
 * of that seam were `RecordingHost` in the test file and `RecordingMaterializer` in two others —
 * so every initialization step had a contract, an envelope, and a passing test suite, and no code
 * that could actually create a workspace on a host. D-110 named that gap; this file closes it.
 *
 * WHY A SYSTEM SEAM RATHER THAN DIRECT `node:child_process` CALLS. Every operation here is a
 * process spawn or a filesystem mutation on a real VM, which is exactly the code a unit test
 * cannot exercise. Routing all of it through one small `WorkspaceHostSystem` interface — whose
 * default is the real node implementation below — means the adapter's DECISIONS (which command,
 * which arguments, what counts as failure, what becomes evidence) are testable, while the
 * irreducible I/O stays in one place that is obviously correct. That is the same split the
 * protocol engine already uses, one layer down.
 *
 * EVIDENCE NEVER CARRIES AUTHORIZATION MATERIAL. The protocol engine runs
 * `assertWorkspaceHostSecretIsolation` over every response, and the credential resolver runs it
 * over every materializer detail. Both reject a key matching
 * `(api[_-]?key|access[_-]?key|secret|token|password|passphrase|private[_-]?key)` and any value
 * containing a PEM private-key header. Evidence below is therefore restricted to paths, booleans,
 * exit codes, counts and already-digested references — never a credential, and never a command
 * line that could have one interpolated into it.
 *
 * FAILURE IS LOUD. A non-zero exit throws `WorkspaceHostOperationError`, which the CLI wrapper
 * turns into exit 1 plus a stderr diagnostic. It is deliberate that no operation here can report
 * partial or optimistic success: the controller treats a failed step as failed and stops, whereas
 * a step that reported success it had not achieved would leave a half-initialized host that every
 * later step then builds on.
 */
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, rm, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  buildWorkspaceHostDesktopPackScript,
  parseWorkspaceHostDesktopPackAttestation,
  PINNED_KASMVNC_ARTIFACT,
  WORKSPACE_HOST_DESKTOP_PACK_CONTRACT_VERSION,
} from "./workspace-host-desktop-pack";

import {
  NodeWorkspaceHostAgentProbeRunner,
  probeWorkspaceHostAgents,
  WORKSPACE_HOST_CANARY_AGENTS,
  type WorkspaceHostAgentVerificationReport,
  type WorkspaceHostAgentProbeRunner,
  type WorkspaceHostCanaryAgent,
} from "./workspace-host-agent-authentication";
import {
  WORKSPACE_HOST_CREDENTIAL_FAMILY_SPECS,
  WorkspaceHostCredentialResolver,
  workspaceHostCredentialReferenceDigest,
  type WorkspaceHostCredentialBindingDescriptor,
  type WorkspaceHostCredentialFamily,
  type WorkspaceHostCredentialMaterializer,
} from "./workspace-host-credential-namespace";
import {
  NodeWorkspaceHostCredentialDeliveryFilesystem,
  ensureSharedWorkspaceDirectory,
  recordWorkspaceHostCredentialRevocation,
  withWorkspaceHostCredentialFilesystemLock,
  workspaceHostCredentialFamilyLockPath,
  workspaceHostCredentialMaterialPath,
  type WorkspaceHostCredentialDeliveryFilesystem,
} from "./workspace-host-credential-delivery";
import {
  WorkspaceHostAgentHomeConsumer,
  WORKSPACE_HOST_AGENT_HOME_FAMILIES,
  requireExplicitWorkspaceHostHome,
  type WorkspaceHostAgentHomeFamily,
  type WorkspaceHostAgentHomeFilesystem,
} from "./workspace-host-agent-home";
import {
  DEFAULT_WORKSPACE_HOST_AGENT_USER,
  DEFAULT_WORKSPACE_HOST_WORKSPACE_USER,
  WORKSPACE_HOST_CUSTOMER_AGENT_TOOLCHAIN_BIN,
  WORKSPACE_HOST_DATA_ROOT,
  WORKSPACE_HOST_RUNTIME_ROOT,
  WORKSPACE_HOST_STATE_ROOT,
} from "./workspace-host-bootstrap";
import type {
  WorkspaceHostCloneRepositoryInput,
  WorkspaceHostCreateWorkspaceInput,
  WorkspaceHostImportWorkspaceInput,
  WorkspaceHostPairWorkspaceInput,
  WorkspaceHostRemoteInitializerDeps,
  WorkspaceHostRemoteInitializerHost,
  WorkspaceHostRemoteStepEvidence,
} from "./workspace-host-remote-initializer";

/** Default root under which per-workspace directories are created on the host. */
export const WORKSPACE_HOST_DEFAULT_WORKSPACE_ROOT = WORKSPACE_HOST_DATA_ROOT;

/** Default native home used by the dedicated workspace SSH identity. */
export const WORKSPACE_HOST_DEFAULT_WORKSPACE_HOME = `/home/${DEFAULT_WORKSPACE_HOST_WORKSPACE_USER}`;

/**
 * Default native home of the platform AGENT identity (D-248).
 *
 * Between D-248 and D-421 delivered Claude/Codex/OMP material lived here. Since D-421 every
 * customer-driven agent runs as the customer workspace account, so delivered material goes to
 * {@link WORKSPACE_HOST_DEFAULT_WORKSPACE_HOME} and this home is only a LEGACY install location
 * the credential consumer migrates away from. The identity itself remains: bootstrap still
 * installs the vendor CLIs as it, and the customer toolchain is copied from there (D-423).
 */
export const WORKSPACE_HOST_DEFAULT_AGENT_HOME = `/home/${DEFAULT_WORKSPACE_HOST_AGENT_USER}`;

/**
 * The release bundle's own `bin/` — the directory holding the psu LAUNCHER WRAPPERS named
 * `claude`, `codex` and `omp`.
 *
 * Named rather than spelled inline because two different rules point at it and they must not
 * drift apart: it leads the probe search path below (the wrappers are what a bare name finds), and
 * an attested vendor runtime path inside it is refused outright (D-259 Defect 2) — a resolve that
 * landed here found a wrapper, which is the D-247 confusion arriving through a different door.
 */
export const WORKSPACE_HOST_RELEASE_BIN_DIR = `${WORKSPACE_HOST_RUNTIME_ROOT}/current/bin`;

/** Where bootstrap writes the attestation this adapter reads its vendor runtime paths from. */
export const WORKSPACE_HOST_BOOTSTRAP_ATTESTATION_FILE = `${WORKSPACE_HOST_STATE_ROOT}/bootstrap-attestation.json`;

/**
 * Exact PATH passed to agent probes; no controller process environment is inherited.
 *
 * Led by the customer agent toolchain, not the release bin: the probes run as the customer
 * workspace account (D-421), which D-043 bars from the release tree, so a release-bin entry would
 * only ever produce EACCES (D-423).
 */
export const WORKSPACE_HOST_DEFAULT_AGENT_PROBE_PATH = `${WORKSPACE_HOST_CUSTOMER_AGENT_TOOLCHAIN_BIN}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;

/** Default bundled CLI used for pair/import. `sidecar/bin` is on the runtime PATH. */
export const WORKSPACE_HOST_DEFAULT_WORKSPACE_COMMAND = "papercup";

/** Default bound on any single host command, so a hung child cannot stall a step forever. */
export const WORKSPACE_HOST_DEFAULT_COMMAND_TIMEOUT_MS = 300_000;

/**
 * Build the only Git credential environment allowed to consume a delivered generation.
 *
 * Git normally forwards `approve` and `reject` to every configured helper. The delivered file is
 * immutable evidence, so its helper exposes only `get`; the leading empty helper also resets every
 * ambient helper inherited from system/global configuration. The path is shell-quoted because Git
 * invokes `!` helpers through a shell, but it is never interpolated into argv or public evidence.
 */
export function workspaceHostGetOnlyGitCredentialEnvironment(
  materialPath: string,
): Readonly<Record<string, string>> {
  if (!isAbsolute(materialPath) || /[\0\r\n]/.test(materialPath)) {
    throw new Error(
      "Git credential material path must be an absolute single-line path",
    );
  }
  const quotedMaterialPath = `'${materialPath.replaceAll("'", "'\\''")}'`;
  return Object.freeze({
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/false",
    SSH_ASKPASS: "/bin/false",
    GCM_INTERACTIVE: "never",
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: `!f() { if [ "$1" = get ]; then git credential-store --file=${quotedMaterialPath} get; fi; }; f`,
    GIT_CONFIG_KEY_2: "credential.useHttpPath",
    GIT_CONFIG_VALUE_2: "true",
  });
}

export interface WorkspaceHostCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface WorkspaceHostCommandInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
  /** Process-only configuration. Callers must never copy this into evidence or diagnostics. */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * The irreducible host I/O. Small on purpose: everything above it is decision logic that a test
 * can drive, and everything in it is a direct call to node with no branching worth testing.
 */
export interface WorkspaceHostSystem
  extends
    WorkspaceHostCredentialDeliveryFilesystem,
    WorkspaceHostAgentHomeFilesystem {
  run(input: WorkspaceHostCommandInput): Promise<WorkspaceHostCommandResult>;
  /**
   * Create a directory under the ACL'd workspace root, mode `0770`, never following a symlink.
   * Distinct from `ensureDirectory` (the PRIVATE `0700` credential/home form) on purpose: under
   * the root's default ACL a `0700` mode sets `mask::---` and locks the service and agent
   * accounts out of the customer's workspace (WI-10004594).
   */
  ensureWorkspaceDirectory(path: string): Promise<void>;
  pathExists(path: string): Promise<boolean>;
  removePath(path: string): Promise<void>;
  /** Optional only so hermetic systems need not model Unix ownership. Production always provides it. */
  setOwnership?(path: string, owner: string, group: string): Promise<void>;
  setOwnershipRecursively?(
    path: string,
    owner: string,
    group: string,
  ): Promise<void>;
}

/** A host operation that did not achieve what it claimed. Never carries the child's argv. */
export class WorkspaceHostOperationError extends Error {
  readonly operation: string;
  readonly exitCode: number;

  constructor(operation: string, exitCode: number, detail: string) {
    super(
      `workspace host operation '${operation}' failed with exit ${exitCode}: ${detail}`,
    );
    this.name = "WorkspaceHostOperationError";
    this.operation = operation;
    this.exitCode = exitCode;
  }
}

/**
 * Trim a child's stderr for a diagnostic.
 *
 * Bounded because a failing command can emit megabytes, and the whole diagnostic ends up in a
 * protocol error the controller reads. The tail is kept rather than the head: the actual error
 * from a CLI is almost always its last lines, while the head is usually banner and progress.
 */
function diagnosticTail(text: string, maxChars = 2_000): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed || "(no diagnostic output)";
  return `…${trimmed.slice(-maxChars)}`;
}

/** The real implementation. Used by the packaged `bin/papercusp-remote-initializer`. */
export class NodeWorkspaceHostSystem implements WorkspaceHostSystem {
  async run(
    input: WorkspaceHostCommandInput,
  ): Promise<WorkspaceHostCommandResult> {
    return await new Promise<WorkspaceHostCommandResult>((resolve) => {
      execFile(
        input.command,
        [...input.args],
        {
          cwd: input.cwd,
          ...(input.env ? { env: { ...process.env, ...input.env } } : {}),
          timeout: input.timeoutMs ?? WORKSPACE_HOST_DEFAULT_COMMAND_TIMEOUT_MS,
          maxBuffer: 16 * 1024 * 1024,
          // The child must never inherit an interactive terminal: every command here runs
          // unattended, and a CLI that decides to prompt would hang the step until the timeout.
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const code =
            error && typeof (error as { code?: unknown }).code === "number"
              ? ((error as { code: number }).code as number)
              : error
                ? 1
                : 0;
          resolve({
            exitCode: code,
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? ""),
          });
        },
      );
    });
  }

  async ensureDirectory(path: string): Promise<void> {
    await this.deliveryFilesystem.ensureDirectory(path);
  }

  async ensureWorkspaceDirectory(path: string): Promise<void> {
    await ensureSharedWorkspaceDirectory(path);
  }

  async pathExists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  async pathKind(
    path: string,
  ): Promise<"missing" | "directory" | "file" | "symlink" | "other"> {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink()) return "symlink";
      if (info.isDirectory()) return "directory";
      if (info.isFile()) return "file";
      return "other";
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: unknown }).code === "ENOENT"
      )
        return "missing";
      throw error;
    }
  }

  async withExclusiveLock<T>(path: string, task: () => Promise<T>): Promise<T> {
    return await this.deliveryFilesystem.withExclusiveLock!(path, task);
  }

  async removePath(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true });
  }

  private async changeOwnership(
    path: string,
    owner: string,
    group: string,
    recursive: boolean,
  ): Promise<void> {
    // Resolve names through the platform command rather than carrying uid/gid assumptions across
    // provider images. Account names are validated by the adapter before reaching this seam.
    // WI-10004607: workspace directories live under a customer-writable root. The final path can
    // be replaced with a symlink after its component walk, so non-recursive chown must change the
    // link itself instead of following it to a root-owned target.
    await new Promise<void>((resolve, reject) => {
      execFile(
        "chown",
        [...(recursive ? ["-R"] : ["-h"]), `${owner}:${group}`, path],
        (error) => (error ? reject(error) : resolve()),
      );
    });
  }

  async setOwnership(
    path: string,
    owner: string,
    group: string,
  ): Promise<void> {
    await this.changeOwnership(path, owner, group, false);
  }

  async setOwnershipRecursively(
    path: string,
    owner: string,
    group: string,
  ): Promise<void> {
    await this.changeOwnership(path, owner, group, true);
  }

  // The two credential-delivery operations. Delegated to the delivery module's implementation
  // rather than re-derived here, so the 0600/atomic-rename behaviour has one definition and the
  // packaged delivery entrypoint and this host adapter cannot drift on how material is written.
  async writePrivateFile(path: string, bytes: Buffer): Promise<void> {
    await this.deliveryFilesystem.writePrivateFile(path, bytes);
  }

  async readFileIfPresent(path: string): Promise<Buffer | null> {
    return await this.deliveryFilesystem.readFileIfPresent(path);
  }

  private readonly deliveryFilesystem =
    new NodeWorkspaceHostCredentialDeliveryFilesystem();
}

export interface ProductionWorkspaceHostOptions {
  readonly system?: WorkspaceHostSystem;
  readonly workspaceRoot?: string;
  readonly workspaceCommand?: string;
  readonly gitCommand?: string;
  readonly agentProbeRunner?: WorkspaceHostAgentProbeRunner;
  readonly now?: () => Date;
  readonly gitCredentialBindings?: WorkspaceHostGitCredentialBindingRegistry;
  readonly credentialMaterialRoot?: string;
  /** Explicit native home for the workspace identity; never inferred from ambient HOME. */
  readonly workspaceHome?: string;
  readonly workspaceUser?: string;
  readonly workspaceGroup?: string;
  /**
   * The THIRD identity (D-248) — the account the bundled agent CLIs execute as, and the owner of
   * the delivered agent credential home. Deliberately NOT `workspaceUser`: that account is the
   * customer's SSH login on a BYOC host, and D-043 forbids it reading the runtime at all.
   */
  readonly agentHome?: string;
  readonly agentUser?: string;
  readonly agentGroup?: string;
  readonly agentProbePath?: string;
  /**
   * Attestation this adapter reads the vendor runtime paths out of (D-259 Defect 2).
   *
   * Overridable so a test can point at a fixture; production always uses the real host path.
   */
  readonly agentRuntimeAttestationPath?: string;
  /** Customer agent toolchain bin the probes execute from (D-423); overridable for tests. */
  readonly customerAgentToolchainBin?: string;
}

interface WorkspaceHostGitCredentialBinding {
  readonly generation: number;
  readonly materialPath: string;
  readonly expiresAt?: string;
}

/**
 * Filesystem-backed state joining lifecycle bind/revoke to a later private clone.
 *
 * The old implementation kept `active` only in this object. The packaged initializer constructs a
 * new object for every SSH step, so a successful bind was invisible to the next clone process.
 * Every operation below reads the state file afresh; independent processes therefore share the
 * same generation without a controller-side singleton.
 */
export class WorkspaceHostGitCredentialBindingRegistry {
  private readonly filesystem: WorkspaceHostSystem;
  private readonly materialRoot: string;

  constructor(
    filesystem: WorkspaceHostSystem = new NodeWorkspaceHostSystem(),
    materialRoot: string = WORKSPACE_HOST_CREDENTIAL_MATERIAL_ROOT,
  ) {
    this.filesystem = filesystem;
    this.materialRoot = materialRoot;
  }

  static statePath(materialRoot: string): string {
    return join(materialRoot, "active", "git-binding.json");
  }

  private async readState(): Promise<WorkspaceHostGitCredentialBinding | null> {
    const raw = await this.filesystem.readFileIfPresent(
      WorkspaceHostGitCredentialBindingRegistry.statePath(this.materialRoot),
    );
    if (raw === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new WorkspaceHostOperationError(
        "credential.git.state",
        1,
        "active Git binding state is malformed",
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new WorkspaceHostOperationError(
        "credential.git.state",
        1,
        "active Git binding state is malformed",
      );
    }
    const body = parsed as Record<string, unknown>;
    if (
      body.contractVersion !== WORKSPACE_HOST_GIT_BINDING_STATE_VERSION ||
      body.channel !== "git" ||
      body.family !== "git-short-lived-delegation" ||
      !Number.isSafeInteger(body.generation) ||
      (body.generation as number) < 1 ||
      typeof body.materialPath !== "string" ||
      (body.expiresAt !== undefined &&
        (typeof body.expiresAt !== "string" ||
          !Number.isFinite(Date.parse(body.expiresAt))))
    ) {
      throw new WorkspaceHostOperationError(
        "credential.git.state",
        1,
        "active Git binding state is malformed",
      );
    }
    const expectedPath = workspaceHostCredentialMaterialPath(
      this.materialRoot,
      "git-short-lived-delegation",
      body.generation as number,
    );
    if (body.materialPath !== expectedPath) {
      throw new WorkspaceHostOperationError(
        "credential.git.state",
        1,
        "active Git binding state points outside the canonical material path",
      );
    }
    return {
      generation: body.generation as number,
      materialPath: body.materialPath,
      ...(body.expiresAt ? { expiresAt: body.expiresAt } : {}),
    };
  }

  private async bindUnlocked(
    binding: WorkspaceHostCredentialBindingDescriptor,
    materialPath: string,
  ): Promise<void> {
    if (binding.channel !== "git") return;
    const expectedPath = workspaceHostCredentialMaterialPath(
      this.materialRoot,
      "git-short-lived-delegation",
      binding.generation,
    );
    if (materialPath !== expectedPath) {
      throw new WorkspaceHostOperationError(
        "credential.git.bind",
        1,
        "Git binding material path is not the canonical generation path",
      );
    }
    const current = await this.readState();
    if (current && current.generation > binding.generation) {
      throw new WorkspaceHostOperationError(
        "credential.git.bind",
        1,
        `cannot activate generation ${binding.generation} below active generation ${current.generation}`,
      );
    }
    if (
      current &&
      current.generation === binding.generation &&
      (current.materialPath !== materialPath ||
        current.expiresAt !== binding.expiresAt)
    ) {
      throw new WorkspaceHostOperationError(
        "credential.git.bind",
        1,
        `generation ${binding.generation} is already active with different binding state`,
      );
    }
    await this.filesystem.ensureDirectory(join(this.materialRoot, "active"));
    await this.filesystem.writePrivateFile(
      WorkspaceHostGitCredentialBindingRegistry.statePath(this.materialRoot),
      Buffer.from(
        JSON.stringify({
          contractVersion: WORKSPACE_HOST_GIT_BINDING_STATE_VERSION,
          channel: "git",
          family: "git-short-lived-delegation",
          generation: binding.generation,
          materialPath,
          ...(binding.expiresAt ? { expiresAt: binding.expiresAt } : {}),
        }),
        "utf8",
      ),
    );
  }

  async bind(
    binding: WorkspaceHostCredentialBindingDescriptor,
    materialPath: string,
    options: { readonly lockHeld?: boolean } = {},
  ): Promise<void> {
    const task = () => this.bindUnlocked(binding, materialPath);
    if (options.lockHeld) return await task();
    return await withWorkspaceHostCredentialFilesystemLock(
      this.filesystem,
      workspaceHostCredentialFamilyLockPath(
        this.materialRoot,
        "git-short-lived-delegation",
      ),
      task,
    );
  }

  private async revokeUnlocked(
    binding: WorkspaceHostCredentialBindingDescriptor,
  ): Promise<void> {
    if (binding.channel !== "git") return;
    const current = await this.readState();
    // Never let an old process revoke a newer active binding.
    if (!current || current.generation !== binding.generation) return;
    await this.filesystem.removePath(
      WorkspaceHostGitCredentialBindingRegistry.statePath(this.materialRoot),
    );
  }

  async revoke(
    binding: WorkspaceHostCredentialBindingDescriptor,
    options: { readonly lockHeld?: boolean } = {},
  ): Promise<void> {
    const task = () => this.revokeUnlocked(binding);
    if (options.lockHeld) return await task();
    return await withWorkspaceHostCredentialFilesystemLock(
      this.filesystem,
      workspaceHostCredentialFamilyLockPath(
        this.materialRoot,
        "git-short-lived-delegation",
      ),
      task,
    );
  }

  private async verifyBoundUnlocked(
    binding: WorkspaceHostCredentialBindingDescriptor,
    materialPath: string,
  ): Promise<void> {
    if (binding.channel !== "git") return;
    const current = await this.readState();
    if (
      !current ||
      current.generation !== binding.generation ||
      current.materialPath !== materialPath ||
      current.expiresAt !== binding.expiresAt
    ) {
      throw new WorkspaceHostOperationError(
        "credential.git.verify-bound",
        1,
        `generation ${binding.generation} is not the active Git binding`,
      );
    }
  }

  async verifyBound(
    binding: WorkspaceHostCredentialBindingDescriptor,
    materialPath: string,
    options: { readonly lockHeld?: boolean } = {},
  ): Promise<void> {
    const task = () => this.verifyBoundUnlocked(binding, materialPath);
    if (options.lockHeld) return await task();
    return await withWorkspaceHostCredentialFilesystemLock(
      this.filesystem,
      workspaceHostCredentialFamilyLockPath(
        this.materialRoot,
        "git-short-lived-delegation",
      ),
      task,
    );
  }

  private async verifyRevokedUnlocked(
    binding: WorkspaceHostCredentialBindingDescriptor,
  ): Promise<void> {
    if (binding.channel !== "git") return;
    const current = await this.readState();
    if (current?.generation === binding.generation) {
      throw new WorkspaceHostOperationError(
        "credential.git.verify-revoked",
        1,
        `generation ${binding.generation} is still the active Git binding`,
      );
    }
  }

  async verifyRevoked(
    binding: WorkspaceHostCredentialBindingDescriptor,
    options: { readonly lockHeld?: boolean } = {},
  ): Promise<void> {
    const task = () => this.verifyRevokedUnlocked(binding);
    if (options.lockHeld) return await task();
    return await withWorkspaceHostCredentialFilesystemLock(
      this.filesystem,
      workspaceHostCredentialFamilyLockPath(
        this.materialRoot,
        "git-short-lived-delegation",
      ),
      task,
    );
  }

  async resolve(now: Date): Promise<WorkspaceHostGitCredentialBinding> {
    const active = await this.readState();
    if (!active) {
      throw new WorkspaceHostOperationError(
        "cloneRepository.credentials",
        1,
        "no bound git credential material is available for a private clone",
      );
    }
    if (active.expiresAt && Date.parse(active.expiresAt) <= now.getTime()) {
      throw new WorkspaceHostOperationError(
        "cloneRepository.credentials",
        1,
        "the bound git credential material has expired",
      );
    }
    return active;
  }
}

const WORKSPACE_HOST_GIT_BINDING_STATE_VERSION =
  "papercusp-workspace-host-git-binding-state-v1";

/**
 * Reject a path that would escape the workspace root.
 *
 * The controller supplies `destination` and the include lists, and those arrive over a network
 * boundary. A relative path containing `..`, or an absolute path pointing anywhere, would let a
 * malformed (or hostile) request write outside the workspace it claims to be initializing.
 */
function resolveWithinRoot(
  root: string,
  candidate: string,
  label: string,
): string {
  if (isAbsolute(candidate)) {
    throw new WorkspaceHostOperationError(
      label,
      1,
      `${label} must be workspace-relative`,
    );
  }
  const resolved = join(root, candidate);
  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    throw new WorkspaceHostOperationError(
      label,
      1,
      `${label} escapes the workspace root`,
    );
  }
  return resolved;
}

const WORKSPACE_HOST_LINUX_ACCOUNT = /^[a-z_][a-z0-9_-]{0,30}$/;

function requireWorkspaceAccount(value: string, label: string): string {
  if (!WORKSPACE_HOST_LINUX_ACCOUNT.test(value) || value === "root") {
    throw new WorkspaceHostOperationError(
      label,
      1,
      `${label} must be a non-root Linux account name`,
    );
  }
  return value;
}

export class ProductionWorkspaceHostRemoteInitializerHost implements WorkspaceHostRemoteInitializerHost {
  private readonly system: WorkspaceHostSystem;
  private readonly workspaceRoot: string;
  private readonly workspaceCommand: string;
  private readonly gitCommand: string;
  private readonly agentProbeRunner: WorkspaceHostAgentProbeRunner;
  private readonly now: () => Date;
  private readonly gitCredentialBindings: WorkspaceHostGitCredentialBindingRegistry;
  private readonly workspaceHome: string;
  private readonly workspaceUser: string;
  private readonly workspaceGroup: string;
  private readonly agentHome: string;
  private readonly agentUser: string;
  private readonly agentGroup: string;
  private readonly agentProbePath: string;
  private readonly agentRuntimeAttestationPath: string;
  private readonly customerAgentToolchainBin: string;

  constructor(options: ProductionWorkspaceHostOptions = {}) {
    this.system = options.system ?? new NodeWorkspaceHostSystem();
    this.workspaceRoot =
      options.workspaceRoot ?? WORKSPACE_HOST_DEFAULT_WORKSPACE_ROOT;
    this.workspaceCommand =
      options.workspaceCommand ?? WORKSPACE_HOST_DEFAULT_WORKSPACE_COMMAND;
    this.gitCommand = options.gitCommand ?? "git";
    this.agentProbeRunner =
      options.agentProbeRunner ?? new NodeWorkspaceHostAgentProbeRunner();
    this.now = options.now ?? (() => new Date());
    this.workspaceHome = requireExplicitWorkspaceHostHome(
      options.workspaceHome ?? WORKSPACE_HOST_DEFAULT_WORKSPACE_HOME,
    );
    this.workspaceUser = requireWorkspaceAccount(
      options.workspaceUser ?? DEFAULT_WORKSPACE_HOST_WORKSPACE_USER,
      "workspaceUser",
    );
    this.workspaceGroup = requireWorkspaceAccount(
      options.workspaceGroup ?? this.workspaceUser,
      "workspaceGroup",
    );
    this.agentUser = requireWorkspaceAccount(
      options.agentUser ?? DEFAULT_WORKSPACE_HOST_AGENT_USER,
      "agentUser",
    );
    this.agentGroup = requireWorkspaceAccount(
      options.agentGroup ?? this.agentUser,
      "agentGroup",
    );
    this.agentHome = requireExplicitWorkspaceHostHome(
      options.agentHome ?? `/home/${this.agentUser}`,
    );
    // Refuse the collapse rather than silently accept it. A caller that passes the SSH account
    // here has recreated the exact shape D-248 removed — agent credentials in the customer's own
    // home, and a runtime the customer's login must read — and every downstream check would
    // still pass, because each one is individually satisfiable by that shape.
    if (this.agentUser === this.workspaceUser) {
      throw new WorkspaceHostOperationError(
        "agentUser",
        1,
        "agentUser must differ from workspaceUser: the agent identity exists so the SSH login is not the account that reads the runtime (D-043, D-248)",
      );
    }
    this.agentProbePath =
      options.agentProbePath ?? WORKSPACE_HOST_DEFAULT_AGENT_PROBE_PATH;
    if (
      !this.agentProbePath.startsWith("/") ||
      /[\r\n\0]/.test(this.agentProbePath)
    ) {
      throw new WorkspaceHostOperationError(
        "agentProbePath",
        1,
        "agentProbePath must be an absolute, newline-free search path",
      );
    }
    this.agentRuntimeAttestationPath =
      options.agentRuntimeAttestationPath ??
      WORKSPACE_HOST_BOOTSTRAP_ATTESTATION_FILE;
    this.customerAgentToolchainBin = requireExplicitWorkspaceHostHome(
      options.customerAgentToolchainBin ?? WORKSPACE_HOST_CUSTOMER_AGENT_TOOLCHAIN_BIN,
    );
    this.gitCredentialBindings =
      options.gitCredentialBindings ??
      new WorkspaceHostGitCredentialBindingRegistry(
        this.system,
        options.credentialMaterialRoot ??
          WORKSPACE_HOST_CREDENTIAL_MATERIAL_ROOT,
      );
  }

  private async require(
    operation: string,
    input: WorkspaceHostCommandInput,
  ): Promise<WorkspaceHostCommandResult> {
    const result = await this.system.run(input);
    if (result.exitCode !== 0) {
      throw new WorkspaceHostOperationError(
        operation,
        result.exitCode,
        diagnosticTail(result.stderr),
      );
    }
    return result;
  }

  async installDesktopPack(input: { hostId: string }): Promise<WorkspaceHostRemoteStepEvidence> {
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(input.hostId)) {
      throw new WorkspaceHostOperationError("installDesktopPack", 1, "invalid desktop-pack hostId");
    }
    const { script } = buildWorkspaceHostDesktopPackScript({
      contractVersion: WORKSPACE_HOST_DESKTOP_PACK_CONTRACT_VERSION,
      action: "install",
      hostId: input.hostId,
    });
    const result = await this.require("installDesktopPack", {
      command: "/bin/bash",
      args: ["-c", script],
    });
    const attestation = parseWorkspaceHostDesktopPackAttestation(result.stdout);
    if (
      attestation.hostId !== input.hostId ||
      attestation.action !== "install" ||
      attestation.kasmvnc?.version !== PINNED_KASMVNC_ARTIFACT.version ||
      attestation.kasmvnc?.sha256 !== PINNED_KASMVNC_ARTIFACT.debSha256
    ) {
      throw new WorkspaceHostOperationError("installDesktopPack", 1, "desktop pack attestation identity mismatch");
    }
    return { ...attestation };
  }

  async createWorkspace(
    input: WorkspaceHostCreateWorkspaceInput,
  ): Promise<WorkspaceHostRemoteStepEvidence> {
    const directory = resolveWithinRoot(
      this.workspaceRoot,
      input.workspaceId,
      "workspaceId",
    );
    // The workspace form, not the private `ensureDirectory`: this directory lives under the ACL'd
    // workspace root and must stay reachable by the service and agent accounts (WI-10004594).
    await this.system.ensureWorkspaceDirectory(directory);
    await this.system.setOwnership?.(
      directory,
      this.workspaceUser,
      this.workspaceGroup,
    );
    // Verify rather than assume: `mkdir -p` succeeding is not the same fact as the directory
    // being there afterwards (a read-only mount and a racing teardown both produce that shape).
    if (!(await this.system.pathExists(directory))) {
      throw new WorkspaceHostOperationError(
        "createWorkspace",
        1,
        `workspace directory ${directory} does not exist after creation`,
      );
    }
    return {
      workspaceId: input.workspaceId,
      hostId: input.hostId,
      directory,
      created: true,
      observedAt: this.now().toISOString(),
    };
  }

  async cloneRepository(
    input: WorkspaceHostCloneRepositoryInput,
  ): Promise<WorkspaceHostRemoteStepEvidence> {
    const destination = resolveWithinRoot(
      this.workspaceRoot,
      input.destination,
      "destination",
    );
    let env: Readonly<Record<string, string>> | undefined;
    if (input.visibility === "private") {
      if (input.credentialChannel !== "git") {
        throw new WorkspaceHostOperationError(
          "cloneRepository.credentials",
          1,
          "a private repository clone must consume the bound 'git' credential channel",
        );
      }
      const binding = await this.gitCredentialBindings.resolve(this.now());
      if (!(await this.system.pathExists(binding.materialPath))) {
        throw new WorkspaceHostOperationError(
          "cloneRepository.credentials",
          1,
          "the bound git credential material is absent from the host",
        );
      }
      env = workspaceHostGetOnlyGitCredentialEnvironment(binding.materialPath);
    }

    // A previous initialization can have completed the clone step before the controller lost its
    // response. Re-running with a fresh operation must reuse only a checkout we can prove is the
    // same repository, clean, and already at the requested revision. Never delete or overwrite a
    // non-empty destination: it may contain customer work, or it may be evidence of a different
    // source that the caller must investigate.
    if (await this.system.pathExists(destination)) {
      const gitDirectory = join(destination, ".git");
      if (!(await this.system.pathExists(gitDirectory))) {
        throw new WorkspaceHostOperationError(
          "cloneRepository.resume",
          1,
          `existing destination ${destination} is not a Git worktree`,
        );
      }
      const worktree = await this.require("cloneRepository.resume.worktree", {
        command: this.gitCommand,
        args: ["-C", destination, "rev-parse", "--is-inside-work-tree"],
      });
      if (worktree.stdout.trim() !== "true") {
        throw new WorkspaceHostOperationError(
          "cloneRepository.resume",
          1,
          `existing destination ${destination} is not a Git worktree`,
        );
      }
      const remote = await this.require("cloneRepository.resume.origin", {
        command: this.gitCommand,
        args: ["-C", destination, "remote", "get-url", "origin"],
      });
      if (
        remote.stdout.trim().replace(/\/+$/, "") !==
        input.repositoryUrl.trim().replace(/\/+$/, "")
      ) {
        throw new WorkspaceHostOperationError(
          "cloneRepository.resume",
          1,
          `existing destination ${destination} has a different origin`,
        );
      }
      const status = await this.require("cloneRepository.resume.status", {
        command: this.gitCommand,
        args: [
          "-C",
          destination,
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
        ],
      });
      if (status.stdout.trim() !== "") {
        throw new WorkspaceHostOperationError(
          "cloneRepository.resume",
          1,
          `existing destination ${destination} has uncommitted changes`,
        );
      }
      if (input.revision) {
        const requested = await this.require(
          "cloneRepository.resume.revision",
          {
            command: this.gitCommand,
            args: [
              "-C",
              destination,
              "rev-parse",
              "--verify",
              `${input.revision}^{commit}`,
            ],
          },
        );
        const head = await this.require("cloneRepository.resume.head", {
          command: this.gitCommand,
          args: ["-C", destination, "rev-parse", "HEAD"],
        });
        if (requested.stdout.trim() !== head.stdout.trim()) {
          throw new WorkspaceHostOperationError(
            "cloneRepository.resume",
            1,
            `existing destination ${destination} is not at requested revision ${input.revision}`,
          );
        }
      }
      await this.system.setOwnershipRecursively?.(
        destination,
        this.workspaceUser,
        this.workspaceGroup,
      );
      return {
        destination,
        visibility: input.visibility,
        cloned: false,
        reused: true,
        ...(input.revision ? { revision: input.revision } : {}),
        ...(input.credentialChannel
          ? { credentialChannel: input.credentialChannel }
          : {}),
        observedAt: this.now().toISOString(),
      };
    }

    await this.require("cloneRepository", {
      command: this.gitCommand,
      args: ["clone", "--quiet", input.repositoryUrl, destination],
      ...(env ? { env } : {}),
    });
    if (input.revision) {
      await this.require("cloneRepository.checkout", {
        command: this.gitCommand,
        args: ["-C", destination, "checkout", "--quiet", input.revision],
      });
    }
    // The clone is only real if the git directory landed. `git clone` exiting 0 with no worktree
    // is the shape a partially-written filesystem takes, and it is the failure the verify step
    // exists to catch — catching it HERE names the step that actually failed.
    if (!(await this.system.pathExists(join(destination, ".git")))) {
      throw new WorkspaceHostOperationError(
        "cloneRepository",
        1,
        `no .git directory at ${destination} after clone`,
      );
    }
    // The privileged initializer creates the checkout, but the unprivileged SSH identity owns and
    // edits it afterwards. Do this only after the clone is complete so Git never observes a tree
    // whose ownership changes underneath it.
    await this.system.setOwnershipRecursively?.(
      destination,
      this.workspaceUser,
      this.workspaceGroup,
    );
    return {
      destination,
      visibility: input.visibility,
      cloned: true,
      ...(input.revision ? { revision: input.revision } : {}),
      // The CHANNEL is public routing metadata; the credential itself never appears here.
      ...(input.credentialChannel
        ? { credentialChannel: input.credentialChannel }
        : {}),
      observedAt: this.now().toISOString(),
    };
  }

  async pairWorkspace(
    input: WorkspaceHostPairWorkspaceInput,
  ): Promise<WorkspaceHostRemoteStepEvidence> {
    await this.require("pairWorkspace", {
      command: this.workspaceCommand,
      args: [
        "workspace",
        "pair",
        "--source",
        input.sourceWorkspaceId,
        "--pairing-ref",
        input.pairingReference.ref,
        ...input.include.flatMap((entry) => ["--include", entry]),
      ],
    });
    return {
      sourceWorkspaceId: input.sourceWorkspaceId,
      // A pairing ref is a reference, not material — but it is still an identifier the controller
      // supplied, so it is digested rather than echoed. The controller can match the digest.
      pairingReferenceDigest: workspaceHostCredentialReferenceDigest(
        input.pairingReference.ref,
      ),
      include: [...input.include],
      paired: true,
      observedAt: this.now().toISOString(),
    };
  }

  async importWorkspace(
    input: WorkspaceHostImportWorkspaceInput,
  ): Promise<WorkspaceHostRemoteStepEvidence> {
    await this.require("importWorkspace", {
      command: this.workspaceCommand,
      args: [
        "workspace",
        "import",
        "--source",
        input.sourceWorkspaceId,
        "--snapshot",
        input.sourceSnapshotRef,
        ...input.include.flatMap((entry) => ["--include", entry]),
      ],
    });
    return {
      sourceWorkspaceId: input.sourceWorkspaceId,
      sourceSnapshotRef: input.sourceSnapshotRef,
      include: [...input.include],
      imported: true,
      observedAt: this.now().toISOString(),
    };
  }

  /**
   * Delegate to the existing probe suite rather than reimplementing it.
   *
   * `probeWorkspaceHostAgents` already owns the rules that make this evidence trustworthy — the
   * sequential ordering, the "exit 0 but unparseable is a FAILED probe" rule, and the subject
   * disclosure policy. A second implementation here would be a second set of those rules to keep
   * in sync, and the one that drifted would be the one nobody was reading.
   */
  async probeAgentVerification(requestedAgents?: readonly WorkspaceHostCanaryAgent[]): Promise<WorkspaceHostAgentVerificationReport> {
    return await probeWorkspaceHostAgents({
      runner: this.agentProbeRunner,
      requestedAgents,
      now: this.now,
      // D-259 Defect 2: exec an explicit path, never a bare name a wrapper could answer. The
      // attestation says WHICH vendor CLIs bootstrap installed; the path executed is that CLI's
      // copy in the customer agent toolchain (D-423), because the attested install lives in the
      // platform agent home, which the account running these probes cannot read.
      runtimePaths: this.customerToolchainRuntimePaths(
        await this.readAttestedAgentRuntimePaths(),
      ),
      // The CUSTOMER workspace account (D-421), the identity every customer-driven agent runs
      // as — so a passing probe proves the product path, not a platform-only one. HOME travels
      // with it: the delivered Claude/Codex material lives in that account's 0700 home, and a
      // probe with any other HOME would look for credentials that are not there and fail
      // identically to a genuine credential fault. D-043 is intact because this account reaches
      // only the toolchain, never `$RUNTIME_ROOT`.
      env: {
        HOME: this.workspaceHome,
        USER: this.workspaceUser,
        LOGNAME: this.workspaceUser,
        PATH: this.agentProbePath,
      },
      runAsUser: this.workspaceUser,
    });
  }

  /** Map each attested vendor CLI onto its customer-toolchain copy (D-423). */
  private customerToolchainRuntimePaths(
    attested: Partial<Record<WorkspaceHostCanaryAgent, string>>,
  ): Partial<Record<WorkspaceHostCanaryAgent, string>> {
    const paths: Partial<Record<WorkspaceHostCanaryAgent, string>> = {};
    for (const agent of Object.keys(attested) as WorkspaceHostCanaryAgent[]) {
      paths[agent] = join(this.customerAgentToolchainBin, agent);
    }
    return paths;
  }

  /**
   * Read the vendor runtime paths bootstrap recorded in its attestation (D-259 Defect 2).
   *
   * ABSENCE IS NOT AN ERROR, in three distinct shapes, and each one is a real host: no attestation
   * file (this adapter running somewhere that never bootstrapped), no `agentRuntimes` key (a host
   * provisioned before the vendor installs existed), or a key missing one agent (a partial
   * install). All three fall back to the probe's own command and therefore FAIL the probe, which
   * is the honest verdict — those hosts genuinely cannot authenticate that agent.
   *
   * MALFORMED IS an error, and the difference matters. Unreadable JSON, a non-object
   * `agentRuntimes`, or a non-absolute path means the attestation says something we cannot act on;
   * treating that as "no path recorded" would silently downgrade it to the fallback above and
   * report a probe failure whose real cause was a corrupt attestation nobody looked at.
   */
  private async readAttestedAgentRuntimePaths(): Promise<
    Partial<Record<WorkspaceHostCanaryAgent, string>>
  > {
    const bytes = await this.system.readFileIfPresent(
      this.agentRuntimeAttestationPath,
    );
    if (!bytes) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new WorkspaceHostOperationError(
        "readAttestedAgentRuntimePaths",
        1,
        `bootstrap attestation at ${this.agentRuntimeAttestationPath} is not valid JSON`,
      );
    }
    const runtime = (parsed as { runtime?: unknown } | null)?.runtime;
    const attested =
      runtime && typeof runtime === "object"
        ? (runtime as { agentRuntimes?: unknown }).agentRuntimes
        : undefined;
    if (attested === undefined) return {};
    if (
      typeof attested !== "object" ||
      attested === null ||
      Array.isArray(attested)
    ) {
      throw new WorkspaceHostOperationError(
        "readAttestedAgentRuntimePaths",
        1,
        "bootstrap attestation runtime.agentRuntimes is not an object",
      );
    }
    const record = attested as Record<string, unknown>;
    const paths: Partial<Record<WorkspaceHostCanaryAgent, string>> = {};
    for (const agent of WORKSPACE_HOST_CANARY_AGENTS) {
      const value = record[agent];
      if (value === undefined) continue;
      if (typeof value !== "string" || !isAbsolute(value)) {
        throw new WorkspaceHostOperationError(
          "readAttestedAgentRuntimePaths",
          1,
          `attested runtime path for '${agent}' is not an absolute path`,
        );
      }
      // The release bin holds the psu wrappers. A resolve that landed there did NOT find a vendor
      // CLI, so probing it would reproduce D-247 exactly — a green-looking probe measuring the
      // wrong binary. Bootstrap's resolve already excludes this directory from its search path;
      // this refuses the same thing at the point of USE, where a hand-edited or future-regressed
      // attestation would otherwise arrive unchallenged.
      if (
        value === WORKSPACE_HOST_RELEASE_BIN_DIR ||
        value.startsWith(`${WORKSPACE_HOST_RELEASE_BIN_DIR}/`)
      ) {
        throw new WorkspaceHostOperationError(
          "readAttestedAgentRuntimePaths",
          1,
          `attested runtime path for '${agent}' is inside ${WORKSPACE_HOST_RELEASE_BIN_DIR}, which holds launcher wrappers rather than vendor CLIs (D-259)`,
        );
      }
      paths[agent] = value;
    }
    return paths;
  }

  async describeClonedRepository(input?: {
    readonly destination: string;
    readonly visibility: "public" | "private";
  }): Promise<{
    readonly visibility: "public" | "private";
    readonly cloned: boolean;
  }> {
    if (!input) return { visibility: "public", cloned: false };
    // `verify-initialization` is a fresh process. The validated destination is carried on that
    // step, so this observation cannot depend on a clone remembered by an earlier JS object.
    const destination = resolveWithinRoot(
      this.workspaceRoot,
      input.destination,
      "destination",
    );
    const cloned = await this.system.pathExists(join(destination, ".git"));
    return { visibility: input.visibility, cloned };
  }
}

/**
 * Production credential materializer.
 *
 * The host is a credential RECIPIENT, never a minter: the controller delivers material out of
 * band (metadata server, injected file, forwarded reference) and the host's job is to confirm the
 * delivery landed, confirm it still holds, and confirm a revocation actually took effect. That is
 * why all four operations are observations and none of them writes a credential.
 *
 * Every returned detail is public: the family, the delivery kind, the generation, and a boolean.
 * The resolver re-asserts secret isolation over whatever this returns, so a materializer that
 * leaked material would fail there — but the design intent is that there is nothing to leak.
 */
export class ProductionWorkspaceHostCredentialMaterializer implements WorkspaceHostCredentialMaterializer {
  readonly family: WorkspaceHostCredentialFamily;
  private readonly system: WorkspaceHostSystem;
  private readonly locate: (
    binding: WorkspaceHostCredentialBindingDescriptor,
  ) => string | null;
  private readonly gitCredentialBindings?: WorkspaceHostGitCredentialBindingRegistry;
  private readonly agentHomeConsumer?: WorkspaceHostAgentHomeConsumer;
  private readonly recordRevocation?: (generation: number) => Promise<void>;
  private readonly lifecycleLockPath?: string;

  constructor(
    family: WorkspaceHostCredentialFamily,
    system: WorkspaceHostSystem,
    locate: (
      binding: WorkspaceHostCredentialBindingDescriptor,
    ) => string | null,
    gitCredentialBindings?: WorkspaceHostGitCredentialBindingRegistry,
    agentHomeConsumer?: WorkspaceHostAgentHomeConsumer,
    recordRevocation?: (generation: number) => Promise<void>,
    lifecycleLockPath?: string,
  ) {
    this.family = family;
    this.system = system;
    this.locate = locate;
    this.gitCredentialBindings = gitCredentialBindings;
    this.agentHomeConsumer = agentHomeConsumer;
    this.recordRevocation = recordRevocation;
    this.lifecycleLockPath = lifecycleLockPath;
  }

  private async withLifecycleLock<T>(task: () => Promise<T>): Promise<T> {
    if (!this.lifecycleLockPath) return await task();
    return await withWorkspaceHostCredentialFilesystemLock(
      this.system,
      this.lifecycleLockPath,
      task,
    );
  }

  private agentFamily(): WorkspaceHostAgentHomeFamily | null {
    return WORKSPACE_HOST_AGENT_HOME_FAMILIES.includes(
      this.family as WorkspaceHostAgentHomeFamily,
    )
      ? (this.family as WorkspaceHostAgentHomeFamily)
      : null;
  }

  private async requireMaterial(
    binding: WorkspaceHostCredentialBindingDescriptor,
    operation: string,
  ): Promise<{ readonly path: string; readonly bytes: Buffer } | null> {
    const path = this.locate(binding);
    if (path === null) return null;
    const bytes = await this.system.readFileIfPresent(path);
    if (bytes === null) {
      throw new WorkspaceHostOperationError(
        `credential.${binding.channel}.${operation}`,
        1,
        `delivered material for family '${this.family}' is not present on the host`,
      );
    }
    return { path, bytes };
  }

  private describe(
    binding: WorkspaceHostCredentialBindingDescriptor,
    present: boolean,
  ): Readonly<Record<string, unknown>> {
    return {
      family: this.family,
      channel: binding.channel,
      deliveryKind: binding.deliveryKind,
      generation: binding.generation,
      present,
    };
  }

  async bind(
    binding: WorkspaceHostCredentialBindingDescriptor,
  ): Promise<Readonly<Record<string, unknown>>> {
    return await this.withLifecycleLock(async () => {
      const material = await this.requireMaterial(binding, "bind");
      const agentFamily = this.agentFamily();
      if (agentFamily) {
        if (!this.agentHomeConsumer || !material) {
          throw new WorkspaceHostOperationError(
            `credential.${binding.channel}.bind`,
            1,
            `no agent-home consumer is configured for family '${this.family}'`,
          );
        }
        await this.agentHomeConsumer.install(
          agentFamily,
          binding.generation,
          material.bytes,
          { lockHeld: true },
        );
      } else if (binding.channel === "git" && material) {
        if (!this.gitCredentialBindings) {
          throw new WorkspaceHostOperationError(
            "credential.git.bind",
            1,
            "no durable Git binding registry is configured",
          );
        }
        await this.gitCredentialBindings.bind(binding, material.path, {
          lockHeld: true,
        });
      } else if (binding.channel !== "cloud" && !material) {
        throw new WorkspaceHostOperationError(
          `credential.${binding.channel}.bind`,
          1,
          `family '${this.family}' requires delivered material`,
        );
      }
      return this.describe(binding, true);
    });
  }

  async verifyBound(
    binding: WorkspaceHostCredentialBindingDescriptor,
  ): Promise<Readonly<Record<string, unknown>>> {
    return await this.withLifecycleLock(async () => {
      const material = await this.requireMaterial(binding, "verify-bound");
      const agentFamily = this.agentFamily();
      if (agentFamily) {
        if (!this.agentHomeConsumer || !material) {
          throw new WorkspaceHostOperationError(
            `credential.${binding.channel}.verify-bound`,
            1,
            `no agent-home consumer is configured for family '${this.family}'`,
          );
        }
        await this.agentHomeConsumer.verify(
          agentFamily,
          binding.generation,
          material.bytes,
          { lockHeld: true },
        );
      } else if (binding.channel === "git" && material) {
        await this.gitCredentialBindings?.verifyBound(binding, material.path, {
          lockHeld: true,
        });
      }
      return this.describe(binding, true);
    });
  }

  async revoke(
    binding: WorkspaceHostCredentialBindingDescriptor,
  ): Promise<Readonly<Record<string, unknown>>> {
    return await this.withLifecycleLock(async () => {
      const path = this.locate(binding);
      const agentFamily = this.agentFamily();
      if (agentFamily) {
        if (!this.agentHomeConsumer) {
          throw new WorkspaceHostOperationError(
            `credential.${binding.channel}.revoke`,
            1,
            `no agent-home consumer is configured for family '${this.family}'`,
          );
        }
        await this.agentHomeConsumer.revoke(agentFamily, binding.generation, {
          lockHeld: true,
        });
      }
      await this.gitCredentialBindings?.revoke(binding, { lockHeld: true });
      if (path !== null) await this.system.removePath(path);
      // The ledger is raised before success is reported, because it is the only durable trace that
      // this generation was destroyed. Keep the whole sequence under one family lock so a delivery
      // cannot slip between unlink and the high-water update.
      if (path !== null) await this.recordRevocation?.(binding.generation);
      return this.describe(binding, false);
    });
  }

  async verifyRevoked(
    binding: WorkspaceHostCredentialBindingDescriptor,
  ): Promise<Readonly<Record<string, unknown>>> {
    return await this.withLifecycleLock(async () => {
      const path = this.locate(binding);
      // Revocation of an ambient family is asserted by the ISSUER, not observable here; saying
      // otherwise would manufacture evidence. Families with an on-host artifact are really checked.
      if (path === null) return this.describe(binding, false);
      if (await this.system.pathExists(path)) {
        throw new WorkspaceHostOperationError(
          `credential.${binding.channel}.verify-revoked`,
          1,
          `material for family '${this.family}' is still present after revocation`,
        );
      }
      const agentFamily = this.agentFamily();
      if (agentFamily) {
        if (!this.agentHomeConsumer) {
          throw new WorkspaceHostOperationError(
            `credential.${binding.channel}.verify-revoked`,
            1,
            `no agent-home consumer is configured for family '${this.family}'`,
          );
        }
        await this.agentHomeConsumer.verifyRevoked(
          agentFamily,
          binding.generation,
          { lockHeld: true },
        );
      }
      await this.gitCredentialBindings?.verifyRevoked(binding, {
        lockHeld: true,
      });
      return this.describe(binding, false);
    });
  }
}

/** Where each family's delivered material lives on the host, or null when it is ambient. */
export const WORKSPACE_HOST_CREDENTIAL_MATERIAL_ROOT =
  "/var/lib/papercusp/credentials";

function materialPathFor(
  root: string,
  family: WorkspaceHostCredentialFamily,
): (binding: WorkspaceHostCredentialBindingDescriptor) => string | null {
  return (binding) => {
    // Derived from the family spec, never from a hard-coded family name (D-215): a family that is
    // answered ambiently by the environment has no file to check, and inventing one would make
    // bind() pass against a path we created ourselves. Keying on the spec means a fifth family
    // has to declare which it is instead of silently inheriting the wrong branch.
    if (
      !WORKSPACE_HOST_CREDENTIAL_FAMILY_SPECS[family].requiresDeliveredMaterial
    )
      return null;
    // The layout is owned by the delivery module — the writer and this reader must agree on the
    // path, and two `join` calls that happen to match today are how they stop matching later.
    return workspaceHostCredentialMaterialPath(
      root,
      family,
      binding.generation,
    );
  };
}

export function createProductionWorkspaceHostCredentialMaterializers(
  system: WorkspaceHostSystem,
  materialRoot: string = WORKSPACE_HOST_CREDENTIAL_MATERIAL_ROOT,
  gitCredentialBindings?: WorkspaceHostGitCredentialBindingRegistry,
  agentHomeConsumer?: WorkspaceHostAgentHomeConsumer,
): readonly WorkspaceHostCredentialMaterializer[] {
  const durableGitBindings =
    gitCredentialBindings ??
    new WorkspaceHostGitCredentialBindingRegistry(system, materialRoot);
  const durableAgentHome =
    agentHomeConsumer ??
    new WorkspaceHostAgentHomeConsumer({
      filesystem: system,
      materialRoot,
      // D-421: the customer workspace account runs every customer-driven agent.
      agentHome: WORKSPACE_HOST_DEFAULT_WORKSPACE_HOME,
      agentUser: DEFAULT_WORKSPACE_HOST_WORKSPACE_USER,
      agentGroup: DEFAULT_WORKSPACE_HOST_WORKSPACE_USER,
      legacyHomes: [{ home: WORKSPACE_HOST_DEFAULT_AGENT_HOME }],
    });
  // Enumerated explicitly rather than mapped over WORKSPACE_HOST_CREDENTIAL_FAMILIES: adding a
  // family should be a decision that lands here deliberately, not one that silently acquires a
  // default binding policy from a loop.
  const families: readonly WorkspaceHostCredentialFamily[] = [
    "cloud-workload-identity",
    "git-short-lived-delegation",
    "agent-forwarded-reference",
    "agent-encrypted-reference",
  ];
  return families.map(
    (family) =>
      new ProductionWorkspaceHostCredentialMaterializer(
        family,
        system,
        materialPathFor(materialRoot, family),
        durableGitBindings,
        durableAgentHome,
        // Only families with an on-host artifact have anything to revoke, so only they carry a
        // ledger. Passing one for an ambient family would create a revocation record for material
        // that never existed.
        WORKSPACE_HOST_CREDENTIAL_FAMILY_SPECS[family].requiresDeliveredMaterial
          ? async (generation: number) =>
              // Through the SAME `system` seam every other host operation uses. A second
              // filesystem here — even one defaulting to the real node implementation — means a
              // caller that faked the host still writes to the machine running it.
              await recordWorkspaceHostCredentialRevocation(
                system,
                materialRoot,
                family,
                generation,
                { lockHeld: true },
              )
          : undefined,
        WORKSPACE_HOST_CREDENTIAL_FAMILY_SPECS[family].requiresDeliveredMaterial
          ? workspaceHostCredentialFamilyLockPath(materialRoot, family)
          : undefined,
      ),
  );
}

export interface ProductionWorkspaceHostRemoteInitializerOptions extends ProductionWorkspaceHostOptions {}

/**
 * The single wiring the packaged executable uses.
 *
 * Keeping this here rather than in the bin file is what makes the bin a three-line program: the
 * dependency graph is assembled by code a test can call, and the only untested lines are the ones
 * that read `process.argv` and `process.stdin`.
 */
export function createProductionWorkspaceHostRemoteInitializerDeps(
  options: ProductionWorkspaceHostRemoteInitializerOptions = {},
): WorkspaceHostRemoteInitializerDeps {
  const system = options.system ?? new NodeWorkspaceHostSystem();
  const materialRoot =
    options.credentialMaterialRoot ?? WORKSPACE_HOST_CREDENTIAL_MATERIAL_ROOT;
  const workspaceUser =
    options.workspaceUser ?? DEFAULT_WORKSPACE_HOST_WORKSPACE_USER;
  const workspaceGroup = options.workspaceGroup ?? workspaceUser;
  const workspaceHome = options.workspaceHome ?? `/home/${workspaceUser}`;
  const agentUser = options.agentUser ?? DEFAULT_WORKSPACE_HOST_AGENT_USER;
  const agentGroup = options.agentGroup ?? agentUser;
  const agentHome = options.agentHome ?? `/home/${agentUser}`;
  const gitCredentialBindings =
    options.gitCredentialBindings ??
    new WorkspaceHostGitCredentialBindingRegistry(system, materialRoot);
  // The delivered Claude/Codex/OMP material lands in the CUSTOMER workspace account's 0700 home
  // (D-421): that account runs every customer-driven agent, and the probe runs as it, so a pass
  // proves the product path. The platform agent identity's home is where D-248 put the material;
  // it is a legacy location now, migrated away from on the next bind and swept on every revoke.
  //
  // The host is built FIRST: its constructor owns the identity-collapse refusal (agentUser ===
  // workspaceUser), which must win over the consumer's weaker "legacy home equals install home".
  const host = new ProductionWorkspaceHostRemoteInitializerHost({
    ...options,
    system,
    credentialMaterialRoot: materialRoot,
    workspaceHome,
    workspaceUser,
    workspaceGroup,
    agentHome,
    agentUser,
    agentGroup,
    gitCredentialBindings,
  });
  const agentHomeConsumer = new WorkspaceHostAgentHomeConsumer({
    filesystem: system,
    materialRoot,
    agentHome: workspaceHome,
    agentUser: workspaceUser,
    agentGroup: workspaceGroup,
    legacyHomes: [{ home: agentHome }],
  });
  return {
    host,
    credentials: new WorkspaceHostCredentialResolver(
      createProductionWorkspaceHostCredentialMaterializers(
        system,
        materialRoot,
        gitCredentialBindings,
        agentHomeConsumer,
      ),
    ),
    ...(options.now ? { now: options.now } : {}),
  };
}
