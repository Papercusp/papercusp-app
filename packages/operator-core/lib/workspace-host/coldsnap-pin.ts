/**
 * coldsnap pin — the one place the AWS AMI release path decides which `coldsnap` it runs (WI-10005642).
 *
 * coldsnap (awslabs, Rust) uploads a bake disk into an EBS snapshot and downloads a candidate AMI's
 * root snapshot for the offline scan. Before this module it was installed by hand with
 * `cargo install --locked coldsnap` into ~/.cargo/bin — unpinned, unverified, and absent from the
 * systemd PATH, so the release CLI only worked from an interactive shell.
 *
 * The pin is the crates.io crate checksum (the `cksum` field of the crates.io index line for this
 * version — the same digest cargo itself verifies). The crate ships its own Cargo.lock, so
 * `cargo install --locked --path <unpacked crate>` reproduces the exact dependency set, each
 * dependency checksum-verified by cargo against that lockfile.
 *
 * Install root: ~/.papercusp/tools/coldsnap/<version>/bin/coldsnap, versioned so a pin bump installs
 * beside the old binary instead of overwriting the one a running release may be executing.
 *
 * Resolution order used by every AWS release entry point (resolveColdsnapExecutable):
 *   1. PAPERCUSP_AWS_COLDSNAP_EXECUTABLE — an operator's explicit override always wins;
 *   2. the pinned binary under $HOME, when installed and executable;
 *   3. undefined — the adapter falls back to bare `coldsnap` on PATH (its historical behaviour).
 * The release preflight (probeAwsAmiExecutables) then reports a missing binary read-only.
 */
import { createHash } from 'node:crypto';
import { accessSync, constants as fsConstants } from 'node:fs';
import { join } from 'node:path';

export interface ColdsnapPin {
  readonly version: string;
  /** sha256 of the published .crate file, as listed in the crates.io index `cksum` field. */
  readonly crateSha256: string;
}

export const COLDSNAP_PIN: ColdsnapPin = Object.freeze({
  version: '0.12.0',
  crateSha256: '731bf6e1fac9ccf757e67b1732f1eac1f253f14e4a8e85fb94b5bf326777e798',
});

export const COLDSNAP_EXECUTABLE_ENV = 'PAPERCUSP_AWS_COLDSNAP_EXECUTABLE';
/** The scan bin's own override name (papercusp-aws-ami-scan.mjs TOOL_ENV.coldsnap). */
export const AWS_AMI_SCAN_COLDSNAP_ENV = 'PAPERCUSP_AWS_AMI_SCAN_COLDSNAP';
const STAMP_FILE = 'papercusp-coldsnap.json';

export function coldsnapCrateUrl(pin: ColdsnapPin = COLDSNAP_PIN): string {
  return `https://static.crates.io/crates/coldsnap/coldsnap-${pin.version}.crate`;
}

export function pinnedColdsnapRoot(home: string, pin: ColdsnapPin = COLDSNAP_PIN): string {
  return join(home, '.papercusp', 'tools', 'coldsnap', pin.version);
}

export function pinnedColdsnapExecutable(home: string, pin: ColdsnapPin = COLDSNAP_PIN): string {
  return join(pinnedColdsnapRoot(home, pin), 'bin', 'coldsnap');
}

function isExecutableSync(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The coldsnap executable an AWS release entry point should use, or undefined for the adapter's
 * PATH default. HOME is read from the SAME env object the caller passes, never os.homedir(), so a
 * caller that hands in an explicit env (tests, a sanitised child env) gets a deterministic answer.
 */
export function resolveColdsnapExecutable(
  env: NodeJS.ProcessEnv,
  isExecutable: (path: string) => boolean = isExecutableSync,
  pin: ColdsnapPin = COLDSNAP_PIN,
): string | undefined {
  const override = env[COLDSNAP_EXECUTABLE_ENV]?.trim();
  if (override) return override;
  const home = env.HOME?.trim();
  if (!home) return undefined;
  const pinned = pinnedColdsnapExecutable(home, pin);
  return isExecutable(pinned) ? pinned : undefined;
}

/** The `coldsnapExecutable` composition option for an AWS release entry point (spread into its options). */
export function coldsnapCompositionOption(
  env: NodeJS.ProcessEnv,
  isExecutable?: (path: string) => boolean,
): { coldsnapExecutable?: string } {
  const executable = resolveColdsnapExecutable(env, isExecutable);
  return executable ? { coldsnapExecutable: executable } : {};
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function assertCrateChecksum(bytes: Uint8Array, pin: ColdsnapPin = COLDSNAP_PIN): void {
  const actual = sha256Hex(bytes);
  if (actual !== pin.crateSha256) {
    throw new Error(
      `coldsnap ${pin.version} crate checksum mismatch: expected ${pin.crateSha256}, got ${actual} — refusing to build it`,
    );
  }
}

export interface ColdsnapRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface ColdsnapInstallDeps {
  fetchBytes(url: string): Promise<Uint8Array>;
  run(command: string, args: readonly string[], options?: { cwd?: string }): ColdsnapRunResult;
  makeTempDir(): Promise<string>;
  removeDir(path: string): Promise<void>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  readFile(path: string): Promise<string | undefined>;
  isExecutable(path: string): boolean;
  now(): Date;
}

export interface ColdsnapInstallResult {
  status: 'already-installed' | 'installed';
  version: string;
  executable: string;
  crateSha256: string;
}

interface ColdsnapStamp {
  version: string;
  crateSha256: string;
  installedAt: string;
}

function parseStamp(text: string | undefined): ColdsnapStamp | undefined {
  if (!text) return undefined;
  try {
    const value = JSON.parse(text) as Partial<ColdsnapStamp>;
    return typeof value.version === 'string' && typeof value.crateSha256 === 'string'
      && typeof value.installedAt === 'string' && Number.isFinite(Date.parse(value.installedAt))
      ? { version: value.version, crateSha256: value.crateSha256, installedAt: value.installedAt }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Read-only: is the pinned binary present, executable, and stamped with THIS pin? */
export async function inspectPinnedColdsnap(
  home: string,
  deps: Pick<ColdsnapInstallDeps, 'readFile' | 'isExecutable'>,
  pin: ColdsnapPin = COLDSNAP_PIN,
): Promise<{ installed: boolean; executable: string; reason?: string }> {
  const executable = pinnedColdsnapExecutable(home, pin);
  if (!deps.isExecutable(executable)) return { installed: false, executable, reason: 'binary missing or not executable' };
  const stamp = parseStamp(await deps.readFile(join(pinnedColdsnapRoot(home, pin), STAMP_FILE)));
  if (!stamp) return { installed: false, executable, reason: 'install stamp missing or unreadable' };
  if (stamp.version !== pin.version || stamp.crateSha256 !== pin.crateSha256) {
    return { installed: false, executable, reason: `stamp records ${stamp.version}/${stamp.crateSha256}, pin is ${pin.version}/${pin.crateSha256}` };
  }
  return { installed: true, executable };
}

function runOrThrow(deps: ColdsnapInstallDeps, command: string, args: readonly string[], cwd?: string): void {
  const result = deps.run(command, args, cwd ? { cwd } : undefined);
  if (result.status !== 0) {
    const tail = `${result.stderr}\n${result.stdout}`.trim().split('\n').slice(-12).join('\n');
    throw new Error(`${command} ${args.join(' ')} exited ${result.status}:\n${tail}`);
  }
}

/**
 * Download the pinned crate, verify its checksum BEFORE anything is unpacked or built, then
 * `cargo install --locked` it into the versioned root and write the stamp last — a crash mid-build
 * leaves no stamp, so the next run rebuilds instead of trusting a half-installed binary.
 */
export async function installPinnedColdsnap(
  home: string,
  deps: ColdsnapInstallDeps,
  options: { cargo?: string; pin?: ColdsnapPin } = {},
): Promise<ColdsnapInstallResult> {
  const pin = options.pin ?? COLDSNAP_PIN;
  const current = await inspectPinnedColdsnap(home, deps, pin);
  if (current.installed) {
    return { status: 'already-installed', version: pin.version, executable: current.executable, crateSha256: pin.crateSha256 };
  }
  const bytes = await deps.fetchBytes(coldsnapCrateUrl(pin));
  assertCrateChecksum(bytes, pin);
  const work = await deps.makeTempDir();
  try {
    const cratePath = join(work, `coldsnap-${pin.version}.crate`);
    await deps.writeFile(cratePath, bytes);
    runOrThrow(deps, 'tar', ['-xzf', cratePath, '-C', work]);
    const root = pinnedColdsnapRoot(home, pin);
    runOrThrow(deps, options.cargo ?? 'cargo', [
      'install',
      '--locked',
      '--force',
      '--path',
      join(work, `coldsnap-${pin.version}`),
      '--root',
      root,
    ]);
    const executable = pinnedColdsnapExecutable(home, pin);
    if (!deps.isExecutable(executable)) throw new Error(`cargo install finished but ${executable} is not executable`);
    const stamp: ColdsnapStamp = { version: pin.version, crateSha256: pin.crateSha256, installedAt: deps.now().toISOString() };
    await deps.writeFile(join(root, STAMP_FILE), `${JSON.stringify(stamp, null, 2)}\n`);
    return { status: 'installed', version: pin.version, executable, crateSha256: pin.crateSha256 };
  } finally {
    await deps.removeDir(work);
  }
}
