/**
 * Operator deep-path shim for `@/lib/memory/mem0-connection`.
 *
 * The connection-field resolver now lives in `@papercusp/memory` (P-021).
 * This shim imports `./configure` for its side-effect and re-exports the
 * surface so direct consumers of `pgClientFields` / `pgFields` — the
 * user/memory + user/search routes, bin/audit-memory-anchors, and
 * @papercusp/backup's orphan-cleanup test — resolve unchanged.
 */

import './configure';

export {
  connectionString,
  pgFields,
  pgClientFields,
  type Mem0PgConnection,
} from '@papercusp/memory';
