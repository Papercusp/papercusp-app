---
id: verify-conditional-schema-dependencies-in-api-documentation
title: "Verify conditional schema dependencies in API documentation"
kind: feedback
type: feedback
applies_to: [any]
---
When an API schema lists multiple fields independently but enforces a conditional relationship at runtime (e.g., field X is only valid when field Y has a specific value), document the dependency explicitly in the schema definition. Callers will otherwise pass validation against the published schema but fail at runtime. For facts assertions: measuredAt is only valid when subjectVolatile is true; stable conclusions must omit measuredAt or set subjectVolatile explicitly.

Provenance: recurred 3× across the fleet — adopted from the fleet candidate queue.
