# power-user-skills

Skill files served to **workspace-power-user** OMP sessions via
`GET /api/agent-bundle` (see
`apps/operator/docs/plans/omp-power-user-bundle-2026-05-20.md` §4.2).

Every `*.md` file in this directory (except `README.md`, which the
bundle route always skips) is read at request time and shipped in the
bundle's `skills[]` array. The `@papercusp/omp` plugin writes each into
the session-scratch dir, so they never pollute the user's global skills
tree.

## What belongs here

Only **Papercusp-shaped** skills — how-to guidance for the Papercusp
MCP tool catalog and the named cross-tool workflows. The subject matter
must be the Papercusp system itself, usable by any power user on any
machine.

## What does NOT belong here

- Machine-specific skills (anything referencing a path on a particular
  engineer's machine — e.g. `restart-stack`, `harness-paperclip`).
- Personal memory / preferences.
- Engineer-only install ceremony.

Power users bring their own machine setup; this directory ships only
what is Papercusp-shaped.

## v1 status

Empty by design. Skills are added here as we observe what power users
actually need. The bundle endpoint returns `skills: []` until then.
