/**
 * Shift-left BAR contract completeness (review-system-rework-reduction-2026-09-23
 * P-003, which absorbed P-029).
 *
 * WHY this exists. A BAR's METHOD, structured `check` and `requiredTestLayers`
 * used to be checked only at the vetting/grading/ship doors, i.e. AFTER proof had
 * been bound. `check` and `requiredTestLayers` are barHash inputs, so supplying
 * them late re-revisions every projected clause and throws the bound proof away:
 * measured as whole extra proof cycles in
 * docs/evidence/review-system-time-audit-2026-09-23.md (improvements 2 and 19).
 * Of 236 BARs on `ready` plans on 2026-09-23, 145 had no METHOD, 146 no check and
 * 187 no test layers — every one of them a late amendment waiting to happen.
 *
 * This module is the ONE definition of "the contract is complete enough to start
 * proving against". It is pure so the two doors that enforce it (the activation
 * seed and `plans:start`) and the activation dry-run preview cannot drift apart.
 *
 * What it deliberately does NOT do: decide whether a BAR owes automated proof.
 * That predicate already has exactly one owner per shape (the seed derives it from
 * the criterion; the snapshot from its projection), and the caller passes the
 * verdict in. A second copy here would be a fourth definition of "manual".
 */
import { RECORDED_TEST_LAYERS, type RecordedTestLayer } from '@papercusp/test-config/execution-details';
import type { RubricCriterionCheck } from './agent-tools/plans/rubric-template';

export type AcceptanceBarContractGap =
  | 'method_missing'
  | 'check_missing'
  | 'test_layers_missing'
  | 'test_layer_unrecordable'
  | 'check_layer_mismatch';

export interface AcceptanceBarContractGapInput {
  role: string | null | undefined;
  method: string | null | undefined;
  check: RubricCriterionCheck | null | undefined;
  requiredTestLayers: readonly string[] | null | undefined;
  /** The caller's canonical "does this BAR owe automated proof" verdict. */
  automatedProofRequired: boolean;
}

export interface AcceptanceBarContractGapFinding {
  gap: AcceptanceBarContractGap;
  detail: string;
}

/** Layers a check file's NAME can prove. Mirrors the repo's test taxonomy: the unit
 * Vitest config excludes `*.integration.test.*` / `*.browser.test.*`
 * (libs/test-config/src/vitest-config.ts), e2e is Playwright under `e2e/` or a
 * `*.spec.*`, and LLM scenarios live under `llm-testing/`. */
// ONE taxonomy with the ledger recorder (EI-24434635346407728): a BAR may only require a
// layer that a test_runs row can record, so this is the recorder's type, not a copy of it.
export type CheckFileTestLayer = RecordedTestLayer;

/** The only layers a BAR may require. spec-test-adequacy's correct-layer passes a layer
 * only when a bound evidence row RECORDS it, and binding refuses any testLayer outside
 * RECORDED_TEST_LAYERS, so a declared layer outside this set (e.g. `component`,
 * `mutation`, `live`) is unsatisfiable and is reported as `test_layer_unrecordable`
 * (WI-10006536). Before, such layers were silently skipped here, passed authoring, and
 * failed correct-layer forever at grading. */
const JUDGED_LAYERS: ReadonlySet<string> = new Set<CheckFileTestLayer>(RECORDED_TEST_LAYERS);

const SCRIPT_EXT = '[cm]?[jt]sx?';

export function normalizedTestLayer(value: string): string {
  return value.trim().toLowerCase().replaceAll('_', '-');
}

/**
 * The layer(s) a check file can satisfy, judged from its path alone; `null` when the
 * path does not look like a test at all (then no mismatch can be claimed for the BAR).
 */
export function checkFileTestLayers(path: string): ReadonlySet<CheckFileTestLayer> | null {
  const p = path.trim().replaceAll('\\', '/').toLowerCase();
  const layers = new Set<CheckFileTestLayer>();
  if (new RegExp(`\\.integration\\.test\\.${SCRIPT_EXT}$`).test(p)) layers.add('integration');
  else if (new RegExp(`\\.browser\\.test\\.${SCRIPT_EXT}$`).test(p)) layers.add('browser');
  else if (
    /(^|\/)e2e\//.test(p) ||
    new RegExp(`\\.e2e\\.test\\.${SCRIPT_EXT}$`).test(p) ||
    new RegExp(`\\.spec\\.${SCRIPT_EXT}$`).test(p)
  )
    layers.add('e2e');
  else if (new RegExp(`\\.test\\.${SCRIPT_EXT}$`).test(p)) layers.add('unit');
  if (/(^|\/)llm-testing\//.test(p) || new RegExp(`\\.llm\\.test\\.${SCRIPT_EXT}$`).test(p)) layers.add('llm');
  return layers.size > 0 ? layers : null;
}

/** `{ kind:'instrument', instrumentKey:'none' }` — the author's explicit manual contract. */
export function isExplicitlyManualCheck(check: RubricCriterionCheck | null | undefined): boolean {
  return check?.kind === 'instrument' && check.instrumentKey.trim().toLowerCase() === 'none';
}

/**
 * Every completeness gap in one BAR's contract. Empty ⇒ the contract is complete
 * enough to bind proof against without a later barHash-changing amendment.
 */
export function acceptanceBarContractGaps(input: AcceptanceBarContractGapInput): AcceptanceBarContractGapFinding[] {
  const findings: AcceptanceBarContractGapFinding[] = [];
  const layers = [...new Set((input.requiredTestLayers ?? []).map(normalizedTestLayer).filter(Boolean))];

  if (!input.method?.trim()) {
    findings.push({
      gap: 'method_missing',
      detail: 'METHOD is empty: state how a grader investigates this BAR (signals, queries, commands)',
    });
  }
  if (!input.check) {
    findings.push({
      gap: 'check_missing',
      detail:
        "no structured check: give a runnable check (kind 'tests' {files}, 'cargo', 'instrument', 'probe', " +
        "'coverage' or 'requirements'), or declare it explicitly manual with {kind:'instrument', instrumentKey:'none'}",
    });
  }
  if (input.role === 'outcome' && input.automatedProofRequired && layers.length === 0) {
    findings.push({
      gap: 'test_layers_missing',
      detail:
        'the BAR owes automated proof but declares no requiredTestLayers: name the layer(s) its proof must be bound ' +
        "at (unit, integration, e2e, ...), or declare the check explicitly manual (instrumentKey:'none')",
    });
  }
  const unrecordable = layers.filter((layer) => !JUDGED_LAYERS.has(layer));
  if (unrecordable.length > 0) {
    findings.push({
      gap: 'test_layer_unrecordable',
      detail:
        `requiredTestLayers declares ${unrecordable.join(', ')}, which the test-run ledger never records ` +
        `(recorded layers: ${[...RECORDED_TEST_LAYERS].join(', ')}), so correct-layer can never pass: ` +
        'name the recorded layer the proof actually runs at (a *.component.test.tsx or mutation-probe run ' +
        "records as unit/integration); a live or deployed observation belongs in requiredEvidence, not requiredTestLayers",
    });
  }

  if (isExplicitlyManualCheck(input.check) && layers.length > 0) {
    findings.push({
      gap: 'check_layer_mismatch',
      detail:
        `the check is explicitly manual (instrumentKey:'none') yet requiredTestLayers declares ${layers.join(', ')}; ` +
        'a BAR cannot be both: omit the `requiredTestLayers` field (a manual BAR) or give it a runnable check',
    });
  } else if (input.check?.kind === 'tests' && layers.length > 0) {
    const classified = input.check.files.map((file) => ({ file, layers: checkFileTestLayers(file) }));
    // One unclassifiable file could be the proof for any layer: claim nothing.
    if (classified.every((entry) => entry.layers !== null)) {
      const uncovered = layers.filter(
        (layer) =>
          JUDGED_LAYERS.has(layer) &&
          !classified.some((entry) => entry.layers!.has(layer as CheckFileTestLayer)),
      );
      if (uncovered.length > 0) {
        findings.push({
          gap: 'check_layer_mismatch',
          detail:
            `requiredTestLayers declares ${uncovered.join(', ')} but no check.files entry is a test at that layer ` +
            `(${classified.map((entry) => `${entry.file} is ${[...entry.layers!].join('/')}`).join('; ')}): ` +
            'name a check file at every declared layer, or correct the declared layers',
        });
      }
    }
  }
  return findings;
}

/** Copy-pasteable authoring shape for a BAR whose contract is complete at activation. */
export const ACCEPTANCE_BAR_REQUIREMENT_BLOCK_TEMPLATE =
  '**R-N — Title.**\n```requirement\n' +
  JSON.stringify({
    intent: { request: '<what was asked>' },
    acceptance: {
      condition: '<one observable outcome>',
      falsifier: '<the observation that proves it false>',
      requiredTestLayers: ['unit'],
    },
    verification: {
      method: '<how a grader investigates it>',
      check: { kind: 'tests', files: ['<path/to/proof.test.ts>'] },
    },
  }) +
  '\n```';
