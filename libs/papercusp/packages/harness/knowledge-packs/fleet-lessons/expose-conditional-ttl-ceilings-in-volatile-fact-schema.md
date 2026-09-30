---
id: expose-conditional-ttl-ceilings-in-volatile-fact-schema
title: "Expose conditional TTL ceilings in volatile-fact schema documentation"
kind: feedback
type: feedback
applies_to: [any]
---
When a schema field's valid range depends on another field's value (e.g., ttlSec ceiling differs for volatile vs. persistent facts), document the conditional constraint explicitly in the schema signature or validation error. Omitting dependent constraints forces callers to discover the ceiling through rejection cycles. Surface the binding rule: volatile facts enforce a lower ttlSec maximum than the advertised schema suggests.

Provenance: recurred 3× across the fleet — adopted from the fleet candidate queue.
