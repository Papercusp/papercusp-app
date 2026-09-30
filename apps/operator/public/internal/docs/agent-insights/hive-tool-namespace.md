# The pot:* tool namespace — local pot lifecycle
URL: /internal/docs/agent-insights/hive-tool-namespace

The pot:* namespace is the full LOCAL pot lifecycle (a kind:'hive' harness + its Mug/cups) — list/get/create/dissolve/update plus the Mug run-loop verbs (start/pause/wake/declare-wake/status/survey). Gotchas — create/dissolve/update are root-only; create must stamp harness_kind:'hive' (harness:create doesn't); deploy:pot is a DISTINCT cloud step; cup placement stays fleet:*.

import { Aside } from '@astrojs/starlight/components';

The tool NAMES in this namespace were renamed `hive:*` → `pot:*` (the Pot rename,
WI-2932). The underlying entity/identifier vocabulary is UNCHANGED (for now — the
DB-value rename is Slice H, sequenced last) — the code still lives under
`packages/operator-core/lib/agent-tools/hive/`, the harness marker is
still `harness_kind:'hive'`, `resolveHive`/`createHiveHarness` keep their names, and
the shared-pot FEDERATION concept (a remote/joined pot across the P2P network)
still says "hive" at the identifier level. Only the local, single-instance entity's
agent-facing verbs became `pot:*`.

## What

`pot:*` (`packages/operator-core/lib/agent-tools/hive/`) is the **local pot
lifecycle** surface — the verbs that manage a pot on this machine:

* **`pot:list`** — workspace-local pots (kind:'hive' harnesses) + a live-agent count (one batched fleet read, no per-pot fan-out).
* **`pot:get`** — one pot in depth: wake schedule + cups `{doing,queued,load}` + todo frontier depth. A pure aggregator.
* **`pot:create`** / **`pot:create_from_repo`** — stand up a new pot (home harness + the `hive` blueprint + optional Mug wake), transactional with rollback; the `_from_repo` variant onboards a GitHub URL.
* **`pot:dissolve`** — tear one down (clear the wake, cancel cups, delete `hive_members`, tear down the learning loop + sandbox desktop, deregister; optional schema drop), confirm-gated + owner-tier-gated.
* **`pot:update`** — edit deployment target / per-instance config overrides.
* **`pot:start`** / **`pot:pause`** / **`pot:wake`** / **`pot:declare-wake`** / **`pot:status`** / **`pot:survey`** / **`pot:set-steering`** — the Mug run-loop control surface (start/pause the pot, fire or schedule the next wake, read status, the placement survey, owner steering).

It **composes** existing primitives (`fleet:*`, `coord:*`, `harness:create` internals) rather than reinventing them. A pot is read through one seam, `resolveHive` (`_resolve.ts`), which now points onto the first-class Hive entity (`shared-hive-federation`) — the verbs didn't have to change. (The same `pot:*` namespace also carries the **shared-pot** surface — membership/approval, moderation, and cross-pot ask/grant — covered in the [shared pots guide](/system/shared-pot-guide/).)

## Gotchas

* **Create/dissolve/update are ROOT-ONLY.** They refuse a parented cup (a `cup:spawn` child — `resolveAgentIdentity(ctx).source === 'fleet-spawn'`) up front; the `assertNotNestedHive` guard in `fireLaunchBlueprint` is the runtime backstop. Pots are peers, never nested — a cup that needs structure spins a `kind:'harness'` subharness, never a pot.

* **`pot:create` must stamp `harness_kind:'hive'` itself.** `harness:create` never sets `harness_kind`, and `resolveHive`/`pot:list` filter on it — so a pot home harness created any other way (or a pre-existing plain harness) is **invisible** to the namespace until stamped. `createHiveHarness` sets it; that's the one non-negotiable difference from a plain `harness:create { blueprintId:'hive' }`.

* **`deploy:pot` / `deploy:teardown_pot` are DISTINCT** — they are the *cloud execution-plane* (provision/destroy frames for an already-existing pot), not local lifecycle. `pot:create` does NOT deploy; `pot:dissolve` does NOT destroy a cloud frame. Order: `pot:create` → (later) `deploy:pot`; `deploy:teardown_pot` → `pot:dissolve`.

* **The Mug run-loop verbs live under `pot:*`.** `pot:start` / `pot:pause` (the pot on/off switch), `pot:wake` / `pot:declare-wake` (fire or schedule the next Mug wake; pause-without-stopping = `pot:declare-wake { mode:'none' }`), and `pot:status` / `pot:survey` are all in the namespace. Cup placement stays `fleet:*`; per-loop error/backoff control is `autoloop:control`.

* **`pot:dissolve` leaves workspace-scoped event-wake subscriptions.** The pot time-wake routine is per-home-slug (cleared cleanly), but the pot's event-wake subscriptions are one row per *workspace* today — so dissolve clears only the time wake to avoid clobbering sibling pots (`dissolve.ts` step 1). The first-class Hive entity makes event subs per-pot.

## Tests

`agent-tools/hive/{_resolve,_create,dissolve}.test.ts` + `guard.integration.test.ts`: descriptor shaping, `harness_kind` stamping, create rollback-on-failure, dissolve unwind (incl. the membership / learning-loop / desktop teardown legs), and the root-only + owner-tier refusals — all PG-free (deps mocked). The live create→wake→dissolve path (a real Mug spawn on shared infra) is a manual smoke, not auto-run.
