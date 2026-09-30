/**
 * `operator:scanner` — substrate-owned scanner-role prompt (the
 * "Operator persona"). Mirrors apps/operator/lib/operator-prompt-system.ts
 * but resolves the canonical scanner.md fresh on each request so any
 * substrate edits surface immediately to MCP consumers.
 *
 * No arguments — returns the raw scanner persona.
 *
 * Host coupling: reaches the filesystem via `@papercusp/host-platform`
 * rather than `node:fs` directly. On desktop hosts this is the same
 * `readFileSync` underneath; on server hosts the call throws cleanly
 * (and the caller should never have asked for this prompt without a
 * filesystem to read from in the first place).
 */

import { resolve } from 'node:path';
import { getHostPlatform } from '@papercusp/host-platform';
import { definePrompt } from '@papercusp/tooldef';
import type { PromptResult } from '@papercusp/tooldef';
import { moduleDir } from '../module-dir';

function findScannerMd(): { path: string; text: string } | null {
  const platform = getHostPlatform();
  const here = moduleDir(import.meta);
  const candidates = [
    ...(here
      ? [
          resolve(here, '../../../../../libs/papercusp/packages/harness/blueprints/base/prompts/scanner.md'),
          resolve(here, '../../../../libs/papercusp/packages/harness/blueprints/base/prompts/scanner.md'),
        ]
      : []),
    resolve(process.cwd(), 'libs/papercusp/packages/harness/blueprints/base/prompts/scanner.md'),
    // The operator hosts run with cwd apps/operator (systemd units + Tauri
    // sidecar) — the repo root is two levels up from there.
    resolve(process.cwd(), '../../libs/papercusp/packages/harness/blueprints/base/prompts/scanner.md'),
  ];
  for (const path of candidates) {
    const text = platform.readTextFileSync(path);
    if (text !== null) return { path, text };
  }
  return null;
}

export default definePrompt({
  name: 'operator:scanner',
  description:
    'Substrate-owned Operator scanner-role prompt. Defines tier table, schema, anti-patterns. No arguments.',
  async render(): Promise<PromptResult> {
    const found = findScannerMd();
    if (!found) {
      throw new Error('Could not locate scanner.md on disk.');
    }
    return {
      description: 'Operator scanner persona — substrate canonical version.',
      messages: [{ role: 'system', content: { type: 'text', text: found.text } }],
    };
  },
});
