/**
 * workspace.* — list / switch workspaces.
 *
 * Voice + Oracle need to know which workspace they're in and let the user
 * switch between them. Pi gets the read but not the switch (Pi runs as a
 * subprocess pinned to one workspace).
 */
import { z } from 'zod';
import { register } from '../registry';
import type { CommandDef, QueryDef } from '../types';
import { navigateClient } from '../../client-navigation';

function baseUrl(): string {
  if (typeof window !== 'undefined') return '';
  const port = process.env.PORT ?? process.env.NEXT_PUBLIC_PORT ?? '3155';
  return `http://127.0.0.1:${port}`;
}

const ListArgs = z.object({});

const workspaceList: QueryDef<z.infer<typeof ListArgs>> = {
  id: 'workspace.list',
  kind: 'query',
  description: 'List all workspaces (and which one is currently active).',
  promptDescription:
    'Returns [{id, name, current}, ...]. Use to answer "which workspace am I on?" ' +
    'or to find an id before workspace.switch.',
  schema: ListArgs,
  agents: ['oracle', 'operator', 'pi'],
  audit: 'none',
  tier: 'fast-query',
  handler: async () => {
    const r = await fetch(`${baseUrl()}/api/workspaces`);
    if (!r.ok) throw new Error(`workspace.list failed: HTTP ${r.status}`);
    const d = await r.json();
    return { workspaces: d?.workspaces ?? [] };
  },
};

const SwitchArgs = z.object({
  id: z.string().min(1).describe('Workspace id (use workspace.list to find).'),
});

const workspaceSwitch: CommandDef<z.infer<typeof SwitchArgs>> = {
  id: 'workspace.switch',
  kind: 'command',
  description: 'Switch the active workspace and reload the page.',
  promptDescription:
    'Switches the active workspace. The page reloads automatically — voice should ' +
    'announce the switch ("Switched to <name>"). Per-tab URL search param `ws` flips.',
  schema: SwitchArgs,
  agents: ['oracle', 'operator', 'palette', 'shortcut'],
  browser: 'required',
  concurrent: 'queue',
  tier: 'reflexive',
  handler: async ({ id }) => {
    if (typeof window === 'undefined') throw new Error('workspace.switch must run in browser');
    const r = await fetch(`${baseUrl()}/api/workspaces/switch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    if (!r.ok) throw new Error(`workspace.switch failed: HTTP ${r.status}`);
    const url = new URL(window.location.href);
    url.searchParams.set('ws', id);
    navigateClient(url.toString(), { replace: true });
    return { id, switched: true };
  },
};

register(workspaceList);
register(workspaceSwitch);
