# Testing — @papercusp/deployment-driver

Vitest, colocated `*.test.ts`. Run: `npm test -w @papercusp/deployment-driver`
(or `npx vitest run` in this dir).

Covered:

- **`local-driver.test.ts`** — LocalDriver declares `target/placement = local`,
  `provision` returns the singleton local frame, and `install/join/teardown` are
  resolving no-ops.
- **`registry.test.ts`** — LocalDriver registered by default; `register` /
  `configureDeployment` add cloud backends; re-register replaces; resolving an
  unknown target throws a descriptive error; `isLocalDeployment` placement logic
  (local/absent/unregistered → true, registered-remote → false); a fake remote
  driver is driven through the full provision→install→join→teardown lifecycle.
- **`workspace-host-registry.test.ts`** — full durable-host lifecycle coverage,
  type-distinct credential channels, fresh-read destroy proof, no implicit local
  provider, and open-target register/configure/replace/resolve behavior.
- **`workspace-host-workflow.test.ts`** — stable DBOS/dedup identities,
  record-before-depend ordering, ambiguous recovery, bounded retries,
  cancellation compensation, and confirmed destroy.
- **`workspace-host-test-harness.test.ts`** — reusable fake-adapter conformance,
  deterministic before/after-success fault injection, contract-approval gate,
  USD 25 hard cumulative canary ceiling, mandatory resource tags, teardown
  watchdog, orphan census, secret isolation, provider cost evidence, and
  emergency manual-destroy receipts.

Not covered here (lives with the consumers): the harness:create threading of
`deployment` (operator-core), the orchestrator placement gate, and the concrete
cloud drivers (LatitudeDriver) which validate their own provider config.
