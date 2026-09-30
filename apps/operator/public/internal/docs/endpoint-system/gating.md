# Gating
URL: /internal/docs/endpoint-system/gating

The ordered gates every tool call runs through — signature, default-deny, roles, capabilities, capability-envelope, RBAC, harness, quota, resource authorization, declarative preconditions, timeout — and the error codes they emit.

## The gates, in order

Every projected tool call runs through `tryBuildSpawnContext` → `dispatchProjectedTool` and faces these gates in order. The first one that fails short-circuits with the matching error code. The dispatch-stack gates are defined once in `DEFAULT_DISPATCH_STACK` (`libs/generic/tooldef/src/dispatch-stack.ts`); signature verification runs earlier, in `tryBuildSpawnContext`.

```
┌────────────────────────────────────────────────┐
│ 0. Signature verification (per-spawn)           │  → request_rejected: spawn_sig_<reason>
├────────────────────────────────────────────────┤
│ 1. Default-deny (opt-in; off by default)        │  → ungated (403)
├────────────────────────────────────────────────┤
│ 2. Role allowlist (agent role vs tool.roles)    │  → role_not_allowed (403)
├────────────────────────────────────────────────┤
│ 3. Capability check (principal capabilities)    │  → unauthorized (401) | missing_capability (403)
├────────────────────────────────────────────────┤
│ 4. Capability envelope (per-role "may at all")  │  → capability_denied (enforce mode only)
├────────────────────────────────────────────────┤
│ 5. RBAC role requirement (tool.requireRoles)    │  → missing_role (403)
├────────────────────────────────────────────────┤
│ 6. Harness-required gate                        │  → harness_required (400)
├────────────────────────────────────────────────┤
│ 7. Per-window quota                             │  → quota_exceeded (429)
├────────────────────────────────────────────────┤
│ 8. Resource authorization (tool.authorize)      │  → authorization_denied (403)
├────────────────────────────────────────────────┤
│ 9. Declarative preconditions (tool.requires)    │  → precondition_failed (412)
├────────────────────────────────────────────────┤
│ 10. Per-tool timeout (during execution)         │  → timeout (504)
└────────────────────────────────────────────────┘
```

If every gate passes, the function runs. Whatever it returns or throws is recorded with one of the post-execution statuses (`ok`, `error`, `timeout`).

Gates **1, 5, 8** and the **authorization audit trail** are the [RFC tooldef-auth](/internal/docs/spec/plan-format) layer: a fail-closed default-deny posture, declarative RBAC roles, resource-level "can THIS principal act on THIS resource", and an audit event for every authz decision. Gate **4** (capability envelope) is the [agent-capability-confinement](/internal/docs/spec/plan-format) layer (B-06 / P-012). Gates 0, 2, 3, 6, 7, 9 are the original coarse checks. Each is detailed below.

## Signature verification (gate 0)

Before any other gate fires, the dispatcher verifies the per-spawn URL's HMAC signature. A worker that rewrites `?role=worker` → `?role=operator` produces an `invalid_signature` and is rejected with `request_rejected: spawn_sig_invalid_signature`. The attempt is persisted to `harness_shared.spawn_sig_verification_failures` for on-call review.

This check is **not** wired into `tools/list` — listing returns what the *claimed* role would see, so an agent can introspect what tools exist before invoking. Verification happens at `tools/call`.

The `?superuser=1` door bypasses this check entirely; it has its own loopback + bearer envelope. See [Superuser mode](/internal/docs/endpoint-system/superuser-mode).

Full scheme, reason codes, rotation, and observability live in [Spawn-URL signing](/internal/docs/endpoint-system/spawn-signing).

## Default-deny (gate 1)

A **fail-closed posture**: when the host sets `deps.defaultDeny`, a tool that declares **no gate at all** — no capabilities, no agent `roles`, no `requireRoles`, no `authorize` hook — is denied as `ungated` (403) unless it is explicitly marked `public: true` (the `[AllowAnonymous]` equivalent).

The *engine* default is off (the legacy allow-by-omission posture), but **the Papercusp host turns it ON** — `PROJECTED_DEPS` in `packages/operator-core/lib/projected-tool-deps.ts` sets `defaultDeny: true` (audited 2026-05-31). It currently denies nothing registered, because every first-party `defineTool` (which *requires* a `capability`) and every bundled plugin tool already declares a gate; it's the fail-closed floor for a future / third-party tool that forgets to. It is **not bypassable** by `GateBypass` — an ungated tool is a declaration gap regardless of caller, so the fix is to declare a gate or mark it `public`.

`defineTool` *requires* a `capability`, so every first-party built-in tool already declares a gate and is never `ungated`. The posture exists to catch plugin / direct `registerProjectedTool` registrations that forgot to gate themselves. Since `defaultDeny` is already on, re-verify before/after installing a plugin by running `listUngatedProjectedTools()` (with the full registry loaded) — an empty result means nothing is silently denied; anything it returns must declare a gate or be marked `public`.

## Role allowlist (gate 2)

Tools declare `roles[]` — the **agent**-role allowlist (worker / scoper / architect / …), checked against `ctx.role` from the URL spawn param. This is orchestration gating, distinct from the RBAC role requirement below.

```jsonc
{
  "roles": ["worker", "scoper", "architect"]
}
```

A `validator` calling this tool gets:

```json
{
  "error": {
    "code": "role_not_allowed",
    "message": "Role \"validator\" cannot call tool \"plugin.tool\" (allowed roles: worker, scoper, architect)"
  }
}
```

HTTP status: 403. The check only runs when *both* `tool.roles` and `ctx.role` are set, and is skipped when `GateBypass.role` is set. Tools without `tool.roles` skip this check.

## Capability check (gate 3)

Built-in tools declare a single capability string per tool. When a request arrives with a bearer token, the framework resolves it to a principal with a `Set<string>` of granted capabilities. The dispatcher checks `tool.capabilities[]` ⊆ `principal.capabilities`.

Two distinct failure modes:

* **No principal at all** (no bearer or invalid bearer) → `unauthorized` (401). The wrapper around legacy `defineTool` handlers throws `UnauthorizedToolError`; the dispatcher catches it and maps to 401.
* **Principal present but missing the required capability** → `missing_capability` (403).

The check is skipped when there is no principal (the agent path gates via the role allowlist instead) or when `GateBypass.capability` is set. Plugin tools have `capabilities[]` declared too, but they're descriptive-only today — used by the Intel UI and tooling, not enforced.

## Capability envelope (gate 4)

A cheap, static, **per-role "may this caller do X *at all*"** gate (agent-capability-confinement B-06 / P-012). It runs right after the capability check (both are cheap capability gates) and before the costlier RBAC / authorize / precondition gates. Unlike gate 3 (which asks "does this principal hold the capability"), the envelope asks "is this tool even *inside* the envelope of what this role is ever allowed to reach".

It is **host-supplied** through `deps.checkCapabilityEnvelope` and is a **no-op when unwired** (no port ⇒ behavior-neutral). Papercusp wires it via `PROJECTED_DEPS.checkCapabilityEnvelope`, but it is in **OBSERVE / shadow mode by default** today: the `CAPABILITY_ENVELOPE` flag defaults to **off** (`libs/flags/src/types.ts`), which means *observe-only* — the evaluator runs and annotates the decision-ledger posture but **never blocks**. Enforcement only begins when the flag is flipped on (the B-18 arming act).

* **Within envelope** → `allow`, pass.
* **Beyond envelope, flag off (default)** → `observe` — logged/annotated, call proceeds.
* **Beyond envelope, flag on** → `deny` with error code `capability_denied`.
* **Evaluator throws** → **fail-open** (`return null`, call proceeds) — the OS sandbox is the containment backstop, so an evaluator bug must never wedge the fleet (matches the quota gate's fail-open-on-error posture).
* **Exempt callers** — SU / power-user / non-fleet / roleless principals are exempt; the evaluator returns no verdict and the gate no-ops.

Note the HTTP mapping caveat: `capability_denied` has **no explicit case** in `statusForErrorCode`, so over HTTP it currently falls through to the default **500** (see the table below) — likely itself a defect, since it is a 403-class authz denial.

## RBAC role requirement (gate 5)

A tool declaring `requireRoles` is callable only by a principal whose **RBAC `roles`** (`principal.roles`) include at least **one** of them (any-of). This is the typed, declarative, audited replacement for ad-hoc `requireAdminKey` / `requireStaff`-style checks.

```jsonc
{ "requireRoles": ["staff", "admin"] }   // caller must hold staff OR admin
```

`principal.roles` is a **distinct axis** from `kind` (how the caller authenticated), from `capabilities` (OAuth-scope-like grants), and from the agent `roles` allowlist above (which is checked against `ctx.role`, not the principal).

* **Principal holds a required role** → pass.
* **Principal lacks every required role, or there is no principal (anonymous)** → `missing_role` (403). The gate is **fail-closed**: a role requirement can't be satisfied without an identity.
* Skipped when `GateBypass.role` is set — a superuser passes RBAC role gates as it passes the agent-role allowlist.

Every denial emits an authorization audit event (see below).

## Harness-required gate (gate 6)

A tool declaring `harness: 'required'` (a ctx-only harness-scoped tool — one with no slug arg, so `ctx.harnessSlug` is its only harness source) is rejected with `harness_required` (400) when no harness is in scope. "No harness in scope" means `ctx.harnessSlug` is unset/empty **or** the literal `'*'` wildcard papercup — the superuser "no harness picked" case (a harness that is present-but-unselected), not only a missing slug (`if (slug && slug !== '*') return null`). This gate **fails closed even for privileged callers** by default, because a `harness: 'required'` tool genuinely can't function without a harness; the point is to return the uniform "harness required" hint rather than push the failure into the handler. There is a narrow explicit dispatcher escape hatch, `GateBypass.harness`, but the normal superuser/power-user mapping does not set it.

## Per-window quota (gate 7)

A window is a counter scoped by `(workspace, tool, role, window_key)` against `harness_shared.tool_invocations`. The window key depends on role (the Papercusp policy in `packages/agent-mcp/src/quota-policy.ts`, wired via `PROJECTED_DEPS.computeQuotaWindow`):

* **Worker** → `chunk:<chunkId>` (resets per chunk; capped by `perChunk`)
* **Power-user session** (`?power_user=1`) → `power-user:<uiClientId>` (the `auth_session_id`; capped by `perRun`) — a power-user MCP call gets a fresh `runId` per request, so a run-keyed window would never accumulate; it keys on the stable session instead.
* **Anyone else** → `run:<runId>` (resets per orchestrator run; capped by `perRun`)

`tool_invocations` rows that count against quota have `status='ok'` only. Failures (`error`, `timeout`, `quota-exceeded`, `role-not-allowed`) don't consume a slot, so a tool that returns 500 doesn't burn the budget.

Manifest declares the limit per role:

```jsonc
{
  "rolesQuota": {
    "worker":    { "perChunk": 1 },
    "architect": { "perRun": 5 },
    "scoper":    { "perRun": 3 }
  }
}
```

When a call exceeds, the dispatcher returns:

```json
{
  "error": {
    "code": "quota_exceeded",
    "message": "Tool \"plugin.tool\" exceeded quota (1/1) in window \"chunk:Q1\"",
    "meta": { "tool": "plugin.tool", "role": "worker", "windowKey": "chunk:Q1", "used": 1, "limit": 1 }
  }
}
```

HTTP status: 429. Skipped when `GateBypass.quota` is set.

### Quota under concurrency

Five simultaneous requests with `perChunk=1` produce one ok and four `quota-exceeded`. This holds in practice because Node's event loop serializes through the JS code paths and the first INSERT lands before the others reach `readQuotaState`.

There is a theoretical TOCTOU window: all five readers could see `count=0` before any of them inserts. Closing this rigorously would require a PG advisory lock or `INSERT ... RETURNING` with a check constraint. Today the soft guarantee is good enough for the workloads the framework handles. If you have a tool where a one-call-over-quota bug is catastrophic, file an issue.

### Don't quota reads

Read-only tools (`roles:list`, `snapshots:get`) shouldn't have a `rolesQuota`. Quotas exist for: external API spend, PG write bursts, subprocess fan-out. Counting every read produces noise without protection.

## Resource authorization (gate 8)

The coarse gates above answer "may this *kind* of caller use this tool". The `authorize` hook answers the **fine-grained** question the others can't express: "may THIS principal act on THIS *resource*" (ownership / ReBAC / ABAC).

```ts
defineTool({
  name: 'orders:get',
  capability: 'orders:read',
  authorize: ({ principal, input }) =>
    input.ownerId === principal?.slug
      ? { allow: true }
      : { allow: false, reason: 'not the owner' },
  // …
});
```

It runs **after** the coarse gates and **before** the handler, **fail-closed** (a throw denies → `authorization_denied`), and is **additive** — a tool with no `authorize` skips this gate entirely. Because it runs in-process with the tool's `ctx`, it can load the resource it needs to decide ("authorize close to the data") and can return `obligations` (e.g. a row filter) for list endpoints rather than checking each row.

The framework is the **policy-enforcement point**; it ships the contract (`AuthzQuery` / `AuthDecision` / `PolicyDecisionPoint`, plus a trivial `ownerOnly` helper) and **no policy engine** — the decision is the host's, supplied as an in-process closure or by delegating to an external PDP (OPA / Cedar / OpenFGA / Cerbos / an AuthZEN engine).

### Break-glass: `GateBypass.policy`

Unlike the role/capability/quota bypasses, the resource-`authorize` gate is **not** skipped by them — resource ownership is a separate decision a host opts out of explicitly, per call, via `GateBypass.policy` (default off). And even then **the bypass is audited**: skipping the hook still emits an authz audit event recording the bypass. Break-glass best practice is "policy-governed *and* mandatorily logged" — a bypassed check that isn't logged is the silent super-admin the standard forbids.

## Declarative preconditions (gate 9): `requires:`

The **preInvoke mirror of `emits:`** (autoloop-pot-operator-rebuild-2026-06-05 D-006). A tool declares `requires: [ToolRequireSpec, …]` — each spec a declarative condition (a `@papercusp/rules` MatchMap / `all`/`any`/`not` combinator over `{ tool, args, ctx, state }`) that must **hold** for the call to proceed, plus a response when it doesn't:

* `{ error }` — **reject** the call with `precondition_failed`.
* `{ fire, then: 'retry' }` — **auto-correct, visibly**: fire a corrective tool through the host's injectable `deps.firePrecondition` port (Papercusp wires it to the same dispatch path reactions use — auth-gated, audited, cause-chained), re-resolve state, re-evaluate **once**, and reject if it still fails.

```ts
defineTool({
  name: 'autoloop:status',
  // The former in-handler `if (!slug) throw` guard, lifted (the proof migration):
  requires: [{
    id: 'harness-slug',
    when: { any: [
      { 'args.harnessSlug': { truthy: true } },
      { 'ctx.harnessSlug':  { truthy: true } },
    ]},
    error: 'autoloop:status — harness slug required (passed or in spawn ctx)',
  }],
  // …
});
```

Host state enters through the spec's optional `state(args, ctx)` resolver (re-resolved before the retry); conditions are **declarative only** — there is deliberately no JS-predicate hatch here, because inspectability/serializability is the point of the lift. Everything fails **closed**: a throwing resolver, a malformed condition, a missing fire port, or a failed retry all deny. Denials and auto-corrections are audited with `gate: 'precondition'` through the same `deps.auditAuth` sink as gates 5/8 (first-try passes are not audited — they're the overwhelmingly common case).

It runs **after** `authorize` — a corrective fire must only happen for an authorized caller, and a functional gap must not mask an auth denial — and **before** `timeout` (it's a gate; no timers or buffers exist yet on the deny path).

**What belongs in `requires:`:** *functional* preconditions — an arg/scope shape the handler can't proceed without, a resumable resource that a corrective fire can fix (the reject/auto-correct/delete choice is D-006's safety-vs-convenience judgment: auto-correct ergonomic preconditions visibly; reject ones the caller must fix; delete artificial ones instead of migrating them).

### Safety invariants are EXCLUDED by design (D-007)

**`requires:` must never absorb a safety invariant.** The rule (autoloop-pot-operator-rebuild D-007): *the operator proposes, the gate disposes* — an agent gets maximal agency **inside** a small set of hard, coded guardrails it cannot reason past. A safety gate in a declarative rule table is a safety gate an agent (or a rule edit) can weaken; these stay imperative, fail-closed, audited **code**. The inventory (verified 2026-06-05):

| Gate                    | Where (imperative code)                                                                                                                                                                                                                    | Audit sink                                                          | Bypass                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **Don't-deploy-on-red** | `apps/operator/lib/release/green-checkpoint.ts` (ready advances only on green) + `deploy-cli.ts` (refuses un-green targets)                                                                                                                | coord broadcast per checkpoint/deploy                               | `--force` / `--deploy-commit` — loudly audited (`🚨 FORCED un-green deploy`) |
| **Protected-paths**     | `packages/operator-core/lib/harness/improvements/policy.ts` `classifyImprovement()` — glob patterns route protected surfaces to the human queue                                                                                            | tier decision in the improvements digest/queue                      | none (kind-graduation only widens `auto` kinds, never the protected paths)   |
| **Budget / quota caps** | `libs/papercusp/libs/db/src/budget-enforcement.ts` (row-locked atomic budget check, fail-closed) + `orchestrator-loop.ts` `SAFETY_CEILING` (hard constant; blueprint `dispatch.safetyCeiling` may only tighten) + the quota gate (7) above | `tool_invocations` (quota); `BudgetExceededError` carries detail    | quota: `GateBypass.quota`; budget/ceiling: none                              |
| **Auth perimeter**      | gates 0–5 + 8 above (`dispatch-stack.ts`, `tryBuildSpawnContext`)                                                                                                                                                                          | `harness_shared.tool_authz_log` + `spawn_sig_verification_failures` | per-gate `GateBypass`, `policy` bypass audited                               |
| **No-double-allocate**  | `work-items.ts` atomic CAS (`UPDATE … WHERE taken_by IS NULL`), `orchestrator/feature-claim.ts` append-only claim log, `authority/lock-authority.ts`                                                                                       | `harness_shared.claim_audit` (won/lost/timeout/error)               | none — atomic by construction                                                |

None of the five flows through `@papercusp/rules`, the event-reaction tables, or `requires:` — and that's load-bearing, not an accident. When migrating a hardcoded guard to `requires:` (or a reaction to `emits:`), first ask: *is this gate's failure mode harm?* If yes, it stays code.

## The authorization audit trail

Gates **5** (RBAC), **8** (authorize), and **9** (preconditions), plus every `GateBypass.policy` bypass, emit an `AuthAuditEvent` through the optional `deps.auditAuth` sink. What each emits differs:

* **Gate 5 (RBAC role requirement)** audits **denials only** — the pass path returns without an emit; only the missing-role branch records `decision: 'deny'`.
* **Gate 8 (authorize)** is the one that audits **every allow, deny, *and* bypass** — its allow path, deny path, and the `GateBypass.policy` break-glass all emit.
* **Gate 9 (preconditions, `gate: 'precondition'`)** audits both **denials** and **successful auto-corrections** (the auto-correct allow on a `{ fire, then: 'retry' }` spec); first-try passes are not audited.

The Papercusp host persists them to `harness_shared.tool_authz_log` (`packages/operator-core/lib/tool-authz-audit.ts`), a security-decision stream distinct from the login-scoped `auth_audit_log` and the per-call `tool_invocations` telemetry. It answers "show me every denial / every break-glass bypass / everything this principal was denied".

## Per-tool timeout (gate 10)

Each manifest entry has `timeoutSec` (default 60). The dispatcher creates an `AbortController`, hands `controller.signal` to the function as `ctx.signal`, and aborts after the configured time. Functions doing long work should watch `ctx.signal.aborted` and bail.

A timed-out call gets:

```json
{
  "error": { "code": "timeout", "message": "tool \"plugin.tool\" exceeded timeout of 60s" }
}
```

HTTP status: 504. The `tool_invocations` row records `status='timeout'`.

## The whole error code → HTTP status table

For HTTP transport, `statusForErrorCode` in `libs/generic/tooldef-http/src/http-projection.ts` maps:

| Error code             | HTTP                                     | Source                                                                                                                                      |
| ---------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `ungated`              | 403                                      | Default-deny on; tool declares no gate and isn't `public`                                                                                   |
| `unauthorized`         | 401                                      | Built-in tool, no bearer / invalid bearer                                                                                                   |
| `role_not_allowed`     | 403                                      | Agent role not in the tool's allowlist                                                                                                      |
| `missing_capability`   | 403                                      | Principal missing required capability                                                                                                       |
| `capability_denied`    | 500 (no explicit case; falls to default) | Capability-envelope gate denied (enforce mode). The missing 403-class case means this authz denial is currently surfaced as a 500 over HTTP |
| `missing_role`         | 403                                      | Principal missing a required RBAC role (`requireRoles`)                                                                                     |
| `harness_required`     | 400                                      | `harness:'required'` tool with no harness in scope                                                                                          |
| `quota_exceeded`       | 429                                      | Window count ≥ limit                                                                                                                        |
| `authorization_denied` | 403                                      | The tool's `authorize` hook denied (or threw → fail-closed)                                                                                 |
| `precondition_failed`  | 412                                      | A declarative `requires:` precondition failed (after the auto-correct retry, when one was declared)                                         |
| `invalid_input`        | 400                                      | Function threw a typed input-validation error                                                                                               |
| `timeout`              | 504                                      | AbortController fired before function returned                                                                                              |
| `unknown_tool`         | 404                                      | No projection registered at this path/name                                                                                                  |
| `method_not_allowed`   | 405                                      | HTTP method not in `expose.http.methods`                                                                                                    |
| anything else          | 500                                      | Function threw an unhandled error → `handler_error`                                                                                         |

For MCP transport, errors are returned as a normal `tools/call` result with `isError: true` and a `content[].text` describing the error. There's no JSON-RPC-level rejection — the MCP spec puts tool errors in the result envelope.

## A worked example

Here's what happens when a `worker` tries to call `firecrawl.scrape` with `chunk=Q1` for the second time:

1. **Default-deny.** On in Papercusp (`defaultDeny: true`), but `firecrawl.scrape` declares a role allowlist, so it's gated → pass.
2. **Role check.** `firecrawl.scrape.roles = [scoper, architect, operator, reviewer, debugger, worker]`. Worker is in. Pass.
3. **Capability check.** Plugin tool — no principal — skipped.
4. **Capability envelope.** `CAPABILITY_ENVELOPE` flag off (default) → observe mode: the evaluator may annotate the decision-ledger posture but never blocks → pass.
5. **RBAC role requirement.** No `requireRoles` → skip.
6. **Harness gate.** Not `harness:'required'` → skip.
7. **Quota check.** Window `chunk:Q1`, role `worker`. Manifest says `worker: { perChunk: 2 }`. Read state: `count=1` (the first call already landed as ok). 1 \< 2, pass.
8. **Resource authorization.** No `authorize` hook → skip.
9. **Preconditions.** No `requires:` declared → skip.
10. **Timeout.** AbortController set to 60s.
11. **Execute + record.** `scrape` runs, completes in 800ms; insert `tool_invocations` row with `status='ok', duration_ms=800`.

Same call a third time: gates 1–6 pass/skip as before, then the quota check reads `count=2`, `2 ≥ 2`, **fails**, inserts a quota-exceeded row, returns 429 with `message: "Tool \"firecrawl.scrape\" exceeded quota (2/2) in window \"chunk:Q1\""` (the role lives in `meta`, not the message).

## Where the dispatcher lives

`libs/generic/tooldef/src/dispatch-stack.ts` defines `DEFAULT_DISPATCH_STACK` — the one ordered list these checks run in; `dispatch-projected.ts` drives it. If you find yourself wanting to add a custom gate inside a tool function, you're probably making a mistake. The dispatcher is the canonical place for cross-cutting concerns.
