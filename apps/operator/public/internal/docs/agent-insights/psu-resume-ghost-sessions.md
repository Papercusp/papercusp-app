# psu --resume \"No conversation found\": ghosts, reservations, and lossless recovery
URL: /internal/docs/agent-insights/psu-resume-ghost-sessions

How psu resume distinguishes transcript ghosts, live rows, explicit reservations, unevaluated requests, and replay-safe acquire/finalize/release transitions across Claude, OMP, and Codex.

## The trap

`psu --resume` → pick a session → `claude --resume <uuid>` fails:

```
No conversation found with session ID: e42bab31-…
```

The owner hit this on every pick and concluded "resume is broken for ALL my
papercusp sessions". It wasn't. The EI-155 isolated-config-dir plumbing was
fine; the picked rows were **ghosts**.

## The mechanism

Two write-times that don't line up:

* The `harness_shared.adv_sessions` row is recorded at **launch** time
  (bootstrap-su, before the agent's first turn).
* Claude/codex only persist a session transcript on the **first message**
  (`<CLAUDE_CONFIG_DIR>/projects/<dir>/<sid>.jsonl`).

A session that crashes at startup, or is closed at the prompt without a
message (pre-spawned dock panes, abandoned launches, instant-death retries),
leaves a row with **nothing on disk to resume — ever**. Audited 2026-06-12:
\~50% of recent claude rows had no transcript anywhere.

Three amplifiers made it read as "everything is broken":

1. `ended_at` was **never stamped** for console sessions (`markAdvSessionEnded`
   only fired for server-spawned terminals), so every dead row showed
   `· active` in the picker forever — and permanently held the session-dir
   GC's open-row protection, wedging collection.
2. The picker sorts newest-first, and the freshest rows are disproportionately
   ghosts — so picking from the top kept hitting them.
3. Rows are visually identical (`claude · no plan · <cwd> · active`).

The brain pane hit the same root cause on 2026-06-06 (the
`claudeStoreHasSession` check at `psu-launcher.mjs` `brainFlow`) — but the fix
was only wired into the brain path, not the picker / direct-id paths.

## The fix (2026-06-12)

* `sessionHasTranscript(session)` in `apps/operator/scripts/psu-launcher.mjs`:
  per-agent store check (claude → isolated config dir keyed by
  `coordOwnerId`, else shared `~/.claude`; codex → per-session `CODEX_HOME`
  rollout; unverifiable rows are KEPT). `resumeFlow` filters the picker with
  it ("psu: hiding N session(s)…") and the direct `psu --resume=<id>` path
  errors with the explanation instead of letting the CLI fail cryptically.
* `POST /api/agent-mcp/console/bootstrap-su/session-ended` (bootstrap-su.ts) +
  `reportSessionEnded` in the launcher: psu is the live parent in both launch
  paths, so child-exit now stamps `ended_at`/`exit_code`. Best-effort: a 404
  from an operator predating the endpoint is swallowed.

## The INVERSE bug and the current lossless handoff (2026-08-26)

Stamping `ended_at` on exit fixed dead rows that looked live, but exposed the
mirror problem: a real resume must make the row live again without letting two
processes become writers. The first repair used `started_at` as a five-minute
single-winner claim. That was safe against duplicates, but it confused
"acquisition started" with "a child is alive": Ctrl+C or a launcher crash before
spawn left every honest retry locked out for five minutes.

The current protocol is a lossless, backend-neutral handoff:

1. **Acknowledge the prior end.** `reportSessionEnded` uses a stable end-attempt
   key. A pre-dispatch 429 or unknown response is retried with that key; if parent
   exit wins first, a bounded pending-end witness survives for the next resume to
   reconcile. The lifecycle REST paths have their own reserved proxy slice, so
   ordinary traffic is shed before one-shot end/resume transitions.
2. **Reserve without asserting liveness.** `acquireAdvSessionResume` writes
   `resume_claim_key` + `resume_claimed_at` while preserving terminal evidence.
   Replaying the same key returns the same verdict. A different key receives a
   typed `reserved` result with `leaseExpiresAt` and `retryAfterMs`; an expired
   reservation is replaced atomically. The writer's
   `RESUME_RESERVATION_LEASE_SEC` is **60 seconds**, replacing the retired
   five-minute `started_at` window.
3. **Spawn, then finalize.** Direct psu and managed-PTY launches call
   `session-resume-finalized` only after child/host liveness is concrete. Every
   pre-spawn/setup failure calls `session-resume-released`, immediately admitting
   recovery instead of waiting for lease expiry.
4. **Replay lost transition responses.** Finalize/release receipts are stored in
   the existing `agent_launch_idempotency` ledger. A timeout after commit can
   replay the same key and recover the committed boolean verdict; it cannot create
   a second claimant or misread a cleared reservation as failure.
5. **Keep activity repair separate.** `reactivateAdvSessionByOwner` remains a
   best-effort visibility repair for genuine activity. It is not launch permission
   and cannot replace acquire → spawn → finalize.

This is shared by Claude, OMP, and Codex. Backend-native transcript/config and
writer-lock checks remain defense in depth; the database handoff is not a second
backend-specific lock.

### Diagnostics are state-specific

* A proven held reservation names its expiry and the launcher waits/retries with
  the same local attempt key inside a bounded budget. A reservation is never
  described as another live process.
* HTTP rejection before evaluation and transport ambiguity say the request was
  **not evaluated**; they do not invent database or process state.
* Only a database-live row or backend-native live/writer evidence justifies a
  live-contender message. Recovery text keeps Codex's concrete writer-lock context
  and supplies Claude/OMP transcript/config context where available.
* An untyped or malformed operator response fails closed and says the reservation
  state could not be determined.

## Diagnosis recipe (if it recurs)

1. Does the transcript exist in the backend's recorded root? Missing means a ghost
   row: nothing was persisted, so there is nothing to resume.
2. Does the resume use the row's recorded cwd and config root
   (`CLAUDE_CONFIG_DIR`, `PI_CODING_AGENT_DIR`/OMP thread root, or
   `CODEX_HOME`)? A transcript in a different root looks missing to the CLI.
3. If psu reports a held reservation, inspect `resume_claim_key`,
   `resume_claimed_at`, and the returned `leaseExpiresAt`. A live 60-second
   reservation is launch-in-progress evidence, not process-liveness evidence; an
   expired one should be atomically replaceable.
4. If psu says the request was not evaluated, diagnose the proxy/transport path.
   Do not inspect `started_at` and infer a winner: acquisition may never have
   reached the datastore.
5. For a crash/setup failure, verify `session-resume-released` cleared the
   reservation while preserving terminal evidence. For a spawned child, verify
   `session-resume-finalized` cleared it and made the row live.
6. After a timeout-after-commit, retry the **same** attempt key and verify the
   idempotency ledger replays the committed end/acquire/finalize/release verdict.

## Consequences to know

* Ghost sessions are **unrecoverable by design** — no transcript was ever
  written. Don't burn time trying to "restore" them.
* With `ended_at` now stamped, a quit session's dir loses the GC's open-row
  protection and is collected after `DEFAULT_RETENTION_MS` (7d) idle
  (`session-dir-gc.ts`) — i.e. the resume window for a quit session is now the
  GC's *designed* 7 days, not the accidental-infinite the wedge provided.
* Pre-fix rows keep `ended_at = NULL` (no backfill — distinguishing
  dead-from-idle retroactively is unsafe); they're harmless now that the
  picker filters by transcript existence.

## Current verification (2026-08-26)

* Real-Postgres integration ran concurrently to prove fixture isolation and the
  shared lifecycle matrix: `recorded-sessions.integration.test.ts` **27/27** and
  `psu-resume-lifecycle.integration.test.ts` **6/6** across Claude, OMP, and
  Codex. It covers same-key acquire/finalize/release replay, end-write 429,
  timeout-after-commit, crash-before-spawn release, reservation expiry, two
  simultaneous resumers, exact session/cwd continuity, and backend root markers.
* The real CLI smoke `apps/operator/scripts/resume-spawn-live.ts` passed on
  Claude Code 2.1.246, OMP 18.0.3, and Codex CLI 0.149.1. Each fresh isolated
  transcript/rollout grew after the production `resumeCommandFor` command.
  One current-staging sample measured whole resumed-turn wall time at **10.251s
  Claude**, **11.929s OMP**, and **4.717s Codex**. These are provider+CLI turn
  latencies, not datastore-acquire latency; the reservation safety budget remains
  the writer's explicit **60-second** lease.

## The fork identity model (`psu --resume --fork`)

A fork is the opposite of the two skews above: not a row-vs-reality mismatch but
a deliberate **branch** — a resumed session split into a *new* tracked session
that runs alongside the original. Its whole correctness rests on one invariant:
**the fork gets a genuinely fresh identity, so it can never collide with the
still-live original.**

For a tracked Claude session, `launchTrackedFork` (`psu-launcher.mjs`) re-uses the
*fresh-launch* server path (`bootstrap-su`), so freshness is guaranteed by
construction, not by fork-specific code. Three distinct identities are minted:

* **A fresh coord identity** — a new `PAPERCUSP_SID`. This is the join key for
  file locks, `coord_presence`, inbox-wake, the pty-host control socket, and the
  supervisor beat, so the fork shares **none** of them with the original.
* **A fresh `adv_sessions` row** — its own `PAPERCUSP_ADV_SESSION_ID`, so the
  fork appears in `psu --resume` and its exit stamps *its own* row's `ended_at`,
  never the original's.
* **A fresh native session id** (`forkId`) — server-minted, then *forced* onto
  Claude with `--session-id` so it is known up-front and resumable.

The **history** is branched, not shared: the original's transcript is copied into
the fork's fresh isolated `CLAUDE_CONFIG_DIR` (`forkSeedPaths` + `cpSync`), then
`claude --resume <origId> --fork-session --session-id <forkId>` replays it and
writes new turns to `<forkId>.jsonl` in the fork's *own* dir. **The original's
transcript is never touched.** (Verified: the installed Claude CLI accepts the
`--resume … --fork-session --session-id …` trio; the plain `--session-id` +
`--resume` conflict is lifted by `--fork-session`.)

The identity-split guard lives in `nativeSessionIdFromLaunchArgs`: a fork's argv
names **two** sessions, and this returns the **fork's** id (the forced
`--session-id`), never the branch-point's `--resume` id — so `recordSessionOwner`
binds the fork's native id to the fork's SID, not the original's (binding the
original's would poison the owner index).

`forkBootstrapBody` carries the original's **workspace + plan + cwd** but sends
**`harness_slug: null`** (deliberate — so the server doesn't relocate the cwd the
seeded transcript is keyed by). Two consequences worth knowing, both by design,
neither a bug: a fork inherits plan *context* but **not** the original's plan
*claims* (its fresh identity holds no lane — re-claim to parallelize), and it
drops *harness* scope (a non-issue for SU, where the harness is a per-call arg).

Graceful degradation off the primary path: an **untracked** / pre-native-id
Claude session forks in place (Claude mints a random id) but *still* takes a
fresh `PAPERCUSP_SID` via `resumeEnvFor(fork:true)` with **no** adv-row link;
**Codex** uses native `codex fork` (untracked — it can't force a fork id);
**OMP** is refused early (no branch primitive). A fork whose first turn never
lands is a normal **ghost** (above), filtered by `sessionHasTranscript`.

The persisted half of this model — fresh coord owner id + native id, plan/cwd
carried, `harness_slug` null, N forks → N distinct identities, and the original
row left untouched when the fork ends — is pinned against real PG by
`apps/operator/lib/psu-launcher-fork.integration.test.ts` (the `/adv` Tests tab's
**coordination-suite → C5 fork identity** row); the pure launcher fns by the
fork cases in `apps/operator/lib/psu-launcher.test.ts`.
