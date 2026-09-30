# Bare \"fetch failed\" spawn failures = loopback retry swallowing undici UND_ERR_* codes during restarts
URL: /internal/docs/agent-insights/bare-fetch-failed-spawns-are-loopback-undici-codes

A mug/spawn that fails with a contentless `fetch failed` (null output_tail, parent_role=operator) is NOT credential exhaustion (that classifies as 'auth') — it is the operator's loopbackFetch to its OWN invoke route failing during a deploy restart. loopbackFetch retries transient errors, but isTransientNetworkError early-returned false on undici's UND_ERR_SOCKET/UND_ERR_CONNECT_TIMEOUT codes (a server-closed socket mid-request), so no retry → bare 'fetch failed'. Fix: recognize UND_ERR_* connection codes + fall through to the message heuristic, and record the cause code via describeFetchError so the watchdog sample is self-diagnosing.

## The mistake this prevents

A `failed-spawn` watchdog signal fires "Agent spawns are failing repeatedly
(network)" with a sample of bare **`fetch failed`** (EI-390). The tempting read
on a box that just hit its weekly OAuth limit is "credential exhaustion" — and
you close it as a dup. **Wrong.** Credential failures (401/403) classify as
`auth`, a *different* watchdog key. A `network`-class `fetch failed` is a
distinct, real bug.

## What it actually is

Trace the rows (`harness_shared.spawned_agents WHERE status='failed'`): the
`network` class is exclusively `child_role=mug`, `parent_role=operator`
autonomous launches with **null `output_tail`** — they fail *before the child
runs*, and span before AND after any credential event. That points at the
**launch fetch itself**, not the LLM call.

Path: `launch-blueprint.ts` fires the mug launch via
`loopbackFetch(url, POST)` to the operator's **own** `/invoke` route, and its
`.catch` records `status='failed', errorMessage=e.message`. So these are the
operator's loopback POST to itself failing during a **restart/deploy window**
(release `:3070` redeploys every ≤15min; the autoloop fires the mug hourly).

`loopback-fetch.ts` *already* retries transient network errors (400/800/1200ms)
to ride over the no-hot-reload restart — but the classifier had a gap:

```ts
const code = cause?.code;
if (code) { return /^E(CONNREFUSED|CONNRESET|NOTFOUND|TIMEDOUT|NETWORK)$/.test(code); } // early-returns false
```

When a server closes a connection **mid-request** (graceful shutdown), undici
does not surface a clean `ECONNREFUSED`. It throws `TypeError: fetch failed`
whose `.cause` is a `SocketError`/timeout with a **`UND_ERR_*`** code
(`UND_ERR_SOCKET` = "other side closed", `UND_ERR_CONNECT_TIMEOUT`, …). Those
carry a `cause.code`, so the early `return` fired **`false` → no retry → bare
`fetch failed`**. The message-regex backstop was never reached.

## The fix (landed 2026-06-13, su-f127046c)

In `packages/operator-core/lib/loopback-fetch.ts`:

1. `isTransientNetworkError` also treats undici connection/timeout codes
   (`UND_ERR_SOCKET|CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT`) as transient,
   and on an **unknown** code **falls through** to the message heuristic instead
   of early-returning false. (`"socket hang up"` has no `cause.code`, so its
   deliberate non-transient behavior is unchanged.)
2. New `describeFetchError(err)` renders the hidden cause code into the message
   (`fetch failed (UND_ERR_SOCKET: other side closed)`), keeping `fetch failed`
   as a prefix so `classifySpawnError` still tags it `network`. Wired into
   `launch-blueprint.ts`'s failure-record so the **next** signal is
   self-diagnosing rather than blind.

## Rules of thumb

* **`fetch failed` with no detail = look at `.cause.code`.** undici hides the
  real reason there; `e.message` alone is useless. Record the cause.
* **`network` vs `auth` watchdog class is meaningful** — they key separate
  signals on purpose. Don't fold a `network` spawn failure into "the credential
  thing" without reading the rows.
* A loopback call to the operator's own host **will** hit restart windows
  (deploys, lib edits). Connection-close mid-request is normal there — retry it.
