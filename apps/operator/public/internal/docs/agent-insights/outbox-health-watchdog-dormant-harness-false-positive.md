# Outbox-health watchdog false-positive: an aged backlog on a not-booted harness is not a stuck drain
URL: /internal/docs/agent-insights/outbox-health-watchdog-dormant-harness-false-positive

scanOutboxHealth's age SLO alarmed on hotel-reservations for a 3h backlog that drained in ~10s the moment the harness next booted — the drain loop wasn't stuck, it simply wasn't resident. Fixed via a residentInProcess fact threaded from getBootedHarness; the depth (storage-bloat) leg is never suppressed.

## The symptom

`EI-21096375006041139`: "shared-hive invariant: substrate outbox depth/age breach in hotel-reservations" — `oldestUndrainedAgeMs: 11292679` (\~3.1h) against the 30-minute SLO, `undrainedDepth: 371`. Fired 3 times (`repeatCount:3`) over consecutive hourly `system:coord-invariant-monitor` ticks.

By the time this was triaged, the harness's outbox was **already fully drained** — 0 undrained rows. Forensics on `harness_shared.substrate_outbox` showed the real shape: 406 rows written between 19:29 and 22:30, then **all 406 drained together in a \~10-second burst at 23:04** — a single catch-up pass, not a gradual recovery.

## Why this is not a drain-loop defect

`hotel-reservations` is a local pot (`harness_kind='hive'`). Its `substrate_outbox` is only drained by an **in-process boot handle** — `bootAllHarnessesForActiveWorkspace` boots every registered harness and wires `startOutboxDrain` for it (`outbox-drain.ts`). That module's own header says the quiet part outright: it "**runs an immediate catch-up drain on start**". So the 10-second burst at 23:04 is exactly what a harness with NO resident drain loop looks like the instant it (re)boots.

The activation policy that would otherwise keep a harness *continuously* booted on-demand — P-010's `LAZY_SUBSTRATE_BOOT` (`substrate-active-set-policy.ts`) — defaults **OFF** in this deployment (verified via `harness_shared.operator_flag_overrides`; no override for `papercusp-workspace`). With it off, `boot-all` runs **once**, at host boot (`bootAllHarnessesForActiveWorkspace` — see `boot-all.ts`'s module header: "Always runs at host boot"). A harness created — or whose boot legitimately failed/lagged — after that one sweep has **no automatic re-boot path** until either something explicitly re-boots it or the whole process restarts. `getBootedHarness`'s reboot-on-access path only fires when `evictionTrackingEnabled` is true, which is gated behind the same OFF flag.

So: **a harness can genuinely have an aged, undrained outbox with NOTHING wrong** — no drain loop is running FOR it right now, by ordinary (if imperfect) boot orchestration, not by fault. It will self-heal completely the next time it boots, per `outbox-drain.ts`'s documented behavior.

## Why `scanOutboxHealth` (fleet-monitors.ts) missed this

Its age leg (`oldestUndrainedAgeMs > maxAgeMs`) has no notion of "is a drain loop even resident to violate this SLO" — it purely measures point-in-time DB state. This is the *exact* false-positive shape this same module already special-cases elsewhere:

* `judgePeerFederationSilence`'s `scope-dormant`/`own-log-only` verdicts (this file, same section) — "a scope we ourselves stopped writing to reads as peer silence; the honest verdict is dormant, not broken".
* The quarantined-row exclusion (`EI-21009625512310918`) — a row deliberately left undrained forever inflated the same age SLO until excluded.
* The broader pattern threaded through `coord-invariant-actions.ts` (`EI-6910`, `EI-8664`, `EI-9506`, `EI-9420`): "measure genuine stalls, not expected/human-owned state".

The outbox-health leg was the one sibling check that hadn't yet learned this lesson.

## The fix

Threaded a `residentInProcess?: boolean` fact — `getBootedHarness(workspaceId, harnessSlug) != null`, computed in `runSharedHiveLeg` (`coord-invariant-actions.ts`) where process-local boot state is actually knowable — through `runSharedHiveMonitorPass` into `scanOutboxHealth` (`fleet-monitors.ts`).

* `residentInProcess === false` ⇒ withhold the **age** breach (report it via a new `ageBreachSuppressedDormant: boolean` on `OutboxHealth` instead, for observability).
* The **depth** leg (`undrainedDepth > maxDepth`) is **deliberately never suppressed** — unbounded growth is the "102GB lesson" this scan exists to catch (see the module header), and that storage-bloat risk is real regardless of why nothing is draining right now.
* `residentInProcess` omitted or `true` ⇒ byte-identical to the prior unconditional behavior — every other caller, and a genuinely wedged/failing drain on a harness that IS resident, still alarms exactly as before.

## The generalizable lesson

Before treating "state X has been stale/aged past an SLO" as evidence of a *failure*, ask: **is there currently a live process/loop that is even SUPPOSED to be changing X right now?** If the honest answer is "no, and that's by design (deferred/dormant/not-yet-booted), and it self-heals the moment one exists" — the correct verdict is dormant/unmeasured, not broken. This applies to any watchdog built on raw age/depth against a resource whose updater has its own independent on/off lifecycle (a boot handle, a leader election, a feature-flagged loop) — check the updater's residency before alarming on its output's staleness.
