/**
 * Immutable lifecycle for Cupboard-installed blueprint packages (identities P-007).
 *
 * This extends the existing `~/.papercusp/blueprints` tier.  The active package
 * stays at `<root>/<id>` for every existing resolver; immutable versions and the
 * exact P-006 closure live below `<root>/.releases/<id>`.  It is deliberately not
 * an identity store, listing kind, installer, or activation registry.
 */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import {
  BlueprintSourceDocumentSchema,
  blueprintPackageInputs,
  findExclusiveSlotConflicts,
  isSlotId,
  resolveBlueprintSource,
  validateAgentInputClosure,
  type BlueprintSourceDocument,
  type ResolveExtendsPath,
  type ResolvedPackageInput,
} from '@papercusp/orchestrator/blueprint';
import { resolveAndValidateBlueprint } from '@papercusp/blueprint-distribution';
import { parse as parseYaml } from 'yaml';
import { canonicalJson } from '../authority/authority-rpc-envelope';
import { blueprintRegistrySets } from '../blueprint/registry-sets';
import { resolveBlueprintPackageInputs, type BlueprintPackageResolver } from '../blueprint/compile-packages';
import { registerHarnessOpProxies } from '../harness-ops/proxy';
import { resolveSeedPackKey } from '../knowledge-packs/seed-pack-key';
import { buildArtifactPackage, type ArtifactPackage } from '../p2p/artifact-package';
import {
  DEFAULT_PINNING_POLICY,
  distributionManifestSigningBytes,
  type ArtifactDistributionManifest,
} from '../p2p/artifact-distribution';
import { listingManifestSigningBytes, unsignedListingManifest, type CupboardReleaseManifest } from './listing-manifest';
import { verifyEd25519 } from '../identity/ed25519';
import type { ReleaseGateInput } from './publish-release-gate';
import {
  ClassContractImportError,
  readClassContractSources,
  validateClassContractPayload,
  type ClassContractPayloadEntry,
} from './class-contract-payload';
import { identityConsentSubjects, identityPermissionLines } from './identity-install-consent';

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const INDEX_SCHEMA_VERSION = 1 as const;

export type BlueprintLifecycleOperation = 'install' | 'update' | 'no-op' | 'rollback' | 'uninstall';

export interface BlueprintActivationLayer {
  id: string;
  slots: readonly string[];
}

export interface BlueprintActivationPreflight {
  ok: boolean;
  candidate: BlueprintActivationLayer;
  conflicts: Array<{ slot: string; claimants: string[] }>;
}

export interface BlueprintReleaseRecord {
  schemaVersion: typeof INDEX_SCHEMA_VERSION;
  id: string;
  version: string;
  /** P-006 root package pin: source, prompts and exact transitive pin graph. */
  contentHash: string;
  /** Public artifact address: Merkle root over the canonical full-closure bytes. */
  artifactContentHash: string;
  source: string;
  installedAtMs: number;
  slots: string[];
  pins: Array<{ packageKind: string; ref: string; revision: string; contentHash: string }>;
  /** Server-moderated policy approval, bound to this release's full artifact hash. */
  modePolicyApproval?: { listingId: string; policyRef: string; artifactContentHash: string };
  retiredAtMs?: number;
}

interface BlueprintLifecycleIndex {
  schemaVersion: typeof INDEX_SCHEMA_VERSION;
  id: string;
  activeContentHash: string | null;
  releases: BlueprintReleaseRecord[];
}

export interface BlueprintReleaseArchive {
  bytes: Buffer;
  package: ArtifactPackage;
  root: ResolvedPackageInput;
  pins: ResolvedPackageInput[];
  /** P-021 typed class-contract section; covered by the artifact hash and signature. */
  classContracts: ClassContractPayloadEntry[];
}

export interface BlueprintReleaseDiff {
  fromContentHash: string | null;
  toContentHash: string | null;
  promptText: Array<{ path: string; beforeHash: string | null; afterHash: string | null; patch: string }>;
  burnKnobs: Array<{ path: string; before: unknown; after: unknown }>;
  /** Publisher declarations are evidence, never administrator authorization. */
  grants: Array<{ layer: string; kind: 'requires' | 'optional'; added: string[]; removed: string[] }>;
}

export interface CommitBlueprintReleaseInput {
  installedDir: string;
  sourceDir: string;
  id: string;
  version: string;
  source: string;
  pins: readonly ResolvedPackageInput[];
  activationStack?: readonly BlueprintActivationLayer[];
  /** Third-party class contracts carried beside the blueprint (P-021). They are
   * part of the hashed closure, so a changed contract fails the pin/signature. */
  classContracts?: readonly unknown[];
  /**
   * The listed release identity. `manifest` is the WHOLE signed manifest as the
   * publisher signed it — carried verbatim, never reconstructed from the pins
   * (identities-v1 D-074): the signing bytes are the canonical JSON of the
   * 12-field manifest, three of whose fields (license, publisher, reviewStatus)
   * are publisher-supplied and not derivable from a clone, so a partial
   * reconstruction would disagree with publish while passing its own tests.
   * A PRESENT signature is verified and refused on failure; an ABSENT manifest
   * installs unsigned, still pin-protected by `contentHash` below (D-073).
   */
  expectedRelease?: {
    version?: string | null;
    contentHash?: string | null;
    manifest?: CupboardReleaseManifest | null;
  };
  modeApproval?: { listingId: string; policyRef: string; approvedArtifactContentHash: string };
  nowMs?: number;
  journal?: BlueprintLifecycleJournal;
}

export interface CommitBlueprintReleaseResult {
  operation: Extract<BlueprintLifecycleOperation, 'install' | 'update' | 'no-op'>;
  record: BlueprintReleaseRecord;
  installedTo: string;
  historyDir: string;
  diff: BlueprintReleaseDiff;
  activationPreflight: BlueprintActivationPreflight;
  journal?: BlueprintJournalReport;
}

/** P-014 / D-034: the Postgres resource journal (pot provider bindings) a
 * lifecycle operation drives while it holds this blueprint's fs lock. The
 * file-tier release stays the applied switch; the journal never activates. */
export interface BlueprintLifecycleJournal {
  /** First, before anything is written: converge interrupted attempts against
   * the release that is active now. Reports; never throws for one attempt. */
  recover(activeContentHash: string | null): Promise<BlueprintJournalReport['recovered']>;
  /** Journal and write what the release `contentHash` needs (null: uninstall).
   * Throws, having compensated its own partial writes, to refuse the switch. */
  prepare(contentHash: string | null): Promise<BlueprintJournalAttempt>;
}

export interface BlueprintJournalAttempt {
  /** After the switch: apply, fence what it supersedes, clean that up. Never
   * throws — the switch stands; an unapplied attempt rolls forward next time. */
  apply(): Promise<Omit<BlueprintJournalReport, 'recovered'>>;
  /** The switch failed: release this attempt. Throws if residue remains. */
  compensate(cause: unknown): Promise<void>;
}

export interface BlueprintJournalReport {
  recovered: Array<{ dependentId: string; potSlug: string; outcome: 'rolled-forward' | 'compensated' | 'cleaned'; error?: string }>;
  pots: Array<{
    potSlug: string;
    dependentId: string | null;
    applied: boolean;
    /** `classRef → package@version` for each binding the applied install holds. */
    bindings: string[];
    superseded: string[];
    note?: string;
    error?: string;
  }>;
  /** Cleanup that did not converge; durable on its installation, retried by the next lifecycle call. */
  residue: Array<{ dependentId: string; error: string }>;
}

// The error class and the release signer live in a leaf so the self-describing kinds can
// sign without compiling this file's lifecycle graph (WI-10004876).
import { BlueprintLifecycleError, defaultReleaseSigner, type BlueprintReleaseSigner } from './blueprint-release-signer';
export { BlueprintLifecycleError, defaultReleaseSigner, type BlueprintReleaseSigner } from './blueprint-release-signer';

/** Run `switchRelease` between the journal's prepare and apply; compensate on failure. */
async function journaledSwitch(
  journal: BlueprintLifecycleJournal | undefined,
  activeContentHash: string | null,
  targetContentHash: string | null,
  switchRelease: () => Promise<void>,
): Promise<BlueprintJournalReport | undefined> {
  if (!journal) {
    await switchRelease();
    return undefined;
  }
  const recovered = await journal.recover(activeContentHash);
  const attempt = await journal.prepare(targetContentHash);
  try {
    await switchRelease();
  } catch (error) {
    await attempt.compensate(error);
    throw error;
  }
  return { recovered, ...(await attempt.apply()) };
}

export interface BlueprintReleaseSourceSnapshot {
  id: string;
  version: string;
  description: string | null;
  raw: Record<string, unknown>;
  slots: string[];
  dependencies: { tools: string[]; packs: string[]; plugins: string[]; blueprints: string[] };
  /** The resolved source's grants and context contributions — install consents to these. */
  grants: { requires: string[]; optional: string[] };
  contributions: BlueprintSourceDocument['contributions'];
  archive: BlueprintReleaseArchive;
}

export interface PreparedBlueprintPublicRelease {
  source: BlueprintReleaseSourceSnapshot;
  release: ReleaseGateInput;
  manifest: ArtifactDistributionManifest;
}

function assertSafeId(id: string): void {
  if (!SAFE_ID.test(id)) throw new BlueprintLifecycleError(`unsafe blueprint id ${JSON.stringify(id)}`, 400);
}

function assertInside(root: string, target: string): void {
  const parent = resolve(root);
  const child = resolve(target);
  if (child !== parent && !child.startsWith(parent + sep)) {
    throw new BlueprintLifecycleError(`blueprint lifecycle path escapes ${root}`, 400);
  }
}

function releaseRoot(installedDir: string, id: string): string {
  const dir = join(installedDir, '.releases', id);
  assertInside(installedDir, dir);
  return dir;
}

function indexPath(installedDir: string, id: string): string {
  return join(releaseRoot(installedDir, id), 'index.json');
}

function versionDir(installedDir: string, id: string, contentHash: string): string {
  const dir = join(releaseRoot(installedDir, id), contentHash);
  assertInside(installedDir, dir);
  return dir;
}

function activeDir(installedDir: string, id: string): string {
  const dir = join(installedDir, id);
  assertInside(installedDir, dir);
  return dir;
}

function releasePinSummary(pin: ResolvedPackageInput) {
  return { packageKind: pin.packageKind, ref: pin.ref, revision: pin.revision, contentHash: pin.contentHash };
}

/**
 * The canonical closure bytes. A non-empty `classContracts` section (P-021 /
 * D-015) joins the SAME JSON document, so the Merkle root and the publisher
 * signature cover each contract; it is omitted when empty so every existing
 * artifact hash is unchanged. Throws `ClassContractImportError` (`forged-hash`)
 * when a declared contract hash does not match its canonical bytes.
 */
export function buildBlueprintReleaseArchive(
  pinsInput: readonly ResolvedPackageInput[],
  id: string,
  classContractsInput: readonly unknown[] = [],
): BlueprintReleaseArchive {
  assertSafeId(id);
  const pins = validateAgentInputClosure(pinsInput)
    .filter((entry): entry is ResolvedPackageInput => entry.kind === 'package')
    .sort((a, b) => `${a.packageKind}:${a.ref}`.localeCompare(`${b.packageKind}:${b.ref}`));
  const root = pins.find((pin) => pin.packageKind === 'blueprint' && pin.ref === id);
  if (!root) throw new BlueprintLifecycleError(`blueprint ${JSON.stringify(id)} has no root package pin`, 422);
  const classContracts = validateClassContractPayload(classContractsInput);
  const bytes = Buffer.from(
    canonicalJson({
      schemaVersion: 1,
      kind: 'blueprint',
      id,
      root: releasePinSummary(root),
      pins,
      ...(classContracts.length ? { classContracts } : {}),
    }),
    'utf8',
  );
  return { bytes, package: buildArtifactPackage(bytes), root, pins, classContracts };
}

/**
 * Verify a listed release against the archive the installer computed: the
 * listed version and content-hash pins, and a PRESENT publisher signature
 * (identities-v1 D-073/D-074). Returns the publisher login ONLY when a
 * signature verified — the one input a class-contract namespace may trust.
 */
export function verifyListedBlueprintRelease(input: {
  id: string;
  version: string;
  archive: BlueprintReleaseArchive;
  expectedRelease?: CommitBlueprintReleaseInput['expectedRelease'];
}): { verifiedPublisherLogin: string | null } {
  const { archive } = input;
  if (input.expectedRelease?.version && input.expectedRelease.version !== input.version) {
    throw new BlueprintLifecycleError(
      `blueprint ${input.id} version ${input.version} does not match listed release ${input.expectedRelease.version}`,
      422,
    );
  }
  if (
    input.expectedRelease?.contentHash &&
    input.expectedRelease.contentHash.toLowerCase() !== archive.package.rootHash.toLowerCase()
  ) {
    throw new BlueprintLifecycleError(
      `blueprint ${input.id} package hashes to ${archive.package.rootHash}, listed release is ${input.expectedRelease.contentHash}`,
      422,
    );
  }
  // Verify a PRESENT publisher signature over the listed manifest, and refuse
  // on failure (identities-v1 D-073/D-074). The signing bytes come from the
  // SAME helpers publish signed with, so there is exactly one byte derivation
  // in the system; an ABSENT manifest installs unsigned, still covered by the
  // content-hash pin above. Only reached after the closure has been hashed,
  // so the diagnostic can name both the computed and the signed identity.
  const listedManifest = input.expectedRelease?.manifest;
  if (!listedManifest?.signature) return { verifiedPublisherLogin: null };
  const publisher = listedManifest.publisher;
  const signedBy = publisher?.login ? `${publisher.login} ` : '';
  const listedAs = `${listedManifest.listingRef}@${listedManifest.releaseVersion}`;
  if (
    !verifyEd25519(
      listingManifestSigningBytes(unsignedListingManifest(listedManifest)),
      publisher?.devicePubkey ?? '',
      Buffer.from(listedManifest.signature, 'base64'),
    )
  ) {
    throw new BlueprintLifecycleError(
      `blueprint ${input.id} listed release ${listedAs} has an INVALID publisher signature — ` +
        `the manifest does not verify against the device key it names ` +
        `(${signedBy}${(publisher?.devicePubkey ?? 'no-pubkey').slice(0, 16)}…), ` +
        `so its contents were altered after signing; refusing to install ${archive.package.rootHash}`,
      422,
    );
  }
  if (listedManifest.contentHash.toLowerCase() !== archive.package.rootHash.toLowerCase()) {
    throw new BlueprintLifecycleError(
      `blueprint ${input.id} package hashes to ${archive.package.rootHash}, but the signed manifest for ` +
        `${listedAs} pins ${listedManifest.contentHash} — the cloned source is not the release that was signed`,
      422,
    );
  }
  return { verifiedPublisherLogin: publisher?.login?.trim() || null };
}

/** Resolve, semantically validate and snapshot the exact file/package closure
 * used by both publish and install. This is the P-006 contract, not a second
 * archive format. */
export async function snapshotBlueprintReleaseSource(input: {
  blueprintFile: string;
  resolveExtends: ResolveExtendsPath;
  resolvePackage?: BlueprintPackageResolver;
}): Promise<BlueprintReleaseSourceSnapshot> {
  let raw: Record<string, unknown>;
  try {
    const parsed = parseYaml(await fs.readFile(input.blueprintFile, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a mapping');
    raw = parsed as Record<string, unknown>;
  } catch (error) {
    throw new BlueprintLifecycleError(`blueprint failed to parse: ${String(error)}`, 422);
  }
  const id = typeof raw.id === 'string' ? raw.id : '';
  assertSafeId(id);
  const abstract = raw.workItem == null && raw.spine == null;
  if (!abstract) {
    const rawOps = (raw as { ops?: unknown }).ops;
    if (Array.isArray(rawOps)) registerHarnessOpProxies(rawOps as Parameters<typeof registerHarnessOpProxies>[0]);
    const executable = resolveAndValidateBlueprint(raw, input.resolveExtends, blueprintRegistrySets());
    if (executable.parseError)
      throw new BlueprintLifecycleError(`blueprint ${id} failed to resolve: ${executable.parseError}`, 422);
    if (!executable.ok) {
      const errors = (executable.validation?.errors ?? []).map((issue) => `${issue.code}: ${issue.message}`).join('; ');
      throw new BlueprintLifecycleError(`blueprint ${id} is invalid: ${errors}`, 422);
    }
  }
  let source;
  try {
    source = resolveBlueprintSource(raw, { resolve: input.resolveExtends, sourcePath: input.blueprintFile });
    if (!source.validation.ok) throw new Error(source.validation.errors.map((issue) => issue.message).join('; '));
  } catch (error) {
    throw new BlueprintLifecycleError(`blueprint ${id} source resolution failed: ${String(error)}`, 422);
  }
  const resolved = BlueprintSourceDocumentSchema.parse(source.merged);
  const requests: Array<{ kind: string; ref: string; version?: string }> = [...(resolved.bundles ?? [])];
  const knowledge = resolveSeedPackKey(resolved).packId;
  if (knowledge && !requests.some((request) => request.kind === 'knowledge-pack' && request.ref === knowledge)) {
    requests.push({ kind: 'knowledge-pack', ref: knowledge });
  }
  let packages: ResolvedPackageInput[];
  try {
    packages = await resolveBlueprintPackageInputs(requests, input.resolvePackage);
  } catch (error) {
    throw new BlueprintLifecycleError(`blueprint ${id} package resolution failed: ${String(error)}`, 422);
  }
  const pins = [...packages, ...blueprintPackageInputs(source, packages)];
  const dependencies = resolved.dependencies as
    | {
        tools?: string[];
        packs?: string[];
        plugins?: string[];
        blueprints?: string[];
      }
    | undefined;
  let archive: BlueprintReleaseArchive;
  try {
    archive = buildBlueprintReleaseArchive(pins, id, await readClassContractSources(dirname(input.blueprintFile)));
  } catch (error) {
    if (error instanceof ClassContractImportError) {
      throw new BlueprintLifecycleError(`blueprint ${id} class contracts are invalid: ${error.message}`, 422);
    }
    throw error;
  }
  return {
    id,
    version: typeof raw.version === 'string' ? raw.version : archive.root.revision,
    description: typeof raw.description === 'string' ? raw.description : null,
    raw,
    slots: slotsOf(archive.root),
    dependencies: {
      tools: dependencies?.tools ?? [],
      packs: dependencies?.packs ?? [],
      plugins: dependencies?.plugins ?? [],
      blueprints: dependencies?.blueprints ?? [],
    },
    grants: { requires: resolved.grants?.requires ?? [], optional: resolved.grants?.optional ?? [] },
    contributions: resolved.contributions,
    archive,
  };
}

/** Build and sign the public distribution manifest whose content address covers
 * the complete P-006 closure. `publishListingToCupboard` re-validates it through
 * the shared release gate before sending only its immutable pins to the worker. */
export async function prepareBlueprintPublicRelease(input: {
  blueprintFile: string;
  listingRef: string;
  resolveExtends: ResolveExtendsPath;
  resolvePackage?: BlueprintPackageResolver;
  signer?: BlueprintReleaseSigner;
  license?: string;
}): Promise<PreparedBlueprintPublicRelease> {
  const source = await snapshotBlueprintReleaseSource(input);
  if (source.id !== input.listingRef) {
    throw new BlueprintLifecycleError(`blueprint id ${source.id} does not match listing ref ${input.listingRef}`, 422);
  }
  const signer = input.signer ?? (await defaultReleaseSigner());
  const unsignedRelease: Omit<CupboardReleaseManifest, 'signature'> = {
    schemaVersion: 1,
    listingKind: 'blueprint',
    listingRef: input.listingRef,
    releaseVersion: source.version,
    contentHash: source.archive.package.rootHash,
    dependencies: source.archive.pins
      .filter((pin) => pin !== source.archive.root)
      .map((pin) => `${pin.packageKind}:${pin.ref}@${pin.revision}#${pin.contentHash}`),
    compatibility: {},
    // D-034: the signed listing declares what install will ask consent for;
    // install refuses a non-empty list that differs from its own computation.
    permissions: identityPermissionLines(identityConsentSubjects({
      grants: source.grants, providerBindings: [], contributions: source.contributions, inputs: source.archive.pins,
    })),
    capabilities: [...source.dependencies.tools].sort(),
    license: input.license?.trim() || 'NOASSERTION',
    publisher: {
      githubUserId: signer.githubUserId,
      login: signer.githubLogin,
      devicePubkey: signer.devicePubkey,
    },
    reviewStatus: 'pending',
  };
  const release: CupboardReleaseManifest = {
    ...unsignedRelease,
    signature: (await signer.sign(listingManifestSigningBytes(unsignedRelease))).toString('base64'),
  };
  const unsignedDistribution: Omit<ArtifactDistributionManifest, 'signature'> = {
    schemaVersion: 1,
    release,
    rootHash: source.archive.package.rootHash,
    totalSizeBytes: source.archive.package.totalSizeBytes,
    chunks: source.archive.package.chunks,
    visibility: 'public',
    encryption: null,
    pinning: DEFAULT_PINNING_POLICY,
  };
  const manifest: ArtifactDistributionManifest = {
    ...unsignedDistribution,
    signature: (await signer.sign(distributionManifestSigningBytes(unsignedDistribution))).toString('base64'),
  };
  return {
    source,
    manifest,
    release: { visibility: 'public', manifest, bytes: source.archive.bytes },
  };
}

function slotsOf(root: ResolvedPackageInput): string[] {
  const value = root.value as { slots?: Array<{ slot?: unknown }> } | undefined;
  return (value?.slots ?? []).flatMap((entry) =>
    typeof entry.slot === 'string' && isSlotId(entry.slot) ? [entry.slot] : [],
  );
}

export function preflightBlueprintActivation(
  candidate: BlueprintActivationLayer,
  active: readonly BlueprintActivationLayer[] = [],
): BlueprintActivationPreflight {
  const claims = [...active, candidate].flatMap((layer) => layer.slots.map((slot) => ({ id: layer.id, slot })));
  const conflicts = findExclusiveSlotConflicts(claims).map((conflict) => ({
    slot: conflict.slot,
    claimants: [...conflict.claimants],
  }));
  return { ok: conflicts.length === 0, candidate: { id: candidate.id, slots: [...candidate.slots] }, conflicts };
}

async function readIndex(installedDir: string, id: string): Promise<BlueprintLifecycleIndex> {
  try {
    const value = JSON.parse(await fs.readFile(indexPath(installedDir, id), 'utf8')) as BlueprintLifecycleIndex;
    if (value.schemaVersion !== INDEX_SCHEMA_VERSION || value.id !== id || !Array.isArray(value.releases)) {
      throw new Error('invalid lifecycle index shape');
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { schemaVersion: INDEX_SCHEMA_VERSION, id, activeContentHash: null, releases: [] };
    }
    throw new BlueprintLifecycleError(`blueprint ${id} lifecycle index is unreadable: ${String(error)}`, 500);
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await fs.mkdir(resolve(path, '..'), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, path);
}

async function copyPackage(src: string, target: string): Promise<void> {
  await fs.cp(src, target, {
    recursive: true,
    filter: (path) => !path.split(/[/\\]/).includes('.git'),
  });
}

async function withLifecycleLock<T>(installedDir: string, id: string, run: () => Promise<T>): Promise<T> {
  const root = releaseRoot(installedDir, id);
  await fs.mkdir(root, { recursive: true });
  const lock = join(root, '.lock');
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      await fs.mkdir(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const stat = await fs.stat(lock).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > 10 * 60_000) {
        await fs.rm(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new BlueprintLifecycleError(`blueprint ${id} lifecycle is busy`, 409);
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  }
  try {
    return await run();
  } finally {
    await fs.rm(lock, { recursive: true, force: true });
  }
}

async function readArchive(installedDir: string, id: string, contentHash: string): Promise<BlueprintReleaseArchive> {
  const path = join(versionDir(installedDir, id, contentHash), 'closure.json');
  try {
    const parsed = JSON.parse(await fs.readFile(path, 'utf8')) as {
      pins?: ResolvedPackageInput[];
      classContracts?: unknown[];
    };
    return buildBlueprintReleaseArchive(parsed.pins ?? [], id, parsed.classContracts ?? []);
  } catch (error) {
    if (error instanceof BlueprintLifecycleError) throw error;
    throw new BlueprintLifecycleError(`blueprint ${id}@${contentHash} closure is unreadable: ${String(error)}`, 500);
  }
}

/** D-037: the retained closure of each ACTIVE installed release is the
 * destination's installed-package tier. A bundled package resolves from the
 * release that shipped it, and leaves with that release's uninstall/rollback. */
export async function resolveInstalledReleasePackage(
  installedDir: string,
  request: { kind: string; ref: string; version?: string },
): Promise<ResolvedPackageInput | null> {
  const ids = await fs.readdir(join(installedDir, '.releases')).catch(() => [] as string[]);
  for (const id of ids.sort()) {
    try {
      assertSafeId(id);
      const index = await readIndex(installedDir, id);
      if (!index.activeContentHash) continue;
      const archive = await readArchive(installedDir, id, index.activeContentHash);
      const pin = archive.pins.find((candidate) => candidate.packageKind === request.kind &&
        candidate.ref === request.ref && (!request.version || candidate.revision === request.version));
      if (pin) return pin;
    } catch {
      // An unreadable release offers nothing; its own lifecycle reports it.
    }
  }
  return null;
}

function promptMap(archive: Pick<BlueprintReleaseArchive, 'pins'> | null): Map<string, { hash: string; text: string }> {
  const out = new Map<string, { hash: string; text: string }>();
  for (const pin of archive?.pins ?? []) {
    if (pin.packageKind !== 'blueprint') continue;
    for (const file of pin.files) {
      if (!file.path.startsWith('prompts/')) continue;
      out.set(`${pin.ref}/${file.path}`, {
        hash: file.contentHash,
        text: Buffer.from(file.bytes, 'base64').toString('utf8'),
      });
    }
  }
  return out;
}

function flatten(value: unknown, prefix = ''): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    out.set(prefix, value);
    return out;
  }
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const child = flatten((value as Record<string, unknown>)[key], prefix ? `${prefix}.${key}` : key);
    for (const [path, entry] of child) out.set(path, entry);
  }
  return out;
}

function promptPatch(path: string, before: string, after: string): string {
  if (before === after) return '';
  const removed = before
    ? before
        .split('\n')
        .map((line) => `-${line}`)
        .join('\n')
    : '';
  const added = after
    ? after
        .split('\n')
        .map((line) => `+${line}`)
        .join('\n')
    : '';
  return [`--- a/${path}`, `+++ b/${path}`, '@@ prompt text @@', removed, added].filter(Boolean).join('\n');
}

/**
 * What sets a release's spend, keyed by path: root knobs, knobs of inherited
 * blueprint layers (qualified `<ref>:`), model/effort/cadence declarations in
 * roles and triggers, and the exact prompt bytes. One derivation, two readers:
 * diffBlueprintReleases compares it between releases, and an identity listing
 * declares it (identity-listing-surface.ts, agent-economy-flywheel P-015), so
 * the storefront shows the same values the upgrade diff compares.
 */
export function releaseBurnKnobs(archive: Pick<BlueprintReleaseArchive, 'root' | 'pins'> | null): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const pin of archive?.pins ?? []) {
    if (pin.packageKind !== 'blueprint') continue;
    const value = pin.value as { knobs?: unknown; roles?: unknown; triggers?: unknown };
    // Retain existing root knob paths; qualify inherited-package changes.
    const prefix = pin.ref === archive?.root.ref ? '' : `${pin.ref}:`;
    for (const [path, entry] of flatten(value.knobs ?? {})) out.set(prefix + path, entry);
    // These declarations can change default model/effort or recurring spend
    // without changing the root knobs. Report the source, not a cost estimate.
    for (const section of ['roles', 'triggers'] as const) {
      for (const [path, entry] of flatten(value[section] ?? {}, section)) {
        if (/effort|model|cadence|intervalSec|cron|loop/i.test(path) || Array.isArray(entry)) {
          out.set(prefix + path, entry);
        }
      }
    }
  }
  // Exact UTF-8 file bytes, deliberately not tokens or a predicted bill.
  out.set('promptBytes', [...promptMap(archive).values()].reduce((n, prompt) => n + Buffer.byteLength(prompt.text, 'utf8'), 0));
  return out;
}

function releaseGrantMap(archive: BlueprintReleaseArchive | null) {
  const out = new Map<string, { requires: string[]; optional: string[] }>();
  for (const pin of archive?.pins ?? []) {
    if (pin.packageKind !== 'blueprint') continue;
    const grants = (pin.value as { grants?: { requires?: string[]; optional?: string[] } }).grants;
    out.set(pin.ref, {
      requires: [...new Set(grants?.requires ?? [])].sort(),
      optional: [...new Set(grants?.optional ?? [])].sort(),
    });
  }
  return out;
}

export function diffBlueprintReleases(
  before: BlueprintReleaseArchive | null,
  after: BlueprintReleaseArchive | null,
): BlueprintReleaseDiff {
  const oldPrompts = promptMap(before);
  const newPrompts = promptMap(after);
  const promptText = [...new Set([...oldPrompts.keys(), ...newPrompts.keys()])].sort().flatMap((path) => {
    const oldValue = oldPrompts.get(path);
    const newValue = newPrompts.get(path);
    if (oldValue?.hash === newValue?.hash) return [];
    return [
      {
        path,
        beforeHash: oldValue?.hash ?? null,
        afterHash: newValue?.hash ?? null,
        patch: promptPatch(path, oldValue?.text ?? '', newValue?.text ?? ''),
      },
    ];
  });
  const oldKnobs = releaseBurnKnobs(before);
  const newKnobs = releaseBurnKnobs(after);
  const burnKnobs = [...new Set([...oldKnobs.keys(), ...newKnobs.keys()])].sort().flatMap((path) => {
    const beforeValue = oldKnobs.get(path);
    const afterValue = newKnobs.get(path);
    return canonicalJson(beforeValue) === canonicalJson(afterValue)
      ? []
      : [{ path, before: beforeValue ?? null, after: afterValue ?? null }];
  });
  const oldGrants = releaseGrantMap(before);
  const newGrants = releaseGrantMap(after);
  const grants: BlueprintReleaseDiff['grants'] = [];
  for (const layer of [...new Set([...oldGrants.keys(), ...newGrants.keys()])].sort()) {
    for (const kind of ['requires', 'optional'] as const) {
      const previous = oldGrants.get(layer)?.[kind] ?? [];
      const next = newGrants.get(layer)?.[kind] ?? [];
      const added = next.filter((ref) => !previous.includes(ref));
      const removed = previous.filter((ref) => !next.includes(ref));
      if (added.length || removed.length) grants.push({ layer, kind, added, removed });
    }
  }
  return {
    fromContentHash: before?.root.contentHash ?? null,
    toContentHash: after?.root.contentHash ?? null,
    promptText,
    burnKnobs,
    grants,
  };
}

async function materializeActive(installedDir: string, id: string, sourceDir: string): Promise<void> {
  const target = activeDir(installedDir, id);
  const stage = join(installedDir, `.${id}.installing-${process.pid}-${randomUUID()}`);
  const prior = join(installedDir, `.${id}.previous-${process.pid}-${randomUUID()}`);
  await copyPackage(sourceDir, stage);
  let hadPrior = false;
  try {
    try {
      await fs.rename(target, prior);
      hadPrior = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await fs.rename(stage, target);
    await fs.rm(prior, { recursive: true, force: true });
  } catch (error) {
    await fs.rm(stage, { recursive: true, force: true });
    if (hadPrior) await fs.rename(prior, target).catch(() => undefined);
    throw error;
  }
}

export async function commitBlueprintRelease(
  input: CommitBlueprintReleaseInput,
): Promise<CommitBlueprintReleaseResult> {
  assertSafeId(input.id);
  return withLifecycleLock(input.installedDir, input.id, async () => {
    let archive: BlueprintReleaseArchive;
    try {
      archive = buildBlueprintReleaseArchive(input.pins, input.id, input.classContracts ?? []);
    } catch (error) {
      if (error instanceof ClassContractImportError) {
        throw new BlueprintLifecycleError(`blueprint ${input.id} class contracts are invalid: ${error.message}`, 422);
      }
      throw error;
    }
    const modePolicyRef = (archive.root.value as { mode?: { policyRef?: unknown } } | undefined)?.mode?.policyRef;
    if (typeof modePolicyRef === 'string' &&
        (!input.modeApproval || input.modeApproval.policyRef !== modePolicyRef ||
         input.modeApproval.approvedArtifactContentHash.toLowerCase() !== archive.package.rootHash.toLowerCase())) {
      throw new BlueprintLifecycleError(`blueprint ${input.id} mode policy needs approval for this exact artifact`, 422);
    }
    const slots = slotsOf(archive.root);
    const activationPreflight = preflightBlueprintActivation({ id: input.id, slots }, input.activationStack ?? []);
    if (!activationPreflight.ok) {
      const details = activationPreflight.conflicts
        .map((entry) => `${entry.slot}: ${entry.claimants.join(', ')}`)
        .join('; ');
      throw new BlueprintLifecycleError(`blueprint ${input.id} activation slot conflict — ${details}`, 409);
    }
    verifyListedBlueprintRelease({
      id: input.id,
      version: input.version,
      archive,
      expectedRelease: input.expectedRelease,
    });
    const index = await readIndex(input.installedDir, input.id);
    const priorArchive = index.activeContentHash
      ? await readArchive(input.installedDir, input.id, index.activeContentHash)
      : null;
    const nowMs = input.nowMs ?? Date.now();
    const existing = index.releases.find((release) => release.contentHash === archive.root.contentHash);
    const modePolicyApproval = typeof modePolicyRef === 'string' ? {
      listingId: input.modeApproval!.listingId,
      policyRef: modePolicyRef,
      artifactContentHash: archive.package.rootHash,
    } : undefined;
    const approvalChanged = Boolean(existing && modePolicyApproval &&
      (existing.modePolicyApproval?.listingId !== modePolicyApproval.listingId ||
       existing.modePolicyApproval?.artifactContentHash !== modePolicyApproval.artifactContentHash));
    if (existing && modePolicyApproval) existing.modePolicyApproval = modePolicyApproval;
    const record: BlueprintReleaseRecord = existing ?? {
      schemaVersion: INDEX_SCHEMA_VERSION,
      id: input.id,
      version: input.version,
      contentHash: archive.root.contentHash,
      artifactContentHash: archive.package.rootHash,
      source: input.source,
      installedAtMs: nowMs,
      slots,
      pins: archive.pins.map(releasePinSummary),
      ...(modePolicyApproval ? { modePolicyApproval } : {}),
    };
    const historyDir = versionDir(input.installedDir, input.id, archive.root.contentHash);
    const operation =
      index.activeContentHash === archive.root.contentHash
        ? ('no-op' as const)
        : index.activeContentHash
          ? ('update' as const)
          : ('install' as const);
    // D-034 order: journaled bindings first, this switch (activation last), then apply.
    const journal = await journaledSwitch(input.journal, index.activeContentHash, archive.root.contentHash, async () => {
      if (!existing) {
        const stage = `${historyDir}.${process.pid}.${randomUUID()}.tmp`;
        await fs.mkdir(stage, { recursive: true });
        await copyPackage(input.sourceDir, join(stage, 'content'));
        await fs.writeFile(
          join(stage, 'closure.json'),
          JSON.stringify({
            schemaVersion: 1,
            pins: archive.pins,
            ...(archive.classContracts.length ? { classContracts: archive.classContracts } : {}),
          }, null, 2) + '\n',
        );
        await fs.writeFile(join(stage, 'release.json'), JSON.stringify(record, null, 2) + '\n');
        await fs.rename(stage, historyDir);
        index.releases.push(record);
      } else if (approvalChanged) {
        // Moderation can approve an already retained byte-identical release.
        // Persist its receipt without changing the immutable source closure.
        await atomicWriteJson(join(historyDir, 'release.json'), record);
      }
      // Re-materialize even a content no-op: the immutable archive is the source
      // of truth, so an untracked/stale file in the active compatibility directory
      // is repaired rather than silently surviving a reinstall.
      await materializeActive(input.installedDir, input.id, join(historyDir, 'content'));
      if (operation !== 'no-op' || approvalChanged) {
        index.activeContentHash = archive.root.contentHash;
        await atomicWriteJson(indexPath(input.installedDir, input.id), index);
      }
    });
    return {
      operation,
      record,
      installedTo: activeDir(input.installedDir, input.id),
      historyDir,
      diff: diffBlueprintReleases(priorArchive, archive),
      activationPreflight,
      ...(journal ? { journal } : {}),
    };
  });
}

export async function rollbackBlueprintRelease(input: {
  installedDir: string; id: string; target: string; journal?: BlueprintLifecycleJournal;
}): Promise<{
  operation: 'rollback';
  record: BlueprintReleaseRecord;
  installedTo: string;
  diff: BlueprintReleaseDiff;
  activationRequired: true;
  journal?: BlueprintJournalReport;
}> {
  assertSafeId(input.id);
  return withLifecycleLock(input.installedDir, input.id, async () => {
    const index = await readIndex(input.installedDir, input.id);
    const candidates = index.releases.filter(
      (release) => release.version === input.target || release.contentHash === input.target,
    );
    const record = candidates.sort((a, b) => b.installedAtMs - a.installedAtMs)[0];
    if (!record)
      throw new BlueprintLifecycleError(`blueprint ${input.id} has no installed release ${input.target}`, 404);
    const before = index.activeContentHash
      ? await readArchive(input.installedDir, input.id, index.activeContentHash)
      : null;
    const after = await readArchive(input.installedDir, input.id, record.contentHash);
    const journal = await journaledSwitch(input.journal, index.activeContentHash, record.contentHash, async () => {
      await materializeActive(
        input.installedDir,
        input.id,
        join(versionDir(input.installedDir, input.id, record.contentHash), 'content'),
      );
      index.activeContentHash = record.contentHash;
      await atomicWriteJson(indexPath(input.installedDir, input.id), index);
    });
    return {
      operation: 'rollback',
      record,
      installedTo: activeDir(input.installedDir, input.id),
      diff: diffBlueprintReleases(before, after),
      activationRequired: true,
      ...(journal ? { journal } : {}),
    };
  });
}

export async function uninstallBlueprintRelease(input: {
  installedDir: string; id: string; nowMs?: number; journal?: BlueprintLifecycleJournal;
}): Promise<{
  operation: 'uninstall';
  removed: BlueprintReleaseRecord;
  retained: BlueprintReleaseRecord[];
  diff: BlueprintReleaseDiff;
  activationRequired: true;
  journal?: BlueprintJournalReport;
}> {
  assertSafeId(input.id);
  return withLifecycleLock(input.installedDir, input.id, async () => {
    const index = await readIndex(input.installedDir, input.id);
    const removed = index.releases.find((release) => release.contentHash === index.activeContentHash);
    if (!removed) {
      // A retried uninstall is still a lifecycle call: converge what an
      // interrupted one left in the journal before refusing.
      const recovered = input.journal ? await input.journal.recover(null) : [];
      const converged = recovered.length ? `; converged ${recovered.length} interrupted pot install(s)` +
        (recovered.some((entry) => entry.error) ? ', with residue' : '') : '';
      throw new BlueprintLifecycleError(`installed blueprint ${input.id} not found${converged}`, 404);
    }
    const before = await readArchive(input.installedDir, input.id, removed.contentHash);
    const target = activeDir(input.installedDir, input.id);
    const tombstone = join(input.installedDir, `.${input.id}.removing-${process.pid}-${randomUUID()}`);
    // D-034: the file tier goes first; the journal then fences and cleans every pot install.
    const journal = await journaledSwitch(input.journal, index.activeContentHash, null, async () => {
      try {
        await fs.rename(target, tombstone);
        await fs.rm(tombstone, { recursive: true, force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      removed.retiredAtMs = input.nowMs ?? Date.now();
      index.activeContentHash = null;
      await atomicWriteJson(indexPath(input.installedDir, input.id), index);
    });
    return {
      operation: 'uninstall',
      removed,
      retained: [...index.releases],
      diff: diffBlueprintReleases(before, null),
      activationRequired: true,
      ...(journal ? { journal } : {}),
    };
  });
}

export async function readBlueprintLifecycle(
  installedDir: string,
  id: string,
): Promise<{
  active: BlueprintReleaseRecord | null;
  releases: BlueprintReleaseRecord[];
}> {
  assertSafeId(id);
  const index = await readIndex(installedDir, id);
  return {
    active: index.releases.find((release) => release.contentHash === index.activeContentHash) ?? null,
    releases: [...index.releases].sort((a, b) => b.installedAtMs - a.installedAtMs),
  };
}
