# scripts/hooks/omp

OMP hook modules served to **workspace-power-user** OMP sessions in the
`hooks[]` array of `GET /api/agent-bundle` (see
`apps/operator/docs/plans/omp-power-user-bundle-2026-05-20.md` §4.3.1).

## Contract

Every `*.ts` / `*.js` / `*.mjs` file in this directory (this `README.md`
excluded) is read at request time by the agent-bundle route and shipped
inline. The `@papercusp/omp` plugin writes each into the session-scratch
dir and registers it with OMP via `--hook=<path>` — no global install.

This is the **single source of truth** for the OMP coordination hook.
The same file backs two delivery paths (D-008a):

- **Power-user path** — served inline by `/api/agent-bundle` (which
  `readDirFiles`-reads this dir), written to session-scratch, passed
  via `--hook`.
- **Engineer path** — `install-standalone-mcp.sh` copies `coord-hook.ts`
  to `~/.papercusp/papercusp-coord.ts`; the `omp-su` wrapper loads it
  via `-e`.

One source, two deliveries. Do not fork the hook between paths.

## Status — LIVE

`coord-hook.ts` is implemented and served on both paths: one module
exporting `tool_call` (L2 file-lock enforcement — acquire-on-edit,
block-on-busy, release-on-result, symlink refusal, fail-open health
markers), `session_start` (L1 presence), and `turn_start` (L3 context
injection). The "empty by design / `hooks: []`" note here was stale and
has been removed.

## Other clients

OMP is **not** the only enforcing client. Claude Code and Codex run a
parallel `tool_call`-equivalent (`PreToolUse`/`PostToolUse`) hook pair
at `../cc/` — same SU-locks contract, same `~/.papercusp/locks-cache/`
health markers, same repo-relative lock keys (so an OMP edit and a
Claude/Codex edit to the same file contend correctly). See
`apps/operator/docs/plans/three-client-lock-enforcement-2026-05-30.md`.
The 2026-05-20 OMP-only decision that deleted the Claude/Codex hooks is
reversed; do not re-delete `../cc/` citing that plan.
