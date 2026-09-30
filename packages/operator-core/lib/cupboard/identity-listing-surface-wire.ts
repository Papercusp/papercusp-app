/**
 * The wire shape of an identity listing's declared surface (portable-identity-
 * packages P-016): the canonical JSON the Cupboard stores in `identity_surface`
 * (worker migration 035), and its reader.
 *
 * Kept apart from identity-listing-surface.ts, which DERIVES the surface from a
 * release closure and so pulls in the orchestrator's blueprint parser: the
 * storefront detail page reads this in the browser bundle and needs only the
 * shape.
 */

export const IDENTITY_LISTING_SURFACE_SCHEMA_VERSION = 1 as const;
/** The worker stores the canonical JSON in one bounded TEXT column (migration 035). */
export const IDENTITY_LISTING_SURFACE_MAX_CHARS = 16_000;

/** When a contribution acts; the same vocabulary as the author preview. */
export type IdentitySurfaceTiming = 'every-turn' | 'mode-change' | 'on-demand' | `on event ${string}`;

export interface IdentityListingSurface {
  readonly schemaVersion: typeof IDENTITY_LISTING_SURFACE_SCHEMA_VERSION;
  readonly identity: { readonly id: string; readonly version: string; readonly slots: readonly string[] };
  readonly contributions: readonly {
    readonly id: string;
    readonly inputKind: string;
    readonly ref: string;
    readonly verb?: string;
    readonly refresh: string;
    readonly injection?: {
      readonly sinks: readonly string[];
      readonly timing: IdentitySurfaceTiming;
      readonly tokenBudget: number;
      readonly priority: number;
      readonly overBudget: string;
    };
  }[];
  readonly hooks: {
    readonly sync: readonly {
      readonly id: string; readonly rule: string; readonly sink: string;
      readonly kind: 'context' | 'guard'; readonly tools?: readonly string[];
    }[];
    readonly async: readonly { readonly id: string; readonly rule: string; readonly on: string; readonly fire: string }[];
    /** A bundled rule the closure carries but this build cannot parse. */
    readonly unreadable: readonly string[];
  };
  /** Every pinned package in the closure except the identity itself. */
  readonly packages: readonly { readonly kind: string; readonly ref: string; readonly version: string; readonly contentHash: string }[];
  readonly knowledge: readonly {
    readonly ref: string; readonly version: string; readonly memories: number;
    readonly docs: readonly { readonly id: string; readonly title: string; readonly section: string }[];
  }[];
  readonly classContracts: readonly { readonly ref: string; readonly contractHash: string }[];
  readonly grants: { readonly requires: readonly string[]; readonly optional: readonly string[] };
  /** Exactly the signed manifest's `permissions` (identityPermissionLines). */
  readonly permissions: readonly string[];
  /** 'content-only' installs with no administrator consent (D-034). */
  readonly consent: 'content-only' | 'required';
}

/**
 * Read a listing's `identity_surface` column (canonical JSON TEXT). Null when
 * absent or unreadable; the install gate treats an unreadable surface on an
 * identity listing as a mismatch, never as permission to skip the check.
 */
export function parseIdentityListingSurface(value: unknown): IdentityListingSurface | null {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const surface = parsed as Partial<IdentityListingSurface>;
  if (typeof surface.schemaVersion !== 'number' || !surface.identity || typeof surface.identity.id !== 'string') return null;
  return parsed as IdentityListingSurface;
}
