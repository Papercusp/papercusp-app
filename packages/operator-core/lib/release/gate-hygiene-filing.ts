/**
 * P-007 (green-main-fast-2026-08-25), filing half: turn a hygiene failure that SURVIVED
 * auto-repair into an owned work-item, instead of a log line nobody reads.
 *
 * `gate-auto-repair.ts` answers "can this be fixed automatically, and did the fix work?".
 * When the answer is no, something still has to happen — and until now nothing did. The
 * sweep printed `REPAIR_SKIP` / `REPAIR_RESULT verdict=...` and exited non-zero, leaving
 * a real blocker owned by whoever happened to read the console. That is not hypothetical:
 * on 2026-08-26 the sweep found `gen:authored-docs:check` unrepairable and the resulting
 * work-item (WI-41770) was filed BY HAND, because there was no path from a verdict to a
 * filing. This module is that path.
 *
 * Like its siblings this is the DECISION half only. It runs nothing and files nothing —
 * it returns drafts. The actuator files them. A pure function here means the filing
 * policy is testable without a database, which is the whole reason the split exists.
 *
 * ## Why `repaired` is the ONLY verdict that files nothing
 *
 * A filer that files on success is a spam generator: the sweep runs on a schedule, most
 * runs repair cleanly, and an item per successful repair would bury the one that matters.
 * So `repaired` is excluded — and it is excluded EXPLICITLY, by name, rather than by a
 * "only file the bad ones" heuristic, because the set of bad ones is exactly what keeps
 * growing.
 *
 * ## Unknown verdicts FILE. That direction is deliberate.
 *
 * Every verdict is classified in `FILING_RULES` below, and that table is typed
 * `Record<RepairVerdict, FilingRule>` — so adding a member to `RepairVerdict` without
 * classifying it is a COMPILE error, not a blocker that silently stops being filed.
 * Where a runtime unknown is still possible (a caller on an older build, a hand-built
 * verdict string), it resolves to FILE, not skip. The asymmetry is the point: a spurious
 * work-item is cheap and visible, while an unfiled blocker is invisible and holds `main`.
 *
 * ## The body must carry the REMEDY DIRECTION, not just the failure
 *
 * This is the load-bearing part, and it is the same lesson `refused` taught in
 * `gate-auto-repair.ts`: two of these verdicts have OPPOSITE remedies.
 *
 *   `repair-failed`  — the generator is BROKEN.  Fix the generator.
 *   `repair-refused` — the generator is WORKING. It is guarding data that regenerating
 *                      would destroy. Fixing "the generator" here means forcing it to
 *                      overwrite, which is the data loss it was protecting against.
 *
 * A work-item whose title says only "gen:authored-docs:check is failing" invites the
 * reader to reach for `--force`. So the direction is not a footnote in the body; it is
 * carried as a typed field AND stated in the first line of the body, where the reader
 * cannot miss it before acting.
 */

import type {
  AssessedRepair,
  RepairVerdict,
  UnrepairableEntry,
} from "./gate-auto-repair";

/**
 * What the reader must DO — and, for the dangerous cases, must NOT do. Typed rather than
 * left to prose so a consumer can route on it (and so the opposite-remedy pair below can
 * never collapse into one bucket by a careless edit to a sentence).
 */
export type RemedyDirection =
  /** The generator works and is protecting data. Fix the DATA. Never force an overwrite. */
  | "fix-the-data-never-force"
  /** The generator itself is broken. Fix the generator. */
  | "fix-the-generator"
  /** Never a hygiene failure at all — treat it as the product failure it is. */
  | "treat-as-product-failure"
  /** No mechanical repair exists for this entry; a human must decide. */
  | "needs-human-triage";

/** How one verdict is filed. `file: false` is the whole no-filing policy, stated once. */
interface FilingRule {
  file: boolean;
  direction: RemedyDirection;
  /** Leads the body. Written as an instruction, not a description. */
  lead: string;
}

/**
 * Typed as a total map over `RepairVerdict` ON PURPOSE: adding a verdict without deciding
 * how it files fails the build. This is the structural guard, not a test that has to
 * remember to be updated.
 */
const FILING_RULES: Record<RepairVerdict, FilingRule> = {
  repaired: {
    file: false,
    direction: "fix-the-generator",
    lead: "Repaired automatically and verified by its own checker. Nothing to do.",
  },
  "repair-refused": {
    file: true,
    direction: "fix-the-data-never-force",
    lead:
      "⛔ DO NOT force this generator to overwrite. It exited non-zero because it " +
      "DECLINED to write, on purpose, to protect content that exists nowhere else. " +
      "The generator is working correctly; the DATA is what needs a decision.",
  },
  "repair-failed": {
    file: true,
    direction: "fix-the-generator",
    lead:
      "The generator failed to run. Read its output before assuming it is broken: a " +
      "non-zero exit can also be a deliberate refusal to overwrite something. If it " +
      "refused, fix the data — never force the write.",
  },
  "still-failing": {
    file: true,
    direction: "fix-the-generator",
    lead:
      "Regeneration changed files but the checker still rejects the result. The " +
      "generator and its checker disagree — a real defect in one of them.",
  },
  "not-stale-product": {
    file: true,
    direction: "treat-as-product-failure",
    lead:
      "Regeneration changed nothing yet the checker still fails, so the artifact was " +
      "never stale. This is a PRODUCT failure that was misclassified as hygiene — do " +
      "not look for a regeneration fix.",
  },
};

/** A work-item draft. Deliberately not a work-item: this module does not write. */
export interface HygieneFilingDraft {
  /**
   * Stable filing identity, keyed on the ENTRY alone — never on the verdict. A re-run
   * that produces a different verdict for the same failing checker must REFRESH the same
   * item, not open a sibling. Keying on the verdict would file a new item every time the
   * failure mode shifted, which is exactly when you least want the history split.
   */
  conditionKey: string;
  entry: string;
  title: string;
  body: string;
  direction: RemedyDirection;
}

export interface HygieneFilingPlan {
  drafts: HygieneFilingDraft[];
  /** Entries deliberately NOT filed, with why — so a caller can prove the silence. */
  skipped: { entry: string; why: string }[];
  reason: string;
}

export interface HygieneFilingInput {
  /** Hygiene failures with no mechanical repair at all, from `decideAutoRepair`. */
  unrepairable?: readonly UnrepairableEntry[];
  /** Outcomes of repairs that were actually attempted, from `assessRepairOutcomes`. */
  assessed?: readonly AssessedRepair[];
}

/**
 * Filing identity for an entry. Exported so the actuator cannot invent a second scheme —
 * and now DEFINED in gate-hygiene-split rather than here, so the gate's promotion drafts
 * and this pass's filings cannot drift apart. Same broken checker ⇒ same key ⇒ one item
 * that refreshes, whichever pass observed it. Re-exported so existing callers of this
 * module are unaffected by where it lives.
 */
import { filingConditionKey } from "./gate-hygiene-split";
export { filingConditionKey };

function ruleFor(verdict: RepairVerdict): FilingRule {
  // A verdict outside the table can only reach here at RUNTIME (an older caller, a
  // hand-built string). File it: see the header — an unfiled blocker is invisible.
  return (
    FILING_RULES[verdict] ?? {
      file: true,
      direction: "needs-human-triage" as const,
      lead:
        `Unrecognized repair verdict ${JSON.stringify(verdict)}. Filed rather than ` +
        `dropped, because a verdict this code does not understand is the last thing ` +
        `that should decide on its own to stay silent.`,
    }
  );
}

/**
 * Derive the work-items owed by a repair pass. Pure: no I/O, no clock, no ids.
 */
export function deriveHygieneFilings(
  input: HygieneFilingInput,
): HygieneFilingPlan {
  const drafts: HygieneFilingDraft[] = [];
  const skipped: { entry: string; why: string }[] = [];
  const seen = new Set<string>();

  // Unrepairable entries first: they never reached a repair attempt, so they have no
  // verdict and would otherwise be represented nowhere.
  for (const u of input.unrepairable ?? []) {
    if (seen.has(u.entry)) continue;
    seen.add(u.entry);
    drafts.push({
      conditionKey: filingConditionKey(u.entry),
      entry: u.entry,
      title: `Gate hygiene blocker with no automatic repair: ${u.entry}`,
      body:
        `A hygiene check is holding the release gate and cannot be repaired ` +
        `mechanically.\n\n` +
        `WHY NO AUTOMATIC REPAIR: ${u.why}\n\n` +
        `Entry: ${u.entry}\n` +
        `Remedy direction: needs-human-triage\n\n` +
        `Filed automatically by the P-007 hygiene sweep. Re-running the sweep refreshes ` +
        `this item rather than filing another.`,
      direction: "needs-human-triage",
    });
  }

  for (const a of input.assessed ?? []) {
    if (seen.has(a.entry)) continue;
    const rule = ruleFor(a.verdict);
    if (!rule.file) {
      skipped.push({
        entry: a.entry,
        why: `verdict=${a.verdict} — ${rule.lead}`,
      });
      continue;
    }
    seen.add(a.entry);
    drafts.push({
      conditionKey: filingConditionKey(a.entry),
      entry: a.entry,
      title: `Gate hygiene blocker survived auto-repair (${a.verdict}): ${a.entry}`,
      // The direction leads. A reader who stops after one line must still stop before
      // doing the dangerous thing.
      body:
        `${rule.lead}\n\n` +
        `Entry: ${a.entry}\n` +
        `Verdict: ${a.verdict}\n` +
        `Remedy direction: ${rule.direction}\n\n` +
        `WHAT THE REPAIR PASS FOUND: ${a.reason}\n\n` +
        `Filed automatically by the P-007 hygiene sweep. Re-running the sweep refreshes ` +
        `this item rather than filing another.`,
      direction: rule.direction,
    });
  }

  if (drafts.length === 0) {
    return {
      drafts,
      skipped,
      reason:
        skipped.length > 0
          ? `Nothing to file: all ${skipped.length} entr(ies) repaired cleanly.`
          : "Nothing to file: the repair pass reported no surviving hygiene failures.",
    };
  }

  return {
    drafts,
    skipped,
    reason:
      `${drafts.length} hygiene blocker(s) survived auto-repair and are owed a ` +
      `work-item: ${drafts.map((d) => d.entry).join(", ")}.`,
  };
}
