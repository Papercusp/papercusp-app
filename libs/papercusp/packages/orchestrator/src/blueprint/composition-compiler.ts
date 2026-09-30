/**
 * The one composition boundary for an effective agent specification.
 *
 * `identities-v1-2026-08-30` P-038 / D-028 deliberately keeps this module on
 * top of the existing seams instead of introducing another loader or package
 * store.  The loader resolves the authored blueprint stack, prompt-resolve
 * resolves the prompt files, and render-stack remains the authority for a
 * sealed stack render.  This module snapshots the results and all externally
 * supplied inputs into one content-addressed, immutable artifact.
 *
 * There are two important rules here:
 *
 *  1. A missing or corrupt input is an error.  In particular, a failed prompt
 *     or addressed-document read must never quietly select a different
 *     identity or an older document.
 *  2. Mutable mode/policy state is an explicit `setting` input.  It is not
 *     merged into the runnable blueprint and therefore cannot masquerade as
 *     authored identity configuration.
 *
 * The compiler is synchronous on purpose.  Database-backed callers read
 * addressed document rows first (the operator-core projection owns that I/O)
 * and hand the exact rows/revision here.  Keeping the final boundary pure and
 * synchronous makes byte identity testable and lets chat, su, and spawn
 * adapters consume the same artifact.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, lstatSync, statSync } from 'node:fs';
import { dirname, join, isAbsolute, resolve as resolvePath } from 'node:path';
import { harnessRoot } from '@papercusp/harness/paths';
import { parse as parseYaml } from 'yaml';
import {
  ResolvedAgentSpecificationSchema,
  BlueprintSourceDocumentSchema,
  RunnableBlueprintSchema,
  ResolvedAgentInputSchema,
  ResolvedPackageInputSchema,
  RESOLVED_AGENT_SPECIFICATION_SCHEMA_VERSION,
  type BlueprintSourceKind,
  type BlueprintSourceDocument,
  type RunnableBlueprint,
  type BlueprintContribution,
  type ResolvedAgentInput,
  type ResolvedAgentProvenance,
  type ResolvedPackageInput,
  type ResolvedPackageReference,
} from './schema.js';
import {
  layerSourceDocument,
  layerContentHash,
  blueprintHash,
  resolveBlueprint,
  resolveBlueprintSource,
  type BlueprintValidateRegistry,
  type LoadedBlueprint,
  type ResolveExtendsPath,
} from './loader.js';
import { stableStringify } from './merge.js';
import {
  resolvePromptFiles,
  resolveReplacementSystemPromptStack,
  type PromptResolveContext,
} from '../prompt-resolve.js';
import { composeStack, type StackDocument } from './render-stack.js';
import type { IdentityLintOptions } from './identity-lint.js';

/** Compiler implementation version.  A semantic change requires a new value. */
export const COMPOSITION_COMPILER_VERSION = '1.7.0';
/** Alias used by callers that call the value a compiler revision. */
export const COMPOSITION_COMPILER_REVISION = COMPOSITION_COMPILER_VERSION;

const SHA256_RE = /^[0-9a-f]{64}$/;
const PROMPT_SEPARATOR = '\n\n---\n\n';

export type CompositionCompilerErrorCode =
  | 'missing-source'
  | 'source-resolution-failed'
  | 'source-invalid'
  | 'prompt-missing'
  | 'prompt-read-failed'
  | 'prompt-empty'
  | 'prompt-hash-mismatch'
  | 'addressed-document-invalid'
  | 'addressed-document-missing-revision'
  | 'addressed-document-missing-content'
  | 'addressed-document-hash-mismatch'
  | 'setting-invalid'
  | 'input-invalid'
  | 'input-conflict'
  | 'contribution-missing'
  | 'contribution-source-mismatch'
  | 'contribution-not-delivered'
  | 'package-missing'
  | 'package-read-failed'
  | 'package-hash-mismatch'
  | 'package-pin-conflict'
  | 'specification-hash-mismatch'
  | 'operation-not-found';

/** A diagnosable, machine-classifiable compiler refusal. */
export class CompositionCompilerError extends Error {
  readonly code: CompositionCompilerErrorCode;
  readonly ref?: string;

  constructor(code: CompositionCompilerErrorCode, message: string, ref?: string) {
    super(`composition compiler [${code}]${ref ? ` ${JSON.stringify(ref)}` : ''}: ${message}`);
    this.name = 'CompositionCompilerError';
    this.code = code;
    this.ref = ref;
  }
}

/** A prompt source supplied by a caller or discovered by prompt-resolve. */
export interface CompositionPromptFileInput {
  /** Stable input reference; defaults to `path` for file-backed inputs. */
  ref?: string;
  /** File path.  When omitted, `bytes` must be supplied. */
  path?: string;
  /** Exact UTF-8 prompt bytes as text. */
  bytes?: string;
  /** Optional expected sha256 of `bytes` / the file contents. */
  contentHash?: string;
}

/** One addressed Project-guide document row, or a compatible DB projection row. */
export interface CompositionAddressedDocumentInput {
  ref?: string;
  partKey?: string;
  /** Compatibility spelling from `harness_doc_parts`. */
  part_key?: string;
  revision?: string | number;
  contentHash?: string;
  /** Compatibility spelling from raw rows. */
  content_hash?: string;
  text?: string;
  body?: string;
  ordinal?: number;
  targetSection?: string | null;
  target_section?: string | null;
}

/** A revision envelope for a set of addressed rows. */
export interface CompositionAddressedDocumentSet {
  revision?: string | number;
  contentHash?: string;
  parts: readonly CompositionAddressedDocumentInput[];
}

/** Mutable mode/policy state.  It is deliberately represented as an input, not config. */
export interface CompositionSettingInput {
  ref: string;
  revision: string | number;
  value: unknown;
  producerRef?: string;
}

export interface CompositionContributionOmissionInput {
  id: string;
  /**
   * 'experiment-arm' (R-4 / D-032): a behavior arm deliberately withheld the
   * contribution. Like 'ineligible' it is preserved even when the declared
   * refresh is due — only 'not-requested' is refused there. Operator-core's
   * IDENTITY_OMISSION_REASONS is assigned into this type, so a reason added
   * there but not here fails typecheck.
   */
  reason: 'ineligible' | 'not-requested' | 'unavailable' | 'experiment-arm';
  /** Required when a producer was unavailable, so that failure is addressable. */
  errorRef?: string;
}

/** A prompt descriptor.  `documents` uses the existing sealed render seam. */
export interface CompositionPromptInput {
  role?: string;
  kind?: string;
  context?: PromptResolveContext;
  files?: readonly (string | CompositionPromptFileInput)[];
  /** An already-rendered inline prompt (useful for a caller-owned adapter). */
  text?: string;
  /** Stack documents are ordered and sealed by `composeStack`; no hand-rendering is done here. */
  documents?: readonly StackDocument[];
}

/**
 * Inputs accepted by the compiler.  `source` may be a raw authored mapping or
 * an already loaded result; `sourcePath` is a convenience for a YAML source.
 * The aliases (`blueprint`, `loaded`, `promptFiles`, `addressedGuide`,
 * `mutableState`) keep migration adapters small while they converge on this
 * one boundary.
 */
export interface CompositionCompilerInput {
  source?: LoadedBlueprint | Record<string, unknown>;
  blueprint?: LoadedBlueprint | Record<string, unknown>;
  loaded?: LoadedBlueprint;
  sourcePath?: string;
  harnessDir?: string;
  resolve?: ResolveExtendsPath;
  registry?: BlueprintValidateRegistry;
  lint?: IdentityLintOptions;

  role?: string;
  promptRole?: string;
  promptContext?: PromptResolveContext;
  prompt?: CompositionPromptInput | readonly CompositionPromptInput[];
  prompts?: CompositionPromptInput | readonly CompositionPromptInput[];
  /** Top-level shorthand for one prompt descriptor's files. */
  promptFiles?: readonly (string | CompositionPromptFileInput)[];
  /** Fixed source files already present in a caller-rendered prompt. Pin and
   * bind their declarations without appending their text a second time. */
  pinnedFixedPromptFiles?: readonly (string | CompositionPromptFileInput)[];
  /** Existing render-stack seam, useful for su and replacement-system prompts. */
  stackDocuments?: readonly StackDocument[];

  addressedDocuments?: readonly CompositionAddressedDocumentInput[] | CompositionAddressedDocumentSet;
  addressedGuide?: CompositionAddressedDocumentSet;
  /** When false, addressed row bodies remain pinned inputs but are not appended to prompt text. */
  includeAddressedDocuments?: boolean;

  settings?: readonly CompositionSettingInput[];
  /** One explicit state input, normally `{ ref: 'mode', revision, value }`. */
  mutableState?: CompositionSettingInput;
  state?: CompositionSettingInput;

  /** Explicit receipt for a conditionally absent provider contribution. */
  contributionOmissions?: readonly CompositionContributionOmissionInput[];
  /** Cadence requested by this delivery sink. Omit for a source-only compile.
   * Recorded in the immutable input closure, never inferred from a declaration. */
  contributionRefresh?: BlueprintContribution['refresh'];

  /** Additional already-pinned closure entries (package/dependency adapters use this). */
  inputClosure?: readonly ResolvedAgentInput[];
  /** Optional externally known revisions for source layers; hashes remain the content identity. */
  layerRevisions?: Readonly<Record<string, string>>;
  compilerVersion?: string;
}

/** The output is the schema's deeply frozen `ResolvedAgentSpecification`. */
export type CompiledAgentSpecification = ReturnType<typeof ResolvedAgentSpecificationSchema.parse>;

function fail(code: CompositionCompilerErrorCode, message: string, ref?: string): never {
  throw new CompositionCompilerError(code, message, ref);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLoadedBlueprint(value: unknown): value is LoadedBlueprint {
  if (!isRecord(value)) return false;
  return (
    isRecord(value.blueprint) &&
    typeof value.contentHash === 'string' &&
    Array.isArray(value.layers) &&
    typeof value.sourceKind === 'string'
  );
}

function assertSha(value: string, what: string, ref?: string): string {
  if (!SHA256_RE.test(value)) fail('input-invalid', `${what} must be a lowercase sha256 hex digest`, ref);
  return value;
}

/** Canonical JSON-ish clone.  It both prevents caller mutation and omits undefined object keys. */
function cloneJson(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('input-invalid', `non-finite number ${String(value)} is not JSON-serializable`);
    return value;
  }
  if (Array.isArray(value)) return value.map(cloneJson);
  if (isRecord(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue;
      out[key] = cloneJson(value[key]);
    }
    return out;
  }
  // Dates, functions, Buffers, and class instances are not valid serialized
  // setting values.  Refuse them instead of hashing an implementation detail.
  fail('input-invalid', `value at ${whatPath(value)} is not JSON-serializable`);
}

function whatPath(value: unknown): string {
  return Object.prototype.toString.call(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalHash(value: unknown): string {
  return sha256(stableStringify(cloneJson(value)));
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function asRevision(value: string | number | undefined, what: string, ref?: string): string {
  if (value === undefined || value === null || String(value).trim() === '') {
    fail('addressed-document-missing-revision', `${what} needs an explicit non-empty revision`, ref);
  }
  return String(value);
}

type LoadedComposition = Omit<LoadedBlueprint, 'blueprint'> & {
  blueprint: LoadedBlueprint['blueprint'] | BlueprintSourceDocument;
};

function sourceFor(input: CompositionCompilerInput): LoadedComposition {
  const candidate = input.loaded ?? input.source ?? input.blueprint;
  if (candidate !== undefined) {
    if (isLoadedBlueprint(candidate)) {
      if (!candidate.validation?.ok) fail('source-invalid', 'the supplied LoadedBlueprint has validation errors');
      if (!candidate.layers.length) fail('source-invalid', 'the supplied LoadedBlueprint has no source layers');
      assertSha(candidate.contentHash, 'loaded blueprint contentHash');
      return candidate;
    }
    if (!isRecord(candidate)) fail('source-invalid', 'source must be a YAML mapping or LoadedBlueprint');
    try {
      const authored = resolveBlueprintSource(candidate, {
        resolve: input.resolve,
        sourcePath: input.sourcePath ?? null,
        lint: input.lint,
      });
      if (!authored.validation.ok) fail('source-invalid', 'the supplied identity source has validation errors');
      if (!RunnableBlueprintSchema.safeParse(authored.merged).success) {
        return {
          blueprint: BlueprintSourceDocumentSchema.parse(authored.merged),
          sourceKind: authored.source.kind,
          validation: authored.validation,
          contentHash: canonicalHash(authored.merged),
          sourcePath: input.sourcePath ?? null,
          layers: authored.layers,
        };
      }
      return resolveBlueprint(candidate, {
        resolve: input.resolve,
        sourcePath: input.sourcePath ?? null,
        registry: input.registry,
        lint: input.lint,
      });
    } catch (error) {
      fail(
        'source-resolution-failed',
        error instanceof Error ? error.message : String(error),
        input.sourcePath,
      );
    }
  }
  if (input.sourcePath) {
    try {
      const raw = parseYaml(readFileSync(input.sourcePath, 'utf8'));
      if (!isRecord(raw)) fail('source-invalid', 'source file must contain a YAML mapping', input.sourcePath);
      return sourceFor({ ...input, source: raw });
    } catch (error) {
      fail('source-resolution-failed', error instanceof Error ? error.message : String(error), input.sourcePath);
    }
  }
  fail('missing-source', 'a raw source, LoadedBlueprint, or sourcePath is required; no identity fallback is attempted');
}

function defaultPromptContext(
  input: CompositionCompilerInput,
  loaded: LoadedComposition,
): PromptResolveContext {
  const supplied = input.promptContext;
  const harnessDir = supplied?.harnessDir ?? input.harnessDir ?? harnessRoot();
  const chain = supplied?.extendsChain ?? loaded.layers.map((layer) => layer.id).reverse();
  return {
    harnessDir,
    phase: supplied?.phase ?? '',
    dept: supplied?.dept ?? '',
    ...supplied,
    blueprintId: supplied?.blueprintId ?? loaded.blueprint.id,
    extendsChain: chain,
  };
}

function normalizePromptDescriptors(input: CompositionCompilerInput): CompositionPromptInput[] {
  const supplied = input.prompts ?? input.prompt;
  const descriptors: CompositionPromptInput[] = supplied
    ? (Array.isArray(supplied) ? [...supplied] : [supplied])
    : [];
  if (descriptors.length === 0 && (input.role || input.promptRole || input.promptFiles || input.stackDocuments)) {
    descriptors.push({
      role: input.role ?? input.promptRole,
      files: input.promptFiles,
      documents: input.stackDocuments,
    });
  }
  return descriptors;
}

function promptFileFromPath(path: string, expectedHash?: string, ref?: string, baseDir?: string): CompositionPromptFileInput {
  const resolved = isAbsolute(path) ? path : resolvePath(baseDir ?? process.cwd(), path);
  if (!existsSync(resolved)) fail('prompt-missing', 'prompt file does not exist', ref ?? path);
  try {
    if (!statSync(resolved).isFile()) fail('prompt-read-failed', 'prompt path is not a regular file', ref ?? path);
    const bytes = readFileSync(resolved, 'utf8');
    if (bytes.length === 0) fail('prompt-empty', 'prompt file is empty', ref ?? resolved);
    const contentHash = sha256(bytes);
    if (expectedHash !== undefined && assertSha(expectedHash, 'prompt contentHash', ref ?? resolved) !== contentHash) {
      fail('prompt-hash-mismatch', `expected ${expectedHash}, read ${contentHash}`, ref ?? resolved);
    }
    return { ref: ref ?? resolved, path: resolved, bytes, contentHash };
  } catch (error) {
    if (error instanceof CompositionCompilerError) throw error;
    fail('prompt-read-failed', error instanceof Error ? error.message : String(error), ref ?? resolved);
  }
}

function normalizePromptFile(
  value: string | CompositionPromptFileInput,
  descriptorRef: string,
  baseDir?: string,
): CompositionPromptFileInput {
  if (typeof value === 'string') {
    return promptFileFromPath(value, undefined, value, baseDir);
  }
  if (!isRecord(value)) fail('prompt-read-failed', 'prompt file descriptor must be a path or mapping', descriptorRef);
  const path = typeof value.path === 'string'
    ? isAbsolute(value.path) || !baseDir
      ? value.path
      : resolvePath(baseDir, value.path)
    : undefined;
  const ref = typeof value.ref === 'string' && value.ref.trim() ? value.ref : path;
  const bytes = typeof value.bytes === 'string' ? value.bytes : undefined;
  const expectedHash = value.contentHash;
  if (expectedHash !== undefined && typeof expectedHash !== 'string') {
    fail('prompt-hash-mismatch', 'contentHash must be a string', ref ?? descriptorRef);
  }
  if (bytes !== undefined) {
    if (bytes.length === 0) fail('prompt-empty', 'inline prompt bytes are empty', ref ?? descriptorRef);
    const actual = sha256(bytes);
    if (expectedHash !== undefined && assertSha(expectedHash, 'prompt contentHash', ref ?? descriptorRef) !== actual) {
      fail('prompt-hash-mismatch', `expected ${expectedHash}, supplied ${actual}`, ref ?? descriptorRef);
    }
    // When both a path and bytes are supplied, verify the path rather than
    // accepting an untrusted replacement for the file the caller named.
    if (path !== undefined) {
      const fromDisk = promptFileFromPath(path, undefined, ref ?? path);
      if (fromDisk.bytes !== bytes) fail('prompt-hash-mismatch', 'inline bytes differ from the named file', ref ?? path);
    }
    return { ref: ref ?? `inline:${descriptorRef}`, ...(path ? { path: resolvePath(path) } : {}), bytes, contentHash: actual };
  }
  if (!path) fail('prompt-missing', 'prompt descriptor needs path or bytes', descriptorRef);
  return promptFileFromPath(path, expectedHash, ref, baseDir);
}

function promptDescriptorFiles(
  descriptor: CompositionPromptInput,
  context: PromptResolveContext,
  descriptorIndex: number,
): { files: CompositionPromptFileInput[]; rendered: string; key: string } {
  const role = descriptor.role?.trim() || '';
  const key = `${role || 'inline'}${descriptor.kind ? `:${descriptor.kind}` : ''}#${descriptorIndex}`;
  if (descriptor.documents) {
    let composed;
    try {
      composed = composeStack(descriptor.documents);
    } catch (error) {
      fail('prompt-read-failed', error instanceof Error ? error.message : String(error), key);
    }
    const sourceFiles = descriptor.documents.map((doc, i) =>
      normalizePromptFile(
        {
          ref: doc.sourcePath ?? `stack:${doc.id}:${i}`,
          bytes: doc.text,
        },
        key,
      ),
    );
    return { files: sourceFiles, rendered: composed.text, key };
  }
  if (descriptor.text !== undefined) {
    const file = normalizePromptFile({ ref: `inline:${key}`, bytes: descriptor.text }, key);
    return { files: [file], rendered: file.bytes!, key };
  }
  const paths = descriptor.files;
  const resolvedPaths = paths && paths.length > 0
    ? paths
    : role
      ? resolvePromptFiles(context, role)
      : [];
  if (resolvedPaths.length === 0) {
    fail(
      'prompt-missing',
      role
        ? `no prompt resolved for role ${JSON.stringify(role)} (the declared chain was searched)`
        : 'prompt descriptor has no role, files, documents, or inline text',
      key,
    );
  }
  const files = resolvedPaths.map((entry) => normalizePromptFile(entry, key, context.harnessDir));
  return {
    files,
    rendered: files.map((file) => file.bytes).join(PROMPT_SEPARATOR),
    key,
  };
}

function normalizeAddressedRows(input: CompositionCompilerInput): CompositionAddressedDocumentInput[] {
  const supplied = input.addressedGuide ?? input.addressedDocuments;
  if (!supplied) return [];
  // `Array.isArray` narrows mutable arrays but not a readonly-array union in
  // older TypeScript versions used by the harness, so make the two branches
  // explicit after the runtime check.
  const envelope = Array.isArray(supplied) ? undefined : (supplied as CompositionAddressedDocumentSet);
  const rows: readonly CompositionAddressedDocumentInput[] = envelope
    ? envelope.parts
    : (supplied as readonly CompositionAddressedDocumentInput[]);
  const envelopeRevision = envelope?.revision;
  const envelopeHash = envelope?.contentHash;
  const normalized = rows.map((row, index) => {
    if (!isRecord(row)) fail('addressed-document-invalid', 'addressed document must be a mapping', String(index));
    const ref =
      (typeof row.ref === 'string' && row.ref.trim() ? row.ref : undefined) ??
      (typeof row.partKey === 'string' && row.partKey.trim() ? row.partKey : undefined) ??
      (typeof row.part_key === 'string' && row.part_key.trim() ? row.part_key : undefined);
    if (!ref) fail('addressed-document-invalid', 'addressed document needs ref/partKey', String(index));
    const rowRevision = typeof row.revision === 'string' || typeof row.revision === 'number' ? row.revision : undefined;
    const revision = rowRevision ?? envelopeRevision;
    const text = typeof row.text === 'string' ? row.text : typeof row.body === 'string' ? row.body : undefined;
    const rowContentHash =
      typeof row.contentHash === 'string'
        ? row.contentHash
        : typeof row.content_hash === 'string'
          ? row.content_hash
          : undefined;
    const contentHash = rowContentHash ?? (text !== undefined ? sha256(text) : envelopeHash);
    if (typeof contentHash !== 'string') {
      fail('addressed-document-missing-content', 'pin contentHash when no document body is supplied', ref);
    }
    assertSha(contentHash, 'addressed document contentHash', ref);
    if (text !== undefined && sha256(text) !== contentHash) {
      fail('addressed-document-hash-mismatch', `body hashes to ${sha256(text)}, not ${contentHash}`, ref);
    }
    const rowTargetSection =
      row.targetSection === null || typeof row.targetSection === 'string'
        ? row.targetSection
        : row.target_section === null || typeof row.target_section === 'string'
          ? row.target_section
          : undefined;
    return {
      ref,
      revision: asRevision(revision, 'addressed document', ref),
      contentHash,
      ...(text !== undefined ? { text } : {}),
      ...(typeof row.ordinal === 'number' ? { ordinal: row.ordinal } : {}),
      ...(rowTargetSection !== undefined ? { targetSection: rowTargetSection } : {}),
    } satisfies CompositionAddressedDocumentInput;
  });
  // DB reads are normally ordered, but the artifact must not depend on an
  // accidental query order.  Ordinal is the projector's order; ref breaks ties.
  normalized.sort((a, b) =>
    (typeof a.ordinal === 'number' ? a.ordinal : Number.MAX_SAFE_INTEGER) -
      (typeof b.ordinal === 'number' ? b.ordinal : Number.MAX_SAFE_INTEGER) ||
    compareText(String(a.ref), String(b.ref)),
  );
  return normalized;
}

function addressedInput(row: CompositionAddressedDocumentInput): ResolvedAgentInput {
  const ref = String(row.ref);
  return {
    kind: 'addressed-document',
    ref,
    revision: String(row.revision),
    contentHash: String(row.contentHash),
    ...(row.text !== undefined ? { bytes: row.text } : {}),
  };
}

function renderAddressedRows(rows: readonly CompositionAddressedDocumentInput[]): string {
  const withBodies = rows.filter((row) => typeof row.text === 'string' && row.text.length > 0);
  if (withBodies.length === 0) return '';
  const blocks: string[] = [
    '## Addressed guidance — for this session’s stack',
    '> These sections are pinned to the addressed-document revisions in the effective agent specification.',
  ];
  let section: string | null | undefined;
  for (const row of withBodies) {
    const next = row.targetSection;
    if (next !== section) {
      section = next;
      if (section) blocks.push(`## ${section}`);
    }
    blocks.push(String(row.text));
  }
  return `${blocks.join('\n\n')}\n`;
}

function normalizeSettings(input: CompositionCompilerInput): CompositionSettingInput[] {
  const settings = [...(input.settings ?? [])];
  for (const state of [input.mutableState, input.state]) {
    if (state) settings.push(state);
  }
  const seen = new Set<string>();
  return settings
    .map((setting, index) => {
      if (!isRecord(setting) || typeof setting.ref !== 'string' || !setting.ref.trim()) {
        fail('setting-invalid', 'setting needs a non-empty ref', String(index));
      }
      const ref = setting.ref.trim();
      const revision = asRevision(setting.revision, 'setting', ref);
      const key = `${ref}\u0000${revision}`;
      if (seen.has(key)) fail('input-conflict', `duplicate setting ${ref}@${revision}`, ref);
      seen.add(key);
      if (setting.producerRef !== undefined && (typeof setting.producerRef !== 'string' || !setting.producerRef.trim())) {
        fail('setting-invalid', 'producerRef must be non-empty when supplied', ref);
      }
      return { ref, revision, value: cloneJson(setting.value),
        ...(setting.producerRef ? { producerRef: setting.producerRef } : {}) };
    })
    .sort((a, b) => compareText(a.ref, b.ref) || compareText(String(a.revision), String(b.revision)));
}

function layerInput(loaded: LoadedComposition, layerIndex: number, revisions?: Readonly<Record<string, string>>): ResolvedAgentInput {
  const layer = loaded.layers[layerIndex]!;
  const revision = revisions?.[layer.id] ?? layer.contentHash;
  assertSha(layer.contentHash, `layer ${layer.id} contentHash`, layer.id);
  if (revision.trim() === '') fail('input-invalid', `layer ${layer.id} revision is empty`, layer.id);
  const document = layerSourceDocument(layer);
  if (!document) fail('source-invalid', 'source snapshot is unavailable', layer.id);
  return {
    kind: 'blueprint-layer',
    ref: layer.id,
    revision,
    contentHash: layer.contentHash,
    sourceKind: layer.sourceKind as BlueprintSourceKind,
    document,
  };
}

/** Canonical package content identity includes every file and exact dependency. */
export function packageContentHash(input: Omit<ResolvedPackageInput, 'contentHash'>): string {
  return canonicalHash(input);
}

export interface CompositionPackageInput {
  packageKind: ResolvedPackageReference['packageKind'];
  ref: string;
  revision: string;
  files: readonly { path: string; bytes: string | Uint8Array }[];
  dependencies?: readonly ResolvedPackageReference[];
  value?: unknown;
}

/** Seal bytes already read by a package adapter into the specification's pin record. */
export function pinPackageInput(input: CompositionPackageInput): ResolvedPackageInput {
  const files = input.files.map((file) => {
    const bytes = typeof file.bytes === 'string' ? Buffer.from(file.bytes, 'utf8') : Buffer.from(file.bytes);
    return {
      path: file.path,
      encoding: 'base64' as const,
      bytes: bytes.toString('base64'),
      contentHash: createHash('sha256').update(bytes).digest('hex'),
    };
  }).sort((a, b) => compareText(a.path, b.path));
  const candidate = {
    kind: 'package' as const,
    packageKind: input.packageKind,
    ref: input.ref,
    revision: input.revision,
    files,
    dependencies: [...(input.dependencies ?? [])].sort((a, b) => compareText(packageKey(a), packageKey(b))),
    ...(input.value !== undefined ? { value: cloneJson(input.value) } : {}),
  };
  const pinned = { ...candidate, contentHash: packageContentHash(candidate) };
  const parsed = ResolvedPackageInputSchema.safeParse(pinned);
  if (!parsed.success) fail('input-invalid', parsed.error.issues.map((issue) => issue.message).join('; '), input.ref);
  validatePackageContent(parsed.data);
  return parsed.data;
}

function packageKey(input: Pick<ResolvedPackageReference, 'packageKind' | 'ref'>): string {
  return input.packageKind + ':' + input.ref;
}

function readPackageFiles(dir: string, prefix = ''): { path: string; bytes: Uint8Array }[] {
  try {
    if (!lstatSync(dir).isDirectory()) fail('package-read-failed', 'package is not a directory', dir);
    return readdirSync(dir, { withFileTypes: true }).sort((a, b) => compareText(a.name, b.name)).flatMap((entry) => {
      const path = prefix + entry.name;
      const absolute = join(dir, entry.name);
      // Never follow links out of a package, or snapshot mutable VCS metadata.
      if (entry.name === '.git') return [];
      if (entry.isSymbolicLink()) fail('package-read-failed', 'package contains a symbolic link', path);
      if (entry.isDirectory()) return readPackageFiles(absolute, path + '/');
      if (!entry.isFile()) fail('package-read-failed', 'package contains a non-regular file', path);
      return [{ path, bytes: readFileSync(absolute) }];
    });
  } catch (error) {
    if (error instanceof CompositionCompilerError) throw error;
    fail('package-read-failed', error instanceof Error ? error.message : String(error), dir);
  }
}

/** Snapshot a locally resolved distribution directory; root paths never enter the pin. */
export function snapshotPackageDirectory(
  input: Omit<CompositionPackageInput, 'files'> & { dir: string },
): ResolvedPackageInput {
  if (!existsSync(input.dir)) fail('package-missing', 'package directory does not exist', packageKey(input));
  return pinPackageInput({ ...input, files: readPackageFiles(input.dir) });
}

function validatePackageContent(input: ResolvedPackageInput): void {
  const seen = new Set<string>();
  for (const file of input.files) {
    if (file.path.includes('\\') || file.path.split('/').some((part) => !part || part === '.' || part === '..')) {
      fail('input-invalid', 'package file path must be relative and normalized', file.path);
    }
    if (seen.has(file.path)) fail('input-conflict', 'duplicate package file', file.path);
    seen.add(file.path);
    const bytes = Buffer.from(file.bytes, 'base64');
    if (bytes.toString('base64') !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.contentHash) {
      fail('package-hash-mismatch', 'package file bytes disagree with the pin', packageKey(input) + '/' + file.path);
    }
  }
  const { contentHash, ...content } = input;
  if (packageContentHash(content) !== contentHash) {
    fail('package-hash-mismatch', 'package content or dependency pins changed', packageKey(input));
  }
}

/** Shared by compilation, replay and the existing distribution dependency validator. */
export function validateAgentInputClosure(entries: readonly unknown[]): ResolvedAgentInput[] {
  const byKey = new Map<string, ResolvedAgentInput>();
  for (const raw of entries) {
    const parsed = ResolvedAgentInputSchema.safeParse(cloneJson(raw));
    if (!parsed.success) {
      fail('input-invalid', parsed.error.issues.map((issue) => issue.message).join('; '));
    }
    const entry = parsed.data as ResolvedAgentInput;
    const key = entry.kind === 'package' ? 'package:' + packageKey(entry) : entry.kind + ':' + entry.ref;
    const prior = byKey.get(key);
    if (prior && stableStringify(prior) !== stableStringify(entry)) {
      fail(entry.kind === 'package' ? 'package-pin-conflict' : 'input-conflict',
        'two closure entries disagree for ' + key, entry.ref);
    }
    if (entry.kind === 'package') validatePackageContent(entry);
    else if (entry.kind === 'prompt-file' && sha256(entry.bytes) !== entry.contentHash) {
      fail('prompt-hash-mismatch', 'closure prompt bytes disagree with the pin', entry.ref);
    } else if (entry.kind === 'addressed-document' && entry.bytes !== undefined && sha256(entry.bytes) !== entry.contentHash) {
      fail('addressed-document-hash-mismatch', 'closure document bytes disagree with the pin', entry.ref);
    } else if (entry.kind === 'blueprint-layer' && entry.document && layerContentHash(entry.document) !== entry.contentHash) {
      fail('source-invalid', 'closure source document disagrees with the pin', entry.ref);
    }
    if (!prior) byKey.set(key, entry);
  }
  const values = [...byKey.values()];
  const packages = values.filter((entry): entry is ResolvedPackageInput => entry.kind === 'package');
  const byPackage = new Map(packages.map((entry) => [packageKey(entry), entry]));
  for (const entry of packages) {
    for (const dependency of entry.dependencies) {
      const actual = byPackage.get(packageKey(dependency));
      if (!actual) fail('package-missing', 'required by ' + packageKey(entry), packageKey(dependency));
      if (actual.revision !== dependency.revision || actual.contentHash !== dependency.contentHash) {
        fail('package-pin-conflict',
          packageKey(entry) + ' requires ' + dependency.revision + '@' + dependency.contentHash +
          ', selected ' + actual.revision + '@' + actual.contentHash, packageKey(dependency));
      }
    }
  }
  return values;
}

/** An operation's external program is an already-resolved blueprint package in
 * the specification closure. The `operation:` key avoids colliding with the
 * authored source layers of the owning blueprint. Never consult a live file on
 * replay: the ref, version and resolved-content hash must all match the pin. */
type OperationProgramInput = {
  readonly kind: string;
  readonly packageKind?: string;
  readonly ref: string;
  readonly revision?: string;
  readonly contentHash?: string;
  readonly value?: unknown;
};

export function pinnedOperationProgramBlueprint(
  operation: { readonly execution?: { readonly kind: string; readonly blueprint?: {
    readonly ref: string; readonly revision: string; readonly contentHash: string;
  } } },
  inputs: readonly OperationProgramInput[],
): RunnableBlueprint | null {
  const ref = operation.execution?.kind === 'program' ? operation.execution.blueprint : undefined;
  if (!ref) return null;
  const key = `operation:${ref.ref}`;
  const pin = inputs.find((entry) =>
    entry.kind === 'package' && entry.packageKind === 'blueprint' && entry.ref === key);
  if (!pin) fail('package-missing', 'external program blueprint has no retained package', key);
  if (pin.revision !== ref.revision) {
    fail('package-pin-conflict', `external program requires revision ${ref.revision}, selected ${pin.revision}`, key);
  }
  const parsed = RunnableBlueprintSchema.safeParse(pin.value);
  if (!parsed.success || parsed.data.id !== ref.ref || parsed.data.version !== ref.revision ||
      blueprintHash(parsed.data) !== ref.contentHash) {
    fail('package-pin-conflict', 'external program blueprint identity or resolved content hash differs from its operation ref', key);
  }
  return parsed.data;
}

/** Acceptance uses the exact rubric package admitted with the operation. A
 * live rubric lookup here would silently change the bar for an in-flight task. */
export function pinnedOperationRubricPackage(
  operation: { readonly acceptance?: { readonly rubric?: {
    readonly ref: string; readonly revision: string; readonly contentHash: string;
  } } },
  inputs: readonly OperationProgramInput[],
): ResolvedPackageInput | null {
  const ref = operation.acceptance?.rubric;
  if (!ref) return null;
  const key = `rubric:${ref.ref}`;
  const selected = inputs.find((entry) =>
    entry.kind === 'package' && entry.packageKind === 'rubric' && entry.ref === ref.ref);
  if (!selected) fail('package-missing', 'operation acceptance rubric has no retained package', key);
  if (selected.revision !== ref.revision || selected.contentHash !== ref.contentHash) {
    fail('package-pin-conflict', 'operation acceptance rubric differs from its declared version or content hash', key);
  }
  const parsed = ResolvedPackageInputSchema.safeParse(selected);
  const value = parsed.success ? parsed.data.value : null;
  if (!parsed.success || !value || typeof value !== 'object' || Array.isArray(value) ||
      (value as Record<string, unknown>).rubricId !== ref.ref ||
      !Array.isArray((value as Record<string, unknown>).criteria) ||
      !Array.isArray((value as Record<string, unknown>).ratingScale)) {
    fail('package-pin-conflict', 'operation acceptance rubric retained content is invalid', key);
  }
  return parsed.data;
}

function validateOperationPins(
  configuration: { readonly operations?: readonly { readonly acceptance?: { readonly rubric?: {
    readonly ref: string; readonly revision: string; readonly contentHash: string;
  } }; readonly execution?: {
    readonly kind: string; readonly blueprint?: {
      readonly ref: string; readonly revision: string; readonly contentHash: string;
    };
  } }[] },
  inputs: readonly OperationProgramInput[],
): void {
  for (const operation of configuration.operations ?? []) {
    pinnedOperationProgramBlueprint(operation, inputs);
    pinnedOperationRubricPackage(operation, inputs);
  }
}

/** Resolve declared bundles using the same exact pins carried by the compiler. */
export function validateSpecificationBundles(
  bundles: readonly { kind: string; ref: string; version?: string }[],
  inputs: readonly unknown[],
): ResolvedPackageInput[] {
  const pins = validateAgentInputClosure(inputs).filter((entry): entry is ResolvedPackageInput => entry.kind === 'package');
  for (const bundle of bundles) {
    const pin = pins.find((entry) => entry.packageKind === bundle.kind && entry.ref === bundle.ref);
    if (!pin) fail('package-missing', 'declared bundle has no resolved content', bundle.kind + ':' + bundle.ref);
    if (bundle.version && bundle.version !== pin.revision) {
      fail('package-pin-conflict', 'requires ' + bundle.version + ', selected ' + pin.revision, packageKey(pin));
    }
  }
  return pins;
}

/** A dependency list reduced to one `revision@contentHash` per package key, or
 * null when the same key is pinned to two different contents. */
function dependencySet(entry: ResolvedPackageInput): string | null {
  const byKey = new Map<string, string>();
  for (const dependency of entry.dependencies) {
    const pin = dependency.revision + '@' + dependency.contentHash;
    const prior = byKey.get(packageKey(dependency));
    if (prior !== undefined && prior !== pin) return null;
    byKey.set(packageKey(dependency), pin);
  }
  return stableStringify([...byKey].sort(([a], [b]) => compareText(a, b)));
}

/** Two pins of one layer agree when content is identical and they depend on the
 * same set of pins; repeating an already-listed dependency changes nothing. */
function sameLayerPin(prior: ResolvedPackageInput, next: ResolvedPackageInput): boolean {
  const { contentHash: _priorHash, dependencies: _priorDependencies, ...priorContent } = prior;
  const { contentHash: _nextHash, dependencies: _nextDependencies, ...nextContent } = next;
  const priorSet = dependencySet(prior);
  return priorSet !== null && priorSet === dependencySet(next) &&
    stableStringify(priorContent) === stableStringify(nextContent);
}

export function blueprintPackageInputs(loaded: Pick<LoadedBlueprint, 'layers'>, additional: readonly ResolvedAgentInput[]): ResolvedPackageInput[] {
  const packages: ResolvedPackageInput[] = [];
  // WI-10003294: a diamond extends (root -> [pot, X], pot -> X) visits layer X
  // twice. Its later visit sees the shared ancestors twice in `packages`, so its
  // dependency list repeats them and re-hashes to a second, conflicting pin.
  // A layer resolves to ONE pin per composition: the first visit is reused, and
  // a later visit must agree on content and dependency set. Reusing (rather than
  // de-duplicating every list) keeps compositions that already compiled on the
  // exact pins and specification revisions they had.
  const pinnedLayers = new Map<string, ResolvedPackageInput>();
  for (const layer of loaded.layers) {
    const document = layerSourceDocument(layer);
    if (!document) fail('source-invalid', 'source snapshot is unavailable', layer.id);
    const promptDir = layer.sourcePath ? join(dirname(layer.sourcePath), 'prompts') : null;
    const files = promptDir && existsSync(promptDir) ? readPackageFiles(promptDir, 'prompts/') : [];
    if (layer.sourcePath) {
      let bytes: Buffer;
      try { bytes = readFileSync(layer.sourcePath); }
      catch (error) { fail('package-read-failed', String(error), layer.sourcePath); }
      let raw: unknown;
      try { raw = parseYaml(bytes.toString('utf8')); }
      catch (error) { fail('source-invalid', String(error), layer.id); }
      if (!isRecord(raw) || layerContentHash(raw) !== layer.contentHash || canonicalHash(raw) !== canonicalHash(document)) {
        fail('source-invalid', 'source file changed after resolution', layer.id);
      }
      files.push({ path: 'blueprint.yaml', bytes });
    }
    const parents = typeof document.extends === 'string' ? [document.extends]
      : Array.isArray(document.extends) ? document.extends : [];
    const dependencies = [...packages, ...additional.filter((entry): entry is ResolvedPackageInput => entry.kind === 'package')]
      .filter((entry) => layer === loaded.layers.at(-1) || (entry.packageKind === 'blueprint' ? parents.includes(entry.ref)
        : layer.bundles.some((bundle) => bundle.kind === entry.packageKind && bundle.ref === entry.ref)))
      .map(({ packageKind, ref, revision, contentHash }) => ({ packageKind, ref, revision, contentHash }));
    const pin = pinPackageInput({
      packageKind: 'blueprint',
      ref: layer.id,
      revision: typeof document.version === 'string' ? document.version : layer.contentHash,
      value: document,
      files,
      dependencies,
    });
    const prior = pinnedLayers.get(layer.id);
    if (prior && prior.contentHash !== pin.contentHash && !sameLayerPin(prior, pin)) {
      fail('package-pin-conflict', 'layer resolved twice with different content or dependencies', packageKey(pin));
    }
    if (!prior) pinnedLayers.set(layer.id, pin);
    packages.push(prior ?? pin);
  }
  return packages;
}

/** Replay the exact saved artifact, without consulting a mutable file or registry. */
export function replayAgentSpecification(value: unknown): CompiledAgentSpecification {
  const parsed = ResolvedAgentSpecificationSchema.safeParse(value);
  if (!parsed.success) fail('input-invalid', parsed.error.issues.map((issue) => issue.message).join('; '));
  const specification = parsed.data;
  validateSpecificationBundles(specification.configuration.bundles ?? [], specification.inputs);
  validateOperationPins(specification.configuration, specification.inputs);
  for (const entry of specification.inputs) {
    if (entry.kind === 'blueprint-layer' && !entry.document) fail('source-invalid', 'replay needs the source document', entry.ref);
    if (entry.kind === 'addressed-document' && entry.bytes === undefined) {
      fail('addressed-document-missing-content', 'replay needs the addressed document bytes', entry.ref);
    }
  }
  const { specificationRevision, ...content } = specification;
  if (canonicalHash(content) !== specificationRevision) {
    fail('specification-hash-mismatch', 'saved configuration, provenance or input closure changed');
  }
  return specification;
}

function leafPaths(value: unknown, prefix: string): string[] {
  if (Array.isArray(value)) return [prefix];
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    if (keys.length === 0) return [prefix];
    return keys.flatMap((key) => leafPaths(value[key], `${prefix}.${key}`));
  }
  return [prefix];
}

/** Whether an authored source snapshot owns the complete dotted path. */
function hasOwnPath(value: Record<string, unknown>, path: string): boolean {
  if (!path) return true;
  let cursor: unknown = value;
  for (const segment of path.split('.')) {
    if (!isRecord(cursor) || !Object.prototype.hasOwnProperty.call(cursor, segment)) return false;
    cursor = cursor[segment];
  }
  return true;
}

function configProvenance(
  loaded: LoadedComposition,
  compilerVersion: string,
): ResolvedAgentProvenance[] {
  const out: ResolvedAgentProvenance[] = [];
  for (const path of leafPaths(loaded.blueprint, 'configuration')) {
    const relative = path === 'configuration' ? '' : path.slice('configuration.'.length);
    const top = relative.split('.')[0] ?? '';
    const contributors = loaded.layers.filter((layer) => {
      const snapshot = layerSourceDocument(layer);
      if (snapshot) return relative ? hasOwnPath(snapshot, relative) : true;
      return top ? layer.fields.includes(top as never) : false;
    });
    const uniqueContributors = [
      ...new Map(contributors.map((layer) => [`${layer.id}\u0000${layer.contentHash}`, layer])).values(),
    ];
    const effective = uniqueContributors.at(-1);
    const sourceRef = effective?.id ?? 'schema:default';
    const sourceRevision = effective?.contentHash ?? compilerVersion;
    out.push({
      path,
      sourceRef,
      sourceRevision,
      ...(uniqueContributors.length > 1
        ? { decision: 'override', sources: uniqueContributors.map((layer) => ({ sourceRef: layer.id, sourceRevision: layer.contentHash })) }
        : { decision: uniqueContributors.length === 1 ? 'declared' : 'default' }),
    } as ResolvedAgentProvenance);
  }
  return out;
}

function inputProvenance(
  inputs: readonly ResolvedAgentInput[],
  promptKeys: ReadonlyMap<string, string>,
): ResolvedAgentProvenance[] {
  const out: ResolvedAgentProvenance[] = [];
  let promptOrdinal = 0;
  for (const input of inputs) {
    if (input.kind === 'blueprint-layer') continue; // configuration paths carry layer origins
    let prefix: string;
    if (input.kind === 'prompt-file') prefix = `prompt.${promptKeys.get(input.ref) ?? 'default'}`;
    else if (input.kind === 'addressed-document') prefix = `addressed.${input.ref}`;
    else if (input.kind === 'package') prefix = 'package.' + packageKey(input);
    else if (input.kind === 'capability-provider') {
      prefix = 'capability-provider.' + input.ref + (input.context ? '#' + input.context.verb : '');
    }
    else prefix = `setting.${input.ref}`;
    const sourceRevision = input.kind === 'prompt-file'
      ? input.contentHash
      : input.kind === 'capability-provider'
        ? input.providerVersion + '@' + input.conformanceRunId
        : input.revision;
    out.push({
      path: prefix,
      sourceRef: input.ref,
      sourceRevision,
      decision: input.kind === 'setting'
        ? 'explicit-state'
        : input.kind === 'capability-provider'
          ? 'resolved-provider'
          : 'resolved-input',
    } as ResolvedAgentProvenance);
  }
  return out;
}

function contributionInputKey(input: ResolvedAgentInput): string {
  if (input.kind === 'package') return `package:${packageKey(input)}`;
  // A context capability is requested portably (class@major + verb); its input
  // pins the exact class@version, so the declaration binds by the request.
  if (input.kind === 'capability-provider' && input.context) {
    return `capability-provider:${input.context.requestedRef}#${input.context.verb}`;
  }
  return `${input.kind}:${input.ref}`;
}

function contributionKey(declaration: BlueprintContribution): string {
  // A setting or prompt-file provider's verb names its first-party class's
  // contract (D-039); its produced value still binds by ref alone.
  return declaration.verb === undefined || declaration.inputKind !== 'capability-provider'
    ? `${declaration.inputKind}:${declaration.ref}`
    : `${declaration.inputKind}:${declaration.ref}#${declaration.verb}`;
}

/** Bind declarations to the exact pinned inputs already resolved by the compiler.
 * A generated prompt is delivered only when a component explicitly names it. */
function bindContributions(
  declarations: readonly BlueprintContribution[] | undefined,
  closure: readonly ResolvedAgentInput[],
  fixedPromptRefs: ReadonlySet<string>,
  providerPromptRefs: ReadonlySet<string>,
  includeAddressedDocuments: boolean,
  omissions: readonly CompositionContributionOmissionInput[],
  refresh: BlueprintContribution['refresh'] | undefined,
): { promptSegments: string[]; provenance: ResolvedAgentProvenance[] } {
  const byKey = new Map(closure.map((entry) => [contributionInputKey(entry), entry]));
  const omittedById = new Map<string, CompositionContributionOmissionInput>();
  for (const omission of omissions) {
    if (!omission.id.trim() || omittedById.has(omission.id) ||
        (omission.reason === 'unavailable' && !omission.errorRef?.trim())) {
      fail('input-invalid', 'contribution omission needs a unique id and unavailable needs errorRef', omission.id);
    }
    omittedById.set(omission.id, omission);
  }
  const promptSegments: string[] = [];
  const provenance: ResolvedAgentProvenance[] = [];
  for (const declaration of declarations ?? []) {
    const key = contributionKey(declaration);
    const entry = byKey.get(key);
    const omission = omittedById.get(declaration.id);
    if (!entry) {
      if (declaration.availability !== 'optional' || !omission) {
        fail('contribution-missing', `declared ${declaration.purpose} input is absent without an explicit optional omission`, `${declaration.id}:${key}`);
      }
      if (omission.reason === 'not-requested' && declaration.refresh === refresh) {
        fail('contribution-not-delivered',
          `declared refresh:${refresh} is due at this sink; supply the contribution or an ineligible/unavailable receipt`,
          `${declaration.id}:${key}`);
      }
      provenance.push({
        path: `contribution.${declaration.id}`,
        sourceRef: key,
        sourceRevision: omission.errorRef ?? `omitted:${omission.reason}`,
        decision: `omitted:${omission.reason}`,
        ...(declaration.producerRef ? { producerRef: declaration.producerRef } : {}),
      });
      omittedById.delete(declaration.id);
      continue;
    }
    if (omission) fail('input-conflict', 'contribution is both pinned and marked omitted', declaration.id);
    if (declaration.inputKind === 'prompt-file') {
      if (entry.kind === 'prompt-file' && !entry.bytes.trim()) {
        fail('contribution-not-delivered', 'declared prompt has no text bytes', `${declaration.id}:${key}`);
      }
      const available = declaration.source === 'fixed' ? fixedPromptRefs : providerPromptRefs;
      if (!available.has(declaration.ref)) {
        fail('contribution-source-mismatch', `declared ${declaration.source} prompt was supplied through another source`, `${declaration.id}:${key}`);
      }
      if (declaration.source === 'provider' && entry.kind === 'prompt-file') promptSegments.push(entry.bytes);
    }
    // A context capability's producer is its portable class; the pot's binding
    // is the implementation and is pinned in the input, not named by the author.
    const producerRef = entry.kind === 'capability-provider'
      ? (entry.context ? entry.context.requestedRef : entry.providerPackage)
      : entry.kind === 'prompt-file' || entry.kind === 'setting' ? entry.producerRef : undefined;
    if (declaration.source === 'provider' && producerRef !== declaration.producerRef) {
      fail('contribution-source-mismatch', `declared producer ${declaration.producerRef} did not supply the pinned input`, `${declaration.id}:${key}`);
    }
    if (declaration.purpose === 'prompt' && declaration.inputKind === 'addressed-document' && !includeAddressedDocuments) {
      fail('contribution-not-delivered', 'declared prompt is excluded by includeAddressedDocuments:false', `${declaration.id}:${key}`);
    }
    if (declaration.purpose === 'prompt' && declaration.inputKind === 'addressed-document' &&
        (entry.kind !== 'addressed-document' || !entry.bytes?.trim())) {
      fail('contribution-not-delivered', 'declared addressed prompt has no text bytes', `${declaration.id}:${key}`);
    }
    const sourceRevision = entry.kind === 'prompt-file' || entry.kind === 'addressed-document' || entry.kind === 'package'
      ? entry.contentHash
      : entry.kind === 'capability-provider'
        ? (entry.context
          ? `${entry.ref}:${entry.context.providerKind}/${entry.context.latencyClass}:${entry.providerVersion}@${entry.conformanceRunId}`
          : `${entry.providerVersion}@${entry.conformanceRunId}`)
        : entry.revision;
    provenance.push({
      path: `contribution.${declaration.id}`,
      sourceRef: key,
      sourceRevision,
      decision: `${declaration.source}:${declaration.refresh}`,
      ...(producerRef ? { producerRef } : {}),
    });
  }
  if (omittedById.size) fail('input-invalid', 'omission refers to an unknown or required contribution', [...omittedById.keys()].join(','));
  return { promptSegments, provenance };
}

function promptTextFromInputs(inputs: CompiledAgentSpecification['inputs']): string {
  const rendered = inputs.find((input) => input.kind === 'prompt-file' && input.ref.startsWith('rendered:'));
  if (rendered && rendered.kind === 'prompt-file') return rendered.bytes;
  return inputs
    .filter((input): input is Extract<ResolvedAgentInput, { kind: 'prompt-file' }> => input.kind === 'prompt-file')
    .map((input) => input.bytes)
    .join(PROMPT_SEPARATOR);
}

/** Return the exact ready-to-send prompt bytes captured in a compiled artifact. */
export function specificationPrompt(specification: CompiledAgentSpecification): string {
  return promptTextFromInputs(specification.inputs);
}

/** Compatibility alias for adapters migrating from their local prompt assemblers. */
export const promptBytesFromSpecification = specificationPrompt;

function compileFromInput(input: CompositionCompilerInput): CompiledAgentSpecification {
  const loaded = sourceFor(input);
  const compilerVersion = input.compilerVersion ?? COMPOSITION_COMPILER_VERSION;
  if (!compilerVersion.trim()) fail('input-invalid', 'compilerVersion must be non-empty');

  const inputs: ResolvedAgentInput[] = loaded.layers.map((_, i) => layerInput(loaded, i, input.layerRevisions));
  inputs.push(...blueprintPackageInputs(loaded, input.inputClosure ?? []));
  const promptKeys = new Map<string, string>();
  const fixedPromptRefs = new Set<string>();
  const providerPromptRefs = new Set<string>();
  const descriptors = normalizePromptDescriptors(input);
  const promptSegments: string[] = [];
  for (let i = 0; i < descriptors.length; i += 1) {
    const descriptor = descriptors[i]!;
    const context = { ...defaultPromptContext(input, loaded), ...(descriptor.context ?? {}) };
    if (context.blueprintId && context.blueprintId !== loaded.blueprint.id && !descriptor.documents && !descriptor.text && !descriptor.files) {
      fail('source-invalid', `prompt context selects blueprint ${context.blueprintId}, but source is ${loaded.blueprint.id}`);
    }
    const resolved = promptDescriptorFiles(descriptor, context, i);
    for (const file of resolved.files) {
      const hash = file.contentHash ?? sha256(file.bytes ?? '');
      const ref = file.ref ?? file.path ?? `prompt:${resolved.key}`;
      promptKeys.set(ref, resolved.key);
      fixedPromptRefs.add(ref);
      inputs.push({ kind: 'prompt-file', ref, contentHash: hash, bytes: file.bytes ?? '' });
    }
    promptSegments.push(resolved.rendered);
  }

  const pinnedFixedPrompts = (input.pinnedFixedPromptFiles ?? []).map((file, index) =>
    normalizePromptFile(file, `pinned-fixed#${index}`, input.harnessDir));
  for (const file of pinnedFixedPrompts) {
    if (!file.ref || !file.bytes?.trim() || !file.contentHash) {
      fail('prompt-empty', 'pinned fixed prompt needs a non-empty file and stable reference', file.ref);
    }
    fixedPromptRefs.add(file.ref);
    inputs.push({ kind: 'prompt-file', ref: file.ref, bytes: file.bytes, contentHash: file.contentHash });
  }

  const addressedRows = normalizeAddressedRows(input);
  for (const row of addressedRows) {
    const addressed = addressedInput(row);
    inputs.push(addressed);
    fixedPromptRefs.add(addressed.ref);
  }
  const settings = normalizeSettings(input);
  if (input.contributionRefresh !== undefined) {
    if (!['source-change', 'launch', 'turn', 'on-demand'].includes(input.contributionRefresh)) {
      fail('input-invalid', 'unknown contribution refresh cadence');
    }
    inputs.push({ kind: 'setting', ref: 'composition:contribution-refresh', revision: '1',
      value: input.contributionRefresh });
  }
  for (const setting of settings) {
    inputs.push({ kind: 'setting', ref: setting.ref, revision: String(setting.revision), value: setting.value,
      ...(setting.producerRef ? { producerRef: setting.producerRef } : {}) });
  }
  if (input.inputClosure) {
    const supplied = input.inputClosure.map((entry) => cloneJson(entry) as ResolvedAgentInput)
      .sort((a, b) => compareText(a.kind + ':' + a.ref, b.kind + ':' + b.ref));
    for (const entry of supplied) if (entry.kind === 'prompt-file') providerPromptRefs.add(entry.ref);
    inputs.push(...supplied);
  }

  const closure = validateAgentInputClosure(inputs);
  validateSpecificationBundles(loaded.blueprint.bundles ?? [], closure);
  validateOperationPins(loaded.blueprint, closure);
  const contributions = bindContributions(
    loaded.blueprint.contributions, closure, fixedPromptRefs, providerPromptRefs,
    input.includeAddressedDocuments !== false,
    input.contributionOmissions ?? [],
    input.contributionRefresh,
  );
  const addressedText = input.includeAddressedDocuments === false ? '' : renderAddressedRows(addressedRows);
  const joinedPromptText = [...promptSegments, ...contributions.promptSegments].join(PROMPT_SEPARATOR);
  const promptText = promptSegments.length || contributions.promptSegments.length
    ? addressedText
      ? `${joinedPromptText.replace(/\n+$/, '')}\n\n${addressedText}`
      : joinedPromptText
    : addressedText;
  for (const file of pinnedFixedPrompts) {
    if (!promptText.includes(file.bytes!.trim())) {
      fail('contribution-not-delivered', 'pinned fixed prompt is absent from the delivered prompt', file.ref);
    }
  }
  // If addressed rows were added after a stack's synthetic rendered entry,
  // replace that entry with the final bytes so adapters never see stale text.
  if (promptText) {
    const renderedIndex = closure.findIndex((entry) => entry.kind === 'prompt-file' && entry.ref.startsWith('rendered:'));
    if (renderedIndex >= 0) {
      const existing = closure[renderedIndex]!;
      closure[renderedIndex] = {
        kind: 'prompt-file',
        ref: existing.ref,
        bytes: promptText,
        contentHash: sha256(promptText),
      };
    } else {
      const renderedRef = 'rendered:effective';
      closure.push({ kind: 'prompt-file', ref: renderedRef, bytes: promptText, contentHash: sha256(promptText) });
      promptKeys.set(renderedRef, 'effective');
    }
  }

  const provenance = [
    ...configProvenance(loaded, compilerVersion),
    ...inputProvenance(closure, promptKeys),
    ...contributions.provenance,
  ].sort((a, b) => compareText(a.path, b.path) || compareText(a.sourceRef, b.sourceRef));
  const sourceLayer = loaded.layers.at(-1)!;
  const source = {
    id: sourceLayer.id,
    kind: sourceLayer.sourceKind,
    contentHash: sourceLayer.contentHash,
  } satisfies { id: string; kind: BlueprintSourceKind; contentHash: string };
  const candidateWithoutRevision = {
    schemaVersion: RESOLVED_AGENT_SPECIFICATION_SCHEMA_VERSION,
    compilerVersion,
    source,
    configuration: loaded.blueprint,
    inputs: closure,
    provenance,
  };
  const specificationRevision = canonicalHash(candidateWithoutRevision);
  return ResolvedAgentSpecificationSchema.parse({ ...candidateWithoutRevision, specificationRevision });
}

/** Compile one immutable effective-agent artifact. */
export function compileAgentSpecification(input: CompositionCompilerInput): CompiledAgentSpecification;
export function compileAgentSpecification(
  source: LoadedBlueprint | Record<string, unknown>,
  options?: Omit<CompositionCompilerInput, 'source' | 'blueprint' | 'loaded'>,
): CompiledAgentSpecification;
export function compileAgentSpecification(
  inputOrSource: CompositionCompilerInput | LoadedBlueprint | Record<string, unknown>,
  options: Omit<CompositionCompilerInput, 'source' | 'blueprint' | 'loaded'> = {},
): CompiledAgentSpecification {
  const input = isLoadedBlueprint(inputOrSource) || isRecord(inputOrSource) && !('source' in inputOrSource)
    && 'id' in inputOrSource
    ? { ...options, source: inputOrSource as LoadedBlueprint | Record<string, unknown> }
    : inputOrSource as CompositionCompilerInput;
  return compileFromInput(input);
}

/** Explicitly named alias used by activation/projection adapters. */
export const compileResolvedAgentSpecification = compileAgentSpecification;
export const compileResolvedSpecification = compileAgentSpecification;
export const compileComposition = compileAgentSpecification;

/** Resolve a named operation only from an immutable compiled specification.
 * The returned revision is the exact closure pinned by a later admission; it
 * never re-reads today's mutable blueprint source. */
export function operationFromSpecification(specification: CompiledAgentSpecification, operationId: string) {
  const operation = specification.configuration.operations?.find((entry) => entry.id === operationId);
  if (!operation) fail('operation-not-found', `operation "${operationId}" is absent from the compiled blueprint`, operationId);
  return Object.freeze({ operationId, specificationRevision: specification.specificationRevision, operation });
}

/** Compile the existing replacement-system-prompt stack through this same boundary. */
export function compileReplacementSystemPromptSpecification(
  input: CompositionCompilerInput & { promptContext: PromptResolveContext },
): CompiledAgentSpecification {
  const docs = resolveReplacementSystemPromptStack(input.promptContext);
  if (!docs) fail('prompt-missing', 'replacement system prompt preamble is absent', input.role ?? 'replacement-system-prompt');
  return compileAgentSpecification({
    ...input,
    stackDocuments: docs,
    prompt: { role: input.role ?? 'replacement-system-prompt', documents: docs },
  });
}

/** A small adapter for su/chat callers that already have StackDocuments. */
export function compileStackSpecification(
  input: CompositionCompilerInput & { stackDocuments: readonly StackDocument[] },
): CompiledAgentSpecification {
  return compileAgentSpecification(input);
}
