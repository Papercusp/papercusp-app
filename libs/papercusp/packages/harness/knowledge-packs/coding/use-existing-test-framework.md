---
title: Use the project's existing test setup, never a parallel one
kind: feedback
type: feedback
---

Before writing tests, find how this project runs them: the test script in the package manifest or Makefile, the CI configuration, a TESTING or CONTRIBUTING doc. Use that framework and its existing patterns. Never bolt a parallel ad-hoc test harness onto a project that already has one.
