/**
 * `@papercusp/testing-shell/server` — Node-only, framework-agnostic backend
 * cores for the universal test domains. NO React / CSS imports here, so a Hono
 * or tsx host can import these without pulling in the panel layer.
 *
 * Populated across universal-testing-domains-generic-2026-06-03:
 *  - Phase 1: ./k6        (listK6Scripts / runK6Stream / createK6HonoRoutes)
 *  - Phase 2: ./chaos     (spawnChaosWebStream + ALLOWED_BASE/clampMaxSteps)
 *  - Phase 3: ./ai-explore (spawnAiExploreStream + DEFAULT_MODELS)
 *
 * Heavy browser deps (playwright, @browserbasehq/stagehand) are OPTIONAL peer
 * deps — the cores resolve/spawn them lazily at run time, so importing this
 * barrel never touches them at module load. The Hono convenience routers live
 * in sibling `*-routes.ts` files behind their own subpath exports, so this
 * barrel never imports the optional `hono` peer either.
 */
export * from './k6';
export * from './chaos';
export * from './ai-explore';
