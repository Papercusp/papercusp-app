/**
 * Hand-written declarations for `scripts/lib/terminal-counter-fields.mjs`.
 *
 * The runtime module is plain ESM JavaScript on purpose — it renders the terminal
 * AFFECTED_TESTS_RESULT line from the affected-tests CRASH path, which must not depend
 * on a build step. operator-core TypeScript imports it directly, so without this sibling
 * declaration the import degrades to `any` and `lint:tsc` fails the importing file with
 * TS7016 under `noImplicitAny` — which is a GATE failure, because the green-checkpoint
 * runs a candidate-scoped `lint:tsc --files` preflight before the suite (WI-38422).
 *
 * Shapes below mirror the module's own JSDoc contract; keep them in step with it.
 */

/**
 * The counters a terminal AFFECTED_TESTS_RESULT line reports.
 *
 * Every field is optional, and that is load-bearing rather than lazy typing: this runs on
 * the abort path, where a counter may legitimately not exist yet (an abort before the run
 * loop reads the pre-upgrade closure).
 */
export interface TerminalCounterInput {
  failed?: number;
  observedNonzeroExits?: number;
  observedAdmissionErrors?: number;
}

/** The rendered trailing fields, plus the undercount verdict they carry. */
export interface TerminalCounterFields {
  /** The trailing `key=value` text, appended so the existing prefix stays byte-identical. */
  text: string;
  /**
   * True when something was OBSERVED exiting nonzero while the tally still says nothing
   * failed — i.e. the verdict is understating the damage.
   */
  undercount: boolean;
}

export function formatTerminalCounterFields(
  counters?: TerminalCounterInput,
): TerminalCounterFields;

export interface RefusalCounterInput extends TerminalCounterInput {
  tasks?: number;
  completedTasks?: number;
  quarantinedFailed?: number;
  timedOutTasks?: number;
  undeterminedTasks?: number;
}

/** Refusal fields preserve completed initial outcomes and untallied observations. */
export function formatRefusalCounterFields(counters?: RefusalCounterInput): string;
