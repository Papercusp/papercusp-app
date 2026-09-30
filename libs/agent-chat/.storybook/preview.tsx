import type { Preview } from '@storybook/react-vite';
import { useEffect } from 'react';

/**
 * Block all network calls in stories — agent-chat blocks (PatchBlock,
 * PromoteBlock) post to /api/harness/<slug>/* on click. Stories should
 * render the visual states without ever hitting a real backend.
 */
function BlockFetch() {
  useEffect(() => {
    const original = window.fetch;
    window.fetch = async () => new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
    return () => { window.fetch = original; };
  }, []);
  return null;
}

const preview: Preview = {
  decorators: [
    (Story) => (
      <>
        <BlockFetch />
        <Story />
      </>
    ),
  ],
  parameters: {
    backgrounds: {
      default: 'harness',
      values: [
        { name: 'harness', value: '#0c0e16' },
        { name: 'light',   value: '#ffffff' },
      ],
    },
    layout: 'padded',
  },
};

export default preview;
