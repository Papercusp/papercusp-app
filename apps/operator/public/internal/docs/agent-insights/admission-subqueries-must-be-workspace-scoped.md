# Security subqueries must be EXPLICITLY workspace-scoped — admin DB handles bypass RLS
URL: /internal/docs/agent-insights/admission-subqueries-must-be-workspace-scoped

The G2 admission/trust predicate runs on the getOrgPg() admin handle, which BYPASSES row-level security. A workspace-scoped table's RLS (e.g. user_trust_list) therefore does NOT isolate it at these chokepoints — an unscoped `IN (SELECT … FROM that_table)` trust-admits foreign-workspace rows (cross-workspace privilege escalation → auto-running un-screened foreign code). Thread workspaceId through and add the predicate yourself; omit it ⇒ drop the leg (fail-safe under-admit).

## The trap

`harness_shared.user_trust_list` ships with RLS (`migration 276`,
`POLICY user_trust_list_workspace_isolation` keyed on `workspace_id`). It is tempting to lean on
that policy for isolation and write the trust fast-path of the G2 admission
predicate as:

```sql
-- WRONG — relies on RLS to scope the trust list
... OR (verified_author_github_user_id IS NOT NULL
        AND verified_author_github_user_id IN
            (SELECT trusted_github_user_id FROM harness_shared.user_trust_list))
```

That is a **cross-workspace privilege-escalation leak.** The admission predicate
(`packages/operator-core/lib/work-items-admission.ts` — `autoPickableWhereSql` /
`isAutoPickable` / `isWorkItemAutoPickable`) runs at every claim/place chokepoint
(`claimWorkItem`, `claimNextWorkItem`, `fleet:place_batch` gather, replica claim).
**Those callers hold the `getOrgPg()` admin handle, which BYPASSES RLS.** So the
subquery above sees `user_trust_list` rows from *every* workspace. A workspace-**A**
feature whose verified author is trusted only in workspace-**B** then satisfies the
trust leg and is **auto-admitted** — i.e. un-screened foreign code runs without the
auditor, in a workspace whose owner never trusted that author.

This is the single sharpest failure mode of the whole gate: the gate exists
precisely to keep remote/un-admitted work from auto-running, and an RLS-reliant
trust leg quietly re-opens that hole for any author trusted *somewhere*.

## The rule

> **Any security-sensitive subquery that runs on an admin/superuser handle and
> references a workspace-scoped table MUST carry its own explicit
> `workspace_id = $ws` predicate. Never rely on RLS for isolation when the
> handle can bypass it.**

RLS is a backstop for RLS-respecting handles, not a substitute for scoping in
code that runs as admin. Treat "this table has RLS" as *irrelevant* the moment
you're on `getOrgPg()`.

## The fix (shared-pot-trust-admission D-004)

Thread `workspaceId` through the predicate and add the scope yourself; when the
caller cannot supply a workspace, **drop the trust leg entirely** — the gate then
only ever *under*-admits (refuses a legitimately-trusted item) rather than
*over*-admits (the security failure). Fail-safe direction matters: a missed
fast-path is a latency cost; a leaked admission is a breach.

```ts
// work-items-admission.ts — RIGHT: explicit ws scope, leg dropped when unscoped
export function autoPickableWhereSql(sql: OrgSql, workspaceId?: string) {
  const trustLeg = workspaceId
    ? sql` OR (verified_author_github_user_id IS NOT NULL
               AND verified_author_github_user_id IN
                   (SELECT trusted_github_user_id FROM harness_shared.user_trust_list
                     WHERE workspace_id = ${workspaceId}))`
    : sql``;                                 // no ws ⇒ no trust fast-path (fail-safe)
  return sql`(origin = 'local' OR origin IS NULL OR audit_verdict = 'admit'${trustLeg})`;
}
```

The JS twin (`isAutoPickable`, fed by `loadTrustedGithubUserIds(workspaceId)`) and
the per-id reader (`isWorkItemAutoPickable`, whose own trust SELECT is ws-scoped)
follow the same discipline. The producer side (`verified_author_github_user_id`,
stamped only from a **verified + non-revoked device attestation** — never a
self-claimed id) is what makes the trusted set meaningful; a NULL verified id
never satisfies the leg.

## Prove it with a test, not by reading

The leak is invisible to a single-workspace test — it only appears when a *second*
workspace's trust row exists. The guard case in
`work-items-admission.integration.test.ts` is therefore mandatory:

* workspace **A** has a remote, un-admitted feature whose `verified_author_github_user_id = X`;
* workspace **B** (only) trusts `X` in its `user_trust_list`;
* assert the predicate (run on the admin handle) **REFUSES** the workspace-A feature.

Without the cross-workspace row the test passes whether or not the subquery is
scoped — so the leak ships green. Security-gate correctness is the test's job, not
the reviewer's eye: write the adversarial cross-tenant case explicitly.

## See also

* Plan `shared-pot-trust-admission-2026-06-14` (D-004 the leak, D-005 the producer rule).
* `work-items-admission.ts` is the SINGLE predicate; if you add a new claim/place
  chokepoint, route it through this — do not re-derive the origin/admit/trust logic.
* Predecessor gate `papercusp-user-protection-gate-2026-05-31` (the frontier-read
  gate this generalizes to every distribution-layer path).
