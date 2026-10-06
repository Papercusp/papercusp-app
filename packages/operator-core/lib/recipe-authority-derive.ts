/**
 * Pure static derivation of a recipe script's authority descriptor.
 *
 * Extracted from `recipe-authority.ts` (P-007, cupboard-release-pipeline-content-trust)
 * so the Cupboard Worker can run the SAME analysis server-side at publish time instead
 * of trusting a publisher's self-reported `authorityUnresolved` (D-005: the Worker
 * verifies, never launders). `recipe-authority.ts` also pulls postgres types, the
 * `@papercusp/tooldef` BARREL (which drags in @opentelemetry/* and MDX/JSX) and the
 * harness-scope helpers, none of which bundle for a Worker — measured: wrangler
 * dry-run exits 1 `Could not resolve @opentelemetry/*` when the barrel is reachable.
 *
 * So this module may import ONLY the `@papercusp/tooldef/parse-check` subpath (the
 * TypeScript-AST `checkScript`; spike D-010 measured it at ~1.7 MiB gzipped, inside
 * the Worker limit) — never `@papercusp/tooldef` itself, `node:*`, or anything with
 * I/O. `recipe-authority.ts` re-exports everything here, so existing callers are
 * unchanged. A guard test pins the import allowlist.
 */
import { checkScript, ensureParseCheckReady, type StaticToolCall } from '@papercusp/tooldef/parse-check';

export interface RecipeAuthorityRefs {
  workspaces: string[];
  fleets: string[];
  plans: string[];
  harnesses: string[];
  items: string[];
  resources: string[];
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
  /** A recipe pins a native session UUID in a session id slot rather than resolving it per run. */
  | { kind: 'volatile-session-id-literal'; sessionId: string }
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
 * Native agent sessions use UUID-shaped ids, optionally prefixed by their
 * source (`claude:<uuid>`). A fixed value in a sessionId/session_id slot names
 * one past or current reporter, so reusing the recipe can quietly inspect the
 * wrong person's activity. Keep this slot-scoped: unrelated stable UUIDs in a
 * recipe are not session authority. Runtime values and validated `inputs`
 * bindings do not match the static-literal prefix.
 */
const VOLATILE_SESSION_ID_LITERAL =
  /^(?:[a-z][a-z0-9_-]*:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_ID_LITERAL_PREFIX =
  /(?:\b(?:const|let|var)\s+[\w$]*session_?ids?\s*=\s*(?:\[\s*)?|\bsession_?ids?\s*:\s*(?:\[\s*)?)$/i;

export function findVolatileSessionIdLiteral(script: string): string | null {
  for (const match of script.matchAll(SCRIPT_STRING_LITERAL)) {
    const value = match[1] ?? match[2] ?? match[3];
    if (!value || !VOLATILE_SESSION_ID_LITERAL.test(value)) continue;
    const prefix = script.slice(0, match.index);
    if (SESSION_ID_LITERAL_PREFIX.test(prefix)) return value;
  }
  return null;
}

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

  // Native session IDs are invocation-specific even though they are UUIDs
  // rather than task-manager handles. A literal in a session-id slot remains
  // stale across reporters and must not be recommended as a generic recipe.
  if (!unresolvedCause) {
    const sessionId = findVolatileSessionIdLiteral(script);
    if (sessionId) unresolvedCause = { kind: 'volatile-session-id-literal', sessionId };
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
