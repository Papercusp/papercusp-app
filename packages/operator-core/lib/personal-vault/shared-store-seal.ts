/**
 * Reader-set labels — sealing what a restricted session writes to SHARED WORK
 * STORES. Plan personal-data-reader-set-labels-2026-10-01 P-012 (WI-10005520), D-006.
 *
 * coord-seal.ts seals coord envelopes. The same leak exists in every other store
 * a peer can read: a work-item comment or checkpoint, a fact, a harness/hive
 * memory. While the writer holds an active disclosure, the authored text moves
 * to personal_sealed_contents with a snapshot of the writer's labels, and the
 * shared row keeps only a stub. `personal:open-sealed { store, ref }` opens it
 * through openSealedContent, which labels the opener in the same transaction.
 *
 * Owner-scoped (user) memory is never sealed: only the owner reads it, and the
 * owner is always a permitted reader.
 *
 * Fail closed: a ledger read or seal write that fails refuses the write
 * (disclosure_ledger_unavailable) rather than persisting the text in the clear.
 */
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { DisclosureRefused } from './disclosure-ledger';
import { openSealedForOwner, snapshotActiveLabels, storeSealedContent } from './sealed-contents';

type Db = postgres.Sql | postgres.TransactionSql;

/** The shared stores P-012 seals, as recorded in personal_sealed_contents.store. */
export const SHARED_SEAL_STORES = ['work-item-comment', 'work-item-checkpoint', 'fact', 'memory'] as const;
export type SharedSealStore = (typeof SHARED_SEAL_STORES)[number];

export function isSharedSealStore(value: string): value is SharedSealStore {
  return (SHARED_SEAL_STORES as readonly string[]).includes(value);
}

export interface SharedSealParams {
  workspaceId: string | null | undefined;
  /** The agent identity that authored the text; null/blank never seals. */
  writerOwnerId: string | null | undefined;
  store: SharedSealStore;
  text: string;
  /** Pre-chosen ref (e.g. a memory id). Defaults to a fresh uuid. */
  ref?: string;
  /** Non-authored locators saved beside the text (work-item id, fact key, …). */
  context?: Record<string, unknown>;
  /**
   * Other AUTHORED values of the same row (a fact's settledBy, recheck, claim,
   * sourceRef). They are sealed with the text in one sealed row, and the caller
   * drops them from the shared row when the result is sealed (WI-10005549, R-8).
   * Null/undefined entries are omitted.
   */
  fields?: Record<string, unknown>;
}

/** Placeholder a shared row keeps for an authored field whose value was sealed with the text. */
export const SEALED_FIELD_STUB = '🔒 sealed with this row’s text';

function presentFields(fields: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!fields) return null;
  const present = Object.entries(fields).filter(([, value]) => value !== null && value !== undefined);
  return present.length ? Object.fromEntries(present) : null;
}

export type SharedSealResult =
  | { sealed: false; text: string }
  | { sealed: true; text: string; store: SharedSealStore; ref: string; labels: number };

/** The call that opens a sealed shared row. */
export function sharedSealOpenCall(store: SharedSealStore, ref: string): string {
  return `personal:open-sealed { store: '${store}', ref: '${ref}' }`;
}

/** What the shared row holds in place of the authored text. */
export function sharedSealStub(params: { store: SharedSealStore; ref: string; writerOwnerId: string; labels: number }): string {
  return (
    `🔒 Sealed: ${params.writerOwnerId} wrote this while holding restricted personal content ` +
    `(${params.labels} labelled document${params.labels === 1 ? '' : 's'}). ` +
    `${sharedSealOpenCall(params.store, params.ref)} opens it and limits your outbound sends the same way.`
  );
}

const SEALED_STUB_RE = /personal:open-sealed \{ store: '([a-z-]+)', ref: '([^']+)' \}/;

/** The store/ref a sealed stub points at, or null for ordinary text. */
export function sharedSealRefOf(text: unknown): { store: SharedSealStore; ref: string } | null {
  if (typeof text !== 'string' || !text.startsWith('🔒 Sealed: ')) return null;
  const match = SEALED_STUB_RE.exec(text);
  if (!match || !isSharedSealStore(match[1])) return null;
  return { store: match[1], ref: match[2] };
}

/**
 * The OWNER's view of sealed shared rows (WI-10005548). D-006 makes the owner a
 * permitted reader of everything, so an owner surface shows what was written in
 * place of the stub, and nobody is labelled. Returns stub → authored text for each
 * stub among `texts` whose sealed row is readable. A non-stub, or a stub whose
 * sealed row is gone, is absent from the map, so the caller keeps the shared row.
 *
 * OWNER SURFACES ONLY. An agent opens a stub with personal:open-sealed, which
 * labels it; calling this on an agent read path would launder the content.
 */
export async function openSharedSealsForOwner(
  sql: Db,
  params: { workspaceId: string | null | undefined; texts: Iterable<unknown> },
): Promise<Map<string, string>> {
  const opened = new Map<string, string>();
  const workspaceId = concreteWorkspace(params.workspaceId);
  if (!workspaceId) return opened;
  const refsByStore = new Map<SharedSealStore, Map<string, string>>();
  for (const text of params.texts) {
    const seal = sharedSealRefOf(text);
    if (!seal) continue;
    let refs = refsByStore.get(seal.store);
    if (!refs) refsByStore.set(seal.store, (refs = new Map()));
    refs.set(seal.ref, text as string);
  }
  for (const [store, refs] of refsByStore) {
    const contents = await openSealedForOwner(sql, { workspaceId, store, refs: [...refs.keys()] });
    for (const [ref, stub] of refs) {
      const text = contents.get(ref)?.text;
      if (typeof text === 'string') opened.set(stub, text);
    }
  }
  return opened;
}

/**
 * Replace each sealed stub in `rows` with its authored text, for an OWNER read
 * surface (see openSharedSealsForOwner). The read runs in its own
 * workspace-scoped transaction because personal_sealed_contents is under RLS, and
 * only when a stub is present, so an ordinary page costs no query. If the sealed
 * store cannot be read, the rows come back unchanged and the owner sees the stub:
 * a read surface degrades to what the shared row holds rather than failing.
 */
export async function unsealRowsForOwner<T>(
  rows: readonly T[],
  params: {
    workspaceId: string | null | undefined;
    textOf: (row: T) => unknown;
    withText: (row: T, text: string) => T;
  },
): Promise<T[]> {
  const workspaceId = concreteWorkspace(params.workspaceId);
  if (!workspaceId || !rows.some((row) => sharedSealRefOf(params.textOf(row)))) return [...rows];
  let opened: Map<string, string>;
  try {
    const { withWorkspace } = await import('@papercusp/db-org');
    opened = await withWorkspace(workspaceId, (tx) =>
      openSharedSealsForOwner(tx, { workspaceId, texts: rows.map(params.textOf) }),
    );
  } catch (error) {
    console.warn(
      `[shared-store-seal] owner unseal unavailable; showing stubs (${error instanceof Error ? error.message : String(error)})`,
    );
    return [...rows];
  }
  return rows.map((row) => {
    const text = params.textOf(row);
    const authored = typeof text === 'string' ? opened.get(text) : undefined;
    return authored === undefined ? row : params.withText(row, authored);
  });
}

function concreteWorkspace(workspaceId: string | null | undefined): string | null {
  const ws = workspaceId?.trim();
  return ws && ws !== '*' ? ws : null;
}

/** True when this write can never need a seal, so no ledger read is spent on it. */
function nothingToSeal(params: SharedSealParams): boolean {
  return (
    !params.writerOwnerId?.trim() ||
    !concreteWorkspace(params.workspaceId) ||
    (!params.text.trim() && !presentFields(params.fields))
  );
}

/**
 * Seal inside the CALLER's transaction, so the sealed row commits or rolls back
 * with the shared write it replaces. Errors propagate; the caller's transaction
 * aborts and nothing is written in the clear.
 */
export async function sealSharedTextInTx(tx: Db, params: SharedSealParams): Promise<SharedSealResult> {
  if (nothingToSeal(params)) return { sealed: false, text: params.text };
  const workspaceId = concreteWorkspace(params.workspaceId)!;
  const writerOwnerId = params.writerOwnerId!.trim();
  const labels = await snapshotActiveLabels(tx, { workspaceId, agentOwnerId: writerOwnerId });
  if (!labels.length) return { sealed: false, text: params.text };
  const ref = params.ref?.trim() || randomUUID();
  const fields = presentFields(params.fields);
  await storeSealedContent(tx, {
    workspaceId,
    store: params.store,
    ref,
    writerOwnerId,
    content: {
      text: params.text,
      ...(params.context ? { context: params.context } : {}),
      ...(fields ? { fields } : {}),
    },
    labels,
  });
  return {
    sealed: true,
    text: sharedSealStub({ store: params.store, ref, writerOwnerId, labels: labels.length }),
    store: params.store,
    ref,
    labels: labels.length,
  };
}

function ledgerUnavailable(params: SharedSealParams, error: unknown): DisclosureRefused {
  return new DisclosureRefused(
    'disclosure_ledger_unavailable',
    `could not check or seal ${params.writerOwnerId}'s ${params.store} write against its disclosure ledger (${error instanceof Error ? error.message : String(error)}); refusing rather than storing it unsealed`,
  );
}

/**
 * Seal in a short transaction of its own on `sql`, with app.workspace_id set so
 * the ledger read is correct under RLS whichever role the handle connects as.
 * Use it where the shared write happens later in another transaction (a
 * comment's thread post, a memory backend write). `sql` may be a thunk, so a
 * write that can never need a seal never touches the pool.
 */
export async function sealSharedText(
  sql: postgres.Sql | (() => postgres.Sql),
  params: SharedSealParams,
): Promise<SharedSealResult> {
  if (nothingToSeal(params)) return { sealed: false, text: params.text };
  const workspaceId = concreteWorkspace(params.workspaceId)!;
  try {
    const handle = typeof sql === 'function' && !('begin' in sql) ? (sql as () => postgres.Sql)() : (sql as postgres.Sql);
    return (await handle.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      return sealSharedTextInTx(tx, params);
    })) as SharedSealResult;
  } catch (error) {
    if (error instanceof DisclosureRefused) throw error;
    throw ledgerUnavailable(params, error);
  }
}

/** Wrap an in-transaction seal failure as the same fail-closed refusal. */
export async function sealSharedTextInTxOrRefuse(tx: Db, params: SharedSealParams): Promise<SharedSealResult> {
  try {
    return await sealSharedTextInTx(tx, params);
  } catch (error) {
    if (error instanceof DisclosureRefused) throw error;
    throw ledgerUnavailable(params, error);
  }
}
