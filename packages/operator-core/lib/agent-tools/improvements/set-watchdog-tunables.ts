/**
 * improvements:set-watchdog-tunables — live-tune the improvement-watchdog's fire bars/caps
 * (live-configurability-audit-2026-06-20 P-004 — the CANARY proving the runtime-config pattern).
 *
 * The ~30 collector thresholds in `PAYLOAD_TUNABLE_KEYS` are read from the watchdog routine's
 * `payload_template` at every tick. Today they're tuned by poking that payload by hand — no
 * preview, no audit-with-prev, no one-call revert. This tool wraps the same payload channel in
 * the gateway-control harness so a `set` gets the four D-005 guarantees: dryRun preview,
 * post-apply verify (auto-revert on mismatch), audit to `harness_shared.audit_log`, and a
 * one-call revert. No new schema — the override IS the routine's payload column (reuse-first).
 *
 * Chosen as the canary (plan D-008): low blast radius (capture-only loop), and its set/verify/
 * revert exercises the whole harness end-to-end before the behavior-changing prompt tools.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import { runControlMutation } from '../../gateway-control/control-harness';
import { PAYLOAD_TUNABLE_KEYS } from '../../harness/improvements/watchdog';
import {
  readWatchdogTunables,
  applyWatchdogTunables,
  restoreWatchdogPayload,
  type WatchdogTunablesSnapshot,
} from '../../harness/improvements/watchdog-tunables';

const TUNABLE_KEYS = new Set<string>(PAYLOAD_TUNABLE_KEYS);

export default defineTool({
  name: 'improvements:set-watchdog-tunables',
  profile: 'engineer',
  description:
    "Live-tune the improvement-watchdog's collector bars + per-tick caps (its payload_template tunables) without a deploy. `get` reads the current standing tunables; `set` merges a patch through the control harness (dryRun preview, post-apply verify+auto-revert, audit, one-call revert). Keys are the watchdog PAYLOAD_TUNABLE_KEYS (e.g. transientMinCount, maxPerTick, structuralMinRate).",
  capability: 'operator:write',
  guidance: {
    when: 'A watchdog collector is too noisy or too quiet on a running fleet (e.g. raise transientMinCount during a flaky-infra window, or lower a min-count to capture more) and you want to retune it live instead of poking the routine payload by hand or editing code.',
    notWhen: 'To turn the watchdog on/off (flip its routine `active` — autoloop/routine control). To READ what it last captured, use improvements:watchdog-status. This tool tunes the payload layer; the maxPerTick env override still wins at tick time.',
    chaining: 'improvements:watchdog-status to see current capture behavior; set with dryRun:true to preview the proposed-vs-current diff before applying.',
    seeAlso: [
      'improvements:watchdog-status (read current capture behavior before/after tuning)',
      'improvements:set-auto-policy (tune the auto-implement lane, not the collector)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 30 } },
  args: z.discriminatedUnion('op', [
    z.object({ op: z.literal('get') }),
    z.object({
      op: z.literal('set'),
      tunables: z
        .record(z.string(), z.number())
        .describe(
          'Subset of watchdog payload tunables to set, e.g. {"transientMinCount":25,"maxPerTick":5}. Unknown keys are rejected (not silently ignored).',
        ),
      dryRun: z.boolean().optional().describe('Preview the proposed-vs-current diff without applying.'),
    }),
  ]),
  async handler(args, ctx) {
    if (args.op === 'get') {
      const snap = await readWatchdogTunables();
      return { content: [{ type: 'text', text: JSON.stringify({ tunables: snap.tunables }) }] };
    }

    // set — operator-config write authority only (mirrors operator:rate_limit_config); the SU read path is open.
    if (!isOperatorConfigWriteRole(ctx.role)) {
      throw new Error('improvements:set-watchdog-tunables set requires operator, architect, or mug role');
    }
    const keys = Object.keys(args.tunables);
    if (keys.length === 0) throw new Error('set requires at least one tunable');
    const unknown = keys.filter((k) => !TUNABLE_KEYS.has(k));
    if (unknown.length) {
      throw new Error(
        `unknown watchdog tunable key(s): ${unknown.join(', ')}. Valid keys: ${[...PAYLOAD_TUNABLE_KEYS].join(', ')}`,
      );
    }
    const bad = keys.filter((k) => !Number.isFinite(args.tunables[k]) || args.tunables[k] < 0);
    if (bad.length) throw new Error(`tunable value(s) must be finite and >= 0: ${bad.join(', ')}`);

    const patch = args.tunables as Record<string, number>;
    const outcome = await runControlMutation<WatchdogTunablesSnapshot>(
      {
        action: 'improvements:set-watchdog-tunables',
        subject: 'improvement-watchdog',
        actor: `role:${ctx.role}`,
        capturePrev: () => readWatchdogTunables(),
        apply: () => applyWatchdogTunables(patch),
        revertTo: (prev) => restoreWatchdogPayload(prev.payload),
        verify: async (next) => {
          const ok = keys.every((k) => next.tunables[k as keyof typeof next.tunables] === patch[k]);
          return { ok, detail: ok ? undefined : 'payload_template did not reflect the patch' };
        },
        describe: (prev) => ({
          current: Object.fromEntries(keys.map((k) => [k, (prev.tunables as Record<string, number>)[k] ?? null])),
          proposed: patch,
        }),
      },
      { dryRun: args.dryRun },
    );

    // Trim the response to the tunables (drop the full payload blobs from prev/next).
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: true,
            dryRun: outcome.dryRun,
            applied: outcome.applied,
            reverted: outcome.reverted,
            preview: outcome.preview,
            verify: outcome.verify,
            auditId: outcome.auditId,
            prev: outcome.prev?.tunables,
            next: outcome.next?.tunables,
          }),
        },
      ],
    };
  },
});
