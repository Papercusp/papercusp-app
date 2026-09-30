/**
 * slash:dispatch — fire a slash-exposed tool command AT another running agent
 * (WI-126; rides slash-exposure-tool-catalog-2026-06-12).
 *
 * A slash command is a rendered instruction delivered as a turn. The human
 * path types it into their own session; this tool is every OTHER path: tip
 * [Apply] buttons, wake-board actions, voice, queen→bee commands,
 * agent-to-agent. It glues the two halves that already exist:
 *
 *   1. RESOLUTION — the same `renderSlashPrompt` projection prompts/get
 *      serves, so the target receives exactly what a typed
 *      `/mcp__<server>__tool:<group>:<verb>` would have rendered.
 *   2. DELIVERY — the deliver-and-wake path (`sendMessage` + `wakeRecipients`),
 *      so the instruction lands durably in the target's inbox and re-invokes a
 *      sleeping target. The per-agent wake-MODE gate applies UNCHANGED: a
 *      manual-mode target STAGES the dispatched command for owner
 *      release/edit/skip — the hive Pause primitive doubles as a command
 *      firewall, for free.
 *
 * Deliberately NOT a transport (that plan's D-001): nothing executes here.
 * The receiving agent invokes the tool over its OWN MCP session, with its own
 * role gates, quota, and audit. Sender-side we only verify the tool exists,
 * is MCP-exposed, and has not opted out of slash exposure — receiver-side
 * gating is the enforcement layer. Self-application needs no dispatcher:
 * an agent applying a glance tip to itself calls `invoke.tool` directly.
 */
import { z } from 'zod';
import {
  defineTool,
  lookupByMcpName,
  resolveSlashExposure,
  renderSlashPrompt,
} from '@papercusp/agent-mcp';
import { advertisedArgsSchema } from '@papercusp/result-encoding';
import { getOrgPg } from '@papercusp/db-org';
import { resolveAgentIdentity } from '../coordination/identity';
import { sendMessage } from '../coordination/messages';
import { wakeRecipients } from '../coordination/inbox-wake';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';

const err = (msg: string) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: msg }) }],
});

export default defineTool({
  name: 'slash:dispatch',
  description:
    "Fire a slash-exposed tool command AT another running agent: renders the same instruction a typed slash command yields and delivers it as the target's next turn via deliver-and-wake. The target executes the tool over its OWN session with its own gates; a manual-wake-mode target stages the command for owner review instead. For tip [Apply] buttons, wake-board actions, and agent-to-agent command dispatch.",
  guidance: {
    when: "You want ANOTHER agent to run a specific tool command — applying a coord:glance tip to another agent, a UI 'run this on that agent' action, or a leader placing a precise command (not prose) onto a fleet member.",
    notWhen:
      'Running the tool YOURSELF — just call it directly (the slash layer adds nothing in-session). Free-form coordination prose — coord:send. Reviewing what a manual-mode target staged — coord:wake-queue.',
    seeAlso: [
      'coord:send (free-form coordination prose)',
      'coord:wake-queue (review what a manual-mode target staged)',
    ],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    tool: z
      .string()
      .min(1)
      .max(200)
      .describe("The MCP tool name to dispatch, e.g. 'coord:wake-mode'."),
    args: z
      .record(z.string(), z.string().max(2000))
      .optional()
      .describe('String arguments, exactly as a slash invocation supplies them (coerced by the receiving agent per the schema).'),
    agent: z
      .string()
      .min(1)
      .describe('Target agent ownerId whose session should run the command.'),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);

    const projected = lookupByMcpName(args.tool);
    if (!projected || !projected.expose.mcp) {
      return err(`unknown_tool: '${args.tool}' is not a registered MCP-exposed tool`);
    }
    if (resolveSlashExposure(projected) === null) {
      return err(
        `not_dispatchable: '${args.tool}' opted out of slash exposure (expose.slash: false)`,
      );
    }

    // The exact render a typed slash command produces (advertised-schema swap
    // included), prefixed so the receiver knows the instruction was dispatched
    // — "the user" in the rendered block is the dispatching principal.
    const rendered = renderSlashPrompt(
      projected,
      args.args ?? {},
      advertisedArgsSchema(args.tool, projected.inputSchema),
    );
    const renderedText = rendered.messages
      .map((m) => (m.content as { text?: string }).text ?? '')
      .join('\n\n');
    const body = [
      `[slash:dispatch] ${identity.ownerId} dispatched the \`${args.tool}\` slash command to you. ` +
        'Follow the instruction block below exactly as if it had been invoked in YOUR session — ' +
        'your own tool gates apply, and "the user" is the dispatching principal (reach them via coord:send if confirmation is needed).',
      '',
      renderedText,
    ].join('\n');

    const summary = `slash:dispatch → ${args.tool} (from ${identity.ownerId})`;
    const env = await sendMessage(identity, {
      to: [args.agent],
      summary,
      body,
      // Persist the wake intent on the envelope so it federates (EI-279), same
      // as coord:send {wake:true}.
      extra: { wake: true },
    });
    const fan = await wakeRecipients(env.to, { summary, source: identity.ownerId });

    // Slash-origin telemetry, same audit_log sink as prompts/get (P-006
    // decision in _mcp-slash-prompts.ts) under its own action. Fire-and-forget.
    void (async () => {
      try {
        const { sql } = getOrgPg();
        const ctxWs = (ctx as { workspaceId?: string }).workspaceId;
        const ws = ctxWs && ctxWs !== '*' ? ctxWs : activeWorkspaceId();
        const id = `slashd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        await sql.unsafe(
          `INSERT INTO harness_shared.audit_log (id, ts, actor, action, subject, details, workspace_id)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
          [
            id,
            Date.now(),
            identity.ownerId,
            'slash.dispatch',
            args.tool,
            JSON.stringify({
              agent: args.agent,
              argKeys: Object.keys(args.args ?? {}),
              staged: fan.staged,
              woken: fan.woken,
            }),
            ws,
          ],
        );
      } catch (e) {
        console.warn('[slash:dispatch] audit write failed:', e);
      }
    })();

    // One honest delivery verdict (mirrors coord:send's woken:0 surfacing).
    const delivery =
      fan.staged > 0
        ? 'staged'
        : fan.woken > 0
          ? 'woken'
          : 'injected';
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            msg_id: env.msg_id,
            tool: args.tool,
            agent: args.agent,
            delivery,
            staged: fan.staged,
            woken: fan.woken,
            ...(delivery === 'staged'
              ? {
                  note: "target is in manual wake mode — the command is STAGED for owner review (coord:wake-queue to release/edit/skip). The pause gate applies to dispatched commands by design.",
                }
              : {}),
            ...(delivery === 'injected'
              ? {
                  note: 'no live wake-watch on the target — the command landed in its inbox and runs on its next natural turn.',
                }
              : {}),
          }),
        },
      ],
    };
  },
});
