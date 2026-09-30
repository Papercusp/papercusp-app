# Burning down undeclared workspace dep edges
URL: /internal/docs/agent-insights/burning-down-undeclared-workspace-dep-edges

How to shrink check-workspace-deps-complete's BASELINE to empty — why a declared dependency cycle is harmless here, how to split dev-only from production deps, why you never needed a quiet box, and why widening this graph can silently SUPPRESS a guard.

`scripts/check-workspace-deps-complete.mjs` holds a shrink-to-empty `BASELINE` of
`importer->imported` edges: places where a workspace imports `@papercusp/*` without declaring
it. Each entry is a consumer that `scripts/affected-tests.mjs` cannot see, so a change to the
imported package does **not** select the importer's tests. That is a latent version of the
2026-08-09 incident where the fleet gate sat frozen \~2h20m.

This page is the method. It was written after taking the BASELINE from **58 to 5**
(EI-20026978310669562) and finished when the last 5 were closed and the BASELINE reached
**empty** (WI-37624, 2026-08-10). Every warning below is something that actually fired.

## Take the denominator from the guard, never from a grep

The guard prints its offender set as JSON with `--list`. Parse **that**.

A hand-rolled `@papercusp/[a-z0-9-]+->@papercusp/[a-z0-9-]+` regex returns **57** where the
guard says **58**. The missing edge is `@papercup/marketplace-public-ui->@papercusp/test-config`
— a *different scope*, `@papercup` with no "s". Same form-blind class as the module-singleton
detector described in `CLAUDE.md`: the measurement matched a spelling instead of the thing.

## A cycle is HARMLESS here — never let one block a declaration

⚠ **This section used to say the opposite**, and that is why 2 of the last 5 edges sat filed as
un-fixable "design questions" for a day. The claim was that declaring `operator-core -> agent-mcp`
closes a loop and so needs an import refactor first. Measured 2026-08-10 (WI-37624), a cycle costs
**nothing** to either consumer of this graph:

* **`affected-tests.mjs` terminates.** Its reverse-dep walk is a BFS with a visited set
  (`if (!affected.has(d)) { affected.add(d); queue.push(d); }`), so a cycle cannot loop or overrun.
* **npm resolves cyclic *workspace* deps by symlinking.** `npm install --package-lock-only`
  accepted the direct 2-cycle **and** the 3-hop cycle below — exit 0, `doctor:deps` clean after.

The decisive point: **the IMPORT cycle already exists in the code.** Leaving the dependency
undeclared never prevented a cycle, it only hid one — while *also* hiding the consumer from the
affected-test walk, which is the very defect this guard exists to catch. Declaring it makes the
graph honest and strictly improves routing.

So **detect cycles to KNOW your graph, never to gate a declaration.** Incremental detection is
still the right technique for knowing, because checking each edge against the **original** graph is
blind to a cycle that a batch closes with itself:

```
operator-core -> plugin-loader      (being added)     ─┐
plugin-loader -> agent-mcp          (being added)      ├─ together: a 3-hop cycle
agent-mcp     -> operator-core      (already declared) ─┘
```

Mutate the graph as you accept, so every later check sees the edges already taken in the same batch
— the non-incremental check saw 1 cycle, the incremental one saw 2. Then report the cycle as a
design observation worth someone's attention, and declare the edge anyway.

## Decide `dependencies` vs `devDependencies` from the IMPORTING FILE

The guard deliberately skips `*.test.ts` / `*.spec.ts` (see `importsInWorkspace`) because
test-only imports do not gate the reverse-dep walk. A consequence that is easy to miss: a
**dev-time config** import is not a test file, so it survives the filter and appears in the
guard's output looking exactly like a production import.

Of 53 edges, 13 were `@papercusp/test-config` imported from nothing but that package's own
`vitest.config.ts`. Declaring all 53 as `dependencies` stripped `"dev": true` from \~200
`package-lock.json` entries — i.e. it promoted a pile of dev-only tooling into production
installs.

Classify **per edge**, from the files that actually import it. `test-config` is never a
production dep; `testing-shell` genuinely is one (real source and UI import it), so you cannot
decide this by package name either.

## You do not need a quiet box — use `--package-lock-only`

The item this work came from advised batching edges and waiting for a quiet window, because
`npm run install:safe` rewrites `node_modules/.bin` under every concurrent agent's in-flight
vitest run. That caution is real for a normal install and **does not apply here**:

* Every edge target is *already* symlinked into root `node_modules` (verified: 0 of 35 missing).
  These declarations change bookkeeping, not what is on disk.
* So `node scripts/npm-install-safe.mjs install --package-lock-only` regenerates the lock
  **without writing `node_modules` at all**. No peer's test run is disturbed.

Two wakes were deferred waiting for a calm box that was never required.

### The desync window is smaller than it looks

Between editing `package.json` and regenerating the lock, the two disagree and `npm ci` fails.
Worth knowing exactly who is exposed:

* **`green-checkpoint` does not run `npm ci` anywhere** — the fleet-freezing local gate is not
  sensitive to this at all.
* Only `.github/workflows/*.yml` runs `npm ci --legacy-peer-deps`.

Keep the window tight by doing the edit and the regeneration in **one** command, and hold
`git-sync:papercusp` if you can get it. Do not block on that lock: it is `advisory`, git-sync
takes it for its own sweeps, and `wait: { max_drain_sec }` only drains *shared* holders, so it
will not block behind git-sync's exclusive hold.

## Verify with a FALSIFIABLE routing probe

"The importer now appears in `--print-affected`" is **not** evidence. Many importers are already
reachable through some other path, so that check can pass without your edge doing anything.

Compare against the before-graph:

```bash
INTRO=$(git log --format=%H -S'@papercusp/lexicon' -- packages/operator-core/package.json | head -1)
# build the declared-dep graph at $INTRO~1 and at HEAD, then test reachability in both
```

Measured across four sample probes, three went `UNREACHABLE -> REACHABLE`
(`operator-core->lexicon`, `operator-core->backup`, `operator-vite->ui-primitives`) — but
`web->p2p-voice` was **already reachable**, so that one probe would have "confirmed" success
while proving nothing.

⚠ **Limit worth stating rather than glossing:** submodule packages (`test-config`,
`testing-shell`, `libs/generic/sync`) have no `package.json` in the *superproject* at any ref,
so a `git show`-based before/after computation is silent about them. That is a gap in the
verification, not a pass.

## The last 5 — closed, and BOTH stated blockers were FALSE

The BASELINE is now **empty** (WI-37624, 2026-08-10). The 5 edges that had been filed as
structurally un-fixable were closed simply by *measuring* the two reasons they were filed under.
Both were wrong. Both are recorded here because each is plausible enough to be re-derived by the
next reader:

| the claim                                                                                                                                        | what measurement showed                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `operator-core->agent-mcp` and `plugin-loader->agent-mcp` are true cycles, so this is a design question rather than a declaration                | A cycle is harmless — see the section above. Declared as ordinary `dependencies`; npm exit 0, the walk terminates, routing improved.                                                                                             |
| `operator-core->file-claim`, `operator-core->sse`, `operator-vite->sse` target a non-root workspace, so `"*"` cannot resolve and `npm ci` breaks | **Falsified by the tree itself**: `"@papercusp/sse": "*"` was ALREADY in use by 5 packages (`flags`, `agent-chat`, `tooldef-http`, `sync`, `desktop-ipc`), and `file-claim` by 2 (`orchestrator`, `locks`). One grep settles it. |

The 3 non-root-target edges were declared with `file:` specifiers anyway — **not** because `"*"`
fails, but to match what `apps/operator` and `packages/agent-mcp` already use for those exact
targets (checklist rule 4).

⚠ A third error rode along in the same filing: it placed `plugin-loader` at
`libs/generic/plugin-loader`, which would have made the edge a generic-independence violation and
sent the fix somewhere entirely wrong. `@papercusp/plugin-loader` is **`packages/plugin-loader`**;
`libs/generic/plugin-loader` is a *different* package, `@papercusp/plugin-loader-core`. **Resolve a
package name to a directory with a command, never from its basename** — same family as the
recycled unit-name/pid traps in `CLAUDE.md`.

## Widening this graph can SUPPRESS behaviour — diff BOTH directions

The regression that followed the 58 -> 5 burn-down (EI-20026978310669562): declaring deps ON
`operator-core` made `libs/papercusp/**` changes pull it into the affected set, and
`affected-tests.mjs` attached repo-wide invariant guards only when their owning workspace was
**not otherwise affected** — so those guards silently stopped attaching.

A graph change has two directions, and it is natural to measure only the one you want. Whenever you
make X reachable, ask **what was guarded by "X is not in the set"**:

```bash
# per representative changed path, captured BEFORE and again AFTER the declarations
node scripts/affected-tests.mjs --changed-paths "<path>" --dry
```

Diff for **lost** tasks, not only gained ones. For the WI-37624 batch this surfaced 3 suppressed
guard tasks, and they turned out to be fine — each declares a `hostSuiteRatchet` into
`operator-core`, whose `:: test` task was gained in the same diff, so the invariant still runs.
"Suppressed" is not automatically "broken", but it always needs explaining before you ship.

## Checklist

1. `--list` → parse the guard's JSON. Do not re-derive with a regex.
2. **Do NOT drop an edge for a non-root-workspace target.** Declare it with a
   `file:../../…` specifier (`"*"` also resolves in practice — see above).
3. Cycle-check **incrementally**, mutating the graph as you accept — to KNOW, not to gate.
   A cycle is not a reason to withhold a declaration.
4. Match each importer's dominant spec style (`"*"` vs `file:../../…`).
5. Split `dependencies` / `devDependencies` by the importing file.
6. Resolve every package name to a directory with a command; never trust a basename.
7. Edit + `install --package-lock-only` in one command; verify **both** dep maps mirror the lock.
   Use `npm run install:safe -- install --package-lock-only` — a bare `npm install` is gate-blocked
   on this shared tree.
8. `npm run doctor:deps` — every declared dep must resolve on disk.
9. Falsifiable before/after reachability probe, diffed in **both** directions (gained *and* lost).
10. Shrink `BASELINE` in the same change, and document any edge you leave behind.
11. Re-run the guard's own tests. A guard whose backlog can reach zero must not have tests that
    assert `offenders.length > 0` — that shape passes only while the debt exists and goes red on
    the fix. `check-workspace-deps-complete-target-scope.test.ts` had exactly that bug; it is now
    hermetic (builds a temp fixture, takes an optional `root`).
