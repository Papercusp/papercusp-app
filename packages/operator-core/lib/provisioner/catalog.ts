/**
 * provisioner/catalog — the certified-combo catalog the provisioner wizard recommends from
 * (local-concurrent-inference-2026-07-02 D-005 "catalog is a HARNESS, not a list", D-006).
 *
 * D-005's certification battery (plan items P-006/P-007, lib/inference-gateway/cert-battery)
 * is the thing that PRODUCES a catalog entry. Each entry carries an explicit `status`:
 *   - 'provisional': grounded in a real, currently-running config (verified against this
 *     box's live `llama-ornith.service` unit) but NOT yet run through the cert battery.
 *   - 'certified':   passed the cert battery — the `certification` field records the verdict,
 *     run timestamp, and mangling rate. ornith-35b IQ3_M @ llama-server is entry #1. Flip an
 *     entry here when the battery certifies it live; never add a parallel "real" catalog.
 *
 * The wizard is honest about this in the UI/CLI (recommend.ts's `reason` string surfaces
 * `status`), rather than presenting a provisional entry as fully vetted.
 */
import type { LocalBackendKind } from '../inference-gateway/local-backend-store';
import type { HardwareTier } from './recommend-types';

export type CatalogEntryStatus = 'provisional' | 'certified';

/** Certification evidence attached to a `status: 'certified'` entry — a compact stamp of the
 *  cert-battery run that certified this locked config (lib/inference-gateway/cert-battery). The
 *  full per-probe report is transient run data; the durable audit fact is this summary. */
export interface CatalogCertification {
  /** The battery verdict at certification (a certified entry is always 'certified' here). */
  verdict: 'certified' | 'failed';
  /** ISO timestamp of the certifying run. */
  ranAt: string;
  /** Aggregate tool-call mangling rate at certification (0..1) — the metric that separates a
   *  healthy model from a tool-JSON storm. */
  manglingRate: number;
  /** Critical probes that passed / total, e.g. "3/3" (behavior · trimmed-shape · comms). */
  criticalProbes: string;
  /** The battery's one-line summary. */
  summary: string;
  /** How it was certified (battery + endpoint), for the audit trail. */
  method: string;
}

export interface CatalogEntry {
  id: string;
  displayName: string;
  backend: LocalBackendKind;
  model: {
    /** ollama-style reference, e.g. "maxwell1500/ornith-35b:IQ3_M" — used both to resolve an
     *  already-pulled ollama blob (weights.ts) and as the `ollama pull` hint when it's missing.
     *  For a `backend: 'vllm'` entry this doubles as the gateway registry's model id / OpenAI
     *  `/v1/models` id (kept equal to `serve`'s rendered `--served-model-name` — see
     *  vllm-container.ts) rather than an actual ollama reference. */
    ollamaRef: string;
    quant: string;
    /** Approximate on-disk weights size, for the wizard's "this will download ~NGB" messaging. */
    sizeGB: number;
    /** HF model repo id for a vLLM backend's `--model` (an AWQ/GPTQ requant repo). Only
     *  meaningful when `backend === 'vllm'`; llama-server/ollama entries resolve weights via
     *  `ollamaRef` (weights.ts) instead and leave this unset. */
    hfRepo?: string;
    /** vLLM quantization method for `--quantization`. Only meaningful when `backend === 'vllm'`
     *  (vllm-container.ts's `renderVllmContainerUnit` defaults to 'awq' when unset). */
    quantization?: 'awq' | 'gptq';
  };
  hardwareTier: HardwareTier;
  /** Minimum VRAM (GB) required to run this combo at the tuning below. */
  minVramGB: number;
  serve: {
    host: string;
    portDefault: number;
    parallelSlots: number;
    ctxTotal: number;
    kvCacheType: string;
    flashAttn: boolean;
    /** vLLM `--gpu-memory-utilization` (0-1). Only meaningful when `backend === 'vllm'`;
     *  defaults to 0.9 in provision.ts's rendering when unset. */
    gpuMemoryUtilization?: number;
    /** llama-server `--jinja` — required for structured tool-call parsing on models whose
     *  tool format needs the jinja chat template (e.g. Qwen3's `<tool_call>`; WI-1596).
     *  Only meaningful when `backend === 'llama-server'`. */
    jinja?: boolean;
    /** llama-server `--reasoning-budget N` (0 = disable thinking-mode preambles — part of
     *  the certified qwen3 config; WI-1596). Only meaningful when `backend === 'llama-server'`. */
    reasoningBudget?: number;
    /** llama-server `-ngl` (`--n-gpu-layers`) — how many transformer layers to offload to the
     *  GPU: an exact count (999 = every layer), `'all'`, or `'auto'` (let `--fit` decide from the
     *  device memory actually free at start). ABSENT means the flag is not written at all.
     *  Only meaningful when `backend === 'llama-server'`.
     *
     *  Declare it whenever the deployed unit sets it. The drift guard COMPARES it, so a catalog
     *  that stays silent about a flag the unit sets reports drift — deliberately, and in line with
     *  this module's "never substitute a default" rule: an undeclared GPU-offload setting is
     *  exactly what let a CPU-only fallback pass every green check (WI-39735, D-012).
     *
     *  An ON-DEMAND backend must use `'auto'` with `fit: 'on'`, never a pinned count (WI-10006354).
     *  It cold-starts into whatever GPU occupancy exists at that moment, and a pinned full offload
     *  turns any co-tenant (embedding hosts, TTS, another operator) into `cudaMalloc failed: out of
     *  memory` and a unit that never serves. */
    gpuLayers?: number | 'auto' | 'all';
    /** llama-server `--fit on|off` — adjust the arguments left unset (here `-ngl auto`) so the model
     *  fits the device memory free at start, spilling MoE expert weights to the CPU first. Declared
     *  explicitly rather than relying on the engine default, for the same never-substitute reason
     *  as `gpuLayers`. Only meaningful when `backend === 'llama-server'`. */
    fit?: 'on' | 'off';
    /** llama-server `--fit-target MiB` — device memory `--fit` leaves free for co-tenants. */
    fitTargetMiB?: number;
    /** Environment variable NAMES this backend cannot serve correctly without. The drift guard
     *  asserts each is PRESENT and non-empty in the deployed unit; it deliberately does NOT compare
     *  their VALUES, which are per-box install paths — comparing those is how a guard starts crying
     *  wolf on every install and gets silenced (see unit-drift.ts's header).
     *
     *  Presence-not-value is the whole point here: ornith needs LD_LIBRARY_PATH + GGML_BACKEND_PATH
     *  because ollama ships its CUDA backend inside a subdirectory ggml's loader does not scan.
     *  Delete either line and the unit still starts, still reports `active`, still answers /health
     *  200, and still matches every compared flag — while serving entirely from the CPU. */
    requiredEnv?: readonly string[];
    /** How this combo's backend should be MANAGED at runtime — the RECOMMENDED DEFAULT for the
     *  combo, not the operative setting (on-demand-local-inference-lifecycle-2026-08-17 D-005:
     *  the catalog recommends, `harness_shared.local_backends` is the truth the reaper and the
     *  gateway actually read). `applyProvision` threads this into the registration.
     *
     *  - 'always-on'  — start it and leave it resident (today's only behaviour).
     *  - 'on-demand'  — the idle-reaper may stop it once idle past `idleTtlSec`, and the gateway
     *                   starts it again on a request routed to it.
     *
     *  UNSET MEANS 'always-on'. That default is load-bearing: every pre-existing entry — and any
     *  catalog a third party supplies — keeps exactly today's behaviour, so adding this field can
     *  never silently make a running backend reapable. */
    lifecycle?: 'always-on' | 'on-demand';
    /** Idle seconds before an `on-demand` backend becomes eligible for reaping. Only meaningful
     *  with `lifecycle: 'on-demand'`; ignored otherwise. Unset ⇒ the reaper's own default. */
    idleTtlSec?: number;
  };
  status: CatalogEntryStatus;
  /** Present iff `status === 'certified'` — the cert-battery run that certified this config. */
  certification?: CatalogCertification;
  /** Plan/decision this entry's config was sourced from, for audit trail. */
  sourceRef: string;
}

export const CERTIFIED_CATALOG: readonly CatalogEntry[] = [
  {
    id: 'ornith-35b-iq3m-llama-server',
    displayName: 'ornith-35b (IQ3_M) via llama-server',
    backend: 'llama-server',
    model: { ollamaRef: 'maxwell1500/ornith-35b:IQ3_M', quant: 'IQ3_M', sizeGB: 15.5 },
    hardwareTier: 'nvidia-24gb-plus',
    minVramGB: 24,
    serve: {
      host: '127.0.0.1',
      portDefault: 11436,
      parallelSlots: 2,
      ctxTotal: 180224,
      kvCacheType: 'q8_0',
      flashAttn: true,
      // A 35b IQ3_M at this context occupies the ENTIRE 24GB card (measured 2026-08-17: stopping
      // it returned 19,836 MiB), which starves every other GPU consumer on the box — the reranker
      // included. It is the archetypal on-demand backend: expensive to hold, cheap to miss.
      lifecycle: 'on-demand',
      // 30 min. Chosen against measured idleness, not taste: when this was stopped it had served
      // 0 requests in 6h and logged 0 journal entries in 24h, so anything up to an hour would have
      // freed the card equally well. 30 min keeps the worst-case waste bounded while staying far
      // above any plausible gap inside one working session.
      idleTtlSec: 1800,
      // Both of the following are what make this unit use the GPU AT ALL, and all three were
      // invisible to the drift guard until WI-39735. Measured 2026-08-17: without them the unit
      // loads ~10.1GB into system RAM, GPU memory stays flat, /health returns 200 in 117.9s; with
      // them it loads to the card (4448 -> 21754 MiB) and cold-starts in 67.5s.
      //
      // Offload is SIZED AT START, not pinned (WI-10006354). With `-ngl 999` the unit needs ~19.8 GiB
      // free, and under normal occupancy (embed sidecar ~7 GiB, hosted control plane ~1.8 GiB,
      // kokoro ~1 GiB, terminal operators) it exited 1 three times on `cudaMalloc failed: out of
      // memory` and hit StartLimit, so every on-demand request failed. Measured 2026-10-06 with
      // 7.5 GiB free: `-ngl auto --fit on --fit-target 1024` spilled MoE experts to the CPU, took
      // 6.4 GiB of VRAM, left 1.2 GiB free, reached /health in 237s and served a completion. On an
      // idle card `--fit` keeps every layer on the GPU, so the uncontended case is unchanged.
      gpuLayers: 'auto',
      fit: 'on',
      fitTargetMiB: 1024,
      requiredEnv: ['LD_LIBRARY_PATH', 'GGML_BACKEND_PATH'],
    },
    // DEMOTED 2026-08-17 from 'certified' — on-demand-local-inference-lifecycle-2026-08-17 D-011.
    // The 2026-07-02 certification was earned on a HAND-BUILT ~/llama.cpp/build/bin/llama-server
    // that has since been deleted (EI-20721621940954812). The unit now runs ollama's PACKAGED
    // engine, which is a different llama.cpp build and — per D-012 — also required two new
    // Environment= vars and an explicit `-ngl 999` before it would use the GPU at all. Same
    // inference PARAMS, different engine: per D-007 an uncertified config must not inherit a
    // 'certified' stamp, so the stamp comes off until lib/inference-gateway/cert-battery is re-run
    // against THIS engine. The prior evidence is preserved in `sourceRef` rather than in
    // `certification`, because that field is defined as the stamp of the run that certified the
    // CURRENT config and leaving it populated would keep asserting exactly what is no longer true.
    status: 'provisional',
    sourceRef:
      'local-concurrent-inference-2026-07-02 D-005/D-006 — config verified against the live llama-ornith.service unit. HISTORICAL: certified 2026-07-02T20:21:49.813Z by the P-006 cert battery (3/3 critical probes, mangling 0.0%, via the D-011 sanitizer at :11435) — but that run was against the now-deleted hand-built llama-server binary, so it does NOT certify the current packaged-ollama engine. Re-run the battery to restore certified status (on-demand-local-inference-lifecycle-2026-08-17 D-011/D-012).',
  },
  {
    id: 'qwen3-8b-q4km-llama-server',
    displayName: 'Qwen3-8B (Q4_K_M) via llama-server',
    backend: 'llama-server',
    model: { ollamaRef: 'qwen3:8b', quant: 'Q4_K_M', sizeGB: 5.0 },
    hardwareTier: 'nvidia-low',
    minVramGB: 10,
    serve: {
      host: '127.0.0.1',
      portDefault: 11437,
      parallelSlots: 2,
      ctxTotal: 16384,
      kvCacheType: 'f16',
      flashAttn: false,
      jinja: true,
      reasoningBudget: 0,
    },
    status: 'certified',
    certification: {
      verdict: 'certified',
      ranAt: '2026-07-03T23:18:26.415Z',
      manglingRate: 0,
      criticalProbes: '3/3',
      summary:
        '[certified] qwen3:8b Q4_K_M @ llama-server (2×8192 ctx): 3/3 critical probes pass, mangling 0.0%',
      method:
        'cert-battery (behavior · trimmed-shape · comms · mangling-rate) run live via cert:run against a CPU-only llama-server serve (CUDA_VISIBLE_DEVICES= — GPU held by the live ornith backend; probes measure model+template+parser behavior, placement-independent) of the official Qwen/Qwen3-8B-GGUF Q4_K_M with --jinja --reasoning-budget 0. Without --jinja the tool-call parser never engages (qwen2.5-coder:14b failed 1/3 under BOTH the embedded and official templates — wrong-tag `<tools>` emissions; that model is NOT catalog-eligible).',
    },
    sourceRef:
      'local-concurrent-inference-2026-07-02 P-007 (WI-1596) — certified 2026-07-03 on the tower via cert:run; serve flags are the exact certified config (jinja + reasoning-budget 0)',
  },
  {
    id: 'qwen3-8b-q4km-llama-server-metal',
    displayName: 'Qwen3-8B (Q4_K_M) via llama-server (Apple Silicon)',
    backend: 'llama-server',
    model: { ollamaRef: 'qwen3:8b', quant: 'Q4_K_M', sizeGB: 5.0 },
    hardwareTier: 'apple-silicon',
    minVramGB: 12,
    serve: {
      host: '127.0.0.1',
      portDefault: 11437,
      parallelSlots: 2,
      ctxTotal: 16384,
      kvCacheType: 'f16',
      flashAttn: false,
      jinja: true,
      reasoningBudget: 0,
    },
    status: 'provisional',
    sourceRef:
      'local-concurrent-inference-2026-07-02 P-007 (WI-1596) — same (model, quant, backend, template-flags) combo as qwen3-8b-q4km-llama-server, which certified 3/3 / 0% mangling on x86 CPU serve 2026-07-03; stays provisional until the cert battery runs on a real Metal serve (mac lane su-a1a71 — flip to certified with that run\'s stamp)',
  },
] as const;

/** Look up a catalog entry by id (returns undefined if unknown — never throws). */
export function findCatalogEntry(id: string, catalog: readonly CatalogEntry[] = CERTIFIED_CATALOG): CatalogEntry | undefined {
  return catalog.find((e) => e.id === id);
}
