# What opencode and OMP actually do for token reduction — cited to file:line
URL: /internal/docs/agent-insights/opencode-and-omp-token-reduction-mechanisms

A read of two other agent codebases installed on this box, opencode 1.4.0 and OMP (@oh-my-pi/pi-coding-agent) 17.0.7, enumerating every token-reduction and context-management mechanism with a file:line citation for each. Commissioned to replace a recalled, uncited comparison table. Four of that table's cells are struck: opencode's output cap is 2000 lines / 50 KB, not 1 MB; opencode DOES spill full output to disk and reference it by id; opencode's `code-mode.ts` does not exist at v1.4.0; and opencode's CRITICAL Task mandate is Anthropic-prompt-only, not universal. Adds six mechanisms the table missed entirely, including OMP's context 'shake', its bitmap-image compaction, and opencode's skill-deferral and model-settable codesearch budget. Eight of nine open gaps are now closed: opencode does NOT roll child-session cost into the parent's displayed total, and its 'Code Mode' cell turns out to be Cloudflare's feature attributed to opencode. Contains no papercusp measurements and no adoption recommendation — deliberately.

## What this is, and what it deliberately is not

This is a **research read of two other codebases**, produced for the
`opencode-omp-token-reduction-research-2026-08-02` plan. It exists because a comparison
of papercusp's token-reduction mechanisms against opencode and OMP existed only as a
**recalled reading in a conversation, with no citations** — and the programme it fed had
already been burned once by optimising against an unmeasured premise.

So the standard here is: **a mechanism you cannot cite does not appear.** Striking a
recalled claim is a result. So is an explicit "could not determine". Both are worth more
than a plausible-sounding cell, because the plausible-sounding version already existed
and could not be built on.

Three things are **deliberately absent**, and their absence is not an oversight:

* **No "us" column.** No papercusp measurement appears here. The measurements belong to
  the leader who holds the corpus and the telemetry; a second uncoordinated measurement
  would be worse than none.
* **No recommendation** *in the research body*. Whether any of this is worth adopting
  depends on numbers this document does not contain. A borrow-list was added afterwards,
  on direct request, and is quarantined in the [addendum](#addendum--what-id-borrow-added-on-request-judgment-not-research)
  at the end — it is judgment, explicitly not research, and every item there names the
  measurement that would kill it.
* **No papercusp source was edited** to produce it.

***

## The ground being cited (P-001)

A finding against an unnamed version cannot be re-checked when the thing upgrades, so
both reads are pinned:

### opencode

|                       |                                                                                                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package               | dpkg `open-code` **1.4.0** amd64, installed 2026-04-07                                                                                                                 |
| Binaries              | `/usr/bin/opencode-cli` (167,297,307 B, Bun-compiled ELF, BuildID sha1 `7336da5387ce01a05b890cdc77fe6287dde90d9c`) · `/usr/bin/OpenCode` (34,501,672 B, desktop shell) |
| Reported version      | `opencode-cli --version` → `1.4.0`                                                                                                                                     |
| Source on disk        | **None.** The binary embeds a bundle but not its `packages/opencode/src` module paths.                                                                                 |
| Source actually read  | upstream `github.com/sst/opencode` tag **v1.4.0** = commit **`98325dcdc6a566de6b7ab42cc87af544bed3658d`**, shallow-cloned to `/tmp/oc-src`                             |
| Runtime dirs observed | `~/.local/share/opencode/tool-output/` (the spill dir — present, empty) · `~/.config/opencode/opencode.json`                                                           |

Also on the box but **not** the installed CLI: npm `opencode-ai@1.2.27` under
`~/.nvm/versions/node/v22.21.1/lib/node_modules/opencode-ai` and an `~/.npm/_npx` cache
copy. Both are launcher shims for an older version; nothing below is cited against them.

All opencode citations below are relative to **`packages/opencode/src/`**.

### OMP

|                |                                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Package        | `@oh-my-pi/pi-coding-agent` **17.0.7**                                                                                   |
| Install        | `~/node_modules/@oh-my-pi/pi-coding-agent`, bin `~/.bun/bin/omp` → `dist/cli.js` (12,788,331 B, minified)                |
| Source on disk | **Yes — the package ships its full TypeScript `src/`.** Citations are against the installed files directly, not a clone. |
| Upstream       | `github.com/can1357/oh-my-pi`, directory `packages/coding-agent`                                                         |

Sibling `@oh-my-pi/*` packages that also ship source: `pi-agent-core`, `pi-ai`,
`pi-utils`, `pi-wire`, `snapcompact`, `hashline`, `pi-catalog`, `pi-mnemopi`,
`omp-stats`.

All OMP citations below are relative to
**`~/node_modules/@oh-my-pi/pi-coding-agent/src/`**.

***

## The recalled table, adjudicated

Every cell of the hypothesis table, with a verdict:

| recalled claim                                                                                                              | verdict                                | what is actually there                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| opencode: batch tool calls in a script — `code-mode.ts`, "confined orchestration script with access to connected MCP tools" | **STRUCK — and its origin identified** | No file matching `*code-mode*` exists anywhere in the v1.4.0 tree, and the phrase "confined orchestration script" appears in no `.ts`/`.txt`/`.md` file. The tree's only "Code Mode" is **Cloudflare's**, in a test fixture (`test/fixture/skills/agents-sdk/SKILL.md:152`). See **O11** — the cell appears to be another vendor's feature attributed to opencode. |
| opencode: output caps 1 MB + explicit `truncated` / `timeout` flags                                                         | **PARTLY STRUCK**                      | The cap is **2000 lines AND 50 KB** (`tool/truncate.ts:17-18`). No 1 MB constant exists on the tool-output path. The `truncated` flag is real (`tool/tool.ts:92`). A `timeout` *flag* is not — bash emits a timeout *message* (`tool/bash.ts:410`).                                                                                                                |
| opencode: spill full output, reference by id — **"—" (absent)**                                                             | **STRUCK — the opposite is true**      | opencode writes the full untruncated output to `~/.local/share/opencode/tool-output/<ToolID>` and hands the model that id-named path (`tool/truncate.ts:104-107`), with a 7-day retention sweep.                                                                                                                                                                   |
| opencode: subagent as context firewall — `Task`, mandated in the system prompt                                              | **CONFIRMED, over-stated**             | The `Task` firewall is real and precise (see M6). The *mandate* is **Anthropic-prompt-only** — see P-003 below.                                                                                                                                                                                                                                                    |
| OMP: output caps 3000 lines / 50 KB / 512 columns                                                                           | **CONFIRMED, wrong file**              | Exactly right numerically (`session/streaming-output.ts:10-12`). The table attributed them to `output-meta.ts`; they are not there.                                                                                                                                                                                                                                |
| OMP: `output-meta.ts` (\~825 lines), `formatFullOutput…`                                                                    | **CONFIRMED**                          | `tools/output-meta.ts` is **825 lines**; `formatFullOutputReference(artifactId)` is at `:391`. It is the metadata *builder*, not the cap definition.                                                                                                                                                                                                               |
| OMP: `task.ts` + `vibe-spawn`/`send`/`wait`/`kill`/`list`, async task contracts + summary prompts                           | **CONFIRMED, two corrections**         | The tool names use **underscores**: `VIBE_TOOL_NAMES = ["vibe_spawn","vibe_send","vibe_wait","vibe_kill","vibe_list"]` (`tools/vibe.ts:50`). And **vibe is not the context firewall** — it drives *external CLI worker sessions* (`tools/vibe.ts:4-5`). The firewall is the `task` subsystem (`src/task/`, 25 files). There is no single `task.ts` under `src/`.   |

**Six mechanisms the table missed entirely** are documented below: opencode's
tool-result *pruning* (M5, distinct from compaction), opencode's overflow arithmetic
(M3), OMP's context **shake** (O4), OMP's **snapcompact** bitmap-image compaction
(O5), and — added 2026-08-04 — opencode's **skill deferral** (M8) and its
model-settable **codesearch budget** (M9).

***

## P-003 — the two quoted prompt lines: both VERIFIED, with a scope nuance

Both quotes exist verbatim. The nuance is the part a recalled reading cannot carry.

**Quote 1 — "prefer to use the Task tool in order to reduce context usage"** — exists in
**three** prompt variants, identical text in each:

* `session/prompt/anthropic.txt:79`
* `session/prompt/trinity.txt:83`
* `session/prompt/default.txt:91`

> `- When doing file search, prefer to use the Task tool in order to reduce context usage.`

**Quote 2 — the CRITICAL mandate** — exists in **exactly one** prompt:

* `session/prompt/anthropic.txt:86`

> `- VERY IMPORTANT: When exploring the codebase to gather context or to answer a question that is not a needle query for a specific file/class/function, it is CRITICAL that you use the Task tool instead of running search commands directly.`

**The nuance:** the *soft* preference is broad; the *hard* mandate is
**Anthropic-prompt-only**. `default.txt` and `trinity.txt` carry no CRITICAL line at all.
opencode ships at least ten prompt variants (`session/system.ts:5-13` imports
ANTHROPIC / DEFAULT / BEAST / GEMINI / TRINITY; the prompt dir also holds `codex.txt`,
`copilot-gpt-5.txt`, `gpt.txt`, `kimi.txt`, `plan.txt`, `max-steps.txt`,
`build-switch.txt`, `plan-reminder-anthropic.txt`).

So "opencode mandates Task" is true for one model family and false for the rest. Anyone
reasoning about how much of opencode's context saving is *attributable to the mandate*
has to condition on which prompt is loaded.

### ⚠ The tool that mandate names is DENIED here

opencode's design routes exploration through `Task`. **On this platform
`Task`/`Agent`/`Workflow` are denied for every psu launch** by owner mandate 2026-07-02
(`NO_SUBAGENT_TOOLS_DENY`, `libs/papercusp/packages/orchestrator/src/no-subagent-deny.ts`).
Verified in the session that produced this document:
`ToolSearch { query: "select:Task,Agent" }` → no matching deferred tools found.

The mechanism is described faithfully below regardless — that is what the read was for.
But the mechanism **as opencode implements it is not available here**, and a design that
assumes it will not run. Precedent for exactly this failure: our own su prompt kept
recommending `Task` for a month after the deny landed (EI-19277117902219188).

The general form of that lesson, which binds while reading this document: **your live
toolset outranks any prompt, doc, or brief — including this one.**

***

## opencode — the mechanisms

### M1 · Universal tool-output truncation with on-disk spill

`tool/truncate.ts` is the whole thing, and it is short.

| constant    | value                  | line  |
| ----------- | ---------------------- | ----- |
| `MAX_LINES` | `2000`                 | `:17` |
| `MAX_BYTES` | `50 * 1024` (51,200 B) | `:18` |
| `RETENTION` | `Duration.days(7)`     | `:15` |

* Output passes through **unchanged only when it satisfies both caps** — `lines.length <= maxLines && totalBytes <= maxBytes` (`:70-72`). It is an AND, so a 10-line 60 KB blob truncates.
* Slicing is `head` by default, `tail` optionally (`:26-28`, `:66`, `:79-99`); the byte budget is charged per line including its newline.
* The elision notice reports **bytes** if the byte cap bound first, otherwise **lines** (`:101-102`) — the two caps are distinguishable in the output the model sees.
* **The spill:** the full untruncated text is written to `path.join(TRUNCATION_DIR, ToolID.ascending())` (`:104-107`) — a monotonic tool id, i.e. reference-by-id. `TRUNCATION_DIR` is `Global.Path.data + "/tool-output"` (`tool/truncation-dir.ts:4`), which is the `~/.local/share/opencode/tool-output/` observed on this box.
* **Expiry:** a forked loop runs `cleanup` hourly after a one-minute startup delay (`:123-131`), deleting `tool_`-prefixed entries older than the 7-day retention (`:51-61`).

**It is applied universally, not per tool.** `tool/tool.ts`'s `wrap()` runs every tool's
`execute` and then unconditionally pipes the result through `Truncate.output` (`:86`),
rewriting `output` and stamping `metadata.truncated` / `metadata.outputPath`
(`:87-95`). `define()` wraps every tool (`:101-109`).

The single opt-out is `:83-85`:

```ts
if (result.metadata.truncated !== undefined) return result
```

A tool that reports its own truncation state bypasses the universal pass. That is the
seam `grep`, `glob` and `ls` use (M2).

### M2 · Per-tool caps that pre-empt the universal one

* `tool/read.ts` — `DEFAULT_READ_LIMIT = 2000` lines (`:16`), `MAX_LINE_LENGTH = 2000` chars per line (`:17`) with a `... (line truncated to 2000 chars)` suffix (`:18`), `MAX_BYTES = 50 * 1024` (`:19`). Emits a resumable hint: `(Output capped at 50 KB. Showing lines A-B. Use offset=N to continue.)` (`:195`, `:197`).
* `tool/bash.ts` — `MAX_METADATA_LENGTH = 30_000` (`:24`, sliced at `:273-274`); `DEFAULT_TIMEOUT = Flag.OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS || 2 * 60 * 1000` (`:25`); on expiry appends `bash tool terminated command after exceeding timeout N ms` (`:410`). Notably the bash **tool description interpolates the live limits** — `.replaceAll("${maxLines}", String(Truncate.MAX_LINES))` and the same for `MAX_BYTES` (`:469-470`) — so the model is told the caps rather than discovering them.
* `tool/grep.ts` — `truncated = matches.length > limit` (`:107-108`); header `Found N matches (showing first L)` (`:119`); per-line truncation (`:130-132`); footer `(Results truncated: showing L of N matches (H hidden). Consider using a more specific path or pattern.)` (`:135-138`); sets `metadata.truncated` (`:151`) and so opts out of M1.
* `tool/glob.ts:38-73`, `tool/ls.ts:116`, `file/ripgrep.ts:330` — same pattern, own limits, own `truncated` flag.

### M3 · Overflow detection — the auto-compaction trigger

`session/overflow.ts`, 22 lines, entire arithmetic:

```ts
const COMPACTION_BUFFER = 20_000                                        // :6
if (input.cfg.compaction?.auto === false) return false                  // :9
const count = tokens.total || tokens.input + tokens.output
            + tokens.cache.read + tokens.cache.write                    // :13-14
const reserved = cfg.compaction?.reserved
               ?? Math.min(COMPACTION_BUFFER, maxOutputTokens(model))   // :16-17
const usable = model.limit.input
             ? model.limit.input - reserved
             : context - maxOutputTokens(model)                         // :18-20
return count >= usable                                                  // :21
```

Two properties worth naming because they differ from the common heuristic:

1. **It is absolute-token and model-limit-derived, not a percent-of-window rule.** The reserve is `min(20k, the model's own max output)`, so a small-output model reserves less.
2. **Cache-read and cache-write tokens count toward the window** (`:14`). Prompt caching (M7) reduces *cost*, not *occupancy*.

### M4 · Compaction — summarize and replace

`session/compaction.ts`:

* A **dedicated named agent** performs it — `agents.get("compaction")` (`:179`), invoked with `mode: "compaction", agent: "compaction"` (`:229-230`).
* Plugins may **inject context into or wholly replace** the compaction prompt via the `experimental.session.compacting` hook (`:183-185`); the prompt is `compacting.prompt ?? [defaultPrompt, ...compacting.context].join("\n\n")` (`:219`).
* Failure is explicit and distinguishes two causes (`:274-278`): `"Conversation history too large to compact - exceeds model context limit"` vs `"Session too large to compact - context exceeds model limit even after stripping media"`.
* The result is a first-class message part — `type: z.literal("compaction")` (`session/message-v2.ts:208`); `session/processor.ts:26` types the loop verdict as `"compact" | "stop" | "continue"` and returns `"compact"` on `ctx.needsCompaction` (`:486`).

### M5 · Prune — evicting old tool-result bodies **without** summarizing

This is a mechanism the recalled table did not have, and it is cheaper than M4 because
it involves no model call at all.

| constant                | value       | line  |
| ----------------------- | ----------- | ----- |
| `PRUNE_MINIMUM`         | `20_000`    | `:35` |
| `PRUNE_PROTECT`         | `40_000`    | `:36` |
| `PRUNE_PROTECTED_TOOLS` | `["skill"]` | `:37` |

The source comment states the intent exactly (`:91-92`): *"goes backwards through parts
until there are PRUNE\_PROTECT tokens worth of tool calls, then erases output of older
tool calls to free context space"*.

The walk (`:108-127`) has four stop conditions worth knowing:

* `if (turns < 2) continue` (`:111`) — **the two most recent user turns are never pruned**.
* `if (msg.info.summary) break loop` (`:112`) — stops at the last summary boundary.
* `if (part.state.time.compacted) break loop` (`:118`) — stops at the already-pruned region, so the walk is incremental rather than re-scanning history.
* `skill` tool results are exempt (`:117`).

Everything beyond the newest 40k tokens of tool output is queued, and the queue is only
*applied* if it totals more than 20k tokens (`:130-138`) — a hysteresis band that avoids
churning the history for small wins. Applied parts get
`part.state.time.compacted = Date.now()`.

**What the model then sees** — `session/message-v2.ts:718`:

```ts
const outputText = part.state.time.compacted ? "[Old tool result content cleared]" : part.state.output
```

and `:719` drops that part's attachments (images, PDFs) as well. So the tool **call and
its arguments remain** in history; only the **result body** is replaced by a fixed
33-character string. The model retains the fact that it ran `grep foo` and lost what
`grep foo` said.

Note the interaction with M1: if that result was large enough to have been truncated, a
copy of the full text is still on disk in the spill dir for up to 7 days — so pruning is
irreversible *in context* but not necessarily *on disk*.

### M6 · The subagent context firewall, and its economics (P-004)

`tool/task.ts`, 169 lines. The economics are the part a summary loses, so they are
itemised.

**What the model can see.** The tool description is built from `Agent.list()` filtered to
`mode !== "primary"` (`:16-21`), and the dynamic variant additionally filters by
permission — `Permission.evaluate("task", a.name, agent.permission).action !== "deny"`
(`:158-169`). An agent is only shown subagents it is allowed to call.

**What a spawn costs the parent.** The parent pays for one tool call whose result is
bounded by:

```
task_id: <sessionID> (for resuming to continue this task if needed)

<task_result>
<the child's LAST text part>
</task_result>
```

— `:136-144`. The extraction is literally
`result.parts.findLast((x) => x.type === "text")?.text ?? ""` (`:136`). **Every child
tool call, every intermediate assistant message, every file the child read is discarded
from the parent's context.** Because `task.ts` sets no `metadata.truncated`, that result
is itself subject to M1, so the parent-visible task result is *additionally* capped at
2000 lines / 50 KB.

**What is discarded vs. merely hidden.** Nothing is deleted. The child is a real session
row with `parent_id` (`session/index.ts:96`), enumerable via `Session.children(parentID)`
(`session/index.ts:448-454`). It is hidden from the parent's *context*, not from the
system.

**What the parent is billed.** The child inherits the parent's model unless the agent
config overrides it — `agent.model ?? { modelID/providerID of the parent assistant
message }` (`:98-101`) — so the child's tokens are real API spend at the same per-token
rate, on the same account, simply accounted to a different session id. Cost is computed
per assistant message from `tokens.input/output/cache.read/cache.write/reasoning`
(`session/index.ts:296-302`).

One small saving is explicit: `session/prompt.ts:193` — `if (input.session.parentID)
return` inside `ensureTitle`. **A child session skips the title-generation model call.**

**Recursion and tool bounds.** The child session is created with deny rules unless the
subagent's own permission grants them: `task` denied (`:78-86`) — so **depth-1 by
default** — and `todowrite` denied (`:69-77`); both are also disabled in the child's tool
map (`:129-130`). `config.experimental.primary_tools` are re-allowed in the child
(`:87-91`) and disabled for it as tools (`:131`).

**Resumption.** `task_id` resumes the same child session with its previous messages and
tool outputs intact (`:29-34`, `:60-62`) — the child's context persists server-side
across calls while never entering the parent.

**What the prompt instructs** — `tool/task.txt`:

* `:17` — *"When the agent is done, it will return **a single message** back to you. The result returned by the agent is not visible to the user… The output includes a task\_id you can reuse later to continue the same subagent session."*
* `:18` — *"Each agent invocation starts with a **fresh context** unless you provide task\_id… your prompt should contain a highly detailed task description for the agent to perform autonomously and you should **specify exactly what information the agent should return back to you in its final and only message to you**."*
* `:16` — *"Launch multiple agents concurrently whenever possible… use a single message with multiple tool uses"*
* `:9-12` — an explicit NOT-to-use list: a specific file path → Read/Glob; `class Foo` → Glob; code within 2-3 known files → Read. The firewall is scoped to *exploration*, not to all reading.

#### The coupling worth noticing: the spill and the firewall are one system

`tool/truncate.ts:30-33` defines:

```ts
function hasTaskTool(agent?: Agent.Info) {
  if (!agent?.permission) return false
  return evaluate("task", "*", agent.permission).action !== "deny"
}
```

and the truncation hint **branches on it** (`:109-111`):

* **with `task`:** `"…Full output saved to: <file>\nUse the Task tool to have explore agent process this file with Grep and Read (with offset/limit). Do NOT read the full file yourself - delegate to save context."`
* **without `task`:** `"…Full output saved to: <file>\nUse Grep to search the full content or Read with offset/limit to view specific sections."`

That is the design in one place: **overflow is spilled to disk, and then a subagent is
directed to read the spill so the bytes never enter the parent's context.** Truncation
without a firewall just defers the problem to whoever reads the file; opencode wires them
together so the reader is disposable.

### M7 · Prompt caching

`provider/transform.ts:192-215`, `applyCaching`:

* `system` = the first **2** system messages (`:193`); `final` = the last **2** non-system messages (`:194`).
* Per-provider marker (`:196-212`): anthropic and openrouter `cacheControl: {type:"ephemeral"}`, bedrock `cachePoint: {type:"default"}`, openaiCompatible `cache_control: {type:"ephemeral"}`, copilot `copilot_cache_control: {type:"ephemeral"}`.
* Applied to `unique([...system, ...final])` (`:214`) — **at most 4 cache breakpoints**.

Cost lever only; per M3 the cached tokens still occupy the window.

### M8 · Skills — deferring instruction bodies out of the system prompt

Added 2026-08-04. Missed by the original read, which enumerated the truncation and
compaction paths but not the tool *registration* surface — the same layer-boundary error
this doc names for OMP's O9, now found on the opencode side too.

An unused skill costs **one markdown bullet**, not its instruction body:

* The tool description is built at `tool/skill.ts:14-33`. The only per-skill payload in it
  is `Skill.fmt(list, { verbose: false })` (`:32`), which emits
  `- **<name>**: <description>` per skill and nothing else (`skill/index.ts:258-263`).
  The verbose form — which adds `<location>` and XML framing — is used elsewhere, not here
  (`skill/index.ts:242-256`).
* The full `SKILL.md` body enters context **only on invocation**: `execute` returns
  `skill.content.trim()` wrapped in `<skill_content name="…">` … `</skill_content>`
  (`tool/skill.ts:79-91`).
* The bundled-resource file list is **sampled, not exhaustive** — the walk breaks at
  `limit = 10` (`:56`, `:69-70`) and the output tells the model so verbatim:
  `"Note: file list is sampled."` (`:86`).

This is a *deferral* mechanism, not a truncation one: it decides what never enters context
in the first place, which is precisely what P-002 asked to be enumerated.

### M9 · codesearch — the one cap the model sets itself

`tool/codesearch.ts:44-51` exposes `tokensNum` to the model:
`.min(1000).max(50000).default(5000)`, described as *"Adjust this value based on how much
context you need - use lower values for focused queries and higher values for comprehensive
documentation."* The tool text repeats the guidance (`tool/codesearch.txt`).

Worth separating from M1/M2: **every other opencode cap is a fixed constant the model
cannot influence.** This one is a budget the model chooses per call.

⚠ Scope caveat, so this is not over-read: `codesearch` queries an **external** retrieval
service (Exa Code API, `tool/codesearch.txt`), so `tokensNum` bounds what *retrieval
injects*, not what a local tool emits. It belongs to P-002's "retrieval/search strategy"
line, not to the output-cap family.

***

## OMP — the mechanisms

### O1 · Output caps — confirmed numbers, corrected location

`session/streaming-output.ts`:

| constant                      | value                                     | line  |
| ----------------------------- | ----------------------------------------- | ----- |
| `DEFAULT_MAX_LINES`           | `3000`                                    | `:10` |
| `DEFAULT_MAX_BYTES`           | `50 * 1024`                               | `:11` |
| `DEFAULT_MAX_COLUMN`          | `512` — *"Max chars per grep match line"* | `:12` |
| `ARTIFACT_DEFAULT_MAX_BYTES`  | `0` — **`0` means unbounded**             | `:20` |
| `ARTIFACT_DEFAULT_HEAD_BYTES` | `3 * 1024 * 1024` (3 MiB)                 | `:22` |

The recalled numbers were right; the recalled file was not — `tools/output-meta.ts` is the
metadata *builder* (825 lines, as recalled), and the caps live in `streaming-output.ts`.

The **third dimension is the interesting one**: `DEFAULT_MAX_COLUMN = 512` caps
characters *per line*, and is stateful across streaming chunks so a mid-line split still
respects the budget (`:870-873`). opencode has a per-line cap only inside `read` and
`grep`; OMP applies it at the sink.

The comment at `:850-851` states the intent of the split explicitly: *"Live preview gets
the raw (pre-cap) chunk so the TUI never lags behind what reached the sink — the column
cap is for the persisted LLM view."* The human sees uncapped output; the model sees the
capped one.

### O2 · Truncation direction and the metadata envelope

`session/streaming-output.ts` exports `truncateMiddle` and `truncateTail` alongside head
truncation (imported at `tools/output-meta.ts:19`), and `TruncationMeta.truncatedBy` is
typed `"lines" | "bytes" | "middle"` (`tools/output-meta.ts:26-28`). **Middle-elision is
a first-class mode** — opencode has head and tail only (`tool/truncate.ts:27`).

`tools/output-meta.ts` builds a structured envelope rather than only a text notice:
`TruncationMeta` (`:26`), `SourceMeta` (`:52`), `DiagnosticMeta` (`:60`), `LimitsMeta`
(`:68`), `OutputMeta` (`:78`), including `nextOffset` for pagination
(`:45`). Three ingestion paths exist — from a `TruncationResult` (`:125`), from an
`OutputSummary` (`:193`), and by *detecting* truncation in already-truncated text
(`:262-268`).

Notices are rendered by `formatTruncationMetaNotice` (`:445`), which for a middle elision
reports `Showing N of M lines; middle elided` (`:459`) and appends the artifact reference
when one exists (`:461-462`).

### O3 · The artifact store — OMP's spill design (P-006)

This is the mechanism most fully specified on the OMP side, so it is itemised against
the five questions the plan asked.

**Where it is stored.** Per-session, on disk. `artifactsDirectoryFor(sessionFile)` is
simply the session file path with its `.jsonl` suffix stripped
(`session/session-manager.ts:94-96`) — session `<x>.jsonl` gets directory `<x>/`. The
directory is created lazily on first write (`session/artifacts.ts:59-63`).

**Under what identifier.** Sequential integers per session.
`ArtifactManager.allocatePath(toolType)` returns
`{ id: String(this.allocateId()), path: <dir>/<id>.<toolType>.log }`
(`session/artifacts.ts:101-106`); `allocateId()` is `this.#nextId++` (`:92-94`). On
resume, `#scanExistingIds()` re-derives the counter by parsing `^(\d+)\..*\.log$` from
the directory listing so a resumed session does not overwrite prior artifacts
(`:74-86`).

**One ID space across the whole agent tree.** The class doc-comment states it
(`session/artifacts.ts:34-36`): *"Subagents do not own their own `ArtifactManager`. The
parent's instance is adopted via `SessionManager.adoptArtifactManager`, so the whole
parent + subagent tree shares one ID space and one directory."* Implemented at
`session/session-manager.ts:1347-1349` and `:1342-1345`. Consequently **a subagent's
artifact id is directly addressable by the parent** — an `artifact://7` written by a
child resolves for the parent.

**What the agent sees instead of the full output.** A preview plus an internal URL.
`sdk.ts:1577` returns `` `${preview}\nFull output: artifact://${artifactId}` ``;
`session/streaming-output.ts:631` appends `` `[raw output: artifact://${artifactId}]` ``
so the composed result stays under `maxBytes` (`:614`); `tools/gh.ts:2432` does the same
for GitHub results.

**How it is fetched back — with sub-ranges.** `artifact://` is one of the internal URL
schemes handled by the read tool (`tools/read.ts:2195`, `:3108`; scheme list at
`tools/bash-skill-urls.ts:272` — `skill://`, `agent://`, `artifact://`, `memory://`,
`rule://`, `local://`). The notable capability is a **selector grammar**:
`tools/path-utils.ts:376` and `:401` cite real forms `artifact://3:raw:-100` and
`artifact://5:1-50`, and `tools/read.ts:822` cites `artifact://5:conflicts:1-1`. So the
agent can fetch a *line range* or a *named section* of a spilled artifact rather than
the whole blob. `splitInternalUrlSel` (`tools/path-utils.ts:387`) peels those selectors,
including common malformed shapes, so errors surface as selector errors rather than as
misleading "host invalid" errors.

**Whether anything expires. No.** `ArtifactManager` (`session/artifacts.ts`, 153 lines)
has **no retention, TTL, sweep, or prune path** — its surface is `allocateId`,
`allocatePath`, `save`, `exists`, `listFiles`, `getPath`. Artifacts live exactly as long
as the session directory does. **This is the sharpest single contrast with opencode**,
whose spill is swept hourly on a 7-day retention (`tool/truncate.ts:15`, `:51-61`,
`:123-131`).

**Non-persistent sessions degrade gracefully:** `SessionManager.saveArtifact` falls back
to an in-memory `Map` with its own counter *"so spill truncation still works"*
(`session/session-manager.ts:1359-1368`).

**Streaming, not post-hoc.** The spill is written as the output streams, not after it
completes. `OutputSink` mirrors the **raw, pre-column-cap** chunk to the artifact file so
the on-disk record is lossless, and triggers that mirror on *"in-memory overflow OR this
chunk's column cap dropped bytes OR file already open"*
(`session/streaming-output.ts:877-880`). Default `spillThreshold = DEFAULT_MAX_BYTES`
(50 KB, `:787`). When an on-disk cap *is* configured, the sink keeps a head budget plus a
rolling tail ring and flushes the tail behind an `[ARTIFACT TRUNCATED: …]` notice
(`:768-776`) — but the default is unbounded precisely so *"advertised `artifact://<id>`
captures are lossless"* (`:772-773`).

### O4 · "Shake" — recoverable in-place context eviction

The mechanism the recalled table missed entirely, and the closest OMP analogue to
opencode's prune (M5) — except **recoverable**.

`session/agent-session.ts:10833` — `shake(mode, opts)` with
`ShakeMode = "elide" | "images"` (`session/shake-types.ts:9`):

* **`elide`** *"replaces whole tool-call results and large fenced/XML blocks with short placeholders that embed an `artifact://` recovery link"* (`:10824-10825`).
* **`images`** delegates to `dropImages()` (`:10834-10836`).

The elide path (`:10839-10881`): collect regions under a config (default
`AGGRESSIVE_SHAKE_CONFIG`, `:10841`) that skips anything already summarized away by the
latest compaction — *"shaking them only churns persisted history with no prompt/cache
effect"* (`:10842-10844`); write **all** region contents into **one** artifact
(`#saveShakeArtifact`, `:10851`, `:10897`); replace each region with a placeholder;
then `rewriteEntries()` → `agent.replaceMessages()` → reset advisor runtimes → tear down
provider sessions that cache message identity (`:10869-10873`).

The placeholder is the whole point (`:10884-10889`):

```ts
`[shaken ~${region.tokens} tokens — recover: artifact://${artifactId} (region ${index + 1})]`
```

with a bare `[shaken ~N tokens]` fallback when the session is not persisted. Compare
opencode's fixed `"[Old tool result content cleared]"` (`session/message-v2.ts:718`):
OMP's placeholder tells the model **how much was removed and how to get it back**;
opencode's tells it neither.

`ShakeResult` reports `toolResultsDropped`, `blocksDropped`, `imagesDropped`,
`tokensFreed` (`session/shake-types.ts:12-21`) and renders as
`Shook … (~N tokens freed).` (`:42`).

Reachable manually as `/shake` (`slash-commands/builtin-registry.ts:1490`,
`modes/controllers/command-controller.ts:1256`) **and automatically** — see O6.

### O5 · Compaction modes, including bitmap-image archival

`session/compact-modes.ts:47-65` defines three:

| mode          | description (verbatim from source)                                                  |
| ------------- | ----------------------------------------------------------------------------------- |
| `soft`        | *"Summarize locally with the active model (skip remote endpoints)"*                 |
| `remote`      | *"Summarize via the remote endpoint / provider-native compaction"*                  |
| `snapcompact` | *"Archive history onto dense bitmap images the model reads back (**no LLM call**)"* |

**`snapcompact` is the outlier and the table missed it.** It converts history into dense
bitmap images the model reads back through vision, so compaction costs **no summarization
model call** at all. Implementation is `session/snapcompact-inline.ts` (frames capped by
`MAX_SYSTEM_PROMPT_FRAMES = 6`, `:51`; tool results swapped for frames at `:431-486`)
plus a dedicated `@oh-my-pi/snapcompact` package and supporting prompt stubs
(`src/prompts/system/snapcompact-*.md`).

### O6 · The tiered dead-end rescue — where shake and compaction compose

`session/agent-session.ts:13706` — `#rescueCompactionDeadEnd`, whose doc-comment
(`:13685-13705`) states the failure it exists for: the summarizer cut at the only
available turn boundary, but the kept tail is *still* over the recovery band because one
recent turn is itself bigger than the band and `findCutPoint` cannot cut inside a single
message.

* **Tier 1 — `shake("elide")`** *"reaches INSIDE that tail"* (`:13692`, called `:13716`). Skipped if this pass already shook (`skipElide`).
* **Tier 2 — `dropImages()`** (`:13743`), the manual `/shake images` remedy automated. It runs only after elide fails the progress re-test, and the comment gives the reason (`:13696-13698`): *"unlike elided text they are NOT artifact-recoverable"*.

Each tier that rewrote history re-anchors the in-flight snapshot
(`#rebasePendingContextSnapshotAfterCompaction`, `:13724`, `:13744`), the caller's
progress predicate is re-tested, and the first tier that restores progress emits one
notice and stops (`:13731-13738`, `:13750-13757`). Failure of both falls through to a
dead-end warning.

**The ordering rule is worth extracting on its own: recoverable reductions are attempted
before irrecoverable ones.** Elided text can be fetched back from `artifact://`; dropped
images cannot; so images are the later tier.

### O7 · Subagents: `task` is the firewall, `vibe` is something else

Two corrections to the recalled row.

**`vibe_*` is not the context firewall.** `tools/vibe.ts:50` —
`VIBE_TOOL_NAMES = ["vibe_spawn","vibe_send","vibe_wait","vibe_kill","vibe_list"]`
(underscores, not hyphens). The header comment (`:4-5`) describes them as *"Five thin
tools over `VibeSessionRegistry`: spawn/send/wait/kill/list persistent worker sessions
("fast"/"good" CLIs)"* — they drive **external CLI worker processes**, each rendered
as a live screen in a TUI "TV wall" (`:9-10`). `vibe_spawn` returns immediately with a
session id and job id and tells the model to keep working (`:118`). That is a
parallel-work primitive, not a context firewall.

**The firewall is the `task` subsystem** — `src/task/`, 25 files including
`executor.ts`, `spawn-policy.ts`, `parallel.ts`, `isolation-runner.ts`,
`structured-subagent.ts`, `yield-assembly.ts`, `output-manager.ts`, `worktree.ts`,
`prompt-policy.ts`, `persisted-revive.ts`. There is no single `task.ts` under `src/`.

**Its result contract is a template, and it spills like everything else** —
`src/prompts/tools/task-summary.md`:

```
<task-result id="{{id}}" agent="{{agentName}}" status="{{status}}" duration="{{duration}}">
{{#if meta}}<meta lines="{{meta.lineCount}}" size="{{meta.charSize}}" />{{/if}}
{{#if abortReason}}
<abort-reason>{{abortReason}}{{#if resumable}} — the agent is still live with its full context; message it via `hub` to resume instead of redoing the work.</abort-reason>
{{/if}}
{{#if truncated}}
<preview full-output="agent://{{id}}">
{{preview}}
</preview>
{{else}}
<output>
{{preview}}
</output>
{{/if}}
...
</task-result>
```

Three things follow that opencode's `<task_result>` (M6) does not do:

1. The parent is told **how big the discarded output was** — `<meta lines size />` (`:2`).
2. A truncated subagent result is itself **spilled and id-referenced**: `<preview full-output="agent://{{id}}">` (`:7`). The subagent-result path and the tool-output path use the same spill idiom.
3. An aborted subagent advertises that it is **still live with its full context** and should be messaged rather than redone (`:4`).

Caps on a subagent's own output are env-overridable
(`task/types.ts:53`, `:56`):

```ts
export const MAX_OUTPUT_BYTES = parseNumber($env.PI_TASK_MAX_OUTPUT_BYTES, 500_000);
export const MAX_OUTPUT_LINES = parseNumber($env.PI_TASK_MAX_OUTPUT_LINES, 5000);
```

— note these are **an order of magnitude larger** than the 50 KB / 3000-line tool-output
caps, i.e. a subagent is allowed to return substantially more than a tool call is.

**The async contract** — `src/prompts/tools/task-async-contract.md`, quoted in full
because it is one paragraph and every clause is load-bearing:

> *"No polling is needed. Inspecting a settled job with `hub jobs` or `hub wait` makes that snapshot its delivery, so no duplicate `async-result` follows. Job IDs live in process memory for roughly five minutes after settlement; afterward, use the agent ID with `hub send`, `agent://<id>`, or `history://<id>`. `completed` means the subagent yielded successfully, not that claimed artifacts were verified."*

Three designed properties: **push not poll**; **a short-lived in-memory job id with a
durable id to fall back to**; and an explicit **anti-trust clause** — `completed` is a
statement about the yield, not about the work.

Subagent sessions are stored *inside* the parent's artifacts directory as
`<parent>/<agentId>.jsonl`, and `resolveBreadcrumbToInteractiveRoot` walks back up
(depth-capped at 8) so `--continue` resumes the real conversation rather than a subagent
transcript (`session/session-manager.ts:98-117`).

### O8 · Prompt caching, and the cache-aware pruner

Added after publication, closing a gap. The mechanisms live in **`@oh-my-pi/pi-ai`**, a
second sibling package — see the note under *Could not determine* for why that matters.

`applyPromptCaching` (`pi-ai/src/providers/anthropic.ts:3001-3047`) lands on the same
**4-breakpoint** ceiling as opencode, but spends it differently. opencode picks *positions*
(first 2 system + last 2 messages, unconditionally). OMP treats the 4 as a *budget*: it first
counts breakpoints already on the request — tools, system and message blocks alike
(`countCacheControlBreakpoints`, `:3128-3147`) — spends what is left on the last system block,
then walks **backwards** from the message tail placing one per message until the budget runs
out (`:3024-3046`); `enforceCacheControlLimit` (`:3149`) trims any overflow. The practical
difference is that a request already carrying a tool-level breakpoint cannot silently exceed
the provider cap, which in a purely positional scheme it can.

Two details are worth more than the placement:

* **Retention defaults to 1h**, and the reason given in source is agent-specific
  (`getCacheControl`, `:440-462`): *"agent sessions routinely idle past 5 minutes waiting on
  background jobs, and a 5m breakpoint cold-misses the entire prefix on resume."* Note it
  applies the 1h default to **API-key** requests too, not only the OAuth path.
* `normalizeCacheControlTtlOrdering` (`:3049-3061`) strips `ttl` from any 1h breakpoint that
  appears *after* a 5m one, so a mixed-retention request cannot violate the provider's
  longest-TTL-first ordering rule.

**The cache-aware pruner is the more interesting find, and it is a trap rather than a
feature.** OMP's prune carries a `cacheWarmSuffixTokens` guard
(`pi-agent-core/src/compaction/pruning.ts:44-51`): for every entry it precomputes the token
total of all messages *after* it (`computeMessageSuffixTokens`, `:137-141`) and refuses to
touch any entry whose suffix exceeds the threshold — `8_000` tokens in practice
(`agent-session.ts:792`, wired at `:10711`).

The reasoning is the transferable part. Editing a message that sits in the already-sent cached
prefix does not cost you that message — it invalidates the prefix from that point on, so the
provider **re-writes the entire suffix at `cacheWrite` price**. A prune reclaiming 2k tokens by
blanking a stale tool result 60k tokens deep is a straight loss. So OMP deliberately leaves
superseded and useless results alone when they are deep — explicitly overriding its own
supersede/useless rules, which otherwise bypass every protection window (`:349-357`) — and lets
compaction and shake reclaim them instead, *because those rebuild the cache anyway*.

Generalised: **any cleanup pass over conversation history has a cost gradient running opposite
to the obvious one.** The oldest, stalest, most tempting material is the most expensive to
touch; the cheap-to-edit region is the recent tail you least want to prune. This holds only
against an explicit prefix cache — with implicit provider-side caching there is no boundary to
respect.

One usability note in the same area: OMP surfaces a lost cache to the *user*.
`detectCacheInvalidation` (`pi-coding-agent/src/modes/components/cache-invalidation-marker.ts:49-66`)
flags a warm→cold transition and renders a `⊘ cache miss · N tokens` divider in the transcript.
It is deliberately suppressed for implicit-cache providers, where `cacheRead` dropping to zero
is routine propagation noise rather than a real invalidation.

***

### O9 · Cap universality — two layers, not one, and the premise of the gap was wrong

The original report recorded OMP's caps as *"wired per tool rather than at a single choke
point"* and filed the universality question as an open gap. The exhaustive audit closes it, and
the answer corrects the cell: **OMP has both a per-executor streaming cap and a universal
choke-point cap, and the report saw only the first.** They sit at different boundaries and are
not alternatives.

**Layer 1 — streaming, per-executor by necessity.** `OutputSink`
(`session/streaming-output.ts:728`) caps bytes *as they arrive from a live subprocess*. It is
imported by exactly four execution sites — `exec/bash-executor.ts:10`,
`eval/executor-base.ts:3`, `eval/js/executor.ts:1`, `tools/bash-interactive.ts:18` (plus
`tools/eval.ts:12`). This layer is not incompletely applied; it is applied to precisely the set
of tools that own a subprocess, because it is the only set for which a streaming cap is
meaningful. Reading this set as "the cap coverage" is what produced the wrong cell.

**Layer 2 — the context boundary, universal.** `spillLargeResultToArtifact`
(`tools/output-meta.ts:650`) runs inside `wrappedExecute` (`:770-798`), which is installed by
`wrapToolWithMetaNotice` (`:805`). Every registration path in the codebase wraps:

| path                     | site                                                                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| built-in tools           | `tools/index.ts:595` — `createTools` maps **every** `BUILTIN_TOOLS` entry; `:634`, `:640` catch the two late-added xdev transport tools |
| vibe (ephemeral) tools   | `session/agent-session.ts:7195`, via `#wrapRuntimeTool` `:7171`                                                                         |
| MCP tools                | `agent-session.ts:7786`                                                                                                                 |
| RPC-host tools           | `agent-session.ts:7837`                                                                                                                 |
| SDK goal/write, CLI read | `sdk.ts:2377`, `:2412`; `cli/read-cli.ts:37`                                                                                            |

Extension tools compose *outside* it — `ExtensionToolWrapper` wraps the already-wrapped tool
(`:7173`, `:7788`, `:7839`) — so the cap still runs. There is no bypass: the saved original,
`kUnwrappedExecute`, is referenced only within `output-meta.ts` (`:603`, `:770`, `:777`, `:806`,
`:813`), as an idempotence guard and the wrapper's own call. The source states the intent
plainly at `:679-680`: *"The spill wraps arbitrary tools (built-in, MCP, extension, RPC-host)."*

Defaults: spill above **50 KB**, keeping **20 KB head + 20 KB tail** (middle elision) or 500
tail lines — `config/settings-schema.ts:679`, `:703`, `:723`, `:765`.

So the coverage fraction is **every registered tool**, with three exemptions — two of which are
sound, and two genuine holes (one exemption, one scope limit):

**Exemption 1 — `read`, by name (`:657`). Not a hole.** `read` implements a richer line-oriented
cap of its own (`DEFAULT_MAX_BYTES` 50 KB, `DEFAULT_MAX_LINES` 3000, `truncateHead`,
`truncateLine` — `read.ts:47-53`; `MAX_SUMMARY_BYTES` 2 MB, `MAX_SUMMARY_LINES` 20 000 —
`:154-155`) which a byte-tail spill would corrupt.

**Exemption 2 — a tool that already saved its own artifact (`:662`). Structurally unreachable by
untrusted tools,** which is the interesting part. The skip keys on
`result.details?.meta?.truncation?.artifactId`, so in principle a tool could self-exempt from
the universal cap. A *remote* MCP server cannot: the bridge builds `details` from a fixed field
list with no `meta` key and no spread of server-supplied data
(`mcp/tool-bridge.ts:212-234`). The trust boundary strips the field, so only in-process tools
that genuinely spilled — bash/eval via `OutputSink` — can take the exemption.

**Hole 1 — no `SessionManager`, no cap at all (`:656`).** `sessionManager` is optional on
`CustomToolContext` (`sdk.ts:542`), and the guard is a bare `if (!sessionManager) return
result;`. An SDK or headless embedding without one therefore gets **no context cap whatsoever**,
not a degraded one. That is inconsistent with how the *same function* handles a failed artifact
save thirty lines later (`:684-692`): it catches, logs, and still truncates, under an explicit
comment that *"a save failure must never … re-expose the full (possibly context-blowing)
output"*. The storage-**failure** path degrades correctly to truncate-without-recovery; the
storage-**absent** path does not degrade at all. Same risk, same function, two different
answers.

**Hole 2 — the universal cap is text-only.** `spillLargeResultToArtifact` measures only blocks
where `block.type === "text"` (`:666-671`) and passes every non-text block through untouched
(`:710-714`). Image blocks are emitted by `browser` (`tools/browser/run-output.ts:24`,
`tab-worker.ts:1581`, `:1617`), `fetch` (`:1153`), `eval` (`:608-621`), `inspect_image`
(`:223`) and `read` (`:1210`, `:1276`). They are governed only by a separate per-tool
`MAX_IMAGE_INPUT_BYTES` of **20 MB** (`utils/image-loading.ts:7`) — a decode-safety limit, not a
context budget. OMP does have an image-specific reduction path, but it is at the *compaction*
layer (`dropImages()`, O4), not at the tool boundary.

***

## Side-by-side, every cell cited or struck

No "us" column, by design.

| mechanism                                                        | opencode 1.4.0                                                                                                                                                                                                                                                    | OMP 17.0.7                                                                                                                                                                                                                                                                                                 | confidence     |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| **Line cap on tool output**                                      | 2000 — `tool/truncate.ts:17`                                                                                                                                                                                                                                      | 3000 — `session/streaming-output.ts:10`                                                                                                                                                                                                                                                                    | High           |
| **Byte cap on tool output**                                      | 50 KB — `truncate.ts:18`                                                                                                                                                                                                                                          | 50 KB — `streaming-output.ts:11`                                                                                                                                                                                                                                                                           | High           |
| **Per-line/column cap**                                          | only within tools: `read.ts:17` (2000 ch), `grep.ts:130-132`                                                                                                                                                                                                      | global at the sink: `DEFAULT_MAX_COLUMN = 512` — `streaming-output.ts:12`, applied `:870-873`                                                                                                                                                                                                              | High           |
| **Cap combination**                                              | AND — both must pass — `truncate.ts:70`                                                                                                                                                                                                                           | per-dimension, tracked separately in `TruncationMeta` — `output-meta.ts:26-28`                                                                                                                                                                                                                             | High           |
| **Truncation directions**                                        | head, tail — `truncate.ts:27`                                                                                                                                                                                                                                     | head, tail, **middle** — `output-meta.ts:28`, `:19`                                                                                                                                                                                                                                                        | High           |
| **Applied universally?**                                         | **Yes** — every tool result via `tool/tool.ts:86`; opt-out at `:83-85`                                                                                                                                                                                            | **Yes, at the registration boundary** — `wrapToolWithMetaNotice` → `spillLargeResultToArtifact`, `output-meta.ts:783`, `:650`; every registration path wraps (built-in `tools/index.ts:595`, MCP `agent-session.ts:7786`, RPC-host `:7837`, vibe `:7195`). Text blocks only; three exemptions — see **O9** | High           |
| **Full output spilled to disk**                                  | **Yes** — `truncate.ts:104-107`                                                                                                                                                                                                                                   | **Yes** — `session/artifacts.ts:101-119`                                                                                                                                                                                                                                                                   | High           |
| **Spill identifier**                                             | monotonic `ToolID` as filename — `truncate.ts:104`                                                                                                                                                                                                                | sequential int per session, `<id>.<tool>.log` — `artifacts.ts:104`                                                                                                                                                                                                                                         | High           |
| **Spill addressed as**                                           | a filesystem path in the hint text — `truncate.ts:110-111`                                                                                                                                                                                                        | a URL scheme `artifact://<id>` — `sdk.ts:1577`, `streaming-output.ts:631`                                                                                                                                                                                                                                  | High           |
| **Sub-range fetch of a spill**                                   | not as a spill feature; generic `Read` offset/limit — `truncate.ts:111`                                                                                                                                                                                           | **yes, selector grammar** `artifact://5:1-50`, `artifact://3:raw:-100`, `artifact://5:conflicts:1-1` — `path-utils.ts:376`, `:401`, `read.ts:822`                                                                                                                                                          | High           |
| **Spill ID space across subagents**                              | per-session dirs, no shared id space found                                                                                                                                                                                                                        | **shared parent+subagent id space** — `artifacts.ts:34-36`, `session-manager.ts:1347-1349`                                                                                                                                                                                                                 | High           |
| **Spill expiry**                                                 | **7 days**, hourly sweep — `truncate.ts:15`, `:51-61`, `:123-131`                                                                                                                                                                                                 | **none** — `artifacts.ts` has no retention path (153 lines, full surface read)                                                                                                                                                                                                                             | High           |
| **Spill written when**                                           | after the fact, on overflow — `truncate.ts:106-107`                                                                                                                                                                                                               | **streaming, raw/pre-cap** — `streaming-output.ts:877-880`                                                                                                                                                                                                                                                 | High           |
| **Model told the caps**                                          | yes — bash description interpolates them, `bash.ts:469-470`                                                                                                                                                                                                       | via `LimitsMeta` in the output envelope — `output-meta.ts:68`                                                                                                                                                                                                                                              | High / Medium  |
| **Overflow trigger**                                             | absolute tokens vs `model.limit.input - reserved`, `reserved = min(20k, maxOutput)` — `overflow.ts:6`, `:16-21`                                                                                                                                                   | budget-reserve vs context window — `agent-session.ts:13673-13683`                                                                                                                                                                                                                                          | High / Medium  |
| **Cache tokens count toward window**                             | **yes** — `overflow.ts:14`                                                                                                                                                                                                                                        | **yes** — `totalTokens \|\| input+output+cacheRead+cacheWrite`, *minus* provider-side orchestration tokens (billable, but never replay into the prefix) — `pi-agent-core/src/compaction/compaction.ts:215-222`                                                                                             | High           |
| **Compaction**                                                   | dedicated `"compaction"` agent, plugin-replaceable prompt — `compaction.ts:179`, `:183-185`, `:219`                                                                                                                                                               | three modes: `soft`, `remote`, **`snapcompact`** — `compact-modes.ts:47-65`                                                                                                                                                                                                                                | High           |
| **Compaction without an LLM call**                               | none found                                                                                                                                                                                                                                                        | **`snapcompact`** — bitmap images read back by vision — `compact-modes.ts:58-63`                                                                                                                                                                                                                           | High           |
| **Evict tool results without summarizing**                       | **prune** — `compaction.ts:35-37`, `:93-139`                                                                                                                                                                                                                      | **shake("elide")** — `agent-session.ts:10833-10882`                                                                                                                                                                                                                                                        | High           |
| **…protection band**                                             | newest 40k tokens of tool output + last 2 user turns — `compaction.ts:36`, `:111`                                                                                                                                                                                 | **`protectTokens: 16_000`** on the auto path (`0` on manual `/shake`) — `pi-agent-core/src/compaction/shake.ts:46-59`                                                                                                                                                                                      | High           |
| **…hysteresis**                                                  | only fires if >20k tokens would be freed — `compaction.ts:35`, `:130`                                                                                                                                                                                             | **`minSavings: 4_000`** on the auto path (`0` on manual `/shake`) — `shake.ts:46-59`                                                                                                                                                                                                                       | High           |
| **…cache-aware history mutation**                                | none found                                                                                                                                                                                                                                                        | **yes** — prune refuses to mutate any entry whose message-suffix exceeds the warm-cache window (`8_000`), because editing inside the sent prefix re-writes the whole suffix at `cacheWrite` price — `pi-agent-core/src/compaction/pruning.ts:44-51`, `:349-357`, threshold at `agent-session.ts:792`       | Medium / High  |
| **…what the model sees after**                                   | `"[Old tool result content cleared]"` — `message-v2.ts:718`                                                                                                                                                                                                       | `"[shaken ~N tokens — recover: artifact://<id> (region N)]"` — `agent-session.ts:10886`                                                                                                                                                                                                                    | High           |
| **…recoverable by the model?**                                   | **No** in-context pointer (the spilled copy may exist for ≤7d, unlinked)                                                                                                                                                                                          | **Yes**, by design — the placeholder carries the recovery URL                                                                                                                                                                                                                                              | High           |
| **Image/attachment dropping**                                    | attachments dropped with pruned parts — `message-v2.ts:719`; `stripMedia` option                                                                                                                                                                                  | `dropImages()` / `/shake images` — `agent-session.ts:10834-10836`                                                                                                                                                                                                                                          | High           |
| **Tiered reduction ladder**                                      | none found — prune and compact are separate paths                                                                                                                                                                                                                 | **yes** — `#rescueCompactionDeadEnd`, elide → dropImages, recoverable first — `agent-session.ts:13685-13760`                                                                                                                                                                                               | Medium / High  |
| **Subagent context firewall**                                    | `task` — child session, only last text part returns — `task.ts:65`, `:136-144`                                                                                                                                                                                    | `task` subsystem (`src/task/`, 25 files); result template `prompts/tools/task-summary.md`                                                                                                                                                                                                                  | High           |
| **…parent-visible result**                                       | `task_id` + `<task_result>` + last text part, then capped by M1 — `task.ts:138-144`                                                                                                                                                                               | `<task-result>` + `<meta lines size/>` + `<preview full-output="agent://id">` — `task-summary.md:1-14`                                                                                                                                                                                                     | High           |
| **…parent told the discarded size**                              | **no**                                                                                                                                                                                                                                                            | **yes** — `<meta lines size />`, `task-summary.md:2`                                                                                                                                                                                                                                                       | High           |
| **…subagent result itself spilled**                              | no (truncated by M1, spilled as any tool output)                                                                                                                                                                                                                  | **yes**, `agent://<id>` — `task-summary.md:7`                                                                                                                                                                                                                                                              | High           |
| **…recursion depth**                                             | 1 by default — `task` denied in child — `task.ts:78-86`, `:130`                                                                                                                                                                                                   | **2** by default — `settings.get("task.maxRecursionDepth") ?? 2`, `task/structured-subagent.ts:211`, gated by `canSpawnAtDepth` `:212`                                                                                                                                                                     | High           |
| **…resumable**                                                   | yes, `task_id` — `task.ts:29-34`, `:60-62`                                                                                                                                                                                                                        | yes, `hub send` / `agent://<id>` / `history://<id>` — `task-async-contract.md`                                                                                                                                                                                                                             | High           |
| **…subagent output caps**                                        | inherits 2000 lines / 50 KB (M1)                                                                                                                                                                                                                                  | `MAX_OUTPUT_BYTES=500_000`, `MAX_OUTPUT_LINES=5000`, env-overridable — `task/types.ts:53`, `:56`                                                                                                                                                                                                           | High           |
| **…async / no-poll contract**                                    | synchronous `await SessionPrompt.prompt` — `task.ts:120`                                                                                                                                                                                                          | explicit push contract, \~5 min job-id memory — `task-async-contract.md`                                                                                                                                                                                                                                   | High           |
| **…"done" ≠ verified warning**                                   | none found                                                                                                                                                                                                                                                        | **explicit** — *"`completed` means the subagent yielded successfully, not that claimed artifacts were verified"*                                                                                                                                                                                           | High           |
| **Prompt-mandated firewall use**                                 | yes but **Anthropic-prompt-only** for the hard form — `anthropic.txt:86`; soft form in 3 prompts                                                                                                                                                                  | not located in the prompts read                                                                                                                                                                                                                                                                            | High / Low     |
| **Prompt caching**                                               | ≤4 breakpoints, first 2 system + last 2 messages — `transform.ts:192-215`                                                                                                                                                                                         | **≤4 too**, but budgeted not positional: counts breakpoints already present (tools+system+messages), then last system block, then walks *back* from the message tail — `pi-ai/src/providers/anthropic.ts:3001-3047`, `:3128-3147`                                                                          | High           |
| **…cache TTL**                                                   | not read                                                                                                                                                                                                                                                          | **1h by default** for OAuth *and* API keys where supported, because "agent sessions routinely idle past 5 minutes waiting on background jobs" — `anthropic.ts:440-462`; longest-TTL-first ordering enforced at `:3049-3061`                                                                                | — / High       |
| **External CLI worker fan-out**                                  | none found                                                                                                                                                                                                                                                        | `vibe_spawn/send/wait/kill/list` — `tools/vibe.ts:50`                                                                                                                                                                                                                                                      | Medium / High  |
| **"Code mode" / script-batched tool calls**                      | **STRUCK — does not exist at v1.4.0.** Tree's only "Code Mode" is Cloudflare's, in a test fixture — `test/fixture/skills/agents-sdk/SKILL.md:152`; no script/exec tool in `tool/registry.ts:1-26`. See **O11**                                                    | not searched                                                                                                                                                                                                                                                                                               | High / —       |
| **Skill deferral** (instruction bodies out of the system prompt) | **yes** — description lists `- **name**: description` only, `Skill.fmt(list,{verbose:false})` `tool/skill.ts:32` + `skill/index.ts:258-263`; body loads on call `:79-91`                                                                                          | **yes** — skills addressed by a `skill://` internal URL scheme, `pi-coding-agent/src/internal-urls/skill-protocol.ts`, `compaction/tool-protection.ts:12`                                                                                                                                                  | High           |
| **…loaded skill content protected from eviction**                | **no** — prune clears on `part.state.time.compacted` alone, with no per-tool exemption — `message-v2.ts:718`                                                                                                                                                      | **yes** — `protectedTools: ["skill", isSkillReadToolResult]` on both shake and prune — `compaction/shake.ts:49`, `:57`, `compaction/pruning.ts:57`, matcher at `tool-protection.ts:38-39`                                                                                                                  | High           |
| **…bundled-resource file list**                                  | **sampled, capped at 10**, and the model is told so — `tool/skill.ts:56`, `:69-70`, `:86`                                                                                                                                                                         | not searched                                                                                                                                                                                                                                                                                               | High / —       |
| **Model-settable context budget**                                | **yes, uniquely** — `codesearch` `tokensNum` `.min(1000).max(50000).default(5000)` — `tool/codesearch.ts:44-51`. Every other opencode cap is a fixed constant                                                                                                     | none found — but on a **single grep** for `tokensNum`/token-count param descriptions; per this doc's own package-boundary lesson, treat as not-established                                                                                                                                                 | High / **Low** |
| **Child-session cost in parent's displayed total**               | **no** — total reduces over one session's own messages, `app/src/components/session/session-context-metrics.ts:51`; children excluded from roots and counters, `global-sync/session-trim.ts`, `event-reducer.ts`; `tool/task.ts` never mentions cost/tokens/usage | not determined                                                                                                                                                                                                                                                                                             | High / —       |

***

## Could not determine

Recording these explicitly, because an honest gap is worth more than a plausible cell.

* **Wall-clock cost of an opencode subagent spawn.** Not measurable by reading; would need a run. **This is now the only open gap.**

The other two closed on 2026-08-04 — both were the searches this section admitted had not been
run. Neither needed a run after all; both needed a *wider* search, which is the same lesson the
package-boundary section below draws.

### ✓ O10 · Child-session cost is **not** rolled into the parent's displayed total

Previously *"no aggregation path was located, but the search was not exhaustive."* The search is
now exhaustive across `packages/opencode/src`, `packages/app/src` and the SDK client, and the
answer is a clean **no**:

* The displayed total is built by `build(messages: Message[])` and reduces over **one session's
  own** messages: `messages.reduce((sum, msg) => sum + (msg.role === "assistant" ? msg.cost : 0), 0)`
  (`app/src/components/session/session-context-metrics.ts:51`), surfaced as `context.stats.totalCost`
  (`session-context-tab.tsx:216`).
* Children are separate rows keyed by `parentID` (`tool/task.ts:65-66`), serialized as `n` in the
  app store, and the app **deliberately excludes them** from root-level views and counters:
  `const roots = all.filter((s) => !s.n)` (`app/src/context/global-sync/session-trim.ts`) and
  `if (!info.n) input.setStore("sessionTotal", (value) => value + 1)`
  (`app/src/context/global-sync/event-reducer.ts`).
* `tool/task.ts` contains **no** reference to `cost`, `tokens` or `usage` at all — the only
  parent linkage it establishes is `parentID` (`:65-66`). Nothing flows back up.

**Why this matters for P-004's economics, not just as trivia:** the subagent firewall's whole
value is that the child's tokens never reach the parent's *context*. The corollary found here is
that they never reach the parent's *cost display* either. So the firewall's price is real but is
not visible where an operator would naturally look for it — a per-session cost readout
systematically under-reports the true cost of a task that delegated. Anyone costing this pattern
must aggregate child sessions themselves; opencode will not do it for them.

### ✓ O11 · "Code Mode" is **Cloudflare's**, not opencode's — the recalled cell's origin, identified

Previously *"a full-repo content search for the concept under another name was not run."* It has
now been run across all 19 packages, and it closes the cell far more strongly than a bare absence:

* The **only** occurrence of the term in the entire v1.4.0 tree is a **test fixture** documenting
  the **Cloudflare Agents SDK** — `packages/opencode/test/fixture/skills/agents-sdk/SKILL.md:152`,
  a doc-index bullet reading `**[references/codemode.md](references/codemode.md)** - Code Mode
  (experimental)`. Its own frontmatter names it: *"Build AI agents on Cloudflare Workers using the
  Agents SDK"* (`:2-3`).
* That referenced file **does not even exist** in the fixture — the `references/` directory
  contains only `callable.md`. It is a dangling link in third-party documentation used as test
  data.
* No tool in the registry executes a script that calls other tools. The registered set is
  `plan-exit · question · bash · edit · glob · grep · read · task · todo · webfetch · write ·
  invalid · skill · websearch · codesearch · lsp · apply_patch` (`tool/registry.ts:1-26`), and
  `packages/opencode/src/tool/` contains no script/exec/code-mode module.

So the recalled table did not merely over-state an opencode feature — it appears to have
**imported a different vendor's feature into opencode's column**. Cloudflare's Code Mode converts
MCP tools into a TypeScript API an LLM writes code against, which matches the recalled phrasing
*"confined orchestration script with access to connected MCP tools"* almost exactly. The likeliest
mechanism is that the fixture (or Cloudflare's docs) and opencode were read in one sitting and
fused in recall.

That is worth more than the strike itself: it shows the recalled table's errors were not random
drift but **attribution collapse between adjacent sources** — the failure mode a citation
requirement exists to catch, and an argument for citing even when you are confident.

### ✓ Eight of the original nine closed after publication — five of them to one cause

Six closed in the first post-publication pass (below); **O10** and **O11** closed on 2026-08-04,
both by running a search a previous pass had recorded as not-run. Only the subagent spawn's
wall-clock cost survives, and it is the one gap that genuinely needs a run rather than a read.

The five that closed were all OMP gaps, and every one of them read as *"OMP does not appear to
do this"* for the same wrong reason: **OMP is not one package.** The original read searched
`@oh-my-pi/pi-coding-agent`, which is only the CLI shell. The mechanisms live one and two
layers down, and each ships its own `src/`:

```
pi-coding-agent   session, UI, slash commands
  └── pi-agent-core   compaction, shake, prune
        └── pi-ai       provider wire, prompt caching, usage accounting
```

Searching `~/node_modules/@oh-my-pi/*` as a whole — rather than one package — turns all five up
in a single grep. **An absence proved by one grep in one package is not an absence.** That is
the transferable lesson here, and it applies to this doc's *remaining* gaps too: the two OMP
cells still marked *"not located"* above were established the same way and deserve the same
scepticism.

**That prediction was then borne out twice.** Both 2026-08-04 closures (O10, O11) were gaps this
doc had written off as needing a run; both fell to a wider search of material already on disk.
Note the asymmetry in what the wider search returned: O10 confirmed the suspected absence (no
cost rollup exists) while O11 overturned the framing entirely (the feature exists — for a
different vendor). **A gap recorded as "not searched" is not evidence of absence in either
direction**, and the cheapest way to find out remains running the search rather than reasoning
about whether it is worth running.

What closed, and where it actually lived:

| gap                      | answer                                                                                                                                                                          | package           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| Shake config values      | auto: `protectTokens 16_000`, `minSavings 4_000`, `fenceMinTokens 400`; manual `/shake`: both `0` — `compaction/shake.ts:46-59`                                                 | `pi-agent-core`   |
| Compaction thresholds    | `shouldCompact` is `contextTokens > threshold` (`compaction.ts:294-298`); fixed `thresholdTokens` beats percentage (`:319-325`); 15% proportional reserve fallback (`:282-288`) | `pi-agent-core`   |
| Subagent recursion depth | **2** by default — `task/structured-subagent.ts:211` (not `spawn-policy.ts`)                                                                                                    | `pi-coding-agent` |
| Prompt-caching strategy  | 4-breakpoint *budget*, 1h default retention, TTL-ordering normalized — see **O8**                                                                                               | `pi-ai`           |
| Cache tokens vs overflow | **yes**, they count — minus provider-side orchestration tokens — `compaction.ts:215-222`                                                                                        | `pi-agent-core`   |
| Cap universality         | **universal at the registration boundary** — `wrapToolWithMetaNotice`, `output-meta.ts:805`; see **O9**                                                                         | `pi-coding-agent` |

**Three** of these did not merely fill a blank — they **corrected cells that were already filled
wrongly**, and the three share a shape worth naming.

Two were the shake cells. OMP's hysteresis and protection band were recorded as *none found* and
*config-driven*; both exist and are cited above. The report had read only the aggressive path
that the manual `/shake` command uses, where both thresholds are deliberately zero, and
generalised from it. The auto path — the one that actually runs unattended — has real guards.

The third was cap universality (**O9**), and it is the same error in a different dress. The
report found `OutputSink` wired into `bash.ts` and `eval.ts`, correctly observed that this is
per-tool, and concluded OMP has no single choke point. It does — one layer up, at tool
*registration* rather than tool *execution*, wrapping every built-in, MCP, RPC-host and
extension tool alike. Both mistakes are the same one: **finding one mechanism and treating it as
the whole answer, when it was one layer of a layered design.** The package-boundary lesson below
is the coarse version of this; the layer-boundary version is subtler, because everything you
read is true — the per-tool wiring really is per-tool. It just was not the only thing there.

The practical form of the rule: when a mechanism looks *surprisingly* incomplete in a codebase
that is otherwise careful, the likely explanation is a second mechanism you have not found yet,
not an oversight by the authors.

## What would change these findings

Both codebases move fast — OMP went 15.5.13 → 16.3.3 → 17.0.7 within recent months, and
this box's opencode is a pinned dpkg from April. Re-run against the pinned identifiers in
the ground section before treating any number here as current. The two cheapest re-checks
are `tool/truncate.ts:17-18` (opencode's caps) and `session/streaming-output.ts:10-12`
(OMP's) — if those four constants still read as documented, the rest of the structure has
almost certainly not moved.

***

## Addendum — "What I'd borrow" (added on request; judgment, not research)

> **Provenance, and why it is in this file.** This section was authored on 2026-08-02 as a
> follow-up to the research above, on direct request, and was published **only** as a Claude
> artifact — never into any store the fleet can read. That artifact was later deleted, and on
> 2026-08-04 the plan's `## Now` was still directing the owner to pick from a "14-item borrow
> list" at a URL returning *artifact not found*. It was recovered from the publishing session's
> local `tool-results/` cache and landed here so it cannot be lost again. **The general rule it
> cost us: a published artifact is a *rendering*, never a deliverable's only home.** See
> WI-10730.

### Read this differently from everything above

Everything before this section is cited to `file:line` and holds without me. **This section is
judgment.** It was deliberately excluded from the research — the plan ruled that a
recommendation depends on papercusp numbers the research does not contain — and is here only
because it was asked for directly.

So **each item names the measurement that would kill it.** If that measurement has not been
taken, the item is a hypothesis wearing a recommendation's clothes.

#### ⚠ Retracted within the original — I read the code, and I was wrong

An earlier version of this section said papercusp's spill looked lossy, on the strength of one
observed `coord:orient` result that was capped and spilled with the tool saying *"paging it will
never recover what was omitted upstream."* I then read the writer. **The claim does not
survive.**

The door's spill is **lossless**: `result-door.ts:223` writes `header + fullText` — everything
that reached it — and caps only what goes into context, separately, at `:227-243`. What I
actually saw was the layer above it: when no explicit tier is requested and a payload crosses
the 30,000-char hard ceiling (`payload-tier.ts:91`, `:511`), a bounded projection replaces the
dropped content with `[omitted: …]` placeholders that are never serialized. So a spill taken
below that point genuinely cannot recover them — exactly as the tool said.

But it **is** recoverable, and the tool named the knob. Passing `payloadTier:'full'` explicitly
sets `explicitFullRequest` (`define-tool.ts:1334`, `:1467`), which returns before the
hard-ceiling force-shape (`payload-tier.ts:509`); the door below it then spills the unshaped
result losslessly and you page it. The recovery path is complete end to end. I had also
suspected the footer was giving impossible advice — recommending `payloadTier:'full'` to a
caller already at `tier=full` — and that is also wrong: my call had resolved to full by default,
never requested it, and the explicit request is a different code path.

What survives is narrower and is **not** a data-loss claim: recovery here costs a *re-execution
of the tool*, where OMP's costs a *range read of an artifact already captured at stream time*.
For an expensive, slow or non-idempotent call that is a real difference — and it is the only
part of item 5 below that still stands.

Worth saying plainly: **papercusp's messaging here is better than either codebase studied.**
Three distinct truthful header variants, a refusal to claim "FULL" unconditionally
(`result-door.ts:213-222`), and a hint teaching the `projection: {pipe:[…]}` operators that
would have avoided the overflow entirely. That is more than opencode's hint and more than OMP's
notice.

### ⚠ Status of these 14 items — read this table before acting on any of them

Added 2026-08-08, updated the same day as the remaining items closed. **Thirteen of these
fourteen items are now settled and must not be re-opened from the prose below**, which was
written before the evidence existed and still reads as fourteen live options. Only **item 7**
is genuinely unassessed (its precondition was never checked). Each verdict cites the decision
that closed it; disagree with a verdict by reading that decision, not by re-reading the item.

Two of the three Tier-3 items (8 and 2's remainder) died on **measurement invalidating their
premise**, not on cost — middle elision because our tails are never both load-bearing and
unrecoverable, per-tool caps because no per-tool cap exists. Both were borrowed as
plausible-sounding mechanisms from another system. **Price the premise before pricing the
build.**

The owner approved **Tier 1 + Tier 2 only** (items 1–6) on 2026-08-02, with an explicit
escape clause — *"if you think we should still keep it after seeing how our system handles
this"*. That clause is why three of the six are closed NEGATIVE: the comparison ran, and
the measurements killed them. **Tier 3 and Tier 4 were never approved**; they are unasked,
not outstanding.

**Reading the citations:** a bare `D-0NN` below belongs to
**`agent-context-firewall-and-output-spill-2026-08-02`** (the plan that ran the
measurements); decisions on the reconciling plan are written out in full. `D-0NN` ids are
only meaningful with their plan — two plans both have a `D-005`.

| #  | Verdict                                                           | Authority                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1  | **DONE** 2026-08-08                                               | `payload-tier.ts` omission markers now carry size + the `payloadTier:'full'` recovery pointer (WI-36048)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 2  | **SHIPPED**; remainder **REJECTED on measurement** 2026-08-08     | Taught once in standing context, generated from `computeTurnDoors` — `agent-context-firewall…` D-009. Sited there, not in the tool descriptions, precisely because of the prompt-weight budget this item named as its own killer. The *per-tool cap interpolation* remainder is now closed by D-021: **there is no per-tool cap to interpolate** — `result-door.ts:57`/`:246` resolve `resultEach` per RECIPIENT SESSION, never per tool — and a static description naming a session-dependent number would be *wrong*, not merely costly. Cost confirms it independently: 724 tools, p50 793 / p90 1371 / **p99 1491 / max 1498** against a 1500 budget; +120 chars on every tool newly breaches the budget on **66** and the hard cap on **14** (WI-36767)                                                                                                                                                                                            |
| 3  | **ADOPTED as a rule** 2026-08-08                                  | `opencode-omp-borrow-finish-2026-08-08` D-019 (with items 11 + 12)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 4  | **DEAD — do not port**                                            | D-006: the 89.5% headline was a definitional artifact of the spill-file shape                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 5  | **DEAD — do not build**                                           | D-005 + EI-19384431482006940: the path it rescues is \~134 cheap re-callable reads/day against 68,649 recoverable spills/24h                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 6  | **DEAD — measured, not argued**                                   | D-018: fan-out costs **1.27×** the exploration it absorbs, priced in billed usage over 795 transcripts / 495 sessions. This also **closes the "Could not determine" gap** listed above for opencode subagent spawn cost — that question has now been answered on our own corpus, which is the number that actually governs the decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 7  | Never approved                                                    | Precondition unchecked (we have no in-session history-eviction pass)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 8  | **REJECTED on measurement** 2026-08-08                            | D-020. Head-keep is correct in **all three** live door populations, and middle elision would actively make two *worse*. `result-door` is deliberately priority-ordered head-first — that IS the WI-5656 fix (`orient.ts` ranks `self`+`recovery` first, pinned by `orient-recovery-door-priority.test.ts`), so eliding the middle would cut mid-priority legs while preserving the lowest-priority tail; `ambient-push` sorts most-urgent-first, same inversion; the wake `injection-door` already spills its tail behind a pointer. **General rule:** elision only pays where the tail is *both* load-bearing *and* unrecoverable — here it is never both, so the lever is REORDERING (what WI-5656 actually used), not a smarter cut. Byproduct: the `ambient-push-door` `lossless` registration was resting on a reason that was false on two counts — corrected, with a bound test + non-vacuity control (WI-36683); its structural fix is WI-36688 |
| 9  | Never approved — **but a CONFIRMED DEFECT, now fixed** 2026-08-08 | `result-door.ts` returned the full uncapped result when the spill write failed. WI-36047                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 10 | **MEASURED, then scoped down — DONE** 2026-08-08                  | `result-door.ts` caps text only, so an image-heavy result takes the identity fast-path untouched — the shape is real, but **exposure is ZERO**: `computer:*`, the only image-emitting tool, has never been invoked (0 rows against a denominator of 1,116,788 rows / 302 tools in 14d, sanity-checked before trusting the empty). So no speculative cap was built — only the SILENCE was removed: `nonTextChars` in `_meta` plus a fast-path notice when non-text exceeds the door budget. WI-36613                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 11 | **Already satisfied**                                             | `compaction-usage.ts` estimates from transcript bytes and never anchors on provider-reported usage                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 12 | **Precondition holds**                                            | We shape at result-creation, ahead of the cache, not behind it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 13 | **DONE** 2026-08-08                                               | Landed as *runtime-rendered* text, not prompt text — `renderCompletion` (`coord-lifecycle/render.ts`), the notification the PARENT reads, so it costs **zero** prompt weight (item 2's killer) and can be CONDITIONAL: said only when true, so it never becomes boilerplate readers skip. A completion recording neither `tests` nor `verifiedHow` is now marked **UNVERIFIED** in the headline plus a terse body clause. Uncovered and fixed en route: `renderCompletion` was violating its own D-006 information-preservation invariant by dropping `verifiedHow` *and* `filesChanged`, and the test asserting that invariant passed **vacuously** because its fixture never set either field. WI-36726                                                                                                                                                                                                                                               |
| 14 | **Parked**                                                        | Tier 4. We hold an independent negative: OMP's image-archival compaction was the root cause of ornith-35b's context overflow on 2026-07-13 (a text-only model cannot read a bitmap back)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

### Tier 1 — cheap, and I'd do them now

Prompt-level or single-function changes. None needs a measurement to justify.

#### 1. Make the eviction placeholder self-describing — *OMP · O4*

OMP replaces evicted content with `[shaken ~N tokens — recover: artifact://<id> (region N)]`.
opencode uses a fixed `[Old tool result content cleared]`. The first tells the model how much
went and how to get it back; the second tells it neither, so the model cannot even decide
whether recovery is worth a call.

This is a string-formatting change at the eviction site. It is the highest
value-per-line-changed item in the whole document.

**What would kill it:** nothing measurable — but it is worthless, and worse than nothing, unless
the recovery pointer it advertises actually resolves. Ship it only alongside the Tier 2
raw-capture item, or it becomes a lie the model trusts.

#### 2. Tell the model the caps in the tool description — *opencode · M2*

opencode's bash description interpolates the live constants at registration —
`.replaceAll("${maxLines}", String(Truncate.MAX_LINES))` (`bash.ts:469-470`) — so the limits can
never drift from what the model was told. Otherwise the model discovers caps by tripping them,
which costs a round trip every time.

**What would kill it:** the prompt-weight budget. Papercusp already gates tool
description+guidance at 1500/1600 chars, so this has to be counted, not assumed free.

#### 3. Order reductions: recoverable before irrecoverable — *OMP · O6*

OMP's rescue ladder runs `shake("elide")` before `dropImages()`, and the source says why:
elided text is artifact-recoverable and images are not (`:13696-13698`). It is a sequencing
rule, not a feature — near-free to adopt, and it makes every future reduction mechanism slot
into an obvious position.

**What would kill it:** nothing. This is a principle; adopt it as a rule for wherever reduction
already happens.

#### 4. Add a per-line column cap at the sink — *OMP · O1*

`DEFAULT_MAX_COLUMN = 512`, applied statefully across streaming chunks. Line and byte caps
together still handle the pathological case badly: one 200 KB line — a minified bundle, a base64
blob, a single JSON log record — passes the line cap and blows the byte budget on content with
almost no information per byte.

**What would kill it:** if long single lines are rare in our corpus this is churn. Measurable
directly: the distribution of max-line-length across recent tool results.

### Tier 2 — real work, and where the actual leverage is

#### 5. Capture raw *before* the lossy projection, so recovery is a read and not a re-run — *OMP · O3*

**Scoped down after reading our own code** — see the retraction above. We already have the two
things I first thought were missing: the door spill is lossless (`result-door.ts:223`), and
paging it by `offset`/`limit` plus the `projection: {pipe:[…]}` operators is arguably a *richer*
selector than OMP's `artifact://5:1-50` grammar, because it applies to any tool's result rather
than only to a spill.

What is genuinely different is **when the capture happens**. OMP mirrors the raw, pre-cap chunk
to the artifact as it streams (`streaming-output.ts:877-880`), defaulting the artifact cap to
unbounded precisely so "advertised captures are lossless" (`:772-773`). We capture *below* the
tier projection, so when the default path drops fields at the hard ceiling, the only way back is
to run the tool again with `payloadTier:'full'`.

That is fine for a cheap idempotent read and bad for an expensive, slow, or side-effecting one.
The narrow ask: mirror the unshaped payload at projection time, and have the projection
placeholder point at it — which is also what makes the Tier 1 placeholder change worth anything.

**What would kill it:** disk, and it may not be worth it. Measure two things before building:
how often the hard-ceiling path actually fires, and what share of those calls are expensive
enough that re-running is the wrong answer. If most overflows are cheap reads, the existing
re-call path is already correct and this is churn. If it is worth it, take opencode's hourly
sweep on a retention window — OMP never expires artifacts, which is wrong for a shared box.

#### 6. Wire a context firewall to the spill — papercusp-shaped, not opencode-shaped — *opencode · M6 + M1*

The single best idea in either codebase, and the one most likely to be mis-adopted. opencode
does not merely truncate-and-spill; the truncation hint **branches on whether the agent can
delegate** and, when it can, says *"Do NOT read the full file yourself - delegate to save
context"* (`truncate.ts:109-111`). Overflow goes to disk and a disposable reader is sent to it,
so the bytes never enter the caller's context at all. Truncation without that second half just
defers the cost to whoever opens the file.

**The mechanism as opencode implements it cannot run here.** `Task`/`Agent`/`Workflow` are
denied on every psu launch. But the *property* — a disposable reader whose context dies with it
— is exactly what a headless fleet member or a nursery cup already is. Borrow the coupling;
build it on the spawn primitives we actually have.

**What would kill it:** spawn latency and spawn cost. opencode's child is an in-process session;
ours is a process. If a delegated read costs more wall-clock than the context it saves is worth,
this loses. Measure spawn-to-first-token before building. *(This is the one remaining open gap
in the research body, and it is open for exactly this reason.)*

### Tier 3 — worth doing, lower urgency

#### 7. Hysteresis and a protection band on any eviction pass — *opencode · M5*

Three guards, all cheap: never touch the last two user turns; stop the walk at the
already-evicted boundary so passes are incremental instead of re-scanning history; and only
apply the queued eviction if it frees more than a floor (opencode uses 20k tokens against a 40k
protection band). The floor is what stops the system churning history for a trivial win.

**What would kill it:** nothing — but pick the constants from our own token distribution, not
opencode's.

#### 8. Middle elision as a first-class truncation mode — *OMP · O2*

OMP types `truncatedBy` as `"lines" | "bytes" | "middle"` and reports `Showing N of M lines;
middle elided`. For stack traces, diffs and long logs, both ends carry the signal and the middle
is filler — head-only truncation reliably discards the part that says how it ended.

**What would kill it:** if our large outputs are mostly head-relevant (listings, search results),
the added mode is unused complexity.

#### 9. A cap that needs storage must degrade to truncate-without-recovery, never to no-cap — *OMP · O9 — a trap, not a feature*

This is the one place the audit found OMP inconsistent with itself, and the inconsistency is
instructive because it sits inside a single function. `spillLargeResultToArtifact` saves the full
output as an artifact and then truncates what goes into context. When the **save fails** (disk
full, permissions) it catches, logs, and **still truncates** — under an explicit comment that a
save failure must never re-expose the full, possibly context-blowing output
(`output-meta.ts:684-692`). Correct. But when the artifact store is simply **absent** — no
`SessionManager`, which is optional on the SDK context (`sdk.ts:542`) — the function returns the
result **uncapped** at `:656`. Same risk, same function, opposite answers.

The generalisation: any cap implemented as a side-effect of "park the full copy somewhere" has
two distinct failure modes, and the absent-store one is the easy one to write as an early return.

**What would kill it:** nothing to build — this is a check to run against our own result-door:
confirm that a door whose scratch destination is unwritable or unconfigured still caps what
reaches context, rather than passing the payload through. I have not read that path, so this is a
question, not a finding.

#### 10. Check whether our output caps cover non-text blocks at all — *OMP · O9*

OMP's universal cap measures only `block.type === "text"` (`output-meta.ts:666-671`) and passes
every other block through untouched (`:710-714`). Images — from browser captures, fetch, eval,
`inspect_image`, `read` — are governed only by a 20 MB decode-safety guard
(`utils/image-loading.ts:7`), which is three orders of magnitude past any context budget. OMP
does reduce images, but one layer later, at compaction (`dropImages()`), which means the
expensive turn has already happened. **The point worth borrowing is the question, not the
number:** a byte cap written against text blocks silently exempts every other content type, and
nothing in the code looks wrong when it does.

**What would kill it:** if we never return image or binary blocks through the capped path, this
is moot. Worth thirty seconds to confirm rather than assume.

#### 11. Floor the compaction trigger by your own estimate, not the provider's number — *OMP · found closing a gap*

`compactionContextTokens = max(providerContextTokens, storedConversationEstimate)`
(`pi-agent-core/src/compaction/compaction.ts:315-317`). The reasoning in the source is the
valuable part: a `before_provider_request` transform — a compression extension, an obfuscator, or
inline `snapcompact` — shrinks the request, so the provider reports deflated prompt tokens, and
anchoring compaction on that usage lets the real stored history grow unbounded until it overflows
and native compaction can no longer run. Flooring by the agent's own estimate keeps the trigger
honest regardless of on-wire compression. Display and cost accounting still use the exact
provider usage; only the *decision* takes the floor.

We already shape payloads between the tool and the model. The moment anything compresses on the
wire, this exact trap is live — and its failure mode is silent until the session dies.

**What would kill it:** only relevant if we transform requests before they reach the provider. If
we never do, this is a note for whenever we start.

#### 12. Never rewrite history inside the warm cache prefix — pruning is not free — *OMP · found closing a gap*

The best thing found in this whole follow-up pass, and it is a trap rather than a feature. OMP's
pruner carries a `cacheWarmSuffixTokens` guard (`pi-agent-core/src/compaction/pruning.ts:44-51`):
for every entry it precomputes the token total of all messages *after* it
(`computeMessageSuffixTokens`, `:137-141`), and refuses to touch any entry whose suffix exceeds
the threshold — `8_000` tokens in practice (`agent-session.ts:792`, wired at `:10711`).

The reasoning is the part to steal. Editing a message that sits in the already-sent cached prefix
does not cost you that message — it **invalidates the prefix from that point on**, so the
provider re-writes the entire suffix at `cacheWrite` price. A prune that reclaims 2k tokens by
blanking a stale tool result 60k tokens deep is a straight loss. So OMP deliberately leaves
superseded and useless results alone when they are deep — explicitly overriding its own
supersede/useless rules, which otherwise bypass every protection window (`:349-357`) — and lets
compaction and shake reclaim them instead, because those rebuild the cache anyway.

Generalised: **any cleanup pass over conversation history has a cost gradient that runs the
opposite way to the obvious one.** The oldest, stalest, most tempting material is the most
expensive to touch; the cheap-to-edit region is the recent tail you least want to prune. Anything
that rewrites history mid-session needs to know where its cache boundary is, or it will
confidently spend more than it saves — and the spend is invisible, because it shows up as someone
else's `cacheWrite` line rather than as a failed prune.

**What would kill it:** we do not retroactively mutate sent messages today — our shaping happens
when a tool result is created, which is ahead of the cache, not behind it. This is a precondition
to check before building any history-rewriting pass, not a fix for an existing one. It also
assumes an explicit prefix cache; against a provider with implicit caching there is no boundary
to respect.

#### 13. An explicit anti-trust clause in the subagent result contract — *OMP · O7*

*"`completed` means the subagent yielded successfully, not that claimed artifacts were
verified."* One sentence in the result template. We already run completion-integrity audits after
the fact; this is the same correction delivered at the moment the parent *reads* the result, when
it is still cheap to act on. Pair it with OMP's `<meta lines size />`, which tells the parent how
much output was discarded, so "the summary looks thin" becomes a checkable claim.

**What would kill it:** nothing. This is prompt text.

### Tier 4 — interesting, but experiment only

#### 14. `snapcompact` — compaction with no model call — *OMP · O5*

Archive history onto dense bitmap images the model reads back through vision, so compaction costs
zero summarization tokens. Genuinely novel and the most surprising thing in either codebase.

It is also the least proven, depends on vision fidelity, and changes what history *is*. Worth a
bounded experiment on a throwaway harness; not worth a place in the main ladder until someone has
measured recall against a summarizer on the same transcript.

**What would kill it:** recall. If the model reads back a bitmap of history materially worse than
it reads a summary, the saved call was not free.

### Skip — what I would *not* borrow

* **opencode's `[Old tool result content cleared]`** — strictly dominated by OMP's placeholder.
  If we are touching that string at all, take the better one.
* **OMP's no-expiry artifact store** — correct for a per-session directory on a laptop, wrong for
  a shared box running many long-lived sessions. Take opencode's hourly sweep on a retention
  window instead. This is the one place where the older design wins.
* **`code-mode`** — it does not exist at v1.4.0. Whatever the recalled table was describing, it
  is not in the codebase; do not chase it on this evidence. *(Since closed as **O11**: the
  concept is Cloudflare's, appearing in an opencode test fixture.)*
