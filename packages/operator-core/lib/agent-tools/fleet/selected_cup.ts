/**
 * fleet:selected_cup — the ephemeral swarm→bee-pane selection relay
 * (pui-bee-dossier-pane-2026-06-06).
 *
 * The desktop chat dock runs the swarm (Fleet) pane and the bee-dossier pane as
 * two SEPARATE pui processes. The swarm pane PUBLISHES the cursor's bee here
 * (call with `select`); the bee pane READS it (call with no args, polling ~1.5s)
 * and renders that bee's dossier.
 *
 * Backed by an in-memory, per-workspace store (lib/fleet/selected-bee) — NOT
 * Postgres: this is a transport between two co-located processes, and the DB is
 * not a transport (owner principle). See that module's header for the tradeoff.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { getSelectedBee, setSelectedBee } from '../../fleet/selected-bee';

export default defineTool({
  name: 'fleet:selected_cup',
  profile: 'engineer',
  description:
    'Get or set the ephemeral "selected cup" for the bee-dossier dock pane. With no args, RETURNS the currently selected cup (the bee pane polls this). With `select`, PUBLISHES the selection (the swarm/Fleet pane calls this when its cursor moves). In-memory, per-workspace, non-durable — a transport between the two pui dock processes, never persisted.',
  guidance: {
    when: 'Driving the desktop chat dock\'s cup-dossier pane: the swarm pane sets the selection on cursor move; the cup pane reads it to know which cup to render.',
    notWhen:
      'You want durable assignment state or "who is on what" — use fleet:assignments. This holds only the transient UI selection.',
    chaining:
      'Fleet pane: fleet:selected_cup { select: { owner_id } } on cursor move. Cup pane: fleet:selected_cup {} (poll) → fleet:assignments { agent } + fleet:cup_mail { owner_id } for the dossier.',
  },
  capability: 'work_items:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    select: z
      .object({
        owner_id: z
          .string()
          .max(200)
          .nullable()
          .describe('The cup\'s ownerId to select; null/empty clears the selection.'),
        name: z
          .string()
          .max(120)
          .optional()
          .describe('The cup\'s adopted agent-name, when known (display only).'),
      })
      .optional()
      .describe('Present → PUBLISH this selection. Absent → READ the current selection.'),
    workspace: z.string().max(120).optional(),
  }),
  async handler(args, ctx) {
    // This is an ephemeral loopback UI relay (read + write of a transient
    // selection), NOT an attributable coordination write — so it must NOT hard-
    // require a coord identity the way coord:send does. Resolve the workspace
    // SOFTLY: use the caller's workspace when attributable, else the default
    // slot. (`resolveAgentIdentity` throws for a bare loopback caller — the pui
    // IPC path — so it's wrapped, not awaited as a precondition.)
    let actorWorkspace: string | null = null;
    try {
      actorWorkspace = resolveAgentIdentity(ctx).workspaceId ?? null;
    } catch {
      actorWorkspace = null;
    }
    const workspaceId = args.workspace ?? actorWorkspace;

    if (args.select !== undefined) {
      const entry = setSelectedBee(
        workspaceId,
        args.select.owner_id,
        args.select.name ?? null,
      );
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ok: true, selected: entry }),
          },
        ],
      };
    }

    const selected = getSelectedBee(workspaceId);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ ok: true, selected }),
        },
      ],
    };
  },
});
