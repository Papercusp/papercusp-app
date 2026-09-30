/**
 * freshness/tool-schema — the ONE `dependsOn` argument spec, shared by every
 * carry-note tool that exposes the P-007/D-013 freshness axis.
 *
 * Both `work_items:checkpoint` and `loop:checkpoint` (EI-19470389781357111) accept
 * the same tag vocabulary against the same substrate. Two hand-maintained copies of
 * this description would be two copies of a list the CODE already owns
 * ({@link SUPPORTED_DEP_KINDS}) — the derived-truth-ladder smell CLAUDE.md names:
 * adding a dependency kind is one entry in `DEP_RESOLVERS`, and it must not also be
 * a prose edit in N tool files that can silently be forgotten in N-1 of them.
 */
import { z } from 'zod';
import { SUPPORTED_DEP_KINDS } from './resolvers';

/**
 * The declared-dependency arg. Tri-state — OMITTED preserves the existing
 * declaration (so an append or a plain re-write never silently drops it), `[]`
 * clears it, a list re-stamps.
 *
 * `subject` names what the note IS in the agent-facing text ('checkpoint',
 * 'carry-note'); everything else is identical by construction.
 */
export function dependsOnSpec(subject: 'checkpoint' | 'carry-note' = 'checkpoint') {
  return z
    .array(z.string().min(1).max(300))
    .max(24)
    .optional()
    .describe(
      `P-007 freshness: what this ${subject} is derived FROM, as \`kind:ref\` tags — ` +
        `supported kinds: ${SUPPORTED_DEP_KINDS.join(', ')} ` +
        '(e.g. "file:packages/operator-core/lib/x.ts", "work-item:WI-6198", "plan:my-plan-slug"). ' +
        'Each is resolved to a version token and stamped NOW, so a later reader is told WHICH dependency ' +
        `moved instead of guessing from the ${subject}'s age. Declaring them makes an OLD ${subject} ` +
        'readable as fresh when nothing moved, and — the case no age threshold can catch — a SECONDS-OLD ' +
        'one as stale when a PEER changed a file it depends on. Omit to keep the previous declaration; ' +
        'pass [] to clear it.',
    );
}
