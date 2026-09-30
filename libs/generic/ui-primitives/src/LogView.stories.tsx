import React from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { LogView, type LogEvent } from './LogView';

const meta: Meta<typeof LogView> = {
  component: LogView,
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    (Story) => (
      <div style={{ height: '400px', background: '#0f1422', display: 'flex', flexDirection: 'column' }}>
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof LogView>;

function makeEvent(
  level: LogEvent['level'],
  msg: string,
  source = 'app',
  tsOffset = 0,
): LogEvent {
  const d = new Date(Date.now() + tsOffset);
  return { ts: d.toISOString(), source, level, msg };
}

const SAMPLE_EVENTS: LogEvent[] = [
  makeEvent('info',  'orchestrator started, watching for features', 'app', -5000),
  makeEvent('debug', 'polling: 0 features in todo state', 'app', -4000),
  makeEvent('info',  'feature F-001 claimed by worker-1', 'app', -3000),
  makeEvent('warn',  'feature F-001 attempt 2 (previous attempt timed out)', 'app', -2500),
  makeEvent('info',  'worker-1 committed chunk F-001-1', 'app', -2000),
  makeEvent('info',  'plugin:@papercusp/eslint: running lint pass', 'plugin:@papercusp/eslint', -1500),
  makeEvent('error', 'typecheck failed: src/foo.ts(12): cannot find module', 'app', -1000),
  makeEvent('info',  'retrying with fixed imports', 'app', -500),
  makeEvent('info',  'feature F-001 passed validation', 'app', 0),
];

const ANSI_EVENTS: LogEvent[] = [
  makeEvent('info',  '\x1b[32mSuccess\x1b[0m: build completed in 1.2s', 'app', -2000),
  makeEvent('warn',  '\x1b[33mWarning\x1b[0m: unused variable `x` at line 42', 'app', -1000),
  makeEvent('error', '\x1b[31mError\x1b[0m: segfault in native module', 'app', 0),
];

export const Empty: Story = {
  args: { events: [] },
};

export const WithEvents: Story = {
  args: { events: SAMPLE_EVENTS },
};

export const WithPlugin: Story = {
  args: {
    events: SAMPLE_EVENTS,
    primarySource: 'app',
    primarySourceLabel: 'Orchestrator',
  },
};

export const ErrorsOnly: Story = {
  args: {
    events: SAMPLE_EVENTS,
    tabs: [
      { id: 'errors', label: 'Errors', filter: (e) => e.level === 'error' },
    ],
    activeTabId: 'errors',
  },
};

export const AnsiColors: Story = {
  args: { events: ANSI_EVENTS },
};

export const NewestFirst: Story = {
  args: { events: SAMPLE_EVENTS, newestFirst: true },
};
