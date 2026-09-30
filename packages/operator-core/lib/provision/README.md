# Provision substrate

Substrate primitives for plugin build-scripts: setup / teardown / verify
lifecycle, sandboxed execution, idempotency, recovery, and audit.

Spec: [/docs/snapshots/build-scripts](../../content/internal-docs/snapshots/build-scripts.mdx).

## Module layout

| Module | Responsibility |
|---|---|
| `hashes.ts` | `configHash`, `scriptHash`, `decideReprovision` |
| `state-store.ts` | `state.json` + WAL of resources recorded during a run |
| `audit-log.ts` | Append-only log per `(harness, plugin)` with size cap + truncation marker |
| `single-user.ts` | Shared-host detection (primary: `who`; secondary: `/etc/passwd`) |
| `sandbox.ts` | bwrap (Linux) / sandbox-exec (macOS) wrappers + `PAPERCUSP_DISABLE_SANDBOX` escape hatch |
| `network-policy.ts` | Cloud presets (aws/gcp/azure/cloudflare) + `${region}` templating + IMDS/RFC1918 deny floor |
| `trust-store.ts` | Per-`(publisher, plugin)` trust + key-rotation + blocklist + dev install marker |
| `operator-claims.ts` | PG-backed cross-machine lock with heartbeat |
| `runner.ts` | Orchestrates a single phase: claim → consent → sandbox → script → WAL → audit → state |
| `runtime/lib.sh` | Shell helper plugin scripts source for `papercusp_record_resource` etc. |

## Phase sequence

```
runPhase('setup' | 'teardown' | 'verify', inputs)
  │
  ├─ resolve script path (path-traversal guard)
  ├─ compute scriptHash + configHash
  ├─ readState — folds prior WAL → createdResources
  ├─ decideReprovision (setup only) — early-exit on 'unchanged' / version-patch
  ├─ consent gate (caller responsibility)
  │
  ├─ acquireClaim (PG or process-only fallback)
  ├─ startHeartbeatLoop (30s)
  │
  ├─ buildSandbox (driver=bwrap|sandbox-exec|none)
  ├─ buildNetworkPolicy (allowedHosts + denyCidrs)
  │
  ├─ spawn /bin/bash <scriptPath>  (bridged via FIFO file)
  │   ├─ stdout/stderr → AuditStream
  │   └─ FIFO writes → appendWalEntry → resource-recorded audit entry
  │
  ├─ writeState (folds WAL into state.json)
  ├─ appendAudit (succeeded | failed)
  ├─ stopHeartbeat
  └─ releaseClaim
```

## Storage layout

Per harness, per plugin:

```
~/.papercusp/harnesses/<slug>/provision/<plugin>/
  ├── state.json             authoritative state (hashes, resources, outputs)
  ├── resources.wal.jsonl    pending WAL entries (folded into state.json on next read)
  ├── audit.log              append-only audit (size-capped)
  └── scratch/               cwd handed to the script (read-write)
```

Trust + acknowledgement are global:

```
~/.papercusp/
  ├── trust.json                       per-(publisher, plugin) consent records
  └── single-user-acknowledged         one-time shared-host ack
```

## Idempotency model

Three hashes drive setup re-run decisions:

- `configHash` — sha256 of plugin config (canonicalized JSON, sorted keys).
- `scriptHash` — sha256 of the setup-script file contents.
- `pluginVersion` — semver from manifest.

| Outcome | Trigger | Behavior |
|---|---|---|
| `fresh` | no prior state | run setup |
| `unchanged` | all three match | skip |
| `script-changed` | scriptHash differs | **always** prompt — never auto-apply |
| `version-major` | major or minor changed | prompt |
| `version-patch` | patch only | skip if `skipReprovisionOnPatch: true` AND scriptHash matches |
| `config-only` | configHash differs | prompt to re-provision |

`script-changed` always wins over `skipReprovisionOnPatch` per spec — a
script-hash change implies the publisher (or attacker) shipped new
provisioning logic.

## Network policy

`buildNetworkPolicy` produces:

- **allowedHosts**: cloud-preset templates (`*.${region}.amazonaws.com`)
  expanded against the plugin's regions, plus manifest `allowedHosts`.
- **deniedCidrs**: hard-coded deny floor — `169.254.169.254/32` (IMDS),
  `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` (RFC1918), `127.0.0.0/8`,
  `fc00::/7`.

V1 emits these for the runner to enforce at the OS level (bwrap shares
network; layer-7 proxy with TLS interception is V2).

## Recovery: WAL → state.json

Plugin scripts call `papercusp_record_resource <kind> <id> [meta]` for
every cloud resource they create. The shell helper writes a JSON line to
`$PAPERCUSP_RECORD_FIFO` (a regular file in V1, true FIFO in V2). The
runner tails this file in 200ms ticks and appends each line to
`resources.wal.jsonl`.

On the next `readState` call, WAL entries are folded into
`createdResources`, deduped on `(kind, externalId)`. Even a SIGKILL of
the script preserves what was recorded — the WAL is append-only.

If setup partially succeeds (steps 1–2 of 5 record resources, step 3
fails), the substrate has full visibility into what to tear down.

## Trust + key rotation

Trust is per-`(publisher, plugin)`. Granting trust to `@papercupai/aws-lambda`
does NOT auto-trust `@papercupai/x`.

Each trust entry records the publisher's signing-key fingerprint at the
time of grant. If the publisher rotates keys, the trust entry's
fingerprint no longer matches, and `checkTrust` returns
`reason: 'key-rotated'` — the user re-confirms once.

Per spec, V1 expects rotation events to be **marketplace-countersigned**
before the substrate accepts them as legitimate. The substrate stores
the rotation events but the marketplace-side signing flow is outside
this codebase.

## Single-user host detection

V1 explicitly targets single-user dev/desktop. On first run:

1. Primary signal: `who | awk '{print $1}' | sort -u | wc -l > 1`.
2. Secondary: `/etc/passwd` users with UID ≥ 1000 + `/home/<name>` + valid login shell.

Either trigger gates a one-time acknowledgement. Once acknowledged, the
banner doesn't reappear unless the host's user-set signature changes.

## Test coverage

```
hashes.test.ts             13 tests
state-store.test.ts         6
audit-log.test.ts           5
single-user.test.ts         5
trust-store.test.ts         9
network-policy.test.ts     10
sandbox.test.ts             2
runner.test.ts              7
```

Total: **57 unit tests + 7 integration tests** across 9 modules.

## Wiring into the host

`apps/operator/app/api/provision/{run,state,consent,host-check}/route.ts`
expose the substrate as REST endpoints. The settings/plugins page and
the harness dashboard call these to drive setup/teardown/verify with a
streaming audit log + recorded-resources view.

`apps/operator/lib/plugin-host-runtime.ts` extends each plugin's
`PapercuspContext` with `ctx.recordResource()` (writes to the WAL via
the same path the shell helper uses) and `ctx.oauth.token()`.
