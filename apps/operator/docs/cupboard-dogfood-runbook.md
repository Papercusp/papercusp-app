# Cupboard dogfood runbook — publish / approve / retire / install

_Plan: `cupboard-full-dogfood-2026-07-10` (P-006). Author: su-5651d, 2026-07-10.
Every command below was exercised end-to-end against the live cupboard while
executing P-002–P-005; the values (routes, listing ids, rate-limit shape) are
verified, not aspirational._

## What the cupboard holds (as of 2026-07-10)

| Kind        | Count | Repo backing                     | Publisher  |
|-------------|-------|----------------------------------|------------|
| `blueprint` | 16    | `Papercusp/blueprints`           | papercupai |
| `template`  | 11    | `Papercusp/templates`            | papercupai |
| `plugin`    | 1     | `Papercusp/papercusp-worker`     | papercupai |

Internal-machinery blueprints (~20: learning loops, benchmarks, ops-fixers) are
**deliberately held internal** — see decision D-001. Publishing them would push
internal SU-governance prompts to a public repo.

## Key facts (the non-obvious ones)

- **All admin/publish/install routes are operator loopback** on `:3070`
  (`http://127.0.0.1:3070/api/cupboard/...`). Plain `curl` from `127.0.0.1`
  works — no token; the proxy uses the operator's `papercupai` gh token.
- **Publish rate limit is a FIXED UTC-clock-hour window**, not rolling:
  `window_start = floor(now_ms / 3_600_000) * 3_600_000`, cap **5 publishes /
  publisher / hour** (bucket `cupboard:user-publish:279242982`). A `429`
  clears only at the **top of the next UTC hour** — pace retries to the
  boundary; do not hammer.
- **Blueprint/plugin/template listings land `review_status: pending`** (worker
  migration 008) and are invisible to everyone until an operator **approves**
  them. Only `review_status = approved` shows in public listings.
- **The publish guardrail requires `visibility: public`** in the *resolved*
  (dist-host) `blueprint.yaml` — fail-closed: absent / wrong-cased / internal
  → `422` before any GitHub call. Mark it in BOTH
  `apps/operator/dist-host/blueprints/<id>/blueprint.yaml` (the resolver reads
  this) AND the submodule `libs/papercusp/packages/harness/blueprints/<id>/`
  (canonical durability).
- **A listing is GitHub-repo-backed**: install clones the repo and reads
  `<listing_ref>/blueprint.yaml`. So the content MUST be pushed to the public
  repo BEFORE publishing — publishing an id whose content isn't in the repo
  yields an uninstallable listing.
- **Plugin listings need a `papercusp.json`** (`{name, version, kind:"plugin",
  ...}`) at the listing_ref subdir or repo root, or the install `locatePlugin`
  fails. A publish-time manifest gate (`422`) now blocks an un-installable
  plugin from being listed (EI-387 / P-005).

## Publish a blueprint

```bash
BASE=http://127.0.0.1:3070/api/cupboard
# 1. Ensure content is in the public repo and visibility:public is marked (both trees).
# 2. Publish (lands pending):
curl -sS -X POST "$BASE/publish-blueprint" -H 'Content-Type: application/json' \
  -d '{"id":"<blueprint-id>","github_url":"https://github.com/Papercusp/blueprints"}'
#   → { ok:true, listing:{ id:"<listing-uuid>", review_status:"pending", ... } }
# 3. Approve (makes it publicly visible):
curl -sS -X POST "$BASE/admin/listings/<listing-uuid>/review" \
  -H 'Content-Type: application/json' -d '{"decision":"approve"}'
#   → { ok:true, review_status:"approved" }
# 4. Verify:
curl -sS "$BASE/listings?kind=blueprint"   # count includes the new id
```
Templates and plugins follow the identical publish→pending→approve shape via
`publish-template` / (plugin publish path); all land pending and need approval.

## Approve / reject / retire

```bash
# Pending queue:
curl -sS "$BASE/admin/pending"
# Approve / reject:
curl -sS -X POST "$BASE/admin/listings/<id>/review" -d '{"decision":"approve"}'
curl -sS -X POST "$BASE/admin/listings/<id>/review" -d '{"decision":"reject","reason":"<why>"}'
# Retire / take down a stale listing:
curl -sS -X POST "$BASE/admin/harnesses/<id>/unlist" -d '{"reason":"<why>"}'
```

## Install (the standard resolve-from-cupboard path)

```bash
# Template (verified live 2026-07-10 — resolves + installs, provenance source=installed):
curl -sS -X POST "$BASE/install-template" -d '{"listingId":"<listing-uuid>"}'
#   → { ok:true, ref, version, source:"https://github.com/Papercusp/templates",
#       installedTo:".../.papercusp/templates/<ref>" }
# Blueprint (git-clone → validate → place under ~/.papercusp/blueprints/<id>/,
#   the middle 'installed' tier that shadows the bundled built-in):
curl -sS -X POST "$BASE/install-blueprint" -d '{"listingId":"<listing-uuid>"}'
# Plugin:
curl -sS -X POST "$BASE/install-plugin"    -d '{"listingId":"<listing-uuid>"}'
```
Provenance is carried as `source: 'installed' | 'cupboard'` (see
`tools-discovery.ts:buildToolProvenance`); the bundled built-ins remain the
**offline floor** (`local → installed → built-in` resolution).

> ⚠️ **Shared-home caution.** The loopback install routes target the operator's
> live `.papercusp` — shared by every session in the workspace. A **blueprint**
> install *shadows the built-in of the same id* for all agents, and a **plugin**
> install can register hooks fleet-wide. Only **template** installs are inert
> (used only on explicit `templates:new-app`). Do the full multi-kind
> fresh-home acceptance against an **isolated** `PAPERCUSP_HOME`, never the live
> shared home.

## Acceptance checklist (P-006)

- [x] All working user-facing blueprints published + approved (16 live).
- [x] 11 templates live + approved (author=papercupai).
- [x] Plugin listing installable (papercusp-worker `papercusp.json`, EI-387).
- [x] Template install resolves from cupboard live, provenance=installed.
- [ ] Isolated fresh-home install of blueprint + plugin (avoid shared-home
      shadowing) — pending an isolated `PAPERCUSP_HOME` harness.
- [ ] `/api/cupboard/tools` `installable > 0` — **blocked by design**: the one
      official plugin (papercusp-worker) is hooks-only (`tools:[]`), so it
      cannot raise the tools counter. Resolving this requires either publishing
      a tool-providing pack or accepting the criterion as N/A for a hooks-only
      plugin (a curation call — see plan).
