# Prompt assembly
URL: /internal/docs/agents/prompt-assembly

How a role's system prompt is built from persona, tools catalog, role playbook, a shared-base policy block, and runtime context. The reference assembly layer that sits next to the endpoint system.

import { Aside } from '@astrojs/starlight/components';

## The one-line version

`assembleRolePrompt` in `packages/operator-core/lib/prompt-assembly.ts` builds a role's system prompt from a **persona + catalog + playbook** core, a **shared-base policy block**, and **runtime context** — concatenated in fixed order:

```
1.  <role>.persona.md         character + behavior rules
2.  Tools catalog             per-tool guidance from defineTool({ guidance })
3.  <role>.tools.md           cross-tool patterns + workflows
─── shared-base policy block (≈14 sections, see below) ───
4.  coord-legend              how to read injected [coord+N] blocks
5.  friction-tripwire         file friction you felt
6.  observation-rubric-nudge  how to grade a turn-end observation
7.  yield-policy              cooperative turn:interrupt yield behavior
8.  account-routing-note      don't mis-diagnose routing as capacity
9.  concurrency-first-note    don't back off on contention
10. testing-standard          write tests the project way
11. deploy-pipeline-note      don't babysit the async pipeline
12. reuse-first-nudge         extend, don't fork
13. code-run-note             collapse N tool calls into one code:run
14. finish-the-rollout-note   built-but-gated-OFF is incomplete; flip it on
15. agent-activity-truth-note "who's doing what" is a live derived truth
16. wait-loop-note            waiting? arm a self-wake loop, don't sleep blind
17. peer-wake-note            you can WAKE a peer; handing work off isn't enough
─────────────────────────────────────────────────────────
18. Runtime context           caller-supplied blocks (history, trigger, ...)
```

Sections 1 and 3 are filesystem files under `apps/operator/prompts/`. Section 2 is auto-rendered from the projection registry. Sections 4–16 each come from a single orchestrator constant (re-exported through a `render*` wrapper) so the operator-launched-role base stays byte-identical with the spawned-cup base. Section 17 is per-request data (conversation history, trigger reason, etc.). The catalog and the playbook are skipped when empty/absent, and each shared-base section collapses to nothing when its renderer returns `''`, so a given prompt may have fewer than 18 sections.

`assembleRolePrompt` is the **reference/CLI assembly path** — `role-launch-spec` uses it (via the *orchestrator's* slug-based variant; see [API](#api)) and tests exercise this one, but **no live chat route calls operator-core's `assembleRolePrompt` directly**. The two real chat surfaces — operator converse and oracle — call the lower-level loaders (`loadRolePersona` / `renderToolsCatalog` / `loadRoleToolsMd`) and assemble manually so they can interleave converse rules and audience-mode overlays. The per-feature worker-chat route (`agent-chats`) calls the **orchestrator's** distinct slug-based `assembleRolePrompt` (the spawned-cup `buildPrompt` path), which produces a different layout entirely. Read this page as the canonical description of *the layering*, not a single function every surface funnels through.

## Why a separate layer

The [endpoint system](/internal/docs/endpoint-system/overview) decides *what* tools exist and *how* they get invoked across transports. The prompt-assembly layer decides *what the model is told about those tools and how to use them*. Different concerns; different files.

A given tool needs **three** kinds of guidance authored:

| Question                                                                  | Where it lives                | Why                                                                             |
| ------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------- |
| "How do I call this tool?"                                                | `defineTool({ inputSchema })` | Schema is consumed by MCP `tools/list`; the model sees it via its API parameter |
| "When should I call this tool vs. another?"                               | `defineTool({ guidance })`    | Lives at the tool — authored once, projected per-role into every prompt         |
| "When working as the operator, what workflows span multiple tools?"       | `<role>.tools.md`             | Can't live at any single tool; verbs across tools                               |
| "How does this agent behave — character, tone, what to never read aloud?" | `<role>.persona.md`           | Agent-level, not tool-level                                                     |

If you put cross-tool guidance in a single tool's `guidance`, you have to copy it to N other tools when you change it. If you put per-tool guidance in `<role>.tools.md`, you have to copy it to every role file the tool appears in. The split avoids both.

## The sections

### Section 1 — `<role>.persona.md`

Character + behavior rules for the role. Always-on. In `assembleRolePrompt` it is pushed first. Note the real operator chat route doesn't keep it first: `converse-prompt.ts` pushes the audience-mode overlay (`operator.persona.<mode>-mode.md` via `loadRoleModePersona`), then the converse rules (`loadRoleConverse`), *then* the persona — so in the live operator assembly persona is the **third** system section. The fixed-order guarantee is about `assembleRolePrompt`, not about every hand-built surface.

```markdown
# Operator persona

You are the user's local operator. Your job is to keep them productive…

## Behavior rules
- Never read URLs aloud in voice mode — speak the title/host instead.
- Tier-high panel cards require explicit user confirmation before dispatch…
```

Loaded by `loadRolePersona(role)`, which **throws if the file is missing**. Only the roles whose persona is assembled through `loadRolePersona` keep a `<role>.persona.md` here — today that is just `auditor`, `operator`, and `oracle`. The orchestrator-spawned roles (worker, scoper, architect, validator, reviewer, debugger, documenter, curator) get their persona from a *different* path: the orchestrator's `resolvePromptFiles` reads `blueprints/base/prompts/<role>.md` (plus an optional `<role>.base.md` prefix), not `apps/operator/prompts/<role>.persona.md`. Calling `loadRolePersona`/`assembleRolePrompt` for one of those roles would throw, because no persona file exists for it in this directory.

### Section 2 — Tools catalog

Auto-rendered from the projected-tool registry. The caller passes a list of MCP tool names (the role's `allowedTools` for chat surfaces, or the role-filtered catalog for spawn-URL agents); each tool emits a block:

```markdown
## Available tools

- `chat:ask_choice`
  Present the user with a structured set of clickable choices…
  When: You would otherwise end a turn with a yes/no, accept/reject, or pick-one-of question…
  Not when: For OPEN-ENDED questions ("describe what you want"…), keep using plain text…
```

The `When` / `Not when` / `Chaining` lines come from each tool's `defineTool({ guidance: ... })` declaration. Tools without `guidance` render with description only (backwards-identical to pre-guidance).

The catalog is THE authoritative answer to "what tools does this role know about?" It's filtered by the caller's `allowedTools` for chat surfaces, and re-derived for every request — agents always see the current surface, no stale list to chase.

`renderToolsCatalog(role, toolNames, modality = 'text', displayTransform?)` has two filters the four-section sketch hides:

* **`modality`** (`'text' | 'voice'`) — each tool may declare a `modality: ('text' | 'voice')[]`; a tool whose array excludes the requested modality is dropped. The default when a tool omits the field is `['text', 'voice']` (usable in either surface). Voice surfaces pass `'voice'`, so e.g. the `plans:*` write tools (declared `modality: ['text']`, e.g. `plans/new.ts:208`, since plan-editing is a text-surface task) fall out of the voice catalog automatically. (`chat:ask_choice` declares no `modality`, so it defaults to `['text', 'voice']` and stays in both surfaces.)
* **`displayTransform`** — an optional rewrite of the *displayed* tool name (lookup is always by the colon MCP name). The operator passes a `:`→`_` transform so the catalog advertises `harness_status` instead of `harness:status`: Claude Code sanitizes the colon out of MCP tool names before handing them to the model, so the catalog must show the underscore form the model actually sees. Every other role uses the identity default, so its catalog is byte-identical.

### Section 3 — `<role>.tools.md`

Cross-tool patterns, named workflows, and discovery hints. **Optional** — falls back to no playbook section when absent.

```markdown
# Operator role playbook

## Cross-tool patterns
- `*_list` → `*_get`: list to find the id, get for detail. Don't get without listing first.

## Workflows

### Approve a pending review
1. `harness:pending_reviews` (filter by slug if user named one)
2. Confirm out loud: "Approving X for sheets — go?"
3. `operator:dispatch` with slug + capability from step 1

## Discovery

For tools not in this playbook, call `agent_tools:list { onlyAllowed: true }`
to introspect the full role-filtered surface.
```

13 files exist today: `architect`, `auditor`, `cup`, `debugger`, `operator`, `oracle`, `papercusp-su-engineer`, `papercusp-su-power`, `reviewer`, `scoper`, `tester`, `validator`, `worker`. Loaded by `loadRoleToolsMd(role)`, which returns `null` (no playbook section) when the file is absent.

### Section 3b — Shared cross-role guides (spawn path only)

The orchestrator's spawn path additionally injects authored MDX from `apps/operator-docs/src/content/docs/agents/` as a separate `sharedGuides` section after `<role>.tools.md` (see `prompt-build.ts`). Today this loads `finding-context.mdx` (the retrieval-surface decision tree). The page lives in the docs site so humans + agents share one source; the orchestrator strips frontmatter and emits the body as another `## ...` section. See [Finding context](/internal/docs/agents/finding-context).

`sharedGuides` is a **spawned-cup `buildPrompt` feature only**. Operator-core's `assembleRolePrompt` — the function the rest of this page documents — has no `sharedGuides` parameter and never emits this section. The shared-base policy block below is the analogue it *does* inject.

### Section 4 — Runtime context

Per-request blocks supplied by the caller via `AssembleOptions.runtime`. Conversation history, trigger reason, the `[may_ask_active]` marker, etc.

```markdown
## Conversation history

[user] What's wrong with sheets?
[assistant] Sheets has 3 escalations. The most recent is…

## Trigger

user_message — the user just sent a message in chat.
```

The order within runtime is caller-controlled. The contract is: runtime always comes last so it can refer to everything above it.

## The shared-base policy block

Between the tools playbook (section 3) and runtime (section 18), `assembleRolePrompt` injects up to **fourteen shared-base policy sections** in this order:

| Section                     | What it primes                                                                                                                                                                                                                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `coord-legend`              | how to read the injected `[coord+N]` blocks the PostToolUse hook adds                                                                                                                                                                                                                                                    |
| `friction-tripwire`         | file friction you *felt* (a workaround, a misleading doc, a >3-attempt confusing failure) via `improvements:capture` the moment it hits                                                                                                                                                                                  |
| `observation-rubric-nudge`  | when filing a turn-end observation, check `rubrics:list` first and file a structured observation if an active rubric fits                                                                                                                                                                                                |
| `yield-policy`              | on a `turn:interrupt` yield: checkpoint, persist partial state, release locks, leave a successor note, end the turn                                                                                                                                                                                                      |
| `account-routing-note`      | don't mis-diagnose a routing/config fault as a true capacity limit; steer LLM work onto the account-routing system                                                                                                                                                                                                       |
| `concurrency-first-note`    | don't back off on contention — the only legit block is verified resource exhaustion; the design target is hundreds-to-thousands of concurrent agents                                                                                                                                                                     |
| `testing-standard`          | write tests the project way                                                                                                                                                                                                                                                                                              |
| `deploy-pipeline-note`      | your change ships via an async, self-healing pipeline; don't babysit or self-diagnose a stall                                                                                                                                                                                                                            |
| `reuse-first-nudge`         | extend an existing durable surface, don't fork a parallel one                                                                                                                                                                                                                                                            |
| `code-run-note`             | reach for `code:run` to collapse a multi-step tool flow into one call instead of N inference round-trips (self-gated on `code:run` being in your toolset)                                                                                                                                                                |
| `finish-the-rollout-note`   | a capability built then left gated OFF (flag or env boolean) is incomplete — flipping the gate on is the last step of the task                                                                                                                                                                                           |
| `agent-activity-truth-note` | "who's doing what" is a live derived truth (`fleet:assignments`: claim + holder-liveness + progress), never a stale coord broadcast that outlives the work                                                                                                                                                               |
| `wait-loop-note`            | waiting on something that may never fire? arm a recurring self-wake (`loop:arm` / `pot:declare-wake`) and FIX what's blocking it — don't sleep forever on a bare `events:await`                                                                                                                                          |
| `peer-wake-note`            | a parked agent sleeps until something re-invokes it, so handing work off doesn't make a peer act — WAKE the peer you depend on (`coord:dispatch` / `coord:handoff` for new work, `coord:wake` to resume an assigned lane) and verify it landed (`woken` / `recipient_absent`); the active complement of `wait-loop-note` |

Each section is sourced from a **single orchestrator constant** (`COORD_LEGEND`, `FRICTION_TRIPWIRE`, `YIELD_POLICY`, …), re-exported through a thin `render*` wrapper in operator-core. That single-source design is the point: the operator-launched-role base and the spawned-cup base (`buildPrompt`) both pull the same constant, so they can't desync. Any section whose renderer returns `''` collapses to nothing, so a prompt may carry fewer than all fourteen.

## The noun/verb split

A working mental model:

| File / source              | Layer                                       | Example content                                                |
| -------------------------- | ------------------------------------------- | -------------------------------------------------------------- |
| `defineTool({ guidance })` | **Nouns** — about a tool                    | "When should I call `harness:status`?"                         |
| `<role>.tools.md`          | **Verbs** — doing something that uses tools | "When approving anything, confirm aloud BEFORE the write call" |
| `<role>.persona.md`        | **Identity** — about the agent              | "Never read URLs aloud in voice mode"                          |

If a rule is "always do X when calling Y," put it in Y's `defineTool({ guidance })`.
If a rule is "after listing X, you usually want to get Y," put it in `<role>.tools.md`.
If a rule is "the operator never raises voice prompts after midnight," put it in `<role>.persona.md`.

## API

```ts
import { assembleRolePrompt } from '../../prompt-assembly';

const { text, sections } = assembleRolePrompt({
  role: 'operator',
  toolNames: [
    // MCP tool names (NOT the `mcp__agentmcp__` prefix form)
    'harness:list',
    'harness:status',
    'chat:ask_choice',
    // ...
  ],
  runtime: [
    { heading: 'Trigger', body: 'user_message' },
    { heading: 'Conversation history', body: transcript },
  ],
});
```

The `sections` array reports `{ name, chars }` for each contributing block — useful for prompt-budget debugging.

**`@papercusp/orchestrator/role-prompt` is NOT a re-export of this function.** It maps to `role-prompt-from-slug.ts`, which *defines its own* `assembleRolePrompt` with a completely different signature — `{ slug, role, mode, featureId, projectDir, ... }` — that calls `buildPrompt` (the spawned-cup path). It produces prompt **files** + the ten shared-base policy constants + a volatile tail, **not** the persona/catalog/`tools.md` four-section layout. The two functions share only a name. The dependency direction is one-way: operator-core depends on the orchestrator (`role-launch-spec.ts` imports `assembleRolePrompt` + `resolvePromptFiles` from `@papercusp/orchestrator/role-prompt`), never the reverse. The orchestrator module re-exports only the policy *constants* (`FRICTION_TRIPWIRE`, `YIELD_POLICY`, …) from `prompt-build`, never operator-core's `prompt-assembly.ts`.

Lower-level loaders exist for callers that build the assembly manually (today: the operator-converse and oracle chat routes, which assemble by hand rather than calling `assembleRolePrompt`). The module exports five such loaders/renderers:

```ts
loadRolePersona('operator')   // section 1 — throws if missing
loadRoleModePersona('operator', mode)  // audience-mode overlay — null if no file
renderToolsCatalog('operator', toolNames, modality?, displayTransform?)  // section 2 — '' if no tools
loadRoleToolsMd('operator')   // section 3 — null if file absent
loadRoleConverse('operator')  // active-mode rules for converse routes — throws if missing
```

A sibling renderer, `renderWireSchemasSection()`, lives in the same module: it emits a `## Wire schemas` legend derived from each tool's registered read/write column projections (consumed by the desktop-install prompt files, not by `assembleRolePrompt`).

## Hot-reload in dev

Filesystem reads (`persona.md`, `tools.md`, `converse.md`) are memoized per-process. To pick up edits without restarting:

```bash
export PAPERCUSP_RELOAD_PROMPTS=1
```

Defaults to on in `NODE_ENV=development`. Bypasses all caches; every request re-reads from disk. **Don't enable in production** — adds a few `readFileSync` calls per request.

`shouldBypassCache` reads the flag as an explicit tri-state: `'1'` forces the bypass on, `'0'` forces it **off** even in development (useful to force caching for a dev profiling run), and any other value falls back to the `NODE_ENV === 'development'` default.

The catalog (section 2) is memoized per-role and invalidated automatically when any tool is registered (catalog version bump in the projection registry). Editing a tool's `guidance` and hot-reloading the route picks up the change without restarting.

## `<role>.converse.md` — chat-mode-only

In addition to the three core files, **chat-mode roles** (today: `operator`) have a `<role>.converse.md` that carries the active-mode behavioral rules — silence ladder timings, the `<say>` / `<set_mode>` / `<sleep>` / `<spawn>` tag protocol, voice-modality forbidden patterns.

This is its own file (not folded into persona) because:

* It's surface-specific — agents that don't drive a streaming conversation loop don't need it
* It's protocol-shaped — closer to a state-machine reference than character notes
* It gets edited more frequently than persona during conversation-flow iteration

Loaded via `loadRoleConverse('operator')` only by routes that own a converse loop. Throws if the file is missing for a role that requested it.

## Adding a new role — checklist

When introducing a role (e.g. `documenter`):

1. **Add the persona** — `apps/operator/prompts/documenter.persona.md` (required).
2. **Add the playbook** if the role has cross-tool workflows — `apps/operator/prompts/documenter.tools.md` (optional but recommended).
3. **Verify the catalog** — list the tools the role should see; ensure each has `guidance` populated in `defineTool` (otherwise the catalog falls back to description-only, which often isn't enough).
4. **Append to the `PROMPT_ROLES` array** — `PROMPT_ROLES` in `prompt-assembly.ts`. This is an array typed `as const satisfies readonly BuiltinAgentRole[]` (and `type Role = (typeof PROMPT_ROLES)[number]` is derived from it), so a new entry must also be a valid `BuiltinAgentRole` from agent-mcp or compilation fails. There is no hand-written `export type Role` union to edit. The set today is the 11 roles `operator`, `oracle`, `worker`, `validator`, `scoper`, `reviewer`, `debugger`, `architect`, `documenter`, `curator`, `auditor`.
5. **Wire role-allowlist on tools** the role should call — most tools declare `roles: [...]` in their manifest.
6. **Smoke test** — call `assembleRolePrompt({ role: 'documenter', toolNames: [...] })` and inspect `sections` to confirm the persona, catalog, playbook, shared-base, and runtime parts populate.

If the role is a chat-mode driver (drives a streaming converse loop), also:

7. **Add the converse rules** — `documenter.converse.md` with silence ladder, tag protocol, modality rules.
8. **Update the route** to call `loadRoleConverse('documenter')`.

## What this layer is not

* **Not a tool registry.** Tools live in `packages/agent-mcp/src/tools/**` (built-ins) and `libs/papercusp/plugins/*/` (plugins). The prompt layer reads from the projection registry; it doesn't own it.
* **Not auth or gating.** Role-allowlist, capability checks, quotas — all in the [endpoint-system dispatcher](/internal/docs/endpoint-system/gating). The prompt layer renders text; the dispatcher decides what runs.
* **Not a runtime tool-discovery mechanism.** Agents that hit unfamiliar tools at runtime use [`agent_tools:list`](/internal/docs/endpoint-system/tool-catalog#singletons) — that's the live, role-filtered surface. Prompt assembly bakes in the *common* path; introspection covers the *long tail*.
* **Not a template engine.** The sections are concatenated verbatim (joined by `\n\n---\n\n`). No variables, no conditionals beyond skipping an empty/absent section. If you need conditional content, do it in TypeScript before passing to `assembleRolePrompt`.

## File map

```
packages/operator-core/
└── lib/
    └── prompt-assembly.ts                  ← the assembly module + loaders

apps/operator/
└── prompts/
    ├── operator.persona.md                 ← one of 3 persona.md files
    ├── operator.persona.<mode>-mode.md     ← audience-mode overlays
    ├── operator.converse.md                ← chat-mode rules (operator only today)
    ├── operator.tools.md                   ← cross-tool playbook
    ├── oracle.persona.md
    ├── oracle.tools.md
    ├── auditor.persona.md
    ├── auditor.tools.md
    ├── architect.tools.md                  ← spawn-roles ship tools.md only here;
    ├── cup.tools.md                        ←   their persona comes from the
    ├── debugger.tools.md                   ←   orchestrator's blueprints/base/
    ├── reviewer.tools.md                   ←   prompts/<role>.md, NOT a
    ├── scoper.tools.md                     ←   persona.md in this directory
    ├── tester.tools.md
    ├── validator.tools.md
    ├── worker.tools.md
    ├── papercusp-su-engineer.tools.md
    └── papercusp-su-power.tools.md
```

Only `auditor`, `operator`, and `oracle` have a `.persona.md` here. The 13 `*.tools.md` files cover those three plus the spawn-roles; a spawn-role's character comes from the orchestrator's prompt files (`blueprints/base/prompts/<role>.md`), resolved by `resolvePromptFiles`, not from this directory.

## Common pitfalls

* **Duplicating per-tool guidance across role files.** The whole point of `defineTool({ guidance })` is one-source authoring. If you find yourself writing "when to call X" in three different `<role>.tools.md` files, move it to X's `guidance` instead.
* **Putting workflows in persona.** Persona is character + behavior. Multi-step "list → confirm → dispatch" sequences live in `<role>.tools.md`. Mixing them makes both harder to evolve.
* **Editing a `.md` in production and expecting hot-reload.** Production caches; you need a redeploy or `PAPERCUSP_RELOAD_PROMPTS=1` to bust the cache.
* **Forgetting that the catalog (section 2) is filtered by `toolNames`.** The chat route passes only its `allowedTools`; spawn-URL agents get a different filter. If a tool isn't appearing, check the caller's filter, not the registration.

## Where to read next

* [Endpoint System → Writing a tool](/internal/docs/endpoint-system/writing-a-tool) — how to add `guidance` to a `defineTool` call
* [Endpoint System → Tool catalog](/internal/docs/endpoint-system/tool-catalog) — the full live tool list
* [Agents → Operator persona](/internal/docs/agents/operator-persona) — the canonical persona example with tone, behavior, and modality rules
