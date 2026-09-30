/**
 * Browser shim for the server-only `ssh2` + `cpu-features` native addons —
 * the last unshimmed member of the "native dep reachable through the route-tree
 * import graph" family (see the `postgres`, `@dbos-inc/dbos-sdk`, and substrate
 * shims alongside this one).
 *
 * Chain: `testcontainers` (integration-test infra) → `dockerode` /
 * `ssh-remote-port-forward` → **`ssh2`** → **`cpu-features`**. `ssh2` and
 * `cpu-features` each `require()` a native `.node` binary at module scope
 * (`ssh2/lib/protocol/crypto/build/Release/sshcrypto.node`,
 * `cpu-features/build/Release/cpufeatures.node`). Rolldown must RESOLVE the
 * whole transitive graph during its scan even though testcontainers is
 * tree-shaken out of the final SPA — and it HARD-FAILS on those `.node` files
 * ("stream did not contain valid UTF-8"), which failed the operator-vite SPA
 * build and froze every deploy at green-checkpoint (WI-2817 rollout blocker).
 *
 * The browser never runs Docker/SSH test-container code (the SPA only talks to
 * the local API), so — same contract as the sibling shims — the value is
 * import/eval-safe (property access returns the proxy) and only throws if
 * something actually calls/constructs it, which never happens in the SPA.
 *
 * Only the two NATIVE-addon packages are shimmed; the pure-JS `testcontainers`
 * / `dockerode` / `docker-modem` above them externalize cleanly on their own.
 */

function serverOnly(): never {
  throw new Error(
    'ssh2 / cpu-features (testcontainers test-infra) are server-only and ' +
      'cannot run in the operator-vite browser bundle',
  );
}

const trap: ProxyHandler<object> = {
  get(_t, prop) {
    if (prop === Symbol.toPrimitive || prop === 'toString') return () => '[testcontainers-native-browser-shim]';
    // Any nested access resolves back to the proxy so deep `Pkg.foo.bar`
    // references resolve during the scan without throwing.
    return testcontainersNativeShim;
  },
  apply: serverOnly,
  construct: serverOnly,
};

const testcontainersNativeShim: never = new Proxy(function testcontainersNativeShim() {
  serverOnly();
}, trap) as never;

export default testcontainersNativeShim;
