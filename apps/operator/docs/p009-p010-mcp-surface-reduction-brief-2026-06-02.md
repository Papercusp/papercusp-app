# Brief — P-009 + P-010: shrink the operator brain's MCP surface (fix the 600s flailing)

**For:** the agent picking up P-009/P-010
**Companion plan (source of truth):** `voice-persona-production-readiness-2026-06-02` (read its
"⚠ ROOT CAUSE FOUND" section first)
**Author:** review handoff, 2026-06-02
**Division of labor:** you own P-009 + P-010 (the shared MCP-endpoint change + naming). The
other agent continues the voice/operator LLM tests (Phase 3b persona items, the S13..S16
harness) in parallel — coordinate via `coord:*` / file locks; don't touch the persona's
*behavioral* rules (terseness/grounding/jargon), only its **tool-name references**.

> **Plan first.** This touches a **shared** MCP endpoint that *every* spawned agent
> (worker/scoper/architect/validator/oracle/delegate/scan) connects to. Present a plan and get
> review before implementing. Land + validate one piece at a time; do not batch-tune.

---

## 1. The bug, in one paragraph

The operator brain (the `operator:converse` voice/text agent) connects to the agent-mcp HTTP
endpoint with `?superuser=1`, which **bypasses all role/capability filtering** — so it is handed
the **full catalog (~226 tools)**. Claude Code **defers** a tool set that large client-side: each
tool must be `ToolSearch`-activated before it can be called. The brain then flails — 4+
ToolSearches/turn, trying `harness_list` / `harness:list` / `harness:list({})`, 11 tool calls /
121s per turn, occasionally looping to the **600s `operator:converse` cap**. The *same* root
causes the missing disambiguation card (it ToolSearches `chat:ask_choice` then `chat_ask_choice`,
neither emits a card) and groundedness misses (narrates before data returns). **This is
infrastructure, not persona** — terseness/grounding/`disallowBuiltins` (all already committed)
cannot fix it.

**Fix:** shrink the brain's *exposed* `tools/list` to the ~40 tools it actually uses, so Claude
Code loads them **directly** (no deferral → no ToolSearch). Two parts:

- **P-009** — a per-request tool-allowlist on the agent-mcp HTTP endpoint, passed only by `converse.ts`.
- **P-010** — reconcile the persona's (and the allowlist's) **colon** tool names → **underscore**, the form the brain actually sees.

---

## 2. Confirmed code anchors (all paths under `apps/operator/papercup` checkout, on `main`)

### HTTP MCP transport (where the brain connects)
- **`apps/operator/lib/endpoint-route/routes/transport/_mcp-handler.ts`** — the HTTP/SSE MCP
  handler. It already reads many `url.searchParams.get(...)` params (`superuser`, `workspace`,
  `harness`, `client`, `plan_run`, `profile`, `power_user`, `role`, `spawn`, `sig`, `exp`) around
  lines 155–230. **This is where you parse a new `?tools=` param** and thread it into the listing.
- **`apps/operator/lib/capabilities/server-catalog.ts`** — `getServerCapabilities({...})` builds
  the `tools/list` projection and **already supports a per-listing filter**: it can drop tools
  whose `agentRoles` allowlist excludes the caller "so the listing matches invocability." A
  name-based `?tools=` allowlist slots in here as an additional filter (or you may be able to
  reuse the existing role/agentRoles path — evaluate both).
- **`packages/agent-mcp/src/gate-bypass.ts`** — superuser bypasses role/capability/quota. Your
  `?tools=` filter is an *independent name allowlist* applied **after** the ctx is resolved; it
  must NOT depend on the gate (the brain is still superuser, just listing fewer tools).

### The operator's existing curated set (your `?tools=` payload)
- **`apps/operator/lib/operator-mcp-tools.ts`** → `ALL_AGENT_MCP_TOOLS` (~40 tools). This is
  already what `converse.ts` passes as the claude-code `allowedTools` *permission* list — but
  `allowedTools` only governs **what may be called**, it does **not** reduce what `tools/list`
  returns, which is why deferral still happens. Your `?tools=` filter is the missing half: it
  makes the *listing* itself small. Derive the `?tools=` set from this list (stripped of the
  `mcp__agentmcp__` prefix → the raw catalog names the server lists under).

### Where converse wires it
- **`apps/operator/lib/agent-tools/operator/converse.ts`** — line ~227 builds
  `mcpUrl = ${selfUrl()}/api/mcp?superuser=1&workspace=...`. Append
  `&tools=<comma-separated core set>` here. **Only converse passes it.** (Consider also
  `operator-scan` / `delegate` later, but keep this change scoped to converse for the first land.)

### The precedent to study (don't reuse it directly)
- **`packages/agent-mcp/src/tool-manifest.ts`** + `applyToolManifest` (`server.ts:370`) — an
  existing surface filter that "decouples *tool exists* from *tool is exposed*," with the key
  property **absent/empty manifest ⇒ expose everything** (backward-compatible). Mirror that
  default for `?tools=` (no param ⇒ expose all). **But the manifest is the wrong lever here:** it
  is process-**global** and stdio-transport only — it would shrink the surface for *every* agent
  and every spawn. P-009 must be **per-request** on the HTTP path so only the brain is affected.
  Read its header comment for the **prompt-cache-stability** requirement (next section).

---

## 3. Hard constraints

1. **Backward-compatible default.** No `?tools=` param ⇒ list everything, exactly as today. This
   is what keeps worker/scoper/architect/oracle/delegate/scan spawns **unaffected** — verify each
   still gets its full surface.
2. **Cache-stable output.** The agent-mcp `tools/list` surface is deliberately byte-stable (see
   `tool-manifest.ts` header: a shifting catalog busts the upstream prompt cache and re-bills the
   whole conversation prefix). The `?tools=`-filtered list must be **deterministically ordered**
   and **stable for a given param value** (converse always sends the same set → fine; just don't
   sort by `Set` iteration or map insertion that can vary).
3. **Name form must match the catalog.** The `?tools=` values must match the names the server
   lists tools under — **confirm whether that is colon (`harness:status`) or underscore
   (`harness_status`) at the catalog layer**, independently of the `mcp__agentmcp__` claude-code
   prefix. Get this wrong and the filter silently drops everything → empty surface → worse than
   today. Add a test.
4. **Don't break dispatch.** Filtering the *listing* must not change what `tools/call` will
   accept — a tool the brain still legitimately needs must remain callable. (It will, since the
   brain only calls what it's told about; but assert it.)

---

## 4. P-010 — the highest-leverage single change

`ALL_AGENT_MCP_TOOLS` itself **mixes colon and underscore** names (e.g.
`mcp__agentmcp__harness:list` vs `mcp__agentmcp__orchestrator_spawn`). The file's own comment
notes claude-code converts `.`→`_` and that "the allowlist must match what Claude sees." The brain
sees **underscore** names. And critically: **`converse-prompt.ts:91` builds the persona's
advertised tool list by iterating `ALL_AGENT_MCP_TOOLS`** — so the colon names leak straight into
what the persona tells the model to call. The brain then ToolSearches the colon form, resolves
nothing, and flails.

→ **Fixing the naming in `ALL_AGENT_MCP_TOOLS` (colon → the real underscore catalog name)
simultaneously fixes the allowlist, the persona's advertised names, and the `?tools=` payload.**
Then sweep the remaining hardcoded colon refs:
- `apps/operator/lib/operator-converse-prompt.ts` (7 colon refs: `harness:status/list`,
  `issues:list`, `chat:ask_choice`, etc.)
- `apps/operator/prompts/operator.persona.md`
- `apps/operator/prompts/operator.tools.md`

Add an explicit persona line: *"Your tools are already loaded under their underscore names
(`harness_status`, not `harness:status`) — call them directly; do not `ToolSearch` for them."*
(P-010 helps even if P-009 slips — colon→underscore stops the wrong-name ToolSearch loop on its
own.)

---

## 5. THE open question — verify empirically, do not assume

**Nobody has confirmed that ~40 tools is below Claude Code's deferral threshold.** This uncertainty
is the entire reason the prior session did not land this blind. Before declaring success:

1. Spawn `operator:converse` with the `?tools=` filter and **inspect the brain's init** — confirm
   the operator tools appear **non-deferred** (no "activate via ToolSearch" wrapper). If they're
   still deferred at ~40, go tighter: define a **voice-specific ~15–25 tool subset** (the brain
   really only needs `harness_status/list`, `issues_list`, `chat_ask_choice`, `plans_*` read,
   `messages_*`, `search_*`, the `ui_*` trio). Find the threshold experimentally.
2. Then run the validation matrix and confirm the flailing stops.

---

## 6. Verification recipe (plan decision D-001 — non-negotiable)

Run the declared **3× `runMatrix`**, `brain=sonnet`, `judge=sonnet`. N=1 + haiku-judge has
produced a wrong "resolved" verdict before — don't trust it.

```
LLM_TEST_BACKEND=claude-code LLM_TEST_SIM_MODEL=haiku LLM_TEST_JUDGE_MODEL=sonnet \
PAPERCUSP_LLM_TEST_SKIP_CLAIM=1 \
npm --prefix apps/operator run llm-test -- --scenario op-S16
```
(declared scenarios run their 3× matrix; do **not** pass `--no-matrix`.) Set the brain to sonnet
for the run via agent-config `models['operator']`; restore after. **Success = the brain's tools
load non-deferred + a 3× S13/S16 run shows no ToolSearch flailing + `cardUsage` passes + no 600s
timeout.** Also run a quick `op-` smoke against a non-converse role (e.g. a scoper/worker spawn)
to prove the full surface is intact for everyone else.

---

## 7. Coordination notes (shared dev box, on `main`)

- File-lock enforcement is automatic (PreToolUse hook). If blocked on `_mcp-handler.ts` /
  `server-catalog.ts` / `converse.ts` / the persona files, pivot or yield — the voice-test agent
  may touch `operator-converse-prompt.ts` too, so **coordinate the persona edits** (you take the
  tool-*name* references; they take the behavioral rules).
- For the multi-file change held across the commit, consider
  `locks:acquire { paths: [...], intent: 'P-009 ?tools= MCP surface filter', ttl_sec: 1200 }`.
- `:3070` has **no hot-reload** for `lib/**` — restart the operator (`dev:restart`, which drains
  peers) before validating, and re-probe that your change is live.
- Stay on `main`; commit each unit (`git commit --no-verify`); don't push.
- Update the plan `voice-persona-production-readiness-2026-06-02` (flip P-009/P-010 status, record
  the deferral-threshold finding) when done.

---

## 8. Done means

- [ ] `?tools=` parsed in `_mcp-handler.ts`, applied in `server-catalog.ts`; absent ⇒ list-all (test).
- [ ] `converse.ts` passes the operator core set; no other spawn passes it (verified full surface intact).
- [ ] `ALL_AGENT_MCP_TOOLS` + the 3 persona files use the real underscore names; persona says "already loaded, don't ToolSearch."
- [ ] Brain init shows operator tools **non-deferred** (threshold empirically confirmed; tighten the set if needed).
- [ ] 3× sonnet-judge S13/S16: no flailing, `cardUsage` passes, no 600s timeout.
- [ ] A non-converse role still sees the full catalog.
- [ ] Plan updated; changes committed.
