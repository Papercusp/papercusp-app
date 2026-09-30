# Knowledge Packs — default pot learnings, pot memory, Comb distribution
URL: /internal/docs/system/knowledge-packs

How a new pot inherits curated working wisdom, where it lives (the pot:<slug> memory pool), how packs are managed through the conflict review, and how the Comb distributes them behind operator approval.

# Knowledge Packs

> Plan of record: `learning-packs-2026-06-11` (shipped). Code anchors:
> `packages/operator-core/lib/knowledge-packs/`, `lib/memory/pot-scope.ts`,
> the `knowledge_packs:*` tool group, and the Cupboard worker migration 008.

A **knowledge pack** is a versioned, git-canonical set of *learnings* —
curated, project-transferable working wisdom. At pot creation the selected
pack is **copied** into the pot's own memory store; from then on the pot
owns every row — editable, deletable, growable — and every agent in every
member harness recalls it.

**Which pack seeds is a 3-level priority** (`pot:create`,
`_create.ts`): an explicit `knowledgePack` arg wins; else the blueprint's
declared `knowledge.pack`; else the global fallback
**`coding`** (`DEFAULT_KNOWLEDGE_PACK_ID`). So `coding` serves two roles —
the coding-pot pack *and* the global fallback — and a pot whose blueprint
declares a `knowledge.pack` seeds that instead (see
[Built-in packs](#built-in-packs-two-of-them)).

> **EI-1539:** the fallback used to be a third pack, `papercusp-default`,
> whose content was byte-identical to `coding` apart from its manifest. It
> was retired and the constant repointed at `coding`; nothing was lost in
> the merge. Pre-existing rows still carry provenance
> `pack_id: 'papercusp-default'` and simply lose pack linkage for
> upgrade/uninstall — the learnings themselves stay valid.

## The three load-bearing decisions

* **Copy, never live-link (D-001).** Seeded rows are ordinary mem0 rows in
  the `pot:<slug>` scope, provenance-tagged
  (`{source:'pack', pack_id, pack_version, pack_item_id}`). Injection,
  per-pot editing, uninstall, and upgrade-diff all ride existing machinery;
  a pot's store changes only by deliberate act.
* **Encode the discipline, parameterize the stack (D-002).** Pack content is
  *discovery rules* ("find how this project runs tests; use that framework"),
  never stack bindings ("use Vitest"). The Mug's first wake runs
  **convention discovery** and records the bindings as pot memories
  (`memory:remember { hive_slug }`); `applies_to` shape tags
  (`ui|service|library|cli|any`) filter what seeds.
* **Install is a merge review, never a silent union (D-003).** Installing a
  pack into a non-empty pool classifies every incoming learning into one of
  **four statuses** — `present` / `clean` / `duplicate` / `conflict`.
  `present` is the **provenance guard**: an item whose `{pack_id,
  pack_item_id}` already has a row is an unconditional no-op (skipped
  regardless of any resolution or embedding score) so a pack row is **never
  double-written** on re-install/upgrade. The other three are the
  same-pool semantic outcomes for items with no provenance row yet —
  `clean` installs; `duplicate` / `conflict` (mem0 dedup + the P-017
  conflict judge) require explicit per-item resolutions (keep existing ·
  take incoming · keep both). Defaults skip clashes: existing content
  outranks the incoming pack.

## Where things live

| Piece                    | Location                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Built-in packs           | `libs/papercusp/packages/harness/knowledge-packs/<pack-id>/` (manifest.yaml + one-learning-per-file md; renamed from `harness/learnings/` — the loader hard-fails on a missing builtin dir, never a soft miss) — two ship: `coding`, `work`                                                                                                                                                                                                                                                                       |
| Comb-installed packs     | per-workspace `papercuspRoot()/knowledge-packs/<pack-id>/` (the legacy `learning-packs/` root is migrated on boot)                                                                                                                                                                                                                                                                                                                                                                                                |
| The `fleet-lessons` pack | **shared root** `workspacesRoot()/shared/knowledge-packs/fleet-lessons/` — workspace-INDEPENDENT, so every workspace resolves the same pack (candidates are fleet-global). Resolution order: builtin → shared → installed; a stray per-workspace copy is shadowed, not merged                                                                                                                                                                                                                                     |
| A pot's live learnings   | mem0 rows, scope `pot:<home-slug>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Pack mute state          | pot setting `knowledge-packs:disabled` (federated hive\_settings)                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Domain targeting         | item frontmatter `domains: [...]` (open kebab-case vocabulary) + pot setting `knowledge-packs:domains` — a domain-tagged item seeds/delivers only to pots declaring an intersecting domain; untagged items are unaffected and a pot with no declaration receives untagged items only (`filterByDomains`, conservative like the repo-less shape posture)                                                                                                                                                           |
| Seeding                  | `pot:create` step 6b (flag `KNOWLEDGE_PACKS`, default ON; undo-stacked, best-effort)                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Pre-turn injection       | `buildMemoryContextBlock` — pot pool resolved member→pot via the registry's `hive_slug`; token-budgeted (\~4k default, `PAPERCUSP_MEMORY_INJECT_BUDGET_CHARS`), priority user > harness > pot-organic > pot-pack; muted packs filtered                                                                                                                                                                                                                                                                            |
| Runtime recall scope     | `memory:search` default fan-out is **confined to the session's pot subtree** (P-018, `narrowHarnessSlugsToSessionHive`, `lib/memory/pot-scope.ts`). A pot-scoped agent never cross-recalls sibling pots' harness pools. Workspace-spanning sessions (`harness='*'`) and plain standalone harnesses are exempt — their fan-out is unchanged. Gated by `FLAGS.SCOPED_SUPERUSER_CLAMP`; fail-open (flag read error → full fan-out retained). `memory:list` is unaffected (it only adds explicitly-passed pot pools). |

## Built-in packs (two of them)

Two packs ship under the builtin root, each seeded by the blueprint-driven
priority above (D-010, `domain-generic-pot-architecture`):

| Pack     | Seeded for                                                                                                    | Shape                                                                                            |
| -------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `coding` | a coding pot (`extends: coding`) **and** the global fallback (no blueprint `knowledge.pack`, no explicit arg) | shape-conditional items (`ui\|service\|library\|cli\|any`) — generic engineering discovery rules |
| `work`   | a work pot (`extends: work`)                                                                                  | fully `any` (repo-less) — coordination discipline + rubric-judged deliverables                   |

`coding` and `work` carry only generic *discovery rules*, never stack
bindings; project specifics belong in the per-pot override and a separate
project pack. A coding pot defaults to `coding` and a work pot to `work`, so
the blueprint's own declaration decides in every case; the fallback only
applies to a pot that declares nothing.

**Curation is single-source** (EI-18121649240446176): `sync-map.json` next to
the packs declares that `work` mirrors a named subset of `coding`'s shared
discipline items. A mirror listed there whose directory is missing fails
`pack-sync.test.ts` outright (it `readdir`s each mirror), so retiring a pack
means deleting its directory **and** its sync-map entry together. Edit the canonical
`coding/` copy, then `npm run gen:knowledge-packs`; `pack-sync.test.ts` reds
the gate on any drift, and deliberately diverging an item is a one-line
sync-map edit. Item files may also carry `domains: [...]` (see the
domain-targeting row above) — the axis is opt-in per item, so untagged packs
behave exactly as before it existed.

## Candidate-promotion loop (fleet → pack) — auto-adopt behind a transferability bar

A recurring cross-scope friction signature (the recurrence-escalation
promotion noticing the same pain across ≥2 distinct scopes) is staged as a
`knowledge_pack_candidates` row — deduped by a **normalized** signature
(instance tokens stripped: hex runs ≥8, pure numbers, uuids) so one lesson
stages once across instances and a dismissed lesson never re-nags; capped
(default 20 pending). Staging also admits a `transfer_lessons` row
(`admitTransferLesson`, sourceKind `pack-candidate`) so the transfer-lesson
machinery sees pack candidates through the same edge.

Candidates are then **auto-reviewed** on the improvement-triage cadence
(WI-5414 — the owner reversed the original human adopt gate) through a
**two-stage review** (`candidates.ts` + `candidate-review.ts`,
knowledge-pack-loop-integrity P-001):

1. **Transferability judge + distiller** (gateway-routed LLM,
   `LessonDistillerLlm` port): adoptable only if another agent, given it
   BEFORE a similar task in a DIFFERENT project, would do measurably better.
   Raw incident reports, ephemeral operational state, and instance-bound text
   **fail** (dismissed with a note). A **pass** REWRITES the draft into the
   compact rule (title ≤120 chars, text ≤1,200) — the pack carries the
   distilled text; the candidate row keeps the raw provenance.
2. **Contradiction check** against the existing fleet-lessons items (the
   original WI-5414 review).

Failure posture (D-004 — the reverse of the old fail-open-to-adopt): a judge
**error** leaves the candidate PENDING for the next tick; never
adopt-by-default. Adoption **materializes** the distilled item into the
`fleet-lessons` pack at the **shared root** and bumps its patch version — it
**never** writes into a pot pool directly; pools pick it up via the delivery
routine below (still D-003: the install review, defaults skip clashes).
`knowledge_packs:candidates` + `knowledge_packs:decide_candidate` remain the
manual surfaces (Learnings view; self-improvement-consume-edges P-032).

## Last mile + hygiene — the two scheduled routines

Both are `registerSystemAction` system actions
(`lib/harness/routines/knowledge-pack-actions.ts`), seeded as routines by
`seed-improvement-routines.ts` and gated by the same master
`FLAGS.KNOWLEDGE_PACKS` that gates seeding and every `knowledge_packs:*` verb:

* **`knowledge-pack-delivery`** (every 6 h at :30) — the fleet-lessons last
  mile. Before it, adoption was inert: the pack version bumped, but
  `updateAvailable` only lights for pools already carrying the pack, and no
  pool had ever installed it. Each tick, for every LOCAL hive (bounded per
  tick) unless the hive muted the pack (`knowledge-packs:disabled`):
  `planPackUpgrade(fleet-lessons)` → `applyPackInstall` with default
  resolutions — clean items install; duplicates/conflicts **skip** (D-003
  preserved: existing pool content outranks the incoming pack, nothing is
  overwritten). For a pool with zero pack rows the NEW-items set is the whole
  pack, so install and upgrade are one code path. `pot:create` also seeds
  fleet-lessons alongside the blueprint pack when it has items.
* **`knowledge-pack-hygiene`** (daily 05:00) — knowledge decays; one bounded
  tick, three passes, conservative-by-construction (**only PRISTINE pack rows
  are ever auto-deleted**; organic/edited content is filed, never deleted):
  1. **Pack re-review** — fleet-lessons items whose adoption is older than
     `minAgeDays` are re-run through the SAME transferability judge; a FAIL
     retires the item (pack file removed + manifest patch-bumped + each
     hive's pristine pool rows of it forgotten — edited rows kept, same rule
     as uninstall). Judge error ⇒ untouched (D-004: never destroy on a broken
     judge); hand-authored items with no candidate row are never auto-retired.
  2. **Conflict sweep** — `sweepHiveConflicts` per local hive (bounded);
     auto-resolved ONLY when exactly one side is a pristine pack row and the
     other organic — the pack row is forgotten (organic outranks pack,
     mirroring install-review D-003). Every other pair (organic vs organic,
     edited, pack vs pack) is FILED via improvements capture.
  3. **Queue prune** — dismissed candidate rows older than
     `pruneDismissedDays` are deleted; adopted rows are provenance and kept
     forever.

## Settings — the "Fleet knowledge packs" section (workspace-wide)

The loop's knobs are runtime-tunable from the **memory settings page**
(`/settings/user/memory`, the "Fleet knowledge packs — workspace-wide"
section), backed by `GET/POST /api/user/knowledge-pack-settings`
(knowledge-pack-settings-2026-07-19):

* **Storage + resolution**: a single-row-per-workspace JSONB record
  (`harness_shared.knowledge_pack_config`, migration 639;
  `lib/knowledge-packs/config.ts`). Every knob resolves **stored → env →
  default**, so the pre-settings env vars
  (`PAPERCUSP_KNOWLEDGE_HYGIENE_MIN_AGE_DAYS` etc.) keep working as boot-time
  fallbacks and an empty table changes nothing. Knob edits apply on the next
  routine tick — no restart.
* **Cadence presets**: the UI writes named presets (delivery hourly/6h/daily/
  paused; hygiene daily/weekly/paused) mapped to vetted cron strings and
  applied to the two `harness_shared.routines` rows (same columns
  `routines:set` mutates, next-fire recomputed). `paused` flips the row
  inactive and keeps the cron; raw cron editing stays with `routines:set`,
  which the UI then reports as `custom`.
* **Adoption policy**: `auto` (the WI-5414 judged auto-adopt) ↔
  `owner-approval` — the latter disables the automated sweep entirely (no
  judge LLM spend); candidates stay pending for
  `knowledge_packs:decide_candidate`.
* **Not duplicated there**: the master `KNOWLEDGE_PACKS` flag
  (`/admin/features`), per-pot pack mute (Learnings view), and the read-only
  routine inventory (`/admin/schedules`).

## Surfaces

* **Creation:** both create flows carry the pack picker (default pack
  preselected, "none" allowed); the from-repo strip shows a real `seed` step;
  the success card links to the Learnings view.
* **Learning tab → Learnings:** per-pot view with pack badges
  (pristine/edited vs the pack), origin filter, inline edit/remove, pack
  management (install / mute / uninstall / upgrade) and the conflict-review
  cards. Backing reads: `learning.pot`, `learning.hiveList`,
  `knowledgePacks.list`.
* **Verbs:** `knowledge_packs:list / install / uninstall / set_enabled /
  upgrade / sweep / export / publish / candidates / decide_candidate` (ten).
  `sweep` re-judges the whole pool for contradictions that emerge after
  install; `upgrade` adopts a newer version's NEW items only — present rows
  are never auto-touched; `uninstall` is provenance-driven and **keeps edited
  rows by default** (only pristine pack rows — text still matching the pack's
  canonical render — are removed; `keepEdited: false` removes everything, and
  the returned `kept` list reports the edited rows preserved). The HTTP
  routes under `/api/knowledge-packs/*` do **not** map 1:1 to the verbs — they
  are `install`, `upgrade`, `uninstall`, `set-enabled`, `fetch-from-comb`,
  and `candidate-decide`; `list / sweep / export / publish / candidates` are
  MCP-only or reached through other paths.

## Comb distribution + the approval gate (D-007)

Listing kinds gained `knowledge-pack` (migration 008 added it as
`learning-pack`, renamed to `knowledge-pack` by migration 011; the runtime-less
code-tool pack, briefly named `tool-pack` by migration 008, was renamed back to
`pack` in the same release — both old wire values still parse as aliases).
**Instruction-carrying kinds — `knowledge-pack` and `blueprint` — publish
PENDING** and are publicly invisible until an allowlisted operator approves them
at `/admin/cupboard-moderation` (worker routes `/admin/pending` +
`/admin/listings/:id/review`). Submitters see their own pending listing and
any rejection reason. Code kinds (plugin/pack) keep install-time
capability consent + reactive moderation.

Install-from-Comb only **stages** a pack locally (clone → validate through
the pack parser → `~/.papercusp/knowledge-packs/`); it enters a pot solely
through the conflict review. Every learning is browsable on the listing
detail page *before* install. Publishing: `knowledge_packs:export` writes the
pack shape into a member repo (organic rows only by default), the project's
normal flow pushes it, `knowledge_packs:publish` creates the listing.

## Ops notes

* Worker migration `008_learning_pack_kind_review_status.sql` is a ONE-SHOT
  D1 rebuild (applied to production 2026-06-11; pre-008 rows grandfathered
  `approved`; the one retired `snapshot` row was removed — backup taken via
  `wrangler d1 export` first). Future rebuild migrations: **enumerate the
  live `listing_kind` values before writing the CHECK** — a forgotten legacy
  kind fails the whole batch.
* Tests live under the **Learnings** domain in the Tests tab
  (`testing-domains-registry.ts`).
