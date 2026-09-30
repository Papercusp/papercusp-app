# A watchdog red-test can be a transient shared-node_modules race, not a regression
URL: /internal/docs/agent-insights/transient-red-test-shared-node-modules-npm-install-race

>-

## The symptom

`packages/operator-core/lib/endpoint-route/routes/transport/mcp-handler-poststream-leak.test.ts`
(the EI-127 leak-regression guard) fired a watchdog `red-test` signal — failed
3× in 6h, `expected +0 to be 20` (the per-request `McpServer.close()` count
stayed 0 instead of matching the 20 POSTs). That assertion only fails when
`node_modules/mcp-handler`'s `patch-package` patch
(`patches/mcp-handler+1.1.0.patch`, which adds the `finally` block closing the
per-request server + transport) is **not currently applied** — i.e. when
`node_modules/mcp-handler/dist/index.{js,mjs}` is the *unpatched* upstream
build.

## Root cause: this is a shared-tree race, not a code defect

This repo runs `npm install` from **one shared `node_modules`** used
concurrently by every fleet agent's test runs (per the git-sync-owned single
checkout model). `npm install` rewrites `node_modules/mcp-handler` from the
registry tarball (unpatched) and only re-applies
`patches/mcp-handler+1.1.0.patch` in the subsequent `postinstall` step
(`patch-package`, see the root `package.json` `postinstall` script). Between
those two steps there is a real window — however short — where
`node_modules/mcp-handler` is unpatched. Any test that happens to run in that
window (this test, or in principle any other test exercising the same
dependency) sees the pre-patch behavior and fails, **on an unmodified
codebase**.

Confirmed for EI-9686 by correlating timestamps: the watchdog's failure was
recorded at `2026-07-11T14:15:14Z`; `node_modules/mcp-handler/dist/index.mjs`'s
mtime was `2026-07-11 14:15:51 -04:00` (\~37s later — mid-reinstall at the time
of the failing run) and `node_modules/.package-lock.json`'s mtime was
`2026-07-11 14:22:30 -04:00` (a later install completing). Re-running the test
immediately (and 3× more) after the install settled passed cleanly every time,
with the patch confirmed present in both `dist/index.js` and `dist/index.mjs`.

### The race isn't specific to patched packages — any dynamic `import()` can hit it

`EI-9687` (`packages/operator-core/lib/inference-gateway/egress-probe.test.ts`)
fired the **same class** of watchdog red-test **one second later**
(`2026-07-11T14:15:15Z`) — different package, same underlying event. That test
doesn't touch a patched dependency at all: `probeEgress` → `fetchExitIp` →
`buildEgressDispatcher` does a real `await import('undici')` (the test only
injects `fetchImpl`/`reputationLookup`, not `importUndici`), so it hits
`node_modules/undici` directly off disk. A `npm install` mid-flight can leave
`node_modules/undici` in a half-written state for the same reason as above —
no patch-package step involved, just the install itself rewriting the
package's files while something else tries to `import()` from it. Re-ran 3×
clean once the install settled. **The generalized tell:** any red watchdog
signal on a test that touches real `node_modules` content (a patched package,
or a plain dynamic `import()` of a real dependency) occurring within the same
narrow window as another such failure is very likely ONE shared-tree npm
reinstall event, not N independent regressions — check them together before
investigating each in isolation.

## What to do when you hit this

1. **Don't assume a red watchdog test means the code regressed.** Re-run it
   locally first (`node_modules/.bin/vitest run --config
   packages/operator-core/vitest.config.ts <path>`), 2–3× if it's a dependency-patch
   guard like this one.
2. If it passes cleanly on re-run, check for a **concurrent `npm install`**
   around the failure timestamp: `stat -c '%y %n' node_modules/<pkg>/<file>
   node_modules/.package-lock.json` — a package file's mtime landing within a
   minute of the failure (and *after* it) is the tell.
3. Close as **transient / not a regression**, with the timestamp-correlation
   evidence — don't spend time bisecting commits for a change that never
   happened.

## What was built (EI-9724): a fail-fast guard for THIS test, not a fleet-wide install lock

EI-9724 proposed two options: (a) serialize `npm install` across the fleet via
a named resource lock, or (b) a `pretest` check that fails fast with an
unambiguous message instead of a misleading assertion diff. **(a) was not
built** — there is no single choke point through which every fleet agent's ad
hoc `npm install` invocations pass, so a lock around "the" install command
isn't enforceable without a behavior change from every agent; a single
transient occurrence didn't justify that scope.

**(b) was built**, scoped to the one test that hit this
(`mcp-handler-poststream-leak.test.ts`): a `beforeAll` reads
`node_modules/mcp-handler/dist/index.{js,mjs}` directly and checks for the
patch's landmark string (`"Error closing per-request POST server/transport"`,
from the `finally` block `patches/mcp-handler+1.1.0.patch` adds). If the
landmark is verifiably **absent**, the test now throws a message naming the
race explicitly ("this almost always means a concurrent `npm install` is
mid-reinstall … re-run after the install settles") instead of the confusing
`expected +0 to be 20`. If the package/dist can't be resolved at all (a real
"not installed" problem, not this race), the check is inert and the test body
runs as normal. This closes the diagnostic-ambiguity gap for this specific
test; it remains a per-test pattern to replicate on any other test that hits
this class of failure, not a repo-wide install-verification pass.
