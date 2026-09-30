/**
 * Context authority for reusable code recipes.
 *
 * Recipes are globally discoverable capabilities, but their scripts often embed
 * concrete fleet/plan/harness/item/resource ids. A semantic match is not enough
 * to authorize recommending one of those scripts in a different lane. This
 * module derives the bound identities from the CURRENT stored script, matches
 * them against the caller's live context, and stamps the recommendation with a
 * content revision that recipes:run can revalidate.
 */
import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { checkScript, ensureParseCheckReady, type StaticToolCall } from '@papercusp/tooldef';
import { isAllHarnessSentinel } from './agent-tools/_harness-scope';
import { ANY_FAMILY_TERMINAL_STATES } from './work-item-dispatch-states';

export interface RecipeAuthorityRefs {
  workspaces: string[];
  fleets: string[];
  plans: string[];
  harnesses: string[];
  items: string[];
  resources: string[];
}

export interface RecipeAuthorityContext {
  workspace?: string | null;
  fleet?: string | null;
  plan?: string | null;
  harness?: string | null;
  items?: string[] | null;
  resources?: string[] | null;
}

type LiveClaimRow = { plan_slug: string; harness_slug: string; item_id: string };
type LiveWorkItemRow = { harness_slug: string; item_id: string };
type LiveResourceRow = { resource: string };

/**
 * Read the reuser's current plan/item/resource authority from the live
 * coordination stores. This belongs beside the static authority logic so both
 * recipes:search and recipes:run use the same authoritative measurement rather
 * than allowing either call site to drift (EI-23083788269370466).
 *
 * A caller must supply both SQL handles because the org work-item/plan claims
 * and host resource locks are intentionally stored in separate pools. The
 * caller owns the failure policy: search fails closed for bound recommendations
 * when this read rejects, while run reports an execution error.
 */
export async function resolveLiveBoundRefs(
  sql: postgres.Sql,
  resourceSql: postgres.Sql,
  ownerId: string,
  coordinationDomain: string,
): Promise<RecipeAuthorityRefs> {
  const [claims, workItems, resources] = await Promise.all([
    sql<LiveClaimRow[]>`
      SELECT DISTINCT plan_slug, harness_slug, item_id
        FROM harness_shared.plan_item_claims
       WHERE owner = ${ownerId} AND expires_ts > clock_timestamp()`,
    sql<LiveWorkItemRow[]>`
      SELECT DISTINCT harness_slug, feature_id AS item_id
        FROM harness_shared.work_items
       WHERE taken_by = ${ownerId}
         -- CROSS-FAMILY: this query has no item_kind filter, so it must use the
         -- cross-family union, not the issue-family list it used to spell by
         -- hand. That copy omitted BOTH 'dropped' (added to the issue set by
         -- EI-21921121818266895) and 'passed' (a feature terminal, 393 live
         -- rows), so a settled feature counted as a live claim here (D-068).
         AND NOT (status = ANY(${[...ANY_FAMILY_TERMINAL_STATES]}::text[]))`,
    resourceSql<LiveResourceRow[]>`
      SELECT DISTINCT resource
        FROM agent_resource_locks
       WHERE coordination_domain = ${coordinationDomain}
         AND owner = ${ownerId}
         AND status = 'held'
         AND expires_ts > clock_timestamp()`,
  ]);
  const unique = (values: string[]): string[] => [...new Set(values.filter(Boolean))].sort();
  return {
    workspaces: [],
    fleets: [],
    plans: unique(claims.map((row) => row.plan_slug)),
    harnesses: unique([...claims, ...workItems].map((row) => row.harness_slug)),
    items: unique([...claims, ...workItems].map((row) => row.item_id)),
    resources: unique(resources.map((row) => row.resource)),
  };
}

/**
 * WI-4946: WHICH construct made a script unprovable — the discriminator behind
 * `authority_unresolved`. Four structurally different conditions used to
 * collapse into one boolean and one message that listed every candidate cause
 * without saying which fired, so a caller could not tell an inherently opaque
 * script from an analyzer limitation, nor find the offending line. The reporter
 * of WI-4946 read the generic text and concluded their failure was a
 * harness-authority mismatch (it was an opaque `dev:pg_query`) — that
 * misdiagnosis is the cost this type exists to prevent.
 */
export type RecipeUnresolvedCause =
  /** The script calls a tool whose effects are inherently unprovable (raw SQL, shell, nested code:run). */
  | { kind: 'opaque-tool'; tool: string }
  /** `tools:invoke` with a dynamically-computed `name` — the dispatched tool is unknowable statically. */
  | { kind: 'dynamic-dispatch-target'; tool: string }
  /** A scoped-namespace call whose args are computed at runtime — the entities touched are unknowable. */
  | { kind: 'dynamic-scope-args'; tool: string }
  /** A coordination call embeds a sender/cursor that can be stale outside its original wake. */
  | { kind: 'volatile-coordination-args'; tool: string; keys: string[] }
  /** A recipe embeds a concrete agent owner id that can be retired or replaced between wakes. */
  | { kind: 'volatile-coordination-owner-id'; ownerId: string }
  /** A loop call writes caller-scoped session state whose values cannot be proved reusable. */
  | { kind: 'volatile-session-state'; tool: string }
  /**
   * The script PINS a run-scoped ephemeral artifact path (one run's `/tmp` log,
   * stamped with its own timestamp/pid), so re-running it can only ever re-read a
   * DEAD run — while its title still promises the *active* one.
   */
  | { kind: 'volatile-run-artifact-path'; tool: null; path: string }
  /** A work-item claim names a fixed assignee that this authority model cannot validate. */
  | { kind: 'fixed-claim-assignee'; tool: string }
  /** A recipe embeds one generated task-manager handle from a past/current run. */
  | { kind: 'volatile-task-id'; taskId: string }
  /** Tools were referenced but NO call could be statically resolved (dynamic/unsupported access form). */
  | { kind: 'unparsable-call-form'; tool: null };

export interface RecipeAuthorityDescriptor {
  refs: RecipeAuthorityRefs;
  /** Opaque dispatch/SQL/shell or dynamically scoped args cannot be proven safe. */
  unresolved: boolean;
  /**
   * WI-4946: which construct set `unresolved` (the FIRST one found), or null
   * when the script is resolvable. Optional so existing descriptor literals do
   * not strand; `deriveRecipeAuthority` always populates it.
   */
  unresolvedCause?: RecipeUnresolvedCause | null;
  bound: boolean;
}

export interface RecipeAuthorityProof {
  version: 1;
  revision: string;
  context: RecipeAuthorityContext;
}

/**
 * The inspection metadata returned by recipes:get. It deliberately carries the
 * script's stable refs, not a caller-bound proof. recipes:run may accept this
 * shape as a compatibility input, but must derive the proof context from these
 * refs and still validate it against the reuser's live lane.
 */
export interface RecipeAuthorityMetadata {
  version: 1;
  revision: string;
  refs: RecipeAuthorityRefs;
  requiresContext: boolean;
  runnable: boolean;
  /**
   * WI-40896 / D-048: whether `refs` is a COMPLETE measurement or a FLOOR.
   *
   * `inspectCall` returns its cause BEFORE calling `collectArgs` on the
   * offending call (see the `tools:invoke` dynamic-dispatch branch), so that
   * one call's identities are never collected. The caller loop deliberately
   * keeps inspecting every OTHER call, so `refs` is not emptied — it is
   * under-counted. Two shapes follow, and both used to render as a confident
   * answer:
   *   - dynamic call ALONE     -> `refs: {}` + `requiresContext: false`,
   *     indistinguishable from a recipe that genuinely needs no authority;
   *   - dynamic + static calls -> non-empty `refs` + `requiresContext: true`,
   *     which reads as a complete authority set while silently omitting
   *     whatever the dynamic call would have touched.
   *
   * This is the same boundedness marker the repo already requires beside a
   * count computed over a capped fetch: state the boundedness ON the value, so
   * a floor is never read as a total.
   *
   * NOT redundant with `runnable`, which is co-extensive with it TODAY.
   * `runnable` is a verdict about EXECUTION ("do not run this"); `refsMeasured`
   * scopes to the `refs`/`requiresContext` fields ("what you are reading
   * under-reports"). A consumer that uses `refs` for anything other than
   * run-gating — display, matching, impact analysis — is not guarded by
   * `runnable` at all, and the second shape above is exactly where it would be
   * misled.
   *
   * Optional so older stored/round-tripped payloads do not strand — and
   * deliberately so: absent reads as `undefined` → falsy → "not measured",
   * which fails CLOSED. `recipes:get` always populates it.
   */
  refsMeasured?: boolean;
  /**
   * WI-40896 / D-048: WHICH construct made the script unprovable, when one did.
   * The descriptor has always carried this (`RecipeAuthorityDescriptor.unresolvedCause`);
   * the recipes:get rendering simply dropped it, leaving a caller unable to tell
   * an unmeasurable script from a context-free one. Null when resolvable.
   */
  unresolvedCause?: RecipeUnresolvedCause | null;
}

/**
 * WI-40896 / D-048: the SOLE projection from an analysis descriptor to the
 * `recipes:get` authority metadata.
 *
 * Extracted so the discrimination it encodes — an authority that could not be
 * MEASURED versus one that is genuinely context-free — is assertable without
 * the tool's database scaffolding, and so the mapping lives in exactly one
 * place. Its being inlined at the call site is what let `refsMeasured` and
 * `unresolvedCause` go unrendered while the descriptor had carried them all
 * along: a projection nobody can test is a projection nobody notices dropping
 * a field.
 */
export function toRecipeAuthorityMetadata(
  descriptor: RecipeAuthorityDescriptor,
  revision: string,
): RecipeAuthorityMetadata {
  return {
    version: 1,
    revision,
    refs: descriptor.refs,
    requiresContext: descriptor.bound,
    runnable: !descriptor.unresolved,
    refsMeasured: !descriptor.unresolved,
    unresolvedCause: descriptor.unresolvedCause ?? null,
  };
}

export interface RecipeAuthorityRecommendation {
  proof: RecipeAuthorityProof;
  refs: RecipeAuthorityRefs;
}

const emptyRefs = (): RecipeAuthorityRefs => ({
  workspaces: [],
  fleets: [],
  plans: [],
  harnesses: [],
  items: [],
  resources: [],
});

const normPart = (value: string): string => value.replace(/[^a-z0-9]/gi, '').toLowerCase();
const splitTool = (tool: string): { ns: string; verb: string } => {
  const colon = tool.indexOf(':');
  const dot = tool.indexOf('.');
  const at = colon >= 0 ? colon : dot;
  return at < 0
    ? { ns: normPart(tool), verb: '' }
    : { ns: normPart(tool.slice(0, at)), verb: normPart(tool.slice(at + 1)) };
};

const strings = (value: unknown): string[] => {
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value.flatMap(strings);
};

const add = (target: Set<string>, value: unknown): void => {
  for (const item of strings(value)) target.add(item);
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const SCOPE_NAMESPACES = new Set(['plans', 'workitems', 'fleet', 'harness', 'locks', 'resource', 'resources']);
const OPAQUE_TOOLS = new Set(['dev:pgquery', 'capability:bash', 'capability:script', 'code:run']);
// Loop/session state is owned by the CURRENT caller, not by the recipe. A saved
// loop:checkpoint carries a prior wake's did/left/next state and can overwrite
// the reuser's live carry note; loop:arm can replace the reuser's active mission
// and cadence; loop:end can stop the reuser's loop. There is no entity proof
// dimension for these caller-scoped mutations, so fail closed instead of
// treating them as generic recipes.
const VOLATILE_SESSION_STATE_TOOLS = new Set(['loop:checkpoint', 'loop:arm', 'loop:end']);
// Coordination cursors and sender ids describe a momentary conversation, not a
// reusable lane. A saved recipe carrying one must fail closed: neither the
// recipe's stable entity refs nor a later authority proof can prove that the
// old leader/cursor is still the right one.
const VOLATILE_COORDINATION_ARG_KEYS = new Set([
  'from',
  'sender',
  'senderid',
  'since',
  'sincets',
  'cursor',
  'after',
  'afterts',
  'before',
  'beforets',
]);

// Agent owner ids are session identities, not durable lane authority. A saved
// coordination recipe that filters or targets a literal su UUID can silently
// report an old owner as absent (or address the wrong owner) after a respawn or
// fleet rotation. Keep this deliberately narrow: ordinary UUIDs in a recipe
// may be durable domain data, while the `su-` owner prefix is the coordination
// identity shape that must be resolved from the current live context.
// coord:send and the other coordination tools accept unique short owner selectors
// (for example `su-f765ba8b`) as well as full UUID owner ids. A recipe can freeze
// either form, so keep the full UUID alternative first to avoid truncating it to
// its first hex segment, then recognize the short 4-64-hex owner-label form.
const VOLATILE_COORDINATION_OWNER_ID =
  /\bsu-(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{4,64})\b/i;

export function findVolatileCoordinationOwnerId(script: string): string | null {
  return script.match(VOLATILE_COORDINATION_OWNER_ID)?.[0] ?? null;
}

/**
 * The task manager's default `newTaskId()` shape is a 9-character base-36
 * timestamp followed by a 10-character base-36 random suffix. A literal of
 * that exact shape names one process/run, not a reusable recipe input. Keep the
 * check on static string literals so a task id resolved from the current live
 * process state or supplied through `inputs` remains a valid reusable shape.
 *
 * This is deliberately whole-script rather than call-argument analysis: the
 * motivating recipe hoisted three ids into `const ids = [...]` and passed each
 * through a loop, so `parse-check` correctly marked the call argument dynamic
 * while dropping the literal values that made the recipe stale.
 */
const VOLATILE_TASK_ID_LITERAL = /^(?=[0-9a-z]{19}$)(?=[0-9a-z]*\d)(?=[0-9a-z]*[a-z])[0-9a-z]{19}$/;

export function findVolatileTaskIdLiteral(script: string): string | null {
  for (const match of script.matchAll(SCRIPT_STRING_LITERAL)) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value && VOLATILE_TASK_ID_LITERAL.test(value)) return value;
  }
  return null;
}

/**
 * Filesystem roots whose contents belong to ONE process/run, never to a lane.
 * A path here is an artifact, not an address.
 */
const EPHEMERAL_PATH_ROOTS = ['/tmp/', '/var/tmp/', '/var/folders/', '/run/', '/dev/shm/'];

/**
 * A path fragment that pins ONE run: a calendar/ISO stamp
 * (`2026-08-13T13-14-14-693Z`) or a long digit run (epoch-ms / pid).
 */
const RUN_SCOPED_PATH_TOKEN = /\d{4}-\d{2}-\d{2}|\d{8,}/;

/** A manual checkpoint unit's log is run-scoped even when its unit id has no timestamp. */
const MANUAL_CHECKPOINT_UNIT_LOG = /^papercup-green-checkpoint-manual-[a-z0-9-]+\.log$/i;

/** capability:bash spills each run to this fixed directory with its job id in the filename. */
const CAPABILITY_BASH_SCRATCH_LOG = /^papercusp-capability\/scratch\/bash-[^/]+\.log$/i;

/** Persisted checkpoint logs encode the base/candidate identity in their filename. */
const PERSISTED_CHECKPOINT_LOG_PATH = /(?:^|\/)\.papercusp\/checkpoint-logs\/[^/]+-base-[^/]+-cand-[^/]+\.log$/i;

/** Quoted literals, skipping any template that interpolates (`$` excluded): a
 *  path BUILT at runtime is derived-from-live-state and therefore fine. */
const SCRIPT_STRING_LITERAL = /'([^'\\\n]*)'|"([^"\\\n]*)"|`([^`\\$]*)`/g;

/**
 * The run-scoped ephemeral artifact path a script PINS, or null.
 *
 * EI-20480226881133232: a recipe titled "read the ACTIVE checkpoint log" froze the
 * one run's `/tmp/…-2026-08-13T13-14-14-693Z.log` into a `const`, then reported that
 * dead run's terminal red as the live gate's verdict — for 11 runs. The literal is not
 * a tool ARGUMENT (it reaches `capability:read` through a variable), so no call-level
 * inspection can see it; the binding is a property of the SCRIPT, which is what this
 * module already claims to derive its identities from. Same family as the volatile
 * coordination-cursor / session-carry causes: a momentary thing saved as a reusable one.
 */
export function findVolatileRunArtifactLiteral(script: string): string | null {
  for (const match of script.matchAll(SCRIPT_STRING_LITERAL)) {
    const value = match[1] ?? match[2] ?? match[3];
    if (!value) continue;
    const root = EPHEMERAL_PATH_ROOTS.find((r) => value.toLowerCase().startsWith(r));
    if (root) {
      const rootRelativePath = value.slice(root.length);
      if (
        RUN_SCOPED_PATH_TOKEN.test(rootRelativePath) ||
        MANUAL_CHECKPOINT_UNIT_LOG.test(rootRelativePath) ||
        CAPABILITY_BASH_SCRATCH_LOG.test(rootRelativePath)
      ) {
        return value;
      }
    }
    if (PERSISTED_CHECKPOINT_LOG_PATH.test(value)) return value;
  }
  return null;
}

/** Collect known authority keys from one statically projected argument object. */
function collectArgs(
  tool: string,
  value: unknown,
  out: Record<keyof RecipeAuthorityRefs, Set<string>>,
): void {
  const args = asRecord(value);
  if (!args) return;
  const normalized = new Map(Object.entries(args).map(([key, val]) => [normPart(key), val]));
  const { ns } = splitTool(tool);

  add(out.workspaces, normalized.get('workspace') ?? normalized.get('workspaceid'));
  add(out.fleets, normalized.get('fleet') ?? normalized.get('fleetslug'));
  add(out.plans, normalized.get('plan') ?? normalized.get('planslug'));
  add(out.harnesses, normalized.get('harness') ?? normalized.get('harnessslug'));
  add(out.items, normalized.get('item') ?? normalized.get('itemid'));
  add(out.items, normalized.get('itemids'));
  // `planItems` is the plan-lane claim carried by coord:orient / coord:declare-intent — a
  // recipe that passes it CLAIMS those items. Capture them as authority refs so the recommender
  // only surfaces such a recipe to a caller who ALREADY holds that exact lane, instead of one on
  // the same plan but a different item (EI-12213: else running the recipe steals another lane).
  add(out.items, normalized.get('planitems'));
  add(out.resources, normalized.get('resource') ?? normalized.get('resourceid'));
  add(out.resources, normalized.get('resources'));

  if (ns === 'plans') add(out.plans, normalized.get('slug'));
  if (ns === 'workitems') add(out.items, normalized.get('id') ?? normalized.get('ids'));
  if (ns === 'fleet') add(out.fleets, normalized.get('slug') ?? normalized.get('id'));
  if (ns === 'harness') add(out.harnesses, normalized.get('slug') ?? normalized.get('id'));
  if (ns === 'locks' || ns === 'resource' || ns === 'resources') {
    add(out.resources, normalized.get('name'));
  }

  const itemRows = normalized.get('items');
  if (Array.isArray(itemRows)) {
    for (const row of itemRows) {
      if (typeof row === 'string') {
        out.items.add(row);
        continue;
      }
      const rec = asRecord(row);
      if (!rec) continue;
      add(out.items, rec.item ?? rec.itemId ?? rec.item_id ?? rec.id);
      add(out.workspaces, rec.workspace ?? rec.workspaceId ?? rec.workspace_id);
      add(out.fleets, rec.fleet ?? rec.fleetSlug ?? rec.fleet_slug);
      add(out.plans, rec.plan ?? rec.planSlug ?? rec.plan_slug ?? rec.slug);
      add(out.harnesses, rec.harness ?? rec.harnessSlug ?? rec.harness_slug);
      add(out.resources, rec.resource ?? rec.resourceId ?? rec.resource_id ?? rec.name);
    }
  }
}

/**
 * Collect a call's authority refs into `out` and report WHY it is unprovable,
 * or null when it is fine. WI-4946: this used to return a bare boolean, which
 * is what erased the discriminator all the way out to the caller's error.
 */
function inspectCall(
  call: StaticToolCall,
  out: Record<keyof RecipeAuthorityRefs, Set<string>>,
): RecipeUnresolvedCause | null {
  const normalizedTool = call.tool.includes(':')
    ? `${normPart(call.tool.split(':', 1)[0])}:${normPart(call.tool.slice(call.tool.indexOf(':') + 1))}`
    : `${splitTool(call.tool).ns}:${splitTool(call.tool).verb}`;
  const { ns } = splitTool(call.tool);

  // A statically projected tools:invoke is transparent: inspect the inner tool
  // and args. A dynamic wrapper target is opaque and therefore fails closed.
  if (ns === 'tools' && splitTool(call.tool).verb === 'invoke') {
    const wrapper = asRecord(call.args);
    const innerName = wrapper?.name;
    if (typeof innerName !== 'string') {
      return { kind: 'dynamic-dispatch-target', tool: call.tool };
    }
    const inner: StaticToolCall = {
      tool: innerName,
      args: wrapper?.args ?? null,
      dynamicArgs: call.dynamicArgs || wrapper?.args === undefined,
    };
    return inspectCall(inner, out);
  }

  collectArgs(call.tool, call.args, out);

  // `work_items:claim` still supports the compact positional write form used by
  // Tier-3 prompt encoding: { row: "<id>,<assignee>,<harness>" }. The generic
  // authority collector cannot see identities hidden in that CSV string, so
  // extract the item + harness here. A fixed assignee is deliberately not
  // reusable: the authority model has no live target-agent dimension, and
  // recommending it to another session could silently assign the claim away
  // from the caller.
  if (normalizedTool === 'workitems:claim') {
    const args = asRecord(call.args);
    const row = args?.row;
    if (typeof row === 'string') {
      const [id, assignee, harness] = row.split(',').map((part) => part.trim());
      add(out.items, id);
      add(out.harnesses, harness);
      if (assignee) return { kind: 'fixed-claim-assignee', tool: call.tool };
    }
    const assignee = args?.assignee;
    if (typeof assignee === 'string' && assignee.trim()) {
      return { kind: 'fixed-claim-assignee', tool: call.tool };
    }
  }

  if (OPAQUE_TOOLS.has(normalizedTool)) {
    return { kind: 'opaque-tool', tool: call.tool };
  }
  if (VOLATILE_SESSION_STATE_TOOLS.has(normalizedTool)) {
    return { kind: 'volatile-session-state', tool: call.tool };
  }
  if (ns === 'coord') {
    const args = asRecord(call.args);
    const volatileKeys = args
      ? Object.keys(args)
          .filter((key) => VOLATILE_COORDINATION_ARG_KEYS.has(normPart(key)))
          .sort()
      : [];
    if (volatileKeys.length > 0) {
      return { kind: 'volatile-coordination-args', tool: call.tool, keys: volatileKeys };
    }
  }
  if (call.dynamicArgs && SCOPE_NAMESPACES.has(ns)) {
    return { kind: 'dynamic-scope-args', tool: call.tool };
  }
  return null;
}

export async function deriveRecipeAuthority(script: string): Promise<RecipeAuthorityDescriptor> {
  await ensureParseCheckReady();
  // An empty catalog is intentional: call inspection still resolves dotted
  // members and tools.call names; authority matching normalizes both spellings.
  const analysis = checkScript(script, []);
  const sets: Record<keyof RecipeAuthorityRefs, Set<string>> = {
    workspaces: new Set(),
    fleets: new Set(),
    plans: new Set(),
    harnesses: new Set(),
    items: new Set(),
    resources: new Set(),
  };
  // Every call is still inspected (inspectCall collects refs as a side effect,
  // so short-circuiting on the first cause would silently narrow `refs`); we
  // just remember WHICH one first made the script unprovable.
  let unresolvedCause: RecipeUnresolvedCause | null = null;
  for (const call of analysis.calls) {
    const cause = inspectCall(call, sets);
    if (cause && !unresolvedCause) unresolvedCause = cause;
  }

  // A pinned run-scoped artifact path is invisible to call inspection when it
  // reaches the tool through a variable, so it is checked over the script source.
  if (!unresolvedCause) {
    const artifactPath = findVolatileRunArtifactLiteral(script);
    if (artifactPath) {
      unresolvedCause = { kind: 'volatile-run-artifact-path', tool: null, path: artifactPath };
    }
  }

  // A generated task-manager id is a run-scoped handle. A literal survives in
  // the saved recipe after the process it names has ended (or been replaced),
  // even when it is hoisted into an array/const and therefore invisible to
  // static call-argument collection.
  if (!unresolvedCause) {
    const taskId = findVolatileTaskIdLiteral(script);
    if (taskId) unresolvedCause = { kind: 'volatile-task-id', taskId };
  }

  // A coordination recipe must resolve its target owner from the current
  // session/fleet state. A literal su UUID is a momentary identity and remains
  // stale even when the surrounding coord call has no cursor-like argument.
  if (!unresolvedCause) {
    const ownerId = findVolatileCoordinationOwnerId(script);
    if (ownerId) {
      unresolvedCause = { kind: 'volatile-coordination-owner-id', ownerId };
    }
  }

  // A script that statically referenced tools but yielded no inspectable calls
  // used a dynamic/unsupported access form; do not recommend it as generic.
  if (!unresolvedCause && analysis.refs.length > 0 && analysis.calls.length === 0) {
    unresolvedCause = { kind: 'unparsable-call-form', tool: null };
  }

  const refs = emptyRefs();
  for (const key of Object.keys(refs) as Array<keyof RecipeAuthorityRefs>) {
    refs[key] = [...sets[key]].sort();
  }
  const bound = Object.values(refs).some((values) => values.length > 0);
  return { refs, unresolved: unresolvedCause !== null, bound, unresolvedCause };
}

const hasAll = (required: readonly string[], actual: readonly string[]): boolean => {
  const set = new Set(actual);
  return required.every((value) => set.has(value));
};

export function normalizeRecipeAuthorityContext(context: RecipeAuthorityContext = {}): RecipeAuthorityContext {
  const unique = (values: string[] | null | undefined): string[] | undefined =>
    values?.length ? [...new Set(values.filter(Boolean))].sort() : undefined;
  const items = unique(context.items);
  const resources = unique(context.resources);
  return {
    ...(context.workspace ? { workspace: context.workspace } : {}),
    ...(context.fleet ? { fleet: context.fleet } : {}),
    ...(context.plan ? { plan: context.plan } : {}),
    ...(context.harness ? { harness: context.harness } : {}),
    ...(items ? { items } : {}),
    ...(resources ? { resources } : {}),
  };
}

/**
 * Convert recipes:get's stable inspection refs into the proof context accepted
 * by recipes:run. Scalar refs are only representable when there is one value;
 * omitting an ambiguous scalar makes recipeAuthorityMatches fail closed. The
 * set-valued plan/item/resource refs are retained so the run handler can also
 * re-check that the reuser still holds them.
 */
export function recipeAuthorityContextFromRefs(refs: RecipeAuthorityRefs): RecipeAuthorityContext {
  const one = (values: readonly string[]): string | undefined => (values.length === 1 ? values[0] : undefined);
  return normalizeRecipeAuthorityContext({
    workspace: one(refs.workspaces),
    fleet: one(refs.fleets),
    plan: one(refs.plans),
    harness: one(refs.harnesses),
    items: refs.items,
    resources: refs.resources,
  });
}

/** Build the comparison context for code:run's near-duplicate search from the
 * source script itself. Multi-scalar scripts remain intentionally unmatched —
 * there is no single active fleet/plan/harness identity to prove. */
export function recipeAuthorityContextFromDescriptor(
  descriptor: RecipeAuthorityDescriptor,
  base: RecipeAuthorityContext = {},
): RecipeAuthorityContext {
  const one = (values: string[]): string | undefined => (values.length === 1 ? values[0] : undefined);
  return normalizeRecipeAuthorityContext({
    workspace: base.workspace ?? one(descriptor.refs.workspaces),
    fleet: base.fleet ?? one(descriptor.refs.fleets),
    plan: base.plan ?? one(descriptor.refs.plans),
    harness: base.harness ?? one(descriptor.refs.harnesses),
    items: [...(base.items ?? []), ...descriptor.refs.items],
    resources: [...(base.resources ?? []), ...descriptor.refs.resources],
  });
}

/**
 * EI-20186804943808838 / EI-12692: `'*'` (friendly alias `'all'`) is the canonical
 * operator/superuser scope sentinel — `http-projection` sets `ctx.harnessSlug = '*'` on
 * EVERY superuser/operator-scope call (see `agent-tools/_harness-scope.ts`, which the
 * sibling call sites that thread ctx into a real predicate already guard against). It
 * means "every harness in this workspace", so a session carrying it IS inside the lane of
 * any concrete-harness recipe. Comparing it with `===` locked every su session out of every
 * harness-bound recipe — unrepairably, since the rejection lands on the server-derived live
 * context that no caller-supplied proof can influence.
 *
 * Honoured ONLY for a SERVER-DERIVED context (the live session scope, and the search context
 * the recommender builds from it) — NEVER for the caller-carried proof, where a hand-written
 * `'*'` would otherwise be a skeleton key. That asymmetry is the security property, so this
 * defaults to the strict comparison: a new call site cannot opt into the loose one by
 * accident, only deliberately. It is also deliberately confined to the HARNESS scalar —
 * workspace is a tenant boundary and stays strict even under operator scope.
 */
export interface RecipeAuthorityMatchOptions {
  /** Treat the operator-scope `'*'`/`'all'` harness sentinel as satisfying a concrete
   *  harness binding. Pass ONLY for a server-derived context. */
  operatorScope?: boolean;
}

export function recipeAuthorityMatches(
  descriptor: RecipeAuthorityDescriptor,
  context: RecipeAuthorityContext = {},
  options: RecipeAuthorityMatchOptions = {},
): boolean {
  if (descriptor.unresolved) return false;
  const c = normalizeRecipeAuthorityContext(context);
  const scalar = (
    required: readonly string[],
    actual: string | null | undefined,
    allowOperatorScope = false,
  ): boolean =>
    required.length === 0 ||
    (Boolean(actual) &&
      ((allowOperatorScope && isAllHarnessSentinel(actual)) ||
        required.every((value) => value === actual)));
  return (
    scalar(descriptor.refs.workspaces, c.workspace) &&
    scalar(descriptor.refs.fleets, c.fleet) &&
    scalar(descriptor.refs.plans, c.plan) &&
    scalar(descriptor.refs.harnesses, c.harness, options.operatorScope === true) &&
    (descriptor.refs.items.length === 0 || hasAll(descriptor.refs.items, c.items ?? [])) &&
    (descriptor.refs.resources.length === 0 || hasAll(descriptor.refs.resources, c.resources ?? []))
  );
}

/**
 * Revalidate the bound set-valued identities against authoritative live state.
 * The recommendation proof is caller-carried and therefore cannot itself prove
 * that a plan/item/resource is still held by the reuser at execution time.
 */
export function recipeAuthorityMatchesLiveRefs(
  descriptor: RecipeAuthorityDescriptor,
  liveRefs: Partial<RecipeAuthorityRefs>,
): boolean {
  return (
    hasAll(descriptor.refs.plans, liveRefs.plans ?? []) &&
    hasAll(descriptor.refs.items, liveRefs.items ?? []) &&
    hasAll(descriptor.refs.resources, liveRefs.resources ?? [])
  );
}

export interface RecipeRevisionContract {
  bindingSchema?: unknown | null;
  capabilityManifest?: unknown | null;
}

function canonicalContractJson(value: unknown): string {
  const normalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map((item) => normalize(item === undefined ? null : item));
    if (candidate && typeof candidate === 'object') {
      return Object.fromEntries(
        Object.entries(candidate as Record<string, unknown>)
          .filter(([, item]) => item !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, normalize(item)]),
      );
    }
    return candidate;
  };
  return JSON.stringify(normalize(value));
}

/**
 * Exact executable-revision hash. Legacy rows retain their historical
 * updatedAt+script digest; once a versioned contract exists, both declarations
 * join the material so a binding/requirement change invalidates old proofs even
 * when the source text is unchanged.
 */
export function recipeRevision(
  script: string,
  updatedAt: string,
  contract: RecipeRevisionContract = {},
): string {
  const hash = createHash('sha256').update(updatedAt).update('\0').update(script);
  if (contract.bindingSchema != null || contract.capabilityManifest != null) {
    hash
      .update('\0recipe-contract-v1\0')
      .update(canonicalContractJson(contract.bindingSchema ?? null))
      .update('\0')
      .update(canonicalContractJson(contract.capabilityManifest ?? null));
  }
  return hash.digest('hex');
}

export async function buildRecipeAuthorityRecommendation(input: {
  script: string;
  updatedAt: string;
  bindingSchema?: unknown | null;
  capabilityManifest?: unknown | null;
  context?: RecipeAuthorityContext;
}): Promise<RecipeAuthorityRecommendation | null> {
  const descriptor = await deriveRecipeAuthority(input.script);
  // Server-derived: this context is built from the live session, not caller input.
  if (!recipeAuthorityMatches(descriptor, input.context, { operatorScope: true })) return null;
  return {
    proof: {
      version: 1,
      revision: recipeRevision(input.script, input.updatedAt, input),
      // EI-21163571260786543: the proof's context states what the RECIPE itself is bound
      // to (descriptor.refs) — NEVER an unfiltered echo of the caller's live context.
      // `input.context` only had to be a SUPERSET of the descriptor's refs to pass the
      // `recipeAuthorityMatches` check above (workspace/fleet/harness are always populated
      // from the caller's live session by recipes:search, and a caller may pass its own
      // items/resources too) — so echoing it verbatim let a recipe with NO bound identity at
      // all (descriptor.bound === false, e.g. one that freezes an unrecognized owner/window
      // literal — `subject`/`since` args a namespace-agnostic script consumes — outside any
      // authority-tracked argument key) be advertised as "bound" to whatever fleet/harness/
      // item/resource the CALLER happened to be working in, even though the script's own
      // hardcoded identity/window has nothing to do with it. `recipeAuthorityContextFromRefs`
      // derives ONLY what the descriptor actually proved is referenced — for an unbound
      // recipe that is `{}`, so recipes:search can no longer misreport a context-free recipe
      // as scoped to the caller's own subject. This also subsumes the old operator-scope
      // sentinel rewrite (`resolveOperatorScopeLane`): the harness value here is always
      // read from `descriptor.refs.harnesses`, so a caller-carried `'*'`/`'all'` sentinel is
      // never echoed into a stored proof in the first place.
      context: recipeAuthorityContextFromRefs(descriptor.refs),
    },
    refs: descriptor.refs,
  };
}

/**
 * Human-actionable detail for each authority failure code — surfaced alongside
 * `error` (which stays the stable machine-matched string) so a caller who hits
 * `authority_unresolved` on a NESTED `tools.recipes.run(...)` composition (the
 * recurring confusion behind EI-12057 — "wrapper recipes that call recipes:run
 * are unusable") can tell an INHERENT, working-as-designed limitation (the
 * target recipe embeds an opaque/unprovable call — SQL, shell, or a nested
 * code:run — so NO proof, nested or top-level, can ever authorize it; run its
 * script directly via code:run instead) apart from a merely MISSING proof
 * (`authority_required` — obtain one via recipes:search's recommendation, or
 * supply matching `authority.context`), which a fresh proof CAN fix.
 */
/**
 * WI-4946: build the `authority_unresolved` reason, LEADING with the specific
 * construct that fired rather than listing all four and leaving the caller to
 * guess. Passing `null` yields the generic form (the pre-WI-4946 text), which
 * is what a caller sees only if no cause was recorded.
 *
 * Note the deliberate asymmetry in the tail: three of the causes are inherent
 * properties of the script and genuinely permanent, but `unparsable-call-form`
 * means the ANALYZER could not read the call — that is a tooling limitation,
 * and claiming it is "by design" would be a confidently wrong answer of exactly
 * the kind this discriminator exists to stop.
 */
function unresolvedReason(cause: RecipeUnresolvedCause | null | undefined): string {
  const workaround =
    'run the script directly via code:run instead (inline it, or code:run { script: "return await ' +
    'tools.recipes.get({ id }).then(r => /* run r.script yourself */)" }).';
  const permanent =
    'so NO authority proof (including from a NESTED tools.recipes.run(...) call inside another recipe) can ever ' +
    'authorize running it via recipes:run. This is a permanent, by-design limitation, not a transient failure: ';

  switch (cause?.kind) {
    case 'opaque-tool':
      return (
        `the recipe script calls \`${cause.tool}\`, an opaque/unprovable tool call whose effects cannot be ` +
        `statically verified ` +
        `(raw SQL via dev:pg_query, a shell via capability:bash/capability:script, or a nested code:run) — ` +
        `${permanent}${workaround} NOTE: this is a property of the SCRIPT, not of your session — it is not a ` +
        `harness/workspace authority mismatch, and re-running it from a different harness will fail identically.`
      );
    case 'dynamic-dispatch-target':
      return (
        'the recipe script calls `tools:invoke` with a dynamically-computed `name`, so the tool actually ' +
        `dispatched cannot be known before the script runs — ${permanent}${workaround} If the target IS static, ` +
        'spell it as a string literal (tools:invoke { name: "server:verb" }) and the call becomes provable.'
      );
    case 'dynamic-scope-args':
      return (
        `the recipe script calls \`${cause.tool}\` with dynamically-computed arguments in a scoped namespace ` +
        '(plan/item/fleet/harness/lock/resource), so the exact entities it would touch cannot be known before ' +
        `it runs — ${permanent}${workaround} If the arguments ARE fixed, spell them as literals and the call ` +
        'becomes provable.'
      );
    case 'volatile-coordination-args':
      return (
        `the recipe script calls \`${cause.tool}\` with volatile coordination sender/cursor argument(s) ` +
        `${cause.keys.map((key) => `\`${key}\``).join(', ')}, so its saved leader or inbox position can be stale ` +
        'when reused in a later wake — no authority proof can safely revalidate a momentary conversation cursor. ' +
        'Rewrite the recipe to derive the current sender/cursor from live context, or run the script directly via ' +
        'code:run; until then it is not safely reusable through recipes:run.'
      );
    case 'volatile-session-state':
      return (
        `the recipe script calls \`${cause.tool}\`, which writes caller-scoped session carry state whose values ` +
        'cannot be proved current for a later wake — reusing it could overwrite the caller\'s live carry note with ' +
        'stale lane facts or mutate the caller\'s active loop mission/cadence. No authority proof can safely ' +
        'authorize this saved state mutation; do not reuse this recipe. Re-author the loop state from the current ' +
        'session only after inspecting the values.'
      );
    case 'volatile-run-artifact-path':
      return (
        `the recipe script pins the run-scoped ephemeral artifact path \`${cause.path}\`, which belongs to ONE ` +
        'past run — re-running it re-reads a DEAD artifact and reports that finished run\'s phase/verdict as if it ' +
        'were the live one. No authority proof can revalidate a frozen temp path. Re-author the recipe to RESOLVE ' +
        'the current path from the live authority (the active run-lock / systemd unit / the owning tool\'s own ' +
        'status read) and assert that the run identity it returns matches that live authority, or run the script ' +
        'directly via code:run against a path you resolved this turn.'
      );
    case 'volatile-task-id':
      return (
        `the recipe script embeds the concrete task-manager id \`${cause.taskId}\`, which names ONE ` +
        'current or past process run rather than a reusable entity — re-running it can inspect, wait on, or ' +
        'control an unrelated/ended task while appearing to audit the current lane. Declare the task handle as a ' +
        'runtime binding or resolve it from live process authority each run; no authority proof can make a frozen ' +
        'task id reusable.'
      );
    case 'volatile-coordination-owner-id':
      return (
        `the recipe script embeds the concrete agent owner id \`${cause.ownerId}\`, which is a volatile ` +
        'coordination identity that can be retired or replaced after a respawn/fleet rotation — a saved ' +
        'presence check or owner-targeted action can therefore report the wrong lane. Resolve the current ' +
        'owner from live coordination state, or run the script directly via code:run; until then it is not ' +
        'safely reusable through recipes:run.'
      );
    case 'fixed-claim-assignee':
      return (
        `the recipe script calls \`${cause.tool}\` with a fixed work-item assignee, but the authority proof ` +
        'has no target-agent dimension to verify that assignment against the current session — the recipe could ' +
        'silently claim work for a different agent. Remove the explicit assignee and let the live caller identity ' +
        'own the claim, or run the script directly via code:run.'
      );
    case 'unparsable-call-form':
      return (
        'the recipe script references tools but the analyzer could not statically resolve ANY call in it — a ' +
        'dynamic or unsupported access form (a computed member, an aliased dispatch handle, or a call built at ' +
        'runtime). Unlike the other authority_unresolved causes this is an ANALYZER limitation rather than a ' +
        'proven property of the script, so it may become provable if the script is rewritten to call tools by ' +
        `literal name. Until then no proof can be derived: ${workaround}`
      );
    default:
      return (
        'the recipe script itself contains an opaque/unprovable tool call (raw SQL via dev:pg_query, a shell via ' +
        'capability:bash/capability:script, a nested code:run, or a dynamically-computed plan/item/fleet/harness/' +
        `resource argument) — its bound identities cannot be statically verified, ${permanent}${workaround}`
      );
  }
}

const AUTHORITY_ERROR_REASONS: Record<string, string> = {
  authority_unresolved: unresolvedReason(null),
  authority_required:
    'the recipe references specific bound entities (a plan/item/fleet/harness/resource) and no `authority` proof ' +
    'was supplied — this includes a NESTED tools.recipes.run(...) call from inside another recipe\'s script, which ' +
    'has no way to construct one. Obtain a proof via a recipes:search recommendation (its runArgs carries a ready ' +
    '`authority`), or call recipes:run { id, authority } directly with a context matching your live session.',
  authority_version_unsupported: 'the supplied `authority.version` is not 1 — obtain a fresh proof rather than hand-building one.',
  authority_stale_revision:
    'the recipe\'s script/updatedAt changed since the `authority` proof was issued (its revision hash no longer ' +
    'matches) — the recipe was edited; re-derive the proof (recipes:search again) before running.',
  authority_entity_mismatch:
    'the `authority` proof\'s bound entities do not match either the recipe\'s own script OR your CURRENT live ' +
    'session context (workspace/fleet/harness/plan/items/resources) — a proof only authorizes the exact lane it ' +
    'was issued for.',
};

export async function validateRecipeAuthorityProof(input: {
  script: string;
  updatedAt: string;
  bindingSchema?: unknown | null;
  capabilityManifest?: unknown | null;
  proof?: RecipeAuthorityProof | null;
  liveContext?: RecipeAuthorityContext;
}): Promise<{ ok: true; descriptor: RecipeAuthorityDescriptor } | { ok: false; error: string; reason: string }> {
  // WI-4946: `authority_unresolved` reports WHICH construct fired; every other
  // code keeps its static text.
  const fail = (
    error: string,
    cause?: RecipeUnresolvedCause | null,
  ): { ok: false; error: string; reason: string } => ({
    ok: false,
    error,
    reason:
      error === 'authority_unresolved'
        ? unresolvedReason(cause)
        : (AUTHORITY_ERROR_REASONS[error] ?? error),
  });
  const descriptor = await deriveRecipeAuthority(input.script);
  if (descriptor.unresolved) return fail('authority_unresolved', descriptor.unresolvedCause);
  if (!input.proof) {
    return descriptor.bound ? fail('authority_required') : { ok: true, descriptor };
  }
  if (input.proof.version !== 1) return fail('authority_version_unsupported');
  if (input.proof.revision !== recipeRevision(input.script, input.updatedAt, input)) {
    return fail('authority_stale_revision');
  }
  if (!recipeAuthorityMatches(descriptor, input.proof.context)) {
    return fail('authority_entity_mismatch');
  }
  if (input.liveContext) {
    // workspace/fleet/harness come from the dispatch context/presence store.
    // Never fall back to the caller-carried proof when one is absent live: a
    // fabricated fleet in a valid-looking proof must fail closed.
    const scalarDescriptor: RecipeAuthorityDescriptor = {
      ...descriptor,
      refs: {
        ...descriptor.refs,
        plans: [],
        items: [],
        resources: [],
      },
    };
    // Server-derived live scope (presence + ctx), so the operator-scope sentinel is
    // trustworthy here. The proof check above stays STRICT — see recipeAuthorityMatches.
    if (!recipeAuthorityMatches(scalarDescriptor, input.liveContext, { operatorScope: true })) {
      return fail('authority_entity_mismatch');
    }
  }
  return { ok: true, descriptor };
}
