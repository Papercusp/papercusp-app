# A hand-placed Papercusp Server install can be structurally un-updatable — and silent about it
URL: /internal/docs/agent-insights/hand-placed-server-install-is-structurally-unupdatable-if-it-predates-the-poller

A "Papercusp Server" build old enough to predate the in-app update poller (WI-4404) produces zero update-related log lines, ever — indistinguishable from "checked, up to date". Fixed with an unconditional per-tick heartbeat in the poller AND an external, code-independent staleness check in the launcher (bin/check-hand-placed-server-staleness.sh), since the poller itself cannot self-report if it doesn't exist yet in the running build.

## The symptom

The owner's `~/.local/opt/papercusp-server` install (the windowless "Server"
product that owns the Quick Panel global-shortcut tray icon) sat **13+ days
stale** while `papercusp-gui` on the same machine moved on. Nothing logged an
update check, ever — `grep -h "update poller|update available|update check"`
across every rotated `~/.papercusp/logs/server-app.log*` came back **empty**,
even though other startup lines from the same code path (`role=server`, tray
install) logged fine. The only signal the owner had was that the Quick Panel's
rendered SPA "looked old" (EI-13939).

## What's actually happening

Two distinct silent-failure classes stacked:

1. **The poller can't self-report if it doesn't exist yet.** `spawn_server_update_poller`
   (main.rs) was added by WI-4404. Any Server binary built *before* that landed
   has no poller and no call site — it produces literally nothing update-related
   in its logs. There is no way to distinguish "polled, found nothing" from "no
   poller exists in this build" from the logs of an old build, because the old
   build has no code path that would ever say so. **Only something external to
   the running binary can catch this class** — the binary cannot be trusted to
   self-diagnose its own absence of a diagnostic.

2. **Even a build WITH the poller was silently swallowing its own "couldn't
   check" signal.** `check_for_update` already distinguishes `available: false`
   (genuinely current) from `check_failed: true` (the release host was
   unreachable/unconfigured — WI-3697's `X-Update-Check` header). But the poller's
   tick loop had `Ok(_) => { /* up to date — nothing to do this tick */ }` —
   it never read `check_failed`/`check_reason` at all, so a persistently
   unreachable release host looked exactly like "up to date" in the logs. And
   because the loop only ever printed on the "found an update" branch, a
   perfectly healthy poller that just never finds anything is *also*
   indistinguishable from no poller running — the same "silence reads as
   healthy" bug, one layer in.

3. **This specific install has no update path of any kind otherwise.** It's
   hand-placed (`~/.local/opt/papercusp-server`, autostarted via
   `~/.local/bin/papercusp-server-launch.sh` + a GNOME `.desktop` autostart
   entry — owner-approved 2026-07-05, su-39fa8) — `dpkg -l` shows no package
   owning it, and there is no installer for this layout anywhere in the repo
   (confirmed by grep). Its *only* possible update path was the in-app poller.
   When that poller is absent, the install is **permanently frozen with no
   recovery path** short of a human noticing the UI "looks old".

## The fix

Two layers, matching the two places silence was reachable:

* **In-process (main.rs):** `update_poll_heartbeat_line` + wiring it into the
  poller's tick loop so *every* tick prints something — "up to date (vN)" when
  genuinely current, or a loud "COULD NOT CHECK (reason=...)" when
  `check_failed` — never a silent no-op branch. This fixes any build going
  forward (WI-4404-and-later builds), but by definition **cannot help a build
  old enough to predate the poller entirely** — that's the one case where
  in-process logging changes can never reach the affected build.

* **External (the launcher, outside the running binary's own code):**
  `bin/check-hand-placed-server-staleness.sh <bin-path> [max-age-days]` — a
  dependency-free (no network) age check on the installed binary, run by the
  launcher *before* `exec`'ing it. This is the piece that catches "predates the
  poller" builds, because it runs regardless of what code the target binary
  does or doesn't contain. Warn-only by default (prints a loud block to
  stderr/the launch log); set `PAPERCUSP_SERVER_STALENESS_STRICT=1` for a hard
  refusal. Prefers a `BUILD_INFO.json` marker next to the binary if one exists,
  falls back to the binary's mtime otherwise (a heuristic — see the caveat in
  the script's own header comment).

`~/.local/bin/papercusp-server-launch.sh` (this dev box's actual autostart
entry — NOT tracked in git; it's a machine-local, owner-approved artifact) now
calls this script before `exec`ing the Server binary.

## Why this dev-box install pattern stays hand-placed, not a shipped installer

This item's report asked whether a real installer/updater should ship for this
layout. It should NOT: `~/.local/opt/papercusp-server` + the GNOME autostart
entry is a **dev-box-only** convenience (a persistent tray icon on an agent
dev machine that has no desktop session of its own otherwise) — it predates
and is unrelated to the actual shipped end-user products (`papercusp-gui`
.deb/AppImage, which already have a real package-manager or self-update path).
Building a general installer for a pattern that should never exist on an
end-user machine would be solving the wrong problem. The right fix for THIS
pattern is exactly what's above: make staleness loud instead of silent,
externally, since that's the one thing a hand-placed install can't do for
itself once its own code is too old to say so.

## If you hit this again

* `grep -h "update" ~/.papercusp/logs/server-app.log*` (or the Server's own
  dedicated log, e.g. `~/.local/share/papercusp-server-home/server-launch.log`
  for a hand-placed install) coming back **completely empty** across many
  boots is itself the signal — a healthy poller now always prints a heartbeat
  line every tick. Silence means either the poller predates this fix, or
  something is intercepting stdout/stderr.
* Check the binary's age directly: `bin/check-hand-placed-server-staleness.sh <path-to-binary>` — safe to run standalone, always exits 0 unless
  `PAPERCUSP_SERVER_STALENESS_STRICT=1`.
