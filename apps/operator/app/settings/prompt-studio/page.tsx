'use client';

import PromptStudioPanel from '../../prompt-studio/PromptStudioPanel';

/**
 * Prompt Studio settings page (P-011) — renders the self-contained PromptStudioPanel.
 * The /settings layout supplies the surrounding chrome, so this renders bare content
 * (the panel fills the settings content section). Flag-gated via the nav link
 * (PROMPT_STUDIO) + the gated /api/prompt-studio/* routes.
 */
export default function Page() {
  return (
    <div style={{ height: '100%', minHeight: 480, display: 'flex', flexDirection: 'column' }}>
      <PromptStudioPanel />
    </div>
  );
}
