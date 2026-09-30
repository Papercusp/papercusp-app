/**
 * Browser shim for the server-only P2P substrate networking stack
 * (`corestore`, `hyperswarm`, `hyperdht`, `hyperbee`, `hypercore`,
 * `udx-native`, `sodium-universal`/`sodium-native`, `hypercore-crypto`, …).
 *
 * Many core backend modules reachable through the route-tree import graph
 * (e.g. `operator-core/lib/work-items`, `issues-engineer`, `orchestrator/*`,
 * the `hive-*` and `sync/hyperbee/*` modules) import these packages at module
 * scope. Rolldown must RESOLVE the whole transitive graph during its scan even
 * though it is tree-shaken out of the final browser bundle — and it hard-fails
 * because `sodium-universal/index.js` requires the **native** `sodium-native`
 * (a `.node` addon that cannot resolve for the browser target), and the
 * `hyperdht`/`udx-native` stack is likewise native. Aliasing these packages
 * here keeps the server-only substrate out of the scan entirely.
 *
 * The browser never runs P2P substrate code (the desktop/server owns the
 * transport; the SPA only ever talks to the local API), so — same contract as
 * the `postgres` and `@dbos-inc/dbos-sdk` shims — touching anything on these
 * stubs in a real browser throws. operator-core imports them as DEFAULT
 * exports (`import Corestore from 'corestore'`, `import Hyperswarm from
 * 'hyperswarm'`, `import DHT from 'hyperdht'`, `import Hyperbee from
 * 'hyperbee'`, `import UDX from 'udx-native'`), so a single Proxy default
 * export covers the family; the Proxy is import/eval-safe (accessing a
 * property or the value never throws — only calling/constructing does).
 */

function serverOnly(): never {
  throw new Error(
    'P2P substrate networking (corestore/hyperswarm/hyperdht/sodium/udx) is ' +
      'server-only and cannot run in the operator-vite browser bundle',
  );
}

const trap: ProxyHandler<object> = {
  get(_t, prop) {
    if (prop === Symbol.toPrimitive || prop === 'toString') return () => '[substrate-browser-shim]';
    // Return the proxy itself for any nested property access so deep
    // `Pkg.foo.bar` references resolve during the scan without throwing.
    return substrateBrowserShim;
  },
  apply: serverOnly,
  construct: serverOnly,
};

const substrateBrowserShim: never = new Proxy(function substrateBrowserShim() {
  serverOnly();
}, trap) as never;

export default substrateBrowserShim;
