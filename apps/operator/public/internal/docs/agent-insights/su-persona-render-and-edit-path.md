# Where the su persona lives and how it reaches a live session
URL: /internal/docs/agent-insights/su-persona-render-and-edit-path

A su agent's system prompt is layered and projected, not one file. The DOMAIN-NEUTRAL base is libs/papercusp/.../base/prompts/su.md (a git submodule); per-client + code-generated sections splice in at `<!-- PAPERCUSP-SU:* -->` markers (AUTO mode is renderModesPolicy(), not a file); the per-pot override is a DB row appended last. renderSuPlaybook() assembles the prompt fresh per launch behind the SU_BLUEPRINT_PERSONA flag, so a base edit is live for NEW sessions immediately — but the .materialized/coding/su.md copies lag and are not on the live path.

## What

A su agent's system prompt is **layered and projected**, not one file. To change su
behavior you edit the canonical SOURCE for the right layer; the live prompt is assembled at
launch. Editing the wrong copy (a build artifact, a sibling worktree, a materialized copy)
looks like it worked and changes nothing live.

## The layers (in render order)

| # | Layer                           | Canonical source                                                                                                                                                        | Edit it for                                                                          |
| - | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1 | **Base domain-neutral persona** | `libs/papercusp/packages/harness/blueprints/base/prompts/su.md` — a git **submodule** @ `main`                                                                          | the universal "how we work" spine: discipline, coordination, default posture, memory |
| 2 | **Per-client tooling overlay**  | `apps/operator/prompts/papercusp-su.claude.md` (`.codex.md` / `.omp.md`), spliced at `<!-- PAPERCUSP-SU:CLIENT-TOOLING-OVERLAY -->` (su.md \~L19)                       | client-specific tool guidance (task tracking, engine loops, lock hook)               |
| 3 | **Code-generated sections**     | TS renderers, spliced at `<!-- PAPERCUSP-SU:* -->` markers                                                                                                              | AUTO mode, wire schemas, coord legend, promotion model                               |
| 4 | **Per-pot instance override**   | DB `harness_shared.hive_settings`, key `promptOverride.su`, appended LAST (`pot-settings-store.ts` → `getHiveInstancePromptOverride` / `setHiveInstancePromptOverride`) | a single pot's domain specifics                                                      |

The marker-spliced code sections are **not in any `.md`** — e.g. `## AUTO mode` is produced
by `renderModesPolicy()` (`operating-modes-policy.ts`) and spliced at `<!-- PAPERCUSP-SU:AUTO-MODE -->`
(su.md \~L122). Marker constants live in `desktop-install/splice-tooling-overlay.ts`.

## The render path

`buildSuLaunchSpec()` (`role-launch-spec.ts`) gates on flag **`SU_BLUEPRINT_PERSONA`**
(`"papercusp-su-blueprint-persona"`, currently ON): when ON it resolves base = blueprint
`su.md`, overlayDir = `apps/operator/prompts`. It then calls **`renderSuPlaybook()`**
(`desktop-install/papercusp-files.ts`) — the in-memory launch-time assembler that
`spliceGeneratedSection()`s each generated block into the base at its marker and returns the
finished prompt. The on-disk installer twin is `writeSplicedPlaybook()`. A rendered prompt is
written to `~/.papercusp/launch-context/session-*.md`.

## Where to edit what

* **A new persona section that must render *before* AUTO mode** → author it in `su.md`
  **before** the `<!-- PAPERCUSP-SU:AUTO-MODE -->` marker. Everything before the marker renders
  before `## AUTO mode`; everything after renders after it.
* **AUTO-mode wording** → `operating-modes-policy.ts` (code, not a file).
* **The orient / mem0 bootstrap instructions** (the MCP `instructions` block) →
  `packages/operator-core/lib/endpoint-route/routes/transport/_mcp-handler.ts`.

## Two render tiers — interactive (in-memory) vs autonomous (materialized)

There are **two** consumers of the persona, and they reach it differently — this is the
single biggest source of "I edited the base but X still shows the old prompt":

* **Interactive su** (omp-hook / psu sessions — the `~/.papercusp/launch-context/session-*.md`
  renders): assembled **in memory at launch** by `renderSuPlaybook()` (via `buildSuLaunchSpec`,
  `role-launch-spec.ts`), reading the base `su.md` through `resolvePromptFiles` and appending the
  pot's `promptOverride.su` straight from `hive_settings`. It **never reads a `.materialized`
  file**, so a base edit is live for the next interactive launch immediately.
* **Autonomous fleet spawns** (cup / mug / overwatch via `invoke.ts`): read the **LOCAL tier**
  copy `<hiveDir>/.papercusp/.materialized/blueprints/<bp>/prompts/<role>.md` (`prompt-resolve.ts`
  `rootsFor` prepends `BLUEPRINT_LOCAL_ROOT`). That copy is a generated composition (built-in
  persona + `---` + the pot's `promptOverride.<role>` delta), written by
  `materializeHiveLocalBlueprint` (`pot-local-blueprint.ts`), which `rmSync`s + rewrites the whole
  `.materialized` root.

**The catch:** `materializeHiveLocalBlueprint` runs **only at autonomous-spawn time** — its sole
callers are `operator-spawn.ts` (fleet placement) and `endpoint-route/routes/harness/spawn.ts`
(loopback invoke). So a base-persona edit does **not** reach autonomous fleet agents until the
next qualifying spawn into that pot regenerates the copy. No code deploy is needed — running
hosts already redirect resolution to the edited tree via `PAPERCUSP_INTEGRATION_ROOT`; to force it
now, fire one autonomous spawn carrying a `BLUEPRINT_ID`. A stale `.materialized/.../su.md` means
"no fleet spawn since the edit," NOT "the edit didn't land."

## Gotchas (these bite)

* **`su.md` is in a git submodule** (`libs/papercusp`). The outer repo's `git ls-files`
  errors on it; it's tracked + committed in the submodule (`main`), while the live working
  tree is `staging`. `git -C <submodule> status` is how you see your edit's commit state.
* **Several copies look canonical but are NOT:** `**/.materialized/blueprints/**/su.md`
  (generated), sibling worktrees (`papercup-staging`, `papercup-release`, `papercup-checkpoint`),
  and the desktop sidecar (`papercusp-desktop/src-tauri/sidecar/harness/...`). Edit the base in
  `libs/papercusp`; the background git-sync commits + propagates to the siblings.
* **The `.materialized` copies lag — and for interactive sessions that's harmless.** They feed
  only autonomous fleet spawns (see *Two render tiers* above), not interactive launches, and
  regenerate at spawn time. **Verify an interactive change by grepping a fresh
  `~/.papercusp/launch-context/session-*.md` — NOT the materialized copy** (and confirm the file
  is actually an su render: H1 `# Superuser engineer-collaborator (su)…`; e.g. the Papercup voice
  persona also writes into `launch-context/`).
* **`renderSuPlaybook({})` renders the LEGACY base — a false-negative verification trap**
  (EI-7075). Calling the renderer with no `baseSource` reads the legacy
  `apps/operator/prompts/papercusp-su-engineer.tools.md`, NOT the blueprint `su.md` the live
  flag-on path uses — so a "my base edit is missing from the render" check against the
  default call fails spuriously. To reproduce the live render programmatically, pass
  `baseSource: libs/papercusp/packages/harness/blueprints/base/prompts/su.md` (what
  `buildSuLaunchSpec` resolves when `SU_BLUEPRINT_PERSONA` is ON).
* **`renderSuPlaybook` returns an OBJECT — the assembled prompt is `.text`.** The shape is
  `{ text, baseSource, overlaySource, projectGuideSource }`. Reaching for a plausible-but-wrong
  field (`.markdown`, `.content`, `.prompt`) yields `undefined`, and a verification script that
  then greps `` `${base}\n\n${override}` `` silently checks the string `"undefined"` plus the pot
  override — so every assertion sourced from the BASE or the CLIENT OVERLAY fails while the ones
  satisfied by the override alone pass. That reads exactly like "my base edit didn't land"
  (EI-19277117902219188, 2026-08-01: 5 of 9 checks false-failed this way, and the tell was
  arithmetic — the "whole prompt" came back SHORTER than the override it supposedly contained).
  Log `base.length` / `override.length` / `prompt.length` before believing a negative result: a
  base render is \~87k chars, so a four-figure or missing base means you read the wrong field, not
  that the edit is missing.
* **Layer 4 is a DB row, and nothing syncs the file into it.** `apps/operator/prompts/pot-instances/<pot>.su.md`
  is the version-controlled SOURCE ONLY; the live override is `harness_shared.pot_settings`
  (`setting_key = 'promptOverride.su'`, note: `pot_settings`, not the older `hive_settings` name).
  Editing the file alone changes NOTHING for live sessions. Re-seed it — not deploy-gated —
  with a loopback `POST /api/agent-mcp/pot-override-set`
  `{ potSlug: 'papercusp', kind: 'prompt', name: 'su', value: <file contents> }`, then CONFIRM the
  row moved (`SELECT length(value), to_timestamp(updated_at/1000) FROM harness_shared.pot_settings
  WHERE setting_key = 'promptOverride.su'`) — a 200 is the route accepting the write, not proof it
  landed.
* **Don't hand-write into a generated section.** If the fact belongs in AUTO mode / promotion
  model / wire schemas, change the renderer — the next splice overwrites anything you typed
  between the markers.
