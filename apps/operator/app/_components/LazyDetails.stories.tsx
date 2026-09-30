import type { Meta, StoryObj } from '@storybook/react-vite';
import { LazyDetails } from './LazyDetails';

const meta: Meta<typeof LazyDetails> = {
  component: LazyDetails,
};
export default meta;

type Story = StoryObj<typeof LazyDetails>;

export const Closed: Story = {
  args: {
    summary: 'Click to expand',
    children: <p>Hidden content</p>,
  },
};

export const OpenByDefault: Story = {
  args: {
    summary: 'Already open',
    defaultOpen: true,
    children: <p style={{ color: '#9ca3af' }}>Visible content with some text inside.</p>,
  },
};

export const RichSummary: Story = {
  args: {
    summary: (
      <span>
        <strong>Voicemode</strong> · 12 engines available
      </span>
    ),
    children: (
      <ul>
        <li>Engine A</li>
        <li>Engine B</li>
        <li>Engine C</li>
      </ul>
    ),
  },
};
