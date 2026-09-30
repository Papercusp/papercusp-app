import { createHash } from 'node:crypto';
import { z } from 'zod';

/** Evidence contracts for the capability extension of the existing Dream pipeline. */
const text = z.string().trim().min(1).max(2_000);
const id = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9:._-]*$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const CapabilityPathSchema = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (p) =>
      !p.includes('\\') &&
      !/[\x00*?\[\]{}]/.test(p) &&
      p.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && !part.startsWith('-')),
    'Evidence must name an exact repository-relative POSIX path',
  );

export const CapabilityClaimSchema = z
  .object({
    text,
    status: z.enum(['observed', 'inferred', 'unknown']),
    evidenceIds: z.array(id).max(24),
  })
  .strict()
  .superRefine((claim, ctx) => {
    if (claim.status === 'observed' && claim.evidenceIds.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['evidenceIds'], message: 'Observed claims require evidence' });
    }
  });
export type CapabilityClaim = z.infer<typeof CapabilityClaimSchema>;

export const CapabilityEvidenceRefSchema = z
  .object({
    id,
    kind: z.enum(['implementation', 'test', 'contract', 'documentation']),
    path: CapabilityPathSchema,
    anchor: z.string().trim().min(1).max(300),
    proves: text,
  })
  .strict();
export type CapabilityEvidenceRef = z.infer<typeof CapabilityEvidenceRefSchema>;

const claims = z.array(CapabilityClaimSchema).max(24);
export const CapabilityUnitSchema = z
  .object({
    id,
    granularity: z.enum(['capability', 'mechanism', 'subsystem']),
    name: z.string().trim().min(1).max(200),
    homeDomain: id,
    relatedDomains: z.array(id).max(16),
    parentId: id.nullable(),
    branch: id,
    relatedUnitIds: z.array(id).max(24),
    overlapsUnitIds: z.array(id).max(24),
    purpose: claims.min(1),
    mechanism: claims.min(1),
    evaluation: claims.min(1),
    contracts: z
      .object({
        inputs: claims,
        outputs: claims,
        events: claims,
        state: claims,
        guarantees: claims,
        prerequisites: claims,
        failureModes: claims,
        resourceConstraints: claims,
      })
      .strict(),
    evidence: z.array(CapabilityEvidenceRefSchema).min(2).max(24),
  })
  .strict()
  .superRefine((unit, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if (!unit.id.startsWith(unit.granularity + ':')) fail('Unit identity must include its granularity');
    const refs = new Map(unit.evidence.map((ref) => [ref.id, ref]));
    if (refs.size !== unit.evidence.length) fail('Evidence identities must be unique');
    if (!unit.evidence.some((ref) => ref.kind === 'implementation')) fail('Implementation evidence is required');
    if (!unit.evidence.some((ref) => ref.kind === 'test')) fail('Meaningful test evidence is required');
    const all = [...unit.purpose, ...unit.mechanism, ...unit.evaluation, ...Object.values(unit.contracts).flat()];
    for (const claim of all) {
      if (claim.evidenceIds.some((ref) => !refs.has(ref))) fail('Claim cites an unknown evidence identity');
    }
    for (const claim of unit.evaluation) {
      if (claim.status === 'observed' && !claim.evidenceIds.some((ref) => refs.get(ref)?.kind === 'test')) {
        fail('Observed evaluation claims require test evidence');
      }
    }
  });
export type CapabilityUnit = z.infer<typeof CapabilityUnitSchema>;

export const CapabilityManifestSchema = z
  .object({
    schemaVersion: z.literal('dream-capability-manifest-v1'),
    revision: z.string().trim().min(1).max(160),
    domainSource: z.literal('testing-domains-registry'),
    coverage: z
      .object({
        status: z.literal('partial'),
        unmapped: z.array(text).min(1).max(100),
        note: text,
      })
      .strict(),
    units: z.array(CapabilityUnitSchema).min(2).max(200),
  })
  .strict();
export type CapabilityManifest = z.infer<typeof CapabilityManifestSchema>;

/** Registry identities are supplied by the existing domain registry, never inferred from globs. */
export function parseCapabilityManifest(value: unknown, domainIds: readonly string[]): CapabilityManifest {
  const manifest = CapabilityManifestSchema.parse(value);
  const domains = new Set(domainIds);
  const units = new Map(manifest.units.map((unit) => [unit.id, unit]));
  if (units.size !== manifest.units.length) throw new Error('Duplicate capability identity');
  for (const unit of manifest.units) {
    if (![unit.homeDomain, ...unit.relatedDomains].every((domain) => domains.has(domain))) {
      throw new Error('Unknown domain for ' + unit.id);
    }
    const links = [unit.parentId, ...unit.relatedUnitIds, ...unit.overlapsUnitIds].filter(
      (ref): ref is string => ref !== null,
    );
    if (links.some((ref) => ref === unit.id || !units.has(ref)))
      throw new Error('Unresolved or self-linked capability parent/overlap');
    const ancestors = new Set([unit.id]);
    let parent = unit.parentId;
    while (parent) {
      if (ancestors.has(parent)) throw new Error('Cyclic capability parentage');
      ancestors.add(parent);
      const ancestor = units.get(parent);
      if (!ancestor) throw new Error('Unresolved capability parent');
      parent = ancestor.parentId;
    }
  }
  return manifest;
}

export function capabilityHash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function capabilityUnitHash(unit: CapabilityUnit): string {
  return capabilityHash(JSON.stringify(CapabilityUnitSchema.parse(unit)));
}

export const CapabilitySourceSchema = CapabilityEvidenceRefSchema.extend({
  sourceHash: sha,
  excerptHash: sha,
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  excerpt: z.string().min(1).max(12_000),
})
  .strict()
  .superRefine((source, ctx) => {
    if (
      source.endLine < source.startLine ||
      source.excerpt.split('\n').length !== source.endLine - source.startLine + 1
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Excerpt line range does not match its text' });
    }
    if (capabilityHash(source.excerpt) !== source.excerptHash) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Excerpt content hash does not match its bytes' });
    }
  });
export type CapabilitySource = z.infer<typeof CapabilitySourceSchema>;

export const CapabilityPacketSchema = z
  .object({
    schemaVersion: z.literal('dream-capability-packet-v1'),
    scope: z.object({ workspaceId: id, potSlug: id, repositoryId: id }).strict(),
    unit: CapabilityUnitSchema,
    unitHash: sha,
    manifestRevision: z.string().trim().min(1).max(160),
    sources: z.array(CapabilitySourceSchema).min(2).max(24),
    extraction: z
      .object({
        recipeVersion: id,
        promptVersion: id,
        capturedAt: z.string().datetime(),
        sourceCommit: z
          .string()
          .regex(/^[a-f0-9]{40,64}$/)
          .nullable(),
        dirty: z.boolean().nullable(),
        backend: z.enum(['lsp', 'gitnexus', 'ripgrep', 'text']),
        indexHealth: z.enum(['current', 'stale', 'unknown']),
        artifactRef: z.string().min(1).max(1_000),
        artifactHash: sha,
        durationMs: z.number().finite().nonnegative(),
        securityScan: z.literal('passed'),
        costUsd: z.number().finite().nonnegative().nullable(),
      })
      .strict(),
    coverage: z
      .object({
        status: z.literal('partial'),
        includedPaths: z.array(CapabilityPathSchema).min(1).max(24),
        excluded: z.array(text).max(100),
        unresolved: z.array(text).max(100),
        truncated: z.boolean(),
        note: text,
      })
      .strict(),
  })
  .strict()
  .superRefine((packet, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    // A nested refinement can report issues without aborting this refinement.
    // Rejected units must remain a safeParse failure, never a thrown parser error.
    const unit = CapabilityUnitSchema.safeParse(packet.unit);
    if (!unit.success) return;
    if (packet.unitHash !== capabilityHash(JSON.stringify(unit.data)))
      fail('Packet unit hash does not match its manifest');
    const sources = new Map(packet.sources.map((source) => [source.id, source]));
    if (sources.size !== packet.sources.length) fail('Packet contains duplicate evidence identities');
    for (const ref of packet.unit.evidence) {
      const source = sources.get(ref.id);
      if (
        !source ||
        source.path !== ref.path ||
        source.kind !== ref.kind ||
        source.anchor !== ref.anchor ||
        source.proves !== ref.proves
      ) {
        fail('Packet evidence does not match the declared manifest reference: ' + ref.id);
      }
      if (source && !source.excerpt.includes(ref.anchor)) fail('Evidence anchor is absent from its excerpt: ' + ref.id);
    }
    if (sources.size !== packet.unit.evidence.length) fail('Packet includes undeclared evidence');
    const paths = new Set(packet.sources.map((source) => source.path));
    if (
      packet.coverage.includedPaths.length !== paths.size ||
      packet.coverage.includedPaths.some((path) => !paths.has(path))
    ) {
      fail('Packet coverage does not match its evidence paths');
    }
  });

/** Structural validity is not a source-freshness verdict; re-read source bytes at admission. */
export type CapabilityPacket = z.infer<typeof CapabilityPacketSchema>;
