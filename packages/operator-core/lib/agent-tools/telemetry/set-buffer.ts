/**
 * telemetry:set_buffer — read/set/reset the dispatch telemetry-buffer sizing at runtime
 * (live-configurability-audit-2026-06-20 P-020).
 *
 * The deferred-telemetry queue (projected-tool-deps.ts) is sized by maxPending (hard cap →
 * drop-oldest on PG stall), debounceMs (flush debounce), maxBatch (rows per batched INSERT). This
 * makes those settable live — raise maxPending mid-incident to ride out a PG-stall burst without
 * shedding telemetry, or tighten debounce/batch. Merged over the baked defaults; an empty override
 * (or the kill-switch flag OFF) is byte-identical. Audited + one-call-revertible.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import { runControlMutation } from '../../gateway-control/control-harness';
import {
  TELEMETRY_BUFFER_DEFAULTS,
  telemetryBufferConfig,
  readTelemetryBufferOverride,
  setTelemetryBufferOverride,
  setTelemetryBufferOverrideFull,
  resetTelemetryBufferOverride,
  type TelemetryBufferOverride,
} from '../../telemetry-buffer-config';

function json(obj: unknown) {
  // { data } shape: the framework owns wire encoding (tool-data-shape ratchet, WI-10002555).
  return { data: obj };
}

export default defineTool({
  name: 'telemetry:set_buffer',
  profile: 'engineer',
  description:
    "Read/set/reset the dispatch telemetry-buffer sizing (maxPending / debounceMs / maxBatch) at runtime, merged over the baked defaults. Raise maxPending to ride out a PG-stall burst without shedding telemetry, or tune debounce/batch — no deploy. Empty override / kill-switch off (papercusp-telemetry-buffer-config) = byte-identical. set/reset audited + one-call-revertible.",
  capability: 'operator:write',
  guidance: {
    when: 'Telemetry rows are being dropped under burst (the "telemetry queue overflow" warning) — raise maxPending; or tune flush debounce/batch for PG load. get to inspect the effective config + override.',
    notWhen: 'Not for quota/rate limits (operator:rate_limit_config), nor for retention (storage settings). This only sizes the in-memory telemetry flush queue.',
    chaining: 'config:list-overrides shows the active telemetry-buffer override; config:reset-overrides reverts it. The kill-switch papercusp-telemetry-buffer-config (default ON) forces the baked defaults when OFF.',
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 20 } },
  args: z.discriminatedUnion('op', [
    z.object({ op: z.literal('get') }),
    z.object({
      op: z.literal('set'),
      maxPending: z.number().int().min(100).max(1_000_000).optional(),
      debounceMs: z.number().int().min(0).max(60_000).optional(),
      maxBatch: z.number().int().min(1).max(10_000).optional(),
      dryRun: z.boolean().optional(),
    }),
    z.object({ op: z.literal('reset'), dryRun: z.boolean().optional() }),
  ]),
  async handler(args, ctx) {
    if (args.op === 'get') {
      return json({ effective: telemetryBufferConfig(), defaults: TELEMETRY_BUFFER_DEFAULTS, override: await readTelemetryBufferOverride() });
    }

    if (!isOperatorConfigWriteRole(ctx.role)) {
      throw new Error('telemetry:set_buffer requires operator, architect, or mug role');
    }

    const patch: TelemetryBufferOverride =
      args.op === 'set'
        ? {
            ...(args.maxPending !== undefined ? { maxPending: args.maxPending } : {}),
            ...(args.debounceMs !== undefined ? { debounceMs: args.debounceMs } : {}),
            ...(args.maxBatch !== undefined ? { maxBatch: args.maxBatch } : {}),
          }
        : {};
    if (args.op === 'set' && Object.keys(patch).length === 0) {
      throw new Error('set requires at least one of maxPending / debounceMs / maxBatch (or use op:reset)');
    }

    const outcome = await runControlMutation<TelemetryBufferOverride>(
      {
        action: 'telemetry:set_buffer',
        subject: 'telemetry-buffer',
        actor: `role:${ctx.role}`,
        capturePrev: () => readTelemetryBufferOverride(),
        apply: async () => {
          if (args.op === 'reset') {
            await resetTelemetryBufferOverride();
            return {};
          }
          return setTelemetryBufferOverride(patch);
        },
        revertTo: (prev) => setTelemetryBufferOverrideFull(prev),
        verify: async () => {
          // For a set, the merged keys must match the patch; for reset, the override must be empty.
          const cur = await readTelemetryBufferOverride();
          if (args.op === 'reset') {
            const ok = Object.keys(cur).length === 0;
            return { ok, detail: ok ? undefined : 'override not cleared' };
          }
          const ok = (Object.keys(patch) as (keyof TelemetryBufferOverride)[]).every((k) => cur[k] === patch[k]);
          return { ok, detail: ok ? undefined : 'override did not persist' };
        },
        describe: (prev) => ({ op: args.op, proposed: patch, had: prev }),
      },
      { dryRun: args.dryRun },
    );
    return json({
      ok: true, op: args.op, dryRun: outcome.dryRun, applied: outcome.applied, reverted: outcome.reverted,
      preview: outcome.preview, verify: outcome.verify, auditId: outcome.auditId,
      effective: telemetryBufferConfig(),
    });
  },
});
