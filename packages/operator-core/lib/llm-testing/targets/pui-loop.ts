/**
 * `pui-loop` LLM target — the owned-loop prompt profile from D-034.
 *
 * Production renders the live projected catalog selected by
 * OWNED_LOOP_TOOL_SELECTION. Like the existing `su` target, this behavioral
 * SUT uses a bounded representative catalog so a matrix run remains hermetic
 * and affordable; the prompt profile itself is the production renderer.
 */
import type {
  ChatSession,
  ChatTarget,
  SessionOptions,
} from '@papercusp/testing-shell/llm';

import {
  renderPuiLoopPrompt,
  resolvePuiLoopProjectDir,
} from '../../agent-loop/prompt-profile';
import { SuTarget } from './su';
import {
  buildCatalog,
  type SuCatalogEntry,
} from './su-catalog';

export const PUI_LOOP_TARGET_CATALOG: ReadonlyArray<SuCatalogEntry> = [
  {
    name: 'capability:read',
    description: 'Read a source/text file through the owned loop file door.',
    input: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
  },
  {
    name: 'capability:edit',
    description: 'Apply one exact-string replacement through the owned loop edit door.',
    input: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'capability:write',
    description: 'Create or replace a whole file through the owned loop write door.',
    input: {
      type: 'object',
      properties: { file_path: { type: 'string' }, content: { type: 'string' } },
      required: ['file_path', 'content'],
    },
  },
  {
    name: 'capability:bash',
    description: 'Run a bounded shell command through the owned loop execution door.',
    input: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  },
  {
    name: 'capability:git',
    description: 'Run a git argv vector through the owned loop git door.',
    input: {
      type: 'object',
      properties: { args: { type: 'array', items: { type: 'string' } } },
      required: ['args'],
    },
  },
  {
    name: 'tasks:ops',
    description: 'Read or mutate the canonical task projection for this owned-loop session.',
    input: { type: 'object' },
  },
  {
    name: 'tasks:todo_write',
    description: 'Replace the session task list through the canonical task facade.',
    input: { type: 'object' },
  },
  {
    name: 'tasks:update_plan',
    description: 'Update the session plan through the canonical task facade.',
    input: { type: 'object' },
  },
];

function renderTargetCatalog(entries: ReadonlyArray<SuCatalogEntry>): string {
  return [
    '## Available tools',
    '',
    ...entries.flatMap((entry) => [
      `- \`${entry.name}\``,
      `  ${entry.description}`,
      '',
    ]),
  ].join('\n').trimEnd();
}

export class PuiLoopTarget implements ChatTarget {
  readonly id = 'pui-loop';
  readonly behaviors = [
    'canonical-su-spine',
    'project-guide-budget',
    'mode-contracts',
    'orientation-fold',
    'tool-guidance-catalog',
    'client-remediation-omitted',
  ];
  readonly supportsVariants = true;
  readonly toolNames = PUI_LOOP_TARGET_CATALOG.map((entry) => entry.name);

  async open(opts: SessionOptions): Promise<ChatSession> {
    const projectDir = resolvePuiLoopProjectDir();
    const prompt = await renderPuiLoopPrompt({
      projectDir,
      toolNames: this.toolNames,
      toolCatalogText: renderTargetCatalog(PUI_LOOP_TARGET_CATALOG),
    });
    return new SuTarget({
      id: this.id,
      behaviors: this.behaviors,
      catalog: buildCatalog(PUI_LOOP_TARGET_CATALOG),
      loadSystemPrompt: () => prompt.text,
    }).open(opts);
  }
}
