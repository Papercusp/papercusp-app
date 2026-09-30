/**
 * Static contract checks for the hermetic `su` scenarios.
 *
 * The generic scenario linter validates framework shape, but it cannot know
 * whether a scenario's own guidance, fixtures, and scripted tool paths agree
 * with the curated SU catalog. These checks run without an LLM or operator
 * connection and fail before a scenario can be used as behavioral evidence.
 */

import {
  PASS_THROUGH,
  type LintViolation,
  type Scenario,
  type ToolResult,
} from '@papercusp/testing-shell/llm';

import { SU_CATALOG, type SuCatalogEntry } from './su-catalog';

const S11_ID = 'su-S11-lock-contention-protocol';
const S19_ID = 'su-S19-overview-state-of-x';
const S20_ID = 'su-S20-overview-not-for-single';

const S11_PROTOCOL_TOOLS = [
  'locks:acquire',
  'locks:queue',
  'coord:send',
  'coord:handoff',
] as const;

interface JsonRecord {
  [key: string]: unknown;
}

export interface SuContractOptions {
  catalog?: readonly SuCatalogEntry[];
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scenarioById(scenarios: readonly Scenario[], id: string): Scenario | undefined {
  return scenarios.find((scenario) => scenario.id === id);
}

function catalogByName(
  catalog: readonly SuCatalogEntry[],
  name: string,
): SuCatalogEntry | undefined {
  return catalog.find((entry) => entry.name === name);
}

function addViolation(
  violations: LintViolation[],
  scenarioId: string,
  field: string,
  message: string,
): void {
  violations.push({ scenarioId, field, severity: 'error', message });
}

function requireFragment(
  violations: LintViolation[],
  scenarioId: string,
  field: string,
  text: string,
  fragment: RegExp,
  label: string,
): void {
  if (!fragment.test(text)) {
    addViolation(
      violations,
      scenarioId,
      field,
      `must retain the ${label} guidance fragment (${fragment})`,
    );
  }
}

function validateGuidanceBoundaries(
  scenarios: readonly Scenario[],
  catalog: readonly SuCatalogEntry[],
  violations: LintViolation[],
): void {
  const overview = catalogByName(catalog, 'harness:overview');
  const status = catalogByName(catalog, 'harness:status');
  const s19 = scenarioById(scenarios, S19_ID);
  const s20 = scenarioById(scenarios, S20_ID);

  if (!overview) {
    addViolation(
      violations,
      S19_ID,
      'catalog.harness:overview',
      'the SU catalog must expose harness:overview for the compound state-of-X scenario',
    );
  } else {
    const description = overview.description;
    requireFragment(violations, S19_ID, 'catalog.harness:overview.description', description, /\bcompound\b/i, 'compound-read');
    requireFragment(
      violations,
      S19_ID,
      'catalog.harness:overview.description',
      description,
      /multi-part\/full-picture/i,
      'multi-part/full-picture',
    );
    requireFragment(
      violations,
      S19_ID,
      'catalog.harness:overview.description',
      description,
      /single fact/i,
      'single-fact boundary',
    );
    requireFragment(
      violations,
      S19_ID,
      'catalog.harness:overview.description',
      description,
      /direct harness:status call/i,
      'direct harness:status route',
    );
    requireFragment(
      violations,
      S19_ID,
      'catalog.harness:overview.description',
      description,
      /not (?:this )?wrapper/i,
      'negative wrapper boundary',
    );
  }

  if (status && /harness:overview|multi-part\/full-picture|\bcompound\b/i.test(status.description)) {
    addViolation(
      violations,
      S20_ID,
      'catalog.harness:status.description',
      'the single-fact status tool must not advertise the compound harness:overview wrapper',
    );
  }

  if (s19) {
    requireFragment(violations, S19_ID, 'description', s19.description, /compound/i, 'compound request');
    requireFragment(
      violations,
      S19_ID,
      'description',
      s19.description,
      /harness:overview/i,
      'harness:overview selection',
    );
    requireFragment(
      violations,
      S19_ID,
      'description',
      s19.description,
      /bounded cross-cutting open-issues snapshot/i,
      'bounded issues payload',
    );
  }

  if (s20) {
    requireFragment(violations, S20_ID, 'description', s20.description, /single-fact/i, 'single-fact request');
    requireFragment(
      violations,
      S20_ID,
      'description',
      s20.description,
      /harness:status/i,
      'direct status selection',
    );
    requireFragment(
      violations,
      S20_ID,
      'description',
      s20.description,
      /harness:overview/i,
      'over-application contrast',
    );
  }
}

async function validateOverviewFixture(
  scenario: Scenario,
  violations: LintViolation[],
): Promise<void> {
  const override = scenario.toolOverride;
  if (!override) {
    addViolation(
      violations,
      scenario.id,
      'toolOverride',
      'SU-S19 must provide a hermetic harness:overview fixture',
    );
    return;
  }

  let result: ToolResult | typeof PASS_THROUGH;
  try {
    result = await override.override('harness:overview', { harness: 'sheets' });
  } catch (error) {
    addViolation(
      violations,
      scenario.id,
      'toolOverride',
      `harness:overview fixture threw while being validated: ${String(error)}`,
    );
    return;
  }

  if (result === PASS_THROUGH) {
    addViolation(
      violations,
      scenario.id,
      'toolOverride',
      'harness:overview must resolve to a fixture result rather than PASS_THROUGH',
    );
    return;
  }

  const text = result.content?.[0]?.text;
  if (typeof text !== 'string' || !text.trim()) {
    addViolation(
      violations,
      scenario.id,
      'toolOverride.content[0].text',
      'harness:overview fixture must expose a JSON text payload',
    );
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    addViolation(
      violations,
      scenario.id,
      'toolOverride.content[0].text',
      `harness:overview fixture text is not valid JSON: ${String(error)}`,
    );
    return;
  }

  const issues = isRecord(payload) && isRecord(payload.issues) ? payload.issues : undefined;
  const count = issues?.count;
  const recent = issues?.recent;
  if (!Number.isInteger(count) || (count as number) < 0) {
    addViolation(
      violations,
      scenario.id,
      'fixture.issues.count',
      'harness:overview fixture issues.count must be a non-negative integer',
    );
  }
  if (!Array.isArray(recent)) {
    addViolation(
      violations,
      scenario.id,
      'fixture.issues.recent',
      'harness:overview fixture issues.recent must be an array',
    );
    return;
  }
  if (Number.isInteger(count) && count !== recent.length) {
    addViolation(
      violations,
      scenario.id,
      'fixture.issues.count',
      `issues.count=${String(count)} does not match issues.recent.length=${recent.length}`,
    );
  }

  const ids = new Set<string>();
  recent.forEach((row, index) => {
    if (!isRecord(row) || typeof row.id !== 'string' || !row.id.trim()) {
      addViolation(
        violations,
        scenario.id,
        `fixture.issues.recent[${index}].id`,
        'each bounded issue row must have a non-empty string id',
      );
      return;
    }
    if (ids.has(row.id)) {
      addViolation(
        violations,
        scenario.id,
        `fixture.issues.recent[${index}].id`,
        `duplicate issue id '${row.id}' in the bounded snapshot`,
      );
    }
    ids.add(row.id);
    if (typeof row.state !== 'string' || !row.state.trim()) {
      addViolation(
        violations,
        scenario.id,
        `fixture.issues.recent[${index}].state`,
        'each bounded issue row must have a non-empty string state',
      );
    }
  });
}

function validateS11Reachability(
  scenario: Scenario,
  catalog: readonly SuCatalogEntry[],
  violations: LintViolation[],
): void {
  const trigger = scenario.triggers?.find(
    (candidate) =>
      candidate.on === 'after_turn' &&
      candidate.param === 0 &&
      candidate.fire === 'user_message',
  );
  if (!trigger || typeof trigger.text !== 'string' || !trigger.text.includes('PreToolUse:Edit hook denied the edit.')) {
    addViolation(
      violations,
      scenario.id,
      'triggers',
      'SU-S11 must script the exact native Edit lock-denial result before judging the protocol response',
    );
  }

  const names = new Set(catalog.map((entry) => entry.name));
  for (const toolName of S11_PROTOCOL_TOOLS) {
    if (!names.has(toolName)) {
      addViolation(
        violations,
        scenario.id,
        `catalog.${toolName}`,
        `SU-S11 scripted lock protocol cannot reach ${toolName}; add the real tool to SU_CATALOG`,
      );
    }
  }

  const customNames = new Set(
    scenario.asserts
      .filter((assertion) => assertion.kind === 'custom')
      .map((assertion) => assertion.name),
  );
  if (!customNames.has('protocol-response-after-denied-lock')) {
    addViolation(
      violations,
      scenario.id,
      'asserts',
      'SU-S11 must retain the causal protocol-response-after-denied-lock assert',
    );
  }
}

/**
 * Validate the SU-specific contract surfaces selected for an `llm-test lint`
 * run. The function is async because hermetic tool overrides may return a
 * Promise, but it performs no model calls or operator I/O.
 */
export async function validateSuContracts(
  scenarios: readonly Scenario[],
  options: SuContractOptions = {},
): Promise<LintViolation[]> {
  const suScenarios = scenarios.filter((scenario) => scenario.target === 'su');
  if (suScenarios.length === 0) return [];

  const violations: LintViolation[] = [];
  const catalog = options.catalog ?? SU_CATALOG;
  validateGuidanceBoundaries(suScenarios, catalog, violations);

  const s19 = scenarioById(suScenarios, S19_ID);
  if (s19) await validateOverviewFixture(s19, violations);

  const s11 = scenarioById(suScenarios, S11_ID);
  if (s11) validateS11Reachability(s11, catalog, violations);

  return violations;
}

/** Alias matching the CLI's generic lint terminology. */
export const lintSuScenarioContracts = validateSuContracts;
