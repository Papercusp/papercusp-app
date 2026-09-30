/**
 * harness:membership — list / add / remove / move a harness across workspaces.
 *
 * The operator-facing MCP surface over lib/harness-membership (Phase 3 of
 * harnesses-across-workspaces). Registry edits only: never moves/deletes the
 * harness folder (the path is a link), never migrates run data (D-1: the
 * harness_<slug> data set is shared by slug). Unblocked by migration 091
 * (composite (workspace_id, slug) uniqueness).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { readRegistry } from '../../workspace-registry';
import { loadHarnessRegistry } from '../../harness-registry';
import {
  addHarnessToWorkspace,
  moveHarness,
  removeHarnessFromWorkspace,
  workspacesForHarness,
} from '../../harness-membership';

function knownWorkspace(id: string | undefined): id is string {
  return typeof id === 'string' && readRegistry().workspaces.some((w) => w.id === id);
}

function txt(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj) }] };
}

export default defineTool({
  name: 'harness:membership',
  profile: 'engineer',
  description:
    'List / add / remove / move which workspaces a harness belongs to. Registry edits only — never touches the harness folder or its run data.',
  guidance: {
    when: 'User asks to move a harness to another workspace, share/link a harness into a second workspace, see which workspaces a harness is in, or remove a harness from a workspace. op=list reads; op=add/remove/move mutate.',
    notWhen: 'To CREATE a brand-new harness from a folder/repo, use the harness create flow (POST /api/harness/projects), not this — membership only links/moves harnesses that already exist somewhere.',
    seeAlso: [
      'harness:create (create a brand-new harness instead of linking/moving)',
      'harness:overview (inspect the harness being linked/moved)',
    ],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: ['operator'],
  args: z.object({
    op: z.enum(['list', 'add', 'remove', 'move']),
    slug: z.string().min(1),
    /** op=remove: the workspace to unlink from. */
    workspace: z.string().optional(),
    /** op=move: source workspace. */
    fromWorkspace: z.string().optional(),
    /** op=add/move: destination workspace. */
    toWorkspace: z.string().optional(),
  }),
  async handler(args) {
    const { op, slug } = args;
    switch (op) {
      case 'list':
        return txt({ slug, workspaces: await workspacesForHarness(slug) });
      case 'add': {
        if (!knownWorkspace(args.toWorkspace)) return txt({ error: 'unknown toWorkspace' });
        const members = await workspacesForHarness(slug);
        if (members.length === 0) {
          return txt({ error: `harness '${slug}' is not registered in any workspace; create it first` });
        }
        const srcReg = await loadHarnessRegistry(members[0]);
        const entry = srcReg.projects.find((p) => p.slug === slug);
        // Guard the re-read: workspacesForHarness reported members[0] as a
        // carrier, but a concurrent move/remove can drop the slug from that
        // registry between the two reads. Without this guard the `find` misses,
        // `entry` is undefined, and it would flow into addHarnessToWorkspace —
        // pushing a corrupt/undefined entry into the destination registry (or
        // throwing deep in the mutation path). Fail cleanly instead.
        if (!entry) {
          return txt({
            error: `harness '${slug}' vanished from workspace '${members[0]}' (concurrent move/remove); retry`,
          });
        }
        return txt({ ok: true, result: await addHarnessToWorkspace(args.toWorkspace, entry) });
      }
      case 'remove': {
        if (!knownWorkspace(args.workspace)) return txt({ error: 'unknown workspace' });
        return txt({ ok: true, result: await removeHarnessFromWorkspace(args.workspace, slug) });
      }
      case 'move': {
        if (!knownWorkspace(args.fromWorkspace)) return txt({ error: 'unknown fromWorkspace' });
        if (!knownWorkspace(args.toWorkspace)) return txt({ error: 'unknown toWorkspace' });
        try {
          return txt({ ok: true, result: await moveHarness(slug, args.fromWorkspace, args.toWorkspace) });
        } catch (e) {
          return txt({ error: e instanceof Error ? e.message : String(e) });
        }
      }
    }
  },
});
