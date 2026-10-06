/**
 * Coding-role targets for the code-search scenarios (gitnexus-deterministic-
 * integration-2026-10-05 P-015): "add scenarios for the su role and at least one
 * coding role".
 *
 * `worker` is the coding spine position (the implementer — see
 * `su-decomposition.ts`, `role('worker.md', …)`). It reuses the su in-process loop
 * exactly as the overwatch / onboarding-tutor siblings do — `new SuTarget` with
 * its own prompt loader and catalog — so the only variables between the su and
 * worker runs of one scenario are the prompt and the offered tool set.
 *
 * The prompt is the worker's blueprint layers in launch order: the domain-neutral
 * base preamble every spawned agent receives, the role-family base fragment, then
 * the role prompt. They are read from SOURCE, so a prompt edit is measured on the
 * next run without a rebuild.
 *
 * `su-code` is the canonical su playbook with the code-search tools appended (see
 * `code-search-catalog.ts` for why they are not in `SU_CATALOG` itself).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CODE_SEARCH_CATALOG } from './code-search-catalog';
import { SuTarget } from './su';
import { buildCatalog, SU_CATALOG, type SuCatalogEntry } from './su-catalog';

const PROMPTS_REL = join('libs', 'papercusp', 'packages', 'harness', 'blueprints', 'base', 'prompts');

/** The worker launch prompt's layers, in render order. */
export const WORKER_PROMPT_LAYERS = ['agent-base-preamble.md', 'worker.base.md', 'worker.md'] as const;

export const WORKER_FRAMING =
  'The following is your operating prompt as a coding worker agent in this repository — follow it exactly.\n\n';

export const WORKER_BEHAVIORS = [
  'complete-search-before-absence',
  'name-cross-workspace-consumers',
  'definition-via-compiler-or-text-search',
];

function resolvePromptsDir(): string {
  const override = process.env.PAPERCUSP_BLUEPRINT_PROMPTS_DIR;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    ...(override ? [override] : []),
    join(here, '..', '..', '..', '..', '..', PROMPTS_REL),
    join(process.cwd(), PROMPTS_REL),
    join(process.cwd(), '..', '..', PROMPTS_REL), // when cwd = apps/operator
  ];
  const found = candidates.find((dir) => existsSync(join(dir, 'worker.md')));
  if (!found) {
    throw new Error(
      `worker target: could not locate the blueprint prompts directory (${PROMPTS_REL}). ` +
        `Set PAPERCUSP_BLUEPRINT_PROMPTS_DIR. Tried:\n  ${candidates.join('\n  ')}`,
    );
  }
  return found;
}

/** The worker's system prompt: framing + every layer, each trimmed, blank-line separated. */
export function loadWorkerPrompt(): string {
  const dir = resolvePromptsDir();
  return WORKER_FRAMING + WORKER_PROMPT_LAYERS.map((file) => readFileSync(join(dir, file), 'utf8').trim()).join('\n\n');
}

/** What a coding worker is offered here: file reads plus the code-search tools. */
export const WORKER_CATALOG: ReadonlyArray<SuCatalogEntry> = [
  ...SU_CATALOG.filter((entry) => entry.name === 'capability:read'),
  ...CODE_SEARCH_CATALOG,
];

export function makeWorkerTarget(): SuTarget {
  return new SuTarget({
    id: 'worker',
    behaviors: WORKER_BEHAVIORS,
    catalog: buildCatalog(WORKER_CATALOG),
    loadSystemPrompt: loadWorkerPrompt,
  });
}

/** The su role with the code-search tools offered alongside its normal catalog. */
export function makeSuCodeTarget(): SuTarget {
  return new SuTarget({
    id: 'su',
    catalog: buildCatalog([...SU_CATALOG, ...CODE_SEARCH_CATALOG]),
  });
}
