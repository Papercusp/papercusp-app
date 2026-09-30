# Per-turn token usage in claude stream-json lives in message_delta, not assistant events
URL: /internal/docs/agent-insights/stream-json-usage-lives-in-message-delta

assistant events' message.usage is an early-stream snapshot (single-digit output_tokens); the real cumulative per-message usage arrives on the stream_event message_delta — burn analysis over assistant events alone under-counts ~100×.

**The trap.** Parsing a persisted agent stream
(`harness_shared.harness_run_output.jsonl_body`, claude-code backend) for
per-turn token burn, the obvious source is the `assistant` events —
`event.message.usage.output_tokens`. It parses cleanly and returns numbers,
so nothing fails. But those usage objects are **early-stream snapshots**:
each `assistant` event carries the message state when that content block
landed, typically `output_tokens: 1–5`. A real 86-turn cup session summed to
**211** output tokens this way; the true figure was **27,833** (\~130×
under-count). Any burn-rate heuristic (inflection detection, behavioral
embeddings, cost attribution) silently degenerates to noise below its
thresholds — it doesn't error, it just never fires.

**Where the real number is.** The cumulative per-message usage arrives on the
**`stream_event` whose `event.type === 'message_delta'`** (the terminal delta
of each message). Correlate it to the message via the preceding
`stream_event` `message_start` (`event.message.id`):

```ts
if (type === 'stream_event') {
  const se = event.event;
  if (se.type === 'message_start') streamingMessageId = se.message?.id ?? null;
  else if (se.type === 'message_delta' && streamingMessageId) {
    const turn = byMessageId.get(streamingMessageId);
    if (turn && typeof se.usage?.output_tokens === 'number')
      turn.outputTokens = Math.max(turn.outputTokens, se.usage.output_tokens);
  }
}
```

(`Math.max` because deltas are cumulative and the assistant-event snapshot may
have landed first.) Reference implementation + tests:
`packages/operator-core/lib/replay/regret/transcript-core.ts` (FB-07,
self-learning-frontier P-021).

**Scope.** This is about **per-turn** attribution. For a run's **total**
usage, keep using the terminal `result` event (`total_cost_usd`, `usage`) —
that is what `harness-agent-runs.ts extractRunUsage` already does, and it is correct.
The gap only bites code that needs the burn **timeline** (fleet EKG
embeddings, regret-mining inflection turns, any per-turn pacing feature).
