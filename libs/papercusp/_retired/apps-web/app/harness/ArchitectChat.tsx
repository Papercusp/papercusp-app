'use client';

import { HarnessChat, type ActionBlock } from '@papercusp/agent-chat';
import { PatchBlock } from '@papercusp/agent-chat';

interface Props {
  slug: string;
  reviewId?: string;
  threadId?: string;
  onThreadTitleInferred?: (title: string) => void;
  onReviewAccepted?: (userResponse: string) => void;
}

export default function ArchitectChat({
  slug, reviewId, threadId, onThreadTitleInferred, onReviewAccepted,
}: Props) {
  const chatKey = reviewId ?? threadId ?? 'adhoc';

  const renderActionBlock = (block: ActionBlock) => {
    if (block.tag.startsWith('proposal:') || block.tag.startsWith('patch:') || block.tag.startsWith('note:')) {
      return (
        <PatchBlock
          slug={slug}
          block={block}
          onReviewAccepted={onReviewAccepted ? () => onReviewAccepted('Accepted Architect patch') : undefined}
        />
      );
    }
    // Fallback: render as code-ish block
    return (
      <pre style={{
        background: 'var(--bg)', border: '1px solid var(--border)',
        borderRadius: 4, padding: 6, fontSize: 10.5, color: 'var(--fg)',
        whiteSpace: 'pre-wrap', margin: '8px 0',
      }}>{'```' + block.tag + '\n' + block.content + '\n```'}</pre>
    );
  };

  return (
    <HarnessChat
      slug={slug}
      endpoint="architect/chat"
      storageKey={`harness.chat.${slug}.${chatKey}`}
      extraBody={{ reviewId }}
      placeholder={reviewId ? 'Answer or ask back…' : 'Describe the change…  (⌘↵ to send)'}
      emptyHint={
        reviewId
          ? 'The Architect is asking for your input on this escalation. Answer below — it will produce a concrete spec change you can accept.'
          : 'Pitch an idea or change. The Architect will ask clarifying questions until your intent is precise, then propose a SPEC/contract patch you can accept.'
      }
      renderActionBlock={renderActionBlock}
      onThreadTitleInferred={onThreadTitleInferred}
    />
  );
}
