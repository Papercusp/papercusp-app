// @papercusp/grid — thin compat re-export of @papercusp/grid-core, kept for
// backward-compat while consumers gradually migrate to importing grid-core
// directly.
//
// Shop-domain helpers moved to `@papercusp/ui` on 2026-04-26 — they did not
// belong in the shared papergrid submodule. Update old imports:
//
//   - import { BulkOrderGrid }                  from '@papercusp/grid'
//   + import { BulkOrderGrid }                  from '@papercusp/ui'
//
//   - import { formatCentsForRegion, getClientRegion, type Region }
//                                               from '@papercusp/grid'
//   + import { formatCentsForRegion, getClientRegion, type Region }
//                                               from '@papercusp/ui'

// Everything from @papercusp/grid-core: theme tokens, GridTable, DataGridShell,
// grid-config, use-hover-expand, RichGrid.
export * from '@papercusp/grid-core';
