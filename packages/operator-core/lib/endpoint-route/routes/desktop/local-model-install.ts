/**
 * POST /api/desktop/local-model-install — the provisioner wizard's Desktop-UI write side
 * (local-concurrent-inference-2026-07-02 P-009). Plans + applies via `provisioner/provision.ts`
 * (same core as the CLI and the `provisioner:install` agent-tool): writes the backend's systemd
 * unit and registers it in the gateway's durable local-backend pool.
 *
 * Body: `{ start?: boolean, provisionBinary?: boolean, pullVllmImage?: boolean, pullWeights?: boolean }`.
 *  - `start` DEFAULTS TO FALSE — config-write + gateway-registration only, no process started,
 *    no GPU touched. `start:true` also enables+starts the systemd unit and health-checks it,
 *    which DOES load the model onto the GPU; the StepLocalModel UI gates that behind an
 *    explicit confirmation (see its warning copy) — this route trusts the caller already got
 *    that confirmation and does not re-derive it server-side.
 *  - `provisionBinary` DEFAULTS TO FALSE (mirrors the CLI's opt-in `--provision-binary` flag,
 *    WI-1617/D-009 #2). When true, resolves (and, on a cache miss, downloads a matching
 *    GitHub-release prebuilt or builds from source — llama-binary.ts's `resolveLlamaBinary`,
 *    itself opt-in/heavy on purpose) a real `llama-server` binary BEFORE planning, so the
 *    rendered systemd unit points at that resolved binPath instead of assuming `llama-server`
 *    is already on the user's PATH. A from-source build genuinely takes real minutes of
 *    CPU/network — this request can be slow when `provisionBinary:true` is set and there is no
 *    cache hit; StepLocalModel.tsx's "Installing…" state already covers an arbitrarily long
 *    wait (no client-side timeout on this same-machine fetch). On a resolve failure, the route
 *    returns `{ ok:false, error }` WITHOUT falling back to a bare-PATH assumption — a caller
 *    that explicitly asked for binary provisioning gets an honest failure, not a silent skip.
 *  - `pullVllmImage` DEFAULTS TO FALSE (mirrors the CLI's opt-in `--provision-vllm-image` flag,
 *    WI-1618/D-009 #3). When true, pulls the pinned vLLM container image (vllm-container.ts's
 *    `pullVllmImage`) BEFORE planning if it isn't already cached locally — a real multi-GB
 *    network fetch on a cache miss, same slow-request contract as `provisionBinary`. Only
 *    meaningful when a working Docker/Podman runtime is present and the recommended combo is a
 *    `vllm` entry; on a resolve failure the route returns `{ ok:false, error }` the same way.
 *  - `pullWeights` DEFAULTS TO FALSE. When true, and the recommended combo is a llama-server
 *    entry whose weights are not present locally, the route runs `ollama pull <ref>` BEFORE
 *    re-planning so the install can complete without a separate manual shell step.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { planProvision, applyProvision } from '../../../provisioner/provision';
import { detectHardware } from '../../../provisioner/hardware-detect';
import { resolveLlamaBinary, computeCapToArch } from '../../../provisioner/llama-binary';
import { detectContainerRuntime, pullVllmImage, VLLM_PINNED_IMAGE } from '../../../provisioner/vllm-container';
import { pullOllamaWeights } from '../../../provisioner/weights';

export default defineTool({
  method: 'POST',
  path: '/desktop/local-model-install',
  auth: {},
  async handler(req: Request) {
    let start = false;
    let provisionBinary = false;
    let provisionVllmImage = false;
    let pullWeights = false;
    try {
      const body = (await req.json().catch(() => ({}))) as {
        start?: unknown;
        provisionBinary?: unknown;
        pullVllmImage?: unknown;
        pullWeights?: unknown;
      };
      start = body?.start === true;
      provisionBinary = body?.provisionBinary === true;
      provisionVllmImage = body?.pullVllmImage === true;
      pullWeights = body?.pullWeights === true;
    } catch {
      // no/invalid body — default to the safe path (all opts false)
    }
    try {
      let binPath: string | undefined;
      if (provisionBinary) {
        const hw = await detectHardware();
        const binaryResult = await resolveLlamaBinary(hw, {
          cudaArch: hw.gpu?.vendor === 'nvidia' && hw.gpu.computeCap ? computeCapToArch(hw.gpu.computeCap) : undefined,
          cudaHostCompiler: hw.gpu?.vendor === 'nvidia' ? process.env.PAPERCUSP_CUDA_HOST_COMPILER : undefined,
        });
        if (!binaryResult.ok) {
          return Response.json({ ok: false, error: `binary provisioning failed: ${binaryResult.blocked}` }, { status: 500 });
        }
        binPath = binaryResult.binPath;
      }
      if (provisionVllmImage) {
        const runtimeInfo = await detectContainerRuntime();
        const imageResult = await pullVllmImage(VLLM_PINNED_IMAGE, { runtimeInfo });
        if (!imageResult.ok) {
          return Response.json({ ok: false, error: `vLLM image provisioning failed: ${imageResult.blocked}` }, { status: 500 });
        }
      }
      let plan = await planProvision({ binPath });
      if (pullWeights && plan.recommendation.entry?.backend === 'llama-server' && plan.weights?.needsDownload) {
        const weightResult = await pullOllamaWeights(plan.recommendation.entry.model.ollamaRef);
        if (!weightResult.ok) {
          return Response.json({ ok: false, error: `weight provisioning failed: ${weightResult.blocked}` }, { status: 500 });
        }
        plan = await planProvision({ binPath });
      }
      const result = await applyProvision(plan, { start });
      return Response.json({ ok: result.ok, plan, result });
    } catch (e) {
      return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
  },
});
