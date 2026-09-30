# @papercusp/pot-app-seam

Host-injected seam for agentic apps that keep deterministic app state separate
from a judgment pot.

The package provides three app-facing operations:

- `bootstrapPots()` ensures the domain pot and ops pot exist once per stable
  fingerprint marker.
- `launchPlanRuns()` turns deterministic app events into canonical app-owned
  plan runs. The host must promote the plan-item DAG, preserve provenance,
  assign the actionable frontier, and acknowledge the stable agent wake.
- `startIngestLoop()` parses judged pot output events and stores accepted
  results through an injected storage port.

It imports no Papercusp operator internals. A host app supplies adapters for
pot creation, marker storage, canonical plan-run launch, and ingest storage.
The seam intentionally has no bare work-item enqueue API: agentic app events
must not bypass plan provenance, dependency edges, assignment, or dispatch.

## Template Consumption

In a materialized app that vendors the Papercusp generic libs beside the app:

```json
{
  "dependencies": {
    "@papercusp/pot-app-seam": "file:../libs/generic/pot-app-seam"
  }
}
```

If the template copies reusable libs into `vendor/papercusp/`, use the copied
path instead:

```json
{
  "dependencies": {
    "@papercusp/pot-app-seam": "file:./vendor/papercusp/pot-app-seam"
  }
}
```

The package is intentionally framework-neutral; React, Tauri, Hono, or CLI apps
all consume the same seam and wire different host adapters.
