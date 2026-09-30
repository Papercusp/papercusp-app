# A remote zsh host silently no-ops your whole ssh command on an unmatched glob
URL: /internal/docs/agent-insights/ssh-zsh-nomatch-silently-noops-remote-command

zsh's default nomatch behavior aborts an entire compound command (e.g. `rm -rf a b*`) when any glob has no matches, instead of passing the pattern through literally like bash does — so a command composed in bash-shaped muscle memory and run over `ssh` to a zsh login shell (macOS default since Catalina, incl. the mac-vm release host) can silently never execute, even for its perfectly valid non-glob arguments, while printing output that looks like an ignorable warning about the optional part.

## What

Running a command over `ssh <host>` where the remote login shell is **zsh** (macOS's default since Catalina — this bites the mac-vm release/acceptance host specifically), any glob in that command with **zero matches** aborts the **entire** compound command under zsh's default `nomatch` option. Bash (with `nullglob` off, the default) instead passes an unmatched glob through literally as a plain argument and keeps going.

Measured live (EI-19426095972367453, 2026-08-03) cleaning `mac-vm` before a WI-3307 acceptance run:

```bash
ssh mac-vm 'rm -rf ~/.papercusp-workspaces/.shared/dev-source ~/.papercusp-workspaces/.shared/dev-source.stale-*'
```

The `dev-source.stale-*` glob had no matches. Output:

```
zsh:11: no matches found: /Users/<user>/.papercusp-workspaces/.shared/dev-source.stale-*
```

`rm -rf` **never ran at all** — not even for the first, perfectly valid, non-glob `dev-source` path. The 5.3G tree was still there afterward.

This class recurred independently at least twice more after the original filing (EI-20340145497995105, EI-20347492509512574) — different agents, different remote commands, same zsh-nomatch trap, each rediscovering it as a fresh "workaround" because it wasn't written down anywhere agents would find it.

## Why it's dangerous, not just surprising

1. **`set -e` / `set +e` do not help.** This is not a non-zero exit from the command you ran — the command is never invoked at all. Neither error-handling mode changes anything.
2. **The failure is attributed to the wrong thing.** The only visible complaint names the *glob*, so it reads as "the optional cleanup pattern matched nothing" — an expected, ignorable condition. Nothing says "and therefore the rest of your command didn't run either."
3. **It fails silently in the direction that matters.** Without an explicit postcondition check, you proceed believing a deletion (or whatever the command did) succeeded. In the original case this was capable of manufacturing a false-pass acceptance gate: a stale hand-patched tree would have kept shadowing the artifact actually under test.
4. **It's asymmetric with the dev box.** Agents write bash reflexively and test on this Linux host, where the identical command works fine. The trap only fires on the remote zsh host — exactly where it's least likely to be noticed, and exactly where mac dogfood/acceptance work routes agents routinely.

Generalizes beyond `rm`: **any** command with a possibly-unmatched glob (`ls a*`, `cp a* dst/`, `for f in a*`, etc.) run over ssh to a zsh host aborts the whole compound command instead of degrading gracefully.

## Fix

Any ONE of these is sufficient when composing a remote command that might contain a glob:

```bash
# a) avoid the remote glob entirely — resolve the variadic part with find
ssh host "rm -rf '\$D/dev-source'; find '\$D' -maxdepth 1 -name 'dev-source.stale-*' -type d -exec rm -rf {} +"

# b) force bash on the remote side, matching the shell the command was written for
ssh host 'bash -lc "rm -rf a b*"'

# c) disable the abort inside zsh explicitly
ssh host 'setopt NULL_GLOB; rm -rf a b*'
```

Prefer **(b)** as the default idiom for any agent-composed remote one-liner/heredoc when the remote host's login shell is unknown or known-zsh (mac-vm, any macOS host) — it makes the remote shell match the shell the command was actually written for.

**Regardless of which form you use: always assert the postcondition** (`[ -e "$path" ] && echo STILL PRESENT`, or the positive-existence check for whatever the command was supposed to produce/remove). That check is what caught this in the original incident — nothing else did.

> Note on the quoted output above: the remote account name is redacted to `<user>` deliberately. A literal home path naming one developer's machine is a `lint:no-box-identity` violation, and this doc red-pinned the fleet green-checkpoint on exactly that line (WI-39362, 2026-08-16). When you paste real terminal output into a doc, redact the account name — the transcript's meaning never depends on it.

See also: [copying-artifacts-off-the-mac-vm](/internal/docs/agent-insights/copying-artifacts-off-the-mac-vm) for the sibling exit-code-lies-too trap on the same host.
