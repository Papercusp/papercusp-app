---
id: ch5-05-definetool
chapter: 5
order: 5
title: defineTool — one function, every surface
docSlugs: endpoint-system/writing-a-tool, endpoint-system/function-as-truth
---

## Brief

Every capability agents use — hundreds of them — is defined once as a typed
**tool** and automatically projected onto every surface: HTTP API, the
agents' tool protocol, the desktop's internal channels. One definition
carries the schema, the permissions, the audit trail, and the docs. It's the
platform's core extensibility seam.

## Details

The principle is "function as truth": you write one function with a typed
signature and guidance on when to use it, and the endpoint system generates
the rest — routing, validation, permission gating, telemetry, even the
per-role documentation agents read. That's why the agent tool catalog stays
coherent at this size: there is exactly one definition per capability.

For you this matters at the moment you want Papercusp to do something new:
"add a tool that talks to our internal inventory API" is a normal,
well-trodden request. An agent scaffolds the definition, implements the
function, and every agent on the machine can call it — with permissions and
auditing — the moment it lands.

Agents can even compose existing tools into reusable scripted recipes on the
fly, which covers most "I wish there were a verb for this" cases without any
new code shipping at all.
