/**
 * The declared surface of an identity listing (portable-identity-packages P-016).
 *
 * An identity publishes as a `blueprint` listing with an identity facet
 * (`blueprint_kind: 'identity'`, plan Q1/D-013) that carries this surface: what a
 * shopper sees before installing — slots, context contributions and their
 * injection points, synchronous and asynchronous hooks, bundled packages,
 * knowledge-pack memories and docs, reviewed class contracts, grants, and the
 * permission lines install will ask consent for.
 *
 * It is DERIVED from the release closure, never authored: publish computes it from
 * the snapshot it signs, and install recomputes it from the clone it verified and
 * refuses a listing whose surface differs (`identity_surface_mismatch`), so a
 * storefront preview cannot describe less than what installs. It is independent of
 * the destination pot: which provider a pot binds for a class is the install
 * consent's question (identity-install-consent.ts), not the listing's.
 */
import {
  isSlotId,
  parseBlueprintSourceDocument,
  type BlueprintSourceDocument,
  type InjectionTrigger,
  type ResolvedPackageInput,
} from '@papercusp/orchestrator/blueprint';
import { canonicalJson } from '../authority/authority-rpc-envelope';
import { wornRulePins } from '../agent-identities/sync-hook-rules';
import type { KnowledgePack } from '../knowledge-packs/pack-format';
import { releaseBurnKnobs, type BlueprintReleaseArchive, type BlueprintReleaseSourceSnapshot } from './blueprint-release';
import { identityConsentSubjects, identityPermissionLines } from './identity-install-consent';
import {
  IDENTITY_LISTING_SURFACE_MAX_CHARS,
  IDENTITY_LISTING_SURFACE_SCHEMA_VERSION,
  parseIdentityListingSurface,
  type IdentityListingSurface,
  type IdentitySurfaceTiming,
} from './identity-listing-surface-wire';

export {
  IDENTITY_LISTING_SURFACE_MAX_CHARS,
  IDENTITY_LISTING_SURFACE_SCHEMA_VERSION,
  parseIdentityListingSurface,
  type IdentityListingSurface,
  type IdentitySurfaceTiming,
};

export interface IdentityListingSurfaceInput {
  readonly id: string;
  readonly version: string;
  readonly grants: { readonly requires?: readonly string[]; readonly optional?: readonly string[] } | undefined;
  readonly contributions: BlueprintSourceDocument['contributions'];
  /** The closure publish signs and install verifies (buildBlueprintReleaseArchive). */
  readonly archive: Pick<BlueprintReleaseArchive, 'root' | 'pins' | 'classContracts'>;
}

/**
 * True for an identity document: an authored layer that declares its own slots.
 * A layer that declares slots but fails the identity schema is still an identity
 * (the release validators refuse it); it never downgrades to a harness facet.
 */
export function isIdentityBlueprintSource(raw: Record<string, unknown>): boolean {
  try {
    return parseBlueprintSourceDocument(raw).kind === 'identity';
  } catch {
    return Object.prototype.hasOwnProperty.call(raw, 'slots');
  }
}

/** The listing's `blueprint_kind` facet for a blueprint source (worker migration 009/035). */
export function blueprintListingKind(raw: Record<string, unknown>): 'hive' | 'harness' | 'identity' {
  if (raw.kind === 'hive' || raw.kind === 'pot') return 'hive';
  return isIdentityBlueprintSource(raw) ? 'identity' : 'harness';
}

function timingOf(trigger: InjectionTrigger): IdentitySurfaceTiming {
  return typeof trigger === 'string' ? trigger : `on event ${trigger.event}`;
}

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/** The slots the release's root blueprint pin declares — what install preflights (blueprint-release.ts). */
function rootSlots(root: ResolvedPackageInput): string[] {
  const value = root.value as { slots?: Array<{ slot?: unknown }> } | undefined;
  return (value?.slots ?? []).flatMap((entry) =>
    typeof entry.slot === 'string' && isSlotId(entry.slot) ? [entry.slot] : []);
}

function knowledgeOf(pin: ResolvedPackageInput): IdentityListingSurface['knowledge'][number] {
  const pack = pin.value as Partial<KnowledgePack> | undefined;
  return {
    ref: pin.ref,
    version: pin.revision,
    memories: Array.isArray(pack?.items) ? pack.items.length : 0,
    docs: (Array.isArray(pack?.docs) ? pack.docs : [])
      .map((doc) => ({ id: doc.id, title: doc.title, section: doc.section }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export function identityListingSurface(input: IdentityListingSurfaceInput): IdentityListingSurface {
  const pins = [...input.archive.pins].sort((a, b) =>
    `${a.packageKind}:${a.ref}`.localeCompare(`${b.packageKind}:${b.ref}`));
  const { rules, unreadable } = wornRulePins({ inputs: pins });
  const pinVersion = new Map(pins.map((pin) => [pin.ref, pin.revision]));
  const ruleRef = (pinRef: string) => `${pinRef}@${pinVersion.get(pinRef) ?? 'unversioned'}`;
  const subjects = identityConsentSubjects({
    grants: input.grants, providerBindings: [], contributions: input.contributions, inputs: pins,
  });
  return {
    schemaVersion: IDENTITY_LISTING_SURFACE_SCHEMA_VERSION,
    identity: { id: input.id, version: input.version, slots: rootSlots(input.archive.root) },
    contributions: (input.contributions ?? []).map((entry) => ({
      id: entry.id,
      inputKind: entry.inputKind,
      ref: entry.ref,
      ...(entry.verb ? { verb: entry.verb } : {}),
      refresh: entry.refresh,
      ...(entry.injection ? { injection: {
        sinks: [...entry.injection.sinks], timing: timingOf(entry.injection.trigger),
        tokenBudget: entry.injection.tokenBudget, priority: entry.injection.priority,
        overBudget: entry.injection.overBudget,
      } } : {}),
    })),
    hooks: {
      sync: rules.flatMap(({ pinRef, rule }) => rule.delivery !== 'sync' ? [] : [{
        id: rule.id, rule: ruleRef(pinRef), sink: rule.sink, kind: rule.guard ? 'guard' as const : 'context' as const,
        ...(rule.tools ? { tools: [...rule.tools] } : {}),
      }]),
      async: rules.flatMap(({ pinRef, rule }) => rule.delivery !== 'async' ? []
        : [{ id: rule.id, rule: ruleRef(pinRef), on: rule.on, fire: rule.fire }]),
      unreadable: sorted(unreadable.map(({ pinRef }) => ruleRef(pinRef))),
    },
    packages: pins.flatMap((pin) => pin === input.archive.root ? []
      : [{ kind: pin.packageKind, ref: pin.ref, version: pin.revision, contentHash: pin.contentHash }]),
    knowledge: pins.flatMap((pin) => pin.packageKind === 'knowledge-pack' ? [knowledgeOf(pin)] : []),
    classContracts: [...input.archive.classContracts]
      .map(({ ref, contractHash }) => ({ ref, contractHash }))
      .sort((a, b) => a.ref.localeCompare(b.ref)),
    grants: { requires: sorted(input.grants?.requires ?? []), optional: sorted(input.grants?.optional ?? []) },
    // Declared beside grants and diffed between releases like them: the same
    // derivation the upgrade diff compares (agent-economy-flywheel P-015).
    burnKnobs: [...releaseBurnKnobs(input.archive)]
      .map(([path, value]) => ({ path, value: value === undefined ? null : value }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    permissions: identityPermissionLines(subjects),
    consent: subjects.contentOnly ? 'content-only' : 'required',
  };
}

/**
 * The listing facet both publish doors send (blueprint:publish and the storefront
 * route): `blueprint_kind`, plus the serialized surface for an identity — computed
 * from the exact snapshot the release signs, never from anything the author typed.
 */
export function blueprintListingFacet(
  source: Pick<BlueprintReleaseSourceSnapshot, 'id' | 'version' | 'raw' | 'grants' | 'contributions' | 'archive'>,
): { blueprint_kind: 'hive' | 'harness' | 'identity'; identity_surface?: string } {
  const blueprintKind = blueprintListingKind(source.raw);
  if (blueprintKind !== 'identity') return { blueprint_kind: blueprintKind };
  return {
    blueprint_kind: blueprintKind,
    identity_surface: serializeIdentityListingSurface(identityListingSurface({
      id: source.id, version: source.version, grants: source.grants,
      contributions: source.contributions, archive: source.archive,
    })),
  };
}

/** The wire form: canonical JSON, so a byte comparison is a surface comparison. */
export function serializeIdentityListingSurface(surface: IdentityListingSurface): string {
  const text = canonicalJson(surface);
  if (text.length > IDENTITY_LISTING_SURFACE_MAX_CHARS) {
    throw new Error(`identity listing surface is ${text.length} chars; the Cupboard stores at most ${IDENTITY_LISTING_SURFACE_MAX_CHARS}`);
  }
  return text;
}

export type IdentityListingSurfaceMismatchReason = 'missing' | 'unreadable' | 'schema-version' | 'differs';

/** Null when the listed surface is exactly what the closure carries. */
export function identityListingSurfaceMismatch(
  listed: unknown,
  carried: IdentityListingSurface,
): { reason: IdentityListingSurfaceMismatchReason; listed: IdentityListingSurface | null } | null {
  if (listed == null || listed === '') return { reason: 'missing', listed: null };
  const surface = parseIdentityListingSurface(listed);
  if (!surface) return { reason: 'unreadable', listed: null };
  if (surface.schemaVersion !== carried.schemaVersion) return { reason: 'schema-version', listed: surface };
  return canonicalJson(surface) === canonicalJson(carried) ? null : { reason: 'differs', listed: surface };
}

/** What a Cupboard row says about itself (worker columns blueprint_kind + identity_surface). */
export interface ListedBlueprintFacet {
  readonly blueprintKind: string | null;
  readonly identitySurface: string | null;
}

export interface IdentityFacetMismatch {
  /** 'facet': an identity listed under another facet; 'not-an-identity': the reverse. */
  readonly reason: IdentityListingSurfaceMismatchReason | 'facet' | 'not-an-identity';
  readonly listedKind: string | null;
  readonly listed: IdentityListingSurface | null;
  readonly carried: IdentityListingSurface | null;
}

/**
 * The install gate for a listing-resolved install: an identity must be listed with
 * the identity facet and exactly the surface its verified closure derives, and a
 * non-identity must not claim the facet. `surface` is the carried surface (null for
 * a non-identity), which install reports whether or not a listing was involved.
 */
export function checkListedIdentityFacet(
  listed: ListedBlueprintFacet | undefined,
  source: IdentityListingSurfaceInput & { readonly raw: Record<string, unknown> },
): { surface: IdentityListingSurface | null; mismatch: IdentityFacetMismatch | null } {
  const surface = isIdentityBlueprintSource(source.raw) ? identityListingSurface(source) : null;
  if (!listed) return { surface, mismatch: null };
  const listedKind = listed.blueprintKind;
  if (!surface) {
    const claims = listedKind === 'identity' || listed.identitySurface != null;
    return { surface, mismatch: claims ? { reason: 'not-an-identity', listedKind, listed: null, carried: null } : null };
  }
  if (listedKind !== 'identity') {
    return { surface, mismatch: { reason: 'facet', listedKind, listed: null, carried: surface } };
  }
  const mismatch = identityListingSurfaceMismatch(listed.identitySurface, surface);
  return { surface, mismatch: mismatch ? { ...mismatch, listedKind, carried: surface } : null };
}
