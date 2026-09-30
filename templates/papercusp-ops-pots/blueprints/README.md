# {{APP_NAME}} blueprints — STARTER (papercusp-ops-pots template)

> **Building agent:** this file becomes YOUR app's `blueprints/README.md` — the
> CANONICAL statement of the confinement rule for your app. Every GUIDE and doc
> points here and never restates it (anti-drift). Replace every `{{…}}` token
> while walking the template's decision points; keep the structure.

The **agentic plane** is the app-owned plan/work-item execution path. The
deterministic planes ({{DETERMINISTIC_PLANES e.g. ingest, approvals, checkout
driver, card vault}}) stay code and are never in an agent's reach. An external
binding, recurrence, or direct app request submits operation
`{{OPERATION_ID}}` in `{{APP_HARNESS_SLUG}}`; that declaration pins and starts
`{{PLAN_TEMPLATE_SLUG}}`. Canonical promotion preserves its inputs, provenance,
and blocked-by DAG. Only actionable work is assigned to
`{{APP_AGENT_NAME}}`, whose live session adopts that stable name and receives a
required wake. The plane joins the app by exactly one seam:
**`work_items`** (kind `{{SEAM_WORK_ITEM_KIND}}`) go up, and the typed
**`{{CONTRACT_NAME}}` contract** comes back through one parse gate into
`{{APP_TABLE}}`.

## The set

| Blueprint | Kind | Extends | Role |
|---|---|---|---|
| `{{APP_AGENT_NAME}}` | harness | `single-agent` | The stable app agent. It adopts this name, processes only assigned actionable work, and emits a `{{CONTRACT_NAME}}` payload. It is not a scheduler or a generic-pool consumer. |

The execution topology lives in `{{PLAN_TEMPLATE_SLUG}}`; the blueprint's
`operations[]` entry names and pins that template but does not copy its DAG.
Its real `blocked-by` edges are authoritative: descendants stay
blocked, unassigned, and unwoken until prerequisite completion releases them.
The standard binding target is exactly:

```yaml
action:
  type: blueprint-operation
  operationHarnessSlug: "{{APP_HARNESS_SLUG}}"
  operationId: "{{OPERATION_ID}}"
```

The plan template retains `schedule.execution { appHarnessSlug, agentName }`,
so operation admission reuses the same stable-agent dispatch contract. Legacy
`launch-plan` bindings remain valid during an individually parity-tested
migration, and direct manual `plans:*` calls remain legitimate.

## Confinement (inviolable)

The stable agent is **{{SAFE_CAPABILITY_CLASS e.g. web-read + propose-only}}**.
It cannot {{DANGEROUS_ACTIONS e.g. add to a cart, check out, read
the card vault, or mutate approvals/purchases}} — enforced at install via role
capability envelopes (the proven `ops-guard` pattern).

## Seam contract

- `payload.in` — `{{INPUT_TYPE}} { {{INPUT_FIELDS}} }` (your contracts
  package); the app sends it to `blueprint:submit` with a stable request key.
- `payload.out` — `{{CONTRACT_NAME}} [{ {{OUTPUT_FIELDS}} }]`; the stable agent
  completes the assigned work item with it; the sidecar ingests it into
  `{{APP_TABLE}}` through ONE parse gate (`parse{{CONTRACT_NAME}}`) — the only
  path from agent output to an app table.

Read `blueprint:status` until terminal, then `blueprint:result`. Only
`state: ready` carries the payload; failed, cancelled, dropped, unavailable,
and pending results never cross the parse gate.

A dead, absent, or unwakeable adopting session is an observable retryable
dispatch failure. Promoted queue state remains recoverable; no trigger may
report execution success merely because work rows exist.
