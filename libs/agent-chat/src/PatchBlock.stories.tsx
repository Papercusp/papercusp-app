import type { Meta, StoryObj } from '@storybook/react-vite';
import { PatchBlock } from './PatchBlock';
import type { ActionBlock } from './HarnessChat';

function block(tag: string, content: string): ActionBlock {
  return { kind: 'action', tag, content, blockKey: `${tag}-key` };
}

const meta: Meta<typeof PatchBlock> = {
  component: PatchBlock,
  args: { slug: 'demo-harness' },
};
export default meta;

type Story = StoryObj<typeof PatchBlock>;

export const SpecPatch: Story = {
  args: {
    block: block('patch:SPEC.md', '@@ -1,3 +1,3 @@\n-old line\n+new line\n  context'),
  },
};

export const ProposalWithSummary: Story = {
  args: {
    block: block(
      'proposal:contract',
      'SUMMARY: Tighten the validation contract for plugin slugs.\n---\n@@ contract.md @@\n+slug: ^[a-z0-9-]+$',
    ),
  },
};

export const NoteOnSupervisor: Story = {
  args: {
    block: block(
      'note:supervisor',
      'Watching for the smoke-test flake on `npm run test:integration`. Will revisit Wednesday.',
    ),
  },
};

export const LargePatch: Story = {
  args: {
    block: block(
      'patch:SPEC.md',
      Array.from({ length: 40 }, (_, i) => `+ line ${i + 1}`).join('\n'),
    ),
  },
};
