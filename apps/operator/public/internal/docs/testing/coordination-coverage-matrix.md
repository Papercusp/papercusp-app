# Coordination system — adversarial test coverage matrix
URL: /internal/docs/testing/coordination-coverage-matrix

Adversarial coverage map for cross-agent isolation, real resume/config seams, and multi-session coordination behavior, including the credentialed three-backend resume smoke.

import { Aside } from '@astrojs/starlight/components';

**EI-152** and **EI-153** — two real coordination bugs — shipped *past 27 green
wake-executor tests*. Both escaped for the same reason: the existing suite was
**single-agent unit tests with the real seams mocked**. They asserted the happy
path but never **cross-agent isolation**, the **real socket / resume / config
seams**, or **multi-session concurrency**. This matrix is the coverage map for the
adversarial suite that closes those classes (plan `coordination-test-suite-2026-06-08`).
It lists every failure-mode cell, whether it was covered before, and where it is
covered now — **no silent gaps** (a silent gap is exactly what shipped EI-152).

## The four test classes that were missing

| Class                                        | What it asserts                                                                                                               | Would have caught |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| **C1 — Cross-agent isolation (adversarial)** | For *every* channel (wake, `coord:send`, inbox, presence, locks, work-item claims): A's traffic **cannot** reach or affect B. | EI-153            |
| **C2 — Real-seam integration**               | The **real** socket inject, the **real** resume (isolated config dir), the **real** PG — not mocked deps.                     | EI-152 + EI-153   |
| **C3 — Multi-session concurrency**           | N live isolated sessions; concurrent wakes / sends / claims / locks → no **lost / duplicated / misrouted** delivery.          | both              |
| **C4 — Liveness/lifecycle matrix**           | Every (alive / exited / stale / pid-reuse / no-pid / ended) × (handle? / live-socket?) → the **correct** outcome.             | EI-152            |
| **C5 — Identity invariants**                 | `PAPERCUSP_SID` / coord ownerId / config-dir correct across launch **and** resume; zero identity/conversation bleed.          | EI-153            |
| **C6 — Idempotency / coalescing / retry**    | Re-arm idempotency; coalescing windows; retry/backoff; no duplicate deliveries; `once=false` standing semantics.              | —                 |

## The keystone

`packages/operator-core/test/_multi-session-testbed.ts` — `MultiSessionTestbed`
mints N genuinely-isolated sessions (own coord identity + own `CLAUDE_CONFIG_DIR`
/ `CODEX_HOME` + on-demand own live control socket in an **isolated discovery
dir**) and drives every channel against them. Every C1/C3 cell reuses it. The
isolated `psuPtyDir` both protects the live fleet's `~/.papercusp/psu-pty` and is
how a test proves `findLiveHost(A)` never returns B's socket.

## Failure-mode matrix

Legend: ✅ covered (new) · 🟢 covered (pre-existing) · 🔴 was a gap, now closed ·
⚪ accepted gap (logged below).

### Wake system — the liveness ladder (C4) + EI-152 (C2)

| Cell                                                                  | Before             | Now            | Where                                                     |
| --------------------------------------------------------------------- | ------------------ | -------------- | --------------------------------------------------------- |
| no-handle + **live psu socket** → socket-inject *(EI-152)*            | mocked-only        | 🔴 real socket | `wake-executor-matrix.test.ts`                            |
| no-handle + socket + inject fails → park                              | ❌                  | ✅              | `wake-executor-matrix.test.ts`                            |
| no-handle + no socket + presence live → park                          | mocked             | ✅              | `wake-executor-matrix.test.ts`                            |
| no-handle + no socket + presence stale/revoked → drop                 | mocked             | ✅              | `wake-executor-matrix.test.ts`                            |
| adv-session alive + live socket → socket beats pty                    | ❌                  | 🔴 real socket | `wake-executor-matrix.test.ts`                            |
| adv-session alive + managed pty → pty-inject                          | mocked             | ✅              | `wake-executor-matrix.test.ts`                            |
| **pid-reuse**: pid alive, not our pty → park (no misroute)            | ❌                  | 🔴             | `wake-executor-matrix.test.ts`                            |
| alive + no recorded pid → park (avoid concurrent resume)              | mocked             | ✅              | `wake-executor-matrix.test.ts`                            |
| **ended row** + pid reused-alive → resume (not inject)                | ❌                  | 🔴             | `wake-executor-matrix.test.ts`                            |
| exited + resumable claude → resume-headless                           | mocked             | ✅              | `wake-executor-matrix.test.ts`                            |
| exited + claude w/o native id → park (never `--continue`)             | mocked             | ✅              | `wake-executor-matrix.test.ts`                            |
| exited + not resumable + presence gone → drop                         | mocked             | ✅              | `wake-executor-matrix.test.ts`                            |
| resume spawn fails → error (pump retries)                             | mocked             | ✅              | `wake-executor-matrix.test.ts`                            |
| plan-run handle → plan-run-resume / error                             | mocked             | ✅              | `wake-executor-matrix.test.ts`                            |
| **real psu-pty-host** idle-gate + `mode:'turn'` CR-submit + discovery | partial (raw only) | 🔴             | `apps/operator/lib/psu-pty-host-turn.integration.test.ts` |

**EI-152 red-on-pre-fix verified**: reverting the no-handle `findPsuHost` block in
`wake-executor.ts` flips `no-handle + live socket → delivered` to `park` (red).

### Wake system — pump / coalescing / retry (C6)

File: `events/await/wake-pump-isolation.integration.test.ts` (+ `await-store.integration.test.ts`, `engine.test.ts` for the pre-existing store/pump mechanics; `events/await/wake-on-message.integration.test.ts` for the coord-e2e P-009 verb-to-socket composition).

| Cell                                                                                                                                                                                                                    | Before                      | Now                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `armInboxWake` re-arm idempotency (one standing row)                                                                                                                                                                    | 🟢 store-level              | ✅ arm-level (real PG)                                                                                                |
| per-subscriber coalescing (no duplicate turn)                                                                                                                                                                           | mocked                      | 🟢 store + 🟢 engine                                                                                                 |
| retry/backoff → dead at max attempts                                                                                                                                                                                    | 🟢 store-level              | 🟢                                                                                                                   |
| **cross-agent**: A's emit never delivered to B (real `emitAwaitedEvent`)                                                                                                                                                | ❌                           | 🔴                                                                                                                   |
| end-to-end pump delivers via live socket, not peer                                                                                                                                                                      | ❌                           | 🔴                                                                                                                   |
| **wake-on-message, UNMOCKED verb→socket** (P-009): real `coord:send {wake:true}` → real engine/store/pump → addressee's live socket gets the turn; bystander (armed + socketed) untouched; message durably in the inbox | ❌ engine mocked at the verb | 🔴 (`wake-on-message.integration.test.ts`)                                                                           |
| wake-on-message, inject-only contract: `wake:false` enqueues but never touches the socket and never consumes the standing watch                                                                                         | ❌                           | 🔴 (`wake-on-message.integration.test.ts`)                                                                           |
| **wake-on-message, RESUME path** (P-009): real `claude` resume in the EI-155 isolated config dir carries the REAL `wakeTurnText` (coord message reference) into the resumed turn's transcript                           | ❌                           | 🔴 gated live-smoke (`resume-spawn-live.ts` claude leg — PASS 2026-06-10, transcript 14→26 lines, wake text present) |

### Coord substrate (C1)

File: `agent-tools/coordination/__tests__/cross-agent-isolation.integration.test.ts` (10 tests, real `PgCoordLog`/`PgPresenceStore`).

| Cell                                                      | Before    | Now        |
| --------------------------------------------------------- | --------- | ---------- |
| `coord:send` A→B reaches B and **no one else**            | 🟢 in-mem | 🔴 real PG |
| inbox is owner-scoped; A can't read B's                   | 🟢 in-mem | ✅          |
| A cannot ack/suppress B's broadcast                       | 🟢        | ✅          |
| workspace\_id isolation (A can't reach B cross-workspace) | ❌         | 🔴         |
| presence staleness / revoked transitions                  | partial   | ✅          |
| subscribe→inject only reaches subscribers                 | 🟢        | ✅          |

### Watermark crash-restart (C2)

File: `agent-tools/coordination/__tests__/watermark-crash-restart.integration.test.ts` (4, plan `coord-system-e2e-testing-2026-06-10` P-002 — real PG; a "process" is a dedicated connection + fresh `PgCoordLog`/`PgWatermarkStore` bound into the host seams, and a hard kill discards every in-memory object).

| Cell                                                                                                                                                                                            | Before   | Now                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------- |
| LINE (`messages`): consume to N, hard-kill, restart → resumes at exactly N+1 (no replay after a committed turn, no skip)                                                                        | ❌        | 🔴                      |
| EVENT (`escalations`): same exact-N+1 resume; re-put on an existing msg\_id mints no second record                                                                                              | ❌        | 🔴                      |
| crash BEFORE the turn-end commit → aborted turn's entries re-seen in full (at-least-once, never a skip)                                                                                         | ❌        | 🔴                      |
| SAME-TS boundary: committing a partially-consumed same-ts group skips its siblings (the ts-cursor sharp edge) + the safe-commit rule (commit the previous distinct ts → re-seen, never skipped) | ❌ silent | ⚪ pinned (logged below) |

### Locks (C1)

Files: `agent-tools/locks/__tests__/cross-agent-isolation.integration.test.ts` (7 tests, live `papercusp_su`) + the `PreToolUse` file-lock hook: `apps/operator/scripts/hooks/cc/__tests__/cc-hooks.test.ts` (fail-open) + `pretooluse-locks-decision.test.ts` (decision rendering, stub operator) + `pretooluse-locks-live.integration.test.ts` (the LIVE-operator rung, coord-e2e P-008 — live-gated, skips when no operator answers).

| Cell                                                                                        | Before            | Now                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A cannot release/heartbeat B's lock (lock\_id keying)                                       | 🟢 aba            | ✅ adversarial (replay B's lock\_id)                                                                                                                                                                                  |
| store-layer block-on-held (B's acquire on A's path → busy)                                  | partial           | ✅                                                                                                                                                                                                                    |
| ABA stale-handle no-op                                                                      | 🟢                | ✅                                                                                                                                                                                                                    |
| named-resource drain (exclusive vs shared)                                                  | 🟢                | ✅                                                                                                                                                                                                                    |
| lock-authority election (lowest live pubkey, failover)                                      | 🟢                | ✅ pure `decideAuthority`                                                                                                                                                                                             |
| **file-lock hook fail-open** (operator unreachable → allow + marker; bounded retry)         | partial           | ✅ (`cc-hooks.test.ts`)                                                                                                                                                                                               |
| **file-lock hook block-on-held → `permissionDecision:deny`** (busy → reason the model sees) | ❌ live-smoke only | 🔴 stub operator (`pretooluse-locks-decision.test.ts`) + 🔴 LIVE operator: deny names holder label + declared intent + the queue-and-sleep guidance (`pretooluse-locks-live.integration.test.ts`)                    |
| file-lock hook allow-on-grant caches lock\_id for release (+ SSE-framed parsing)            | ❌                 | 🔴 + LIVE full cycle: deny → `wake_on_grant` queue → release → grant cascade → hook allows + caches `<tool_use_id>.lock` → PostToolUse release frees the path (`pretooluse-locks-live.integration.test.ts`, 5 tests) |

### Lock authority — remote leg over HTTP (C2)

Files: `lib/authority/__tests__/file-lock-authority-e2e.integration.test.ts` (6, real PG su-lock store + real loopback HTTP, plan `coord-system-e2e-testing-2026-06-10` P-006) + `lib/authority/__tests__/transport-wiring.test.ts` (9) + the pre-existing `peer-rpc-transport.integration.test.ts` / `two-instance-authority.integration.test.ts` (+ pot variant).

| Cell                                                                                                                            | Before                                                  | Now                              |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------- |
| generic remote dispatch over real HTTP (`routeToAuthority` → transport → `handleAuthorityRpc`)                                  | 🟢                                                      | ✅                                |
| transport REGISTERED at boot + addressing precedence (configured resolver > env map > null → fail-open)                         | ❌ production transport never registered (D-002 blocker) | 🔴 `transport-wiring.ts` + tests |
| REAL file-lock chain: `routeFileLockOp` → boot-wired `HttpPeerRpcTransport` → boot-registered `lock.*` handlers → real PG store | ❌ fake store + hand-registered kinds only               | 🔴                               |
| cross-wire mutual exclusion (B busy on A's held path) + cross-wire release frees the contender                                  | partial (fake store)                                    | 🔴                               |
| `not_authority` refusal during a failover gap → fail-open with loud warning                                                     | ❌                                                       | 🔴                               |
| authority unreachable → fail-open, local advisory grant                                                                         | 🟢 generic leg                                          | ✅ file-lock leg                  |
| unmanaged domain → pure local, zero wire traffic                                                                                | 🟢                                                      | ✅                                |

### Lock authority — failover mid-hold + fencing (C2/C3)

Files: `lib/authority/__tests__/cross-machine-lock-failover.integration.test.ts` (8, plan `coord-system-e2e-testing-2026-06-10` P-007 — the two-instances-one-box rung; the two-physical-box variant is P-010, owner-gated) + `authority-failover-flood.integration.test.ts` (2, P-003 — sustained flood across a mid-flood authority crash). Shared rig `_two-instance-authority-rig.ts`: two simulated machines with per-instance stores + the REAL handlers (`buildFileLockAuthorityHandlers`), hardened verification (`resolveHardenedAuthority`), and the D-005 `LockSetReconstructor` handover, driven over real loopback HTTP via the boot-wired transport; injected clock + roster (deterministic, no sleeps).

| Cell                                                                                                                                                                                  | Before            | Now                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------- |
| authority failover MID-HOLD → holder re-asserts to the new authority; contender refused across the wire                                                                               | ❌ pure parts only | 🔴 composed over the wire                                                                           |
| epoch bumps on takeover; deposed authority's stale-epoch grant fenced out downstream (`fenceValid`)                                                                                   | 🟢 pure           | ✅ E2E                                                                                               |
| a deposed authority's stale-epoch **re-assert** at the NEW authority is fenced out (a late heartbeat minted under the old epoch cannot clobber the new authority's truth — B1, D-006) | ❌                 | 🔴                                                                                                  |
| deposed authority refuses mis-routed ops (`not_authority`) → requester fails open loud                                                                                                | ❌                 | 🔴                                                                                                  |
| optimistic grant of UNCONTENDED paths during the rebuild window (the designed D-004 gap, asserted as such)                                                                            | ❌                 | 🔴                                                                                                  |
| cross-wire release at the NEW authority frees the contender post-rebuild                                                                                                              | ❌                 | 🔴                                                                                                  |
| anti-flap: returning lower peer cannot preempt within cooldown (no double grant); clean preemption + fresh epoch after                                                                | 🟢 pure           | ✅ E2E                                                                                               |
| FLOOD across a crash: zero contender grants on a contended path over 30 rounds × concurrent traffic (before/during/after failover)                                                    | ❌                 | 🔴 flood test                                                                                       |
| re-election within the staleness window under flood — fail-open window starts at the crash, bounded by staleMs, full remote service resumes after                                     | ❌                 | 🔴 flood test                                                                                       |
| fencing under flood: remote grant epochs non-decreasing across the takeover; liveness (workers keep getting granted whenever an authority is reachable)                               | ❌                 | 🔴 flood test                                                                                       |
| holder→authority heartbeat re-assert op over the production transport                                                                                                                 | ❌                 | ⚪ rig-local `lock.assert` op kind — the production heartbeat-op wiring is a residual (logged below) |

### Federation (C2/C3)

File: `sync/hyperbee/__tests__/federation-adversarial.integration.test.ts` (8 tests, real two-peer DHT).

| Cell                                                                                                                                                                                                                                                     | Before        | Now                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ---------------------------------------- |
| peer-log → projection → PG round-trip (no loss)                                                                                                                                                                                                          | 🟢            | ✅                                        |
| **wrong tableTag silently dropped** (pins op-key invariant)                                                                                                                                                                                              | ❌             | 🔴                                       |
| admission gate (rejecting peer never federates)                                                                                                                                                                                                          | partial       | ✅                                        |
| revocation drops a peer mid-session                                                                                                                                                                                                                      | partial       | 🔴                                       |
| no duplication (one op merged twice → one row)                                                                                                                                                                                                           | 🟢            | ✅                                        |
| **poisoning/DoS resilience** — a malformed-op barrage (NaN ts / oversized payload / junk schema / null value) cannot crash or wedge an honest peer's merge pipeline; a later valid op still federates                                                    | ❌             | 🔴                                       |
| **3-peer partition/rejoin** (P-001): minority keeps appending; heal → 3-way convergence, no loss/dup, cross-partition LWW conflict resolves identically everywhere, per-log merge watermarks monotonic throughout, quiescent pass applies zero (no echo) | ❌ 2-peer only | 🔴 `three-peer-partition-rejoin.test.ts` |

### Coord verb lifecycle ACROSS instances (C2/C3)

File: `shared-pot-loop/coord-verb-lifecycle-two-cell.integration.test.ts` (5 tests, plan `coord-system-e2e-testing-2026-06-10` P-005 — the brief-11 composition rig + the real coord\_event\_log (mig-150 capture verbatim) + the real coord-messages projection + the real PgWatermarkStore; real Hyperswarm over a local testnet DHT, own PG per cell).

| Cell                                                                                                                                                                | Before                               | Now                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **send → handoff/ACCEPT → escalate/RESOLVE federate BOTH directions** between two cells of one Pot (LINE + EVENT surfaces, origin='remote' on arrival, body intact) | ❌ nothing ran verbs across instances | 🔴                                                                                                                                                                                                                                                                                                                                                                                                      |
| EVENT immutability across the wire: replays mint no second record on the peer                                                                                       | 🟢 single-PG only                    | 🔴 cross-cell                                                                                                                                                                                                                                                                                                                                                                                           |
| per-surface order of remote-fed rows preserved (send order = arrival order)                                                                                         | ❌                                    | 🔴                                                                                                                                                                                                                                                                                                                                                                                                      |
| partition (convergence withheld) → heal: every message exactly once, batch order kept; a re-converge is a FIXED POINT (EI-117 no-double-application class)          | ❌                                    | 🔴                                                                                                                                                                                                                                                                                                                                                                                                      |
| watermark commit on REMOTE-fed rows survives a store restart; resume strictly past the cursor sees exactly the new traffic                                          | ❌                                    | 🔴                                                                                                                                                                                                                                                                                                                                                                                                      |
| workspace isolation across the wire (another workspace's rows never surface in WS reads on the peer)                                                                | ❌                                    | 🔴                                                                                                                                                                                                                                                                                                                                                                                                      |
| cross-instance deliver-and-WAKE (remote-origin message fires the recipient's local inbox-wake)                                                                      | ❌                                    | 🔴 EI-279 fixed 2026-06-11: `coord:send {wake:true}` persists `body.wake`, which federates; the coord-message projection fans `wakeRecipients` on a FRESH remote-origin insert (once per msg\_id — re-applies/replays never re-wake). Trigger contract pinned here (P-005 'EI-279 liveness' cell) + `coord-message-federation.integration.test.ts` (fan-once, no-intent/local-origin no-ops, fail-soft) |

### Swarm-path chaos — real Hyperswarm under churn (C2)

File: `sync/hyperbee/__tests__/swarm-chaos.test.ts` (plan `coord-system-e2e-testing-2026-06-10` P-004; \~2.6s, seeded LCG kill schedule, offline testnet DHT). Chaos = repeated mid-replication CONNECTION KILLS + reconnect churn — the only failure shape a reliable UDX transport can surface to the substrate (loss/reorder are absorbed below the byte stream; injecting them in-stream would fabricate impossible corruption). History: landed red and held the gate (EI-272) — root causes were rig-level (the IP-keyed DoS conn-rate ceiling cross-bans one-box peers sharing 127.0.0.1; in-process testnet RELAY streams take unguarded resets when `forceRelaying` engages); both documented in-file.

| Cell                                                                                                                                                                                                                    | Before                   | Now                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ----------------------------- |
| **unhandled socket `'error'` on swarm connections = host-CRASH class** — an unclean peer disconnect raised an uncaught ECONNRESET; guards now first-line in both connection handlers (`swarm.ts`, `directory-swarm.ts`) | ❌ crash                  | 🔴 found + fixed by this test |
| convergence under seeded kill-reconnect churn: every honest op exactly once per key on both peers (no loss, no dup)                                                                                                     | ❌                        | 🔴                            |
| admission enforced across churn: a failing channel-2 binding re-announces on every reconnect, never admitted, ops never merge                                                                                           | partial (single connect) | 🔴                            |
| MID-SESSION revocation survives reconnect churn (re-announce refused), with a live-wire positive control op proving the assertion isn't vacuous                                                                         | ❌                        | 🔴                            |

### work\_items claim/lease (C3)

File: `work-item-claims-concurrency.integration.test.ts` (12 tests, real PG).

| Cell                                                                                                                                                                                                                                           | Before                                             | Now                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| N swarms claim one item → **no double-claim**                                                                                                                                                                                                  | 🟢 2-inst                                          | 🔴 8-way                                                                                                                    |
| N>M over a backlog (SKIP LOCKED) → each item once                                                                                                                                                                                              | 🟢                                                 | ✅                                                                                                                           |
| lease ttl expiry → reclaimable (claim\_id rotates)                                                                                                                                                                                             | 🟢                                                 | ✅                                                                                                                           |
| heartbeat extends lease; foreign heartbeat no-op                                                                                                                                                                                               | 🟢                                                 | ✅                                                                                                                           |
| fail-open reconcile under partition (deterministic)                                                                                                                                                                                            | 🟢 pure                                            | ✅ partition-heal                                                                                                            |
| **G16 — REAL-clock lease expiry**: a short ttl lapses on the wall clock (no manual DB edit) and is then stealable                                                                                                                              | ❌                                                  | 🔴                                                                                                                          |
| **G17 — heartbeat renewal blocks a steal**: a renewing owner holds against concurrent steals, then loses only after heartbeats stop                                                                                                            | ❌                                                  | 🔴                                                                                                                          |
| **G18 — priority-ordered claiming**: equal `feature_order` tie-breaks on `created_ts` (oldest first); N claimers over M priorities drain in priority order, all distinct; serial claiming drains strictly lowest-`feature_order` first         | ❌                                                  | 🔴                                                                                                                          |
| **caller-standing gate (EI-284)**: a REVOKED swarm's acquire/heartbeat RPC is refused (`refused:'caller_revoked'` / `reason:'caller_revoked'`); release stays ungated (zombie relinquish is wanted); no-pubkey + check-error fail open (D-004) | ❌ revoked swarm stole leases + blocked live swarms | 🔴 `work-item-claim-authority-ops.test.ts` (6 gate cells) + the flipped `shared-pot-loop/revoked-swarm.integration.test.ts` |
| caller-standing residual: the RPC envelope is UNAUTHENTICATED — `holderPubkey` is self-reported, so the gate is defense-in-depth against well-behaved-but-revoked peers, not spoofing                                                          | —                                                  | ⚪ on EI-284's thread (authenticated-envelope follow-on)                                                                     |

### Multi-session concurrency E2E (C3) — the capstone

File: `multi-session-concurrency.integration.test.ts` (4 channels, N isolated testbed sessions).

| Cell                                                                 | Before | Now |
| -------------------------------------------------------------------- | ------ | --- |
| N concurrent wakes → each lands on its OWN socket, none on a peer    | ❌      | 🔴  |
| N concurrent directed sends → each reaches exactly its addressee     | ❌      | 🔴  |
| N×M concurrent claims → one winner per item                          | ❌      | 🔴  |
| N concurrent lock races → one grant/path; distinct paths all granted | ❌      | 🔴  |

### Agent protocol use under lock contention — LLM-judged (Layer C)

File: `lib/llm-testing/scenarios/su/S11-lock-contention-protocol.ts` (llm-testing lane, coord-e2e P-011 — deny text is the live hook's exact rendering, verified by `pretooluse-locks-live.integration.test.ts`). Cost-capped: single scenario per run (`--no-matrix`), D-003.

| Cell                                                                                                                                            | Before   | Now                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| hook-denied edit → protocol response (`locks:acquire {wake_on_grant:true}` / `locks:queue` / `coord:send` to holder), ERROR-gated assert        | ❌        | 🔴 first scored run 2026-06-12: assert green                                                                                                    |
| NO bypass — no `mv`/`cp`/`--force` on the contested path, no sibling-copy edit, no blind retry loop (>2 re-denied attempts), ERROR-gated assert | ❌        | 🔴 same run: assert green                                                                                                                       |
| grounding while waiting — no narrated/fictional peer reply after `coord:send` (judge groundedness axis)                                         | ❌ silent | 🔴 judged — first run FAILED this axis (real finding: SUT narrated an anticipated reply before checking `coord:inbox`; filed as an improvement) |

Run recipe (the 429 trap): `LLM_TEST_BACKEND=claude-code` is the knob that escapes the saturated raw-OAuth bucket (`AGENT_BACKEND` alone only picks the stateless credential) — see the `llm-429-check-the-transport-not-the-account` insight.

## Closed since first publication

**Interactive psu/SU + role claude config isolation (EI-155) is now implemented
and tested.** Per-session `CLAUDE_CONFIG_DIR` isolation was previously only on
the **orchestrator-spawned cup** path (`spawn-mcp.ts`/`invoke.ts` →
`~/.papercusp/session-claude/<spawnId>`, restored on **wake-executor resume**);
interactive `psu` claude sessions shared one `~/.claude`. The fix (`bootstrap-su`

* `bootstrap-role` → `writeInteractiveClaudeConfig`, keyed by `sid` via the same
  `sessionClaudeConfigDir` helper the resume leg reads) materializes a **symlink
  mirror** of `~/.claude` with **two** things isolated — the `projects/`
  transcript store (EI-153) and the launching user's **personal global-memory**
  files (`CLAUDE.md` / `CLAUDE.local.md` / `AGENTS.md`, deliberately *not*
  symlinked in so a psu session loads no personal memory — the psu-isolation
  P-002 / D-001 leak fix) — plus the sibling `~/.claude.json` symlinked in. That
  is what makes it credential-/onboarding-safe where a creds-only dir is not: the
  user-level `papercusp-su` MCP (lives in `~/.claude.json`), the file-lock + coord
  hooks (`settings.json`), plugins/skills, and onboarding/trust all carry through;
  the conversation transcripts and personal memory are private (so `/resume` +
  wake-by-uuid never reach a peer's session — the EI-153 root — and the session
  is governed only by the psu playbook + the P-001 project-guide splice). Verified
  live on claude-code 2.1.169 (a creds-only dir lost the MCP + hooks; the mirror
  restores them). Covered by `interactive-claude-config.test.ts` (8 — including
  the personal-memory leak-fix test) + the `bootstrap-su`/`bootstrap-role`
  route assertions (CLAUDE\_CONFIG\_DIR present for claude, absent for omp/codex,
  non-fatal on materialize failure).

**The real-CLI resume rung covers all three backends.** The CI test
(`wake-resume-isolation.test.ts`) still asserts the wake executor builds the
right command and hands it to `spawnDetached`. Its credentialed complement is
`apps/operator/scripts/resume-spawn-live.ts`, surfaced as the coordination-suite
**C5 real resume spawn (live)** runner. It builds each resume with the production
`resumeCommandFor`, launches against a real isolated transcript store, and
asserts the exact transcript/rollout grows after resume—independent of model
wording. Claude also asserts the injected wake text is present.

The current runner uses an isolated `CLAUDE_CONFIG_DIR`,
`PI_CODING_AGENT_DIR`, or `CODEX_HOME` for Claude, OMP, or Codex respectively.
It skips a missing/unauthed CLI and fails when an available backend does not
continue its exact session. Verified together on this box with Claude Code
2.1.246, OMP 18.0.3, and Codex CLI 0.149.1 (2026-08-26); resumed-turn wall times
in that sample were 10.251s, 11.929s, and 4.717s respectively.

## Accepted gaps (logged — not silent)

* **Production peer ADDRESSING for the authority remote leg.** The HTTP
  transport is boot-registered and the whole file-lock chain is proven over a
  real wire, but `shared_presence` carries identity, not a network address — so
  on a real multi-box deployment no peer address resolves until a topology layer
  calls `configurePeerAddressResolver` or sets
  `PAPERCUSP_AUTHORITY_PEER_ADDRESSES`. Until then every remote-authority op
  fails OPEN with a loud warning (D-004 — git-merge is the data backstop).
  Tracked in `coord-system-e2e-testing-2026-06-10` (P-006 note; the two-box
  variant is P-010, owner-gated). Not silent: the fail-open path itself is
  covered by the cells above.
* **The ts-based watermark's same-ts boundary.** The watermark cursors are ISO
  timestamps and the inbox filter is strictly-later, so a consumer that
  commits the ts of a PARTIALLY-consumed same-ts group will never see that
  group's remaining entries. Pinned (not fixed) in
  `watermark-crash-restart.integration.test.ts` with the safe-commit rule a
  consumer must follow: when consumption ends mid-group, commit the previous
  DISTINCT ts (re-see beats skip). A structural fix would key the cursor by
  `(ts, msg_id)` — a protocol change tracked in
  `coord-system-e2e-testing-2026-06-10` (P-002 note), not silently absorbed
  here.
* **Holder→authority heartbeat re-assert as a production op kind.** The D-005
  handover protocol (holders re-assert held locks to a new authority; the
  `LockSetReconstructor` rebuilds within one heartbeat interval) is proven E2E
  with a rig-local `lock.assert` op. Production wiring — a `lock.assert` kind in
  `file-lock-authority-ops.ts` fired from the locks heartbeat path on authority
  change — is not built yet. Until it is, a failover's rebuild window behaves as
  pure fail-open (D-004). Tracked in `coord-system-e2e-testing-2026-06-10`
  (P-007 note).
* The two gaps logged at first publication (interactive-claude config
  isolation, real resume spawn) are both closed above.
