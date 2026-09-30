# identities-v1 — integration audit (P-018)

> Plan `identities-v1-2026-08-30` · item **P-018** (Part A/B entry point) · work-item WI-2143730 ·
> written 2026-09-03 by su-27188c44 · method: **read the code, not the docs** — every surface below
> was located by grep + read of its consumer (there is no registry of prompt surfaces; that absence
> is finding F1). Sizes are `wc -c` on 2026-09-03; the DB counts are `dev:pg_query` reads with a
> positive control where an absence is claimed.
>
> **This table is the authority for Phase 3's scope** (P-020 … P-024, P-033). A Phase 3 item that
> touches a surface not listed here extends this table first.

## 0. Headline findings

- **F1 — no registry.** 22 surfaces author agent behaviour (§2). None is enumerated anywhere in
  code; the count was unknown until this audit. R9/P-024's build-time presence assertion is the
  first mechanism that will name them.
- **F2 — four generated sections are silently DROPPED from the live su render.** The blueprint base
  `su.md` carries only **5** of the **10** `<!-- PAPERCUSP-SU:* -->` splice markers
  (CLIENT-TOOLING-OVERLAY, WIRE-SCHEMAS, COORD-LEGEND, AUTO-MODE, RESULT-DOOR). `spliceGeneratedSection`
  drops a section whose marker is absent, so under `SU_BLUEPRINT_PERSONA` (default ON) the
  **WORKSPACE-MAP, PROMOTION-MODEL, COMPACTION and PROJECT-GUIDE** sections never reach an su agent.
  The legacy `papercusp-su-engineer.tools.md` carries all 9 content markers plus 3 FULL-ONLY blocks;
  `su.md` carries **0** FULL-ONLY blocks, so the `fleet` tier of the blueprint persona strips
  nothing but the AUTO clause. Claude sessions are partly compensated by out-of-repo mirrors
  (Claude Code auto-loads `CLAUDE.md`; the user `~/.claude/CLAUDE.md` `@`-includes
  `~/.papercusp/compaction-strategy.md`); Codex/OMP sessions get neither. The SHARED-BASE-NOTES
  bundle survives only because its injector decides eligibility from the AUTO-MODE marker and
  APPENDS when it has no anchor (`papercusp-files.ts` `injectSharedBaseNotes`). → **P-024**.
- **F3 — the substrate's projection is empty.** `harness_shared.blueprints` (PK
  `workspace_id, harness_slug`) holds **0 rows** on this box (positive control: `harness_plans`
  1,791). The plan's Design names it as "the per-harness projection"; today the blueprint layer is
  file-only. → **P-001** decides populate-or-drop before anything reads it.
  **Correction (P-001 / WI-2143731, 2026-09-03T23:20Z, su-27188c44):** the phrase "before anything
  reads it" (and S20's "nothing reads it today") was WRONG — the table has four live readers and a
  lazy projector: `getEffectiveBlueprint` (`packages/operator-core/lib/blueprint/project-to-pg.ts`)
  is called from `dbos/orchestrator-loop.ts:540` (`resolveHarnessDispatchGate`),
  `blueprint/blueprint-run-action.ts:245` and `harness/routines/gym-actions.ts:110`;
  `harness/improvements/watchdog.ts:3461` reads it as `blueprint_wired`;
  `blueprint/commit-reproject-real.ts` writes it. It is empty because this repo has no
  `.papercusp/blueprint.yaml` (S21) and the lazy path fires only from those callers with errors
  swallowed. Ruled **POPULATE** (D-017); 9 of 10 sibling harness blueprints load cleanly,
  `brood-box-alpha` fails `cannot resolve extended blueprint "pot"` (filed separately).
- **F4 — thirteen facts are declared twice** (§3). Five are the schema pairs the plan anticipated;
  eight are prose pairs the first sweep missed — including the whole su base text (blueprint vs
  legacy file) and the mode prose (policy module vs registry vs base). → **P-033 / P-021 / P-023**.
- **F5 — 157 plan slugs cited by non-test code do not resolve** (§4), 207 more only from tests /
  fixtures, 10 test placeholders leaked into production code. The one the plan named
  (`domain-generic-agent-personas-2026-06-17`) is #11 with 15 production citations across 11
  files, including the su persona's own header.
- **F6 — the baseline exists and is deterministic** (§5): full tier **136,083 B / 25 sections**,
  fleet tier **109,915 B / 22 sections**, rendered from pinned inputs and re-rendered
  byte-identical; the live base scores byte-equivalent to the pin today.

## 1. The live su render path (as read, 2026-09-03)

`packages/operator-core/lib/role-launch-spec.ts` (`getFlag(FLAGS.SU_BLUEPRINT_PERSONA)`, default ON)
→ `resolvePromptFiles(harnessRoot, 'su')` picks the base
`libs/papercusp/packages/harness/blueprints/base/prompts/su.md` (75,371 B, a git submodule) →
`renderSuPlaybook({ agent, profile, baseSource, overlayDir: apps/operator/prompts, projectGuideSource, tier })`
(`packages/operator-core/lib/desktop-install/papercusp-files.ts:3751`) splices, in order:

| step | marker | generator | fires on `su.md`? |
|---|---|---|---|
| 1 | CLIENT-TOOLING-OVERLAY | `apps/operator/prompts/papercusp-su.<agent>.md` (claude 7,716 / omp 7,613 / codex 7,076 B) | yes |
| 2 | WIRE-SCHEMAS | `prompt-assembly.ts renderWireSchemasSection` (fleet tier: spine families only) | yes |
| 3 | COORD-LEGEND | `coord-schema.ts renderCoordLegend` | yes |
| 4 | WORKSPACE-MAP | `desktop-install/workspace-map.ts` (env `PAPERCUSP_*_ROOT`) | **no — dropped** |
| 5 | PROMOTION-MODEL | `desktop-install/promotion-model.ts` | **no — dropped** |
| 6 | AUTO-MODE | `operating-modes-policy.ts renderModesPolicy(tier)` (33,951 B source; no is-active gate) | yes |
| 7 | RESULT-DOOR | `result-door-prompt.ts renderResultDoorSection(BAKED_DOOR_CONSTANTS)` | yes |
| 8 | COMPACTION | `apps/operator/prompts/papercusp-compaction.protocol.md` (1,622 B) | **no — dropped** |
| 9 | SHARED-BASE-NOTES | `injectSharedBaseNotes` — deploy-pipeline (engineer only) + wait-loop + peer-wake + coupling + state-plane | no marker; **appended** (eligible via AUTO-MODE) |
| 10 | PROJECT-GUIDE | `resolveProjectGuideText` → repo `CLAUDE.md` (doc-parts projection, ~32 KB) | **no — dropped** |
| 11 | FULL-ONLY | `stripFullOnlySections` (fleet) / `stripFullOnlyMarkers` (full) | 0 blocks in `su.md` |

AFTER the render, `role-launch-spec.ts` (L366-405, L772+) appends the per-pot instance override
`pot_settings.promptOverride.su` (papercusp: 35,843 B, origin `local`) via `getPromptOverride` +
`hive-local-blueprint.ts`, checked WARN-only by `hive-override-additive-guard.ts`. Markers are
declared in `desktop-install/splice-tooling-overlay.ts` L16-150. The `.materialized/**` copies
that `prompt-resolve.ts` can read are **not on this path** and lag; verification of any persona
change reads a fresh `~/.papercusp/launch-context/session-*.md`, never a materialized copy
(`/internal/docs/agent-insights/su-persona-render-and-edit-path`).

## 2. Surface table — the Phase 3 authority

Classes: **ON-BLUEPRINT** = already a document / tier of the blueprint layer, Phase 3 only adds
slot metadata · **SHOULD-BE** = identity prose living outside the blueprint layer (TS string
constants, prompt dirs, out-of-repo mirrors); Phase 3 moves it onto a slot · **CORRECTLY-SEPARATE**
= a mechanism (assembler / resolver / lint / enforcement / registry of STATE) or a derived truth
(rung 1 of the derived-truth ladder) that must never become blueprint prose.

| # | surface | where · size | reaches an agent via | class | reason | Phase 3 |
|---|---|---|---|---|---|---|
| S1 | su base persona | `libs/papercusp/packages/harness/blueprints/base/prompts/su.md` · 75,371 B | §1 render (flag ON) | ON-BLUEPRINT | it IS the kernel + engineer-craft + fleet-member text, today one undifferentiated document; `## Default posture` (22,033 B) and `## Working as a fleet MEMBER` (4,475 B) are the slot-bound halves | P-003 seal/precedence · P-020 fleet-posture · P-021 mode prose out |
| S2 | client tooling overlays | `apps/operator/prompts/papercusp-su.{claude,omp,codex}.md` · 7,716 / 7,613 / 7,076 B | step 1 | SHOULD-BE | the `client` slot of the D-007 registry, but a file per client in the operator prompts dir, unreachable from any blueprint chain | P-024 (repo blueprint) · P-020 |
| S3 | legacy base playbooks | `apps/operator/prompts/papercusp-su-{engineer,power}.tools.md` · 90,560 / 74,172 B | flag-OFF fallback only | SHOULD-BE (retire) | a second full copy of the su base (D6); the only carrier of the 9-marker + FULL-ONLY layout — the layout `su.md` should have inherited (F2) | P-023 byte-equivalence, then delete |
| S4a | WIRE-SCHEMAS | `prompt-assembly.ts:525` | step 2 | CORRECTLY-SEPARATE | derived from the wire-schema tool registry | — |
| S4b | COORD-LEGEND | `coord-schema.ts:519` → `## Coord injection protocol` 2,278 B | step 3 | CORRECTLY-SEPARATE | derived from the coord glyph registry | — |
| S4c | AUTO-MODE (mode prose) | `operating-modes-policy.ts` 33,951 B → rendered AUTO 12,812 + IDEATE 7,581 + DRAIN 4,530 + AUDIT 3,503 = 28,426 B (fleet: 2,261 B) | step 6 | SHOULD-BE | mode PROSE is identity text authored as a TS string; each axis is an exclusive slot (`autonomy`, `ideation`, `objective`, `audit`); STATE + the implication table stay in `modes/registry.ts` | P-021 |
| S4d | RESULT-DOOR | `result-door-prompt.ts:57` → `## Tool results are capped` 2,849 B | step 7 | CORRECTLY-SEPARATE | derived from the door constants the agent is held to | — |
| S4e | SHARED-BASE-NOTES bundle | `papercusp-files.ts:601 injectSharedBaseNotes` over 5 `*-policy.ts` renderers: deploy-pipeline 8,226 + wait-loop 3,669 + peer-wake 2,017 + coupling 1,922 + state-plane 3,783 = 19,617 B | step 9 (appended) | SHOULD-BE | behavioural clauses = kernel / `practice` prose authored as TS constants and rendered by TWO composers (D8); the injector already splits `domain` (deploy-pipeline, `profile === 'engineer'`) from platform | P-020 · P-023 |
| S4f | WORKSPACE-MAP | `desktop-install/workspace-map.ts:81` | step 4 — **dropped** | CORRECTLY-SEPARATE | instance-derived from env; its absence is F2 | P-024 |
| S4g | PROMOTION-MODEL | `desktop-install/promotion-model.ts:45` | step 5 — **dropped** | CORRECTLY-SEPARATE | derived from release config | P-024 |
| S4h | COMPACTION protocol | `apps/operator/prompts/papercusp-compaction.protocol.md` 1,622 B; Claude floor `papercusp-compaction.base.md` 16,758 B (+ `PAPERCUSP-COMPACTION:CLIENT-OVERLAY`) | step 8 — **dropped**; Claude gets it via `~/.papercusp/compaction-strategy.md` | SHOULD-BE | `practice` prose delivered to one client by an out-of-repo mirror (D9) | P-024 · P-020 |
| S4i | PROJECT-GUIDE | `resolveProjectGuideText` → repo `CLAUDE.md` (302 live doc parts, ~32 KB) | step 10 — **dropped**; Claude Code auto-loads `CLAUDE.md` | CORRECTLY-SEPARATE | doc CONTENT, Postgres-canonical; the gap is ADDRESSING (P-022) and PRESENCE (P-024) | P-022 · P-024 |
| S5 | per-pot instance override | `pot_settings.promptOverride.su` · papercusp 35,843 B, origin `local` | appended after render (`getPromptOverride` + `hive-local-blueprint.ts`) | ON-BLUEPRINT | the `instance` tier — the last position of the D-007 registry | P-003 (guard → identity-lint BLOCK tier) |
| S6 | extends-chain resolver | `libs/papercusp/packages/orchestrator/src/prompt-resolve.ts` 16,542 B (+ `.materialized/` tier) | `invoke <role>`; `resolvePromptFiles` | CORRECTLY-SEPARATE | mechanism; `.materialized/**` is a lagging build artifact, never the live path | P-003 extends |
| S7 | base role library + overlays | `blueprints/base/prompts/*` 63 files (incl. `agent-base-preamble.md` 11,760 B, cup/kettle/…); overlays work 4 · coding 4 · vote 2 · scan / implement / gaia-agent / coding-solo / coding-factory 1 each | chain walk (S6) | ON-BLUEPRINT | already where the chain resolves prompts; Phase 3 adds `slots:` | P-003 · P-032 |
| S8 | second composer `REPLACE_CLAUDE_BASE` | `agent-base-preamble.md` + `agent-base-overlay.md`; consumers `bootstrap-su.ts`, `bootstrap-role.ts`, `role-prompt-from-slug.ts`, `invoke.ts`, `prompt-resolve.ts`, `omp-native-lsp-gate.ts`, `dbos/orchestrator-runner.ts`, `apps/operator/scripts/psu-launcher.mjs` | spawned-role system prompt | SHOULD-BE (content) / CORRECTLY-SEPARATE (flag consumers) | recorded default SUBSUME: preamble = kernel base text, overlay = `domain` leaf | P-032 |
| S9 | spawned-bee base builder | `libs/papercusp/packages/orchestrator/src/prompt-build.ts` 129,989 B — assembler + inline nudges (`FRICTION_TRIPWIRE`, `YIELD_POLICY`, …) | bee spawn | SHOULD-BE (nudge prose) / CORRECTLY-SEPARATE (assembler) | prose in TS constants; the assembler stays code | P-023 |
| S10 | chat-surface role prompts | `apps/operator/prompts/<role>.{persona,converse,shell,examples,tools}.md` — operator 14,337 · papercup 26,486 · papercup-deep 6,754 · oracle 2,597 · auditor 3,977 · onboarding-tutor 11,700 (persona B); worker / architect / scoper / debugger / validator / reviewer / tester `.tools.md` | `prompt-assembly.ts` (51,778 B) | SHOULD-BE | `PROMPT_ROLES` must resolve through the one chain with the file tier as lowest-precedence fallback | P-023 |
| S11 | audience mode personas | `<role>.persona.{engineer,novice}-mode.md` via `loadRoleModePersona` (`prompt-assembly.ts:329`) | chat roles | SHOULD-BE | the `audience` axis | P-021 |
| S12 | prompt-clause policy re-exports | 20 `packages/operator-core/lib/*-policy.ts` (§6): 15 chat-only + 5 shared with su | `prompt-assembly.ts` (+ S4e) | SHOULD-BE | craft / kernel prose as TS constants | P-020 · P-023 |
| S13 | doc parts + projector | `harness_shared.harness_doc_parts` (papercusp: 302 live; 131 `client_scope`; 302 `target_section`) → `CLAUDE.md` via `scripts/project-doc-parts.mjs` 66,217 B | S4i / Claude native | CORRECTLY-SEPARATE | doc content + projector; CLIENT addressing exists, blueprint/slot addressing does not | P-022 |
| S14 | out-of-repo client mirrors | `~/.claude/AGENTS.md`, user `~/.claude/CLAUDE.md`, `~/.papercusp/compaction-strategy.md` | Claude Code native load | SHOULD-BE | hand-kept projections of the `client` slot (the base itself calls them projections) | P-024 · P-020 |
| S15 | mode registry | `packages/operator-core/lib/modes/registry.ts` 51,079 B | `mode:set`, `⟦mode⟧` stamp, `coord:orient` | CORRECTLY-SEPARATE (state + implication table) · its contract PROSE is SHOULD-BE | D-008: state stays; prose moves | P-021 |
| S16 | instruction-precedence resolver | `packages/operator-core/lib/instruction-lint.ts` 20,407 B | `⟦INSTRUCTION-PRECEDENCE⟧` | CORRECTLY-SEPARATE | R3: identity text is never its input | — |
| S17 | capability envelopes | `capability-envelope/policy.ts` `ROLE_ENVELOPES` 13,654 B + `blueprint-envelopes.ts` 2,811 B (`fleet.workerRoles`) | dispatch seat | CORRECTLY-SEPARATE | authority as code; the M3 grants seam | P-005 · P-016 · P-033 (D2) |
| S18 | mode guards | `capability-envelope/audit-mode-guard.ts` 9,749 B · `agent-tools/locks/goal-mode-edit-guard.ts` 4,670 B | dispatch / lock path | CORRECTLY-SEPARATE | enforcement, R3 | — |
| S19 | additive-override guard | `packages/operator-core/lib/hive-override-additive-guard.ts` 3,593 B (WARN) | S5 | CORRECTLY-SEPARATE | lint; generalized to the composed stack with a structural BLOCK tier | P-003 |
| S20 | blueprint projection | `harness_shared.blueprints` (PK `workspace_id, harness_slug`) · **0 rows** (F3) | `getEffectiveBlueprint` from `dbos/orchestrator-loop.ts:540`, `blueprint/blueprint-run-action.ts:245`, `harness/routines/gym-actions.ts:110`; `watchdog.ts:3461` `blueprint_wired` — **corrected by P-001: NOT unread** (the first draft said "nothing reads it today") | CORRECTLY-SEPARATE (projection) | empty because the lazy projector fires only from those callers for a harness with `.papercusp/blueprint.yaml` (this repo has none — S21) and swallows errors; ruled POPULATE (D-017) | P-001 ✓ (ruled) · P-024 (this repo's yaml) |
| S21 | this repo's blueprint | `.papercusp/blueprint.yaml` | — | **ABSENT** | P-024 creates it (domain overlay, lexicon, `fleet.workerRoles`) | P-024 |
| S22 | render-fidelity tests | `llm-testing/targets/su.ts`, `llm-testing/__tests__/su-system-framing.test.ts`, `psu-prompt-isolation.test.ts`, `desktop-install/persona-tier.test.ts`, `desktop-install/__tests__/papercusp-files.test.ts`, **`desktop-install/su-render-baseline.test.ts`** (this item) | CI | CORRECTLY-SEPARATE | the P-035 gate's instruments | P-035 |

## 3. Duplicate declaration sites

One fact, two declarations. R10 requires each pair to collapse to one authoritative site or fail
validation when the two disagree.

| # | fact | site A | site B | today | resolves in |
|---|---|---|---|---|---|
| D1 | persona per role | `roles[].prompt` (`blueprint/schema.ts:61`) | `knobs.promptOverrides[role]` (`schema.ts:551`) | both read; no precedence statement | P-033 |
| D2 | capabilities per role | `roles[].capabilities` (`schema.ts:64` — "generous hints") | `fleet.workerRoles[].capabilities` (`schema.ts:407` — the ENFORCED allow-list via `blueprint-envelopes.ts`) | indistinguishable at the point of authoring (R10) | P-033 |
| D3 | knowledge pack | `knowledge.pack` (`schema.ts:428`) | `learning.pack` (`schema.ts:446`, `@deprecated` read-side compat) | readers prefer A, fall back to B | P-033 |
| D4 | rubric | `gym.rubric` (`schema.ts:351`) | `acceptance.rubric` (`schema.ts:365`) — both `GymRubricSchema` | two copies of one shape | P-025 / P-026 (`bundles:` ref) |
| D5 | dependencies | `dependencies` (`schema.ts:999`: tools / packs / plugins) | D-004 capability classes (M3 `capability_class_registry`) | B does not exist yet | P-016 |
| D6 | the su base text | `blueprints/base/prompts/su.md` 75,371 B | `apps/operator/prompts/papercusp-su-engineer.tools.md` 90,560 B (flag-OFF fallback) | diverged: markers 5 vs 9, FULL-ONLY 0 vs 3 (F2) | P-023 |
| D7 | mode prose | `operating-modes-policy.ts` (28,426 B rendered) | `modes/registry.ts` contract clauses AND `su.md` `## Default posture (AUTO mode OFF)` 22,033 B restating the AUTO boundary | three tellings of one grant | P-021 |
| D8 | the five behavioural notes | `injectSharedBaseNotes` (su) | `prompt-assembly.ts` (chat roles) — the SAME five renderers, two composers | one clause, two assemblers | P-023 |
| D9 | compaction protocol | `papercusp-compaction.{base,protocol}.md` | `~/.papercusp/compaction-strategy.md` (user `CLAUDE.md` `@`-include) | in-repo copy not rendered (F2); out-of-repo copy hand-kept | P-024 |
| D10 | the WHAT/HOW/WHO route gate | `su.md` `## Default posture` | `~/.claude/AGENTS.md` (declared "a projection of this section") | hand-synced | P-024 · P-020 |
| D11 | project-guide delivery | PROJECT-GUIDE splice (not firing) | Claude Code native `CLAUDE.md` load | Claude only | P-022 · P-024 |
| D12 | `extends` | `schema.ts:912` (full schema) | `schema.ts:1025` (header prefix parser) | same bytes parsed twice — derives, acceptable | note only |
| D13 | instance override vs base | `pot_settings.promptOverride.su` 35,843 B | base headings it restates | WARN-only guard (S19) | P-003 BLOCK tier |

## 4. Dangling plan citations

Method: every `<slug>-2026-MM-DD`-shaped string in `packages/ apps/ libs/papercusp/packages/ scripts/`
(1,100 distinct) resolved against `harness_shared.harness_plans` → **374 unresolved**
(`.papercusp/scratch/su-27188/p018/p018-dangling.txt`). Re-scored by WHO cites them over
`git ls-files --recurse-submodules` (15,526 code / prompt files): test & fixture files
(`*.test.*`, `__tests__/`, `__fixtures__/`, `e2e/`, `scenarios/`) vs everything else.

- **157 slugs are cited by non-test code** (below) — real dangling citations. Each is a plan that
  was archived, renamed, or never written; the citation is a dead pointer a reader cannot follow.
- **10 test placeholders leaked into production code** (`some-plan-*`, `my-plan-*`, `acceptance-foo-*`,
  `fed-reanchor-*`, `006-federation-scope-*`, `108-results-channel-*`, `on-api-*`,
  `plan-and-briefs-*`) — in `agent-tools/locks/acquire.ts`, `curation/deps.ts`,
  `sync/hyperbee/scope-cores.ts`, `agent-tools/plan-items/claim.ts`, `memory/recall-staleness.ts`,
  `sync-resolver/index.ts`, `agent-tools/plans/val-assertions.ts`,
  `harness/improvements/observation-types.ts`, `consult/get-feedback-core.ts`,
  `sync/pot-git/results-receipt.ts` (one each; `acquire.ts` ×3, `deps.ts` ×2, `scope-cores.ts` ×2).
- **207 are cited only from tests / fixtures** — synthetic slugs; not dangling in the sense that matters.

The plan's own named case, `domain-generic-agent-personas-2026-06-17`, is #11: 15 production
citations across 11 files (`role-launch-spec.ts` ×3, `apps/operator/scripts/psu-launcher.mjs` ×2,
`orchestrator/src/invoke.ts` ×2, `bootstrap-su.ts`, `bootstrap-role.ts`, `hive-settings-store.ts`,
`effective-config.ts`, …) plus the su persona's own header line ("Authored for
domain-generic-agent-personas-2026-06-17 P-006").

Resolution is NOT in P-018's scope (it records); the plan-authored owner of the persona citations
is P-032 / P-003, and the rest is a fleet-wide sweep to file separately.

| # | dangling plan slug | non-test cites | first file | test cites |
|---|---|---|---|---|
| 1 | `impartial-benchmark-suite-2026-06-15` | 38 | `libs/papercusp/packages/harness/blueprints/external-bench/blueprint.yaml` +34 more | 4 |
| 2 | `scheduled-recurring-plans-2026-06-16` | 34 | `apps/operator-vite/src/components/adv/AdvShell.tsx` +27 more | 12 |
| 3 | `domain-generic-hive-architecture-2026-06-18` | 27 | `packages/operator-core/lib/hive-settings-store.ts` +25 more | 15 |
| 4 | `shared-hive-owner-enforcement-2026-06-19` | 24 | `packages/operator-core/lib/harness-state/table-registry.ts` +16 more | 0 |
| 5 | `shared-hive-rekey-2026-06-19` | 23 | `packages/operator-core/lib/sync/hyperbee/projections/register-all.ts` +15 more | 7 |
| 6 | `shared-hive-hardening-2026-06-13` | 21 | `packages/operator-core/lib/agent-tools/index.ts` +20 more | 14 |
| 7 | `benchmark-suite-gaia-2026-06-17` | 18 | `packages/operator-core/lib/external-bench/hive-backlog-realqueen.ts` +15 more | 0 |
| 8 | `docs-and-memory-as-projections-2026-06-05` | 18 | `packages/operator-core/lib/memory/suite/checks.ts` +16 more | 1 |
| 9 | `accounts-pool-tab-2026-06-15` | 16 | `packages/operator-core/lib/agent-tools/index.ts` +13 more | 6 |
| 10 | `infra-fail-fast-build-integrity-2026-06-19` | 16 | `packages/operator-core/lib/native-addon-preflight.ts` +13 more | 6 |
| 11 | `domain-generic-agent-personas-2026-06-17` | 15 | `packages/operator-core/lib/role-launch-spec.ts` +10 more | 6 |
| 12 | `storage-settings-page-2026-06-15` | 15 | `apps/operator-vite/src/routes/settings/storage.tsx` +14 more | 0 |
| 13 | `load-flake-isolation-2026-06-23` | 14 | `apps/operator/lib/release/green-checkpoint.ts` +1 more | 3 |
| 14 | `watchdog-and-exposed-systems-improvement-2026-06-18` | 14 | `packages/operator-core/lib/harness/improvements/tool-error-classifier.ts` +11 more | 4 |
| 15 | `work-item-completion-integrity-2026-07-01` | 14 | `packages/operator-core/lib/work-items.ts` +8 more | 3 |
| 16 | `operator-scalability-event-loop-2026-06-16` | 13 | `packages/operator-core/lib/endpoint-route/routes/transport/_mcp-handler.ts` +11 more | 4 |
| 17 | `benchmark-suite-metr-hcast-2026-06-17` | 12 | `packages/operator-core/lib/external-bench/task-sets.ts` +10 more | 9 |
| 18 | `model-override-sidebar-2026-06-23` | 12 | `packages/operator-core/lib/owner-steering.ts` +6 more | 2 |
| 19 | `relight-self-learning-edges-2026-06-14` | 12 | `apps/operator-vite/src/components/adv/LearningEfficacyPanel.tsx` +11 more | 2 |
| 20 | `benchmark-suite-frontier-swe-2026-06-18` | 11 | `packages/operator-core/lib/external-bench/task-sets.ts` +9 more | 0 |
| 21 | `cost-audit-2026-06-29` | 11 | `packages/operator-core/lib/search/embed-backfill.ts` +3 more | 1 |
| 22 | `dynamic-tool-surface-2026-07-01` | 11 | `packages/operator-core/lib/endpoint-route/routes/transport/_mcp-handler.ts` +6 more | 3 |
| 23 | `plan-implementation-framework-2026-06-15` | 11 | `apps/operator-vite/src/components/adv/LearningTab.tsx` +10 more | 0 |
| 24 | `backend-connection-scaling-2026-06-17` | 10 | `packages/operator-core/lib/pg-listen-hub.ts` +6 more | 6 |
| 25 | `worker-pool-crash-absorption-2026-06-25` | 10 | `apps/operator/lib/release/green-checkpoint.ts` | 1 |
| 26 | `workspace-data-isolation-leaks-2026-06-17` | 10 | `scripts/check-scope-defaults.mjs` +8 more | 4 |
| 27 | `benchmark-capability-injection-redesign-2026-06-17` | 9 | `packages/operator-core/lib/external-bench/capabilities/capability-profile.ts` +8 more | 1 |
| 28 | `benchmark-suite-gdpval-2026-06-17` | 9 | `packages/operator-core/lib/external-bench/gdpval/_xbench_gdpval.ts` +8 more | 0 |
| 29 | `isolation-retry-resilience-2026-07-19` | 9 | `apps/operator/lib/release/green-checkpoint.ts` +1 more | 1 |
| 30 | `presence-v2-2026-06-14` | 9 | `packages/operator-core/lib/harness/routines/token-report-action.ts` +6 more | 9 |
| 31 | `experiment-registry-invocation-api-2026-06-14` | 8 | `apps/operator-vite/src/components/adv/ExperimentsPanel.tsx` +7 more | 1 |
| 32 | `account-dynamic-pin-2026-06-29` | 7 | `packages/operator-core/lib/inference-gateway/gateway.ts` +4 more | 0 |
| 33 | `blender-loop-repair-2026-08-16` | 7 | `packages/operator-core/lib/knowledge-packs/candidate-review.ts` +5 more | 1 |
| 34 | `gateway-live-control-and-egress-plan-2026-06-20` | 7 | `packages/operator-core/lib/agent-tools/index.ts` +5 more | 0 |
| 35 | `git-sync-dx-hardening-2026-06-17` | 7 | `apps/operator/prompts/papercusp-su-engineer.tools.md` +6 more | 0 |
| 36 | `inference-gateway-robustness-audit-2026-06-20` | 7 | `packages/operator-core/lib/deployment/account-pool-store.ts` +6 more | 1 |
| 37 | `sentinel-as-claude-tui-2026-06-22` | 7 | `apps/operator/app/_components/voice/VoiceAppBridge.tsx` +6 more | 5 |
| 38 | `benchmark-suite-theagentcompany-2026-06-17` | 6 | `packages/operator-core/lib/external-bench/task-sets.ts` +4 more | 4 |
| 39 | `coordination-hook-rpc-fanout-collapse-2026-07-16` | 6 | `apps/operator/scripts/psu-launcher.d.mts` +5 more | 2 |
| 40 | `infra-perf-reliability-audit-round3-2026-06-19` | 6 | `packages/operator-core/lib/cpu-task-worker.script.mjs` +5 more | 1 |
| 41 | `infra-perf-robustness-audit-2026-06-18` | 6 | `apps/operator/bin/hono-host.ts` +5 more | 2 |
| 42 | `lock-contention-2026-06-01` | 6 | `packages/operator-core/lib/scout/test-support.ts` | 13 |
| 43 | `mem0-timeout-fix-2026-06-24` | 6 | `packages/operator-core/lib/memory/configure.ts` +3 more | 3 |
| 44 | `promote-policy-and-waves-2026-05-30` | 6 | `packages/agent-mcp/dist/role-config.js` +5 more | 0 |
| 45 | `shared-hive-member-content-federation-2026-06-20` | 6 | `apps/operator/app/adv/harnesses/PotContentPanel.tsx` +5 more | 15 |
| 46 | `token-tracking-plan-and-briefs-2026-06-20` | 6 | `apps/operator/app/harness/insights/InsightsTab.tsx` +5 more | 0 |
| 47 | `watchdog-embed-resilience-and-dedup-2026-06-17` | 6 | `packages/operator-core/lib/harness/improvements/watchdog.ts` +2 more | 1 |
| 48 | `benchmark-arms-su-vs-queen-expansion-2026-06-16` | 5 | `apps/operator/app/eval-viz/arms.ts` +4 more | 3 |
| 49 | `benchmark-report-portable-trace-2026-06-17` | 5 | `packages/operator-core/lib/external-bench/report/report-builder-pg.ts` +4 more | 2 |
| 50 | `benchmark-workspace-isolation-2026-06-18` | 5 | `packages/operator-core/lib/external-bench/bench-workspace.ts` +3 more | 1 |
| 51 | `coord-wake-mid-turn-2026-06-30` | 5 | `apps/operator/scripts/psu-pty-host.mjs` +1 more | 4 |
| 52 | `coordination-unification-2026-06-23` | 5 | `packages/operator-core/lib/agent-tools/index.ts` +3 more | 2 |
| 53 | `infra-perf-reliability-audit-round4-2026-06-19` | 5 | `apps/operator/bin/host-backpressure.ts` +4 more | 0 |
| 54 | `infra-self-healing-supervision-2026-06-19` | 5 | `apps/operator/bin/hono-host.ts` +4 more | 0 |
| 55 | `left-sidebar-tauri-2026-06-07` | 5 | `apps/operator-vite/src/components/left-sidebar/LeftSidebar.tsx` +4 more | 3 |
| 56 | `mcp-outage-triage-2026-07-02` | 5 | `apps/operator/lib/mcp-proxy/proxy.ts` +4 more | 1 |
| 57 | `owner-wall-ttl-lapse-hardening-2026-07-26` | 5 | `packages/operator-core/lib/agent-facts/store.ts` +4 more | 2 |
| 58 | `pui-bee-dossier-pane-2026-06-06` | 5 | `packages/operator-core/lib/agent-tools/coordination/messages.ts` +4 more | 1 |
| 59 | `queen-steering-panel-2026-06-15` | 5 | `packages/operator-core/lib/agent-tools/index.ts` +4 more | 7 |
| 60 | `account-hard-pin-2026-06-29` | 4 | `packages/operator-core/lib/inference-gateway/gateway.ts` +2 more | 2 |
| 61 | `autoloop-hive-operator-rebuild-2026-06-05` | 4 | `packages/operator-core/lib/agent-tools/pot/declare_wake.ts` +3 more | 2 |
| 62 | `bee-context-efficiency-2026-06-14` | 4 | `packages/operator-core/lib/agent-tools/work_items/checkpoint.ts` +3 more | 5 |
| 63 | `benchmark-suite-agentsnet-2026-06-17` | 4 | `packages/operator-core/lib/external-bench/agentsnet-ingest-cli.ts` +3 more | 2 |
| 64 | `benchmark-suite-paperbench-2026-06-17` | 4 | `packages/operator-core/lib/external-bench/_pb_hive_solve.ts` +3 more | 2 |
| 65 | `benchmark-suite-swarmbench-2026-06-17` | 4 | `packages/operator-core/lib/external-bench/swarmbench-backlog.ts` +3 more | 2 |
| 66 | `bg-host-agent-spawn-scope-isolation-2026-07-02` | 4 | `packages/operator-core/lib/fleet/spawn-reclaim.ts` +2 more | 1 |
| 67 | `capability-bash-orphan-kill-2026-06-21` | 4 | `packages/operator-core/lib/agent-tools/capability/bash-jobs.ts` +2 more | 1 |
| 68 | `compaction-fold-audit-2026-07-06` | 4 | `packages/operator-core/lib/agent-tools/coordination/tools/orient.ts` +2 more | 2 |
| 69 | `flags-default-on-reach-2026-06-21` | 4 | `libs/papercusp/packages/orchestrator/src/prompt-build.ts` +2 more | 1 |
| 70 | `github-bridge-ingress-timeout-too-short-2026-07-20` | 4 | `packages/operator-core/lib/sync/pot-git/github-egress.ts` +3 more | 1 |
| 71 | `owner-auto-adopt-fleet-lessons-2026-07-19` | 4 | `apps/operator-vite/src/components/adv/KnowledgePackCandidates.tsx` +3 more | 0 |
| 72 | `agent-briefs-2026-06-05` | 3 | `packages/operator-core/lib/endpoint-route/routes/agent-tools/catchall.ts` +2 more | 2 |
| 73 | `attention-parallel-db-org-mock-race-2026-07-17` | 3 | `packages/operator-core/lib/agent-tools/plans/attention.ts` +2 more | 0 |
| 74 | `auth-tier-rollout-2026-06-10` | 3 | `scripts/gen-auth-tier-audit.mjs` +1 more | 1 |
| 75 | `capacity-oracle-false-saturation-2026-06-29` | 3 | `packages/operator-core/lib/fleet/capacity-dispatch.ts` +1 more | 1 |
| 76 | `codex-gateway-oauth-proxy-2026-07-04` | 3 | `packages/operator-core/lib/inference-gateway/gateway.ts` +1 more | 0 |
| 77 | `coding-hive-bee-vs-coding-factory-scoper-2026-06-23` | 3 | `packages/operator-core/lib/agent-tools/scheduler/set_claim_spec.ts` +1 more | 2 |
| 78 | `desktop-update-center-and-release-tooling-2026-07-10` | 3 | `apps/operator/app/_components/UpdateChip.tsx` +2 more | 1 |
| 79 | `explicit-presence-as-convention-2026-07-26` | 3 | `packages/operator-core/lib/harness/routines/register-system-actions.ts` +1 more | 0 |
| 80 | `green-checkpoint-timeout-vs-forks-2026-06-27` | 3 | `apps/operator/lib/release/green-checkpoint.ts` +2 more | 0 |
| 81 | `hybrid-cup-scheduler-work-stealing-2026-06-22` | 3 | `libs/papercusp/packages/harness/blueprints/base/prompts/cup.base.md` +2 more | 0 |
| 82 | `integration-adoption-2026-06-03` | 3 | `packages/operator-core/lib/agent-tools/coordination/tools/topics-tag.ts` +2 more | 0 |
| 83 | `load-aware-routing-2026-06-29` | 3 | `packages/operator-core/lib/inference-gateway/account-failover.ts` +1 more | 1 |
| 84 | `scoped-superuser-workspace-clamp-2026-06-18` | 3 | `apps/operator/scripts/hooks/omp/coord-hook.ts` +2 more | 0 |
| 85 | `self-improvement-stack-reconciliation-2026-06-09` | 3 | `packages/operator-core/lib/instance-spec/genome.ts` +1 more | 1 |
| 86 | `tool-discovery-for-weak-models-2026-06-30` | 3 | `apps/operator/scripts/hooks/omp/coord-hook.ts` +2 more | 0 |
| 87 | `wake-delivery-degradation-fix-2026-07-09` | 3 | `packages/operator-core/lib/events/await/wake-executor.ts` | 0 |
| 88 | `work-queue-stuck-item-recovery-2026-06-17` | 3 | `packages/operator-core/lib/work-item-dispatch-states.ts` +2 more | 1 |
| 89 | `account-aware-rate-governor-routing-2026-06-16` | 2 | `packages/operator-core/lib/deployment/account-pool-store.ts` +1 more | 0 |
| 90 | `account-cold-start-seed-2026-06-29` | 2 | `packages/operator-core/lib/inference-gateway/gateway.ts` | 1 |
| 91 | `capless-inference-gateway-ship-2026-08-28` | 2 | `packages/operator-core/lib/agent-fleets-store.ts` +1 more | 3 |
| 92 | `egress-proxy-toggle-2026-06-30` | 2 | `packages/operator-core/lib/inference-gateway/gateway.ts` | 0 |
| 93 | `flaky-coord-tests-2026-05-30` | 2 | `packages/operator-core/lib/scout/test-support.ts` | 1 |
| 94 | `green-checkpoint-lock-starvation-2026-07-02` | 2 | `packages/operator-core/lib/harness/routines/release-actions.ts` | 1 |
| 95 | `green-checkpoint-stale-lock-2026-06-26` | 2 | `apps/operator/lib/release/green-checkpoint.ts` | 1 |
| 96 | `hive-git-p2p-ops-runbook-2026-07-09` | 2 | `packages/operator-core/lib/endpoint-route/routes/desktop/git-hive-mode.ts` +1 more | 2 |
| 97 | `infra-perf-reliability-audit-2026-06-19` | 2 | `packages/operator-core/lib/dbos/dead-workflow-monitor.ts` +1 more | 1 |
| 98 | `kettle-role-2026-06-15` | 2 | `libs/papercusp/packages/harness/blueprints/base/prompts/kettle.md` | 1 |
| 99 | `m3-realqueen-2026-06-16` | 2 | `packages/operator-core/lib/external-bench/preserved-runs.ts` +1 more | 11 |
| 100 | `papercusp-dogfood-phase11-multi-engineer-2026-05-25` | 2 | `packages/operator-core/lib/harness/load-shared-config.ts` +1 more | 0 |
| 101 | `pui-hive-lexicon-2026-06-06` | 2 | `packages/operator-core/lib/agent-tools/index.ts` +1 more | 1 |
| 102 | `queue-audit-2026-08-17` | 2 | `packages/operator-core/lib/coord/condition-upsert.ts` +1 more | 0 |
| 103 | `server-polling-2026-07-26` | 2 | `packages/operator-core/lib/dbos/in-process-periodic.ts` +1 more | 0 |
| 104 | `shared-pot-loop-e2e-testing-2026-06-10` | 2 | `packages/operator-core/lib/deployment/p2p-perf-tier3/run-full-loop.ts` +1 more | 0 |
| 105 | `work-item-mail-surface-retirement-2026-07-26` | 2 | `packages/agent-mcp/dist/bootstrap.js` +1 more | 0 |
| 106 | `workspace-hive-ui-2026-06-17` | 2 | `apps/operator-vite/src/components/adv/AdvShell.tsx` +1 more | 2 |
| 107 | `7d-aware-account-selection-2026-06-17` | 1 | `packages/operator-core/lib/deployment/account-pool.ts` | 0 |
| 108 | `account-cache-affinity-auto-pin-2026-06-16` | 1 | `packages/operator-core/lib/deployment/account-pool.ts` | 0 |
| 109 | `agent-insight-file-citations-on-disk-migr-2026-06-12` | 1 | `packages/operator-core/lib/harness/docs/subject-ref.ts` | 0 |
| 110 | `agentsnet-pilot-2026-06-17` | 1 | `packages/operator-core/lib/external-bench/agentsnet-ingest-cli.ts` | 0 |
| 111 | `cache-expensive-reads-round2-2026-06-23` | 1 | `packages/operator-core/lib/agent-tools/plans/items.ts` | 0 |
| 112 | `capability-terminal-unscoped-slug-fix-2026-06-30` | 1 | `packages/operator-core/lib/agent-tools/capability/terminal.ts` | 0 |
| 113 | `codex-config-rescue-2026-08-14` | 1 | `scripts/repair-codex-home-configs.mjs` | 0 |
| 114 | `cold-carry-self-recall-2026-07-20` | 1 | `packages/operator-core/lib/search/self-session.ts` | 0 |
| 115 | `dark-capability-enforcement-2026-06-21` | 1 | `scripts/check-env-feature-gates.mjs` | 0 |
| 116 | `deploy-pipeline-legibility-2026-06-18` | 1 | `packages/operator-core/lib/agent-tools/dev/pipeline_position.ts` | 2 |
| 117 | `desktop-update-center-2026-07-10` | 1 | `packages/operator-core/lib/endpoint-route/routes/desktop/tutorial-script.ts` | 0 |
| 118 | `deterministic-commit-workitem-attribution-2026-06-20` | 1 | `packages/operator-core/lib/harness/docs/seed-doc-tracking.ts` | 0 |
| 119 | `encapsulation-audit-2026-07-21` | 1 | `packages/operator-core/lib/agent-tools/work_items/claimable.ts` | 0 |
| 120 | `external-bench-grader-feasibility-2026-06-15` | 1 | `packages/operator-core/lib/external-bench/types.ts` | 0 |
| 121 | `fleet-liveness-zombie-await-2026-07-07` | 1 | `packages/operator-core/lib/agent-tools/coordination/presence-wakeability.ts` | 4 |
| 122 | `fleet-members-parked-stall-2026-07-17` | 1 | `packages/operator-core/lib/agent-tools/fleet/leader-brief.ts` | 0 |
| 123 | `fleet-state-2026-06-05` | 1 | `packages/operator-core/lib/agent-tools/fleet/assignments.ts` | 0 |
| 124 | `foreign-work-isolation-sandbox-spec-2026-07-02` | 1 | `packages/operator-core/lib/p2p/sandbox/drill.ts` | 0 |
| 125 | `gateway-mass-outage-storm-guard-2026-07-01` | 1 | `packages/operator-core/lib/agent-tools/turn/interrupt.ts` | 1 |
| 126 | `hiveloop-coding-harness-bees-2026-06-17` | 1 | `packages/operator-core/lib/dbos/orchestrator-finalize.ts` | 1 |
| 127 | `hyperbee-plumbing-2026-05-24` | 1 | `packages/operator-core/lib/sync/hyperbee/health.ts` | 0 |
| 128 | `ingress-timeout-too-short-2026-07-20` | 1 | `packages/operator-core/lib/sync/pot-git/github-egress.ts` | 0 |
| 129 | `instance-spec-2026-06-09` | 1 | `packages/operator-core/lib/instance-spec/genome.ts` | 0 |
| 130 | `liveness-source-of-truth-2026-08-31` | 1 | `packages/operator-core/lib/harness/routines/oddsmith-paper-cycle-action.ts` | 0 |
| 131 | `locks-extraction-2026-05-30` | 1 | `libs/papercusp/packages/locks/src/config.ts` | 0 |
| 132 | `loop-status-display-2026-06-23` | 1 | `packages/operator-core/lib/agent-tools/coordination/tools/glance.ts` | 0 |
| 133 | `mcp-transport-resilience-2026-07-13` | 1 | `scripts/check-no-identity-literals.mjs` | 0 |
| 134 | `mug-memory-hybrid-2026-07-02` | 1 | `apps/operator/prompts/papercusp-su-engineer.tools.md` | 0 |
| 135 | `papercup-herald-2026-06-21` | 1 | `libs/papercusp/packages/harness/blueprints/base/prompts/scanner.md` | 0 |
| 136 | `plan-schedule-blender-steward-heartbeat-2026-08-11` | 1 | `packages/operator-core/lib/system-health/recovery-dependency-audit.ts` | 1 |
| 137 | `pot-network-surface-2026-06-11` | 1 | `libs/papercusp/packages/harness/blueprints/coding/prompts/operator.md` | 0 |
| 138 | `pot-run-evaluation-2026-06-13` | 1 | `libs/papercusp/packages/harness/blueprints/pot-eval/blueprint.yaml` | 0 |
| 139 | `pr-system-completion-dogfood-2026-06-19` | 1 | `packages/operator-core/lib/harness/completion-ref-writer.ts` | 0 |
| 140 | `pui-remediation-ship-2026-08-28` | 1 | `packages/operator-core/lib/harness/routines/fleet-headcount-action.ts` | 1 |
| 141 | `queen-bee-spawn-reclaim-relaunch-2026-06-22` | 1 | `packages/operator-core/lib/fleet/spawn-relaunch.ts` | 0 |
| 142 | `queen-heartbeat-2026-06-16` | 1 | `packages/operator-core/lib/sync-resolver/index.ts` | 0 |
| 143 | `release-distribution-2026-08-03` | 1 | `packages/operator-core/lib/dbos/periodic-workflows.ts` | 0 |
| 144 | `route-everything-through-definetool-2026-06-17` | 1 | `packages/operator-core/lib/external-bench/report/report-builder-pg.ts` | 0 |
| 145 | `scout-rubric-pot-coordination-health-scorecard-2026-06-26` | 1 | `packages/operator-core/lib/scout/mug-notify.ts` | 0 |
| 146 | `search-core-papercup-adoption-2026-05-30` | 1 | `packages/operator-core/lib/agent-tools/search/rerank.ts` | 0 |
| 147 | `seed-history-trim-2026-07-07` | 1 | `apps/operator/lib/release/cut-seed-cli.ts` | 0 |
| 148 | `semantic-push-2026-07-14` | 1 | `packages/operator-core/lib/push-utilization.ts` | 0 |
| 149 | `sentinel-as-herald-2026-06-21` | 1 | `packages/operator-core/lib/voice-prefs.ts` | 2 |
| 150 | `sentinel-tui-shared-backend-and-cards-2026-06-22` | 1 | `packages/operator-core/lib/agent-tools/operator/converse.ts` | 4 |
| 151 | `slack-respond-in-thread-2026-08-22` | 1 | `packages/operator-core/lib/external-triggers/slack-flagship.ts` | 3 |
| 152 | `steering-panel-2026-06-15` | 1 | `packages/operator-core/lib/sync-resolver/index.ts` | 0 |
| 153 | `substrate-sidecar-memory-isolation-2026-07-02` | 1 | `packages/operator-core/lib/sync/hyperbee/substrate-sidecar-spawn.ts` | 0 |
| 154 | `system-improvements-2026-07-12` | 1 | `packages/operator-core/lib/memory/session-epoch-ledger.ts` | 0 |
| 155 | `tool-discovery-for-weak-models-plan-2026-06-30` | 1 | `libs/papercusp/packages/orchestrator/src/invoke.ts` | 0 |
| 156 | `voice-consolidation-2026-07-09` | 1 | `packages/operator-core/lib/endpoint-route/routes/agent-mcp/tts-synth.ts` | 0 |
| 157 | `windows-macos-tutorial-shortcut-parity-2026-07-04` | 1 | `packages/operator-core/lib/desktop-install/papercusp-files.ts` | 0 |

## 5. The deterministic baseline (R12 / R17)

**What it is.** `packages/operator-core/lib/desktop-install/su-render-baseline.test.ts` renders the
PINNED inputs under `desktop-install/__fixtures__/su-render-baseline/` — a frozen copy of
`su.md` (blob `981e5735…`, 75,371 B), the Claude overlay (blob `1daad958…`, 7,716 B) and a 445 B
stub project guide — through the live `renderSuPlaybook` for both tiers, and asserts the
per-`## `-section byte + sha256 table against `baseline.json`. Two renders are byte-identical; the
live `su.md` scores **byte-equivalent** to the pin as of 2026-09-03. Never a live
`~/.papercusp/launch-context/session-*.md` (178,037 B on 2026-09-02, 135,172 B on 2026-09-03 —
those include the per-pot override, the doc-part revision of the day and the session's
mode state).

**How to score a move.** `measureSuRender(text, baseText)` → `scoreAgainstBaseline(current,
baseline.tiers.full)` → `formatScoreTable(score, { onlyChanged: true })`
(`desktop-install/su-render-baseline.ts`; pure, no vitest needed). Re-pin only together with the
change that legitimately moved the render: `BASELINE_UPDATE=1 npm run test:file --
packages/operator-core/lib/desktop-install/su-render-baseline.test.ts`.

**Full tier — 136,083 B, 25 sections** (`generated` = spliced generator, overlay, or notes bundle):

| bytes | origin | section |
|---:|---|---|
| 573 | base | (preamble) |
| 8,691 | base | ## Who you are (+ the 7,716 B client overlay lands here) |
| 7,561 | base | ## Working in a shared environment — coordination is enforced |
| 4,475 | base | ## Working as a fleet MEMBER — the member operating loop |
| 1,277 | base | ## Git — a background routine owns commit + push |
| 14,485 | base | ## Engineering discipline |
| 4,937 | base | ## Anti-babysitting rule — monitoring is not work by default |
| 22,033 | base | ## Default posture (AUTO mode OFF) — plan, then confirm before you execute |
| 6,042 | base | ## Delivery discipline — a dialog ECLIPSES same-turn text; rendered ≠ delivered |
| 12,812 | generated | ## AUTO mode — the owner's switch for "act, don't ask" |
| 7,581 | generated | ## IDEATE mode — the owner's switch for "invent net-new, don't just patch" |
| 4,530 | generated | ## DRAIN mode — the owner's switch for "drain the work queue to terminal" |
| 3,503 | generated | ## AUDIT mode — the owner's switch for "step back and audit the whole picture" |
| 2,326 | base | ## Registering work is a SEPARATE discipline from asking approval — AUTO waives the ask, NOT the register |
| 2,849 | generated | ## Tool results are capped — reduce BEFORE you call, not after |
| 2,333 | base | ## Tools, docs, memory |
| 8,111 | base | ## Coordination: subscribe → ask → file |
| 29 | base | ## Coordination glyph legend |
| 2,278 | generated | ## Coord injection protocol |
| 16 | base | ## Wire schemas (heading only — the legend body is counted with the next generated section) |
| 8,226 | generated | ## The deploy pipeline is ASYNC — … a RED gate is EVERYONE's job to FIX |
| 3,669 | generated | ## Waiting on something? Arm a self-wake LOOP — … |
| 2,017 | generated | ## You can WAKE a peer — … |
| 1,922 | generated | ## Coupling — opt IN to a peer's state, and opt back OUT … |
| 3,783 | generated | ## Read the value; say what you want back |

**Fleet tier — 109,915 B, 22 sections**: identical except the four mode sections (28,426 B) are
replaced by `## AUTO mode — you are in it` (2,261 B) and the wire legend is filtered to the spine
families. Nothing else is stripped — `su.md` carries no FULL-ONLY blocks (F2), so the leader-only
`## Default posture` (22,033 B) still reaches every fleet member. The byte budget for P-020's
"member render is a measured strict subset" is therefore: full − 28,426 + 2,261 − (whatever P-020
moves onto the leader posture).

Slot-bound totals a Part B move is expected to remove from the kernel render, from this table:
mode prose **28,426 B** (P-021); leader posture ≥ **22,033 B** (P-020, `## Default posture`);
member posture **4,475 B** (P-020, `## Working as a fleet MEMBER`); shared-base notes
**19,617 B** (P-020/P-023, of which deploy-pipeline 8,226 B is `domain`).

## 6. The 30 `packages/operator-core/lib/*-policy.ts` modules, by consumer

| module | B | consumer(s) (non-test) | class |
|---|---:|---|---|
| operating-modes-policy | 33,951 | `prompt-assembly.ts`, `desktop-install/papercusp-files.ts` (AUTO-MODE splice) | SHOULD-BE — mode prose (S4c) |
| deploy-pipeline-policy | 1,340 | `prompt-assembly.ts`, `papercusp-files.ts` (notes bundle) | SHOULD-BE — `domain` prose |
| wait-loop-policy | 1,388 | same two | SHOULD-BE — kernel/practice prose |
| peer-wake-policy | 1,333 | same two | SHOULD-BE |
| coupling-policy | 1,504 | same two | SHOULD-BE |
| state-plane-policy | 1,740 | same two | SHOULD-BE |
| account-routing-policy | 1,260 | `prompt-assembly.ts` | SHOULD-BE — chat-role prose (S12) |
| agent-activity-truth-policy | 1,403 | `prompt-assembly.ts` | SHOULD-BE |
| code-run-policy | 1,309 | `prompt-assembly.ts` | SHOULD-BE |
| concurrency-first-policy | 1,547 | `prompt-assembly.ts` | SHOULD-BE |
| evidence-discipline-policy | 1,344 | `prompt-assembly.ts` | SHOULD-BE |
| finish-the-rollout-policy | 1,371 | `prompt-assembly.ts` | SHOULD-BE |
| memory-flush-policy | 1,324 | `prompt-assembly.ts` | SHOULD-BE |
| observation-capture-policy | 1,436 | `prompt-assembly.ts` | SHOULD-BE |
| observation-rubric-policy | 1,408 | `prompt-assembly.ts` | SHOULD-BE |
| plan-discipline-policy | 1,232 | `prompt-assembly.ts` | SHOULD-BE |
| reuse-first-policy | 1,343 | `prompt-assembly.ts` | SHOULD-BE |
| testing-standard-policy | 1,639 | `prompt-assembly.ts` | SHOULD-BE |
| turn-end-observation-policy | 2,693 | `prompt-assembly.ts` | SHOULD-BE |
| turn-yield-policy | 1,024 | `prompt-assembly.ts` | SHOULD-BE |
| work-record-policy | 1,249 | `prompt-assembly.ts` | SHOULD-BE |
| auto-implement-policy | 6,311 | `agent-tools/improvements/set-auto-policy.ts`, `harness/routines/improvement-actions.ts` | CORRECTLY-SEPARATE — dispatch limits (runtime) |
| hive-membership-policy | 7,435 | `hive-membership-admission.ts`, `sync/hyperbee/policy-admission.ts` | CORRECTLY-SEPARATE — admission decision |
| migrate-policy | 3,293 | `agent-tools/db/migrate-policy.ts`, `apps/operator/lib/release/migrate.ts` | CORRECTLY-SEPARATE — deploy-migration rules |
| op-narration-policy | 6,957 | `op-backstory-bank.ts`, `voice-narration.ts` | CORRECTLY-SEPARATE — narration timing |
| opus-budget-policy | 3,006 | `fleet-rate-status.ts`, `agent-tools/fleet/opus-budget.ts`, `deployment/account-pool-store.ts` | CORRECTLY-SEPARATE — spend policy |
| pot-control-policy | 5,973 | `agent-tools/pot/control-policy.ts`, `pot/placement-watchdog.ts` | CORRECTLY-SEPARATE |
| remote-auth-policy | 5,809 | `endpoint-route/**`, `apps/operator/bin/host-app.ts`, `hono-host.ts` | CORRECTLY-SEPARATE — auth |
| scale-policy | 3,311 | `agent-tools/accounts/scale-policy.ts`, `deployment/account-pool-store.ts` | CORRECTLY-SEPARATE |
| vm-release-runtime-policy | 5,693 | `harness/dev-operators.ts`, `apps/operator/bin/host-*.ts` | CORRECTLY-SEPARATE — runtime fail-closed |

Net: **21 of 30 are prompt prose in TS** (the plan's list of 15 + `agent-activity-truth`,
`peer-wake`, `plan-discipline`, `state-plane`, `turn-end-observation`, `operating-modes`); **9 are
runtime policies** that merely share the `-policy.ts` suffix and are out of Phase 3's scope.

## Appendix — reproduction

- Surfaces + sizes: `.papercusp/scratch/su-27188/p018/p018-inventory.txt` (grep/wc, 2026-09-03).
- Dangling citations: `p018-slugs.txt` (1,100) → `p018-dangling.txt` (374, resolved against
  `harness_shared.harness_plans`) → `dangling-filter.mjs` → `p018-dangling-filtered.{md,json}`.
- Baseline: `BASELINE_UPDATE=1` run of the test above; `SU_RENDER_BASELINE_DUMP=<dir>` writes the
  rendered texts and the live-vs-pin score table outside the tree.
- DB reads: `dev:pg_query` — `harness_doc_parts` (papercusp: 302 / 131 / 302), `blueprints`
  (0 rows; positive control `harness_plans` 1,791).
