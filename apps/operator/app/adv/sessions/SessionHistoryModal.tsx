'use client';

import { parseAsString, useQueryState } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import AgentInspectorModal from '../../harness/AgentInspectorModal';
import { Modal } from '../../harness/Modal';
import { useOwnerSessionChat, type SessionRosterHint } from '../../_components/chat/use-owner-session-chat';
import { advRosterArgs } from '../../../lib/adv-roster-args';

/** The existing turn-by-turn inspector, addressable by any native host. The
 * optional session key pins an inactive row instead of opening its owner's
 * latest session. No second transcript renderer or stream parser. */
export default function SessionHistoryModal() {
  const [ownerId, setOwnerId] = useQueryState('agentHistory', parseAsString);
  const [sessionKey, setSessionKey] = useQueryState('agentHistorySession', parseAsString);
  const [, setApp] = useQueryState('app', parseAsString);
  const [, setHudSession] = useQueryState('hudsession', parseAsString);
  const [, setConversation] = useQueryState('agentConversation', parseAsString);
  const roster = useSyncQuery<{ active: Array<SessionRosterHint & { ownerId: string; label?: string | null; role?: string | null; harnessSlug?: string | null }> }>({
    queryName: 'advRoster.list', args: advRosterArgs(), enabled: Boolean(ownerId),
  });
  const agent = roster.data?.[0]?.active.find((row) => row.ownerId === ownerId);
  const chat = useOwnerSessionChat(sessionKey ? null : ownerId, {}, agent ?? {});
  const close = () => { void setOwnerId(null); void setSessionKey(null); };
  if (!ownerId) return null;

  let streamUrl = chat.streamUrl;
  if (sessionKey) {
    const [backend, id, ompHome] = sessionKey.split(':');
    const key = backend === 'codex' ? 'codexSessionKey' : backend === 'omp' ? 'ompThreadId' : backend === 'claude' ? 'sessionId' : null;
    if (key && id) {
      const params = new URLSearchParams({ [key]: id, owner: ownerId, ended: '1' });
      if (backend === 'omp' && ompHome) params.set('ompSessionKey', ompHome);
      streamUrl = `/api/adv/session/thinking?${params}`;
    }
  }
  if (!streamUrl) return (
    <Modal open title="Session history" onOpenChange={(open) => { if (!open) close(); }}>
      <p role={chat.resolveError ? 'alert' : 'status'}>
        {chat.resolveError ?? (chat.resolving || !roster.data ? 'Loading session history…' : 'No transcript is available for this session.')}
      </p>
      <button type="button" onClick={close}>Close</button>
    </Modal>
  );
  return (
    <AgentInspectorModal
      key={`${ownerId}:${sessionKey ?? ''}`}
      open onClose={close}
      slug={agent?.harnessSlug ?? ''} phase="staging" runId={ownerId}
      role={agent?.label ?? agent?.role ?? 'Session history'}
      streamUrl={streamUrl}
      conversationOwnerId={ownerId}
      onOpenInGui={(id) => {
        close();
        void setConversation(id);
        void setHudSession(id);
        void setApp('hud');
      }}
    />
  );
}
