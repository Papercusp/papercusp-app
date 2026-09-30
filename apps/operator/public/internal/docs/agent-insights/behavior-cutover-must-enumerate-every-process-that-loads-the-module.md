# A behavior cutover isn't done when :3070 is fixed — enumerate EVERY process that loads the changed module
URL: /internal/docs/agent-insights/behavior-cutover-must-enumerate-every-process-that-loads-the-module

P-022 retired native /compact fleet-wide, but the long-lived standalone bg-host process (which loads the same compaction-watchdog module via dbos/bootstrap.ts) wasn't restarted by the deploy and kept enforcing pre-cutover behavior for ~13h, completely silently — the zero-invocation transcript audit can't see a stale ENFORCER, only stale enforced sessions. Fixed with a boot-time self-check (staleCutoversForProcessStart) plus a durable checklist for the next cutover (EI-16190).

## What

P-022 (WI-4998, "native `/compact` is retired") shipped, deployed, and *looked*
fully cut over: `:3070` restarted into the new code, every psu Claude child ran
with `DISABLE_COMPACT`, and the zero-invocation transcript audit
(`native-compaction-audit.ts`) found no `compact_boundary` rows in sessions
started after the cutover. Verdict: clean.

Except **`papercup-bg-host.service`** — a separate, long-lived process that also
loads `compaction-compliance-watchdog.ts` (via `dbos/bootstrap.ts`'s
`startCompactionComplianceWatchdog`) — had been running since **2026-07-17
22:26Z**, hours before the P-022 rewrite landed. A deploy restarts `:3070`; it
does **not** restart bg-host. So for \~13 hours, bg-host's watchdog kept
force-injecting the OLD `mode:'compact'` control message into live psu-pty
hosts. The current-code psu-pty-host had no handler for that stale mode
("Unknown command: `/compact`" from the CLI, since `DISABLE_COMPACT=1`), so
the inject silently no-op'd — the agent got a **false** "you were just
compacted" continuation banner while its context stayed exactly where it was.

## Why the existing audit couldn't catch this

The transcript audit is a **completion-criterion check on sessions**: it scans
Claude project transcripts for `compact_boundary` rows and asserts none exist
post-cutover. That is the right check for *"did any session actually
native-compact,"* but it has no visibility into *"is the enforcer itself
running current code."* A stale enforcer that fails safe (drops the write) or
fails silently (the psu-pty host of 2026-07-17) produces **zero** transcript
evidence either way — the audit reads "clean" while the enforcement mechanism
underneath it is broken. **Session-side auditing and enforcer-side freshness
are orthogonal; you need both.**

## The durable checklist for the *next* behavior cutover

Before declaring a behavior cutover complete, enumerate **every process** that
loads the changed module — not just the one a deploy restarts:

1. `rg` the import chain from the changed module outward. For anything reached
   through `dbos/bootstrap.ts`, that means every process that calls the shared
   bootstrap: `:3070` (`papercup-dev-api`), `:3170` (staging), AND standalone
   long-lived hosts like `papercup-bg-host.service` that boot the same
   bootstrap function outside the request-serving process.
2. Also check the gateway / embed-sidecar processes if the change touches
   anything they load — they're the same class of "deploy doesn't restart me"
   process as bg-host.
3. **Restart each one explicitly** as part of the cutover, don't assume the
   deploy pipeline covers it. `dev:restart { target: 'bg-host' }` is the tool
   for bg-host specifically.
4. If a genuinely-independent audit exists for the behavior being retired (like
   `native-compaction-audit.ts`), remember what it actually proves: session
   outcomes, not enforcer freshness. It cannot substitute for step 1–3.

## The added defense: a boot-time self-check on the enforcer itself

Since a human can forget step 1–3 for some future cutover the same way this one
was missed, `compaction-compliance-watchdog.ts` now self-checks at start:

* `WATCHDOG_BEHAVIOR_CUTOVERS` is a small registry of `{ id, atMs, note }` —
  one entry per known behavior cutover this watchdog's code must run at-or-after.
* `staleCutoversForProcessStart(processStartedAtMs, cutovers?)` is a pure,
  exported, unit-tested function: given this process's boot instant, it returns
  which known cutovers it *predates*.
* `startCompactionComplianceWatchdog()` computes its own boot instant
  (`Date.now() - process.uptime() * 1000`), logs a one-line version/boot stamp
  on every start (so a stale host is trivially greppable across every host's
  logs: `journalctl | grep 'compaction-watchdog] starting'`), and — if it
  predates any registered cutover — logs a loud `console.warn` AND raises a
  best-effort advisory coord escalation (deduped per process) naming the exact
  cutover it missed and telling the operator to restart it.

Add a new entry to `WATCHDOG_BEHAVIOR_CUTOVERS` for every future watchdog
behavior change so the *next* forgotten-process class self-flags at boot
instead of running silently for 13 hours until an owner notices garbled
context-usage behavior.

## Related: the psu-pty-host side already screams on a stale sender

`psu-pty-host.mjs`'s control-message handler treats an incoming `mode:'compact'`
as proof of a stale pre-P-022 sender (since no current code ever sends it) and
drops it **loudly** — an `appendHostEvent('retired-mode-dropped', …)` durable
row plus a `stderr` line naming EI-16190 and telling the operator to find and
restart the stale sender. That fix protects the *receiving* side (the psu-pty
host); the watchdog self-check above protects the *sending* side (bg-host)
from staying stale in the first place. Both matter: a receiver-side loud-drop
only helps if something is watching stderr/host-events; a sender-side boot
self-check surfaces the problem the moment the stale process starts, without
requiring the stale behavior to ever actually fire.

## TL;DR for the next agent

A deploy that restarts `:3070` is not the same as "every process that runs this
code got the fix." Grep the import chain for every long-lived standalone host
(bg-host, gateway, embed-sidecar) before declaring a cutover done, and restart
each one explicitly. A session-outcome audit (no native compact\_boundary rows)
proves sessions behaved — it does not prove the enforcer is current; you need
both an outcome audit and an enforcer freshness check.
