# Test-coverage gap lists — stable domains (2026-06-07)

**Plan:** `app-wide-test-coverage-2026-06-05` (P-001 audit artifact, regenerated current-state).
**Brief:** BRIEF-app-wide-test-coverage-2026-06-07 (Brief 4 of the 16-brief fan-out).
**Method:** test-file ÷ source-file sibling matching (a proxy, not line coverage), filtered by
stability (git churn since 2026-06-04) and the live collision contract (`coord:presence`).

The Wave-1 + Phase-2-mapped work all landed before this audit (~46 files / ~554 cases by
su-5cf8c's fan-out + Briefs 60/61, then this brief's residual tranche below). This document
records the **current** per-area gap lists: what is now covered, what was closed today, and
what remains — each remainder with `{file, untested-path, suggested-test, canonical-home}`
and the reason it was *deliberately* left.

---

## 1. `packages/agent-mcp/src` (read-side MCP tools) — was ~29%, now 37/52 sibling-tested

**Closed today (this brief's tranche, all green):**

| file | tested path | test |
|---|---|---|
| `tools/features/history.ts` | section assembly, truncation, audit-row ISO/unwrap formatting, degraded paths, arg caps | `tools/features/history.test.ts` (14) |
| `tools/features/search.ts` | FTS vs recency branch, status/tags/limit binding, error→degraded, slug guard | `tools/features/search.test.ts` (12) |
| `tools/features/list_related.ts` | src-lookup degraded paths, tags coercion, no-tags short-circuit, binding | `tools/features/list_related.test.ts` (11) |
| `tools/features/tag_vocabulary.ts` | bigint→Number projection, error→degraded, binding, caps | `tools/features/tag_vocabulary.test.ts` (5) |
| `tools/features/get.ts` | drizzle path: hit verbatim / not-found degraded / slug guard | `tools/features/get.test.ts` (3) |
| `tools/harness/get.ts` | summary projection vs full+featureCounts (null-status drop, Number coercion) | `tools/harness/get.test.ts` (4) |

**Closed in tranche 2 (2026-06-07, second pass — churn re-measured at 0 since 06-05):**

| file | tested path | test |
|---|---|---|
| `tools/harness/list.ts` | registry⊕projects merge (enrichment, source tagging, dedup, limit, summary/full), payload guards | `tools/harness/list.test.ts` (9) — reshape settled, previously skipped for churn |
| `resources/audit/recent.ts` | {entries} projection, query shape, capability | `resources/audit/recent.test.ts` (3) |
| `resources/hindsight/banks.ts` | companyId resolution, all degraded paths (missing/corrupt registry) | `resources/hindsight/banks.test.ts` (4) |
| `resources/harness/issues.ts` | template list expansion, {slug} match, schema-identifier sanitization, error→degraded | `resources/harness/issues.test.ts` (4) |

**Remaining gaps (deliberate, with reasons):**

| file | untested path | suggested test | canonical home | why left |
|---|---|---|---|---|
| `src/server.ts` (478) | MCP server wiring / transport lifecycles | spin-up integration | `src/server.integration.test.ts` | process wiring, not unit logic; `server-dispatch.test.ts` covers dispatch |
| `src/index.ts` (240) | entrypoint composition | smoke import | n/a | barrel/bootstrap; exercised by every tool test |
| `src/provisioning.ts` (154) | credential/provision flow | PG integration | `src/provisioning.integration.test.ts` | next integration-tranche pick |
| `tools/harness/status.ts` (86) | status aggregation | tx-mock unit | sibling `.test.ts` | 1 recent commit, reshape neighborhood |
| `tools/artifacts/{save,load,append,delete}.ts` | artifact CRUD | tx-mock unit | sibling `.test.ts` | 2 recent commits on save.ts — family being touched |
| `tools/tasks/{list,get}.ts`, `tools/goals/get.ts` | drizzle list/get convention | chain-mock unit | sibling `.test.ts` | convention already documented by `goals/list.test.ts`; marginal |

## 2. `packages/operator-core/lib` (stable pure-logic clusters) — near-saturated, verified

The P-003 named clusters are covered: `auth.test.ts`, `auth-audit.test.ts`,
`auth-rate-limit.test.ts`, `operator-rate-limit.test.ts`, `agent-auth-detect.test.ts`,
`tool-authz-audit.test.ts`, `__tests__/tool-auth-gating.test.ts`, `validators.ts` (tested),
`design-ir/validate.ts` (tested), `auth/require-principal.test.ts`.

**Remaining untested files are NOT stable-pure-logic gaps:**

| file | why left |
|---|---|
| `agent-tools/coordination/tools/promote.ts` (1017) | **Brief 7's primary surface** (promote wave → child harness) — ships with its build |
| `endpoint-route/routes/**` (the large tail) | HTTP route handlers — integration surface; PG-integration tranche HELD |
| `fleet/**`, `sync/hyperbee/**`, `events/await/**` | Briefs 1/2 + EI-79 rewrite — active churn, excluded by contract |
| `voice-node/codec.ts` | opusscript WASM seam on `@papercusp/p2p-voice` — Brief 6's voice-transport neighborhood; round-trip test ships with that work |
| `dev-data.ts`, `iq-battery/corpus.ts` | fixture/corpus data, not logic |

**Integration tranche REOPENED in tranche 2** (judgment call: the hold condition — "baseline
settles" — is met; `self-contained-migration-baseline` is listed SHIPPED in the brief index):

- `plan-items/claims.integration.test.ts` (15 cases, real PG, migration 141 verbatim) — the
  lease store's acquire/steal/conflict, the D-003 asymmetric heartbeat-kind matrix, ttl
  clamps, owner-checked release, `renewOwnerActivityClaims` scoping, sweep. *Correction to
  this audit:* `claims.ts` was already INDIRECTLY exercised via the liveness-layer tests
  (`plan-items.integration.test.ts`, `activity-claim-renewal`, the two-instance authority
  test) — sibling-matching missed them; the new test still added the store-level matrix
  nobody covered, and caught a real diagnostic bug: a lapsed-own claim's heartbeat reported
  "held by another owner" instead of "lapsed — re-acquire" (fixed in `claims.ts`).
- Drive-by fix: `plan-item-convert.integration.test.ts` was broken by the migration-178 rank
  columns (its local DDL seed predated them) — patched with the §1 ALTERs, mirroring
  work-items-lifecycle's setup; Brief 2 notified.

## 3. `apps/operator/app` (UI) — was ~30% (122/414), now 151 test files

**The 15 Phase-2 mapped gaps all landed** (su-5cf8c fan-out, verified green 2026-06-07:
96 tests across plans-api-result, harness-actions, aria-live-bus, tauri-detect,
PlanBucketTabs, AudienceModeSelector, primitives [icon-map ??-fallback guard],
useHarnessClaimStatus, useWizardStatuses).

**Closed today (this brief's tranche, all green):**

| file | tested path | test |
|---|---|---|
| `_components/routePending.ts` | href normalization, harness/generic target, begin/finish lifecycle + html attrs, min-visible-floor timers, renavigation cancel | `routePending.test.ts` (25) |
| `_components/route-progress-document.ts` | full veto table + origin/path/hash URL rules | `route-progress-document.test.ts` (17) |
| `_components/route-link-progress.ts` | Link-level veto table | `route-link-progress.test.ts` (14) |
| `_components/operator-chat-layout.ts` | width ceiling/clamp/offset math (incl. the deliberate 56px floor) | `operator-chat-layout.test.ts` (8) |
| `adv/harnesses/useHarnessData.ts` (468) | `parseWorkingUsers` normalization; features/issues/agents hooks: REST mapping, error path, NON-EMPTY-only Zero overlay (no-clobber), defensive row coercions, patch merge, pending-count fallback, refresh re-pull | `useHarnessData.test.tsx` (18) |

**Remaining gaps (deliberate, with reasons):**

| file | untested path | suggested test | canonical home | why left |
|---|---|---|---|---|
| `admin/plans/plans-api.ts` (1509) | the fetch wrappers (fetchPlanList/fetchPlan/…) | fetch-stub unit | sibling (extend `plans-api-result.test.ts`) | thin fetch wrappers; the pure helpers (bucketOf/staleConflictOf/applyPlanFilters/locks) ARE tested (plan-buckets, plans-api-result) |
| ~~`adv/create/use-create-data.ts`~~ | **CLOSED in tranche 2**: scope precedence (`?h`/`?scope`/sub-harness union), localStorage fallback, plan-list maps (real bucketOf), inbox tag/dedup/counts/facets, refresh fan-out | — | `use-create-data.test.tsx` (15) | — |
| `_components/voice/operator-voice-runtime.ts` (213), `_components/voice/stt-voicemode.ts` (82) | voice runtime / VAD wrapper | mock MicVAD | sibling | voice surface (Briefs 5/6 neighborhood); stt-voicemode is a thin `@ricky0123/vad-web` wrapper — logic lives in the lib |
| `admin/testing/_lib/{vitals-recorder,recorder-channel,chaos-store}.ts` | testing-tab instrumentation | jsdom unit | sibling | self-instrumentation of the testing tab; low product risk |
| `editor-demo/spec-content.ts`, `cupboard/cupboard-theme.ts`, `_components/structured-stream-types.ts` | — | — | — | constants/types only, nothing to test |
| Large page components (`AdvSessionsClient`, `OperatorConversationProvider`, `OracleDock`, dashboards, settings pages) | page behavior | Playwright e2e | `apps/operator/e2e/*.spec.ts` | e2e territory (31 specs exist); jsdom render tests of 1-2k-line pages are brittle; `OperatorConversationProvider` also touched by Brief 3 |
| `harness/dock/**`, `HarnessDockShell.tsx`, `InsightsFirstVisitGate.tsx`, spec-redirect routes | dock/empty-state | — | — | **Briefs 9/10 own these** (sequenced hot-file pair) |
| tui/design-adjacent UI | — | — | — | deferred per P-004 item text (churn) |

## 4. `libs/papercusp-shared` + `libs/flags` — DONE (Brief 60/WI-53, +71 cases, flags→100%)

No remaining stable gaps; blueprint-engine + agent-mcp role-config lane shipped by Brief 61 (WI-52).

## 5. `libs/generic` (~44%) — **DEFERRED** (P-005)

Untouched by design: the generalize-libs-to-generic carve is still landing each extracted
lib with its own tests. Re-audit the residual after the carve settles. One-line status
recorded on the plan item.

---

**Verification trail (2026-06-07):**
- Tranche 1 = 11 test files / 130 cases (`agent-mcp` 6/48, `apps/operator` 5/82); the 9
  previously-landed Phase-2 UI files re-verified green (96 cases).
- Tranche 2 = 6 test files / 50 cases (`agent-mcp` harness:list + 3 resources = 20;
  `use-create-data` 15; `claims.integration` 15) + 2 source fixes (the claims lapsed-reason
  diagnostic; the convert test's mig-178 column patch).
- Full suites green after tranche 2: `agent-mcp` 41 files/434; `apps/operator` 192
  files/1771; `operator-core` plan-items integration 5 files/59 (real PG via testcontainer);
  `lint:tests` + root `gen:contract:check` green.
