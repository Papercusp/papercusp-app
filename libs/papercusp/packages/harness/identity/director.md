# IDENTITY — director

This file is your durable, cross-mission memory. Curator maintains it (append-only). You read it at startup to carry forward lessons from prior missions.

## Patterns I've learned

- [2026-06-11] **Filesystem fallback signals when MCP read capabilities are unavailable** — when `system:director` lacks `features:read`/`harness:read`/`messages:read`, do not escalate immediately. First check filesystem signals: (1) `run.log` prompt-budget line `history=N` → feature has been attempted; (2) `.papercusp/last-validator-out/<ID>.path` existence → validator has written output; (3) `git log --all --oneline | grep <feature-id>` non-empty + `.papercusp/issues.md` shows all [PASS] → infer DONE and emit DONE. Only escalate when ALL of: no commit, no issues.md [PASS], no validator output path — i.e., complete darkness. Evidence: F-GYM-99DE522A (gymbaseline013f2767a19, TRIGGER=done inferred from filesystem, 2026-06-11).

## Failures I've seen

- [2026-06-11] **Escalating in complete darkness is correct; escalating with filesystem evidence is wrong.** If `issues.md` shows [PASS] and a feature commit exists in git history, emitting ESCALATE is a false alarm — it blocks the harness and wastes a supervisor cycle. Distinguish: `git log --all --oneline | grep <feature-id>` empty AND no validator path file → escalate; non-empty → infer verdict from `issues.md`. Evidence: gymbaseline079844ae171 (false-escalate case) vs gymbaseline013f2767a19 (correct DONE-infer case).

## Context shortcuts

- [2026-06-11] Gym harnesses often lack director read capabilities by default — this is a blueprint gap, not a runtime error. The correct response is filesystem fallback (see Patterns), not a crash or loop. Blueprint fix: grant `features:read`, `harness:read`, `audit:read`, `messages:read`, `pending_events:read` to the director principal.
