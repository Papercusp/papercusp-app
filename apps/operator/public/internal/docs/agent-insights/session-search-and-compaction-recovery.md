# Session search + compaction recovery: your pre-compaction turns survive — retrieve, don't re-derive
URL: /internal/docs/agent-insights/session-search-and-compaction-recovery

Compaction and cold wakes lose CONTEXT, not DATA. Every agent session transcript (claude/omp/codex + harness chats) is indexed into session_turns and coord messages are a searchable corpus, so anything a compaction summary dropped is still on disk and retrievable verbatim. The failure this prevents: a successor burning turns re-deriving lost state it could have pulled with one sessions:search { session:'self', mode:'verbatim' } call. Covers self-recall after compaction, fleet postmortems via the membership ledger (postmortem-safe when owners are dead), the sessions:* navigation verbs, and the write-through discipline that keeps sessions a safety net rather than the primary store.

import { Aside } from '@astrojs/starlight/components';

Compaction (and a cold wake, and a re-spawn) loses **context, not data**. Your
transcript scrolls out of the model window, but every pre-compaction turn still
exists on disk and is **indexed** into `harness_shared.session_turns` — across
all four corpora (claude / omp / codex + harness agent chats). Coord messages
are indexed too. So the single most wasteful thing a successor can do is
**re-derive lost state from scratch** when it could **retrieve** it.

After a compaction, anything the summary dropped is recoverable:
`sessions:search { session:'self', mode:'verbatim', query:'<what you remember>' }`
finds the exact pre-compaction quote with its surrounding turns; `sessions:read { session:'self' }` reads the tail. **Retrieve, don't re-derive.**

## The four memory layers — where sessions fits

`sessions:*` is the **episodic, verbatim** layer — a peer of the three you
already use, not a replacement:

* **mem0** (`memory:*`) — what was **distilled** (curated, fuzzy-recalled facts).
* **facts** (`facts:*`) — **deterministic** standing conclusions, folded verbatim
  into every orient.
* **coord** (`coord:*`) — what's **happening** right now (live ephemera).
* **sessions** (`sessions:*`) — **what was actually said.** The safety net for
  everything nobody thought to file. If a conclusion never made it into mem0,
  facts, or a checkpoint, it is still in the transcript — and still findable.

## Self-recall after a compaction

Two moves:

1. **First orient after a compaction:** `coord:orient { afterCompaction: true }`.
   This folds your held work-items' checkpoints, armed-loop status, and the
   self-recall pointer back into your context — the deterministic half of
   recovery.
2. **Anything the summary lost:** `sessions:search { session:'self',
   mode:'verbatim', query:'…' }`. `'self'` is resolved **server-side** from the
   call context — you never discover your own transcript path — and a live-tail
   fallback scans the un-ingested tail of your own JSONL so even the last few
   minutes are searchable. `mode:'verbatim'` is the exact-quote finder;
   `mode:'hybrid'` (default) is the semantic/paraphrase finder. Both modes cover
   pre-compaction turns just the same — compaction only removes them from your
   live context window, never from the index.

The compaction summary you produce should **say this out loud** so the successor
knows to retrieve. The rendered compaction floor
(`~/.papercusp/compaction-strategy.md`, generated from
`apps/operator/prompts/papercusp-compaction.base.md` via `renderCompactionStrategy`
— never hand-edit the generated file) now carries both the `afterCompaction`
re-orient banner and a "the verbatim record SURVIVES" line for exactly this
reason.

## Fleet postmortems + handoff archaeology

`sessions:search` takes a `fleet:<slug>` filter that answers "where did fleet X
discuss Y" across **both** member transcripts and coord traffic in one call. The
non-obvious part — and the reason there is no `fleet:search` convenience verb —
is that the fleet→members resolution runs **server-side against the append-only
membership ledger, time-windowed**, *not* against live presence.

An ended agent loses its `fleet_slug` and its presence row is reaped on a TTL.
So resolving a fleet's members from **live presence** silently drops exactly the
dead members a postmortem needs. The membership ledger is append-only, so
`fleet:<slug>` recall is **postmortem-safe even when every member is dead** —
the documented presence-vs-history trap, handled once, in the filter.

For sequencing a handoff or reconstructing who-did-what:
`sessions:timeline { owner }` joins `session_turns` + `tool_invocations` + coord
messages by owner and time; `sessions:list` enumerates sessions across
claude/omp/harness-chat surfaces (it absorbs the old `dev:claude_session
op=list` and `omp:sessions op=list`).

## The tool surface

### Search bounds and zero-hit results

`sessions:search` validates its request before the handler runs: `limit` accepts 1–20 hits, and `context` accepts 0–5 turns on each side of a hit (default 2). A larger `context` value is a request error; it is not silently clipped after an expensive search.

A `mode:'verbatim'` result with 0 hits also includes an inline `hint` explaining that matching is an exact, contiguous, case-insensitive substring search and suggesting a `mode:'hybrid'` retry or a shorter literal fragment. For `session:'self'`, `zeroHitCaveat` further distinguishes a query miss from an owner whose other indexed sessions exist. Treat either signal as guidance to refine the query, not evidence that the conversation never happened.

* **`sessions:search`** — the fused, one-round-trip verb: search the session
  corpora → hydrate ±N-turn context windows around the top-k hits → `readMore`
  pointers into `sessions:read`. Prefer it over raw `search:*` when you want the
  surrounding turns, not just the hit. Precedent for fusing a
  search-then-read composition into one tool: `coord:orient`.
* **`sessions:read` / `sessions:list` / `sessions:timeline`** — the thin
  navigation verbs (windowed read, unified enumeration, joined timeline).
* **`search:fulltext` / `search:semantic`** — the generic search verbs already
  cover the `session_turn` and `coord_message` corpora via the SearchSource
  registry, honoring the structured filter bag (owner, speaker, client,
  since/until, fleet). `sessions:search` composes these primitives; it does not
  fork them.

`dev:claude_session op=search` and `omp:sessions op=search` were substring
greps over raw JSONL. For search, use the indexed path (`sessions:search` /
`search:*`); their `op=list` / `op=read` remain until `sessions:list` /
`sessions:read` fully absorb them.

## Write-through discipline — sessions is the net, not the trampoline

Retrieval is the backstop, **not** an excuse to skip filing. A durable
conclusion goes to `facts:assert` (standing conclusion), `work_items:checkpoint`
/ `loop:checkpoint` (in-flight continuity), or `memory:remember` (fuzzy fact)
**the moment it forms — not when the context gauge fills.** The \~75%-context
nudge is the backstop, not the trigger. Sessions search saves you when
write-through failed; it is not a substitute for it. Two reasons filing still
wins even though the transcript survives:

* **Deterministic delivery.** A `facts:assert` conclusion is folded verbatim into
  every future orient; a transcript quote has to be *searched for*, which means
  you have to remember it exists.
* **Distillation.** mem0/facts carry the *conclusion*; the transcript carries the
  raw turn you'd have to re-read and re-derive from. Retrieval is cheaper than
  re-derivation, but filing is cheaper than retrieval.

## See also

* Plan `session-search-scope-2026-07-05` (the corpora, the filter bag, the fused
  tool, adoption) and `compaction-context-loss-2026-07-05` (the write-through +
  recovery-cost framing).
* The memory-layers section of the su playbooks
  (`papercusp-su-{engineer,power}.tools.md`) and `~/.claude/AGENTS.md` § Memory,
  which now name `sessions` as the fourth recall layer.
