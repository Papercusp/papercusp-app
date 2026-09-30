# Substrate flag-flip runbook — what to do when you enable the Hyperbee substrate
URL: /internal/docs/agent-insights/substrate-flag-flip-runbook

Step-by-step procedure for flipping PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE=1, what to expect at each stage, how to verify success, and how to roll back cleanly if something goes wrong.

import { Aside } from '@astrojs/starlight/components';

The `PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE` opt-in gate **was removed** with the
Model B substrate rewrite — the substrate now **always boots** in-process and
no code reads the env var (it survives only in "the gate was removed" comments
in `in-process-status.ts` / `share-finalize.ts`, and setting it in `.env.local`
is a no-op). This whole "set the env var → restart → verify the flag took
effect → roll back by unsetting it" procedure is therefore **obsolete**. What
is still real and useful below: the diagnostic surfaces (`substrate:status`
CLI, `/admin/dogfood-substrate`, `/api/admin/dogfood-substrate-health`,
`/api/harness/<slug>/claim-attempts`, the boot-history table) and the
boot-error troubleshooting table — read those as "verify the always-on
substrate," not "verify the flag." (Note: step 5's `<HarnessChromeHeaderBadges>`
component does not exist; the live pills are `SubstrateHealthPill` /
`BootstrapProgressIndicator` in `app/harness/insights/`.) For the current
diagnostic walkthrough see [Substrate diagnostic stack](/internal/docs/agent-insights/substrate-diagnostic-stack).

## Before you start

* This is a **one-process toggle** — restart the operator after editing the env var. It is not picked up live.
* Substrate boot opens real Hyperswarm peer connections + writes to local
  Hypercore stores under `~/.papercusp-workspaces/<workspace>/.papercusp/<harness>/hyperbee/`.
  Leaves disk artefacts after the first run; rolling back the flag does NOT delete them.
* Native dependencies must be installed (corestore, hypercore, autobase,
  hyperswarm, b4a). If `npm install` skipped them (rare; usually
  `--no-optional` or similar) the boot fails fast in `boot-history`
  with a clear error.
* Has **no effect** on the legacy single-writer claim path. The
  orchestrator only switches to the distributed path if your code calls
  `getClaimStrategy()` — see "Orchestrator wiring" below.

## Steps

### 1. Set the env var + restart

```bash
export PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE=1
# kill -HUP / restart the operator process so instrumentation-node.ts
# picks it up.
```

### 2. Verify the flag took effect

```bash
cd apps/operator && npm run substrate:status
```

Or open `/admin/dogfood-substrate` in a browser.

Expected:

```
Substrate flag: ✓ ON   booted: 0 harnesses
  → flag is on but no handles in boot map yet.
```

If you see `· off`, the env var didn't propagate — check whether you
restarted the right process.

### 3. Wait for harnesses to boot

`instrumentation-node.ts` boots harnesses in parallel during startup
(typically `<30s` for a handful of harnesses on local disk). The boot
table on `/admin/dogfood-substrate` populates as each one comes up.

If a boot **fails**, the `boot-history` section at the bottom of the
page shows the error message. Common causes:

| Error pattern               | Likely cause                                              |
| --------------------------- | --------------------------------------------------------- |
| `corestore lock contention` | Two processes opening the same store. Kill the other one. |
| `bootstrap timeout`         | Hyperswarm can't reach any peer (firewall / no internet). |
| `schema_version mismatch`   | A peer is on a newer Papercusp. Update or wait.           |
| `permission denied`         | Disk perms on `~/.papercusp-workspaces/...`.              |

### 4. Check the health verdict per harness

```bash
curl http://127.0.0.1:3070/api/admin/dogfood-substrate-health | jq
```

Or look at the per-row `SubstrateHealthPill` on the admin page. Verdict
should be `healthy` once boot completes and no claim attempts have
errored.

### 5. (Optional) Surface in chrome

Drop `<HarnessChromeHeaderBadges slug={...} />` into the harness header
to show the 3-pill row (status / health / bootstrap) live in-app.

### 6. (Optional) Wire orchestrator

The distributed claim path is off until production code calls
`getClaimStrategy()` + branches. This is a code change, not a runtime
toggle — see `lib/orchestrator/distributed-claim.ts` for the pattern.

## What you'll see when things go well

* `/admin/dogfood-substrate` top bar: green "Substrate live" pill +
  green health pill with `N✓` count.
* Per-harness row: green health pill + bootstrap "Up to date" pill.
* Boot history: 1 boot\_start + 1 boot\_ok per harness.
* `substrate:status` CLI exits 0.

## What you'll see when things go wrong

* Top bar: green "Substrate live" but yellow/red health pill.
* Per-row: health pill in `degraded` or `unhealthy` state. Tooltip
  lists the reasons (e.g. `claim error rate 30% ≥ 25%`).
* Boot history: `boot_fail` rows with the error message.
* `substrate:status` CLI exits 1.

## Rolling back

The flag is a no-op when unset. To disable:

```bash
unset PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE
# restart the operator
```

What happens:

* Substrate boot is skipped on the next start.
* The boot map stays empty.
* `attemptDistributedClaim` returns `substrate-not-booted` for every
  call — production code falls back to the legacy single-writer path.
* Health pill shows `disabled`.
* The on-disk Hypercore stores from previous boots stay where they
  are (safe to leave; harmless when not opened).

To wipe the on-disk substrate entirely (use only if rotating keys
or starting fresh):

```bash
rm -rf ~/.papercusp-workspaces/*/.papercusp/*/hyperbee/
```

## Telemetry checkpoint

After the first 24h with the flag on, sanity-check:

* `/api/admin/dogfood-substrate-boot-history?kinds=boot_fail` — should
  be empty or only show transient errors.
* `/api/harness/<slug>/claim-attempts?stats=1` — `error` count should
  be \< 5% of `total`.
* `/api/admin/dogfood-substrate-health` — every harness `healthy`.

If any of these stay degraded for hours, file an issue with the boot-
history entries attached.

## Related docs

* [Substrate diagnostic stack](/internal/docs/agent-insights/substrate-diagnostic-stack)
* [Dogfood v5 readiness map](/internal/docs/agent-insights/dogfood-v5-readiness-map)
