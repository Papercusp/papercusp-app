# A cheap repeating beat must not inherit a restart-sized retry budget
URL: /internal/docs/agent-insights/a-cheap-repeating-beat-must-not-inherit-a-restart-sized-retry-budget

The mcp-proxy's retry window exists to make a :3070 restart invisible — ~90s, ~30 attempts, correctly generous for a one-shot MCP handshake whose loss costs an agent its whole tool plane. But the classifier keyed on MCP BATCH SHAPE ('no tools/call' ⇒ idempotent ⇒ full window), and a plain REST liveness heartbeat has no tools/call either — so a beat that repeats every ~60s across ~140 agents silently inherited the budget sized for a rare catastrophe. Result: 97% of all proxy failures on one endpoint, 57 → 8,107 failures/hour in five hours, and a metastable storm whose own retries sustained the slowness that triggered them. The general shape: a retry budget sized by COST-OF-LOSS applied by a classifier that cannot see FREQUENCY. Also: why the fear of restarting the fix into place was itself wrong, and how measuring killed it.

## The shape, in one line

**A retry budget is sized by *cost of losing the request*. A classifier that routes requests
into that budget usually keys on *shape*. When a cheap, self-replacing, high-frequency
request happens to share a shape with a rare, expensive, one-shot one, it silently inherits
a budget sized for the catastrophe — and multiplies it by its own frequency.**

That is not a typo-class bug in either layer. Each layer was individually correct.

## The concrete instance

`mcp-proxy` sits in front of `:3070` so that a deploy restart is invisible to MCP clients.
Its `retryWindowMs` (\~90s, up to \~30 attempts) exists for exactly that: bridge a restart.

`prepareForward` classifies a request by **MCP batch shape**: a POST whose JSON body contains
no `tools/call` is `'idempotent'` — replaying it has no side effect, so it earns the full
window. That rule was written for the MCP control plane: `initialize` / `tools/list` / `ping`.
For those it is exactly right — a client fetches the tool catalog **once per session**, so
losing that one request costs a multi-hour agent its entire tool plane (WI-6740).

`/api/agent-mcp/console/bootstrap-su/heartbeat` is a plain REST liveness beat. It is **not an
MCP batch at all**. It contains no `tools/call` — so it fell through the same branch and
inherited the restart-sized window.

Its own handler had already made the opposite judgement, deliberately returning a **soft 503**
because "the launcher treats any failure as a missed beat, never an error loop". The proxy
could not see that intent, and turned each shrug into \~30 attempts over 27–42s (observed on
**successes**), with give-ups clustering at the full **\~90,000 ms** window.

### The numbers

| hour (UTC)      | proxy-forwarded failures |
| --------------- | ------------------------ |
| 18:00           | 57                       |
| 19:00           | 151                      |
| 20:00           | 3,175                    |
| 21:00           | 3,822                    |
| 22:00           | 5,647                    |
| 23:00 (partial) | 8,107                    |

**97%** of them were that one endpoint (13,330 of 13,754 in a 90-minute window). With \~140
agents beating every \~60s, transient upstream slowness was multiplied \~30× on the hottest
path in the system — and the amplified load **sustained the slowness that caused it**. That
is a textbook metastable failure: the trigger can pass while the storm keeps feeding itself.

Downstream, degraded beats aged presence out until the watchdog declared sessions **MCP-dark**,
each needing a manual `/mcp` in its terminal. 75 such declarations in the hour before the fix.

## The fix is at the classifier, and it is an ASYMMETRY

```ts
export const CHEAP_REPEATING_BEAT_PATHS: readonly string[] = [
  '/api/agent-mcp/console/bootstrap-su/heartbeat',
  '/api/admin/owner-presence/touch',
];

/** One prompt re-attempt, then give up and let the NEXT beat carry the signal. */
export const CHEAP_REPEATING_BEAT_RETRY_WINDOW_MS = 2000;

export function effectiveRetryWindowMs(url: string, windowMs: number): number {
  return isCheapRepeatingBeat(url) ? Math.min(CHEAP_REPEATING_BEAT_RETRY_WINDOW_MS, windowMs) : windowMs;
}
```

The asymmetry is the whole point, and it mirrors WI-6740's in the opposite direction:

* **Retry the one-shot handshake generously.** Losing it is session-fatal; replaying is free.
* **Retry a beat that repeats every \~60s barely at all.** Its replacement is *already on its
  way*, and replaying it is precisely what builds the storm.

Two things this fix deliberately is **not**:

* **Not a change to the endpoint's status code.** Making the endpoint lie (return 200 on a
  soft failure) to dodge the proxy's retry policy would hide a real signal to work around a
  classifier bug. Fix the classifier.
* **Not a global reduction of `retryWindowMs`.** That would re-break the restart-bridging the
  proxy exists for. The budget was never wrong — only its *application* to this class was.

## How to spot this class before it bites

Ask of any retry/timeout budget: **what event was this number sized for, and does everything
that reaches it occur at that event's frequency?**

* A budget sized for a **rare catastrophe** (a restart, a failover, a cold start) is dangerous
  the moment a **frequent** request can reach it.
* Multiply honestly: `budget × attempts × callers × frequency`. Here \~30 attempts × \~140 agents
  × once/60s is the entire bug, visible without any code reading.
* Beware classifiers keyed on **shape** (does the body contain X?) when the property that
  actually matters is **frequency** or **cost-of-loss**. Shape is a proxy for intent, and
  proxies drift — especially when a *new kind of caller* (here: plain REST, not MCP) starts
  passing through a classifier written for one protocol.
* **Cross-layer intent is invisible by default.** The endpoint's "treat me as best-effort"
  judgement lived in a comment in a different file. If a layer has an opinion about how its
  failures should be handled, that opinion has to be *expressible to the layer that retries*
  — a path list, a header, a class — or it will be silently overridden.

## The second lesson: the fear of deploying the fix was itself wrong

The proxy's entire value is its uptime — it exists to be the thing that never restarts. So
"restart the proxy to fix connection-darkening" reads as a fix whose delivery mechanism causes
the harm it prevents. That reasoning stalled the deploy for a full wake, and it was **wrong**.

What settled it was a **natural experiment already in the record**: the proxy had restarted
cleanly at 23:27:46Z. Checking what happened next —

* restart took **2 seconds** (Stopping → Started → listening);
* MCP-dark declarations that hour ran 19:02 (17), 19:07 (16), 19:12 (42), and then **zero**
  after the restart.

The mechanism explains it: dark-declaration requires `max(3 × loopInterval, 20 min)` of
presence staleness. A 2-second blip is **600× below** that threshold and cannot trip it. The
escalating darkening tracked the **storm**, not any restart.

So the correct reading inverted: **the storm darkens sessions; restarting does not.**
Withholding the fix was preserving the harm, not avoiding it.

> Before treating a shared-infrastructure action as too dangerous to take, check whether it has
> **already happened** recently and what actually followed. An hour of logs frequently contains
> the experiment you were about to reason about from first principles — and reasoning lost to
> the record four separate times on this one item.

Note also the deployment subtlety: `papercup-mcp-proxy.service` runs from the **integration
tree** (`WorkingDirectory=…/papercusp/apps/operator`, `exec npx tsx bin/mcp-proxy.ts`), so a
staging edit goes live on a plain `systemctl --user restart` — no green-checkpoint or `main`
promotion involved. It is deliberately "always-up infra that never restarts on a deploy",
which is exactly why, absent an explicit restart, it would have kept running pre-fix code
indefinitely. **There was no natural restart to wait for.**

## Verifying a fix like this honestly

The production failure rate went to zero immediately after the fix. That is *not* proof the
fix works: the upstream was also healthy at that moment (`:3070` answering in 1.8 ms), and a
storm only manifests under upstream slowness. Zero failures is equally consistent with "the
upstream happens to be fine".

Keep the evidence classes separate:

* **Proves the cap works** — a controlled test against a deliberately-refused upstream
  (`gives up on a refused upstream in ~2s instead of burning a 30s window`, 2006 ms).
* **Proves it did not backfire** — 0 new dark declarations, i.e. failing beats fast did not
  starve presence. (The real risk of this fix: beats that *used* to succeed after \~30s now
  fail. Safe here only because the 20-min dark threshold leaves \~20 beats of margin at \~60s
  cadence — that margin is a precondition, not a coincidence, and is worth re-checking if the
  beat interval or the threshold ever changes.)
* **Proves nothing on its own** — production quiet while the upstream is healthy.

The falsifying observation to watch for: a fresh burst of heartbeat records with `elapsedMs`
near 90,000 *after* the fix went live. That would mean the cap is not being applied.
