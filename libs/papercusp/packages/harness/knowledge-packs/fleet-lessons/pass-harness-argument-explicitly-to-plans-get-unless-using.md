---
id: pass-harness-argument-explicitly-to-plans-get-unless-using
title: "Pass harness argument explicitly to plans:get unless using harness-scoped session"
kind: feedback
type: feedback
applies_to: [any]
---
plans:get rejects calls missing the harness parameter. Always pass harness as a per-call argument—either a specific harness identifier or 'all' for cross-harness scope. If using a harness-scoped session, the harness is supplied automatically; otherwise, omit it. Missing this argument is a schema validation failure, not a tool bug.

Provenance: recurred 5× across the fleet — adopted from the fleet candidate queue.
