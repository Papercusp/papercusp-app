/**
 * provisioner/vllm-container — vLLM MANAGED-CONTAINER provisioning (local-concurrent-inference-
 * 2026-07-02 D-009 #3, P-013/WI-1618).
 *
 * D-009 #3: vLLM installs as a MANAGED CONTAINER (Docker/Podman) — never bundled in the
 * installer, never a bare `pip install` into the app's own Python (vLLM's CUDA/torch pin
 * surface is heavy and host-Python-sensitive, D-006). A container pins the whole stack to a
 * known-good combo the certification battery (P-006/P-007) validates, isolated from whatever
 * Python happens to be on PATH. This module is the provisioning MACHINERY that decision asks
 * for, split the same way llama-binary.ts (WI-1617/P-012) splits binary provisioning:
 *
 *   - `detectContainerRuntime()` — READ-ONLY, fail-soft probe for a working Docker/Podman
 *     runtime (docker preferred; podman as the rootless-friendly fallback). Mirrors
 *     hardware-detect.ts's probe contract exactly: never throws, a missing/erroring probe just
 *     narrows the result. This is the D-009 #3 "gate the vLLM lane on a working container
 *     runtime" signal — `recommend.ts` (via `RecommendOptions.containerRuntimeAvailable`) uses
 *     it to skip a `backend:'vllm'` candidate and fall through to a llama-server one ("downgrade
 *     to llama-server when absent").
 *   - `resolveVllmImage()` — READ-ONLY, mirrors `weights.ts`'s `resolveOllamaWeights()` contract
 *     (same `WeightsPlan` return shape, reused verbatim so `provision.ts` / the SetupWizard UI
 *     need no second "is it ready" type): checks whether the pinned image is ALREADY present in
 *     the runtime's local cache and, if not, returns a `pullHint` rather than pulling itself.
 *   - `pullVllmImage()` — the heavier, OPT-IN, network-touching step (mirrors
 *     `llama-binary.ts`'s `resolveLlamaBinary` being deliberately kept OUT of the read-only
 *     `planProvision()` path) — actually runs `docker/podman pull`. A caller opts in explicitly
 *     (CLI `--provision-vllm-image`, `provisioner:install { pullVllmImage: true }`), exactly
 *     the same shape as WI-1617's `--provision-binary` / `provisionBinary`.
 *   - `renderVllmContainerUnit()` — pure string rendering (mirrors `backend-config.ts`) of a
 *     systemd user-unit whose `ExecStart` runs the pinned image as a foreground `docker run`/
 *     `podman run` (so `Type=simple` + `Restart=on-failure` supervises it exactly like the
 *     llama-server unit does) — the "systemd on Linux" half of D-009 #3.
 *   - `renderVllmDetachedRunArgs()` — pure argv rendering for the "the container runtime's own
 *     supervision on Mac/Windows" half of D-009 #3 (no systemd there — Docker Desktop / Podman
 *     Desktop keep a `--restart unless-stopped` detached container running instead). NOT wired
 *     into `provision.ts`'s `applyProvision()` yet — that function is systemd/Linux-only across
 *     every backend today (a pre-existing limitation, not unique to vLLM); this function exists
 *     and is tested so the non-Linux apply path has zero further plumbing to invent once
 *     `applyProvision()` grows platform-awareness.
 *
 * Registration into `harness_shared.local_backends` (kind:'vllm') needs NO changes here or in
 * the gateway — `local-backend-store.ts` already lists `'vllm'` in `LOCAL_BACKEND_KINDS` and
 * `local-backend-pool.ts` routes on `kind` generically (WI-1593/P-004). This module only ever
 * produces a plan (a unit string + a `RegisterLocalBackendInput`); `provision.ts`'s existing,
 * unmodified `applyProvision()` write path is what proves D-002's "zero gateway-code changes
 * for a new backend kind" claim.
 *
 * Scope note: there is no CERTIFIED (or even provisional) AWQ/GPTQ catalog entry yet — grounding
 * one requires an actually-running, verified vLLM instance (catalog.ts's D-005 policy), which is
 * P-008's job, still `todo`. This module is the machinery D-009 #3 asks for, wired into
 * `provision.ts`'s `backend === 'vllm'` branch so it activates the moment `catalog.ts` gains a
 * real entry — tested here (and in provision.test.ts/recommend.test.ts) via synthetic catalog
 * entries, the same technique provision.test.ts already uses for its llama-server cases.
 */
import { execFile } from 'node:child_process';
import { lstat, readdir } from 'node:fs/promises';
import type { Dirent, Stats } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { WeightsPlan } from './weights';

const execFileAsync = promisify(execFile);

export type ContainerRuntime = 'docker' | 'podman';

export interface ContainerRuntimeInfo {
  /** null = neither docker nor podman answered a version probe — no working runtime. */
  runtime: ContainerRuntime | null;
  /** Best-effort server/engine version string, when the runtime answered. */
  version?: string;
  /** Non-fatal probe notes (mirrors hardware-detect.ts's `notes[]` — never thrown, always
   *  surfaced for the wizard UI/CLI). */
  notes: string[];
}

export type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

async function defaultExec(cmd: string, args: string[], timeoutMs = 5000): Promise<{ stdout: string; stderr: string }> {
  const r = await execFileAsync(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
  return { stdout: r.stdout, stderr: r.stderr };
}

/**
 * Papercusp's pinned `vllm/vllm-openai` image (D-009 #3: "a Papercusp-published pin ... never
 * `:latest`" — a container pins the whole CUDA/torch stack to a known-good combo the
 * certification battery, P-006/P-007, is what should validate/bump this tag once a real
 * AWQ/GPTQ catalog entry exists).
 */
export const VLLM_PINNED_IMAGE = 'vllm/vllm-openai:v0.24.0';

/**
 * The container-side HF root. Do not mount a host cache at `/root/.cache/huggingface`:
 * vLLM images run as root by default, which turns a host user's cache into a root-owned
 * cleanup trap. The rendered run commands below use a non-root identity and this neutral
 * mount point together, so both Docker and Podman write with the host user's ownership.
 */
export const VLLM_CONTAINER_HF_HOME = '/tmp/papercusp-huggingface';

export interface HfCacheOwnershipCheck {
  /** False means the cache must not be used until its ownership/access problem is fixed. */
  healthy: boolean;
  /** False when the path is absent or the current platform has no numeric uid primitive. */
  checked: boolean;
  cacheDir: string;
  foreignEntries: string[];
  errors: string[];
  detail: string;
}

export interface HfCacheOwnershipDeps {
  /** Injected in tests; production uses the current process uid. */
  uid?: number;
  readdir?: (path: string) => Promise<Dirent[]>;
  lstat?: (path: string) => Promise<Stats>;
}

/**
 * Read-only health assertion for a host-mounted Hugging Face cache. A privileged model
 * writer can leave `.no_exist` files owned by root even when the cache is otherwise empty;
 * checking every entry catches that class before a user-scoped reclaim or a new container
 * start reports a misleading partial success. Missing caches are healthy-but-unchecked.
 */
export async function inspectHfCacheOwnership(cacheDir: string, deps: HfCacheOwnershipDeps = {}): Promise<HfCacheOwnershipCheck> {
  const uid = deps.uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
  const base: HfCacheOwnershipCheck = {
    healthy: true,
    checked: false,
    cacheDir,
    foreignEntries: [],
    errors: [],
    detail: '',
  };
  if (uid === undefined) {
    return { ...base, detail: 'current platform does not expose a numeric uid; cache ownership check skipped' };
  }

  const readEntries = deps.readdir ?? ((path: string) => readdir(path, { withFileTypes: true }));
  const statEntry = deps.lstat ?? lstat;
  let root: Stats;
  try {
    root = await statEntry(cacheDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return { ...base, detail: 'cache directory does not exist yet' };
    return {
      ...base,
      checked: true,
      healthy: false,
      errors: [`${cacheDir}: ${error instanceof Error ? error.message : String(error)}`],
      detail: 'cache ownership could not be checked',
    };
  }

  const foreignEntries: string[] = [];
  const errors: string[] = [];
  const visited = new Set<string>();
  const walk = async (dir: string): Promise<void> => {
    if (visited.has(dir)) return;
    visited.add(dir);
    let entries: Dirent[];
    try {
      entries = await readEntries(dir);
    } catch (error) {
      errors.push(`${dir}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      let info: Stats;
      try {
        info = await statEntry(path);
      } catch (error) {
        errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (info.uid !== uid) foreignEntries.push(path);
      // lstat + the Dirent guard keeps a symlink from escaping the cache root.
      if (entry.isDirectory() && !entry.isSymbolicLink()) await walk(path);
    }
  };

  if (root.uid !== uid) foreignEntries.push(cacheDir);
  if (root.isDirectory()) await walk(cacheDir);
  const healthy = foreignEntries.length === 0 && errors.length === 0;
  return {
    healthy,
    checked: true,
    cacheDir,
    foreignEntries,
    errors,
    detail: healthy ? 'all cache entries are owned by the current user' : 'cache contains foreign-owned or unreadable entries',
  };
}

/**
 * Probe for a WORKING container runtime — docker first (the more common default), podman as a
 * rootless-friendly fallback. "Working" means the daemon/engine actually answers a version
 * query, not just that the binary is on PATH, so an installed-but-not-running daemon is
 * distinguished (in `notes`) from "not installed" at all. Read-only, fail-soft — never throws.
 */
export async function detectContainerRuntime(exec: ExecFn = (c, a) => defaultExec(c, a)): Promise<ContainerRuntimeInfo> {
  const notes: string[] = [];

  try {
    const { stdout } = await exec('docker', ['info', '--format', '{{json .ServerVersion}}']);
    const version = JSON.parse(stdout.trim()) as unknown;
    if (typeof version === 'string' && version) {
      return { runtime: 'docker', version, notes };
    }
    notes.push('docker responded but reported no server version — treating as not running');
  } catch (e) {
    notes.push(`docker not usable: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    const { stdout } = await exec('podman', ['info', '--format', 'json']);
    const info = JSON.parse(stdout) as { version?: { Version?: string } };
    const version = info?.version?.Version;
    return { runtime: 'podman', version, notes };
  } catch (e) {
    notes.push(`podman not usable: ${e instanceof Error ? e.message : String(e)}`);
  }

  notes.push("no working container runtime found (docker/podman) — the vLLM lane is unavailable; downgrade to llama-server (D-009 #3)");
  return { runtime: null, notes };
}

export interface VllmImageDeps {
  runtimeInfo?: ContainerRuntimeInfo;
  exec?: ExecFn;
}

/**
 * Read-only: resolve whether `image` is ALREADY present in the local container runtime's image
 * cache (`<runtime> image inspect`, no network). Mirrors `resolveOllamaWeights()`'s contract
 * exactly and reuses its `WeightsPlan` return shape — `weightsPath` here holds the resolved
 * image reference (not a filesystem path; documented here rather than widening the shared type)
 * so `provision.ts` and the SetupWizard UI need no second "is it ready" type to plumb through.
 * Never pulls — see `pullVllmImage()` for the opt-in, network-touching step.
 */
export async function resolveVllmImage(image: string = VLLM_PINNED_IMAGE, deps: VllmImageDeps = {}): Promise<WeightsPlan> {
  const exec = deps.exec ?? ((c: string, a: string[]) => defaultExec(c, a));
  const runtimeInfo = deps.runtimeInfo ?? (await detectContainerRuntime(exec));

  if (!runtimeInfo.runtime) {
    return {
      needsDownload: true,
      detail: `no working container runtime (docker/podman) found — the vLLM lane is unavailable on this machine (D-009 #3: downgrade to llama-server). ${runtimeInfo.notes.join('; ')}`,
    };
  }

  const runtime = runtimeInfo.runtime;
  try {
    await exec(runtime, ['image', 'inspect', image, '--format', '{{.Id}}']);
    return { needsDownload: false, weightsPath: image, detail: `image '${image}' already present in the local ${runtime} cache` };
  } catch {
    return {
      needsDownload: true,
      pullHint: `${runtime} pull ${image}`,
      detail: `image '${image}' not present in the local ${runtime} cache — run the pull hint to fetch it (a real, multi-GB network fetch)`,
    };
  }
}

export interface PullVllmImageResult {
  ok: boolean;
  runtime?: ContainerRuntime;
  image?: string;
  /** true iff the image was already cached locally — no network I/O happened this call. */
  alreadyPresent?: boolean;
  blocked?: string;
}

/**
 * Opt-in, network-touching: pull `image` via the detected runtime if it isn't already cached
 * locally. Deliberately NOT called from `planProvision()`'s read-only path (mirrors
 * `llama-binary.ts`'s `resolveLlamaBinary` being kept out of it) — a caller that wants the
 * image provisioned before planning opts in explicitly (CLI `--provision-vllm-image`,
 * `provisioner:install { pullVllmImage: true }}`).
 */
export async function pullVllmImage(image: string = VLLM_PINNED_IMAGE, deps: VllmImageDeps = {}): Promise<PullVllmImageResult> {
  const exec = deps.exec ?? ((c: string, a: string[]) => defaultExec(c, a, 10 * 60 * 1000));
  const runtimeInfo = deps.runtimeInfo ?? (await detectContainerRuntime(exec));

  if (!runtimeInfo.runtime) {
    return {
      ok: false,
      blocked: `no working container runtime (docker/podman) found — vLLM lane unavailable, downgrade to llama-server (D-009 #3). ${runtimeInfo.notes.join('; ')}`,
    };
  }
  const runtime = runtimeInfo.runtime;

  try {
    await exec(runtime, ['image', 'inspect', image, '--format', '{{.Id}}']);
    return { ok: true, runtime, image, alreadyPresent: true };
  } catch {
    // Not present locally — fall through and pull.
  }

  try {
    await exec(runtime, ['pull', image]);
    return { ok: true, runtime, image, alreadyPresent: false };
  } catch (e) {
    return { ok: false, runtime, image, blocked: `${runtime} pull ${image} failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export interface VllmContainerUnitOptions {
  runtime: ContainerRuntime;
  /** Container + systemd-unit-scoped name (matches `provision.ts`'s `backendId`). */
  containerName: string;
  image: string;
  /** HF model repo id for `--model` (an AWQ/GPTQ requant repo — distinct from the ollama-style
   *  `model.ollamaRef` a llama-server catalog entry uses). */
  hfModelRepo: string;
  /** `--served-model-name` — the id the OpenAI-compatible `/v1/models`/completions surface uses;
   *  kept equal to the gateway registry's `models[]` entry so routing lines up. */
  servedModelName: string;
  quantization: 'awq' | 'gptq';
  /** Host-side bind address for the `-p` port mapping (container always listens on :8000 internally). */
  host: string;
  /** Host-side port for the `-p` port mapping. */
  port: number;
  maxModelLen: number;
  gpuMemoryUtilization: number;
  /** Host directory bind-mounted to the container-side HF root (so repeated restarts/pulls
   *  reuse the same on-disk weights cache instead of re-downloading). The host directory is
   *  health-checked by `planProvision`; it must remain owned/readable by the current user. */
  hfCacheDir: string;
  /** Absolute path to append stdout/stderr to. */
  logPath: string;
  /** Optional `HUGGING_FACE_HUB_TOKEN` for a gated HF repo. Never logged/echoed by this
   *  function beyond embedding it in the rendered unit file (same trust level as any other
   *  systemd-unit secret — the caller is responsible for the unit file's on-disk permissions). */
  hfToken?: string;
  /** Numeric host uid:gid for detached Docker runs. Systemd units use `%U:%G` instead. */
  containerUser?: string;
  description?: string;
}

function currentHostContainerUser(): string | undefined {
  if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function') return undefined;
  return `${process.getuid()}:${process.getgid()}`;
}

/** Render a systemd user-unit (`[Unit]/[Service]/[Install]`) for a vLLM backend running as a
 *  managed container — the "systemd on Linux" half of D-009 #3. `ExecStart` runs the pinned
 *  image in the FOREGROUND (no `-d`) so `Type=simple` + `Restart=on-failure` supervises it
 *  exactly the way `renderLlamaServerUnit()` supervises the bare llama-server process; `--rm`
 *  plus an `ExecStartPre` cleanup keeps a crash-restart from tripping over a stale container
 *  name. Pure — never touches the filesystem or a container runtime itself. */
export function renderVllmContainerUnit(opts: VllmContainerUnitOptions): string {
  const description =
    opts.description ?? `vLLM (${opts.runtime}) serving ${opts.servedModelName} (provisioner wizard — local-concurrent-inference-2026-07-02 P-013)`;
  const after = opts.runtime === 'docker' ? 'network.target docker.service' : 'network.target';
  const requires = opts.runtime === 'docker' ? '\nRequires=docker.service' : '';
  const identityLine = opts.runtime === 'podman' ? '  --userns=keep-id \\\n' : '  --user %U:%G \\\n';
  const envLine = [
    ` \\\n  -e HF_HOME=${VLLM_CONTAINER_HF_HOME}`,
    ` \\\n  -e HF_HUB_CACHE=${VLLM_CONTAINER_HF_HOME}/hub`,
    ` \\\n  -e TRANSFORMERS_CACHE=${VLLM_CONTAINER_HF_HOME}/transformers`,
    ...(opts.hfToken ? [` \\\n  -e HUGGING_FACE_HUB_TOKEN=${opts.hfToken}`] : []),
  ].join('');
  return `[Unit]
Description=${description}
After=${after}${requires}

[Service]
Type=simple
ExecStartPre=-${opts.runtime} rm -f ${opts.containerName}
ExecStart=${opts.runtime} run --rm --name ${opts.containerName} \\
${identityLine}\
 --gpus all \\
 -p ${opts.host}:${opts.port}:8000 \\
  -v ${opts.hfCacheDir}:${VLLM_CONTAINER_HF_HOME}${envLine} \\
  ${opts.image} \\
  --model ${opts.hfModelRepo} \\
  --served-model-name ${opts.servedModelName} \\
  --quantization ${opts.quantization} \\
  --max-model-len ${opts.maxModelLen} \\
  --gpu-memory-utilization ${opts.gpuMemoryUtilization} \\
  --host 0.0.0.0 --port 8000
ExecStop=-${opts.runtime} stop ${opts.containerName}
Restart=on-failure
RestartSec=5
StandardOutput=append:${opts.logPath}
StandardError=append:${opts.logPath}

[Install]
WantedBy=default.target
`;
}

export type VllmDetachedRunOptions = Omit<VllmContainerUnitOptions, 'logPath' | 'description'>;

/** Render the argv for a DETACHED `docker/podman run` with `--restart unless-stopped` — the
 *  "the container runtime's own supervision" half of D-009 #3 for platforms without systemd
 *  (Mac/Windows: Docker Desktop / Podman Desktop keep a restart-policy container running across
 *  reboots on their own). Pure — returns an argv array the caller execs; not wired into
 *  `applyProvision()` yet (that function is systemd/Linux-only across every backend today, a
 *  pre-existing scope boundary, not new to vLLM) — see this module's header comment. */
export function renderVllmDetachedRunArgs(opts: VllmDetachedRunOptions): string[] {
  const args = ['run', '-d', '--restart', 'unless-stopped', '--name', opts.containerName];
  if (opts.runtime === 'podman') {
    args.push('--userns=keep-id');
  } else {
    const containerUser = opts.containerUser ?? currentHostContainerUser();
    if (containerUser) args.push('--user', containerUser);
  }
  args.push(
    '--gpus',
    'all',
    '-p',
    `${opts.host}:${opts.port}:8000`,
    '-v',
    `${opts.hfCacheDir}:${VLLM_CONTAINER_HF_HOME}`,
    '-e',
    `HF_HOME=${VLLM_CONTAINER_HF_HOME}`,
    '-e',
    `HF_HUB_CACHE=${VLLM_CONTAINER_HF_HOME}/hub`,
    '-e',
    `TRANSFORMERS_CACHE=${VLLM_CONTAINER_HF_HOME}/transformers`,
  );
  if (opts.hfToken) args.push('-e', `HUGGING_FACE_HUB_TOKEN=${opts.hfToken}`);
  args.push(
    opts.image,
    '--model',
    opts.hfModelRepo,
    '--served-model-name',
    opts.servedModelName,
    '--quantization',
    opts.quantization,
    '--max-model-len',
    String(opts.maxModelLen),
    '--gpu-memory-utilization',
    String(opts.gpuMemoryUtilization),
    '--host',
    '0.0.0.0',
    '--port',
    '8000',
  );
  return args;
}
