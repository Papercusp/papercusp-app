/**
 * nav.* — browser navigation.
 */
import { z } from 'zod';
import { register } from '../registry';
import type { CommandDef } from '../types';
import { navigateClient } from '../../client-navigation';

const NavigateArgs = z.object({
  path: z.string().min(1).describe('Path within the operator app (e.g. /harness, /settings/voice).'),
});

function navTo(path: string): { path: string } {
  if (typeof window === 'undefined') throw new Error('navigate must run in browser');
  const ws = new URL(window.location.href).searchParams.get('ws');
  let target = path;
  if (ws && !path.includes('?')) target = `${path}?ws=${encodeURIComponent(ws)}`;
  else if (ws && path.includes('?') && !path.includes('ws=')) target = `${path}&ws=${encodeURIComponent(ws)}`;
  navigateClient(target);
  return { path: target };
}

const navigate: CommandDef<z.infer<typeof NavigateArgs>> = {
  id: 'navigate',
  kind: 'command',
  description: 'Navigate the browser to a path within the operator app.',
  promptDescription:
    'Routes the user to the given path. Use for "take me to settings" / "go to the ' +
    'sheets harness". Common paths: /harness, /settings/voice, /settings/api-keys, ' +
    '/cupboard, /installed/harnesses.',
  schema: NavigateArgs,
  agents: ['oracle', 'operator', 'shortcut'],
  browser: 'required',
  concurrent: 'allow',
  tier: 'reflexive',
  handler: async ({ path }) => navTo(path),
};

register(navigate);

const Empty = z.object({}).strict();

const FIXED_NAVS: Array<{ id: string; path: string; title: string; icon: string; keywords: string }> = [
  { id: 'nav.papercusp', path: '/harness', title: 'Go to Harness', icon: '⌖', keywords: 'harness dashboard' },
  { id: 'nav.cupboard', path: '/cupboard', title: 'Go to Cupboard', icon: '⌖', keywords: 'cupboard marketplace plugins templates' },
  { id: 'nav.installed-harnesses', path: '/installed/harnesses', title: 'Go to Installed harnesses', icon: '⌖', keywords: 'installed harnesses' },
  { id: 'nav.settings', path: '/settings', title: 'Go to Settings', icon: '⌖', keywords: 'settings' },
  { id: 'nav.settings-voice', path: '/settings/voice', title: 'Go to Voice settings', icon: '⌖', keywords: 'voice settings elevenlabs' },
  { id: 'nav.settings-api-keys', path: '/settings/api-keys', title: 'Go to API keys', icon: '⌖', keywords: 'api keys openai anthropic' },
  { id: 'nav.settings-shortcuts', path: '/settings/shortcuts', title: 'Go to Keyboard shortcuts', icon: '⌖', keywords: 'shortcuts keyboard' },
  { id: 'nav.docs', path: '/docs', title: 'Go to Docs', icon: '⌖', keywords: 'docs documentation' },
  { id: 'nav.notes', path: '/notes', title: 'Go to Notes', icon: '⌖', keywords: 'notes jot search' },
];

for (const f of FIXED_NAVS) {
  const def: CommandDef<{}, { path: string }> = {
    id: f.id,
    kind: 'command',
    description: `Navigate to ${f.path}.`,
    schema: Empty,
    agents: ['oracle', 'operator', 'palette', 'shortcut'],
    browser: 'required',
    concurrent: 'allow',
    tier: 'reflexive',
    paletteEntry: { section: 'Navigate', title: f.title, icon: f.icon, keywords: f.keywords },
    handler: async () => navTo(f.path),
  };
  register(def);
}
