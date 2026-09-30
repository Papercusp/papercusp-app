# Federation \"0 rows\" with healthy connections — check the WRITE's workspace_id before blaming the drain
URL: /internal/docs/agent-insights/federation-zero-rows-check-write-side-workspace-first

WI-5399: owner→member content probes read \"0 rows\" with swarm peer_connected healthy and ZERO [outbox-drain] lines. Three sessions chased pairing, zombie connections and hung drain promises; the bug was on the WRITE side — scenario helpers resolved workspace_id with an unordered LIMIT 1 over a table federation had grown, so writes were stamped with a workspace no drain scope selects. ⚠ Iteration 1's origin='local' fix was itself WRONG on joiner frames and was superseded by pot_home_slug scoping — read \"The fix\" before copying any predicate from an older revision.

## The trap

A federation leg fails with **owner→member content probes returning "0 rows"**
while everything that is easy to check looks healthy: swarm `peer_connected`
re-established on all topics, topic-gossip self-healing, repair-ladder /
forceRejoin firing normally, `content_bidir` green earlier in the SAME run.
The reflex diagnosis chain — DHT re-pairing → zombie connection → stalled
replication → hung outbox-drain promise — burned three sessions on WI-5399
(and this leg had been red on EVERY gate run, previously unowned as EI-13317).

**The decisive, cheap check nobody ran first:** look at the stuck rows
themselves.

```sql
SELECT key, workspace_id, drained_at
  FROM harness_shared.substrate_outbox
 WHERE harness_slug='<slug>' ORDER BY ts;
```

On gate run 184041 this showed a perfect split: every drained row
`ws=workspace-rig17e1fcff`, every stuck row `ws=papercusp-workspace`.
The drain pass selects `WHERE workspace_id = <handle boot workspace>`
(outbox-drain.ts) — a row stamped with any other workspace matches **no
drain's scope, ever**. No error fires because nothing is failing: the drain
truthfully sees zero rows for its scope. Restarts don't help (catch-up-on-start
scans the same scope). It looks exactly like a permanent, silent,
restart-surviving replication stall.

## Why the workspace flipped mid-run

The rig scenario write helpers resolved the workspace with an **unordered**
`COALESCE((SELECT workspace_id FROM harness_shared.pot_members LIMIT 1),'default')`
(D-050). That was fine while `pot_members` had only the frame's own rows. The
new federation legs (orders 55–57: fleet\_directory / seat\_offer /
spawn\_request) **federate IN foreign pot\_members cards** (`origin='remote'`,
`papercusp-workspace`, old fed\_ts) — after which the unordered `LIMIT 1` is a
4-row planner lottery. On 184041 it flipped between two writes 2 seconds apart
(WI-1 drained 23:03:39Z; F-RD-INIT stuck 23:03:41Z), right at the order-58→80
boundary — which is also why the failure correlated so convincingly (and so
misleadingly) with the member-offline step. Planner non-determinism also
explains the historical flakiness and run 171529's soak asymmetry (B→A
recovering in cycles 4–5 while A→B never did).

## The fix

> ⚠ **This section was rewritten 2026-08-11. Iteration 1 — which this doc
> previously presented as *the* fix — is WRONG on joiner frames. If you are
> reading an older revision, or copied `coalesce(origin,'local')='local'` out of
> one, use the ladder below instead.**

### Iteration 1 (2026-07-18, superseded)

```sql
-- ⛔ superseded: structurally never matches on a JOINER
COALESCE((SELECT workspace_id FROM harness_shared.pot_members
           WHERE coalesce(origin,'local')='local'
           ORDER BY joined_at LIMIT 1),'default')
```

It removed the lottery, so it looked correct, and it *is* correct on an OWNER
frame. But `origin` classifies **write provenance** (did THIS db insert the row
directly, vs receive it via federation-apply) — **not identity-ownership**. A
joiner's own membership row is authored by the OWNER and federates IN, so on a
joiner it is always `origin='remote'` and this predicate matches **zero rows**
(confirmed live on a failing joiner frame: 0 local, 4/4 remote, direct psql).
It then fell back to the literal `'default'` — reinstating the very D-050
silent-wrong-workspace bug it was written to remove.

### Iteration 2 (current) — scope by `pot_home_slug`, and FAIL LOUD

```sql
SELECT workspace_id FROM harness_shared.pot_members
 WHERE pot_home_slug='<the pot>' LIMIT 1;
```

`pot_home_slug` is part of the table's PK and there is one `workspace_id` per
pot on a given frame's DB, so it is uniform on **owner AND joiner** with no
origin asymmetry. The canonical resolver is `rig_resolve_ws()` in
`deb-hetzner-rig.sh`; helpers outside that family (no `RIG_HIVE_ID` in scope)
fall back to the origin heuristic, which is sound *for them* because they write
from the owner frame.

**Never fall back to a literal `'default'`.** Exhausting the ladder must print
`FATAL ... could not resolve a real workspace_id (D-050/WI-5399 class)` and
fail the probe. A loud failure costs one red leg; a silent wrong workspace costs
three sessions of replication-layer archaeology.

## The sweep missed one call site (found 2026-08-11)

`fed_plan_part_merge_assert` in `federation-asserts.sh` was **not** converted by
the iteration-2 sweep and kept *two* lottery rungs: an unordered
`harness_features_consolidated WHERE harness_slug=... LIMIT 1` (the same
coin-flip, one table over — that table holds federated-in foreign rows too), and
a `COALESCE` onto it instead of failing loud. Now on the same deterministic
ladder, with regression cases in `federation-asserts.selftest.sh`.

The general point: when you sweep a defect class across N call sites, the sweep
is only as good as the enumeration behind it. Enumerate by **what the code
does** (every site that resolves a workspace\_id) rather than by the pattern you
happen to grep for — the missed site here used a *different table*, so a grep
for `pot_members` could never have found it.

## The generalized lessons

1. **"0 rows federated" is a WRITE-side symptom until proven otherwise.**
   Before touching swarm/pairing/drain layers, SELECT the stuck outbox rows and
   compare their `workspace_id` (and `harness_slug`) against the drain scope
   the boot log prints (`[wire-presence] wired <ws>::<slug>`).
2. **Silence is evidence.** outbox-drain.ts logs loudly on every guarded
   failure (pass timeout WI-2009, quarantine WI-3896, SESSION\_CLOSED WI-3684,
   CONNECTION\_ENDED EI-13917). Zero `[outbox-drain]` lines during a
   multi-minute "stall" means the drain is NOT failing — stop investigating it.
3. **Never resolve a scope with an unordered `LIMIT 1`** on a table that
   federation (or any concurrent writer) can grow — it is deterministic right
   up until the day it isn't, and the failure lands somewhere else entirely.
4. **A column that sounds like ownership may encode provenance.** `origin`
   answers "who wrote this row into THIS database", not "whose row is this".
   Iteration 1 shipped because that distinction is invisible on the owner frame,
   where both readings agree — the asymmetry only appears on the joiner. Check a
   predicate on the side of the system where the two meanings diverge.
