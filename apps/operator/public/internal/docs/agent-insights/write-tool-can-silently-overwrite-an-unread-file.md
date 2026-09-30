# The Write tool's "will fail on an unread file" promise did not hold — verify before you trust it
URL: /internal/docs/agent-insights/write-tool-can-silently-overwrite-an-unread-file

>-

## What happened (2026-08-09, \~09:04–09:14Z)

An agent called `Write` on `packages/operator-core/lib/memory/injection-coverage.ts` with 123
lines of new content, believing it was creating a new module. It had never `Read` the file in
that session.

The file already existed — 350 lines, owned by a different in-flight plan
(`context-injection-retrieval-reach-and-visibility-2026-08-03` P-004), exporting
`assessInjectionReach` + `formatInjectionReachToast`, consumed by
`packages/operator-core/lib/dbos/periodic-workflows.ts:56`.

**`Write` succeeded.** It reported *"The file … has been updated successfully."* — not a
refusal.

`apps/operator/bin/bundle-host.sh` (the staging API's `ExecStartPre`) then failed:
`No matching export … for import "assessInjectionReach"`. `:3170` crash-looped 6×; systemd's
own restart-storm limiter gave up (`Start request repeated too quickly`), so even its retries
stopped. Shared staging was down fleet-wide for \~13 minutes before the mismatch was traced back
to the clobber.

## Why this is a tool defect, not only an agent error

The `Write` tool's own description states its contract plainly: creating a new file, or fully
replacing one you've already `Read`, is fine; **"Overwriting an existing file you haven't Read
will fail."** It did not fail. Whatever read-before-overwrite guard the tool is documented to
enforce did not fire for this call.

**The success wording compounds it, and is what delayed detection \~10 minutes.** `Write` reports
*"has been updated successfully"* for an unintended overwrite — worded identically to a routine,
intended overwrite. A genuinely new file instead says *"File created successfully at: `<path>`"*.
That created-vs-updated distinction is the **only** signal a clobber occurred, it is one
easily-skimmed word, and nothing else flags it. Verified in the same incident session: both the
new migration file and a renamed module correctly said "created" — so the tool *can* distinguish
the two cases and chose the wrong outcome + a misleadingly calm message for this one.

## Why it was recoverable this time — and why that is luck, not the guard working

The victim file had been committed by the background git-sync sweep minutes before the clobber,
so `git checkout -- <that one explicit path>` (a single explicit path — never a tree-wide
discard, per `CLAUDE.md`'s destructive-git-op warning) restored it byte-identical to `HEAD`.
Verified via `git diff --stat` (empty) **and** `assessInjectionReach` present at line 170 —
together these rule out "I merely restored an already-clobbered commit."

**A clobber landing inside the sweep window, on work not yet committed, would have been
unrecoverable.** Kopia backs up \~14KB of workspace-state, not code (see `CLAUDE.md`). Do not read
this incident as "the system caught it" — it caught it by timing, not by design.

## The fix shipped here: an independent, ADVISORY reconstruction of "was this Read?"

The native `Write` tool's own read-tracking is internal to the closed CLI — not fixable from
this repo. What a repo-level hook *can* do is independently reconstruct, from the session
transcript, whether the target path was `Read`/`Edit`/`MultiEdit`/`Write`-touched earlier in
**this** session, and warn loudly before the write lands if it can't find one.

`apps/operator/scripts/hooks/cc/pretooluse-write-overwrite-guard.mjs` — `PreToolUse(Write)`:

* **Trigger:** the target path already exists on disk with non-trivial content, AND has no
  prior `Read`/`Edit`/`MultiEdit`/`Write` `tool_use` recorded against that same absolute path
  earlier in the transcript (self-excluded by `tool_use_id`).
* **Contract: advisory only, fail-open, never `deny`.** A hit emits `additionalContext`
  (model-facing) with no `permissionDecision` — the `Write` still proceeds. Any error, missing
  transcript, oversized transcript, or unparseable line exits 0 silently.

**Why advisory and not a hard deny — this is the deliberate trade-off, read it before
"fixing" it to `deny`.** The only read signal this hook can see is a `Read`/`Edit`/`MultiEdit`/
`Write` `tool_use` in the *Claude Code* transcript with a matching `file_path`. A file genuinely
inspected through a different surface — an MCP `capability:read` path, a `Grep` that happened to
show the whole file, a Codex/OMP-native equivalent — reads as "unread" here. A false **negative**
(missing a real prior inspection) only costs an extra dismissible warning. A false **positive**
under a hard `deny` would wedge a legitimate `Write` fleet-wide on this shared tree — the wrong
trade, matching the same reasoning `pretooluse-content-lint.mjs` documents for its own
advisory-only posture.

## The transferable lesson: a tool's stated contract is not self-verifying

The agent that triggered this incident had every reason to trust `Write`'s documented behavior —
the description is explicit, and the tool *usually* enforces it (an intentional overwrite of a
`Read` file works exactly as documented). The failure mode here is narrow but real: a promised
guard silently not firing, with a success message worded identically to the safe case. Two
concrete habits this argues for on a shared monorepo where filename collisions between unrelated
modules are plausible (`injection-coverage.ts` vs. an intended `injection-coverage-counters`
module is exactly this shape):

1. **Before `Write`-ing a path you believe is new, check for collision first** — `ls` the path
   or `git cat-file -e HEAD:<path>` — rather than trusting the tool to refuse on your behalf.
2. **After any `Write` you intended as a create, read the confirmation wording.** "File created
   successfully at: `<path>`" vs. "has been updated successfully" is the only differentiator
   available, and it rewards being read rather than skimmed.

## Registering a new `.mjs` CC hook — the three-sync-point map

Adding a hook script under `apps/operator/scripts/hooks/cc/*.mjs` and wiring it into
`~/.claude/settings.json` touches three places, but only two need a *named* edit:

* **`packages/operator-core/lib/desktop-install/papercusp-files.ts`** — add the filename to
  the `CC_HOOK_FILES` array (governs presence/copy for the desktop installer) **and** add a
  `merge_<name>_hook`-style block wiring its `matcher` + `hooks.PreToolUse` entry.
* **`apps/operator/scripts/install-standalone-mcp.sh`** — the dev/Linux installer's parallel
  `CC_HOOK_*` var + copy step + merge function + invocation, kept in sync by hand with the
  above (there is no single shared source for both).
* **`papercusp-desktop/bin/build-desktop-sidecar.sh`** — **needs no per-file edit.** It ships
  every `.mjs` under `scripts/hooks/cc/` into the packaged sidecar via a `nullglob`-safe loop
  (`for mjs in "$CC_HOOK_SRC_DIR"/*.mjs; do … done`, added for EI-16981) rather than a named
  list. A new hook file is picked up automatically the next time the sidecar is built — verified
  live for this hook (its file was already present under the gitignored
  `src-tauri/sidecar/apps/operator/scripts/hooks/cc/` build output from a prior `npm run dev`,
  confirming the glob mechanism, not a hand-registration, put it there). Don't go looking for a
  name list to edit here; if you find yourself wanting to add one, you're solving a problem this
  file already doesn't have.

The settings.json registration order matters for tests:
`packages/operator-core/lib/desktop-install/claude-hooks.test.ts` asserts the exact
`PreToolUse` command + matcher array in install order — a new hook appended at the end of
`papercusp-files.ts`'s merge chain needs its filename + matcher appended to that test's
`toEqual([...])` array too.

## Incident record

`EI-19966323166806405` (papercusp harness). Recovery command:
`git checkout -- packages/operator-core/lib/memory/injection-coverage.ts`, re-verified via
`git diff --stat` (empty) + `assessInjectionReach` present at line 170. The agent's own
new module was re-created under a disambiguated name,
`packages/operator-core/lib/memory/injection-delivery-coverage.ts`, with cross-references added
to both files so a future reader can't confuse them again.
