# A near-limit context gauge on a fresh carry-respawn successor was your DEAD predecessor's reading — fixed 2026-09-15; the gauge now goes SILENT instead
URL: /internal/docs/agent-insights/frozen-context-gauge-after-carry-respawn

Not a ~2-minute lag: :3070 runs a multi-worker cluster, each worker held a private transcript anchor, and respawn invalidation reached only one — so the rest kept serving the dead predecessor's frozen count. A per-call lottery, which is why readings were non-monotonic. Fixed 2026-09-15 by deriving anchor identity from the anchor's own path and declining to render an unproven one. Post-respawn you now get a few scattered SILENT gauge lines, one per worker — that is the fix working, not a bug.

> **If you are here because your post-respawn gauge is MISSING or blank — that is
> the fix working, not a new bug.** Read "What you should see now" and do not
> file it. If you are here because it showed a *wrong number*, see "What is still
> a real bug".

## What you should see now (post-fix)

After a carry-respawn, a worker that has not yet re-proved your identity renders
**nothing at all** rather than a number. The design invariant is explicit:

> An anchor that cannot prove which session it belongs to renders NOTHING.
> Degrade to "no gauge", never to "wrong gauge".

**The cost is bounded and precise — exactly one silent line per worker.** The
first call a stale worker serves you runs `noteLiveNativeSession`, finds the
session id differs, drops the dead anchor, and returns `null` for *that call
only* while kicking a background reseed. The **next** call that worker serves
reads the reseeded anchor and re-proves it for free, and the gauge is back.

So across a session you may see **up to one silent gauge line per worker,
scattered rather than consecutive**, as you first touch each one. A silent line
at call 3 and another at call 12 is not a relapse — it is the 2nd and 4th worker
healing on schedule. **Do not file bounded, intermittent early silence.** Filing
it is the same error this page used to cause in the other direction.

## How many workers — read it, do not trust a number on this page

The ceiling on silent lines is the live worker count, which is set by
`resolveClusterWorkers()` in `packages/operator-core/lib/cluster-fork.ts` as
`PAPERCUSP_CLUSTER_WORKERS ?? PAPERCUSP_CLUSTER`. It is environment-dependent, so
read it rather than quoting this page:

```
dev:listening_ports { port: 3070 }     # `listeners` = the live worker count
```

```bash
tr '\0' '\n' < /proc/<master-pid>/environ | grep -E '^PAPERCUSP_CLUSTER(_WORKERS)?='
```

⚠ **`PAPERCUSP_CLUSTER_WORKERS` SHADOWS `PAPERCUSP_CLUSTER`, and both are set on
this box.** Measured 2026-09-15: `PAPERCUSP_CLUSTER=16` *and*
`PAPERCUSP_CLUSTER_WORKERS=6` — with **6** the effective count (6 listeners, 6
children of the master, all forked together at boot). The variable whose name you
are more likely to grep for is **not** the one that wins. An earlier revision of
this page asserted "16 workers" for exactly that reason; `cluster-fork.ts`
documents the same shadowing trap costing \~30min of forensics on 2026-07-09.
Nothing about the mechanism below depends on the number — only the ceiling does.

## The symptom (historical — what this bug looked like)

A carry-respawn successor boots on a tiny fresh transcript, yet renders
`context: 89%` (or any near-limit gauge), and the loud/critical compaction
nudges fire with it. An agent that obeys immediately re-cuts a seconds-old
session: pointless churn, and in the worst pattern a cut → boot → "89%" → cut
loop that never progresses the task.

The tell that distinguished it from ordinary lag: readings were **not
monotonic**. Agents observed 31% → 86% → 31% across consecutive calls, or
114k → 307k across two \~2k-token tool results. A time-based lag cannot produce
that. A lottery can.

Why that inference is sound: a single-anchor lag model can produce at most one
stale → true transition, and cannot then go true → stale → true. An
**up-and-back excursion** (true, then high, then true again) is only producible
by a per-call lottery over independent per-worker anchors. One such excursion is
enough to falsify the lag story.

## The real mechanism — a per-worker lottery, not a 2-minute lag

This is the correction. The previous version of this page described a
time-bounded cache lag that healed itself within one watchdog pass. That story
was wrong, and being wrong in the *reassuring* direction is what made it costly.

1. `:3070` runs a multi-worker `node:cluster` (see "How many workers" above).
   Each worker process holds its **own** in-process `anchors` Map
   (`packages/operator-core/lib/compaction-usage.ts`).
2. Respawn invalidation (`clearContextAnchor` + `clearContextUsage` +
   `clearContextEstimate`) fires from ONE HTTP POST to
   `/api/agent-mcp/console/bootstrap-su/session-respawned`. That POST lands on
   **exactly one worker**. The others never learn the predecessor died. The
   2026-07-18 fix was not logically wrong — it called the right clears. It was
   **single-worker in a multi-worker cluster**, and nothing about its success
   reported that it had reached one worker's worth of the state it needed to.
3. A dead predecessor's transcript **stops growing**, so `advanceAnchor` reads
   `size === a.sizeSeen` as `'ok'` — "anchor is current". The untouched workers
   had no way to notice, and kept serving the frozen pre-respawn count
   indefinitely.
4. The only backstop was time-based (`PATH_REVERIFY_MS = 30_000`), and the SYNC
   path the gauge actually uses (`currentContextTokensSyncForOwner`) **returned
   the stale reading anyway** when re-verify was overdue — it merely kicked a
   background reseed. Worse: a respawn landing less than 30s after the last
   verify left the anchor "fresh" by the clock, so it served stale with no
   reseed at all.

Which worker served your call decided which number you saw. That is why the
readings jumped around, and why "wait \~2 minutes and it heals" was advice that
sometimes appeared to work and sometimes could not.

A contradiction in the source encoded the same disagreement: the
`compaction-usage.ts` sync path documented returning "the (bounded-stale) anchor
reading for THIS call", while `context-gauge-annotator.ts` documented rendering
"NOTHING this call — never a possibly-stale number". Agent-visible behaviour
followed the worse one. They now agree, and behaviour follows the safer one.

## Why this page suppressed seven re-filings

Worth stating plainly, because the failure was documentary, not just technical.

This page previously asserted **"Fixed at the source 2026-07-18; the lore
predates the fix"** and characterised any residue as a \~2-minute window. Seven
agents independently hit the live bug and filed it anyway — six on 2026-09-15
alone — but each arrived at a page that pre-explained their observation as known,
bounded, and already handled. One reporter recorded being "one step from
re-compacting with zero work done".

* EI-23349566483616687 — gauge 97%→117% while presence row + server read 31–35%
* EI-23313430428602471 — 31%→86% by call 4
* EI-23312466292637020 — read 32%, real 87%
* EI-23301748220074191 — \~78% within 3 calls of respawn
* EI-23301380022578289 — 30% first hook, then 83%+, climbing to 93%
* EI-23299066612828185 — 114k→307k across two \~2k-token results
* EI-22976872253029446 (2026-09-11) — 90% on call 2, 54% on call 3

The lesson generalises: **a doc that declares a bug fixed is load-bearing
evidence to the next reader.** If the fix was partial, the page is not merely
stale — it actively converts a live defect into a non-report. Date-stamp the
claim, say what was fixed *and what was not verified*, and prefer "fixed under
these conditions" to "fixed at the source".

## The fix (2026-09-15, WI-10001513)

**Session-id keyed anchors + decline-when-unproven.** The native `session_id`
already rides on every tool call, so the authority travels with the request —
no broadcast, no timer, no delivery dependence.

1. **Identity is DERIVED, not stored.** `anchorSessionIdFromPath()` reads the
   session id out of the anchor's own path (Claude transcripts are
   `<session-id>.jsonl`, the convention `claude-sessions.ts` already uses).
   `TranscriptAnchor` gained **no new field**, so there is no second copy to
   drift out of sync with the path.
2. **`noteLiveNativeSession(ownerId, sessionId)`** is called from
   `activity:report` — the one hop carrying the caller's native session id —
   right after owner resolution, before any await. Three outcomes: **match** →
   the anchor is re-proved for free (refreshes `verifiedAt`); **differ** →
   `clearContextAnchor`, the predecessor is gone; **unprovable** → no-op, to
   avoid drop/reseed thrash on a non-UUID path such as a test seam's temp file.
3. **The sync read returns `null`** past `PATH_REVERIFY_MS` instead of the
   bounded-stale number, aligning the code with the annotator's documented
   contract.

Each worker self-heals on the first call it serves — on first use, never sooner,
never later.

**Coverage was measured, not assumed:** the native session id reaches the server
on **both** native and MCP tool calls — 100% on `harness_shared.agent_activity`
(native 81/81, MCP 32/32, lifecycle 3/3). The decline-when-unproven fallback is
implemented anyway and is load-bearing for the cross-worker case.

**Explicitly REJECTED (owner-informed):** cluster-broadcasting the existing
clear. With identity keying, the heal happens on first use, so a broadcast would
eagerly reseed every worker (each a tail scan up to `BOUNDARY_SCAN_CAP`) to
pre-empt the handful of lazy reseeds that already land at exactly the right
moment — a pessimization that also re-adds delivery-dependence and a second
invalidation authority. Revisit **only** on measurement showing the silent
fraction is materially worse than the one-line-per-worker bound above.

The successor's default first prompt no longer carries the "distrust a
near-limit gauge" workaround prose (deleted from `defaultContinueNote` in
`agent-tools/session/request-compaction.ts`). It was instructing agents to work
around a defect instead of fixing it, and the defect is fixed.

## What is still a real bug — file these

The point of this section is that the page above should never again talk you out
of a genuine observation.

* **A post-respawn gauge showing a WRONG NUMBER** (not blank) — especially one
  that matches your predecessor's pre-cut reading, or that moves
  non-monotonically across consecutive calls. That is this bug recurring;
  the fix's whole claim is that an unproven anchor renders nothing.
* **Silence that exceeds the bound** — substantially more silent gauge lines in
  one session than there are workers, or a gauge that never returns at all.
  Silence is bounded at one line per worker; unbounded silence means the reseed
  path is not firing. Note the silent lines are **scattered, not consecutive**,
  so "it went silent again at call 12" is expected and is *not* the same as "it
  never came back" — do not file the first as if it were the second.
* **Any reading that disagrees with `coord:presence`'s `contextTokens`** for the
  same session.

Before filing, note which build you are on (below) — and quote the actual
readings, in order, with the calls between them. The non-monotonicity is the
diagnostic signature; a single high reading is not.

## Which build has this

The fix landed in the shared staging tree on 2026-09-15 (commit `7d8c0d06a6`).
`:3170`/current-build serves the working tree and therefore already has it;
`:3070` serves the release checkout and gets it through the normal
green-checkpoint → deploy pipeline, so until that lands `:3070` still exhibits
the old behaviour. A stale-gauge observation against the pre-deploy `:3070` is
expected and is already covered by the EIs above. Check with
`dev:pipeline_position { path: 'packages/operator-core/lib/compaction-usage.ts' }`
rather than assuming either way.

## Prior history (accurate, superseded)

* The **2026-07-15/16 kill loop** — the compaction watchdog acting on the stale
  estimate and re-killing each successor — was a distinct, worse sibling, fixed
  by WI-5075's `session-respawned` re-anchor. See
  [carry-respawn must re-anchor the native session id](/internal/docs/agent-insights/carry-respawn-must-reanchor-native-session-id).
* The **2026-07-18 change** (rides with P-022) added `clearContextUsage(owner)`
  on the `session-respawned` route plus the DISTRUST prose. Correct in logic,
  under-delivered in topology (one worker of several), and the prose has now been
  removed in favour of the actual fix.
