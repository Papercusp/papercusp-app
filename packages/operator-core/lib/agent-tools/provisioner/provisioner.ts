/**
 * provisioner:* — agent control surface for the provisioner wizard (local-concurrent-
 * inference-2026-07-02 P-009, D-006 "detect → recommend → download/configure → register").
 * The headless-CLI/agent-facing mirror of the Desktop SetupWizard step — both drive the SAME
 * `provisioner/provision.ts` core, so there's one place the logic can drift out of sync.
 *
 * `provisioner:detect_hardware` / `provisioner:recommend` / `provisioner:plan_install` are all
 * READ-ONLY (the last does a filesystem probe for already-downloaded weights, nothing else).
 * `provisioner:install` is the one WRITE tool, and even it defaults to config-write +
 * gateway-registry-write only — it does NOT start the backend (and therefore does not touch
 * the GPU) unless the caller explicitly passes `start: true`.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { detectHardware } from '../../provisioner/hardware-detect';
import { recommendCombo } from '../../provisioner/recommend';
import { planProvision, applyProvision } from '../../provisioner/provision';
import { resolveLlamaBinary, computeCapToArch } from '../../provisioner/llama-binary';
import { detectContainerRuntime, pullVllmImage, VLLM_PINNED_IMAGE } from '../../provisioner/vllm-container';
import { pullOllamaWeights } from '../../provisioner/weights';

const ok = (p: Record<string, unknown>) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, ...p }) }] });
const fail = (p: Record<string, unknown>) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, ...p }) }] });
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

export const provisionerDetectHardwareTool = defineTool({
  name: 'provisioner:detect_hardware',
  description:
    "Probe this machine's GPU vendor/VRAM and platform (nvidia-smi / rocm-smi / sysctl — all read-only, never touches a GPU's resident memory). Returns {ok, hardware:{platform,arch,ramGB,gpu,notes}}.",
  guidance: {
    when: 'First-run provisioning, or re-checking hardware after a driver/GPU change.',
    notWhen: "You already have a recent detectHardware() result and just need a recommendation — that's provisioner:recommend, which detects internally.",
    chaining: 'provisioner:detect_hardware → provisioner:recommend (or call recommend directly, it re-detects) → provisioner:plan_install → provisioner:install.',
    seeAlso: ['provisioner:recommend', 'provisioner:plan_install'],
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({}),
  async handler() {
    try {
      const hardware = await detectHardware();
      return ok({ hardware });
    } catch (e) {
      return fail({ error: `provisioner:detect_hardware failed: ${errMsg(e)}` });
    }
  },
});

export const provisionerRecommendTool = defineTool({
  name: 'provisioner:recommend',
  description:
    "Detect this machine's hardware and recommend a catalog combo for it (D-005 catalog — entries may be `status:'provisional'` until the P-006/P-007 certification battery lands). Returns {ok, hardware, recommendation:{entry,tier,reason}}. `entry:null` means no local combo fits (surfaced in `reason`, e.g. no GPU → cloud gateway).",
  guidance: {
    when: 'Deciding what to install before committing to a plan/apply.',
    notWhen: "You're ready to actually write config — that's provisioner:plan_install (does the same detect+recommend, plus weights resolution + rendered config).",
    chaining: 'provisioner:recommend → provisioner:plan_install → provisioner:install.',
    seeAlso: ['provisioner:detect_hardware', 'provisioner:plan_install'],
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({}),
  async handler() {
    try {
      const hardware = await detectHardware();
      const recommendation = recommendCombo(hardware);
      return ok({ hardware, recommendation });
    } catch (e) {
      return fail({ error: `provisioner:recommend failed: ${errMsg(e)}` });
    }
  },
});

export const provisionerPlanInstallTool = defineTool({
  name: 'provisioner:plan_install',
  description:
    'Dry-run the full provisioner flow: detect hardware → recommend a combo → resolve its weights against the local ollama blob store → render its backend config. Performs NO writes (not the systemd unit, not the gateway registry) — this is provisioner:install\'s plan, without applying it. Returns {ok, plan:{hardware,recommendation,weights,unitFileContent,unitFilePath,gatewayRegisterInput,blocked}}. `blocked` non-null means it cannot be applied as-is yet (no combo fits, or weights need `ollama pull` first).',
  guidance: {
    when: 'Previewing exactly what provisioner:install would write, before committing.',
    notWhen: "You just want the recommendation without the weights/config detail — that's provisioner:recommend (cheaper, no filesystem probe).",
    chaining: 'provisioner:plan_install → (if blocked is null) provisioner:install.',
    seeAlso: ['provisioner:recommend', 'provisioner:install'],
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({}),
  async handler() {
    try {
      const plan = await planProvision();
      return ok({ plan });
    } catch (e) {
      return fail({ error: `provisioner:plan_install failed: ${errMsg(e)}` });
    }
  },
});

export const provisionerInstallTool = defineTool({
  name: 'provisioner:install',
  description:
    "Plan + apply the provisioner flow: write the recommended backend's systemd user-unit + register it in the gateway's local-backend pool. Default: no start, no GPU touch — pass `start:true` to enable+start + health-check it (loads the model onto the GPU). `provisionBinary:true` (WI-1617) resolves a real `llama-server` binary first; `pullVllmImage:true` (WI-1618, vLLM combos only) pulls the pinned vLLM image first; `pullWeights:true` pulls missing llama-server weights first — each can take real minutes and fails the call outright rather than silently falling back. Returns {ok, plan, result:{wroteUnit,registered,started}}; `plan.blocked` non-null refuses the apply with `result.error`.",
  guidance: {
    when: 'Actually provisioning a local inference backend after reviewing provisioner:plan_install\'s output.',
    notWhen: 'A GPU-resident process may already be running — check coord:presence and send a directed coord:send when coordination is needed before `start:true`. Config-write + registry-registration alone (start omitted/false) is always safe. To preview without committing to a download/build, use provisioner:plan_install.',
    chaining: 'provisioner:plan_install (review) → provisioner:install (start:false default; add provisionBinary:true / pullVllmImage:true on first run) → once verified idle, provisioner:install again with start:true, or start the unit manually.',
    seeAlso: ['provisioner:plan_install', 'gateway:local_backend_list', 'gateway:local_backend_register'],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    start: z
      .boolean()
      .optional()
      .describe(
        'Also enable+start the systemd unit and health-check it. Default false. WARNING: true loads the recommended model onto the GPU — check coord:presence and coordinate directly via coord:send first.',
      ),
    provisionBinary: z
      .boolean()
      .optional()
      .describe(
        'Resolve (download a matching GitHub-release prebuilt, or build from source) a real llama-server binary before planning, instead of assuming one is already on PATH. Default false. A from-source build can take real minutes.',
      ),
    pullVllmImage: z
      .boolean()
      .optional()
      .describe(
        'Pull the pinned vLLM container image (docker/podman) before planning, instead of assuming it is already cached locally. Default false. A first pull is a real multi-GB network fetch. Only meaningful when a working container runtime is present and the recommended combo is a vllm entry.',
      ),
    pullWeights: z
      .boolean()
      .optional()
      .describe(
        'Pull the recommended llama-server model into the local ollama blob store before planning/apply when weights are missing, instead of stopping at a manual `ollama pull` hint. Default false.',
      ),
  }),
  async handler({ start, provisionBinary, pullVllmImage: doPullVllmImage, pullWeights }) {
    try {
      let binPath: string | undefined;
      if (provisionBinary) {
        const hw = await detectHardware();
        const binaryResult = await resolveLlamaBinary(hw, {
          cudaArch: hw.gpu?.vendor === 'nvidia' && hw.gpu.computeCap ? computeCapToArch(hw.gpu.computeCap) : undefined,
          cudaHostCompiler: hw.gpu?.vendor === 'nvidia' ? process.env.PAPERCUSP_CUDA_HOST_COMPILER : undefined,
        });
        if (!binaryResult.ok) {
          return fail({ error: `provisioner:install failed: binary provisioning failed: ${binaryResult.blocked}` });
        }
        binPath = binaryResult.binPath;
      }
      if (doPullVllmImage) {
        const runtimeInfo = await detectContainerRuntime();
        const imageResult = await pullVllmImage(VLLM_PINNED_IMAGE, { runtimeInfo });
        if (!imageResult.ok) {
          return fail({ error: `provisioner:install failed: vLLM image provisioning failed: ${imageResult.blocked}` });
        }
      }
      let plan = await planProvision({ binPath });
      if (pullWeights && plan.recommendation.entry?.backend === 'llama-server' && plan.weights?.needsDownload) {
        const weightResult = await pullOllamaWeights(plan.recommendation.entry.model.ollamaRef);
        if (!weightResult.ok) {
          return fail({ error: `provisioner:install failed: weight provisioning failed: ${weightResult.blocked}` });
        }
        plan = await planProvision({ binPath });
      }
      const result = await applyProvision(plan, { start: start ?? false });
      return ok({ plan, result });
    } catch (e) {
      return fail({ error: `provisioner:install failed: ${errMsg(e)}` });
    }
  },
});
