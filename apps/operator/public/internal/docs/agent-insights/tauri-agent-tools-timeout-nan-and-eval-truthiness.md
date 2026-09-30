# tauri-agent-tools check/wait: millisecond options collapsed to NaN, and wait's truthiness was inverted underneath it
URL: /internal/docs/agent-insights/tauri-agent-tools-timeout-nan-and-eval-truthiness

Two stacked bugs in the globally-installed tauri-agent-tools CLI (external npm package, not in this repo) — a classic commander.js parseInt-as-radix footgun turned every --duration/--timeout/--interval default into NaN, which masked a second bug where wait --selector/--eval compared against the bridge's stringified booleans and could never match or never fail correctly.

## Symptom

`tauri-agent-tools check --duration 5000` printed a Node `TimeoutNaNWarning` and
returned a pass verdict after \~1ms instead of running for 5s. `tauri-agent-tools
wait --eval <condition> --timeout 120000 --interval 100` returned "Timed out
waiting for expression to be truthy" after \~34ms instead of polling for up to
120s. `console-monitor --duration 5000` (no CLI-declared default) ran correctly
for \~5.3s — so the fault looked command-specific rather than a shell/Commander
universal, which is what made it look small (WI-4991 / EI-12504).

**This is a globally-installed third-party npm package** (`tauri-agent-tools`,
from `github.com/cesarandreslopez/tauri-agent-tools`), not part of this repo —
installed at `/home/linuxbrew/.linuxbrew/lib/node_modules/tauri-agent-tools`.
There is no local source checkout, only the compiled `dist/`. The fix here was
applied directly to the installed `dist/*.js` files so every agent on this box
gets the corrected CLI immediately; it will **not** survive a
`brew reinstall` / `npm install -g tauri-agent-tools` that pulls a fresh
copy from the registry — re-apply (or push upstream) if the tool ever gets
reinstalled and the symptoms above reappear.

## Root cause 1 — commander's classic `parseInt`-as-custom-parser footgun

Commander.js option definitions accept `(flags, description, fn, defaultValue)`.
When `fn` is supplied, Commander calls it as `fn(value, previousValue)` on every
occurrence — where `previousValue` is the option's **default value** on the
first (and, for a non-variadic option, only) call. Passing the bare `parseInt`
function directly hits this: `parseInt`'s second parameter is a **radix**, not
an accumulator. So `--duration 5000` with a declared default of `3000` calls
`parseInt("5000", 3000)` — radix `3000` is out of the valid `2..36` range, so
`parseInt` returns `NaN`, **regardless of what the user typed**. That `NaN`
then flows into `setTimeout(fn, NaN)` (Node coerces a non-finite delay to `1`,
emitting `TimeoutNaNWarning`), or into `deadline = start + NaN`, making every
`Date.now() < deadline` loop guard evaluate to `false` immediately.

This explains the "some commands work, some don't" pattern exactly:
`console-monitor --duration <ms>` had **no declared default**
(`.option('--duration <ms>', '...', parseInt)`), so `previousValue` was
`undefined` on the first call and `parseInt(value, undefined)` correctly
parses in base 10. Every option with a *numeric default* alongside bare
`parseInt` was broken; every option *without* one happened to work by luck.

Found **12 occurrences** of this pattern across the CLI (not just check/wait):
`check --duration`, `wait --timeout` + `--interval`, `dom --depth`,
`capture --dom-depth` + `--logs-duration`, `ipc-monitor --interval`,
`rust-logs --interval`, `console-monitor --interval`, `mutations --interval`,
`snapshot --dom-depth`, `store-inspect --depth`, plus `--max-width` on
`screenshot` and `--port`/`--pid` in the shared bridge options. All were fixed
by one shared helper (`parsePositiveInt` in `commands/shared.js`) that ignores
the previous/default argument entirely and rejects non-finite input with a
clear `commander.InvalidArgumentError` instead of a silent `NaN`.

## Root cause 2 — `wait`'s truthiness checks were inverted by bridge stringification, and root cause 1 was hiding it

Once the `NaN` bug above was fixed, live verification against a running Tauri
bridge (`tauri-agent-tools wait --eval "false" --timeout 3000`) immediately
exposed a **second, more severe** bug that root cause 1 had been masking:
the bridge's `/eval` endpoint always returns primitive results **stringified**
— `bridge.eval("false")` resolves to the *string* `"false"`, never the
boolean `false` (confirmed by probing `BridgeClient.eval` directly; `eval.js`'s
own JSON-parse-then-print fallback already silently works around this for
display purposes).

`wait.js` did not account for this:

* **selector mode** compared `result === true` — always `false`, since the
  wire value is the string `"true"`. This meant `wait --selector` could
  **never succeed**, even for a selector present from the start — it always
  ran the full `--timeout` window and then threw `Timed out waiting for
  selector: ...`, regardless of reality.
* **eval mode** did `if (result)` — a non-empty string is JS-truthy, so
  `"false"` (and `"0"`) evaluated as truthy. `wait --eval` **always matched
  near-instantly** regardless of the real expression value.

Before the `NaN` fix, both paths were dominated by the `deadline = start + NaN`
short-circuit (loop body never executes, straight to "Timed out"), which is
exactly EI-12504's reported symptom. Fixing only root cause 1 without also
fixing this would have "fixed" the ticket into a **worse** state: `wait --eval` would then report false-positive matches in \~100ms instead of a
false-negative timeout in \~50ms — same practical brokenness, opposite
direction, and much easier to miss in a quick pass since it "returns success."

Fixed with a shared `isBridgeResultTruthy(result)` helper (`commands/shared.js`)
that JSON-parses a string result back to its real value before applying
`Boolean()`, falling back to "non-empty string is truthy" only when the string
isn't valid JSON (e.g. an arbitrary string return value). Both `wait`
call sites (`selector` and `eval` modes) now use it.

## Verified live (not just unit-level)

Against a live Tauri bridge (`--pid <papercusp-desktop pid>`):

| command                                         | before                                              | after                                                                  |
| ----------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------- |
| `check --no-errors --duration 3000`             | passes in \~1ms                                     | passes in \~3.39s                                                      |
| `wait --eval "false" --timeout 3000`            | "Timed out" in \~0.06s                              | "Timed out" in \~3.40s (correctly never matches)                       |
| `wait --eval "true" --timeout 5000`             | (masked by NaN bug)                                 | matches in \~86ms                                                      |
| `wait --selector "body" --timeout 5000`         | "Timed out" in \~5s even though `body` exists       | matches in \~102ms                                                     |
| `wait --selector ".nonexistent" --timeout 3000` | "Timed out" in \~0.06s (right answer, wrong reason) | "Timed out" in \~3.40s (right answer, right mechanism)                 |
| `dom --depth abc` (garbage input)               | silently became `NaN`, no error                     | rejected: `error: option '--depth <number>' argument 'abc' is invalid` |

## Takeaway for anyone touching this class of code

* Never pass a bare `parseInt` (or any 2-arg function whose 2nd param isn't
  meant to be "the previous value") as a commander custom option processor.
  Wrap it: `(value) => parseInt(value, 10)`, and validate `Number.isFinite`.
* If a CLI's bridge/IPC layer stringifies primitives, every downstream
  strict-equality/truthiness check against that value needs to account for it
  — grep for `=== true`, `if (result)` style checks after any bridge change.
* A bug that "returns a timeout error" can be hiding a second bug that would
  make it "return false success" once you fix the first — verify the *actual
  elapsed time and actual correctness*, not just "no longer NaN", before
  closing out a timing-related ticket. This is why WI-4991's "add elapsed-time
  regression coverage" ask mattered: a bare unit test on `parsePositiveInt`
  would have missed root cause 2 entirely.
