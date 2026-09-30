import type { Meta, StoryObj } from '@storybook/react-vite';
import { StatusPill } from './StatusPill';

const meta: Meta<typeof StatusPill> = {
  component: StatusPill,
};
export default meta;

type Story = StoryObj<typeof StatusPill>;

export const Todo:        Story = { args: { status: 'todo' } };
export const InProgress:  Story = { args: { status: 'in_progress' } };
export const Validating:  Story = { args: { status: 'validating' } };
export const Failing:     Story = { args: { status: 'failing' } };
export const Passed:      Story = { args: { status: 'passed' } };
export const Blocked:     Story = { args: { status: 'blocked' } };

export const AllStatuses: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <StatusPill status="todo" />
      <StatusPill status="in_progress" />
      <StatusPill status="validating" />
      <StatusPill status="failing" />
      <StatusPill status="passed" />
      <StatusPill status="blocked" />
    </div>
  ),
};
