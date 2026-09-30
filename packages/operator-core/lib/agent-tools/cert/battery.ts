/**
 * cert:run / cert:catalog — the on-demand agent surface for the P-006 model
 * certification battery (WI-1659, fast-follow to local-concurrent-inference-2026-07-02
 * P-006/P-007). The battery (lib/inference-gateway/cert-battery, runCertBattery) was
 * previously invokable only as a library / an operational scratchpad runner — this
 * exposes it as discoverable agent-tools so any agent can re-certify a served backend
 * on demand without hand-writing a runner, and read back CERTIFIED_CATALOG (the
 * durable certification-evidence catalog, provisioner/catalog.ts) without grepping
 * source. No new catalog and no new battery — this is a thin tool wrapper over the
 * existing, already-tested library (D-005: "the catalog is a harness, not a list").
 *
 * `cert:run` performs LIVE network calls against a served OpenAI-compatible backend
 * (a local llama-server/vllm/ollama instance, or an explicit baseUrl) — it does not
 * write to our own durable state (no PG row), so this mirrors gym:judge's
 * `harness:read` capability (an evaluation call, not a governed-spend/ledger write)
 * rather than experiment:run's `harness:write` (which spends an accounted budget).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import { listLocalBackends, LOCAL_BACKEND_KINDS, type LocalBackendKind } from '../../inference-gateway/local-backend-store';
import { runCertBattery, createOpenAiProbeContext, type CertConfig } from '../../inference-gateway/cert-battery';
import { CERTIFIED_CATALOG, findCatalogEntry } from '../../provisioner/catalog';

const ok = (p: Record<string, unknown>) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, ...p }) }] });
const fail = (p: Record<string, unknown>) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, ...p }) }] });
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 400);

export const certRunTool = defineTool({
  name: 'cert:run',
  description:
    'Run the P-006 model-certification battery (behavior · trimmed-shape · comms · mangling-rate — a deterministic, no-LLM-judge harness, coordination-eval.ts D-002) LIVE against a served OpenAI-compatible backend, and return the CertReport (per-probe pass/fail + the aggregate mangling rate + a `certified`/`failed` verdict). Resolve the target EITHER by `backendId` (looked up in the local-backend registry — gateway:local_backend_list) OR an explicit `baseUrl` + `backend` kind. This is the on-demand re-cert surface for certifying additional models/configs beyond CERTIFIED_CATALOG entry #1 — it does NOT itself write a catalog entry; a human/agent promotes a `certified` verdict into provisioner/catalog.ts CERTIFIED_CATALOG by hand (per D-005, "never a parallel catalog"). Returns {ok, report}.',
  guidance: {
    when:
      'Certifying a NEW (model, quant, num_ctx, parallel, backend) combo before adding it to CERTIFIED_CATALOG, or re-certifying an existing one after a config/prompt change. Pass `backendId` when the backend is already registered (gateway:local_backend_list); otherwise pass `baseUrl` + `backend` directly.',
    notWhen:
      'Reading already-certified entries — cert:catalog. Certifying a CLOUD (Claude/Codex) account — this battery is for the LOCAL inference-backend pool only. Scoring one gym run\'s subjective quality — gym:judge.',
    chaining: 'gateway:local_backend_list (find backendId) → cert:run { backendId, model } → on a `certified` verdict, hand-add the entry to provisioner/catalog.ts CERTIFIED_CATALOG.',
    seeAlso: ['cert:catalog (read the certified entries)', 'gateway:local_backend_list', 'gateway:local_backend_register'],
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      backendId: z.string().min(1).optional().describe('A registered local-backend id (gateway:local_backend_list) — resolves baseUrl + backend kind. Mutually exclusive with baseUrl/backend.'),
      baseUrl: z.string().min(1).optional().describe("Explicit backend root, e.g. 'http://127.0.0.1:11436' (no trailing /v1). Use with `backend` when the target isn't registered."),
      backend: z.enum(LOCAL_BACKEND_KINDS).optional().describe('Serving engine kind — required when `baseUrl` is given instead of `backendId`.'),
      model: z.string().min(1).describe("The OpenAI /v1 model id the backend serves, e.g. 'maxwell1500/ornith-35b:IQ3_M'."),
      quant: z.string().optional().describe("Quantization label for the report's config, e.g. 'IQ3_M' or 'awq'. Default 'unknown' (descriptive only — does not reconfigure the backend)."),
      numCtx: z.number().int().positive().optional().describe('TOTAL context across all parallel slots, for the report\'s config (descriptive only). Default 0 (unknown).'),
      parallel: z.number().int().positive().optional().describe("Parallel slots, for the report's config (descriptive only). Default 1."),
      apiKey: z.string().optional().describe('Optional bearer token (local backends typically need none).'),
      timeoutMs: z.number().int().positive().max(300000).optional().describe('Per-probe-call timeout (default 60000).'),
      workspace: z.string().max(120).optional().describe('Workspace id (default: ctx / active workspace) — used to resolve `backendId`.'),
    })
    .refine((a) => Boolean(a.backendId) || (Boolean(a.baseUrl) && Boolean(a.backend)), {
      message: 'Provide either `backendId`, or both `baseUrl` and `backend`.',
    }),
  async handler(args, ctx) {
    const ws = args.workspace ?? ctx?.workspaceId ?? ctx?.principal?.workspaceId ?? activeWorkspaceId();
    let baseUrl = args.baseUrl;
    let backend: LocalBackendKind | undefined = args.backend;
    try {
      if (args.backendId) {
        const backends = await listLocalBackends({ workspaceId: ws });
        const found = backends.find((b) => b.id === args.backendId);
        if (!found) {
          return fail({ error: `cert:run — no registered backend with id '${args.backendId}' (see gateway:local_backend_list)` });
        }
        baseUrl = found.baseUrl;
        backend = found.kind;
      }
      if (!baseUrl || !backend) {
        return fail({ error: 'cert:run — could not resolve a target backend (baseUrl/backend unset after backendId lookup)' });
      }
      const config: CertConfig = {
        model: args.model,
        quant: args.quant ?? 'unknown',
        numCtx: args.numCtx ?? 0,
        parallel: args.parallel ?? 1,
        backend,
      };
      const ctx2 = createOpenAiProbeContext({ baseUrl, model: args.model, apiKey: args.apiKey, timeoutMs: args.timeoutMs });
      const report = await runCertBattery(config, { ctx: ctx2 });
      return ok({ report });
    } catch (e) {
      return fail({ error: `cert:run failed: ${errMsg(e)}` });
    }
  },
});

export const certCatalogTool = defineTool({
  name: 'cert:catalog',
  description:
    'Read CERTIFIED_CATALOG (provisioner/catalog.ts) — the provisioner wizard\'s certified/provisional combo catalog. Each entry carries its `status` (\'provisional\' = grounded in a real running config but not yet battery-certified; \'certified\' = passed cert:run, with the `certification` evidence stamp attached). Pass `id` to fetch one entry; omit for the full catalog. Returns {ok, catalog} or {ok, entry} / {ok:false, error} if `id` is unknown.',
  guidance: {
    when: "Checking what's already certified before running cert:run again (avoid a redundant re-cert), or reading a specific entry's certification evidence (verdict/ranAt/manglingRate/summary).",
    notWhen: 'Certifying a NEW combo — that is cert:run. This tool never mutates the catalog (a certified verdict is hand-promoted into provisioner/catalog.ts per D-005, never written by an agent tool).',
    chaining: 'cert:catalog → (a combo is missing or provisional) → cert:run to certify it → hand-add/flip the CERTIFIED_CATALOG entry in code.',
    seeAlso: ['cert:run (certify a combo)'],
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    id: z.string().min(1).optional().describe('Fetch one entry by catalog id (e.g. \'ornith-35b-iq3m-llama-server\'). Omit for the full catalog.'),
  }),
  async handler({ id }) {
    if (id) {
      const entry = findCatalogEntry(id);
      return entry ? ok({ entry }) : fail({ error: `cert:catalog — no entry with id '${id}'`, knownIds: CERTIFIED_CATALOG.map((e) => e.id) });
    }
    return ok({ catalog: CERTIFIED_CATALOG, count: CERTIFIED_CATALOG.length });
  },
});
