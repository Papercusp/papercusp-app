# npm says \"up to date\" but the dep is not on disk — check this before you suspect a code bug
URL: /internal/docs/agent-insights/npm-says-up-to-date-but-the-dep-is-not-on-disk

Concurrent installs on the shared tree can leave npm's reify bookkeeping believing a declared dependency is resolved while the tarball was never extracted. Run `npm run doctor:deps` first; the misdiagnosis costs hours.

## The symptom, and why it lies to you

A build, gate, or test fails with something that reads like a code bug:

* Rolldown / Vite: `failed to resolve <pkg>`
* Node: `Cannot find module '<pkg>'` / a bare `ERR_MODULE_NOT_FOUND`
* a gate test red in a package you did not touch

You check `package.json` — the package **is** declared. You check
`package-lock.json` — it **is** there, resolved, with an integrity hash. You run
`npm install` — it prints **`up to date`** and exits **0**. Everything says the
dependency exists. It is not on disk.

That combination is not a code bug and not flakiness. It is npm's **reify
bookkeeping** believing the package is already resolved: `node_modules/.package-lock.json`
is NEWER than `package-lock.json`, so npm concludes there is nothing to do — while the
tarball was never actually extracted into `node_modules`.

## What causes it here

Concurrent `npm install` runs against the same `node_modules`. On this fleet many
agents cold-wake and independently run an install to unblock their own work; two
overlapping reify passes can leave the bookkeeping ahead of the disk. Observed twice
in one night (EI-18666853411437489): a mac-VM build where a scoped install left
`@restart` / `@papercusp` un-extracted after "up to date in 19s", and the local
staging tree where 8 declared `mem0ai` peers (`@azure/identity`, `@google/genai`,
`@langchain/core`, `@mistralai/mistralai`, `@qdrant/js-client-rest`,
`@supabase/supabase-js`, `cloudflare`, `groq-sdk`) were declared + locked but absent
from disk, blocking a gate.

The expensive part is never the fix — it is the **misdiagnosis**. The failure surfaces
10+ minutes later, in a different subsystem, as a confusing unrelated error. Two agents
independently went looking for a code bug first.

## Diagnose it in 0.2 seconds

```bash
npm run doctor:deps           # every workspace
npm run doctor:deps -- --workspace=apps/operator
```

`scripts/check-declared-deps-extracted.mjs` checks that every **directly-declared**
`dependencies` entry of every workspace actually resolves on disk (the workspace's own
`node_modules`, then each ancestor up to the repo root — the way Node and Rolldown
resolve). Over the whole tree that is \~94 workspaces in \~0.15s.

* `DECLARED_DEPS_OK` ⇒ your missing-module error is a **real** code/config problem;
  keep looking.
* `DECLARED_DEPS_UNEXTRACTED` ⇒ stop debugging the code. Run
  `npm run install:safe -- install --legacy-peer-deps`.

## Fix it, and don't create it again

Never run a bare `npm install` / `npm ci` on the shared tree. Always:

```bash
npm run install:safe                                  # plain install
npm run install:safe -- install --legacy-peer-deps    # the repair shape
```

`scripts/npm-install-safe.mjs` does two things a bare install does not:

1. **Serializes** the install across every agent process on the host via a filesystem
   mutex (`scripts/lib/fs-mutex.mjs`, keyed on the repo root's real path) — so a second
   agent's install cannot interleave with yours (EI-18662389554660036).
2. **Verifies** afterwards, still holding the lock: it runs the same declared-deps check,
   repairs **once** with a full `npm install --legacy-peer-deps` if anything is missing,
   re-verifies, and otherwise **fails loudly** rather than returning success over a
   half-installed tree. `PAPERCUSP_SKIP_DEP_VERIFY=1` opts out.

So the corruption surfaces at the install that caused it, not in someone else's build.

## Why the check is deliberately narrow

It checks only what a workspace **directly declares** in `dependencies` — not
`npm ls --all`. Under `--legacy-peer-deps`, `npm ls` reports every unmet non-optional
**peer** dependency the same way, including transitive peers of test-only packages
nothing imports. That is not a hypothetical: an earlier version of this guard failed a
build on `@nestjs/core`, a peer of a test package that never reached the bundle graph.
Directly-declared deps are the exact shape of the real bug, without inheriting every
third-party package's peer graph.

It also **retries** (3 attempts, 2s apart, tunable via `--attempts` / `--delay-ms`). A
miss seen immediately after an install can be a filesystem-sync race — one that clears on
retry is the race and is not reported; one that persists across every attempt is real
(WI-5769 retry8, where failing on the first check turned a \~3s race into a wasted 15–30min
universal-arch rebuild).

## Related

* `papercusp-desktop/bin/build-desktop-sidecar.sh` carries its own inline copy of this
  detector for the mac-VM build (where it was first proven). A follow-up can point it at
  the shared module.
* Test-run symptoms of a *concurrent* install (`vitest: not found`, a bare
  `ERR_MODULE_NOT_FOUND` into `node_modules`) are the sibling failure —
  `npm run test:file` prints a `TEST_FILE_MID_INSTALL_SUSPECTED` hint for those.
