# Context estimator: toolUseResult is a double-write that never enters context
URL: /internal/docs/agent-insights/context-estimate-tooluseresult-double-write

The transcript-bytes/4 context estimator must discount the top-level toolUseResult field — Claude Code writes each tool_result payload twice, and only message.content enters context.

## Symptom

A fresh/warm session (often a `[1m]` fleet member) reports context **already CRITICAL
(>100% of its soft compaction limit) right after a ToolSearch schema preload, before any
substantive tool call** — and the **exact same token figure recurs verbatim across
consecutive wakes**. Each wake burns on flush+compact with zero progress; compaction never
helps because the number is dominated by an *immovable* baseline that reconstitutes
identically every wake.

## Root cause: the transcript double-writes every tool\_result

The context estimator (`packages/operator-core/lib/compaction-usage.ts`) estimates context
as **transcript-bytes-since-last-compaction / 4**. But Claude Code writes each tool\_result's
payload into its JSONL line **TWICE**:

1. `message.content` → a `tool_result` block — **this is what the model sees** (in context).
2. a **top-level `toolUseResult`** field — CC's local replay/re-render copy — **never sent to
   the model** (out of context).

So a bytes/4 estimate **roughly double-counts every tool result**. Measured on a real 21MB
transcript, `toolUseResult` was **21.3% of the file**. A big ToolSearch schema preload is
exactly a large text tool\_result → doubled → a member on a 300k soft cap reads \~332k (111%)
before doing anything, and compact-loops on the duplicate. The verbatim-repeat across wakes
is the tell: it's not genuine token growth, it's the same payload reconstituted each wake.

This is the **text analogue of WI-3176** (which already discounts the `"base64"` *image*
copy in `toolUseResult`), and one more member of the recurring "bytes/4 counts non-context
bytes" family (EI-6410 cross-compaction accumulation, EI-10434 unbounded scan, WI-4154 stale
cache).

## The fix pattern

Discount the top-level `toolUseResult` field from the estimate (key → end-of-line), **minus
any image-run bytes inside it** (those stay handled solely by the image path — no
double-discount). Safe because:

* `toolUseResult` is **always emitted after `message`** on the line (verified across live
  transcripts), followed only by non-context metadata (`uuid`/`session_id`/`cwd`/…) — so
  discounting from the key to end-of-line can never touch in-context `message.content`.
* Match the **comma-anchored top-level key** (`,"toolUseResult":`), which **fails safe**: a
  nested/escaped `\"toolUseResult\"` the session merely *read* as data never matches (the
  WI-4608 false-positive class), and an unmatched key just leaves the (harmless) over-count
  rather than risking an **under-count → real context death**.

Apply it to **both** estimator paths: the full-scan `tokensFromFileSize` and the
anchored-incremental path (a parallel `tureExcess` on the `TranscriptAnchor`, reset on a
compaction marker just like `imageExcess`).

## The general lesson

`bytes/4` over the raw transcript is only an approximation of context: the JSONL also stores
CC bookkeeping the model never receives (`toolUseResult`, uuids, timestamps, image base64
copies). When adding or debugging context accounting, **count only what enters
`message.content`** — and when you can't parse, discount the biggest non-context offenders
(`toolUseResult`, images) rather than counting the whole file.
