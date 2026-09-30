/**
 * One refusal names every invalid field (review-system-rework-reduction-2026-09-23
 * P-008, clause RSR-P-008-A).
 *
 * THE MECHANISM THIS FIXES. zod v4 skips an object-level `superRefine`/`refine`
 * while the object's base shape already has an issue. So a request with one shape
 * defect (a wrong-typed or missing field) and one refinement defect (an invalid
 * COMBINATION of fields) is refused naming only the shape defect; the caller fixes
 * it, retries, and only then learns about the second. Measured on zod 4.4.3: a
 * `{ a: 42 }` request against a two-rule schema reported `a` alone.
 *
 * THE FIX. Run the refinement ALWAYS, exactly once (zod v4's `when` check-param).
 * On a well-shaped value it behaves exactly as before, so a bug in it still
 * surfaces as an error. When shape issues already exist it sees UNVALIDATED input
 * (a field the shape rejected may be any type), so only then does it run inside
 * try/catch: a throw means "this combination cannot be judged on malformed
 * input", and the shape issue already explains the refusal.
 *
 * (A first version chained the original refinement with a guarded copy gated on
 * `payload.issues.length > 0`. The review-tool guard caught it reporting a rule
 * TWICE: the original's own issue satisfied the copy's gate. One check, told by
 * its own `when` whether the shape was clean, cannot double-report.)
 */
import type { z } from 'zod';

type Refinement<T> = (value: T, ctx: z.RefinementCtx) => void;

export function refineEvenWithShapeIssues<S extends z.ZodType>(schema: S, refinement: Refinement<z.output<S>>): S {
  // zod runs a check's `when` synchronously immediately before the check itself,
  // so this flag always describes the payload the check is about to see.
  let shapeHadIssues = false;
  return schema.superRefine(
    (value, ctx) => {
      if (!shapeHadIssues) return refinement(value, ctx);
      try {
        refinement(value, ctx);
      } catch {
        // Malformed input the shape check already refused; nothing more to report.
      }
    },
    {
      when: (payload: { issues: readonly unknown[] }) => {
        shapeHadIssues = payload.issues.length > 0;
        return true;
      },
    } as never,
  ) as S;
}
