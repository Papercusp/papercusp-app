# Viewer identity + per-contributor tier stats in the live shell
URL: /internal/docs/agent-insights/viewer-identity-and-contributor-tiers

How to get "who is the current viewer" in the /adv shell (GET /api/viewer → useViewer → resolveLocalGithubIdentity), the server-side privacy-filter pattern, and the per-contributor tier-stat source rule (use auto_review_audit + harness_features_consolidated.taken_by + contributor_usage_events — NOT the inert harness_feature_prs/shipped_by_github_id — and zero non-verified bindings).

## Who is the current viewer?

The live `/adv` Vite shell historically had **no way to know who is operating the
desktop**, which blocked every viewer-specific surface (working-set Start/Stop,
profile privacy filter, Contributors trust menu, claim CTA). The infra that closes
that gap (Phase-8, 2026-06-01):

* **Source of truth:** `resolveLocalGithubIdentity()` (`packages/operator-core/lib/identity/resolve-local-github-identity.ts`)
  → `{ kind:'ok', token, githubUserId, githubLogin }` or `{ kind:'gh_auth_required' }`.
  On a single-user, loopback-bound desktop **the local GitHub identity IS the viewer.**
* **Endpoint:** `GET /api/viewer` (`packages/operator-core/lib/endpoint-route/routes/users/viewer.ts`) → `{ github_user_id, github_login }`
  (anonymous → `{null,null}` at 200; **never** returns the token).
* **Client hook:** `useViewer()` (`app/adv/harnesses/useViewer.ts`) — module-cached fetch +
  `isMe(id)` / `normalizeViewer`. Lives in `app/adv` (consumed *by* operator-vite via the
  `@/app` alias) — **not** operator-vite (wrong dep direction; app/adv can't import from it).

**Server-side privacy filtering must NOT trust the client.** When a handler needs the
viewer (e.g. the §18 profile filter in `packages/operator-core/lib/endpoint-route/routes/users/by-github-id.ts`), resolve it
server-side: try `getSessionUserOrDefault()` (web/multi-user), then fall back to
`resolveLocalGithubIdentity()` (the desktop case). Never take the viewer id from a
query param the client could spoof.

## Per-contributor tier stats — use the POPULATED sources

Trust tiers (A = merged PRs, B = features shipped, C = activity) appear in the user
profile (P-072b), the Contributors tab (P-048), and the Insights People card. **They
must agree.** The trap: there are two candidate source sets, and one is inert.

| Tier                 | USE (populated)                                                                               | DO NOT use (inert outside the gated substrate)                                |
| -------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| A — merged PRs       | `auto_review_audit` WHERE `author_github_id` AND `action IN ('auto_merge','manual_merge')`    | `harness_feature_prs` (no producer → always 0)                                |
| B — features shipped | `harness_features_consolidated` WHERE `status='shipped'` AND `taken_by = <id>::text`          | `harness_features.shipped_by_github_id` / `completion_ref` (unpopulated)      |
| C — activity         | `contributor_usage_events` WHERE `harness_slug` + `github_user_id` (the §7.1 source of truth) | filtering it by `workspace_id` — **that column does not exist on this table** |

The authoritative per-user definitions live in `packages/operator-core/lib/user-profile/load.ts` (P-072b); the
per-contributor (one-harness, GROUP BY contributor) inversion is
`packages/operator-core/lib/harness-insights/load-contributors-tab.ts`. A Contributors-tab endpoint built
earlier used the *inert* sources and silently disagreed with the profile until
reconciled (commit `426c0868d`) — if you add a tier surface, mirror the populated
sources or you'll ship all-zero / inconsistent stats.

**Schema trap — `contributor_usage_events` has NO `workspace_id`.** Unlike
`auto_review_audit` and `harness_features_consolidated` (both workspace-scoped), the
tier-C ledger is a federated substrate table keyed by `harness_slug` only (PK
`(harness_slug, event_id)`, index `(harness_slug, github_user_id, ts)` — see
`libs/papercusp/libs/db/sql/000-baseline.sql`; the old runtime
`ensure-schema-dogfood.ts` was removed when the schema went migrations-only,
`self-contained-migration-baseline-2026-06-02`). Filtering it
by `workspace_id` throws `column … does not exist` at *runtime only* — unit tests
that mock the SQL runner pass clean (this exact bug shipped in both the endpoint and
the lib and was caught only by a live curl against `:3070`, 2026-06-02). When you add
or move a tier-C query, scope it on `harness_slug` (+ `github_user_id`) and **verify
it live**, not just through mocked-runner unit tests.

**Zero non-verified bindings.** Only `verified` bindings aggregate stats —
`statsAggregateForStatus(status)` (`packages/operator-core/lib/identity/binding-verifier-types.ts`) is the
predicate (`status === 'verified'`). Apply it (server-side and/or in the panel) so
unverified/pending contributors render zeroed + greyed (§0.2.7 / P-048d). Per-contributor
binding status is derived from the row's `device_attestations` (see
`bindingStatusFromAttestations` / `packages/operator-core/lib/harness-insights/load-people.ts pickBindingStatus`), or read the
maintained `contributors.binding_status` column.
