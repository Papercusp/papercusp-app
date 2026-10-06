/**
 * tools:find — find tools by INTENT. The agent-facing front door to the
 * ~550-tool catalog (tool-discovery-for-weak-models-2026-06-30 WS3).
 *
 * Hybrid lexical + semantic search (the committed `cupboard/tool-find.ts`
 * floored-union core): the lexical leg is exact-name-authoritative, the semantic
 * leg broadens recall so "feature flag" finds `flags:*` and "spawn a worker"
 * finds `cup:spawn` even with no shared words. Better than omp's keyword-only
 * `search_tool_bm25`, and — unlike that omp-internal search — usable by
 * claude/codex too.
 *
 * The semantic embedding index over the catalog is built at BOOT
 * (`warmToolFindIndex`, fired once at module load) with a settings-driven
 * embedder via `buildQueryEmbedder` — so the semantic
 * leg is live for the FIRST agent call rather than each cold worker warming
 * lazily on first use (where rate-governed 551-tool warming may never finish
 * before a call lands, leaving agents perpetually on lexical-only). It rebuilds
 * on executable registry-revision drift, and the handler self-heals (re-invokes the build)
 * if the boot warm hasn't completed. Every embedding path degrades to
 * lexical-only on any failure (no embedder, admission shed, fetch error) and the
 * result's `semantic` field reports which leg ran — so the tool is always
 * functional and never silently pretends semantic ran.
 *
 * ONE EMBEDDING SPACE, and deliberately unnamed here. `buildQueryEmbedder` is
 * the SAME resolution the prose search uses, so the catalog index and every
 * prose column live in one space — measured 2026-08-08: both gemma@768, 296,452
 * session turns and 9,987 doc sections (P-019).
 *
 * ⚠ This comment used to say "currently openai, 384-d". It went stale when the
 * embedder moved, and a plan item was later written FROM IT asserting the app
 * ran two models at two dimensionalities. It does not, and never needed to —
 * the point of routing through `buildQueryEmbedder` is that this file holds no
 * opinion about model or width. Do not re-pin one here; a width named in prose
 * is a claim nothing can keep true. `findTools` carries a width guard for the
 * one mismatch that IS reachable: a boot-built index stranded in a different
 * space by a settings change mid-process.
 */
import { z } from 'zod';
import {
  AGENT_ROLES,
  PROJECTED_TOOL_REGISTRY_SOURCE,
  defineTool,
  listAllProjectedTools,
  projectedToolRegistryRevision,
} from '@papercusp/agent-mcp';
import { categoryOf } from '../../cupboard/tools-search';
import {
  arrayItemConstraintText,
  mergeRepeatedPropertySchema,
  renderSchemaBounds,
  schemaAliasAnnotation,
  schemaCallConstraintAnnotation,
  schemaToText,
  type ToolDiscoveryEntry,
  unionConditionalHint,
  unionRequiredKeyHint,
} from '../../cupboard/tools-discovery';
import { findTools, type Embedder } from '../../cupboard/tool-find';
import { buildQueryEmbedder, interactiveEmbedAcquireBudgetMs } from '../search/embedder';
import { resolveConcreteHarnessSlug } from '../_harness-scope';
import { withBoundedTimeout } from '../../bounded-timeout';
import { withInlinedSchemaRefs } from '../schema-ref-inline';

/**
 * The result-door is a per-tool-result budget, not a per-field budget. A
 * discovery hit can therefore be perfectly valid in isolation and still make
 * the whole `tools:find` response unparseable when several hits carry verbose
 * schemas. Keep the ranking corpus rich, but project the response through a
 * compact structural schema and a conservative byte budget.
 */
export const DISCOVERY_RESULT_MAX_BYTES = 5_000;
/** Keep plugin readiness below the MCP transport deadline while preserving the base catalog. */
export const PLUGIN_HOST_READINESS_TIMEOUT_MS = 5_000;
/** The optional harness-registry read must not let catalog discovery hang on a DB pool wait. */
export const DISCOVERY_HIVE_SCOPE_TIMEOUT_MS = 5_000;
const DISCOVERY_DESCRIPTION_MAX_CHARS = 320;
const DISCOVERY_SCHEMA_MAX_CHARS = 2_200;
const COMPACT_NESTED_DESCRIPTION_MAX_CHARS = 180;

type JsonSchemaNode = {
  'x-papercusp-call-constraint'?: unknown;
  type?: unknown;
  enum?: unknown;
  const?: unknown;
  pattern?: unknown;
  properties?: unknown;
  required?: unknown;
  items?: unknown;
  additionalProperties?: unknown;
  anyOf?: unknown;
  oneOf?: unknown;
  minItems?: unknown;
  maxItems?: unknown;
  minimum?: unknown;
  maximum?: unknown;
  exclusiveMinimum?: unknown;
  exclusiveMaximum?: unknown;
  minLength?: unknown;
  description?: unknown;
  maxLength?: unknown;
};

function schemaNodes(node: JsonSchemaNode): JsonSchemaNode[] {
  const unions = [node.anyOf, node.oneOf].find(Array.isArray);
  const branches = unions ? (unions as unknown[]).filter((n): n is JsonSchemaNode => !!n && typeof n === 'object') : [];

  // Some strict Zod schemas deliberately include permissive branches solely so
  // `superRefine` can replace their generic error with teaching text.  Those
  // branches are still present in the generated JSON Schema even though the
  // handler rejects them: shapeTaughtArray, for example, emits a bounded strict
  // array alongside a bare string and an untyped `array` catch-all.  Returning
  // those branches from discovery tells callers that an invalid value is
  // callable (`array|string`) and hides the fact that the nested object fields
  // are the accepted shape.  The compact projection should describe the
  // callable branch, not the validation-only refusal branches.
  const hasTeachingArrayShape = branches.some(
    (branch) => branch.type === 'array' && (branch.minItems != null || branch.maxItems != null),
  );
  if (!hasTeachingArrayShape) return branches;

  const isBareString = (branch: JsonSchemaNode): boolean =>
    branch.type === 'string' && Object.keys(branch).every((key) => key === 'type' || key === 'description');
  const isUntypedArrayCatchall = (branch: JsonSchemaNode): boolean => {
    if (branch.type !== 'array' || branch.minItems != null || branch.maxItems != null) return false;
    if (!branch.items || typeof branch.items !== 'object' || Array.isArray(branch.items)) return false;
    return Object.keys(branch.items as Record<string, unknown>).every((key) => key === 'description');
  };
  const callableBranches = branches.filter((branch) => !isBareString(branch) && !isUntypedArrayCatchall(branch));
  return callableBranches.length > 0 ? callableBranches : branches;
}

function schemaType(node: JsonSchemaNode): string {
  const enumValues = Array.isArray(node.enum)
    ? node.enum.filter(
        (v): v is string | number | boolean => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
      )
    : [];
  if (enumValues.length > 0) return `enum(${enumValues.join('|')})`;
  // z.literal() emits JSON Schema's `const`, not `enum`. Preserve that
  // singleton constraint in discovery so callers do not learn the accepted
  // value only after a runtime rejection (EI-21166891721391042).
  if (
    Object.prototype.hasOwnProperty.call(node, 'const') &&
    (node.const === null ||
      typeof node.const === 'string' ||
      typeof node.const === 'number' ||
      typeof node.const === 'boolean')
  ) {
    return `enum(${String(node.const)})`;
  }
  if (typeof node.type === 'string') return node.type;
  const unionTypes = [...new Set(schemaNodes(node).map(schemaType).filter(Boolean))];
  return unionTypes.join('|');
}

function schemaBound(node: JsonSchemaNode): string {
  const bound = renderSchemaBounds([node, ...schemaNodes(node)]);
  return bound ? `(${bound})` : '';
}

function schemaPattern(node: JsonSchemaNode): string {
  const pattern = [node, ...schemaNodes(node)]
    .map((candidate) =>
      typeof candidate.pattern === 'string' && candidate.pattern.length > 0 ? candidate.pattern : null,
    )
    .find((value): value is string => value != null);
  return pattern ? `~/${pattern}/` : '';
}

function objectProperties(node: JsonSchemaNode): { properties: Record<string, unknown>; required: Set<string> } | null {
  const candidates = [node, ...schemaNodes(node)];
  for (const candidate of candidates) {
    if (!candidate.properties || typeof candidate.properties !== 'object' || Array.isArray(candidate.properties))
      continue;
    const required = new Set<string>(
      Array.isArray(candidate.required) ? candidate.required.filter((v): v is string => typeof v === 'string') : [],
    );
    return { properties: candidate.properties as Record<string, unknown>, required };
  }
  return null;
}

/**
 * Merge the object branches of a nested union for compact discovery. The
 * ordinary objectProperties helper intentionally retains its historical
 * first-object behavior for callers that need a single representative shape;
 * nested discovery needs the complete callable field vocabulary instead.
 */
function mergedNestedObjectProperties(
  node: JsonSchemaNode,
): { properties: Record<string, unknown>; required: Set<string> } | null {
  const direct =
    node.properties && typeof node.properties === 'object' && !Array.isArray(node.properties)
      ? {
          properties: node.properties as Record<string, unknown>,
          required: new Set<string>(
            Array.isArray(node.required) ? node.required.filter((v): v is string => typeof v === 'string') : [],
          ),
        }
      : null;
  if (direct && Object.keys(direct.properties).length > 0) return direct;

  // Ignore scalar/null union branches: a nullable object still has required
  // fields whenever the object arm is selected.
  const objectBranches = schemaNodes(node).filter(
    (branch) => branch.properties && typeof branch.properties === 'object' && !Array.isArray(branch.properties),
  );
  if (objectBranches.length === 0) return direct;

  // A nested object union (for example rubricCriterionCheckSchema) used to be
  // reduced to the first branch here. That made `check` advertise only the
  // tests arm while hiding the cargo/instrument/probe/coverage/requirements
  // fields that callers can actually submit. Merge the object branches using
  // the same conservative requiredness rule as the root projection: a field is
  // required only when every object branch both exposes and requires it.
  const merged = new Map<string, { raw: unknown; presentIn: number; requiredInAll: boolean }>();
  for (const branch of objectBranches) {
    const required = new Set<string>(
      Array.isArray(branch.required) ? branch.required.filter((v): v is string => typeof v === 'string') : [],
    );
    for (const [name, raw] of Object.entries(branch.properties as Record<string, unknown>)) {
      const prior = merged.get(name);
      if (prior) {
        prior.presentIn += 1;
        prior.requiredInAll = prior.requiredInAll && required.has(name);
        prior.raw = mergeRepeatedPropertySchema(prior.raw, raw);
      } else {
        merged.set(name, { raw, presentIn: 1, requiredInAll: required.has(name) });
      }
    }
  }

  const required = new Set<string>();
  for (const [name, entry] of merged) {
    if (entry.presentIn === objectBranches.length && entry.requiredInAll) {
      required.add(name);
    }
  }
  return { properties: Object.fromEntries([...merged].map(([name, entry]) => [name, entry.raw])), required };
}

/** Keep the compact result useful without letting recursive schemas consume it. */
const MAX_NESTED_SCHEMA_DEPTH = 4;

function nestedObjectProperties(
  node: JsonSchemaNode,
): { properties: Record<string, unknown>; required: Set<string> } | null {
  const direct = mergedNestedObjectProperties(node);
  const candidates = [node, ...schemaNodes(node)];

  // A mixed object may legally carry named properties alongside an
  // additionalProperties schema. It is not a record-only shape: replacing
  // its named fields with the synthetic `*` entry would hide established
  // output paths from the bounded projection. Only use the record branch when
  // the object has no non-empty direct property set.
  if (direct && Object.keys(direct.properties).length > 0) return direct;

  // z.record() publishes its value schema under `additionalProperties`, not
  // under named `properties`. Treat the map value as a synthetic `*` field so
  // compact discovery keeps the entry contract visible (for example,
  // `object{*:object{verdict,measuredAt}}`) instead of downgrading the record
  // to a misleading bare `object`. Prefer this over an empty direct
  // properties object, which some schema emitters include alongside the map.
  for (const candidate of candidates) {
    const additional = candidate.additionalProperties;
    if (!additional || typeof additional !== 'object' || Array.isArray(additional)) continue;
    const valueSchema = additional as JsonSchemaNode;
    const valueProperties = objectProperties(valueSchema);
    if (valueProperties && Object.keys(valueProperties.properties).length > 0) {
      return { properties: { '*': valueSchema }, required: new Set(['*']) };
    }
  }

  if (direct) return direct;

  for (const candidate of candidates) {
    if (!candidate.items || typeof candidate.items !== 'object' || Array.isArray(candidate.items)) continue;
    const item = mergedNestedObjectProperties(candidate.items as JsonSchemaNode);
    if (item) return item;
  }
  return null;
}

/**
 * EI-21490971340666010: one property's nested-fields block is bounded so the
 * braces marking nesting stay visually attachable to their parent. A wide
 * object (improvements:capture's `observation`) rendered >1,500 chars of
 * comma-joined fields whose closing brace sat ~1,900 chars from the opener —
 * past other fields' brace-bearing descriptions — and callers read a late
 * nested field (`linkTo`) as a TOP-LEVEL arg, then hit invalid_args on the
 * strict schema (three filings). Over budget: drop descriptions first, then
 * elide the tail with an explicit `…+N`. Field NAMES stay visible at every
 * depth (the EI-13190 contract); only aggregate width is capped.
 */
const NESTED_FIELDS_SEGMENT_MAX_CHARS = 320;

/**
 * When a nested object is too wide for its parent's bounded segment, keep one
 * of its own nested-object fields attached to the parent. Prefer the first
 * bounded child in schema order with its structural fields expanded; this
 * preserves a contract path such as `completion.verification.coverage` and
 * its residue bucket without allowing a large recursive evidence record to
 * consume the whole discovery result. Once that structural path is selected,
 * retain shallow direct fields while room remains. A direct primitive can be
 * required by the runtime schema even when a sibling array/object is the field
 * that made the segment too wide (for example, `rerunRecipe.current.supplied`).
 */
const NESTED_OBJECT_HINT_MAX_CHARS = 180;

function nestedObjectFieldHint(node: JsonSchemaNode, depth: number, includeNestedPath = true): string {
  const nested = nestedObjectProperties(node);
  if (!nested) return '';
  const entries = Object.entries(nested.properties);
  const fields = entries.filter(([, raw]) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    return nestedObjectProperties(raw as JsonSchemaNode) != null;
  });
  const directFields = entries.filter(([, raw]) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return true;
    return nestedObjectProperties(raw as JsonSchemaNode) == null;
  });

  let body = '';
  let expandedNestedPath = false;
  let nestedPathRequired = false;
  if (includeNestedPath) {
    for (const [name, raw] of fields) {
      const child = raw as JsonSchemaNode;
      const shape = schemaShape(child, depth, false, true);
      const rendered = `${name}${nested.required.has(name) ? '' : '?'}${shape ? `:${shape}` : ''}`;
      if (rendered.length <= NESTED_OBJECT_HINT_MAX_CHARS) {
        body = rendered;
        expandedNestedPath = true;
        nestedPathRequired = nested.required.has(name);
        break;
      }
    }
    if (!body) {
      const [name, raw] = fields[0] ?? [];
      if (name && raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const shape = schemaType(raw as JsonSchemaNode);
        body = `${name}${nested.required.has(name) ? '' : '?'}${shape ? `:${shape}` : ''}`;
        nestedPathRequired = nested.required.has(name);
      }
    }
  }

  // Keep required shallow fields even when an expanded structural child is
  // selected. Otherwise a bounded hint can retain that optional child while
  // hiding required siblings such as testing:run.recoverEvidence.originRunId.
  // Optional direct details are considered only when there is no expanded
  // nested path, preserving the established high-value paths such as
  // completion.verification.coverage.
  const includeOptionalDirectFields = !expandedNestedPath || !includeNestedPath;
  const directCandidates = directFields
    .map(([name, raw]) => {
      const child = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as JsonSchemaNode) : {};
      const shape = schemaShape(child, depth, false, false);
      return {
        name,
        child,
        required: nested.required.has(name),
        rendered: `${name}${nested.required.has(name) ? '' : '?'}${shape ? `:${shape}` : ''}`,
      };
    })
    .sort((a, b) => Number(b.required) - Number(a.required));
  const requiredCandidates = directCandidates.filter((candidate) => candidate.required);
  const optionalCandidates = directCandidates.filter((candidate) => !candidate.required);
  const join = (base: string, entries: string[]) => [base, ...entries].filter(Boolean).join(',');
  const renderRequired = (candidate: (typeof requiredCandidates)[number], mode: 'full' | 'type' | 'name') => {
    if (mode === 'full') return candidate.rendered;
    const type = mode === 'type' ? schemaType(candidate.child) : '';
    return `${candidate.name}${type ? `:${type}` : ''}`;
  };

  // Preserve every required key before spending the small nested-hint
  // budget on optional metadata or long patterns. Required fields first use
  // their full shape; under pressure, reduce them to type-only and then
  // name-only forms so a long UUID pattern cannot evict a sibling required
  // field such as testing:run.recoverEvidence.originRunId.
  let requiredMode: 'full' | 'type' | 'name' = 'full';
  let requiredEntries = requiredCandidates.map((candidate) => renderRequired(candidate, requiredMode));
  // An optional nested path must not force required fields down to names only.
  // Drop that path first, then simplify required fields only if their own full
  // constraints still exceed the bounded hint.
  if (join(body, requiredEntries).length > NESTED_OBJECT_HINT_MAX_CHARS && body && !nestedPathRequired) {
    body = '';
  }
  if (join(body, requiredEntries).length > NESTED_OBJECT_HINT_MAX_CHARS) {
    requiredMode = 'type';
    requiredEntries = requiredCandidates.map((candidate) => renderRequired(candidate, requiredMode));
  }
  if (join(body, requiredEntries).length > NESTED_OBJECT_HINT_MAX_CHARS) {
    requiredMode = 'name';
    requiredEntries = requiredCandidates.map((candidate) => renderRequired(candidate, requiredMode));
  }
  body = join(body, requiredEntries);

  // Optional details remain useful when there is room, but never displace
  // any required direct field from the bounded hint.
  if (includeOptionalDirectFields) {
    for (const candidate of optionalCandidates) {
      const next = join(body, [candidate.rendered]);
      if (next.length <= NESTED_OBJECT_HINT_MAX_CHARS) body = next;
    }
  }

  return body ? `{${body}}` : '';
}

function nestedFieldNames(node: JsonSchemaNode, depth: number, includeDescriptions = true): string {
  if (depth >= MAX_NESTED_SCHEMA_DEPTH) return '';
  const nested = nestedObjectProperties(node);
  const properties = Object.entries(nested?.properties ?? {});
  if (!nested) return '';
  const isWorkItemsGetResultRow =
    properties.some(([name]) => name === 'checkpoint') &&
    properties.some(([name]) => name === 'checkpointChecks') &&
    properties.some(([name]) => name === 'checkpointAgeMs') &&
    properties.some(([name]) => name === 'workItem');
  // `work_items:complete.specAdequacy.current` is a bounded array of evidence
  // tuples. The first seven identity fields are the structural join key; the
  // four optional dimension fingerprints are still available from the full
  // schema but consume the compact tuple budget before the enclosing completion
  // contract can be rendered. Keep the identity prefix intact and let the
  // explicit tail marker account for those optional dimensions in compact
  // discovery. This is intentionally shape-based so it does not affect
  // unrelated arrays that happen to contain a `current` property.
  const tupleProperties =
    node.type === 'array' && node.items && typeof node.items === 'object' && !Array.isArray(node.items)
      ? objectProperties(node.items as JsonSchemaNode)?.properties
      : null;
  const isSpecEvidenceCurrentItem =
    tupleProperties != null &&
    ['planSlug', 'specId', 'specRevision', 'specFingerprint', 'evidenceKind', 'evidenceRef', 'sourceFingerprint'].every(
      (name) => Object.prototype.hasOwnProperty.call(tupleProperties, name),
    ) &&
    ['testFingerprint', 'fixtureFingerprint', 'rubricFingerprint', 'environmentFingerprint'].some((name) =>
      Object.prototype.hasOwnProperty.call(tupleProperties, name),
    );
  // Keep conditional lifecycle contracts ahead of descriptive/legacy fields in
  // a bounded nested object. `work_items:complete` places
  // `rootCauseVerification` after the wide `verification` record and several
  // legacy aliases; the old schema-order walk elided it behind `…+17`, leaving
  // a caller with a shape that looked valid until the close was refused. Both
  // fields are contract-bearing, so reserve their names/shapes before optional
  // evidence metadata while retaining source order for everything else.
  const contractPriority = (name: string): number => {
    // `improvements:capture.observation.subject` is a typed discriminator + ref
    // used to bind a captured observation to its subject. It was late in this
    // wide object and disappeared behind the compact segment's tail marker,
    // leaving callers to discover its required object shape from invalid_args.
    const isObservationCapture =
      properties.some(([field]) => field === 'linkTo') &&
      properties.some(([field]) => field === 'sourceHive') &&
      properties.some(([field]) => field === 'subject') &&
      properties.some(([field]) => field === 'confidence');
    if (isObservationCapture && name === 'subject') return 110;
    if (name === 'rootCauseVerification') return 100;
    // plans:set-specs has a wide clause shape; its required discriminator was
    // elided behind optional fields in both `spec` and `items` discovery.
    if (name === 'behaviorClass') return 95;
    if (name === 'verification') return 90;
    // rerunRecipe.current.supplied is a required decision input. A wide
    // selection object must not push that shape behind the segment tail.
    if (name === 'current' && nested.required.has(name)) return 85;
    // work_items:get's bounded result row must expose its resumable checkpoint
    // and recent-comment window together. Let the larger item-identity object
    // render after those paths so it can degrade to its outer name when needed.
    if (isWorkItemsGetResultRow && name === 'checkpoint') return 90;
    if (isWorkItemsGetResultRow && name === 'threadWindow') return 80;
    if (isWorkItemsGetResultRow && name === 'workItem') return 70;
    return 0;
  };
  const orderedProperties = properties
    .map(([name, raw], index) => ({ name, raw, index, priority: contractPriority(name) }))
    .sort((a, b) => b.priority - a.priority || a.index - b.index)
    .map(({ name, raw }) => [name, raw] as [string, unknown]);
  const hasRequiredArrayItemFields = (raw: unknown): boolean => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const node = raw as JsonSchemaNode;
    const item = node.items && typeof node.items === 'object' && !Array.isArray(node.items)
      ? objectProperties(node.items as JsonSchemaNode)
      : null;
    return node.type === 'array' && item != null && item.required.size > 0;
  };
  const renderEntry = (
    name: string,
    raw: unknown,
    withDescription: boolean,
    includeNestedFields = true,
  ): string => {
    const child = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as JsonSchemaNode) : {};
    // Keep the canonical workItem key visible in the bounded result row after
    // checkpoint and threadWindow.posts. Its full child schema can consume the
    // remaining segment and cause the enclosing field itself to be elided.
    const includeChildFields =
      includeNestedFields &&
      name !== 'rootCauseVerification' &&
      !(isWorkItemsGetResultRow && name === 'workItem');
    // rootCauseVerification publishes its conditional required-field contract
    // through x-papercusp-call-constraint. Rendering its now-wide v2 object in
    // full would consume this entire bounded segment and evict the equally
    // load-bearing completion.verification.coverage path. Keep the object name
    // here; the constraint above retains every required causal field verbatim.
    const shape = schemaShape(
      child,
      depth,
      withDescription,
      includeChildFields,
    );
    const description = withDescription ? nestedDescription(child, depth) : '';
    return `${name}${nested.required.has(name) ? '' : '?'}${shape ? `:${shape}` : ''}${description}`;
  };
  const renderOrderedProperties = (propertiesToRender: Array<[string, unknown]>): {
    body: string;
    omitted: Set<string>;
    degradedArrayItems: Set<string>;
    oversized: boolean;
  } => {
    let entries = propertiesToRender.map(([name, raw]) => renderEntry(name, raw, includeDescriptions));
    if (includeDescriptions && entries.join(',').length > NESTED_FIELDS_SEGMENT_MAX_CHARS) {
      entries = propertiesToRender.map(([name, raw]) => renderEntry(name, raw, false));
    }
    const oversized = entries.some((entry) => entry.length > NESTED_FIELDS_SEGMENT_MAX_CHARS);
    let body = '';
    let dropped = 0;
    const omitted = new Set<string>();
    const degradedArrayItems = new Set<string>();
    for (const [index, entry] of entries.entries()) {
      const [name, raw] = propertiesToRender[index];
      if (
        isSpecEvidenceCurrentItem &&
        ['fixtureFingerprint', 'rubricFingerprint', 'environmentFingerprint'].includes(name)
      ) {
        dropped += 1;
        omitted.add(name);
        continue;
      }
      const candidate = body ? `${body},${entry}` : entry;
      if (body && candidate.length > NESTED_FIELDS_SEGMENT_MAX_CHARS) {
        // Keep the child name/type discoverable even when its recursive shape is
        // larger than the remaining segment budget. Dropping the whole entry
        // made large contracts (notably completion.verification) disappear,
        // leaving callers to infer the legacy alias was canonical. The shallow
        // fallback preserves the callable field without changing aggregate
        // width or the explicit tail-elision marker.
        // Keep a shallow nested-object path on the fallback. Without this, a
        // wide field such as completion.verification degraded to just
        // `verification?:object`, while the legacy sibling completion.coverage
        // remained visible and callers learned the wrong nesting from discovery.
        const fallback = renderEntry(name, raw, false, false);
        const nestedHint =
          raw && typeof raw === 'object' && !Array.isArray(raw)
            ? nestedObjectFieldHint(raw as JsonSchemaNode, depth)
            : '';
        const hintedFallback = nestedHint ? `${fallback}${nestedHint}` : fallback;
        // If the preserved nested path plus direct fields is too large for the
        // remaining parent segment, retain the direct fields on their own. This
        // keeps required values discoverable even when an earlier sibling has
        // already consumed most of the 320-character budget.
        const directHint =
          raw && typeof raw === 'object' && !Array.isArray(raw)
            ? nestedObjectFieldHint(raw as JsonSchemaNode, depth, false)
            : '';
        const compactChild =
          raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as JsonSchemaNode) : {};
        // A required primitive can still be dropped here when the child list
        // itself stays under the segment cap but its long constraints (for
        // example a UUID pattern) do not fit after earlier required siblings.
        // The parent-level nestedObjectFieldHint cannot help in that case,
        // because this loop is already rendering the child's direct fields.
        // Keep the required key and its broad type once its full shape cannot
        // fit; optional metadata and long patterns remain expendable.
        const compactRequired = nested.required.has(name) && !hasRequiredArrayItemFields(raw)
          ? `${name}${schemaType(compactChild) ? `:${schemaType(compactChild)}${schemaBound(compactChild)}` : ''}`
          : '';
        const fallbackCandidates = [
          hintedFallback,
          directHint ? `${fallback}${directHint}` : fallback,
          compactRequired,
          fallback,
        ];
        const selectedFallback = fallbackCandidates.find((candidate) => {
          const candidateWithBody = `${body},${candidate}`;
          return candidate.length < entry.length && candidateWithBody.length <= NESTED_FIELDS_SEGMENT_MAX_CHARS;
        });
        if (selectedFallback) {
          body = `${body},${selectedFallback}`;
          if (selectedFallback === fallback && hasRequiredArrayItemFields(raw)) degradedArrayItems.add(name);
          continue;
        }
        dropped += 1;
        omitted.add(name);
        continue;
      }
      body = candidate;
    }
    if (dropped > 0) body = `${body},…+${dropped}`;
    return { body: body.length > 0 ? `{${body}}` : '', omitted, degradedArrayItems, oversized };
  };

  let propertiesForRender = orderedProperties;
  // Preserve the established contract-priority/source order unless it would
  // hide a required field. If one is omitted, move only the omitted required
  // fields to the front and render again; this keeps existing high-value
  // nested paths (such as completion.verification.coverage) stable while
  // making a late required field such as progress_lease.remedy visible.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const rendered = renderOrderedProperties(propertiesForRender);
    const omittedRequired = propertiesForRender.filter(
      ([name]) => nested.required.has(name) && rendered.omitted.has(name),
    );
    const omittedRequiredArrayItems = propertiesForRender.filter(([name, raw]) =>
      rendered.degradedArrayItems.has(name) || (rendered.omitted.has(name) && hasRequiredArrayItemFields(raw)),
    );
    // An oversized entry has its own established shallow fallback at the
    // enclosing object level (for example completion.verification.coverage or
    // rerunRecipe.current.supplied). Reordering around it would make that
    // fallback appear to fit and would regress the nested path projection.
    if (
      (omittedRequired.length === 0 && omittedRequiredArrayItems.length === 0) ||
      attempt === 1 ||
      (rendered.oversized && omittedRequiredArrayItems.length === 0)
    ) {
      return rendered.body;
    }
    const omittedRequiredNames = new Set([
      ...omittedRequired.map(([name]) => name),
      ...omittedRequiredArrayItems.map(([name]) => name),
    ]);
    propertiesForRender = [
      ...omittedRequired,
      ...omittedRequiredArrayItems.filter(
        ([name]) => !omittedRequired.some(([requiredName]) => requiredName === name),
      ),
      ...propertiesForRender.filter(([name]) => !omittedRequiredNames.has(name)),
    ];
  }
  return '';
}

/**
 * Keep semantic descriptions for nested fields that cannot be represented by
 * JSON Schema structure alone (for example, a pipeline must be the sanitized
 * integration-root basename). Top-level descriptions remain on the tool hit;
 * nested descriptions are otherwise lost by the compact projection. Bound the
 * hint so one verbose field cannot consume the discovery result budget.
 */
function nestedDescription(node: JsonSchemaNode, depth: number): string {
  if (depth <= 0 || typeof node.description !== 'string') return '';
  const description = node.description.replace(/\s+/g, ' ').trim();
  if (!description) return '';
  const bounded =
    description.length <= COMPACT_NESTED_DESCRIPTION_MAX_CHARS
      ? description
      : `${description.slice(0, COMPACT_NESTED_DESCRIPTION_MAX_CHARS - 1)}…`;
  return ` ${bounded}`;
}

/**
 * Keep top-level field guidance in the compact result, but cap it separately
 * from nested descriptions. A field's phase/usage restriction is part of the
 * callable contract even when its type is already visible (for example,
 * `plans:audit.auditedSha` is completion-phase only). When the complete
 * projection is too large, descriptions without a constraint keyword are the
 * first detail dropped; the structural shape and explicit restrictions remain.
 */
const COMPACT_TOP_LEVEL_DESCRIPTION_MAX_CHARS = 240;
const COMPACT_CONTRACT_DESCRIPTION_PATTERN =
  /\b(?:phase\s+only|only|required|must|requires?|forbidden|cannot|exact(?:ly)?)\b/i;

/**
 * Long descriptions sometimes put their most important callable contract in a
 * late clause rather than at the front. Keep a short, self-contained clause
 * for the canonical BAR heading so compact discovery does not teach callers
 * only the plan-body shape while hiding the requirement-to-work mapping that
 * plans:new validates. This is deliberately marker-driven and bounded: other
 * descriptions retain the ordinary prefix projection below.
 */
const COMPACT_BAR_MAP_MARKER = /(?:###\s*)?Bar-to-work map for this plan/i;

function compactContractSynopsis(description: string): string | null {
  const marker = COMPACT_BAR_MAP_MARKER.exec(description);
  if (!marker || marker.index < COMPACT_TOP_LEVEL_DESCRIPTION_MAX_CHARS) return null;

  const remainder = description.slice(marker.index).trim();
  if (!remainder) return null;

  // The BAR column grammar and evidence-plane choices precede the first
  // semicolon in plans:new's guidance. Stop there so subsequent operational
  // prose cannot evict the actual mapping contract from the bounded snippet.
  const semicolon = remainder.indexOf(';');
  const period = remainder.indexOf('.');
  const clauseEnd = semicolon >= 0 && (period < 0 || semicolon < period)
    ? semicolon + 1
    : period >= 0
      ? period + 1
      : remainder.length;
  const clause = remainder.slice(0, clauseEnd).trim();
  if (!clause) return null;

  const omittedPrefix = marker.index > 0 ? '…' : '';
  const candidate = `${omittedPrefix}${clause}`;
  return candidate.length <= COMPACT_TOP_LEVEL_DESCRIPTION_MAX_CHARS
    ? candidate
    : `${candidate.slice(0, COMPACT_TOP_LEVEL_DESCRIPTION_MAX_CHARS - 1)}…`;
}

function compactTopLevelDescription(node: JsonSchemaNode, fieldName: string): { text: string; priority: number } | null {
  if (typeof node.description !== 'string') return null;
  const description = node.description.replace(/\s+/g, ' ').trim();
  if (!description) return null;
  const synopsis = compactContractSynopsis(description);
  const projected = synopsis ?? description;
  const bounded =
    projected.length <= COMPACT_TOP_LEVEL_DESCRIPTION_MAX_CHARS
      ? projected
      : `${projected.slice(0, COMPACT_TOP_LEVEL_DESCRIPTION_MAX_CHARS - 1)}…`;
  return {
    text: ` ${bounded}`,
    // Keep plans:audit's phase restriction visible even when its newly
    // expanded itemProvenance union pushes the compact projection over budget.
    // The activation-wide constraint is useful, but this field-level rule is
    // the clearest guard against sending auditedSha on an activation call.
    priority: fieldName === 'auditedSha' && /completion phase only/i.test(description)
      ? 200
      : COMPACT_CONTRACT_DESCRIPTION_PATTERN.test(description)
        ? 100
        : 10,
  };
}

/**
 * Nested object unions are compacted to a merged field vocabulary so callers
 * can see every callable field. Preserve the branch boundary too: without it,
 * `binding` can appear to accept test-run fields and manual-measurement fields
 * together even though the validator accepts either shape, not both.
 */
const NESTED_UNION_HINT_MAX_CHARS = 320;

function nestedObjectUnionHint(node: JsonSchemaNode, depth: number): string {
  // This hint repairs a union that is itself a top-level argument object
  // (binding?: ...). Recursive hints multiply across broad contracts and can
  // evict required nested paths from the bounded discovery result.
  if (depth !== 0) return '';
  const branches = schemaNodes(node);
  const objectBranches = branches.filter(
    (branch) => branch.properties && typeof branch.properties === 'object' && !Array.isArray(branch.properties),
  );
  if (objectBranches.length < 2 || objectBranches.length !== branches.length) return '';

  const requiredKeys = unionRequiredKeyHint(objectBranches);
  if (!requiredKeys.includes('|')) return '';
  const hint = `(one-of:${requiredKeys})`;
  return hint.length <= NESTED_UNION_HINT_MAX_CHARS ? hint : '';
}

function schemaShape(
  node: JsonSchemaNode,
  depth: number,
  includeNestedDescriptions = true,
  includeNestedFields = true,
): string {
  const type = schemaType(node);
  const bound = schemaBound(node);
  // Keep regex constraints in the returned schema just as bounds and array
  // item constraints are kept. Without this, tools:find's response path
  // silently downgraded locks:release's published_sha to bare `string`, even
  // though the searchable corpus already exposed the pattern.
  const pattern = type.startsWith('enum(') ? '' : schemaPattern(node);
  const itemConstraint =
    [node, ...schemaNodes(node)]
      .map((candidate) => arrayItemConstraintText(candidate))
      .find((text): text is string => text.length > 0) ?? '';
  const unionHint = nestedObjectUnionHint(node, depth);
  const nested = includeNestedFields ? nestedFieldNames(node, depth + 1, includeNestedDescriptions) : '';
  return `${type}${bound}${pattern}${itemConstraint}${unionHint}${nested}`;
}

type TopLevelSchemaProjection = {
  entries: Array<[string, unknown]>;
  required: Set<string>;
  /** Required keys that distinguish the root union's branches, if any. */
  unionHint: string;
  /** Explicit discriminator-dependent required/forbidden relationships. */
  conditionalHint: string;
};

function topLevelSchemaProjection(root: JsonSchemaNode): TopLevelSchemaProjection | null {
  const directProps = root.properties;
  if (directProps && typeof directProps === 'object' && !Array.isArray(directProps)) {
    return {
      entries: Object.entries(directProps as Record<string, unknown>),
      required: new Set<string>(
        Array.isArray(root.required) ? root.required.filter((v): v is string => typeof v === 'string') : [],
      ),
      unionHint: '',
      conditionalHint: '',
    };
  }

  const branches = schemaNodes(root);
  if (branches.length === 0) return null;

  // A root union is how Zod publishes dual-arity tools such as
  // work_items:complete. Merge the branch properties for a callable compact
  // shape, but retain the branch-required keys as an explicit one-of hint so
  // the merged optional view cannot be mistaken for the whole contract.
  const merged = new Map<string, { raw: unknown; presentIn: number; requiredInAll: boolean }>();
  for (const branch of branches) {
    const props = branch.properties;
    if (!props || typeof props !== 'object' || Array.isArray(props)) continue;
    const required = new Set<string>(
      Array.isArray(branch.required) ? branch.required.filter((v): v is string => typeof v === 'string') : [],
    );
    for (const [name, raw] of Object.entries(props as Record<string, unknown>)) {
      const prior = merged.get(name);
      if (prior) {
        prior.presentIn += 1;
        prior.requiredInAll = prior.requiredInAll && required.has(name);
        // A discriminated union repeats the discriminator in every branch with
        // a different literal. Keeping only branch one's raw schema makes a
        // multi-op tool look get-only. Merge scalar const/enum values while
        // retaining the conservative first-branch behavior for complex fields.
        prior.raw = mergeRepeatedPropertySchema(prior.raw, raw);
      } else {
        merged.set(name, { raw, presentIn: 1, requiredInAll: required.has(name) });
      }
    }
  }
  if (merged.size === 0) return null;

  const unionHint = branches.length > 1 ? unionRequiredKeyHint(branches) : '';
  const conditionalHint = branches.length > 1 ? unionConditionalHint(branches) : '';
  const required = new Set<string>();
  for (const [name, entry] of merged) {
    if (entry.presentIn === branches.length && entry.requiredInAll) required.add(name);
  }
  const entries = [...merged].map(([name, entry]) => [name, entry.raw] as [string, unknown]);
  // Prefer the canonical completion envelope to its many legacy shorthand
  // aliases. Validator-owned constraints consume part of the root budget, so
  // merely moving controls just before completion still lets preceding legacy
  // fields evict completion.verification.coverage at the final text cutoff.
  // Keep identity, shallow controls, the current-evidence selector and the
  // canonical record together before expendable aliases. Generic root unions
  // retain their source order.
  const completionIndex = entries.findIndex(([name]) => name === 'completion');
  const completionControls = new Set(['specAdequacy', 'validateOnly', 'assumptions']);
  if (completionIndex >= 0 && entries.some(([name]) => completionControls.has(name))) {
    const canonicalFields = new Set([
      'id', 'workItem', 'harness', 'state', 'recordOnly', 'validateOnly',
      'assumptions', 'specAdequacy', 'completion',
    ]);
    const canonical = entries.filter(([name]) => canonicalFields.has(name));
    const aliases = entries.filter(([name]) => !canonicalFields.has(name));
    return { entries: [...canonical, ...aliases], required, unionHint, conditionalHint };
  }
  return { entries, required, unionHint, conditionalHint };
}

/**
 * Discovery schemas now publish shared sub-objects through `$defs` and point at
 * them with `$ref` (work_items:complete's completion record, coord:send's body,
 * watch:create, events:await, triggers:bind, design-phase.*). Neither
 * `schemaToText` nor `compactSchemaForResult` follows a JSON pointer, so an
 * unresolved `$ref` renders as a BARE field name with no shape — discovery
 * silently stopped advertising `completion.verification.coverage`,
 * `completion.rootCauseVerification` and `body[].premises` the moment those
 * schemas moved into `$defs`, which is a wrong answer that looks like a
 * complete one. Inline the pointers ONCE at the corpus boundary so every
 * downstream renderer keeps seeing the same structural shape it saw before.
 *
 * This touches DISCOVERY only — the wire `inputSchema` the byte-budget guards
 * measure is a different object and is deliberately left referenced.
 *
 * The implementation lives in ../schema-ref-inline so the orient task schema
 * pack — a THIRD bounded renderer, in a different tree — resolves pointers the
 * same way without importing this whole 1.3k-line tool module onto a hot
 * recovery path. Re-exported here for callers already importing from find.
 */
export { withInlinedSchemaRefs };

/**
 * Render only the structural part of a JSON schema for the returned hit. The
 * full descriptions remain in the search corpus; this projection is what a
 * caller needs to form a valid next call without overflowing the result door.
 */
export function compactSchemaForResult(inputSchema: unknown): string | null {
  if (!inputSchema || typeof inputSchema !== 'object') return null;
  const root = inputSchema as JsonSchemaNode;
  const projection = topLevelSchemaProjection(root);
  if (!projection) return null;
  const parts = projection.entries.map(([name, raw], index) => {
    const node = raw && typeof raw === 'object' ? (raw as JsonSchemaNode) : {};
    // Root unions commonly carry verbose branch descriptions (the completion
    // contract is one such schema). Keep their projection structural so a
    // late top-level contract field such as `assumptions` cannot be clipped
    // behind a nested prose description before the result budget is reached.
    const shape = schemaShape(node, 0, !projection.unionHint);
    return {
      index,
      base: `${name}${projection.required.has(name) ? '' : '?'}${shape ? `:${shape}` : ''}`,
      description: compactTopLevelDescription(node, name),
    };
  });
  if (parts.length === 0) return null;
  const aliasHint = schemaAliasAnnotation(root);
  const callConstraints = schemaCallConstraintAnnotation(root, { compact: true });
  const prefix = `${callConstraints ? `${callConstraints}; ` : ''}${projection.unionHint ? `one-of:${projection.unionHint}; ` : ''}${projection.conditionalHint ? `${projection.conditionalHint}; ` : ''}${aliasHint ? `${aliasHint}; ` : ''}`;
  const withDescriptions = new Set(parts.filter((part) => part.description).map((part) => part.index));
  const render = (includedDescriptions: ReadonlySet<number>): string =>
    `${prefix}${parts
      .map((part) => `${part.base}${includedDescriptions.has(part.index) ? part.description?.text ?? '' : ''}`)
      .join('; ')}`;

  let text = render(withDescriptions);
  if (text.length > DISCOVERY_SCHEMA_MAX_CHARS && withDescriptions.size > 0) {
    // Remove low-value prose first, preserving explicit contract restrictions
    // such as "Completion phase only" for as long as the size budget allows.
    const removable = [...parts]
      .filter((part) => part.description)
      .sort((a, b) => (a.description!.priority - b.description!.priority) || (a.index - b.index));
    for (const part of removable) {
      withDescriptions.delete(part.index);
      text = render(withDescriptions);
      if (text.length <= DISCOVERY_SCHEMA_MAX_CHARS) break;
    }
  }
  return text.length <= DISCOVERY_SCHEMA_MAX_CHARS ? text : `${text.slice(0, DISCOVERY_SCHEMA_MAX_CHARS - 1)}…`;
}

/** Project a registered RESULT schema, including array/scalar-rooted shapes. */
export function compactOutputSchemaForResult(outputSchema: unknown): string | null {
  const objectShape = compactSchemaForResult(outputSchema);
  if (objectShape) return objectShape;
  if (!outputSchema || typeof outputSchema !== 'object') return null;
  const shape = schemaShape(outputSchema as JsonSchemaNode, 0);
  if (shape) return boundedText(shape, DISCOVERY_SCHEMA_MAX_CHARS);
  try {
    return boundedText(JSON.stringify(outputSchema), DISCOVERY_SCHEMA_MAX_CHARS);
  } catch {
    return null;
  }
}

function boundedText(value: string | null, maxChars: number): string | null {
  if (value == null || value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 1)}…`;
}

export interface DiscoveryResultHit {
  tool: string;
  description: string | null;
  argSchema: string | null;
  returns: string | null;
  returnsSource?: 'registered-output-schema' | 'authored-tool-guidance' | null;
  via: string;
}

/** Keep the result valid and useful when the caller asks for many hits. */
export function boundDiscoveryHits(
  base: Omit<Record<string, unknown>, 'hits' | 'count' | 'truncated'>,
  hits: DiscoveryResultHit[],
): { hits: DiscoveryResultHit[]; truncated: boolean } {
  const kept: DiscoveryResultHit[] = [];
  for (const hit of hits) {
    const candidate = [...kept, hit];
    const projected = {
      ...base,
      count: candidate.length,
      totalMatches: hits.length,
      truncated: candidate.length < hits.length,
      hits: candidate,
    };
    if (Buffer.byteLength(JSON.stringify(projected), 'utf8') > DISCOVERY_RESULT_MAX_BYTES && kept.length > 0) break;
    kept.push(hit);
  }
  return { hits: kept, truncated: kept.length < hits.length };
}

/**
 * Build the live corpus from the projected-tool registry: name + description +
 * guidance.when + arg-schema text. The arg-schema text makes a tool's PARAMETERS
 * searchable/embeddable (so "set a flag by key" can match `flags:set`'s `key`
 * arg) and lets `tools:find` RETURN the schema with each hit. The embed text is
 * `name \n description \n when \n argSchema` — the richest intent signal for the
 * semantic leg.
 */
// Schema-to-text projection is materially more expensive than lexical ranking.
// Reuse one snapshot per executable registry revision so a recovery lookup does
// not rebuild every projected tool contract on every call. Plugin/catalog drift
// changes the revision and therefore invalidates this cache.
let corpusCache: { revision: string; value: ToolFindCorpus } | null = null;

export function buildCorpus(): ToolFindCorpus {
  const revision = projectedToolRegistryRevision();
  if (corpusCache?.revision === revision) return corpusCache.value;

  const corpus: ToolDiscoveryEntry[] = [];
  const embedText = new Map<string, string>();
  const returnsByTool = new Map<string, string>();
  const returnSourcesByTool = new Map<string, 'registered-output-schema' | 'authored-tool-guidance'>();
  const schemaByTool = new Map<string, unknown>();
  for (const tool of listAllProjectedTools()) {
    if (!tool.expose.mcp) continue;
    const name = tool.expose.mcp.name;
    const when = tool.guidance?.when?.trim();
    // Strict MCP/OpenAI callers receive the flattened schema, but discovery
    // needs the raw union so branch requirements (for example path OR sha)
    // remain visible. Older/plugin projections may not expose the raw field,
    // so retain the flattened fallback.
    // `$ref`/`$defs` are inlined HERE, at the single choke point both renderers
    // read from, so schemaToText (argSchema) and compactSchemaForResult
    // (schemaByTool) recover the structural shape a bare pointer hides.
    const discoverySchema = withInlinedSchemaRefs(tool.discoveryInputSchema ?? tool.inputSchema);
    const argSchema = schemaToText(discoverySchema);
    const schemaReturns = compactOutputSchemaForResult(tool.outputJsonSchema);
    const authoredReturns = tool.guidance?.returns?.trim();
    if (schemaReturns) {
      returnsByTool.set(name, schemaReturns);
      returnSourcesByTool.set(name, 'registered-output-schema');
    } else if (authoredReturns) {
      returnsByTool.set(name, authoredReturns);
      returnSourcesByTool.set(name, 'authored-tool-guidance');
    }
    schemaByTool.set(name, discoverySchema);
    // Fold the "when to use" line into the searchable text — it's the richest
    // intent signal for both legs (lexical description weight + the embedding).
    const description = [tool.description, when].filter(Boolean).join(' ').trim() || null;
    corpus.push({
      tool: name,
      category: categoryOf(name),
      capability: tool.capabilities[0] ?? null,
      description,
      argSchema,
      provider: null,
      unit: null,
    } as unknown as ToolDiscoveryEntry);
    embedText.set(name, [name, tool.description, when, argSchema].filter(Boolean).join('\n'));
  }
  const value = { revision, corpus, embedText, returnsByTool, returnSourcesByTool, schemaByTool };
  corpusCache = { revision, value };
  return value;
}

type DiscoveryScopeContext = {
  workspaceId?: unknown;
  harnessSlug?: unknown;
};

type ToolFindCorpus = {
  /** Registry revision that produced every corpus row and embedding text. */
  revision: string;
  corpus: ToolDiscoveryEntry[];
  embedText: Map<string, string>;
  /** name → the derived output schema projection, or authored prose fallback. */
  returnsByTool: Map<string, string>;
  /** Provenance for returnsByTool; registered schemas always outrank prose. */
  returnSourcesByTool: Map<string, 'registered-output-schema' | 'authored-tool-guidance'>;
  /** name → raw schema, used to project a compact schema in the response. */
  schemaByTool: Map<string, unknown>;
};

type HiveHomeResolver = (workspaceId: string, harnessSlug: string) => Promise<string | null>;

/**
 * Mirror the transport's confirmed hive visibility before ranking. A
 * hive-scoped superuser cannot call `cross_harness:*`, so leaving those rows in
 * the discovery corpus can spend a narrow result (especially `limit: 1`) on a
 * tool the same request path must reject. Resolution is deliberately fail-open:
 * only a concrete, positively resolved hive scope removes catalog entries.
 */
export async function filterCorpusForConfirmedHiveScope(
  corpus: ToolDiscoveryEntry[],
  scope: DiscoveryScopeContext,
  resolveHiveHome: HiveHomeResolver,
  timeoutMs = DISCOVERY_HIVE_SCOPE_TIMEOUT_MS,
): Promise<ToolDiscoveryEntry[]> {
  const workspaceId = typeof scope.workspaceId === 'string' ? scope.workspaceId.trim() : '';
  const harnessSlug = typeof scope.harnessSlug === 'string' ? scope.harnessSlug.trim() : '';
  if (
    !workspaceId ||
    workspaceId === '*' ||
    workspaceId === 'all' ||
    !harnessSlug ||
    harnessSlug === '*' ||
    harnessSlug === 'all'
  ) {
    return corpus;
  }

  const resolution = await withBoundedTimeout(
    () => resolveHiveHome(workspaceId, harnessSlug),
    {
      fallback: null,
      timeoutMs,
      label: 'tools:find hive scope resolution',
    },
  );
  const hiveHome = resolution.value;
  if (resolution.degraded) return corpus;
  if (!hiveHome) return corpus;

  return corpus.filter((entry) => !entry.tool.startsWith('cross_harness:'));
}

// ── Boot-time embedding index over the full catalog (module-scoped cache) ─────
// Built ONCE at startup (see warmToolFindIndex below) so the semantic leg is
// live for the FIRST agent call rather than each cold worker warming lazily on
// first use — the failure mode where rate-governed 551-tool warming never
// finishes before a call lands. Rebuilt whenever the executable registry
// revision changes, even when the catalog keeps the same number of tools (a
// same-cardinality rename/schema edit must not reuse old vectors).
let queryEmbedder: Embedder | null | undefined; // undefined = not yet resolved
let embIndex: Map<string, number[]> | null = null;
let indexedRevision: string | null = null;
let building: { revision: string; promise: Promise<void> } | null = null;

async function getEmbedder(): Promise<Embedder | null> {
  if (queryEmbedder === undefined) {
    try {
      queryEmbedder = await buildQueryEmbedder({ acquireBudgetMs: interactiveEmbedAcquireBudgetMs() });
    } catch {
      queryEmbedder = null;
    }
  }
  return queryEmbedder;
}

/**
 * Embed every corpus row → `name → vector` map. Per-row failures (admission
 * shed / transient fetch error) are skipped — a partial index still broadens
 * recall. Pure over its inputs; exported so the index build is unit-testable
 * with a mock embedder.
 */
export async function buildEmbeddingIndex(
  embedText: ReadonlyMap<string, string>,
  embedder: Embedder,
): Promise<Map<string, number[]>> {
  const next = new Map<string, number[]>();
  for (const [name, text] of embedText) {
    try {
      const v = await embedder(text);
      if (Array.isArray(v) && v.length > 0) next.set(name, v);
    } catch {
      /* skip this tool — partial index still helps */
    }
  }
  return next;
}

/**
 * Build (or rebuild on registry-revision drift) the module-scoped embedding index. Idempotent
 * + single-flight: a no-op when fresh or when no embedder is configured (→
 * lexical-only), and concurrent callers share the one in-flight build. Returns
 * the in-flight promise (so a boot/test caller can await it) or null when there
 * is nothing to do.
 */
export function ensureIndex(
  embedText: ReadonlyMap<string, string>,
  embedder: Embedder | null,
  revision: string,
): Promise<void> | null {
  if (!embedder) return null; // unconfigured → lexical-only
  if (embIndex && indexedRevision === revision) return null; // fresh
  if (building?.revision === revision) return building.promise; // single-flight

  const promise = buildEmbeddingIndex(embedText, embedder)
    .then((idx) => {
      // A newer registry revision may have started while this build was in
      // flight. Do not let the older result become the active index again.
      if (building?.revision === revision) {
        embIndex = idx;
        indexedRevision = revision;
      }
    })
    .catch(() => {
      /* leave the prior index in place; a later call retries */
    })
    .finally(() => {
      if (building?.promise === promise) building = null;
    });
  building = { revision, promise };
  return promise;
}

/**
 * Boot entry point: resolve the embedder and build the catalog embedding index.
 * Fired once at module load (below) so the index warms from STARTUP. The
 * embedder is resolved BEFORE buildCorpus so the first `await` lets the rest of
 * the tool tree finish registering — the corpus is then read complete. Awaitable
 * for tests / explicit warmers; resolves once the index is ready (or immediately
 * when no embedder is configured).
 */
export async function warmToolFindIndex(): Promise<void> {
  const embedder = await getEmbedder();
  const { embedText, revision } = buildCorpus();
  const p = ensureIndex(embedText, embedder, revision);
  if (p) await p;
}

// Kick the warm off at module load (boot). Skipped under vitest — tests drive
// the index explicitly; and it self-heals on first call regardless (the handler
// re-invokes ensureIndex). Fire-and-forget: never blocks boot.
if (!process.env.VITEST) {
  void warmToolFindIndex().catch(() => {});
}

/**
 * Normalize the common legacy `q` spelling before the strict discovery args
 * schema runs. Search callers frequently use `q`, while this tool's canonical
 * field is `query`; when both are supplied, explicit `query` wins.
 */
export function normalizeToolsFindArgs(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;
  const args = raw as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(args, 'q')) return raw;

  const { q, ...rest } = args;
  return rest.query !== undefined ? rest : { ...rest, query: q };
}

export default defineTool({
  name: 'tools:find',
  description:
    // P-011 prompt-weight: the result-shape prose below moved into the free `returns`
    // field, which already described this exact payload (EI-22083648545226771).
    'Find tools by INTENT across the full ~550-tool catalog (hybrid lexical + semantic). ACTIVATION IS ' +
    'CONDITIONAL: on a seeded (small-surface) session the matches are added to your live tool list ' +
    '(activated:true) and are directly callable; on a full-catalog session there is nothing to expand ' +
    '(activated:false) — call them via tools:invoke. High-confidence runtime symptoms (slow/queued, ' +
    'connection-refused, no-window, change-live?, value-stale?) route their decisive diagnostic to hit #1.',
  guidance: {
    when:
      'You need a tool that is not in your loaded/core set and do not know its exact name — search by what you want to DO ' +
      '("set a feature flag", "spawn a worker bee").',
    notWhen:
      'The tool is already in your core set or you know its exact name — just call it. `tools:find` is catalog-global; its scope is resolved from session context automatically, so a per-call `harness`/`workspace` is accepted but ignored — it never filters or narrows results.',
    chaining:
      'tools:find("<intent>") → call the top hit through tools:invoke in the SAME turn. `activated:true` ' +
      'means the server surface grew and requested a client refresh; it does not guarantee this client has ' +
      'materialized a direct-call wrapper yet. After a refresh/next turn, direct calls may work.',
    returns:
      '{ query, count, semantic: "on"|"warming"|"lexical-only", registry: { source, revision }, activated (were the hits added to YOUR live tool surface), hits: [{ tool, description, argSchema, returns (registered output schema projection, otherwise authored fallback, otherwise null), returnsSource:"registered-output-schema"|"authored-tool-guidance"|null, via }], howToCall }. ' +
      'Each hit carries that tool\'s ARG schema AND its resolved RESPONSE shape (registered output schemas outrank authored prose), so you can write a code:run batch over a tool without calling it once just to learn its field names. ' +
      'ALWAYS read `activated` + `howToCall` rather than assuming a direct call resolves.',
    seeAlso: [
      'agent_tools:list (full permission-annotated dump)',
      'meta:define-tool (define a new tool if none exists)',
    ],
  },
  capability: 'agent_tools:read',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  // Discovery is the recovery door for locating diagnostics/restart tools when the
  // operator is degraded. The handler reads only the in-process tool catalog and
  // embedding index; retaining an ambient org-app transaction makes that recovery
  // door wait behind the very DB pool queue it is meant to diagnose.
  skipWorkspaceTx: true,
  args: z.preprocess(
    normalizeToolsFindArgs,
    z.object({
      /** What you want to do, in natural language or keywords. */
      query: z.string().min(1).max(400).optional(),
      q: z
        .string()
        .min(1)
        .max(400)
        .optional()
        .describe('Compatibility alias for `query`; explicit `query` wins when both are supplied.'),
      /** Max results (default 8). */
      limit: z.number().int().positive().max(25).optional(),
      // EI-21854434860586936: every other harness/workspace-scoped tool in the
      // catalog accepts a `harness` (and often `workspace`) arg, so callers
      // naturally reach for the same shape here — but this tool is catalog-global
      // and its scope is already resolved from ctx automatically. Rejecting the
      // near-universal convention as `invalid_args` produced a recurring
      // caller-error watchdog signal even after the guidance.notWhen text was
      // added (2026-08-27) explicitly telling callers not to pass it — the text
      // wasn't visible enough to prevent the mistake. Accept-and-ignore (the same
      // "compatibility hint" pattern already used by rubrics:get's `harness` arg)
      // removes the friction without changing behavior for anyone who was already
      // calling correctly.
      harness: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Optional caller scope hint accepted for compatibility; ignored — tools:find is catalog-global and its scope is resolved from session context automatically.',
        ),
      workspace: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Optional caller scope hint accepted for compatibility; ignored — tools:find is catalog-global and its scope is resolved from session context automatically.',
        ),
    }).superRefine((args, ctx) => {
      // normalizeToolsFindArgs has already mapped a q-only call to query here.
      // Keep query optional in the published structural schema so the q alias
      // is truthfully callable, while preserving the runtime requirement that
      // one non-empty spelling must be supplied.
      if (args.query === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['query'],
          message: 'query (or compatibility alias q) is required',
        });
      }
    }),
  ),
  result: z
    .object({
      query: z.unknown().optional(),
      count: z.unknown().optional(),
      semantic: z.unknown().optional(),
      registry: z.unknown().optional(),
      activated: z.unknown().optional(),
      hits: z.unknown().optional(),
      howToCall: z.unknown().optional(),
    })
    .passthrough(),
  async handler(args, ctx) {
    // The args refinement above guarantees this for every dispatched call.
    // Keep the guard because focused tests may invoke the handler directly and
    // because it narrows the inferred optional schema field for this function.
    if (!args.query) throw new Error('tools:find query is required after argument normalization');
    // host-bootstrap starts plugin discovery fire-and-forget. Join the same
    // single-flight readiness promise before snapshotting the projected
    // registry, otherwise a first post-restart request can build a corpus
    // while plugin tools are still being wired. Keep this import dynamic so
    // the plugin host does not become part of the agent-tools registry cycle.
    await withBoundedTimeout(
      () => import('../../plugin-host-runtime').then(({ getPluginHost }) => getPluginHost()),
      {
        fallback: null,
        timeoutMs: PLUGIN_HOST_READINESS_TIMEOUT_MS,
        label: 'tools:find plugin-host readiness',
      },
    );
    const { corpus: fullCorpus, embedText, returnsByTool, returnSourcesByTool, schemaByTool, revision } = buildCorpus();
    const registry = {
      source: PROJECTED_TOOL_REGISTRY_SOURCE,
      revision,
    };
    const concreteHarnessSlug = resolveConcreteHarnessSlug(undefined, ctx);
    const corpus = await filterCorpusForConfirmedHiveScope(
      fullCorpus,
      { workspaceId: ctx.workspaceId, harnessSlug: concreteHarnessSlug },
      async (workspaceId, harnessSlug) => {
        const { potHomeSlugForHarness } = await import('../../hive-federation');
        return potHomeSlugForHarness(workspaceId, harnessSlug);
      },
    );
    const embedder = await getEmbedder();
    // Self-heal: rebuild if boot warm didn't run or the catalog drifted. Non-
    // blocking — this call uses whatever index is ready right now.
    void ensureIndex(embedText, embedder, revision);

    // A revision change can leave the prior index available while the new one
    // warms. Never score the current corpus with those stale vectors; report
    // `warming` and use the lexical leg until the matching revision is ready.
    const activeEmbeddings = indexedRevision === revision ? embIndex : null;

    const hits = await findTools(corpus, args.query, {
      limit: args.limit ?? 8,
      embedder,
      embeddings: activeEmbeddings,
      // WI-20202755675039636: a resolved provider can still stall (notably an
      // OpenAI fetch without a client-side timeout); keep discovery responsive
      // by degrading this query to lexical-only at the interactive budget.
      embedTimeoutMs: interactiveEmbedAcquireBudgetMs(),
    });

    // `tools:find` returns a hand-serialized ToolResult, so the generic
    // payload-tier shaper cannot expand its compact discovery projection for
    // an explicit `payloadTier:'full'` request. Preserve the ordinary bounded
    // shape by default; an explicit full request gets the complete JSON schema
    // so deep fields omitted by the searchable one-level corpus text remain available.
    const fullArgSchemaRequested = ctx.payloadTierOverride === 'full';

    // Honest mode marker (never silently pretend semantic ran):
    //   on          — index ready, the semantic leg contributed;
    //   warming      — embedder configured, index still building (lexical-only this call);
    //   lexical-only — no embedder configured/available → graceful degrade.
    const semantic: 'on' | 'warming' | 'lexical-only' =
      activeEmbeddings != null && activeEmbeddings.size > 0 ? 'on' : embedder ? 'warming' : 'lexical-only';
    const projectedHits = hits.map((h) => ({
      tool: h.tool,
      description: boundedText(h.description, DISCOVERY_DESCRIPTION_MAX_CHARS),
      argSchema: fullArgSchemaRequested
        ? JSON.stringify(schemaByTool.get(h.tool)) ?? h.argSchema
        : compactSchemaForResult(schemaByTool.get(h.tool)) ?? boundedText(h.argSchema, DISCOVERY_SCHEMA_MAX_CHARS),
      returns: returnsByTool.get(h.tool) ?? null,
      returnsSource: returnSourcesByTool.get(h.tool) ?? null,
      via: h.via,
    }));

    const hasToolsInvokeHit = projectedHits.some((hit) => hit.tool === 'tools:invoke');
    const activatedHowToCall =
      'activated:true means the SERVER surface grew and requested a client tool-list refresh; ' +
      'it does NOT guarantee your client has materialized a direct-call wrapper in this same turn. ' +
      (hasToolsInvokeHit
        ? 'The tools:invoke hit is the dispatcher itself; do NOT pass name:"tools:invoke" through it. ' +
          'Call tools:invoke directly with the name + args of a different target tool. '
        : 'Call tools:invoke {name:"<exact tool name from hits>", args:{...}} now — it works immediately ' +
          'on every client via server-side dispatch. ') +
      'After the client refreshes (often next turn), the direct wrapper may also be available.';
    const inactiveHowToCall = hasToolsInvokeHit
      ? 'activated:false — direct calls to other hits may fail with unknown/not-found. The ' +
        'tools:invoke hit is the dispatcher itself; do NOT pass name:"tools:invoke" through it. ' +
        'Call tools:invoke directly with the name + args of a different target tool. ' +
        'Do NOT try ToolSearch on the colon name — it only resolves the client-mangled id.'
      : 'activated:false — these tools are NOT on your live tool surface, so a direct call will ' +
        'fail with unknown/not-found. Call them with ' +
        'tools:invoke {name:"<exact tool name from hits>", args:{...}} — server-side dispatch under ' +
        "the tool's real (colon-form) name; works on every client, needs no load step. " +
        'Do NOT try ToolSearch on the colon name — it only resolves the client-mangled id.';

    // Bound the candidate names before activating them. Otherwise a large schema
    // can cause the response to omit a matched tool while still adding that
    // invisible tool to the session surface (the activation contract is about
    // the hits the caller can actually see and invoke).
    const activationCandidate = boundDiscoveryHits(
      {
        query: args.query,
        semantic,
        registry,
        activated: true,
        howToCall: activatedHowToCall,
        totalMatches: hits.length,
      },
      projectedHits,
    );

    // Dynamic expansion (dynamic-tool-surface-2026-07-01): activate the matched
    // tools for THIS session so a seeded (small-surface) client can call them.
    // On a listChanged-capable transport this also fires tools/list_changed so
    // the client re-fetches tools/list and the surfaced tools become callable.
    // No-op (returns false) on a full-catalog / un-seeded session — nothing to
    // expand — and on transports without a mutable surface. NEVER let a surface
    // failure break discovery: the hits are still returned.
    let activated = false;
    try {
      activated = ctx.activateTools?.(activationCandidate.hits.map((h) => h.tool)) ?? false;
    } catch {
      /* activation is best-effort; discovery still succeeds */
    }

    const howToCall = activated ? activatedHowToCall : inactiveHowToCall;
    const bounded = boundDiscoveryHits(
      { query: args.query, semantic, registry, activated, howToCall, totalMatches: hits.length },
      projectedHits,
    );
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            query: args.query,
            count: bounded.hits.length,
            totalMatches: hits.length,
            truncated: bounded.truncated,
            semantic,
            registry,
            // true ⇒ the server-side session allowlist grew and emitted the
            // standard list_changed request. It cannot prove the client has
            // consumed that notification and materialized wrappers yet.
            activated,
            hits: bounded.hits,
            // EI-10885: when activation did NOT happen, the old text still LED with
            // "Call the tool directly" — the one path that cannot work on this
            // surface — and relegated the path that always works to a fallback after
            // a failure. An agent that follows the instruction in order pays a
            // guaranteed wasted call. Lead with the working path instead.
            howToCall,
          }),
        },
      ],
    };
  },
});
