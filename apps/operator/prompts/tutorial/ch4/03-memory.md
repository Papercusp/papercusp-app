---
id: ch4-03-memory
chapter: 4
order: 3
title: Agent memory — what the system knows about your world
docSlugs: harness/memory
---

## Brief

Papercusp keeps a shared, searchable **memory**: durable knowledge about
your projects, preferences, and past decisions, recalled semantically ("what
do we know about the payments service?") rather than by exact keyword. Every
agent reads from and writes to the same store, so what one agent learns, all
of them know.

## Details

Memory is the fuzzy layer of the knowledge stack — the right home for
background that should shape future work: "the owner prefers small PRs",
"the staging database is reset nightly", "we chose library X over Y because
Z". At the start of a task an agent recalls what's relevant to its intent
and treats hits as binding context.

It's shared on purpose: a memory written during a chat session is recalled
by an agent working a loop next week. That is what makes the system feel
like one organization rather than a series of goldfish conversations.

If an agent remembers something wrongly — or you change your mind — just say
so: memories can be corrected or forgotten, and the correction propagates to
everyone the same way.

Under the hood, recall is powered by a local embedding model — the default is
**Harrier-OSS-0.6b**, which gives the best recall on our internal benchmark and
runs fully on your machine (no API key, nothing leaves your device). If you
want a lighter footprint, **EmbeddingGemma-300m** uses less resources (~4×
faster embeds, ~1GB RAM instead of ~2.5GB) with slightly lower recall — switch
any time in **Settings → User → Memory system**, then run "Re-embed" on the
Memory page so existing memories follow you to the new model.

**One caveat for Harrier:** it embeds and recalls your *memories*, but
semantic search over your *docs, recipes, and knowledge* stays on
EmbeddingGemma — Harrier's vectors don't fit that search index. Both models
run locally, so either way nothing leaves your device.
