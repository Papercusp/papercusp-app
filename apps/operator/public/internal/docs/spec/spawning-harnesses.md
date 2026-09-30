# Authoring a spawning harness
URL: /internal/docs/spec/spawning-harnesses

How to write a harness whose roles can spawn child harnesses and message other harnesses.

import { Aside } from '@astrojs/starlight/components';

This page documents the role-config-driven `scaffold_harness` / `send_message`
substrate verbs (live in `packages/operator-core/lib/execute-action.ts`). The
newer agent-authorable way to create a harness is the `harness:create` MCP tool,
which instantiates a **blueprint** rather than a marketplace template — see
[spawning-harnesses](/internal/docs/spec/harness-spawning) and the `blueprint:*`
tools. Cross-harness messaging is also exposed read-side via the `cross_harness:*`
tools (`inbox` / `outbox` / `recent_activity` / `supervisor_notes` / `plans_*`
/ `docs_*`).

A harness is "spawning-capable" if at least one of its roles has `scaffold_harness` and/or `send_message` in its `allowedActions`. There's nothing template-specific about this — `papercup-org` is just the first one that uses it.

## Role config

Inside `<harness>/.papercusp/config.json`:

```json
{
  "harness_kind": "org",
  "primaryRole": "director",
  "roles": {
    "director": {
      "inboxKinds": ["Directive", "Completion", "Status"],
      "outboxKinds": ["Decision", "Priority", "Budget"],
      "allowedActions": [
        "spinup_project",
        "scaffold_harness",
        "send_message",
        "mark_message_status"
      ],
      "model": "claude-opus-4-7",
      "cadence": 60
    }
  }
}
```

`allowedActions` is the gate. The substrate doesn't currently enforce this at the executor (the bearer token is the only check), but the role's prompt is built from `inboxKinds` / `outboxKinds` / `allowedActions` so the agent knows what it's expected to emit.

## Bearer token & auth

When the harness is scaffolded, a `harness_token` is written into `.papercusp/config.json` (mode 0600) and mirrored into the authoritative `harness_shared.token_index` (the per-harness `config_token` table was retired — migration 121). All `executeAction` calls read the token and send it as `Authorization: Bearer <token>`.

The executor (`deriveCallerFromBearer` / `validateIdentityFields` in `packages/operator-core/lib/execute-action.ts`) derives the caller identity from the token by looking it up in `harness_shared.token_index`. **Body-supplied `from` or `callingHarness` fields are rejected on mismatch** (`403 identity_mismatch`); `parent_slug` on `scaffold_harness` is never body-controlled (`400 parent_slug_not_caller_controlled`). See [auth-and-identity](/internal/docs/spec/auth-and-identity).

`scaffold_harness` also enforces a spawn-depth guard. Walking the caller's `parent_slug` chain upward, the substrate refuses to deepen a chain past `MAX_SPAWN_DEPTH` (default `8`, override via `PAPERCUSP_MAX_SPAWN_DEPTH`) and rejects cycles — a harness spawning itself, or a requested child that's already an ancestor of the caller. Both come back as `400 validation_error`.

The executor dispatches more than the original four substrate verbs. Beyond `send_message` / `mark_message_status` / `spinup_project` / `scaffold_harness`, `dispatchAction` also routes `create_feature` (owner-only: the caller must own the target harness or the call returns `403 forbidden`), plus `pause_project` / `resume_project` / `mark_campaign_published` / `add_directive_summary`. None of these are gated per-role at the executor — dispatch is purely by `op`, with the bearer token as the only auth check.

## Tier 3 substrate context

Every role's prompt is built with a top section called "About Papercusp" + a "Neighbor harnesses" view + an "Available read capabilities" list. This is automatic — no template authoring needed. The agent learns at prompt build time:

* That it's running inside Papercusp
* Who its parent / children / siblings are (depth-1 view)
* Which curl commands inspect any other harness on demand
* Which spawnable templates exist (via `GET /api/marketplace/spawnable`)

To author a spawning role's prompt, focus on what the role should DO with that context (decision rules, ACTIONS-block conventions). Don't re-document the substrate.

## Cross-harness messaging

Any role with `send_message` in `allowedActions` can post to any harness:

```json
{ "op": "send_message",
  "to": ["any-other-harness-slug"],
  "kind": "Priority",
  "subject": "...",
  "body": "...",
  "reason": "<≥10 chars explaining why; placeholders flagged>" }
```

The executor validates the `reason` before the send: a reason under 10 characters is rejected (`400 validation_error`), and placeholder reasons (`test` / `todo` / `asdf` / `reason` / `tbd` / `na` / repeated `x`/`y` / bare dots) are accepted but surfaced in the result as `placeholder_reason_flag: true`. `send_message` is also rate-limited per caller — at most 50 ops per 60s sliding window (override via `PAPERCUSP_SEND_MESSAGE_RATE_LIMIT`; set `<= 0` to disable). Over the limit returns `rate_limited`; `system:` principals are exempt.

The receiver's prompt-build automatically includes pending messages from its `parent_slug` in a bounded "Recent supervisor messages" section. On a "happy progression" decision (DONE / NEXT\_\*) the substrate auto-acknowledges the consumed messages; ESCALATE / REVIEW leave them pending so a redirect re-surfaces the original. See [cross-harness-coordination](/internal/docs/spec/cross-harness-coordination) for the full decision set.

## Completion hook

If a harness has `parent_slug` set, the substrate's built-in `afterDone` step posts a `kind: "Completion"` message back to the parent's inbox. No template authoring needed. The hook reads `parent_slug` from PG (`harness_shared.projects.parent_slug`) — `.papercusp/config.json` still stores it, but as a scaffold-time **contract** artifact, not as the live source the hook consults. (Instance config — `phase` / `phases` / `dept` / knobs — has moved out of `config.json` to the workspace-PG registry, but `harness_token` / `parent_slug` / `slug` stay in the file by design; see `deprecate-harness-config-json-2026-06-06` D-005.)

In the per-feature DBOS pipeline this is `notifyParentOnDone` (`packages/operator-core/lib/dbos/notify-parent-done.ts`), invoked by the orchestrator finalize step. It fires on a feature's DONE finalize **only once the harness's feature queue has drained** — i.e. no other feature remains non-terminal (`passed`/`deprecated`) — so the parent is notified at mission completion, not once per feature. (The legacy bash `run.sh` run-loop is retired.) Override per-harness by writing your own `<harness>/.papercusp/hooks/afterDone.sh`, which still takes precedence over the builtin.
