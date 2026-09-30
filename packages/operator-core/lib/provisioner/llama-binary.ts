/**
 * provisioner/llama-binary — on-demand llama-server BINARY provisioning per platform
 * (local-concurrent-inference-2026-07-02 D-009 #2, WI-1617).
 *
 * Resolves (os, gpu-vendor, cuda-version) -> a llama.cpp GitHub-release prebuilt asset
 * when one matches; falls back to build-from-source using the PROVEN recipe this exact
 * box already used to serve ornith-35b (WI-1590 P-001), verified against the box's live
 * build (`/home/dev/llama.cpp/build`):
 *   - CMAKE_CUDA_ARCHITECTURES pinned to the detected GPU's compute capability
 *     (this box's RTX 3090 = 86; CMakeCache.txt confirms `CMAKE_CUDA_ARCHITECTURES:UNINITIALIZED=86`).
 *   - CUDA host compiler pinned to gcc-12/g++-12 via `-DCMAKE_CUDA_HOST_COMPILER=/usr/bin/g++-12`
 *     — nvcc 12.0 does not support this distro's default gcc-13 as a CUDA host compiler.
 *     Confirmed both by ggml/src/ggml-cuda/CMakeLists.txt (reads CMAKE_CUDA_HOST_COMPILER and
 *     appends `-ccbin` to the nvcc invocation) and by the box's own compile_commands.json
 *     (`nvcc -ccbin=/usr/bin/g++-12 ... --generate-code=arch=compute_86,code=[compute_86,sm_86]`).
 *   - `-DGGML_CUDA=ON -DCMAKE_BUILD_TYPE=Release`.
 *
 * Cache layout: `~/.papercusp/backends/llama-server/<version>/<platform-key>/`
 *   - `llama-server` (or `llama-server.exe` on Windows) — the resolved/built binary, copied
 *     (not symlinked, so a later `rm -rf` of the build workspace can't orphan the cache entry).
 *   - `manifest.json` — `{ version, platformKey, source, sha256, builtAt }`, re-verified
 *     (re-hashed) on every cache-hit lookup so local corruption never silently serves a bad
 *     binary — a mismatch is treated as a cache miss and the binary is re-provisioned.
 *
 * llama.cpp does NOT currently publish GPU-accelerated Linux binaries in its GitHub Releases
 * (only a CPU-only `-bin-ubuntu-x64.zip`) — this is corroborated directly by this box's own
 * history: WI-1590 had to build from source despite being exactly this platform (Linux) + an
 * NVIDIA GPU. `assetNameRules`/`pickPrebuiltAsset` encode the real (as of writing) release
 * asset naming convention as a small, independently-testable, DATA-DRIVEN table rather than a
 * hardcoded "Linux+NVIDIA always builds" rule — so this self-corrects if llama.cpp ever starts
 * shipping an accelerated Linux asset; until then a Linux+NVIDIA/AMD box simply keeps falling
 * through to the (already-proven, already-working) build-from-source path, exactly as today.
 *
 * Scope boundary: this module produces a `binPath` (a `renderLlamaServerUnit({binPath})` input)
 * — it never starts the server, loads a model onto the GPU, or writes to
 * `harness_shared.local_backends`. Those remain provision.ts's job (`applyProvision`, gated
 * behind `opts.start`, unchanged) — `planProvision()` now calls into this module to resolve
 * `binPath` instead of relying on a bare `llama-server` already being on PATH.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, readFile, rm, chmod, readdir, copyFile, stat as fsStat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join, dirname } from 'node:path';
import * as os from 'node:os';
import type { DetectedHardware, GpuVendor } from './hardware-detect';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------------------
// Platform resolution (pure)
// ---------------------------------------------------------------------------------------

export type LlamaOs = 'linux' | 'darwin' | 'win32';
export type LlamaArch = 'x64' | 'arm64';

export interface PlatformSpec {
  os: LlamaOs;
  arch: LlamaArch;
  /** 'none' = no GPU detected; 'unknown' = a GPU was detected but its vendor tooling isn't
   *  one llama.cpp's release/build system targets (treated like 'none' for matching purposes). */
  gpuVendor: GpuVendor | 'none';
  /** CUDA toolkit major.minor (e.g. "12.4"), only meaningful when gpuVendor === 'nvidia'. */
  cudaVersion?: string;
}

/** Deterministic, filesystem-safe cache-dir key for a PlatformSpec. Pure. */
export function platformKeyFor(spec: PlatformSpec): string {
  const gpuPart =
    spec.gpuVendor === 'nvidia'
      ? `cuda${spec.cudaVersion ? '-' + spec.cudaVersion.replace(/\./g, '') : ''}`
      : spec.gpuVendor === 'amd'
        ? 'hip'
        : spec.gpuVendor === 'apple'
          ? 'metal'
          : 'cpu';
  return `${spec.os}-${spec.arch}-${gpuPart}`;
}

/** Derive a PlatformSpec from detected hardware (+ an optional probed CUDA toolkit version).
 *  Pure, total — every DetectedHardware maps to a spec (AMD/unknown vendors fall through to
 *  'cpu' for llama.cpp binary-provisioning purposes; the catalog/recommend.ts layer is what
 *  decides whether a combo is offered at all). */
export function derivePlatformSpec(hw: DetectedHardware, cudaVersion?: string): PlatformSpec {
  const os: LlamaOs = hw.platform === 'win32' ? 'win32' : hw.platform === 'darwin' ? 'darwin' : 'linux';
  const arch: LlamaArch = hw.arch === 'arm64' ? 'arm64' : 'x64';
  const gpuVendor: PlatformSpec['gpuVendor'] = hw.gpu?.vendor ?? 'none';
  return { os, arch, gpuVendor, cudaVersion: gpuVendor === 'nvidia' ? cudaVersion : undefined };
}

export type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

async function defaultExec(cmd: string, args: string[], timeoutMs = 15000): Promise<{ stdout: string; stderr: string }> {
  const r = await execFileAsync(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  return { stdout: r.stdout, stderr: r.stderr };
}

/** Best-effort probe of the installed CUDA toolkit version via `nvcc --version`. Never throws
 *  — returns undefined on any failure (no nvcc on PATH, parse miss). Injectable exec for tests. */
export async function detectCudaVersion(exec: ExecFn = (c, a) => defaultExec(c, a)): Promise<string | undefined> {
  try {
    const { stdout } = await exec('nvcc', ['--version']);
    const m = stdout.match(/release (\d+\.\d+)/i);
    return m?.[1];
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------
// GitHub release asset matching (pure)
// ---------------------------------------------------------------------------------------

export interface GhReleaseAsset {
  name: string;
  browser_download_url: string;
  size?: number;
}
export interface GhRelease {
  tag_name: string;
  assets: GhReleaseAsset[];
  prerelease?: boolean;
  draft?: boolean;
}

export const LLAMA_CPP_REPO = 'ggml-org/llama.cpp';
export const LLAMA_CPP_CLONE_URL = 'https://github.com/ggml-org/llama.cpp.git';

/**
 * Ordered (most-specific-first) name-fragment rules a release asset must satisfy for a given
 * PlatformSpec, per llama.cpp's `llama-<tag>-bin-<os>[-<accel>]-<arch>.zip` release-asset
 * naming convention. Each rule is a list of substrings that must ALL appear (case-insensitive)
 * in the asset's filename; the FIRST rule with a matching asset wins. An EMPTY rule list means
 * "llama.cpp does not currently publish a prebuilt asset for this platform+GPU combo" — the
 * caller falls back to build-from-source rather than guessing at a wrong/incompatible binary.
 */
export function assetNameRules(spec: PlatformSpec): readonly (readonly string[])[] {
  switch (spec.os) {
    case 'darwin':
      // Metal is compiled into every macOS release build — no separate GPU-variant asset to pick.
      return spec.arch === 'arm64' ? [['macos', 'arm64']] : [['macos', 'x64']];
    case 'win32':
      if (spec.gpuVendor === 'nvidia') {
        // CUDA builds are versioned by toolkit release (e.g. "cu12.4"). Try an exact match on
        // the detected toolkit version first, then fall back to ANY published cuda build —
        // llama-server's CUDA runtime deps are usually forward/backward compatible across
        // minor bumps, so a close-enough cuda asset beats forcing a from-source build.
        const rules: string[][] = [];
        if (spec.cudaVersion) rules.push(['win', 'cuda', `cu${spec.cudaVersion}`]);
        rules.push(['win', 'cuda']);
        return rules;
      }
      if (spec.gpuVendor === 'amd') return [['win', 'hip']];
      return [['win', 'avx2'], ['win', 'cpu']];
    case 'linux':
    default:
      // llama.cpp's Linux release asset ("llama-<tag>-bin-ubuntu-x64.zip") is CPU-only as of
      // writing — no CUDA/HIP/Vulkan variant is published for Linux (see this module's header
      // comment: corroborated by WI-1590's own build-from-source necessity on this exact
      // platform+GPU combo). An nvidia/amd Linux spec therefore has NO rule here on purpose.
      return spec.gpuVendor === 'none' || spec.gpuVendor === 'unknown' ? [['ubuntu', 'x64'], ['linux', 'x64']] : [];
  }
}

/** Generic rules→asset matcher (first rule with a matching .zip/.tar.gz asset wins). Pure.
 *  Shared with whisper-binary.ts, whose release-asset naming differs only in the rule table. */
export function pickAssetByRules(release: GhRelease, rules: readonly (readonly string[])[]): GhReleaseAsset | null {
  for (const rule of rules) {
    const hit = release.assets.find((a) => {
      const name = a.name.toLowerCase();
      return rule.every((frag) => name.includes(frag)) && (name.endsWith('.zip') || name.endsWith('.tar.gz'));
    });
    if (hit) return hit;
  }
  return null;
}

/** Pick the best-matching prebuilt asset for `spec` from a release's assets, or null when
 *  llama.cpp doesn't publish one for this platform+GPU combo. Pure, no I/O. */
export function pickPrebuiltAsset(release: GhRelease, spec: PlatformSpec): GhReleaseAsset | null {
  return pickAssetByRules(release, assetNameRules(spec));
}

/** The newest non-draft, non-prerelease release with at least one asset (assumes newest-first
 *  input, matching GitHub's default `/releases` ordering — the real API's default). Pure. */
export function pickLatestRelease(releases: readonly GhRelease[]): GhRelease | null {
  return releases.find((r) => !r.draft && !r.prerelease && r.assets.length > 0) ?? null;
}

// ---------------------------------------------------------------------------------------
// Build-from-source (pure command generation)
// ---------------------------------------------------------------------------------------

export interface CudaBuildOptions {
  sourceDir: string;
  buildDir: string;
  /** CMAKE_CUDA_ARCHITECTURES value, e.g. "86" for this box's RTX 3090 (compute capability 8.6). */
  cudaArch: string;
  /** CUDA host-compiler binary to pin nvcc's `-ccbin` to (WI-1590's proven recipe: gcc-12/g++-12
   *  — newer distro-default gcc/g++ versions are frequently unsupported by a given CUDA toolkit
   *  release as a host compiler). Omit to let cmake/nvcc pick a default (only safe when the
   *  distro's default gcc is already CUDA-compatible). */
  cudaHostCompiler?: string;
  jobs: number;
}

/** Render the cmake configure + build argv pair for the proven CUDA/gcc-12/arch86 recipe
 *  (generalized to whatever cudaArch/cudaHostCompiler this box's hardware needs). Pure —
 *  returns argv arrays; the caller runs them via the injected exec. */
export function cudaBuildCommands(opts: CudaBuildOptions): readonly (readonly string[])[] {
  const configureArgs = [
    '-S',
    opts.sourceDir,
    '-B',
    opts.buildDir,
    '-DCMAKE_BUILD_TYPE=Release',
    '-DGGML_CUDA=ON',
    `-DCMAKE_CUDA_ARCHITECTURES=${opts.cudaArch}`,
  ];
  if (opts.cudaHostCompiler) configureArgs.push(`-DCMAKE_CUDA_HOST_COMPILER=${opts.cudaHostCompiler}`);
  return [
    ['cmake', ...configureArgs],
    ['cmake', '--build', opts.buildDir, '--config', 'Release', '-j', String(opts.jobs)],
  ];
}

/** Map an NVIDIA compute-capability string ("8.6") reported by nvidia-smi to the
 *  CMAKE_CUDA_ARCHITECTURES value llama.cpp's build expects ("86", no dot). Pure. */
export function computeCapToArch(computeCap: string): string {
  return computeCap.replace(/\./g, '').trim();
}

// ---------------------------------------------------------------------------------------
// Orchestration (I/O — every effect is injectable; real defaults mirror provision.ts's pattern)
// ---------------------------------------------------------------------------------------

export interface LlamaBinaryManifest {
  version: string;
  platformKey: string;
  source: 'prebuilt' | 'source-build';
  sha256: string;
  builtAt: string;
}

export interface ResolveLlamaBinaryResult {
  ok: boolean;
  binPath?: string;
  manifest?: LlamaBinaryManifest;
  /** true iff this result came from an already-provisioned, integrity-reverified cache entry
   *  (no network / no build ran this call). */
  fromCache?: boolean;
  /** Non-null iff provisioning could not complete (network unreachable, no matching release,
   *  a build-tooling probe failed, ...). Surfaced verbatim by CLI/UI callers. */
  blocked?: string;
}

export interface LlamaBinaryDeps {
  /** GitHub releases for LLAMA_CPP_REPO, newest-first (matches the real API's default order).
   *  Default: an unauthenticated `api.github.com` fetch (subject to the same 60/hr rate limit
   *  as updates-manifest.ts — set GITHUB_TOKEN to raise it). */
  fetchReleases?: () => Promise<GhRelease[]>;
  exists?: (p: string) => boolean;
  mkdir?: (p: string) => Promise<void>;
  readFile?: (p: string) => Promise<string>;
  writeFile?: (p: string, content: string) => Promise<void>;
  /** Compute the sha256 of a file already on disk (for cache re-verification). */
  hashFile?: (p: string) => Promise<string>;
  /** Download `url` to `destPath`, returning the sha256 of what landed. No resume/retry beyond
   *  what `fetch` itself gives — release archives here are tens of MB, not multi-GB weights
   *  (unlike @papercusp/resumable-download, which model-weight downloads use instead; see
   *  EI-6686 for why this module doesn't depend on that lib yet). */
  download?: (url: string, destPath: string) => Promise<{ bytesWritten: number; sha256: string }>;
  /** Extract a downloaded .zip/.tar.gz into a directory. Default shells out to `unzip`/`tar`
   *  (both present on every target platform's base image). */
  extract?: (archivePath: string, destDir: string) => Promise<void>;
  exec?: ExecFn;
  now?: () => string;
  home?: string;
  /** Root of the (shared-across-versions) llama.cpp source checkout used for a from-source
   *  build. Default `${home}/.papercusp/backends/llama-server/_src/llama.cpp`. */
  sourceDir?: string;
  jobs?: number;
}

function defaultHome(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? '';
}

async function defaultHashFile(p: string): Promise<string> {
  const buf = await readFile(p);
  return createHash('sha256').update(buf).digest('hex');
}

async function defaultDownload(url: string, destPath: string): Promise<{ bytesWritten: number; sha256: string }> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`llama-binary: download failed HTTP ${res.status} for ${url}`);
  await mkdir(dirname(destPath), { recursive: true });
  const hasher = createHash('sha256');
  const chunks: Uint8Array[] = [];
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    const buf = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBufferLike);
    hasher.update(buf);
    chunks.push(buf);
  }
  const full = Buffer.concat(chunks);
  await writeFile(destPath, full);
  return { bytesWritten: full.byteLength, sha256: hasher.digest('hex') };
}

async function defaultExtract(archivePath: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  if (archivePath.endsWith('.zip')) {
    await execFileAsync('unzip', ['-o', archivePath, '-d', destDir], { timeout: 60000 });
  } else if (archivePath.endsWith('.tar.gz') || archivePath.endsWith('.tgz')) {
    await execFileAsync('tar', ['-xzf', archivePath, '-C', destDir], { timeout: 60000 });
  } else {
    throw new Error(`llama-binary: don't know how to extract '${archivePath}' (expected .zip or .tar.gz)`);
  }
}

async function defaultFetchReleases(): Promise<GhRelease[]> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com/repos/${LLAMA_CPP_REPO}/releases?per_page=10`, { headers });
  if (!res.ok) throw new Error(`llama-binary: github releases fetch failed HTTP ${res.status}`);
  return (await res.json()) as GhRelease[];
}

/** Recursively find a file named `binName` under `dir` (bounded depth — release archives and
 *  our own build dirs are shallow). Returns the first match or null.
 *  Exported for reuse by whisper-binary.ts (same archive/build-dir shapes). */
export async function findBinaryUnder(dir: string, binName: string, depth = 4): Promise<string | null> {
  if (depth < 0) return null;
  let entries: Dirent<string>[];
  try {
    entries = await readdir(dir, { withFileTypes: true, encoding: 'utf8' });
  } catch {
    return null;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isFile() && e.name === binName) return full;
    if (e.isDirectory()) {
      const hit = await findBinaryUnder(full, binName, depth - 1);
      if (hit) return hit;
    }
  }
  return null;
}

function binaryName(os: LlamaOs): string {
  return os === 'win32' ? 'llama-server.exe' : 'llama-server';
}

/**
 * Resolve a working `llama-server` binary for `hw`: a cache hit (integrity-reverified), else a
 * matching GitHub-release prebuilt asset (downloaded + extracted + cached), else a from-source
 * build using the proven CUDA/gcc-12/arch86 recipe (cudaArch/cudaHostCompiler are read from
 * `hw`/`opts` — never hardcoded to THIS box's exact values, so a different NVIDIA card or a
 * distro with a CUDA-compatible default gcc resolves correctly too).
 *
 * Every I/O effect is injectable (`LlamaBinaryDeps`) — with no opts this hits the real
 * network/filesystem/toolchain, matching provision.ts's established pattern. A from-source
 * build genuinely compiles CUDA code (minutes of wall-clock, real CPU/disk use) — callers that
 * only want to know WHAT would happen (no build) should inspect `assetNameRules`/
 * `pickPrebuiltAsset` directly rather than calling this function.
 */
export async function resolveLlamaBinary(
  hw: DetectedHardware,
  opts: LlamaBinaryDeps & { version?: string; cudaArch?: string; cudaHostCompiler?: string } = {},
): Promise<ResolveLlamaBinaryResult> {
  const exists = opts.exists ?? existsSync;
  const doMkdir = opts.mkdir ?? ((p: string) => mkdir(p, { recursive: true }).then(() => undefined));
  const readFileImpl = opts.readFile ?? ((p: string) => readFile(p, 'utf8'));
  const writeFileImpl = opts.writeFile ?? ((p: string, c: string) => writeFile(p, c, 'utf8'));
  const hashFile = opts.hashFile ?? defaultHashFile;
  const download = opts.download ?? defaultDownload;
  const extract = opts.extract ?? defaultExtract;
  const exec = opts.exec ?? ((c: string, a: string[]) => defaultExec(c, a, 15 * 60 * 1000));
  const fetchReleases = opts.fetchReleases ?? defaultFetchReleases;
  const now = opts.now ?? (() => new Date().toISOString());
  const home = opts.home ?? defaultHome();
  const jobs = opts.jobs ?? Math.max(1, os.cpus().length - 1);
  const bin = binaryName(hw.platform === 'win32' ? 'win32' : hw.platform === 'darwin' ? 'darwin' : 'linux');

  let cudaVersion: string | undefined;
  if (hw.gpu?.vendor === 'nvidia') {
    cudaVersion = await detectCudaVersion(exec);
  }
  const spec = derivePlatformSpec(hw, cudaVersion);
  const platformKey = platformKeyFor(spec);

  let releases: GhRelease[];
  try {
    releases = await fetchReleases();
  } catch (e) {
    return { ok: false, blocked: `could not reach GitHub releases for ${LLAMA_CPP_REPO}: ${e instanceof Error ? e.message : String(e)}` };
  }
  const release = opts.version ? releases.find((r) => r.tag_name === opts.version) ?? null : pickLatestRelease(releases);
  if (!release) {
    return { ok: false, blocked: opts.version ? `no release tagged '${opts.version}' found for ${LLAMA_CPP_REPO}` : `no usable (non-draft, non-prerelease, with assets) release found for ${LLAMA_CPP_REPO}` };
  }
  const version = release.tag_name;

  const cacheDir = `${home}/.papercusp/backends/llama-server/${version}/${platformKey}`;
  const cacheBinPath = `${cacheDir}/${bin}`;
  const manifestPath = `${cacheDir}/manifest.json`;

  // 1. Cache hit — re-verify integrity against our own recorded hash before trusting it.
  if (exists(cacheBinPath) && exists(manifestPath)) {
    try {
      const manifest = JSON.parse(await readFileImpl(manifestPath)) as LlamaBinaryManifest;
      const actualSha = await hashFile(cacheBinPath);
      if (actualSha === manifest.sha256) {
        return { ok: true, binPath: cacheBinPath, manifest, fromCache: true };
      }
      // Fall through and re-provision — the cached binary no longer matches its own manifest
      // (local corruption / tampering), never silently serve it.
    } catch {
      // Malformed manifest — treat as a cache miss, not a fatal error.
    }
  }

  await doMkdir(cacheDir);

  // 2. Prebuilt release asset, if llama.cpp publishes one for this platform+GPU combo.
  const asset = pickPrebuiltAsset(release, spec);
  if (asset) {
    const archivePath = `${cacheDir}/_download-${asset.name}`;
    let extractDir = `${cacheDir}/_extract`;
    try {
      await download(asset.browser_download_url, archivePath);
      await extract(archivePath, extractDir);
      const found = await findBinaryUnder(extractDir, bin);
      if (!found) {
        return { ok: false, blocked: `downloaded '${asset.name}' but no '${bin}' was found inside it` };
      }
      await copyFile(found, cacheBinPath);
      await chmod(cacheBinPath, 0o755);
      const sha256 = await hashFile(cacheBinPath);
      const manifest: LlamaBinaryManifest = { version, platformKey, source: 'prebuilt', sha256, builtAt: now() };
      await writeFileImpl(manifestPath, JSON.stringify(manifest, null, 2));
      return { ok: true, binPath: cacheBinPath, manifest };
    } finally {
      await rm(archivePath, { force: true }).catch(() => {});
      await rm(extractDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // 3. Build from source — the proven CUDA/gcc-12/arch86 recipe (generalized per this box's
  //    detected hardware, never hardcoded).
  if (spec.gpuVendor === 'nvidia' && !opts.cudaArch && !hw.gpu?.model) {
    return { ok: false, blocked: 'no prebuilt asset matches this platform and no CUDA compute-capability could be determined for a from-source build (nvidia-smi did not report a GPU model)' };
  }
  const sourceDir = opts.sourceDir ?? `${home}/.papercusp/backends/llama-server/_src/llama.cpp`;
  const buildDir = `${sourceDir}/build-${platformKey}`;
  try {
    if (!exists(sourceDir)) {
      await exec('git', ['clone', LLAMA_CPP_CLONE_URL, sourceDir]);
    } else {
      await exec('git', ['-C', sourceDir, 'fetch', '--all', '--tags']);
    }
    await exec('git', ['-C', sourceDir, 'checkout', version]);

    const cudaArch = opts.cudaArch; // caller-supplied compute capability (e.g. "86"); no safe
    // cross-GPU default — an unsupported arch either fails to build or produces a binary that
    // silently can't use the card, so this module never guesses one.
    const commands = cudaBuildCommands({
      sourceDir,
      buildDir,
      cudaArch: cudaArch ?? '',
      cudaHostCompiler: spec.gpuVendor === 'nvidia' ? opts.cudaHostCompiler : undefined,
      jobs,
    });
    for (const [cmd, ...args] of commands) {
      await exec(cmd, args);
    }
    const built = await findBinaryUnder(buildDir, bin);
    if (!built) {
      return { ok: false, blocked: `build completed but no '${bin}' was found under ${buildDir}` };
    }
    await copyFile(built, cacheBinPath);
    await chmod(cacheBinPath, 0o755);
    const sha256 = await hashFile(cacheBinPath);
    const manifest: LlamaBinaryManifest = { version, platformKey, source: 'source-build', sha256, builtAt: now() };
    await writeFileImpl(manifestPath, JSON.stringify(manifest, null, 2));
    return { ok: true, binPath: cacheBinPath, manifest };
  } catch (e) {
    return { ok: false, blocked: `build-from-source failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function pathExistsSize(p: string): Promise<number | null> {
  try {
    return (await fsStat(p)).size;
  } catch {
    return null;
  }
}
// (pathExistsSize is exported only for tests that want to assert a real file landed on disk
// without importing node:fs themselves in a unit test.)
export { pathExistsSize };

// Shared archive-provisioning defaults, reused by whisper-binary.ts (identical download/extract
// needs — GitHub release archives in the tens of MB; weights go through their own path).
export { defaultDownload as downloadFileWithSha256, defaultExtract as extractArchive };
