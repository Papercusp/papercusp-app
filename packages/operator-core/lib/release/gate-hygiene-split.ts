/**
 * P-005 (green-main-fast-2026-08-25): which gate failures may hold `main` red.
 *
 * On the evening of 2026-08-25 the gate was blocked three separate times, by three
 * DIFFERENT machinery faults, and by ZERO product-test failures: a fossil verdict
 * naming six guard tests that all passed at HEAD; a frozen repair queue waiting on a
 * dead fixer; and a fail-closed prewarm prerequisite that crashed before the suite.
 * Every one froze promotion for the whole fleet. That is the case for splitting the
 * verdict: a failure whose entire remedy is "regenerate a file" should file a work
 * item, not freeze `main`.
 *
 * This module is the DECISION half of that split, and only the decision half. It
 * classifies failures and says whether promotion may proceed; it files nothing,
 * promotes nothing, and calls nothing. Actuation is the caller's, deliberately —
 * same separation as `green-stall-watchdog`'s refire decision, for the same reason:
 * a pure verdict can be exhaustively tested against real inputs, and a decision that
 * cannot act cannot misfire while it is being proven.
 *
 * ## The rule this module exists to enforce: hygiene is a property of the FAILURE,
 * ## never of the file it came from
 *
 * The obvious implementation — "doc-claims are drift guards, so exempt that
 * directory" — is UNSAFE, and measurably so. `doc-claims/gate-candidate-ref.test.ts`
 * lines 97-102 is ONE `it()` block holding three assertions of two different kinds:
 *
 *     expect(verdict.violations).toEqual([]);                          // SUBSTANTIVE
 *     expect(verdict.ok).toBe(true);                                   // SUBSTANTIVE
 *     expect(verdict.candidateSites.length).toBeGreaterThanOrEqual(2); // COVERAGE FLOOR
 *
 * On 2026-08-25 only the third failed: green-checkpoint.ts passed 14,500 lines, its
 * candidate-resolution calls became multi-line, and a per-LINE detector stopped
 * seeing one of them. Pure drift. But the first two assertions in that same block are
 * the pin that catches the gate resolving its candidate from a REMOTE ref, or
 * fetching before it cuts — i.e. the gate judging a sha nobody asked for. Exempt the
 * FILE and you switch that off too, which is the opposite of what P-005 wants.
 *
 * So hygiene-vs-product does not vary by directory, or by file, or even by test. In
 * the block above it varies WITHIN a single `it()`. The only sound unit is the
 * failure's own semantics, which is why the admitted set below is defined as "the
 * entire remedy is regenerate-an-artifact or get-back-under-a-budget, with no
 * behavioural assertion about the running system" — and why doc-claims are NOT in it.
 * Admitting them requires first separating those two assertion kinds inside the
 * guards themselves. That is real work in ~36 files and is explicitly follow-on.
 * Until then a doc-claim red keeps holding the gate, which is today's behaviour and
 * is the safe direction to be wrong in. Recorded as plan decision D-008.
 *
 * ## Everything here fails closed, and the asymmetry is why
 *
 * Misclassifying a PRODUCT failure as hygiene promotes a real regression to `main`.
 * Misclassifying a HYGIENE failure as product merely reproduces today's behaviour —
 * an annoying freeze that a human already knows how to clear. Those costs are not
 * comparable, so every unknown, unparseable, or unregistered entry resolves to
 * `product`. There is no "assume safe" branch anywhere in this file, and the tests
 * assert that by enumeration rather than by example.
 *
 * ## Why the generated-artifact set is DERIVED and not listed
 *
 * A hand-listed set of ~17 `gen:*:check` scripts is exactly the code-describing
 * metadata that drifts (see CLAUDE.md's derive/pin/attest ladder): someone adds an
 * 18th generator, nobody updates the list, and the gate freezes on a stale artifact
 * for reasons no one can find. So the set is derived from a STRUCTURAL fact instead —
 * a script qualifies only if BOTH `gen:X` and `gen:X:check` exist in the root
 * package.json. That pair means "a generator, plus a checker asking whether its
 * output is current", which is precisely the hygiene shape. A lone `gen:foo:check`
 * with no generator behind it does NOT qualify and falls through to product, so the
 * derivation cannot be widened by naming alone.
 */

/** What kind of hygiene failure this is — drives the remedy sentence on the filed item. */
export type HygieneCategory =
  | "generated-artifact-stale"
  | "budget-exceeded"
  | "fixture-drift"
  | "detector-coverage-drift";

export type GateFailureClass = "product" | "hygiene";

/** A hygiene entry that does NOT follow the `gen:X` / `gen:X:check` pair convention
 *  and therefore cannot be derived. Each one is here because its remedy is genuinely
 *  "regenerate or get under the budget" with no behavioural claim attached — the same
 *  bar the derived set meets, just reached by hand because the naming differs. */
export interface ExplicitHygieneEntry {
  category: HygieneCategory;
  /** The command that fixes it, as a reader would type it. */
  remedy: string;
  /** Why this is hygiene and not product. Stated per-entry so a future reader can
   *  audit the judgement instead of inheriting it. */
  why: string;
}

export const EXPLICIT_HYGIENE_GATE_SCRIPTS: Record<string, ExplicitHygieneEntry> = {
  "lint:tool-prompts": {
    category: "budget-exceeded",
    remedy: "npm run lint:tool-prompts",
    why:
      "A prompt-weight cap. Breaching it degrades agent prompts and must be fixed, but it " +
      "asserts nothing about whether the running system is correct, and it cannot corrupt " +
      "`main`. Historically this is the single most common way a tool-description edit " +
      "froze the fleet gate hours after the edit landed.",
  },
  "lint:migration-fixture-drift:check": {
    category: "fixture-drift",
    remedy: "npm run lint:migration-fixture-drift",
    why:
      "A test fixture has fallen behind the migrations it mirrors. The remedy is to " +
      "regenerate the fixture; the check makes no claim about production behaviour.",
  },
};

/** ## The one admitted exception to "a test file is never hygiene" (WI-41765, D-010)
 *
 * The header above rejects exempting a doc-claims FILE, and that rejection stands: the
 * measured reason was that `gate-candidate-ref.test.ts` held a SUBSTANTIVE pin and a
 * COVERAGE floor inside ONE `it()`, so a file-level exemption switched off the pin.
 *
 * That premise no longer holds for the block it was measured on. WI-41765 SPLIT those two
 * assertion kinds into separate `it()`s, which is precisely the precondition the header
 * names ("Admitting them requires first separating those two assertion kinds inside the
 * guards themselves"). Once separated, a single failing CASE is a sound unit: its whole
 * body is one kind of claim. The unit here is therefore the CASE, never the file — a file
 * is admitted only when EVERY one of its failing cases is registered below.
 *
 * WHY A REGISTRY AND NOT A HEURISTIC. There is no textual property of a case name that
 * makes it coverage-class; "coverage" in a title is a naming convention, and deriving from
 * it would let any future test opt itself out of the gate by choosing a word. Each entry is
 * a hand-audited judgement about one specific case, exactly like EXPLICIT_HYGIENE_GATE_SCRIPTS.
 *
 * WHY THE re-merge GUARD IS LOAD-BEARING. A registered case is trusted to contain only
 * instrument assertions. If someone later adds a substantive assertion back into it, this
 * registry silently converts a REAL product failure into hygiene — the original D-008 hazard,
 * one level down. `forbiddenSymbols` is what makes that detectable rather than a comment
 * nobody re-reads: gate-hygiene-coverage-cases.test.ts reads the real file and fails if any
 * of them appears in an `expect(...)` inside the registered case. */
export interface CoverageClassCase {
  /** Workspace-relative path, exactly as vitest's `❯ <file> (N tests | M failed)` header
   *  renders it — that header is what `extractFailingCasesByFile` keys its map by, and the
   *  gate's `failingTests` entries use the same shape. */
  file: string;
  /** Repo-relative path to the SAME file. Only the guard test uses it (to read the file);
   *  matching never does. Its presence is what lets the guard prove the workspace-relative
   *  key above resolves to exactly one real file, closing the ambiguity that two workspaces
   *  could both contain a `lib/…/x.test.ts`. */
  repoPath: string;
  /** The LEAF case name, exactly as vitest's `× <name>` row renders it. NOT the
   *  `describe > describe > it` path: a nested describe is emitted on its own `❯` row and
   *  does not prefix the case name (green-checkpoint.test.ts pins both shapes). */
  caseName: string;
  /** Symbols that would make this case substantive again. Presence of any inside an
   *  `expect(...)` in the registered case is a re-merge and fails the guard. */
  forbiddenSymbols: string[];
  /** Why this case is an instrument claim rather than a system claim. */
  why: string;
}

export const COVERAGE_CLASS_TEST_CASES: readonly CoverageClassCase[] = [
  {
    file: "lib/doc-claims/gate-candidate-ref.test.ts",
    repoPath: "packages/operator-core/lib/doc-claims/gate-candidate-ref.test.ts",
    caseName:
      "detector coverage: still sees both candidate-resolution sites (instrument health, not a system claim)",
    forbiddenSymbols: ["violations", "verdict.ok"],
    why:
      "Asserts the detector can still SEE both candidate-resolution sites. It makes no claim " +
      "about what the gate does — the sibling case 'cuts the candidate from the LOCAL " +
      "integration branch, and never fetches' holds that pin and stays product. On 2026-08-25 " +
      "this case alone failed because green-checkpoint.ts passed 14,500 lines and its calls " +
      "became multi-line: pure measurement drift, which froze every agent's promotions.",
  },
];

export interface ClassifiedGateFailure {
  /** The failing entry exactly as the gate reported it. */
  entry: string;
  klass: GateFailureClass;
  /** Why it landed in that class — always populated, including for `product`, so a
   *  frozen gate can explain itself without a second investigation. */
  reason: string;
  category?: HygieneCategory;
  remedy?: string;
}

export interface HygieneClassificationContext {
  /** The root package.json `scripts` map, passed in rather than read, so this module
   *  stays pure and the pair derivation is testable against synthetic script sets. */
  rootScripts: Record<string, string>;
  /** Failing CASE names attributed to the file they failed in, from the gate's own
   *  `extractFailingCasesByFile`. ABSENT ⇒ every test file classifies product, which is
   *  byte-identical to the behaviour before WI-41765 — the attribution can only ever
   *  ADMIT a file, never hold one it would otherwise have promoted. */
  failingCasesByFile?: ReadonlyMap<string, readonly string[]>;
}

/** `<workspace> :: <script>` → the script half; a bare id → itself; a bare workspace
 *  name → null (a whole workspace failing names no single check and is never hygiene). */
function scriptIdOf(entry: string): string | null {
  const trimmed = entry.trim();
  if (!trimmed) return null;

  const scoped = /^(@[^\s]+)\s*::\s*(.+)$/.exec(trimmed);
  if (scoped) return scoped[2].trim() || null;

  // A bare workspace name (`@papercusp/web`) names a whole suite, not a check.
  if (trimmed.startsWith("@")) return null;

  // A path is a test file. Never hygiene — see the header on doc-claims.
  if (trimmed.includes("/")) return null;

  return trimmed;
}

/** The derived half of the hygiene set: `gen:X:check` qualifies only when its `gen:X`
 *  generator also exists. Exported so the guard test can assert the derivation against
 *  the REAL package.json rather than a restated copy of its results. */
export function deriveGeneratedArtifactHygiene(
  rootScripts: Record<string, string>,
): Map<string, string> {
  const derived = new Map<string, string>();
  for (const key of Object.keys(rootScripts ?? {})) {
    const m = /^(gen:.+):check$/.exec(key);
    if (!m) continue;
    const generator = m[1];
    // The pair IS the evidence. A checker with no generator behind it is not a
    // freshness check, whatever it is named.
    if (!(generator in rootScripts)) continue;
    derived.set(key, `npm run ${generator}`);
  }
  return derived;
}

/** The file half of `scriptIdOf`'s `null` branch: the entries that are test-file paths,
 *  as opposed to bare workspaces or unparseable text. Mirrors `scriptIdOf`'s ordering
 *  deliberately — `@papercusp/web` contains a `/` too, and is a whole suite, not a file. */
function testFilePathOf(entry: string): string | null {
  const trimmed = entry.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("@")) return null;
  if (!trimmed.includes("/")) return null;
  return trimmed;
}

/** WI-41765 / D-010. Admits a failing test FILE as hygiene only when every one of its
 *  failing cases is a registered coverage-class case.
 *
 *  Every early return here is a fall-through to `product`, and each is a distinct way the
 *  evidence could be too weak to promote on:
 *    no attribution map  — the gate did not supply one; cannot know what failed inside.
 *    not a file path     — a bare workspace names a whole suite, never one case.
 *    no parsed cases     — the file failed with no `×` rows we could read (a crash, a
 *                          collection error, a reporter shape we do not parse). A file that
 *                          died before naming a case has NOT shown its failures are benign.
 *    any unregistered    — THE ONE THAT MATTERS: a file whose failing cases are not ALL
 *                          coverage-class stays product, so a substantive red sharing a
 *                          file with a coverage red still holds `main`. */
function classifyCoverageClassFailure(
  entry: string,
  ctx: HygieneClassificationContext,
): ClassifiedGateFailure | null {
  const byFile = ctx.failingCasesByFile;
  if (!byFile) return null;

  const filePath = testFilePathOf(entry);
  if (filePath === null) return null;

  const failingCases = byFile.get(filePath);
  if (!failingCases || failingCases.length === 0) return null;

  const registeredNames = new Set(
    COVERAGE_CLASS_TEST_CASES.filter((c) => c.file === filePath).map((c) => c.caseName),
  );
  if (registeredNames.size === 0) return null;

  const unregistered = failingCases.filter((name) => !registeredNames.has(name));
  if (unregistered.length > 0) return null;

  return {
    entry,
    klass: "hygiene",
    category: "detector-coverage-drift",
    reason:
      `Every failing case in '${filePath}' is a registered coverage-class case ` +
      `(${failingCases.map((n) => `'${n}'`).join(", ")}) — an assertion about whether the ` +
      `detector can still SEE what it measures, not about whether the system is correct.`,
    remedy:
      "Widen the detector to the shape it stopped recognising — never lower the floor it " +
      "asserts. Lowering it converts a loud instrument failure into a quiet false-clean, " +
      "which is strictly worse than the red it removes.",
  };
}

export function classifyGateFailure(
  entry: string,
  ctx: HygieneClassificationContext,
): ClassifiedGateFailure {
  const scriptId = scriptIdOf(entry);

  if (scriptId === null) {
    const coverageClass = classifyCoverageClassFailure(entry, ctx);
    if (coverageClass) return coverageClass;
    return {
      entry,
      klass: "product",
      reason:
        "Not a single named check (a test file, a bare workspace, or unparseable). " +
        "Fails closed to product.",
    };
  }

  const explicit = EXPLICIT_HYGIENE_GATE_SCRIPTS[scriptId];
  if (explicit) {
    return {
      entry,
      klass: "hygiene",
      reason: `Registered hygiene check (${explicit.category}): ${explicit.why}`,
      category: explicit.category,
      remedy: explicit.remedy,
    };
  }

  const derivedRemedy = deriveGeneratedArtifactHygiene(ctx.rootScripts).get(scriptId);
  if (derivedRemedy) {
    return {
      entry,
      klass: "hygiene",
      reason:
        `Generated-artifact freshness check: both '${scriptId}' and its generator ` +
        `exist in the root package.json, so its whole remedy is to regenerate.`,
      category: "generated-artifact-stale",
      remedy: derivedRemedy,
    };
  }

  return {
    entry,
    klass: "product",
    reason:
      `'${scriptId}' is not a registered or derivable hygiene check. Unknown checks ` +
      `hold the gate — promoting past an unclassified failure is the one error this ` +
      `split must never make.`,
  };
}

export interface PromotionInput {
  /** The gate's failing entries. */
  failures: readonly string[];
  /** Did this run actually RENDER a verdict? A crash/abort produces no verdict at all
   *  (`green: null`), and "no product failures were observed" is then vacuously true —
   *  which would promote a candidate nothing ever judged. Passing `false` here refuses,
   *  so that reading can never be reached through this function. */
  verdictRendered: boolean;
  ctx: HygieneClassificationContext;
}

/** The filing-identity prefix. Lives HERE, in the module with no imports, because both
 *  draft producers need it and the dependency chain runs gate-hygiene-filing →
 *  gate-auto-repair → gate-hygiene-split. Defining it in the filing module and importing
 *  it back would close that chain into a cycle; duplicating the literal in both would put
 *  a second copy of a convention in the tree, which is the drift this repo's derived-truth
 *  rule exists to prevent. One definition, at the base. */
const KEY_PREFIX = "gate-hygiene-unrepaired";

/**
 * Stable filing identity, keyed on the ENTRY alone — never on the verdict, and never on
 * which pass observed it. A re-run that produces a different verdict for the same failing
 * checker must REFRESH the same item, not open a sibling.
 *
 * Deliberately SHARED between the gate's promotion drafts and the repair pass's filings:
 * "gen:contract:check is failing" is ONE condition, whether the gate promoted past it or
 * the repair pass could not fix it. Keying those separately would open two items for one
 * broken checker and split its history exactly when someone is trying to read it.
 */
export function filingConditionKey(entry: string): string {
  return `${KEY_PREFIX}:${entry}`;
}

export interface HygieneWorkItemDraft {
  title: string;
  category: HygieneCategory;
  remedy: string;
  entry: string;
  /**
   * Refresh-not-duplicate identity for `work_items:create { conditionKey }`.
   *
   * REQUIRED, not optional, and that is the point. The gate PUBLISHES these drafts and a
   * caller with harness context files them — green-checkpoint.ts runs live from the staging
   * tree for every co-hosted install, so it must never file work items itself (see
   * scripts/repair-stale-generated-artifacts.ts, which states the same boundary). Without a
   * key, a correct external consumer opens a NEW item on every gate run. A hygiene check
   * stays failing across many runs by definition — that is what makes it hygiene rather
   * than a flake — so an unkeyed draft duplicates hardest in exactly the case it matters.
   */
  conditionKey: string;
}

export interface PromotionDecision {
  promote: boolean;
  reason: string;
  productFailures: ClassifiedGateFailure[];
  hygieneFailures: ClassifiedGateFailure[];
  /** Drafts for the caller to file. Populated whenever hygiene failures exist —
   *  including when promotion is BLOCKED by a product failure, because the hygiene
   *  debt is real either way and dropping it is how a split quietly becomes a
   *  suppression. */
  hygieneWorkItems: HygieneWorkItemDraft[];
}

export function decidePromotion(input: PromotionInput): PromotionDecision {
  const { failures, verdictRendered, ctx } = input;

  const classified = (failures ?? []).map((f) => classifyGateFailure(f, ctx));
  const productFailures = classified.filter((c) => c.klass === "product");
  const hygieneFailures = classified.filter((c) => c.klass === "hygiene");

  const hygieneWorkItems: HygieneWorkItemDraft[] = hygieneFailures.map((h) => ({
    title: `Gate hygiene: ${h.entry} is failing`,
    category: h.category ?? "generated-artifact-stale",
    remedy: h.remedy ?? "",
    entry: h.entry,
    conditionKey: filingConditionKey(h.entry),
  }));

  if (!verdictRendered) {
    return {
      promote: false,
      reason:
        "No verdict was rendered by this run, so there is nothing to promote. An empty " +
        "product-failure list here means 'nothing was measured', not 'nothing failed'.",
      productFailures,
      hygieneFailures,
      hygieneWorkItems,
    };
  }

  if (productFailures.length > 0) {
    return {
      promote: false,
      reason:
        `${productFailures.length} product-correctness failure(s) hold the gate: ` +
        productFailures.map((p) => p.entry).join(", "),
      productFailures,
      hygieneFailures,
      hygieneWorkItems,
    };
  }

  if (hygieneFailures.length > 0) {
    return {
      promote: true,
      reason:
        `Promoting: every failure is hygiene (${hygieneFailures
          .map((h) => h.entry)
          .join(", ")}). ${hygieneWorkItems.length} work item(s) to file. ` +
        `No product-correctness test failed.`,
      productFailures,
      hygieneFailures,
      hygieneWorkItems,
    };
  }

  return {
    promote: true,
    reason: "Promoting: the run rendered a verdict and nothing failed.",
    productFailures,
    hygieneFailures,
    hygieneWorkItems,
  };
}
