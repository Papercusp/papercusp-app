/**
 * Admission sources: the one extension seam for turning DATA into WORK
 * (enterprise-data-sources-2026-10-01 P-020 / D-004, P-021 / D-028).
 *
 * A record (an ingested ticket, nature='record'), a chat message or a chat thread becomes a work
 * item only through `work_items:admit`, through a per-data-source admission rule or a person
 * promoting it by hand. Every source kind plugs in here as a resolver. The verb owns
 * idempotency, attribution (harness_shared.work_admissions) and the work-item mint, and the
 * resolver owns what only the source knows:
 *
 *   - the stable provider identity (`sourceKey`), which must survive retention and re-ingest.
 *     For a chat message that is `<dataSourceId>:<channelId>:<providerMessageId>`, never the
 *     chat_messages uuid.
 *   - the snapshot (title, body excerpt, permalink) persisted on the admission, so the work item
 *     outlives the source row (no FK to chat_messages).
 *   - visibility. A person admission is refused when that person cannot see the source. A rule
 *     admission is refused when the source lies outside the rule's data source.
 *   - covering keys (`coveredBy`). A message whose thread is already admitted resolves to the
 *     thread's admission rather than minting a second work item. The resolver DECLARES the keys,
 *     and the verb looks them all up in one query, so idempotency lives in one place.
 *   - field authority, and an optional write-back. Write-back follows slack-flagship.ts: the
 *     public verb carries only an internal id, and the resolver resolves the external
 *     coordinates and credential server-side from the durable admission, so a caller can never
 *     redirect a write.
 *
 * There is one admission path. A new source kind registers a resolver here; it never adds a
 * parallel verb or table.
 */
import type postgres from 'postgres';
import { pinModuleState } from '@papercusp/module-singleton';

export type AdmissionDb = postgres.Sql | postgres.TransactionSql;

/** Built-in source kinds. `record` ships with P-020; the chat kinds ship with P-021. */
export type BuiltinAdmissionSourceKind = 'record' | 'chat-message' | 'chat-thread';
export type AdmissionSourceKind = BuiltinAdmissionSourceKind | (string & {});

/**
 * Who admitted: a person promoting by hand, or a per-data-source rule.
 *
 * `actorId` is the coord identity recorded as `admitted_by`. `principalUserId` is the local
 * user (harness_shared.users.id) behind the call, when the verb could resolve one; resolvers
 * that check the person's visibility of the source (chat channels, P-021) read it. A person
 * admission without it is treated as having no personal or organization visibility.
 */
export type Admitter =
  | { via: 'person'; actorId: string; principalUserId?: string }
  | { via: 'rule'; ruleId: string; dataSourceId: string };

export interface AdmissionResolveContext {
  db: AdmissionDb;
  workspaceId: string;
  harness: string;
  admitter: Admitter;
}

/**
 * Which side owns each field. The external system owns the fields it authors (for a ticket:
 * title, description, assignee), and Papercusp owns agent-side state (status, claim,
 * checkpoint, completion). A Papercusp edit never overwrites an external-owned field, and a
 * re-sync never overwrites a Papercusp-owned one.
 */
export interface FieldAuthority {
  external: readonly string[];
  papercusp: readonly string[];
}

export const DEFAULT_FIELD_AUTHORITY: FieldAuthority = Object.freeze({
  external: Object.freeze(['title', 'description', 'assignee']),
  papercusp: Object.freeze(['status', 'claim', 'checkpoint', 'completion', 'priority']),
});

/** A (kind, key) pair identifying one admissible source. */
export interface AdmissionSourceIdentity {
  kind: AdmissionSourceKind;
  key: string;
}

export interface ResolvedAdmissionSource {
  /** The data source the item came from, or null for a source with none. */
  dataSourceId: string | null;
  /** Stable provider identity. Unique per (workspace, kind) and stable across re-ingest. */
  sourceKey: string;
  /** Snapshot title for the minted work item. */
  title: string;
  /** Snapshot body excerpt for the minted work item. */
  body: string;
  permalink?: string | null;
  /**
   * The record's own work_items id when the source is a record row (nature='record'). The minted
   * work item links to it with the existing rel 'about' (D-030 point 5).
   */
  recordWorkItemId?: string | null;
  /** Provider-shaped snapshot persisted to work_admissions.source_ref. JSON-serialisable. */
  sourceRef: Record<string, unknown>;
  fieldAuthority?: FieldAuthority;
  /**
   * Other sources whose EXISTING admission already covers this one, for example the thread of a
   * chat message. The verb returns the first covering admission it finds (reason 'covered')
   * instead of minting.
   */
  coveredBy?: readonly AdmissionSourceIdentity[];
}

/** A resolver's typed refusal. The verb surfaces `code` verbatim and mints nothing. */
export interface AdmissionRefusal {
  refused: true;
  /** For example 'source_not_found', 'source_deleted', 'not_visible', 'outside_rule_scope'. */
  code: string;
  message: string;
}

export function isAdmissionRefusal(x: unknown): x is AdmissionRefusal {
  return Boolean(x) && typeof x === 'object' && (x as { refused?: unknown }).refused === true;
}

/** One admission row, as the verb persisted it. */
export interface AdmissionRow {
  id: string;
  workspaceId: string;
  workItemId: string;
  dataSourceId: string | null;
  sourceKind: AdmissionSourceKind;
  sourceKey: string;
  sourceRef: Record<string, unknown>;
  admittedVia: 'person' | 'rule';
  admittedBy: string;
  ruleId: string | null;
  createdAt: string;
}

export interface AdmissionWriteBackInput {
  db: AdmissionDb;
  admission: AdmissionRow;
  /** Plain text to write to the source, for example a status note. Length is bounded by the verb. */
  text: string;
}

export interface AdmissionWriteBackResult {
  posted: boolean;
  alreadyPosted?: boolean;
  /** Provider-side id or permalink of the written object. */
  externalRef?: string | null;
  /**
   * The provider's id for the change, spelled the way its own sync later reports it (its
   * nativeId). The verb ledgers it so the change is recognised as an echo when sync ingests it.
   */
  updateId?: string | null;
}

export interface AdmissionTransitionInput {
  db: AdmissionDb;
  admission: AdmissionRow;
  /** A canonical ticket workflow category (data-sources/ticket-vocabulary). */
  toCategory: string;
}

export interface AdmissionTransitionResult {
  /** False when the source was already in that category and the provider changed nothing. */
  transitioned: boolean;
  /** As on {@link AdmissionWriteBackResult.updateId}. */
  updateId?: string | null;
  externalRef?: string | null;
}

export interface AdmissionSourceResolver<Ref = unknown> {
  kind: AdmissionSourceKind;
  /**
   * Validates and normalises the caller's raw `source` object, minus its `kind`. Throw an Error
   * whose message starts `admission_source_invalid:` to reject the input.
   */
  parseRef(raw: Record<string, unknown>): Ref;
  /** Resolves the source to its identity and snapshot, or refuses. Never writes. */
  resolve(ctx: AdmissionResolveContext, ref: Ref): Promise<ResolvedAdmissionSource | AdmissionRefusal>;
  /** Optional write-back to the source through its capability (server-side coordinates only). */
  writeBack?(input: AdmissionWriteBackInput): Promise<AdmissionWriteBackResult>;
  /**
   * Optional move of the source object to a workflow category, through its capability. Only the
   * status moves: fields the source owns (title, description, assignee) are never sent.
   */
  transition?(input: AdmissionTransitionInput): Promise<AdmissionTransitionResult>;
}

interface RegistryState {
  resolvers: Map<string, AdmissionSourceResolver<unknown>>;
}

const state = pinModuleState<RegistryState>('@papercusp/operator-core.work-admission.sources', () => ({
  resolvers: new Map(),
}));

/**
 * Registers a resolver for a source kind. Registering the same kind twice with a DIFFERENT
 * resolver throws. A second registration of the identical object is a no-op (module re-import).
 */
export function registerAdmissionSource<Ref>(resolver: AdmissionSourceResolver<Ref>): void {
  const kind = String(resolver.kind ?? '').trim();
  if (!kind) throw new Error('admission_source_kind_required');
  const existing = state.resolvers.get(kind);
  if (existing && existing !== (resolver as AdmissionSourceResolver<unknown>)) {
    throw new Error(`admission_source_already_registered:${kind}`);
  }
  state.resolvers.set(kind, resolver as AdmissionSourceResolver<unknown>);
}

export function getAdmissionSource(kind: string): AdmissionSourceResolver<unknown> | undefined {
  return state.resolvers.get(kind);
}

export function listAdmissionSourceKinds(): string[] {
  return [...state.resolvers.keys()].sort();
}

/** Test-only: drop one registration so a test can register a fake. */
export function unregisterAdmissionSourceForTest(kind: string): void {
  state.resolvers.delete(kind);
}
