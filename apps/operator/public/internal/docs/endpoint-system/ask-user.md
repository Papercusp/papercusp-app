# ctx.askUser — interactive prompts mid-run
URL: /internal/docs/endpoint-system/ask-user

Mid-tool-run interactive prompts. The card lives on the state channel, not the event ring buffer; reconnect after answer does not re-prompt.

# `ctx.askUser` — interactive prompts mid-run

A tool handler can pause and ask the user a question:

```ts
const r = await ctx.askUser({
  prompt: 'Did you mean X or Y?',
  // The radio renderer submits `{ picks: [optionId] }`, so the schema
  // must match that shape — the server validates the inbound payload
  // against dataSchema verbatim, with no key remapping.
  dataSchema: z.object({ picks: z.tuple([z.enum(['x', 'y'])]) }),
  presentation: {
    kind: 'radio',
    options: [
      { id: 'x', label: 'X' },
      { id: 'y', label: 'Y' },
    ],
  },
});

switch (r.action) {
  case 'submit':  return doX(r.payload.picks[0]);
  case 'decline': return useDefault();
  case 'cancel':  throw new Error('cancelled');
}
```

The handler **blocks** until the user submits, declines, or the run is cancelled. The user's choice is the function's return value, not a separate user message.

## Two channels

The endpoint system has two channels:

| Channel    | Used by                                                | Wire event       | Replay on reconnect        |
| ---------- | ------------------------------------------------------ | ---------------- | -------------------------- |
| **Events** | `ctx.emit('progress', …)`, `ctx.emit('text-delta', …)` | typed events     | Ring buffer history (T2.2) |
| **State**  | `ctx.askUser`, `ctx.publishState`                      | `state-snapshot` | Current snapshot only      |

**Cards live on the state channel.** A reconnecting client receives the latest snapshot of `openCards[]` — already-answered cards are gone, so the user is never re-prompted for something they already answered. (This is the bespoke-card-improvements H2 fix; if cards lived on the event ring buffer, the replay-on-reconnect would re-emit them.)

Each entry in `state-snapshot.openCards[]` is an `OpenCardSnapshot`: it carries `correlationId`, `prompt`, `presentation`, `fallbackText`, `allowDecline`, `report`, `createdAt`, and `dataSchemaJson`. The `dataSchema` is **not** shipped as a Zod object — the server serializes it to JSON Schema (the required `dataSchemaJson` field) so the renderer can read the schema without a Zod runtime. The default adapter is Zod 4's `toJSONSchema` (`zod-to-json-schema@3` produced empty output for Zod 4 schemas), with the `$schema` key stripped.

## API

```ts
interface CardSpec<TSchema extends ZodTypeAny> {
  /** Human-readable prompt. Voice surfaces read this verbatim. */
  prompt: string;

  /** Zod schema for the response payload. Validated server-side. */
  dataSchema: TSchema;

  /** Visual presentation hint. Voice surfaces ignore. */
  presentation?: CardPresentation;

  /** Plain-text fallback for voice / MCP-elicitation bridge. */
  fallbackText?: string;

  /** Wall-clock timeout. Rejects with {action:'cancel'} if user does not respond. */
  timeoutMs?: number;

  /** Per-run idempotency key. Same key returns cached response within the run. */
  idempotencyKey?: string;

  /** When false, the renderer hides the Skip affordance. Default true. */
  allowDecline?: boolean;

  /**
   * Optional structured body block (the shared `ReportBlock` two-tier
   * plan→item shape from `@papercusp/chat-protocol`) rendered between the
   * prompt and the options. Copied verbatim onto the wire snapshot.
   */
  report?: ReportBlock;

  /**
   * Fired synchronously once the card is registered, with the freshly-minted
   * `correlationId` and the run/workspace it's scoped to. Lets a caller link
   * the live card to an external durable record (e.g. an inbox / coord
   * escalation). NOT called on an idempotency-cache hit (no card is
   * registered), and any throw is swallowed — it never breaks the card flow.
   */
  onCard?: (info: { correlationId: string; runId: string; workspaceId: string }) => void;
}

type CardResponse<TSchema extends ZodTypeAny> =
  | { action: 'submit';  payload: z.infer<TSchema> }
  | { action: 'decline'; reason?: string }
  | { action: 'cancel' };
```

### Submit payload shape by presentation

The renderer wraps the user's response into a per-kind payload shape:

| Presentation        | Submit payload                           |
| ------------------- | ---------------------------------------- |
| `radio`, `checkbox` | `{ picks: [optionId, ...] }`             |
| `text`              | `{ value: string }`                      |
| `date`              | `{ value: string }` *(ISO `yyyy-mm-dd`)* |
| `slider`            | `{ value: number }`                      |

Your `dataSchema` must match the payload shape. For a single-select radio with two options, that's typically `z.object({ picks: z.tuple([z.enum(['x','y'])]) })`. For a date, `z.object({ value: z.string().date() })`. The server validates the inbound payload against `dataSchema` before resolving the handler's promise.

### `presentation` shapes

```ts
type CardPresentation =
  | { kind: 'radio';    options: CardOption[]; voiceAnswerable?: boolean }
  | { kind: 'checkbox'; options: CardOption[] }
  | { kind: 'text';     placeholder?: string; multiline?: boolean }
  | { kind: 'date';     min?: string; max?: string }
  | { kind: 'slider';   min: number; max: number; step?: number };

interface CardOption {
  id: string;
  label: string;
  hint?: string;
  style?: 'default' | 'primary' | 'danger';
}
```

`voiceAnswerable` on the `radio` variant is the opt-in that makes a radio card answerable **by voice**: when `true`, voice surfaces expose the option set for spoken answering. It defaults to off, and every other presentation kind stays announce-only on voice regardless.

## Response actions

| `r.action` | Meaning                                                  | When                                                            |
| ---------- | -------------------------------------------------------- | --------------------------------------------------------------- |
| `submit`   | User picked. `r.payload` validated against `dataSchema`. | User clicked Submit / chose a single option.                    |
| `decline`  | User explicitly skipped.                                 | User clicked Skip (only available when `allowDecline ≠ false`). |
| `cancel`   | Run cancelled, workspace switched, or `timeoutMs` fired. | Out-of-band — user did not respond.                             |

The handler picks one branch for each. `decline` is for "this card isn't relevant, but keep running." `cancel` always means the entire run is going away.

Single-select choice cards may also include **navigational** (non-terminal) options — clicking one opens a sub-surface (e.g. a chat thread or a log view) and leaves the card live instead of answering it. This is a renderer-local `navigate` action: it does **not** POST to `/card-response` and never resolves the `ctx.askUser` promise, so it has no `r.action` branch on the handler side.

## What ctx.askUser is **not**

* **Not a tool call.** It happens *inside* a tool handler. The model sees the tool as one unit of work that returned a value.
* **Not on the event channel.** `ctx.emit('card', …)` is rejected at register time — `'card'` is a reserved event name to prevent plugins from intercepting other tools' askUser flow on the wire.
* **Not available when the transport is one-shot.** When `ctx.askUser` is undefined (no `runId` in context — e.g. a non-streaming HTTP caller hitting a tool directly), the handler should detect this and either return an error or pick a default.

## Lifecycle

```
                 (1) tool handler awaits ctx.askUser(spec)
                                │
                                ▼
              (2) card-correlator registers a UUID correlationId,
                  publishes state-snapshot with openCards[+correlationId]
                                │
                                ▼
              (3) transport ships state-snapshot to client
                                │
                                ▼
              (4) renderer reads openCards[head], shows AskChoiceCard
                                │
                                ▼
              (5) user clicks → POST /api/operator/conversations/:id/card-response
                                │
                                ▼
              (6) card-correlator: validate payload, resolve deferred,
                  publish state-snapshot with openCards[-correlationId]
                                │
                                ▼
              (7) handler continues with the response value
```

If the run aborts at any point, every open card under the run is resolved `{action:'cancel'}`.

If the user switches workspaces, every open card in the **leaving** workspace is resolved `{action:'cancel'}` via the `onWorkspaceSwitch` hook. `POST /api/workspaces/switch` captures `leaving = reg.current` *before* writing the new current, then fires `dispatchWorkspaceSwitch(leaving)` so the card-correlator's `cancelPendingCardsForWorkspaceSwitch(leaving)` resolves every deferred under that workspace; the state-channel drops all snapshots in the same pass.

## Cancelling an entire run

A user can dismiss every pending card under a run with one click. The chat surface (`PendingCardsBar`) renders a "Cancel" button alongside the head card. Click → `POST /api/operator/conversations/:id/run-cancel`:

```
POST /api/operator/conversations/:convId/run-cancel
Cookie: <session>
Content-Type: application/json

{ "runId": "<run-uuid>", "workspaceId": "<workspace-id>" }
```

The server calls `cancelPendingCardsForRun(runId)` — every pending card's deferred resolves `{action:'cancel'}`. Tools awaiting those cards see cancel and (typically) throw an "operation cancelled" error that the dispatcher catches.

Same auth + rate-limit contract as `/card-response`: session-cookie required (401 if missing), 30 RPS per session user, 404 on cross-workspace runId.

The client-side `PendingCardsBar` also optimistically dismisses ALL cards from the cancelled run (not just the head) — even if the SSE state-snapshot update is delayed, the local UI clears immediately.

## Auth, defense in depth, rate limit

The `/card-response` endpoint requires a session cookie (401 if missing). Beyond that, the card-correlator validates `expectedWorkspaceId` against the card's stored workspace — even if a caller bypasses the session check, cross-workspace replay returns 404 (`card not found`).

Rate limit: **30 RPS per session user**, sliding window. Bursts past that return 429. The bucket key is the session's user id (not the caller-supplied `workspaceId`, which is untrusted) so a single workspace-hopping client cannot evade the limit.

## Client-side companion: `askUserLocal`

For render-time-only prompts that never cross the wire (tab pickers, settings dialogs, "are you sure?" confirmations):

```ts
import { askUserLocal } from '@/lib/chat-cards/ask-user-local';

const r = await askUserLocal({
  prompt: 'Switch to a new chat?',
  dataSchema: z.object({ choice: z.enum(['yes', 'no']) }),
  presentation: { kind: 'radio', options: [...] },
});
```

Same `CardSpec` / `CardResponse` types. Different transport: a global subscriber registry in the React tree.

To **render** an `askUserLocal` prompt, mount a `LocalCardHost` somewhere in the React tree:

```tsx
import { LocalCardHost } from '@/app/_components/chat/LocalCardHost';

function MyLayout() {
  return (
    <>
      {/* …app chrome… */}
      <LocalCardHost />
    </>
  );
}
```

`LocalCardHost` subscribes to the `askUserLocal` registry on mount, queues incoming cards, and reuses the same `AskChoiceCard` / `InputCard` renderer dispatch as `PendingCardsBar` (so cards look identical regardless of which path emitted them). The operator chat sidebar already mounts one `LocalCardHost`; without any host mounted, every `askUserLocal` call immediately resolves `{action:'cancel'}`.

`askUserLocal` and `ctx.askUser` are **not interchangeable**. Use `ctx.askUser` when the prompt is in flight inside a tool execution; use `askUserLocal` when the prompt is purely a UI affordance.

## Idempotency

```ts
const r = await ctx.askUser({
  prompt: '...',
  dataSchema: ...,
  idempotencyKey: 'pick-flavor',
});
```

If the tool reaches this point again within the same `runId` (e.g. re-entrant flow), the cached response is returned without re-prompting. Keys are scoped per-run — two different runs ask independently.

## Timeouts

`timeoutMs` is on the card, not the tool. The card's deferred is resolved `{action:'cancel'}` when the timeout fires; the handler decides what to do next.

The tool's own `timeoutSec` is independent — it aborts the entire run, which cascades cancel to every open card under it.

## State retention across reconnects

`state-snapshot` for a `runId` is retained for 5 minutes after the run ends (success or abort). A late reconnect within that window receives the final snapshot. Past 5 minutes the entry is GC'd.

## Limitations

* **In-process only.** The PENDING map lives in the operator's Node process. Dev-mode HMR drops it; a server restart drops it. v1 accepts this — the same bound applies to `/turn-answer` today. PG-backed persistence is a v1.x follow-up.
* **One card visible at a time.** The renderer shows `openCards[0]`; additional concurrent cards queue behind it with an indicator. This avoids the multi-card chat-surface cliff. If you need a multi-question flow, prefer one card with a multi-field `dataSchema` instead of multiple sequential `ctx.askUser` calls.
* **No bidirectional state sync.** `ctx.publishState` handles server-to-client state (snapshot-only in v1; JSON-Patch deltas deferred to v1.1). The reverse (client-edits-server-state) is not in scope — it's the same shape as a regular tool call, which already covers that direction.

## See also

* [Function-as-truth](./function-as-truth.mdx) — how `defineTool` projects to every transport.
* [Voice modality](./voice-modality.mdx) — how cards collapse to plain text on voice surfaces.
* Plan: `apps/operator/docs/plans/bespoke-card-improvements-2026-05-13.md`
