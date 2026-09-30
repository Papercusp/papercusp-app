/**
 * Standard Schema adoption (plan P-020 / D-002).
 *
 * The engine validates a tool's `args`/`input`/`state` and card payloads against
 * any [Standard Schema](https://standardschema.dev) validator — Zod 3.24+,
 * Valibot, ArkType, … — not Zod specifically. It reads only the `~standard`
 * property every such validator exposes; it never calls Zod-specific methods
 * like `.safeParse`. The Papercusp host keeps Zod for its ~96 tools (D-002 only
 * generalizes the core, not the consumers), and Zod schemas satisfy
 * `StandardSchemaV1` so they flow through unchanged.
 *
 * JSON-Schema generation is a *separate* pluggable concern (Standard Schema has
 * no JSON-Schema export) — see `schema-adapter.ts` (P-021).
 */

import type { StandardSchemaV1 } from '@standard-schema/spec';

export type { StandardSchemaV1 };

/** A validation outcome the engine branches on. */
export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: ReadonlyArray<StandardSchemaV1.Issue> };

interface IssueExtras {
  code?: string;
  origin?: string;
  maximum?: number;
  minimum?: number;
  /** Zod's per-branch sub-issues on an `invalid_union` issue. */
  errors?: ReadonlyArray<ReadonlyArray<StandardSchemaV1.Issue>>;
  /** Zod's names for an `unrecognized_keys` issue. */
  keys?: ReadonlyArray<PropertyKey>;
}

type UnknownKeyNode = {
  remove: Set<PropertyKey>;
  children: Map<PropertyKey, UnknownKeyNode>;
};

const UNKNOWN_KEY_CODES = new Set(['unrecognized_key', 'unrecognized_keys', 'unknown_key', 'unknown_keys']);

function issuePathSegments(issue: StandardSchemaV1.Issue): PropertyKey[] {
  return (issue.path ?? []).map((segment) =>
    typeof segment === 'object' && segment !== null
      ? (segment as { key: PropertyKey }).key
      : (segment as PropertyKey),
  );
}

function isUnknownKeyIssue(issue: StandardSchemaV1.Issue): boolean {
  const code = (issue as IssueExtras).code;
  if (code && UNKNOWN_KEY_CODES.has(code)) return true;
  // `code` is not part of Standard Schema's portable issue contract. Keep a
  // conservative message fallback so another validator can still participate
  // when it reports the same ordinary-language diagnosis.
  return /\b(?:unrecognized|unrecognised|unknown)\s+keys?\b/i.test(issue.message);
}

function messageUnknownKeys(message: string): PropertyKey[] {
  // Standard Schema only guarantees `message`; validators without Zod's
  // `keys` extension can still be revalidated when they quote the offending
  // names in the conventional `... key: "name"` form.
  const afterColon = message.slice(message.indexOf(':') + 1);
  const keys: PropertyKey[] = [];
  for (const match of afterColon.matchAll(/["'`]([^"'`]+)["'`]/g)) {
    const key = match[1];
    if (key !== undefined) keys.push(key);
  }
  return keys;
}

function unknownKeysForIssue(issue: StandardSchemaV1.Issue): PropertyKey[] {
  if (!isUnknownKeyIssue(issue)) return [];
  const keys = (issue as IssueExtras).keys;
  if (Array.isArray(keys)) return keys.filter((key): key is PropertyKey => isPropertyKey(key));
  return messageUnknownKeys(issue.message);
}

function isPropertyKey(value: unknown): value is PropertyKey {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'symbol';
}

function newUnknownKeyNode(): UnknownKeyNode {
  return { remove: new Set(), children: new Map() };
}

function unknownKeyTree(issues: ReadonlyArray<StandardSchemaV1.Issue>): UnknownKeyNode | null {
  const root = newUnknownKeyNode();
  let found = false;
  for (const issue of issues) {
    const keys = unknownKeysForIssue(issue);
    if (keys.length === 0) continue;
    found = true;
    let node = root;
    for (const segment of issuePathSegments(issue)) {
      let child = node.children.get(segment);
      if (!child) {
        child = newUnknownKeyNode();
        node.children.set(segment, child);
      }
      node = child;
    }
    for (const key of keys) node.remove.add(key);
  }
  return found ? root : null;
}

function stripUnknownKeys(input: unknown, issues: ReadonlyArray<StandardSchemaV1.Issue>): unknown {
  const tree = unknownKeyTree(issues);
  if (!tree) return input;

  const strip = (value: unknown, node: UnknownKeyNode): { value: unknown; changed: boolean } => {
    if (value === null || typeof value !== 'object') return { value, changed: false };

    let copy: Record<PropertyKey, unknown> | unknown[] = value as Record<PropertyKey, unknown>;
    let changed = false;
    const ensureCopy = (): Record<PropertyKey, unknown> | unknown[] => {
      if (!changed) {
        copy = Array.isArray(value) ? value.slice() : { ...(value as Record<PropertyKey, unknown>) };
        changed = true;
      }
      return copy;
    };

    for (const key of node.remove) {
      // `length` is an array implementation detail, never an input field.
      if (Array.isArray(value) && key === 'length') continue;
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        delete (ensureCopy() as Record<PropertyKey, unknown>)[key];
      }
    }

    for (const [key, child] of node.children) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      const nested = strip((value as Record<PropertyKey, unknown>)[key], child);
      if (nested.changed) (ensureCopy() as Record<PropertyKey, unknown>)[key] = nested.value;
    }

    return { value: copy, changed };
  };

  const stripped = strip(input, tree);
  return stripped.changed ? stripped.value : input;
}

function issueKey(issue: StandardSchemaV1.Issue): string {
  const code = (issue as IssueExtras).code ?? '';
  return `${issuePathSegments(issue).map(String).join('.')}\u0000${code}\u0000${issue.message}`;
}

function mergeUniqueIssues(
  first: ReadonlyArray<StandardSchemaV1.Issue>,
  second: ReadonlyArray<StandardSchemaV1.Issue>,
): ReadonlyArray<StandardSchemaV1.Issue> {
  const merged: StandardSchemaV1.Issue[] = [];
  const seen = new Set<string>();
  for (const issue of [...first, ...second]) {
    const key = issueKey(issue);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(issue);
  }
  return merged;
}

function validateOnce<S extends StandardSchemaV1>(
  schema: S,
  input: unknown,
): Promise<ValidationResult<StandardSchemaV1.InferOutput<S>>> {
  return Promise.resolve(schema['~standard'].validate(input)).then((result) =>
    result.issues ? { ok: false, issues: result.issues } : { ok: true, value: result.value },
  );
}

function validateOnceSync<S extends StandardSchemaV1>(
  schema: S,
  input: unknown,
): ValidationResult<StandardSchemaV1.InferOutput<S>> {
  const result = schema['~standard'].validate(input);
  if (result instanceof Promise) {
    throw new Error(
      'Standard Schema validate() returned a Promise on a synchronous path. ' +
        'Async validators are not supported here (e.g. ctx.publishState); use a synchronous validator like Zod.',
    );
  }
  return result.issues ? { ok: false, issues: result.issues } : { ok: true, value: result.value };
}

/**
 * Validate `input` against a Standard Schema, awaiting async validators (Zod's
 * is synchronous; Valibot/ArkType may be async). Use from an async context.
 *
 * Strict object validators can report an unknown-key issue before running
 * object-level required checks or refinements. Revalidate once after removing
 * only the reported unknown keys, then merge the new issues back into the
 * original result. The original input is never mutated, and the first pass is
 * retained so the caller still learns about the undeclared keys.
 */
export async function standardValidate<S extends StandardSchemaV1>(
  schema: S,
  input: unknown,
): Promise<ValidationResult<StandardSchemaV1.InferOutput<S>>> {
  const first = await validateOnce(schema, input);
  if (first.ok) return first;

  const sanitized = stripUnknownKeys(input, first.issues);
  if (sanitized === input) return first;

  const second = await validateOnce(schema, sanitized);
  return second.ok
    ? first
    : { ok: false, issues: mergeUniqueIssues(first.issues, second.issues) };
}

/**
 * Synchronous validation for call paths that cannot await (e.g. the
 * fire-and-forget `ctx.publishState`). Zod validates synchronously; if a host
 * plugs in an async validator on such a path, this throws loudly rather than
 * silently dropping validation.
 */
export function validateSync<S extends StandardSchemaV1>(
  schema: S,
  input: unknown,
): ValidationResult<StandardSchemaV1.InferOutput<S>> {
  const first = validateOnceSync(schema, input);
  if (first.ok) return first;

  const sanitized = stripUnknownKeys(input, first.issues);
  if (sanitized === input) return first;

  const second = validateOnceSync(schema, sanitized);
  return second.ok
    ? first
    : { ok: false, issues: mergeUniqueIssues(first.issues, second.issues) };
}

/**
 * EI-19968462161677390: an `invalid_union` issue's own top-level message is Zod's
 * generic "Invalid input" — it never names which field was wrong, because the union
 * itself has no field. The USEFUL diagnosis lives in `issue.errors`: one sub-issue
 * array per union branch, each carrying the field-level issues THAT branch produced
 * trying to match the input. A caller who sends a well-shaped ARRAY into
 * `z.union([z.string(), z.array(section)])` gets a deep, specific issue from the
 * array branch (e.g. `body[1].forYouBecause.note: Required`) and a shallow
 * "expected string, received array" from the string branch — the deep one is the
 * branch the caller actually meant, so its issues are the ones worth surfacing.
 *
 * Picks the branch reaching the greatest PATH DEPTH first; on a DEPTH TIE, the
 * branch with the FEWEST issues (ties within that keep the first). A branch
 * with depth 0 (e.g. the string branch's bare type mismatch) never wins once
 * any other branch located a specific field — reproduced live: reporting the
 * deepest branch turns "body: Invalid input" into
 * "body[1].forYouBecause.note: forYouBecause.relation:'other' REQUIRES a `note`".
 *
 * EI-22057520151022793: depth alone is blind to a union of SIBLING object
 * branches that all fail at the SAME shallow depth — facts:assert's 6-way
 * modality union is exactly this shape. For a private, undecidable fact
 * missing `settledBy`, every branch fails at path-depth 1 (a bare top-level
 * field mismatch), so the old code kept whichever branch was listed FIRST
 * regardless of how well it actually matched: the caller was told
 * "shareable: expected true" — a field that has nothing to do with their one
 * real mistake — because the shareable-federation branch happens to be
 * declared before the private-fact branch it actually meant. Fewer issues on
 * a tied-depth branch means fewer respects in which that branch disagrees
 * with the input, i.e. a closer match; break further ties by declaration
 * order, as before, so this only ever sharpens an existing ambiguous case.
 *
 * EI-22050255299103531 / EI-22063684320590166: an `unrecognized_keys` issue
 * DOES locate a specific field — it just records the name in `keys` rather
 * than in `path`, so measuring depth by `path.length` alone scored it 0 and
 * the rule above ("a depth-0 branch never wins once another located a field")
 * discarded it by construction. That inverts the ranking in the one case
 * where the validator has already identified the caller's exact mistake: for
 * facts:assert's 6-way union, a private fact carrying one stray legacy key
 * (`ttlDays`, `source_ref`) produces a branch whose ONLY complaint is that
 * key — the closest possible match — while every sibling branch reports its
 * own missing required fields at path-depth 1 and wins. Both reports show the
 * result: "harness: expected string; shareable: expected true; Unrecognized
 * key: <theirs>", which teaches the caller to add federation fields they
 * never wanted and buries the one actionable word at the end.
 *
 * So count an unrecognized key at the depth of the key it names (its path,
 * plus the one level the key itself sits at). A branch that matched
 * everything except a stray key then ranks as the specific match it is, and
 * the fewest-issues tie-break above selects it over branches that disagree in
 * more respects. This only re-ranks branches that already carry a named key;
 * a union with no unrecognized keys is scored exactly as before.
 */
function issueDepth(issue: StandardSchemaV1.Issue): number {
  const pathDepth = (issue.path ?? []).length;
  const keys = (issue as IssueExtras).keys;
  return Array.isArray(keys) && keys.length > 0 ? pathDepth + 1 : pathDepth;
}

function bestUnionBranch(
  issue: StandardSchemaV1.Issue,
): ReadonlyArray<StandardSchemaV1.Issue> | null {
  const branches = (issue as IssueExtras).errors;
  if (!Array.isArray(branches) || branches.length === 0) return null;
  let best: ReadonlyArray<StandardSchemaV1.Issue> | null = null;
  let bestDepth = 0;
  let bestCount = Infinity;
  for (const branch of branches) {
    if (!Array.isArray(branch) || branch.length === 0) continue;
    const depth = Math.max(...branch.map(issueDepth));
    if (depth > bestDepth || (depth === bestDepth && branch.length < bestCount)) {
      bestDepth = depth;
      bestCount = branch.length;
      best = branch;
    }
  }
  return best;
}

/**
 * Value-level issue codes: the caller used a KEY THAT EXISTS and supplied a value the
 * field would not take. Contrast with a shape problem (an unrecognized key, a missing
 * required field, a wrong type) where the caller demonstrably does not know the schema.
 * The distinction drives `issuesAreValueLevel` below — see its doc.
 */
const VALUE_LEVEL_CODES = new Set(['too_big', 'too_small', 'invalid_format', 'invalid_value', 'not_multiple_of']);

/**
 * Codes whose verdict is about a value's SIZE. These are the only ones suppressed
 * when the same path also failed its type check (see `formatIssues`) — a length
 * verdict on a value of the wrong type describes nothing the caller can act on.
 */
const SIZE_CODES = new Set(['too_big', 'too_small']);

export function issuePath(issue: StandardSchemaV1.Issue): string {
  return (issue.path ?? [])
    .map((seg) => (typeof seg === 'object' && seg !== null ? String((seg as { key: PropertyKey }).key) : String(seg)))
    .join('.');
}

/**
 * True when EVERY issue is a value-level violation on a NAMED field — i.e. the caller
 * knows the tool's shape and simply sent a value one field would not accept (too long,
 * a bad enum value, a malformed string).
 *
 * EI-10943: this is the signal that even field-scoped shape guidance is unnecessary.
 * A caller that sent the right key and merely missed a value constraint already gets the
 * actionable limit/enum/format diagnosis. Shape-blind callers instead receive only the
 * failing field schema or a compact accepted-key list (WI-6661), never the former
 * 1,800-character whole-schema dump. An unnamed-path issue (a whole-object refinement)
 * remains a shape problem, so it keeps that compact guidance.
 */
export function issuesAreValueLevel(issues: ReadonlyArray<StandardSchemaV1.Issue>): boolean {
  if (issues.length === 0) return false;
  return issues.every((issue) => {
    const code = (issue as IssueExtras).code;
    return !!code && VALUE_LEVEL_CODES.has(code) && issuePath(issue).length > 0;
  });
}

/**
 * Render issues into a single `path: message; …` string (Zod-error-like).
 *
 * A string `too_big` is rendered ACTIONABLY — how far over the cap the value is and the
 * exact target length — so the caller trims deterministically in ONE retry instead of
 * blind-retrying the same value (a telemetry audit traced ~1,000+ tool calls/14d failing
 * purely on over-length args, and Zod's own "Too big: expected string to have <=120
 * characters" never says by how much). Needs the input to measure the actual length;
 * without it the message degrades gracefully to the target-only form.
 */
/**
 * Resolve issues to their LEAF diagnoses, each with its fully-qualified segment path.
 *
 * This is the traversal `formatIssues` renders from, extracted so other consumers can
 * reach the same leaves. The distinction it encodes is easy to get wrong and expensive
 * when you do: an `invalid_union` issue's own `path` stops at the UNION NODE (`body`),
 * while its real diagnosis lives in per-branch sub-issues several levels deeper
 * (`body.2.couldNotDetermine.0.what`). Anyone reading `issue.path` directly therefore
 * sees a shallow path that does not match the deep one the rendered message shows —
 * which reads as a bug in the renderer rather than a missing descent.
 *
 * Kept as ONE traversal deliberately: a second copy would drift from the rendered
 * message, and a path hint that disagrees with the error beside it is worse than none.
 */
export function issueLeaves(
  issues: ReadonlyArray<StandardSchemaV1.Issue>,
): Array<{ issue: StandardSchemaV1.Issue; segs: PropertyKey[] }> {
  const out: Array<{ issue: StandardSchemaV1.Issue; segs: PropertyKey[] }> = [];
  const walk = (issue: StandardSchemaV1.Issue, prefix: ReadonlyArray<PropertyKey>, depth: number): void => {
    const segs = [
      ...prefix,
      ...(issue.path ?? []).map((seg) =>
        typeof seg === 'object' && seg !== null ? (seg as { key: PropertyKey }).key : (seg as PropertyKey),
      ),
    ];
    // An `invalid_union` issue's real diagnosis lives in its per-branch sub-issues
    // (see `bestUnionBranch`) — surface the branch that located an actual field
    // instead of the union's own generic "Invalid input". Bounded recursion so a
    // union of unions cannot spin.
    if (depth < 4) {
      const branch = bestUnionBranch(issue);
      if (branch) {
        for (const sub of branch) walk(sub, segs, depth + 1);
        return;
      }
    }
    out.push({ issue, segs });
  };
  for (const issue of issues) walk(issue, [], 0);
  return out;
}

export function formatIssues(issues: ReadonlyArray<StandardSchemaV1.Issue>, input?: unknown): string {
  const render = (
    issue: StandardSchemaV1.Issue,
    segs: ReadonlyArray<PropertyKey>,
  ): { path: string; code: string | undefined; text: string } => {
    const path = segs.map((s) => String(s)).join('.');
    const extras = issue as IssueExtras;
    if (extras.code === 'too_big' && extras.origin === 'string' && typeof extras.maximum === 'number') {
      const max = extras.maximum;
      const actual = input !== undefined ? valueAtPath(input, segs) : undefined;
      const actualLen = typeof actual === 'string' ? actual.length : null;
      const over = actualLen !== null ? actualLen - max : null;
      const detail =
        over !== null && over > 0
          ? `too long — ${actualLen} chars, ${over} over the ${max}-char limit; trim to ${max}.`
          : `too long — over the ${max}-char limit; trim to ${max}.`;
      return { path, code: extras.code, text: path ? `${path}: ${detail}` : detail };
    }
    // EI-21903452986957483: the NUMBER twin of the string branch above. Zod's raw
    // message for a numeric ceiling — "Too big: expected number to be <=10" — names
    // the limit but not the caller's actual value or how far past it they landed, so
    // a caller retries blind instead of clamping in one step. Same defect, same fix,
    // as `formatInvalidArgs` in packages/agent-mcp/src/server.ts (that file's own
    // comment names work_items:get's threadLimit — capped at 10 — as the motivating
    // case, recurring across 6+ sessions) — but that formatter only serves the legacy
    // agent-mcp dispatch path. Every `defineTool`-registered tool (including
    // work_items:get, and every call routed through `tools:invoke`) validates through
    // THIS formatter instead, which never got the number branch — so the exact same
    // caller-facing gap persisted on the projected-tool path the fix was meant to close.
    if (extras.code === 'too_big' && extras.origin === 'number' && typeof extras.maximum === 'number') {
      const max = extras.maximum;
      const actual = input !== undefined ? valueAtPath(input, segs) : undefined;
      const over = typeof actual === 'number' ? actual - max : null;
      const detail =
        over !== null && over > 0
          ? `too big — ${over} over the ${max} limit; use ${max}.`
          : `too big — over the ${max} limit; use ${max}.`;
      return { path, code: extras.code, text: path ? `${path}: ${detail}` : detail };
    }
    return {
      path,
      code: extras.code,
      text: path ? `${path}: ${issue.message}` : issue.message,
    };
  };

  const rows = issueLeaves(issues).map(({ issue, segs }) => render(issue, segs));

  // A SIZE verdict on a value that failed its TYPE check is meaningless, and worse
  // than meaningless when rendered actionably. Zod's `.max(n)` on an array is a
  // size check that reads `.length` off whatever it is handed — so a prose STRING
  // passed to an array field reports `too_big { origin: 'string', maximum: n }`
  // ALONGSIDE the invalid_type, and the branch above dutifully renders it as
  // "too long — 312 chars, 292 over the 20-char limit; trim to 20." The 20 bounds
  // ITEMS, not characters, and trimming the prose is the opposite of the fix
  // (pass an array). Being the more specific-sounding of the two messages, it
  // out-competes the correct one.
  //
  // EI-20018883577474576: six independent agents hit this on coord:send's
  // `youMayNotKnow` / `couldNotDetermine`, and every report ends the same way —
  // they shipped by DELETING the structured field. The renderer taught agents to
  // strip the epistemic-honesty fields the protocol exists to carry.
  const typeFailedPaths = new Set(rows.filter((r) => r.code === 'invalid_type').map((r) => r.path));
  const kept = rows.filter((r) => !(r.code && SIZE_CODES.has(r.code) && typeFailedPaths.has(r.path)));

  // Never return an empty string: if suppression somehow removed everything, the
  // caller is better served by the raw issues than by a silent success-shaped "".
  return (kept.length > 0 ? kept : rows).map((r) => r.text).join('; ');
}

/** Walk `input` to the value at a resolved (already-flattened) segment path. */
function valueAtPath(input: unknown, segs: ReadonlyArray<PropertyKey>): unknown {
  let cur: unknown = input;
  for (const seg of segs) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[seg];
  }
  return cur;
}
