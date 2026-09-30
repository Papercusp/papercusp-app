# Blueprint operations — typed durable work through blueprint:*
URL: /internal/docs/harness/blueprint-operations

How to declare, submit, observe, signal, resume, cancel and collect blueprint operations through the seven blueprint:* tools over HTTP and MCP; direct (agent/program) vs plan targets; trigger and schedule automation and legacy binding migration; vocabulary, typed client, durability and refusals. Runnable examples are executed verbatim by operation-docs-examples.integration.test.ts.

A **blueprint operation** is a typed, durable unit of work that a harness blueprint
declares and that any authenticated caller can start, observe, steer and collect
through one public lifecycle: seven `blueprint:*` tools, projected identically onto
MCP, HTTP (`/api/agent-tools`) and the OpenAPI document. You do **not** need a
Papercusp plan to use one: a direct operation creates exactly one work item and no
plan or plan run. Only an operation that *declares* a plan target starts a plan run.

> **How to read the examples.** Every fence marked `runnable=<id>` is extracted
> from this page and executed verbatim by
> `packages/operator-core/lib/blueprint/operation-docs-examples.integration.test.ts`
> against the current build, over both HTTP and MCP, and its results are checked
> against the declared schemas. A fence marked **conceptual** illustrates a shape
> and is not executed; the page names the test that verifies that behaviour instead.

![Lifecycle of a blueprint operation: a caller submits with a request key, receives a durable handle, reads status, events and result, may send signals, resume a wait or request cancellation, and finally reads a schema-validated result.](/internal/docs/diagrams/blueprint-operation-lifecycle.svg)

## Vocabulary

| term                       | meaning                                                                                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **operation**              | An entry in a blueprint's `operations[]`: id, version, target, execution, `inputSchema`, `acceptance.resultSchema`, optional `signals` and `waits`.                                         |
| **specification revision** | The compiled, content-addressed snapshot of the blueprint. Every submission is **pinned** to the revision current at submit time; later blueprint edits never change an admitted operation. |
| **target**                 | What an admitted operation becomes. `work-item` (direct: one work item, no plan) or `plan` (a run of a declared plan template).                                                             |
| **execution**              | Who produces the result for a direct target: `agent` (a declared role) or `program` (a deterministic program root).                                                                         |
| **request key**            | Caller-chosen idempotency key. Same key + same input replays the same handle; same key + different input is refused `input_conflict`.                                                       |
| **handle**                 | The durable receipt returned by submit. It is bound to the submitting caller, workspace and harness; every other verb takes it.                                                             |
| **signal**                 | A typed, fire-and-record message on a declared channel.                                                                                                                                     |
| **wait / resume**          | The operation may open a named wait with an opaque token; the caller resumes it with a response validated against that wait's `responseSchema`.                                             |
| **result**                 | `pending`, or `ready` with an `output` that validated against `acceptance.resultSchema` and an `evidenceRef`.                                                                               |

## Declaring operations

Operations live in the blueprint source. This declaration is compiled and projected
by the test exactly as written:

```json runnable=declaration
{
  "id": "docs-example",
  "workItem": { "kind": "feature" },
  "roles": [{ "id": "worker" }],
  "spine": { "steps": [{ "id": "open", "op": "coord:thread-open", "args": { "title": "Extract" } }] },
  "operations": [
    {
      "id": "extract",
      "version": "1",
      "target": { "kind": "work-item", "itemKind": "feature" },
      "execution": { "kind": "agent", "role": "worker" },
      "inputSchema": {
        "type": "object", "required": ["value"],
        "properties": { "value": { "type": "string" } }, "additionalProperties": false
      },
      "acceptance": {
        "resultSchema": {
          "type": "object", "required": ["answer"],
          "properties": { "answer": { "type": "string" } }, "additionalProperties": false
        }
      },
      "signals": {
        "note": { "payloadSchema": { "type": "object", "required": ["text"], "properties": { "text": { "type": "string" } } } }
      },
      "waits": {
        "approve": { "responseSchema": { "type": "object", "required": ["approved"], "properties": { "approved": { "type": "boolean" } } } }
      }
    },
    {
      "id": "extract-program",
      "version": "1",
      "target": { "kind": "work-item", "itemKind": "feature" },
      "execution": { "kind": "program" },
      "inputSchema": {
        "type": "object", "required": ["value"],
        "properties": { "value": { "type": "string" } }, "additionalProperties": false
      },
      "acceptance": {
        "resultSchema": {
          "type": "object", "required": ["outcome", "resolved"],
          "properties": { "outcome": { "type": "string" }, "resolved": { "type": "boolean" } },
          "additionalProperties": false
        }
      }
    }
  ]
}
```

## The seven tools

Tool names and HTTP routes, checked against the live projection registry:

```json runnable=tool-routes
{
  "blueprint:submit": "/api/agent-tools/blueprint/submit",
  "blueprint:status": "/api/agent-tools/blueprint/status",
  "blueprint:result": "/api/agent-tools/blueprint/result",
  "blueprint:events": "/api/agent-tools/blueprint/events",
  "blueprint:cancel": "/api/agent-tools/blueprint/cancel",
  "blueprint:signal": "/api/agent-tools/blueprint/signal",
  "blueprint:resume": "/api/agent-tools/blueprint/resume"
}
```

Over HTTP, `POST` the JSON arguments to the route with `Authorization: Bearer <token>`;
over MCP, call the tool by name with the same arguments. Caller identity and workspace
come from the authenticated principal, never from the arguments: a `?client=` or
`?workspace=` query parameter cannot widen a principal into another caller's handle.
The outcomes are byte-identical on both transports.

## Direct agent operation, end to end

**Submit.** Name the harness explicitly; `input` is validated against `inputSchema`.

```json runnable=submit
{ "harness": "docs-example", "operationId": "extract", "requestKey": "order-1234", "input": { "value": "hello" }, "title": "Extract" }
```

The result is `{ "handle": { … } }`. Keep the whole handle: pass it as `handle` to
every other verb. Submitting the same arguments again returns the same handle;
changing `input` under the same `requestKey` is refused
`input_conflict: blueprint operation request key was reused with different input or target`.

**Observe.** `blueprint:status { handle }` returns `phase` (`accepted`, `waiting`,
`terminal`), `outcome`, `wait` and `cancellationRequested`. `blueprint:events { handle,
cursor?, limit? }` pages the durable event log; pass the returned `cursor` to read only
newer events. `blueprint:result { handle }` returns `{ "state": "pending" }` until the
operation settles.

**Signal** a declared channel (the payload is validated against its `payloadSchema`;
a repeated `requestKey` replays the same event):

```json runnable=signal
{ "channel": "note", "payload": { "text": "go" }, "requestKey": "note-1" }
```

**Resume** an open wait. While the operation waits, `status.phase` is `waiting` and
`status.wait` carries `{ name, token }`; send that token back with a response that
matches the wait's `responseSchema`:

```json runnable=resume
{ "token": "wait-1", "response": { "approved": true }, "requestKey": "resume-1" }
```

**Cancel** requests cancellation; it is recorded and reflected as
`status.cancellationRequested: true`. Cancelling a terminal operation is refused
`terminal`.

```json runnable=cancel
{ "reason": "no longer needed", "requestKey": "cancel-1" }
```

**Collect.** Once settled, `blueprint:result` returns
`{ "state": "ready", "output": { … }, "evidenceRef": "…" }`, where `output` has
already been validated against `acceptance.resultSchema`.

## Direct program operation

A program operation uses the same verbs; only the declaration differs. It still
creates exactly one work item and no plan. Its result is the program's own outcome,
not free-form output: a gateless program settles `{ "outcome": "done", "resolved": true }`,
and a spine `gate` op that resolves adds its `decision`. Declare
`acceptance.resultSchema` to admit that shape — a schema the program cannot produce
settles the root `failed`, not `succeeded`:

```json runnable=submit-program
{ "harness": "docs-example", "operationId": "extract-program", "requestKey": "program-1", "input": { "value": "hello" }, "title": "Extract (program)" }
```

## Typed TypeScript client

`BlueprintOperationClient` (`packages/operator-core/lib/blueprint/operation-client.ts`)
wraps any transport. `createProjectedBlueprintOperationPort(invoke)` adapts a function
that calls one projected tool (MCP or HTTP) and parses every result with the shared
contract, so transport drift fails loudly. The client is bound to one workspace,
harness and caller and refuses handles from another scope.

```ts runnable=typed-client
type Ops = {
  extract: { input: { value: string }; output: { answer: string }; signals: { note: { text: string } } };
};
const client = new BlueprintOperationClient<Ops>(createProjectedBlueprintOperationPort(invoke), {
  workspaceId, harnessSlug: 'docs-example', callerId,
});
const handle = await client.submit({ operationId: 'extract', input: { value: 'typed' }, requestKey: 'typed-1' });
const status = await client.status(handle);
await client.signal(handle, { channel: 'note', payload: { text: 'hi' }, requestKey: 'typed-note-1' });
```

Here `invoke(toolName, args)` must return the tool's decoded structured result and
throw on a refusal.

## Plan-target operations

An operation may instead target a declared plan template. Submission then starts one
run of that template (instance plan + plan run + promoted items), and the handle's
target carries `{ kind: "plan", runId, instanceSlug }`. The result becomes `ready` when
the run settles successfully and its published outputs validate against the result
schema.

The template is pinned by slug, revision and the content hash of the template body, so
a later edit to the template cannot silently change what an admitted operation runs.
The declaration below is the one the P-013 fork/join benchmark submits end to end in
`packages/operator-core/lib/blueprint/operation-performance-b.integration.test.ts`:
submit, promotion of the template's items, claim and complete of each item,
`plans:publish-outputs`, settlement, and a `ready` result. Its `contentHash` is the hash
of that suite's `p013-fork-join` template, and the docs suite fails if the two drift.

```json runnable=plan-target
{
  "id": "fork-join",
  "version": "1",
  "target": {
    "kind": "plan",
    "template": {
      "kind": "plan-template",
      "ref": "p013-fork-join",
      "revision": "0",
      "contentHash": "767fa209f0f9c989272aa73f58d4338ddb576a9cdd8500ac870ae68ca97f347c"
    }
  },
  "inputSchema": {
    "type": "object", "required": ["value"],
    "properties": { "value": { "type": "string" } }, "additionalProperties": false
  },
  "acceptance": {
    "resultSchema": {
      "type": "object", "required": ["value"],
      "properties": { "value": { "type": "string" } }, "additionalProperties": false
    }
  }
}
```

Use a plan target only when the work genuinely is a multi-item plan; most callers want
a direct target.

## Automation: triggers and schedules

External-event triggers and plan schedules start operations through the same admission
path as a direct `blueprint:submit-operation`. The operation's input schema,
authorization and target apply unchanged. There is no second scheduler, workflow
namespace or receipt store: each automated start reuses a receipt that already exists as
its `requestKey`, so a replayed occurrence returns the original handle instead of
starting a second run.

| start                  | `callerId`                    | `requestKey`                        | input the operation receives                |
| ---------------------- | ----------------------------- | ----------------------------------- | ------------------------------------------- |
| external-event trigger | `trigger-binding:<bindingId>` | `trigger-run:<triggerRunId>`        | `{ trigger: <routing envelope>, ...input }` |
| plan schedule          | `routine:<routineId>`         | the routine fire's DBOS workflow id | `input` exactly as configured               |

### External-event triggers

A trigger-started operation receives the event's **routing envelope** under `trigger`
(`key`, `source`, `event`, `sourceId`, `externalId`, `occurredAt`, `datatypeId`,
`dedupeKey`) merged with the literal `input` configured on the binding. The provider
payload itself is never forwarded. So the operation's input schema must admit a
`trigger` object. Add an operation like this to the declaration above:

```json runnable=trigger-operation
{
  "id": "triage",
  "version": "1",
  "target": { "kind": "work-item", "itemKind": "feature" },
  "execution": { "kind": "agent", "role": "worker" },
  "inputSchema": {
    "type": "object", "required": ["trigger", "queue"],
    "properties": { "trigger": { "type": "object" }, "queue": { "type": "string" } },
    "additionalProperties": false
  },
  "acceptance": {
    "resultSchema": {
      "type": "object", "required": ["answer"],
      "properties": { "answer": { "type": "string" } }, "additionalProperties": false
    }
  }
}
```

Then bind an event pattern to it with `triggers:bind`. An optional `filter` (the shared
rules vocabulary) narrows which events fire, and `stormPolicy` caps runs per window:

```json runnable=trigger-bind
{
  "sourceId": "0b6b6f7e-3c1a-4d2e-9f00-5a1f2c3d4e5f",
  "eventPattern": "ext:github:issues.opened",
  "stormPolicy": { "maxRuns": 20, "windowSeconds": 3600 },
  "operationHarnessSlug": "docs-example",
  "operationId": "triage",
  "input": { "queue": "inbox" }
}
```

The binding is installed **disarmed**. Review it, then activate it with
`triggers:arm { bindingId, confirm: true }`. `triggers:status` shows each run's
`blueprintOperation` outcome: the receipt id, operation id, specification revision, and
the actual target (`{ kind: "work-item", id, status }` or
`{ kind: "plan", runId, instanceSlug, status, outcome }`).

### Migrating a legacy plan binding

A binding that launches a plan directly can be moved onto an operation without
re-authoring its source, event pattern, filter or storm policy. Pass the legacy binding
id and the operation target only; everything else is copied, and passing any of it is
refused:

```json runnable=trigger-migrate
{
  "migrateFromBindingId": "5d0c9a3e-1b2f-4c7d-8e6a-0f1e2d3c4b5a",
  "operationHarnessSlug": "docs-example",
  "operationId": "triage",
  "input": { "queue": "inbox" }
}
```

The replacement is created **disarmed** and the legacy binding is left unchanged.
Repeating the same migration returns the same replacement; repeating it with a different
target is refused (`external_trigger_binding_migration_target_conflict`). Prove the
replacement with `triggers:run-with-last-event`, then switch over with the explicit
controls: `triggers:arm` the replacement and `triggers:disarm` the legacy binding.

### Schedules

A plan schedule fires an operation when its `schedule.operation` names one. Without it,
the schedule keeps the legacy `system:plan-run` path. Author the recurrence with
`plans:set-schedule`:

```json runnable=schedule-operation
{
  "harness": "docs-example",
  "slug": "weekly-digest",
  "schedule": {
    "kind": "rrule",
    "rrule": "FREQ=WEEKLY;BYDAY=MO",
    "dtstart": "2026-10-05T09:00:00.000Z",
    "tzid": "America/New_York",
    "concurrency": "skip",
    "operation": {
      "harnessSlug": "docs-example",
      "operationId": "extract-program",
      "input": { "value": "weekly digest" }
    }
  }
}
```

Authoring does not arm it. Arming is the separate, autonomy-gated
`plans:arm-schedule` step, and an unarmed schedule never fires. Each fire runs the
`system:blueprint-operation` routine action, which submits the operation with the
configured `input` unchanged.

## Durability, replay and recovery

![Durability: submission writes a durable receipt pinned to a specification revision; on restart the same request key replays the receipt, pending waits and signals remain in the event log, and the result is re-read from durable state.](/internal/docs/diagrams/blueprint-operation-durability.svg)

* **Idempotent admission.** The receipt, the pinned specification revision and the
  target are written in one transaction. A retried submit with the same key and input
  returns the same handle; because the receipt lives in PostgreSQL, that also holds
  after an operator restart.
* **Pinned specification.** Execution, signal, wait and result validation always use
  the pinned revision, never the blueprint's current one.
* **Durable control inputs.** Signals, resumes and cancellation requests are appended
  to the operation's event log before they are acknowledged; a replayed `requestKey`
  returns the original event (`replayed: true`).
* **Program execution** runs as a durable (DBOS) workflow; a crash mid-run replays
  completed steps from their recorded results instead of re-executing them. This is
  verified with a real process kill by the SIGKILL replay test in the P-009 suite.
* **Late readers** always observe the current durable state: status, events from any
  cursor, and the final validated result.

## Refusals

Every refusal is `invalid_input` (HTTP 400) with a typed message prefix, except the
capability gate (`missing_capability`, HTTP 403):

| prefix            | meaning                                                                  |
| ----------------- | ------------------------------------------------------------------------ |
| `input_conflict`  | request key reused with different input or target                        |
| `invalid_payload` | input, signal payload or resume response fails its schema                |
| `undeclared`      | signal channel not declared by the operation                             |
| `stale_wait`      | wait token is stale or belongs to another operation                      |
| `terminal`        | cannot cancel a terminal operation                                       |
| `handle_mismatch` | handle does not match its durable receipt (e.g. another caller's handle) |
| `scope_mismatch`  | handle belongs to a different workspace                                  |

## Performance

P-013 of plan `blueprint-backed-work-item-execution-2026-09-23` measured each operation shape against
the non-operation path it replaces, on one host, with deterministic provider fixtures (no model
latency) and a dedicated PostgreSQL. Every number below is the median of five process-isolated
repetitions, rendered from the evidence file named under each table. Latency is measured from
ingress to the business event.

A cell passes when the candidate stays inside the D-016 bar set against its own paired control:
warm p50 at most 1.15x control + 15 ms, warm p95 at most 1.25x + 25 ms, warm p99 at most 1.5x + 50 ms,
cold p95 at most 1.75x + 500 ms, and throughput at 8 concurrent callers at least 0.80x control.

### A. Direct work-item operation — PASS 9/9

| Metric     | Callers | Control | Candidate | Limit   | Result |
| ---------- | ------- | ------- | --------- | ------- | ------ |
| warm p50   | 1       | 479 ms  | 468 ms    | 566 ms  | pass   |
| warm p95   | 1       | 562 ms  | 553 ms    | 727 ms  | pass   |
| warm p99   | 1       | 1365 ms | 679 ms    | 2097 ms | pass   |
| cold p95   | 1       | 3088 ms | 3190 ms   | 5903 ms | pass   |
| warm p50   | 8       | 2346 ms | 2185 ms   | 2712 ms | pass   |
| warm p95   | 8       | 3106 ms | 3156 ms   | 3907 ms | pass   |
| warm p99   | 8       | 3723 ms | 3575 ms   | 5634 ms | pass   |
| cold p95   | 8       | 2834 ms | 2880 ms   | 5460 ms | pass   |
| throughput | 8       | 3.21/s  | 3.20/s    | 2.57/s  | pass   |

Evidence: `docs/evidence/p013-workload-a-2026-09-28.json`.

Not proven by this workload:

* Actual-model latency: this matrix uses deterministic provider fixtures only; the bounded actual-model smoke is separate.
* Which call pays the \~1.1 s cold first-use cost in each arm is inferred from phase sums, not probed per call.

### B. Plan-target fork/join DAG — PASS 9/9

| Metric     | Callers | Control  | Candidate | Limit    | Result |
| ---------- | ------- | -------- | --------- | -------- | ------ |
| warm p50   | 1       | 2001 ms  | 2006 ms   | 2316 ms  | pass   |
| warm p95   | 1       | 2650 ms  | 2459 ms   | 3337 ms  | pass   |
| warm p99   | 1       | 4862 ms  | 3547 ms   | 7343 ms  | pass   |
| cold p95   | 1       | 6526 ms  | 7566 ms   | 11920 ms | pass   |
| warm p50   | 8       | 12549 ms | 11381 ms  | 14447 ms | pass   |
| warm p95   | 8       | 14814 ms | 13357 ms  | 18543 ms | pass   |
| warm p99   | 8       | 15684 ms | 14863 ms  | 23576 ms | pass   |
| cold p95   | 8       | 15888 ms | 11388 ms  | 28304 ms | pass   |
| throughput | 8       | 0.63/s   | 0.68/s    | 0.51/s   | pass   |

Evidence: `docs/evidence/p013-workload-b-2026-09-28.json`.

Not proven by this workload:

* Actual-model latency: this matrix uses a deterministic fixture worker only.
* Absolute latency on an idle box: the box was shared with fleet work throughout; only the paired candidate/control ratio is graded.

### C. Four-step conditional program — FAIL 6/9

| Metric     | Callers | Control  | Candidate | Limit    | Result |
| ---------- | ------- | -------- | --------- | -------- | ------ |
| warm p50   | 1       | 46 ms    | 47 ms     | 80 ms    | pass   |
| warm p95   | 1       | 52 ms    | 95 ms     | 115 ms   | pass   |
| warm p99   | 1       | 54 ms    | 101 ms    | 182 ms   | pass   |
| cold p95   | 1       | 83 ms    | 233 ms    | 646 ms   | pass   |
| warm p50   | 8       | 46 ms    | 93 ms     | 80 ms    | fail   |
| warm p95   | 8       | 54 ms    | 122 ms    | 118 ms   | fail   |
| warm p99   | 8       | 59 ms    | 148 ms    | 188 ms   | pass   |
| cold p95   | 8       | 82 ms    | 274 ms    | 643 ms   | pass   |
| throughput | 8       | 149.94/s | 72.93/s   | 119.95/s | fail   |

Evidence: `docs/evidence/p013-workload-c-final-2026-09-29.json`.

This workload does not meet its budget: warm p50 at 8 callers, warm p95 at 8 callers, throughput at 8 callers fail. It stays graded against the same control and limits as the other workloads (plan decision D-036). The remaining cost is in the canonical work-item write path, and it is tracked as WI-10003818.

Not proven by this workload:

* Invariants (zero harness\_plans / plan\_runs rows on both arms, stable step ids across every sample, no duplicated step effects) are asserted inside the test per repetition (all 5 passed); they are not re-derived here.
* Persistence counters are dedicated-cluster pg\_stat deltas per sample; they attribute cost to the whole cluster, not to a specific table.
* No wait-event sampler ran during c-run3, so no wait-class attribution accompanies this grade.

### D. Durable recipe (orchestrate:run) — PASS 9/9

| Metric     | Callers | Control | Candidate | Limit   | Result |
| ---------- | ------- | ------- | --------- | ------- | ------ |
| warm p50   | 1       | 78 ms   | 110 ms    | 166 ms  | pass   |
| warm p95   | 1       | 89 ms   | 131 ms    | 255 ms  | pass   |
| warm p99   | 1       | 103 ms  | 151 ms    | 431 ms  | pass   |
| cold p95   | 1       | 236 ms  | 318 ms    | 1589 ms | pass   |
| warm p50   | 8       | 197 ms  | 176 ms    | 346 ms  | pass   |
| warm p95   | 8       | 244 ms  | 253 ms    | 527 ms  | pass   |
| warm p99   | 8       | 318 ms  | 335 ms    | 914 ms  | pass   |
| cold p95   | 8       | 278 ms  | 297 ms    | 1694 ms | pass   |
| throughput | 8       | 39.49/s | 42.71/s   | 25.67/s | pass   |

Evidence: `docs/evidence/p013-workload-d-2026-09-28.json`.

Not proven by this workload:

* dbRoundTrips is null (UNKNOWN, not zero) for both arms; control dbBytes/durableSteps are null because the foreground arm has no DBOS persistence to measure.
* The bounded actual-provider smoke (kept separate from fixture latency by D-016).
* The exactly-once idempotent write invariant is asserted inside the test per sample (test passed on all 5 repetitions); it is not re-derived here.
* Host load was not held constant across reps (shared box); per-rep load is not recorded in this artifact.

### Actual-model smoke (ungraded)

One bounded run with a real model (claude-haiku-4-5), 5 samples per arm after
1 warmup. It is not graded; it shows how much of a real call is platform overhead.

| Arm                  | Total p50 | Model p50 | Platform overhead p50 | Overhead share |
| -------------------- | --------- | --------- | --------------------- | -------------- |
| Control (foreground) | 552.3 ms  | 449.4 ms  | 102.9 ms              | 19.5%          |
| Candidate (durable)  | 565.3 ms  | 426.4 ms  | 135.8 ms              | 24.5%          |

Every run made exactly one provider call and exactly one business write (10 runs, 10 writes). Evidence: `docs/evidence/p013-actual-model-smoke-2026-09-28.json`.
