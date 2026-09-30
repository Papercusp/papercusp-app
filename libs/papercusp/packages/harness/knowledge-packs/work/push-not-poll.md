---
title: Wait on events, never poll
kind: feedback
type: feedback
---

When you are blocked on something another agent or system will announce (a sub-task finishing, a review landing, an escalation resolving), register a wake on that event and end your turn. Polling in a loop burns budget and still reacts slower than a push. Tell the emitter what key you are awaiting; emit the keys peers told you they await.
