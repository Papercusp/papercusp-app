# WI-3792: the host-meltdown fix couldn't deploy itself (circular git-sync deadlock)
URL: /internal/docs/agent-insights/wi-3792-host-meltdown-circular-deploy-deadlock

A single-process ONNX thread-spin bug on :3070 stalled the exact pipeline (git-sync + green-checkpoint) that would have deployed its own fix — the recovery recipe and how to recognize the pattern.

## The pattern to recognize

When git-sync / green-checkpoint go STALLED on `papercusp` at the same time as a
host-load meltdown, don't treat them as two separate incidents. `bin/hono-host.ts`
(the process behind `papercup-dev-api.service`, `:3070`) is explicitly **the one
process** that owns git-sync + DBOS + substrate ("MUST be exactly one process").
If *that* process is thrashing (CPU-spinning threads, swapping, event-loop
starved), its own scheduled routines — including the routine that would commit
and eventually deploy a fix for the thrashing — stall too. **The fix is on
`staging` and cannot reach `:3070` because the pipeline that deploys it is stuck
on the very process the fix targets.** This is a deadlock, not a queue backup —
waiting it out does not resolve it.

## Root cause seen 2026-07-10 (WI-3792)

ONNX Runtime defaults `intraOpNumThreads` to **every core** + spin-waits them.
Every operator process that touches the local embedder (Gemma/BGE default)
accumulates a huge thread pool over its uptime. Symptoms: `papercup-dev-api.service`
grew to **2406 tasks / 58G memory / 8.8G swap**, host loadavg **889–3000+**, and
`operator/MCP writes died with `CONNECTION\_CLOSED 127.0.0.1:6432\`\` even though
PgBouncer's own pool (`SHOW POOLS`) looked fine moments later — the bottleneck was
the Node process failing to service its Postgres client fast enough, not PgBouncer
itself. Fix: bound the thread pool —
`libs/generic/memory/src/local-embedder-worker.ts`:

```ts
export const ORT_SESSION_OPTIONS = { intraOpNumThreads: 4, interOpNumThreads: 1 } as const;
```

## Diagnosis recipe (don't skip steps — PgBouncer looking "wedged" is a red herring)

1. `PGPASSWORD=<from /etc/pgbouncer/userlist.txt via sudo> psql postgresql://harness_admin@127.0.0.1:6432/pgbouncer -c "SHOW POOLS;"` —
   if `cl_waiting` is transient/already back to 0, PgBouncer's pool itself is not
   the wedge; look at the app process next.
2. `systemctl --user status papercup-dev-api.service` — check `Tasks:` / `Memory:` /
   `swap:`. Thousands of tasks + double-digit GB + swap use is the signature.
3. `cat /proc/loadavg` — a 1-min average in the hundreds/thousands with `nproc`
   cores available confirms host-wide CPU starvation, not just this service.
4. Confirm the fix is on `staging` but **not yet on `papercup-release`**:
   `git log -1` in both checkouts (superproject **and** the relevant submodule —
   `git submodule status -- <path>`) and diff the shas/dates. `papercup-release`
   only advances when green-checkpoint FFs `main`, which is exactly what's stuck.

## Recovery: the D-009 escape hatch, then restart

Don't wait for green-checkpoint to unstick itself — it can't, by construction.

1. Dry-run the plan: `npx tsx apps/operator/lib/release/deploy-cli.ts --deploy-commit <staging-superproject-sha>`
   (no `--execute`). Check `migrations: []` and `risk.tier` before proceeding — a
   `blocked` tier or pending migrations changes the calculus.
2. Force it: `PAPERCUSP_ALLOW_DEV_RESTART=1 npx tsx apps/operator/lib/release/deploy-cli.ts --deploy-commit <sha> --execute`.
   This is the sanctioned "loud + audited" un-green path (D-009) for exactly this
   situation — it checks out the target sha into `papercup-release` and restarts
   `papercup-dev-api.service`.
3. **The CLI process itself can hang/timeout under the still-heavy load even after
   the restart has already succeeded** — don't trust the CLI's own exit code alone;
   re-verify directly: `systemctl --user status papercup-dev-api.service` (new
   `Active: ... since <restart time>`, no post-boot Napi/error lines in
   `journalctl --user -u papercup-dev-api.service --since <restart time>`).
4. Expect a **transient `.git/index.lock` collision** on the first git-sync tick
   right after the restart (a queued tick racing the restart) — check
   `harness_shared.pipeline_events` (`kind='git_sync'`) for it; it self-clears on
   the next tick. Confirm actual recovery by watching for a **new commit** landing
   (`git log -1`), not just `routines.last_fired_at` advancing — a fired-but-not-yet-
   committed tick looks identical to a stuck one from the routines table alone.
5. Loadavg recovery is gradual (hundreds → tens over several minutes), not
   instant — don't re-declare the incident open because the 1-min average ticks
   back up transiently while the 5/15-min averages are still decaying.

## Why this matters beyond this one incident

Any bug that lives in the single-process git-sync/DBOS host and degrades that
process badly enough will reproduce this same circular deadlock. The general
lesson: if git-sync/green-checkpoint stall *during* a host-load incident, check
whether the fix for the load incident itself is sitting un-deployed on staging
before assuming the stall needs its own separate diagnosis.
