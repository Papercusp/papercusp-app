# A receipt must never become durable before the work it attests to — and a chain whose every link is verified can still be wrong about causation
URL: /internal/docs/agent-insights/a-receipt-must-not-outlive-the-write-it-attests-to

The MCP replay layer persisted its success envelope on its OWN connection (getOrgPg()) while the tool's writes were still uncommitted inside the withWorkspace transaction wrapping the whole handler. The receipt therefore committed BEFORE the work, and a failed COMMIT left a `created:true` + real-id envelope replaying for its full 1h TTL against a row that never landed. Two lessons: (1) an idempotency cache is a promise about a COMMITTED effect, so writing it on a different connection than the effect is a lie waiting to happen; (2) the incident report verified three code facts correctly and still named the wrong cause, because the chain's premise was never load-bearing.

## The shape of the bug

`_mcp-handler.ts` wraps a tool call that needs a workspace transaction in
`dispatchWithSynthesizedTx` → `withWorkspace(...)`, which is postgres-js
`sql.begin(...)`. That **commits when its callback resolves**, not before.

Inside that callback, `execute()` used to do, in order:

1. dispatch the tool — its writes go to `ctx.tx`, **uncommitted**
2. `storeMcpResult(...)` — which calls `getOrgPg()`, i.e. a **different
   connection**, and therefore **commits immediately and independently**
3. return
4. …and only *then* does `withWorkspace` COMMIT the tool's transaction.

So the success **receipt** became durable at step 2 while the **work** it
attested to was still uncommitted until step 4. If step 4 failed — a dropped
connection, a pool eviction, an idle-tx timeout — the row never landed, but a
`created:true` envelope carrying a real id was already stored, and every retry
with the same `_meta.idempotencyKey` replayed it for the full 1h TTL.

The replay path makes it worse in a way that defeats forensics:
`lookupStoredMcpResult` returns **before dispatch**, so a replayed call executes
nothing and writes **no `tool_invocation` row**. A replay is invisible to
telemetry and returns instantly. That is why the incident first read as a
"13-minute fleet-wide write gap" rather than as retries being served a stale
receipt.

## The fix

Persist the receipt **after** `dispatchWithSynthesizedTx` resolves — which is
after the COMMIT — and still before the result is returned to the transport.
This keeps the module's actual design intent ("persist before the response hits
a possibly-closed stream") and drops only the accidental part ("persist before
the commit").

The fix needs no new error handling, which is the sign it is at the right
level: **if the COMMIT fails, `await dispatchWithSynthesizedTx(...)` rejects, so
the persist block is simply never reached.** Correctness falls out of the
ordering rather than being bolted on.

Two details worth keeping if you touch this again:

* Persist the **tool's real outcome**, never the value the dispatch returned. On
  a P2-5 deadline those differ: `raceDeadline` resolves the timeout envelope
  while the tool keeps running. Storing the timeout envelope would make every
  later retry replay *the timeout*, forever. Capture the `execute()` promise and
  key the store off that.
* On the deadline path the caller has already been answered, so persist in the
  **background** rather than re-blocking the response you just raced to send.

## The generalizable rule

> An idempotency / replay cache is a promise that an effect **committed**. If
> the receipt is written on a different connection, in a different transaction,
> or at a different time than the effect, that promise is unfounded — and the
> failure is silent, durable, and served confidently.

Whenever you see a "best-effort" write next to a transactional one, ask which
one can outlive the other. "Best-effort" describes what happens when the write
*fails*; it says nothing about what happens when it *succeeds and the other one
doesn't*. That second case is the dangerous one and it is rarely named.

## The reasoning lesson: verified links, wrong chain

The filed report was unusually good. It named three code facts and each one was
**correct**, verified against the files:

1. the `engineer_issues` view's INSTEAD OF trigger ends `RETURN NEW`, so
   `INSERT..RETURNING` echoes caller input;
2. `storeMcpResult` is a separate, non-atomic, best-effort write;
3. the replay returns before dispatch, so no `tool_invocation` row is written.

It then concluded that (1) is what makes the false success possible, and
proposed fixing the trigger first. That conclusion was wrong, and re-verifying
each *link* would never have caught it — because every link really was true.

What settled it was testing the **premise** instead: (1) only produces a false
*success* if the base INSERT can affect **0 rows without raising**. Checking
that took one query — all five `BEFORE INSERT` triggers on
`harness_shared.work_items` were read for `RETURN NULL`, and none has one (the
sole gate `RAISE`s). No `ON CONFLICT DO NOTHING` either. So link 1 could not
silently swallow a row, and fixing the trigger alone would not have prevented
the incident. The real cause was a fourth fact the chain never mentioned: the
commit ordering.

> When a causal chain is offered, do not only re-verify its links. Ask what the
> chain needs to be **load-bearing** — the condition under which link N actually
> forces link N+1 — and test *that*. A chain of true statements is not an
> argument.

(A related trap in the same investigation: the trigger's `RETURN NEW` *is* a
real defect at the **field** level — a peer proved it live by probing a column
neither write list mentions and seeing `RETURNING` echo a value that was never
stored — and fixed it in migration 711. "Not the cause of this incident" and
"not a bug" are different verdicts; say which one you mean.)

## Pinning it

The regression lives in `mcp-handler-gating-matrix.test.ts`, which drives the
**real** CallTool handler with only its seams mocked — so the pin bites on real
code rather than on a model of it. The mocked `withWorkspace` now awaits its
callback and then optionally throws, reproducing a COMMIT that fails *after* the
tool produced its result. Three cases: the event order is exactly
`['commit', 'store']`; a failed COMMIT stores **no** receipt; and no
`idempotencyKey` stores nothing at all.

Use plain functions rather than `vi.fn()` in that file's mocks — its
`beforeEach` calls `vi.resetAllMocks()`, which would strip a `vi.fn`
implementation out from under the assertions and leave a test that passes
vacuously.
