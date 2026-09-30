/**
 * A bounded, task-derived tool-schema pack for coord:orient (P-006 / EI-11409).
 *
 * Dynamic tool surfaces already know how to grow a seeded MCP session through
 * ctx.activateTools. The missing leg was choosing the small set a task needs at
 * the wake boundary and carrying enough schema to survive a compaction. This
 * module deliberately reuses the projected tool registry and the existing
 * activation notification; it does not create a second catalog.
 */
import { createHash } from 'node:crypto';
import {
  PROJECTED_TOOL_REGISTRY_SOURCE,
  listAllProjectedTools,
  projectedToolRegistryRevision,
} from '@papercusp/agent-mcp';
import { schemaToText } from '../../../cupboard/tools-discovery';
import { withInlinedSchemaRefs } from '../../schema-ref-inline';

export const TASK_SCHEMA_PACK_SCHEMA = 'orient-task-tool-schema-pack-v2' as const;
export const TASK_SCHEMA_PACK_BUDGET_CHARS = 3_500;
export const TASK_SCHEMA_PACK_MAX_TOOLS = 36;
const ARG_SCHEMA_CAP = 180;
// Keep the lifecycle producer's write shape in the bounded recovery preview. The
// base spine plus AUTO's loop:arm used all six old slots, leaving loop:checkpoint
// advertised in toolNames but with no inline args for a cold successor to use.
const SCHEMA_DETAIL_MAX_TOOLS = 7;
const RECOVERY_DETAIL_TOOLS = ['loop:checkpoint'] as const;

interface ProjectedToolLike {
  expose?: { mcp?: { name?: string } | null };
  inputSchema?: unknown;
}

export interface TaskSchemaPackInput {
  intent?: string;
  modes?: readonly string[];
  harness?: string | null;
  plan?: string | null;
  planItems?: readonly string[];
  recipeTitles?: readonly string[];
}

export interface TaskToolSchemaPack {
  schemaVersion: typeof TASK_SCHEMA_PACK_SCHEMA;
  generation: string;
  watermark: string;
  /**
   * Every server-side tool activated for the task. This is the projected
   * registry's activation set, not proof that the caller has materialized a
   * direct client wrapper yet.
   */
  toolNames: string[];
  tools: Array<{ name: string; args: string | null }>;
  /** Requested names absent from the server's projected registry. This says
   * nothing about client-side direct-wrapper availability. */
  registryMissing: string[];
  /** The server cannot observe whether this client has refreshed its tool
   * list, so every listed name has an immediate universal dispatch path. */
  dispatch: {
    immediate: 'tools:invoke';
    direct: 'client-surface-dependent';
    refresh: 'tools/list_changed';
  };
  basis: {
    modes: string[];
    harness: string | null;
    plan: string | null;
    planItems: string[];
    signals: string[];
  };
  budget: { maxChars: number; serializedChars: number; estimatedTokens: number; maxTools: number };
  provenance: {
    source: 'coord:orient';
    schemaSource: typeof PROJECTED_TOOL_REGISTRY_SOURCE;
    registryRevision: string;
  };
  resync: {
    on: readonly ['missing-base', 'schema-mismatch', 'watermark-mismatch', 'mode-transition', 'scope-transition'];
    verb: 'coord:orient';
    args: { afterCompaction: true };
    rule: 'replace-full-never-merge-behind';
  };
}

type CandidateMap = Map<string, number>;

function add(candidates: CandidateMap, names: readonly string[], priority: number): void {
  for (const name of names) candidates.set(name, Math.max(priority, candidates.get(name) ?? 0));
}

const MODE_TOOLS: Record<string, readonly string[]> = {
  auto: ['loop:arm', 'loop:status', 'loop:checkpoint', 'loop:end'],
  drain: [
    'scheduler:get_next',
    'work_items:claimable',
    'work_items:burn_down',
    'fleet:assignments',
    'fleet:leader-brief',
    'fleet:bench',
  ],
  ideate: [
    'curation:state-of-pot',
    'rubrics:list',
    'rubrics:search',
    'scorecards:freshness',
    'blender:ideation-feedback',
    'blender:route-idea',
    'blender:ideate-pass-record',
    'improvements:capture',
  ],
};

const SIGNAL_GROUPS: Array<{ id: string; pattern: RegExp; tools: readonly string[] }> = [
  {
    id: 'grade',
    pattern: /\b(grade|rubric|scorecard|evaluation|audit score)\b/i,
    tools: ['rubrics:list', 'rubrics:search', 'rubrics:get', 'scorecards:list', 'scorecards:freshness', 'blender:grade-idea', 'blender:ideation-feedback'],
  },
  {
    id: 'monitor',
    pattern: /\b(monitor|watch|await|event|wake|cadence|loop)\b/i,
    tools: ['loop:status', 'loop:checkpoint', 'watch:create', 'events:await', 'events:status', 'coord:glance'],
  },
  {
    id: 'fleet-drain',
    pattern: /\b(fleet|drain|backlog|scheduler|claim.?spec|burndown)\b/i,
    tools: [
      'scheduler:get_next',
      'scheduler:get_claim_spec',
      'work_items:claimable',
      'work_items:burn_down',
      'fleet:assignments',
      'fleet:leader-brief',
      'fleet:bench',
    ],
  },
  {
    id: 'release',
    pattern: /\b(release|deploy|gate|green|sha|pipeline)\b/i,
    tools: ['release:trace', 'release:checkpoint-run', 'deploy:status', 'deploy:await', 'dev:build_status'],
  },
  {
    id: 'sessions',
    pattern: /\b(session|transcript|compaction|timeline)\b/i,
    tools: ['sessions:list', 'sessions:search', 'sessions:timeline', 'sessions:read', 'session:request-compaction'],
  },
  {
    id: 'tool-schema',
    pattern: /\b(tool|schema|catalog|argument|parameter)\b/i,
    tools: ['tools:find', 'tools:invoke', 'agent_tools:list'],
  },
  {
    // coordination-spec-adoption-2026-08-03 P-011 / D-100 / D-101. `coord:dispatch`
    // is the only single call that assigns a lane, inlines each item's body, wakes
    // the target and reports whether pickup happened — and it took 1 call in 30 days
    // from 1 agent. The kept-under-test hypothesis is that its zero use is DELIVERY,
    // not absent demand: it reaches a trimmed session only as a deferred name, so it
    // is callable only by an agent who already suspected it existed.
    //
    // Seeding is the NECESSARY half and explicitly not the sufficient one — D-101
    // records that on this fleet promotion (docs/hints/mentions) asymptoted at 1.7%
    // while a pre-addressed HANDLE in a result the agent already holds is what moved
    // adoption. So this makes the verb callable without a tools:find round-trip; the
    // handles in coord:presence and plan_items:release are what make it reached for.
    //
    // `plan_items:release` — not `work_items:release` — is the lane surface here:
    // coord:dispatch's `items` are PLAN items (P-NNN), so plan_items:assign/release
    // are the pair that actually moves a lane, and plan_items:release is the second
    // site that emits the ready dispatch handle. work_items:release stays because a
    // handoff usually releases the WI claim too, but it is the WI-id surface, not
    // the one dispatch addresses.
    id: 'handoff',
    pattern: /\b(hand.?off|handing off|delegat|reassign|re-?assign|dispatch|pick(?:ed)? ?up|take over|taking over|park(?:ing)? (?:my|the) lane)\b/i,
    tools: ['coord:dispatch', 'coord:presence', 'plan_items:release', 'plan_items:assign', 'work_items:release'],
  },
  {
    id: 'recipe',
    pattern: /\b(recipe|orchestrat|batch|fan.?out)\b/i,
    tools: ['recipes:get', 'recipes:run', 'recipes:search', 'code:run'],
  },
];

function compactSchema(schema: unknown): string | null {
  const rendered = schemaToText(schema);
  if (!rendered) return null;
  if (rendered.length <= ARG_SCHEMA_CAP) return rendered;

  // EI-20485533379404314: a blind prefix clip can hide the one argument that
  // determines whether a lifecycle write is valid. work_items:complete is the
  // concrete failure: its verbose `completion` shape precedes `assumptions`, so
  // the old 180-char preview advertised state but omitted that terminal closes
  // require assumptions:"none"|fact keys. Preserve any explicitly documented
  // terminal contract as a suffix instead of relying on property order. The
  // full schema still arrives through tools/list_changed; this is the bounded
  // recovery preview an agent must be able to act from before that round-trip.
  // Resolve `$ref`/`$defs` FIRST. work_items:complete moved its completion
  // record into a shared `$defs` entry, so the `completion` property node at
  // this position is a bare {"$ref": "#/$defs/..."} carrying no `description`
  // — which made the root-cause probe below silently fail and degrade the
  // preview to `completion?:object structured record`, dropping the very
  // contract a recovery caller needs to form a valid bug close. This is the
  // single choke point: both completionHasRootCauseContract and the
  // schemaToText fragment loop read from `rawBranches`.
  const inlinedSchema = withInlinedSchemaRefs(schema);
  const root = inlinedSchema && typeof inlinedSchema === 'object' && !Array.isArray(inlinedSchema)
    ? inlinedSchema as Record<string, unknown>
    : null;
  const rawBranches = root && Array.isArray(root.anyOf)
    ? root.anyOf
    : root && Array.isArray(root.oneOf)
      ? root.oneOf
      : root
        ? [root]
        : [];
  const terminalContracts = new Map<string, { fragment: string; priority: number }>();
  const completionHasRootCauseContract = rawBranches.some((rawBranch) => {
    if (!rawBranch || typeof rawBranch !== 'object' || Array.isArray(rawBranch)) return false;
    const properties = (rawBranch as Record<string, unknown>).properties;
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return false;
    const completion = (properties as Record<string, unknown>).completion;
    if (!completion || typeof completion !== 'object' || Array.isArray(completion)) return false;
    const description = (completion as Record<string, unknown>).description;
    return typeof description === 'string'
      && /rootCauseVerification/.test(description)
      && /bug\/capability-gap/i.test(description);
  });
  for (const rawBranch of rawBranches) {
    if (!rawBranch || typeof rawBranch !== 'object' || Array.isArray(rawBranch)) continue;
    const properties = (rawBranch as Record<string, unknown>).properties;
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) continue;
    for (const [name, rawProperty] of Object.entries(properties as Record<string, unknown>)) {
      if (!rawProperty || typeof rawProperty !== 'object' || Array.isArray(rawProperty)) continue;
      const property = rawProperty as Record<string, unknown>;
      const description = property.description;
      const isCompletion = name === 'completion';
      if (
        !isCompletion &&
        (typeof description !== 'string' || !/\bterminal(?:\s+close)?\b/i.test(description))
      ) continue;
      const fragment = schemaToText({ type: 'object', properties: { [name]: rawProperty } });
      if (!fragment && !isCompletion) continue;

      // Keep the terminal markers short enough to share the bounded suffix. The
      // full schema remains available through tools/list_changed, but a recovery
      // caller still needs the conditional root-cause contract: omitting it makes
      // a valid-looking bug close fail only after the write is attempted.
      const compactFragment = isCompletion
        ? completionHasRootCauseContract
          ? `${name}?:object; rootCauseVerification v2 adds testProcedure,predictedObservations,actualObservation,evidenceRefs`
          : `${name}?:object structured record`
        : name === 'assumptions' && completionHasRootCauseContract
          ? `${name}?:terminal close; record-only; \"none\"|facts`
        : fragment;
      if (compactFragment) {
        terminalContracts.set(name, {
          fragment: compactFragment,
          priority: name === 'assumptions' ? 100 : isCompletion ? 90 : 10,
        });
      }
    }
  }

  // Prefer the fields that determine whether a terminal write is valid. A long
  // description on an earlier field (notably `state`) must not force a fallback
  // to the prefix-only preview and hide both `completion` and `assumptions`.
  const suffixParts: string[] = [];
  let suffixLength = 0;
  const suffixBudget = ARG_SCHEMA_CAP - '; …; '.length;
  for (const { fragment } of [...terminalContracts.values()].sort((a, b) => b.priority - a.priority)) {
    const separatorLength = suffixParts.length > 0 ? 2 : 0;
    if (suffixLength + separatorLength + fragment.length > suffixBudget) continue;
    suffixParts.push(fragment);
    suffixLength += separatorLength + fragment.length;
  }
  const suffix = suffixParts.join('; ');
  const separator = '; …; ';
  if (suffix && suffix.length + separator.length < ARG_SCHEMA_CAP) {
    const prefixLength = ARG_SCHEMA_CAP - separator.length - suffix.length;
    const prefix = rendered.slice(0, prefixLength).replace(/[;\s]+$/u, '');
    return `${prefix}${separator}${suffix}`;
  }
  return `${rendered.slice(0, ARG_SCHEMA_CAP - 1)}…`;
}

function projectedCatalog(): ProjectedToolLike[] {
  return listAllProjectedTools() as unknown as ProjectedToolLike[];
}

/** Pure over its input + injected catalog. Exported for the recurrence test. */
export function buildTaskToolSchemaPack(
  input: TaskSchemaPackInput,
  catalog: readonly ProjectedToolLike[] = projectedCatalog(),
): TaskToolSchemaPack {
  const candidates: CandidateMap = new Map();
  const signals: string[] = [];

  // The task lifecycle spine: orient once, explicitly redeclare the live lane,
  // inspect/checkpoint/finish the held unit. `coord:orient` performs a best-effort
  // declaration when intent is supplied, but a resumed client may still need the
  // direct verb after compaction; keep it callable without a tools:find detour.
  add(candidates, [
    'coord:orient',
    'coord:declare-intent',
    // Mode transitions are part of the session lifecycle, not an intent-specific
    // capability. A successor must be able to enter/exit/repair a registered mode
    // immediately after orient, before relying on tools:list_changed or the
    // tools:invoke fallback (EI-21312723403670925).
    'mode:set',
    'work_items:get',
    // Claimability is the read-only floor oracle shared by scheduler:get_next and
    // drain guidance. Keep it in the base recovery pack so a resumed client has a
    // direct schema before intent/mode-specific candidates are considered.
    'work_items:claimable',
    'work_items:checkpoint',
    'work_items:complete',
  ], 100);

  const modes = [...new Set((input.modes ?? []).map((m) => m.toLowerCase()))].sort();
  for (const mode of modes) {
    const tools = MODE_TOOLS[mode];
    if (tools) {
      signals.push(`mode:${mode}`);
      add(candidates, tools, 95);
    }
  }

  if (input.plan || input.planItems?.length) {
    signals.push('scope:plan');
    add(candidates, ['plans:get', 'plans:items', 'locks:acquire', 'locks:release'], 92);
  }

  const recipeTitles = (input.recipeTitles ?? []).filter(Boolean);
  const signalText = [input.intent ?? '', ...recipeTitles].join('\n');
  for (const group of SIGNAL_GROUPS) {
    if (group.pattern.test(signalText)) {
      signals.push(`intent:${group.id}`);
      add(candidates, group.tools, 85);
    }
  }
  if (input.intent && input.recipeTitles !== undefined) {
    // A surfaced recipe is executable context even when its short title has no
    // recognizable keyword. Carry the two direct continuation verbs.
    signals.push('surface:recipes');
    add(candidates, ['recipes:get', 'recipes:run'], 88);
  }

  const byName = new Map<string, ProjectedToolLike>();
  for (const tool of catalog) {
    const name = tool.expose?.mcp?.name;
    if (name) byName.set(name, tool);
  }

  const requested = [...candidates.entries()]
    .sort(([a, ap], [b, bp]) => bp - ap || a.localeCompare(b));
  const registryRevision = projectedToolRegistryRevision(
    catalog as Parameters<typeof projectedToolRegistryRevision>[0],
  );
  const registryMissing = requested.filter(([name]) => !byName.has(name)).map(([name]) => name);
  const allTools = requested
    .flatMap(([name]) => {
      const tool = byName.get(name);
      return tool ? [{ name, args: compactSchema(tool.inputSchema) }] : [];
    })
    // Missing registry entries are reported above and never consume the pack's
    // live-tool budget. This matters during rolling deploys: one unavailable
    // low-priority tool must not evict a real schema the caller can use now.
    .slice(0, TASK_SCHEMA_PACK_MAX_TOOLS);
  const toolNames = allTools.map((tool) => tool.name);
  // Reserve the carry-note producer even when higher-priority mode tools fill the
  // ordinary preview slots. `toolNames` activates the full surface, but a fresh
  // recovery caller needs the write keys before it can rely on tools/list_changed.
  const reservedDetails = allTools.filter((tool) => RECOVERY_DETAIL_TOOLS.includes(tool.name as (typeof RECOVERY_DETAIL_TOOLS)[number]));
  const ordinaryDetails = allTools
    .filter((tool) => !RECOVERY_DETAIL_TOOLS.includes(tool.name as (typeof RECOVERY_DETAIL_TOOLS)[number]))
    .slice(0, Math.max(0, SCHEMA_DETAIL_MAX_TOOLS - reservedDetails.length));
  const tools = [...ordinaryDetails, ...reservedDetails];

  // The char budget is an invariant, not guidance. `toolNames` is the exact
  // activation set; `tools` is only a small inline schema preview. The client
  // receives complete schemas for every name through tools/list_changed.
  for (
    let i = tools.length - 1;
    i >= 0 && JSON.stringify({ toolNames, tools }).length > TASK_SCHEMA_PACK_BUDGET_CHARS;
    i -= 1
  ) {
    tools[i] = { ...tools[i], args: null };
  }
  while (tools.length > 1 && JSON.stringify({ toolNames, tools }).length > TASK_SCHEMA_PACK_BUDGET_CHARS) tools.pop();

  const basis = {
    modes,
    harness: input.harness ?? null,
    plan: input.plan ?? null,
    planItems: [...new Set(input.planItems ?? [])].sort(),
    signals: [...new Set(signals)].sort(),
  };
  const watermark = createHash('sha256')
    .update(JSON.stringify({
      schemaVersion: TASK_SCHEMA_PACK_SCHEMA,
      registryRevision,
      basis,
      registryMissing,
      tools: allTools,
    }))
    .digest('hex')
    .slice(0, 24);
  const serializedChars = JSON.stringify({ toolNames, tools }).length;

  return {
    schemaVersion: TASK_SCHEMA_PACK_SCHEMA,
    generation: watermark,
    watermark,
    toolNames,
    tools,
    registryMissing,
    dispatch: {
      immediate: 'tools:invoke',
      direct: 'client-surface-dependent',
      refresh: 'tools/list_changed',
    },
    basis,
    budget: {
      maxChars: TASK_SCHEMA_PACK_BUDGET_CHARS,
      serializedChars,
      estimatedTokens: Math.ceil(serializedChars / 4),
      maxTools: TASK_SCHEMA_PACK_MAX_TOOLS,
    },
    provenance: {
      source: 'coord:orient',
      schemaSource: PROJECTED_TOOL_REGISTRY_SOURCE,
      registryRevision,
    },
    resync: {
      on: ['missing-base', 'schema-mismatch', 'watermark-mismatch', 'mode-transition', 'scope-transition'],
      verb: 'coord:orient',
      args: { afterCompaction: true },
      rule: 'replace-full-never-merge-behind',
    },
  };
}
