# "Setup failed" on a fresh clone — a renamed `.gitmodules` URL pointed at a non-existent repo
URL: /internal/docs/agent-insights/setup-wizard-submodule-url-mismatch

THE root cause of the owner's recurring 'Setting up Papercusp workspace failed': the papercup→papercusp identity rename overreached into .gitmodules and rewrote two submodule URLs (libs/papercusp-db, libs/papercusp-shared) to Papercusp/papercusp-db.git / papercusp-shared.git — repos that were NEVER renamed on GitHub (404). Every FRESH dogfood clone then failed submodule init; the dev box was immune (its .git/config kept the correct papercup-* URLs). Fix: restore the URLs to papercup-db.git/papercup-shared.git + a gitmodules-invariants test that fails CI if a submodule URL goes stale again.

import { Aside } from '@astrojs/starlight/components';

The deterministic root cause of the owner's repeated "Setting up Papercusp
workspace failed" — **not** GitHub, **not** the network, **not** git/PATH/auth
(those were red herrings / secondary robustness gaps chased first).

## What broke

The papercup→papercusp identity migration (owner-directed 2026-06-20) ran a
blanket `papercup`→`papercusp` rename that **overreached into `.gitmodules`**
and rewrote two submodule URLs:

| path                    | URL after the bad rename (404)   | real repo                       |
| ----------------------- | -------------------------------- | ------------------------------- |
| `libs/papercusp-db`     | `Papercusp/papercusp-db.git`     | `Papercusp/papercup-db.git`     |
| `libs/papercusp-shared` | `Papercusp/papercusp-shared.git` | `Papercusp/papercup-shared.git` |

The submodule **paths** were correctly renamed on disk, but the GitHub **repos**
were never renamed — they still answer only at their `papercup-*` names. So the
rewritten URLs 404.

These are **load-bearing source** submodules (34+ active imports of
`@papercusp/db-org` `getOrgPg` and `@papercusp/papercusp-shared`), not retired —
so `git submodule update --init` fails, the dogfood bootstrap reports an error
row, and the wizard shows a bare "setup failed".

## Why only fresh clones — and why it was so hard to see

The dev box (and any checkout that existed *before* the bad edit) was **immune**:
its `.git/config` / `.git/modules/<path>/config` already cached the correct
`papercup-*` URLs, and `git submodule update` reads those, not `.gitmodules`,
once a submodule is initialized. Only a **fresh `git clone`** (exactly the
dogfood first-boot path on the owner's Mac/Mac-VM) reads `.gitmodules` to seed
the remotes — so the breakage was invisible to every developer and reproduced
only on a brand-new machine. `git submodule sync` is what copies `.gitmodules`
URLs into `.git/config`; running it on a stale checkout is also how you'd
*propagate* the bug.

## The fix

1. Restore the two URLs in `.gitmodules` to `papercup-db.git` /
   `papercup-shared.git` (git-sync pushes it → every future fresh clone works).
2. On an already-broken clone: edit its `.gitmodules`, `git submodule sync
   libs/papercusp-db libs/papercusp-shared`, then re-run the bootstrap (the
   operator's `POST /api/desktop/bootstrap-pot/start`, which runs in the GUI
   process that holds the keychain creds — an SSH shell can't reach the
   GUI-bound osxkeychain).

After the URL fix + `git submodule sync`, triggering the operator's own
bootstrap drove `uninitialized` submodules 2 → 0 in \~10s; `git submodule status`
then showed `libs/papercusp-db (heads/main)` and `libs/papercusp-shared`
checked out cleanly.

## Recurrence guards (a detector failure too)

* **`gitmodules-invariants.test.ts`** parses the committed `.gitmodules` and
  fails the build if any submodule URL matches the known-dead `papercusp-db` /
  `papercusp-shared` names, if the two load-bearing submodules don't point at
  their real `papercup-*` repos, or if any URL is not an `https`
  `github.com/Papercusp/*.git` URL. A blanket rename can't silently re-break it.
* **`bootstrap-papercusp-pot.ts`** now logs *which* submodule failed and the
  git stderr tail on a non-zero exit (`fatal:` / `Repository not found` / …)
  instead of a bare `exited 128` — the missing diagnostic that cost a full live
  debugging round.

## Lesson

A repo-wide identity rename must **exclude remote URLs** (`.gitmodules`,
`.git/config` remotes, `package.json` repository fields, CI clone URLs) unless
the remote was *actually* renamed on the host. Renaming a local path ≠ renaming
the upstream repo. When a "setup failed" reproduces only on a fresh machine,
suspect a clone-time-only input (`.gitmodules`, lockfile registries, bundled
tool paths) before blaming the network.
