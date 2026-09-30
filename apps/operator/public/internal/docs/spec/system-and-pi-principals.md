# System and pi principal classes
URL: /internal/docs/spec/system-and-pi-principals

Two new principal classes alongside harness principals — `system:<name>` for persistent in-app concierges (Operator, Oracle) and `pi:<session-id>` for ephemeral pi sessions. Both inherit the bearer-token identity model from `auth-and-identity`.

import { Aside } from '@astrojs/starlight/components';

Both principal classes ship. `system` and `pi` are two members of the `PrincipalKind` union in `@papercusp/tooldef` (`libs/generic/tooldef/src/types.ts`) — a union the original draft had as the `'harness' | 'system' | 'pi'` triad but which principal-rfc-2026-05-20 (Phase 3b) extended to seven members (`'harness' | 'system' | 'pi' | 'user' | 'device' | 'service' | 'loopback'`). This page covers only the `system` and `pi` classes. Provisioning is `provisionSystemPrincipal` / `startPiSession` (`packages/agent-mcp/src/provisioning.ts`); the `harness_shared.system_principals` + `harness_shared.pi_sessions` tables are in `000-baseline.sql`. Two drifts from the original draft below: the per-workspace `config.json` bearer file was retired (PG-only now), and the `token_index` principal-slug column is named `harness_slug` (it holds `system:<name>` / `pi:<session-id>`, not just harness slugs).

## Why

`auth-and-identity` defines bearer-token identity binding for harnesses. Two classes of caller need the same identity guarantees but are not harnesses:

* **In-app concierge agents** (Operator, Oracle) run inside the operator process, are workspace-scoped and persistent, and need their own audit-trail identity for Decisions log composition and capability-state isolation.
* **pi sessions** are user-initiated Claude/Claude-Code coding sessions that consume MCP tools out-of-process. Multiple sessions may run concurrently per workspace; each is short-lived; each should be capability-scoped per session.

This amendment adds two reserved principal namespaces.

## `system:<name>` — persistent system principals

### Provisioning

Generated at substrate provisioning per workspace (implemented in
`provisionSystemPrincipal`, `packages/agent-mcp/src/provisioning.ts`):

* 256-bit random, base64url-encoded bearer.
* Written to **two PG tables** (the per-workspace `config.json` file was
  retired — PG is now the source of truth; routes read the live bearer from
  `token_index` via `packages/operator-core/lib/system-principal.ts`):
  1. `harness_shared.system_principals` (one row per `(workspace_id, name)`; stores `bearer_hash` + `capabilities`)
  2. `harness_shared.token_index` with `kind='system'`, `harness_slug='system:<name>'` (this column holds the principal slug; it is not harness-specific)

v1 instantiates `system:operator` and `system:oracle`. Future named principals (`system:<other>`) instantiate the same class without further spec work.

### Auth header

```
Authorization: Bearer <system_token>
```

Identical to harness auth.

### Identity derivation

The middleware:

1. Looks up `harness_shared.token_index WHERE token = <bearer>` → `(kind, harness_slug, workspace_id)`.
2. If `kind='system'`, the principal is `system:<name>` (the `harness_slug` column holds `system:<name>`) for the workspace bound to that token.
3. Body-supplied identity fields (`from`, `actor`) are rejected per `auth-and-identity`'s rules.

### Audit

`executed_actions` and `audit_log` rows from a system principal show `actor='system:<name>'`. The same RLS / workspace-scoping rules apply.

### Capabilities

Each `system:<name>` principal has its own §10 capability set, declared in the principal's provisioning config. Tier caps from §10.6.1 apply per principal (not aggregated across system principals).

In-memory cap state (§10.7) is keyed by `(workspace_id, principal_slug)`. Revocation in workspace A does not affect workspace B; revocation of one capability from `system:operator` does not affect `system:oracle`.

Beyond capabilities, `system:operator` alone also carries an RBAC **role** — `BRAIN_PRINCIPAL_ROLE` — attached to the resolved principal at auth time (`rolesForPrincipal` in `auth.ts` returns it only when `kind='system'` and the slug is `system:operator`). `requireRoles`-gated tools admit only the brain (plus superuser). `system:oracle` and every pi principal carry no role; the role is verified-identity-derived, never caller-asserted.

Capability and revocation changes propagate to live, out-of-process MCP auth caches via a dedicated PG `NOTIFY` channel, `agent_mcp_principal_invalidate`. `notifyPrincipalChanged` fires `pg_notify` *inside the write tx* (`provisioning.ts`), so the signal is delivered on commit and dropped on rollback; it is emitted from `provisionSystemPrincipal`, `startPiSession`, and `endPiSession`. A `LISTEN`-backed cache in `auth.ts` invalidates on the notify. If `LISTEN` is down, staleness is still bounded by TTLs: 60s for positive (resolved) entries and 15s for negative (revoked / missing / out-of-scope) entries.

### Lifecycle

System principals are persistent. The bearer is rotated only by an explicit operator-level rotation (analogous to harness token rotation, deferred to v2 of `auth-and-identity`).

## `pi:<session-id>` — ephemeral session principals

### Why a separate class

pi sessions are:

* **Multiple per workspace** (a user may have N coding sessions open simultaneously).
* **User-initiated and short-lived** (closed when the iframe / window closes).
* **Capability-scoped per session** (a "read-only research" session and a "full-access fixup" session may need different grants).

Modeling them as a system principal would force one shared cap state across all sessions, which is wrong.

### Provisioning

When a pi session starts:

1. The operator generates a fresh 256-bit bearer.
2. A row is inserted into `harness_shared.pi_sessions` with `(workspace_id, session_id, bearer_hash, capabilities, started_at)`.
3. `harness_shared.token_index` gets a row with `kind='pi'`, `harness_slug='pi:<session-id>'`.

(Implemented as `startPiSession` / `endPiSession`, `packages/agent-mcp/src/provisioning.ts`.)
4\. The bearer is delivered to the pi process via secure channel (env var on spawn or postMessage to a same-origin iframe; not over the network).

When the session ends:

1. The `token_index` row is deleted.
2. The `pi_sessions` row is updated with `ended_at`. The row is retained for audit.

### Identity derivation

Same as `system:<name>`, with `kind='pi'`. `actor` on audit rows is `pi:<session-id>`.

### Capability template

A workspace-level "default pi capabilities" config defines what every pi session starts with. The default is **read-only**: `tasks:read`, `goals:read`, `harness:read`, `messages:read`, `search:read` (the implemented `DEFAULT_PI_CAPABILITIES` in `packages/agent-mcp/src/provisioning.ts`). No writes.

Per-session overrides require explicit user action (e.g. clicking "grant write access" in the pi UI).

### Audit + budget

* `executed_actions` rows show `actor='pi:<session-id>'`.
* Budget is per-workspace overall (the workspace's own spend), filtered by `actor` for "what is pi costing me?" UX. No per-pi-session budget bucket; pi sessions are too ephemeral for that to be meaningful.

### Lifecycle invariants

1. A pi bearer ceases to authenticate the moment the session ends, via **two independent mechanisms**: (a) the `token_index` row is deleted (so identity derivation finds no row), and (b) even if a `token_index` row survived, `loadCapabilities` rejects any pi session whose `pi_sessions.ended_at` is set (`if (rows[0].ended_at) return null` in the pi branch of `auth.ts`). `endPiSession` deletes the `token_index` row and sets `ended_at` in the same tx.
2. A pi session cannot grant itself capabilities at runtime; capability changes require a substrate-level grant from the user.
3. Two pi sessions with the same `session_id` cannot coexist. The enforcing constraint is the workspace-scoped `UNIQUE INDEX token_index_ws_harness_slug_idx` on `(workspace_id, harness_slug)` (which makes `pi:<session-id>` unique per workspace), backed independently by `pi_sessions_pkey` on `(workspace_id, session_id)`. The `token_index` primary key is on `token`, not the slug, so it is *not* the mechanism that blocks a duplicate `session_id`.

## Substrate invariants (both classes)

These hold by construction. Mirror the harness invariants in `auth-and-identity`:

1. The bearer token is the single source of truth for caller identity.
2. `actor` on every audit row equals the bearer-derived principal at the time of insert.
3. No body-supplied identity field ever overrides the derived value.
4. A system principal can read any other harness's state in its workspace (operator-local reads, no auth) but writes to its own audit/identity context.
5. A pi principal's reach is gated by its (per-session) capability set, never by what it claims in a request body.

## Schema

```sql
CREATE TABLE IF NOT EXISTS harness_shared.system_principals (
  workspace_id  TEXT NOT NULL,
  name          TEXT NOT NULL,                -- 'operator', 'oracle', etc.
  bearer_hash   TEXT NOT NULL,                -- sha256 of the bearer; bearer itself is in token_index
  capabilities  JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, name)
);

CREATE TABLE IF NOT EXISTS harness_shared.pi_sessions (
  workspace_id  TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  bearer_hash   TEXT NOT NULL,
  capabilities  JSONB NOT NULL DEFAULT '[]'::jsonb,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at      TIMESTAMPTZ,
  PRIMARY KEY (workspace_id, session_id)
);

-- token_index already exists (now in 000-baseline.sql; `kind` defaults to
-- 'harness' and also accepts 'system' and 'pi'). The `harness_slug` column
-- holds the principal slug (system:<name> / pi:<session-id>).
```

Both new tables are workspace-scoped per the workspace-scoping amendment. RLS policies follow the same pattern.

## Threats addressed

* **Identity spoofing across principal classes**: a harness's bearer cannot impersonate a system principal because token\_index resolves to `kind='harness'`.
* **Session capability creep**: pi sessions cannot grant themselves capabilities; runtime requests claiming new caps are rejected by the in-memory cap state lookup, which only loads grants from the `pi_sessions.capabilities` column at session start (or after a substrate-level grant).
* **Cross-workspace impersonation**: the workspace\_id is part of the principal record; a bearer leaked into a different workspace's process does not authenticate.

## Threats not addressed

* **A compromised operator process**. The operator is the source of truth; if it's malicious, all bets are off.
* **Read access to the `token_index` table**. Bearers are now stored only in PG (the per-workspace `config.json` bearer file was retired, so there is no on-disk file to chmod `0600` — `provisioning.ts` performs no filesystem write). Anyone who can read `token_index` reads live bearers; this is mitigated at the DB-access / RLS layer, not by file permissions.
* **A user knowingly granting a pi session full capabilities and then losing the device**. Out of scope; analogous to the user typing into a regular harness.
