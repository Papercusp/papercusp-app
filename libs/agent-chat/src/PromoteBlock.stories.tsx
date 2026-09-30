import type { Meta, StoryObj } from '@storybook/react-vite';
import { PromoteBlock } from './PromoteBlock';
import type { ActionBlock } from './HarnessChat';

function block(tag: string, content: string): ActionBlock {
  return { kind: 'action', tag, content, blockKey: `${tag}-key` };
}

const meta: Meta<typeof PromoteBlock> = {
  component: PromoteBlock,
  args: { slug: 'demo-harness' },
};
export default meta;

type Story = StoryObj<typeof PromoteBlock>;

export const PromoteFeature: Story = {
  args: {
    block: block(
      'promote:feature',
      JSON.stringify({ id: 'F-101', title: 'Snapshot publish flow', status: 'todo' }, null, 2),
    ),
  },
};

export const PromoteSpec: Story = {
  args: {
    block: block(
      'promote:spec',
      '## Snapshot publish flow\n\nDescribes the end-to-end CLI → marketplace API path.',
    ),
  },
};

export const PromoteIssue: Story = {
  args: {
    block: block(
      'promote:issue',
      JSON.stringify({ id: 'BUG-42', title: 'Pty replay returns empty', priority: 'high' }, null, 2),
    ),
  },
};
