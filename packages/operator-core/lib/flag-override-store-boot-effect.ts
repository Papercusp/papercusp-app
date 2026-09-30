/**
 * Side-effect-only module: install the PG-backed runtime flag-override store
 * IMMEDIATELY at import time (WI-6822).
 *
 * WHY THIS EXISTS AS ITS OWN FILE, NOT JUST A FUNCTION CALL AT THE TOP OF A
 * SERVER'S MAIN(): ES module import evaluation is transitive and eager — ALL
 * of a module's own `import` declarations are fully evaluated, in
 * declaration (encounter) order, before ANY of that module's own top-level
 * code runs — and a function body doesn't count as "top-level code" until
 * something actually CALLS it. So `installFlagOverrideStore()` placed as the
 * literal first statement inside a `run*Server()` function is NOT early
 * enough if anything earlier in that file's import graph performs its OWN
 * module-level flag read.
 *
 * Several operator-core modules do exactly that — the "SYNC-cached flag,
 * refreshed on module load" pattern, e.g. `work-item-claim-lease-wiring.ts`'s
 * top-level `void refreshClaimLease()`, plus the same shape in
 * `issues-engineer.ts`, `release-checkpoint-config.ts`,
 * `pot-control-policy.ts`, `work-item-redundancy.ts`, `lexicon/configure.ts`,
 * `memory/configure.ts`, `events/cache-eca-rule.ts`. A standalone sidecar
 * process (e.g. `fleet/spawner-sidecar-server.ts`) that transitively imports
 * `dbos/orchestrator-runner.ts` — which imports `work-item-claim-lease-
 * wiring.ts` — hits this concretely: that module's top-level
 * `void refreshClaimLease()` calls `getFlag()` DURING the import phase,
 * before the server's own `run*Server()` body (where the install call used
 * to live) ever executes. Result: the one-shot "[flags] No override store
 * installed" warning latches permanently, and that first flag read silently
 * resolves to its default, on every single boot (found live 2026-08-02,
 * reproduced by running `apps/operator/bin/spawner-sidecar.ts` directly and
 * tracing `warnOverrideStoreMissingOnce`'s call stack straight into
 * `work-item-claim-lease-wiring.ts:44`).
 *
 * The fix: install the store as a side effect of importing THIS module, and
 * import THIS module FIRST — textually before any import that might pull in
 * a module-level flag reader — in any standalone sidecar/worker entry.
 * Sibling `import` declarations in one file are evaluated fully, in
 * encounter order, before the next sibling import starts evaluating; put
 * this one first and its install runs before any later sibling's transitive
 * side effects, in BOTH the dev-tsx entry (a static import) and the packaged
 * `serve.ts` divert (a dynamic `await import(...)` of the same module — the
 * target module's OWN import graph, including this file if it's imported
 * first there, still resolves fully before the dynamic import settles).
 *
 * (`apps/operator/bin/boot-flag-store.ts` is the analogous fix for the main
 * operator/bg-host boot graph — same idea, app-scoped rather than
 * operator-core-scoped since hono-host.ts's own import order already puts it
 * first.)
 */
import { installFlagOverrideStore } from './flag-override-store';

installFlagOverrideStore();
