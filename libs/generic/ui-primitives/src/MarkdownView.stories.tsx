import type { Meta, StoryObj } from '@storybook/react-vite';
import { MarkdownView } from './MarkdownView';

const meta: Meta<typeof MarkdownView> = {
  component: MarkdownView,
};
export default meta;

type Story = StoryObj<typeof MarkdownView>;

export const Empty: Story = { args: { source: '' } };

export const Headings: Story = {
  args: { source: `# Heading\n\n## Sub\n\nParagraph with **bold** and *italic*.` },
};

export const ListsAndLinks: Story = {
  args: {
    source: `- item one\n- item two\n  - nested\n- item three\n\n[link](https://example.com)\n\n\`inline code\``,
  },
};

export const Table: Story = {
  args: {
    source: `| col a | col b |\n| --- | --- |\n| one | two |\n| three | four |`,
  },
};
