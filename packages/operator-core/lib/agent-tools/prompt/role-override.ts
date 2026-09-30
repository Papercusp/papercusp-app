/**
 * prompt:role_override — read/set/clear a per-(harness, role) prompt override
 * (live-configurability-audit-2026-06-20 P-001).
 *
 * The harness_prompt_overrides store already exists and is read LIVE by the orchestrator
 * (resolvePromptOverrideWithStore, invoke.ts) — but the only writers were the gym champion path
 * and a loopback-only HTTP route. This exposes it as an MCP tool so an operator can specialize or
 * correct a role's prompt for a running harness without a deploy, and clear it to fall back to the
 * committed repo default. Near-free: the store + live read already exist.
 *
 * set/clear are wrapped in the control harness (dryRun, post-apply verify+auto-revert, audit,
 * one-call revert) and operator-authority gated; get/list are open reads.
 */
import { z } from 'zod';
import { defineTool, entityRef, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../workspace-registry';
import { runControlMutation } from '../../gateway-control/control-harness';
import {
  getPromptOverride,
  setPromptOverride,
  deletePromptOverride,
  clearAllPromptOverrides,
  listPromptOverrides,
} from '../../harness-prompt-overrides';

function json(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj) }] };
}

export default defineTool({
  name: 'prompt:role_override',
  profile: 'engineer',
  description:
    "Read/set/clear a per-(harness, role) prompt override (the harness_prompt_overrides store, read live by the orchestrator; cleared ⇒ falls back to the committed repo prompt). ops: get | list | set | clear (clear with no role wipes all of the harness's overrides). set/clear are audited + one-call-revertible via the control harness.",
  capability: 'operator:write',
  guidance: {
    when: "Specialize or correct a role's prompt for a running harness without a deploy (e.g. sharpen the validator persona for this mission), or clear an override to revert to the committed default. get/list to inspect.",
    notWhen: 'For the shared-base nudges across ALL roles (FRICTION_TRIPWIRE etc.) use P-017 prompt:set_fragment. A set REPLACES the whole role prompt for that harness; it does not merge.',
    chaining: 'get/list first to see the current override; clear to revert to the committed prompt.',
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 30 } },
  args: z.discriminatedUnion('op', [
    z.object({ op: z.literal('get'), harness: z.string().min(1).max(120), role: entityRef('role', { max: 80 }) }),
    z.object({ op: z.literal('list'), harness: z.string().min(1).max(120) }),
    z.object({
      op: z.literal('set'),
      harness: z.string().min(1).max(120),
      role: entityRef('role', { max: 80 }),
      content: z.string().min(1).max(100_000).describe('The full replacement prompt markdown for this (harness, role).'),
      dryRun: z.boolean().optional(),
    }),
    z.object({
      op: z.literal('clear'),
      harness: z.string().min(1).max(120),
      role: entityRef('role', {
        max: 80,
        describe: 'Omit to clear ALL role overrides for the harness.',
      }).optional(),
      dryRun: z.boolean().optional(),
    }),
  ]),
  async handler(args, ctx) {
    const ws = activeWorkspaceId();

    if (args.op === 'get') {
      return json({ harness: args.harness, role: args.role, override: await getPromptOverride(ws, args.harness, args.role) });
    }
    if (args.op === 'list') {
      return json({ harness: args.harness, overrides: await listPromptOverrides(ws, args.harness) });
    }

    // writes — operator-authority only.
    if (!isOperatorConfigWriteRole(ctx.role)) {
      throw new Error('prompt:role_override set/clear requires operator, architect, or mug role');
    }

    if (args.op === 'set') {
      const outcome = await runControlMutation<string | null>(
        {
          action: 'prompt:role_override',
          subject: `${args.harness}/${args.role}`,
          actor: `role:${ctx.role}`,
          capturePrev: () => getPromptOverride(ws, args.harness, args.role),
          apply: async () => {
            await setPromptOverride(ws, args.harness, args.role, args.content);
            return args.content;
          },
          revertTo: async (prev) => {
            if (prev === null) await deletePromptOverride(ws, args.harness, args.role);
            else await setPromptOverride(ws, args.harness, args.role, prev);
          },
          verify: async () => {
            const cur = await getPromptOverride(ws, args.harness, args.role);
            return { ok: cur === args.content, detail: cur === args.content ? undefined : 'override did not persist' };
          },
          describe: (prev) => ({ harness: args.harness, role: args.role, hadOverride: prev !== null, newLength: args.content.length }),
        },
        { dryRun: args.dryRun },
      );
      return json({
        ok: true, harness: args.harness, role: args.role, dryRun: outcome.dryRun, applied: outcome.applied,
        reverted: outcome.reverted, preview: outcome.preview, verify: outcome.verify, auditId: outcome.auditId,
      });
    }

    // clear
    if (args.role) {
      const role = args.role;
      const outcome = await runControlMutation<string | null>(
        {
          action: 'prompt:role_override:clear',
          subject: `${args.harness}/${role}`,
          actor: `role:${ctx.role}`,
          capturePrev: () => getPromptOverride(ws, args.harness, role),
          apply: async () => {
            await deletePromptOverride(ws, args.harness, role);
            return null;
          },
          revertTo: async (prev) => {
            if (prev !== null) await setPromptOverride(ws, args.harness, role, prev);
          },
          verify: async () => {
            const cur = await getPromptOverride(ws, args.harness, role);
            return { ok: cur === null, detail: cur === null ? undefined : 'override still present' };
          },
          describe: (prev) => ({ harness: args.harness, role, willClear: prev !== null }),
        },
        { dryRun: args.dryRun },
      );
      return json({
        ok: true, harness: args.harness, role, cleared: 'role', dryRun: outcome.dryRun, applied: outcome.applied,
        reverted: outcome.reverted, preview: outcome.preview, auditId: outcome.auditId,
      });
    }

    // clear ALL for the harness
    const outcome = await runControlMutation<Array<{ role: string; promptMd: string }>>(
      {
        action: 'prompt:role_override:clear-all',
        subject: args.harness,
        actor: `role:${ctx.role}`,
        capturePrev: async () => (await listPromptOverrides(ws, args.harness)).map((o) => ({ role: o.role, promptMd: o.promptMd })),
        apply: async () => {
          await clearAllPromptOverrides(ws, args.harness);
          return [];
        },
        revertTo: async (prev) => {
          for (const o of prev) await setPromptOverride(ws, args.harness, o.role, o.promptMd);
        },
        verify: async () => {
          const cur = await listPromptOverrides(ws, args.harness);
          return { ok: cur.length === 0, detail: cur.length === 0 ? undefined : `${cur.length} override(s) remain` };
        },
        describe: (prev) => ({ harness: args.harness, willClearRoles: prev.map((o) => o.role) }),
      },
      { dryRun: args.dryRun },
    );
    return json({
      ok: true, harness: args.harness, cleared: 'all', count: outcome.prev.length, dryRun: outcome.dryRun,
      applied: outcome.applied, preview: outcome.preview, auditId: outcome.auditId,
    });
  },
});
