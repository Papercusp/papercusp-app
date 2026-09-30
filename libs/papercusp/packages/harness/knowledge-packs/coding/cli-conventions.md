---
title: Follow CLI conventions users already rely on
kind: feedback
applies_to: [cli]
type: feedback
---

Match the tool's existing flag style and help-text shape; write errors to stderr, results to stdout, and exit non-zero on failure. Scripts and CI pipelines depend on these behaviors even when no human is watching.
