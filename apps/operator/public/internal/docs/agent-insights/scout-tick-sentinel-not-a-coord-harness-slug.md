# A Scout tick's install_slug can be the workspace sentinel — never stamp it verbatim as a coord harnessSlug
URL: /internal/docs/agent-insights/scout-tick-sentinel-not-a-coord-harness-slug

Under FLAGS.WORKSPACE_COORDINATION, recordScoutTick's install_slug is literally the workspace id (a partition-key sentinel, not a hive). Threading it through as SendOptions.harnessSlug captures the coord message into substrate_outbox under a harness that never boots, so it can never drain — a permanent, growing outbox-health SLO breach (EI-20949117919419640).

## The trap

Several unrelated subsystems each mint their own "install slug" / partition key, and it is
easy to assume any string flowing through an `installSlug`-shaped parameter names a real,
bootable harness/hive. It does not always.

Concretely: `workspaceBrainScopeKey(workspaceId, perHiveSlug, on) = on ? workspaceId : perHiveSlug`
(`packages/operator-core/lib/workspace-brain-scope.ts`). When `FLAGS.WORKSPACE_COORDINATION`
is ON (default), every Scout tick recorded via `recordScoutTick` gets `install_slug` set to
the **workspace id itself** — a documented sentinel meaning "workspace-wide", not any one
hive (`scout-cycle-action.ts`: *"ctx.installSlug is the workspace SENTINEL — not a hive"*).

`SendOptions.harnessSlug` (`packages/operator-core/lib/agent-tools/coordination/messages.ts`)
has the OPPOSITE contract: a non-null string is stamped verbatim onto
`coord_event_log.harness_slug` and, per migration 150, is what the capture trigger uses to
decide a row should federate — it enqueues into `harness_shared.substrate_outbox` for
`outbox-drain.ts` to drain **per booted harness**. A harness slug that is never registered/
booted (the workspace sentinel never is) can NEVER be drained. The row sits in the outbox
forever, and `scanOutboxHealth` (`fleet-monitors.ts`) eventually alarms on it — permanently,
because nothing will ever process it (the SLO breach only grows, never clears).

This is the SAME shape as the earlier quarantined-row false-positive class (mig 645): a value
that is structurally guaranteed to never drain, captured anyway because nothing at the write
site distinguished "a real federating scope" from "a same-shaped value from a different
domain".

## The fix (EI-20949117919419640)

`packages/operator-core/lib/scout/error-streak-alarm.ts` threaded the Scout tick ledger's
`installSlug` straight into `deliverScoutNudge({ harnessSlug: opts.installSlug ?? null })`.
Fixed by only passing it through when it differs from the resolving workspace id (i.e. it is
demonstrably a real per-hive slug, not the sentinel):

```ts
const nudgeHarnessSlug = opts.installSlug && opts.installSlug !== ws ? opts.installSlug : null;
```

`null` is the CORRECT value for a workspace-wide event — `SendOptions.harnessSlug`'s own
docstring: `null → EXPLICIT machine-local … never auto-stamped`. That is exactly what
migration 150 intends for an un-scoped/workspace-global coord event: it stays local and is
never captured for federation.

## The general lesson

Before passing an `installSlug`/`harnessSlug`/`potSlug`-shaped value across a module
boundary, ask: **is this string guaranteed to name something that will actually consume it
on the other side** (a booted harness, a registered hive)? A same-shaped sentinel from an
unrelated domain (a workspace id doing double duty as a Scout ledger partition key, here)
looks identical to a real slug and type-checks fine, but silently produces state nothing can
ever drain. When in doubt, compare against the value that would make the sentinel case
detectable (e.g. `slug !== workspaceId`) rather than threading the raw value through
unconditionally.

## Symptom to recognize

`shared-hive invariant: substrate outbox depth/age breach` where the reported
`harness_slug` (query `harness_shared.substrate_outbox` for the undrained rows) equals the
`workspace_id` column exactly, and the payload rows are `coord_event_log` messages whose
body reads like an internal watchdog page (not user-authored coordination). That equality
is the tell: a real per-hive slug essentially never collides with the workspace id unless the
deployment is genuinely workspace==hive shaped (`workspaceBrainReadKeys`'s own de-dup case) —
worth double-checking against `harness_shared.projects` before assuming sentinel leakage.
