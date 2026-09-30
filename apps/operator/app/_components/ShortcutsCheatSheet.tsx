'use client';

/**
 * Read-only keyboard-shortcut cheat-sheet.
 *
 * Triggered by `?` (registered as `shortcuts.show` in the shortcut
 * registry). Lists every shortcut grouped by category, with a footer
 * link to the editable settings page.
 */
import * as Dialog from '@radix-ui/react-dialog';
// The sheet's rules ride with the component, not globals.css: the cloud portal
// mounts this through @papercusp/operator-ui/shortcuts without the operator's
// globals (portal-global-shortcuts-2026-09-06 P-001).
import './shortcuts-cheat-sheet.css';
import RouteLink from './RouteLink';
import { SHORTCUTS, effectiveCombo, type ShortcutCategory } from '@papercusp/operator-core/lib/shortcut-registry';
import { isMacPlatform } from '@papercusp/operator-core/lib/shortcut-match';
import { useShortcutOverrides } from '../../lib/hotkeys';

const CATEGORY_LABELS: Record<ShortcutCategory, string> = {
  global: 'Global',
  palette: 'Quick actions',
  navigation: 'Navigation',
  history: 'Back / forward',
  editor: 'Editors',
  voice: 'Voice & video',
};

const CATEGORY_ORDER: ShortcutCategory[] = [
  'palette',
  'global',
  'navigation',
  'history',
  'voice',
  'editor',
];

/**
 * Pretty-print a stored combo into a human-readable form. Splits on `,`
 * (alternates) and `>` (sequences); converts `mod` to platform glyph.
 */
export function prettyCombo(raw: string): string[] {
  if (!raw) return [];
  // `isMacPlatform()` (not navigator.platform, which WebKit freezes to "MacIntel"
  // on every OS) so the Linux desktop shows "Ctrl", matching the keys that fire.
  const isMac = isMacPlatform();
  const modGlyph = isMac ? '⌘' : 'Ctrl';
  return raw
    .split(',')
    .map((alt) => alt.trim())
    .filter(Boolean)
    .map((alt) =>
      alt
        .split('>') // sequence separator
        .map((step) =>
          step
            .split('+')
            .map((part) => part.trim())
            .map((part) => {
              const lc = part.toLowerCase();
              if (lc === 'mod') return modGlyph;
              if (lc === 'shift') return isMac ? '⇧' : 'Shift';
              if (lc === 'alt' || lc === 'option') return isMac ? '⌥' : 'Alt';
              if (lc === 'ctrl' || lc === 'control') return isMac ? '⌃' : 'Ctrl';
              if (lc === 'meta' || lc === 'cmd') return modGlyph;
              if (lc === 'arrowdown') return '↓';
              if (lc === 'arrowup') return '↑';
              if (lc === 'arrowleft') return '←';
              if (lc === 'arrowright') return '→';
              if (lc === 'enter' || lc === 'return') return '↵';
              if (lc === 'space') return 'Space';
              if (lc === 'escape' || lc === 'esc') return 'Esc';
              if (lc === 'slash') return '/';
              if (lc === 'bracketleft') return '[';
              if (lc === 'bracketright') return ']';
              if (lc === 'backslash') return '\\';
              if (lc === 'period') return '.';
              if (lc === 'comma') return ',';
              if (part.length === 1) return part.toUpperCase();
              return part;
            })
            .join('+'),
        )
        .join(' then '),
    );
}

export default function ShortcutsCheatSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  // Subscribe so the cheat-sheet refreshes immediately if the user
  // remaps a shortcut from another tab.
  const overrides = useShortcutOverrides();

  const grouped: Record<ShortcutCategory, typeof SHORTCUTS[number][]> = {
    global: [], palette: [], navigation: [], history: [], editor: [], voice: [],
  };
  for (const s of SHORTCUTS) grouped[s.category].push(s);

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="kbd-cheat-overlay" />
        <Dialog.Content className="kbd-cheat" aria-label="Keyboard shortcuts">
          <div className="kbd-cheat-head">
            <Dialog.Title className="kbd-cheat-title">Keyboard shortcuts</Dialog.Title>
            <Dialog.Description className="kbd-cheat-sub">
              Press <kbd className="kbd-key">Esc</kbd> to close. Customize any binding at{' '}
              <RouteLink href="/settings/shortcuts" onClick={onClose} className="kbd-cheat-link">
                Settings → Shortcuts
              </RouteLink>.
            </Dialog.Description>
          </div>
          <div className="kbd-cheat-body">
            {CATEGORY_ORDER.map((cat) => {
              const items = grouped[cat];
              if (items.length === 0) return null;
              return (
                <section key={cat} className="kbd-cheat-section">
                  <h3 className="kbd-cheat-cat">{CATEGORY_LABELS[cat]}</h3>
                  <ul className="kbd-cheat-list">
                    {items.map((s) => {
                      const combo = effectiveCombo(s.id, overrides);
                      const alts = prettyCombo(combo);
                      return (
                        <li key={s.id} className="kbd-cheat-row">
                          <span className="kbd-cheat-desc">{s.description}</span>
                          <span className="kbd-cheat-combos">
                            {alts.length === 0 ? (
                              <em className="kbd-cheat-unbound">— unbound —</em>
                            ) : (
                              alts.map((c, i) => (
                                <span key={i} className="kbd-cheat-combo">
                                  {i > 0 && <span className="kbd-cheat-or">or</span>}
                                  {c.split('+').map((tok, j, arr) => (
                                    <span key={j}>
                                      {tok.split(' then ').map((seq, k, sarr) => (
                                        <span key={k}>
                                          <kbd className="kbd-key">{seq}</kbd>
                                          {k < sarr.length - 1 && <span className="kbd-cheat-then"> then </span>}
                                        </span>
                                      ))}
                                      {j < arr.length - 1 && '+'}
                                    </span>
                                  ))}
                                </span>
                              ))
                            )}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
