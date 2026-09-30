'use client';

import { HarnessChat, type ActionBlock } from '@papercusp/agent-chat';
import { PromoteBlock } from '@papercusp/agent-chat';

interface Props { slug: string }

export default function BrainstormChat({ slug }: Props) {
  const renderActionBlock = (block: ActionBlock) => {
    if (block.tag.startsWith('promote:')) {
      return <PromoteBlock slug={slug} block={block} />;
    }
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
      endpoint="brainstorm/chat"
      storageKey={`harness.brainstorm-chat.${slug}`}
      placeholder="Pitch an idea…  (⌘↵ to send)"
      emptyHint="Brainstorm partner here — I'll help explore ideas, challenge assumptions, and suggest analogues. When an idea matures, I can promote it to a feature, SPEC note, or issue."
      renderActionBlock={renderActionBlock}
    />
  );
}
