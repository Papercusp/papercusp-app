# Papercusp Official: App — build guide

The one whole-app root. It is a **thin pure composition**: it owns no
components of its own, and every capability it gives you comes from an aspect
in its closure. What it adds is the glue guidance below and the decision points
that shape the composition — above all `target`, which picks the chassis.

> **This template replaced four.** The old web-app and desktop-app roots and
> their two agentic twins were the cross-product of two booleans: which
> chassis, and whether the agent plane joins. Web and desktop shared 15 of 15
> files with 11 byte-identical and **no code divergence at all**, so they were
> never really different templates — they were one template with a parameter
> nobody had extracted yet. Those four refs still resolve here; there is
> nothing to migrate.

## Before you write anything

- Read `template.yaml` — the pinned closure, the checks that gate you, and the
  structured MUSTs mirrored below.
- Read the docs it declares (the `docs:` list names the canonical pages),
  starting with `agent-insights/templates-system-design`.
- Inspect the **operator app** itself — a running reference instance of every
  pattern these templates encode, and the existence proof for `target: both`:
  it serves the same codebase through a Tauri shell and a plain browser with no
  runtime branch anywhere in its sync layer.

## How to build from this (orientation)

1. **Answer `target` FIRST.** `desktop`, `web`, or both. This is not a
   preference — it *selects* the chassis aspect into your composition, and the
   chassis carries its own decision points, which you cannot even see until you
   have chosen. Pick `web` and you inherit `tenancy`, `hosting-target`,
   `auth-strategy`, `render-strategy`, `observability`. Pick `desktop` and you
   inherit the sidecar and release-pipeline forks instead.
2. **Answer the chassis's own decision points**, in the order the chassis
   states. On web, `tenancy` says outright that it comes first: single-user
   local install vs multi-user server deployment forks auth, connection
   resolution, and the hosting target beneath it.
3. **Answer `agents`** — `none` (the ordinary answer) or `pots`. Answering
   `pots` layers `papercusp-ops-pots` onto this same root, which is why there
   is no separate "agentic" template to switch to: the agent plane was always a
   layer on the same app. Treat it as an architectural commitment, not a
   feature flag — it introduces app-owned plan runs, canonical work-item
   promotion with a blocked-by DAG, stable-agent assignment + required wake,
   and the one typed seam.
4. **Answer `domain`** — the noun the app ledgers and surfaces. Every
   aspect-level decision point (schema, panels, lexicon terms, searchable
   surfaces) derives from it.
5. **Expand the closure** (`resolveSelection` in `@papercusp/template-kit`,
   which takes your answers and returns the full template list) and work each
   aspect's GUIDE in dependency order: chassis → data-layer → ui.
6. **Answer `optional-planes`** — add `papercusp-data-sync` and/or
   `papercusp-search` to the composition now if the app needs them. Both drop
   onto either chassis.
7. **Run the union of checks.** Every template in your closure contributes its
   checks and all of them must be green — that additive rule is what keeps free
   composition safe without a deterministic generator.

## MUST

1. **`thin-app-template`** — this root adds guidance and decision points, never
   its own components. Capability belongs in aspects. Enforced by
   `checks/composition-integrity.test.ts`.
2. **`answer-target-first`** — `target` is answered before anything else. A
   chassis-level decision answered against the wrong chassis is not a small
   mistake; it is an app built on the wrong host.
3. **`full-union-green`** — the composed app passes the FULL union of its
   closure's checks, not a subset you found convenient.
4. **`dual-target-is-opt-in`** — `target: both` is chosen deliberately and
   stated in the ship disclosure. **Measured (P-005), so you can stop guessing
   at the tax:** the union is **6 check declarations for `both` against 5 for
   either target alone**. Each chassis contributes exactly ONE check — its
   `boot-e2e` — while `papercusp-app:composition-integrity`,
   `papercusp-data-layer:components-integrated`,
   `papercusp-ui:components-integrated` and `papercusp-ui:theme-tokens` are
   shared and paid once either way.
   So dual-target is **+1 declaration, not a doubling**.

   Read that number for what it is: a count of check *declarations*, not
   seconds. The one check it adds is the most expensive kind there is — build
   the app, boot the host, probe health — so the wall-clock cost is larger than
   `+25%` suggests, and only running both suites would say by how much. Choose
   `both` because the app genuinely ships two artifacts, never because it
   sounded more flexible.
5. **`agents-are-explicit`** — no agent work plane and no seam unless you
   answered `agents: pots`. The default answer cannot drag the plane in, and
   `checks/composition-integrity.test.ts` proves it rather than asserting it.
6. **`agentic-plan-work-plane`** — with `agents: pots`, every external or
   scheduled run uses an app-owned plan template, canonical promotion, real
   `blocked-by` edges, and `execution { appHarnessSlug, agentName }`. Only the
   actionable frontier is assigned and durably woken. Do not hide scheduling,
   direct work-item creation, or generic-pool dispatch in app code.
7. **`one-seam`** — with the plane composed, the deterministic app and agentic
   work plane meet at exactly ONE typed seam. That discipline is
   `papercusp-ops-pots`' own Tier B MUST; honor it, do not re-invent it in app
   code.

## SHOULD

- Keep the chassis swap honest. The reason one root serves both targets is that
  the data and UI closure is *identical*; if you find yourself branching on the
  target inside app code, that branch belongs in the chassis aspect instead.
- Record every decision-point answer. The answers are the ship disclosure that
  makes a free-form composition reviewable by someone who was not there.

## FREE

- Domain schema, routes, copy, brand, and which optional planes you compose.
- How you organise your own source tree — the closure constrains the seams
  between aspects, not the shape of your product code.

## If agents appear mid-build

Re-answer `agents` as `pots` and re-expand the closure. Do **not** grow an
ad-hoc orchestration loop inside app code: `papercusp-ops-pots` exists so the
plan/work-item/stable-agent execution contract arrives with its seam and checks
attached, and an app that hand-rolls one gets neither. Nothing else about the
app changes—the chassis, data layer and UI closure are the same either way,
which is exactly why this is an answer and not a different template.
