# Dogfood arc — code-truth audit (2026-05-30)

Item-by-item audit of the whole dogfood plan corpus against the real codebase at
`/home/dev/papercupai-workspace/papercup` (branch `main`). **Code is the only
source of truth** — every verdict below was traced to actual implementation + wiring
(not the plan's own status claims, which are frequently optimistic). Verdicts:
IMPLEMENTED (built + wired) · PARTIAL · STUB (code exists, no caller/route) · MISSING ·
DEFERRED-BY-DESIGN · BLOCKED · DEPLOY-GATE.

> Method: 14 phase/master plans audited (11 by parallel code-reading subagents + 3
> follow-ups), with key claims spot-checked directly. The plan docs systematically
> **overstate** completion: several phases marked `shipped`/`code-complete` have real,
> unit-tested modules that are **not wired end-to-end**. That gap is the headline.

---

## TL;DR — the 8 things that are actually broken/incomplete

1. **Substrate is write-only (no read-loop).** `applyHyperbeeOpToPg` has ZERO runtime
   callers; no `read-loop.ts`/`write-hooks.ts`, no `pg_notify`, no PG→Hyperbee trigger,
   no backfill seeder. The Hyperbee substrate boots + reports "healthy", but **no harness
   state ever round-trips PG↔Hyperbee**. (Phase 5a P-031, 5b, 11) — this is the single
   biggest gap; it's the half that makes multi-engineer sync real.
2. **`completion_ref` is never written.** Schema + verifier daemon + UI card all real and
   wired, but nothing ever stamps `completion_ref` (`buildCompletionRef` is called only by
   its own test). So the verifier selects 0 rows forever, the UI card is always empty, and
   the tier-B "features shipped ✓" stat is permanently 0. (Phase 2)
3. **Phase 1b: real modules, disconnected pipeline.** OAuth/clone/attest/keychain/binding/
   two-channel all have real bodies (the plan's "types-only stubs" Now-block is outdated),
   BUT the only UI join entry sends an empty OAuth token by design, `createAttestationGist`/
   `verifyAttestation`/`claimBinding`/`supersedeBinding` have zero production callers, P-068
   isn't wired into the create-harness route, step-9 verification results are never persisted,
   and both daily re-check daemons are absent. `status: shipped` overstates reality.
4. **Phase 4 P-026 blocked by a real code bug.** `resolveProject(slug)` (`harness-core.ts`)
   loads the registry with NO workspaceId → reads the *active* workspace, but papercup is
   registered ONLY in the `papercusp-workspace` papercup (never sets `registry.current`),
   so `/api/harness/papercup/*` 404s unless the active workspace happens to be the papercup.
   Real data: papercup has 19 features, all `todo`, 0 attempts — nothing has ever run e2e.
5. **Phase 8 Insights/Contributors built but not mounted.** The live `HarnessDashboard` has
   NO Contributors tab and NO Phase-8 Insights tab (its "insights" tab is the old analytics
   panel). The real Phase-8 Insights is reachable only via the standalone `/harness/$slug/insights`
   route. P-049 (PR-reviewer settings) + most of P-069 (claim UI) are disconnected shells.
6. **Phase 9 cupboard has a live bug + gaps.** Listings proxy (`cupboard.ts`) fetches
   `${CUPBOARD_URL}/api/harnesses` but the deployed server serves `/harnesses` (no `/api`)
   → browse/detail 404 against the real server. No navbar item → `/cupboard` unreachable.
   Discord outbound webhook (P-054b) is dead code (zero callers, no storage/UI).
7. **Two real test failures (Phase 1a)** on stale hardcoded counts: `classify-tree.test.ts`
   asserts 9 submodules (actual `libs/` = 11); `ensure-schema-dogfood-binding.test.ts`
   asserts `DOGFOOD_REACTIVE_TABLES` length 13 (now 16). So "shipped, all tests pass" is false.
8. **v5 master is mislabeled** `status: ready` → should be `active`.

---

## Per-phase verdicts

### Phase 0 — Holepunch spike (`phase0-spike`)  — gate, Linux-smoke-only
Items are P-001..P-005 + D-001 (each with a/b/c sub-items).
- P-001a Linux x64 install: IMPLEMENTED (re-ran smoke, exit 0). P-001b/c macOS, P-001d Windows: MISSING (deferred per 2026-05-25 user direction). P-001e Tauri-bundle: PARTIAL (8 deps added to `apps/operator/package.json` via `f9b02723`; bundled-binary in-runtime smoke not done).
- P-002a loopback (actually public DHT): IMPLEMENTED. P-002b cross-network NAT: MISSING. P-002c symmetric-NAT: MISSING (informational).
- P-003a 2-writer: IMPLEMENTED. P-003b 3-writer / P-003c/d sleeping-peer reconnect / P-003e latency dist: MISSING (the hardest, dogfood-critical cases — laptop-closed-overnight — are untested).
- P-004a KV correctness: IMPLEMENTED. P-004b sustained / P-004c burst throughput: MISSING (no benchmark; throughput asserted, never measured).
- P-005 `RESULTS.md` gate record: MISSING (file absent; status only in README).
- D-001 PARTIAL PASS: accurate.
- **Verdict:** spike is honestly "Linux-x64 smoke-only"; the substrate-stability questions the gate exists to answer are unbuilt. macOS gate skipped by user direction. ACTION: none required (spike, accepted-risk) — but carry sleeping-peer + disk-growth as risks into 5a/11.

### Phase 1a — workspace + classifier + create-harness UI (`phase1a`)  — IMPLEMENTED, 2 failing tests
P-006 papercup workspace, P-007 5-rule classifier, P-013 dogfood PG schema, P-010 Entry1/3 backend, P-012 picker UI: **all IMPLEMENTED + live** (classifier consumed by the projects route; picker rendered in AdvShell + installed page; `init-local-dir` runs real `git init`).
- **BUGS:** 2 tests FAIL on stale hardcoded counts — `apps/operator/lib/harness/classify-tree.test.ts` (asserts 9 submodules; `.gitmodules` now 11) and `ensure-schema-dogfood-binding.test.ts` (asserts `DOGFOOD_REACTIVE_TABLES.length === 13`; now 16). Plan file-paths are stale (route lives in endpoint-route system, not `app/api/.../route.ts`; P-012 consolidated 7 claimed files → 1; Entry 4 is fully functional, not a stub). ACTION: fix the 2 stale test assertions.

### Phase 1b — OAuth + clone + attestation + binding + verifier (`phase1b`)  — real modules, NOT connected
- P-008 GitHub-URL clone: IMPLEMENTED (real + caller in projects route).
- P-068 canonical binding service: PARTIAL — all 5 fns real, but **zero production callers**; NOT wired into the create-harness route (plan claims it is); claim/supersede UI unmounted; P-068f daily re-check is a no-op + unscheduled; D-002 ETag strategy unimplemented.
- P-009 harness-link join: PARTIAL — real orchestrator + registered route + UI, BUT the only UI caller sends `token:''`/`githubUserId:0` by design → a real join is impossible from the product surface; two divergent link parsers (drift hazard).
- P-011 device attestation: PARTIAL — keypair gen real + called; `createAttestationGist` + `verifyAttestation` have **zero production callers**; scope precheck unimplemented; no keychain test.
- P-075 two-channel verifier: PARTIAL — real logic + schema columns + `BindingStatusBadge` (the one fully-wired sub-item), BUT step-9 never persists verification results to the columns the badge reads; daily re-check daemon absent; never executes in the real flow (empty token).
- D-001 JCS canonicalization: IMPLEMENTED. D-002 bulk-collaborator/ETag: MISSING.
- **Verdict:** `status: shipped` overstates — unit-tested modules exist, the integrated OAuth→clone→attest→bind→verify pipeline is non-functional from the UI. NOTE: the team already filed **F-DOGFOOD-002** (P-068 runtime) and **F-DOGFOOD-003** (P-011 attest/keychain runtime) in the papercup queue — these are tracked as dogfood features to run through the loop itself.

### Phase 2 — completion_ref + status verification (`phase2`)  — built, INERT (no writer)
- P-014 `completion_ref JSONB` (migration 080): IMPLEMENTED. P-015 working-state cols: IMPLEMENTED (schema only; `created_by_github_user_id` + `worked_by_history` have no writers). P-016 verifier daemon: PARTIAL (built + started at `instrumentation-node.ts:309`, but `WHERE completion_ref IS NOT NULL` never matches → selects 0 rows forever; plan-claimed test symbols live in the wrong file; no test covers stamp/divergence/backoff). P-017 UI card + recheck: IMPLEMENTED (renders, but always the empty branch).
- **CENTRAL GAP:** `buildCompletionRef` is called only by its own test; ZERO SQL `SET completion_ref` anywhere; the PR-merge path doesn't stamp it. So verifier + card are inert and the tier-B "features shipped ✓" stat is permanently 0. Latent bug: `contributors.ts:97` reads a `shipped_by_github_id` column migration 080 never adds.
- **Verdict:** schema+verifier+UI shipped at file level; the phase's *purpose* (status anchored to a real commit) is NOT wired end-to-end. ACTION (high value): add the writer — stamp `completion_ref` on PR merge / feature ship.

### Phase 4 — single-engineer dogfood on papercup (`phase4`)  — P-026 BLOCKED (real code bug)
- P-024 register papercup `state:private`: IMPLEMENTED (boot-wired; `register-papercup.ts` writes the papercup-workspace registry; `0010_harness_state.sql` adds `state`). NOTE: the wave's first guess of a `scripts/register-papercup-harness.ts` was wrong — that file doesn't exist; the real helper is `register-papercup.ts`.
- P-025 seed features: PARTIAL (CRUD real; **P-025a is FALSE in code** — `created_by_github_user_id` has no writer anywhere).
- P-026 run a feature e2e: **BLOCKED** — concrete code blocker: `resolveProject(slug)` (`harness-core.ts:203`) calls `loadHarnessRegistry()` with NO workspaceId → reads the *active* workspace; papercup is registered ONLY in `papercusp-workspace` and `register-papercup` deliberately never sets `registry.current` → `/api/harness/papercup/{launch,spawn,features,spec}` returns 404 `unknown project` unless active workspace is the papercup. Secondary: no always-on PG-only orchestrator claim loop (claim machinery needs `PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE=1`, off by default). Real data: papercup = 19 features, all `todo`, 0 attempts → nothing has ever run.
- P-027 observe / P-028 gate: MISSING (gated behind P-026). D-005 (private, no Hyperbee): honored.
- **Verdict:** P-024/P-025 done; P-026 is the key uncompleted dogfood milestone — needs the workspace-resolution fix **and** an actual owner-driven run (running real agents is an owner/operational action per playbook, not something I should `orchestrator.spawn` from a shell).

### Phase 5a — Hyperbee plumbing (`phase5a`)  — primitives shipped (flag-gated), DATA PATH unwired
- P-029 share wizard UI: PARTIAL — renders 9 steps but 3 backing routes don't exist (`/binding/resolve`, `share/finalize`); backfill is a `setTimeout(200)` stub; uses `useState` not nuqs (repo-rule violation).
- P-030 Hyperbee schema + Autobase: PARTIAL — corestore/autobase/schema-version real + boot-invoked; 3-writer convergence test skipped (native binding); `revoked_pubkeys` gate not implemented.
- P-031 PG↔Hyperbee projection: **STUB/PARTIAL (read side unwired)** — `write-hooks.ts` + `read-loop.ts` DON'T EXIST; `applyHyperbeeOpToPg` has zero runtime callers; no `pg_notify`; no backfill seeder; `enqueueFeature` appends to the in-process Autobase view only, never projected to PG; the read path reads a PG table the substrate never writes → loop broken end-to-end.
- P-066 bootstrap-progress indicator: IMPLEMENTED in-process (poller wired at boot) / PARTIAL real (never tracked real cross-peer merge — all harnesses private).
- P-070 `contributor_usage_events` ledger: **STUB/MISSING** — `usage-events.ts` runtime doesn't exist (types only); `emitUsageEvent`/`rollupForContributor` unimplemented; no emitters. Largest single overclaim.
- **Projection count is 9, not 8** (the plan undercounts — `usage` added later). All 9 do real PG upserts but none execute at runtime. Diagnostic stack (boot/health/status endpoints + `dev:dogfood_substrate_status` MCP + admin SSR page) IMPLEMENTED — but "healthy" = booted+idle, not sync-working.
- **Verdict:** `shipped` is accurate for substrate primitives + boot + diagnostics; overclaims the sync data path.

### Phase 5b — Hyperbee UI integration + clobber-toast (`phase5b`)  — PENDING follow-up audit (see below)

### Phase 6 — orchestrator distributed claim (`phase6`)  — PENDING follow-up audit (see below)

### Phase 7 — PR lifecycle (`phase7`)  — PENDING follow-up audit (see below)

### Phase 8 — sidebar tabs + Insights + contributor stats + profile (`phase8`)  — built, mostly UNMOUNTED
IMPLEMENTED: P-047a filters, P-047b pull-to-queue, P-050 vditor MarkdownEditor, P-072a-e user-profile page (real PG, both routes live), P-073a-f Insights cards (real data via real endpoint), P-073g first-visit force-route.
PARTIAL: P-047c (no unified detail panel w/ current PR), P-048 Contributors tab (fully built + real endpoint but **no live render site** — unreachable), P-071 activity badges (not wired into feature/PR avatars), P-072f (live Vite marketplace still links github.com; only the dead SSR page switched), P-073a/e (Project + HowItWorks cards show slug-derived placeholder, not real config).
STUB: P-049 PR-reviewer settings modal (UI shell, no endpoint, no trigger), P-069 claimed/unclaimed UI (5 of 6 components orphaned; no claim-binding endpoint).
- **BIGGEST:** the "sidebar tabs" thesis isn't realized — the live `HarnessDashboard` has no Contributors tab and no Phase-8 Insights tab (its "insights" tab = old analytics panel). Phase-8 Insights/Contributors are effectively invisible in normal navigation despite components+endpoints+tables being real.

### Phase 9 — Cupboard + Discord + sync-with-main (`phase9`)  — NOT code-complete
IMPLEMENTED: P-051a Cupboard server (Hono+D1), P-053 publish-from-wizard, P-055 sync-with-main trio, P-076 tier-A indexer (cron-wired; README "no-op stub" note is stale). D-001 (Hono+D1) honored.
- P-051b deploy: DEPLOY-GATE — actually ALREADY deployed (`4bd3a952`/`740b5034`), contradicting "deploy remains"; remaining is pure ops (D1 apply, `wrangler secret put`, DNS) + hostname ambiguity.
- P-052 Cupboard UI: PARTIAL — **navbar item MISSING** (`/cupboard` unreachable from nav); claim CTA is static prose; **proxy path BUG**: `cupboard.ts:31,69` fetch `/api/harnesses` but the server serves `/harnesses` → browse/detail 404 against the real server.
- P-054 Discord: PARTIAL — deep-link real (054a); **outbound webhook (054b) is dead code** (zero callers, no `discord_webhook_url` storage/UI, no event hookup, no test).
- **Verdict:** "🟢 CODE-COMPLETE, only P-051b deploy remains" is inaccurate on two counts (already deployed; not code-complete). ACTION (easy wins): fix the `/api/harnesses` proxy path; add the navbar item.

### Phase 10 — Hyperdrive peer-mirror (`phase10`)  — DEFERRED-BY-DESIGN (correctly unbuilt)
P-056..P-060 all MISSING. `packages/holepunch-substrate` doesn't exist; only `libs/holepunch-spike` (throwaway). Plan explicitly defers indefinitely. No gaps/bugs — correct that it's unbuilt. ACTION: none.

### Phase 11 — multi-engineer dogfood (`phase11` -24 → -26)  — wiring real (gated off), milestone not done
- -24 correctly `status: superseded`; -26 `status: active`. -26 renumbered (P-061..065 → P-077..081).
- P-078 swarm wiring: IMPLEMENTED but **gated OFF + starved** — `joinHarnessSwarm` + boot honors `swarmBinding` + `boot-all` reads `.papercusp/shared.json`; unit-tested incl. real 2-store Autobase replication via piped streams.
- P-077 bind papercup as first shared harness: STUB/MISSING — ShareWizard `/share/finalize` route DOESN'T EXIST; `runBackfill` is a 200ms no-op; nothing sets `state:'shared-private'` → `defaultResolveSwarmBinding` always returns null → every harness boots `swarm: null`.
- P-079 cross-machine smoke / P-080 soak / P-081 gate+D-001: MISSING (manual; never run). P-062 stress script / P-063 F-DOGFOOD-002 capture / P-064 onboarding doc / P-065 cupboard-publish: MISSING.
- **Verdict:** "cross-machine replication wiring SHIPPED" holds at the code level (real + tested in isolation), but it's off by default, never verified cross-machine, and the share→shared.json→boot-binding chain is broken at the missing finalize route. The milestone is not done.

### Master chain v1–v5  — one real doc bug
- v1–v4 all correctly `status: superseded` (in `archive/`). v3/v4 lack the `superseded_by:` frontmatter field (banner-only) — minor consistency gap.
- **v5: `status: ready` is MISLABELED → should be `active`** (it's the live master with phases shipped/in-progress). The one real doc fix.
- No false implementation claims found in v5's spot-checked done-markers. v1's items all map into later phases; nothing orphaned (superseded mechanisms deliberately replaced).
- Carve-outs (`proxy-witness-pattern`, `plans-harness-scoped`): design drafts, deferred, nothing to implement.

---

## What I can safely complete (code gaps) vs what needs the owner

**Safe, bounded code fixes (candidates to do now):**
- Phase 1a: fix 2 stale test assertions (classify-tree 9→11 submodules; reactive-tables 13→16).
- Phase 9: fix cupboard proxy path `/api/harnesses` → `/harnesses`; add `/cupboard` navbar item.
- Phase 2: add the `completion_ref` writer (stamp on PR-merge / feature-ship) — unblocks verifier + tier-B. (Medium; high value.)
- Phase 8: mount ContributorsTab + Phase-8 InsightsTab in the live HarnessDashboard. (Medium UI wiring.)

**Needs owner / coordination / can't be done from a shell:**
- Phase 4 P-026 e2e run (owner/operational; running real agents) — but the workspace-resolution fix (resolveProject scoping) IS a code fix I could do.
- Phase 5a/5b/11 substrate read-loop + usage-events runtime — large, flag-gated, and another agent (28dbf719) is actively in `packages/coordination`; coordinate before touching.
- Phase 1b pipeline wiring — partly tracked as F-DOGFOOD-002/003 (team intends to dogfood these).
- Phase 0 macOS/Windows/sleeping-peer — needs other hosts; deferred by user.
- Phase 9 P-051b — pure ops.
</content>
