'use client';

/**
 * Mounts the keyboard-shortcut cheat-sheet on the `shortcuts.show` binding
 * (Mod+/ Discord-style, or `?`) — this is the component that finally WIRES
 * the registry entry (it existed unbound since the registry landed).
 *
 * Open state lives in the URL (`?shortcuts=1`) via nuqs — per the repo's
 * "almost all state should be in nuqs" rule: deep-linkable, survives
 * reload, and agent-driveable (ui:dispatch can open the sheet).
 *
 * Renders only the dialog (nothing when closed).
 */
import { parseAsBoolean, useQueryState } from 'nuqs';
import { useShortcutAction } from '../../lib/hotkeys';
import ShortcutsCheatSheet from './ShortcutsCheatSheet';

export default function GlobalShortcutsHelp() {
  const [open, setOpen] = useQueryState('shortcuts', parseAsBoolean.withDefault(false));

  useShortcutAction('shortcuts.show', () => {
    void setOpen(!open);
  });

  return <ShortcutsCheatSheet open={open} onClose={() => void setOpen(false)} />;
}
