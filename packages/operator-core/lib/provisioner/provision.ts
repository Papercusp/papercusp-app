/**
 * provisioner/provision — orchestrates the wizard's full flow (local-concurrent-inference-
 * 2026-07-02 P-009, D-006): detect → recommend → resolve weights → render backend config →
 * register in the gateway pool.
 *
 * Split into two phases on purpose:
 *   - `planProvision()` is PURE besides the (injectable, read-only) weights lookup — safe to
 *     call anytime, including while another agent is GPU-resident (it never starts a process).
 *   - `applyProvision()` is the side-effecting phase: writes the systemd unit + registers the
 *     backend in the durable gateway pool (`local-backend-store.ts` — also just a DB write,
 *     no GPU I/O). Actually STARTING the backend (which loads the model onto the GPU) is
 *     gated behind `opts.start`, which defaults to **false**. Nothing in this module's default
 *     path touches the GPU — a caller must opt in explicitly to `start: true`.
 */
import { dirname } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { detectHardware, type DetectedHardware, type HardwareDetectDeps } from './hardware-detect';
import { recommendCombo, type Recommendation } from './recommend';
import { resolveOllamaWeights, type WeightsPlan, type OllamaResolveDeps } from './weights';
import { renderLlamaServerUnit } from './backend-config';
import {
  detectContainerRuntime,
  resolveVllmImage,
  renderVllmContainerUnit,
  inspectHfCacheOwnership,
  VLLM_PINNED_IMAGE,
  type ContainerRuntimeInfo,
  type HfCacheOwnershipCheck,
  type HfCacheOwnershipDeps,
  type VllmImageDeps,
} from './vllm-container';
import {
  registerLocalBackend,
  type RegisterLocalBackendInput,
  type LocalBackendRecord,
} from '../inference-gateway/local-backend-store';
import type { CatalogEntry } from './catalog';
import { auditDeployedUnitForBackend, type DeployedUnitAudit } from './unit-drift';

const execFileAsync = promisify(execFile);

export interface ProvisionPlan {
  hardware: DetectedHardware;
  recommendation: Recommendation;
  weights: WeightsPlan | null;
  /** Container-runtime probe result (D-009 #3) — only populated when the detected hardware is
   *  NVIDIA (the only tier a vLLM candidate can ever target, D-004); `null` on Apple/AMD/CPU
   *  hardware where the probe would be moot. Feeds `recommendCombo`'s "downgrade to
   *  llama-server when no working Docker/Podman runtime" gate. */
  containerRuntime: ContainerRuntimeInfo | null;
  /** Read-only ownership assertion for the host-mounted HF cache. `null` for non-vLLM plans. */
  hfCacheOwnership: HfCacheOwnershipCheck | null;
  backendId: string;
  unitFileContent: string | null;
  unitFilePath: string;
  gatewayRegisterInput: RegisterLocalBackendInput | null;
  /** Non-null iff the plan cannot be applied as-is (no combo fits, or weights need a download
   *  the wizard hasn't been told to perform). Surfaced verbatim by the CLI/UI. */
  blocked: string | null;
}

export interface PlanProvisionOptions {
  catalog?: readonly CatalogEntry[];
  hardwareDeps?: HardwareDetectDeps;
  ollamaDeps?: OllamaResolveDeps;
  backendId?: string;
  home?: string;
  unitFilePath?: string;
  logPath?: string;
  /** Absolute path to an ALREADY-provisioned `llama-server` binary (from
   *  `llama-binary.ts`'s `resolveLlamaBinary` — a separate, opt-in, network/build-capable
   *  step; deliberately NOT called from inside this function, which stays fast/read-only per
   *  its own contract below). Omitted -> `renderLlamaServerUnit`'s default of relying on a
   *  bare `llama-server` already being on PATH, unchanged from before WI-1617. */
  binPath?: string;
  /** Exec injection for the container-runtime probe (D-009 #3/P-013) — tests only; production
   *  callers rely on the default (real `docker`/`podman` exec). */
  vllmDeps?: VllmImageDeps;
  /** Override the vLLM image pin — tests / a future multi-image catalog. Defaults to
   *  `VLLM_PINNED_IMAGE`. */
  vllmImage?: string;
  /** Host directory bind-mounted to the vLLM container's `/root/.cache/huggingface`. Defaults
   *  to `${home}/.cache/huggingface`. */
  hfCacheDir?: string;
  /** Filesystem seams for the read-only HF cache ownership assertion; tests only. */
  hfCacheOwnershipDeps?: HfCacheOwnershipDeps;
}

function defaultHome(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? '';
}

/**
 * Detect hardware, pick a combo, and resolve its weights + render its config — all read-only
 * besides a filesystem probe for already-downloaded weights. Safe to call at any time.
 */
export async function planProvision(opts: PlanProvisionOptions = {}): Promise<ProvisionPlan> {
  const hardware = await detectHardware(opts.hardwareDeps);
  // Container-runtime probing only matters where a vLLM candidate could ever match (NVIDIA —
  // D-004: vLLM is CUDA-only) — skip the two extra subprocess spawns on Apple/AMD/CPU hardware.
  const containerRuntime: ContainerRuntimeInfo | null =
    hardware.gpu?.vendor === 'nvidia' ? await detectContainerRuntime(opts.vllmDeps?.exec) : null;
  const recommendation = recommendCombo(hardware, opts.catalog, {
    containerRuntimeAvailable: containerRuntime ? containerRuntime.runtime !== null : undefined,
  });

  if (!recommendation.entry) {
    return {
      hardware,
      recommendation,
      weights: null,
      containerRuntime,
      hfCacheOwnership: null,
      backendId: '',
      unitFileContent: null,
      unitFilePath: '',
      gatewayRegisterInput: null,
      blocked: recommendation.reason,
    };
  }

  const entry = recommendation.entry;
  const vllmImage = opts.vllmImage ?? VLLM_PINNED_IMAGE;
  const weights: WeightsPlan =
    entry.backend === 'llama-server'
      ? await resolveOllamaWeights(entry.model.ollamaRef, opts.ollamaDeps)
      : entry.backend === 'vllm'
        ? await resolveVllmImage(vllmImage, { ...opts.vllmDeps, runtimeInfo: containerRuntime ?? undefined })
        : { needsDownload: true, detail: `download flow for backend kind '${entry.backend}' is not implemented yet`, pullHint: undefined };

  const backendId = opts.backendId ?? `provisioner-${entry.id}`;
  const home = opts.home ?? defaultHome();
  const unitFilePath = opts.unitFilePath ?? `${home}/.config/systemd/user/${backendId}.service`;
  const logPath = opts.logPath ?? `${home}/.papercusp/${backendId}.log`;
  const hfCacheDir = opts.hfCacheDir ?? `${home}/.cache/huggingface`;
  const hfCacheOwnership =
    entry.backend === 'vllm' ? await inspectHfCacheOwnership(hfCacheDir, opts.hfCacheOwnershipDeps) : null;
  const cacheOwnershipBlocked = hfCacheOwnership && !hfCacheOwnership.healthy
    ? `Hugging Face cache ownership check failed for ${hfCacheDir}: ${hfCacheOwnership.detail}`
    : null;

  const unitFileContent =
    !cacheOwnershipBlocked && !weights.needsDownload && weights.weightsPath
      ? entry.backend === 'vllm' && containerRuntime?.runtime
        ? renderVllmContainerUnit({
            runtime: containerRuntime.runtime,
            containerName: backendId,
            image: weights.weightsPath,
            hfModelRepo: entry.model.hfRepo ?? entry.model.ollamaRef,
            servedModelName: entry.model.ollamaRef,
            quantization: entry.model.quantization ?? 'awq',
            host: entry.serve.host,
            port: entry.serve.portDefault,
            maxModelLen: entry.serve.ctxTotal,
            gpuMemoryUtilization: entry.serve.gpuMemoryUtilization ?? 0.9,
            hfCacheDir,
            logPath,
          })
        : entry.backend === 'llama-server'
          ? renderLlamaServerUnit({
              alias: entry.model.ollamaRef,
              weightsPath: weights.weightsPath,
              host: entry.serve.host,
              port: entry.serve.portDefault,
              parallelSlots: entry.serve.parallelSlots,
              ctxTotal: entry.serve.ctxTotal,
              kvCacheType: entry.serve.kvCacheType,
              flashAttn: entry.serve.flashAttn,
              jinja: entry.serve.jinja,
              reasoningBudget: entry.serve.reasoningBudget,
              // The GPU-offload flags the drift guard compares: a wizard-written unit that omitted
              // them would be reported as drifted by the very next cold-start audit (WI-10006354).
              gpuLayers: entry.serve.gpuLayers,
              fit: entry.serve.fit,
              fitTargetMiB: entry.serve.fitTargetMiB,
              logPath,
              binPath: opts.binPath,
            })
          : null
      : null;

  const gatewayRegisterInput: RegisterLocalBackendInput | null =
    !cacheOwnershipBlocked && !weights.needsDownload && weights.weightsPath
      ? {
          id: backendId,
          kind: entry.backend,
          baseUrl: `http://${entry.serve.host}:${entry.serve.portDefault}`,
          models: [entry.model.ollamaRef],
          maxConcurrent: entry.serve.parallelSlots,
          // Carry the catalog's RECOMMENDED lifecycle into the registry, which is the operative
          // truth the reaper and the gateway read (D-005). Unset in the catalog ⇒ 'always-on',
          // so this can only ever preserve today's behaviour for an entry that says nothing.
          lifecycle: entry.serve.lifecycle ?? 'always-on',
          idleTtlSec: entry.serve.idleTtlSec ?? null,
          // This function is the only place that knows BOTH the catalog entry and the unit file
          // it is about to write, which is exactly why the unit name is captured here rather than
          // inferred later from baseUrl — for a backend fronted by a proxy those differ, and
          // guessing stops the wrong process (D-005).
          unitName: `${backendId}.service`,
        }
      : null;

  const blocked = cacheOwnershipBlocked ?? (weights.needsDownload
    ? `${entry.backend === 'vllm' ? 'container image' : 'weights'} not present locally — ${weights.pullHint ?? weights.detail ?? 'a download is required'}`
    : null);

  return { hardware, recommendation, weights, containerRuntime, hfCacheOwnership, backendId, unitFileContent, unitFilePath, gatewayRegisterInput, blocked };
}

export interface ApplyProvisionOptions {
  writeFile?: (path: string, content: string) => Promise<void>;
  mkdir?: (path: string) => Promise<void>;
  registerBackend?: (input: RegisterLocalBackendInput) => Promise<LocalBackendRecord>;
  /** Enable + start the systemd unit and health-check it. **Defaults to false — this is the
   *  ONLY thing in this whole module that loads a model onto the GPU.** Never set true while
   *  another process needs the card (check coord:presence / coord:ask first). */
  start?: boolean;
  runSystemctl?: (args: string[]) => Promise<{ stdout: string; stderr: string }>;
  healthCheck?: (baseUrl: string) => Promise<boolean>;
}

export interface ApplyProvisionResult {
  ok: boolean;
  wroteUnit: boolean;
  registered: boolean;
  started: boolean;
  error?: string;
}

async function defaultSystemctl(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const r = await execFileAsync('systemctl', args, { timeout: 15000 });
  return { stdout: r.stdout, stderr: r.stderr };
}

async function defaultHealthCheck(baseUrl: string): Promise<boolean> {
  try {
    const r = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5000) });
    return r.ok;
  } catch {
    return false;
  }
}

/* ────────────────────────────────────────────────────────────────────────────────────────
 * Runtime lifecycle (on-demand-local-inference-lifecycle-2026-08-17 P-006)
 *
 * `applyProvision` above is the WIZARD's one-shot start. The two functions below are the
 * RUNTIME seam the idle-reaper (P-007) and the gateway's ensure-running path (P-008) call
 * against an ALREADY-REGISTERED backend. They deliberately live beside `applyProvision` and
 * reuse the same `defaultSystemctl` / `defaultHealthCheck` injection points, so this module
 * stays the single place that knows how this repo talks to systemctl about a backend — one
 * exec path to audit, and no second copy to drift.
 *
 * No new spawn mechanism: both go through the same short-lived, non-detached `execFile` that
 * was already here, so `lint:no-unenrolled-spawn` / the managedSpawn enrolment rules are
 * satisfied by inheritance (an ordinary child of an already-confined process).
 * ──────────────────────────────────────────────────────────────────────────────────────── */

/** The fields of a `LocalBackendRecord` these operations act on. Deliberately a structural
 *  subset rather than the whole record: the reaper reads rows from the registry, but a test
 *  (or the CLI) can drive these with a literal, and neither needs a DB. */
export interface BackendLifecycleTarget {
  id: string;
  /** From the registry (migration 843). `null` ⇒ this backend has no unit recorded, and both
   *  operations below REFUSE rather than guess — see the D-005 note on `LocalBackendRecord`. */
  unitName: string | null;
  /** The alias set this backend serves, straight off the registry row. Optional: it exists ONLY
   *  to resolve the catalog entry for the cold-start unit audit (D-016), and every pre-existing
   *  construction site stays valid without it — absent simply makes the audit `unauditable`. */
  models?: readonly string[];
  /** Backend engine, for the same resolution — it disambiguates one model served two ways. */
  kind?: string;
  /** What the gateway actually routes to. Health is checked here, end-to-end, rather than on
   *  the unit's own port: for a proxied backend those differ, and the routable address is the
   *  one whose readiness callers care about. */
  baseUrl: string;
}

export interface BackendLifecycleOptions {
  runSystemctl?: (args: string[]) => Promise<{ stdout: string; stderr: string }>;
  healthCheck?: (baseUrl: string) => Promise<boolean>;
}

export interface StopBackendResult {
  ok: boolean;
  /** True only when `systemctl stop` was actually issued and returned cleanly. */
  stopped: boolean;
  unitName: string | null;
  error?: string;
}

/**
 * Stop an on-demand backend's systemd unit, freeing whatever it holds (for `llama-ornith`,
 * ~19.8GB of VRAM).
 *
 * **Refuses when `unitName` is null instead of falling back to `baseUrl`.** That refusal is
 * the whole point of the function's shape, not defensive noise: measured on this box,
 * `ornith-llamaserver`'s baseUrl `:11435` is the always-on `ollama-schema-proxy.service`,
 * while the GPU-resident process is `llama-ornith.service` on `:11436`. A baseUrl-derived
 * stop kills the cheap proxy, leaves the 19.8GB process resident, and reports success (D-005).
 *
 * `stop` only — never `disable`. Disabling additionally changes boot behaviour, which is a
 * policy decision belonging to whoever registered the backend, not to an idle sweep.
 */
export async function stopLocalBackend(
  target: BackendLifecycleTarget,
  opts: BackendLifecycleOptions = {},
): Promise<StopBackendResult> {
  if (!target.unitName) {
    return {
      ok: false,
      stopped: false,
      unitName: null,
      error: `backend '${target.id}' has no unitName recorded — refusing to derive one from baseUrl (D-005)`,
    };
  }

  const systemctl = opts.runSystemctl ?? defaultSystemctl;
  try {
    // `Restart=on-failure` (backend-config.ts) — a deliberate stop is not a failure, so
    // systemd will not race us by restarting the unit.
    await systemctl(['--user', 'stop', target.unitName]);
    return { ok: true, stopped: true, unitName: target.unitName };
  } catch (err) {
    return {
      ok: false,
      stopped: false,
      unitName: target.unitName,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface EnsureBackendRunningOptions extends BackendLifecycleOptions {
  /** How long to wait for the backend to answer its health check after `systemctl start`.
   *
   *  **REQUIRED — there is deliberately no default.** Cold start here means faulting a
   *  multi-GB quantized model off disk (ornith is 15.5GB IQ3_M), and that duration has not
   *  been measured on this box. A default would be a guess that every caller silently
   *  inherits; making it required forces the caller that DOES know (P-008, from a real
   *  measurement) to state it. */
  readyTimeoutMs: number;
  /** Gap between health polls while waiting (default 1000ms). */
  pollIntervalMs?: number;
  /** Injected for hermetic tests — the default is real wall-clock. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Where the cold-start audit (D-016) REPORTS. Omitted ⇒ the audit still runs and still lands on
   *  the result, it just goes nowhere a human will see — so a caller on the request path should
   *  pass this. It is called for EVERY verdict including `ok`, because a caller that only hears
   *  about failures cannot tell a passing guard from an absent one. */
  onUnitAudit?: (audit: DeployedUnitAudit) => void;
  /** Read the DEPLOYED unit text. Default `systemctl --user cat <unit>`, which is the deployed
   *  truth including drop-ins — as opposed to re-deriving a path the unit may not live at. */
  readUnitText?: (unitName: string) => Promise<string>;
  /** Catalog to resolve the entry against (default `CERTIFIED_CATALOG`). */
  catalog?: readonly CatalogEntry[];
  /** Injected for hermetic tests — the binary-existence probe. */
  access?: (path: string, mode: number) => Promise<void>;
}

export interface EnsureBackendRunningResult {
  ok: boolean;
  /** Health check passed BEFORE we touched systemd — the common case on a warm backend. */
  alreadyRunning: boolean;
  /** `systemctl start` was issued. */
  started: boolean;
  /** The backend answered its health check within `readyTimeoutMs`. */
  healthy: boolean;
  waitedMs: number;
  error?: string;
  /** The cold-start unit audit (D-016). Present only on the START path; `undefined` on the warm
   *  path means NOT CHECKED, never "checked and clean" — the audit's own `unauditable` verdict is
   *  what "checked, could not conclude" looks like. */
  unitAudit?: DeployedUnitAudit;
}

/**
 * Ensure an on-demand backend is up and answering, starting it if it is not.
 *
 * Health is probed FIRST, so a warm backend costs one HTTP request and no subprocess — this
 * sits on the gateway's request path (P-008), where the overwhelmingly common case is
 * "already running".
 *
 * Concurrency is safe without an in-process guard: systemd merges concurrent `start` jobs for
 * the same unit, so N simultaneous callers produce one activation. De-duplicating the *wait*
 * (so N requests don't each hold a connection for the cold-start duration) is the gateway's
 * concern, not this seam's.
 *
 * On timeout the unit is left RUNNING and `healthy:false` is returned — a model part-way
 * through loading is worth more than a clean slate, and the caller may want to fail this one
 * request while the load completes for the next.
 */
export async function ensureLocalBackendRunning(
  target: BackendLifecycleTarget,
  opts: EnsureBackendRunningOptions,
): Promise<EnsureBackendRunningResult> {
  const healthCheck = opts.healthCheck ?? defaultHealthCheck;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollIntervalMs = opts.pollIntervalMs ?? 1000;
  const startedAt = now();

  if (await healthCheck(target.baseUrl)) {
    return { ok: true, alreadyRunning: true, started: false, healthy: true, waitedMs: 0 };
  }

  if (!target.unitName) {
    return {
      ok: false,
      alreadyRunning: false,
      started: false,
      healthy: false,
      waitedMs: now() - startedAt,
      error: `backend '${target.id}' has no unitName recorded — refusing to derive one from baseUrl (D-005)`,
    };
  }

  const systemctl = opts.runSystemctl ?? defaultSystemctl;

  // AUDIT THE UNIT WE ARE ABOUT TO START (D-016, WI-39735). This is the guard's production caller:
  // provisioner/unit-drift can compare a deployed unit against its catalog entry, and until now
  // nothing in production ever asked it to — it ran only when a test happened to select the
  // provisioner suite, i.e. when someone edited the provisioner, never when the deployed unit
  // changed underneath it. A widened detector nobody calls is decoration.
  //
  // WHY HERE. This is the one moment the system deliberately looks at a stopped unit and decides to
  // run it, so the check costs nothing anybody waits on: a cold start here is ~90s of model load
  // and `systemctl cat` is a few ms. It is also the moment the answer is most actionable — both
  // historical incidents (a deleted engine binary, missing CUDA env) presented as a start that
  // "worked" and then served wrong or timed out silently.
  //
  // WHY BEFORE THE START, not after: the binary check EXPLAINS a failed start (203/EXEC), so
  // running it first means the log line that diagnoses the failure is already emitted when the
  // failure happens, instead of never (we return early on a start error).
  //
  // WHY IT WARNS AND NEVER REFUSES. A degraded backend still serves; refusing to start one turns a
  // slow-but-answering box into a dead one, and converts every false positive in this guard into an
  // outage. That asymmetry is also what keeps the guard alive: a warning that cries wolf gets
  // fixed, a refusal that cries wolf gets deleted. The audit therefore cannot fail the start —
  // including by throwing, which is what the catch-all is for.
  let unitAudit: DeployedUnitAudit | undefined;
  try {
    const readUnitText = opts.readUnitText ?? ((unit: string) => systemctl(['--user', 'cat', unit]).then((r) => r.stdout));
    unitAudit = await auditDeployedUnitForBackend(
      { models: target.models, kind: target.kind },
      await readUnitText(target.unitName),
      { access: opts.access, catalog: opts.catalog },
    );
  } catch (err) {
    unitAudit = {
      verdict: 'unauditable',
      catalogEntryId: null,
      drift: [],
      envIssues: [],
      binary: null,
      model: null,
      summary: `unit audit could not run:${err instanceof Error ? err.message : String(err)}`,
    };
  }
  try {
    opts.onUnitAudit?.(unitAudit);
  } catch {
    // A broken reporter must not fail a start either.
  }

  try {
    await systemctl(['--user', 'start', target.unitName]);
  } catch (err) {
    return {
      ok: false,
      alreadyRunning: false,
      started: false,
      healthy: false,
      waitedMs: now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
      unitAudit,
    };
  }

  // Poll until the deadline. The FIRST probe happens after one interval: `systemctl start`
  // has just returned, and for a cold model load there is no chance it is ready yet.
  while (now() - startedAt < opts.readyTimeoutMs) {
    await sleep(pollIntervalMs);
    if (await healthCheck(target.baseUrl)) {
      return { ok: true, alreadyRunning: false, started: true, healthy: true, waitedMs: now() - startedAt, unitAudit };
    }
  }

  return {
    ok: false,
    alreadyRunning: false,
    started: true,
    healthy: false,
    waitedMs: now() - startedAt,
    // A timeout and a degraded unit have the same outward shape (see checkUnitExecStartBinary's
    // header: a missing binary read as a slow 15.5GB load for 15 minutes), so name the audit
    // verdict right here rather than leaving the reader to correlate two log lines.
    error:
      `backend '${target.id}' (${target.unitName}) did not answer ${target.baseUrl} within ${opts.readyTimeoutMs}ms — unit left running` +
      (unitAudit && unitAudit.verdict !== 'ok' ? ` · unit audit: ${unitAudit.summary}` : ''),
    unitAudit,
  };
}

/**
 * Apply a plan: write the unit file + register the backend in the gateway pool's durable
 * registry. With `opts.start` left at its default (`false`), this NEVER starts a process or
 * touches the GPU — it only writes a config file and a Postgres row.
 */
export async function applyProvision(plan: ProvisionPlan, opts: ApplyProvisionOptions = {}): Promise<ApplyProvisionResult> {
  if (plan.blocked) {
    return { ok: false, wroteUnit: false, registered: false, started: false, error: plan.blocked };
  }

  const doWriteFile = opts.writeFile ?? ((p: string, c: string) => writeFile(p, c, 'utf8'));
  const doMkdir = opts.mkdir ?? ((p: string) => mkdir(p, { recursive: true }).then(() => undefined));

  let wroteUnit = false;
  if (plan.unitFileContent) {
    await doMkdir(dirname(plan.unitFilePath));
    await doWriteFile(plan.unitFilePath, plan.unitFileContent);
    wroteUnit = true;
  }

  let registered = false;
  if (plan.gatewayRegisterInput) {
    const register = opts.registerBackend ?? registerLocalBackend;
    await register(plan.gatewayRegisterInput);
    registered = true;
  }

  let started = false;
  if (opts.start && plan.unitFileContent) {
    const systemctl = opts.runSystemctl ?? defaultSystemctl;
    const healthCheck = opts.healthCheck ?? defaultHealthCheck;
    await systemctl(['--user', 'daemon-reload']);
    await systemctl(['--user', 'enable', '--now', `${plan.backendId}.service`]);
    started = await healthCheck(plan.gatewayRegisterInput!.baseUrl);
  }

  return { ok: true, wroteUnit, registered, started };
}
