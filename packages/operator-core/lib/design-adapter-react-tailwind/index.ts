/**
 * papercusp-design-react-tailwind — first ecosystem adapter
 * (eat-our-own-dogfood for papercusp's own React + Tailwind UI).
 *
 * Plan §15 (build), step 6.
 */
import type { DesignEcosystemAdapter } from '../design-adapter';
import { makeReactTailwindRegistry } from './registry';
import { makeReactTailwindTokens } from './tokens';
import { makeReactTailwindCodeEmit } from './code-emit';

export interface ReactTailwindAdapterOpts {
  /** Workspace-relative roots the registry scans for primitives.
   *  v0.1 uses a hand-curated set that ignores these; future TS
   *  extractor will use them. */
  registrySourcePaths?: string[];
  /** Where the tokens emitter writes generated CSS vars. */
  cssVarsOutPath?: string;
  /** Where the tokens emitter writes the Tailwind preset. */
  tailwindPresetOutPath?: string;
}

export function createReactTailwindAdapter(
  opts: ReactTailwindAdapterOpts = {},
): DesignEcosystemAdapter {
  const sourcePaths = opts.registrySourcePaths ?? ['apps/operator/app/harness/'];
  return {
    id: 'papercusp-design-react-tailwind',
    displayName: 'React + Tailwind (papercusp)',
    ecosystem: 'react-tailwind',
    capabilities: ['registry', 'tokens', 'codeEmit'],
    irVersionsSupported: ['0.x'],
    uiPaths: ['**/*.tsx', '**/*.jsx', '**/*.css', 'app/**/page.tsx', 'app/**/layout.tsx'],
    registry: makeReactTailwindRegistry({ sourcePaths }),
    tokens: makeReactTailwindTokens({
      cssVarsOutPath: opts.cssVarsOutPath,
      tailwindPresetOutPath: opts.tailwindPresetOutPath,
    }),
    codeEmit: makeReactTailwindCodeEmit(),
  };
}

export { makeReactTailwindRegistry, makeReactTailwindTokens, makeReactTailwindCodeEmit };
