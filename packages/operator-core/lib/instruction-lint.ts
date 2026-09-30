/**
 * Deterministic lint for the FINAL instruction text handed to an agent.
 *
 * Generated operating briefs stamp load-bearing rules as
 * `<!-- papercusp-rule:<key>=<value> -->`. Markers let the compiler detect real
 * contradictions without guessing policy from arbitrary prose. Exact repeated
 * normative lines are reported separately as compaction candidates.
 */

import { createHash } from 'node:crypto';
import { modeImpliesAutonomy } from './modes/registry';

export interface InstructionRuleOccurrence {
  key: string;
  value: string;
  line: number;
}

export interface InstructionLintReport {
  markerCount: number;
  duplicateRules: Array<{ key: string; value: string; lines: number[] }>;
  conflicts: Array<{ key: string; values: string[]; lines: number[] }>;
  staleRules: Array<{ key: string; value: string; line: number; replacement: string }>;
  duplicateDirectives: Array<{ directive: string; lines: number[] }>;
  /** D-017/P-019: post-compaction startup text that still mandates a recovery
   * orient instead of branching on the automatically delivered marker. */
  unconditionalPostCompactionRecovery: Array<{
    line: number;
    directive: string;
    pattern: string;
  }>;
  /** Runtime-effective rule resolution. Present only when the caller supplies
   * canonical mode/route/scope state; this never guesses runtime state from prose. */
  precedenceTrace?: InstructionPrecedenceTrace;
  clean: boolean;
}

export const INSTRUCTION_PRECEDENCE_SCHEMA = 'instruction-precedence-v1' as const;

export type InstructionModeResolution = 'launch' | 'registry' | 'unavailable';

export interface InstructionRuntimeContext {
  source: 'bootstrap-su' | 'coord:orient' | 'control-anchor';
  ownerId?: string | null;
  modes?: string[];
  /** Where the active mode list came from. A failed live read is explicit so
   * the trace cannot silently turn an unknown authority state into the generic
   * confirm-first posture. */
  modeResolution?: InstructionModeResolution;
  route?: { kind: 'self' } | { kind: 'mug' } | { kind: 'fleet'; fleet: string; role?: string | null };
  scope?: {
    workspace?: string | null;
    harness?: string | null;
    plan?: string | null;
    items?: string[];
  };
  loop?: { active: boolean; intervalSec?: number | null };
  observedAt?: string;
}

export interface InstructionPrecedenceSuppression {
  value: string;
  source: string;
  reason: string;
  lines?: number[];
}

export interface InstructionPrecedenceDecision {
  key: string;
  status: 'effective' | 'conflict';
  effective: { value: string; source: string; lines?: number[] } | null;
  suppressed: InstructionPrecedenceSuppression[];
  reason: string;
}

export interface InstructionPrecedenceTrace {
  schemaVersion: typeof INSTRUCTION_PRECEDENCE_SCHEMA;
  /** Content-addressed runtime watermark. Consumers replace the full trace
   * whenever it changes; they never merge a prior trace into a newer one. */
  watermark: string;
  effectiveMission: {
    constraint: string;
    source: string;
    explanation: string;
  };
  decisions: InstructionPrecedenceDecision[];
  provenance: {
    source: InstructionRuntimeContext['source'];
    ownerId: string | null;
    observedAt: string;
  };
  resync: {
    on: readonly ['watermark-mismatch', 'mode-transition', 'route-transition', 'scope-transition'];
    verb: 'coord:orient';
    args: { afterCompaction: true };
    rule: 'replace-full-never-merge-behind';
  };
}

const RULE_RE = /<!--\s*papercusp-rule:([a-z0-9-]+)=([a-z0-9-]+)\s*-->/gi;

const UNCONDITIONAL_POST_COMPACTION_PATTERNS = [
  {
    name: 'first-orient',
    re: /\b(?:first|always|must|immediately)\s+(?:re-?run|run|call)\s+`?coord:orient\s*\{\s*afterCompaction\s*:\s*true\s*\}/i,
  },
  {
    name: 'before-acting-orient',
    re: /\bbefore acting\b[\s\S]{0,320}\b(?:re-?run|run|call)\s+`?coord:orient[\s\S]{0,180}afterCompaction\s*:\s*true/i,
  },
  {
    name: 'first-afterCompaction-arg',
    re: /\bpass\s+`?afterCompaction\s*:\s*true`?\s+on\s+(?:your|the)\s+first\b/i,
  },
  {
    name: 'first-action-orient',
    re: /\bFIRST ACTION\b[\s\S]{0,320}\brun\s+coord:orient\s*\{\s*afterCompaction\s*:\s*true\s*\}/i,
  },
  {
    name: 're-run-orient',
    re: /\bre-?run\s+coord:orient\s*\{\s*afterCompaction\s*:\s*true\s*\}/i,
  },
  {
    name: 'reconstruct-via-orient',
    re: /\breconstruct working state via coord:orient\s*\{\s*afterCompaction\s*:\s*true\s*\}/i,
  },
  {
    name: 'compacted-context-first-orient',
    re: /\bcompacted context\b[\s\S]{0,240}\bfirst\s+re-?run\s+coord:orient\b/i,
  },
] as const;

/** Find the retired unconditional startup contract in wrapped Markdown or
 * concatenated source strings. Windows are deliberately small so a valid
 * marker condition elsewhere in a long prompt cannot launder a nearby mandate. */
export function findUnconditionalPostCompactionRecoveryDirectives(
  text: string,
  maxFindings = 20,
): InstructionLintReport['unconditionalPostCompactionRecovery'] {
  const lines = text.split(/\r?\n/);
  const findings: InstructionLintReport['unconditionalPostCompactionRecovery'] = [];
  const seen = new Set<string>();
  for (let index = 0; index < lines.length; index += 1) {
    const window = lines.slice(index, index + 6).join(' ').replace(/\s+/g, ' ').trim();
    for (const pattern of UNCONDITIONAL_POST_COMPACTION_PATTERNS) {
      const match = pattern.re.exec(window);
      if (!match) continue;
      const key = `${pattern.name}:${match[0].toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({ line: index + 1, directive: window.slice(0, 500), pattern: pattern.name });
      if (findings.length >= maxFindings) return findings;
      // Several narrow regexes intentionally overlap (for example a "First
      // re-run" line is both first-orient and re-run-orient). One source
      // directive is one blocking finding; the first/most-specific pattern wins.
      break;
    }
  }
  return findings;
}

function semanticFileLockMode(line: string): string | null {
  const plain = line
    .replace(/[`*_>#|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (
    /file-lock enforcement is not automatic/.test(plain) ||
    /nothing claims locks for you/.test(plain) ||
    /treat every edit as needing the explicit claim/.test(plain)
  ) {
    return 'explicit-manual';
  }
  if (
    /file-lock enforcement is automatic here/.test(plain) ||
    /managed hooks claim\/release file locks automatically/.test(plain)
  ) {
    return 'automatic-hooks';
  }
  return null;
}

/** Retired mechanisms whose replacements are now canonical. */
const STALE_RULE_VALUES: Record<string, Record<string, string>> = {
  'harness-scope': { 'session-auto': 'explicit-per-call' },
  'test-router': { 'raw-vitest': 'test-file' },
  'file-locking': { advisory: 'automatic-hooks' },
  'git-ownership': { agent: 'background-sync' },
  'app-runtime': { browser: 'tauri' },
};

function stableRuntimeContext(input: InstructionRuntimeContext) {
  return {
    modes: [...new Set(input.modes ?? [])].sort(),
    modeResolution:
      input.modeResolution ?? (input.source === 'bootstrap-su' ? ('launch' as const) : ('registry' as const)),
    route: input.route ?? { kind: 'self' as const },
    scope: {
      workspace: input.scope?.workspace ?? null,
      harness: input.scope?.harness ?? null,
      plan: input.scope?.plan ?? null,
      items: [...new Set(input.scope?.items ?? [])].sort(),
    },
    loop: input.loop ? { active: Boolean(input.loop.active), intervalSec: input.loop.intervalSec ?? null } : null,
  };
}

function runtimeDecision(
  key: string,
  value: string,
  source: string,
  reason: string,
  suppressed: InstructionPrecedenceSuppression[] = [],
): InstructionPrecedenceDecision {
  return { key, status: 'effective', effective: { value, source }, suppressed, reason };
}

/**
 * Resolve the machine-readable EFFECTIVE instruction set from canonical
 * runtime state. Generic playbook clauses remain available for a later mode
 * transition, but the trace explicitly suppresses the ones that do not apply
 * NOW. Nothing is inferred from natural-language prompt prose.
 */
export function buildInstructionPrecedenceTrace(
  runtime: InstructionRuntimeContext,
  occurrences: InstructionRuleOccurrence[] = [],
): InstructionPrecedenceTrace {
  const stable = stableRuntimeContext(runtime);
  const modes = new Set(stable.modes);
  const modeResolutionUnknown = stable.modeResolution === 'unavailable';
  const auto = !modeResolutionUnknown && [...modes].some((m) => modeImpliesAutonomy(m));
  const drain = modes.has('drain');
  const ideate = modes.has('ideate');
  const decisions: InstructionPrecedenceDecision[] = [];

  const byKey = new Map<string, InstructionRuleOccurrence[]>();
  for (const occurrence of occurrences) {
    const group = byKey.get(occurrence.key) ?? [];
    group.push(occurrence);
    byKey.set(occurrence.key, group);
  }
  for (const [key, group] of [...byKey.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const values = [...new Set(group.map((entry) => entry.value))];
    const canonical =
      values.length === 1
        ? values[0]!
        : (values.find((candidate) => values.some((value) => STALE_RULE_VALUES[key]?.[value] === candidate)) ?? null);
    if (!canonical) {
      decisions.push({
        key,
        status: 'conflict',
        effective: null,
        suppressed: [],
        reason: `No declared precedence resolves compiled values: ${values.join(', ')}.`,
      });
      continue;
    }
    const effectiveRows = group.filter((entry) => entry.value === canonical);
    decisions.push({
      key,
      status: 'effective',
      effective: {
        value: canonical,
        source: 'compiled-rule',
        lines: effectiveRows.map((entry) => entry.line),
      },
      suppressed: values
        .filter((value) => value !== canonical)
        .map((value) => ({
          value,
          source: 'compiled-rule',
          lines: group.filter((entry) => entry.value === value).map((entry) => entry.line),
          reason: `Retired value; canonical replacement is ${canonical}.`,
        })),
      reason:
        values.length === 1
          ? 'Only one compiled value is active.'
          : `Canonical replacement ${canonical} supersedes retired compiled values.`,
    });
  }

  decisions.push(
    modeResolutionUnknown
      ? {
          key: 'execution-authorization',
          status: 'conflict',
          effective: { value: 'unknown', source: 'runtime:mode-registry' },
          suppressed: [],
          reason:
            'The canonical agent mode registry could not be read; execution authorization is unknown, not confirm-first.',
        }
      : auto
      ? runtimeDecision(
          'execution-authorization',
          'act-with-disclosure',
          drain ? 'mode:drain' : 'mode:auto',
          'The active owner-authorized mode overrides the generic confirm-first posture.',
          [
            {
              value: 'confirm-before-execution',
              source: 'generic-playbook',
              reason: 'Suppressed while AUTO or DRAIN is active.',
            },
          ],
        )
      : runtimeDecision(
          'execution-authorization',
          'confirm-before-execution',
          'generic-playbook',
          'No active AUTO-implying mode supersedes the default posture.',
        ),
  );

  let mission: InstructionPrecedenceTrace['effectiveMission'];
  if (drain) {
    mission = {
      constraint: 'drain-active-scope-to-terminal',
      source: 'mode:drain',
      explanation:
        'Drive every item in the active scoped queue to a terminal state; completion integrity outranks speed.',
    };
  } else if (stable.route.kind === 'fleet' && stable.route.role === 'leader') {
    mission = {
      constraint: 'lead-fleet-plan-to-terminal',
      source: `fleet:${stable.route.fleet}:leader`,
      explanation: 'Drive the selected plan through the fleet; do not silently fall back to solo implementation.',
    };
  } else if (stable.route.kind === 'fleet') {
    mission = {
      constraint: 'execute-fleet-plan-only',
      source: `fleet:${stable.route.fleet}:member`,
      explanation: 'Pull only work admitted by the fleet scope/spec; do not fall through to the generic backlog.',
    };
  } else if (stable.scope.plan) {
    mission = {
      constraint: 'execute-bound-plan',
      source: `plan:${stable.scope.plan}`,
      explanation: 'The bound plan and claimed items are the active mission; unrelated backlog is out of scope.',
    };
  } else if (stable.route.kind === 'mug') {
    mission = {
      constraint: 'execute-pot-placement',
      source: 'route:mug',
      explanation: 'Advance the work placed by the pot; route-level placement outranks generic backlog selection.',
    };
  } else {
    mission = {
      constraint: 'execute-owner-directed-scope',
      source: 'route:self',
      explanation: 'Advance the current owner-directed task and its registered work; do not invent a parallel mission.',
    };
  }
  const missionSuppressed: InstructionPrecedenceSuppression[] = [
    {
      value: 'generic-backlog-selection',
      source: 'generic-playbook',
      reason: `${mission.constraint} is the effective mission constraint.`,
    },
  ];
  if (stable.route.kind === 'fleet') {
    missionSuppressed.push({
      value: stable.route.role === 'leader' ? 'solo-implementation' : 'solo-route-selection',
      source: 'generic-playbook',
      reason: 'Fleet role is a sticky execution route until explicitly changed.',
    });
  }
  decisions.push(
    runtimeDecision('mission', mission.constraint, mission.source, mission.explanation, missionSuppressed),
    ideate
      ? runtimeDecision(
          'ideation',
          auto ? 'invent-and-implement' : 'invent-and-propose',
          'mode:ideate',
          auto
            ? 'IDEATE plus AUTO authorizes implementing the strongest net-new ideas.'
            : 'IDEATE without AUTO authorizes proposals but retains the execution gate.',
          [
            {
              value: 'direct-improvements-only',
              source: 'generic-playbook',
              reason: 'Suppressed while IDEATE is active.',
            },
          ],
        )
      : runtimeDecision(
          'ideation',
          'direct-improvements-only',
          'generic-playbook',
          'IDEATE is not active; stay within the directed improvement scope.',
        ),
  );
  if (stable.loop) {
    decisions.push(
      runtimeDecision(
        'recurrence',
        stable.loop.active ? 'continue-on-engine-loop' : 'one-shot-unless-open-ended',
        stable.loop.active ? 'runtime:loop' : 'runtime:no-loop',
        stable.loop.active
          ? 'The engine loop owns recurrence until explicitly ended.'
          : 'No active engine loop currently carries the mission across turns.',
      ),
    );
  }

  const watermark = createHash('sha256')
    .update(
      JSON.stringify({
        runtime: stable,
        decisions: decisions.map(({ key, effective, suppressed }) => ({ key, effective, suppressed })),
      }),
    )
    .digest('hex')
    .slice(0, 24);
  return {
    schemaVersion: INSTRUCTION_PRECEDENCE_SCHEMA,
    watermark,
    effectiveMission: mission,
    decisions,
    provenance: {
      source: runtime.source,
      ownerId: runtime.ownerId ?? null,
      observedAt: runtime.observedAt ?? new Date().toISOString(),
    },
    resync: {
      on: ['watermark-mismatch', 'mode-transition', 'route-transition', 'scope-transition'],
      verb: 'coord:orient',
      args: { afterCompaction: true },
      rule: 'replace-full-never-merge-behind',
    },
  };
}

/** Compact prompt delivery. The structured trace remains the authority. */
export function renderInstructionPrecedenceContext(trace: InstructionPrecedenceTrace): string {
  return `⟦INSTRUCTION-PRECEDENCE⟧ ${JSON.stringify(trace)}`;
}

function normalizedDirective(line: string): string | null {
  const plain = line
    .replace(/<!--.*?-->/g, '')
    .replace(/[`*_>#|]/g, ' ')
    .replace(/^\s*[-+\d.)]+\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (plain.length < 24 || plain.length > 500) return null;
  if (!/\b(must|must not|never|always|do not|don't|required|only)\b/.test(plain)) return null;
  return plain.replace(/[.!:;]+$/g, '');
}

export function lintInstructionText(
  text: string,
  maxFindings = 20,
  runtime?: InstructionRuntimeContext,
): InstructionLintReport {
  const lines = text.split(/\r?\n/);
  const occurrences: InstructionRuleOccurrence[] = [];
  lines.forEach((line, index) => {
    RULE_RE.lastIndex = 0;
    for (let match = RULE_RE.exec(line); match; match = RULE_RE.exec(line)) {
      occurrences.push({ key: match[1]!, value: match[2]!, line: index + 1 });
    }
  });
  const markerCount = occurrences.length;
  // EI-11408: the original Codex contradiction was prose on one side and a
  // generated marker on the other, so marker-only lint declared it clean.
  // Recognize only the narrow, load-bearing lock modal phrases. A marker on
  // the same/adjacent line already carries that rule and suppresses a duplicate.
  lines.forEach((line, index) => {
    const value = semanticFileLockMode(line);
    if (!value) return;
    const lineNo = index + 1;
    if (
      occurrences.some(
        (entry) => entry.key === 'file-locking' && entry.value === value && Math.abs(entry.line - lineNo) <= 1,
      )
    ) {
      return;
    }
    occurrences.push({ key: 'file-locking', value, line: lineNo });
  });
  occurrences.sort((a, b) => a.line - b.line || a.key.localeCompare(b.key));

  const byKey = new Map<string, InstructionRuleOccurrence[]>();
  for (const occurrence of occurrences) {
    const group = byKey.get(occurrence.key) ?? [];
    group.push(occurrence);
    byKey.set(occurrence.key, group);
  }

  const duplicateRules: InstructionLintReport['duplicateRules'] = [];
  const conflicts: InstructionLintReport['conflicts'] = [];
  const staleRules: InstructionLintReport['staleRules'] = [];
  for (const [key, group] of byKey) {
    const values = [...new Set(group.map((entry) => entry.value))];
    if (values.length > 1) {
      conflicts.push({ key, values, lines: group.map((entry) => entry.line) });
    }
    for (const value of values) {
      const same = group.filter((entry) => entry.value === value);
      if (same.length > 1) {
        duplicateRules.push({ key, value, lines: same.map((entry) => entry.line) });
      }
      const replacement = STALE_RULE_VALUES[key]?.[value];
      if (replacement) {
        staleRules.push(...same.map((entry) => ({ key, value, line: entry.line, replacement })));
      }
    }
  }

  const directiveLines = new Map<string, number[]>();
  lines.forEach((line, index) => {
    const directive = normalizedDirective(line);
    if (!directive) return;
    const positions = directiveLines.get(directive) ?? [];
    positions.push(index + 1);
    directiveLines.set(directive, positions);
  });
  const duplicateDirectives = [...directiveLines.entries()]
    .filter(([, positions]) => positions.length > 1)
    .map(([directive, positions]) => ({ directive, lines: positions }))
    .slice(0, maxFindings);
  const unconditionalPostCompactionRecovery =
    findUnconditionalPostCompactionRecoveryDirectives(text, maxFindings);

  return {
    markerCount,
    duplicateRules: duplicateRules.slice(0, maxFindings),
    conflicts: conflicts.slice(0, maxFindings),
    staleRules: staleRules.slice(0, maxFindings),
    duplicateDirectives,
    unconditionalPostCompactionRecovery,
    ...(runtime ? { precedenceTrace: buildInstructionPrecedenceTrace(runtime, occurrences) } : {}),
    clean:
      duplicateRules.length === 0 &&
      conflicts.length === 0 &&
      staleRules.length === 0 &&
      duplicateDirectives.length === 0 &&
      unconditionalPostCompactionRecovery.length === 0,
  };
}

/** Conflicts that make a compiled prompt unsafe to launch, rather than merely noisy. */
export function blockingInstructionConflicts(report: InstructionLintReport) {
  return [
    ...report.conflicts.filter((conflict) => conflict.key === 'file-locking'),
    ...report.unconditionalPostCompactionRecovery.map((finding) => ({
      key: 'post-compaction-recovery',
      values: ['unconditional-afterCompaction-orient'],
      lines: [finding.line],
    })),
  ];
}
