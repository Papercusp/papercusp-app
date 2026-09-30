# `/api/admin/execute-action` contract

Locked 2026-05-01 as part of [multi-harness-spawning](../../../content/internal-docs/implementation/multi-harness-spawning.mdx) Step 0.5. This document defines the wire contract before code lands; changes here propagate to the executor (Step 2), callers (Step 4), and smokes (Step 6).

## Endpoint

```
POST http://localhost:3055/api/admin/execute-action
```

Single endpoint, slug-less, dispatched by `action.op`. NOT mounted under `/api/harness/:slug` because most actions cross harness boundaries.

## Auth

**Header (required):** `Authorization: Bearer <token>`

**Token issuance:**
- Generated at scaffold time: 256-bit random, base64url-encoded
- Stored in three places, all written together:
  1. `<harness-dir>/.papercusp/config.json:harness_token` (mode 0600)
  2. `harness_<slug>.config_token` (one row per harness)
  3. `harness_shared.token_index` (token → harness_slug for O(1) lookup)
- Generated once per harness; **rotation is out of scope for v1**

**Identity derivation:**
1. Server reads `Authorization: Bearer <token>` from the request headers.
2. `SELECT harness_slug FROM harness_shared.token_index WHERE token = $1` → `derivedCallingHarness`.
3. If no row matches → respond `401 {error: 'invalid_or_missing_token'}`.
4. If body has `callingHarness` and `body.callingHarness !== derivedCallingHarness` → `403 {error: 'identity_mismatch'}`.
5. For `send_message` ops with body `from`: same rule, 403 on mismatch.
6. For `scaffold_harness` ops with body `parent_slug`: this field is server-controlled; presence in body → `400 {error: 'parent_slug_not_caller_controlled'}`.

After this middleware, the handler trusts `derivedCallingHarness` as the caller's identity. Body-supplied identity fields are dropped or rejected.

## Request body

```ts
{
  actionId: string,        // UUID v4 supplied by caller (idempotency key)
  callingHarness?: string, // optional; rejected if mismatched with bearer
  callingDept?: string,    // backwards-compat for run.sh; informational only
  action: {
    op: 'send_message' | 'mark_message_status' | 'spinup_project' | 'scaffold_harness',
    ...                    // op-specific fields below
  }
}
```

### `send_message`

```ts
action: {
  op: 'send_message',
  to: string[],            // array of harness slugs (recipients)
  kind: string,            // 'Directive' | 'Decision' | 'Priority' | 'Budget' | 'Completion' | 'Status' | etc.
  subject: string,
  body?: string,
  parentMessageId?: string,
  reason: string,          // REQUIRED, min 10 chars; placeholder regex (`/^(test|todo|asdf|reason|tbd|...)$/i`) logs a quality warning but doesn't block
  // `from` is server-derived = derivedCallingHarness; presence in body is rejected
}
```

Effects:
- INSERT one row per recipient into `harness_<recipient>.messages` with `from_slug = derivedCallingHarness`, `status = 'pending'`.
- If `kind === 'Directive'`, also append to `harness_<recipient>.supervisor_notes`.

### `mark_message_status`

```ts
action: {
  op: 'mark_message_status',
  messageId: string,       // UUID
  status: 'acknowledged' | 'archived'
}
```

Effects:
- UPDATE `harness_<derivedCallingHarness>.messages SET status = $status, acknowledged_at = now() WHERE id = $messageId`.
- The caller can only ack messages in their **own** schema. Cross-harness ack is rejected (404 if message is not in caller's schema).

### `spinup_project`

```ts
action: {
  op: 'spinup_project',
  directiveId: string,
  projectName: string,
  projectVertical: 'apps' | 'mobile-app' | 'service' | string,
  projectBudgetCents: number,
  departments: string[]    // dept slugs (recipients of kickoff/priority/budget)
}
```

Effects (all wrapped in a single PG transaction across affected schemas):
- INSERT into `harness_shared.projects`
- For each dept slug: recurse into the executor in-process to fire `send_message` with `kind = 'Kickoff' | 'Priority' | 'Budget'`
- Single COMMIT or single ROLLBACK
- Response includes `subActions[]` with per-sub-action `{actionId, op, ok}` for diagnostic detail

### `scaffold_harness`

```ts
action: {
  op: 'scaffold_harness',
  projectSlug: string,     // unique; 409 if already exists
  template: string,        // must appear in spawnable catalog
  spec: string,            // written to <projectDir>/SPEC.md (north-star + scope)
  goal?: string            // optional, deprecated; if present, prepended to SPEC.md
  // `parent_slug` is server-derived = derivedCallingHarness; presence in body is rejected
}
```

Effects:
- Validate `projectSlug` matches `/^[a-z0-9][a-z0-9-]{1,63}$/`.
- Look up `template` in `GET /api/marketplace/spawnable`. If absent → `400 {error: 'template_not_spawnable'}`.
- Slug uniqueness: `SELECT 1 FROM harness_shared.projects WHERE slug = $1`. If exists → `409 {error: 'slug_already_in_use'}`.
- Shell out to `papercusp init <projectSlug> --from <template>` with **5-minute** timeout.
  - On SIGTERM/SIGKILL timeout: rollback partial directory; return `internal {timeout: true}`.
  - On non-zero exit: rollback partial directory; return `internal` with stderr.
- After init succeeds:
  - Write `SPEC.md` from request body (north-star goal + technical scope; if both `spec` and `goal` are passed, `goal` is prepended).
  - Atomically merge `parent_slug: derivedCallingHarness` into `<projectDir>/.papercusp/config.json`.
  - Generate `harness_token`, write to same config.json (chmod 0600).
  - Call internal harness-projects registration (provisions per-harness PG schema, creates `config_token` + `token_index` rows).
- On partial scaffold (init succeeded, register failed): error response includes `partialPath` so the caller can retry with same `actionId`.

## Response shape

Every response is a single JSON object:

```ts
{
  ok: boolean,
  actionId: string,
  result?: any,            // op-specific result payload on success
  error?: string,          // error code on failure
  detail?: string,         // human-readable detail for ops/debug
  cached?: boolean         // true when returned from idempotency cache
}
```

### Per-action error codes

| Code | HTTP | Meaning |
|---|---|---|
| `invalid_or_missing_token` | 401 | No bearer / unknown bearer |
| `identity_mismatch` | 403 | `callingHarness` / `from` doesn't match bearer-derived identity |
| `parent_slug_not_caller_controlled` | 400 | Caller tried to set `parent_slug` (it's server-derived) |
| `validation_error` | 400 | Field missing / wrong type / fails regex / `reason` too short |
| `template_not_spawnable` | 400 | `scaffold_harness` template not in spawnable catalog |
| `slug_already_in_use` | 409 | `scaffold_harness` slug collides with existing harness |
| `not_found` | 404 | `mark_message_status` messageId doesn't exist in caller's schema |
| `internal` | 500 | Shell-out failure, DB error, etc. (`detail` carries stderr / SQLSTATE) |

## Idempotency

Every accepted call is logged to `harness_<derivedCallingHarness>.executed_actions` keyed by `actionId`:

```sql
CREATE TABLE harness_<slug>.executed_actions (
  action_id UUID PRIMARY KEY,
  op TEXT NOT NULL,
  caller_slug TEXT NOT NULL,
  target_slug TEXT,
  reason TEXT,
  request JSONB NOT NULL,
  response JSONB NOT NULL,
  executed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Replay rule (cache-is-authoritative):** a subsequent request with the same `actionId` returns the cached `response` field with `cached: true` set. **No side-effect verification.** If the side effect was deleted out-of-band (e.g. registry pruned, message hard-deleted), the replay still returns `{ok: true, ...}`. This is documented as a v1 boundary; v1.5 may add cache-and-verify.

**Idempotency wrapper pseudocode:**
```ts
const cached = await getExecutedAction(actionId, derivedCallingHarness);
if (cached) return { ...cached.response, cached: true };
const result = await dispatch(action);
await saveExecutedAction({
  actionId, op: action.op,
  callerSlug: derivedCallingHarness,
  targetSlug: extractTargetSlug(action),
  reason: action.reason ?? null,
  request: action,
  response: result,
});
return result;
```

## Per-verb timeouts

| Verb | Timeout | Rationale |
|---|---|---|
| `scaffold_harness` | 5 min (300s) | Shells out to `papercusp init` which runs npm install, schema scaffold, etc. |
| All others | 60 s | SQL only; bounded |

Timeout is enforced server-side via `AbortSignal.timeout(...)` on the request handler. On timeout, the handler returns `500 {error: 'internal', detail: 'timeout', timeout: true}`. Idempotency cache is **not** populated on timeout (the operation may have partially succeeded; safer to allow retry).

## Tier 3 inspect-on-demand mechanism

**Verified 2026-05-01:** Agent CLI invocations from `run.sh` and the TS orchestrator (`libs/papercusp/packages/orchestrator/src/invoke.ts`) — both `omp -p` (default) and `claude -p` — do NOT restrict `--allowed-tools`, so `Bash` is available by default. Agents can `curl` the read APIs directly from inside a tool call.

**Decision: Tier 3 ships as curl-from-Bash.** Step 2.5 is documentation only — wiring `mcp__papercusp__inspect*` MCP tools is unnecessary.

The prompt-build's "Available capabilities" section lists the curl URLs (no auth required for reads, since they're operator-local).

## Auth & identity invariants (substrate-level)

These hold by construction. If they ever fail, the substrate is broken:

1. The bearer token is the **single source of truth** for caller identity.
2. `from_slug` on every message row equals the bearer-derived identity at the time of insert.
3. `parent_slug` on every project row equals the bearer-derived identity of the calling harness at scaffold time.
4. No body-supplied identity field ever overrides the derived value. They are either rejected on mismatch or silently dropped.
5. A harness can read any other harness's state (Tier 3) but can only write to its own schema (`mark_message_status`) or insert into other harnesses' inboxes (`send_message`, with from-spoofing prevented by #2).

## Open questions for v2 (NOT v1)

- Token rotation API + revocation
- Cache-and-verify idempotency replay (v1 is cache-is-authoritative)
- Rate limiting on `send_message` per `caller_slug` (if `reason` friction proves insufficient)
- Cross-machine spawn (parent on machine A, child on machine B)
- `dryRun: true` for `scaffold_harness`
- Per-role addressing (`to: [<harness>:<role>]`)
