# Runbook — responding to capless governor alerts
URL: /internal/docs/agent-insights/capless-governor-alert-response-runbook

Runbook: what a governor alert is (a latched state transition, not sample spam), what each one means, and the response for constrained / paused / growing / stalled.

## What an alert is here

An alert is a **latched state transition** (D-009), not a sample crossing a line. It fires when a cell's assessment changes and stays latched until the state changes back — so an alert you are looking at describes a condition that is still true, and a quiet plane is not a plane nobody is sampling.

Two rules decide who acts:

* **Agent-facing alerts are ADVISORY. Governor admission is AUTHORITATIVE** (D-010). Do not hand-throttle your own work because a cell says `constrained`; the governor is already shaping admission. Your job is to find and fix the cause.
* **Utilization is never the cause.** A raw capacity number cannot raise an alert by itself (D-013). If CPU is at 99% and nothing is degraded, that is a **healthy saturated system** and the correct action is none.

## An alert always names a cause, not just a symptom

A degraded verdict carries two halves and you need both:

1. a **breached service objective** — the outcome that actually got worse (heartbeat lag, event-loop p95, DB/service/provider wait, GC pause, major faults, swap, queue writer latency), with its baseline, boundary and inflation ratio; and
2. a **causal attribution** — the cause signal, the resource, a correlation and a temporal alignment.

If you only have (1) you have a symptom nobody owns. If you only have (2) you have a raw capacity number. Some families deliberately have no objective of their own — CPU stall and working-set growth reach the controller *only* through a breached progress outcome plus attribution.

## Response by assessment

**`governor.admission: constrained`** — one or more classes contracted against a named resource.
Read `constrainedClasses[]`, then the feedback's `resource` and `reason`. Fix the named resource. Do **not** raise a window by hand: contraction carries a TTL and lifts itself (D-014), and every contraction expires by construction.

**`governor.admission: paused`** — a severe, attributable progress-loss pause on a class.
The pause is short and self-expiring. Confirm it is attributable to the class you expect; a pause with no attributable class is a bug, not a policy. Control-class work is protected and keeps flowing — if control work is \*also\_ stalled, the problem is below the governor.

**`governor.queue: growing`** — arrival rate exceeds drain rate.
This is the healthy pressure response, not an incident by itself. It becomes one when `oldestAgeMs` keeps climbing: queue health is **age and flow, not one depth threshold** (D-007). A deep queue draining steadily is fine; a shallow queue whose head is old is not.

**`governor.resources: constrained`** — the live constraint set. Use it to route: the drainer already penalizes classes constrained on that resource and prefers ones with affinity for what is free.

**`governor.recovery: stalled`** — upward probing is not resuming after a contraction cleared.
This is the alert that means something is genuinely wrong with the governor rather than with the host: probing is unbounded by design, so a stall implies feedback that will not expire or a health verdict stuck in `warming`/`unknown`. Check whether a writer stopped publishing before you touch the controller.

**Any cell reading `unknown`** — treat as a visibility incident and see the state-cell runbook. An unobserved system is not a healthy one.

## What never to do in response

* Do not add a numeric cap, a max-concurrency knob, or a per-subsystem ceiling "just for now". That is the architecture this plan deleted, and `npm run lint:resource-governor-enforcement` will fail you.
* Do not reject queued work to shed load. Capacity pressure queues; it does not reject (D-001).
* Do not restart the operator to "clear" a constrained state. The controller's window is transient feedback, but the durable queue and its receipts are not — a restart loses the feedback that was correctly protecting you and keeps every queued row.
