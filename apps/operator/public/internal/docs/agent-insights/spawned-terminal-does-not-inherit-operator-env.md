# A desktop-spawned terminal does not inherit the operator env
URL: /internal/docs/agent-insights/spawned-terminal-does-not-inherit-operator-env

Why an agent launch dies instantly with `command not found` while every probe you can run says the binary is on PATH — the two mechanisms that strip the env, the false-negative trap that hides them, and the one-list-three-consumers fix.

## The symptom

`capability:launch-agent` reports **Launched**. The terminal window opens, prints
`omp: command not found`, and is gone before anyone sees it. Every check you then run
from your agent session says the binary is fine:

```
capability:bash  which omp    ->  $HOME/.bun/bin/omp
```

The binary IS fine. The window never had a PATH that could see it.

## Two independent mechanisms strip the env, and either one alone is enough

**1. The emulator is a client/server binary.** `gnome-terminal`, `konsole` and friends
do not fork your window. Your spawn is a *client* that hands the request to an
already-running server over D-Bus and exits. The window is forked from **that server**,
which inherited the desktop session's environment at login — hours ago, from a different
process tree. The `env:` you carefully passed to `spawn()` was delivered to a client that
immediately died. Nothing errors; the window simply comes up wearing someone else's
environment.

**2. `bash -lc` is a LOGIN but NON-INTERACTIVE shell.** Even on the paths where the env
does survive, the console one-liner runs non-interactively, and the standard early-return
guard at the top of `~/.bashrc`

```sh
case $- in *i*) ;; *) return;; esac
```

returns before every `PATH=` line below it. So a toolchain installed by bun, nvm, fnm,
volta or cargo — all of which do their PATH work in `.bashrc` — exists when the user types
it into a terminal and does not exist for the command we spawn. "It works when I run it"
and "it works when we spawn it" are different claims about different shells.

## The trap: every convenient probe returns a FALSE GREEN

This is the part that costs the hours, and it is structural rather than careless.

The operator process was started from a login shell with the full desktop environment. So
`process.env.PATH`, a `child_process` call, and `capability:bash` **all inherit the env that
does not have the defect**. A probe run there reports green while the window dies. It is not
a flaky check; it is a check of the wrong subject — you asked the healthy process whether
the sick one is healthy.

> A probe that reads `process.env.PATH` is *structurally incapable* of detecting a
> spawned-env bug. Reproduce in the TARGET env, or search only the dirs you inject.

That is why `preflightBackendLaunch(agent, env)` deliberately ignores `process.env.PATH`
and searches only the layers we inject (`spawnPathLayers`). A pass therefore means
*"resolvable no matter what PATH the window inherits"* rather than *"resolvable from here"*.

To read the target env for real, make the spawned command tell you:

```sh
# the only reading of the window's PATH that is not the operator's
printenv PATH > /tmp/spawned-path.txt
```

Everything else — `buildPathExport()`, `buildConsoleOneliner()` — is a pure function, so
unit-test the string you are about to hand the shell instead of testing your own shell.

## The fix, and the three decisions worth keeping

**One list, three consumers.** `backendSearchDirs({ home, env, platform })` in
`packages/operator-core/lib/backend-bin-resolve.mjs` is the single per-platform well-known-dir
list. Three call sites consume it: the launcher's detection (`wellKnownBackendBin`), the
spawn PATH injection (`resolveSpawnPathDirs`), and the installer's shim linking
(`ensureAgentClisLinked`). Before this, each had hand-rolled its own list — which is exactly
how `~/.bun/bin` came to be present in one and missing from another, so a bun-installed CLI
was detectable and unlaunchable at the same time. Adding a directory to a list that has
copies fixes one symptom and leaves the class armed.

**Append, never prepend.** The resolved dirs travel as `PAPERCUSP_BACKEND_PATH_DIRS` and
`buildPathExport()` places them *after* `${PATH}`:

```
export PATH=<papercusp bin>:<papercusp scripts>:${PATH}:<resolved backend dirs>
```

Injecting a directory is a repair for a *missing* binary, not an opinion about which binary
should win. Prepending would shadow the user's own toolchain for every command they
subsequently type in that window — a much worse bug than the one being fixed, and a silent
one. (The same reasoning is why `~/.papercusp/bin`, which *is* prepended, must never carry a
shim for a general-purpose tool like `bun`.)

**Detection is not execution.** Resolving the binary proves nothing about whether the window
can run it. A bun-installed `omp` is a script whose `#!` interpreter is `~/.bun/bin/bun`; if
that directory is unreachable the window dies inside `env`, not at the command, and the error
names the interpreter rather than the thing you launched. `readShebangInterpreter()` resolves
the interpreter too, and `interpreter-unreachable` is its own preflight verdict — distinct
from `not-installed` (nothing anywhere; tells the user to run `papercusp setup`) and from
`resolved-but-not-injected` (the operator can see it, so this is *our* injection bug and the
diagnosis says so plainly rather than blaming the user's install).

## Why it survived so long: "Launched" was never evidence

`spawn()` returning success means the *emulator* started. It says nothing about whether an
agent did. This class has now been filed four times (EI-11543, WI-4752,
EI-18696184925888288, WI-37920) because the tool cheerfully reported success on every one of
them.

The obvious fix — poll \~20s and return `agentStarted: true|false` — is also wrong, and
measuring the population first is what showed it: first non-statusline tool call is **p50 31.0s,
p90 417s**, with only **27 of 118** sessions crossing inside 20 seconds. A 20-second boolean
reports FAILED for the majority of *healthy* launches, which converts a silent-failure bug
into a false-alarm generator. Nor is an `adv_sessions` row evidence: a confirmed-dead launch
had a row, an owner id and a session id, and did nothing for an hour.

The discriminator that does work is **statusline silence**. `activity:report` and
`coord:glance` are statusline machinery that a dead launch emits too (the dead one fired both
within 3.7s). Exclude just those two names and the populations separate cleanly on whether the
beat *continues*: duds average 1.7 calls with the last at a median of 4.9s; live sessions
average 730 and are still beating hours later. Hence the three-state verdict —
`true` / `false` / `null` ("not yet determinable") — in `verifyFreshLaunchStarted()`. Do not let
a later edit collapse it back to a boolean; `agent-launch-verification.test.ts` pins the null
state on purpose.

## Checklist for the next spawn-env change

* Add the directory to `backendSearchDirs()` — never to a caller's local list.
* Decide append vs prepend by asking *"whose binary should win if both exist?"* The answer is
  almost always the user's.
* Resolve the `#!` interpreter, not just the binary.
* Verify by inspecting the generated one-liner, or by making the spawned command print its own
  env. Never by probing from the operator.
