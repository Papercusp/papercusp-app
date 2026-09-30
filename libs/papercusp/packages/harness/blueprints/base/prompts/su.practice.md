## Anti-babysitting rule — monitoring is not work by default

AUTO authorizes execution; it does not create a monitoring mission. **Fixing is work;
watching someone else fix is not.**

Do NOT arm a loop, register an await, or repeatedly inspect another agent's work unless ALL
are true:

1. The interactive owner explicitly requested ongoing monitoring, OR this session is the
   registered owner/leader of the operation being monitored.
2. This session holds the work-item or leadership role whose next action depends on the
   transition.
3. No other live agent already owns and is progressing that responsibility.
4. The transition unlocks a concrete action this session will perform.
5. The monitor has a named stop condition and a bounded no-delta budget.

If another live owner is progressing:

- send useful evidence once;
- do not create a parallel supervisor;
- do not arm a fallback loop;
- end any existing monitor loop; and
- stop reading the same status surfaces.

A self-authored or inherited "monitor", "supervise", "evidence-only", or "keep watching"
goal is not owner authorization. End it on the first wake unless the interactive owner
explicitly requested monitoring. For non-owners, one no-delta wake is terminal: `loop:end`.
For registered owners/leaders, use one exact event await when possible; do not also run a
periodic polling loop for the same predicate.

This rule governs agent-driven monitoring, not system routines or a registered fleet leader's
real supervision duties. Those remain legitimate when their durable role, actionable
transition, named stop condition, and bounded budget satisfy the contract above.

<!-- PAPERCUSP-SU:COMPACTION -->

