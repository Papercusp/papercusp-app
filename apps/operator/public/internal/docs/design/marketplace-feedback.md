# Marketplace pages — designer feedback
URL: /internal/docs/design/marketplace-feedback

Concrete UX feedback on /marketplace and its 4 tabs. Captured live against the running operator with installed templates, snapshots, and zero published plugins. Cross-cutting issues first, per-tab notes second.

:::caution\[Surface superseded — the Marketplace was replaced by the Cupboard]
The `/marketplace` UI this memo critiques no longer exists. There is no
`app/marketplace/` directory, no `app/marketplace/layout.tsx`, no
app-level `app/marketplace/MarketplaceList.tsx`, and no
`/marketplace/<slug>` detail route. (A `MarketplaceList.tsx` does still
live inside the `marketplace-public-ui` lib at
`libs/marketplace-public-ui/src/MarketplaceList.tsx`, but it is not the
app's browse surface.) The browse/install surface is now the
**Cupboard** (`/cupboard` → `apps/operator/app/cupboard/CupboardClient.tsx`):
a single storefront with **kind-filter tabs** (`?kind=` nuqs param, the
`ViewFilter`/`VIEW_FILTERS` union). As of 2026-07 the tab set is `all /
harness / blueprint / template / plugin / pack / knowledge-pack /
tools` (D-002 of `cupboard-public-release-2026-07-12` retired the separate
`hive-blueprint` tab: a pot blueprint — `blueprint_kind==='pot'` — now folds
into the `blueprint` tab, distinguished by a "pot template" badge rather than
getting its own tab; `template` is instead a distinct listing kind carrying
first-party app templates). Labels resolve through the lexicon
(`useLexicon()`), not statically: **All /
`<pot-plural>`** (e.g. "Pots" or "Hives" depending on the active brand pack —
never "Harnesses") **/ Blueprints / Templates / Plugins /
Packs / Knowledge Packs / Tools**. Note there is no **Snapshots** tab: the `snapshot` kind was
retired (`retire-snapshots-instance-spec` D-005 — the Cupboard
distributes recipes/blueprints, not tarballs). This replaces the old
4-tab Overview/Templates/Plugins/Snapshots IA. The per-listing detail
route is `/cupboard/[id]` (keyed by the listing **id** —
`router.push('/cupboard/' + listing.id)`) — the slug-based
`/marketplace/<slug>` detail page is gone, so don't assume slug routing
carried over.

A backend `marketplace` endpoint-route and the
`@papercup/marketplace-public-ui` lib still exist, but they are not the
Cupboard browse path. The surviving backend routes — `GET
/api/marketplace/catalog` and `GET /api/marketplace/spawnable` — are
UNGATED and serve only the bundled **fallback catalog** for the internal
`scaffold_harness` verb and prompt-build's "Available templates" section
(the legacy `:3057` marketplace server and the `FLAGS.MARKETPLACE`-gated
`/marketplace` UI are both retired). The Cupboard browses via
`/api/cupboard/listings`, not `/api/marketplace`. The page-level
critiques below (tab strip, detail page, per-tab stats) describe a
retired surface. Keep them only as historical design intent for the
Cupboard rebuild.
:::

Captured live by walking
`http://localhost:3070/marketplace?ws=default` and the four tabs
(Overview / Templates / Plugins / Snapshots) plus a detail page.
Screenshots in `/tmp/mkt-{overview,templates,plugins,snapshots,
detail}.png`. Read alongside `app/marketplace/layout.tsx`,
`MarketplaceList.tsx`, the per-tab `page.tsx` files, and the
`@papercup/marketplace-public-ui` package the layout pulls from.

***

# The shape of the surface

Four tabs across the top, each with a primary label + subtitle:

| Tab       | Subtitle        | Job                             |
| --------- | --------------- | ------------------------------- |
| Overview  | How it works    | Onboarding + category browse    |
| Templates | Ready workflows | Browse + install full workflows |
| Plugins   | Extra tools     | Browse + install plugins        |
| Snapshots | Saved setups    | Local + published snapshots     |

Plus a detail page at `/marketplace/<slug>` for individual packages.

***

# Cross-cutting issues

## C1. The detail page is broken right now

**This is the most important thing in this memo.** Visiting
`/marketplace/papercup-coding?ws=default` (or
`/marketplace/papercup-org`) renders just:

> papercup-coding
>
> This package isn't in the catalog.
>
> ← back to marketplace

…even though both are *installed* and visible on the Templates tab.
The link from the catalog row even points at this URL
(`<a href="/marketplace/papercup-coding">`). So **clicking any
template in the catalog leads to a dead-end page**.

**This is engineering, not design** — but flagging here so the
designer doesn't redesign a detail page that doesn't currently load.
Whoever owns marketplace routing should fix the `[slug]` route to
hydrate from the local catalog manifest, or the catalog rows should
not link if the detail page is unreachable.

For the design memo's purposes, **assume the detail page works** when
proposing flows below; just know that what's on screen today is a
404 stub.

## C2. Search is on 3 of 4 tabs

Search input exists on Overview, Templates, Plugins. **Missing on
Snapshots.** A user who already has 10 local snapshots can't search
them by name/harness — they have to scroll the whole list.

**Fix:** add the same search input to Snapshots. Filter by the
`name`, `harness`, or `created` field.

## C3. The "available" / "installed" counts contradict themselves

Top of each list tab shows two badges. On Plugins the user sees:

> 0 available
> 7 installed

That looks like a contradiction. A new user reads this as *"there are
0 plugins to install, but I somehow have 7"*. The truth is that
*"available"* means *"in the public catalog"* and *"installed"*
includes built-in/local plugins not in the public catalog. But
nothing on screen explains that.

**Fix:** rename "available" → "in catalog" and add a tooltip:
*"Plugins published to the public marketplace. Locally-installed
plugins (including built-ins) may not appear here."* Or merge the
counts: *"0 in catalog · 7 installed (1 from catalog, 6 local)"*.

## C4. Heading is repeated three times per tab

Every tab page has:

1. The tab label in the nav (e.g., "Templates / Ready workflows").
2. A page eyebrow `TEMPLATES`.
3. A page heading `Pick a workflow to install`.
4. A description paragraph.

That's four pieces of chrome before any content. The user has clicked
"Templates" — they know they're on Templates. The eyebrow + heading
duplicate what the tab said.

**Fix:** drop the all-caps eyebrow. Keep the heading as the *action*
("Pick a workflow to install") since it tells the user what to do.
Or invert — keep the eyebrow as orientation and shorten the heading
to one line. Pick one.

## C5. Stats under the header mix scopes

On Templates: *"2 available · 68 local projects"*. **What are 68
local projects?** A user has 2 templates installed, but "local
projects" appears to count *every* project directory (including
ones not derived from a marketplace template). The number is
larger than the catalog count by 33×, which is alarming-looking.

**Fix:** drop "local projects" from the Templates header — it's a
different concept (project directories vs. templates). If you want
to show installed-templates count, say *"2 available · 2 installed"*
(matching the rest of the marketplace's vocabulary).

## C6. No "what's new" / "recently published" / "featured"

Overview page is a static three-card brochure: Templates / Plugins /
Snapshots. No trending, no recently-published, no editorial picks.
For a marketplace to feel alive, *something* has to update.

**Fix:** Overview gets a *"Recently added"* strip below the
explainer. Pull from the most-recently-published rows in each
catalog. If that's empty (early-stage marketplace), say so:
*"Marketplace is just getting started — be the first to publish a
plugin"* with a link to publishing docs.

## C7. No filter / sort controls on lists

Templates, Plugins, Snapshots all render flat lists. There's a
search box but nothing for: filter by category / tag / kind, sort
by name / date / size, or "show only mine vs. all."

**Fix:** add a single filter row above each list:

* Templates: kind (coding / org / department / etc.) + sort (name /
  newest / popular).
* Plugins: capability tag (publishing / integration / dashboard) +
  sort.
* Snapshots: harness + has-redactions + sort.

## C8. No update affordance on installed items

Templates tab shows `papercup-coding · v0.1.0 · INSTALLED · Uninstall`.
There's no signal whether a newer version exists. A user has no way
to know if they're current.

**Fix:** when an installed item has a newer version in catalog, show
*"v0.1.0 · update available → v0.2.0"* with an *"Update"* button
where *"Uninstall"* sits today (or alongside it).

## C9. Tab labels use a double-line pattern; subtitles are noisy

Every tab is two lines:

> Overview        Templates        Plugins        Snapshots
> How it works    Ready workflows  Extra tools    Saved setups

The subtitles ("How it works", "Ready workflows", etc.) are a soft
explainer for first-time users — but they make the tab strip take
\~50% more vertical space and make active-state styling harder to
read. Once a user knows the four words, the subtitles are
permanent visual debt.

**Fix:** drop the subtitles from the tab strip. Move them to the
page heading or a tooltip. Active tab gets a clear underline +
bolder weight.

## C10. Mobile responsiveness untested

The catalog list, snapshot cards, and tab strip all assume desktop
width. On mobile (where users may legitimately want to browse the
marketplace), the tab strip will wrap and the cards will overflow.

**Fix:** below `--breakpoint-md`: collapse tabs to a `<select>` or
horizontal-scroll strip. Snapshot cards collapse to single-column
with metadata stacked vertically.

***

# Per-tab notes

## Overview tab

**What works:**

* "Three steps, all local" is a clear onboarding explainer.
* Three category cards (Templates / Plugins / Snapshots) with
  one-line descriptions and "Browse →" — clear action surface.
* The tagline *"Find a workflow. Run it on your machine."* is good
  positioning.

**What's missing:**

* No editorial content or live data (see C6).
* The search input on Overview is unscoped — typing "publish" should
  ideally show results across all three tabs, not just titles. (Test
  what current behavior is and clarify.)

## Templates tab

**What works:**

* Card structure (title, description, version, license, author,
  install/uninstall) is clean.
* *Installed* badge + matching action button (Uninstall vs. Install)
  is intuitive.

**Defects:**

* See C5 — "68 local projects" is the wrong scope.
* See C8 — no update affordance.
* See C7 — no filter/sort.
* The catalog rows are clickable (link to `/marketplace/<slug>`) but
  the detail page is broken (C1). Until the detail route is fixed,
  the rows lead to a dead-end.

## Plugins tab

**What works:**

* Empty state is friendly and actionable: *"No plugins published
  yet. Try a broader search, or switch Marketplace tabs."*

**Defects:**

* See C3 — *"0 available · 7 installed"* contradicts itself without
  explanation.
* The user has 7 installed plugins (visible in `/settings/plugin-runtime`)
  but they're entirely missing from the marketplace UI — no list
  of *"Installed plugins on this machine"*. If a user wants to
  uninstall a built-in plugin, there's no obvious surface for it
  inside the marketplace.

**Fix:** show two sections on the Plugins tab:

1. *"Public catalog"* — what's available to install (currently 0).
2. *"Installed locally"* — what the user already has (currently 7),
   with Uninstall + Update affordances.

## Snapshots tab

**What works:**

* Strongest tab structurally. Each snapshot card has rich metadata:
  HARNESS / CREATED / SIZE / FILES / PLUGINS / REDACTIONS.
* Three clear actions per card: *Instantiate / Publish / Delete*.
* Section header: *"Your snapshots (10) · Captured on this machine.
  Fork to clone the state, publish to share, delete to clear local
  copies."* — explainer + count + actions all in one line. Good
  pattern; reuse on other tabs.

**Defects:**

* *"REDACTIONS · 0 verified · 1 warnings"* appears on every card with
  no explanation. A new user has no idea what redactions are or
  what 1 warning means.
* Section header says *"Your snapshots (10)"* but the page header
  also says *"0 available · 10 on your machine · 1 published"* —
  *"on your machine"* and *"Your snapshots"* are the same thing said
  twice in slightly different ways.
* See C2 — no search.
* See C7 — no filter (e.g., "show only published").
* Snapshot names look like: `sheets snapshot @ 2026-05-02T02:27`,
  `v1-final-test`, `v1-e2e-test-3`, `v1-e2e-test-2`. Not a design
  issue per se but: the inconsistent naming convention says nobody's
  forced to give meaningful names. Empty-name snapshots are hard to
  recognize at-a-glance.

**Fixes:**

* Tooltip + small "?" icon on REDACTIONS field linking to a doc page
  *"What are redactions?"*. Don't expand inline (too noisy on cards).
* Drop one of the two count strings (the page header is more
  prominent; keep that, drop the section-header parenthetical).
* Add *"Group by harness"* / *"Show only published"* filters above
  the list.
* Rename suggestion: *"Snapshot name"* placeholder during creation
  could nudge: *"e.g. before-refactor / v1-stable / fix-attempt"*.

## Detail page (`/marketplace/<slug>`)

**Currently broken** (C1) — won't review design until route works.
When fixed, a detail page should at minimum show:

* Package metadata (version, author, license, last updated)
* Full description / README rendering
* What it installs (file paths, plugin enables, env vars touched)
* What it can access (capability declarations)
* Install / Uninstall / Update button
* Versions list (changelog)
* Source link (GitHub / npm)
* Reviews or usage stats if applicable

***

# Visual quality

A few cross-cutting visual things that affect every tab:

* **Eyebrow casing**: All-caps eyebrows (`MARKETPLACE`,
  `TEMPLATES`, `PLUGINS`, `SNAPSHOTS`, `TEMPLATE CATALOG`,
  `PLUGIN CATALOG`) are heavy. They were probably introduced to
  match the operator HUD aesthetic but feel out of place on what
  should be a calm browse surface. Reserve uppercase for one
  meaning (e.g., section dividers); body labels go in sentence case.
* **Stat strip styling**: numbers like `2 available · 68 local
  projects` look like CLI output. Could become small chips with
  consistent spacing — visually grouped, no separator dots needed.
* **Card hover states**: from screenshots, cards have border but no
  hover affordance. A user can't tell they're clickable until they
  read the cursor change. Add a 1-2% lighter background on hover +
  tiny shift.
* **Action buttons**: *Uninstall* / *Install* / *Publish* / *Delete*
  / *Instantiate* — all rendered identically (border + label).
  Different consequence levels, same visual weight. Destructive
  actions (Uninstall, Delete) should be distinguishable (red text or
  border; or hidden behind a kebab menu).

***

# Top-priority list

If the designer (with eng support for C1) ships **one** thing:

> **C1 fix the detail route** + give the detail page a real
> design. Today the list rows go to a 404 stub — the entire
> "browse → click → install" flow is broken at the click step.
> Without this fixed, none of the tab UX matters.

If they can ship **one** design-only thing alongside:

> **C3 + Plugins tab restructure** — show two sections (catalog +
> locally installed) with non-contradictory counts. The current
> *"0 available · 7 installed"* is the most confusing single thing
> on the marketplace.

Three more cheap wins:

1. **C9 drop tab subtitles** — gain \~50px vertical, quieter visual.
2. **C2 search on Snapshots** — one input copy/paste away.
3. **REDACTIONS tooltip on Snapshot cards** — single span change.

***

# How I gathered this

* Loaded `localhost:3070/marketplace?ws=default` in Edge.
* Walked all four tabs, captured rendered text + screenshots.
* Tested detail link by clicking from the catalog AND by direct URL
  (both forms 404 with "not in catalog").
* Verified search input presence per tab via DOM query.
* Cross-referenced against `app/marketplace/layout.tsx` (tab list)
  and the per-tab `page.tsx` files for IA confirmation.
* Did not install or uninstall anything; observations are read-only.
