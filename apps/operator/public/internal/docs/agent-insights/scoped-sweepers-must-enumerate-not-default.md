# A background sweeper that defaults to `?? DEFAULT_WORKSPACE_ID` silently covers nothing
URL: /internal/docs/agent-insights/scoped-sweepers-must-enumerate-not-default

A recurring class, seen at least 4 times: a sweeper/watchdog resolves its scope as `opts.workspaceId ?? DEFAULT_WORKSPACE_ID`, no caller ever passes the option, and the sweep silently iterates an empty/irrelevant workspace while reporting a clean pass.

## The shape

A background component (a watchdog, a sweeper, a boot-time registration loop)
resolves its scope as:

```ts
const workspaceId = opts.workspaceId ?? DEFAULT_WORKSPACE_ID;
```

No caller ever passes `opts.workspaceId` — boot paths forward empty opts.
`DEFAULT_WORKSPACE_ID` is the literal `'default'`, which on a real install is a
near-empty scratch workspace holding a handful of unrelated pots. Every real
pot lives in the actual named workspace (e.g. `papercusp-workspace`). The
component therefore iterates an empty/irrelevant set and returns a
**success-shaped result**: zero items processed, no error, no warning. Nothing
distinguishes *"covered everything, all healthy"* from *"covered nothing"* —
this is the SCOPE-specific variant of the absorbing-state / Shape-D family in
[absorbing-state-guards-and-self-report-detectors](/agent-insights/absorbing-state-guards-and-self-report-detectors);
that doc covers the general "detector aimed at an empty set reports clean
forever" shape, this one is specifically about how the empty set gets chosen.

## Why `DEFAULT_WORKSPACE_ID` is the trap, not a safety net

`?? DEFAULT_WORKSPACE_ID` *reads* like a safe fallback — the same shape as any
other `?? someDefault`. But on a multi-workspace install it is a silent **scope
error**: the fallback value is a real, valid workspace id, so nothing throws,
nothing logs, and every downstream read/write succeeds against the wrong (or
empty) partition. The failure mode is always "quietly does nothing", never
"throws" — which is precisely why it survives in production for months: unit
tests inject an explicit `workspaceId` (the one path that's covered), so the
untested path is exactly the one that ships broken.

## Known instances (4, all independently found and fixed)

1. **WI-5791** — `checkOriginFreshness` (`origin-freshness-watchdog.ts`)
   returned `checked: 0` on every sweep since it shipped (WI-5607). The
   watchdog whose entire job is detecting a silently-stalled git egress was
   itself silently stalled for its whole life: it could never write
   `of_origin_sha`, never age a tip, never fire `tipAgeStale`. Verified live:
   `of_origin_sha` NULL on all 21 git-sync routine rows fleet-wide.
2. **EI-10103** — the sibling main-behind-staging watchdog: an unresolved
   workspace made its escalation INSERT set `workspace_id: NULL` explicitly
   (bypassing the column's own DEFAULT, which only applies when a column is
   *omitted*), violating a NOT NULL constraint — silently swallowed by the
   function's own outer `catch`. The watchdog that should escalate a
   promotion stall could never write its escalation.
3. **`agent-tools/plans/revisions.ts`** — `?? DEFAULT_WORKSPACE_ID` read the
   *wrong* workspace's plan-revision spine (and, after a later data move, an
   empty one).
4. **`apps/operator/bin/host-bootstrap.ts`'s stall-waker** — looped over
   every registry workspace but called a **module-singleton** loop-starter
   inside the loop, so only the LAST call won — the loop ended up bound to
   whichever workspace happened to be first/last in the registry, and a
   `'default'`-bound `capacityBack` couldn't find any real account (they live
   in the other workspaces' pools), so its unknown-account fallback waived
   the availability check entirely.

All four are fixed today. This doc exists so the *pattern* survives past the
four fixes — the next sweeper someone writes is instance 5.

## The fix, in order of leverage

### 1. The lint already exists — use it, don't rebuild it

`scripts/check-scope-defaults.mjs` (D-003,
`workspace-data-isolation-leaks-2026-06-17` P-007) already flags `?? 'default'`
/ `?? DEFAULT_WORKSPACE_ID` / `?? 'operator'` (and the `operatorHomeHarnessSlug()`
function-call form) whenever the immediate left-hand identifier names a
workspace/harness/hive/scope value. It is **advisory** (`npm run
lint:scope-defaults` reports; `--strict` exits 1), not part of the green gate
yet. It is a **regex-based heuristic over `??`/`||`** — it cannot catch every
shape. Instance 4 above (a loop silently bound to the wrong iteration via a
singleton) has no `??`/`||` at all and would NOT have been caught by this
lint; it can only be caught by reading the code. Don't assume "the lint is
clean" means "no scope bug here."

### 2. Enumerate, don't default — and prefer the ALREADY-canonical policy

If your background job needs to decide **which workspaces to cover**, that
question already has a canonical, reused answer:
**`backgroundWorkspaceIds()`** (`workspace-registry.ts`) — the policy already
shared by the DBOS dispatcher, the await-event sweeper, and the pot wake-rule
boot registration. It resolves, in order: a `PAPERCUSP_WORKSPACE_ID` process
pin → every registered workspace under the shared-operator model → the single
active workspace (dev/legacy). **Reach for this before writing a new
enumeration query** — `origin-freshness-watchdog.ts`'s own private
`listRegistryWorkspaceIds(sql)` is a narrower, DB-specific need (only
workspaces that own a `harness_registry` row with a bridged pot) and is a
reasonable exception, not a second pattern to copy; a generic "which
workspaces exist" sweeper should use `backgroundWorkspaceIds()`, not
hand-roll a query or default to `'default'`.

### 3. Self-report zero-coverage

Even with the scope resolved correctly, a sweep that legitimately has nothing
to do (a fresh install, no bridged pots yet) looks identical, on the wire, to
a sweep that silently covered nothing due to a bug. `checkOriginFreshness`'s
fix models the guard: a cheap independent query (`countBridgedPots`) asks "was
there work to cover?", and the result carries a `blind: true` flag when the
sweep processed zero units **while work existed** — distinct from a
legitimate `checked: 0` on an install with nothing to check. **Silence must
never read as health.** Add this self-check to any sweeper whose "processed
zero" and "all healthy" results are otherwise indistinguishable.

## Where NOT to look for the fix

Don't reach for `DEFAULT_WORKSPACE_ID`'s own doc comment as a defense — its
role is CLIENT-side (a browser tab with no workspace header yet), and the
comment now says so explicitly, with a pointer back to this file. The literal
string `'default'` will keep looking like a harmless fallback in every future
`??` you write; it is not, for anything server-side that iterates workspaces.
