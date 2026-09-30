import React from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Panel } from './Panel';

const meta: Meta<typeof Panel> = {
  component: Panel,
  args: {
    title: 'Feature Queue',
    children: (
      <div style={{ padding: 12, fontSize: 13, color: '#e7ecf3' }}>
        Panel body content goes here.
      </div>
    ),
  },
};
export default meta;

type Story = StoryObj<typeof Panel>;

export const Default: Story = {};

export const WithCount: Story = {
  args: { count: 7 },
};

export const WithActions: Story = {
  args: {
    actions: (
      <button type="button" style={{ padding: '2px 8px', fontSize: 11 }}>
        Refresh
      </button>
    ),
  },
};

export const Padded: Story = {
  args: {
    padded: true,
    children: <p style={{ margin: 0, fontSize: 13 }}>Padded panel body.</p>,
  },
};

export const NonMaximizable: Story = {
  args: { maximizable: false },
};

export const WithCountAndActions: Story = {
  args: {
    count: 3,
    actions: (
      <button type="button" style={{ padding: '2px 8px', fontSize: 11 }}>
        Add
      </button>
    ),
  },
};
