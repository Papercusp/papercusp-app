/**
 * ESM entrypoint for the authored-doc projector.
 *
 * The implementation stays in the `.ts` file because the repository's Vitest
 * imports and the existing CJS-oriented `tsx` CLI use it directly.  When Node
 * loads that file as CJS, its esbuild export object is not statically visible
 * as named ESM bindings.  Keep this small facade as the stable entrypoint for
 * scripts that need `import { listCorpusDocs } ...` under `tsx`.
 */
import * as importedImplementation from './project-authored-docs.ts';

// Node's CJS bridge places the implementation under `default`; Vitest bundles
// the `.ts` source as ESM and exposes its named exports directly.  Supporting
// both keeps this facade useful to Node/tsx consumers without breaking the
// package's existing Vitest imports.
const implementation =
  (importedImplementation as unknown as { default?: typeof importedImplementation }).default ??
  importedImplementation;

export const WORKSPACE_ID = implementation.WORKSPACE_ID;
export const HARNESS_SLUG = implementation.HARNESS_SLUG;
export const SECTION = implementation.SECTION;
export const GENERATOR_OWNED_DOCS = implementation.GENERATOR_OWNED_DOCS;
export const resolveDocsRoot = implementation.resolveDocsRoot;
export const listSectionDocs = implementation.listSectionDocs;
export const listCorpusDocs = implementation.listCorpusDocs;
export const parseExactDocSelection = implementation.parseExactDocSelection;
export const readAuthoredRows = implementation.readAuthoredRows;
export const writeContent = implementation.writeContent;
export const retireRow = implementation.retireRow;
export const BACKFILL_RETIRE_REASON = implementation.BACKFILL_RETIRE_REASON;
export const retireOrphansRefusal = implementation.retireOrphansRefusal;

export type { ExactDocSelection, ExpectedDocVersion } from './project-authored-docs.ts';
