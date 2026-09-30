# Orchestration security and replayability contract
URL: /internal/docs/agent-insights/orchestration-security-and-replayability-contract

Normative P-005 contract for current-caller reauthorization, secret isolation/redaction, binding lifetimes, capability admission, replay classes, and durable recovery.

# Scope

This is the normative P-005 security and replayability contract for the model-facing orchestration suite. It governs inline scripts, saved-recipe replay, and any future DBOS-backed durable execution of the same exact recipe revision.

It refines the P-003 public API and P-004 recipe-script representation under plan decisions D-012, D-013, D-015, D-020, D-022, and D-024. It introduces no client backend, no second orchestration representation, no authority token carried from recipe authorship, and no parallel secret store.

The contract has two enforcement moments:

1. **Preflight** rejects every foreseeable authorization, binding, capability, topology, lifecycle, secret, and replay-safety mismatch before the first nested dispatch.
2. **Nested dispatch** re-authorizes every call under the current caller through the real projected-tool dispatcher. Preflight is never a reusable grant.

A successful inspection, saved recipe, capture record, replay trace, DBOS checkpoint, or prior invocation cannot authorize a later invocation.

# Normative language

The words MUST, MUST NOT, SHOULD, and MAY are normative. “Current caller” means the principal, role, workspace, harness, fleet/lane ownership, capability envelope, and live resource authority established for the invocation that is executing now—not the recipe author, capturer, inspector, scheduler, or prior runner.

# Shipped baseline and conformance gap

The current implementation already establishes important parts of this contract:

* `code:run` constructs its facade with `roleScopedToolNames(..., ctx.role, ...)`, dispatches through `PROJECTED_DEPS`, and uses `bindInnerDispatch` to reproduce direct-call workspace, principal, transaction, and async-local binding for every nested call.
* `recipes:run` constructs its facade from the **reuser’s** `ctx.role`, never `recipe.authorRole`; validates the current recipe revision and descriptor-derived authority; and compares plan, item, and resource references with the reuser’s live lane before execution.
* The worker runtime records dispatch attempts and preserves rejected, uncertain, semantic-failure, and not-dispatched write truth.

Two gaps are requirements, not shipped claims:

1. `recipes:run` currently calls `runToolOrchestration` without `code:run`’s per-call `bindInnerDispatch` wrapper. Conformance requires one shared current-caller dispatch wrapper used by inline, saved-recipe, and durable paths.
2. Current `code:run` log shaping removes ANSI/control noise, but the inspected orchestration paths do not establish a central provenance-aware secret-redaction boundary. Conformance requires the boundary defined below.

No downstream implementation may describe those gaps as already solved.

# Current-caller authorization

## One shared nested-dispatch wrapper

All orchestration sources MUST enter one shared nested-dispatch wrapper before the real dispatcher:

```ts
type OrchestrationDispatchContext = {
  currentCaller: {
    principal: Principal;
    role: AgentRole;
    workspace: string;
    harness?: string;
    ownerId?: string;
    fleet?: string;
  };
  runId: string;
  sourceRevision: string;
  dispatchOrdinal: number;
  lifecycle: "foreground" | "background";
};
```

The wrapper MUST:

1. derive the allowed tool facade from the current `ctx.role` and current projected catalog;
2. exclude recursive orchestration entry points where the existing runner excludes them;
3. route through the real dispatcher and its capability-envelope, quota, audit, telemetry, post-invoke, and authorization hooks;
4. reproduce direct-call per-call workspace resolution, synthesized principal, short workspace transaction, and async-local workspace binding;
5. preserve explicit full-value semantics for intermediate script values without weakening the outer model-facing result door;
6. attach run and dispatch identity needed for truthful accounting and durable checkpointing; and
7. apply the secret/output boundary before a child result can become script-visible, logged, captured, checkpointed, or returned.

`code:run`, `recipes:run`, and a DBOS durable adapter MUST call this same wrapper. Copying only the role allowlist is insufficient.

## No author privilege

A recipe stores source, revisioned metadata, provenance, and stable authority references. It MUST NOT store or reactivate:

* the author’s role, principal, capability envelope, superuser status, workspace transaction, account route, or authentication material;
* the author’s live plan/item claim, lock lease, session identity, or coordination cursor; or
* an inspection/preflight verdict as an authorization token.

The author role MAY remain historical display metadata, but it MUST never participate in the execution allowlist or dispatcher context.

Recipe inspection and search MAY return an exact revision plus authority continuation. On run, the runtime MUST recompute the descriptor from the stored revision, compare the continuation with that revision, and revalidate every stable entity reference against the current caller’s live context. A mismatch or unavailable live context fails closed.

## Preflight and dispatch are both mandatory

Preflight MUST validate all statically knowable requirements before execution. The real dispatcher remains the final authority for each call because roles, capabilities, claims, service availability, and locks can change after preflight.

If authority is revoked between calls, the next call fails under the current state. The runtime MUST NOT reroute, borrow author privilege, or claim the earlier side effects did not execute.

# Binding lifetime contract

The P-003 `BindingSchema` is extended with a required lifetime classification for each property:

```ts
type BindingLifetime =
  | { kind: "stable" }
  | { kind: "resolved-ref"; refKind: "resource" | "secret"; resolution: "each-run" | "each-use" }
  | { kind: "invocation-ephemeral" };

type BindingProperty = {
  type: "string" | "number" | "integer" | "boolean" | "json" | "secret-ref" | "resource-ref";
  required?: boolean;
  description?: string;
  lifetime: BindingLifetime;
};
```

## Stable values

Stable values are deeply frozen JSON data whose meaning does not depend on a live session, process, lease, cursor, or temporary filesystem location. They MAY be stored with a recipe run and MAY participate in a durable run’s immutable input digest.

A value being JSON-serializable does not make it stable. Stability is semantic and is checked against both the schema and known volatile shapes.

## Re-resolved references

A `resource-ref` or `secret-ref` stores an opaque logical reference, never the resolved value. It MUST be re-resolved under the current caller at the declared boundary:

* `each-run` before execution for versioned immutable resources whose authorization and revision can be proven for the run;
* `each-use` at the consuming tool boundary for secrets and mutable resources whose live authorization or value may change.

Resolution MUST verify workspace, resource kind, revision policy, caller authorization, and availability. A reference is replay-safe only if its resolver is deterministic for the required scope or the resolved use is checkpointed with a safe disposition.

## Invocation-ephemeral values

The following raw handles are invocation-ephemeral unless a owning subsystem exposes a distinct typed durable reference:

* session/owner IDs and short owner selectors;
* PTY IDs, operating-system PIDs, process IDs, and unmanaged job handles;
* claim IDs, lock IDs/leases, coordination cursors/message cursors, and request/transport IDs;
* temporary paths and run-scoped artifacts;
* live foreground task handles whose owner does not promise durable reattachment.

A managed durable task reference or versioned artifact/resource reference is not ephemeral merely because its backing implementation has a process ID; only the typed durable reference may be persisted.

Invocation-ephemeral values MAY flow between calls inside one foreground run. They MUST NOT be:

* stored in a recipe revision or captured binding set;
* emitted in a replay continuation;
* persisted as a DBOS workflow input or checkpoint identity;
* hard-coded in saved source; or
* treated as live authority on a later run.

Their presence classifies the run `non-replayable` and makes it ineligible for background execution. A hard-coded ephemeral literal or an attempt to persist one fails preflight. A dynamically produced ephemeral handle is allowed only in the current foreground run and is redacted or replaced with a safe opaque result reference before the model-facing boundary.

# Secret contract

## References, not plaintext bindings

Secret bindings MUST use `secret-ref`. Inline secret plaintext is rejected even if the property name is not obviously sensitive. A secret reference identifier is metadata and MUST reveal no secret value.

The script receives no resolved secret in `inputs`. Resolution happens only after the consuming nested tool has itself been authorized. The resolver SHOULD inject the value directly into the authorized consumer or return an opaque one-use capability; it MUST NOT return plaintext to general script code.

A recipe, run trace, capture row, DBOS input/checkpoint, task record, telemetry row, log, diagnostic, output reference, or model-facing result MUST NOT contain a resolved secret.

## Central redaction boundary

Every nested result and every final output MUST cross one shared provenance-aware sanitizer before it reaches:

* the script worker;
* logs or child-failure/write-truth collections;
* recipe capture, run history, task state, or DBOS checkpoints;
* telemetry/audit metadata not explicitly designed for secret custody;
* the result door, overflow/reference store, or reference-expansion path; and
* image/audio metadata or textual media descriptions.

The sanitizer MUST combine structural policy with secret provenance. Key-name regexes alone are insufficient. At minimum it tracks values resolved by the secret subsystem, recursively redacts known secret-bearing fields, protects stringified/encoded occurrences where provenance is retained, and uses a fixed non-reversible marker such as `[REDACTED_SECRET]`.

Redaction metadata MAY report counts and safe field paths. It MUST NOT report plaintext, reversible hashes of low-entropy secrets, or enough prefix/suffix material to reconstruct a value.

If the runtime cannot prove that a value is safe to expose, it fails closed:

* before dispatch: return a `phase:"preflight"`, `executed:false` secret diagnostic;
* after any dispatch: withhold the unsafe payload, return `phase:"execution"`, `outputWithheld:true`, preserve write dispositions, and never imply rollback.

A redaction failure MUST NOT be converted into an unredacted “debug” payload.

# Capability and topology admission

The runtime derives statically visible tool calls and merges them with the exact revision’s manifest. Before the first dispatch it MUST validate:

1. manifest and binding-schema versions;
2. every declared logical requirement;
3. every statically proven call is declared;
4. the current caller may use the required projected tool/capability;
5. the service or server capability family is available now;
6. lifecycle and output-kind support;
7. replay/idempotency safety for the requested lifecycle; and
8. every topology premise, including mandatory `host:same`.

Unknown, undeclared, denied, unavailable, or topology-invalid requirements fail closed. Dynamic tool-name construction is foreground-only unless the implementation can prove its closed set at inspection time; it is never admitted to durable execution as “probably safe.”

Capability escapes remain server-side nested calls. `execution:shell`, `execution:pty`, `execution:background-task`, and media capabilities do not select a backend. There is no client route and no mid-run backend failover.

A successful preflight records an observation, not a grant. Each nested dispatch repeats current-caller authorization. If a requirement becomes unavailable after side effects, the run stops honestly with an execution failure and prior dispositions intact.

# Replayability model

The stored manifest’s `replay.class` is an assertion to check, never authority and never sufficient by itself. The runtime derives the effective class from source, bindings, requirements, tool metadata, and lifecycle, and MAY only downgrade the author’s assertion.

The existing P-004 classes mean:

* **`read-only`** — no dispatched effect mutates state. A fresh intentional rerun is permitted, but live reads may return different data.
* **`idempotent`** — every mutating step advertises retry-safe/idempotent execution and receives a stable idempotency key derived from run ID, exact source revision, and dispatch ordinal.
* **`checkpointed`** — crash recovery reuses each stored settled step result and does not redispatch it. This permits DBOS recovery; it does not make a whole-run manual rerun safe.
* **`non-replayable`** — the run contains invocation-ephemeral state, ambient nondeterminism that changes dispatch order, an uncertain/non-idempotent effect, or a requirement that cannot be safely checkpointed. It is foreground-only.

The effective trace also records a portability dimension:

* **portable** — stable values and logical re-resolved references only;
* **topology-bound** — valid only while declared premises such as `host:same` hold;
* **invocation-bound** — contains ephemeral state and cannot be replayed or resumed after the invocation.

“Deterministic” means the exact source revision, immutable stable inputs, and checkpointed step results reproduce the same control decisions and dispatch ordinals during recovery. It does not claim that an independent rerun of live external reads returns identical values.

## Durable execution

A durable run MUST:

1. persist the exact recipe revision, binding schema, manifest, and stable input digest before execution;
2. reject invocation-ephemeral bindings and uncheckpointed ambient clock/random input that can alter dispatch order;
3. derive step identity from immutable run ID, recipe revision, and deterministic dispatch ordinal;
4. checkpoint each nested dispatch, not the whole script as one opaque step;
5. never redispatch a settled checkpoint after recovery;
6. automatically retry only a proven pre-dispatch failure or an advertised idempotent step with a stable key;
7. stop on uncertain writes and preserve the uncertainty; and
8. re-authorize the current durable-run principal at every newly dispatched step.

A DBOS checkpoint carries execution evidence, never reusable authority. Restoring a workflow does not restore a recipe author’s or prior session’s privileges.

# Capture and provenance

Recipe capture stores only:

* source and its exact revision inputs;
* versioned binding schema and capability manifest;
* stable values or opaque re-resolved references allowed by this contract;
* non-authorizing authorship/provenance metadata; and
* sanitized descriptive metadata.

It MUST NOT store resolved secrets, invocation-ephemeral values, a prior principal, an authorization verdict, or a live lease/claim as executable authority.

Every run trace SHOULD record enough sanitized provenance to explain and audit execution:

* exact recipe/source revision and manifest/binding-schema versions;
* effective caller role, workspace, harness, and stable live authority references;
* preflight decisions and effective replay/portability class;
* nested tool name, dispatch ordinal, effect class, idempotency/checkpoint identity, and disposition;
* requested/effective timeout and cancellation;
* capture outcome and output/reference identity; and
* redaction/withholding counts without sensitive values.

Trace and reference expansion MUST use the same redaction policy as the initial result. A later expansion cannot reveal content withheld at creation.

# Failure contract

Pre-dispatch failures use the P-003 envelope with `phase:"preflight"` and `executed:false`. P-005 adds these codes where applicable:

```ts
type SecurityReplayabilityError =
  | "caller_context_unavailable"
  | "recipe_authority_stale"
  | "recipe_authority_mismatch"
  | "binding_secret_inline"
  | "binding_ephemeral_persisted"
  | "secret_resolution_denied"
  | "secret_resolution_unavailable"
  | "secret_redaction_failed"
  | "replayability_mismatch"
  | "durable_replay_unsafe"
  | "capability_undeclared"
  | "capability_denied"
  | "capability_unavailable"
  | "topology_premise_failed";
```

After the first nested dispatch, the runtime uses `phase:"execution"` and MUST NOT claim `executed:false`. It preserves the existing `writeAttempts`, rejected/uncertain/not-dispatched mutations, child failures, cancellation state, and output-withheld truth.

There is no speculative fallback, privilege borrowing, whole-run retry after an uncertain effect, or conversion of a security failure into a partial unredacted result.

# Compatibility and migration

* Existing `code:run` remains the primary foreground engine and is conformant only when its existing wrapper is extended with the central secret/output boundary.
* Existing `recipes:run` remains the saved-recipe compatibility door. Before P-005 conformance it MUST adopt the same shared dispatch wrapper rather than maintaining a near-copy.
* Existing recipes without versioned binding/manifest metadata MAY run foreground only when the runtime derives a complete legacy manifest and proves no secret/ephemeral ambiguity. Otherwise they fail closed and must be recaptured.
* Legacy recipes are never admitted to background execution when dynamic calls, bindings, capability requirements, or replay safety are unprovable.
* A future durable adapter wraps the exact saved recipe revision in DBOS and the task manager. DBOS does not become an authority source, secret store, representation, or public backend.
* Native client shell/code tools remain direct compatibility doors only during D-016/D-017 rollout. No orchestration source routes to them.

# Acceptance criteria

P-005 is satisfied when implementation and conformance tests prove:

1. inline, saved-recipe, and durable paths use one current-caller nested-dispatch wrapper;
2. every nested call reaches the real dispatcher with per-call workspace/principal/transaction/async-local rebinding;
3. a recipe authored by a more privileged role gains no privilege when reused by a less privileged caller;
4. recipe revision, stable authority references, and the reuser’s live lane are revalidated at run time;
5. inspection/preflight output cannot be replayed as authorization;
6. inline secret plaintext is rejected and resolved secrets never enter `inputs`, logs, traces, captures, checkpoints, output references, or final results;
7. redaction is shared by nested results, final results, reference creation, and reference expansion, and uncertainty withholds rather than leaks;
8. binding lifetime checks allow stable values/re-resolved refs, reject persisted ephemeral handles, and mark dynamic foreground ephemeral flows non-replayable;
9. the effective replay class is derived and cannot be upgraded by manifest assertion;
10. durable recovery checkpoints nested dispatches and does not duplicate settled effects;
11. retries occur only pre-dispatch or under an advertised idempotency contract with a stable key;
12. unknown/undeclared/denied/unavailable capabilities and failed `host:same` premises stop before the first dispatch;
13. post-dispatch failures preserve truthful write and output-withheld dispositions; and
14. no recipe stores author privilege, resolved secret, client backend, DBOS implementation identifier, or a second orchestration representation.
