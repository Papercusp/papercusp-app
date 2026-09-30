/**
 * provisioner/whisper-binary — on-demand whisper.cpp `whisper-server` + ggml model provisioning
 * for local voice STT (voice-public-release-readiness-2026-07-12 P-009 hop 1, WI-4449).
 *
 * Mirrors llama-binary.ts (same PlatformSpec matrix, GitHub-release resolution, cache+manifest
 * integrity model, injectable-deps orchestration) with three deliberate differences, each
 * verified against the REAL ggml-org/whisper.cpp v1.9.1 release assets and this box's live
 * voicemode-whisper service (2026-07-12):
 *
 *  1. **Linux prebuilts EXIST** (`whisper-bin-ubuntu-{x64,arm64}.tar.gz`) — unlike llama.cpp.
 *     They are CPU-only, and that is the SHIPPING configuration on purpose: whisper base-model
 *     STT is realtime on CPU (this box serves it with `--no-gpu --threads 16` while the GPU is
 *     held by the LLM backend). A Linux box therefore always resolves the CPU asset regardless
 *     of GPU vendor — see `whisperPlatformSpec`.
 *  2. **The cache payload is the whole extracted asset DIRECTORY, not a lone binary.** The
 *     released `whisper-server` is dynamically linked against bundled libs (`libwhisper.so*`,
 *     `libggml*.so*`) with `RUNPATH=$ORIGIN` (verified via objdump + a live `--help` run of the
 *     v1.9.1 ubuntu-x64 asset on this box) — copying only the binary would strand its libs.
 *  3. **No macOS server asset is published** (the xcframework is a library, not whisper-server)
 *     — darwin falls to a fast from-source cmake build with `-DBUILD_SHARED_LIBS=OFF` so the
 *     built binary IS self-contained (Metal is compiled in by default on Apple Silicon).
 *
 * Model weights (`ggml-<model>.bin`) come from the canonical HF mirror whisper.cpp's own
 * download script uses (huggingface.co/ggerganov/whisper.cpp), cached under
 * `~/.papercusp/models/whisper/` with a sha256 sidecar manifest (trust-on-first-use, re-verified
 * on every cache hit — same contract as the binary manifest). `resolveWhisperModel` also probes
 * known external installs (e.g. a voicemode service's models dir) before planning a download.
 *
 * Cache layout: `~/.papercusp/backends/whisper-server/<version>/<platform-key>/`
 *   - `whisper-server` (`.exe` on Windows) + its bundled shared libs (prebuilt path).
 *   - `manifest.json` — `{ version, platformKey, source, sha256, builtAt }` (sha256 of the
 *     server binary; re-hashed on every cache hit — a mismatch is a cache miss, never served).
 *
 * Scope boundary (same as llama-binary.ts): this module produces `binPath`/`weightsPath` — it
 * never starts the server or registers a backend. Service lifecycle + the health seam
 * (operator-voice-engine-health.ts, VOICEMODE_URL/KOKORO_URL) are P-009 hop 3.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, readFile, rm, chmod, readdir, copyFile, cp } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import * as os from 'node:os';
import type { DetectedHardware } from './hardware-detect';
import type { WeightsPlan } from './weights';
import {
  derivePlatformSpec,
  detectCudaVersion,
  platformKeyFor,
  pickAssetByRules,
  pickLatestRelease,
  findBinaryUnder,
  downloadFileWithSha256,
  extractArchive,
  type PlatformSpec,
  type GhRelease,
  type GhReleaseAsset,
  type ExecFn,
} from './llama-binary';

const execFileAsync = promisify(execFile);

export const WHISPER_CPP_REPO = 'ggml-org/whisper.cpp';
export const WHISPER_CPP_CLONE_URL = 'https://github.com/ggml-org/whisper.cpp.git';

/** Default port matches operator-voice-proxy-helpers' VOICEMODE_URL default
 *  (http://localhost:2022) so a provisioned server is reachable through the existing
 *  health/proxy seams with zero extra config. */
export const WHISPER_SERVER_DEFAULT_PORT = 2022;

// ---------------------------------------------------------------------------------------
// Platform resolution (pure)
// ---------------------------------------------------------------------------------------

/**
 * Derive the PlatformSpec whisper provisioning keys on. Linux deliberately normalizes to
 * CPU (`gpuVendor: 'none'`): whisper.cpp publishes no GPU Linux asset, base-model STT is
 * realtime on CPU (this box's proven `--no-gpu` config), and NOT tying the cache key to the
 * LLM-side GPU means the same provisioned server survives GPU-tenancy changes. Windows keeps
 * the vendor (a cuBLAS asset IS published there); darwin keeps 'apple' (Metal source build).
 */
export function whisperPlatformSpec(hw: DetectedHardware, cudaVersion?: string): PlatformSpec {
  const spec = derivePlatformSpec(hw, cudaVersion);
  if (spec.os === 'linux') return { ...spec, gpuVendor: 'none', cudaVersion: undefined };
  return spec;
}

/**
 * Ordered (most-specific-first) name-fragment rules per whisper.cpp's release-asset naming,
 * verified against the real v1.9.1 assets: `whisper-bin-ubuntu-{x64,arm64}.tar.gz`,
 * `whisper-bin-x64.zip` / `whisper-bin-Win32.zip`, `whisper-blas-bin-x64.zip`,
 * `whisper-cublas-{11.8.0,12.4.0}-bin-x64.zip`, `whisper-v<ver>-xcframework.zip`.
 * An EMPTY rule list = no usable prebuilt (darwin: the xcframework is a lib, not the server;
 * win32/arm64: nothing published) — the caller falls back to build-from-source.
 * Fragment choices are deliberate substring-collision guards: `whisper-bin-x64` never matches
 * the cublas/blas assets, `blas-bin-x64` never matches `cublas-…-bin-x64`.
 */
export function whisperAssetNameRules(spec: PlatformSpec): readonly (readonly string[])[] {
  switch (spec.os) {
    case 'darwin':
      return [];
    case 'win32': {
      if (spec.arch === 'arm64') return [];
      if (spec.gpuVendor === 'nvidia') {
        const rules: string[][] = [];
        if (spec.cudaVersion) rules.push([`cublas-${spec.cudaVersion}`]);
        rules.push(['cublas', 'x64']);
        rules.push(['blas-bin-x64'], ['whisper-bin-x64']);
        return rules;
      }
      // BLAS beats the plain build for CPU inference speed; plain is the safety net.
      return [['blas-bin-x64'], ['whisper-bin-x64']];
    }
    case 'linux':
    default:
      return spec.arch === 'arm64' ? [['ubuntu', 'arm64']] : [['ubuntu', 'x64']];
  }
}

/** Pick the best-matching whisper.cpp prebuilt asset for `spec`, or null. Pure. */
export function pickWhisperPrebuiltAsset(release: GhRelease, spec: PlatformSpec): GhReleaseAsset | null {
  return pickAssetByRules(release, whisperAssetNameRules(spec));
}

// ---------------------------------------------------------------------------------------
// Build-from-source (pure command generation)
// ---------------------------------------------------------------------------------------

export interface WhisperBuildOptions {
  sourceDir: string;
  buildDir: string;
  jobs: number;
}

/** Render the cmake configure+build argv pair for a self-contained whisper-server build.
 *  `-DBUILD_SHARED_LIBS=OFF` is the load-bearing flag: it statically links libwhisper/libggml
 *  into the binary, so the source-build cache entry is a single file (the prebuilt path instead
 *  caches the whole asset dir because THOSE binaries are dynamically linked — see header).
 *  No CUDA/arch pinning on purpose: whisper ships CPU-first (Metal auto-enables on darwin). */
export function whisperBuildCommands(opts: WhisperBuildOptions): readonly (readonly string[])[] {
  return [
    ['cmake', '-S', opts.sourceDir, '-B', opts.buildDir, '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF'],
    ['cmake', '--build', opts.buildDir, '--config', 'Release', '-j', String(opts.jobs)],
  ];
}

// ---------------------------------------------------------------------------------------
// Serve invocation (pure) — the dev-box-proven shape hop 3's lifecycle will launch
// ---------------------------------------------------------------------------------------

export interface WhisperServeOptions {
  modelPath: string;
  /** Default 127.0.0.1 — local-only, matching the rest of the provisioner's serve defaults. */
  host?: string;
  /** Default WHISPER_SERVER_DEFAULT_PORT (2022, the VOICEMODE_URL seam's default). */
  port?: number;
  /** Default: all-but-one core, CLAMPED to 16 (WI-4501). STT on whisper-base is realtime well
   *  under 16 threads (this box's live voicemode unit runs exactly 16); an unclamped
   *  `cpus()-1` on a big box claims 127 threads PER SERVER, which turned a duplicate-spawn
   *  bug into a machine-wide CPU incident. */
  threads?: number;
  /** Default true — webview/browser audio arrives as webm/opus; whisper-server needs its
   *  ffmpeg conversion path to accept it (the live voicemode unit runs --convert). */
  convert?: boolean;
  /** Force CPU inference (the proven config when a GPU is resident to the LLM backend). */
  noGpu?: boolean;
}

/** Render the whisper-server argv (no binary path) — mirrors this box's live, working
 *  voicemode-whisper unit: `--host … --port … --model … --inference-path
 *  /v1/audio/transcriptions --threads … --convert [--no-gpu]`. The OpenAI-compatible
 *  inference path is what operator-voice-proxy-helpers already targets via VOICEMODE_URL. */
export function renderWhisperServerArgs(opts: WhisperServeOptions): string[] {
  const args = [
    '--host', opts.host ?? '127.0.0.1',
    '--port', String(opts.port ?? WHISPER_SERVER_DEFAULT_PORT),
    '--model', opts.modelPath,
    '--inference-path', '/v1/audio/transcriptions',
    '--threads', String(opts.threads ?? Math.max(1, Math.min(16, os.cpus().length - 1))),
  ];
  if (opts.convert ?? true) args.push('--convert');
  if (opts.noGpu) args.push('--no-gpu');
  return args;
}

// ---------------------------------------------------------------------------------------
// Model weights (ggml-<model>.bin) — read-side plan + write-side download
// ---------------------------------------------------------------------------------------

/** Approx download sizes (MB) for the wizard's "this will download ~N MB" messaging —
 *  from the canonical HF repo's file listing. Only the sizes the voice UI offers; the
 *  functions below accept any of these ids. */
export const WHISPER_MODELS = {
  tiny: { sizeMB: 78 },
  'tiny.en': { sizeMB: 78 },
  base: { sizeMB: 148 },
  'base.en': { sizeMB: 148 },
  small: { sizeMB: 488 },
  'small.en': { sizeMB: 488 },
} as const;
export type WhisperModelId = keyof typeof WHISPER_MODELS;

/** The dev-box-proven default (the live voicemode unit serves ggml-base.bin). */
export const DEFAULT_WHISPER_MODEL: WhisperModelId = 'base';

/** Canonical weights URL — the same HF mirror whisper.cpp's own download-ggml-model.sh uses. */
export function whisperModelUrl(model: WhisperModelId): string {
  return `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${model}.bin`;
}

function defaultHome(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? '';
}

/** Our own weights cache dir (the only root downloadWhisperModel writes to). */
export function whisperModelCacheDir(home = defaultHome()): string {
  return `${home}/.papercusp/models/whisper`;
}

export interface WhisperModelManifest {
  model: string;
  url: string;
  sha256: string;
  bytes: number;
  downloadedAt: string;
}

export interface WhisperModelDeps {
  home?: string;
  /** Roots probed IN ORDER for an existing `ggml-<model>.bin`. Default: our cache dir first,
   *  then known external installs (a voicemode whisper service's models dir). */
  candidateRoots?: string[];
  exists?: (p: string) => boolean;
  readFile?: (p: string) => Promise<string>;
  writeFile?: (p: string, content: string) => Promise<void>;
  hashFile?: (p: string) => Promise<string>;
  download?: (url: string, destPath: string) => Promise<{ bytesWritten: number; sha256: string }>;
  now?: () => string;
}

function defaultModelRoots(home: string): string[] {
  return [whisperModelCacheDir(home), `${home}/.voicemode/services/whisper/models`];
}

async function defaultHashFile(p: string): Promise<string> {
  const buf = await readFile(p);
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Read-side plan: is `ggml-<model>.bin` already on disk? Probes the candidate roots in order;
 * a hit in OUR cache is integrity-reverified against its sidecar manifest (a mismatch is
 * treated as needs-download, never silently served); a hit in an external root (no sidecar)
 * is trusted as-is — it's an install the user's own tooling manages. Never throws, never
 * downloads (downloadWhisperModel is the write side).
 */
export async function resolveWhisperModel(
  model: WhisperModelId = DEFAULT_WHISPER_MODEL,
  deps: WhisperModelDeps = {},
): Promise<WeightsPlan> {
  const home = deps.home ?? defaultHome();
  const roots = deps.candidateRoots ?? defaultModelRoots(home);
  const exists = deps.exists ?? existsSync;
  const read = deps.readFile ?? ((p: string) => readFile(p, 'utf8'));
  const hashFile = deps.hashFile ?? defaultHashFile;
  const fileName = `ggml-${model}.bin`;
  const ourCacheDir = whisperModelCacheDir(home);

  for (const root of roots) {
    const candidate = `${root}/${fileName}`;
    if (!exists(candidate)) continue;
    const manifestPath = `${candidate}.manifest.json`;
    if (root === ourCacheDir && exists(manifestPath)) {
      try {
        const manifest = JSON.parse(await read(manifestPath)) as WhisperModelManifest;
        const actual = await hashFile(candidate);
        if (actual !== manifest.sha256) {
          return {
            needsDownload: true,
            pullHint: whisperModelUrl(model),
            detail: `cached ${fileName} no longer matches its recorded sha256 (corruption) — re-download required`,
          };
        }
      } catch {
        // Malformed sidecar — fall through and trust the file (same posture as an external root).
      }
    }
    return { needsDownload: false, weightsPath: candidate, detail: `resolved existing ${fileName} at ${root}` };
  }

  return {
    needsDownload: true,
    pullHint: whisperModelUrl(model),
    detail: `${fileName} not found in any candidate root (searched ${roots.length}) — download ~${WHISPER_MODELS[model].sizeMB}MB from the pull hint`,
  };
}

export interface DownloadWhisperModelResult {
  ok: boolean;
  weightsPath?: string;
  sha256?: string;
  bytes?: number;
  blocked?: string;
}

/**
 * Write-side companion to resolveWhisperModel: download `ggml-<model>.bin` into our cache dir
 * and record its sha256 sidecar manifest (trust-on-first-use; resolveWhisperModel re-verifies
 * every later cache hit against it). Callers opt in AFTER the plan says needsDownload.
 */
export async function downloadWhisperModel(
  model: WhisperModelId = DEFAULT_WHISPER_MODEL,
  deps: WhisperModelDeps = {},
): Promise<DownloadWhisperModelResult> {
  const home = deps.home ?? defaultHome();
  const download = deps.download ?? downloadFileWithSha256;
  const writeFileImpl = deps.writeFile ?? ((p: string, c: string) => writeFile(p, c, 'utf8'));
  const now = deps.now ?? (() => new Date().toISOString());
  const destDir = whisperModelCacheDir(home);
  const destPath = `${destDir}/ggml-${model}.bin`;
  const url = whisperModelUrl(model);
  try {
    await mkdir(destDir, { recursive: true });
    const { bytesWritten, sha256 } = await download(url, destPath);
    const manifest: WhisperModelManifest = { model, url, sha256, bytes: bytesWritten, downloadedAt: now() };
    await writeFileImpl(`${destPath}.manifest.json`, JSON.stringify(manifest, null, 2));
    return { ok: true, weightsPath: destPath, sha256, bytes: bytesWritten };
  } catch (e) {
    return { ok: false, blocked: `whisper model download failed for ${url}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ---------------------------------------------------------------------------------------
// Binary orchestration (I/O — every effect injectable; mirrors resolveLlamaBinary)
// ---------------------------------------------------------------------------------------

export interface WhisperBinaryManifest {
  version: string;
  platformKey: string;
  source: 'prebuilt' | 'source-build';
  sha256: string;
  builtAt: string;
}

/**
 * Cache-ONLY lookup: the newest already-provisioned whisper-server for this platform, integrity
 * re-verified against its manifest — NO network, NO build (the lifecycle layer calls this on
 * every voice request path, where an implicit GitHub fetch or a surprise download would be a
 * latency/availability landmine; the explicit provision step is what populates the cache).
 * Returns null when nothing valid is cached. Version dirs sort descending lexicographically —
 * whisper.cpp tags are `v<semver>`, so lexicographic order matches release order closely enough
 * for "pick the newest cached" (ties/misorder only pick a slightly older WORKING cache entry).
 */
export async function findCachedWhisperBinary(
  opts: { home?: string; platformKey: string; hashFile?: (p: string) => Promise<string> } = { platformKey: '' },
): Promise<{ binPath: string; manifest: WhisperBinaryManifest } | null> {
  const home = opts.home ?? defaultHome();
  const hashFile = opts.hashFile ?? defaultHashFile;
  const root = `${home}/.papercusp/backends/whisper-server`;
  let versions: string[];
  try {
    versions = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
      .map((e) => e.name)
      .sort()
      .reverse();
  } catch {
    return null;
  }
  const bin = opts.platformKey.startsWith('win32') ? 'whisper-server.exe' : 'whisper-server';
  for (const version of versions) {
    const dir = `${root}/${version}/${opts.platformKey}`;
    const binPath = `${dir}/${bin}`;
    const manifestPath = `${dir}/manifest.json`;
    if (!existsSync(binPath) || !existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as WhisperBinaryManifest;
      if ((await hashFile(binPath)) === manifest.sha256) return { binPath, manifest };
    } catch {
      // Malformed/corrupt entry — try the next cached version rather than fail.
    }
  }
  return null;
}

export interface ResolveWhisperBinaryResult {
  ok: boolean;
  binPath?: string;
  manifest?: WhisperBinaryManifest;
  fromCache?: boolean;
  blocked?: string;
}

export interface WhisperBinaryDeps {
  fetchReleases?: () => Promise<GhRelease[]>;
  exists?: (p: string) => boolean;
  mkdir?: (p: string) => Promise<void>;
  readFile?: (p: string) => Promise<string>;
  writeFile?: (p: string, content: string) => Promise<void>;
  hashFile?: (p: string) => Promise<string>;
  download?: (url: string, destPath: string) => Promise<{ bytesWritten: number; sha256: string }>;
  extract?: (archivePath: string, destDir: string) => Promise<void>;
  /** Copy the CONTENTS of srcDir into destDir (prebuilt path: the whole asset dir travels —
   *  the released binary resolves its bundled libs via RUNPATH=$ORIGIN; see header). */
  copyDirContents?: (srcDir: string, destDir: string) => Promise<void>;
  exec?: ExecFn;
  now?: () => string;
  home?: string;
  /** Default `${home}/.papercusp/backends/whisper-server/_src/whisper.cpp`. */
  sourceDir?: string;
  jobs?: number;
}

async function defaultExec(cmd: string, args: string[], timeoutMs = 15 * 60 * 1000): Promise<{ stdout: string; stderr: string }> {
  const r = await execFileAsync(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  return { stdout: r.stdout, stderr: r.stderr };
}

async function defaultFetchWhisperReleases(): Promise<GhRelease[]> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com/repos/${WHISPER_CPP_REPO}/releases?per_page=10`, { headers });
  if (!res.ok) throw new Error(`whisper-binary: github releases fetch failed HTTP ${res.status}`);
  return (await res.json()) as GhRelease[];
}

async function defaultCopyDirContents(srcDir: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  const entries = await readdir(srcDir, { withFileTypes: true });
  for (const e of entries) {
    // verbatimSymlinks is LOAD-BEARING: the release tarball's lib links are same-dir RELATIVE
    // (libwhisper.so.1 -> libwhisper.so.1.9.1). fs.cp's default resolves them to ABSOLUTE paths
    // into the _extract temp dir at copy time — which the caller then deletes, leaving every
    // .so.N link dangling and the server failing to start (caught by the live smoke 2026-07-12).
    await cp(join(srcDir, e.name), join(destDir, e.name), { recursive: true, force: true, verbatimSymlinks: true });
  }
}

function whisperBinaryName(osName: PlatformSpec['os']): string {
  return osName === 'win32' ? 'whisper-server.exe' : 'whisper-server';
}

/**
 * Resolve a working `whisper-server` for `hw`: a cache hit (integrity-reverified), else a
 * matching GitHub-release prebuilt (downloaded + extracted + the whole asset dir cached), else
 * a from-source static build (darwin / win32-arm64 — the only combos without a prebuilt).
 * Every I/O effect is injectable; with no opts this hits the real network/filesystem/toolchain,
 * matching resolveLlamaBinary's established pattern.
 */
export async function resolveWhisperBinary(
  hw: DetectedHardware,
  opts: WhisperBinaryDeps & { version?: string } = {},
): Promise<ResolveWhisperBinaryResult> {
  const exists = opts.exists ?? existsSync;
  const doMkdir = opts.mkdir ?? ((p: string) => mkdir(p, { recursive: true }).then(() => undefined));
  const readFileImpl = opts.readFile ?? ((p: string) => readFile(p, 'utf8'));
  const writeFileImpl = opts.writeFile ?? ((p: string, c: string) => writeFile(p, c, 'utf8'));
  const hashFile = opts.hashFile ?? defaultHashFile;
  const download = opts.download ?? downloadFileWithSha256;
  const extract = opts.extract ?? extractArchive;
  const copyDirContents = opts.copyDirContents ?? defaultCopyDirContents;
  const exec = opts.exec ?? ((c: string, a: string[]) => defaultExec(c, a));
  const fetchReleases = opts.fetchReleases ?? defaultFetchWhisperReleases;
  const now = opts.now ?? (() => new Date().toISOString());
  const home = opts.home ?? defaultHome();
  const jobs = opts.jobs ?? Math.max(1, os.cpus().length - 1);

  // The cuBLAS-asset pick only exists on Windows — that's the only platform whisper.cpp
  // publishes a CUDA build for, so don't probe nvcc anywhere else.
  let cudaVersion: string | undefined;
  if (hw.platform === 'win32' && hw.gpu?.vendor === 'nvidia') {
    cudaVersion = await detectCudaVersion(exec);
  }
  const spec = whisperPlatformSpec(hw, cudaVersion);
  const platformKey = platformKeyFor(spec);
  const bin = whisperBinaryName(spec.os);

  let releases: GhRelease[];
  try {
    releases = await fetchReleases();
  } catch (e) {
    return { ok: false, blocked: `could not reach GitHub releases for ${WHISPER_CPP_REPO}: ${e instanceof Error ? e.message : String(e)}` };
  }
  const release = opts.version ? releases.find((r) => r.tag_name === opts.version) ?? null : pickLatestRelease(releases);
  if (!release) {
    return {
      ok: false,
      blocked: opts.version
        ? `no release tagged '${opts.version}' found for ${WHISPER_CPP_REPO}`
        : `no usable (non-draft, non-prerelease, with assets) release found for ${WHISPER_CPP_REPO}`,
    };
  }
  const version = release.tag_name;

  const cacheDir = `${home}/.papercusp/backends/whisper-server/${version}/${platformKey}`;
  const cacheBinPath = `${cacheDir}/${bin}`;
  const manifestPath = `${cacheDir}/manifest.json`;

  // 1. Cache hit — re-verify integrity against our own recorded hash before trusting it.
  if (exists(cacheBinPath) && exists(manifestPath)) {
    try {
      const manifest = JSON.parse(await readFileImpl(manifestPath)) as WhisperBinaryManifest;
      const actualSha = await hashFile(cacheBinPath);
      if (actualSha === manifest.sha256) {
        return { ok: true, binPath: cacheBinPath, manifest, fromCache: true };
      }
      // Mismatch: fall through and re-provision — never silently serve a corrupted binary.
    } catch {
      // Malformed manifest — treat as a cache miss.
    }
  }

  await doMkdir(cacheDir);

  // 2. Prebuilt release asset (linux always; win32 x64 always; darwin never — see rules).
  const asset = pickWhisperPrebuiltAsset(release, spec);
  if (asset) {
    const archivePath = `${cacheDir}/_download-${asset.name}`;
    const extractDir = `${cacheDir}/_extract`;
    try {
      await download(asset.browser_download_url, archivePath);
      await extract(archivePath, extractDir);
      const found = await findBinaryUnder(extractDir, bin);
      if (!found) {
        return { ok: false, blocked: `downloaded '${asset.name}' but no '${bin}' was found inside it` };
      }
      // Cache the binary's whole directory — its bundled .so/.dll siblings are load-bearing
      // (RUNPATH=$ORIGIN); a lone-binary copy would produce a server that can't start.
      await copyDirContents(dirname(found), cacheDir);
      await chmod(cacheBinPath, 0o755).catch(() => {});
      const sha256 = await hashFile(cacheBinPath);
      const manifest: WhisperBinaryManifest = { version, platformKey, source: 'prebuilt', sha256, builtAt: now() };
      await writeFileImpl(manifestPath, JSON.stringify(manifest, null, 2));
      return { ok: true, binPath: cacheBinPath, manifest };
    } finally {
      await rm(archivePath, { force: true }).catch(() => {});
      await rm(extractDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // 3. Build from source (darwin / win32-arm64): static, self-contained, no GPU flags needed.
  const sourceDir = opts.sourceDir ?? `${home}/.papercusp/backends/whisper-server/_src/whisper.cpp`;
  const buildDir = `${sourceDir}/build-${platformKey}`;
  try {
    if (!exists(sourceDir)) {
      await exec('git', ['clone', WHISPER_CPP_CLONE_URL, sourceDir]);
    } else {
      await exec('git', ['-C', sourceDir, 'fetch', '--all', '--tags']);
    }
    await exec('git', ['-C', sourceDir, 'checkout', version]);

    for (const [cmd, ...args] of whisperBuildCommands({ sourceDir, buildDir, jobs })) {
      await exec(cmd, args);
    }
    const built = await findBinaryUnder(buildDir, bin);
    if (!built) {
      return { ok: false, blocked: `build completed but no '${bin}' was found under ${buildDir}` };
    }
    await copyFile(built, cacheBinPath);
    await chmod(cacheBinPath, 0o755);
    const sha256 = await hashFile(cacheBinPath);
    const manifest: WhisperBinaryManifest = { version, platformKey, source: 'source-build', sha256, builtAt: now() };
    await writeFileImpl(manifestPath, JSON.stringify(manifest, null, 2));
    return { ok: true, binPath: cacheBinPath, manifest };
  } catch (e) {
    return { ok: false, blocked: `build-from-source failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
