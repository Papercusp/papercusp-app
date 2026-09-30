# \"Unresolved escalation in harness X\" phantoms: a stale/orphaned harness_escalations row, not a live problem
URL: /internal/docs/agent-insights/unresolved-escalation-phantom-orphaned-slug

The recurring auto-implement EI 'Unresolved escalation in harness X' is almost always a PHANTOM — a harness_shared.harness_escalations row whose escalation is set + supervisor_notes empty, while the underlying condition is long since resolved. The green-checkpoint-{stall,watchdog} variants self-clear via trackGateStall / green-stall-watchdog only when the row's harness_slug equals the LIVE install-slug; a row keyed under a DEAD/renamed slug (e.g. legacy 'papercup' after the papercup→papercusp rename, which has no live green-checkpoint routine) can never be matched by the clear. As of the EI-8396 fix, collectEscalationSignals now SUPPRESSES exactly those two green-checkpoint phases when the row's install-slug has no live green-checkpoint routine, so a dead-install orphan of those phases no longer loops forever. A stale row under any OTHER phase (or a same-slug row that just never got cleared) still re-fires the watchdog every tick. The drill: confirm the real condition is resolved via routines.gate_health, then clear the stale row (escalation=NULL + supervisor_notes) — do NOT try to 'fix' a green gate.

## The signal

The self-improvement loop dispatches an auto-implement worker on an EI titled
**"Unresolved escalation in harness `X`"** (watchdog source `unresolved-escalation`,
key `escalation:<harness>:<phase>`). It has recurred many times for the
`green-checkpoint-stall` phase: EI-7335 / 7447 / 7557 / 7569 / 7575 / 7690 (and the
`quartermaster*` siblings).

## What it actually means

`collectEscalationSignals` (watchdog.ts) fires for **every** row in
`harness_shared.harness_escalations` where `escalation <> '' AND supervisor_notes = ''`
— **except** the two green-checkpoint phases when the row's install-slug has no live
green-checkpoint routine (the EI-8396 dead-install guard, below). It is otherwise a
**presence** check on a durable row — it says nothing about whether the underlying
condition is still live. So a stale row that never got cleared re-fires the signal
**every tick**, re-dispatching a worker indefinitely on a problem that is already gone.

There are two green-checkpoint escalation phases, both keyed on the LIVE install-slug for
their clear (so both are covered by the dead-install guard):

* `green-checkpoint-stall` — written by `trackGateStall` (release-actions.ts,
  `GATE_STALL_PHASE`) when `main` is held red too long.
* `green-checkpoint-watchdog` — written by the standalone green-stall-watchdog.ts
  (`WATCHDOG_PHASE`, its own `watchdogAlerted` dedup flag).

The `green-checkpoint-stall` row is **cleared on the first green tick** by `trackGateStall`
(release-actions.ts) via:

```sql
UPDATE harness_shared.harness_escalations SET escalation = NULL, mtime_ms = $now
 WHERE harness_slug = ctx.installSlug AND phase = 'green-checkpoint-stall' AND escalation IS NOT NULL
```

The clear keys on `ctx.installSlug` — the **live** install running the green-checkpoint
routine. `green-checkpoint-watchdog` has a mirror clear in green-stall-watchdog.ts keyed the
same way.

## The orphaned-slug trap (EI-7690)

If the row's `harness_slug` is **not** the live install-slug, the clear can never match
it. This happens after an **install-slug rename**: legacy `papercup` (4 routines, **no**
`system:green-checkpoint`) vs the live `papercusp` (186 routines, has it). A
`green-checkpoint-stall` row keyed under `papercup` — whose escalation **body** correctly
says `harness_slug: papercusp` — is permanently orphaned: no routine runs as `papercup`, so
nothing ever clears it, and the watchdog re-fires forever.

`WI-2825` hardened the **same-slug** 0-row clear-miss (a loud `console.warn`,
`shouldWarnOnStallClearMiss`, when `gate_health.stallAlerted` is true but the clear matched
0 rows). It did not cover the different-slug/dead-install orphan — that gap was tracked as
**EI-8396**.

**EI-8396 is now fixed (current behavior, 2026-07):** `collectEscalationSignals` no longer
blindly re-fires a dead-install green-checkpoint orphan. Its query suppresses a row whose
`phase` is one of the two green-checkpoint phases when **no live green-checkpoint routine
exists for that row's install-slug**:

```sql
AND NOT (
  e.phase = ANY(ARRAY['green-checkpoint-stall','green-checkpoint-watchdog'])
  AND NOT EXISTS (
    SELECT 1 FROM harness_shared.routines r
     WHERE r.workspace_id = e.workspace_id
       AND r.install_slug  = e.harness_slug
       AND r.name = 'green-checkpoint'
       AND r.active
  )
)
```

So the `papercup`-orphan class (a green-checkpoint escalation under a dead/renamed slug with
no live `green-checkpoint` routine) is now **silently skipped** — it no longer re-dispatches a
worker forever. The guard is deliberately narrow: it only touches those two phases, and only
when the install-slug is genuinely dead; a same-slug row that just never got cleared, or a
stale row under any other phase, still re-fires and still needs the manual clear below.

## The drill (how to resolve one of these EIs)

1. **Don't try to "fix" the release gate.** Read the LIVE condition first:
   ```sql
   SELECT metadata->'gate_health', last_fired_at
     FROM harness_shared.routines
    WHERE workspace_id = '<ws>' AND install_slug = '<live-slug>' AND target_role = 'system:green-checkpoint';
   ```
   `consecutiveReds = 0`, `stallAlerted = false`, a recent `lastGreenAt` + `last_fired_at`
   ⇒ the stall is **resolved**; the escalation is a phantom.
2. **Check for a slug mismatch.** Compare the row's `harness_slug` column against the live
   install-slug and the escalation body's `harness_slug`. A dead/renamed slug (no matching
   `system:green-checkpoint` routine) is the orphan case.
3. **Clear the stale row** (the sanctioned remediation — same as every sibling EI): set
   `escalation = NULL` **and** write `supervisor_notes` documenting why. Either clause
   alone stops `collectEscalationSignals` from re-firing.
4. **Resolve the EI `fixed`** with the gate\_health evidence. This is a **state-only**
   cleanup — zero code lines change — so the contract's "evidence says it no longer
   exists = verified fix" path applies; there is no unit diff to test.
5. **For the two green-checkpoint phases, the durable fix already landed** (EI-8396):
   `collectEscalationSignals` now suppresses a dead-install orphan of those phases, so it
   should no longer recur from a renamed slug. If you still see a green-checkpoint phantom,
   the row's install-slug probably DOES have a live `green-checkpoint` routine (a same-slug
   clear-miss, not the dead-install case) — check for the `shouldWarnOnStallClearMiss`
   warning and clear the row manually. For any OTHER phase, a stale presence row still loops;
   the manual clear (step 3) is the remediation, and a per-phase durable clear on a protected
   surface is the real fix to file.

### The DISABLED-gate variant (EI-13114) — `gate_health` lies; read `pipeline_events`

A third same-slug flavor, distinct from both the dead-install orphan and the stuck-red
clear-miss: the green-checkpoint routine is **live AND present, but the gate is now DISABLED**.
A gated hive whose gate is later turned off (`resolveCheckpointRouting` → `routing.skip`,
`reason: gate_disabled`) makes `green-checkpoint` **return early BEFORE `trackGateStall` ever
runs** (release-actions.ts) — and `trackGateStall`'s green branch is the ONLY code that clears a
`green-checkpoint-stall` row. So an escalation that was OPEN when the gate went red **can never
self-clear**: the gate will never again produce a green verdict, and every run records
`skipped-disabled` instead. The EI-8396 guard does **not** save you — it only suppresses a
**missing** green-checkpoint routine, not a **present-but-disabled** one (the row's install-slug
still has a live, `active` `green-checkpoint` routine, so the guard's `NOT EXISTS` is false).

⚠ **`gate_health` is a trap here.** It stays frozen at the last real verdict — e.g. quartermaster-hive
showed `consecutiveReds: 26, lastGreenAt: null, stallAlerted: true`, which reads exactly like a
gate that is genuinely stuck red. It is NOT: a `skipped-disabled` run touches neither `gate_health`
nor the escalation. **The authoritative tell is `harness_shared.pipeline_events`**, not `gate_health`:

```sql
SELECT status, detail->>'reason' AS reason, created_at
  FROM harness_shared.pipeline_events
 WHERE workspace_id = '<ws>' AND install_slug = '<slug>' AND kind = 'green_checkpoint'
 ORDER BY created_at DESC LIMIT 5;
```

An unbroken run of `skipped-disabled` / `gate_disabled` ⇒ the gate is **off**, the stall is moot
(nothing to promote), and the escalation is a **permanent phantom**. Remediation is the same
manual clear (step 3 via the resolve route with `?phase=green-checkpoint-stall`) + resolve `fixed`;
the durable class-fix — *disabling a gate should clear its open stall escalation* — is a
protected-surface (release-machinery) change, filed as **EI-17065**, not auto-implemented.

## The `git-sync-watchdog` phase is different — it SELF-clears (verify, don't rush to manually clear)

The `git-sync-watchdog` phase (written by `git-sync-stall-watchdog.ts`, **not** a green-checkpoint
phase) is the recurring \*\*non-\*\*green-checkpoint flavor of this EI ("Unresolved escalation in
harness papercusp", key `escalation:papercusp:git-sync-watchdog` — e.g. EI-8665). Unlike the
green-checkpoint orphan, it is usually a **transient** git-sync stall (a DBOS executor-reaper fault
streak — `"produced no DBOS operation output; … cancelled the stuck fire and requeued"`) that has
**already recovered**. The git-sync-stall-watchdog has its OWN healthy-recovery branch
(`git-sync-stall-watchdog.ts` L395-431) that idempotently nulls the escalation + resets
`watchdog_alerted`/`wd_error_sweeps` on its next healthy sweep — so unlike the "any OTHER phase"
rows above, step 3's **manual clear is often unnecessary**: the row self-clears within one \~15-min
sweep. The improvement-watchdog simply filed the EI **inside that recovery window**, before the
git-sync-stall-watchdog's own clear ran.

Verify recovery, then resolve `fixed` (no manual clear needed if already null):

1. `harness_shared.routines` (`install_slug=papercusp, name=git-sync,
   workspace_id=papercusp-workspace`), `metadata`: `last_status='synced'`, `reaped_count < 3`
   (`persistentReapMin`), `watchdog_alerted=false`, `wd_error_sweeps=0`. ⚠ `last_error` is
   **NOISY** — git-sync nulls/sets it per tick; it is not a liveness signal, ignore it.
2. `harness_shared.harness_escalations` `phase='git-sync-watchdog'` → `escalation IS NULL`
   ⇒ the watchdog already cleared it and the condition is gone; resolve `fixed`. If it is
   **still set** while the metadata above is healthy, the watchdog just hasn't swept yet — you
   may clear it manually (step 3) to stop re-firing, but do **not** also reset `watchdog_alerted`
   unless the watchdog is confirmed dead (it owns that flag; leaving it stuck `true` masks the
   next real stall).
3. **The durable root-cause class** (intermittent DBOS routine-fire reaps, \~1 commit/40min under
   load) is a **protected surface** (DBOS executor + git-sync) tracked separately as **WI-1415**
   (owner-escalated) — do NOT auto-fix it, and clearing the transient escalation does not mask it.
   A separate idea to debounce the improvement-watchdog's redundant recovery-window dispatch is
   filed as **EI-8671** (touches the self-improvement loop, so human-gated).

### The persistentReap variant does NOT self-clear — it's the git-sync-watchdog orphan trap (EI-8614)

The "self-clears within one sweep" story above assumes the stall **recovered**. It does **not** hold
when the verdict stays `stalled` because of `persistentReap` (`reaped_count ≥ 3`) or a frozen HEAD on
a **semi-dead / low-traffic pot** whose git-sync is permanently wedged by WI-1415 (e.g. `oddsmith`,
2026-07-08: `reaped_count=44`, `wd_error_sweeps=74`, no successful sync in \~16h). Here
`evaluateGitSyncStall` keeps returning `stalled=true`, so the git-sync-stall-watchdog's healthy branch
(the self-clear) **never runs**, and its alarm is one-shot (`if (watchdogAlerted) continue`) — so the
row sits `escalation<>'' , supervisor_notes=''` **forever** and `collectEscalationSignals` re-dispatches
an auto-implement worker **every tick** (EI-8614 reached dispatch attempt 3). This is the exact
orphan-loop the EI-8396 guard fixed for the two green-checkpoint phases — but **git-sync-watchdog has
no such guard** (that gap is EI-8671, human-gated).

Distinguishing it from the recovery-window phantom: check `metadata.reaped_count`/`wd_error_sweeps`
and `last_synced_at`. If the metadata is genuinely **unhealthy** (not the "healthy, just hasn't swept"
case in step 2), the row will not self-clear — do the **manual clear (step 3)** with a `supervisor_notes`
that points at WI-1415, and resolve `fixed`. Leave `watchdog_alerted` alone so a genuine future
transition re-alarms. This is a state-only cleanup on a protected root cause (WI-1415) that a worker
cannot fix; clearing the ledger row does not mask it because WI-1415 is the authoritative tracker.
⚠ The sanctioned write path is `POST /api/harness/:slug/escalation/resolve?phase=git-sync-watchdog`
(`{ response, action:'clear' }`, `auth:'loopback'`) — it **appends** `supervisor_notes` and bumps
`mtime_ms`, so probing it writes real rows (and a bumped mtime pulls the row into the escalation-spike
6h window until you `clear` it). A non-project harness like `oddsmith` still resolves through this route.

⚠⚠ **You MUST pass `?phase=<the row's phase>` or the clear silently no-ops the row the collector
reads (EI-8788).** The resolve route (`supervisor-actions.ts`) appends `supervisor_notes` to the
**disk** `supervisor-notes.md` + the un-phased PG text-artifact **unconditionally**, but its
`UPDATE harness_shared.harness_escalations` is scoped to `phase = (requestedPhase ?? 'staging')`.
So if you call `.../escalation/resolve` **without** `?phase=git-sync-watchdog` (or with a wrong
phase), the disk notes ARE written — and `harness:escalation` (disk-backed) then shows your
resolution — while the PG `harness_escalations` row the improvement-watchdog's
`collectEscalationSignals` actually reads is **never touched**: `escalation` stays set,
`supervisor_notes` stays `''`, and it re-fires next tick. This is exactly how EI-8787 "resolved"
`shared-pot-test`/`git-sync-watchdog` yet it immediately re-dispatched as EI-8788. **Always verify
the fix on the PG row, not the disk view:** `SELECT COALESCE(escalation,'')<>'' AS has_esc,
COALESCE(supervisor_notes,'')<>'' AS has_notes FROM harness_shared.harness_escalations WHERE
workspace_id = '<ws>' AND harness_slug=... AND phase=...` — a resolved row must show `has_esc=false` (cleared) and/or
`has_notes=true`; if `harness:escalation` shows notes but the PG row still has `has_esc=true,
has_notes=false`, your resolve missed the phase.

## The `mcp-dark-int:su-<uuid>` phase — a self-clearing recovery-window phantom (EI-12934 / EI-12059)

A third recurring flavor of this EI, key `escalation:papercusp:mcp-dark-int:su-<uuid>` (phase
`mcp-dark-int:su-<uuid>`), is written by the **mcp-dark-watchdog INTERACTIVE sweep**
(`mcp-dark-watchdog.ts` `notifyInteractiveDark`, `INTERACTIVE_PHASE_PREFIX = 'mcp-dark-int:'`)
when a live interactive `psu` session's tool-call-coupled presence beat goes stale (its MCP
transport appears severed). Like the `git-sync-watchdog` case, it **self-clears**: the same
watchdog's recovery sweep (`checkInteractiveMcpDark`, \~L642-653) idempotently nulls the escalation
on its next pass for any owner **no longer in the dark set** — either the session recovered (a fresh
beat) OR **ended entirely** (dropped out of the live-hosts list; that end-of-session sweep is the
2026-07-14 durability follow-up that fixed EI-12059/su-39f079d3). The improvement-watchdog simply
filed the EI **inside that window**, before the recovery sweep ran. (You will typically see several
stale `.papercusp/state/escalations/mcp-dark-int_su-*.md` disk mirrors — those are the recovered
rows' disk side; the PG row is the authority.)

The drill is the same "verify recovery, no manual clear needed if already null" path as
git-sync-watchdog:

1. **The PG row already shows `has_esc=false`** (escalation IS NULL) for that phase — the recovery
   sweep cleared it. Verify:
   ```sql
   SELECT COALESCE(escalation,'')<>'' AS has_esc, COALESCE(supervisor_notes,'')<>'' AS has_notes
     FROM harness_shared.harness_escalations
    WHERE workspace_id = '<ws>' AND phase = 'mcp-dark-int:su-<uuid>';
   ```
2. **Confirm the session is genuinely gone** (not still dark): `su-<uuid>` has **no**
   `harness_shared.coord_presence` row and **no** `harness_shared.spawned_agents` row.
   `collectEscalationSignals` gates on `COALESCE(e.escalation,'') <> ''`, so a NULL row is never
   selected → it cannot re-dispatch.
3. **Resolve `fixed`** with that evidence (state-only, zero code diff). Do **not** try to "reconnect"
   anything — the transport-death condition is long gone.
4. **The durable class-fix** — debouncing `collectEscalationSignals` so it does not file inside the
   mcp-dark recovery window — touches the **self-improvement loop's own code** (a protected surface),
   and is the same debounce already filed as **EI-8671** (human-gated). Do NOT auto-fix it.

## The `github-bridge` phase — a self-clearing recovery-window phantom on a bridged hive (EI-18150552284724662)

A fourth recurring flavor, key `escalation:<hive>:github-bridge` (phase `github-bridge`, e.g.
`escalation:oddsmith-hive:github-bridge`), is written by the **GitHub-bridge divergence policy**
(`recordDivergenceVerdict` in `sync/pot-git/github-divergence.ts`, `GITHUB_BRIDGE_ESCALATION_PHASE =
'github-bridge'`) when a bridged hive's managed repo diverges from its GitHub origin (origin is never
force-pushed — divergence is REPORTED-not-applied). Like `git-sync-watchdog` and `mcp-dark-int`, it
**self-clears**: the very next **clean** bridge pass classifies `action: 'clear'` and nulls the row —

```sql
UPDATE harness_shared.harness_escalations SET escalation = NULL, mtime_ms = $now
 WHERE harness_slug = $hive AND phase = 'github-bridge'
   AND escalation IS NOT NULL AND (escalation::jsonb ->> 'kind') = 'github-bridge-divergence'
```

The improvement-watchdog simply filed the EI **inside that window** — after the diverging tick wrote
the row and before the next clean tick cleared it. (Observed 2026-07-20: `oddsmith-hive`/`github-bridge`
row written \~04:15, EI captured 04:15:15, row cleared 04:23:20; the collector then returned 0 rows.)

The drill is the same "verify recovery, no manual clear needed if already null" path as git-sync-watchdog /
mcp-dark-int:

1. **Verify the PG row is already NULL** for that phase (the clean pass cleared it):
   ```sql
   SELECT COALESCE(escalation,'')<>'' AS has_esc, length(coalesce(escalation,'')) AS esc_len, mtime_ms
     FROM harness_shared.harness_escalations
    WHERE workspace_id = '<ws>' AND harness_slug = '<hive>' AND phase = 'github-bridge';
   ```
   `has_esc = false` (esc\_len 0) with an `mtime_ms` **after** the EI's `createdAt` ⇒ a clean bridge tick
   cleared it. `collectEscalationSignals` gates on `COALESCE(e.escalation,'') <> ''`, so a NULL row is
   never selected → it cannot re-dispatch. Reproducing the collector's own condition returns 0 rows —
   that IS the verification for this state-only fix.
2. **Resolve `fixed`** with that evidence (state-only, zero code diff). Do **not** try to "fix" the
   GitHub bridge or force any push — divergence is deliberately reported-not-applied (S-4), and it
   already cleared.
3. **The durable class-fix** is the same debounce-`collectEscalationSignals`-against-a-self-clear-window
   idea already filed as **EI-8671** (human-gated, touches the self-improvement loop). Do NOT auto-fix it.
