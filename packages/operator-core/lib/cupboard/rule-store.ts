/** Local rule packages use the same layered directory store as other Cupboard
 * content. Reading pins inert data; registration and wearer authorization stay
 * in the existing standalone reaction/activation path.
 *
 * A rule declares HOW it is delivered (portable-identity-packages P-011, D-023):
 *   - `async` is the standalone reaction rule — `on` an event, `fire` a class verb,
 *     registered into the reaction engine (`registerStandaloneReactionRule`).
 *   - `sync` runs inline at one client hook sink (`HOOK_SINKS`) and is never
 *     registered as a reaction. It carries exactly one of a `context` capability
 *     (a read-only provider whose output lands at the sink under the D-009 budget)
 *     or a `guard` (a pure deny/allowOnly predicate over the pending tool call).
 * A manifest that mixes the two shapes is refused at parse, never rerouted. */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { dataConditionSchema } from '@papercusp/rules';
import {
  HOOK_SINKS,
  HOOK_TOOL_SINKS,
  INJECTION_PRIORITY_MAX,
  INJECTION_PRIORITY_MIN,
  INJECTION_TOKEN_BUDGET_MAX,
} from '@papercusp/orchestrator/blueprint';
import { parseClassFireTarget } from '../events/class-fire-target';
import type { StandaloneRuleInput } from '../events/standalone-rules';
import { papercuspPath } from '../papercusp-root';
import {
  enumerateSelfDescribingDirs, inRepoFallbackDir, selfDescribingRoots,
  type SelfDescribingRoot,
} from './self-describing-store';

export const RULE_MANIFEST = 'rule.json';
export const RULE_PACKAGE_SCHEMA_VERSION = 1 as const;
const RULES_USER_SUBDIR = 'rules/installed';

/** Parse-time bounds on a rule condition. A guard is evaluated on every pending
 * tool call, so its size is fixed when the package is read, not discovered then. */
export const RULE_CONDITION_MAX_BYTES = 8 * 1024;
export const RULE_CONDITION_MAX_DEPTH = 12;
export const RULE_CONDITION_MAX_NODES = 256;

function conditionWithinBounds(value: unknown): boolean {
  if (JSON.stringify(value).length > RULE_CONDITION_MAX_BYTES) return false;
  let nodes = 0;
  const walk = (node: unknown, depth: number): boolean => {
    if (depth > RULE_CONDITION_MAX_DEPTH || ++nodes > RULE_CONDITION_MAX_NODES) return false;
    if (Array.isArray(node)) return node.every((child) => walk(child, depth + 1));
    if (node && typeof node === 'object') return Object.values(node).every((child) => walk(child, depth + 1));
    return true;
  };
  return walk(value, 0);
}

const boundedCondition = dataConditionSchema.refine(conditionWithinBounds,
  `a rule condition must stay within ${RULE_CONDITION_MAX_BYTES} bytes, depth ${RULE_CONDITION_MAX_DEPTH} and ${RULE_CONDITION_MAX_NODES} nodes`);

const ruleMeta = {
  schemaVersion: z.literal(RULE_PACKAGE_SCHEMA_VERSION),
  id: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(2000),
  version: z.string().regex(/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/),
};

// The executable fields are the existing StandaloneRuleInput contract. In
// particular, a publisher cannot supply local grants, principals or capabilities.
const AsyncRulePackageSchema = z.object({
  ...ruleMeta,
  delivery: z.literal('async'),
  on: z.string().trim().min(1).max(200),
  when: boundedCondition.optional(),
  fire: z.string().refine((value) => parseClassFireTarget(value) !== null,
    'standalone rules require a capability class fire target'),
  args: z.record(z.string(), z.unknown()).optional(),
  onlyOnSuccess: z.boolean().optional(),
}).strict();

/** A portable context capability — the same `class@major` + verb a blueprint
 * contribution names (D-013) — with its D-009 injection request. */
const SyncRuleContextSchema = z.object({
  ref: z.string().max(220).regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+@(?:0|[1-9][0-9]*)$/,
    'a context capability is class@major'),
  verb: z.string().trim().min(1).max(120),
  tokenBudget: z.number().int().min(1).max(INJECTION_TOKEN_BUDGET_MAX),
  priority: z.number().int().min(INJECTION_PRIORITY_MIN).max(INJECTION_PRIORITY_MAX),
  overBudget: z.enum(['truncate', 'omit']),
}).strict();

/** Deny-only: a guard can refuse a pending call, never approve or rewrite one. */
const SyncRuleGuardSchema = z.object({
  deny: boundedCondition.optional(),
  allowOnly: boundedCondition.optional(),
  reason: z.string().trim().min(1).max(500).optional(),
}).strict().refine((guard) => guard.deny !== undefined || guard.allowOnly !== undefined,
  'a guard declares deny, allowOnly or both');

/** A tool name, or a prefix ending in `*`. Omit `tools` to match every tool. */
const RuleToolPatternSchema = z.string().max(200).regex(/^[^*\s]+\*?$/,
  'a tool filter is a name or a prefix ending in *');

const SyncRulePackageSchema = z.object({
  ...ruleMeta,
  delivery: z.literal('sync'),
  sink: z.enum(HOOK_SINKS),
  tools: z.array(RuleToolPatternSchema).min(1).max(32).optional(),
  context: SyncRuleContextSchema.optional(),
  guard: SyncRuleGuardSchema.optional(),
}).strict().superRefine((rule, ctx) => {
  if ((rule.context === undefined) === (rule.guard === undefined)) {
    ctx.addIssue({ code: 'custom', message: 'a sync rule declares exactly one of context or guard' });
  }
  if (rule.guard && rule.sink !== 'pre-tool') {
    ctx.addIssue({ code: 'custom', path: ['guard'], message: 'a guard runs only at the pre-tool sink' });
  }
  if (rule.context && rule.sink === 'pre-tool') {
    ctx.addIssue({ code: 'custom', path: ['context'], message: 'a context hook never votes, so it cannot target pre-tool' });
  }
  if (rule.tools && !(HOOK_TOOL_SINKS as readonly string[]).includes(rule.sink)) {
    ctx.addIssue({ code: 'custom', path: ['tools'], message: 'a tools filter applies only at pre-tool and post-tool' });
  }
});

const RulePackageSchema = z.discriminatedUnion('delivery', [AsyncRulePackageSchema, SyncRulePackageSchema]);

export type SyncRuleContext = z.infer<typeof SyncRuleContextSchema>;
export type SyncRuleGuard = z.infer<typeof SyncRuleGuardSchema>;
type RuleDeclaration<T> = Omit<T, 'schemaVersion'>;
export type AsyncRuleDeclaration = RuleDeclaration<z.infer<typeof AsyncRulePackageSchema>>;
export type SyncRuleDeclaration = RuleDeclaration<z.infer<typeof SyncRulePackageSchema>>;

interface LocalRuleLocation {
  ref: string;
  dir: string;
  layer: SelfDescribingRoot['layer'];
}
export type LocalAsyncRule = AsyncRuleDeclaration & StandaloneRuleInput & LocalRuleLocation;
export type LocalSyncRule = SyncRuleDeclaration & LocalRuleLocation;
export type LocalRule = LocalAsyncRule | LocalSyncRule;

export type ParseRulePackageResult =
  | { ok: true; rule: AsyncRuleDeclaration | SyncRuleDeclaration }
  | { ok: false; error: string };

/** Validate a `rule.json` value; every issue is named so an author fixes it in one pass. */
export function parseRulePackage(value: unknown): ParseRulePackageResult {
  const parsed = RulePackageSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues.map((issue) =>
        (issue.path.length ? issue.path.join('.') + ': ' : '') + issue.message).join('; '),
    };
  }
  const { schemaVersion: _schemaVersion, ...rule } = parsed.data;
  return { ok: true, rule };
}

const inRepoRulesDir = inRepoFallbackDir('rules', import.meta.url);

export function ruleRoots(): SelfDescribingRoot[] {
  return selfDescribingRoots({
    envVar: 'PAPERCUSP_RULES_DIR', devFallbackDir: inRepoRulesDir,
    userSubdir: RULES_USER_SUBDIR,
  });
}

/** The writable layer a Cupboard install lands in (it shadows the bundled floor). */
export function userRulesDir(): string {
  return papercuspPath(RULES_USER_SUBDIR);
}

export function readRuleDir(
  dir: string, ref: string, layer: SelfDescribingRoot['layer'] = 'user',
): LocalRule | null {
  try {
    const manifestPath = join(dir, RULE_MANIFEST);
    const listingPath = join(dir, 'listing.json');
    if (statSync(manifestPath).size > 64 * 1024 || statSync(listingPath).size > 32 * 1024) return null;
    const listing = JSON.parse(readFileSync(listingPath, 'utf8')) as Record<string, unknown> | null;
    if (!listing || typeof listing !== 'object' || Array.isArray(listing) ||
        (listing.kind !== 'rule' && listing.listing_kind !== 'rule' && listing.scope !== 'rule')) return null;
    const parsed = parseRulePackage(JSON.parse(readFileSync(manifestPath, 'utf8')));
    if (!parsed.ok) return null;
    // A listed version and its manifest cannot disagree about the selected pin.
    if (listing.version !== undefined && listing.version !== parsed.rule.version) return null;
    return { ...parsed.rule, ref, dir, layer } as LocalRule;
  } catch {
    return null;
  }
}

export function resolveLocalRule(
  idOrRef: string, roots: SelfDescribingRoot[] = ruleRoots(),
): LocalRule | null {
  const key = idOrRef.trim();
  if (!key) return null;
  return enumerateSelfDescribingDirs(roots, readRuleDir)
    .find((rule) => rule.ref === key || rule.id === key) ?? null;
}
