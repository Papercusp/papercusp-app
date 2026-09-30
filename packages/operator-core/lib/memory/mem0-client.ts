/**
 * Operator deep-path shim for `@/lib/memory/mem0-client`.
 *
 * The mem0 store core now lives in `@papercusp/memory` (extracted per
 * papercusp-systems-abstraction-2026-05-29, P-021). This shim imports
 * `./configure` for its side-effect (wiring the operator host seams) and
 * re-exports the client surface so the many `@/lib/memory/mem0-client`
 * consumers — the memory:* tool wrappers, the curation pipeline, and the
 * settings/health routes — resolve unchanged.
 */

import './configure';

export {
  getMemoryClient,
  getResolvedMode,
  invalidateMemoryClient,
} from '@papercusp/memory';
