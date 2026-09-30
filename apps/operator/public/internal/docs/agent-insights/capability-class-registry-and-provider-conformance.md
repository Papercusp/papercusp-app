# Capability classes — registry, conformance, and provider bindings
URL: /internal/docs/agent-insights/capability-class-registry-and-provider-conformance

How to define job-scoped capability contracts, discover exact versions, validate provider tools against the live projected registry, and interpret the immutable run-derived provider bindings.

# Capability classes — registry, conformance, and provider bindings

Capability classes are versioned, vendor-neutral interface contracts. A class names a narrow job (for example `crm.email@1.0.0`) and declares the JSON Schema for each logical verb. Provider packages implement those verbs with real projected MCP tools and earn a binding only by passing structural conformance against the live registry.

This extends the existing datatype-registry pattern: definitions are local, versioned, searchable records; later Cupboard work distributes reviewed definitions. It does not create a second marketplace.

## The invariants

* Define job-scoped classes, not vendor-shaped bundles. Prefer a small interface such as `storage.object-read` over a provider's entire API.
* A published `id@version` is immutable. An identical `classes:define` replay is a no-op; changed contract bytes require a new semantic version.
* Provider conformance is derived evidence. Callers never set a `conformance_status` field. `classes:validate` reads the actual projected-tool schemas and their registry revision, then records the result.
* Every validation attempt is retained in `capability_class_conformance_runs`. A failed run cannot create or replace a provider binding.
* The database FK requires a binding to reference a passing run for the same workspace, class version, provider package, and provider version. The binding does not duplicate `verb_bindings`; reads derive that map from the attested run.
* `classes:get` reports providers by joining the binding to its passing run. Treat that join—not a provider claim or a copied emitter list—as the source of truth.
* Publisher/review status, provider conformance, and runtime authorization are separate decisions. Passing conformance does not grant a principal permission to call the provider.

## Storage model

Migration `1140-capability-class-registry.sql` creates four workspace-scoped tables. Migration `1141-enforce-capability-class-passing-bindings.sql` forward-hardens the provider/run relationship after 1140: it adds the exact-identity passing-run FK and removes the duplicated verb map.

| Table                                | Meaning                                                                                                               |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `capability_class_registry`          | Immutable `id@version` definition, discovery fields, lifecycle/review state, and optional behavioral-suite reference. |
| `capability_class_conformance_runs`  | Append-only structural result, exact registry revision, verb mapping, report, and future behavioral status.           |
| `capability_class_provider_bindings` | Active provider implementation backed by one matching passing conformance run.                                        |
| `pot_capability_class_bindings`      | Referentially safe remembered provider choice for a pot; P-017 owns selection policy.                                 |

All four tables use workspace RLS. Approved class definitions also have the global read policy used by reviewed registry content.

## Define a class

`classes:define` is platform-only in v1 and requires an operator. Class ids are normalized namespaced ids, versions are semantic versions, and every verb schema must compile as JSON Schema.

```json
{
  "id": "crm.email",
  "version": "1.0.0",
  "title": "Send and inspect email",
  "description": "A narrow email job contract independent of provider.",
  "verbs": {
    "send": {
      "inputSchema": {"type": "object", "properties": {"to": {"type": "string"}}, "required": ["to"]},
      "outputSchema": {"type": "object", "properties": {"messageId": {"type": "string"}}, "required": ["messageId"]}
    }
  },
  "tags": ["crm", "email"]
}
```

An optional `behavioralSuiteRef` reserves the behavioral gate. P-016 does not pretend that suite ran: validation reports `not-run` when the hook exists and `not-required` otherwise.

## Discover and inspect

Use `classes:list` before defining or granting a class. `query` fuses full-text rank with the stored embedding when embedding is available; `tag`, `includeInactive`, `includeVersions`, and `limit` are explicit filters. By default the newest matching version per id is returned.

Use `classes:get { ref }` (or `refs`) for the exact contract and its attested providers. A provider shown there is backed by the immutable passing run identified by `conformanceRunId`; the row also carries the projected registry revision used for the proof.

## Validate a provider

After the provider has registered its tools, map every logical class verb to the real projected MCP tool name:

```json
{
  "classRef": "crm.email@1.0.0",
  "providerPackage": "example-mail-plugin",
  "providerVersion": "2.3.0",
  "verbBindings": {"send": "mail:send"}
}
```

`classes:validate` resolves each named tool from `listAllProjectedTools()`, requires the exact provider-package owner, and compares canonical input and declared output schemas byte-for-byte after canonical JSON ordering. Missing verbs, extra verbs, missing tools, owner mismatches, and schema mismatches all fail the run.

The response always includes `runId` and the conformance report. On success it also includes the installed provider binding. On failure it says no binding changed; inspect `conformance.checks[].problems` rather than inferring from the top-level boolean alone.

## Behavioral and selection boundaries

P-016 proves structural compatibility only. A future behavioral runner may advance `behavioral_status` and attach `behavioral_run_ref`, but no caller-provided success flag is accepted. P-017 owns provider resolution and the one-provider-per-class pot picker; P-016 supplies only the FK-safe binding seam. Cupboard proposal/review and cross-install distribution are later registry work.

## Code and verification map

* Base migration: `libs/papercusp/libs/db/sql/1140-capability-class-registry.sql`
* Passing-run forward guard: `libs/papercusp/libs/db/sql/1141-enforce-capability-class-passing-bindings.sql`
* Store and pure conformance logic: `packages/operator-core/lib/capability-class-registry-store.ts`
* Tool handlers: `packages/operator-core/lib/agent-tools/classes/`
* Pure guard: `capability-class-registry-store.test.ts`
* Real-Postgres 1140→1141/store guard: `capability-class-registry.integration.test.ts`
* Projected-tool registration guard: `agent-tools/tool-alias-contract.test.ts`
