/**
 * ChatFacesHost — composes the Fleet + Peers faces for the Papercup chat
 * sidebar's header row and hands them down to ChromeShell (WI-5162, owner ask
 * 2026-07-17: "move the fleet and peers panes from the middle section to the
 * leftmost section and put them to the right of the kettle button" — the
 * "kettle button" being the 🎯 Pot Health toggle in the leftmost sidebar,
 * confirmed with the owner before the move).
 *
 * WHY THE COMPOSITION RUNS FROM THIS SIDE: the panes (SwarmTab / VoiceTab) live
 * under operator-vite/src and import operator-vite-local modules
 * (../adv/AgentsRunningPill, ../voice-video/VideoGrid, @tanstack/react-router).
 * apps/operator — where the chat sidebar lives — cannot import up-layer into
 * this tree (`@` resolves to operatorRoot; see AGENT-ENV § "Cross-tree alias
 * trap"), so it exposes a descriptor slot instead and WE fill it. Same shape and
 * same reason as quick-panel's status pills (quick-panel-status-pills-2026-07-13
 * D-001): the route composes, the page/shell renders.
 *
 * This component exists (rather than a hook called in __root's body) so the
 * lexicon/flag hooks run INSIDE the provider stack that wraps ChromeShell.
 */
import { Suspense } from 'react';
import { lazyWithRetry as lazy } from '@papercusp/operator-core/lib/lazy-with-retry';
import { Users, AudioLines, GraduationCap } from 'lucide-react';
import ChromeShell from '@/app/_components/ChromeShell';
import type { OpChatFace } from '@/app/_components/op-chat-faces';
import { useLexicon } from '@/lib/useLexicon';

// The same retry-wrapped lazy the left sidebar used for these panes: a
// transient first-boot chunk fetch failure on the packaged WebKitGTK desktop
// must retry, not escalate to the fatal boundary (WI-2902).
const SwarmTab = lazy(() => import('../left-sidebar/SwarmTab'));
const VoiceTab = lazy(() => import('../left-sidebar/VoiceTab'));
const LearningLoopFace = lazy(() => import('./LearningLoopFace'));
// The rail's ~110KB `pclsb-*` stylesheet. THIS module is imported eagerly by
// routes/__root.tsx, so a static `LEFT_SIDEBAR_CSS` import here put that
// stylesheet in the first-paint graph to style panes first paint never mounts
// (WI-5502 item 3 neighbourhood). Behind a dynamic import it is fetched when a
// face pane first renders instead. See LeftSidebarStyleTag's own comment.
const LeftSidebarStyleTag = lazy(() => import('./LeftSidebarStyleTag'));

/**
 * Hosts a pane that was written for the left rail inside the chat sidebar.
 *
 * The panes are styled entirely by `pclsb-*` rules in LEFT_SIDEBAR_CSS, and
 * they used to inherit two things from the rail that no longer wrap them here:
 * the `--pclsb-current-accent` custom property (declared on `.pclsb`) and
 * `.pclsb__body`'s scroll box. This host re-supplies both, so the panes render
 * identically without being rewritten. Injecting LEFT_SIDEBAR_CSS a second time
 * while the rail is also mounted is harmless — same rules, same cascade.
 */
function ChatFacePane({ children }: { children: React.ReactNode }) {
  return (
    <div className="pclsb-face-host" data-testid="op-chat-face-pane">
      {/*
        `fallback={null}` on purpose: this renders a <style> tag, so it
        occupies no layout box and there is nothing to reserve. It is a
        SIBLING of `children` (not a wrapper) so React starts both chunk
        fetches in the same render pass rather than serialising them —
        the pane's own Suspense keeps showing its "Loading…" meanwhile.
      */}
      <Suspense fallback={null}>
        <LeftSidebarStyleTag />
      </Suspense>
      <style>{CHAT_FACE_PANE_CSS}</style>
      {children}
    </div>
  );
}

const CHAT_FACE_PANE_CSS = `
.pclsb-face-host {
  /* Declared on .pclsb in the rail; the panes read it for their accent. */
  --pclsb-current-accent: var(--accent, #38bdf8);
  /* The rail's .pclsb__body scroll box, which no longer wraps these panes. */
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 4px 0 10px;
  display: flex;
  flex-direction: column;
}
`;

/**
 * ChromeShell + the two faces. Drop-in replacement for a bare <ChromeShell/>.
 */
export default function ChromeShellWithChatFaces() {
  const faces = useOpChatFaces();
  return <ChromeShell chatFaces={faces} />;
}

/**
 * The extra Papercup-chat faces (Learning / Fleet / Peers), composed from this
 * side of the layering seam — see the module comment. A hook rather than a
 * constant because the labels come from the lexicon. Shared by the in-app
 * ChromeShell mount above and the portal's docked chat pane document
 * (/portal-panes/chat), so the two hosts never drift in what the header offers.
 */
export function useOpChatFaces(): OpChatFace[] {
  const t = useLexicon();

  // Rebuilt per render (cheap: two object literals) but memo-stable enough —
  // OperatorChatSidebar keys its nuqs parser off the face IDS, not identity.
  const faces: OpChatFace[] = [
    // FIRST so 🎓 sits immediately right of 🎯 Pot Health (owner ask
    // 2026-07-26, option C "Loop" of three rendered mockups).
    {
      id: 'learning',
      label: 'Learning',
      tip: 'Learning — the loop at a glance: stage counts, release readiness, and what needs attention',
      icon: <GraduationCap size={16} aria-hidden="true" />,
      render: () => (
        <ChatFacePane>
          <Suspense fallback={<div className="pclsb-panel__empty">Loading…</div>}>
            <LearningLoopFace />
          </Suspense>
        </ChatFacePane>
      ),
    },
    {
      id: 'fleet',
      label: t('fleet'),
      tip: `The ${t('fleet', { lower: true })} — live roster of SU agents & ${t('contributor', { plural: true, lower: true })} and what each is doing`,
      icon: <Users size={16} aria-hidden="true" />,
      render: () => (
        <ChatFacePane>
          <Suspense fallback={<div className="pclsb-panel__empty">Loading…</div>}>
            <SwarmTab active />
          </Suspense>
        </ChatFacePane>
      ),
    },
    {
      id: 'peers',
      label: 'Peers',
      tip: 'Peers — live voice/video channels with other people',
      icon: <AudioLines size={16} aria-hidden="true" />,
      render: () => (
        <ChatFacePane>
          <Suspense fallback={<div className="pclsb-panel__empty">Loading…</div>}>
            <VoiceTab active />
          </Suspense>
        </ChatFacePane>
      ),
    },
  ];

  return faces;
}
