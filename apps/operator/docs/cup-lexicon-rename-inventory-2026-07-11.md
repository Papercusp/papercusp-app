# Cup-lexicon rename — executable inventory & location spec

> **Companion to plan `cup-lexicon-backend-zero-2026-07-11`.** This is the
> discovery artifact: the map, the guardrails, the collision map, and **where
> every rename lives**, so the agent that picks this up **proceeds straight to
> fixing** without re-running discovery. Authored 2026-07-11 by su-7a3c4041
> under owner mandate [owner 2026-07-11 10:38 EDT]: *"zero residuals of our old
> names anywhere in our app, frontend or backend."*
>
> **Status: discovery DONE, execution DEFERRED ("we'll finish it later" — the
> owner, 2026-07-11).** Nothing below has been edited yet except the two counter
> scripts. Read §0 (guardrails) and §2 (collision map) BEFORE touching anything.

---

## 0. Guardrails — read first (these are hard rails, not preferences)

1. **KEEP the flag-gated old-brand pack.** `libs/generic/lexicon/src/packs.ts`
   `THE_HIVE_TERMS` (labels Hive/Queen/Bee/Sentinel/Overwatch/Scout/Comb/…, pack
   id `the-hive`, gated by `FLAGS.THE_HIVE`) is the ONE sanctioned home for the
   old labels. **Never edit those labels, the pack id, or `FLAGS.THE_HIVE`.** It
   is excluded from every count below.
2. **Frozen SQL history is immutable.** `libs/papercusp/libs/db/sql/*.sql`
   already-applied migrations are never hand-edited. DB column/table renames go
   in **NEW forward migrations** (see §Phase-4). Old names persist in history
   irreducibly — that's expected, not a residual to fix.
3. **`sentinel` → `papercup`, NOT `operator`.** `operator` already means the
   app/host; a blind `sentinel→operator` collides catastrophically. Precedent:
   the codebase already has `cup_spawn` / `pot_mug_efficiency` MCP tools — the
   backend id is the lowercased NEW label.
4. **Term KEYS stay brand-neutral (lexicon D-001).** Internal identifiers are
   NEVER lexicon-driven. The lexicon term keys (`pot`, `brain`, `contributor`,
   `operator`, `overwatch`, `scout`, `cupboard`, `human`, `chunk`, `fleet`,
   `node`, `substrate`, `signal`) are the neutral keys and are already correct —
   do not "rename" a neutral key to a brand label.
5. **git-sync owns commit + push.** Do NOT `git add`/`commit`/`push`/`stash`.
   NEVER run a tree-wide destructive git op on the shared checkout
   (`git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`) — it
   wipes every peer's uncommitted work. To discard your own one-file change,
   re-edit that one file by hand.
6. **npm only** (never pnpm/yarn). Tests via the four canonical frameworks. UI
   verified inside the **Tauri desktop shell**, never a browser at :3055/:3070.
7. **Do not destroy a live peer's uncommitted work.** See §2 — the p2p fleet is
   live and owns the biggest chunk of the rename surface.

---

## 1. The rename map (old backend-id → new backend-id)

| old        | new       | notes |
|------------|-----------|-------|
| hive       | pot       | 76% of the mass; DB table `harness_shared.pots` (migration 557) ALREADY exists → backend is HALF-migrated, expect mixed state |
| queen      | mug       | `computeQueenWakeBrief→computeMugWakeBrief` already landed (fact WI-3967). `RED_QUEEN` flag + any `red_queen` table were prior deliberate keeps — re-confirm before renaming |
| bee        | cup       | `cup_spawn` tool already exists |
| sentinel   | **papercup** | **NOT operator** (rail #3) |
| overwatch  | kettle    | ⚠ currently in `scan-lexicon.mjs` KEEP-SET (old plan kept it) — under THIS mandate it is a RENAME |
| scout      | blender   | ⚠ same — was kept by the old plan, now a rename |
| comb       | cupboard  | `Cupboard`/`CupboardClient` already partly exist |
| colony     | fleet     | |
| keeper     | human     | only 32 hits |
| cell       | chunk     | ⚠ rampant English false positives (spreadsheet/table "cell") — hand-review each; NOT in the automated count |
| waggle     | signal    | only ~19 hits |

Casing: apply case-preserving (`hive→pot`, `Hive→Pot`, `HIVE→POT`).
Compound ids too: `hive-store→pot-store`, `listHives→listPots`,
`HIVE_INVITE_LINK_PREFIX→POT_INVITE_LINK_PREFIX`, `HiveSteeringTree→PotSteeringTree`.

**Genuine keeps (never rename — not our brand):** `hyperbee`, `hyperswarm`
(npm library names), `honeycomb` design-token file (unless owner says
otherwise), and the `THE_HIVE`/`RED_QUEEN` flag identifiers.

---

## 2. COLLISION MAP — the p2p backend surface (verify QUIET before editing)

The bulk of the operator-core rename mass is the p2p/sync/cross-hive/federation
layer — the shared surface a p2p fleet edits when active. **As of 2026-07-11
11:49 EDT this surface is QUIET, not under active edit:** the p2p fleet members
are **parked/idle** (last activity 2.5h–20h ago), `git status` shows **ZERO
uncommitted p2p-backend edits**, and the newest write to any p2p file was
**~08:58 EDT**. There is NO active collision right now; the risk is **latent** —
parked members are wakeable and could be re-assigned p2p work.

⚠ **Do not infer edit-activity from the roster.** Fleet MEMBERSHIP
(`fleet: p2p-*`), session `state: live`/`parked`, and a present-tense declared
INTENT ("resume drain") are NOT evidence anyone is editing — most are stale
post-compaction intents on idle sessions (`intentStale: true`, `lastActiveSecAgo`
in the thousands). **Check the WORKING TREE + locks (ground truth) per file at
edit time:** `git status --porcelain <path>` (uncommitted edits), file mtime, and
`locks:list` / `coord:presence { include_detail:true }` heldFiles. If those are
clean, the file is safe to edit now.

### p2p-hot surface (edit only after a working-tree/lock check; coordinate if a member is genuinely re-activated):
Everything under `packages/operator-core/lib/` matching the p2p/sync/federation
surface — this is the MAJORITY of the 20,777 operator-core hits and the 373
operator-core file-renames:
- `sync/**` (incl. `sync/hyperbee/**`, `sync-resolver/index.ts`, `sync/hyperbee/boot.ts`, `projections/register-all.ts`)
- the `cross-hive-*` cluster — **~39 files** (`cross-hive-boundary*`, `cross-hive-grants*`, `cross-hive-transport*`, `cross-hive-outbox*`, `cross-hive-asks*`, `cross-hive-swarm-transport*`, `cross-hive-reply*`, `cross-hive-two-hive*`, `cross-hive-wiring*`, `cross-hive-e2e*`, `deployment/cross-hive-cross-machine*`, `deployment/cross-hive-frame`)
- `hive-store.ts`→`pot-store.ts` (`listHives→listPots`, `federation-scope`)
- `hive-membership-admission*`, `harness/join-hive*`, `harness/create-hive-membership*`, `hive-directory.ts`
- `harness/git-sync/hive-git-*` (p2p-git fleet owns these)
- `harness/bootstrap-papercusp-hive.ts`
- **invite links** — `hive-invite-link.ts`→`pot-invite-link.ts`
  (`parseHiveInviteLink→parsePotInviteLink`, `HIVE_INVITE_LINK_PREFIX→POT_INVITE_LINK_PREFIX`).
  The `papercusp://pot` wire host is reportedly already done; the SYMBOL/file
  rename is p2p-adjacent → defer/coordinate.

### SAFE to do now (no p2p-fleet overlap) — start here:
- **Frontend (operator-vite)** — 1,232 hits. `src/components/left-sidebar/`
  (`HiveSteeringTree`, `HiveFederationStatus`, `LocalHivesControl`,
  `HivesRunningPill`, `hive-steering-tree.test.ts`), `src/components/adv/`
  (`RedQueenPanel`, `hive-control.ts`, `AdvShell.tsx`), 19 file-renames here.
- **Frontend (apps/operator, non-p2p)** — parts of the 2,547 hits.
  `app/harness/CreateHarnessPicker.tsx` (139) + its test (122),
  `app/harness/EntryGithubUrlForm.tsx` (74) + test (91),
  `app/adv/harnesses/HiveHeaderStrip.tsx` (74), `app/cupboard/CupboardClient.tsx`
  (119). Skip release/`lib/**` server files that the p2p fleet may touch.
- **TUI (apps/tui, Rust)** — 1,015 hits: `src/layout.rs` (208), `src/app.rs`
  (208), `src/main.rs` (116), `src/agent_pane_kind.rs` (72). Self-contained; verify
  with `cargo test`. No p2p overlap.
- **Benchmark/eval LABELS** — display strings only (arm KEY strings are a locked
  contract, see §Phase-5). `apps/operator/app/eval-viz/arms.ts` `armLabel()` is
  already renamed (returns Pot/Mug-ablated/etc.) and its 3 test files are green.
- **Docs/comments** — 974 doc hits, but many are HISTORICAL runbooks (D-002:
  leave historical plans/briefs untouched). Judgment per file.
- **libs/flags/src/types.ts** (192 hits) — rename flag DESCRIPTIONS/keys that
  carry old brand, but **keep `THE_HIVE` and `RED_QUEEN` identifiers**.

---

## 3. Counting / tooling (regenerate "all locations" on demand)

Two scripts live in `scripts/`:

- **`scripts/scan-lexicon.mjs`** — the MATURE scanner (git-ls-files based, keep-set
  + generated-artifact exclusions already correct). **Authoritative but partial:**
  its `TERM_RE` covers only **hive/bee/queen/sentinel**, and its KEEP-SET still
  *keeps* overwatch+scout (from the old plan). Run:
  `node scripts/scan-lexicon.mjs` (report) · `--json` · `--check` (exit 1 if any
  non-kept) · `--dir <path>` (scope a subtree).
  **Current reading (2026-07-11): 27,226 non-kept hits (26,252 code, 974 docs),
  1,129 kept-set, 13,312 files scanned.** This is the accurate CORE baseline.
- **`scripts/lexicon-residual-count.mjs`** — the all-11-term burndown counter
  (per-term table + `--by-file`). NOTE: it does NOT yet apply the keep-set or
  exclude generated artifacts (junit.xml/env-sidecars/llms-full.txt/plans-index),
  so its headline (41,048) OVER-counts. **First execution task: fold
  scan-lexicon's git-ls-files + keep-set + generated exclusions into this counter,
  and add overwatch/scout/comb/colony/keeper/cell/waggle to the term set** (and
  drop overwatch/scout from the keep-set) so one command gives an accurate
  all-term burndown + per-file inventory.

**True actionable estimate:** ~27k (hive/bee/queen/sentinel) + comb 1,091 +
colony 224 + keeper 32 + waggle 19 + overwatch/scout (uncounted, currently kept)
+ cell (hand-review) ≈ **~29–31k hand-editable references**, ~76% in
`packages/operator-core`, the majority of which is the p2p-hot surface (§2).

### Per-directory rollup (non-kept, hive/bee/queen/sentinel):
```
20777  packages/operator-core     (majority p2p-hot — DEFER; non-p2p subset safe)
 2547  apps/operator              (frontend + release/lib mix)
 1232  apps/operator-vite         (frontend — SAFE)
 1015  apps/tui                   (Rust TUI — SAFE)
  526  apps/operator-docs         (docs — mostly historical)
  281  docs/plans                 (historical plans — mostly leave)
  189  libs/flags                 (keep THE_HIVE/RED_QUEEN)
  143  libs/generic               (excl. lexicon pack)
   80  packages/agent-mcp
   77  rubrics/pot-coordination-health
   73  apps/operator-public
   69  apps/the-swarm-site
   59  templates/papercusp-ops-pots
   … (long tail: rubrics, briefs, scripts, plugin-sdk/loader, design-tokens)
```

### Generated / DO-NOT-EDIT buckets (excluded by scan-lexicon, inflate the raw counter):
`**/junit.xml` (~4k), `papercusp-desktop/src-tauri/env-sidecars/staging/**`
(~2k bundled JS), `apps/operator/public/internal/**` (llms-full.txt 441,
llms-small.txt 92, plans-index.md 152×2 — generated doc projections),
`**/coverage/**`, `*.map`, `*-lock.json`, `.materialized/`, `_retired/`,
`papercup-release/`.

---

## 4. File renames (660 basenames carry an old-brand token)

Regenerate the exact list any time:
`rg --files -g '!**/node_modules/**' -g '!**/_retired/**' -g '!**/dist/**' -g '!**/.materialized/**' -g '!**/papercup-release/**' | rg -i '(^|/)[^/]*(hive|queen|bee|sentinel|overwatch|scout|comb|colony|keeper|waggle)[^/]*\.(ts|tsx|js|mjs|rs|sql|md|mdx|json)$'`

Rollup by 2nd-segment dir:
```
373  packages/operator-core        (mostly p2p-hot cross-hive-*/sync/hive-* — DEFER)
140  papercusp-desktop/src-tauri    (mostly env-sidecars GENERATED — skip)
 68  libs/papercusp                 (orchestrator/harness)
 40  apps/operator
 19  apps/operator-vite             (SAFE — left-sidebar/adv components)
 10  apps/operator-docs
  3  docs/plans   ·  2 apps/tui  ·  1 each: operator-public migration, design-tokens honeycomb, papercusp-publish, holepunch-spike
```
Each file rename = rename the file + update every `import`/`require`/dynamic-import
+ any string path reference + the paired `*.test.*`. Use the LSP/`gitnexus:rename`
tools or `rg -l` to find all referrers before renaming.

---

## Phase-by-phase execution spec

### Phase 2 — backend code symbols (operator-core, non-DB) — MOSTLY DEFERRED (§2)
Order once the p2p fleet pauses: (a) `hive-invite-link.ts`→`pot-invite-link.ts`
(smallest, self-contained); (b) `hive-store.ts`→`pot-store.ts` +
`federation-scope` + `listHives→listPots`; (c) the `cross-hive-*` cluster (~39
files) — rename `cross-hive`→`cross-pot` across the cluster in one coordinated
pass; (d) `hive-membership-admission`, `join-hive`, `hive-directory`,
`bootstrap-papercusp-hive`; (e) `harness/git-sync/hive-git-*` (coordinate with
p2p-git). `agent-tools` + `agent-mcp` (P-012): any queen/bee/sentinel/hive/comb
tool symbols → mug/cup/papercup/pot/cupboard (several `*_spawn`/`*_efficiency`
tools already renamed). **Trap (EI-9469):** `listHives()` queries
`harness_shared.pots` (migration 557); in test/integration envs lacking that
table, `federation-scope.ts` catches + `console.warn`s → trips
vitest-fail-on-console. Ensure the migration is applied in the test DB before
asserting green.

### Phase 3 — frontend residual symbols — SAFE, START HERE
`apps/operator-vite/src/components/left-sidebar/`:
`HiveSteeringTree`→`PotSteeringTree`, `HiveFederationStatus`→`PotFederationStatus`,
`LocalHivesControl`→`LocalPotsControl`, `HivesRunningPill`→`PotsRunningPill`
(+ their `.test.tsx` + `hive-steering-tree.test.ts`).
`apps/operator-vite/src/components/adv/`: `RedQueenPanel` (re-confirm red-queen
keep vs rename with owner), `hive-control.ts`→`pot-control.ts`, `AdvShell.tsx`
internal refs, `HiveHeaderStrip`→`PotHeaderStrip`.
`apps/operator/app/harness/`: `CreateHarnessPicker.tsx` (139) + test,
`EntryGithubUrlForm.tsx` + test. `app/cupboard/CupboardClient.tsx` (119 — mostly
already `Cupboard`, sweep residual `comb`). `apps/tui/src/*.rs` (P-021, 1,015
hits — `cargo test` to verify). Verify UI in the Tauri shell per
`/internal/docs/testing/agent-e2e`.

### Phase 4 — DB schema migrations (live columns/tables) — needs a live PG read
Inventory live (non-frozen) old-brand columns/tables:
```sql
SELECT table_schema, table_name, column_name
FROM information_schema.columns
WHERE table_schema IN ('harness_shared','public')
  AND (column_name ~* '(hive|queen|bee|sentinel|comb|colony|keeper|waggle)'
       OR table_name ~* '(hive|queen|bee|sentinel|comb|colony|keeper|waggle)')
ORDER BY 1,2,3;
```
(Run via `dev:pg_query` read-only.) `harness_shared.pots` already exists (557) —
so some tables are migrated and their old-named siblings/columns are the targets.
For each: allocate a migration with `node scripts/next-migration.mjs --name
<slug> --intent "..."` (atomic allocator — NEVER `ls sql | tail`), write an
idempotent forward migration at `libs/papercusp/libs/db/sql/<NNN>-….sql`
(`ALTER TABLE … RENAME COLUMN …`), update EVERY query/ORM ref in code, run
`node libs/papercusp/libs/db/scripts/pull-schema.mjs`, apply via `db:migrate`
(never raw `psql -f`), then `npm run test:all:integration`.

### Phase 5 — locked wire/data contracts — careful, self-contained
- **Benchmark arm keys** (`apps/operator/app/eval-viz/arms.ts` `ArmId`/`ARM_IDS`:
  `'hive'`, `'queen-ablated'`, `'hive-realqueen'`, `'fifo-noqueen'`,
  `'native-serial'`; `packages/operator-core/lib/external-bench/hive-backlog-realqueen.ts`
  `HIVE_REALQUEEN_ARM`/`FIFO_NOQUEEN_ARM`, `hive-backlog-live.ts`,
  `su-independent-backlog.ts`). These strings are the cross-brief run-result
  contract — changing them requires **migrating stored `run_result` rows** (the
  arm id is persisted). Rename the constants + add a data migration mapping old
  arm ids → new in stored rows, and update every viz/eval surface keyed on them.
- **P2P/invite wire protocol** (P-041, p2p-hot — DEFER): `papercusp://pot` host
  reportedly done; still audit DHT topic strings + handshake/envelope field names
  for old brand.

### Phase 6 — tests, comments, docs, filenames
Tests move with their subject slice (never a separate pass). Comments/docstrings:
sweep in-code prose. Docs: `apps/operator-docs` (526) + `docs/plans` (281) are
largely HISTORICAL — per lexicon D-002, historical runbooks/plans describing past
paths are left as-is; only update LIVE reference docs. `/internal/docs` live pages
get the new brand.

### Phase 7 — verification
`node scripts/lexicon-residual-count.mjs` (extended) actionable == 0 (excl. pack +
frozen SQL + documented historical-doc exceptions); `npm run test:all` +
`test:all:integration` green; typecheck clean; live Tauri smoke under new ids;
force-deploy + owner report with the 0-count.

---

## Per-slice recipe (mechanical loop for the executor)
1. Pick the lowest-phase SAFE slice (§2). `coord:presence`+`locks:list` the target
   files — skip anything a live peer holds.
2. Rename symbols + file + **all** callers/imports/string-paths + the paired test,
   together, in one coherent slice (use `rg -l`, LSP rename, or `gitnexus:rename`).
3. `npm run test:affected` (route heavy runs through `scripts/pc-heavy.sh -- <cmd>`
   when host load1 > 1.5×cores, else the PreToolUse resource gate denies it).
   Schema/migration slices → `test:all:integration`.
4. Re-run the counter; confirm the actionable count DROPPED by ~the slice size.
5. `work_items:checkpoint` the new count; move to the next slice. git-sync commits
   automatically — do NOT commit yourself.

## Open decisions for the owner (surface, don't assume)
- **Scope depth vs. cost:** ~29–31k references, ~76% p2p-hot. Full backend+DB+wire
  zero is a large, delicate refactor that fights (or must wait on) the live p2p
  fleet. Option to re-pause the p2p fleet for a single clean backend pass, or to
  stop at user-visible + non-p2p and leave internal p2p ids for a later p2p-quiet
  window. (Disclosed to owner via coord msg `mrgiy7xu`, 2026-07-11.)
- **`overwatch`→`kettle`, `scout`→`blender`, `red-queen`:** these were KEPT by the
  prior plan; the new mandate renames them. Confirm before the sweep — they touch
  role names, flags (`RED_QUEEN`), and possibly table names.
