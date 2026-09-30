import type { Meta, StoryObj } from '@storybook/react-vite';
import { JsonTree } from './JsonTree';

const meta: Meta<typeof JsonTree> = {
  component: JsonTree,
};
export default meta;

type Story = StoryObj<typeof JsonTree>;

export const SimpleObject: Story = {
  args: { data: { name: 'harness-1', stats: { passed: 12, failed: 0 } } },
};

export const NestedArrays: Story = {
  args: {
    data: {
      runs: [
        { id: 'r-001', status: 'passed', durationMs: 412 },
        { id: 'r-002', status: 'failed', error: 'timeout' },
      ],
    },
  },
};

export const StringInput: Story = {
  args: { data: '{"parsed": "from string"}' },
};

export const Primitive: Story = {
  args: { data: 'just a string, no parsing' as unknown as object },
};
