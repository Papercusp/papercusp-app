# The :3270 dev rig can be stale — compare the Hono operator PID, not the desktop PID
URL: /internal/docs/agent-insights/tauri-dev-3270-operator-staleness-check

The Tauri dev shell loads a working-tree Hono operator, but that process has no source watch. Use the webview's selected port, compare that listener PID's start time with the changed server file mtime, and recycle the operator via dev:restart target desktop-dev. Desktop PID age and git promotion status both give false answers.

## The failure mode

The default Tauri development launch (`cd papercusp-desktop && npm run dev`) serves the webview from this checkout's working-tree Hono operator. Its default content origin is `:3270`; when `:3270` is reserved by `papercup-bg-host`, `desktop-dev-nohmr` and `dev-operator-ifneeded.sh` use the same resolver and move the shell and operator together to another port.

Two facts that look contradictory are both true:

* The operator starts `npx tsx bin/hono-host.ts` from `apps/operator`, so it imports the **working tree**, including uncommitted edits. Git commit, promotion, and deploy status do not determine what a fresh dev operator would load.
* The Hono host has **no source file-watch**. A server-side edit made after that operator started is absent from the running process until the operator is recycled.

That combination makes a stale dev rig dangerously convincing: the URL is local, the code is in the working tree, and the process still answers normally — but it may answer with an older imported module graph.

## First identify the actual dev port

`papercusp-desktop/src-tauri/tauri.conf.json` declares `devUrl: http://127.0.0.1:3270`. Its `frontendDist: http://127.0.0.1:3070` is the production-build path and is not what `tauri dev` loads.

Do not hard-code `:3270` when the launcher reports a relocation. Read the current webview URL (for example, from `tauri-agent-tools probe --pid <desktop-pid>`) and use that selected port below.

## The authoritative freshness check

Compare the **listener process on the selected dev port** with the relevant changed server file:

```bash
dev_port=3270  # replace with the webview's selected port when it was relocated
operator_pid="$(
  ss -ltnp "sport = :$dev_port" 2>/dev/null \
    | sed -n 's/.*pid=\([0-9]\+\).*/\1/p' \
    | head -n 1
)"

test -n "$operator_pid" || {
  echo "no Hono operator listener found on :$dev_port" >&2
  exit 1
}

ps -o pid=,lstart=,cmd= -p "$operator_pid"
stat -c '%y %n' path/to/the/changed-server-file.ts
```

If the file mtime is later than the Hono operator's start time, that live operator is stale for the edit. Compare every relevant changed server module when the behavior crosses several files; avoid sweeping unrelated high-churn paths, which creates false alarms.

### Why the desktop PID is the wrong PID

The Tauri shell and the Hono operator have independent lifetimes:

* On launch, `dev-operator-ifneeded.sh` reuses an already-bound selected port and exits. A **fresh desktop shell can therefore reuse an older operator**. Comparing the desktop start time gives a false clear.
* The wrapper supervises and restarts a failed Hono child without requiring the Tauri shell to restart. An **older desktop shell can therefore have a fresh operator**. Comparing the desktop start time gives a false alarm.

The listener PID is the process that imported the server module graph. It is the only relevant clock for this check.

## Recover a stale operator

On the default `:3270` path, use the coordinated restart primitive:

```text
dev:restart {
  target: "desktop-dev",
  confirm: true,
  authorize: true,
  reason: "reload the working-tree dev operator after server-source edits"
}
```

The tool verifies the wrapper-owned listener and requests its supported `SIGUSR2` recycle; the wrapper then brings up a fresh child. If the launch was relocated to another selected port, restart the **owning `npm run dev` session** so its wrapper replaces the correct listener, then repeat the PID/mtime check. Do not kill a PID copied from an old note or pidfile.

Waiting for git-sync, promotion, or deploy does not fix this state. `dev:pipeline_position` answers whether code has moved through the git/release pipeline — useful for `:3070`, but the wrong instrument for the working-tree dev operator.

## Frontend-only changes are a different freshness plane

The operator-process check applies to server modules loaded by `hono-host.ts`. The default desktop launch is **no-HMR**: a Vite build watcher updates the static SPA bundle, and the webview needs a manual reload. The explicit `npm run dev:hmr` path on `:3055` uses HMR.

Therefore a frontend-only edit does not require a Hono recycle, but it can still be hidden by a stale build watcher or an unreloaded webview. Diagnose that with \[\[ui-edit-not-showing-stale-vite-watcher]]. For checkout/port selection and owner-visible window verification, see \[\[verifying-desktop-fixes-on-the-right-instance]]. For the analogous release/staging host distinction, see \[\[operator-3070-host-no-hot-reload]].

## Evidence boundary

This runbook establishes the correct instrument and the two process-lifetime failure directions. It does not claim a measured incident frequency. The recurrence evidence for promoting the rule is two independent re-derivations recorded on `EI-20215111901643732`; the source ruling is `hud-session-chat-release-audit-2026-08-11#D-005`.
