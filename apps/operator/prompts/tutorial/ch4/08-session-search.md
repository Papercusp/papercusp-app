---
id: ch4-08-session-search
chapter: 4
order: 8
title: Session search & compaction recovery — nothing said is ever lost
docSlugs: agent-insights/session-search-and-compaction-recovery
---

## Brief

Remember auto-compaction summarizing a session? Here's the safety net under it:
the **full transcript is never thrown away** — every turn is saved to disk and
indexed. So an agent can *recover* what a summary dropped, and you can search
across **all** your past agent sessions — by meaning or by exact quote — to
find "where did we decide X?". Compaction loses context, not data.

## Details

An episodic index ingests every agent session — Claude, Codex, OMP, and the
in-app harness chats — as it happens. Three tools ride on top: **search**
(`sessions:search`, semantic *or* verbatim-quote), **read** (a bounded window
of turns around any hit), and **timeline** (one agent's speech + tool calls +
coordination messages merged over a time window).

The one that matters most is **self-recovery after compaction**:
`sessions:search { session: 'self', mode: 'verbatim', query: '…' }` finds the
exact pre-compaction quote — your own words from before the summary — because
those turns survive on disk and are re-indexed at read time. So when an agent
says "we discussed this earlier, let me find where," it genuinely can — digging
up a design decision you made several sessions ago, word for word, instead of
guessing from a lossy summary. It's why long-running work here is resilient:
the conversation is a view, the transcript-plus-database is the state.
