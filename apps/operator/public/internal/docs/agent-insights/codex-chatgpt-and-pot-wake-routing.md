# Codex chatgpt aliases and Pot wake routing
URL: /internal/docs/agent-insights/codex-chatgpt-and-pot-wake-routing

The Pot loop has three easy-to-confuse routing seams: chatgpt:* is a Papercusp-facing model alias but Codex CLI wants gpt-*; ChatGPT OAuth auth.json is not an OpenAI-compatible gateway bearer; and Mug nudges/wakes must use stable role-slot and single-flight routing instead of fresh session owner ids.

## Failure pattern

When the owner steers Mug/cup/Overwatch/Scout to `chatgpt:5.5`, do not pass that
literal value to Codex CLI. It is the Papercusp user-facing alias; native Codex wants
`gpt-5.5`. The alias has to be normalized at every boundary:

* `buildInvokeOnce` / `applyRoleModel` for per-role and per-spawn command assembly.
* `orchestrator invoke` when an existing Codex command already contains `--model chatgpt:*`.
* `normalizeModelForBackend(..., 'codex')` for model values resolved inside the child.

If a spawned agent prints `There's an issue with the selected model (chatgpt:5.5)`, it
means one of those boundaries leaked the alias through.

When `operator-spawn` resolves a final `spawnModelSpec`, infer the backend from that
final spec and override stale pins from an older role/default. A `chatgpt:*` final spec
with `PAPERCUSP_SPAWN_BACKEND=claude-code` is a routing bug even when the argv model
normalizes later.

## Gateway routing trap

A Codex account credential backed only by ChatGPT OAuth `auth.json` is usable by native
Codex, but it is not an OpenAI-compatible bearer for the gateway's `/v1/responses`
proxy. If the credential store reports `auth_mode: 'chatgpt'` and no real
`OPENAI_API_KEY`, Codex spawns should not receive a gateway provider config for that
credential; let native Codex use its own `auth.json`.

Also keep `/v1/models` out of the shared admission queue. Codex probes model metadata
before a turn; queueing that local synthetic response behind long-running responses can
make the agent appear hung before it even starts.

When the Codex gateway is used, the per-spawn `CODEX_HOME/config.toml` must include all
three headers:

* `x-papercusp-account` to pin the OpenAI-compatible bearer account.
* `x-papercusp-owner` to preserve per-owner attribution.
* `x-papercusp-priority` to keep Mug/Overwatch/cup traffic out of the low-priority
  default tier.

Missing `x-papercusp-priority` is a real liveness bug: a Mug can connect to the gateway
and then time out behind low-priority work, which looks like a zero-output launcher loss.

Do not register a random `.apikey` as a Codex account just because it is present on disk.
Shape-check the credential first: OpenAI-compatible gateway accounts need an OpenAI
bearer, not an Anthropic `sk-ant-*` key and not ChatGPT `auth.json`. If a bad bearer gets
registered, remove it, clear session overrides, and `gateway:reload` immediately.

## No-turn failure classes

The parent durable-spawn row is the detector Overwatch and Mug usually see first. For
Codex no-turn deaths, the important classes are:

* `usage_limit` — native ChatGPT/Codex reported account quota, for example “You've hit
  your usage limit.” This is an account routing/capacity problem, not a stale work-item
  or launcher-host problem.
* `auth_error` — the OpenAI-compatible gateway returned 401/invalid API key. This means
  the account credential or gateway account pool is wrong.
* `infra_loss` — use only when the child produced no turn and no credential/quota
  diagnostic is present.

If Overwatch sees `usage_limit` or `auth_error`, the durable idea should be account-pool
repair or alternate healthy Codex account routing. It should not propose stale-claim
reaping, wake retries, or host restarts as the primary fix.

PG is canonical for run transcripts. A run log line like `stdout: .papercusp/logs/...`
can be stale/misleading for orchestrator-managed runs; inspect
`harness_shared.harness_run_output.jsonl_body` for the actual Codex error.

## Work-item claim guardrail

`su-loopback` is a transport identity, not a real cup. `work_items:claim` must reject
implicit claims that resolve to `su-loopback`; otherwise Mug/Scout can see a claimed
item with no wakeable owner and misdiagnose it as a placement failure. Explicit claims
to a real assignee remain valid.

When debugging a stale-claim/wake inconsistency, check both:

* `fleet:assignments` / coord presence for a wakeable owner.
* `harness_shared.work_items.taken_by` for transport identities such as `su-loopback`.

The durable fix is to prevent the bogus claim at claim time and let the stale-claim
reaper clear old rows in canonical `harness_shared.work_items`.

## Mug nudge routing

Do not tell Overwatch to `coord:send` a concrete Mug `coordOwner`. Mug sessions are
fresh per wake, so the owner id can expire between brief computation and send. The stable
route is:

```json
{ "to": ["@role:mug"], "wake": "optimistic" }
```

`@role:mug` parks the message. `computeQueenWakeBrief` drains that role slot into the
Mug's next wake brief, alongside her normal coord inbox.

## Mug wake single-flight

`pot:wake` must claim `lastWakeAt` before launching the Mug. Recording it after
`fireLaunchBlueprint` leaves a race: manual, event, watchdog, and Overwatch nudges can all
read the old state and launch overlapping Mugs. A second race appears after the 60s wake
floor expires while the prior Mug is still running. The tool now:

* skips when a recent Mug adv-session is still open (`wake-inflight`);
* atomically records `lastWakeAt` under the `hive_wake` row lock before launch;
* lets later triggers coalesce instead of creating duplicate Mug sessions.

Scorecard clue: Overwatch reports healthy determinism for `@role:mug` acceptance, but
degraded parallel distribution or scheduler usage if the Mug is alive and still not
placing enough work.
