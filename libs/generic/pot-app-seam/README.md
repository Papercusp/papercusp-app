# @papercusp/pot-app-seam

Host-injected seam for agentic apps that keep deterministic app state separate
from a judgment pot.

The package provides these app-facing operations:

- `bootstrapPots()` ensures the domain pot and ops pot exist once per stable
  fingerprint marker.
- `submitOperations()` submits app requests as durable blueprint operations.
  Each draft carries a request key derived from the app's own domain ids
  (`deriveRequestKey(operationId, ...domainParts)`), so a resubmitted request
  replays the original handle instead of minting a second execution, and the
  same key with different input is refused.
- `operationStatus()`, `operationEvents()` and `cancelOperation()` read the
  operation's state and event stream and request cancellation through the
  returned handle.
- `operationResult(handle, parse)` returns a `ready` output only after it
  passes the app's parse gate; a rejected output throws
  `OperationOutputRejectedError` and none of it reaches the caller.
- `startIngestLoop()` parses judged pot output events and stores accepted
  results through an injected storage port.

It imports no Papercusp operator internals. A host app supplies adapters for
pot creation, marker storage, blueprint operations, and ingest storage.
`blueprintOperationHostFromInvoker(invoke)` builds the operation adapter from
any function that calls the public `blueprint:*` tools by name
(`BLUEPRINT_OPERATION_TOOL_NAMES`). The seam intentionally has no bare
work-item enqueue API: an app request runs as a durable operation, never as a
loose work item.

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
