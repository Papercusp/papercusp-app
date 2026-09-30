/**
 * Static scenario linter.
 *
 * Walks a Scenario (or the full registry) and validates everything the
 * type system cannot enforce at registration time — assert kinds against
 * the live union, persona blend ids against the live blend list, trigger
 * values against the TurnTrigger enum, scripted-trigger param vs. caps,
 * fixture paths against disk, etc.
 *
 * Several "ALL_*" maps below are typed `Record<UnionMember, true>` so
 * that adding a new value to the corresponding type union becomes a
 * compile error here — the lint can't silently lag the schema.
 *
 * Catches the kind of authoring drift that the framework's audit rounds
 * found one-at-a-time during build-out (see operator-behavior-tests
 * plan v3 §A audit, items B6 / B14 / B15).
 *
 * Decoupled: the host's registered-target list is injected via
 * `LintOpts.registeredTargets` (the operator passes `listTargets()`).
 * When omitted, the target-registration check is skipped — the lib owns
 * no target registry.
 */

import type {
  DeterministicAssert,
  GoalSpec,
  PersonaTraits,
  Scenario,
  ScenarioTrigger,
  TurnTrigger,
} from './types';
import { lookupBlend } from './personas/blends';

// =============================================================================
// Exhaustive enum maps (compile-error on union drift)
// =============================================================================

const ALL_TRIGGERS: Record<TurnTrigger, true> = {
  user_message: true,
  continue: true,
  quiet_wait_resume: true,
  user_says_ready: true,
  user_welcomed: true,
  open_canvas: true,
  silence_nudge: true,
  generate_ideas: true,
};

const ALL_ASSERT_KINDS: Record<DeterministicAssert['kind'], true> = {
  tool_called: true,
  tool_not_called: true,
  text_contains: true,
  text_excludes: true,
  card_emitted: true,
  control_tag_present: true,
  auto_fire_happened: true,
  auto_fire_did_not_happen: true,
  continue_chain_within_cap: true,
  latency_under: true,
  cost_under: true,
  mem0_wrote: true,
  mem0_read: true,
  spawn_dispatched: true,
  finish_reason_is: true,
  custom: true,
};

const ALL_GOAL_KINDS: Record<GoalSpec['kind'], true> = {
  user_satisfied: true,
  tool_fired: true,
  card_emitted: true,
  state_reached: true,
};

const ALL_TRIGGER_ONS: Record<ScenarioTrigger['on'], true> = {
  silence: true,
  after_turn: true,
  at_secs: true,
};

const ALL_VARIANCE_POLICIES = ['flag-if-stddev>0.5', 'flag-if-disagreement', 'none'] as const;
const ALL_TRANSPORTS = ['in-process', 'http-sse'] as const;
const ALL_CRITICALITY = ['normal', 'high'] as const;

const TRAIT_ENUMS: Record<keyof Omit<PersonaTraits, 'interrupts' | 'domain'>, readonly string[]> = {
  verbosity: ['terse', 'normal', 'verbose'],
  politeness: ['rude', 'neutral', 'polite'],
  clarification: ['never_clarifies', 'sometimes', 'always'],
  goalClarity: ['precise', 'vague', 'shifting'],
  modality: ['text', 'voice'],
};

// =============================================================================
// Types + entrypoint
// =============================================================================

export interface LintViolation {
  scenarioId: string;
  field: string;
  severity: 'error' | 'warn';
  message: string;
}

export interface LintOpts {
  /** Inject a file-existence check for fixture paths. Tests stub this. */
  fileExists?: (path: string) => boolean;
  /** Repo-root for resolving relative fixture paths. Defaults to cwd. */
  fixtureRoot?: string;
  /**
   * Registered chat-target ids (the host owns the registry). When provided,
   * `scenario.target` must be a member; when omitted, the target-registration
   * check is skipped (the lib names no targets).
   */
  registeredTargets?: readonly string[];
}

export function lintScenarios(scenarios: readonly Scenario[], opts: LintOpts = {}): LintViolation[] {
  const all: LintViolation[] = [];
  const seenIds = new Set<string>();
  for (const s of scenarios) {
    if (s && typeof s.id === 'string' && seenIds.has(s.id)) {
      all.push({
        scenarioId: s.id,
        field: 'id',
        severity: 'error',
        message: `duplicate scenario id in registry`,
      });
    }
    if (s?.id) seenIds.add(s.id);
    all.push(...lintScenario(s, opts));
  }
  return all;
}

export function lintScenario(s: Scenario, opts: LintOpts = {}): LintViolation[] {
  const v: LintViolation[] = [];
  const sid = (s && typeof s.id === 'string' ? s.id : '<unknown>');
  const violation = (field: string, severity: 'error' | 'warn', message: string) =>
    v.push({ scenarioId: sid, field, severity, message });

  if (!s || typeof s !== 'object') {
    return [{ scenarioId: '<invalid>', field: 'scenario', severity: 'error', message: 'scenario must be an object' }];
  }

  // === id, version, target, description ===
  if (typeof s.id !== 'string' || !s.id.trim()) {
    violation('id', 'error', 'id is required (non-empty string)');
  }
  if (typeof s.version !== 'number' || !Number.isInteger(s.version) || s.version < 1) {
    violation('version', 'error', `version must be a positive integer, got ${JSON.stringify(s.version)}`);
  }
  if (typeof s.target !== 'string' || !s.target.trim()) {
    violation('target', 'error', 'target is required (non-empty string)');
  } else if (opts.registeredTargets && !opts.registeredTargets.includes(s.target)) {
    violation(
      'target',
      'error',
      `target '${s.target}' is not registered (registered: ${opts.registeredTargets.join(', ')})`,
    );
  }
  if (typeof s.description !== 'string' || s.description.trim().length < 20) {
    violation(
      'description',
      'warn',
      'description should be a substantive paragraph (≥20 chars) — the judge reads it, and so does the sim-user unless you set simUserContext',
    );
  }

  // === caps ===
  if (!s.caps || typeof s.caps !== 'object') {
    violation('caps', 'error', 'caps is required');
  } else {
    for (const k of ['maxTurns', 'maxWallSecs', 'maxCostUsd'] as const) {
      const val = s.caps[k];
      if (typeof val !== 'number' || !(val > 0) || !Number.isFinite(val)) {
        violation(`caps.${k}`, 'error', `must be a positive finite number, got ${JSON.stringify(val)}`);
      }
    }
  }

  // === goal ===
  if (!s.goal || typeof s.goal !== 'object') {
    violation('goal', 'error', 'goal is required');
  } else if (!(s.goal.kind in ALL_GOAL_KINDS)) {
    violation(
      'goal.kind',
      'error',
      `'${s.goal.kind}' is not a valid GoalSpec.kind; allowed: ${Object.keys(ALL_GOAL_KINDS).join(', ')}`,
    );
  }

  // === persona ===
  if (typeof s.persona === 'string') {
    if (!lookupBlend(s.persona)) {
      violation('persona', 'error', `persona blend '${s.persona}' is not registered`);
    }
  } else if (s.persona && typeof s.persona === 'object') {
    // Could be a full Persona ({id, description, traits}) or inline PersonaTraits.
    const traits = ('traits' in s.persona
      ? (s.persona as { traits: PersonaTraits }).traits
      : (s.persona as PersonaTraits));
    if (!traits || typeof traits !== 'object') {
      violation('persona', 'error', 'persona object must include PersonaTraits (or be a {traits} Persona)');
    } else {
      for (const [k, allowed] of Object.entries(TRAIT_ENUMS)) {
        const val = (traits as unknown as Record<string, unknown>)[k];
        if (val !== undefined && !allowed.includes(String(val))) {
          violation(
            `persona.traits.${k}`,
            'error',
            `'${String(val)}' is not a valid ${k}; allowed: ${allowed.join(', ')}`,
          );
        }
      }
      if (traits.interrupts !== undefined && typeof traits.interrupts !== 'boolean') {
        violation('persona.traits.interrupts', 'error', 'interrupts must be a boolean');
      }
    }
  } else {
    violation('persona', 'error', 'persona is required (blend id, traits, or full Persona)');
  }

  // === rubric ===
  if (!s.rubric || typeof s.rubric !== 'object') {
    violation('rubric', 'error', 'rubric is required');
  } else {
    if (typeof s.rubric.version !== 'string' || !s.rubric.version.trim()) {
      violation('rubric.version', 'error', 'rubric.version is required (semver string)');
    }
    if (!Array.isArray(s.rubric.axes) || s.rubric.axes.length === 0) {
      violation('rubric.axes', 'error', 'rubric must declare at least one axis');
    } else {
      const seenAxisIds = new Set<string>();
      s.rubric.axes.forEach((a, i) => {
        if (typeof a?.id !== 'string' || !a.id.trim()) {
          violation(`rubric.axes[${i}].id`, 'error', 'axis id is required');
        } else {
          if (seenAxisIds.has(a.id)) {
            violation(`rubric.axes[${i}].id`, 'error', `duplicate axis id '${a.id}'`);
          }
          seenAxisIds.add(a.id);
        }
        if (!a?.anchors || !a.anchors.bad || !a.anchors.ideal) {
          violation(
            `rubric.axes[${i}].anchors`,
            'warn',
            'axis should declare both bad and ideal anchors (judges read them)',
          );
        }
      });
    }
    if (s.rubric.criticality !== undefined && !ALL_CRITICALITY.includes(s.rubric.criticality)) {
      violation(
        'rubric.criticality',
        'error',
        `'${s.rubric.criticality}' must be one of: ${ALL_CRITICALITY.join(', ')}`,
      );
    }
  }

  // === triggers ===
  if (s.triggers !== undefined) {
    if (!Array.isArray(s.triggers)) {
      violation('triggers', 'error', 'triggers must be an array');
    } else {
      const maxTurns = typeof s.caps?.maxTurns === 'number' ? s.caps.maxTurns : undefined;
      s.triggers.forEach((t, i) => {
        if (!(t.on in ALL_TRIGGER_ONS)) {
          violation(
            `triggers[${i}].on`,
            'error',
            `'${t.on}' must be one of: ${Object.keys(ALL_TRIGGER_ONS).join(', ')}`,
          );
        }
        if (!(t.fire in ALL_TRIGGERS)) {
          violation(
            `triggers[${i}].fire`,
            'error',
            `'${t.fire}' is not a valid TurnTrigger; allowed: ${Object.keys(ALL_TRIGGERS).join(', ')}`,
          );
        }
        if (t.text !== undefined) {
          if (typeof t.text !== 'string' || !t.text.trim()) {
            violation(`triggers[${i}].text`, 'error', 'trigger text must be a non-empty string');
          }
          if (t.fire !== 'user_message') {
            violation(`triggers[${i}].text`, 'error', 'trigger text is only valid with fire:user_message');
          }
        }
        if (t.on === 'after_turn' && typeof t.param === 'number') {
          if (t.param < 0 || !Number.isInteger(t.param)) {
            violation(`triggers[${i}].param`, 'error', `param must be a non-negative integer, got ${t.param}`);
          } else if (maxTurns !== undefined && t.param >= maxTurns) {
            violation(
              `triggers[${i}].param`,
              'error',
              `scripted trigger param=${t.param} is unreachable: caps.maxTurns=${maxTurns} ` +
                `(after_turn triggers fire BEFORE the named turn, so param must be < maxTurns)`,
            );
          }
        }
      });
    }
  }

  // === asserts ===
  if (!Array.isArray(s.asserts)) {
    violation('asserts', 'error', 'asserts must be an array');
  } else {
    s.asserts.forEach((a, i) => {
      if (!a || typeof a !== 'object' || typeof (a as { kind?: unknown }).kind !== 'string') {
        violation(`asserts[${i}]`, 'error', 'each assert must be an object with a string kind');
        return;
      }
      if (!(a.kind in ALL_ASSERT_KINDS)) {
        violation(
          `asserts[${i}].kind`,
          'error',
          `'${a.kind}' is not a known assert kind. Known: ${Object.keys(ALL_ASSERT_KINDS).sort().join(', ')}`,
        );
        return;
      }
      switch (a.kind) {
        case 'custom': {
          if (typeof a.name !== 'string' || !a.name.trim()) {
            violation(`asserts[${i}].name`, 'error', 'custom asserts must have a non-empty name');
          }
          if (typeof a.eval !== 'function') {
            violation(`asserts[${i}].eval`, 'error', 'custom asserts must have a callable eval(run)');
          }
          break;
        }
        case 'control_tag_present': {
          if (!['continue', 'sleep', 'spawn'].includes(a.tag)) {
            violation(`asserts[${i}].tag`, 'error', `'${a.tag}' must be one of: continue, sleep, spawn`);
          }
          break;
        }
        case 'auto_fire_happened': {
          if (!['continue', 'user_says_ready'].includes(a.trigger)) {
            violation(
              `asserts[${i}].trigger`,
              'error',
              `'${a.trigger}' must be 'continue' or 'user_says_ready'`,
            );
          }
          break;
        }
        case 'tool_called':
        case 'tool_not_called': {
          if (typeof a.name !== 'string' || !a.name.trim()) {
            violation(`asserts[${i}].name`, 'error', `${a.kind} must have a non-empty name`);
          }
          break;
        }
        case 'finish_reason_is': {
          const allowed = ['done', 'error', 'aborted', 'budget', 'cap'];
          if (!allowed.includes(a.expected)) {
            violation(`asserts[${i}].expected`, 'error', `'${a.expected}' must be one of: ${allowed.join(', ')}`);
          }
          break;
        }
        case 'spawn_dispatched': {
          if (typeof a.role !== 'string' || !a.role.trim()) {
            violation(`asserts[${i}].role`, 'error', 'spawn_dispatched must declare a role');
          }
          break;
        }
        case 'card_emitted': {
          if (typeof a.cardKind !== 'string' || !a.cardKind.trim()) {
            violation(`asserts[${i}].cardKind`, 'error', 'card_emitted must declare a cardKind');
          }
          break;
        }
      }
    });
  }

  // === runMatrix ===
  if (s.runMatrix !== undefined) {
    if (!Number.isInteger(s.runMatrix.repeat) || s.runMatrix.repeat < 1) {
      violation(
        'runMatrix.repeat',
        'error',
        `repeat must be a positive integer, got ${JSON.stringify(s.runMatrix.repeat)}`,
      );
    }
    if (
      s.runMatrix.variancePolicy !== undefined &&
      !ALL_VARIANCE_POLICIES.includes(s.runMatrix.variancePolicy)
    ) {
      violation(
        'runMatrix.variancePolicy',
        'error',
        `'${s.runMatrix.variancePolicy}' must be one of: ${ALL_VARIANCE_POLICIES.join(', ')}`,
      );
    }
  }

  // === transport ===
  if (s.transport !== undefined && !ALL_TRANSPORTS.includes(s.transport)) {
    violation('transport', 'error', `'${s.transport}' must be one of: ${ALL_TRANSPORTS.join(', ')}`);
  }

  // === fixtures ===
  if (s.fixtures?.sseTapePath) {
    const root = opts.fixtureRoot ?? process.cwd();
    const path = s.fixtures.sseTapePath.startsWith('/')
      ? s.fixtures.sseTapePath
      : `${root.replace(/\/$/, '')}/${s.fixtures.sseTapePath}`;
    if (opts.fileExists && !opts.fileExists(path)) {
      violation(
        'fixtures.sseTapePath',
        'error',
        `declared SSE tape '${s.fixtures.sseTapePath}' does not exist on disk (resolved: ${path})`,
      );
    }
  }

  return v;
}

/**
 * Pretty-print lint violations for the CLI. Groups by scenario id;
 * errors before warnings.
 */
export function formatViolations(violations: LintViolation[]): string {
  if (violations.length === 0) return '✓ lint clean — 0 violations';
  const byScenario = new Map<string, LintViolation[]>();
  for (const v of violations) {
    const arr = byScenario.get(v.scenarioId) ?? [];
    arr.push(v);
    byScenario.set(v.scenarioId, arr);
  }
  const lines: string[] = [];
  for (const [sid, arr] of [...byScenario.entries()].sort()) {
    arr.sort((a, b) => (a.severity === 'error' ? -1 : 1) - (b.severity === 'error' ? -1 : 1));
    lines.push(`\n${sid}:`);
    for (const v of arr) {
      const icon = v.severity === 'error' ? '✗' : '!';
      lines.push(`  ${icon} [${v.severity}] ${v.field}: ${v.message}`);
    }
  }
  const errs = violations.filter((x) => x.severity === 'error').length;
  const warns = violations.filter((x) => x.severity === 'warn').length;
  lines.push(`\n${errs} error(s), ${warns} warning(s).`);
  return lines.join('\n');
}
