/**
 * Install cloudflared for the "use my own tunnel" step (external-app-access P-009, D-001):
 * download Cloudflare's official release binary into `<papercusp data dir>/bin/`, where
 * runtime.resolveCloudflaredBinary looks first. Nothing is installed system-wide and no
 * elevated permission is needed.
 *
 * The download is verified by running `cloudflared --version` before it is moved into
 * place, so a truncated or wrong-architecture file never replaces a working binary.
 */
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { OwnTunnelInputError } from './config';
import { papercuspDataDir } from './runtime';

const execFileAsync = promisify(execFile);

export const CLOUDFLARED_RELEASE_BASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download';

export interface CloudflaredAsset {
  /** Release asset file name. */
  readonly asset: string;
  /** The asset is a gzip tarball holding a `cloudflared` binary (macOS). */
  readonly tarball: boolean;
  /** File name of the installed binary. */
  readonly exe: string;
}

/** Which release asset fits this platform, or null when Cloudflare ships none. */
export function cloudflaredAssetFor(platform: NodeJS.Platform, arch: string): CloudflaredAsset | null {
  const cpu = arch === 'x64' ? 'amd64' : arch === 'arm64' ? 'arm64' : arch === 'arm' ? 'arm' : arch === 'ia32' ? '386' : null;
  if (!cpu) return null;
  if (platform === 'linux') return { asset: `cloudflared-linux-${cpu}`, tarball: false, exe: 'cloudflared' };
  if (platform === 'darwin' && (cpu === 'amd64' || cpu === 'arm64')) {
    return { asset: `cloudflared-darwin-${cpu}.tgz`, tarball: true, exe: 'cloudflared' };
  }
  if (platform === 'win32' && (cpu === 'amd64' || cpu === '386')) {
    return { asset: `cloudflared-windows-${cpu}.exe`, tarball: false, exe: 'cloudflared.exe' };
  }
  return null;
}

export interface InstallCloudflaredOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly fetch?: typeof fetch;
  readonly baseUrl?: string;
  /** Runs a file and returns its stdout (tests replace it). */
  readonly run?: (file: string, args: string[], opts: { cwd?: string }) => Promise<string>;
}

async function defaultRun(file: string, args: string[], opts: { cwd?: string }): Promise<string> {
  const { stdout, stderr } = await execFileAsync(file, args, { cwd: opts.cwd, timeout: 30_000, maxBuffer: 1 << 20 });
  return `${stdout}${stderr}`;
}

export interface InstalledCloudflared {
  readonly path: string;
  readonly version: string;
}

/** Download, verify and install cloudflared. Returns the installed path and its version line. */
export async function installCloudflared(opts: InstallCloudflaredOptions = {}): Promise<InstalledCloudflared> {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const asset = cloudflaredAssetFor(platform, arch);
  if (!asset) {
    throw new OwnTunnelInputError('cloudflared_unsupported', `Cloudflare publishes no cloudflared build for ${platform}/${arch}`);
  }
  const run = opts.run ?? defaultRun;
  const binDir = path.join(papercuspDataDir(opts.env ?? process.env), 'bin');
  mkdirSync(binDir, { recursive: true });
  const work = mkdtempSync(path.join(binDir, '.cloudflared-download-'));
  try {
    const url = `${(opts.baseUrl ?? CLOUDFLARED_RELEASE_BASE).replace(/\/+$/, '')}/${asset.asset}`;
    const res = await (opts.fetch ?? fetch)(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`downloading ${asset.asset} failed: HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length < 1_000_000) throw new Error(`downloading ${asset.asset} returned only ${bytes.length} bytes`);

    let candidate: string;
    if (asset.tarball) {
      const tgz = path.join(work, asset.asset);
      writeFileSync(tgz, bytes);
      await run('tar', ['-xzf', tgz, '-C', work], { cwd: work });
      candidate = path.join(work, asset.exe);
    } else {
      candidate = path.join(work, asset.exe);
      writeFileSync(candidate, bytes);
    }
    chmodSync(candidate, 0o755);

    const out = await run(candidate, ['--version'], { cwd: work });
    const version = /cloudflared version \S+/.exec(out)?.[0];
    if (!version) throw new Error(`the downloaded cloudflared did not run (it printed: ${out.trim().slice(0, 200) || 'nothing'})`);

    const dest = path.join(binDir, asset.exe);
    renameSync(candidate, dest);
    return { path: dest, version };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
