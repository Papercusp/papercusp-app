'use client';

/**
 * DiscussPanel — the single "Discuss" action's inline panel
 * (queue-pending-accuracy P-004 ext-2 (A)). Folds the old Chat + Message-owner
 * pair into one intent and routes to the best target:
 *   - **Reply to the originating agent** (MessageOwnerThread) when that agent is
 *     a live, addressable one — i.e. a real agent id, NOT a `system[:…]` / CI-bot
 *     identity. (For most escalations the "owner" is `system:hive-placement-watchdog`
 *     or a dead bee; a coord message to it is recorded but never read.)
 *   - **Fresh harness agent chat** (PlanChat) otherwise.
 * Defaults to the smart target; when both are possible a small toggle lets the
 * owner switch, so neither capability is lost under the single button.
 */

import { useState } from 'react';
import PlanChat from './PlanChat';
import MessageOwnerThread from './MessageOwnerThread';
import type { AttentionItem } from './plans-api';

/** A `system` / `system:<emitter>` / named CI-bot id is not a live, interactive
 *  agent you can reply to — mirrors isOperationalEscalation's sender check. */
function isSystemAgentId(id: string | null | undefined): boolean {
  return !id || id === 'system' || id.startsWith('system:') || id === 'green-checkpoint';
}

const noteStyle = { fontSize: 11.5, color: 'var(--fg-mute)', margin: '6px 14px 0' } as const;

export default function DiscussPanel({ item, chatLabel }: { item: AttentionItem; chatLabel: string }) {
  const ownerLabel = item.ownerLabel ?? item.ownerAgentId ?? 'the agent';
  const canReplyOwner = !!item.ownerAgentId && !isSystemAgentId(item.ownerAgentId);
  const canHarnessChat = !!item.harnessSlug;
  const [mode, setMode] = useState<'owner' | 'harness'>(canReplyOwner ? 'owner' : 'harness');

  if (!canReplyOwner && !canHarnessChat) {
    return (
      <div style={noteStyle} data-testid="discuss-empty">
        No live agent to discuss this with — it was raised by {item.ownerLabel ?? 'a system process'} and isn’t
        attached to a harness chat.
      </div>
    );
  }

  return (
    <div data-testid="discuss">
      {canReplyOwner && canHarnessChat ? (
        <nav className="pc-queue__tabs" aria-label="Discuss with" style={{ margin: '6px 14px 0' }}>
          <button
            type="button"
            className={`pc-queue__tab${mode === 'owner' ? ' is-active' : ''}`}
            aria-pressed={mode === 'owner'}
            onClick={() => setMode('owner')}
          >
            Reply to {ownerLabel}
          </button>
          <button
            type="button"
            className={`pc-queue__tab${mode === 'harness' ? ' is-active' : ''}`}
            aria-pressed={mode === 'harness'}
            onClick={() => setMode('harness')}
          >
            Fresh {item.harnessSlug} agent
          </button>
        </nav>
      ) : (
        <div style={noteStyle}>
          {canReplyOwner
            ? `Replying to ${ownerLabel}.`
            : `Raised by ${item.ownerLabel ?? 'a system process'} (not an interactive agent) — chatting with a fresh ${item.harnessSlug} agent.`}
        </div>
      )}
      {mode === 'owner' && canReplyOwner ? (
        <MessageOwnerThread item={item} />
      ) : (
        <PlanChat harnessSlug={item.harnessSlug} label={chatLabel} />
      )}
    </div>
  );
}
