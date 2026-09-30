# @papercusp/deployment-driver

Provider-agnostic deployment abstraction. "Deploying" a harness moves its
**execution plane** onto a **frame** (a machine the driver controls) that joins
the harness/Pot as a headless federated peer.

The package also exposes a deliberately separate `WorkspaceHostProvider`
contract for durable cloud workspace hosts. A workspace host contains the full
operator and user data; it is not a renamed deployment frame and never inherits
frame cattle semantics.

```ts
import {
  resolveDeploymentDriver,
  isLocalDeployment,
  configureDeployment,
  type DeploymentConfig,
  type DeploymentDriver,
} from '@papercusp/deployment-driver';

// Host bootstrap: register cloud backends (LocalDriver is built-in).
configureDeployment({ drivers: [LatitudeDriver] });

// At instantiation / dispatch:
const cfg: DeploymentConfig = { target: 'latitude', region: 'NYC', kind: 'vm' };
if (!isLocalDeployment(cfg)) {
  const driver = resolveDeploymentDriver(cfg);
  const frame = await driver.provision(cfg, ctx);
  await driver.install(frame, cfg, ctx);
  await driver.join(frame, cfg, ctx);
  // … run … then
  await driver.teardown(frame, cfg, ctx); // DESTROY for cloud → ends billing
}
```

## Model

- **`DeploymentConfig`** — a sibling input to the blueprint (NOT a blueprint
  property; D-001). `target` selects the driver; provider-specific fields live
  under `provider`.
- **`DeploymentDriver`** — `provision` / `install` / `join` / `teardown` over a
  `Frame`. `local` is the trivial built-in no-op (the machine is already here);
  every cloud backend implements the same four verbs and registers via the
  `configure*()` seam.
- **`Frame`** — a handle to a provisioned machine; persisted host-side so
  teardown survives process restarts.

### Durable workspace hosts

`WorkspaceHostProvider` reuses the open target and injected-registry pattern,
without extending the old four-verb lifecycle. It specifies connection and
catalog discovery, price estimates, three separate typed credential references,
`plan` → one-resource `apply` → `reconcile`, the full retained-data lifecycle,
capability-declaring transport profiles, and health attestation. Stop preserves
data; destroy requires a disposition and a fresh provider-read absence proof.

There is no implicit local workspace-host provider. Concrete backends register
through `configureWorkspaceHostProviders({ providers })` at host bootstrap.

`WorkspaceHostDurableWorkflowSpec` is the provider-neutral controller contract
that sits above those adapters. It gives one client operation a stable DBOS
workflow id, serializes desired mutations per host, records every logical
resource plan before the first provider call, and makes an interrupted
`applying` checkpoint resume through `reconcile` with the same provider
idempotency key. Retry classes distinguish bounded transient/throttled retries
from ambiguous results and terminal failures. Cancellation first resolves any
in-flight ambiguity, then compensates only operation-created resources in
reverse dependency order; retained data and pre-existing resources are explicit
non-targets. Destroy remains blocked until every delete target carries a fresh
provider-read absence receipt.

The eventual operator controller should adapt DBOS's idempotent registration,
queue isolation, per-resource `runStep` checkpoints, and injected-executor test
seams. It must not route workspace hosts through the existing whole-plugin
provision workflow or its `provision_state` JSONB blob. The provision audit bus
is reusable as an implementation pattern for workspace-host events, but its
harness/plugin-keyed table is not the workspace-host state model.

`runFakeWorkspaceHostProviderContractSuite` is the mandatory adapter preflight.
It drives a deterministic in-memory backend through discovery, stable planning,
one-resource apply, same-identity reconciliation, observation/transport/health,
and fresh-read confirmed destroy. `DeterministicWorkspaceHostFaultInjector`
adds exact before-call and timeout-after-success failures without sleeps or
randomness.

Real accounts use `WorkspaceHostLiveCanaryHarness`, never the fake runner. The
harness refuses provider work until a current contract report is explicitly
approved, caps cumulative spend at USD 25 (or a lower run cap), emits immutable
run/workspace tags, tracks teardown deadlines and orphan census results, stores
only typed credential references, and requires both provider cost evidence and
fresh-read deletion receipts before completion. Emergency native cleanup is
recorded with `createWorkspaceHostManualDestroyReceipt`; a successful delete
request without an absence read is not a receipt.

Generic + host-clean: the frame surface names no provider except `local`; the
workspace-host surface names none. Each backend narrows and validates its own
provider state host-side. The contracts stay separate because their ownership
and lifecycle guarantees differ.
