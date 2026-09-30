/**
 * Browser shim for `@dbos-inc/dbos-sdk` (server-only).
 *
 * Server modules reachable through the route-tree import graph (e.g.
 * `operator-core/lib/dbos/*` workflows) import the DBOS SDK. The real SDK's
 * telemetry CJS does `require('winston-transport')` at module scope, which
 * rolldown must RESOLVE during the scan even though the whole graph is
 * tree-shaken out of the final browser bundle — and on a machine without a
 * stray $HOME/node_modules copy of winston the build hard-fails (first hit:
 * the macOS build VM, mac-desktop-release-readiness-2026-06-11). Aliasing the
 * SDK here keeps server code out of the scan entirely. Calling anything on
 * these stubs in a real browser throws, same contract as the postgres shim.
 */

function serverOnly(): never {
  throw new Error('@dbos-inc/dbos-sdk is server-only and cannot run in the operator-vite browser bundle');
}

const trap: ProxyHandler<object> = {
  get(_t, prop) {
    if (prop === Symbol.toPrimitive || prop === 'toString') return () => '[dbos-browser-shim]';
    return serverOnly;
  },
  apply: serverOnly,
  construct: serverOnly,
};

export const DBOS = new Proxy({}, trap) as never;
export const WorkflowQueue = new Proxy(function WorkflowQueue() {
  serverOnly();
}, trap) as never;
// operator-core/lib/dbos/workspace-host-provision-client.ts calls DBOSClient.create(...).
export const DBOSClient = new Proxy({}, trap) as never;

export default new Proxy({}, trap) as never;
