/**
 * pui-loop prompt profile — the owned loop's system-prompt prefix.
 *
 * D-034 / WI-583183: the profile is produced by the shared
 * `assembleRolePrompt` pipeline. Client-only remediation is excluded while
 * canonical sources are projected, never stripped from a finished prompt.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PUI_LOOP_PROJECT_GUIDE_MAX_CHARS,
  assembleRolePrompt,
  projectGuideAtBudget,
} from '../prompt-assembly';

export {
  PUI_LOOP_PROJECT_GUIDE_MAX_CHARS,
  projectGuideAtBudget,
};

export interface RenderPuiLoopPromptInput {
  projectDir: string;
  /** Exact executable tool names selected by capabilityToolNames(). */
  toolNames: string[];
  /** Test/packaging override for the canonical su base source. */
  baseSource?: string;
  /** Explicit guide path. Undefined resolves CLAUDE.md then AGENTS.md. */
  projectGuideSource?: string;
  /** Hermetic llm-target override; production renders the live catalog. */
  toolCatalogText?: string;
  projectGuideMaxChars?: number;
}

export interface RenderedPuiLoopPrompt {
  text: string;
  baseSource: string;
  projectGuideSource: string;
  projectGuideTruncated: boolean;
  omittedClientRemediation: string[];
}

function resolveProjectGuideSource(projectDir: string, explicit?: string): string {
  if (explicit !== undefined) return explicit;
  for (const candidate of [join(projectDir, 'CLAUDE.md'), join(projectDir, 'AGENTS.md')]) {
    if (existsSync(candidate)) return candidate;
  }
  return '';
}

/**
 * Thin profile facade used by the route and the llm-testing target. The actual
 * assembly and source-level omission contract live in `assembleRolePrompt`.
 */
export async function renderPuiLoopPrompt(
  input: RenderPuiLoopPromptInput,
): Promise<RenderedPuiLoopPrompt> {
  const projectGuideSource = resolveProjectGuideSource(
    input.projectDir,
    input.projectGuideSource,
  );
  const assembled = assembleRolePrompt({
    role: 'operator',
    profile: 'pui-loop',
    projectDir: input.projectDir,
    toolNames: input.toolNames,
    baseSource: input.baseSource,
    projectGuideSource,
    projectGuideMaxChars: input.projectGuideMaxChars,
    toolCatalogText: input.toolCatalogText,
  });
  return {
    text: assembled.text,
    baseSource: assembled.baseSource ?? input.baseSource ?? '',
    projectGuideSource: assembled.projectGuideSource ?? projectGuideSource,
    projectGuideTruncated: assembled.projectGuideTruncated ?? false,
    omittedClientRemediation: assembled.omittedClientRemediation ?? [],
  };
}

/** Resolve the repository root for the hermetic llm target from any cwd. */
export function resolvePuiLoopProjectDir(start = process.cwd()): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  for (const initial of [resolve(start), moduleDir]) {
    let dir = initial;
    for (let i = 0; i < 12; i += 1) {
      if (existsSync(join(dir, 'CLAUDE.md')) && existsSync(join(dir, 'packages'))) {
        return dir;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return resolve(start);
}
