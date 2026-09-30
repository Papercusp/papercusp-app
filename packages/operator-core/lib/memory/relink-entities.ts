/**
 * Operator deep-path shim for the entity re-link backfill (EI-10218).
 *
 * `relinkEntities` lives in `@papercusp/memory` (P-021, alongside `reembed`).
 * This shim imports `./configure` for its side-effect (wires the memory host —
 * admin URL, embedder, schema) and re-exports the surface so the
 * `/api/user/memory/relink-entities` route resolves the configured store,
 * exactly as the reembed shim does.
 */

import './configure';

export {
  relinkEntities,
  type RelinkResult,
} from '@papercusp/memory';
