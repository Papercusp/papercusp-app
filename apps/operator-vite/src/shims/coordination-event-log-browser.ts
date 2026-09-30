/**
 * Browser boundary for the server-owned coordination event-log package.
 *
 * Client-reachable operator-core modules import `@papercusp/coordination/event-log`
 * (vite.config aliases the specifier HERE). Loading the real barrel would drag its
 * Postgres and filesystem backends into the SPA graph, which cannot be parsed into
 * a browser bundle — so this shim stands in for it and must export every VALUE
 * those modules import.
 *
 * ⚠ Keep this in lockstep with the importers, or the SPA build DIES — and dies in
 * the worst possible way. A missing export here is a rolldown MISSING_EXPORT, which
 * is a LINK-time error: it fires AFTER vite's renderStart hook has already emptied
 * dist/, so it does not merely fail the build, it DESTROYS the bundle that was
 * serving and leaves a dead desktop behind a 503 (EI-10539 — this exact shim did it
 * on 2026-07-12: `agent-tools/coordination/log.ts` began importing `PgCoordLog` and
 * the shim did not export it). bin/vite-build-singleflight now stages builds so a
 * red build can no longer eat dist/, and coordination-event-log-browser.test.ts
 * fails the moment an importer reaches for a binding this shim lacks — but the
 * cheapest place to get this right is still here.
 */
export const DEFAULT_COORD_WORKSPACE = 'default';

/**
 * Browser stand-in for the coordination log's schema bootstrap.
 *
 * A client-reachable operator-core module imports this value while assembling a
 * server-side composition rig. The browser build therefore needs the binding to
 * link, but actually invoking it from the SPA would still be a boundary breach.
 * Throw loudly instead of pretending the Postgres schema exists in the browser.
 */
export async function ensureCoordEventLogTable(..._args: unknown[]): Promise<never> {
  throw new Error(
    '[browser] ensureCoordEventLogTable() is server-only. The SPA cannot bootstrap the coordination event-log schema.',
  );
}

/**
 * Browser stand-in for the coordination package's Postgres retry wrapper.
 *
 * Client-reachable tool modules import this binding even though their handlers
 * execute only on the operator server. The shim must expose it so the SPA can
 * link, but it must never run the supplied operation in a browser: doing so
 * would turn a boundary violation into a local write attempt before failing.
 */
export async function withPgContentionRetry(..._args: unknown[]): Promise<never> {
  throw new Error(
    '[browser] withPgContentionRetry() is server-only. The SPA cannot run Postgres coordination writes.',
  );
}

/**
 * Browser stand-in for the Postgres CoordEventLog backend.
 *
 * `agent-tools/coordination/log.ts` constructs one at MODULE SCOPE
 * (`let impl: CoordEventLog = makeDefaultLog()`), so merely importing that module
 * in the SPA constructs this — construction must therefore be harmless and silent.
 * Actually CALLING it is a different matter: the coord event log is a server-owned
 * surface reached over the API, never spoken to directly from the browser. Any call
 * here is a bug, so every method throws instead of silently no-op'ing (a silent
 * no-op would swallow coord writes and look like flaky coordination).
 *
 * Methods are proxied rather than listed so this cannot drift out of date as the
 * CoordEventLog interface grows — a new method throws too, instead of arriving as
 * `undefined is not a function`.
 */
export class PgCoordLog {
  constructor(_opts?: unknown) {
    return new Proxy(this, {
      get(target, prop, receiver) {
        // Only the LOG SURFACE throws. Everything the language and the runtime
        // routinely touch must answer normally:
        //   · symbols       — Symbol.toStringTag, Symbol.iterator, node's inspect
        //   · `then`        — a throwing `then` reads as a broken thenable and
        //                     detonates any `await` that merely passes it along
        //   · Object.prototype members (toString, valueOf, constructor, …) —
        //     `String(log)` and `console.log(log)` call these, and a stub that
        //     explodes when something DEBUGS it is a trap, not a guard rail.
        if (typeof prop === 'symbol' || prop === 'then' || prop in Object.prototype) {
          return Reflect.get(target, prop, receiver);
        }
        return (..._args: unknown[]) => {
          throw new Error(
            `[browser] PgCoordLog.${String(prop)}() is server-only. The SPA must reach the ` +
              `coordination event log through the operator API, not by constructing a PG ` +
              `backend in the browser. (apps/operator-vite/src/shims/coordination-event-log-browser.ts)`,
          );
        };
      },
    });
  }
}
