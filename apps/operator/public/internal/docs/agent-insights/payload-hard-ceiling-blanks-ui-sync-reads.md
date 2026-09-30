# Payload hard-ceiling force-trims UI/sync reads — an \"empty\" UI list over a fat shaper-tool is THIS, not missing data
URL: /internal/docs/agent-insights/payload-hard-ceiling-blanks-ui-sync-reads

The 30KB payload-tier HARD CEILING force-applies a tool's trimmed shaper even for tier 'full' — including the in-process callPlansRead → sync-resolver path the operator UI reads. plans:attention (~1.1MB) came back as item-less group summaries, normalizeAttentionGroups dropped them, and the Queue / Overview needs-you / sidebar Inbox rendered EMPTY while 329 decisions existed. Escape hatch: an EXPLICIT per-call payloadTier:'full' (now actually honored, WI-5078).

## Symptom signature

A UI list backed by a `useSyncQuery` named query renders **empty** (or a
badge/count reads 0) while the same data plainly exists server-side. The wire
rows, inspected via the REST fallback:

```bash
curl -s "http://127.0.0.1:3170/api/zero-harness/rest-query?name=plans.attention&args=%7B%7D"
# rows: [{ key, title, maxImportance, itemCount, decisions }]  ← SUMMARY rows, no items[]
```

Rows carrying **aggregate fields (`itemCount`, `decisions`, `itemsTotal`,
`hint`) instead of the full nested payload** is the fingerprint: you are
looking at a payload-tier **shaper's** output, not the resolver's.

Concrete incident (WI-5078, found while shipping the left-sidebar Inbox
EI-13037): the /adv Create→Queue, the Overview NEEDS-YOU tiles, and the new
Inbox pane all rendered empty. `plans:attention` had 1087 items / 329
decision-tier server-side. `normalizeAttentionGroups` (plans-api.ts) drops any
group without an `items` array — correct for its sparse-delta purpose — so
summary rows zeroed the whole feed. Downstream, escalations aged invisibly
("278 human-attention escalations aging past the attention threshold").

## Root cause

`applyPayloadTier` (tooldef) has a **HARD CEILING** guard
(`PAYLOAD_TIER_HARD_CEILING_CHARS = 30_000`, WI-2859): any tool result over
30KB whose tool **declares shapers** gets the smallest shaper force-applied —
*"even `full`"* — on **every transport**. When context-trimming-tiers P-021
added shapers to `plans:attention` (\~1.1MB, the fattest measured payload), the
force-shape started firing on the **in-process UI dispatch too**
(`callPlansReadRaw` → `handleHttpToolRequest` → serialize), despite P-021's
own comment that "the UI (HTTP/sync path, no ctx\_tier) reads full." The tier
WAS full — the ceiling ignored it.

Two contracts were silently broken:

1. Every shaper `hint` (and the generic bounded projection's
   `cursor.args.payloadTier:'full'` retry pointer) documents
   `payloadTier:'full'` as the escape hatch — but the ceiling re-trimmed even
   explicit-full calls, so the documented retry could never return the full
   payload.
2. UI/sync consumers have **no result cap** (they consumed the 1.1MB payload
   for months) — the ceiling protects the MCP client cap, a transport those
   readers don't use.

## The fix (and the contract going forward)

* An **EXPLICIT per-call `payloadTier: 'full'`** now skips the hard ceiling
  (`explicitFullRequest` in `applyPayloadTier`; wired at both define-tool
  serialize sites from `callTier === 'full'`). A *defaulted/session* full
  still gets ceiling-guarded — agent sessions are unchanged.
* `callPlansReadRaw` (the admin-UI + sync-resolver dispatch) passes
  `payloadTier: 'full'` unless the caller specified a tier.
* Recurrence guards: `payload-tier.test.ts` ("EXPLICIT payloadTier:full call
  skips the ceiling") + `read-dispatch.test.ts` (UI dispatch requests explicit
  full).

## If you hit this on ANOTHER tool

Any in-process/UI read path that goes through the tool dispatch (not just
plans) is exposed the moment the tool grows a `shape` and its payload crosses
30KB. Symptoms as above → pass `payloadTier: 'full'` explicitly at the
dispatch seam (the UI side), never by weakening the ceiling itself (agents
still need it). If an MCP **agent** explicitly requests full and overflows its
client cap, the client's result-door (file + paged reads) handles it — that is
a deliberate caller choice.

## Verification recipe

```bash
# after a server-side fix, restart staging via the coordinated tool (never raw systemctl):
#   tools:invoke dev:restart { target: 'staging', confirm: true, authorize: true, reason: 'reload the staging operator with updated code' }
curl -s ".../rest-query?name=plans.attention&args=%7B%7D" | python3 - <<'EOF'
import json,sys; j=json.load(sys.stdin); rows=j["rows"]
print(len(rows), sum(len(r.get("items") or []) for r in rows))
EOF
# expect: 170 1087-ish — rows WITH items[]. Summary-only rows = still shaped.
```

Note: the desktop app's own operator (`:3270`) is a separate process — it
serves the fix only after the app (or its operator sidecar) restarts.
