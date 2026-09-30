/** Unified authoring over the existing criterion fields. No second persisted BAR. */
import type { RubricCriterionCheck } from './agent-tools/plans/rubric-template';
import type { ServingRuntimeId } from './serving-runtimes';

export interface RequirementIntent {
  request: string;
  rationale?: string;
  constraints?: string[];
  sourceRefs?: string[];
}

export interface RequirementAcceptance {
  condition: string;
  falsifier: string;
  requiredScope?: string[];
  evidencePlane?: 'tree' | 'deployed' | 'live';
  /** WHICH runtime a deployed/live promise is measured on (acceptance-runtime-plane P-002). */
  evidenceRuntime?: ServingRuntimeId;
  /** Required depth of outcome proof; changing this changes the promise. */
  requiredTestLayers?: string[];
  passRatings?: string[];
  mandatory?: boolean;
  role?: 'outcome' | 'disclosure';
  coversBarKeys?: string[];
}

export interface RequirementVerification {
  method: string;
  check?: RubricCriterionCheck;
  replication?: string;
}

export interface RequirementSectionInput {
  key: string;
  intent?: RequirementIntent;
  acceptance?: RequirementAcceptance;
  verification?: RequirementVerification;
  model?: string;
  bar?: string;
  driftMarkers?: string;
  requiredScope?: string[];
  evidencePlane?: 'tree' | 'deployed' | 'live';
  evidenceRuntime?: ServingRuntimeId;
  requiredTestLayers?: string[];
  passRatings?: string[];
  mandatory?: boolean;
  role?: 'outcome' | 'disclosure';
  coversBarKeys?: string[];
  method?: string;
  check?: RubricCriterionCheck;
  replication?: string;
}

function comparable(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/\r\n?/g, '\n').trim();
  if (Array.isArray(value)) return value.map(comparable).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, comparable(v)]),
  );
  return value;
}

/** The wire sections are aliases. Conflicts refuse; persistence receives only
 * model/driftMarkers/method/check and the original Intent metadata. */
export function normalizeRequirementSections<T extends RequirementSectionInput>(input: T):
  Omit<T, 'acceptance' | 'verification'> & Omit<RequirementSectionInput, 'acceptance' | 'verification'> {
  const { acceptance, verification, ...canonical } = input;
  const result: Omit<RequirementSectionInput, 'acceptance' | 'verification'> = { ...canonical };
  const assign = <K extends keyof RequirementSectionInput>(key: K, value: RequirementSectionInput[K]) => {
    if (value === undefined) return;
    const prior = input[key];
    if (prior !== undefined && JSON.stringify(comparable(prior)) !== JSON.stringify(comparable(value))) {
      throw new Error(`requirement_alias_conflict: '${input.key}' supplies conflicting ${key} and requirement section values`);
    }
    Object.assign(result, { [key]: value });
  };
  if (acceptance) {
    if (input.bar !== undefined && comparable(input.bar) !== comparable(acceptance.condition)) {
      throw new Error(`requirement_alias_conflict: '${input.key}' supplies conflicting bar and acceptance.condition`);
    }
    assign('model', acceptance.condition);
    assign('driftMarkers', acceptance.falsifier);
    for (const key of ['requiredScope', 'evidencePlane', 'evidenceRuntime', 'requiredTestLayers', 'passRatings', 'mandatory', 'role', 'coversBarKeys'] as const) {
      assign(key, acceptance[key]);
    }
  }
  if (verification) {
    assign('method', verification.method);
    assign('check', verification.check);
    assign('replication', verification.replication);
  }
  return { ...canonical, ...result };
}

/** Read projection only. Missing legacy Intent stays missing, never inferred. */
export function requirementSections(input: RequirementSectionInput) {
  return {
    intent: input.intent ?? null,
    acceptance: {
      condition: input.model ?? input.bar ?? '',
      falsifier: input.driftMarkers ?? '',
      requiredScope: input.requiredScope ?? [],
      evidencePlane: input.evidencePlane ?? null,
      evidenceRuntime: input.evidenceRuntime ?? null,
      requiredTestLayers: input.requiredTestLayers ?? [],
      passRatings: input.passRatings ?? [],
      mandatory: input.mandatory ?? null,
      role: input.role ?? null,
      coversBarKeys: input.coversBarKeys ?? [],
    },
    verification: {
      method: input.method ?? '',
      check: input.check ?? null,
      replication: input.replication ?? null,
    },
  };
}
