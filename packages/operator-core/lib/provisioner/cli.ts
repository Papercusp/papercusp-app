#!/usr/bin/env node
/**
 * Headless CLI for the provisioner wizard (local-concurrent-inference-2026-07-02 P-009, D-006).
 * The non-Desktop entrypoint to the SAME plan/apply logic the SetupWizard step drives via
 * `/api/desktop/provisioner*` (provision.ts is the shared core — no forked logic here).
 *
 * Usage:
 *   npx tsx packages/operator-core/lib/provisioner/cli.ts               # detect + recommend + dry-run plan
 *   npx tsx packages/operator-core/lib/provisioner/cli.ts --install     # write config + register in the
 *                                                                        # gateway pool (does NOT start it)
 *   npx tsx packages/operator-core/lib/provisioner/cli.ts --install --start
 *                                                                        # ALSO enable+start the backend —
 *                                                                        # this loads the model onto the
 *                                                                        # GPU. Confirm nothing else is
 *                                                                        # GPU-resident first (coord:presence
 *                                                                        # / coord:ask) — this is the ONLY
 *                                                                        # flag in this tool that touches
 *                                                                        # the GPU.
 *   npx tsx packages/operator-core/lib/provisioner/cli.ts --provision-binary
 *                                                                        # resolve a llama-server BINARY
 *                                                                        # first (llama-binary.ts): a
 *                                                                        # cached/prebuilt-asset hit is
 *                                                                        # fast, a from-source build takes
 *                                                                        # real minutes of CPU + touches
 *                                                                        # the network — opt-in, and safe
 *                                                                        # to combine with --install (never
 *                                                                        # with plain dry-run only, since
 *                                                                        # the resolved binPath would just
 *                                                                        # be discarded).
 *   npx tsx packages/operator-core/lib/provisioner/cli.ts --provision-vllm-image
 *                                                                        # pull the pinned vLLM container
 *                                                                        # IMAGE first (vllm-container.ts's
 *                                                                        # `pullVllmImage`, D-009 #3/P-013):
 *                                                                        # a cache hit is fast, a fresh pull
 *                                                                        # is a real multi-GB network fetch
 *                                                                        # — opt-in, mirrors --provision-
 *                                                                        # binary. Only meaningful when the
 *                                                                        # recommended combo is a vllm entry
 *                                                                        # AND a working Docker/Podman
 *                                                                        # runtime was detected — otherwise
 *                                                                        # a no-op (nothing to pull yet:
 *                                                                        # no vLLM catalog entry exists
 *                                                                        # until P-008 lands one).
 *   npx tsx packages/operator-core/lib/provisioner/cli.ts --pull-weights
 *                                                                        # pull the recommended
 *                                                                        # llama-server model into
 *                                                                        # the local ollama blob
 *                                                                        # store before planning /
 *                                                                        # install, instead of
 *                                                                        # stopping at a manual
 *                                                                        # `ollama pull` hint.
 *   npx tsx packages/operator-core/lib/provisioner/cli.ts --json        # machine-readable output
 *
 * Exit code: 0 on a successful detect/plan (and, with --install, a successful apply); 1 if the
 * plan is blocked (no combo fits / weights or image missing / binary or image provisioning
 * failed) or --install's apply fails.
 */
import { planProvision, applyProvision } from './provision';
import { detectHardware } from './hardware-detect';
import { resolveLlamaBinary, computeCapToArch } from './llama-binary';
import { detectContainerRuntime, pullVllmImage, VLLM_PINNED_IMAGE } from './vllm-container';
import { pullOllamaWeights } from './weights';

interface CliArgs {
  install: boolean;
  start: boolean;
  json: boolean;
  provisionBinary: boolean;
  provisionVllmImage: boolean;
  pullWeights: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  return {
    install: argv.includes('--install'),
    start: argv.includes('--start'),
    json: argv.includes('--json'),
    provisionBinary: argv.includes('--provision-binary'),
    provisionVllmImage: argv.includes('--provision-vllm-image'),
    pullWeights: argv.includes('--pull-weights'),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let binPath: string | undefined;
  if (args.provisionBinary) {
    const hw = await detectHardware();
    const result = await resolveLlamaBinary(hw, {
      cudaArch: hw.gpu?.vendor === 'nvidia' && hw.gpu.computeCap ? computeCapToArch(hw.gpu.computeCap) : undefined,
      cudaHostCompiler: hw.gpu?.vendor === 'nvidia' ? process.env.PAPERCUSP_CUDA_HOST_COMPILER : undefined,
    });
    if (!args.json) {
      console.log(result.ok ? `Binary: ${result.binPath} (${result.fromCache ? 'cached' : result.manifest?.source})` : `Binary provisioning BLOCKED: ${result.blocked}`);
    }
    if (!result.ok) {
      if (args.json) console.log(JSON.stringify({ binaryResult: result }, null, 2));
      process.exitCode = 1;
      return;
    }
    binPath = result.binPath;
  }

  if (args.provisionVllmImage) {
    const runtimeInfo = await detectContainerRuntime();
    const result = await pullVllmImage(VLLM_PINNED_IMAGE, { runtimeInfo });
    if (!args.json) {
      console.log(result.ok ? `vLLM image: ${result.image} (${result.alreadyPresent ? 'cached' : 'pulled'}, ${result.runtime})` : `vLLM image provisioning BLOCKED: ${result.blocked}`);
    }
    if (!result.ok) {
      if (args.json) console.log(JSON.stringify({ vllmImageResult: result }, null, 2));
      process.exitCode = 1;
      return;
    }
  }

  let plan = await planProvision({ binPath });

  if (args.pullWeights && plan.recommendation.entry?.backend === 'llama-server' && plan.weights?.needsDownload) {
    const pullResult = await pullOllamaWeights(plan.recommendation.entry.model.ollamaRef);
    if (!args.json) {
      console.log(pullResult.ok ? `Weights: pulled ${pullResult.ollamaRef}` : `Weight provisioning BLOCKED: ${pullResult.blocked}`);
    }
    if (!pullResult.ok) {
      if (args.json) console.log(JSON.stringify({ pullWeightsResult: pullResult }, null, 2));
      process.exitCode = 1;
      return;
    }
    plan = await planProvision({ binPath });
  }

  if (!args.json) {
    const hw = plan.hardware;
    const gpuDesc = hw.gpu ? `${hw.gpu.vendor} ${hw.gpu.model ?? ''} (${hw.gpu.vramGB ?? '?'}GB)`.trim() : 'none detected';
    console.log(`Hardware: ${hw.platform}/${hw.arch}, RAM ${hw.ramGB}GB, GPU: ${gpuDesc}`);
    console.log(`Recommendation: ${plan.recommendation.entry ? plan.recommendation.entry.displayName : '(none)'} — ${plan.recommendation.reason}`);
    if (plan.blocked) console.log(`BLOCKED: ${plan.blocked}`);
  }

  if (!args.install) {
    if (args.json) console.log(JSON.stringify({ plan }, null, 2));
    process.exitCode = plan.blocked ? 1 : 0;
    return;
  }

  if (args.start && !args.json) {
    console.log(
      '⚠️  --start will enable+start the backend and load the model onto the GPU. ' +
        'Make sure nothing else is currently GPU-resident (check coord:presence / coord:ask first).',
    );
  }

  const result = await applyProvision(plan, { start: args.start });
  if (args.json) {
    console.log(JSON.stringify({ plan, result }, null, 2));
  } else {
    console.log(`Install: ${JSON.stringify(result)}`);
  }
  process.exitCode = result.ok ? 0 : 1;
}

main().catch((e) => {
  console.error('[provisioner] fatal:', (e as Error)?.stack || String(e));
  process.exitCode = 1;
});
