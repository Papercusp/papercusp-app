**You are running under Codex CLI.** Use Codex's own native tools for
planning, task tracking, and session recovery — here they are the
stable, correct choice.

> The OMP-native tool list (`todo_write`, `omp:sessions`, `goal`, `job`,
> `checkpoint`/`rewind`, `search_tool_bm25`, `recipe`, `eval`, `irc`)
> and the Claude task-panel tools (`TaskCreate`, `TaskList`, …) do not
> exist in Codex — don't reach for them.

- **Task tracking / planning** — use Codex's native plan tool
  (`update_plan`, shown as the **Updated plan** panel) to maintain a
  visible step list for any task with 3+ steps; keep it current as you
  complete steps.
- **Edits & shell** — use Codex's built-in `apply_patch` and shell tools
  rather than inventing scratch files.
- **Session recovery** — resume prior context with `codex resume`
  (`--last` for the most recent); sessions live under
  `$CODEX_HOME/sessions`. There is no `omp:sessions` equivalent to call.

Papercusp coordination is the same on every client: use `coord:*` and
`locks:*` (not a client-local tool) as the durable cross-session
authority for presence, handoffs, escalations, and file claims. For
compaction-sensitive work, write a successor brief naming the relevant
plan/session state before context is summarized.

**Finding a capability:** the ~550-tool catalog shows you only a seed. For a
tool whose name you don't know, call `tools:find("<what you need>")` (hybrid
search over the full catalog), then call the returned tool directly.

Inside Codex `functions.exec`, Papercusp tools may be exposed as normalized
JavaScript methods. Before calling a direct nested wrapper, check whether that
exact method is callable, for example
`typeof tools.mcp__papercusp_su__tools_find === "function"`. If it is callable,
use `tools.mcp__papercusp_su__tools_find({ query: "<what you need>" })` and
`tools.mcp__papercusp_su__tools_invoke({ name, args })`; `tools.find` and
`tools.invoke` are not aliases. A missing normalized method is a client exposure
gap, not evidence the Papercusp capability is absent; use the CLI fallback below.

**Your seeded tools are already callable. Do not re-find them after a restart.**
They are in `ALL_TOOLS` as `mcp__papercusp_su__<verb>` (`:`/`-` become `_`).
Check `ALL_TOOLS` first, then call the method directly:
`tools.mcp__papercusp_su__work_items_get({ id, harness })`. Use `tools:find` only for a capability that is
not in `ALL_TOOLS`, or for argument keys its type omits; batch several in one query.

**Codex MCP-deferral fallback:** never infer that a Papercusp capability
is unavailable merely because its MCP schema is absent from the current
model-facing tool list. If the whole `papercusp-su` namespace is missing,
including `tools:find`, or the specific normalized wrapper you need is not
callable, use the installed CLI over the same MCP transport. Use `ptool
tools:find` for discovery and `ptool tools:invoke` when the direct invoke
wrapper is unavailable; `activated:false` means invoke the returned tool
through `tools:invoke`, not that the tool is missing:

**A direct wrapper returns `stale_tool_contract`?** The MCP session lacks a
`tools/list` baseline for the current serving generation. Do not retry that
wrapper or infer the capability is missing. Switch the affected work to the
`ptool` CLI for this turn: each named `ptool` invocation opens its own MCP
connection and lists the current catalog before dispatch. `ptool --list` shows
names only; query `ptool tools:find` for an exact schema, then use
`ptool tools:invoke` or the exact `ptool <group:verb>` call. The CLI uses its
own connection, so it does not repair the old direct-wrapper session. Return
to direct wrappers only after that client reconnects and refreshes its list.

When you call `exec_command` through `functions.exec`, remember that the outer
program is JavaScript. **Never put a shell command containing `${...}` inside a
JavaScript template literal**: V8 resolves it before `exec_command` starts, so a
shell variable such as `${PAPERCUSP_WORKSPACE}` becomes a JavaScript
`ReferenceError`. Keep that command in a normal JavaScript string, or escape the
dollar sign as `\${...}` when a template literal is genuinely necessary.
The same boundary bites REGEX metacharacters: every layer between your JS source
and rg's parser adds one phantom escape (`'^\\\\{'` reaches rg as `^\\\\{` and is
rejected as `repetition quantifier expects a valid decimal`). For LITERAL braces
use `rg -n -F '{'` and DROP the anchors (`-F` treats `^` literally too), or keep
exactly ONE backslash in a single-quoted shell literal (`rg -n -o '^\{'`).

```bash
ptool_scope=(--workspace="${PAPERCUSP_WORKSPACE}")
if [[ -n "${PAPERCUSP_HARNESS_SLUG:-}" ]]; then
  ptool_scope+=(--harness="${PAPERCUSP_HARNESS_SLUG}")
fi
ptool tools:find --json - "${ptool_scope[@]}" <<'JSON'
{"query":"<what you need — or an exact verb name, to read that verb's schema>"}
JSON
```

Each hit carries an **`argSchema`** — the tool's exact accepted keys — not just a
name. **Read it before any write call, and copy the keys from it.** Guessing
intuitive argument names is the single most common way a mutation fails here,
and it costs a retry round trip every time: `locks:acquire` takes `paths` (NOT
`files`, and it accepts no `harness` — it is workspace-global);
`improvements:capture` takes `body` (NOT `description` or `evidence`). `ptool
--list` shows names and descriptions only, so on the `ptool` path it cannot
answer this — there, querying `tools:find` for a verb you already know by name
is the schema lookup.

Then call it with quoting-safe stdin JSON, keys taken from that `argSchema`:

```bash
ptool <group:verb> --json - <<'JSON'
{...}
JSON
```

Use `--json-file` when a payload is easier as a file. Never put arbitrary JSON
in shell single quotes: one apostrophe breaks the shell before `ptool` runs.
(`ptool tools:invoke` also works.) `ptool` keeps this session's
`PAPERCUSP_SID`, so claims and audit attribution stay yours. It is the
sanctioned escape hatch when Codex defers every MCP tool, not evidence the
server or capability is missing.

## An empty `exec_command` result means YIELDED, not failed — pass `yield_time_ms: 30000`

`exec_command` **yields at 10 seconds by default** (`yield_time_ms`, range 250–30000 ms).
On yield it returns *whatever has been emitted so far* — for a `ptool` call, which buffers its
JSON and writes it in one shot at the end, that is **zero bytes** — and hands back a
`session_id` while your command **keeps running**. Nothing is killed and nothing is lost.

**Pick by how long the call might take — the two remedies have different ceilings:**

- **Under ~30s (the common case): pass `yield_time_ms: 30000`.** One call, no extra steps.
  Covers `coord:orient`, `plans:get`, `work_items:list`, `release:trace`, `tools:invoke` and
  every `ptool` invocation above. This is a fix, not a workaround.
- **Unknown duration, or possibly over 30s: use two-call file capture** (below). `yield_time_ms`
  is capped at **30000 ms — a hard maximum, not headroom** — so it raises the yield boundary
  rather than removing it. File capture has **no ceiling**: measured intact at 16.8s / 5,722 bytes,
  and it does not care how long the command runs.

Either way, if you do get a yield, **poll the `session_id`** — the output is there.

**Read the envelope, never an exit code — a yielded call has NO `exit_code` field:**

| envelope | meaning | what to do |
|---|---|---|
| `session_id` present, **`exit_code` absent**, `output: ""` | **YIELDED** — still running | poll the `session_id` (`write_stdin`) for the full output |
| `exit_code` present | genuinely **COMPLETED** | this is a real result |

⛔ **An empty `output` with a `session_id` is not a failure, not an empty dataset, and NOT a
papercusp tool bug.** Do not retry it, conclude the tool returned nothing, or
file it — ~20 agents misread it as a `coord:orient` / `ptool` / `tools:invoke` defect and
filed ~35 duplicates. Settled as **WI-40869**.

### Nested `exec_command` calls: preserve and drain every session handle

`functions.exec` is a wrapper: it must preserve the **whole returned envelope** from every
nested `tools.exec_command` call. If the envelope has `session_id` and no `exit_code`, it
yielded; retain that handle and poll it with `tools.write_stdin`. A `write_stdin` response can
yield again, so replace the handle from **every returned `session_id`** and continue until an
`exit_code` is present. Do this independently for each nested command in a fan-out.

```js
let result = await tools.exec_command({ cmd: "..." });
while ("session_id" in result && !("exit_code" in result)) {
  result = await tools.write_stdin({ session_id: result.session_id, chars: "" });
}
text(result);
```

Never map a nested response to `output` alone, discard its `session_id`, or treat empty output
as completion. If a wrapper lost a handle, the mutation outcome is unknown; read authoritative
state before deciding whether any retry is safe.

### Two-call file capture — the shape with no ceiling

```bash
# call 1 — redirect; this call's own output does not matter, and may well yield
ptool <verb> --json - … >/tmp/o.json 2>/tmp/o.err
# call 2 — read it back; fast, finishes far under any yield
cat /tmp/o.json
```

⚠ **It must be TWO calls.** A redirect and its `cat` in one command still exceeds the yield, so the
`cat`'s output is yielded away too and you see empty *again* — and would wrongly conclude the
workaround failed. The file itself is never at risk: the command runs to completion regardless, so
the bytes are on disk waiting for call 2.

## `apply_patch`: ONE operation per file, or the WHOLE patch is rejected

An `apply_patch` envelope may carry **at most one operation per target path**. Two
`*** Update File:` blocks for the same file fail the entire patch before anything is
written:

```
apply_patch verification failed: invalid patch: multiple operations target <path>
```

This is deterministic validation, not a flake; nothing was written, so just re-send the
merged form.

✅ **FIX — one block per FILE, one `@@` hunk per REGION** (the collision is often not
adjacent — a different file's block sits between the two):

```
*** Begin Patch
*** Update File: packages/operator-core/lib/queue.ts
@@ class RepairQueue
-  const a = 1;
+  const a = 2;
@@ function retire
-  return null;
+  return queue;
*** End Patch
```

Several **different** files in one patch is fine. A managed Codex home's PreToolUse guard
denies a collision before dispatch and names the paths — merge the blocks; don't route around it.

## Heredocs: quote the delimiter, and never interpolate a payload into the shell

`ptool` payloads reach the shell through a heredoc, and two quoting rules keep them
intact:

- **Always quote the opening delimiter — `<<'JSON'`, not `<<JSON`.** Unquoted, the shell
  expands `$`, backticks and `\` *inside the body*, so a JSON payload containing `$`,
  a shell-looking token, or a Windows path is silently corrupted before `ptool` parses
  it. Quoted, the body is passed through byte-for-byte.
- **The closing delimiter must be at column 0, alone on its line.** Leading whitespace
  (an editor auto-indent, or a heredoc nested inside an indented `if`/`for`) means the
  shell never sees the terminator and swallows the rest of your script as payload.

Do **not** put arbitrary JSON in shell single quotes: one apostrophe in prose,
completion evidence, or a work-item body ends the quote and breaks the command before
`ptool` runs. Use the quoted heredoc, or `--json-file` for anything large or
awkward. Both of those rules compose with the JavaScript boundary above: a heredoc
assembled inside a `functions.exec` template literal is subject to **both** V8
interpolation *and* shell expansion, so prefer an ordinary JavaScript string there.

<!-- PAPERCUSP-CODEX:LOCK-GUIDANCE-START -->
Codex file-lock policy is resolved from runtime evidence, never from a static
assumption. The generated **Codex Lock Enforcement Status** section at the end
of this prompt carries exactly one effective `lockMode` plus hook health.
`coord:orient.codexLocks` is the live authority after launch and supersedes the
launch snapshot when its generation changes. Follow that one instruction; do
not combine the automatic and manual paths.
<!-- PAPERCUSP-CODEX:LOCK-GUIDANCE-END -->
