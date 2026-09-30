# External triggers — setup, arming, and acceptance
URL: /internal/docs/reference/external-triggers

Connect replay-safe Slack and Google Workspace sources, review disarmed bindings, drive the Triggers UI, and collect falsifiable live acceptance evidence without exposing credentials.

## Contract

Papercusp extends the existing event and plan-run systems: provider adapters normalize replayable activity into `ext:<source>:<event>`, the durable delivery ledger deduplicates it, and an armed binding launches an existing plan. Source connection, workflow installation, and binding arming are separate transitions. New bindings land disarmed and cannot act until they have been reviewed and explicitly armed.

Slack, Gmail, and Google Calendar use outbound-only transports suitable for a desktop behind NAT. Slack uses Socket Mode plus history reconciliation; Gmail treats Pub/Sub pull as a latency doorbell and `history.list` as truth; Calendar polls incrementally with `syncToken`. Credentials stay behind opaque connection references and are never returned by trigger tools or copied into snapshots.

## Connect Slack

Follow [Slack external triggers — Socket Mode setup](/internal/docs/reference/slack-external-trigger-setup). The maintained app manifest, token-storage rules, required scopes, channel configuration, delayed-event option, and cold-gap behavior live there. After connecting, `triggers:list { sourceKind: "slack" }` must show one source and no credential values. Review the generated `slack-respond-in-thread-2026-08-22` binding before arming it.

## Connect Google Workspace

Connect one Google Workspace account through Personal Vault / the Google OAuth flow. Gmail and Calendar deliberately reuse that connection. The consent set must include Gmail read/compose access and Calendar read/write access when calendar writes are enabled. Re-consent upgrades the same connection rather than creating a second credential path.

Successful provisioning creates `gmail`, `gcal`, and `contacts` source rows that all reference the same opaque `google-workspace:<field>` credential. Gmail watch provisioning also needs the configured Google Cloud project and Pub/Sub service account to be allowed to create/use the topic and subscription, plus Gmail's push publisher grant on the topic. A 403 during topic creation is a cloud IAM/project configuration failure: the source remains visible as `degraded`; it is not proof that the owner OAuth token is absent or invalid. Calendar can remain connected independently because its offline-safe path uses `events.list` plus `syncToken`.

## Review and arm

Open **Admin → Triggers** (`/admin/triggers`). Confirm source status, binding event/filter, destination plan, storm policy, and the fact that the binding is disarmed. Attach or edit through this page or the `triggers:*` tools. Arming is the only step that authorizes autonomous launches and requires `triggers:arm { bindingId, confirm: true }`; installation alone never arms.

Use `triggers:list` to discover source and binding ids without secrets. `triggers:status` reports health and recent failures. A source-level `degraded`/`error` state must be resolved before live acceptance; do not treat a rendered page or a bridge probe as provider evidence.

## Falsifiable desktop acceptance

Drive an isolated debug Tauri instance with an explicit `tauri-agent-tools --pid <owned-pid>` target. Never use a bare mutating command when another bridge may be running. `probe` is discovery only; the load-bearing UI evidence is an exit-coded `check` plus a negative control.

1. Navigate the owned webview to `/admin/triggers`.
2. Assert the Triggers heading, source cards, statuses, binding rows, arm state, and a clean console with `tauri-agent-tools check --pid <pid> ... --json`.
3. Run one deliberately false check and retain its non-zero exit so the positive assertion is proven falsifiable.
4. Capture DOM/console/Rust logs on failure; a screenshot alone is not evidence.

## Live Slack acceptance

With the Slack source connected and the flagship binding armed, mention `@papercusp` in an allowed channel. Verify all of the following from canonical state: one `ext:slack:app_mention` delivery, one succeeded trigger run, one linked plan run/work item, and one reply in the originating channel/thread. Replay the same Slack `event_id` and verify it does not launch or post twice.

## Live Gmail acceptance

With the Gmail source connected and the draft-response binding armed, send an inbound message to the connected account. Verify one `ext:gmail:message.received` delivery, one succeeded trigger/plan run, and one Gmail draft anchored to the originating thread with resolved recipient and reply headers. The workflow creates a draft only; it never sends. Reprocessing the same message/dedupe key must return the existing draft rather than create a second one.

## Provider-independent regression layer

When live provider credentials are unavailable, run the real-Postgres flagship integrations; they cover the complete normalized event → delivery ledger → binding → plan run → anchored provider write path with provider HTTP/storage seams mocked only at the final network boundary:

```bash
cd packages/operator-core
npx vitest run --config vitest.integration.config.ts \
  lib/external-triggers/slack-flagship.integration.test.ts \
  lib/external-triggers/gmail-flagship.integration.test.ts \
  lib/external-triggers/google-gmail.integration.test.ts
```

This layer is necessary but does not substitute for a live Slack workspace or Gmail account. Record missing Slack tokens, Google OAuth client material, or Pub/Sub IAM as explicit acceptance residue rather than silently relabeling simulated evidence as live.
