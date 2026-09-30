/**
 * Palette shim — convert registry commands tagged with `paletteEntry`
 * into the shape `apps/operator/app/harness/CommandPalette` consumes.
 *
 * HarnessDashboard imports `buildRegistryPaletteItems()` and spreads its
 * result into the array of `Command` objects it already builds inline.
 * The user keeps using ⌘K the same way; new registry entries with
 * paletteEntry get a free palette row.
 */

import { list, runCommand } from '../registry';
import type { CommandContext } from '../types';
import { trackDetached } from '../../detached-imports';
import '../defs';

export interface PaletteItem {
  id: string;
  title: string;
  section?: string;
  icon?: string;
  keywords?: string;
  perform: () => void;
}

export function buildRegistryPaletteItems(opts: {
  workspace: string;
  sessionId?: string;
}): PaletteItem[] {
  const out: PaletteItem[] = [];
  for (const def of list({ kind: 'command', agent: 'palette' })) {
    if (def.kind !== 'command') continue;
    if (!def.paletteEntry) continue;
    out.push({
      id: def.id,
      title: def.paletteEntry.title,
      section: def.paletteEntry.section,
      icon: def.paletteEntry.icon,
      keywords: def.paletteEntry.keywords,
      perform: () => {
        const ctx: CommandContext = {
          agent: 'palette',
          workspace: opts.workspace,
          sessionId: opts.sessionId,
          requestId: `pal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        };
        // Empty args — palette items default to def.schema's default values
        // (which Zod fills in via .default()). Commands needing arg input
        // have to be invoked by voice/Oracle, not the palette.
        void runCommand(def.id, {}, ctx).then((r) => {
          if (!r.ok && typeof window !== 'undefined') {
            // Surface failures via toast — same pattern voice uses.
            void trackDetached(import('sonner')).then(({ toast }) => {
              toast.error(`${def.id}: ${r.error.code} — ${r.error.message}`);
            }).catch(() => { /* sonner not in bundle */ });
          }
        });
      },
    });
  }
  return out;
}
