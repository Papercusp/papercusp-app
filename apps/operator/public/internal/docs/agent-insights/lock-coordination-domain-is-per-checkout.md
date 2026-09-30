# A lock coordination domain is a property of the READER, not of the lock — so every domain-scoped diagnostic read is silently checkout-dependent
URL: /internal/docs/agent-insights/lock-coordination-domain-is-per-checkout

lockCoordinationDomain() resolves to the repo root of whichever process resolved it (import.meta.url). This box runs THREE operators from TWO different checkouts (:3070 from papercup-release, :3170/:3270 from the staging tree), so the same query returns different rows depending on which port served it — and returns them as an EMPTY result, not an error. That is how the agent dossier's LOCKS section reported every agent as holding no locks while 100% of live lock rows sat in another domain (WI-5979). Enforcement reads are legitimately domain-scoped; any observability read that is scoped is a bug. This class has now recurred four times.

## The one-line takeaway

`lockCoordinationDomain()` answers *"which repo root is the code asking this question
loaded from?"* — **not** *"which files does this lock protect?"* Scope an
**enforcement** read by it (correct: two checkouts are two genuinely different
files). Scope an **observability** read by it and you have written a bug that
reports *nothing found* instead of failing.

## Why this bites specifically here

The domain is derived from `import.meta.url`, so it is a property of the **process**.
This box runs three operators from **two different checkouts**:

| port    | checkout                                      | domain it computes                         |
| ------- | --------------------------------------------- | ------------------------------------------ |
| `:3070` | `papercup-release`                            | `/…/papercupai-workspace/papercup-release` |
| `:3170` | staging tree                                  | `/…/papercupai-workspace/papercusp`        |
| `:3270` | staging tree (spawned by the Tauri dev shell) | `/…/papercupai-workspace/papercusp`        |

`papercup` is a **symlink** to `papercusp`, and the domain is `realpathSync`'d, so
the staging domain is always the `papercusp` spelling.

Now add the acquisition path: the file-lock hook posts to a hardcoded
`${PAPERCUSP_OPERATOR_URL:-http://localhost:3070}`. So **every** agent's lock is
recorded under the *release* root — a tree nobody edits — while the files being
protected live in the staging tree. Measured live 2026-07-26:

```
agent_file_locks   GROUP BY coordination_domain
  /…/papercup-release   1 live lock
  (staging root)        0

agent_lock_waiters GROUP BY coordination_domain
  /…/papercup-release   10 rows
  (staging root)        0
```

Locking still *works*, but only because every acquirer funnels through one port.
Correctness rests on a routing coincidence, not on the domain naming the files.

## The failure is an empty result, not an error

This is the part that costs hours. `readQueue` filters
`WHERE coordination_domain = $1`. A reader in the wrong domain gets **zero rows**,
which is a perfectly valid answer to a well-formed query. Nothing throws, so:

* `AgentLocks.error` stays `null`
* the UI renders its ordinary empty state — *"No locks held or waiting."*
* that is **indistinguishable** from a genuinely lock-free agent

In WI-5979 the agent dossier's LOCKS section had been doing exactly this: served
from the Tauri desktop's `:3270`, it scoped to the staging domain, matched none of
the release-domain rows, and confidently reported every agent as holding no locks.
No screenshot or amount of UI inspection would explain it — the bug is in what the
query was *scoped to*, and the symptom is an absence.

> **Debugging heuristic.** When a panel renders empty, establish what the read was
> scoped to *before* you believe the emptiness. An empty set from a scoped query is
> the single most common way this codebase lies to you quietly.

## The fix pattern for a diagnostic read

`QueueParams.coordinationDomain` accepts `null` = read **every** domain. Use it for
any per-agent/observability read:

```ts
// Diagnostic: "what is this agent holding?" — owner is a globally-unique ownerId,
// so the domain filter buys no correctness, only the cross-checkout bug.
const queue = await readQueue(sql, { coordinationDomain: null });
```

Two obligations come with a cross-domain read:

1. **Attribute within a domain.** Every row carries `coordination_domain`. The same
   repo-relative path in two checkouts is two different physical files, so matching
   a waiter to a blocker must compare the domain too — otherwise you invent
   blockers that do not exist.
2. **Partition your window functions.** `ahead_count`'s `ROW_NUMBER()` needs
   `PARTITION BY coordination_domain`, or a waiter inherits a queue position from an
   unrelated checkout. (No-op while single-domain; required once unfiltered.)

Do **not** "fix" this with a try-domains-in-order fallback: it is fragile and
picks the wrong answer whenever both trees have rows.

## Four recurrences of one root cause

Each was fixed pointwise for its own family, which is why it keeps coming back:

| # | surface                                           | ref                  |
| - | ------------------------------------------------- | -------------------- |
| 1 | `release-deploy` host-global resource, cross-tree | EI-18674647773291145 |
| 2 | `git-sync:<slug>` workspace-scoped resource       | WI-5960              |
| 3 | the dossier LOCKS **diagnostic read**             | WI-5979              |
| 4 | the file-lock **enforcement** path — still open   | WI-5987              |

`coordination-domain.ts` already exposes the branch helpers
(`hostGlobalLockDomain`, `workspaceScopedLockDomain`, `resourceLockDomain`,
`candidateResourceLockDomains`). **Read that file before keying anything new on a
domain** — the branch you need probably exists.

## Two adjacent traps that wasted time in the same session

* **`dev:pg_query` cannot see the lock tables.** They live in a *separate database*
  (`papercusp_su`); `dev:pg_query` hits the operator `papercusp` DB and returns
  `relation "agent_file_locks" does not exist`, which reads like a wrong table name.
  Query them with `psql` on a live operator's `DATABASE_URL` with the database name
  swapped to `papercusp_su`.
* **A server-side fix is invisible until the right host restarts.** The Hono host
  has no file-watch, so after landing a fix like this the desktop's `:3270` is still
  running the old code. A verifier who opens the dossier will "confirm" the bug
  persists. Check `ss -tlnp | grep :3270` → `ps -o lstart= -p <pid>` against your
  edit time before judging. (See also the port-topology note: the owner's window
  drives `:3270`, not `:3070`.)
