# Claude's ToolSearch cannot select a papercusp colon-form tool name — use tools:find / tools:invoke instead
URL: /internal/docs/agent-insights/toolsearch-cannot-select-colon-form-tool-names

Every papercusp doc/prompt/contract writes tool names in colon form (server:verb, e.g. rubrics:search, curation:state-of-pot) — that IS the tool's real cross-client name. Claude's own ToolSearch only resolves the client-mangled mcp__<server>__<verb> form (colon replaced by underscore), so a fresh session following documented tool names hits a hard no-match wall on both select and keyword search. The escape hatch (tools:find, then tools:invoke) already exists and always works — this was a discoverability gap, not a missing capability.

## What (WI-3930)

Found by the GRADE-iter2 M2 battery, reproduced independently by two sessions
on 2026-07-10: an agent following a documented, prescribed read —
`curation:state-of-pot`, `rubrics:list`, `rubrics:search`, `scorecards:freshness`
(the IDEATE-mode grounding-first list; also written this way in the GRADE mode
contract and the su playbook) — tried:

```
ToolSearch({ query: "select:curation:state-of-pot,rubrics:list,rubrics:search,scorecards:freshness" })
→ "No matching deferred tools found"

ToolSearch({ query: "curation state of pot rubrics scorecards grade idea" })  # keyword retry
→ ranked-out misses (work_items_set_state, ReadMcpResourceDirTool, EnterPlanMode, Monitor)
```

Both attempts failed. The agent was blocked from the very tools its own
system prompt told it to read first.

## Root cause — a name-space mismatch, not a broken tool

Papercusp's own tool identity — the one every doc, prompt, contract, and
`defineTool({ name: ... })` call uses — is **colon form**: `server:verb`
(`curation:state-of-pot`, `rubrics:search`). That is one of the [four
distinct string encodings a tool identity has](/internal/docs/agent-insights/mcp-tool-rename-four-string-forms)
— colon token, MCP-projection underscore, dot module-path, slash file-path.

Claude Code's **ToolSearch is a client-native mechanism papercusp does not
implement or control** ([dynamic-tool-surface](/internal/docs/agent-insights/dynamic-tool-surface)
— "Claude: native ToolSearch — untouched"). It indexes and resolves tools by
the **client-visible id**, which Claude constructs from the MCP `tools/list`
entry as `mcp__<server-slug>__<name>` with every `:` in `name` replaced by
`_` (so `curation:state-of-pot` → `mcp__papercusp-su__curation_state-of-pot`).
`ToolSearch({query:"select:curation:state-of-pot"})` is therefore the WRONG
INPUT SHAPE for that mechanism — not a defect in the tool, and not something
papercusp can fix by patching ToolSearch (it isn't papercusp's code).

The keyword-search miss is a second, independent symptom: ToolSearch's own
lexical/semantic ranking over \~550 catalog entries did not surface the right
tool for a reasonable-looking natural-language query. That ranking quality is
also entirely client-side and outside papercusp's reach.

## The fix — the escape hatch already exists; it was just undocumented

Papercusp ships its own hybrid lexical+semantic finder, **`tools:find`**
(`packages/operator-core/lib/agent-tools/tools/find.ts`), whose lexical leg is
**exact-name-authoritative over the REAL (colon-form) tool identity** — the
same string every doc uses. And **`tools:invoke`** dispatches any catalog
tool server-side by that same real name, entirely sidestepping whatever the
calling client's own id-mangling does. Neither of these needed a code change;
the gap was that nothing told a stuck agent to reach for them instead of
retrying ToolSearch with name variants.

**When a documented colon-form tool name doesn't resolve via ToolSearch
(`select:` or a keyword retry):**

1. `ToolSearch({query:"select:mcp__papercusp-su__tools_find"})` (or a keyword
   search like `"find a tool by intent"`) to load `tools:find` itself.
2. `tools:find({query:"<the colon-form name, verbatim>"})` — resolves
   reliably; its lexical leg matches the real name exactly.
3. If the returned hit still can't be called directly (client didn't grow its
   surface), `tools:invoke({name:"<colon-form name>", args:{...}})` — this
   ALWAYS works, on every client, because it dispatches server-side under the
   tool's real identity.

This is now spelled out directly in `apps/operator/prompts/papercusp-su.claude.md`'s
"Finding a capability" section (the injected system-prompt text every Claude
su session gets), so it no longer depends on an agent independently
rediscovering it mid-task.

## Re-reported for `session:*` (EI-12618) — same class, no session-specific defect

EI-12618 hit the same wall for `session:carry-drill` and hypothesised "an
activation/indexing gap specific to `session:*` group tools" — noting that even
the CORRECTLY-mangled `select:mcp__papercusp-su__session_carry-drill` returned
"No matching deferred tools found", not just the colon form. Two clarifications
fall out, and there is **no `session:*`-specific defect**:

* **On a full-catalog session, the defer set is EMPTY, so every `select:` fails
  trivially.** ToolSearch only searches tools the client declared with
  `defer_loading`. A non-seeded (frontier-tier) Claude session gets the FULL
  papercusp catalog directly in `tools/list` — nothing is deferred — so
  `select:<anything>` returns "No matching deferred tools found" no matter how the
  name is spelled. The tool is already in your list: just call
  `mcp__papercusp-su__session_carry-drill` directly (or `tools:invoke`).
* **On a SEEDED session, deferred tools aren't in `tools/list` at all** (papercusp
  grows the surface via `tools:find` → `activateTools`, not the API-native defer
  mechanism — see [dynamic-tool-surface](/internal/docs/agent-insights/dynamic-tool-surface)),
  so ToolSearch has nothing to select there either. The path is `tools:find`
  (which activates the match) → call it, or `tools:invoke`.

`session:carry-drill` is verifiably registered, MCP-projected, in the `tools:find`
corpus (exact-name lexical hit), and dispatchable via `tools:invoke` — the whole
group is fine. A regression guard
(`packages/operator-core/lib/agent-tools/session/carry-drill.test.ts`) locks that
in so the hypothesised "session:\* indexing gap" cannot silently become real.

## Consequence / what NOT to do

* Don't retry `ToolSearch select:` with more name-variant guesses — the input
  shape is what's wrong, not the guessed spelling.
* Don't conclude the tool "doesn't exist" or "the system is missing this
  capability" from a ToolSearch miss — verify via `tools:find` before drawing
  that conclusion (this is exactly the trap WI-3930's GRADE subject fell
  into: the miss was graded `attribution:system`, correctly, since the
  contract itself prescribed an unreachable read — but a session hitting this
  organically should self-rescue via the escape hatch above, not stall).
* This is a **discoverability fix, not a ToolSearch fix** — there is no lever
  in this repo to change how Claude Code's ToolSearch matches or ranks;
  don't file a follow-up expecting one.
