/**
 * P-007 (green-main-fast-2026-08-25): which gate failures may be MECHANICALLY REPAIRED
 * instead of held against `main`.
 *
 * This is the strictly safer sibling of P-005's split. P-005 (`gate-hygiene-split.ts`)
 * decides whether the gate may promote a candidate PAST a hygiene failure. This module
 * decides whether that failure can simply be FIXED — the artifact regenerated, the
 * checker re-run, and the red retired on its merits. Where P-005 trades a small
 * correctness risk for liveness, P-007 pays no such price: a regenerated artifact that
 * its own checker then accepts is not a promotion past anything.
 *
 * Like `gate-hygiene-split`, this is the DECISION half and only the decision half. It
 * runs nothing, writes nothing, and commits nothing — it has no runner dependency to
 * call. It answers two questions and stops:
 *
 *   1. `decideAutoRepair`  — which failing entries have a verifiable repair, and what
 *                            exact commands would repair and then re-verify them.
 *   2. `assessRepairOutcomes` — given what actually happened when a caller ran them,
 *                            did the repair genuinely work, or must the gate stay red?
 *
 * Splitting (2) out matters more than it looks. The dangerous half of auto-repair is
 * not choosing what to regenerate; it is deciding that regeneration WORKED. A gate that
 * assumes its own repair succeeded promotes an unverified tree, which is precisely the
 * failure the whole P-005/P-007 pair exists to avoid.
 *
 * ## Where the repair LANDS is deliberately not this module's problem
 *
 * "Regenerate, commit, re-judge" needs somewhere to put the fixed bytes. That machinery
 * already exists and is not reimplemented here: `frozen-candidate-repair-queue.ts`
 * already owns the serialized repair lifecycle (worktree preparation, staging-containment
 * checks, and `reconcileFrozenRepairIntoStaging` for landing an exact tested repair).
 * A second path that regenerates and commits on its own would be a parallel system with
 * none of that serialization — the reuse-first smell, and on a shared tree an actively
 * dangerous one. This module produces a verified repair PLAN and a verdict on its
 * outcome; landing it belongs to the existing queue.
 *
 * ## Only DERIVED repairs are admitted, and one measurement is why
 *
 * `gate-hygiene-split` classifies three hygiene categories, and every one of them
 * carries a `remedy` string. It is tempting to treat `remedy` as "the command that fixes
 * this" and run it. That is wrong, and the counter-example is already in the table:
 *
 *     EXPLICIT_HYGIENE_GATE_SCRIPTS["lint:tool-prompts"].remedy === "npm run lint:tool-prompts"
 *
 * which is the FAILING CHECKER ITSELF, not a fixer. Running it repairs nothing and exits
 * non-zero exactly as before; a naive auto-repair would either report a phantom success
 * or retry forever. The `remedy` field is prose for a human reader — "here is where to
 * start" — and was never a promise of idempotent repair.
 *
 * The derived set carries a guarantee the explicit set cannot. `gen:X:check` qualifies as
 * hygiene only when `gen:X` ALSO exists, so the pair is proven from the root
 * package.json rather than asserted by hand, and the two halves are structurally
 * distinct: `gen:X` produces the artifact, `gen:X:check` judges it. That gives a repair
 * command that is not the checker, plus an independent verifier for whether it worked.
 * Both are required, so only the derived set is admitted here. `budget-exceeded` and
 * `fixture-drift` are refused BY CATEGORY, with their reason attached, rather than
 * silently dropped — a refusal a reader can audit is worth more than a shorter list.
 *
 * ## Fail-closed, in the same direction as P-005 and for the same asymmetry
 *
 * Wrongly repairing something is how a real regression gets papered over; wrongly
 * REFUSING to repair merely reproduces today's behaviour, which is a red a human already
 * knows how to clear. So every unknown, unparseable, unpaired, or non-hygiene entry
 * resolves to "not repairable", and the tests assert that by enumeration.
 */

import {
  classifyGateFailure,
  type ClassifiedGateFailure,
  type HygieneCategory,
  type HygieneClassificationContext,
} from "./gate-hygiene-split";

/**
 * The one hygiene category whose repair is structurally verifiable — see the header.
 * Declared as a constant rather than inlined so the enumeration test can assert that
 * every other category is refused, and so adding a fourth category cannot silently
 * become repairable by default.
 */
export const AUTO_REPAIRABLE_CATEGORIES: readonly HygieneCategory[] = Object.freeze([
  "generated-artifact-stale",
]);

/** Why a hygiene failure that is otherwise real cannot be auto-repaired. */
export interface UnrepairableEntry {
  entry: string;
  /** Stated per-entry so a frozen gate can explain itself without a second investigation. */
  why: string;
}

export interface AutoRepairStep {
  /** The failing entry exactly as the gate reported it. */
  entry: string;
  category: HygieneCategory;
  /** The generator, e.g. `npm run gen:declarations`. Never equal to `verifyCommand`. */
  repairCommand: string;
  /** The checker that must pass AFTER the repair, e.g. `npm run gen:declarations:check`.
   *  The repair is judged by this, never by the generator's own exit code: a generator
   *  can exit 0 and still emit an artifact its checker rejects. */
  verifyCommand: string;
}

export interface AutoRepairInput {
  /**
   * Failing check ids. Both placements of P-007 feed this the same way and get the same
   * answer, which is why there is only one function:
   *
   *   PRE-JUDGE  — run the `gen:*:check` scripts up front and pass whichever failed, so a
   *                stale artifact is repaired before the suite is ever judged and the red
   *                is never surfaced at all.
   *   POST-RED   — pass a rendered red verdict's failing entries to repair and re-judge.
   *
   * The decision cannot tell the two apart and does not need to: "this named checker is
   * failing and its generator exists" has the same remedy either way.
   */
  failures: readonly string[];
  ctx: HygieneClassificationContext;
}

export interface AutoRepairDecision {
  /** True only when at least one step is genuinely repairable. */
  repair: boolean;
  reason: string;
  steps: AutoRepairStep[];
  /** Hygiene failures that are real but not mechanically repairable, each with why. */
  unrepairable: UnrepairableEntry[];
  /** Product-class failures seen in the same input. Reported, never repaired — a product
   *  failure is not a stale artifact, and the caller still owes it a red. */
  productFailures: ClassifiedGateFailure[];
}

/** `npm run gen:X` → `npm run gen:X:check`. Kept next to its only caller so the
 *  repair/verify pairing cannot drift apart. */
function verifierFor(repairCommand: string): string | null {
  const m = /^npm run (gen:.+)$/.exec(repairCommand);
  if (!m) return null;
  return `npm run ${m[1]}:check`;
}

export function decideAutoRepair(input: AutoRepairInput): AutoRepairDecision {
  const { failures, ctx } = input;

  const classified = (failures ?? []).map((f) => classifyGateFailure(f, ctx));
  const productFailures = classified.filter((c) => c.klass === "product");
  const hygiene = classified.filter((c) => c.klass === "hygiene");

  const steps: AutoRepairStep[] = [];
  const unrepairable: UnrepairableEntry[] = [];

  for (const h of hygiene) {
    const category = h.category;

    if (!category || !AUTO_REPAIRABLE_CATEGORIES.includes(category)) {
      unrepairable.push({
        entry: h.entry,
        why:
          `Hygiene category '${category ?? "unknown"}' has no structurally verifiable ` +
          `repair. Its remedy is a hand-written string, which in this table is not ` +
          `reliably a fixer at all (lint:tool-prompts' remedy IS the failing checker), ` +
          `so it is never executed automatically.`,
      });
      continue;
    }

    const repairCommand = h.remedy;
    if (!repairCommand) {
      unrepairable.push({
        entry: h.entry,
        why:
          "Classified generated-artifact-stale but carries no remedy command, so there " +
          "is nothing to run. Fails closed.",
      });
      continue;
    }

    const verifyCommand = verifierFor(repairCommand);
    if (!verifyCommand) {
      unrepairable.push({
        entry: h.entry,
        why:
          `Remedy '${repairCommand}' is not a 'npm run gen:X' generator, so no paired ` +
          `'gen:X:check' verifier can be derived for it. An unverifiable repair is ` +
          `refused.`,
      });
      continue;
    }

    if (verifyCommand === repairCommand) {
      // Unreachable given the regex above, but asserted rather than assumed: a repair
      // command identical to its verifier is the lint:tool-prompts failure shape, and it
      // must never be executed as a repair.
      unrepairable.push({
        entry: h.entry,
        why:
          `Repair command and verifier are identical ('${repairCommand}'), which means ` +
          `the 'fix' is the failing check itself. Refused.`,
      });
      continue;
    }

    steps.push({ entry: h.entry, category, repairCommand, verifyCommand });
  }

  if (steps.length === 0) {
    return {
      repair: false,
      reason:
        hygiene.length === 0
          ? "No hygiene failures to repair."
          : `${hygiene.length} hygiene failure(s), none mechanically repairable.`,
      steps,
      unrepairable,
      productFailures,
    };
  }

  return {
    repair: true,
    reason:
      `${steps.length} stale generated artifact(s) can be regenerated and re-verified: ` +
      steps.map((s) => s.entry).join(", ") +
      (productFailures.length > 0
        ? `. ${productFailures.length} product failure(s) remain and still hold the gate.`
        : "."),
    steps,
    unrepairable,
    productFailures,
  };
}

/** What actually happened when the caller ran one `AutoRepairStep`. */
export interface RepairOutcome {
  entry: string;
  /** Exit code of `repairCommand`. */
  repairExitCode: number;
  /** Exit code of `verifyCommand`, run AFTER the repair. This is the authority on
   *  whether the repair worked. */
  verifyExitCode: number;
  /** Did regenerating actually change anything on disk? Distinguishes "the artifact was
   *  stale and is now fixed" from "the artifact was already current and something else
   *  is failing this check". */
  producedDiff: boolean;
  /**
   * Did the generator exit non-zero because it DELIBERATELY DECLINED to write, rather
   * than because it broke? Supplied by the caller, never inferred here — a pure function
   * cannot read a generator's output, and guessing would be worse than not knowing.
   *
   * The distinction is not cosmetic and not a nit. A crash means the generator is broken
   * and someone should fix it. A refusal means the generator is WORKING — it is guarding
   * data, and the thing that needs fixing is the data. Confusing the second for the first
   * invites exactly one repair: "make it overwrite" — which destroys whatever the refusal
   * was protecting. That is a real, live case, not a hypothetical: `gen:authored-docs`
   * refuses because 24 doc files hold hand-edits that exist nowhere else (WI-41770).
   *
   * Omitted ⇒ unknown, which resolves to `repair-failed` with a reason that warns about
   * this very ambiguity, so the dangerous misreading is guarded even when nobody sets it.
   */
  refused?: boolean;
}

export type RepairVerdict =
  /** Regenerated and the checker now passes. The red is retired on its merits. */
  | "repaired"
  /** The generator DECLINED to write, on purpose, to avoid destroying something. NOT a
   *  code defect: the generator is working. The data needs a human decision. */
  | "repair-refused"
  /** The generator itself failed, or declined for a reason the caller did not classify.
   *  Nothing was fixed. */
  | "repair-failed"
  /** Regeneration changed files but the checker still fails — a real, unfixed problem. */
  | "still-failing"
  /** Regeneration changed NOTHING and the checker still fails. The artifact was never
   *  stale, so this was never a hygiene failure. Reclassified to product. */
  | "not-stale-product";

export interface AssessedRepair {
  entry: string;
  verdict: RepairVerdict;
  reason: string;
}

export interface RepairAssessment {
  /** True only when every attempted repair verified clean. */
  allRepaired: boolean;
  reason: string;
  results: AssessedRepair[];
  /** Entries the gate must still treat as PRODUCT failures after this pass. Non-empty
   *  means the candidate does not become promotable on the strength of the repair. */
  stillBlocking: string[];
  /** Always false. A second automatic pass is never recommended: a repair that did not
   *  take on attempt one is a real problem, and re-running the generator is how an
   *  auto-repair becomes an infinite loop that hides it. */
  retryRecommended: false;
}

export function assessRepairOutcomes(
  outcomes: readonly RepairOutcome[],
): RepairAssessment {
  const results: AssessedRepair[] = (outcomes ?? []).map((o) => {
    if (o.repairExitCode !== 0 && o.refused === true) {
      return {
        entry: o.entry,
        verdict: "repair-refused" as const,
        reason:
          `The generator exited ${o.repairExitCode} because it DECLINED to write, not ` +
          `because it broke. It is working correctly and is protecting something that ` +
          `regenerating would destroy. Do NOT "fix" this by forcing an overwrite — ` +
          `resolve the underlying data conflict instead.`,
      };
    }

    if (o.repairExitCode !== 0) {
      return {
        entry: o.entry,
        verdict: "repair-failed" as const,
        reason:
          `The generator exited ${o.repairExitCode}. Nothing was repaired, so the ` +
          `original failure stands. ⚠ Read its output before treating this as a broken ` +
          `generator: a non-zero exit can also be a DELIBERATE REFUSAL to overwrite ` +
          `something (see the 'refused' field). Forcing such a generator to write is how ` +
          `a protective refusal turns into data loss.`,
      };
    }

    if (o.verifyExitCode === 0) {
      return {
        entry: o.entry,
        verdict: "repaired" as const,
        reason:
          "Regenerated and its own checker now passes. Verified by the checker, not by " +
          "the generator's exit code.",
      };
    }

    if (!o.producedDiff) {
      return {
        entry: o.entry,
        verdict: "not-stale-product" as const,
        reason:
          "Regeneration changed nothing on disk yet the checker still fails, so the " +
          "artifact was never stale. This check is failing for some other reason and " +
          "was misclassified as hygiene. Treated as a product failure.",
      };
    }

    return {
      entry: o.entry,
      verdict: "still-failing" as const,
      reason:
        "Regeneration changed files but the checker still fails. A real problem that " +
        "auto-repair cannot clear; it keeps holding the gate.",
    };
  });

  const stillBlocking = results
    .filter((r) => r.verdict !== "repaired")
    .map((r) => r.entry);

  if (results.length === 0) {
    return {
      allRepaired: false,
      reason: "No repair outcomes were reported, so nothing is verified as fixed.",
      results,
      stillBlocking,
      retryRecommended: false,
    };
  }

  if (stillBlocking.length === 0) {
    return {
      allRepaired: true,
      reason:
        `All ${results.length} stale artifact(s) regenerated and re-verified clean.`,
      results,
      stillBlocking,
      retryRecommended: false,
    };
  }

  return {
    allRepaired: false,
    reason:
      `${stillBlocking.length} of ${results.length} repair(s) did not verify clean: ` +
      stillBlocking.join(", ") +
      ". The gate stays red on these.",
    results,
    stillBlocking,
    retryRecommended: false,
  };
}
