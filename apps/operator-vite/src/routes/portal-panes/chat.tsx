import { createFileRoute } from '@tanstack/react-router';
import { OperatorChatSidebar } from '@/app/_components/OperatorChatSidebar';
import { useOpChatFaces } from '../../components/chat-faces/ChatFacesHost';
import { PortalPane } from '../../components/portal-panes/PortalPane';

/**
 * /portal-panes/chat — the Papercup chat dock (with its Learning / Fleet /
 * Peers faces) as a pane-only document, framed by the cloud portal as its own
 * sidebar (owner ask 2026-09-01). Composition only: the conversation state
 * comes from the OperatorConversationProvider __root mounts around every
 * route, and the faces are the same descriptors the in-app ChromeShell mount
 * uses, so the two hosts cannot drift.
 */
export const Route = createFileRoute('/portal-panes/chat')({
  component: PortalChatPaneRoute,
});

export function PortalChatPaneRoute() {
  const faces = useOpChatFaces();
  return (
    <PortalPane pane="chat">
      <OperatorChatSidebar faces={faces} docked />
    </PortalPane>
  );
}
