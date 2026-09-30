'use client';

/**
 * Discord-parity app-level navigation shortcuts (discord-shortcuts
 * 2026-06-06), mounted once at the app shell:
 *
 *   - Mod+,        → /settings              (Discord: user settings)
 *   - Mod+I        → /adv?opcv=inbox (the canonical Resolution Inbox face)
 *   - Mod+Shift+N  → /adv?create=true       (Discord: create/join server →
 *                                            our create-harness wizard)
 *   - g then b     → /adv?tab=brainstorm    (Linear-style 2-stroke tab jump)
 *   - g then i     → /adv?tab=insights      (Linear-style 2-stroke tab jump)
 *
 * These are the ROOT fallbacks. The Resolution Inbox now lives in the global
 * Papercup middle pane (`?opcv=inbox`), so its shortcut targets that canonical
 * face directly instead of the retired Conversations-tab approximation.
 * Renders nothing.
 */
import { useRouter } from '../../lib/router-compat/navigation';
import { useShortcutAction } from '../../lib/hotkeys';

export default function GlobalAppShortcuts() {
  const router = useRouter();

  useShortcutAction('settings.open', () => {
    router.push('/settings');
  });

  useShortcutAction('goto.inbox', () => {
    router.push('/adv?opcv=inbox');
  });

  useShortcutAction('harness.create', () => {
    router.push('/adv?create=true');
  });

  // Per-pot tab, so landing here from another route shows AdvShell's
  // pick-a-pot empty-state until a pot is selected — same as any deep link to
  // a per-pot tab. This id had no handler at all before settings-audit
  // 2026-07-09.
  useShortcutAction('goto.brainstorm', () => {
    router.push('/adv?tab=brainstorm');
  });

  useShortcutAction('goto.insights', () => {
    router.push('/adv?tab=insights');
  });

  return null;
}
