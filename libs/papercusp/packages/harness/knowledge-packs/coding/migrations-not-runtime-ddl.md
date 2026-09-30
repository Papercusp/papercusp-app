---
title: Schema changes go through migrations
kind: feedback
applies_to: [service]
type: feedback
---

Find the project's migration system and use it for every schema change — never runtime DDL or hand-applied SQL that the migration ledger doesn't know about. An unrecorded schema change re-runs, conflicts, or silently diverges environments later.
