/**
 * @papercusp/deployment-driver — the provider-agnostic deployment abstraction.
 *
 * `cloud-deployment-layer-2026-06-06` P-001 / D-002.
 *
 * "Deploying" a harness means moving its **execution plane** onto a **frame** (a
 * machine the driver controls) that joins the harness/Hive as a headless
 * federated peer. The abstraction is a `DeploymentDriver` with four verbs —
 * `provision` / `install` / `join` / `teardown` — over a `Frame` handle. `local`
 * is the trivial built-in driver (the machine is already here, so every verb is a
 * no-op); every cloud backend (`latitude`, `fly`, `hetzner`, …) implements the
 * SAME interface and registers via the `configure*()` seam, so "swap a Latitude
 * config in and it runs on Latitude" is one code path, different driver.
 *
 * This lib is generic + host-clean: it names no provider except `local`, depends
 * on nothing, and validates no provider-specific config (each driver narrows +
 * validates its own `provider` block). The papercusp-coupled pieces — the cloud
 * driver implementations and the harness/orchestrator wiring — live host-side and
 * plug in through `registerDeploymentDriver`.
 */

/**
 * Where a harness's execution plane runs. An OPEN discriminator: `'local'` is the
 * built-in; cloud backends register their own target strings (`'latitude'`,
 * `'fly'`, …). Kept a bare string (not a closed union) precisely so the lib stays
 * provider-agnostic — adding a backend never edits this type.
 */
export type DeploymentTarget = string;

/** Does a driver run the execution plane on THIS machine, or on a remote frame? */
export type DeploymentPlacement = 'local' | 'remote';

/** A frame's machine kind. `vm` (default for cloud) | `metal` (bare metal) | `local`. */
export type FrameKind = 'vm' | 'metal' | 'local';

/**
 * Frame desktop capability (opt-in): the frame stands up virtual X displays so
 * its agents can drive GUIs (browsers, Electron/Tauri apps), one isolated
 * display per concurrent agent. `true` takes the defaults; the object form
 * tunes the pool. A desktop is a frame *capability*, not a new kind of frame.
 */
export interface DesktopConfig {
  /** Number of virtual displays to stand up (one per concurrent GUI agent). */
  displays?: number;
  /** X geometry per display (e.g. `'1920x1080x24'`). */
  geometry?: string;
}

/**
 * Deployment config — a **sibling input to the blueprint** at instantiation
 * (D-001: NOT a blueprint property, since the blueprint must stay placement-
 * agnostic + Cupboard-distributable). `target` selects the driver; the rest is
 * the common envelope. Provider-specific fields go under `provider`, which the
 * selected driver narrows + validates.
 */
export interface DeploymentConfig {
  /** Selects the driver. `'local'` = run here (the default). */
  target: DeploymentTarget;
  /** Provider region (e.g. `'NYC'`, `'sao-paulo'`). Driver-specific vocabulary. */
  region?: string;
  /** Provider instance size / plan slug. Driver-specific. */
  size?: string;
  /** VM (default) vs bare metal, where the provider offers both. */
  kind?: FrameKind;
  /**
   * Opaque reference to the credential bundle to mount on the frame (e.g. a
   * Claude subscription with its own rate limits — P-011). A REFERENCE the host
   * resolves, never the secret itself, so configs are safe to persist/federate.
   */
  credentialRef?: string;
  /**
   * Logical id of the account whose `credentialRef` this is (cloud-deployment-layer
   * Phase 7, P-019/P-020). When the host runs an account pool, deploy-time selection
   * stamps this alongside `credentialRef`; the frame exports it so its rate governor
   * keys per-account. A label, not a secret. Absent ⇒ unpooled / a single account.
   */
  accountId?: string;
  /** Opt-in frame desktop capability (virtual X displays for GUI agents). */
  desktop?: boolean | DesktopConfig;
  /** Provider-specific extras a driver narrows + validates (e.g. Latitude project id). */
  provider?: Record<string, unknown>;
}

/** The canonical local config — the well-defined no-op deployment (P-002). */
export const LOCAL_DEPLOYMENT: DeploymentConfig = { target: 'local' };

/**
 * A handle to a provisioned execution frame — the machine a driver controls.
 * Returned by `provision` and threaded through `install` / `join` / `teardown`.
 * Persisted host-side so teardown can find what to destroy across process
 * restarts (the frame outlives the operator process that created it).
 */
export interface Frame {
  /** Stable id within the provider (e.g. the Latitude server id). `'local'` for LocalDriver. */
  id: string;
  /** The driver target that owns this frame. */
  target: DeploymentTarget;
  /** Local (this machine) vs remote (a provisioned box). */
  placement: DeploymentPlacement;
  /** Reachable host / IP once provisioned, if any. */
  host?: string;
  /**
   * The harness sidecar's CALLABLE HTTP port on this frame — where the operator
   * dispatches harness-provided ops (`harness-provided-cadence-ops-2026-06-26`
   * P-004 / D-001). A deployed harness runs its own runtime (sidecar) listening
   * on this port; a proxy CoordOp's `run()` POSTs `/api/op/<name>` to
   * `http://{host}:{callablePort}`. The lib never reads it; the operator's
   * `harnessApiBase` does. Absent ⇒ the frame exposes no callable op endpoint
   * (a non-op harness, or the LOCAL path which uses the sidecar's advertised
   * `localEndpoint` instead).
   */
  callablePort?: number;
  kind?: FrameKind;
  region?: string;
  /**
   * Provider-specific opaque state the driver round-trips (terraform output, SSH
   * key id, billing handle, …). The lib never reads it; only the owning driver does.
   */
  meta?: Record<string, unknown>;
}

/** A background service to supervise on the frame (generic: a name + command). */
export interface FrameService {
  name: string;
  command: string;
  port?: number;
  healthcheck?: string;
}

/**
 * Host-assembled bootstrap inputs for `install()` — deliberately GENERIC (shell
 * commands + a repo + env + a credential file path), so the lib stays host-clean.
 * The host (operator) maps its blueprint's environment spec + the harness repo +
 * the resolved credential bundle onto this; the driver turns it into whatever the
 * provider needs (an SSH-run bootstrap script, cloud-init user-data, …).
 */
export interface FrameBootstrapInput {
  /** Git URL of the repo to clone on the frame (omit for a repo-less harness). */
  repoUrl?: string;
  repoRef?: string;
  setup?: string[];
  install?: string[];
  build?: string[];
  run?: string[];
  services?: FrameService[];
  ports?: number[];
  /** NON-SECRET env to export for the run. */
  env?: Record<string, string>;
  /** Local path to the credential bundle to stage on the frame (e.g. a Claude sub). */
  credentialsLocalPath?: string;
  /** Logical id of the account this frame's credential belongs to — exported on the
   *  frame as `PAPERCUSP_ACCOUNT_ID` so its rate governor buckets per-account (P-019).
   *  A label, not a secret; omit for an unpooled single-account frame. */
  accountId?: string;
  /** Local path to a long-lived OAuth token file (`claude setup-token` output) to
   *  stage on the frame and export as `CLAUDE_CODE_OAUTH_TOKEN` — the headless
   *  alternative to a `.credentials.json` bundle (no refresh-rotation races,
   *  ~1-year validity, one interactive mint instead of per-expiry logins). */
  oauthTokenLocalPath?: string;
  /** Local path to an operator-packed runtime tarball to stage on the frame. When
   *  set, the frame untars this instead of `git clone`-ing the runtime — required
   *  when the runtime repo is private (an anonymous clone can never work) and
   *  avoids shipping any git credential to the frame. */
  runtimeTarballLocalPath?: string;
  /** The harness's per-install INSTANCE config as JSON — delivered to the frame's
   *  runtime via the `HARNESS_CONFIG_JSON` env-transport (the frame has no local
   *  config.json file). Host-assembled from workspace PG. */
  instanceConfigJson?: string;
  /** This frame is a control node (the Queen) — supervises across frames rather
   *  than running a single harness's execution. */
  controlNode?: boolean;
}

/** Severity for the injected logger. */
export type LogLevel = 'info' | 'warn' | 'error';

/**
 * Per-call context the host supplies to a driver: which harness/workspace the
 * frame serves, an optional structured logger, and an abort signal for
 * long-running provisions/teardowns. Host-clean — no papercusp types leak in.
 */
export interface DeploymentContext {
  /** Harness slug the frame serves. */
  harnessSlug: string;
  /** Workspace id the harness belongs to. */
  workspaceId: string;
  /** Structured logger (host-injected). No-op if omitted. */
  log?: (level: LogLevel, msg: string, extra?: Record<string, unknown>) => void;
  /** Abort signal for long-running provision/teardown. */
  signal?: AbortSignal;
  /** Host-assembled bootstrap inputs for `install()` (repo + env-spec commands +
   *  credential file). The host populates this; cloud drivers consume it. */
  bootstrap?: FrameBootstrapInput;
}

/**
 * The provider-agnostic deployment contract (D-002). `LocalDriver` is the trivial
 * no-op; every cloud backend implements the same four verbs over a `Frame`.
 *
 * Lifecycle: `provision` (acquire the machine) → `install` (bootstrap the
 * papercusp runtime on it) → `join` (admit it as a federated peer) → run →
 * `teardown` (DESTROY for cloud, to end billing). The verbs are idempotent where
 * feasible so a retried deploy/teardown converges.
 */
export interface DeploymentDriver {
  /** The target discriminator this driver handles (e.g. `'local'`, `'latitude'`). */
  readonly target: DeploymentTarget;
  /** Does this driver run the execution plane here (`'local'`) or on a remote frame? */
  readonly placement: DeploymentPlacement;
  /** Acquire/realize a frame. Local: a no-op returning the local frame handle. */
  provision(config: DeploymentConfig, ctx: DeploymentContext): Promise<Frame>;
  /** Bootstrap the papercusp runtime on the frame. Local: no-op (already installed). */
  install(frame: Frame, config: DeploymentConfig, ctx: DeploymentContext): Promise<void>;
  /** Join the frame to the harness/Hive as a federated peer. Local: no-op (already a peer). */
  join(frame: Frame, config: DeploymentConfig, ctx: DeploymentContext): Promise<void>;
  /**
   * Tear down the frame. For cloud this DESTROYS the machine (not stop) to end
   * billing (P-012/P-017). Local: no-op (the machine stays — it is the user's).
   */
  teardown(frame: Frame, config: DeploymentConfig, ctx: DeploymentContext): Promise<void>;
}
