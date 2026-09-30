# PUI — the Papercusp terminal app

PUI is a terminal client for Papercusp: ask an agent to do work, watch it
stream, approve or interrupt it, and pick up where you left off.

## Install

```sh
tar -xzf pui-<version>-<target>.tar.gz
cd pui-<version>-<target>
./install.sh
```

`install.sh` checks every file against `CONTENTS.sha256`, confirms `pui` starts
on this machine, then runs `bin/pui self install`, which previews what it will
change and asks before changing it. Nothing else is needed: no Rust toolchain,
no Node or npm, no python, no source checkout.

It installs into `~/.local/share/pui` and links `~/.local/bin/pui` and
`~/.local/bin/psu`. If you already have a `psu` there that PUI did not install,
PUI leaves it alone; its own sessions still use the `psu` in this release. Set
`PUI_HOME` or `PUI_BIN_DIR` to choose other (absolute) locations. If
`~/.local/bin` is not on your `PATH`, add it.

Before unpacking, you can check the archive against the `SHA256SUMS` published
beside it (`sha256sum -c SHA256SUMS --ignore-missing`, or
`shasum -a 256 -c SHA256SUMS --ignore-missing` on macOS). If a `.minisig`
signature is published, verify it with `minisign -V -m <archive>` and the
publisher's public key.

## What PUI needs

PUI is a client. It needs a Papercusp server to run agents, but it does not
need the desktop app. For a local setup, get the separate **Papercusp Server**
installer from the Papercusp release download page supplied with this PUI
archive: the Server `.deb` on Linux, `.dmg` on macOS, or setup `.zip` on
Windows. Install and start Server, then run `pui`; the desktop GUI is optional.
The current Server installers are listed separately from the GUI on that page.
You can also connect to a remote operator or a Papercusp cloud workspace.
See `COMPATIBILITY.md`. `pui doctor` checks the installation and the selected
operator.

**First launch.** With no operator on this computer, `pui` opens setup:

- `l` signs in to Papercusp cloud in your browser, then opens PUI on one of
  your cloud workspaces.
- `h` connects to a remote host you have saved (a cloud sign-in or an SSH
  host).
- `e` enters the address of a Papercusp Server you run yourself, locally or
  elsewhere.

Cancelling a sign-in (`Ctrl-C`) or a failed one brings you back to setup.

The same connections work from the command line: `pui --connect` (a picker),
`pui --connect=<name>`, `pui --connect-list`, and `pui --connect-login` to
sign in. They use the `psu` shipped in this release, which runs on its own
bundled Node.

## Using PUI

Press `F1` for a short tutorial and `?` for every key. The everyday ones:

| Key | What it does |
| --- | --- |
| `o` | open the chat and put the cursor in the message box |
| `Enter` | send the message (`Esc` leaves the box without sending) |
| `j` / `k`, `↑` / `↓` | move the selection, or scroll the chat |
| `Ctrl+X` | stop the agent's current turn |
| `l` | your conversations: pick one to reopen it |
| `m` / `e` / `a` / `u` | model · effort · account · mode for a new session |
| `Ctrl+T` | the conversation's task list (`Esc` returns to the chat) |
| `:` | command palette |
| `q` | quit |

Messages you send while the agent is working wait their turn and go out when
it finishes; `Ctrl+X` stops the turn and drops the waiting messages. If a
session has stopped, your next message reopens the same conversation.

**Questions and approvals.** When the agent asks something or needs permission
to use a tool, a card opens over the chat. Choose with `↑`/`↓` (or type the
option's number), confirm with `Enter`, or press `Esc` to decline.

**Task list.** Both you and the agent edit the same list. With it open: `a` add,
`e` edit, `x` mark done, `s` start, `b` blocked (with a reason), `u` unblock,
`r` reopen, `d` drop, `K`/`J` move up or down, `P` turn the task into a
tracked work item linked to it, `g` refresh.

**Colour.** PUI follows [`NO_COLOR`](https://no-color.org): set it to any value
and PUI draws without colour, marking the selection and the focused pane with
reverse video and a heavier border instead.

## Getting help

- `pui doctor` checks this installation and the connection to your operator.
- `pui self diagnostics` prints a support report; the palette's `:diagnostics`
  saves the same report to `~/.papercusp/pui-diagnostics-<time>.txt`. The
  report leaves out conversation content, prompts, tokens and credentials, but
  read it before you share it.
- `:about` in the palette shows the version, the installed release and the
  release a rollback would return to.

## Update, roll back, uninstall

```sh
pui self status
pui self update --from pui-<newer-version>-<target>.tar.gz
pui self rollback            # return to the release before the last update
pui self uninstall           # keeps your settings; add --purge to remove them
```

The same actions are in PUI's command palette. Updates and rollbacks keep your
settings in `~/.papercusp`; the last two releases stay installed so a rollback
needs no download.

## Files in this release

| File | Purpose |
| --- | --- |
| `bin/pui` | the PUI binary |
| `bin/pui-audio` | optional audio device helper; on Linux, voice requires the system ALSA library (`libasound2`) |
| `bin/psu` | the Papercusp launcher PUI uses for sessions, sign-in and remote hosts |
| `lib/psu/` | psu's program files |
| `lib/node/` | the private Node runtime psu runs on (not added to your `PATH`) |
| `bin/zellij` | the terminal multiplexer PUI's workbench uses (version-matched) |
| `pui-companion.wasm` | PUI's zellij plugin, built with the binary |
| `pui-install.json` | the binary/companion generation manifest |
| `CONTENTS.sha256` | digest of every file in this release |
| `PROVENANCE.json` | source commit, toolchain, measured runtime requirements |
| `COMPATIBILITY.md` | supported platforms and what each has been verified on |
| `LICENSE` | Apache-2.0 terms for PUI and its first-party companion components |
| `THIRD_PARTY_LICENSES.md` | licenses of everything built into or shipped with PUI |
| `RELEASE_NOTES.md` | what changed |
