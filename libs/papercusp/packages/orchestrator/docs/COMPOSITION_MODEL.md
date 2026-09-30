# Blueprint composition model — identities as stackable documents

> Plan `identities-v1-2026-08-30` · item **P-001** (design audit + manifest schema) · work-item
> WI-2143731 · written 2026-09-03 by su-27188c44. Authority: D-006 (one composition system),
> D-013 (an identity IS a blueprint document), D-007 as amended (slots, not tiers), the D-008
> amendment (one exclusive slot per mode axis), D-011 (one bundling model), D-004 / D-014
> (grants reserved until M3), D-016 (Phase 3 scope), P-001's own **D-017**, and P-032's
> **D-018** (§8 — the legacy replacement-system-prompt composer is SUBSUMED, not a third path).
>
> This document describes `src/blueprint/{schema,slots,merge-rules,loader,validate}.ts` as
> built. The slot table below is **pinned** to `slots.ts` by `slots.test.ts` (it must equal
> `renderSlotRegistryMarkdown()` byte-for-byte), and the merge-rule claims are pinned by
> `merge-rules.test.ts`; the prose cannot describe a registry other than the one that ships.

## 1. The document model

There is one document kind: the blueprint (`BlueprintSchema`). An **identity** is a blueprint
document that declares the **slots** it fills — `slots:` present (even `[]`) ⇒ identity;
absent ⇒ ordinary blueprint (`isIdentityDocument`). Nothing else is new: the same loader
(`loadBlueprintFromFile` / `resolveBlueprint`), the same `extends` walk, the same per-harness
projection (`harness_shared.blueprints`), the same Cupboard `blueprint` listing kind and
`blueprint:publish` / `cupboard:install-blueprint` flows (D-013).

P-001 adds five sections to the schema:

| field | shape | rule |
|---|---|---|
| `slots` | `[{ slot, cardinality? }]` | `slot` is an OPEN string checked against the registry by `validateBlueprint` (`slot-unknown`, mirroring `unknown-op`): a new axis is a registry row, never a document-format change, and an installed identity naming a slot this platform lacks fails diagnosably. `cardinality` is optional and, when restated, must agree with the registry (`slot-cardinality-mismatch`) — the registry is authoritative, so the two copies cannot drift. |
| `bundles` | `[{ kind, ref, version? }]`, default `[]` | ONE uniform by-reference list for every distributable layer (D-011); `kind` is the CLOSED vocabulary `BUNDLE_KINDS` — no `skill` kind. `(kind, ref)` is unique per document (`bundle-duplicate`). Composes by union across a stack. |
| `grants` | `{ requires[], optional[], suggestedProviders{} }` | Exact capability `class@version` requirements. Required classes block install when absent; optional classes remain visible gaps; provider suggestions are defaults, never conformance or authorization. The effective toolset remains grants ∩ pot/role ceiling. |
| `publisher` | `{ id, name?, url? }` | layer metadata (the resolved document carries the leaf's). |
| `attestation` | `{ contentHash, signedBy, signature?, signedAt? }` | publisher attestation over THIS layer: `contentHash` must equal the layer's own hash (§4); the signature binding lands in M2 on `lib/identity/attest.ts` + `hive-keypair.ts`. |

Engine and autonomy defaults stay on the EXISTING `knobs.aiBackend.roles` / autonomy sections
(P-025) — never a parallel field. `extends` (the stack) and `version` already existed.

## 2. The slot registry

<!-- SLOT-REGISTRY:BEGIN -->
Layering order: `kernel` → `client` → `domain` → `fleet-posture` → `modes` → `practices` → `instance` (reserved, no declarable slot: `kernel`, `instance`).

| slot | cardinality | layer | fills | ruling |
|---|---|---|---|---|
| `client` | exclusive | client | the per-client tooling overlay (Claude / Codex / OMP) — the section the su prompt hand-splices today as CLIENT-TOOLING-OVERLAY | D-007 amendment 2026-09-03 |
| `domain` | exclusive | domain | the profession: what the work IS and how it is judged (papercusp-engineer, potato-salesman) — the engineering-discipline text of su.md | D-007 ("exactly one profession per agent" becomes "the domain slot is exclusive") |
| `fleet-posture` | exclusive | fleet-posture | the fleet ROLE playbook — member pull-loop style or leader monitoring / benching / claim-spec craft; the fleet PROTOCOL invariants stay kernel | D-003 (playbooks leave the kernel) + D-007 (member-vs-leader is one exclusive slot) |
| `autonomy` | exclusive | modes | the domain flavour of AUTO mode prose (state + what AUTO suspends stay kernel) | D-008 amendment 2026-09-03 (one exclusive slot per mode axis) |
| `ideation` | exclusive | modes | the domain flavour of IDEATE mode prose | D-008 amendment 2026-09-03 |
| `objective` | exclusive | modes | the domain flavour of DRAIN mode prose (the DRAIN ⇒ AUTO implication is kernel) | D-008 amendment 2026-09-03 |
| `grade` | exclusive | modes | the GRADE evaluation and repair practice; scoring and independent acceptance remain host-enforced | SU mode/identity unification P-003 (2026-09-24) |
| `test` | exclusive | modes | the TEST independent-verification practice; test subjects and permissions remain host-enforced | SU mode/identity unification P-003 (2026-09-24) |
| `goal` | exclusive | modes | the GOAL planning and delegated-execution practice; subject and authority remain host-enforced | SU mode/identity unification P-003 (2026-09-24) |
| `audit` | exclusive | modes | the domain flavour of AUDIT mode prose (read-only-toward-subject enforcement is kernel) | D-008 amendment 2026-09-03 |
| `audience` | exclusive | modes | who the agent is speaking to — the engineer-mode / novice-mode personas that `loadRoleModePersona` resolves from files today | D-008 (unify the second mode axis) + amendment 2026-09-03 |
| `collaboration-stance` | exclusive | practices | how the agent works WITH the owner — the collaborator stance of su.md (address by name, confirm-before-execute posture, delivery discipline) | D-017 (P-001 ruling): exclusive — two stances toward one owner conflict rather than stack; sits on the practices layer per D-007’s order |
| `practice` | additive | practices | a stackable working practice (compaction protocol, wait-loop discipline, peer-wake craft, …) | D-007 ("practices stack because their slot is additive") |

Bundle kinds (`bundles[].kind`, D-011): `recipe`, `rubric`, `knowledge-pack`, `plan`, `goal`, `datatype`, `event`, `rule` — no `skill` kind (owner ruling 2026-09-02).
<!-- SLOT-REGISTRY:END -->

**Why a registry and not a `kind`.** What the profession/facet TYPE split encoded was a
cardinality constraint on one slot; two package kinds paid for one rule with two lifecycles
(D-007). A new axis is one row in `SLOT_SPECS` (typed exhaustively against `SLOT_IDS`, so a
slot without a spec is a compile error). **Why `kernel` and `instance` are layers, not slots.**
The kernel is sealed (D-009 / P-003) and the instance tier is the per-pot override
(`pot_settings.promptOverride.<role>`, audit S5); a document claiming either is refused
(`slot-reserved-layer`). **Why mode axes are five exclusive slots.** Modes stack ACROSS axes
(`auto + ideate`, `drain ⇒ auto`) and are exclusive WITHIN one; a single `mode` slot would make
`mode:set ideate` on an AUTO session a composition failure (D-008 amendment). Mode STATE and
the implication table stay in `modes/registry.ts`; authority is computed by
`instruction-lint.ts` and enforced at the dispatch chokepoint — identity text is never an input.

## 3. Composition: a stack is an ordered `extends`

A **stack** is the existing ordered multi-parent `extends` array (`schema.ts`
`extends: z.union([z.string(), z.array(z.string())])`); `resolveLayers` walks it depth-first,
parents before children, and returns every merged document as a `BlueprintLayer` (id,
sourcePath, contentHash, attestation, slots) in merge order. Precedence ascends along that
list; the renderer (`render-stack.ts` `composeStack`, P-003 — §10) walks layers in layering
order (§2) and renders the kernel LAST under an explicit precedence statement (the seal).

**Merge algebra (`merge-rules.ts`, consumed by `merge.ts` — P-019).** Every leaf of `BlueprintSchema`
(145 as of 2026-09-03; a LEAF is a scalar field, a whole array, a whole record, a union, a lazy
schema, or an object's `.catchall` keys as `<path>.*`) has ONE declared rule in `MERGE_RULES`;
`merge-rules.test.ts` fails on a leaf with no rule and on a rule naming no leaf. The rules:

| rule | meaning | where |
|---|---|---|
| `replace` | the child's value wins when set; absent inherits — the pre-P-019 `mergeRaw` for scalars / arrays | the default |
| `union` | set-union: arrays by `key` (a field or tuple) or structural value; records by key. A key or keyed element present on BOTH sides deep-merges (`mergeRaw`): a record composes exactly as before, a restated role / slot / bundle overrides the fields it names and inherits the rest | every record; `bundles` (key `[kind, ref]`), `grants.requires`, `grants.optional` (D-003 / D-011); the declaration sets `roles` (key `id`), `reactive`, `gym.signals`, `dependencies.*` (D-020) |
| `most-restrictive` | the TIGHTER value wins regardless of order (numeric caps: min) | `spine.maxTurns`, `recursion.maxDepth`, `knobs.maxCostUsd`, `knobs.parallelWorkers.max`, `knobs.parallelWorkers.maxFeaturesInFlight`, `dispatch.costCapUsd`, `dispatch.safetyCeiling` (D-003) |
| `hard-error` | keyed union in the document PLUS a stack-level refusal: a key claimed by two DISTINCT layers fails the load; cardinality-aware for `slots` | `slots` only (D-007) |

**The merger (`merge.ts`, P-019).** `resolveLayers` composes a stack pairwise with
`mergeByRules`, which descends the schema's object nodes (`schemaInteriorPaths` — every proper
prefix of a leaf path) and applies `mergeRuleFor(path)` at each leaf; a key outside the schema
composes by `mergeRaw` as before. The graph is unchanged — parents depth-first, pairwise, the
child last — only the algebra moved. The default assignment REPRODUCES `mergeRaw`, and
`merge.test.ts`'s GOLDEN proves it: every builtin blueprint resolves to the same document under
both walks. The cap rule turns a parent-200 / child-500 `maxTurns` into 200 — the intended fix,
asserted explicitly; the one builtin parent whose children RAISED a cap under last-writer-wins
(`single-agent`, `spine.maxTurns` 40 → children 60/80/200) was re-authored to the loosest bound
(200) so the rule clamped no live blueprint, and a second golden fails if any template ever
tightens a child again (D-020). The one place the algebra is stricter than `mergeRaw` is an
object-valued CATCHALL key (`knobs.someUnknownKnob: {…}` on two layers): `knobs.*` is `replace`,
so the child's opaque value wins whole (no builtin sets one). `mergeRuleFor(path)` resolves a
concrete document path: exact entry, else the nearest enclosing catchall (`knobs.foo` →
`knobs.*`). `params` stays a record (D-020): its keys ARE the config.json dot-paths the settings
panel reads and writes, so key-union is the declared rule, not a workaround.

**Slot conflicts are checked on the STACK, not the merged document.** `mergeByRules` unions
`slots` across the stack (keyed by `slot`), so the resolved document lists every slot the stack
fills — what the renderer walks. The DISTINCT-claimant refusal needs layer identity a merged
document no longer carries, so `resolveBlueprint` derives the claims from `layers[].slots` and
fails the load on `findExclusiveSlotConflicts` (`slot-exclusive-conflict`): two DISTINCT
documents on one exclusive slot conflict; the same document reached twice (a diamond) is one
claimant; additive slots stack; unknown slot ids are validation's job (`slot-unknown`).

## 4. Per-layer content hash and attestation

`layerContentHash(raw)` is sha256 over the layer's OWN raw document with `attestation`
removed (sorted-key stable), so a publisher can sign a document that then carries its own
attestation. `blueprintHash` remains the hash of the RESOLVED document (the projection's
`content_hash`). `resolveBlueprint` verifies every layer's `attestation.contentHash` against
its computed hash and refuses the load on disagreement (`attestation-hash-mismatch`). The
lockfile (M2, P-005) extends the existing dep-validation pin record with these per-layer hashes.

## 5. Splice-seam design — how the stack enters each render tier

The four assemblers (audit §1–§2) stay code; each gains ONE seam where the ordered layer list
replaces the hand-spliced sections. Client is an axis of the stack, not of the assembler.

| tier | assembler today | what the stack replaces there | owning items |
|---|---|---|---|
| interactive psu | `packages/operator-core/lib/desktop-install/papercusp-files.ts` `renderSuPlaybook` — splice steps 1–11 over `blueprints/base/prompts/su.md` (audit §1) | step 1 CLIENT-TOOLING-OVERLAY → the `client` layer; the engineering-discipline text of su.md → `domain`; `## Working as a fleet MEMBER` / `## Default posture` → `fleet-posture` (attached by `fleet:launch-on-plan` / `fleet:take-leadership`); step 6 AUTO-MODE → the five mode-axis layers, attached from `mode:set`; step 9 SHARED-BASE-NOTES + step 8 COMPACTION → `practice` layers; the collaborator stance → `collaboration-stance`; `pot_settings.promptOverride.su` (S5) stays the instance tier; the kernel renders last with the seal. Generated sections (WIRE-SCHEMAS, COORD-LEGEND, RESULT-DOOR, WORKSPACE-MAP, PROMOTION-MODEL, PROJECT-GUIDE) remain derived and are spliced by marker — P-024 first restores the 5 missing markers (F2). | P-003, P-020, P-021, P-024 |
| autonomous spawn (bees) | `libs/papercusp/packages/orchestrator/src/prompt-build.ts` (S9) | the same layer list; the inline nudge constants become `practice` documents; the kernel base text is `blueprints/base/prompts/agent-base-preamble.md` (P-032 SUBSUME) | P-023, P-032 |
| chat-surface roles | `packages/operator-core/lib/prompt-assembly.ts` (S10/S11) | `PROMPT_ROLES` resolve through the chain with the file tier as lowest-precedence fallback; `loadRoleModePersona`'s engineer/novice files become the `audience` layer | P-023, P-021 |
| harness spawn | `libs/papercusp/packages/orchestrator/src/prompt-resolve.ts` (S6) | already the chain walk (`blueprints/<id>/prompts/<role>.md` up the chain, then base); `agent-base-overlay.md` becomes the `domain` leaf; `.materialized/**` is never the live path | P-032, P-003 |

**Client axis.** Exactly one `client` document per launch — Claude / Codex / OMP — selected by
the launcher's `agent` argument (today `apps/operator/prompts/papercusp-su.<agent>.md`, S2, plus
the out-of-repo mirrors S14). Claude's `CLAUDE.md` auto-load and the
`~/.papercusp/compaction-strategy.md` include are COMPENSATIONS for the dropped sections (F2),
retired by P-024 once the markers are present; Codex/OMP get the same content through the layer
list with no mirror.

**Runtime attach / detach (P-012).** Additive and mode-axis layers attach inject-now through
the existing mode-flip channel and appear in the next full render; a `domain` swap is a
relaunch-with-carry; a `fleet-posture` swap follows inject-now under the exclusive-slot rule.
Only mode PROSE moves; state and implications stay in the registry. The primitive, the delivery
table and the channel are §11.

## 6. The projection: `harness_shared.blueprints` is POPULATED, not dropped (D-016 §3 → D-017)

Audit finding F3 / row S20 said "nothing reads it today". **That was wrong** (corrected in the
audit and in D-017): `getEffectiveBlueprint` (`packages/operator-core/lib/blueprint/project-to-pg.ts`)
reads the cache and lazily projects `<harness>/.papercusp/blueprint.yaml` on a miss, and is
called from `dbos/orchestrator-loop.ts` `resolveHarnessDispatchGate`, `blueprint/blueprint-run-action.ts`
and `harness/routines/gym-actions.ts`; `harness/improvements/watchdog.ts` reads it as
`blueprint_wired`; `blueprint/commit-reproject-real.ts` writes it. The table is empty on this
box because (a) this repo has no `.papercusp/blueprint.yaml` (S21 — P-024 creates it), so the
papercusp pot never projects, and (b) the lazy path only fires from those callers, with errors
swallowed (`.catch(() => null)`). Measured 2026-09-03: 9 of 10 sibling harness blueprints load
cleanly through the loader; `brood-box-alpha` fails `cannot resolve extended blueprint "pot"`
(filed). Ruling: POPULATE via the existing lazy projector + `commit → reproject` path; M2's
identities read the same projection; no new store.

## 7. Boundary — what P-001 deliberately leaves to its neighbours

- **P-019** (DONE, D-020) replaced `mergeRaw` with the `MERGE_RULES`-driven merger
  (`merge.ts`), added the fast-check properties (union commutative + idempotent;
  most-restrictive commutative; replace order-dependent by design) and the golden over every
  builtin, unions `slots` across layers, and moved `roles` / `reactive` / `gym.signals` /
  `dependencies.*` to union.
- **P-002** assigns su.md's sections to these slots; **P-003** seals the kernel and renders the
  stack; **P-012** attaches/detaches layers at runtime; **P-032** subsumed the second composer
  (§8, D-018).
- **P-016 (M3)** provides the versioned class registry and attested provider bindings; **P-017** validates exact grant refs, resolves provider choices at install, and pins the exact pot provider in the immutable specification closure.

## 8. The spawn replacement composer — subsumed, not a third path (P-032 / D-018)

`src/prompt-resolve.ts` `resolveReplacementSystemPrompt` already composes a REPLACEMENT system
prompt for a spawn: the neutral base preamble, then the SINGLE most-specific blueprint overlay
walking the `extends` chain leaf-first (`base` excluded; first hit wins), joined
`trim + "\n\n" + trim + "\n"`. That is D-002's kernel + overlay model on the spawn tier,
shipped under domain-generic-agent-personas P-009/P-010/P-013, and it maps onto the stack
without remainder:

| file (live read path, under `libs/papercusp/packages/harness/`) | layer / slot | notes |
|---|---|---|
| `blueprints/base/prompts/agent-base-preamble.md` | **kernel** — the kernel's BASE text | domain- and tier-neutral ring-0 topics (Harness · Tools+MCP startup · Blockers · Diagnose-from-evidence · Mitigation≠fix · Context · Environment · Memory). Rendered on EVERY tier; su.md's ring-0 sections are kernel EXTENSIONS of the interactive tier and P-002 keeps an overlapping paragraph once, here. |
| `blueprints/<id>/prompts/agent-base-overlay.md` | **`domain`** — the slot's LEAF document | exclusive; the chain walk's first-hit rule IS the exclusive-slot resolution. Two exist: `blueprints/coding-factory/prompts/agent-base-overlay.md` (the retired factory's) and, since P-002, `blueprints/papercusp-engineer/prompts/agent-base-overlay.md` (§9 — the identity's verbatim extraction). The coding HIVE (`blueprints/coding`) still has no domain leaf (EI-22285277325728666): attaching the papercusp-engineer identity to it is P-003 / P-023, not P-002. |

**Delivery is unconditional (P-035 / WI-2143907).** Claude spawns always replace the Claude Code
default coding prompt: `--system-prompt-file` for bees in `invoke.ts`, and
`--system-prompt-file` plus `--exclude-dynamic-system-prompt-sections` for psu sessions in
`apps/operator/scripts/psu-launcher.mjs`. OMP uses its corresponding `--system-prompt` form;
Codex already takes the per-session `CODEX_HOME/AGENTS.md` as its whole prompt. There is no
append/replace feature flag or env thread. An append branch would put unsealed client prose ABOVE
the kernel and contradict the seal.

**Subsumed (P-003, landed).** `resolveReplacementSystemPrompt` IS now a thin call into the
renderer: `resolveReplacementSystemPromptStack` selects the stack `[domain(overlay)?, kernel(preamble)]`
(the same preamble tier-walk and the same first-hit overlay rule as before) and `composeStack`
renders it under the SEAL (§10) — the overlay ABOVE the precedence statement, the kernel base text
LAST. The documents are byte-verbatim (trimmed, one blank line between blocks, one trailing
newline — the old formula's bytes); only their ORDER changed, because "kernel renders
authoritatively and last" is the seal. `prompt-resolve.test.ts` ("P-032/D-018 …") pins the
selection over the REAL tree and that this section names the two live paths above.

The retired flag was only a DELIVERY switch, never a second composer. WI-2143907 removed its
legacy env threading and both launchers' append branches after the sealed
selection/order golden above turned green. `apps/operator/dist-*/**`,
`papercusp-desktop/src-tauri/**/harness/**` and `.materialized/**` copies of both prompt files are
projections, never the live read path.

## 9. The su decomposition — kernel / identity / instance boundary as slot assignments (P-002)

`src/blueprint/su-decomposition.ts` classifies EVERY line of `blueprints/base/prompts/su.md`
(the LIVE su render source — P-002 does not cut it; P-003 switches the render) into TILES,
each assigned to one PART: the sealed `kernel`, the reserved `instance` layer, or a declarable
slot from §2. A tile is addressed by its ANCHOR — the exact text of its first line — and runs to
the line before the next anchor, so the tiling is complete by construction, an edit inside a
tile moves nothing, and a NEW `##`/`###` section or splice marker fails
`su-decomposition.test.ts` until it is classified (a new bullet inside an existing tile
inherits that tile's part — the granularity limit, and the one place a reviewer still looks).
D-003 as narrowed by D-007 decides the fleet split: claims honoured, gate events, stand-down
obeyed and completion evidence stay kernel; the member pull-loop and the leader's
monitoring / benching / kickoff / spawn-announcement craft become the two `fleet-posture`
candidates. D-018 §4 decides the overlap with `agent-base-preamble.md`: a tile that duplicates
a preamble section is marked as a dedupe row — kept in su.md while it is the live render,
kept ONCE (in the preamble) by P-003's seal. The part documents are DERIVED, byte-equal to the
concatenation of their tiles, and committed only so an identity has a file on disk — the
`papercusp-engineer` domain leaf is the coding hive's future domain document (§8, D-018 §5).

<!-- SU-DECOMPOSITION:BEGIN -->
Source: `blueprints/base/prompts/su.md` — tiled by ANCHOR (the exact first line of each tile; every `##`/`###` heading and every `<!-- PAPERCUSP-SU:… -->` splice marker must be one). 46 tiles → 7 verbatim part documents + the `client` seam.

| # | part | tile | anchor | preamble dedupe (D-018 §4) | why |
|---|---|---|---|---|---|
| 1 | `kernel` | title + provenance blockquote | `# Superuser engineer-collaborator (su) — domain-neutral base persona` | — | The document’s own framing — "the universal how-we-work-together spine … for ANY pot" — is the kernel’s self-description; P-003’s seal restates it for the composed stack. |
| 2 | `kernel` | authority grant (operator + admin) · "the domain comes from the pot" | `## Who you are` | — | The su tier’s authority level is a safety rail every layer inherits, and "the domain of that work comes from the pot" is the composition statement itself (D-002 kernel + overlay). |
| 3 | `collaboration-stance` | address the owner by name | `**Address the owner by name.** When you speak TO the owner — a report…` | — | D-017 names "address by name" as the collaboration-stance slot’s content. |
| 4 | `client` | ⟨seam `CLIENT-TOOLING-OVERLAY`⟩ client-overlay splice seam | `<!-- PAPERCUSP-SU:CLIENT-TOOLING-OVERLAY -->` | — | su.md carries only the seam; the `client` slot’s documents are the per-client overlays `apps/operator/prompts/papercusp-su.{claude,codex,omp}.md` that `renderSuPlaybook` splices here (D-007 amendment; audit S2). |
| 5 | `kernel` | locks · claim-before-edit · await-don’t-poll · wake the owner · yield · directed messages outrank | `## Working in a shared environment — coordination is enforced` | — | Lock discipline, claims, event/wake semantics and the directed-message priority are D-003’s protocol invariants — everything whose violation harms OTHER agents. |
| 6 | `fleet-posture` (member) | member loop: wake bootstrap · pull via scheduler:get_next · claim via wip-flip | `## Working as a fleet MEMBER — the member operating loop` | — | D-003: the member PULL-LOOP operating style leaves the kernel and becomes the member posture (P-020). |
| 7 | `kernel` | completion evidence is a structured object; assumptions required | `- **Finish with work_items:complete { id, completion, state:'done', …` | — | D-007’s narrowed kernel: "completion evidence required" is an invariant, not member style. |
| 8 | `fleet-posture` (member) | member loop: persist with loop:arm · register the pool-refill watch · push beats polling · report exceptions to the leader | `- **Persist with loop:arm; each wake pull + advance one unit. Lane …` | — | Member operating style (D-003); the await/emit PROTOCOL it uses is already kernel in the shared-environment section. |
| 9 | `kernel` | claims honoured · a gate opens on the leader’s event (latch) · wind-down on stand-down | `- **Never contest a live peer's claim** — a claim_conflict means co…` | — | D-007’s kernel invariants verbatim: claims honoured, gate events, stand-down obeyed. Phrased for members, binding for every agent. |
| 10 | `domain` | git-sync owns commit + push · edit only the canonical staging tree | `## Git — a background routine owns commit + push` | — | Source-control convention of the software-engineering profession (D-007: the domain slot = "what the work IS and how it is judged"); the named worktrees are instance colour the project guide already carries. |
| 11 | `kernel` | ⟨seam `WORKSPACE-MAP`⟩ workspace-map splice seam | `<!-- PAPERCUSP-SU:WORKSPACE-MAP -->` | — | The map is derived from the live workspace-path contract; the marker is kernel addressing, never copied domain prose. |
| 12 | `kernel` | ⟨seam `PROMOTION-MODEL`⟩ promotion-model splice seam | `<!-- PAPERCUSP-SU:PROMOTION-MODEL -->` | — | The promotion section is derived from release configuration; its seam stays in the kernel so the domain identity remains marker-free when used as a standalone system-prompt overlay. |
| 13 | `domain` | section heading | `## Engineering discipline` | — | The domain document’s own heading; its kernel-classified bullets are tiled out individually below. |
| 14 | `kernel` | plan-store lifecycle: plan-before-work tiers · activation audit · encode real deps | `- **Plan before non-trivial work.** Durable plans live in the plan st…` | — | Registration + plan-lifecycle discipline holds for ANY domain (a potato-salesman pot plans too); it is the "Registering work" tier rule stated at plan scope. |
| 15 | `domain` | tests ship with the feature | `- **Tests ship WITH the feature**, in the project's testing framework…` | — | How engineering work is judged (D-007 domain). |
| 16 | `kernel` | raw forensic output never enters agent context | `- **Raw forensic output (journalctl, psql dumps, proc scans) never en…` | — | Context hygiene is a ring-0 concern (the preamble’s "Context management" family), domain-neutral. |
| 17 | `kernel` | a blocker is work, not a stop sign | `- **A blocker is work, not a stop sign — resolve it, don't relay it.*…` | `# Blockers` | Ring-0; near-verbatim in the preamble — kept once there (D-018 §4). |
| 18 | `kernel` | read the writer before reporting a number · a retraction is owed fast | `- **Before you report a number, find the code that WRITES it.** A met…` | — | Faithful reporting is the interactive tier’s EXTENSION of the preamble’s "Diagnose from evidence" — not duplicated there, so it stays a kernel extension. |
| 19 | `kernel` | never blame high load without the mechanism | `- **Never blame "high load" without the mechanism.** Even when load i…` | `# Diagnose from evidence, not a plausible story` | Near-verbatim in the preamble’s diagnose section — kept once there (D-018 §4). |
| 20 | `domain` | a red gate has one fixer · LIVE_GATE_OPS vs GATE_SYSTEM_DEV · three hops to green | `- **A red release/CI gate has exactly ONE fixer — READ OWNERSHIP BEFO…` | — | Release-gate craft of the engineering profession; the single-fixer claim it rests on is kernel already (claims honoured). |
| 21 | `kernel` | a mitigation is not a fix | `- **A mitigation is not a fix — don't stop at the band-aid.** Discove…` | `# Fixing what you find — a mitigation is not a fix` | Near-verbatim in the preamble — kept once there (D-018 §4). |
| 22 | `kernel` | confirm before hard-to-reverse actions · report outcomes faithfully | `- **Confirm before hard-to-reverse or outward-facing actions** unless…` | `# Tools and MCP startup` | The preamble carries this paragraph (at the end of its "Tools and MCP startup" section) — kept once there (D-018 §4); the stance document’s confirm-before-execute posture is the Default-posture gate, not this line. |
| 23 | `domain` | alpha bias · flags default ON · reuse-first · app templates mandate | `- **In alpha, timidity is the failure mode, not breakage** — but this…` | — | Engineering execution bias, feature-flag policy, reuse-first and the template mandate are how THIS profession builds (D-007 domain). |
| 24 | `practice` | anti-babysitting: monitoring is not work by default | `## Anti-babysitting rule — monitoring is not work by default` | — | A stackable working practice (D-007: "practices stack because their slot is additive") — the wait-loop / monitor discipline family. |
| 25 | `domain` | the papercusp-way routing gate (intent → mechanism table) | `### The papercusp-way routing gate (intent → mechanism)` | — | Reuse-first applied to platform mechanisms — the engineer’s "name the mechanism before hand-rolling" discipline; its rows are engineering asks. |
| 26 | `collaboration-stance` | a plan is a proposal, not authorization | `## Default posture (AUTO mode OFF) — plan, then confirm before you ex…` | — | D-017: the confirm-before-execute posture toward the owner is the stance slot. |
| 27 | `collaboration-stance` | the WHO/route ask (A–D) · never offer an unconfirmed route · ask even if obvious · batch the asks · fleet-knob disclosure · confirm write-side calls · sticky route | `- **Confirm the execution route BEFORE executing — always offer these…` | — | The authorization gate is stance (the owner chooses WHO runs the work). The fleet-launch mechanics inside options C/D ride along at this granularity; P-020 may lift them into the leader posture with a cross-reference. |
| 28 | `fleet-posture` (leader) | leader craft: claim leadership first · leading ⇒ AUTO + monitor (push first) · fleet:invariant · bench · re-read the ledger · kickoff = mission delta · declare the gate | `- **When the owner designates you a fleet's leader, CLAIM it as your …` | — | D-003: leader monitoring / benching / claim-spec / kickoff craft leaves the kernel. Should "leading ⇒ AUTO" become a registry implication it moves to the kernel’s modes table (D-008); the craft stays posture. |
| 29 | `fleet-posture` (leader) | spawn announcement: account routing · model · carry (prediction vs remediation rail) | `- **Spawning a fleet/agent? ANNOUNCE the account + model + carry you'…` | — | Spawn-time disclosure is leader craft; the one hard rail inside it (fix a MEASURED outage) is stated as posture, not kernel, because only a spawner exercises it. |
| 30 | `collaboration-stance` | the AUTO boundary of the ask gate · client mirrors are projections of this section | `These asks are exactly what AUTO mode suspends — and the boundary is …` | — | Closes the stance section: what AUTO suspends is kernel STATE (D-008), but which asks it suspends is this stance’s own boundary. |
| 31 | `collaboration-stance` | delivery discipline: park content then ask · never announce a future question · rendered ≠ delivered · artifact URLs | `## Delivery discipline — a dialog ECLIPSES same-turn text; rendered ≠…` | — | D-017 names "delivery discipline" as stance content. The Claude-Artifact bullets are client colour a client overlay may absorb in P-003. |
| 32 | `collaboration-stance` | owner-directive capture rail: every owner turn an OPEN verbatim row · done or declined(+reason) · forced summary over the cap | `## Owner directives — durable capture and resolution` | — | The section’s own claim — "a capture rail, not a paraphrase rail: the database stores the owner’s literal words" — is fidelity to the owner, which is exactly what D-017 puts in the stance slot beside "address the owner by name" and the delivery discipline it follows in file order. It is deliberately NOT kernel: the ledger verbs are platform protocol, but the obligation this tile states is about the OWNER relationship (never paraphrase them, never silently drop what they said), and a pot with no interactive owner inherits the verbs without inheriting the stance. |
| 33 | `kernel` | ⟨seam `AUTO-MODE`⟩ modes KERNEL splice seam (state · registration · implication table · authority) | `<!-- PAPERCUSP-SU:AUTO-MODE -->` | — | P-021: the splice renders the KERNEL half of the modes from `modes/registry.ts` — state, how a flip is registered, the implication table, authority computed by instruction-lint (D-008). The mode DEFINITIONS are identities on the axis slots (`su.mode-*`, `mode-identities.ts`) rendered in the `modes` layer only while the mode is ON. |
| 34 | `practice` | ⟨seam `COMPACTION`⟩ agent-managed compaction practice splice seam | `<!-- PAPERCUSP-SU:COMPACTION -->` | — | Compaction is a stackable context-management practice; the generated protocol is spliced after the stack is composed. |
| 35 | `kernel` | registering work: trivial / substantive / big-scope tiers | `## Registering work is a SEPARATE discipline from asking approval — A…` | — | Work-item registration discipline is D-007’s "completion evidence required" seen from the front — kernel. |
| 36 | `kernel` | ⟨seam `RESULT-DOOR`⟩ result-door splice seam (tool results are capped) | `<!-- PAPERCUSP-SU:RESULT-DOOR -->` | — | Tool-result envelope semantics (`projection`) are platform protocol — kernel. |
| 37 | `kernel` | verbs are MCP tools, never curl · docs-first | `## Tools, docs, memory` | `# Tools and MCP startup` | Platform tool protocol; the preamble’s MCP-startup section already forbids hand-rolled HTTP — kept once there (D-018 §4). |
| 38 | `instance` | editing a persona: read the su render/edit-path runbook | `- **Editing an agent prompt/persona? Read the runbook BEFORE you grep…` | — | A papercusp-REPO runbook (this prompt tree’s layering); the project guide is the instance layer and already carries "Prompts are auto-generated — edit the source". |
| 39 | `kernel` | memory layers (memory:remember · facts:assert · checkpoints · coord) · push, don’t poll | `- **Memory has layers — route by DELIVERY, not habit.** A durable but…` | `# Memory` | Ring-0 memory routing; the preamble’s Memory section carries the shared-store rule — kept once there (D-018 §4). |
| 40 | `kernel` | coord protocol: decisions · coord verbs · @-selectors · read surfaces · state vs history · file what you discover | `## Coordination: subscribe → ask → file` | — | Coordination protocol (D-003 invariants + the D-007 completion/decision substrate) — kernel. |
| 41 | `kernel` | glyph legend heading | `## Coordination glyph legend` | — | The coord injection protocol is kernel. |
| 42 | `kernel` | ⟨seam `COORD-LEGEND`⟩ coord-legend splice seam | `<!-- PAPERCUSP-SU:COORD-LEGEND -->` | — | Generated glyph key — kernel protocol. |
| 43 | `kernel` | wire schemas heading | `## Wire schemas` | — | Prompt-declared column schemas are tool protocol — kernel. |
| 44 | `kernel` | ⟨seam `WIRE-SCHEMAS`⟩ wire-schemas splice seam | `<!-- PAPERCUSP-SU:WIRE-SCHEMAS -->` | — | Generated wire schemas — kernel protocol. |
| 45 | `kernel` | ⟨seam `SHARED-BASE-NOTES`⟩ shared base notes splice seam | `<!-- PAPERCUSP-SU:SHARED-BASE-NOTES -->` | — | The explicit anchor for the shared deploy/wait/wake/coupling/state protocol bundle; it replaces the silent append fallback. |
| 46 | `instance` | ⟨seam `PROJECT-GUIDE`⟩ addressed project-guide splice seam | `<!-- PAPERCUSP-SU:PROJECT-GUIDE -->` | — | The project guide is the pot-specific instance layer selected for the wearer’s stack, not an identity document. |

Part documents (each is BYTE-EQUAL to the concatenation of its tiles — `npm run gen:su-decomposition` rewrites them from su.md, `:check` and the test refuse drift):

| document | part | path (under `libs/papercusp/packages/harness/`) | role in the model |
|---|---|---|---|
| `su.kernel` | `kernel` | `blueprints/base/prompts/su.kernel.md` | the interactive tier’s KERNEL EXTENSION — composed after agent-base-preamble.md (the kernel base text) by P-003’s seal; its dedupe tiles are dropped there |
| `papercusp-engineer` | `domain` | `blueprints/papercusp-engineer/prompts/agent-base-overlay.md` | identity #1 — the `domain` leaf of blueprints/papercusp-engineer (D-018 §5: the coding hive’s missing domain document; attached by P-023, not here) |
| `su-collaborator` | `collaboration-stance` | `blueprints/su-collaborator/prompts/collaboration-stance.md` | identity #2 — the `collaboration-stance` document of blueprints/su-collaborator (exclusive per D-017) |
| `su.fleet-member` | `fleet-posture` (member) | `blueprints/su.fleet-member/prompts/fleet-posture.md` | identity #3 — the `fleet-posture` document of blueprints/su.fleet-member (P-020; exclusive per D-003/D-007): attached at fleet:launch-on-plan / fleet:join, resolved through the prompt chain |
| `su.fleet-leader` | `fleet-posture` (leader) | `blueprints/su.fleet-leader/prompts/fleet-posture.md` | identity #4 — the `fleet-posture` document of blueprints/su.fleet-leader (P-020; exclusive per D-003/D-007): attached at fleet:take-leadership (a swap that voids su.fleet-member), resolved through the prompt chain |
| `su.practice` | `practice` | `blueprints/base/prompts/su.practice.md` | the one additive `practice` document su.md carries today (anti-babysitting); more practices stack beside it |
| `su.instance` | `instance` | `blueprints/base/prompts/su.instance.md` | INSTANCE-layer candidate — belongs in the papercusp project guide / pot override, not in any identity; P-003 moves it |

The interactive su’s DEFAULT stack (P-013 fixtures), in `LAYER_ORDER`:

| layer | slot | document | bound | note |
|---|---|---|---|---|
| `kernel` | — | `blueprints/base/prompts/agent-base-preamble.md` | static | the kernel base text (D-018), rendered on every tier |
| `kernel` | — | `blueprints/base/prompts/su.kernel.md` | static | the interactive tier’s kernel extension (this decomposition); the seal renders the kernel last |
| `client` | `client` | `apps/operator/prompts/papercusp-su.<client>.md` | launch | chosen by the launching client (claude / codex / omp) — exclusive |
| `domain` | `domain` | `papercusp-engineer` | static | the software-engineering profession — exclusive |
| `fleet-posture` | `fleet-posture` | — | runtime | NONE by default — fleet:launch-on-plan / fleet:join attach su.fleet-member, fleet:take-leadership attaches su.fleet-leader |
| `modes` | — | — | runtime | NONE by default — mode:set binds one identity per active axis (su.mode-auto on autonomy, su.mode-ideate on ideation, su.mode-drain on objective, su.mode-audit on audit; P-021); the kernel seam at PAPERCUSP-SU:AUTO-MODE carries only state / implications / authority (D-008) |
| `practices` | `collaboration-stance` | `su-collaborator` | static | how the su works WITH the owner — exclusive (D-017) |
| `practices` | `practice` | `su.practice` | static | anti-babysitting — additive; further practices stack beside it |
| `instance` | — | `pot_settings.promptOverride.su + the project guide` | launch | the per-pot override (audit S5) and the spliced project guide |

Base role library (`blueprints/base/prompts`, 64 files): 1 `decomposed-v1` · 1 `kernel-base` · 2 `later` · 58 `role` · 2 `sidecar`. An identity is what an agent IS across pots; a role is WHERE it sits in a spine — choreography stays a role. The non-role rows:

| file | disposition | target | note |
|---|---|---|---|
| `su.md` | decomposed-v1 | — | tiled by SU_TILES into kernel / client / domain / fleet-posture / collaboration-stance / practice / instance (this item) |
| `agent-base-preamble.md` | kernel-base | — | the kernel’s BASE text rendered on every tier (D-018) — not a role |
| `papercup.md` | later | `collaboration-stance` (P-021) | the owner-facing chat collaborator — a second stance document, exclusive with su-collaborator on one stack |
| `papercup-deep.md` | later | `collaboration-stance` (P-021) | the deep-work variant of the chat collaborator — same stance family as papercup.md |
<!-- SU-DECOMPOSITION:END -->

## 10. The kernel seal — slot-based prompt assembly and the composed-stack identity-lint (P-003)

**The render (`src/blueprint/render-stack.ts`).** `composeStack(docs)` takes `StackDocument`s —
each bound to a layer of `LAYER_ORDER` and, on a declarable layer, to the slot it fills — and
renders: every non-kernel document in layering order (client → domain → fleet-posture → modes →
practices → instance; within a layer by `compareSlotOrder`, ties by input order), then the
**seal**, then the kernel documents last (base text first, extensions after). The seal is one
block: the marker `<!-- PAPERCUSP-KERNEL:SEAL -->`, the heading `## Kernel precedence — the seal`,
and a precedence statement that names every section above it, says the kernel below OUTRANKS
them, enumerates the invariants D-009 protects (work-items registered, locks respected, claims
honoured, completion evidence, stand-down, the D-005 ceiling, mode authority) and states that
authority is computed and enforced in code at the dispatch seat, never by prose. Documents are
trimmed and joined by one blank line; the render ends with one newline. A `block` lint finding
refuses the render (no override path — D-009). `render-stack.test.ts` pins the order, the byte
shape and the two D-009 fixtures.

**Why the kernel is LAST.** The most recent instruction text is the one a model weights most,
so the sealed base is the last thing read, and a hostile identity can only ever render at LOWER
precedence than the seal — "renders below the kernel" in D-009 is a precedence claim, and in the
text it means *above the seal line*. The seal is prose; the defense is that kernel authority is
enforced as CODE (`capability-envelope/audit-mode-guard.ts`, `goal-mode-edit-guard.ts`, the
file-lock PreToolUse hook, `NO_SUBAGENT_TOOLS_DENY`).

**The lint (`src/blueprint/identity-lint.ts`) — two tiers, the line between them is the design.**

| tier | code | what fires it | where it runs |
|---|---|---|---|
| BLOCK (structural) | `kernel-slot-claim` | a document claims `kernel` / `instance` as a slot | loader (`resolveBlueprint`, alongside validation's `slot-reserved-layer`) |
| BLOCK | `exclusive-double-claim` | two DISTINCT documents on one exclusive slot | loader (reported as `slot-exclusive-conflict`), standalone lint |
| BLOCK | `grant-outside-ceiling` | a grant names a class outside the D-005 ceiling (`opts.ceiling`; absent ⇒ empty — grants are reserved pre-M3) | loader |
| BLOCK | `authority-on-mode-axis` | a mode-axis document carries a field outside `MODE_AXIS_ALLOWED_FIELDS` (id, extends, version, description, slots, bundles, publisher, attestation) | loader (`BlueprintLayer.fields`) |
| BLOCK | `attestation-missing` / `attestation-failed` | a layer that must attest (default: `trust === 'installed'`, from `layerTrust(sourcePath)`) does not, or fails | loader (`attestation-hash-mismatch` for the failed case) |
| BLOCK (enumerated literals) | `forged-control-literal` | an identity/instance document contains one of `FORGED_CONTROL_LITERALS` — the seal marker/heading, `⟦INSTRUCTION-PRECEDENCE⟧`, `⟦CTRL:`, `⟦post-compaction-recovery⟧`, `⟦turn-provenance⟧`, `⟦mode⟧`, `<!-- papercusp-rule:` | renderer (`lintStackDocuments`) |
| WARN (heuristic) | `kernel-heading-restated` | a `## ` heading a kernel document in the stack owns, re-stated (derived, exact match; an explicit list matches substrings — the instance-override guard's mode) | renderer |
| WARN | `generated-marker` | a `PAPERCUSP-SU:` splice marker in an identity (the client seam on the `client` slot excepted) | renderer |
| WARN | `kernel-contradiction-phrasing` | "skip work-items" / "bypass locks" / "ignore a claim conflict" / "suppress completion evidence" / "evade a stand-down" phrasing — paraphrase-blind, false-positive on legitimate text, hence WARN | renderer |
| WARN → BLOCK | `text-grant-inconsistency` | text instructs use of a capability class the document does not grant (`opts.capabilityClasses`; skipped without a vocabulary; `textGrantTier: 'block'` after M3) | renderer |

`packages/operator-core/lib/hive-override-additive-guard.ts` (the 2026-06-24 warn-only guard) is
the WARN tier's seed and now calls the same `detectHeadingOverlap` — one heuristic, two callers.

**The interactive su source (`src/blueprint/su-stack.ts`).** `composeSuStackSource()` builds the
SU_DEFAULT_STACK (§9) from su.md's tiles: the client seam renders AS the `client` layer (so
`renderSuPlaybook` step 1 still splices the per-client overlay there), `papercusp-engineer` on
`domain`, an optional fleet posture, `su-collaborator` + `su.practice` on `practices`,
`su.instance` on `instance`, then the seal, then the kernel: `agent-base-preamble.md` followed by
su.md's kernel tiles with the D-018 §4 dedupe tiles DROPPED (guarded — a tile whose named
preamble heading is missing is kept and reported). The AUTO-MODE / RESULT-DOOR / COORD-LEGEND /
WIRE-SCHEMAS seams live in kernel tiles and render under the seal, so every generated section
still splices. `role-launch-spec.ts` feeds this text to `renderSuPlaybook` as `baseText` on the
`SU_BLUEPRINT_PERSONA` path (a compose failure falls back to su.md, with a warning).
`su-stack.test.ts` proves the render LOSSLESS over the real tree (every non-dropped tile exactly
once; identity tiles above the seal, kernel tiles under it; no seam lost or duplicated). The
interactive golden is lossless-tile + order, NOT byte-equality with the pre-P-003 render: the
seal necessarily reorders the file, and the P-018 baseline (`su-render-baseline.ts`) measures
that delta per section for the P-035 gate rather than forbidding it.

## 11. The stack-mutation primitive — attach / detach a layer on a LIVE session (P-012)

**What a binding is (`src/blueprint/stack-mutation.ts`).** A `StackBinding` is the set of
identity layers a session runs beyond the kernel: `{ slot, id }` per filled slot, an additive
slot carrying several, in `compareSlotOrder`. It is DERIVED state, never a new table — for the
interactive su the fleet posture is presence's `fleet_role` and the mode axes are `agent_modes`
(one definition identity per active mode axis since P-021 — §13), projected by the operator
into the control anchor as `stack: ['fleet-posture:su.fleet-leader', …]` (`bindingRefs`). The
su's static layers (`SU_STATIC_LAYERS`: `domain:papercusp-engineer`,
`collaboration-stance:su-collaborator`, `practice:su.practice`) are implied; a runtime binding
is applied over them with attach semantics (`suEffectiveBinding`), so an exclusive layer in
the binding REPLACES the static one and a static layer can be swapped but never detached.

**What a mutation is.** `attachLayer` / `detachLayer` are pure functions over a binding. On an
exclusive slot an attach onto a DIFFERENT holder is a SWAP — the mutation carries `replaced` —
because D-007's "exactly one document per exclusive slot" is a property of the STACK, which a
mutation preserves; the hard-error is for a stack that declares two claims at once
(`normalizeStackBinding` still refuses that). On an additive slot documents stack in attach
order and a detach must name the document. A repeat attach or a detach of an unbound layer is a
no-op (`changed: false`) that delivers nothing. `diffStackBindings(before, after)` turns two
anchor states into the mutation list (detaches first, then attaches; a swapped exclusive holder
is ONE attach), which is how the turn-start channel reconstructs what to deliver.

**Delivery — the slot's LAYER decides, and the table below is the rule (pinned).**

<!-- STACK-MUTATION:BEGIN -->
| slot | cardinality | layer | attach / detach delivers by | why |
|---|---|---|---|---|
| `client` | exclusive | client | **relaunch-with-carry** | the client overlay names the CLI the session runs IN (Claude / Codex / OMP) — a different client is a different process, so the swap is a relaunch-with-carry (P-012 (b) by analogy with `domain`) |
| `domain` | exclusive | domain | **relaunch-with-carry** | P-012 (b): the profession shapes the whole context; swapping the exclusive `domain` slot is a carry-respawn on the new stack, never an in-place rewrite |
| `fleet-posture` | exclusive | fleet-posture | **inject-now** | P-012 (c): a posture swap (fleet:join → take-leadership) follows (a) with the exclusive-slot rule enforced — the attach REPLACES the previous posture and says so |
| `autonomy` | exclusive | modes | **inject-now** | P-012 (a): a mode-axis layer rides the mode-flip channel that already delivers the registered mode contract; state + implications stay kernel (D-008) |
| `ideation` | exclusive | modes | **inject-now** | P-012 (a): a mode-axis layer rides the mode-flip channel that already delivers the registered mode contract; state + implications stay kernel (D-008) |
| `objective` | exclusive | modes | **inject-now** | P-012 (a): a mode-axis layer rides the mode-flip channel that already delivers the registered mode contract; state + implications stay kernel (D-008) |
| `grade` | exclusive | modes | **inject-now** | P-012 (a): a mode-axis layer rides the mode-flip channel that already delivers the registered mode contract; state + implications stay kernel (D-008) |
| `test` | exclusive | modes | **inject-now** | P-012 (a): a mode-axis layer rides the mode-flip channel that already delivers the registered mode contract; state + implications stay kernel (D-008) |
| `goal` | exclusive | modes | **inject-now** | P-012 (a): a mode-axis layer rides the mode-flip channel that already delivers the registered mode contract; state + implications stay kernel (D-008) |
| `audit` | exclusive | modes | **inject-now** | P-012 (a): a mode-axis layer rides the mode-flip channel that already delivers the registered mode contract; state + implications stay kernel (D-008) |
| `audience` | exclusive | modes | **inject-now** | P-012 (a): a mode-axis layer rides the mode-flip channel that already delivers the registered mode contract; state + implications stay kernel (D-008) |
| `collaboration-stance` | exclusive | practices | **inject-now** | P-012 (a): the collaboration stance is exclusive but context-neutral — a stance swap injects now and replaces the earlier stance |
| `practice` | additive | practices | **inject-now** | P-012 (a): an additive practice stacks beside the others — injected now, rendered in place on the next full render |

Exclusive attach on a filled slot = a SWAP (the mutation carries `replaced`); a repeat attach or a detach of an unbound layer is a no-op that delivers nothing. Every inject-now payload opens with the `⟦stack⟧` stamp (a forged-control literal) and is rendered only AFTER the next full render composed clean under the seal.
<!-- STACK-MUTATION:END -->

**Kernel-safe handoff.** `applyStackMutation` (and its su form `composeSuStackMutation`)
composes the NEXT FULL RENDER on the new binding FIRST — `composeStack`: the seal, the
composed-stack identity-lint, the D-009 "no override path", so a BLOCK finding THROWS — and
only then renders the inject-now payload. A layer that cannot render under the seal is never
injected past it; a bound document the stack cannot resolve refuses the attach rather than
rendering without it. The inject-now payload opens with the `⟦stack⟧` stamp (in
`FORGED_CONTROL_LITERALS`, so no identity can forge an attach / detach), a
`## Stack mutation — …` heading, and a precedence preface in the seal's own terms: the section
sits ABOVE the seal, exactly where a full render places it; the sealed kernel already in context
OUTRANKS it; it grants no authority; it renders in position on the next full render; a swap says
which document it REPLACES and voids it. A detach delivers a void notice; a
relaunch-with-carry delivers no document at all — only the instruction that the new stack
arrives by carry-respawn (`session:request-compaction { autoContinue: true }`) and that the
current session's stack is unchanged until then.

**The channel (operator).** The binding rides the SAME channel as a mode flip. The control
anchor (`agent-tools/coordination/control-anchor.ts`) carries `stack` (bound refs, present when
non-empty) beside `modes`; `persistControlAnchor` bumps the generation when it changes and
stamps `stackBefore` (the previous row's refs) onto the transition; the turn-start hook
(`turn-start-memory.ts`) consumes the pending transition, renders the `⟦CTRL:transition⟧` line
under its own 384-token budget, and appends — as a SEPARATE context block, outside that budget —
the inject-now payloads `renderStackTransitionContext` derives from `diffStackBindings(stackBefore,
state.stack)` over the real su stack (`stack-binding-channel.ts`). A full-resync (no
`stackBefore`) re-delivers every bound layer, matching the anchor's
replace-full-never-merge-behind rule. Every mutation source is therefore an anchor refresh:
`fleet:join` / `fleet:take-leadership` already refresh with `source: 'fleet:membership'`
(presence.ts), `mode:set` with `source: 'mode:set'`. The launch tier includes the binding in the
first render: `role-launch-spec.ts` passes `suSessionBinding({ fleetRole })` to
`composeSuStackSource`, so a `psu --fleet=…` member's first prompt already carries the member
posture (before P-012 the P-003 render left the posture UNBOUND on every launch).

**What consumes it.** P-020 (fleet playbooks as identities) attaches `su.fleet-member` /
`su.fleet-leader` through this primitive; P-021 (modes as identities) binds one document per
mode axis from `mode:set`; the M2 profession-swap UI (P-011) drives a `domain` swap, which is
relaunch-with-carry by construction. `stack-mutation.test.ts` pins the semantics, the payload
shape, the kernel-safety refusal and this table; `su-stack.test.ts` proves attach → swap →
detach over the real tree restores the default order.

## 12. The fleet postures are identities, resolved through the prompt chain (P-020)

**The two identities.** `blueprints/su.fleet-member` and `blueprints/su.fleet-leader` are
identity blueprints in the exact shape of `su-collaborator` (§9): abstract (`extends: base`,
no spine / work item — a layer, never runnable alone), `slots: [{ slot: fleet-posture }]`
(exclusive — D-003 as narrowed by D-007: member and leader never co-bind, a leader attach on a
member session is a SWAP, §11), text in `prompts/fleet-posture.md`. The text is still the
VERBATIM extraction of su.md's posture tiles (§9 rows 6, 8 / 26, 27) that `gen:su-decomposition`
writes and `su-decomposition.test.ts` drift-checks — su.md remains the derivation source and the
`llm-test --target su` subject is byte-identical. The fleet PROTOCOL (claims honoured, gate
events, stand-down obeyed, completion evidence) stays kernel; only the operating CRAFT moved.

**Resolution through the chain.** `suStackDocuments` no longer re-concatenates an
identity-homed part document from tiles: `suPartDocumentHome(doc) === 'identity'` (derived from
the path — `blueprints/<identity>/prompts/…`, never restated) routes it to
`resolveSuIdentityDocument(part, identityRoots)` — the first root, most specific tier first,
that holds `<root>/<part.path>` wins, the same walk `resolveReplacementSystemPromptStack` does
for the domain overlay. `identityRoots` defaults to `[harnessDir]` (the built-in tier); a hive's
local / installed tiers go in front of it, so an installed override of an identity wins over the
built-in copy. A bound identity installed in NO tier REFUSES the render — the tiles are the
derivation of those files, not a second source, so there is no silent fallback. The kernel
extension, the practice and the instance tile still render from su.md's tiles. The ⟦stack⟧
inject-now payload (`composeSuStackMutation`) is fed by the same resolution, so an installed
posture override is what a fleet:join / take-leadership delivers.

**Attach points (P-012 seams, verified — not rebuilt).** `fleet:launch-on-plan` launches members
with `--fleet=<slug>`; `bootstrap-su` resolves the requested role (`fleet_name` ⇒ leader,
`fleet` ⇒ `fleet_role || member`) into `BuildSuLaunchSpecInput.fleetRole`, and
`role-launch-spec` binds `suSessionBinding({ fleetRole })` into the FIRST render.
`fleet:take-leadership` → `setPresenceFleet(…, 'leader')` → `refreshControlAnchorAfterMutation`
(source `fleet:membership`) → the anchor's `stack` moves `fleet-posture:su.fleet-member` →
`fleet-posture:su.fleet-leader` → the turn-start channel renders ONE swap payload that names and
voids the member posture (`stack-binding-channel.test.ts`).

**Measured (P-018 fixture baseline, `su-posture-render.test.ts`).** Each single-posture render
is a STRICT line-subset of the baseline render (the seal's own lines are the only admitted
additions), carries none of the other posture's tile anchors, and renders strictly fewer bytes;
the test prints the whole-render byte delta per posture and dumps the per-section table under
`SU_RENDER_BASELINE_DUMP`. `su-identities.test.ts` pins the blueprint shape, the chain
precedence (installed tier > built-in), the refusal, and the tile/identity byte-equality.

## 13. Modes as facets — the definitions are identities on the axis slots (P-021)

**The three-way split (D-008 as amended 2026-09-03).** A mode is STATE + DEFINITION + AUTHORITY.
STATE stays in `harness_shared.agent_modes` (`mode:set` writes it, the ⟦CTRL⟧ anchor projects
it); AUTHORITY stays kernel — computed by `instruction-lint.ts` from the registry, enforced at
the dispatch chokepoint (`audit-mode-guard.ts`); only the DEFINITION moved. Each definition is
an abstract identity blueprint on ONE EXCLUSIVE AXIS SLOT (`mode-identities.ts`
`SU_MODE_DOCUMENTS`): `su.mode-auto` on `autonomy` (bound for `auto` AND `cold-auto` — one
dial), `su.mode-ideate` on `ideation`, `su.mode-drain` on `objective`, `su.mode-audit` on
`audit`; text at `blueprints/<id>/prompts/<axis>.md` — the prose cut verbatim out of
`operating-modes-policy.ts` (28,428 B), which until P-021 rode in EVERY su render with no
is-this-mode-active gate. Registry modes with no document (`goal`, `grade`, `test`) bind
nothing: their definition is the registry `contract` mode:set already delivers.

**Additive across axes, exclusive within one.** `suSessionBinding({ fleetRole, modes })`
binds one layer per axis from the ACTIVE registry modes — the implication closure is the
registry write's job (`setMode` writes the implied rows), so `mode:set drain` leaves `drain +
auto` in `agent_modes` and the binding carries `objective:su.mode-drain` AND
`autonomy:su.mode-auto`. `auto + ideate` composes (the case a single exclusive `mode` slot
would have hard-errored under D-007); a second document on one axis is a swap.

**The kernel seam.** `<!-- PAPERCUSP-SU:AUTO-MODE -->` now splices the KERNEL half only
(`renderModesPolicy`, both tiers identical): how a flip is registered, the implication table
DERIVED from `modes/registry.ts` (`resolveImpliedModes`), the axis ← mode map derived from
`SU_MODE_DOCUMENTS`, the authority statement, and the one-line mode index. An su with all
modes off renders none of the four definitions; the fleet tier's former compact AUTO variant
is retired — a fleet member's autonomy document is bound because its launch registers `auto`,
not because the tier says so.

**Attach points (P-012's seams, verified).** Launch: bootstrap-su computes the launch modes
from the same body fields it registers (`--mode=drain` ⇒ auto + drain, `--auto` ⇒ auto, a
fleet member ⇒ auto) → `BuildSuLaunchSpecInput.modes` → `suSessionBinding` in the FIRST
render. Live: `mode:set` → `refreshControlAnchorAfterMutation` → the anchor's `stack` is
`stackRefsForSession({ route, modes })` (`stack-binding-channel.ts`; `SU_MODE_REFS` inlined
and pinned to `suModeLayer` by test) → the turn-start channel renders the ⟦stack⟧ attach
carrying the document; `enabled:false` renders the detach that VOIDS it. The documents are
authored, not derived from su.md — they have no tiles — so `suBoundLayerDocument` resolves
them through the chain ONLY (`identityRoots`, most specific first) and a mode identity
installed in no tier REFUSES the render (there is nothing to fall back to).

**D-005 negative.** A publisher-authored mode identity cannot widen authority: an
authority-bearing field on a mode axis is the BLOCK finding `authority-on-mode-axis`
(`MODE_AXIS_ALLOWED_FIELDS`), and a forged control literal in its text (`⟦stack⟧`,
`⟦INSTRUCTION-PRECEDENCE⟧`, `⟦mode⟧`, …) is `forged-control-literal` — the render refuses, and
because `applyStackMutation` composes the next render FIRST, so does the attach
(`su-mode-identities.test.ts`). The built-in AUTO document itself had to be reworded once for
this: it described the platform's `⟦mode⟧` stamp by name, which an identity may not carry.

**The second axis (D-008 "unify").** The file-based persona modes
(`apps/operator/prompts/<role>.persona.{engineer,novice}-mode.md`) are identities on the
exclusive `audience` slot — `operator.audience-engineer`, `operator.audience-novice`,
`papercup.audience-engineer`, `papercup.audience-novice` (`AUDIENCE_IDENTITY_DOCUMENTS`,
text at `prompts/audience.md`, moved verbatim; the prompts-dir files are gone — an identity
has ONE home). `loadRoleModePersona(role, mode, identityRoots?)` resolves them through the
same chain; it is bound per conversation by `audienceMode`, not by `mode:set`. RECORDED
DEFAULT (P-021): v1 is the four files on the same mechanism.

## 14. The chat-surface roles resolve through the chain — one prompt-resolution path, file tier last (P-023)

**One resolver.** Until P-023 the system had two prompt-resolution paths: the spawn tier
resolved `blueprints/<id>/prompts/<role>.md` through `resolvePromptFile` (`prompt-resolve.ts`:
the blueprint extends-chain leaf-first with `base` last; within one id the tiers local →
installed → built-in, `rootsFor`), and the su's identity documents resolved through
`identityRoots` (§12) — while the CHAT-SURFACE roles (`PROMPT_ROLES` in
`packages/operator-core/lib/prompt-assembly.ts`: operator, oracle, auditor, papercup,
papercup-deep, …) read `apps/operator/prompts/<role>.{persona,converse,tools}.md` by direct
file read (`promptsDir()`), with no chain, no tiers and no override seam. P-023 puts the
chat-surface documents on the spawn tier's resolver: `loadChatRoleDocument(role, kind, ctx?)`
calls `resolvePromptFile(ctx, '<role>.<kind>')`, so the chain form of a document is
`blueprints/<id>/prompts/<role>.<kind>.md` — the same dotted-suffix naming as the generic
prefix `<role>.base.md`, and the same candidate order (`chatRoleDocumentCandidates`) the spawn
tier lists. `ctx` is `ChatRoleResolveContext` — the spawn tier's `PromptResolveContext` minus
the retired phase/dept axis: `blueprintId` / `extendsChain` (the chain walked) and
`blueprintRoots` (local → installed, before the built-in `harnessDir`). Omitted, it is the
`base` chain over the built-in harness — what every workspace-level chat surface resolves with;
a pot-scoped role session passes its blueprint through `assembleRolePrompt({ resolve })`.

**The file tier is retained, LAST.** The prompts dir (`apps/operator/prompts/<role>.<kind>.md`)
is the lowest-precedence tier: consulted only when no root of the chain holds the document.
Two consequences the item asked for. (1) BYTE-EQUIVALENCE: the built-in harness ships no chain
copy of any chat-surface document (pinned by `prompt-assembly-chat-role-chain.test.ts`), so
every `PROMPT_ROLE` renders byte-identical to the pre-P-023 direct read — asserted per role
and per kind by `it.each(PROMPT_ROLES)`, at the loader (`tier:'file'`, the file's bytes
verbatim) and at the assembled prompt (opens with the persona bytes, carries the tools
playbook verbatim); a role that had no document before still has none (the same refusal for
persona / converse, `null` for tools). The integration-root redirect survives on both tiers:
`promptsDir()` prefers `PAPERCUSP_INTEGRATION_ROOT/apps/operator/prompts` and `rootsFor`
resolves the built-in tier through `promptHarnessRoot`, so a chat-surface prompt edit still
goes live without a code-release promotion. (2) OVERRIDE WITHOUT A CODE CHANGE: a `base` copy in
any tier wins over the file; a leaf blueprint's copy (or its non-base ancestor's, read from
`blueprint.yaml` `extends` exactly like a spawn) wins over `base`; within one id a local tier
wins over the built-in — but a leaf in ANY tier still beats an ancestor in the local tier
(specificity is the primary axis, tier the tiebreaker, unchanged from D-006 of the
hive-architecture plan). Memoization is keyed by (role, kind, ctx, prompts dir), so two
chains never share a cache row.

**Not moved.** Unlike the audience identities (§13, one home), the chat-surface documents
stay in the prompts dir: the packaged desktop ships that dir as `PAPERCUSP_PROMPTS_DIR`, the
decouple-agent-prompts pipeline redirects it, and `llm-test` / `lint:tool-prompts` read it —
moving five documents into `blueprints/base/prompts/` would ripple through packaging for no
precedence gain (the file tier is already the lowest). `<role>.shell.md` / `.examples.md` are
not role documents of this assembler (the voice dashboard and the examples reader hold their
own paths) and are outside P-023.
