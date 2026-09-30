/**
 * Portable third-party capability-class contracts (portable-identity-packages
 * P-021 / D-010 / D-015).
 *
 * CARRIER. An identity package may ship `class-contracts/*.json` beside its
 * `blueprint.yaml`. The contracts ride in the SAME signed Cupboard release as a
 * typed `classContracts` section of the canonical closure JSON
 * (`buildBlueprintReleaseArchive`), so the artifact Merkle root and the
 * publisher signature cover the exact contract bytes. It is not a blueprint
 * layer field, not a listing kind and not a parallel registry.
 *
 * IMPORT. `classes:define` stays platform-only. A published contract enters the
 * destination's EXISTING `harness_shared.capability_class_registry` only through
 * `importCupboardClassContracts`, which requires administrator consent bound to
 * the exact artifact hash and the exact `{ref, contractHash}` set. Every check
 * runs before the first write, inside one transaction: a refusal writes nothing.
 *
 * CONFORMANCE. Publisher-side conformance run ids are carried as provenance
 * only. They never create a provider binding: a destination binding still
 * requires `recordProviderConformance` over the destination's live registry.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type postgres from 'postgres';
import { z } from 'zod';
import { FIRST_PARTY_CLASS_NAMESPACE } from '@papercusp/orchestrator/blueprint';
import { canonicalJson } from '../authority/authority-rpc-envelope';
import { isCompilableSchema } from '../datatype-payload-validation';
import {
  CAPABILITY_CLASS_ID_PATTERN,
  CAPABILITY_CLASS_VERB_PATTERN,
  CAPABILITY_CLASS_VERSION_PATTERN,
  capabilityClassDefinitionShape,
  normalizeCapabilityClassId,
  type CapabilityClassVerbs,
  type JsonObject,
} from '../capability-class-registry-store';

/** Directory beside `blueprint.yaml` that carries third-party class contracts. */
export const CLASS_CONTRACTS_DIR = 'class-contracts';

export type ClassContractRefusalCode =
  | 'invalid-contract'
  | 'forged-hash'
  | 'namespace-squat'
  | 'platform-shadow'
  | 'same-version-changed-bytes'
  | 'schema-widening'
  | 'unresolved-ref'
  | 'unsigned-publisher'
  | 'consent-required'
  | 'consent-rejected'
  | 'consent-mismatch';

export interface ClassContractRefusal {
  code: ClassContractRefusalCode;
  ref: string | null;
  detail: string;
}

export class ClassContractImportError extends Error {
  readonly code: ClassContractRefusalCode;
  constructor(readonly refusals: readonly ClassContractRefusal[]) {
    super(
      refusals.map((refusal) => `${refusal.code}${refusal.ref ? ` ${refusal.ref}` : ''}: ${refusal.detail}`).join('; ') ||
        'class contract import refused',
    );
    this.name = 'ClassContractImportError';
    this.code = refusals[0]?.code ?? 'invalid-contract';
  }
}

/** The canonical, hashed contract bytes — exactly the registry's immutable definition shape. */
export interface ClassContract {
  id: string;
  version: string;
  title: string;
  description: string;
  interfaceVerbs: CapabilityClassVerbs;
  behavioralSuiteRef: string | null;
  tags: string[];
}

/** A publisher-side conformance claim. Evidence only; never a binding. */
export interface SourceConformanceClaim {
  runId: string;
  providerPackage: string;
  providerVersion: string;
}

export interface ClassContractPayloadEntry {
  ref: string;
  contractHash: string;
  contract: ClassContract;
  sourceConformance?: SourceConformanceClaim[];
}

export interface ClassContractConsentSubject {
  artifactContentHash: string;
  contracts: Array<{ ref: string; contractHash: string }>;
}

export interface ClassContractConsent extends ClassContractConsentSubject {
  decision: 'approved' | 'rejected';
}

/**
 * Wire schema for administrator consent. The `cupboard:install-blueprint` tool
 * and the loopback POST /cupboard/install-blueprint route both parse with this
 * one schema, so the two doors cannot accept different shapes. The subject to
 * approve is the `consentSubject` carried by a `class_contract_consent_required`
 * refusal; the importer compares it canonically against the artifact it is about
 * to import, so approval of one artifact never carries to another.
 */
export const classContractConsentSchema = z
  .object({
    artifactContentHash: z.string().min(1).max(200),
    contracts: z
      .array(
        z.object({ ref: z.string().min(1).max(200), contractHash: z.string().min(1).max(200) }).strict(),
      )
      .min(1)
      .max(100),
    decision: z.enum(['approved', 'rejected']),
  })
  .strict();

// Compile-time proof that the wire schema produces exactly the importer's input type.
const _consentSchemaMatchesType: ClassContractConsent = {} as z.infer<typeof classContractConsentSchema>;
void _consentSchemaMatchesType;

/** A closure pin as seen by the unresolved-ref check (`<packageKind>:<ref>`). */
export interface ClassContractClosurePin {
  packageKind: string;
  ref: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** sha256 over the canonical contract bytes, in the release-hash spelling. */
export function classContractHash(contract: ClassContract): string {
  return `sha256:${createHash('sha256').update(canonicalJson(capabilityClassDefinitionShape(contract)), 'utf8').digest('hex')}`;
}

export function classContractRef(contract: Pick<ClassContract, 'id' | 'version'>): string {
  return `${contract.id}@${contract.version}`;
}

/** First id segment: the namespace a publisher may define classes under. */
export function classContractNamespace(id: string): string {
  return id.split('.')[0] ?? '';
}

/** Normalized signing-publisher login. A class namespace must equal it exactly. */
export function publisherClassNamespace(login: string): string {
  return normalizeCapabilityClassId(login).replace(/\./g, '-');
}

function parseSourceConformance(value: unknown, where: string): SourceConformanceClaim[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value)) throw invalid(where, 'sourceConformance must be an array');
  return value.map((claim, index) => {
    if (
      !isObject(claim) ||
      typeof claim.runId !== 'string' || !claim.runId ||
      typeof claim.providerPackage !== 'string' || !claim.providerPackage ||
      typeof claim.providerVersion !== 'string' || !claim.providerVersion
    ) {
      throw invalid(where, `sourceConformance[${index}] needs runId, providerPackage and providerVersion strings`);
    }
    return { runId: claim.runId, providerPackage: claim.providerPackage, providerVersion: claim.providerVersion };
  });
}

function invalid(where: string, detail: string): ClassContractImportError {
  return new ClassContractImportError([{ code: 'invalid-contract', ref: null, detail: `${where}: ${detail}` }]);
}

/** Validate an untrusted contract document with the SAME rules classes:define applies. */
export function parseClassContract(value: unknown, where: string): ClassContract {
  if (!isObject(value)) throw invalid(where, 'contract must be a JSON object');
  const id = typeof value.id === 'string' ? value.id : '';
  if (!CAPABILITY_CLASS_ID_PATTERN.test(id) || normalizeCapabilityClassId(id) !== id) {
    throw invalid(where, `id ${JSON.stringify(value.id)} must be a normalized namespaced class id (publisher.job)`);
  }
  const version = typeof value.version === 'string' ? value.version : '';
  if (!CAPABILITY_CLASS_VERSION_PATTERN.test(version)) throw invalid(where, `version ${JSON.stringify(value.version)} is not semver`);
  if (typeof value.title !== 'string' || !value.title.trim() || value.title.length > 200) {
    throw invalid(where, 'title must be 1-200 characters');
  }
  if (typeof value.description !== 'string' || !value.description.trim() || value.description.length > 2000) {
    throw invalid(where, 'description must be 1-2000 characters');
  }
  if (!isObject(value.interfaceVerbs) || Object.keys(value.interfaceVerbs).length === 0) {
    throw invalid(where, 'interfaceVerbs must declare at least one verb');
  }
  const interfaceVerbs: CapabilityClassVerbs = {};
  for (const verb of Object.keys(value.interfaceVerbs).sort()) {
    const contract = value.interfaceVerbs[verb];
    if (!CAPABILITY_CLASS_VERB_PATTERN.test(verb)) throw invalid(where, `verb ${JSON.stringify(verb)} is not a valid verb id`);
    if (!isObject(contract) || !isObject(contract.inputSchema) || !isCompilableSchema(contract.inputSchema)) {
      throw invalid(where, `${verb}.inputSchema must compile as JSON Schema`);
    }
    if (contract.outputSchema !== undefined && (!isObject(contract.outputSchema) || !isCompilableSchema(contract.outputSchema))) {
      throw invalid(where, `${verb}.outputSchema must compile as JSON Schema`);
    }
    if (contract.capability !== undefined && (typeof contract.capability !== 'string' || !contract.capability)) {
      throw invalid(where, `${verb}.capability must be a non-empty string`);
    }
    interfaceVerbs[verb] = {
      inputSchema: contract.inputSchema as JsonObject,
      ...(contract.outputSchema ? { outputSchema: contract.outputSchema as JsonObject } : {}),
      ...(typeof contract.capability === 'string' ? { capability: contract.capability } : {}),
    };
  }
  const behavioralSuiteRef = value.behavioralSuiteRef == null ? null : value.behavioralSuiteRef;
  if (behavioralSuiteRef !== null && (typeof behavioralSuiteRef !== 'string' || !behavioralSuiteRef || behavioralSuiteRef.length > 300)) {
    throw invalid(where, 'behavioralSuiteRef must be a 1-300 character string or null');
  }
  const rawTags = value.tags ?? [];
  if (!Array.isArray(rawTags) || rawTags.length > 32 || rawTags.some((tag) => typeof tag !== 'string' || !tag || tag.length > 80)) {
    throw invalid(where, 'tags must be at most 32 strings of 1-80 characters');
  }
  return {
    id,
    version,
    title: value.title,
    description: value.description,
    interfaceVerbs,
    behavioralSuiteRef: behavioralSuiteRef as string | null,
    tags: [...new Set(rawTags as string[])].sort(),
  };
}

/**
 * Validate a payload section (from source files, a stored closure, or any other
 * transport). The declared hash must equal the recomputed canonical hash — a
 * mismatch is `forged-hash`, never silently re-hashed. Returns entries sorted by ref.
 */
export function validateClassContractPayload(entries: readonly unknown[]): ClassContractPayloadEntry[] {
  const refusals: ClassContractRefusal[] = [];
  const out: ClassContractPayloadEntry[] = [];
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    const where = `classContracts[${index}]`;
    if (!isObject(entry)) throw invalid(where, 'entry must be an object');
    const contract = parseClassContract(entry.contract, where);
    const ref = classContractRef(contract);
    if (entry.ref !== ref) throw invalid(where, `ref ${JSON.stringify(entry.ref)} does not name its contract ${ref}`);
    if (seen.has(ref)) throw invalid(where, `duplicate contract ${ref}`);
    seen.add(ref);
    const computed = classContractHash(contract);
    if (typeof entry.contractHash !== 'string' || entry.contractHash.toLowerCase() !== computed) {
      refusals.push({
        code: 'forged-hash',
        ref,
        detail: `declared ${String(entry.contractHash)} but the canonical contract bytes hash to ${computed}`,
      });
      return;
    }
    const sourceConformance = parseSourceConformance(entry.sourceConformance, where);
    out.push({ ref, contractHash: computed, contract, ...(sourceConformance ? { sourceConformance } : {}) });
  });
  if (refusals.length) throw new ClassContractImportError(refusals);
  return out.sort((a, b) => a.ref.localeCompare(b.ref));
}

/**
 * Read `class-contracts/*.json` beside a blueprint. Each file is one contract
 * document; it may declare `contractHash` (verified, `forged-hash` on mismatch)
 * and `sourceConformance` (provenance only). No directory ⇒ no section.
 */
export async function readClassContractSources(blueprintDir: string): Promise<ClassContractPayloadEntry[]> {
  const dir = join(blueprintDir, CLASS_CONTRACTS_DIR);
  let names: string[];
  try {
    names = (await fs.readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const entries: unknown[] = [];
  for (const name of names) {
    const where = `${CLASS_CONTRACTS_DIR}/${name}`;
    let document: unknown;
    try {
      document = JSON.parse(await fs.readFile(join(dir, name), 'utf8'));
    } catch (error) {
      throw invalid(where, `not valid JSON: ${String(error)}`);
    }
    if (!isObject(document)) throw invalid(where, 'contract must be a JSON object');
    const { contractHash, sourceConformance, ...rest } = document;
    const contract = parseClassContract(rest, where);
    entries.push({
      ref: classContractRef(contract),
      contractHash: typeof contractHash === 'string' ? contractHash : classContractHash(contract),
      contract,
      ...(sourceConformance !== undefined ? { sourceConformance } : {}),
    });
  }
  return validateClassContractPayload(entries);
}

/** The exact subject an administrator approves: artifact + every {ref, contractHash}. */
export function classContractConsentSubject(
  artifactContentHash: string,
  entries: readonly Pick<ClassContractPayloadEntry, 'ref' | 'contractHash'>[],
): ClassContractConsentSubject {
  return {
    artifactContentHash: artifactContentHash.toLowerCase(),
    contracts: [...entries]
      .map((entry) => ({ ref: entry.ref, contractHash: entry.contractHash }))
      .sort((a, b) => a.ref.localeCompare(b.ref)),
  };
}

function consentRefusal(
  consent: ClassContractConsent | null | undefined,
  subject: ClassContractConsentSubject,
): ClassContractRefusal | null {
  if (!consent) {
    return { code: 'consent-required', ref: null, detail: 'administrator consent for this exact artifact and contract set is required' };
  }
  if (consent.decision === 'rejected') {
    return { code: 'consent-rejected', ref: null, detail: 'the administrator rejected these class contracts' };
  }
  if (consent.decision !== 'approved') {
    return { code: 'consent-required', ref: null, detail: `unknown consent decision ${JSON.stringify(consent.decision)}` };
  }
  const offered = canonicalJson(classContractConsentSubject(consent.artifactContentHash ?? '', consent.contracts ?? []));
  if (offered !== canonicalJson(subject)) {
    return {
      code: 'consent-mismatch',
      ref: null,
      detail: 'consent was given for a different artifact hash or contract set than the one being imported',
    };
  }
  return null;
}

function semverMajor(version: string): string {
  return version.split('.')[0] ?? version;
}

function behavioralRefResolves(ref: string, pins: readonly ClassContractClosurePin[]): boolean {
  return pins.some((pin) => `${pin.packageKind}:${pin.ref}` === ref);
}

type RegistryRow = {
  id: string;
  version: string;
  title: string;
  description: string;
  interface_verbs: unknown;
  behavioral_suite_ref: string | null;
  tags: string[] | null;
  provenance_kind: string;
};

function jsonObject(value: unknown): JsonObject {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return isObject(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isObject(value) ? value : {};
}

function rowContract(row: RegistryRow): ClassContract {
  return {
    id: row.id,
    version: row.version,
    title: row.title,
    description: row.description,
    interfaceVerbs: jsonObject(row.interface_verbs) as CapabilityClassVerbs,
    behavioralSuiteRef: row.behavioral_suite_ref,
    tags: row.tags ?? [],
  };
}

export interface ImportClassContractsInput {
  workspaceId: string;
  /** Merkle root of the signed release that carried the contracts. */
  artifactContentHash: string;
  /** Login from a VERIFIED signed manifest. Null/absent ⇒ unsigned ⇒ refused. */
  publisherLogin: string | null | undefined;
  entries: readonly unknown[];
  /** The release closure pins, for resolving `behavioralSuiteRef`. */
  closurePins: readonly ClassContractClosurePin[];
  consent: ClassContractConsent | null | undefined;
  importedBy?: string | null;
  listingRef?: string | null;
}

/**
 * Imported contracts deliberately survive a later install failure (e.g. no
 * conformant provider yet): a consented, immutable definition is exactly what
 * destination conformance needs to exist BEFORE any provider can bind to it.
 * Consent absent/mismatched/rejected, or any refusal, writes nothing.
 */
export interface ImportClassContractsResult {
  imported: Array<{ ref: string; contractHash: string; created: boolean }>;
}

/**
 * Consent-bound write into the existing capability-class registry. All checks
 * (consent, forged hash, namespace, platform shadow, same-version bytes, schema
 * widening, unresolved refs) complete before the first INSERT, in one
 * transaction under a per-namespace advisory lock. Any refusal writes nothing.
 * An identical replay of an already-imported contract is a no-op (`created:false`).
 */
export async function importCupboardClassContracts(
  sql: postgres.Sql,
  input: ImportClassContractsInput,
): Promise<ImportClassContractsResult> {
  const entries = validateClassContractPayload(input.entries);
  const subject = classContractConsentSubject(input.artifactContentHash, entries);
  if (entries.length === 0) return { imported: [] };
  const consentProblem = consentRefusal(input.consent, subject);
  if (consentProblem) throw new ClassContractImportError([consentProblem]);
  const login = input.publisherLogin?.trim();
  if (!login) {
    throw new ClassContractImportError([{
      code: 'unsigned-publisher',
      ref: null,
      detail: 'class contracts are importable only from a release whose publisher signature verified',
    }]);
  }
  const namespace = publisherClassNamespace(login);

  const created = await sql.begin(async (tx) => {
    const refusals: ClassContractRefusal[] = [];
    const namespaces = [...new Set(entries.map((entry) => classContractNamespace(entry.contract.id)))].sort();
    for (const ns of namespaces) {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`capability-class-ns:${input.workspaceId}:${ns}`}))`;
    }
    const writes: ClassContractPayloadEntry[] = [];
    const replays: ClassContractPayloadEntry[] = [];
    for (const entry of entries) {
      const { contract } = entry;
      const ns = classContractNamespace(contract.id);
      if (ns !== namespace) {
        refusals.push({
          code: 'namespace-squat',
          ref: entry.ref,
          detail: `namespace "${ns}" is not the signing publisher's namespace "${namespace}"`,
        });
        continue;
      }
      if (contract.behavioralSuiteRef && !behavioralRefResolves(contract.behavioralSuiteRef, input.closurePins)) {
        refusals.push({
          code: 'unresolved-ref',
          ref: entry.ref,
          detail: `behavioralSuiteRef ${contract.behavioralSuiteRef} names no <packageKind>:<ref> pinned in the release closure`,
        });
      }
      // First-party classes are code, not registry rows (D-039), so their
      // namespace is held even where this workspace has no row for it.
      if (ns === FIRST_PARTY_CLASS_NAMESPACE) {
        refusals.push({
          code: 'platform-shadow',
          ref: entry.ref,
          detail: `namespace "${ns}" is reserved for the platform's first-party classes`,
        });
        continue;
      }
      const platformRows = await tx<{ id: string; version: string }[]>`
        SELECT id, version FROM harness_shared.capability_class_registry
         WHERE workspace_id = ${input.workspaceId}
           AND split_part(id, '.', 1) = ${ns}
           AND provenance_kind <> 'cupboard-import'
         ORDER BY id, version
         LIMIT 3`;
      if (platformRows.length) {
        refusals.push({
          code: 'platform-shadow',
          ref: entry.ref,
          detail: `namespace "${ns}" already holds destination-defined classes (${platformRows
            .map((row) => `${row.id}@${row.version}`)
            .join(', ')})`,
        });
        continue;
      }
      const siblings = await tx<RegistryRow[]>`
        SELECT id, version, title, description, interface_verbs, behavioral_suite_ref, tags, provenance_kind
          FROM harness_shared.capability_class_registry
         WHERE workspace_id = ${input.workspaceId} AND id = ${contract.id}`;
      const same = siblings.find((row) => row.version === contract.version);
      if (same) {
        if (canonicalJson(capabilityClassDefinitionShape(rowContract(same))) !== canonicalJson(capabilityClassDefinitionShape(contract))) {
          refusals.push({
            code: 'same-version-changed-bytes',
            ref: entry.ref,
            detail: `${entry.ref} already exists with different contract bytes; publish a new semantic version`,
          });
        } else {
          replays.push(entry);
        }
        continue;
      }
      for (const row of siblings.filter((sibling) => semverMajor(sibling.version) === semverMajor(contract.version))) {
        const existing = rowContract(row).interfaceVerbs;
        const altered = Object.keys(existing).filter(
          (verb) => !contract.interfaceVerbs[verb] || canonicalJson(contract.interfaceVerbs[verb]) !== canonicalJson(existing[verb]),
        );
        if (altered.length) {
          refusals.push({
            code: 'schema-widening',
            ref: entry.ref,
            detail: `same-major ${row.id}@${row.version} verb contract(s) ${altered.sort().join(', ')} changed or removed; ` +
              'adding verbs is allowed, changing one needs a new major version',
          });
        }
      }
      writes.push(entry);
    }
    if (refusals.length) throw new ClassContractImportError(refusals);
    for (const entry of writes) {
      const { contract } = entry;
      await tx`
        INSERT INTO harness_shared.capability_class_registry
          (workspace_id, id, version, title, description, interface_verbs, behavioral_suite_ref, tags,
           review_status, created_by, provenance_kind, publisher_namespace, contract_hash,
           source_artifact_hash, source_provenance)
        VALUES (
          ${input.workspaceId}, ${contract.id}, ${contract.version}, ${contract.title}, ${contract.description},
          ${JSON.stringify(contract.interfaceVerbs)}::text::jsonb, ${contract.behavioralSuiteRef}, ${contract.tags},
          'approved', ${input.importedBy ?? null}, 'cupboard-import', ${namespace}, ${entry.contractHash},
          ${subject.artifactContentHash},
          ${JSON.stringify({
            publisherLogin: login,
            listingRef: input.listingRef ?? null,
            sourceConformance: entry.sourceConformance ?? [],
          })}::text::jsonb
        )`;
    }
    return { writes, replays };
  });

  return {
    imported: [
      ...created.writes.map((entry) => ({ ref: entry.ref, contractHash: entry.contractHash, created: true })),
      ...created.replays.map((entry) => ({ ref: entry.ref, contractHash: entry.contractHash, created: false })),
    ].sort((a, b) => a.ref.localeCompare(b.ref)),
  };
}
