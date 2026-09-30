import type { Meta, StoryObj } from '@storybook/react-vite';
import { StatCard } from './StatCard';

const meta: Meta<typeof StatCard> = {
  component: StatCard,
  args: { label: 'Latency', value: '42ms' },
};
export default meta;

type Story = StoryObj<typeof StatCard>;

export const Default: Story = {};
export const Good: Story = { args: { tone: 'good' } };
export const Warn: Story = { args: { tone: 'warn', value: '180ms' } };
export const Bad:  Story = { args: { tone: 'bad',  value: '4.2s' } };
export const Info: Story = { args: { tone: 'info' } };
export const NumberValue: Story = { args: { label: 'Open PRs', value: 12 } };
