'use client';

/**
 * AdvPrsPanel — dock-panel wrapper hosting the self-contained <PrsTab/> in
 * the /adv Git dock. Mirrors the AdvChatPanel wrapper pattern: pull the
 * harness slug out of the panel params and render the standalone tab.
 */

import type { PanelComponentProps } from '../../harness/dock/panel-registry';
import PrsTab from '@/app/harness/PrsTab';

export default function AdvPrsPanel({ params }: PanelComponentProps) {
  const slug = (params.harnessSlug as string) || (params.slug as string) || '';
  if (!slug) {
    return (
      <div style={{ padding: 16, fontSize: 13, color: 'var(--fg-mute)' }}>
        No harness slug in params.
      </div>
    );
  }
  return <PrsTab harnessSlug={slug} />;
}
