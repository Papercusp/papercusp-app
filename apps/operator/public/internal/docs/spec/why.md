# 1. Why Papercusp exists
URL: /internal/docs/spec/why



Most agent frameworks today (LangChain, AutoGen, CrewAI, Smolagents, …) optimize for one of two things:
&#x20;"give the LLM tools and a goal, hope it figures it out", or
&#x20;"build a complicated DAG of agents". Both leak into long-running autonomous work badly:

Tool-loop frameworks drift on multi-day missions. Context windows fill, attention degrades, the model forgets what was decided three hours ago.
DAG frameworks bake too many decisions into code that can't be revised by the agents themselves. Adding a new step requires a developer.

Papercusp takes a third path borrowed from{' '}
Anthropic's harness design{' '}
and{' '}
Factory.ai's missions architecture:
constrain the loop to a small set of named roles, each invoked with a fresh context,
each reading state from a structured store and writing decisions back. The roles can't drift because they don't see history;
they hand off to each other through structured artefacts.

That's the substrate. The Papercusp specification is the open standard for that substrate.

The pitch in one sentence: Papercusp is a substrate for running autonomous agent harnesses
for any long-running mission — coding, research, marketing, ops, anything. The framework is opinionated about
&#x20;drift control (fresh contexts, named decisions, file-based handoff). It's unopinionated about
what mission the harness runs. Anyone publishes a "harness config" via the marketplace; the best ones win.

Papercup was a reference install — a 5-director autonomous AI company demo, now preserved-not-active in
\_retired/papercup. It was never the framework's purpose; just an example of what one can ship on top.
