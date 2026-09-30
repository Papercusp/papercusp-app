/**
 * Operator deep-path shim for `@/lib/memory/reembed`.
 *
 * The cross-model re-embed pass now lives in `@papercusp/memory` (P-021).
 * This shim imports `./configure` for its side-effect and re-exports the
 * surface so the `/api/user/memory/reembed` route resolves unchanged.
 */

import './configure';

export {
  reembedMemories,
  type ReembedResult,
} from '@papercusp/memory';
