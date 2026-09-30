/**
 * provisioner/hardware-detect — first-run hardware probe for the provisioner wizard
 * (local-concurrent-inference-2026-07-02 P-009, D-006 "detect → recommend →
 * download/configure → register"). Detects GPU vendor/VRAM and platform so
 * `recommend.ts` can match against the catalog.
 *
 * READ-ONLY: every probe here only shells out to inspect the machine
 * (`nvidia-smi`, `rocm-smi`, `sysctl`, `system_profiler`) — nothing here
 * starts a process, loads a model, or touches the GPU's resident memory.
 * Fail-soft throughout (mirrors preflight-binaries.ts): a missing/erroring
 * probe yields `gpu: null` / an undefined field, never a thrown exception.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as os from 'node:os';

const execFileAsync = promisify(execFile);

export type GpuVendor = 'nvidia' | 'amd' | 'apple' | 'unknown';

export interface GpuInfo {
  vendor: GpuVendor;
  /** Marketing/model name, e.g. "NVIDIA GeForce RTX 3090". Best-effort. */
  model?: string;
  /** Total VRAM in GB (rounded), when the probe can determine it. */
  vramGB?: number;
  /** True for Apple Silicon's unified memory — vramGB there is shared with system RAM. */
  unifiedMemory?: boolean;
  /** NVIDIA-only: CUDA compute capability ("8.6" for an RTX 3090), from
   *  `nvidia-smi --query-gpu=...,compute_cap`. Feeds `CMAKE_CUDA_ARCHITECTURES` for a
   *  from-source llama-server build (provisioner/llama-binary.ts's `computeCapToArch`) —
   *  undefined when the probe's output doesn't include it (older driver/nvidia-smi builds). */
  computeCap?: string;
}

export interface DetectedHardware {
  platform: NodeJS.Platform;
  arch: string;
  /** Total system RAM in GB (rounded). */
  ramGB: number;
  /** null = no GPU detected (CPU-only / detection failed). */
  gpu: GpuInfo | null;
  /** Any non-fatal probe issues, surfaced for the wizard UI/CLI (never thrown). */
  notes: string[];
}

/** Injectable exec so tests never shell out for real (mirrors preflight-binaries' pattern,
 *  generalized to a run(cmd,args) shape so it composes across nvidia-smi/rocm-smi/sysctl/etc). */
export type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

async function defaultExec(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const r = await execFileAsync(cmd, args, { timeout: 5000 });
  return { stdout: r.stdout, stderr: r.stderr };
}

export interface HardwareDetectDeps {
  exec?: ExecFn;
  platform?: NodeJS.Platform;
  arch?: string;
  totalMemBytes?: number;
}

function bytesToGB(bytes: number): number {
  return Math.round((bytes / 1024 ** 3) * 10) / 10;
}

/** NVIDIA: `nvidia-smi --query-gpu=name,memory.total,compute_cap --format=csv,noheader,nounits`.
 *  Reports the FIRST GPU only (multi-GPU boxes are out of scope for P-009 — the wizard
 *  targets the common single-card dev/workstation case). `compute_cap` (added for
 *  provisioner/llama-binary.ts's from-source build path — WI-1617) is best-effort: an older
 *  nvidia-smi/driver that doesn't recognize the field just omits it from the CSV rather than
 *  erroring, so a short (2-field) response degrades to `computeCap: undefined`, not a probe
 *  failure. */
async function detectNvidia(exec: ExecFn, notes: string[]): Promise<GpuInfo | null> {
  try {
    const { stdout } = await exec('nvidia-smi', ['--query-gpu=name,memory.total,compute_cap', '--format=csv,noheader,nounits']);
    const firstLine = stdout.split('\n').map((l) => l.trim()).find(Boolean);
    if (!firstLine) return null;
    const [namePart, memPart, computeCapPart] = firstLine.split(',').map((s) => s.trim());
    const memMiB = Number.parseFloat(memPart);
    if (!namePart || !Number.isFinite(memMiB)) {
      notes.push(`nvidia-smi output not in the expected "name, memory.total[, compute_cap]" shape: '${firstLine}'`);
      return null;
    }
    const computeCap = computeCapPart && /^\d+\.\d+$/.test(computeCapPart) ? computeCapPart : undefined;
    if (!computeCap) notes.push('nvidia-smi did not report a compute_cap — a from-source llama-server build will need it supplied explicitly');
    return { vendor: 'nvidia', model: namePart, vramGB: bytesToGB(memMiB * 1024 * 1024), computeCap };
  } catch {
    return null; // nvidia-smi absent or errored — not an NVIDIA box (or driver not installed)
  }
}

/** AMD: `rocm-smi --showproductname --showmeminfo vram --json` when ROCm is installed.
 *  Best-effort — ROCm tooling varies a lot across distros/versions, so a parse miss just
 *  degrades to vendor-known-but-vramGB-unknown rather than failing detection outright. */
async function detectAmd(exec: ExecFn, notes: string[]): Promise<GpuInfo | null> {
  try {
    const { stdout } = await exec('rocm-smi', ['--showproductname', '--showmeminfo', 'vram', '--json']);
    const parsed = JSON.parse(stdout) as Record<string, Record<string, string>>;
    const cardKey = Object.keys(parsed).find((k) => /^card\d+$/.test(k));
    if (!cardKey) {
      notes.push('rocm-smi returned JSON but no card* entry was found');
      return { vendor: 'amd' };
    }
    const card = parsed[cardKey];
    const model = card['Card series'] ?? card['Card Series'] ?? undefined;
    const vramBytesStr = card['VRAM Total Memory (B)'] ?? card['vram_total'];
    const vramGB = vramBytesStr ? bytesToGB(Number.parseFloat(vramBytesStr)) : undefined;
    return { vendor: 'amd', model, vramGB };
  } catch {
    return null; // rocm-smi absent — not (visibly) an AMD GPU box, or ROCm not installed
  }
}

/** Apple Silicon: GPU shares unified memory with the CPU, so "VRAM" is total system RAM.
 *  Intel Macs with a discrete/dedicated GPU are out of scope (rare, EOL hardware for the
 *  provisioner's target audience) — they fall through to `gpu: null` (cpu-only tier). */
async function detectApple(exec: ExecFn, ramGB: number, notes: string[]): Promise<GpuInfo | null> {
  try {
    const { stdout } = await exec('sysctl', ['-n', 'machdep.cpu.brand_string']);
    const model = stdout.trim() || 'Apple Silicon';
    return { vendor: 'apple', model, vramGB: ramGB, unifiedMemory: true };
  } catch {
    notes.push('sysctl probe for the Apple Silicon chip name failed; reporting a generic Apple GPU entry');
    return { vendor: 'apple', vramGB: ramGB, unifiedMemory: true };
  }
}

/**
 * Detect this machine's platform, RAM, and (best-effort) primary GPU. Never throws —
 * a failed probe just narrows the result (`gpu: null` at worst) and appends a note.
 */
export async function detectHardware(deps: HardwareDetectDeps = {}): Promise<DetectedHardware> {
  const exec = deps.exec ?? defaultExec;
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const ramGB = bytesToGB(deps.totalMemBytes ?? os.totalmem());
  const notes: string[] = [];

  let gpu: GpuInfo | null = null;

  if (platform === 'darwin' && arch === 'arm64') {
    gpu = await detectApple(exec, ramGB, notes);
  } else {
    // NVIDIA and AMD tooling both exist cross-platform (Linux primarily, NVIDIA also on
    // Windows) — probe both and take whichever answers. NVIDIA first: it's the box this
    // wizard is validated against (D-005/D-006) and the catalog's only non-provisional
    // hardware family so far.
    gpu = await detectNvidia(exec, notes);
    if (!gpu) gpu = await detectAmd(exec, notes);
    if (!gpu && platform === 'darwin') {
      // Intel Mac: unified memory doesn't apply, and we have no reliable discrete-VRAM
      // probe here — treat as cpu-only rather than guess.
      notes.push('Intel Mac detected — no discrete-GPU VRAM probe implemented; treating as CPU-only for recommendation purposes');
    }
  }

  if (!gpu) notes.push('no supported GPU detected (or vendor tooling is not installed) — recommendation will fall back to cloud/CPU-only');

  return { platform, arch, ramGB, gpu, notes };
}
