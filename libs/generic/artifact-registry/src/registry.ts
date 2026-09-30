/**
 * ArtifactRegistry — the registry half of an artifact distribution system.
 *
 * A registry is an index of distributable artifact *listings* (a plugin, a
 * snapshot, a blueprint, a package version…). This core owns the listing
 * *lifecycle* — publish (with dedupe), get, list, unlist (with content-addressed
 * blob GC), claim — over a pluggable `ListingStore` metadata backend, while the
 * *domain* (what kinds exist, the listing's field shape, the identity/trust model,
 * the dedupe key, claim authorization) is injected through `ArtifactRegistryPolicies`.
 *
 * Generic over the row type `TRow`, the publish-input type `TInput`, and the
 * insert type `TInsert`. Zero coupling: no SQL, no HTTP, no auth provider — the
 * host maps its store + domain onto the seam, exactly like the Cupboard worker
 * maps D1 + R2 + GitHub onto it. PURE w.r.t. transport.
 */

import {
  gcIfUnreferenced,
  type ArtifactStatus,
  type BlobStore,
} from "./blob-store.js";

/** A principal acting on the registry (publisher / claimant / unlister). */
export interface PrincipalRef {
  user_id: number | string;
  login?: string;
}

/**
 * The pluggable metadata backend. The host implements this over its store —
 * Postgres, SQLite/D1, an in-memory map. `list`'s query is `unknown` so each host
 * defines its own filter/pagination shape without leaking it into the core.
 */
export interface ListingStore<TRow, TInsert> {
  insert(input: TInsert): Promise<void>;
  getById(id: string): Promise<TRow | null>;
  list(query: unknown): Promise<TRow[]>;
  markUnlisted(id: string, reason: string, now: number): Promise<void>;
  setClaim(id: string, claim: PrincipalRef, now: number): Promise<void>;
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; status: ArtifactStatus; error: string; field?: string };

/** The injected domain: everything registry policy needs that isn't generic. */
export interface ArtifactRegistryPolicies<TRow, TInput, TInsert> {
  /** Domain validation of a publish request (field shape, per-kind rules…). */
  validate(input: TInput): ValidationResult | Promise<ValidationResult>;
  /** The active listing this publish would duplicate, or null to mint a new one. */
  findDuplicate(input: TInput): Promise<TRow | null>;
  /** Build the row to insert; the registry supplies a fresh `id` + `now`. */
  toInsert(input: TInput, ctx: { id: string; now: number }): TInsert;
  idOf(row: TRow): string;
  isUnlisted(row: TRow): boolean;
  /** Is the row already claimed? (claim conflict guard). Default: never claimed. */
  isClaimed?(row: TRow): boolean;
  /** Authorize an unlist by `actor`. Default: allow. */
  authorizeUnlist?(row: TRow, actor: PrincipalRef): boolean | Promise<boolean>;
  /** Authorize a claim by `claimant`. Default: allow. */
  authorizeClaim?(row: TRow, claimant: PrincipalRef): boolean | Promise<boolean>;
  /** The content-addressed blob this row points at (for GC on unlist), or null. */
  blobKeyOf?(row: TRow): string | null;
  /** Is `key` still referenced by some OTHER live listing? (refcount for GC) */
  isBlobStillReferenced?(key: string): Promise<boolean> | boolean;
}

export interface ArtifactRegistryOptions {
  /** Fresh listing id. Default: `crypto.randomUUID()`. */
  genId?: () => string;
  /** Current epoch-ms. Default: `Date.now()`. Inject for deterministic tests. */
  now?: () => number;
  /** The blob backend, when listings carry content-addressed blobs (for unlist GC). */
  blobStore?: BlobStore;
}

export type PublishResult<TRow> =
  | { ok: true; id: string; row: TRow; deduped: boolean }
  | { ok: false; status: ArtifactStatus; error: string; field?: string };

export type UnlistResult =
  | { ok: true; id: string; alreadyUnlisted?: boolean; blobCollected?: boolean }
  | { ok: false; status: ArtifactStatus; error: string };

export type ClaimResult<TRow> =
  | { ok: true; id: string; row: TRow }
  | { ok: false; status: ArtifactStatus; error: string };

export class ArtifactRegistry<TRow, TInput, TInsert> {
  constructor(
    private readonly store: ListingStore<TRow, TInsert>,
    private readonly policies: ArtifactRegistryPolicies<TRow, TInput, TInsert>,
    private readonly options: ArtifactRegistryOptions = {},
  ) {}

  private newId(): string {
    // Bare `crypto` — the ambient Web-Crypto global across Node 18+, Workers,
    // Deno, browsers — type-checks under every host lib setting (see sha256Hex).
    return (this.options.genId ?? (() => crypto.randomUUID()))();
  }

  private nowMs(): number {
    return (this.options.now ?? (() => Date.now()))();
  }

  /** Publish a listing: validate → dedupe (return the existing one) → insert. */
  async publish(input: TInput): Promise<PublishResult<TRow>> {
    const v = await this.policies.validate(input);
    if (!v.ok) return { ok: false, status: v.status, error: v.error, field: v.field };

    const dup = await this.policies.findDuplicate(input);
    if (dup && !this.policies.isUnlisted(dup)) {
      return { ok: true, id: this.policies.idOf(dup), row: dup, deduped: true };
    }

    const id = this.newId();
    const now = this.nowMs();
    await this.store.insert(this.policies.toInsert(input, { id, now }));
    const row = await this.store.getById(id);
    if (!row) return { ok: false, status: 500, error: 'insert_failed' };
    return { ok: true, id, row, deduped: false };
  }

  get(id: string): Promise<TRow | null> {
    return this.store.getById(id);
  }

  list(query?: unknown): Promise<TRow[]> {
    return this.store.list(query);
  }

  /** Unlist a listing, then GC its content-addressed blob iff now unreferenced. */
  async unlist(id: string, actor: PrincipalRef, reason = 'by_publisher'): Promise<UnlistResult> {
    const row = await this.store.getById(id);
    if (!row) return { ok: false, status: 404, error: 'not_found' };
    if (this.policies.isUnlisted(row)) return { ok: true, id, alreadyUnlisted: true };

    if (this.policies.authorizeUnlist) {
      const allowed = await this.policies.authorizeUnlist(row, actor);
      if (!allowed) return { ok: false, status: 403, error: 'forbidden' };
    }

    const now = this.nowMs();
    await this.store.markUnlisted(id, reason, now);

    // Refcounted blob GC: drop the bytes once no live listing references them.
    let blobCollected = false;
    const { blobStore } = this.options;
    const blobKey = this.policies.blobKeyOf?.(row) ?? null;
    if (blobStore && blobKey && this.policies.isBlobStillReferenced) {
      const stillRef = this.policies.isBlobStillReferenced;
      blobCollected = await gcIfUnreferenced(blobStore, blobKey, () => stillRef(blobKey));
    }
    return { ok: true, id, blobCollected };
  }

  /** Claim ownership of a listing (gated by the injected `authorizeClaim`). */
  async claim(id: string, claimant: PrincipalRef): Promise<ClaimResult<TRow>> {
    const row = await this.store.getById(id);
    if (!row) return { ok: false, status: 404, error: 'not_found' };
    if (this.policies.isUnlisted(row)) return { ok: false, status: 410, error: 'unlisted' };
    if (this.policies.isClaimed?.(row)) return { ok: false, status: 409, error: 'already_claimed' };

    if (this.policies.authorizeClaim) {
      const allowed = await this.policies.authorizeClaim(row, claimant);
      if (!allowed) return { ok: false, status: 403, error: 'insufficient_permission' };
    }

    const now = this.nowMs();
    await this.store.setClaim(id, claimant, now);
    const updated = await this.store.getById(id);
    return { ok: true, id, row: updated ?? row };
  }
}
