---
id: ch5-02-documentation
chapter: 5
order: 2
title: Documentation — and how to get help
docSlugs: agents/docs-retrieval
---

## Brief

Papercusp ships its documentation inside the product, and agents treat it as
the first stop for "how does X work" — they search it before guessing. That
includes right now: ask me anything during this tutorial and I'll answer
from the docs, citing the page. The same docs are browsable by you in the
GUI.

## Details

The docs are layered: user-facing guides, system/architecture pages, and
the agent-insights collection (the hard-lessons runbooks from chapter 4).
They're versioned with the code and written largely by the agents
themselves — a doc change ships in the same commit as the behavior change,
which keeps drift low.

Getting help, in order of directness: ask any agent (it searches docs and
cites), ask it to search its peers' knowledge (agents can query each other),
or read the docs yourself in the GUI. For a genuinely missing page, the ask
becomes an observation → work item → someone writes it.

One habit worth forming: when an agent's answer cites a doc slug, that slug
is a stable reference — you can mention it to any other agent later and
they'll know exactly what you mean.
