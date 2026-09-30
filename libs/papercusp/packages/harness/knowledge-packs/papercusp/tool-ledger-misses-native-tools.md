---
title: The tool ledger cannot see your client's native tools
kind: project
applies_to: [any]
type: project
---

Papercusp records tool calls that reach its MCP server. An agent client's OWN native tools — its file reader, editor, shell, and search — never reach that server, so they leave no row. Only the MCP `capability:*` equivalents are recorded, and in practice those are the minority path.

So the ledger cannot answer "how much work is this agent doing" in absolute terms, and a low count of code-shaped verbs is NOT evidence that an agent is idle or editing nothing. Compare a RATIO OVER TIME — the same instrument against itself, carrying the same bias — and say which of the two you are quoting.

Verbs with no native equivalent are fully captured and make cleaner signals: test runs, work-item completions, checkpoints, and claims.

This compounds with any origin skew in the same table, where hook-issued rows can dominate organic ones: a raw count then over-reports activity while simultaneously under-reporting code work. Before quoting any aggregate from a tool ledger as a verdict, say what ONE ROW of it actually represents.
