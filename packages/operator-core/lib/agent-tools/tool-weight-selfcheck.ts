/**
 * tool-weight-selfcheck — EI-10966: warn, at catalog-registration time, when any
 * tool is over the prompt-weight budget. Imported LAST in the agent-tools barrel
 * so every tool has already registered; the live operator (a hot-reloading dev
 * server) re-runs it on every edit to a tool file, so an over-budget guidance
 * edit surfaces in the operator's own logs the moment it is saved — NOT hours
 * later when it reds the fleet-blocking green gate.
 *
 * TIERED by severity (EI-18685386548651513 — the class fix for "3 breaches in one
 * night"): a BUDGET-only breach stays a log-only warn (nobody but the editing agent
 * is affected yet). A HARD-CAP breach is different — it is a GUARANTEED green-gate
 * red the moment that candidate is judged — so it ALSO escalates into the work
 * queue via `captureImprovement` (deduped per-tool by `watchdogKey`, so a
 * hot-reloading dev server re-running this on every save can't spam). That routes
 * it to an agent within minutes of the save instead of hours later via a stale
 * checkpoint log, which is what let two agents independently discover + fix the
 * same two breaches within ~10 minutes of each other, unaware of one another.
 *
 * Gated `!process.env.VITEST`: the dedicated gate test
 * (`packages/operator-core/lib/__tests__/tool-guidance-budget.test.ts`) asserts this
 * deliberately, and `vitest-fail-on-console` would otherwise turn a
 * warn here into a failure of every UNRELATED suite that imports the catalog,
 * re-creating the very "one edit reds everyone" blast radius this fix exists to
 * shrink. In the operator process (no vitest) it is a plain, visible log line.
 *
 * Fail-soft: a bug in the check — or a failed escalation capture — must never
 * block operator boot (mirrors every other side-effect block in index.ts).
 */
import { BUDGET, budgetViolations, formatViolations, HARD_CAP, type BudgetViolation } from './tool-guidance-budget';

/**
 * Escalate ONE hard-cap breach into the work queue. Injectable (mirrors the
 * `CaptureDeps` pattern in capture-core.ts) so the tiering logic is unit-testable
 * without PG; the real implementation dynamically imports `captureImprovement` —
 * this boot-time module stays cheap to load when there is nothing to escalate,
 * and matches the fire-and-forget dynamic-import pattern every other watchdog
 * uses to reach the capture core (e.g. autoloop-chronic-failure.ts).
 */
export type EscalateHardCapFn = (violation: BudgetViolation) => Promise<void>;

export async function defaultEscalateHardCap(v: BudgetViolation): Promise<void> {
  const watchdogKey = `tool-weight-hard-cap:${v.name}`;
  // EI-18689219855601091: an authoritative pre-filter BEFORE planning a capture —
  // mirrors every other watchdog caller of `findIssuesByWatchdogKeys` (per its own
  // doc comment: "pre-filters signals against this BEFORE planning captures, so a
  // standing already-filed signal never consumes the per-tick capture budget").
  // This watchdog skipped that step and relied entirely on captureImprovement's
  // own lexical/semantic search-first dedup over `input.title` — which is racy (two
  // near-simultaneous hot-reloads can both search-and-miss before either commits)
  // and not a guaranteed hit even outside the race window. Root-caused 3 duplicate
  // rows filed for the SAME watchdogKey in one evening (11ms apart, then again 3min
  // later). This exact indexed lookup is the reliable check; it does not fully close
  // the sub-millisecond TOCTOU race (no DB-level unique constraint), but it is the
  // established pattern for this class of watchdog and removes the dominant cause.
  const { findIssuesByWatchdogKeys } = await import('../issues-engineer');
  const existing = await findIssuesByWatchdogKeys([watchdogKey]).catch(() => []);
  if (existing.some((i) => i.state === 'open')) return;

  const { captureImprovement } = await import('../harness/improvements/capture-core');
  await captureImprovement({
    // Deliberately STABLE (no weight/cutAtLeast numbers) — those live in the body.
    // The search-first dedup declines a create when the title is lexically similar
    // AND the watchdogKey is compatible, so a stable title is what makes re-running
    // this on every hot-reload coalesce onto one open row instead of spamming.
    title: `Tool "${v.name}" is over the prompt-weight HARD CAP`,
    kind: 'bug',
    severity: 'major',
    scope: 'operator',
    foundDuring: 'tool-weight-selfcheck (catalog registration)',
    createdBy: 'system:tool-weight-selfcheck',
    sourceRole: 'system',
    source: 'su',
    dedupScope: 'open',
    watchdogKey,
    paths: [
      'packages/operator-core/lib/agent-tools/tool-guidance-budget.ts',
      'packages/operator-core/lib/agent-tools/tool-weight-selfcheck.ts',
    ],
    body:
      `${v.name} weighs ${v.weight} chars (description + all guidance fields) — ` +
      `${v.weight - HARD_CAP} over the ${HARD_CAP}-char HARD CAP; cut at least ${v.cutAtLeast} ` +
      `chars to clear the ${v.grandfathered ? `${HARD_CAP}-char HARD CAP` : `${BUDGET}-char budget`}. ` +
      `This GUARANTEES a green-checkpoint ` +
      `red the moment a candidate touching it is judged (P-011), which freezes deploys ` +
      `fleet-wide until triaged. Trim the guidance — prefer a docs pointer over prose-in-place ` +
      `— before the next checkpoint. (Filed automatically at catalog-registration time; re-runs ` +
      `on every hot-reload coalesce onto this same item via watchdogKey until it's fixed.)`,
  });
}

/**
 * The tiering logic itself, split out from `runToolWeightSelfCheck` so it is
 * directly unit-testable without toggling `process.env.VITEST` or touching the
 * live tool catalog. Always logs the full violation list; additionally escalates
 * every HARD-CAP violation (fire-and-forget, never throws — a failed capture
 * degrades to "log-only", the pre-existing behavior, never to a boot failure).
 */
export function reportViolations(violations: readonly BudgetViolation[], escalate: EscalateHardCapFn = defaultEscalateHardCap): void {
  if (violations.length === 0) return;
  const hardCapViolations = violations.filter((v) => v.hardCap);
  // eslint-disable-next-line no-console -- intentional operator-log signal; suppressed under vitest by the caller
  console.warn(
    `[tool-weight] ${violations.length} tool(s) over the prompt-weight budget` +
      (hardCapViolations.length > 0 ? ` (${hardCapViolations.length} over the HARD CAP — these RED the green gate)` : '') +
      ` — trim before the next green checkpoint or deploys freeze fleet-wide (EI-10966):\n` +
      formatViolations(violations),
  );
  for (const v of hardCapViolations) {
    escalate(v).catch((e: unknown) => {
      // eslint-disable-next-line no-console -- fail-soft signal; the warn above already fired
      console.warn(`[tool-weight] escalation capture failed for ${v.name} (non-fatal, log-only until fixed): ${e instanceof Error ? e.message : e}`);
    });
  }
}

export function runToolWeightSelfCheck(): void {
  if (process.env.VITEST) return;
  const violations = budgetViolations();
  reportViolations(violations);
}

try {
  runToolWeightSelfCheck();
} catch {
  /* never block boot */
}
