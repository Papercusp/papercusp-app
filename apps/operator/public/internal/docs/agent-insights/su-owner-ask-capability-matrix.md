# The su owner-ask convention, and why enforcement is per-client (D-002)
URL: /internal/docs/agent-insights/su-owner-ask-capability-matrix

Every client-agnostic convention "an owner-directed question must ride a durable channel" — but each of Claude Code / OMP / Codex can enforce it to a different degree, because they expose different hook surfaces. This page is the capability matrix behind that decision (D-002, owner-inbox-single-pane-2026-07-17).

## What this page covers

* the convention every su session is held to (D-001) — durable-channel-or-bounce
* the per-client hook surface each backend actually exposes, verified in-repo
* why the Codex gap is a recorded decision, not an open bug
* what "durable channel" concretely means (`coord:escalate` vs an `<ask>` block)

## The convention (D-001, universal — binds every su session regardless of client)

An owner-directed question must ride a **durable, machine-readable channel**,
never just a prose sentence at the end of a turn:

1. **Preferred:** `coord:escalate` with structured `options[]` — this already
   renders as an answerable `AskChoiceCard` in the owner's Inbox
   (`_retired/inbox-pane/InboxPane.tsx`), and answering it
   round-trips back to the asking session.
2. **Floor:** an `<ask>` block (`question`, `options[]`, `refs[]`) in
   `@papercusp/chat-protocol`, living beside the existing `<report>` block
   (D-001 of `owner-inbox-single-pane-2026-07-17`; parser/schema is P-003's
   lane in `libs/generic/chat-protocol`).

A bare turn-ending question in prose — no escalation, no tagged block — is
**invisible** to the unified owner Inbox this plan builds. The owner may never
see it; the asking session sits blocked on a reply that never surfaces
anywhere the owner is looking.

## Why enforcement can't be uniform: the per-client hook reality (verified 2026-07-17)

The three su backends expose genuinely different hook surfaces — this was
verified in-repo, not assumed, before D-002 was written:

| Client          | Turn-end / Stop hook?                                                                                                                                                                                                                              | What it can do about an unstructured ask                                                                                                                                                                                                                                                                                                                |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Claude Code** | Yes — `Stop` hook (blockable), plus `Notification` and the full `PreToolUse`/`PostToolUse` set (`apps/operator/scripts/hooks/cc/*`)                                                                                                                | **Hard enforce.** Parse the final turn for a structured mirror; if a question-shaped ending has none, **BOUNCE the stop** with a corrective reason (narrow, loop-guarded — P-001). `PreToolUse` also mirrors `AskUserQuestion`/`ExitPlanMode` dialogs into a coord escalation directly.                                                                 |
| **OMP**         | Yes — `turn_end` (`apps/operator/scripts/hooks/omp/coord-hook.ts`)                                                                                                                                                                                 | **Soft enforce.** No blocking primitive at turn boundary, but `turn_end` can capture the final turn text, ingest it (P-002's endpoint), and inject a `followUp` nudge (`deliverAs:'followUp'`) on the *next* turn when the prior one ended in an unstructured ask.                                                                                      |
| **Codex**       | **No.** `role-codex-home.ts` / the codex hook surface is `PreToolUse`/`PostToolUse` only — there is no turn-end/Stop-equivalent event today. (An upstream `notify` turn-complete channel reportedly exists but is **unverified against our pin**.) | **Convention only.** Nothing mirrors or bounces an unstructured Codex ask; the watcher (P-002, transcript-based) is the *only* backstop — it detects a pending `AskUserQuestion`/permission `tool_use` with no `tool_result` and surfaces "session blocked on owner" client-agnostically, but that's a liveness signal, not an ask-quality enforcement. |

## D-002: this asymmetry is a decision, not a bug

> **Enforcement is PER-CLIENT-CAPABILITY; the convention is UNIVERSAL.**
> Claude = hard Stop-bounce; OMP = turn\_end capture + followUp corrective
> nudge; Codex = convention + watcher only. The Codex prose-question gap is a
> **recorded decision**, not a bug to file later.

Concretely: don't file an EI/bug for "Codex doesn't bounce unstructured asks
the way Claude does" — that's expected, tracked here, and will only change if
Codex ships a genuine turn-end hook upstream (at which point this page and
the OMP-style extension become the template). What Codex sessions DO get
today:

* The convention itself, delivered via the same playbook text every client
  loads (`apps/operator/prompts/papercusp-su-{engineer,power}.tools.md` —
  "An owner-directed question MUST ride a durable channel").
* The P-002 transcript watcher's blocked-session detection, which is
  client-agnostic (works off the stored transcript, not a hook).
* A note in `role-codex-home.ts`'s own header pointing here, so anyone
  extending the Codex home-materialization path sees the gap in context.

## D-003 reminder: mirror, never suppress

Every hook in this system **copies** an ask into the coordination substrate;
none of them touch what the terminal actually shows. The goal is "the Inbox
is sufficient", never "the terminal goes dark" — a bounce is a *correction*
(try again, structured), not a silent drop.

## See also

* Plan `owner-inbox-single-pane-2026-07-17` (D-001 through D-008) — the
  full design this matrix serves.
* [turn-provenance-owner-vs-agent](/internal/docs/agent-insights/turn-provenance-owner-vs-agent) —
  the companion protocol for verifying *who* a turn came from, relevant once
  an inbox reply is relayed back into an asking session (D-006).
