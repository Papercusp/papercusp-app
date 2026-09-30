# Action Registry — implementation plan v5
URL: /internal/docs/agents/action-registry

Final implementation-ready plan unifying agent tool surfaces (Oracle, Operator-voice, Pi) plus shortcuts and command palette under one typed registry, with a delegate-to-Claude pattern for deep reasoning.

import { Aside } from '@astrojs/starlight/components';

This is the canonical plan — earlier iterations (v2-v4) are preserved at
`apps/operator/docs/plans/archive/agent-action-registry-plan-v{2,3,4}-2026-05-03.md` for design history.

This page is a forward-looking plan; several settled-looking details diverged
once the registry shipped. The corrections below are reflected inline where they
matter, but the load-bearing ones:

* **The registry lives at `packages/operator-core/lib/commands/`** (the operator-core
  carve), not `apps/operator/lib/commands/`.
* **The delegation endpoint is `/api/agent-mcp/delegate-chat`** (a GET SSE shim into
  the `operator:delegate` tool). There is no `operator-chat` or `operator-scan` API
  route — those names never landed.
* **`delegate_to_claude` is a client-side tool tagged `browser: 'required'`**, not a
  webhook tool, and it has a live backend-neutral alias `delegate_to_agent`.
* **The default `fullAgentEngine` is `'off'`**, not `'elevenlabs-conv'`. The OpenAI
  engine value is `'openai-realtime'` (no `'gpt-realtime'` exists).
* **The claude-sessions table was renamed to `harness_shared.delegates`** (migration
  003\); its queries are `delegates.list` / `delegates.get` / `delegates.search`.
* **There is no `panel.*`/`harness.start`/`palette.toggle` surface in this registry** —
  panel/palette toggles live in the separate `lib/shortcut-registry.ts`. Same for the
  shared-voice-session bus shortcuts (`voice.toggleMute`, `voice.toggleDeafen`,
  `voice.toggleMode`, `voice.forceHost`, `video.toggleCamera`) — they're plain
  `ShortcutDef`s wired straight to a handler via `useShortcutAction` in
  `GlobalVoiceShortcuts.tsx`, not registry commands. A `ShortcutDef` only touches
  this registry when it sets the optional `command:` field (auto-bound by
  `shortcut-shim.tsx`); as of this writing no shipped shortcut uses it.
* **EL Conv AI is a transport shell** that proxies every turn to the local
  `/api/agent-mcp/operator-converse` brain via an `ask_operator` tool — the BYO-Haiku
  reasoning story (§6/§8/§9) is largely moot. See the §9 as-built note.

See `apps/operator/docs/plans/` (linked in frontmatter) for the plans that drove
each delta — notably `unify-agent-launches-as-blueprints-2026-06-04` (D-005 retired
the panel/scanner cards) and `collapse-delegate-into-workitems-2026-06-04`.

# Agent Action Registry — Implementation Plan v5 (final, implementation-ready)

**Status:** v5 — final, implementation-ready. Earlier iterations preserved as
`apps/operator/docs/plans/archive/agent-action-registry-plan-v{2,3,4}-2026-05-03.md`.

**Scope:** unify the agent tool surfaces (Oracle, Operator-voice, Pi) plus
the user-facing surfaces (keyboard shortcuts, ⌘K command palette) under a
single typed registry of commands (side-effects) and queries (reads),
with a clear architectural split between:

* **reflexive UI control** — fast, local, low-stakes; runs in the voice layer
  via ElevenLabs Conv AI client-side tools or directly via shortcuts/palette
* **deep reasoning** — slow, agent-backed, high-context; lives behind the
  `/api/agent-mcp/delegate-chat` SSE endpoint, which shims into the
  `operator:delegate` tool (`claude -p` under `AGENT_BACKEND=claude-code` —
  the deployed default — or `omp -p`, which routes through its own Meridian
  router + Claude Max OAuth), accessed via the `delegate_to_claude` tool
  (live backend-neutral alias: `delegate_to_agent`)

As built, the endpoint is `delegate-chat`, not `operator-chat`/`operator-scan`
(neither route ever existed). The `delegate_to_agent` alias is real — both ids
are registered so in-flight EL agents keep working through the rename.

**Non-goals:** generic DOM clicker, free-text input tools, drag/resize
gestures, multi-step workflows in the registry. Deep-reasoning lives behind
the `delegate-chat` endpoint, not in the registry.

**Decisions made through iteration** (see §9 for the full log):

| Decision                                      | Resolution                                                                                                                                                                                                                                                  |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Voice provider                                | **ElevenLabs Conversational AI** (primary) + OpenAI Realtime (manual fallback in settings)                                                                                                                                                                  |
| Voice underlying LLM                          | **Claude Haiku 4.5** via ElevenLabs BYO LLM (fallback to whichever fast Anthropic/OpenAI model EL supports)                                                                                                                                                 |
| Deep reasoning                                | **agent CLI per-turn** (`claude -p` under `AGENT_BACKEND=claude-code` — the deployed default — or `omp -p` via its Meridian router; existing pattern from `operator-scan`); persistent subprocess rejected                                                  |
| Conversation memory                           | `claude-sessions` table; voice picks via injected list; auto-archive at 24h idle                                                                                                                                                                            |
| Tool surface for voice                        | **As built: 25 EL client tools** — see §4 for the full list. (The plan's "12 reflexive + 9 fast queries + claude-sessions list/get" did not match the shipped set; there is no `panel.*` surface, and the session queries are `delegates.list/get/search`.) |
| Audit                                         | Two tables: `agent_actions` (full) + `agent_queries` (sampled per-def)                                                                                                                                                                                      |
| Aliases for renamed tools                     | **As built: one alias kept.** `delegate_to_agent` is registered as a live alias of `delegate_to_claude` (both stay live so in-flight EL agents keep working). The plan's "None — hard cutover" was reversed for the delegate rename.                        |
| Browser-routing                               | Tristate `browser: 'required' \| 'optional' \| 'none'` per def                                                                                                                                                                                              |
| Concurrency                                   | Per-def `concurrent: 'allow' \| 'queue' \| 'deny'`                                                                                                                                                                                                          |
| Workspace scoping                             | `ctx.workspace`, never threaded through args                                                                                                                                                                                                                |
| Cross-process                                 | Leader-bridge SSE pressure-tested in PR 1                                                                                                                                                                                                                   |
| Auto-fallback to OpenAI on ElevenLabs failure | **Manual** for v1. Auto-fallback rejected as premature complexity                                                                                                                                                                                           |
| `runMany` / batch tool calls                  | Deferred until concrete need                                                                                                                                                                                                                                |

***

## §0. The architecture in one diagram

```
                    ┌────────────────────────────────────────┐
                    │     User speaks / keys / clicks        │
                    └──────┬──────────────────────┬──────────┘
                           │                      │
            voice          │                      │  click / kbd / Pi cmd
            ▼                                     ▼
   ┌───────────────────┐                ┌────────────────────────┐
   │ ElevenLabs Conv AI│                │ Action Registry        │
   │ (transport shell) │                │  (in-process, typed)   │
   │                   │                │                        │
   │                   │ ◀──tools──────▶│  Reflexive commands:   │
   │ • <300ms latency  │                │   navigate, nav.*,     │
   │ • best TTS        │                │   operator.scan,       │
   │ • server-side     │                │   workspace.switch …   │
   │   state           │                │                        │
   │ • barge-in        │                │  Fast queries:         │
   └────────┬──────────┘                │   harness.status,      │
            │                           │   chat.list, …         │
            │ delegate_to_claude        └────────────────────────┘
            │ (client tool, browser:'required';
            │  handler proxies to the SSE endpoint)
            ▼
   ┌───────────────────┐
   │ GET /api/agent-   │
   │ mcp/delegate-chat │
   │ (SSE shim →       │
   │  operator:delegate)│
   │                   │
   │ spawn `claude -p` │
   │ (Sonnet/Opus)     │
   │ + full agent-mcp  │
   │ tool surface      │
   │                   │
   │ • file reads      │
   │ • multi-step plan │
   │ • code analysis   │
   │ • the heavy stuff │
   └────────┬──────────┘
            │
            ▼ streams back as the tool's return value
   ┌───────────────────┐
   │ ElevenLabs voice  │ ◀── full Claude text
   │ (Haiku)           │
   │ summarizes for    │
   │ voice + announces │
   │ "details in panel"│
   └────────┬──────────┘
            │
            ▼
   ┌───────────────────┐
   │ Operator panel    │ ◀── full Claude text written here
   │ auto-opens (opt   │     for the eye path
   │ -outable)         │
   └───────────────────┘
```

Three LLMs, three roles, three cost tiers:

| Role                                                                          | LLM                                       | Cost              | Why this one                                    |
| ----------------------------------------------------------------------------- | ----------------------------------------- | ----------------- | ----------------------------------------------- |
| **Voice front-end** (decide-to-delegate, summarize, route reflexive commands) | **Claude Haiku** (via ElevenLabs BYO LLM) | \~$0.001 per turn | Fast, cheap, plenty smart for routing decisions |
| **Voice audio** (STT + TTS + conversation orchestration)                      | **ElevenLabs Conv AI**                    | \~$0.05-0.08/min  | Best-in-class voice quality + server-side state |
| **Deep work** (file reads, code analysis, planning)                           | **Claude Sonnet/Opus**                    | per-token         | Most capable model only invoked when needed     |

This split exists because voice latency budget is \~300ms; Claude with full
agent-mcp tools is multi-second. Don't put the slow brain in the voice
critical path. Don't pay GPT-4o tier prices for routing decisions Haiku
handles. Don't TTS through a model whose voices sound robotic when a TTS
specialist exists.

The shipped EL Conv AI integration does **not** rely on a BYO Haiku LLM inside
ElevenLabs to do the decide-to-delegate / summarize / route work. EL's own LLM
is a transport shell: it calls a single `ask_operator` client tool for every
user turn, and the actual operator reply (persona, reasoning, routing) is
generated by the **local omp + Claude Max stack via
`/api/agent-mcp/operator-converse`**; EL speaks the returned text verbatim. The
"Voice front-end LLM" row above is therefore largely moot — whatever model EL is
configured with is only moving audio in and text out. (Reflexive commands and
fast queries are still answered client-side via the registry; the brain delegate
is for everything else.) See the §9 as-built note for the full picture.

***

## §1. Why a registry at all

Even with the delegation split, three smaller pieces still want unification:

1. **Reflexive UI commands** are duplicated 2-3 times today:
   * `operator.toggle` shortcut + `open_operator` Realtime tool + (no palette
     entry, no Oracle tool) — same panel, three implementations.
   * Same story for navigation, voice mode, workspace switching.
2. **Fast queries the voice layer needs to answer questions without delegating** —
   "what's the current harness?", "is operator running?", "what workspace am
   I on?" — are scattered across hand-rolled fetches. The voice layer needs
   them as tools so it can answer reflexively instead of always delegating.
3. **Pi's read tools and Oracle's read tools overlap** today (both have
   `status`/`list_features`-shaped queries), differently named, differently
   shaped. Worth consolidating so the voice layer can use the same queries.

The registry is **smaller in v3 than v2** — Claude's deep tool surface
(file reads, code analysis, audit, etc.) is **not** in the registry. That
lives in the existing `agent-mcp` MCP config used by `operator-scan`, and
we leave it there. The registry only covers the reflexive + fast-query
surface.

***

## §2. Registry shape

### 2.1 Types

```ts
// lib/commands/types.ts

export type AgentId = 'oracle' | 'operator' | 'pi' | 'palette' | 'shortcut';

/** How a command relates to a live browser session. */
export type BrowserRequirement =
  | 'required'   // panel.toggle — useless without a browser
  | 'optional'   // chat.dispatch — server writes the row, browser updates if present
  | 'none';      // harness.start — server-side process, no browser involvement

/** Concurrency policy when multiple callers fire the same command id. */
export type Concurrency =
  | 'allow'      // panel.toggle — safe to fire in parallel (idempotent)
  | 'queue'      // harness.start — serialize; second call waits for first
  | 'deny';      // harness.delete — second concurrent call returns conflict

/** Tier classification used by voice prompt builder + UI grouping. */
export type Tier =
  | 'reflexive'   // commands: panel.*, navigate, voice.set-mode
  | 'fast-query'  // queries: harness.status, chat.list
  | 'delegation'; // delegate_to_claude only

export interface CommandDef<Args = unknown, Result = unknown> {
  id: string;                          // 'panel.toggle'
  kind: 'command';
  description: string;                 // ≤200 chars, shown to LLMs + ⌘K
  promptDescription?: string;          // longer agent-facing description
  schema: ZodSchema<Args>;             // arg validation (see §2.4)
  agents: AgentId[];                   // who's allowed to invoke
  browser: BrowserRequirement;
  concurrent?: Concurrency;            // default 'allow'
  tier: 'reflexive' | 'delegation';
  paletteEntry?: { section: string; title: string; icon?: string; keywords?: string };
  handler: (args: Args, ctx: CommandContext) => Promise<Result> | Result;
}

export interface QueryDef<Args = unknown, Result = unknown> {
  id: string;
  kind: 'query';
  description: string;
  promptDescription?: string;
  schema: ZodSchema<Args>;
  agents: AgentId[];
  audit?: 'none' | 'sample' | 'full';  // default 'sample'
  tier: 'fast-query';
  handler: (args: Args, ctx: CommandContext) => Promise<Result> | Result;
}

export interface CommandContext {
  agent: AgentId;
  workspace: string;        // every handler gets this; never an arg (§3.2)
  sessionId?: string;       // browser session for browser='required' commands
  requestId: string;        // for audit correlation
}

export type Definition = CommandDef | QueryDef;

/** Result shape returned to all callers. Errors are values, never thrown. */
export type CommandResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; error: CommandErrorPayload };

export interface CommandErrorPayload {
  code: string;                        // 'no-active-session', 'denied', 'conflict', 'invalid-args', 'internal'
  message: string;                     // human-readable, safe to show
  hint?: string;                       // actionable, agent-facing
  retryable: boolean;
}

/** Handlers throw this; registry wraps anything else as code:'internal'. */
export class CommandError extends Error {
  constructor(public payload: CommandErrorPayload) { super(payload.message); }
}
```

### 2.2 Registry engine

```ts
// lib/commands/registry.ts

const defs = new Map<string, Definition>();
const inflight = new Map<string, Promise<unknown>>();   // for 'queue' / 'deny'

export function register(def: Definition): void {
  if (defs.has(def.id)) throw new Error(`duplicate command id: ${def.id}`);
  defs.set(def.id, def);
}

export function get(id: string): Definition | undefined { return defs.get(id); }

export function list(filter?: { kind?: 'command' | 'query'; agent?: AgentId; tier?: Tier }): Definition[] {
  return [...defs.values()].filter(d => {
    if (filter?.kind && d.kind !== filter.kind) return false;
    if (filter?.agent && !d.agents.includes(filter.agent)) return false;
    if (filter?.tier && d.tier !== filter.tier) return false;
    return true;
  });
}

export async function runCommand<T = unknown>(
  id: string, args: unknown, ctx: CommandContext,
): Promise<CommandResult<T>> {
  const def = defs.get(id);
  if (!def || def.kind !== 'command')
    return err('unknown', `no such command: ${id}`, false);
  if (!def.agents.includes(ctx.agent))
    return err('denied', `agent ${ctx.agent} not authorized for ${id}`, false);

  // Schema validation
  const parsed = def.schema.safeParse(args ?? {});
  if (!parsed.success)
    return err('invalid-args', parsed.error.message, false);

  // Browser-requirement gate. Commands needing a browser but called from
  // a non-browser context (Pi, server-side cron) get a structured
  // 'no-active-session' before the handler runs. The shim that has a
  // back-channel pre-resolves the session and passes it via ctx.sessionId;
  // if set, the gate is satisfied.
  if (def.browser === 'required' && !ctx.sessionId)
    return err('no-active-session', 'this command needs an open browser tab', true,
               'ask the user to open the workspace in a browser');

  // Concurrency
  const policy = def.concurrent ?? 'allow';
  if (policy !== 'allow') {
    if (inflight.has(id)) {
      if (policy === 'deny')
        return err('conflict', `${id} is already running`, true);
      try { await inflight.get(id); } catch {}
    }
  }

  const t0 = Date.now();
  const auditRow = { kind: 'command', id, agent: ctx.agent, workspace: ctx.workspace,
                     args: parsed.data, requestId: ctx.requestId };
  const promise = (async () => {
    try {
      const value = await def.handler(parsed.data, ctx) as T;
      audit({ ...auditRow, status: 'ok', durationMs: Date.now() - t0 });
      return ok(value);
    } catch (e: any) {
      const payload = e instanceof CommandError
        ? e.payload
        : { code: 'internal', message: 'handler threw', retryable: false };
      audit({ ...auditRow, status: 'err', error: payload.code, durationMs: Date.now() - t0 });
      return { ok: false as const, error: payload };
    }
  })();
  if (policy !== 'allow') inflight.set(id, promise.finally(() => inflight.delete(id)));
  return promise;
}

export async function runQuery<T = unknown>(
  id: string, args: unknown, ctx: CommandContext,
): Promise<CommandResult<T>> {
  // …same shape, no concurrency gate, audit policy per-def (§6).
}

function ok<T>(value: T): CommandResult<T> { return { ok: true, value }; }
function err(code: string, message: string, retryable: boolean, hint?: string): CommandResult<never> {
  return { ok: false, error: { code, message, hint, retryable } };
}
```

**`runCommand` never throws to its caller.** Every error becomes a
`CommandResult.ok=false` payload. Shims serialize uniformly to their
transport's preferred error shape (MCP `isError: true`, OpenAI Realtime
tool error, ElevenLabs webhook 4xx) — all from the same
`CommandErrorPayload`.

### 2.3 File structure

(As built, the registry landed at `packages/operator-core/lib/commands/` — the operator-core carve moved the route/lib code out of `apps/operator/lib/`. Paths below show the plan's original layout under `apps/operator/lib/commands/`.)

```
packages/operator-core/lib/commands/
  registry.ts            # the engine above
  types.ts               # CommandDef, QueryDef, AgentId, Tier
  audit.ts               # audit() impl, batched insert into PG
  defs/
    panel.ts             # panel.toggle, panel.open, panel.close
    nav.ts               # navigate
    voice.ts             # voice.set-mode, voice.set-engine
    workspace.ts         # workspace.list (q), workspace.switch
    harness.ts           # harness.start/stop, harness.scan,
                         # harness.status (q), harness.list-features (q),
                         # harness.last-scan (q), harness.recent-suggestions (q)
    chat.ts              # chat.list (q), chat.open-pane, chat.dispatch
    palette.ts           # palette.toggle
    delegation.ts        # delegate_to_claude, claude-sessions.list (q),
                         # claude-sessions.get (q)
    panel-state.ts       # panel.state (q)
  shims/
    elevenlabs-shim.ts   # generates EL Conv AI tool config (primary)
    realtime-shim.ts     # generates OpenAI Realtime tool defs (fallback)
    oracle-shim.ts       # generates Oracle MCP tool defs
    pi-shim.ts           # generates Pi MCP tool defs
    palette-shim.ts      # render registry → ⌘K palette items
    shortcut-shim.ts     # bind shortcuts to commands
```

Each `defs/*.ts` runs for side-effect (`import 'lib/commands/defs/panel'`)
and calls `register()` at top level. Strict import discipline: defs
import only from `lib/commands/types`, the side-effect targets they
wrap (`operator-shared-state`, `voice-mode`, harness-state), and `zod`.
A `defs/index.ts` does the side-effect imports in a stable order and
optionally re-exports a typed catalog (`Commands.panel.toggle:
CommandDef<…>`) for autocomplete.

### 2.4 Schema → tool-spec translation

Each shim converts `def.schema` to the transport's expected schema format:

| Transport                        | Format                                                                            | Library                                     |
| -------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------- |
| **ElevenLabs Conv AI** (primary) | JSON Schema in EL agent-config envelope (URL/in-page handler ref + required flag) | `zod-to-json-schema` + EL-specific wrapping |
| MCP tools (Oracle, Pi)           | JSON Schema                                                                       | `zod-to-json-schema`                        |
| OpenAI Realtime tools (fallback) | SDK `tool({...})` accepts Zod directly                                            | none                                        |

Forbidden Zod constructs (don't translate cleanly to JSON Schema or
become invisible to the LLM):

* `.transform()` — runtime-only, not in schema. Use a separate normalization
  step inside the handler.
* `.refine()` with logic the LLM can't see. OK for internal sanity checks;
  describe the constraint in `description` so the LLM can satisfy it.
* Branded types — opaque to the LLM, no benefit at the boundary.
* `z.union` of incompatible literal shapes that the LLM has to pick by
  presence — flatten or split into separate commands.

CI test enumerates every registered def and asserts
`zod-to-json-schema(def.schema)` doesn't throw and produces a non-empty
object. Catches misuse at import time.

***

## §3. Cross-process routing, workspace scoping, multi-tab

### 3.1 Process boundaries

Pi runs in a separate process from the browser (`node-pty` subprocess →
`claude`/`omp` → the projected-tool dispatcher at the transport route).
Side-effect commands land in the right process based on the `browser:`
tristate and where the shim runs:

As built, there is no `papercusp-mcp-server` (or `oracle-mcp-server`) package.
The old stdio shim was deleted 2026-05-09; Pi/omp now hit the same projected-tool
dispatcher at the transport route (`/api/[transport]/route.ts`) that every other
caller uses — this registry plus the projected tool catalog supersede it.

| Command class                                     | Browser-only?            | Where the handler lives                                    | Same-process from Oracle?                                      | From Operator?             | From Pi?                              |
| ------------------------------------------------- | ------------------------ | ---------------------------------------------------------- | -------------------------------------------------------------- | -------------------------- | ------------------------------------- |
| Panel/nav/voice (`panel.toggle`, `navigate`)      | `'required'`             | Browser-side handler in operator-shared-state / voice-mode | Yes (oracle-mcp lives in operator app, posts to leader-bridge) | Yes (in-page)              | **No** — leader-bridge SSE round-trip |
| Server actions (`harness.start`, `chat.dispatch`) | `'optional'` or `'none'` | Operator app server (HTTP)                                 | Yes                                                            | Yes (HTTP from EL webhook) | Yes (HTTP)                            |
| Queries (`harness.status`, `chat.list`)           | `'none'`                 | Operator app server / DB                                   | Yes                                                            | Yes                        | Yes                                   |

### 3.2 Workspace scoping

Per repo memory (`workspace_scoping_boundary`), workspaces are
**filesystem-only** — PG state is global with `workspace` filter columns.
Every command/query handler that touches `harness_shared.*` must filter
on workspace, or it leaks.

Workspace lives on `ctx.workspace`. **Never an LLM-visible arg.** Each
shim derives it:

| Shim                              | How                                                            |
| --------------------------------- | -------------------------------------------------------------- |
| Palette / shortcut                | Current `useWorkspace()` value at invoke time                  |
| ElevenLabs Conv AI                | Derived from the WebRTC client session's bound workspace       |
| Oracle / OpenAI Realtime fallback | Derived from the browser session that holds the LLM connection |
| Pi                                | `PAPERCUSP_WORKSPACE` env var stamped on pty spawn             |

CI test: load every registered def, mount against a mock workspace,
assert no result references rows from a different workspace.

### 3.3 Multi-tab session arbitration

For `browser: 'required'` commands, the registry needs to pick a tab.
There can be 0, 1, or N tabs open on the same workspace.

**Election:** reuse `voice-leader.ts` (existing BroadcastChannel-based
leader election). Leader tab registers with the operator app's
server-side session registry on election + on every heartbeat (\~5s).

**Session registry** (in-memory, operator Node process):

```ts
Map<workspace, { sessionId: string; lastSeen: number; deliver: (cmd) => Promise<CommandResult> }>
```

`deliver` is a per-session SSE channel. When an in-process caller
(Oracle, ElevenLabs webhook) needs a `browser: 'required'` command, it
looks up the workspace's leader, posts the command over SSE, awaits
the result.

**Failure modes:**

* 0 tabs → `{ok: false, error: {code: 'no-active-session', retryable: true, hint: 'open the workspace in a browser'}}`
* Leader closes mid-command → 5s timeout, same error
* Leader changes mid-flight → `requestId` correlation; serializable commands marked `concurrent: 'queue'` get serialized at new leader
* 3 tabs same workspace → exactly one leader handles; followers see resulting state via existing pub/sub

**Cross-tab UX:** if user has Operator open in tab A and Oracle answers a
command in tab B, tab A sees the side-effect through `operator-shared-state.broadcastState` pub/sub. Same as voice-leader-gated STT today.

**Pi specifically:** Pi's MCP shim only emits `browser: 'none'` and `'optional'` defs until PR 7.

***

## §4. What the voice LLM has access to

This is the central new material. Catalog of what Operator's voice
layer gets in its tool list, with reasoning.

The plan's `panel.*` / `harness.start` / `palette.toggle` surface was never built.
The shipped registry has **no `panel.*` surface at all** (panel/palette toggles live
in the separate `lib/shortcut-registry.ts`), and the scanner-card queries
(`harness.last-scan`, `harness.recent-suggestions`, `panel.state`) were retired with
the scanner card stream (unify-agent-launches D-005). The reflexive/scan command is
`operator.scan`; the approval command is `operator.approve-pending`. The session
queries are `delegates.list/get/search`, not `claude-sessions.*`.

**Actual registered set** (`packages/operator-core/lib/commands/defs/*.ts`):

* **Commands:** `navigate`, the eight `nav.*` (papercusp, cupboard, installed-harnesses,
  settings, settings-voice, settings-api-keys, settings-shortcuts, docs), `operator.scan`,
  `operator.approve-pending`, `workspace.switch`, `chat.open-pane`, `voice.set-mode`,
  `agent.dispatch`, `agent.follow-up`, `delegate_to_claude`, `delegate_to_agent` (alias).
* **Queries:** `harness.status`, `harness.list`, `harness.list-features`, `issues.list`,
  `escalations.get`, `pending-reviews.list`, `harness.health`, `actions.recent`,
  `notifications.recent`, `agents.across-workspace`, `chat.list`, `voice.prefs`,
  `workspace.list`, `delegates.list`, `delegates.get`, `delegates.search`.

Note `agent.dispatch` / `agent.follow-up` are tagged `agents: ['oracle','palette']`
(NOT `operator`) — the voice operator routes agent-touching work through
`delegate_to_claude` instead. The new authority queries (`issues.list`,
`escalations.get`, `pending-reviews.list`, `harness.health`, `actions.recent`,
`notifications.recent`) and `agent.dispatch/follow-up` postdate v5 (Plan v6 phases C/E,
audit unlock 2026-05-07).

**The EL Conv AI client-tool set as pushed by `el-agent-sync.mjs` is 25 tools**, two of
which have no registry-def equivalent — the EL transport tools `ask_operator` (proxies
every turn to the local brain at `/api/agent-mcp/operator-converse`) and
`end_conversation` (lets the agent hang up). The full pushed set:
`ask_operator`, `operator_scan`, `operator_approve_pending`, `navigate`,
`workspace_list`, `workspace_switch`, `harness_list`, `harness_status`,
`harness_list_features`, `harness_health`, `agents_across_workspace`, `chat_list`,
`chat_open_pane`, `voice_set_mode`, `voice_prefs`, `issues_list`, `escalations_get`,
`pending_reviews_list`, `actions_recent`, `notifications_recent`, `delegates_list`,
`delegates_get`, `delegates_search`, `delegate_to_claude`, `end_conversation`.

### Design principles

1. **Voice gets fast paths for things the user asks about often.** "What's
   the current state?" should not delegate to Claude.
2. **Voice gets reflexive controls that don't need reasoning.** Navigate,
   change voice mode, switch workspaces, fire a scan — all one-shot tools.
3. **Voice does NOT get file reads, code analysis, multi-step planning,
   or anything requiring filesystem walking.** Those go through
   `delegate_to_claude`.
4. **When in doubt, delegate.** The model's prompt explicitly tells it:
   "If you need to read files, plan more than one step, or analyze code,
   call `delegate_to_claude` — don't try to fake it from your training
   data."

### Catalog — reflexive commands (as built)

| Command                                         | What it does                                                                                                      | Why voice gets it directly                                 |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `navigate({path})`                              | Browser router push                                                                                               | "Take me to settings" — common, reflexive                  |
| `nav.*` (8 fixed targets)                       | Jump to harness / cupboard / settings / docs etc.                                                                 | Named destinations, one tool each, palette-backed          |
| `operator.scan({query?})`                       | Fire a workspace scan (the `scan` launch blueprint). Findings land as work\_items in the self-improvement backlog | "Scan the workspace" — same result the panel button gives  |
| `operator.approve-pending({slug, capability?})` | Approve a pending capability for a harness                                                                        | Single decision, same authority the user has via the panel |
| `voice.set-mode({mode})`                        | off / push-to-talk / always-on                                                                                    | User says "stop listening" — should not need to delegate   |
| `workspace.switch({id})`                        | Switch workspace and reload                                                                                       | Common command, reflexive                                  |
| `chat.open-pane({slug, chatId})`                | Open an existing chat pane                                                                                        | Reflexive — comes after `chat.list`                        |

`agent.dispatch` / `agent.follow-up` are also registered commands, but tagged for
oracle + palette only (not the voice operator). They start / continue a role-scoped
agent chat from ⌘K without paying the delegate-spawn cost; `audit: 'full'`.

### Catalog — fast queries (as built)

These let voice answer questions reflexively, without delegating. `slug` is
**required** (`z.string().min(1)`) on `harness.status`, `harness.list-features`,
and `chat.list` — it is not optional.

| Query                                            | Returns                                                                | Reason voice has it                                              |
| ------------------------------------------------ | ---------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `harness.status({slug})`                         | alive/paused, iteration, last decision, feature counts                 | "Is the harness running?" — voice answers immediately            |
| `harness.list-features({slug, status?, limit?})` | Feature queue rows (filterable by status; default 50, cap 200)         | "What's in the queue?"                                           |
| `harness.list()`                                 | Slugs + paths + state flags                                            | "What harnesses do I have?"                                      |
| `harness.health({slug})`                         | Fast snapshot: alive, escalated, feature-status counts                 | "Is sheets healthy?" — one call instead of status + escalations  |
| `issues.list({slug?, limit?})`                   | Open issues / features needing human review (cross-harness if no slug) | "Any open issues?" / "what needs my approval?"                   |
| `escalations.get({slug})`                        | Active escalation + supervisor notes (if any)                          | "Any escalations?" / "what's wrong with sheets?"                 |
| `pending-reviews.list({slug, limit?})`           | Pending capability approvals / plan reviews                            | "Anything waiting on me?" — pair with `operator.approve-pending` |
| `actions.recent({slug, limit?})`                 | Recent long-running user actions (replan, cleanup, snapshot)           | "Did the cleanup finish?"                                        |
| `notifications.recent({level?, limit?})`         | Recent toast notifications across the app                              | "Any errors recently?" / "what's the bell showing?"              |
| `agents.across-workspace({slug?, limit?})`       | Role-scoped agents with recent chat activity across the workspace      | "Which agents are working in this workspace?"                    |
| `chat.list({slug, role?, limit?})`               | Recent chats with id, role, title, last activity (default 20, cap 100) | "What chats do I have open?"                                     |
| `workspace.list()`                               | All workspaces with current marker                                     | "Which workspace am I on?"                                       |
| `voice.prefs()`                                  | Current voice prefs (mode, engines, wake word)                         | Voice can answer "what's my wake word?"                          |
| `delegates.list({status?, limit?})`              | Delegate (Claude-session) list for the workspace                       | Pick which session a delegation lands in                         |
| `delegates.get({id})`                            | Full metadata for one delegate session                                 | Read a session's recent context before resuming it               |
| `delegates.search({query, limit?})`              | Free-text search over delegate title/summary/kickoff                   | Find a related past delegate by topic                            |

### Catalog — delegation tool

Exactly one entry, special-cased (plus its `delegate_to_agent` alias):

| Tool                                                            | What it does                                                                                                                                                                                                                    |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `delegate_to_claude({task, context?, sessionId?, newSession?})` | Client tool tagged `browser: 'required'`; its handler GETs `/api/agent-mcp/delegate-chat?request=<task>` with `accept: text/event-stream` and consumes the SSE stream. See §5 for the full sync-race / background-drain design. |

### What's deliberately NOT in voice's catalog

* **No `harness.read-spec` / `harness.read-agent` / file reads.** If the
  user asks "what does the spec say?", voice delegates to Claude. Claude
  has filesystem access via its MCP tools; voice does not.
* **No mutations to feature queue, proposals, decisions.** Approving a
  capability via voice is OK (`operator.approve-pending` — single decision,
  same authority the user has via the panel). Bulk changes go through Claude.
* **No code analysis, no grep, no git inspection.** Voice doesn't have
  these tools. If the user asks anything code-shaped, delegate.
* **No `agent.dispatch` from the voice operator.** Starting a new agent
  chat is a decision worth Claude's context. The voice operator delegates
  with the user's request as `task` and Claude decides whether to dispatch.
  (`agent.dispatch`/`follow-up` are available to oracle + palette directly.)

### What Pi has access to (kept from v2)

Pi's tool surface stays as today — read-only data tools through the same
projected-tool dispatcher every caller hits (the `papercusp-mcp-server` stdio
shim was deleted 2026-05-09):

* All the harness queries above (status, list\_features, lineage, audit,
  proposals, decisions, issues)
* Plus filesystem + shell because it's a coding subprocess

The registry-shim version of Pi's tools delegates to the same query
handlers as voice's fast queries — single source of truth for "what's
the harness state."

### What Oracle has access to (kept from v2)

Oracle's tool surface stays as today — list/navigate/dispatch:

* All voice's fast queries (Oracle is also a chat-bot answering quickly)
* The reflexive commands (Oracle can navigate, open chats, etc.)
* Plus its existing `dispatchToAgent`
* **Does NOT get `delegate_to_claude`** — Oracle IS Claude. Oracle's
  tool surface is already the "deep" surface.

***

## §5. `delegate_to_claude` design

The single tool that bridges voice (fast/shallow) → Claude (slow/deep).

The shipped handler does not implement the `{status:'thinking', delegationId}`
partial, the `panelDelegationId` / `toolCallsClaudeMade` / `durationMs` fields, or a
`/operator-delegation/:id/complete` endpoint — none of those exist. The real design
is a **10s sync race with a background drain**, and completion is signalled via browser
`CustomEvent`s, not an SSE push-back endpoint. The blocks below show the as-built
shape; the original §5 prose is preserved beneath the line for design-history context.

### Signature (as built)

```ts
{
  id: 'delegate_to_claude',                 // alias: delegate_to_agent
  kind: 'command',
  browser: 'required',                      // client tool; handler proxies to SSE
  concurrent: 'queue',
  tier: 'delegation',
  schema: z.object({
    task: z.string().min(1),                // user's request, paraphrased if helpful
    context: z.string().optional(),         // extra context to attach
    sessionId: z.string().optional(),       // existing delegate session to continue
    newSession: z.boolean().default(false).optional(),  // force a fresh conversation
  }),
  // handler executes:
  // GET /api/agent-mcp/delegate-chat?request=<task>[&context=…][&sessionId=…][&newSession=1]
  //   with { headers: { accept: 'text/event-stream' } }, then consumes the SSE stream
}
```

### Server side

The endpoint is `/api/agent-mcp/delegate-chat` (a `GET` SSE shim into the
`operator:delegate` tool, `auth: 'public'`) — **not** an `operator-chat` route. It
streams `session` / `delegate` / `done` / `error` SSE events; the handler accumulates
`delta` text into `fullText` and captures `agentSessionId` + `costUsd`.

Conversation continuity is by `sessionId` (omit + `newSession:true` for a fresh
conversation; pass neither and the server picks recent-if-\<5min, else new). Same
agent-mcp tool surface, same `system:operator` principal, same budget enforcement.

### Streaming + voice timing (as built)

Tool-call latency is the hard part: delegates run 5-30s, and EL's tool-call wall is
\~120s. The handler uses a **race-with-timeout**:

1. The handler opens the SSE stream and (in-page) fires an
   `operator:delegation-start` `CustomEvent`.
2. It pumps events for a **10s sync deadline** (`SYNC_DEADLINE_MS = 10_000`). If the
   `done` event arrives within that window, it returns the full result synchronously
   so the agent summarizes on the same turn.
3. If the deadline passes first, it returns early with
   `{ status: 'started', agentSessionId, message: 'Delegate is running; result will
   arrive shortly.' }` and **drains the rest of the stream in the background**.

On completion (sync or async) it dispatches two browser `CustomEvent`s:
`operator:delegation-complete` (panel-targeted) and
`operator:delegation-async-complete` (voice-targeted — the voice-mode listener
`sendSystem()`s it into the live EL session so the agent can speak about it on its
next turn). Errors surface through the same `*-async-complete` channel with
`{ status: 'error', message }`.

### Response shape voice receives (as built)

```ts
// Sync win (stream finished within 10s):
{
  status: 'complete',
  fullText: "<claude's full response>",
  agentSessionId: 's_abc' | null,
  costUsd: 0.012,
}

// Async path (blew past the 10s deadline):
{
  status: 'started',
  agentSessionId: 's_abc' | null,
  message: 'Delegate is running; result will arrive shortly.',
}
```

The agent should speak a one-sentence gist of `fullText` and announce that the
details are in the operator panel; it should not read `fullText` verbatim. (There is
no `panelDelegationId` / `toolCallsClaudeMade` / `durationMs` in the real result.)

Below this point §5 preserves the original plan prose (two-phase protocol, the
`/operator-delegation/:id/complete` push, the `showInPanel` param). Treat it as
design history — the as-built blocks above are authoritative.

### Signature (original plan)

```ts
{
  name: 'delegate_to_claude',
  description: 'Delegate complex reasoning, file analysis, multi-step planning, or anything requiring filesystem/code access to the harness Claude agent. Returns the agent\'s text response. Voice should speak a one-sentence gist; full text appears in the operator panel.',
  parameters: {
    task: 'string',           // user's request, paraphrased if helpful
    context?: 'string',       // anything specific the user mentioned
    showInPanel?: 'boolean',  // default true; set false for trivial answers
  },
  // executes:
  // POST /api/agent-mcp/operator-chat?request=<task>&context=<context>
  // (new sibling endpoint to operator-scan, conversational system prompt)
}
```

### Server side (original plan)

New endpoint `/api/agent-mcp/operator-chat/route.ts` — sibling of
`operator-scan`, copies its `runClaudeChat` invocation pattern with two
differences:

1. **Conversational system prompt** instead of suggestion-extraction:
   "You are an agent serving an Operator voice assistant. The user said
   `<task>`. Use your MCP tools to answer their request fully. Be
   thorough — your response is shown in a panel; you don't need to
   shorten for voice. The voice layer will summarize."
2. **Streams events to the operator panel** in addition to returning
   the final text to the voice tool call. The panel shows live deltas
   while the voice layer waits.

Same agent-mcp tools attached. Same `system:operator` principal. Same
budget enforcement. Same conversation continuity via `--resume &lt;session&gt;`
keyed on `(workspace, conversation-id)`.

### Streaming + voice timing (original plan)

Tool call latency is the hard part. Claude scans take 5-30s.

Solution: **two-phase tool result.**

1. Tool call fires. Operator-chat endpoint starts streaming.
2. Voice gets back almost immediately (\~100ms after tool fire) a
   `{status: 'thinking', delegationId: 'd_abc'}` partial result, plus
   a `thinkingMessage` field the voice prompt is told to speak:
   *"Let me check on that…"*
3. Claude finishes streaming. The endpoint POSTs the full text to a
   `/api/agent-mcp/operator-delegation/:id/complete` endpoint, which
   the voice session is subscribed to via SSE. Voice gets the result
   pushed in as a synthetic tool result, generates the gist + announce.

This pattern is supported by OpenAI Realtime — multiple sequential
tool returns within one user-turn are normal. The "thinking" message
gives the user audible feedback during the wait, and barge-in still
works (user can interrupt by speaking).

### Response shape voice receives (original plan)

```ts
{
  status: 'complete',
  fullText: '<claude\'s full response>',
  panelDelegationId: 'd_abc',          // panel reference
  toolCallsClaudeMade: ['mcp__agentmcp__harness:get', …],  // for context
  costUsd: 0.012,
  durationMs: 8420,
}
```

Voice prompt: *"You will receive a `complete` response with `fullText`.
Speak a one-sentence summary (≤30 words). Mention 'I've put the details
in the operator panel'. Do NOT read fullText verbatim. If fullText
contains a clear action recommendation, propose it to the user as a
follow-up."*

### Panel behavior on completion

* **Panel auto-opens** on delegation completion if it's currently closed.
* **Voice settings toggle** `voicePanelAutoOpen: boolean` (default true)
  controls this — same model as toast notifications.
* **Panel content** is the streamed-live Claude output, with the user's
  original `task` shown as the prompt.
* **Conversation history** in the panel is keyed by
  `(workspace, conversation-id)`. Multiple voice delegations in one
  session show as a single threaded conversation in the panel.
* **Closing the panel** does not cancel an in-flight delegation. User
  can re-open and see the result land. (Cancellation is a future
  feature; not in this PR.)

### Cost gating

Reuses `operator-scan`'s existing `checkBudget` / `recordSpend`
infrastructure. Voice can't burn money calling Claude every turn:

* Soft cap (e.g. $0.50/day) → voice gets back a `'rate-limited'`
  status with a message; speaks "I've hit my daily reasoning budget,
  please raise it in voice settings or try again tomorrow."
* Hard cap (e.g. $5/day) → voice can't delegate at all; speaks the same.

### Ambiguity / "should I delegate?"

The voice prompt has a checklist:

> Delegate when:
>
> * The user asks "why" or "how" about anything
> * The user mentions a specific file, feature, or piece of code
> * The user asks for a plan or recommendation
> * The user asks something multi-step
> * You don't know the answer from the fast queries you have
>
> Do NOT delegate when:
>
> * User asked you to open/close/navigate/toggle something
> * User asked a question your fast queries answer (status, lists, etc.)
> * User said "stop", "wait", "ok", or any backchannel response

Test this prompt in practice — ambiguity will surface real cases. Iterate.

***

## §6. Voice provider selection + fallback policy

### 6.1 Primary: ElevenLabs Conversational AI

`'elevenlabs-conv'` is the primary `fullAgentEngine` option a user selects in
`/settings/voice`, but it is **not** the shipped default — the default
`fullAgentEngine` is `'off'` (`voice-prefs.ts` defaults). Voice goes through
ElevenLabs' agent platform; per the §9 as-built note, EL is a transport shell that
proxies every turn to the local brain via `ask_operator`, so the "Claude Haiku 4.5
via BYO LLM" framing here is largely moot. See §8/§9 for the integration shape.

### 6.2 Fallback: OpenAI Realtime

`fullAgentEngine: 'openai-realtime'` stays available. User flips manually
in `/settings/voice`. Implementation:

* `lib/voice-engines/openai-realtime.ts` (existing, working) stays in tree
* `lib/commands/shims/realtime-shim.ts` generates the same registry-derived
  tool catalog for the OpenAI Realtime SDK shape (Zod schemas accepted
  directly, no JSON Schema conversion needed)
* `delegate_to_claude` works identically — as built it's a **client-side tool
  tagged `browser: 'required'`** on EL (its handler proxies to the SSE endpoint),
  and a regular tool from Realtime; both route to `/api/agent-mcp/delegate-chat`
  (not `operator-chat`, which does not exist)

### 6.3 No automatic fallback

If ElevenLabs is unreachable, voice surfaces a clear error toast ("Voice
unavailable — ElevenLabs cannot be reached. Switch to OpenAI Realtime
in voice settings to continue.") and stays in `'off'` mode until the
user manually resolves it.

**Why not auto-fallback:**

* Adds significant code complexity (provider abstraction layer, health
  probes, switchover state machine, conflict resolution if both providers
  succeed concurrently)
* ElevenLabs Conv AI uptime is reasonable; not a frequent failure mode
* When auto-fallback is wrong, recovery is opaque to the user
* Manual flip is a single dropdown in voice settings, ≤30s

If sustained outages become an issue, revisit. Until then, manual is the
honest contract: one provider serves the user, the other is a setting away.

### 6.4 Why Operator-as-Claude was rejected (kept from v3)

Earlier turns explored running the entire Operator voice path through
`claude -p` or a persistent claude subprocess. **Rejected** in favor of
the delegation pattern because:

1. **Latency** — voice budget is \~500ms; Claude with tools is multi-second.
   Unacceptable for the conversational layer.
2. **Wrong tool for the job** — Realtime is purpose-built for streaming
   voice with prosody; `claude -p` produces text that goes through Kokoro,
   stripping prosody. Realtime sounds better.
3. **Existing investment** — the Realtime path is wired, working,
   tool-capable, and the user has confirmed it works. Don't rip out a
   working system.
4. **Delegation is honest** — when the model says "let me check on that"
   and goes quiet for 8 seconds, the user knows something deep is
   happening. That's the right UX cue.

As built, the `FullAgentEngineKind` union is
`'off' | 'openai-realtime' | 'gemini-live' | 'elevenlabs-conversational' | 'elevenlabs-conv'`
(`voice-prefs.ts`). The OpenAI engine value is `'openai-realtime'` — there is no
`'gpt-realtime'` literal anywhere in operator-core/operator (the only `gpt-realtime`
string in the source is the OpenAI **model** id `'gpt-realtime-1.5'`, not an engine
value). No `'claude'` mode was added.

***

## §7. Migration plan

### PR 0 — ElevenLabs agent + credential setup

Not a code PR. User-facing prerequisite work:

* Create ElevenLabs Conv AI agent on dashboard with Claude Haiku as
  underlying LLM (or fallback model if Haiku not yet supported).
* Add agent ID field to `/settings/voice`. Store alongside ElevenLabs API
  key in voice-credentials.
* Verify the basic conversation works (default agent prompt, no tools).

### PR 1 — Registry foundation + ElevenLabs Conv AI integration + first reflexive commands

This is the largest PR; everything below depends on this skeleton being
in place.

**Registry foundation:**

* `lib/commands/types.ts`, `registry.ts`, `audit.ts`
* `lib/commands/defs/panel.ts` — panel.toggle/open/close
* `lib/commands/defs/nav.ts` — navigate
* `lib/commands/defs/voice.ts` — voice.set-mode, voice.set-engine
* `lib/commands/defs/workspace.ts` — workspace.switch, workspace.list
* New `app/api/agent-mcp/run-command/route.ts` returns 503 for cross-process
  (*as built this is fully wired, not a 503 stub* — see the §7 as-built note)
* Leader-bridge SSE skeleton from v2 §4 PR 1

**ElevenLabs Conv AI integration:**

* `lib/voice-engines/elevenlabs-conversational.ts` — full implementation
  (replaces existing stub). Connects via the `@elevenlabs/client` SDK
  (or equivalent), establishes WebRTC, receives tool calls, dispatches
  to client-side registry.
* `lib/commands/shims/elevenlabs-shim.ts` — generates the agent's tool
  configuration JSON. Two outputs: client-side tools list (browser
  property `'required'`) and webhook tools list (other browser values).
  Pushed to ElevenLabs agent on app startup or on registry change.
* `app/api/elevenlabs/webhook/delegate/route.ts` — webhook endpoint
  ElevenLabs POSTs to for `delegate_to_claude` calls.
* `app/api/elevenlabs/webhook/server-action/route.ts` — webhook endpoint
  for any server-side command (`harness.start`, etc.).
* Voice prefs gain `elevenLabsAgentId` field; settings UI to enter it.

**`fullAgentEngine: 'elevenlabs-conv'` becomes the default.**
OpenAI Realtime stays available as an alternative; user can switch in
settings. The current `'openai-realtime'` value continues to work
unchanged.

Outcome: ElevenLabs voice with Claude Haiku underneath, full reflexive
command set wired through the registry. Operator can close itself, and
any other panel-level reflexive action. \~1500 LoC (the EL integration
itself is the bulk; registry is \~500).

### PR 2 — Fast queries + Pi/Oracle read-side unification

* `lib/commands/defs/harness.ts` — status, list-features, list (queries).
  (*As built `harness.last-scan` / `harness.recent-suggestions` were never
  built / were retired with the scanner card stream — unify-agent-launches
  D-005; `panel-state.ts` does not exist.*)
* `lib/commands/defs/chat.ts` — chat.list, chat.open-pane
* Pi emits these through the shared projected-tool dispatcher (the
  `papercusp-mcp-server` stdio shim was deleted 2026-05-09 — no such package).
* Oracle emits these through the same dispatcher (no `oracle-mcp-server`
  package exists).
* ElevenLabs sync (`el-agent-sync.mjs`) re-pushes the updated tool set to the
  agent.
* Operator's voice catalog gains these queries.

Outcome: voice can answer "what's the harness doing", "what chats do I
have", etc., without delegating. \~500 LoC.

### PR 3 — `delegate_to_claude` + delegate sessions

* `lib/commands/defs/delegation.ts` — defines the `delegate_to_claude`
  tool (plus the `delegate_to_agent` alias) and the `delegates.list` /
  `delegates.get` / `delegates.search` queries.
* DB read/write helpers + title/summary generators (haiku calls).
* The sessions table is `harness_shared.delegates` — migration 003 renamed
  it from `claude_sessions` (`ALTER TABLE … RENAME TO delegates`). Migrations
  live in `packages/operator-core/lib/commands/migrations/`; there is **no**
  `harness-state/migrations/` directory.
* `app/api/agent-mcp/delegate-chat` — the GET SSE shim into `operator:delegate`
  that the handler proxies to (there is **no** `operator-chat` route).
* Completion is signalled via the `operator:delegation-complete` /
  `operator:delegation-async-complete` browser `CustomEvent`s — there is no
  `operator-delegation/:id/complete` endpoint.
* ElevenLabs agent prompt gets the delegate-session injection block
  (refreshed during the active session).
* Panel auto-open hook: subscribe to delegation-complete events, open
  panel if `voicePanelAutoOpen` pref is true
* Voice settings adds `voicePanelAutoOpen` toggle under "Output behavior"
  * `voiceMaxSpokenWords` numeric (default 120)

Outcome: voice can delegate complex work to Claude, pick which session
to delegate to (or start fresh), summarize the response, auto-open the
panel. The UX described in §0 is fully wired. \~800 LoC.

### PR 4 — Palette + shortcut shims

(Same as v2 PR 3.)

### PR 5 — Operator's existing tools migrate to registry

(Same as v2 PR 4.)

### PR 6 — Pi gains server-side actions

(Same as v2 PR 5.)

### PR 7 — (optional) Pi browser back-channel

(Same as v2 PR 6.)

Same six-PR cadence as v2 with the delegation tool slotting in as PR 3.
Voice gains useful capability after each PR.

* **The cross-process `run-command` bridge is live, not a 503 stub.** For a
  `browser: 'required'` command it round-trips to the workspace's leader tab via
  the session-registry (`deliverToTab`) and audits the result. Sibling routes
  `run-command-sse.ts` and `run-command-result.ts` also exist.
* **New authority surfaces landed post-v5 (Plan v6).** `agent.dispatch` /
  `agent.follow-up` (start/continue a role-scoped agent chat; oracle + palette;
  `audit: 'full'`) and the read queries `issues.list`, `escalations.get`,
  `pending-reviews.list`, `harness.health`, `actions.recent`, `notifications.recent`,
  `agents.across-workspace` are all registered (Plan v6 phases C/E; audit unlock
  2026-05-07). See the §4 as-built catalog.

***

## §8. Risks

| Risk                                                                                                    | Mitigation                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Voice over-delegates (calls Claude for trivial things)                                                  | Prompt has explicit "do not delegate when…" checklist; iterate on real usage; track delegation-rate metric                                                       |
| Voice under-delegates (tries to answer file/code questions from training)                               | Same; iterate on prompt; user-feedback button per response                                                                                                       |
| Two-phase tool return (`thinking…` → `complete`) surprises the model                                    | Snapshot test on EL agent behavior with sequential tool returns; OpenAI fallback shim same test                                                                  |
| Panel auto-open is annoying                                                                             | `voicePanelAutoOpen: false` toggle in voice settings; default-on but easy to disable                                                                             |
| Two LLMs per delegation (Claude generates + Haiku summarizes) doubles cost                              | Haiku summarization is sub-$0.001 per delegation; Claude's actual cost dwarfs it                                                                                 |
| ElevenLabs as single point of vendor failure                                                            | Manual fallback to OpenAI Realtime in voice settings; both shims share registry surface so swap is config-only (§6.3)                                            |
| ElevenLabs Conv AI tool-calling latency higher than expected with non-OpenAI underlying LLM             | Validate end-to-end `delegate_to_claude` smoke test in PR 1 before depending on it                                                                               |
| ElevenLabs agent platform API quirks vs OpenAI Realtime SDK                                             | Single-purpose shim isolates differences; underlying registry is provider-agnostic                                                                               |
| `CommandResult.ok=false` not rendered usefully by EL agent                                              | PR 1 includes a smoke test: handler returns `{code:'no-active-session'}`, verify the agent says something coherent to the user instead of "tool error"           |
| Server-side EL agent state means "reset to fresh conversation" is an explicit API call, not a reconnect | Already needed for the "new conversation" voice command; same path                                                                                               |
| Claude Haiku not on ElevenLabs allowed-LLM list at agent setup time                                     | Fall back to whatever cheap+fast model EL supports; document the chosen fallback in voice prefs                                                                  |
| Multi-tab arbitration is wrong                                                                          | Reuse existing voice-leader-election (tested). PR 1 includes integration test for headless leader-bridge flow                                                    |
| Cross-process command latency                                                                           | Same-process routing for \~70% of cases; SSE-bridged calls add \~50ms                                                                                            |
| Registry becomes a god object                                                                           | Hard rule: `defs/` files per domain, ≤200 LoC each. Split when they grow                                                                                         |
| Audit insert volume                                                                                     | Commands always logged; queries sampled by default; nightly prune; configurable retention                                                                        |
| Pi gains too much authority too fast                                                                    | PR 7 is a deliberate review milestone; tag-per-command keeps the surface explicit                                                                                |
| Concurrent paperclip stomps during migration                                                            | Per memory: stage+commit in single shell command; touch one defs/ file per PR                                                                                    |
| Concurrent runs corrupt state (`harness.start` × 2)                                                     | `concurrent: 'queue'/'deny'` per-def; serialized at the registry                                                                                                 |
| Import cycles between defs and registry                                                                 | Strict import discipline (§2.3); CI test for cycles via `madge`                                                                                                  |
| Prompt drift from registry                                                                              | CI test asserts every tool name in the prompt files exists in the registry with the right `agents:` tag                                                          |
| Non-goals creep in (DOM clicker, free text)                                                             | `CONTRIBUTING.md` next to `defs/` lists rejection criteria; CI tripwire greps for `document.querySelector` etc. in handlers. Not airtight — code review backstop |

All v2 risks (cross-process, multi-tab, prompt drift, import cycles)
carry forward unchanged.

**v4 new risks:**

| Risk                                                                                                               | Mitigation                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| ElevenLabs Conv AI tool-calling latency higher than expected when underlying LLM is non-OpenAI                     | Validate with end-to-end `delegate_to_claude` smoke test in PR 1 before depending on it. Have OpenAI Realtime fallback wired |
| ElevenLabs agent platform API quirks vs OpenAI Realtime SDK                                                        | Single-purpose shim isolates differences; underlying registry is provider-agnostic                                           |
| Server-side agent state means a "reset to fresh conversation" is now an explicit API call, not a reconnect         | Already needed for the "new conversation" voice command; same path                                                           |
| ElevenLabs is one more vendor in the stack                                                                         | Acceptable. The voice quality + cost win is the reason; OpenAI fallback covers vendor risk                                   |
| Claude Haiku via ElevenLabs BYO needs ElevenLabs to support Haiku — verify it's on the platform's allowed-LLM list | Start with whatever they support that's cheapest+fastest; switch later if Haiku goes unsupported                             |

***

## §9. ElevenLabs Conversational AI integration shape

This section's central premise — that ElevenLabs runs Claude Haiku as a BYO LLM doing
the decide-to-delegate / summarize / route work — is **not how the integration
shipped**. As built, EL's own LLM is a transport shell: it is told (in its system
prompt) to call a single `ask_operator` client tool for **every** user turn and speak
the returned text verbatim. The actual operator reply (persona, reasoning, routing) is
generated by the **local omp + Claude Max stack via `/api/agent-mcp/operator-converse`**
(`elevenlabs-conv.ts`: "EL's own LLM is the transport shell; the actual operator reply
is generated by our local omp + Claude Max stack"). The persona/character lives on the
local brain (`el-agent-sync.mjs`). So:

* The "Why the BYO-LLM choice (Haiku) is load-bearing" subsection below is moot — the
  EL-configured model does not do the four reasoning duties it lists.
* Reflexive commands and fast queries are still answered client-side via the registry
  (those tools are pushed real, not proxied through `ask_operator`).
* EL also gets an `end_conversation` transport tool (let the agent hang up) with no
  registry-def equivalent.

The rest of §9 (account setup, conversation-state lifecycle) is broadly accurate; read
the tool-routing subsection with the correction below.

### Account + agent setup (one-time, dashboard work)

Before any code lands, the user needs to:

1. **Create an ElevenLabs Conv AI agent** on elevenlabs.io. Configure:
   * **Underlying LLM:** Claude Haiku (or GPT-4o-mini if Haiku isn't yet on the platform's allowed-LLM list — check current docs).
   * **System prompt:** the registry-generated voice prompt (uploaded once, refreshed when registry changes).
   * **Voice:** an EL voice the user prefers (default, configurable per workspace).
   * **Tools:** see "Tool routing" below — reflexive vs webhook.
   * **First-message:** "Hi, what can I help with?" (suppressible per session).
2. Save the agent ID. Surfaces in `/settings/voice` next to the existing
   ElevenLabs API key field.

The agent ID + ElevenLabs API key are the two credentials. Both stored in
voice-credentials, mirrored to env where the server endpoints need them.

### Tool routing — client tools only (as built)

The plan's two-flavor split (client-side for `browser:'required'`, webhooks for
`browser:'none'|'optional'`) is **not** what shipped. The EL agent's tool list is
built by `buildClientTools`, which only exposes `browser: 'required'` defs (see
`elevenlabs-conv.ts`: `list({ kind: 'command', agent: 'operator', browser: ['required'] })`).
So both `delegate_to_claude` and `operator.approve-pending` had to be tagged
`browser: 'required'` precisely so the agent can call them client-side without
crashing with *"Client tool with name … is not defined on client"*. The `browser` tag
is about *where the handler runs*; a `'required'` handler may still do a server-side
`fetch` (delegate's handler proxies the SSE call to `/api/agent-mcp/delegate-chat`).
There is no `/api/elevenlabs/webhook/delegate` path in this flow.

ElevenLabs Conv AI receives the tool call browser-side; the SDK invokes the registry's
`runCommand` / `runQuery` in-page and returns the result over WebRTC (sub-100ms for the
reflexive surface). Used for: `navigate`, `nav.*`, `operator.scan`,
`operator.approve-pending`, `voice.set-mode`, `workspace.switch`, `chat.open-pane`, all
queries, and `delegate_to_claude` (whose handler then proxies to the SSE endpoint).

### Server-side agent state

ElevenLabs' agent maintains conversation state server-side keyed by their
`conversation_id`. Reconnect with the same id and the agent picks up
exactly where the WebRTC dropped — no re-injecting prompt, no re-loading
tools, no re-loading claude-sessions context (we mark that context as
cacheable on the agent side once injected).

We still maintain claude-sessions PG state for cross-(elevenlabs-conversation)
memory — claude-sessions persist across ElevenLabs conversations; ElevenLabs
state persists within one conversation. Two layers, complementary.

### Agent state lifecycle in our app

| Voice user action                                 | ElevenLabs side                                             | Our DB                                                |
| ------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------- |
| First time entering always-on mode in a workspace | Create conversation, store `conversation_id` in voice-state | Inject claude-sessions list into agent context        |
| Voice mode toggled off                            | Connection dropped; agent state preserved server-side at EL | nothing                                               |
| Voice mode toggled back on within \~5min          | Reconnect to same `conversation_id`; agent state intact     | Refresh claude-sessions list (might have new entries) |
| User says "start a new conversation"              | Discard `conversation_id`, create a fresh one               | New top-level voice context                           |
| Workspace switched                                | Discard `conversation_id`; new conversation per workspace   | New claude-sessions list for new workspace            |
| 24h idle                                          | EL conversation auto-closes; we discard `conversation_id`   | Archived state on our side                            |

### Why the BYO-LLM choice (Haiku) is load-bearing

The voice agent's reasoning duties are:

1. Decide whether to delegate to Claude (deep) or answer locally
2. Pick a `claude-sessions.id` if delegating to existing conversation
3. Fire reflexive command tools when appropriate
4. Summarize Claude's response into ≤30 words for voice

These are easy reasoning tasks. Haiku 4.5 handles them at \~50ms TTFT and
\~$0.001 per turn. GPT-4o tier (what OpenAI Realtime forces) is overkill,
and 5x more expensive than Haiku.

The risk: if ElevenLabs hasn't onboarded Haiku 4.5 specifically, fall back
to whatever cheapest Anthropic / OpenAI / Gemini model they support.
Verify at integration time.

### What stays the same as v3

* `delegate_to_claude` design (two-phase tool return, speak-the-gist contract)
* Panel auto-open behavior + `voicePanelAutoOpen` toggle
* claude-sessions design (titles, summaries, archive policy, picking)
* `voiceMaxSpokenWords: 120` cap on cached scan readouts
* Action Registry + tool tier (`reflexive` / `fast-query` / `delegation`)
* Cross-process boundary (`browser` field tristate)
* Workspace scoping
* All v2 architectural decisions

The voice provider change is **purely a swap at the audio layer**. The
delegation pattern, registry, claude-sessions, workspace scoping — all
unchanged. That's intentional: the architecture is provider-agnostic.

***

## §10. Decisions log

Settled questions and their resolutions, in resolution order:

| #  | Question                                         | Resolution                                                                                                                                                                        |
| -- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1  | Voice provider for v1                            | **ElevenLabs Conv AI** primary; OpenAI Realtime kept as manual fallback                                                                                                           |
| 2  | Underlying LLM for voice routing                 | **Claude Haiku 4.5** via EL BYO LLM (fallback: cheapest+fastest model EL supports if Haiku unavailable)                                                                           |
| 3  | Voice-as-Claude (full agent)                     | Rejected — latency budget too tight; delegation pattern instead                                                                                                                   |
| 4  | Auto-fallback EL→OpenAI on outage                | Rejected — manual flip in voice settings is sufficient. Revisit if uptime issues materialize                                                                                      |
| 5  | `harness.scan` in voice catalog                  | Removed — voice is conversational front-end, not card-producer. Cards come from panel button or delegation                                                                        |
| 6  | Aliases for renamed tools                        | *Reversed as built:* one alias is kept — `delegate_to_agent` is a live alias of `delegate_to_claude` (both registered) so in-flight EL agents survive the rename                  |
| 7  | Tool aliases for backward compatibility          | *Reversed as built for the delegate rename — see #6.* The hard-cutover rule held everywhere else                                                                                  |
| 8  | `runMany`/batch tool calls                       | Deferred — `request_id` foreign key allows future grouping; not needed day 1                                                                                                      |
| 9  | Browser-only flag shape                          | Tristate `'required' \| 'optional' \| 'none'` (not boolean)                                                                                                                       |
| 10 | Concurrent runs of the same command              | Per-def `'allow' \| 'queue' \| 'deny'`; registry serializes per-id                                                                                                                |
| 11 | Workspace scoping mechanism                      | `ctx.workspace`, never an LLM-visible arg                                                                                                                                         |
| 12 | Multi-tab arbitration                            | Reuse voice-leader-election; leader tab paired with EL conversation                                                                                                               |
| 13 | Cross-process pressure-test timing               | PR 1 (not deferred) — adds 503-returning endpoint + leader-bridge skeleton                                                                                                        |
| 14 | Audit query inclusion                            | Two tables: `agent_actions` (commands, full) + `agent_queries` (sampled). Per-def policy `'none' \| 'sample' \| 'full'`                                                           |
| 15 | Audit retention                                  | 30 days for actions, **14 days** for queries (env-tunable via `ACTIONS_DAYS` / `QUERIES_DAYS`; the plan said 7 days for queries — as built it's 14, see `prune-audit-tables.mjs`) |
| 16 | Default query limits                             | `chat.list` default 20 / cap 100; `harness.list-features` default 50 / cap 200; `harness.recent-suggestions` default 10 / cap 50                                                  |
| 17 | Conversation continuity for `delegate_to_claude` | Voice picks via `claude-sessions.list` injected into context; layered title (haiku) + summary (haiku) + 24h auto-archive                                                          |
| 18 | Panel auto-open on delegation completion         | On by default; toggle in voice settings under new "Output behavior" subsection                                                                                                    |
| 19 | Panel auto-open toggle location                  | `/settings/voice` → Output behavior                                                                                                                                               |
| 20 | `harness.last-scan` voice readout                | Speak verbatim if ≤120 words; gist + panel for longer. `voiceMaxSpokenWords: 120` voice pref, env-tunable                                                                         |
| 21 | Voice's archive authority                        | Voice can archive a claude-session only when explicitly told ("archive that auth conversation"); never unilaterally                                                               |
| 22 | Pi expansion timing                              | PR 7 deliberately separate; whitelist a small starting set (`chat.dispatch`, `harness.scan`) and expand                                                                           |
| 23 | Pi browser back-channel                          | Skeleton in PR 1 (returns 503); full wiring deferred to optional PR 8                                                                                                             |

No remaining open questions.

***

## §11. Shipping order

| PR       | Title                                                                  | Approx LoC         | Outcome                                                                                                              | Depends on |
| -------- | ---------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------- | ---------- |
| **PR 0** | ElevenLabs agent + credential setup                                    | 0 (dashboard work) | Agent ID + EL API key in `/settings/voice`                                                                           | none       |
| **PR 1** | Registry + EL Conv AI integration + reflexive commands                 | \~1500             | Voice through ElevenLabs, registry foundation, panel.close works, leader-bridge pressure-tested                      | PR 0       |
| **PR 2** | Fast queries + Pi/Oracle read-side unification                         | \~500              | Voice answers status questions reflexively; Pi + Oracle share queries via shims                                      | PR 1       |
| **PR 3** | `delegate_to_claude` + claude-sessions                                 | \~800              | Full delegation pattern works; auto-open panel; voice picks claude-sessions; conversational `operator-chat` endpoint | PR 1       |
| **PR 4** | Palette + shortcut shims                                               | \~300              | ⌘K and shortcuts route through registry; audit log catches them                                                      | PR 1       |
| **PR 5** | Operator's existing Realtime tools migrate to registry (fallback shim) | \~300              | OpenAI Realtime fallback uses same registry surface as primary EL path                                               | PR 1       |
| **PR 6** | Pi gains server-side actions (selective)                               | \~400              | Pi can `chat.dispatch`, `harness.scan`, etc. — server-side commands only                                             | PR 2       |
| **PR 7** | (optional) Pi browser back-channel                                     | \~400              | Pi can drive UI actions via leader-bridge                                                                            | PR 1, PR 6 |

**PR sequencing constraints:**

* PR 1 is the foundation. Everything else depends on it. Cannot parallelize.
* PR 2, 3, 4, 5 are independent of each other after PR 1 lands. Can ship in any order.
* PR 6 needs PR 2 (so Pi has the query surface migrated first).
* PR 7 is optional and gated on concrete Pi workflows that need browser-side action.

**Rough timeline if shipped serially with paperclip-aware caution (commit-immediately, single shell command, etc.):**

* PR 0: 1 day
* PR 1: 5-7 days (largest)
* PR 2: 2-3 days
* PR 3: 3-4 days
* PR 4: 1-2 days
* PR 5: 1-2 days
* PR 6: 2-3 days
* PR 7: 3-5 days (only if needed)

**Total: \~3 weeks for PRs 0-6** (the canonical "everything except optional Pi back-channel"). Can be compressed if PRs 4-5 land in parallel with PR 3.

**Implementation begins with PR 0** — user-side dashboard work to create the ElevenLabs agent. Once you have the agent ID + verified test conversation, PR 1 starts.
