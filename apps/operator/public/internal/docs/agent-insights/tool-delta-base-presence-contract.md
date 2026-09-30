# Tool result freshness: the delta base-presence contract
URL: /internal/docs/agent-insights/tool-delta-base-presence-contract

How an agent tool answers `not_modified` instead of replaying an unchanged snapshot into the model's context — who owns the cursor, how the harness proves it still holds the base, and why this is base-presence-safe with no semantic deltas. The server half (framework plumbing) of agent-tool-delta-protocol; the harness half is the contract this page pins.

## The problem

A list/snapshot tool (`plans:attention`, `fleet:assignments`, `coord:inbox`, …)
re-serializes the **whole** view on every call. When an agent polls one across a
loop, the same \~unchanged snapshot is replayed into the model's context turn
after turn — pure token waste. The fix mirrors HTTP `ETag`/`If-None-Match`: let
the tool answer **"nothing changed"** instead of the body.

This page pins the **base-presence contract** (plan
`agent-tool-delta-protocol-2026-06-22`, Lane B / P-004). The framework
*plumbing* is in [`delta-protocol.ts`](libs/generic/tooldef/src/delta-protocol.ts);
this is the rule the **agent harness** (OMP / psu turn-wrapper) must honor for
that plumbing to be safe.

## The two safe modes (no semantic deltas)

The framework implements only two outcomes — never a partial body:

* **`full`** — the complete snapshot. Needs no prior base in context. (Also what
  an absent `_delta` means: today's behavior, unchanged.)
* **`not_modified`** — *no data*, just `mode: not_modified` + a row `count` + a
  fresh cursor. The harness re-presents the base it already holds.

Because `not_modified` carries **no data to merge**, there is nothing the model
can silently mis-merge. The silent-wrong-merge hazard only enters with semantic
`added/updated/removed` delta bodies — that is a **separate, endpoint-opt-in
layer** (Lane E) gated on the Lane-C behavior tests, and is deliberately NOT part
of this contract.

## Control rides the `_meta` envelope, never `arguments` (D-001)

The freshness control field is `_meta.delta` on the MCP `tools/call` params (a
sibling of `arguments`, alongside `format`/`structured`/`idempotencyKey` —
[`_mcp-handler.ts`](packages/operator-core/lib/endpoint-route/routes/transport/_mcp-handler.ts)),
with a connection-level `?delta=` URL fallback mirroring `?format=`. It must NOT
be a key inside `arguments`: \~9 `.strict()` tools and the converse/papercup
`additionalProperties:false` rejection-contract would `400` on an unknown
`arguments` key. Wire form is a single string: `"<mode>"` or `"<mode>~<cursor>"`
(the cursor is base64url, which never contains `~`).

The negotiated outcome rides back on `_meta.delta`:

```jsonc
{ "mode": "full" | "not_modified",
  "supported": true,            // did the endpoint declare a delta capability?
  "cursor": "<opaque>",         // fresh cursor (omitted on bypass / non-capable)
  "reason": "changed" }         // why full, when the client wanted otherwise
```

## Cursors are stateless and opaque (D-002)

There is **no server-side snapshot store**. Everything needed to validate a
cursor on the next call lives inside the base64url token: the **view
fingerprint** (a hash of tool name + canonical args + scope + requested format),
the **revision** it was issued at, and the endpoint **schema version**. The
server recomputes the fingerprint + current revision and compares:

| cursor vs current                                          | result                                     |
| ---------------------------------------------------------- | ------------------------------------------ |
| fingerprint differs (different tool/args/scope/**format**) | `full` (`view_changed`)                    |
| schemaVersion differs                                      | `full` (`schema_changed`)                  |
| malformed / unversioned                                    | `full` (`cursor_malformed`)                |
| revision matches                                           | **`not_modified`**                         |
| revision advanced                                          | `full` (`changed`) — here is the new state |

No retention burden, no stale-base class of bug. A cursor minted for one view
can never be honored for another.

## The harness owns the base — mirror coord (D-006)

`not_modified` is only useful if the **base snapshot is still in the model's
context**. The server can validate the cursor/view/scope, but it **cannot** see
whether the model still holds the base. So the **harness, not the model, owns
cursor storage and base-presence tracking** — exactly as coord already does for
OMP/psu agents: the `[coord+N]` positional injection line-protocol
([`coord-schema.ts`](packages/operator-core/lib/coord-schema.ts) is the single
source for that schema — the shared legend the renderer and the psu prompt both
read, so the two can't desync), `coord_watermarks` per-channel cursors
(`agent-tools/coordination/watermarks.ts`), the `messages_shown_ts` read-receipt
and `snapshot_rebootstrap_pending` flag that re-sends full state after
compaction (`agent-tools/coordination/tools/inbox.ts`,
`agent-tools/coordination/presence-snapshot.ts`).

The harness contract:

1. **Store** each cursor keyed by **(tool name + canonical args + scope +
   serialization format)** — the same tuple the fingerprint binds. A different
   key ⇒ a different stored base.
2. **Assert `haveBase`**: send `_meta.delta = "not_modified~<cursor>"` **only**
   when the matching base snapshot is still verbatim in the current context.
   Otherwise send `"full"` (or omit `_delta`).
3. **Invalidate on compaction / session-resume**: when the turn wrapper compacts
   history or resumes a session, the prior tool snapshots may be gone — clear the
   stored cursors (or flag rebootstrap-pending), so the next call asks for `full`.
   This is the `snapshot_rebootstrap_pending` move.
4. **On a `not_modified` response**: re-present the retained base to the model;
   it is never re-read off the wire. Refresh the stored cursor from
   `_meta.delta.cursor`.
5. **On a `full` response**: replace both the stored base and the cursor.
6. **On `supported: false`**: the endpoint isn't delta-capable — stop sending
   `_delta` for it.

**Auto-expand-to-full on absent base is automatic, from both sides:** the harness
simply never asserts `not_modified` without the base (so the model always has
data to act on), and the server independently returns `full` on any
cursor/scope/schema mismatch. There is no path where the model is left with
neither a body nor a base.

### Scope: only harnesses Papercusp's turn-wrapper controls

LLM-facing `not_modified` is scoped to **OMP / psu** harnesses, where Papercusp
owns the turn wrapper and can guarantee base-presence tracking. **External Claude
Code / Codex** sessions get no turn-wrapper control, so the harness must **never**
send `not_modified` for them — they always receive `full` (their MCP client may
still use `?format=` etc., just not delta).

### Harness reference implementation (P-003)

The harness half is now a concrete, generic unit — the inverse companion to the
client-side merge:

* [`DeltaToolClient`](libs/generic/tooldef/src/delta-client.ts) owns the \*\*cursor
  * base ROWS + the merge\*\* (`ingest`: `full` caches, `not_modified` returns the
    cached base, `delta` merges then checksum-verifies or forces a refetch).
* [`BasePresenceTracker`](libs/generic/tooldef/src/base-presence.ts) owns the
  **base-PRESENCE** question this contract pins: is the base snapshot still in the
  *model's* context? It implements rules 2–6 + the compaction clear (rule 3) and
  the scope guard as a `enabled` constructor flag — `enabled:false` (external
  Claude Code / Codex) makes every `negotiationFor` resolve to `full` and every
  `record` a no-op. `negotiationFor(viewKey)` returns the `_meta.delta` wire value
  (`full` | `not_modified~<cursor>` | `auto~<cursor>`); `record(viewKey, mode,
  cursor, supported)` folds the served response back in; `onCompaction()` is the
  `snapshot_rebootstrap_pending` move.

The two compose: the tracker decides *whether* it is safe to ask for a delta (so
the model never loses its base across a compaction), the client decides *how* to
reconstruct the full view from whatever the server returned. The
[`base-presence.test.ts`](libs/generic/tooldef/src/base-presence.test.ts) suite
walks a realistic poll loop: `full → not_modified×N → compaction → forced full`.

**The integration seam is the turn-wrapper that OWNS the message array — and the
operator's in-process `runAgentChat` is NOT it (P-003 finding).** The operator's
oracle/converse loop
([`chat-stream.ts`](libs/papercusp-shared/src/agent/chat-stream.ts)) does not run
a Vercel-AI-SDK-style `execute()` loop holding the messages; it **spawns a child
agent process** (claude-code or omp) and only *observes* that child's event
stream (`tool_call` blocks, text deltas). The actual tool dispatch + the message
array — where a `not_modified`/`delta` would have to be injected and a base
re-presented — live INSIDE the child process. So a base-presence tracker bolted
onto `runAgentChat` would have no message array to act on, and for the
claude-code child it is excluded by the scope rule above anyway. The tracker
therefore belongs in the **OMP/psu turn-wrapper**, alongside coord's existing
`coord_watermarks` / `snapshot_rebootstrap_pending` plumbing, which is the one
place Papercusp owns both the turn boundary and the message array. The unit ships
now; the turn-wrapper adoption is the (flag-gated) follow-on.

**Integration recipe — one call.** `dispatchWithBasePresence` composes the two so a
turn-wrapper adopts the whole contract in a single line per delta-capable read:

```ts
import { BasePresenceTracker, DeltaToolClient, dispatchWithBasePresence } from '@papercusp/tooldef';

// once per session: enabled=false for an out-of-scope wrapper (external Claude Code / Codex)
const tracker = new BasePresenceTracker({ enabled: harnessOwnsTurnWrapper });
const client = new DeltaToolClient();
// from the wrapper's compaction / session-resume hook:
onCompaction(() => tracker.onCompaction());

// per delta-capable tool read (e.g. plans:attention):
const { rows, mode } = await dispatchWithBasePresence(
  tracker, client, viewKey, itemKeyFor(view),
  (requested) => callTool(name, args, { _meta: requested ? { delta: requested } : {} }),
  { wantSemantic: true },
);
// mode === 'full'         → inject `rows` into the model context
// mode === 'delta'        → the client has checksum-merged a delta into `rows`;
//                           inject a deterministic representation of `rows`
//                           for any full-list/user-visible answer. Do not hand
//                           raw delta rows to the model and rely on it to merge.
// mode === 'not_modified' → inject NOTHING; the base already stands
```

`mode` is the **wire mode the client observed**, not a blanket instruction to
expose that wire body to the model. The client always returns `rows`, the
authoritative reconstructed view. A runtime may use a reduced presentation only
when the user-visible task does not require the full current view; otherwise it
must render from `rows` (or re-fetch full after compaction). The `su-S23`/`S24`/
`S25` gate is specifically about this user-visible correctness class: removed
rows and stale updated rows must not reach the final answer.

**Where this lands (and where it does NOT).** Every delta-capable consumer today is an
EXTERNAL MCP-client runtime — `transport: 'mcp'` calls from spawned cups / psu sessions
(claude-code, omp-via-Meridian, codex *binaries*), never an in-repo Papercusp LLM loop
(the operator's own `runAgentChat` delegates to a child process and owns no message
array). So the model-token win is realized by the **agent runtime** importing
`@papercusp/tooldef` and calling the recipe above inside its own tool-exec loop —
claude-code/codex are contract-excluded (`enabled:false`), omp/Meridian is the in-scope
adopter. The reusable half ships from this repo; the per-runtime call site is that
runtime's (one-line) change. The resilience MCP proxy
([`mcp-proxy/proxy.ts`](apps/operator/lib/mcp-proxy/proxy.ts)) is deliberately stateless
per-request and can't see client compaction, so it is NOT the integration site (a
proxy-level delta would reconstruct `full` for the client — a localhost-moot wire saving,
no model-token win).

## Small-response bypass

Below \~256 bytes of full body
([`DELTA_SMALL_RESPONSE_BYTES`](libs/generic/tooldef/src/delta-protocol.ts)) the
framework skips delta machinery entirely and serves `full` with **no cursor** —
a `not_modified` round-trip (cursor + envelope ≈ 120 bytes) barely saves anything
for a tiny view.

## Endpoint opt-in (the server half — what P-005 built)

A tool opts in by declaring a `delta` capability on its `defineTool`
([`define-tool.ts`](libs/generic/tooldef/src/define-tool.ts)). For this lane the
minimal contract is just a `revision` source — the monotonic/checksum signal the
framework compares against the cursor:

```ts
defineTool({
  name: 'plans:attention',
  // …args, handler returning { data } …
  delta: {
    revision: (args, ctx) => maxPlanRevisionSeq(args, ctx), // string | number | Promise
    scope: (args, ctx) => `${ctx.workspaceId}:${ctx.harnessSlug}:${ctx.role}`,
    schemaVersion: 'v1', // bump to invalidate every outstanding cursor at once
  },
});
```

Ready-made revision sources (audit-confirmed): `plan_revisions.seq`, a plan row's
`version`/`contentHash`/`updatedAt`, cache generation counters, `coord_watermarks`
timestamps. A tool with **no** `delta` capability is unaffected: a `_delta`
request returns `full` + `supported:false`, and a call without `_delta` is
byte-identical to today (zero overhead). A thrown `revision()` degrades to `full`
(`revision_error`) — freshness never fails a call.

> **Telemetry.** The served mode is captured into
> `tool_invocations.metadata_json->>'deltaMode'`
> ([`dispatch-stack.ts`](libs/generic/tooldef/src/dispatch-stack.ts), mirroring
> the `format` capture) so the `not_modified` hit-rate per tool is a measurable
> rollout signal — no DDL.

## Semantic deltas (Lane E) — `added` / `updated` / `removed` rows

A delta-capable tool whose data is (or yields) a **row array** can graduate from
`not_modified` to true semantic deltas by declaring `itemKey`. When the view
changed and the harness asked for a delta (`_delta: "auto~<cursor>"`), the
response carries ONLY the changed rows:

```jsonc
// _meta.delta
{ "mode": "delta", "supported": true, "cursor": "<opaque>",
  "checksum": "<set-hash>", "counts": { "added": 1, "updated": 1, "removed": 1 } }
// body = the changes array (compact/TOON-eligible):
[ { "change": "added",   "id": "P-9", "type": "plan-item", "data": { /* full row */ } },
  { "change": "updated", "id": "E-2", "type": "coord-escalation", "data": { /* full row */ } },
  { "change": "removed", "id": "P-1" } ]                       // removed carries id only
```

`added`/`updated` carry the **full row** (`data`) — a changed row never depends on
the model's base; only completeness + removals do. The diff is **stateless**: the
prior view's `{ itemKey → rowRevision }` digest is embedded in the cursor (`dg`),
so `diffFromDigest(priorDigest, currentRows)` reconstructs added/updated/removed
with no server-stored snapshot. (For an unbounded view that can't embed a digest,
declare `changesSince(args, cursor, ctx)` instead — a watermark-backed query.)

**The merge + checksum safety net (D-007).** The harness applies the changes to
its retained base with `applySemanticDelta(base, changes, itemKey)`, then
recomputes `computeViewChecksum` over the merged set and compares it to
`_meta.delta.checksum`. **Any** mismatch — a missed removal, a mis-merge, an
un-tombstoned drop — forces a full re-fetch. The worst untested path degrades to a
wasted re-fetch, never a wrong action. All three helpers ship from
[`delta-protocol.ts`](libs/generic/tooldef/src/delta-protocol.ts) so the server,
the harness, and the tests share ONE implementation.

**Capability for a semantic tool:**

```ts
delta: {
  itemKey: (row) => row.id,           // stable per-row id (the merge key)
  itemKeyField: 'id',                 // optional; the FIELD NAME row.id reads —
                                       // conveyed on the wire (below) for an
                                       // out-of-process client, which has no
                                       // access to the itemKey FUNCTION itself
  rowRevision: (row) => row.version,  // optional; defaults to a content hash
  rowType: (row) => row.kind,         // optional; tags DeltaChange.type
  rows: (data) => data.items,         // optional; extract the row array when data isn't itself one
  maxDeltaAge: 5 * 60_000,            // periodic forced-full (bounds drift)
  // revision omitted → derived from the item-set checksum
}
```

When `itemKeyField` is declared, `negotiateToolDelta` (`define-tool.ts`) conveys
it as `_meta.delta.itemKeyField` alongside `mode`/`cursor`/`checksum` — the
generic merge key an **out-of-process** client (the MCP proxy /
`dispatchWithConveyedDelta`) needs to apply `row[itemKeyField]` itself. An
**in-process** client (`dispatchWithBasePresence`) doesn't need this: it reads
the `itemKey` function straight off the tool registry (`ProjectedTool.delta`),
same process, no wire hop.

The framework declines a semantic delta WHENEVER it isn't safe — and says why in
`_meta.delta.reason`: `no_digest` (prior cursor had none), `max_age` (cursor too
old → forced full), `delta_too_large` (the delta wasn't smaller than a full
resend), `schema_changed` / `view_changed` (cursor doesn't match this view), or
`changesSince_error`. An explicit `_delta: "not_modified"` is always honored as
ETag-only (never upgraded to a delta body).

### Exemplar: `plans:attention` (P-013)

`plans:attention` is the first exemplar — the strongest ROI target (\~9.6k tokens,
\~19k calls/6h, no `compact` escape). Its response is a GROUPED aggregate
(`{ groups, tierCounts }`, untouched so the UI's `plans.attention` sync read is
unaffected); the diffable unit is the FLAT `AttentionItem` set, extracted with
`rows: (data) => data.groups.flatMap((g) => g.items)`. So an unchanged feed
returns `not_modified` (no replay), a changed feed returns only the
added/updated/removed items (checksum-verified), and first/stale/scope-change/
over-age returns a full snapshot. A grouped view works because the AGENT's unit is
the flat importance-sorted item list; the harness merges items and re-presents
them (the groups are a UI presentation the agent doesn't need to reconstruct from
a delta).

> **Scope reminder.** Semantic deltas are scoped to OMP/psu (the base-presence
> rule above). External Claude Code / Codex always get `full`.

## Production rollout: the flag + the safety gate (P-016)

The LLM-facing **semantic** delta (the `mode:delta` merge — Lane E) is the only
risky part: a wrong merge is *plausible but incorrect*. Per the owner BUILD
decision ([`D-007`/`D-008`](#)), that risk is retired **by test, not by
avoidance** — so the semantic opt-in ships behind a flag and a gate, never on by
default.

**The flag — `papercusp-tool-delta-protocol`** (`libs/flags/src/types.ts`,
default **ON** since the owner-directed flip 2026-06-22; not present in the
`DARK_FLAGS` registry). Since the P-011 flag-default inversion
(`enforce-system-on-generic-work-2026-06-29`), `FLAG_DEFAULTS` is **derived**
from `DARK_FLAGS` (`!DARK_FLAGS.has(key)`) rather than hand-written — a flag
defaults ON simply by NOT being registered in `DARK_FLAGS`, which replaced the
old flat `KNOWN_DARK_FLAGS` allowlist with a reasoned
`Map<FlagKey, { case, reason }>` (`DarkCase`: `incomplete` | `owner-authority`
\| `cutover` | `parked`). OFF ⇒ tools serve only the unconditionally-safe Lane-B
responses (`full | not_modified`); a tool never emits a `mode:delta` body. The
flag is the master switch for the semantic merge. It is a `FLAGS` entry, **not**
an env boolean (env gates ship dark, dodge the default-on guard, and can't be
flipped at runtime). The flip was **dormant-safe** at the time it landed: it
enabled the *server* capability ahead of any client. That gap has since closed —
the client side (originally tracked as WI-514, **resolved as superseded** by the
`agent-tool-delta-client-rollout-2026-06-23` plan) now ships too: `DeltaToolClient`
(`delta-client.ts`) plus the two one-line integration recipes,
`dispatchWithConveyedDelta` (out-of-process — reads the `itemKeyField` the server
conveys in `_meta.delta`, see below) and `dispatchWithBasePresence` (in-process,
composed with `BasePresenceTracker`). Real `mode:delta` traffic still depends on
a runtime actually calling one of these from its own tool-exec loop (psu/cup
Claude-Code sessions and the operator's own `runAgentChat` don't yet — see
"Where this lands" above), so most calls today are still `full | not_modified`
in practice, but the flag is no longer gating on a nonexistent client.

**Where the flag actually bites — the runtime gate.** The flag is enforced
per-request inside `defineTool`'s `negotiateToolDelta` (`define-tool.ts`), not
just at deploy time. tooldef is host-agnostic, so it exposes a resolver seam
(`setSemanticDeltaEnabledResolver` / `isSemanticDeltaEnabled`, `delta-protocol.ts`,
default `() => true`); the host wires it to the flag in
`packages/operator-core/lib/agent-tools/delta-flag-wiring.ts` (a side-effect
import from `agent-tools/index.ts`, same shape as `pre-prompt-registry-config`),
keyed on `ctx.workspaceId` so the flag can be targeted per-workspace. The read
sits **after** the structural narrowing (`rows && itemKey && base.mode === 'full'
&& base.reason === 'changed' && wantsDelta`), so it runs only on a changed-view +
delta-request call — never per-call — and **fails open to the flag default** (a
flag-subsystem throw never silently disables a shipped-ON capability). When the
resolver returns false the upgrade short-circuits to the Lane-B `full` body with
`reason: 'flag_off'` — a distinct, telemetry-visible reason so a mode-mix
dashboard can tell "flag is off" apart from "the view genuinely changed". OFF is
byte-identical to a delta-unaware host.

**The safety gate — `apps/operator/lib/release/delta-gate.ts`**, wired into the
green-checkpoint as `CheckpointDeps.deltaGate` (mirrors `perf-gate.ts`). Before
advancing the green pin it asks: *is the production delta flag ON, and are the
Lane-C scenarios (`su-S23`/`S24`/`S25`) recorded-green-and-fresh?* If the flag is
ON but any scenario is red/errored/stale/missing, it **holds the deploy**
(`reason: 'delta-held'`). Key properties:

* **Reads recorded verdicts, never runs the live model.** It queries
  `llm_test_runs` (via `storage.latestScenarioVerdicts`) — the nightly matrix runs
  the model and persists the verdict; the gate reads it. So the gate is immune to
  account 429s / opus-saturation.
* **Flag-scoped.** Flag OFF ⇒ no-op `pass` (nothing risky shipping).
* **Default-warn, fail-closed-when-armed.** Disabled by default
  (`PAPERCUSP_DELTA_GATE=1` enables it); even enabled it only `warn`s until the
  owner arms `PAPERCUSP_DELTA_GATE_BLOCK=1`. A missing/stale verdict is treated as
  *not proven* (warn|block), never a silent pass — a safety gate must not
  green-light an opt-in it could not verify. Freshness window:
  `PAPERCUSP_DELTA_GATE_MAX_AGE_MS` (default 7d).

**State of the rollout.** The flag flip (`FLAG_DEFAULTS[TOOL_DELTA_PROTOCOL] =
true`, out of `KNOWN_DARK_FLAGS`) and the client build (`DeltaToolClient` +
`dispatchWithConveyedDelta`/`dispatchWithBasePresence`, itemKey conveyance
shipped in `define-tool.ts`) are both **done** — WI-514 closed as superseded by
`agent-tool-delta-client-rollout-2026-06-23` once it found the client + itemKey
conveyance had already landed. What remains is **wiring a real runtime** to call
the recipe from its own tool-exec loop: the out-of-process MCP proxy path is
architecturally closed (a stateless proxy can't see client-side compaction, so
it could only save localhost wire bytes, not model tokens — not worth building);
the live win is an OMP/Meridian-style in-process adopter, which is an
external-runtime change, not an in-repo one. Independent of that: **arm the
gate** (`PAPERCUSP_DELTA_GATE=1`, and `_BLOCK=1` once trusted) once a runtime
actually sends `_meta.delta`, so a future regression that reds the `su-S23`/`S24`/
`S25` scenarios holds the deploy instead of shipping a silent-wrong-merge. Until
then the gate stays default-warn/un-armed — there is still no live caller for it
to protect.

**Telemetry.** Every negotiated response records its mode on
`tool_invocations.metadata_json.deltaMode` (`full | delta | not_modified`,
`dispatch-stack.ts`) — the adoption + savings signal, and the source a
mode-mix dashboard reads.
