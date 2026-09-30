# tauri-agent-tools: real flags per subcommand (--help is blocked by the target guard)
URL: /internal/docs/agent-insights/tauri-agent-tools-real-flags-help-blocked-by-target-guard

tauri-agent-tools' multi-bridge target guard also blocks --help, so a guessed flag can burn a full ~5min verify-tauri-headless.sh cycle. This is the accurate flag reference so agents never have to guess or read dist/ source.

## The gotcha

`tauri-agent-tools <subcommand> --help` fails when 2+ bridges are live on the box:

```
$ tauri-agent-tools screenshot --help
tauri-agent-tools target guard: 3 bridges are live, so `screenshot` cannot tell which app you mean.
...
Re-run naming your target:  tauri-agent-tools screenshot --pid <PID> ...
```

The target guard itself is correct and load-bearing — without `--pid` the CLI attaches to an arbitrary bridge in readdir order, frequently the **owner's live desktop**. That must not change. The bug is narrower: the guard also fires for `--help`, which neither attaches to a bridge nor acts on a window, so there is nothing to disambiguate. The only remaining way to learn a subcommand's real flags is to grep the installed `dist/commands/*.js` — and a guessed flag is not rejected up front; it fails **inside** a `scripts/verify-tauri-headless.sh` run, which first boots Xvfb + a Tauri dev bridge (\~4–6 min under contention). One wrong flag name burns a full verifier cycle.

`tauri-agent-tools` is a genuinely external, third-party package (github.com/cesarandreslopez/tauri-agent-tools) installed via npm/brew — there is no vendored copy in this repo to patch, so the guard behavior itself cannot be fixed from here. This doc is the practical mitigation: the real flags, so nobody needs `--help` (or a source read) to use these subcommands correctly. `probe` is confirmed never blocked by the guard (its own refusal message advertises this).

## Real flags, by subcommand (verified against the installed dist/commands/\*.js, 2026-09-02)

**`screenshot`** — `-s/--selector <css>` · `-t/--title <regex>` · **`-o/--output <path>`** (not `--out`) · `--format <png|jpg>` · `--max-width <n>` · `--json`

**`check`** (CI-style assert, exits 0/1) — `--selector <css>` · **`--eval <js>`** (not `--expr`) · `--text <pattern>` · `--no-errors` · `--duration <ms>` · `--json`

**`eval`** — positional `[expression]` (JS to evaluate) · `--file <path>` (read JS from a file instead)

**`dom`** — positional `[selector]` (default `body`) · `-s/--selector <css>` (alt form) · `--mode <mode>` · `--depth <n>` (default 3) · `--tree` · `--styles` · `--text <pattern>` · `--count` · `--first` · `--json`

**`capture`** (screenshot + DOM + console + logs) — `-s/--selector <css>` · `-t/--title <regex>` · `--dom-depth <n>` (default 3) · `--eval <js>` · `--logs-duration <ms>` · `--json`

**`probe`** — `--json` (this subcommand is NOT blocked by the target guard)

**`click`** (`interact click <selector>`) — positional `<selector>` (required) · `--double` · `--right` · `--wait <ms>`

**`type`** (`interact type <selector> <text>`) — positional `<selector>` `<text>` (both required) · `--clear`

Every subcommand also takes `--pid <PID>` for target disambiguation when 2+ bridges are live — per `tauri-agent-tools-screenshot-resolves-window-by-pid`, ALWAYS pass `--pid "$VERIFY_TAURI_PID"` explicitly rather than relying on auto-discovery, even with only one bridge apparently live.

## Why this is documented here instead of fixed at the source

There are (at least) two separate installs of this package on a typical dev box at different versions — a brew global install and a node25/npm global install — neither of which is a git-tracked checkout inside `papercusp`. A local patch to either `dist/` copy would be silently lost on the next `npm install -g` / brew upgrade, so it is not a durable fix. The durable, in-repo fix available to us is this reference doc: it eliminates the actual cost described in the original report (a guessed flag burning a \~5min verifier cycle) without needing to touch vendor code. If someone wants the upstream `--help` guard fixed properly, the concrete, cheap patch (verified from the installed CLI's own behavior) is: let `--help`/`-h` bypass the target-guard check before it evaluates bridge count — file that upstream at github.com/cesarandreslopez/tauri-agent-tools if/when this team decides to maintain a relationship with that repo.

## Related docs

* `agent-insights/tauri-agent-tools-screenshot-resolves-window-by-pid` — always pin `--pid`
* `agent-insights/tauri-agent-tools-timeout-nan-and-eval-truthiness` — other CLI gotchas in the same tool
