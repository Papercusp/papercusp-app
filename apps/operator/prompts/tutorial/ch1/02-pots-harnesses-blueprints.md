---
id: ch1-02-pots-harnesses-blueprints
chapter: 1
order: 2
title: Pots, harnesses & blueprints — where work lives
docSlugs: harness/glossary, system/blueprint-distribution
---

## Brief

A **pot** is a project — usually a code repository plus everything Papercusp
knows about it. Inside a pot, work runs through **harnesses**: pipelines that
take a task from "described in one sentence" to "done and reviewed", with
specialist agents handling each stage. A **blueprint** is the reusable
template a harness is stamped from — coding, research, review, migration and
more ship built in.

## Details

Think of it as three layers. The pot is the container: one per project, it
holds the repo, its settings, and its history. The harness is the running
pipeline inside a pot — when you file work, the harness routes it through a
sequence of specialist agents (for a coding harness: scoping, architecture,
implementation, validation, review, documentation), with human approval
gates where they matter.

Blueprints are what make harnesses cheap to create. Each blueprint defines a
pipeline shape for a kind of work — decomposable coding work, an open-ended
investigation, a large mechanical migration, a structured decision. You pick
the blueprint that fits, and Papercusp instantiates a harness from it. You
can also extend a blueprint when your project needs a custom flow.

You rarely need to think about this machinery day-to-day: you describe work
to an agent, and it lands in the right harness. But knowing the three words
helps you read the GUI — its tabs are organized around exactly these layers.
