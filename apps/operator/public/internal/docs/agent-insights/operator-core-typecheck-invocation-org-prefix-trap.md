# Typechecking operator-core: the org-prefix trap, and the root script that avoids it
URL: /internal/docs/agent-insights/operator-core-typecheck-invocation-org-prefix-trap

Why `--workspace @papercupai/operator-core` fails with \"No workspaces found\", and the existing root script that means you never need the package name at all.

## The one-line answer

```bash
npm run typecheck:operator-core        # already exists at root — use this
```

You do **not** need to know operator-core's package name, and that is the whole point:
the root script already encodes it (`npm --workspace @papercusp/operator-core run typecheck --`).

## Why so many agents get "No workspaces found"

The org prefix is **not uniform in this repo**, and the root package is the misleading one:

| package                      | name                             |
| ---------------------------- | -------------------------------- |
| repo root                    | `@papercupai/papercusp-monorepo` |
| `apps/operator-docs`         | `@papercupai/operator-docs`      |
| **`packages/operator-core`** | **`@papercusp/operator-core`**   |

So the natural generalization — read `@papercupai/` off the root, apply it to operator-core —
produces `--workspace @papercupai/operator-core`, and npm answers:

```
npm error No workspaces found: --workspace=@papercupai/operator-core
```

This was filed **six independent times** in a single day
(EI-20258922077948119, EI-20249052224380386, EI-20232712447748201,
EI-20217000696016525, EI-20220734121650776, and the timeout sibling
EI-20225440369854094). Six agents each rediscovering the same naming
inconsistency is the cost this page exists to stop.

## This is a DIFFERENT failure from the one CLAUDE.md already warns about

CLAUDE.md warns against `npm run --workspace <dir> typecheck` because most workspaces
declare no such script, and it dead-ends with `npm error Missing script: "typecheck"`.
That guidance is correct and unrelated:

* **`Missing script`** — the workspace resolved, but has no `typecheck`. (operator-core *does* declare one.)
* **`No workspaces found`** — the workspace never resolved, because the *name* was wrong.

Reading the second as the first invites the wrong conclusion ("nothing to run here"),
which is the same false-clean trap that guidance already names — one level further out.

## Don't add another script

Reuse-first: the lever already exists. Root also ships the narrower legs
(`lint:tsc`, `lint:tsc:workspaces`, `lint:tsc:operator`, …); `lint:tsc` alone is
`tsc -p packages/operator-core/tsconfig.json`, i.e. operator-core only.

## Expect it to be slow, and don't read a timeout as clean

A full operator-core typecheck routinely exceeds short verification caps
(`build:typecheck` foreground-caps at 50s; see EI-20225440369854094). A timeout is
**not** a pass. Either scope it to your own files:

```
build:typecheck { project: 'packages/operator-core/tsconfig.json',
                  files: ['<your changed files>'], scopeToFiles: true }
```

(which compiles only your import graph — and correspondingly will **not** see errors your
change caused in files that do not import yours), or run it detached and read the result,
rather than piping a real run through `head`/`grep` — that truncates PATH-ORDERED output,
so your file can be silently absent and read as clean.
