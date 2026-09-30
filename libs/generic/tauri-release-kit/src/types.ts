/**
 * @papercusp/tauri-release-kit — type surface (the seam contract).
 *
 * The kit owns the release *orchestration*; each app injects its *sidecar
 * build* via `buildSidecar` and supplies a `TauriReleaseConfig`. All side
 * effects go through the `Exec`/`Fs`/`Log` ports so the pure logic stays
 * unit-testable with in-memory doubles (mirrors @papercusp/deployment-driver).
 */

/**
 * Release channel — the vocabulary a CUT is made on.
 *
 * Broader than the set a user can switch between: `nightly` is a `side-by-side`
 * channel (its own bundle id, name and data home — see `./channels.js`), so it
 * is something you cut and install, never something you switch an existing
 * install to. Ask a `ChannelRegistry` for `updateLaneIds()` when the question is
 * "which lanes may this install move between".
 */
export type Channel = 'alpha' | 'beta' | 'stable' | 'nightly';

/**
 * Updater platform key — the keys Tauri's updater + the operator's
 * /api/updates/manifest understand. Open string so an app can add targets,
 * but the well-known set is enumerated for the default classifier.
 */
export type PlatformKey =
  | 'linux-x86_64'
  | 'linux-aarch64'
  | 'windows-x86_64'
  | 'darwin-universal'
  | 'darwin-x86_64'
  | 'darwin-aarch64'
  | (string & {});

/** Which build target driver to run. */
export type TargetKey =
  | 'linux-x86_64'
  | 'linux-aarch64'
  | 'windows-x86_64'
  | 'macos-universal'
  | (string & {});

// ── Ports (all side effects) ────────────────────────────────────────────────

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
}

/** Run external commands (tauri, cargo, gh, ssh, scp, …). */
export interface ExecPort {
  run(cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult>;
}

/** Filesystem access. Dep-free — no glob; drivers list known bundle dirs. */
export interface FsPort {
  readText(path: string): Promise<string>;
  writeText(path: string, data: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Basenames of entries in `dir`; resolves to [] if the dir is missing. */
  readDir(dir: string): Promise<string[]>;
  /** Create `dir` (and any missing parents) if it doesn't already exist — a
   *  no-op if it does (EI-7474: a driver downloading into a not-yet-created
   *  collectDir must call this FIRST, else the write silently fails/drops). */
  mkdir(dir: string): Promise<void>;
}

export interface LogPort {
  info(msg: string): void;
  warn(msg: string): void;
}

export interface ReleasePorts {
  exec: ExecPort;
  fs: FsPort;
  log: LogPort;
  /** Read an environment variable (e.g. the signing-key password). */
  env(name: string): string | undefined;
  /** Current time as an ISO string — injected so releases are testable. */
  now(): string;
}

// ── Config ──────────────────────────────────────────────────────────────────

/** A file whose version string the release bumps. */
export type VersionFile =
  /** A JSON file with a top-level (or dotted) version field; default field "version". */
  | { path: string; kind: 'json'; field?: string }
  /** A Cargo.toml — the first `version = "…"` line is rewritten. */
  | { path: string; kind: 'cargo-toml' };

export interface SigningConfig {
  /** Tauri minisign private key path (→ TAURI_SIGNING_PRIVATE_KEY, the v2 var). */
  keyPath: string;
  /** Env var holding the key password (→ TAURI_SIGNING_PRIVATE_KEY_PASSWORD). */
  passwordEnv?: string;
}

/** SSH frame for a remote (Mac/Windows) build host. */
export interface VmConfig {
  host: string;
  port: number;
  user: string;
  /** Path to the SSH identity (private key) file. */
  identityFile: string;
  /** Remote dir the tree is synced into and built in. */
  buildDir: string;
}

/** Context handed to the injected sidecar builder. */
export interface SidecarContext {
  /** The desktop app root (where src-tauri/ lives). */
  root: string;
  version: string;
  channel: Channel;
  ports: ReleasePorts;
}

/** The injected per-app seam: builds the sidecar payload into src-tauri/. */
export type BuildSidecar = (ctx: SidecarContext) => Promise<void>;

export interface TauriReleaseConfig {
  appName: string;
  appId: string;
  /** Desktop app root (contains package.json + src-tauri/). */
  root: string;
  repo: { owner: string; name: string };
  version: string;
  channel: Channel;
  /** Files whose version is bumped in lockstep. */
  versionFiles: VersionFile[];
  /**
   * Destination branch for the release commit + tag. Defaults to the branch
   * currently checked out, falling back to `main` when HEAD is DETACHED — the
   * normal state for a cut running in an ephemeral clone pinned to a sha, where
   * a bare `git push origin HEAD` can derive no destination and the bump is
   * silently lost with the throwaway clone.
   */
  releaseBranch?: string;
  /** Target drivers to run, in order. */
  targets: TargetKey[];
  signing: SigningConfig;
  /** App-specific sidecar build — the firewall between generic + app. */
  buildSidecar: BuildSidecar;
  /** Maps an artifact to its GitHub release download URL (for latest.json). */
  latestJsonUrl: (a: { tag: string; name: string }) => string;
  /** Override the default `desktop-vX.Y.Z[-channel]` tag scheme. */
  tagFor?: (version: string, channel: Channel) => string;
  /** Override the default Tauri-naming → PlatformKey classifier. */
  classifyArtifact?: (path: string) => PlatformKey | null;
  /** Per-target VM frame config (Mac/Windows). */
  vm?: Partial<Record<TargetKey, VmConfig>>;
  /**
   * Explicit cargo target directory override. Normally left unset — the Linux
   * driver resolves it via `cargo metadata` so it honors CARGO_TARGET_DIR and a
   * `[build] target-dir` in any .cargo/config.toml (e.g. this dev box redirects
   * all builds to ~/.cargo-target). Set only to force a specific dir.
   */
  cargoTargetDir?: string;
}

// ── Artifacts + driver registry ──────────────────────────────────────────────

export interface Artifact {
  /** Absolute path to the built file. */
  path: string;
  /** Basename, for the release upload + latest.json. */
  name: string;
  /** Updater platform key, if this artifact is an updater target. */
  platformKey?: PlatformKey;
  /** Path to the detached `.sig`, if signed. */
  sigPath?: string;
}

/** A build target driver — mirrors @papercusp/deployment-driver's shape. */
export interface TargetDriver {
  key: TargetKey;
  /** Build the target's artifacts; returns the collected files. */
  build(cfg: TauriReleaseConfig, ports: ReleasePorts): Promise<Artifact[]>;
}

// ── latest.json updater manifest ─────────────────────────────────────────────

export interface PlatformEntry {
  signature: string;
  url: string;
}

export interface LatestManifest {
  version: string;
  channel: Channel;
  notes: string;
  pub_date: string;
  platforms: Record<string, PlatformEntry>;
}
