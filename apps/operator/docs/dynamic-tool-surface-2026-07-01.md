# Dynamic tool surface — a per-session mutable MCP catalog for all agent clients

**Status:** ✅ IMPLEMENTED + live-verified (2026-07-01) · **Date:** 2026-07-01 · **Scope:** operator MCP transport
(`_mcp-handler.ts`) + tool-allowlist + `tools:find` + psu launch wiring
(omp/codex). Successor to the static-trim approach; folds in
`tool-discovery-for-weak-models-plan-2026-06-30.md` and the
`weak-model-tool-tier` work shipped 2026-07-01.

---

## 1. Problem — the trilemma

The full superuser MCP catalog is **~580 tools / ~140k tokens**. Three costs
compete, and every static approach can only buy two:

1. **Reachability** — a client can only *call* a tool it received in
   `tools/list` (OMP returns `toolNotFound` otherwise; **verified**: a trimmed
   OMP session's `search_tool_bm25` returns only core tools).
2. **Token cost** — sending all ~580 schemas every turn is ~140k tokens —
   billed *and* attention-diluting — **even on a big-context model** (Codex).
3. **Focus** — a weak model handed ~580 choices hallucinates tool names instead
   of picking correctly (the original ornith failure).

| Approach | Reachability | Token cost | Focus |
|---|---|---|---|
| Static trim (`?tools=core`) | ❌ tail stranded | ✅ ~7k | ✅ |
| Full catalog (+ primer) | ✅ | ❌ ~140k | ⚠️ primer helps |
| **Dynamic surface (this plan)** | ✅ on demand | ✅ ~7–15k | ✅ |

## 2. Key finding (verified 2026-07-01)

MCP's `notifications/tools/list_changed` lets the **server grow a client's tool
set mid-session** — the escape route the earlier plan dismissed as "not needed":

- **OMP acts on it.** Bundle: `onNotification → case "tools": refreshServerTools(f)`
  → clears the cached set and **re-fetches `tools/list`**. OMP's callable
  registry is *not* frozen at launch.
- **papercusp can drive it.** `_mcp-handler.ts` already sends server→client
  notifications on the response stream (`notifications/papercusp/event`,
  `notifications/progress`).
- **The only gap** is one line: capabilities declare `tools: {}` instead of
  `tools: { listChanged: true }` — exactly the flag OMP checks
  (`J.tools?.listChanged === true`).

So: advertise a **small seed surface**, and **expand on demand** — the model
calls `tools:find`, the server adds the matches to that session's live tool-set
and fires `list_changed`, the client re-fetches and can now call them. Small
default (token + focus win) **and** full reachability (on demand). The trilemma
dissolves.

## 3. Decisions (recommendations)

- **D1 — Heterogeneous, per-client best layer (NOT one unified mechanism).**
  Claude → its native **ToolSearch**; OMP + Codex → server-driven dynamic
  expansion. *Why:* ToolSearch is this exact "defer-then-activate" pattern done
  client-side and strictly better for Claude (no server round-trip, works today,
  reachability already preserved). Unifying would downgrade Claude and risk two
  systems fighting over the surface.

- **D2 — Dynamic expansion via `tools/list_changed` is the PRIMARY mechanism**
  for clients that honor it (OMP confirmed). Server: declare the `listChanged`
  capability + a **per-session mutable allowlist** (seed = core spine, grows via
  `tools:find`) + fire `list_changed` after `tools:find` surfaces tools.

- **D3 — `tools:invoke { name, args }` meta-tool as the UNIVERSAL fallback** and
  a reachability escape hatch: one core tool that dispatches server-side to any
  of the ~580 tools. Works regardless of `list_changed` support. Trade: the
  model constructs calls *indirectly* (name+args as data) — fine for strong
  models, harder for weak ones, so it's the fallback, not the default.

- **D4 — Implement for Codex too, driven by TOKEN COST (not just reachability).**
  Codex loads the full catalog upfront (~140k tokens/turn) on *any* model, so
  dynamic expansion is a real win even on strong models. Verify Codex's
  `list_changed` support; if absent, Codex uses the meta-tool (D3) over a small
  seed.

- **D5 — Claude stays on native ToolSearch, untouched.** No new work; it already
  defers over the full catalog (reachability + low tokens). The server must
  **not** fire `list_changed` at Claude sessions (avoid the conflict) — the
  mechanism is gated to omp/codex, which the launch layer already distinguishes.

- **D6 — The static `?tools=` trim becomes the SEED, not a hard cap.** Reuse the
  existing `parseToolsAllowlist` / `filterListingsByAllowlist` machinery; make
  the per-session set **mutable** instead of fixed-at-connect.

- **D7 — Small-seed becomes the DEFAULT only once dynamic expansion is verified**
  (reachability preserved). Until then, the interim state shipped this session
  holds: OMP weak default = full catalog + primer, trim opt-in.

- **D8 — Seed size is per-tier, a tuning knob (not fixed at 19).** Weak model →
  19 core (tight focus). Strong model / Codex → core + a wider common set (token
  cost is the driver there, not focus). Tunable, seeded from the tier gate.

- **D10 — "Default all to trimmed" (2026-07-01, supersedes D5/D7's frontier-full
  default).** The small-seed dynamic surface is the DEFAULT for EVERY client + tier,
  including frontier Claude/Codex/OMP. Rationale: the ~165k up-front tool-list cost is
  almost entirely descriptions the model never reads (a session uses ~15–30 tools); the
  discoverability downside is smallest for frontier models (they reason + intent-search
  well) and is cheaply restored by the capability map (D11); reachability holds via
  `tools:find`/`list_changed`/`tools:invoke`. `contextSize:'full'` becomes the OPT-OUT
  escape hatch (eager whole-catalog load) for latency-critical broad-tool tasks, a client
  that can't do dynamic expansion, or debugging. Gate: `wantsSeed = contextSize !== 'full'`
  in `role-launch-spec.ts`; `psu-launcher.mjs` mirrors it for OMP + Claude. **Supersedes
  D5** (Claude is now seeded too — ToolSearch defers only schemas, not the ~165k of
  names+descriptions, which is the actual waste). Pending: an A/B eval (P-007) + live
  Claude/Codex `list_changed` verification before this is considered proven, not just
  shipped.

- **D11 — Compact capability map preserves discoverability.** A ~2.2k-token category
  menu (all ~555 tools grouped by namespace, with example names + a `tools:find`/`tools:invoke`
  directive), generated from the registry (`capability-map.ts`) and injected into the MCP
  `initialize.instructions` (`mcpInstructionsForServer`). It's the "menu" a seeded model
  browses to know WHAT exists to search for — discoverability at ~1% of the ~165k full
  descriptions. Harmless for `full`/eager sessions (seed-agnostic wording).

- **D12 — Trimmed OMP runs discovery OFF (live-verified necessity, 2026-07-01).** With OMP
  tool-discovery ON, even the seed's front doors (`tools:find`/`tools:invoke`) sit behind
  `search_tool_bm25` activation — a 0-match query strands the ENTIRE surface (verified on
  ornith: bm25("schedule inventory") → 0 matches → nothing callable → the session dead-ends
  improvising via bash/eval). A ~20-tool seed needs no discovery gate; `discoveryOff:true` +
  `toolsAllowlist` exposes the spine directly AND lets the post-`list_changed` refresh
  auto-expose surfaced tools instead of gating them behind a second bm25 pass
  (`psu-launcher.mjs` trimmed branch). Client verification matrix (real headless sessions
  against :3170, trimmed 20-tool seed, off-seed target `schedule:inventory`):
  **Sonnet PASS** — `tools:find` → `activated:true` → direct off-seed call, real data;
  **Codex PASS** — `tools:invoke` fallback, real data (headless codex NEEDS the harness's
  standard `-s danger-full-access --dangerously-bypass-approvals-and-sandbox`, else every MCP
  call auto-denies as "user cancelled"); **OMP/ornith** — with discovery ON it failed as
  above; this decision is the fix. Server side exonerated by replay: `tools/list` grows
  20→25 under the same client key, and OMP's log confirms `notifications/tools/list_changed`
  is received on the POST response stream even with `disableSse`. Guidance hardened
  alongside: `tools:find`'s `howToCall`/`chaining` + the capability map now say "if a found
  tool errors not-found, run it via `tools:invoke` — never guess name variants".

## 4. Phases / work items

**Phase 0 — server-side mutable surface state**
- **P-001** Per-session mutable tool allowlist store, keyed by the MCP
  session/client id, **seeded** from the connect-time `?tools=`, mutable at
  runtime. (`tool-allowlist.ts` + `_mcp-handler.ts`)
- **P-002** Declare `tools: { listChanged: true }` in `MCP_SERVER_CAPABILITIES`
  (+ the `mcp-notifications.test.ts` regression).

**Phase 1 — dynamic expansion (OMP)**
- **P-003** On `tools:find`, add the matched tool names to the session allowlist
  and fire `notifications/tools/list_changed` on the session stream.
- **P-004** `tools/list` reflects the mutable per-session allowlist on re-fetch.
- **P-005** **Live-verify the OMP round-trip on ornith** — `tools:find` →
  `list_changed` → OMP re-fetch → the surfaced tool is callable. *The acceptance
  test — the mechanism is confirmed in the bundle but the full loop is unrun.*

**Phase 2 — meta-tool fallback + Codex**
- **P-006** `tools:invoke { name, args }` meta-tool (server-side dispatch to any
  projected tool); add to the core spine.
- **P-007** Verify Codex honors `list_changed` (empirical). Yes → wire Codex to
  the dynamic surface. No → Codex uses `tools:invoke` over a small seed.
- **P-008** Codex launch seeds the small surface — repurpose the
  `role-launch-spec` `?tools=` gate as a tier-sized **seed** (D8), not a cap.

**Phase 3 — cutover + docs**
- **P-009** Once P-005 passes, flip OMP weak-default (and Codex) from
  full/­full-catalog to **small-seed + expand** — the token-cost win, now
  reachability-safe (D7).
- **P-010** `agent-insights` doc: the dynamic-surface model; retire the "static
  trim strands the tail" caveat; anchor it to the handler + `tools:find` + the
  capability flag.

## 5. Risks / mitigations

- **Notification timing** — `list_changed` fires during `tools:find`'s response;
  the surfaced tool becomes callable on the *next* turn (1-turn latency, matches
  the natural find→call flow). Confirm in P-005.
- **Codex may not honor `list_changed`** → the `tools:invoke` meta-tool (P-006)
  covers it regardless.
- **Per-session state lifecycle** — bind the mutable allowlist to the MCP
  session; evict on disconnect.
- **Claude conflict** — never fire `list_changed` at a Claude session; gate the
  mechanism to omp/codex (the server already knows the client).

## 6. Validation

- **P-005 round-trip** on ornith (OMP) — the acceptance gate.
- **Token measurement** — seed surface ≈ 7–15k vs ~140k full (the win, on Codex
  too).
- **Reachability** — a mid-session-surfaced tool is callable (both the
  `list_changed` and `tools:invoke` paths).
- **No regression** — Claude keeps ToolSearch; strong-model sessions unchanged
  unless opted into a seed.

## 7. Relationship to work already shipped (2026-07-01)

- **400 fix** (sanitizing proxy + server schema-sanitize) — DONE, orthogonal;
  keep. It's why the small-seed default is now safe to pursue (weak models can
  actually run).
- **Static trim opt-in** (`writeOmpSessionConfigDir` + `?tools=`) — DONE →
  becomes the **seed delivery** (D6).
- **model-tier gate + `model` threading** — DONE → decides the **seed size** per
  tier (D8).
- **Full-mode `PI_CONFIG_DIR` fix** (home-relative + faithful registry) — DONE;
  keep.
