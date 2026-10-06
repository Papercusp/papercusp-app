/**
 * The ONE place a canonical platform row becomes an app batch row.
 *
 * P-011 requires push delivery and the P-005 reconcile sweep to send the SAME
 * shape — "a separate push-only payload shape is how the two silently diverge".
 * They have different INPUTS (push holds a freshly normalized trigger event;
 * reconcile reads a stored `documents` row), so sharing a mapper only
 * works if both first reduce to a common shape. They do:
 *
 *   push:      NormalizedExternalEvent --personalDocumentFromExternalEvent-->  \
 *                                                                              ProducerSourceRecord --> app row
 *   reconcile: documents row ------------------------------------->  /
 *
 * That works because the vault sink stores the normalized payload VERBATIM as
 * `metadata`, so the reconcile path reads back exactly what the push path held.
 * `appRowsAgree` in the tests asserts this equality rather than trusting it.
 *
 * ⚠ CROSS-REPO CONTRACT. The apps' zod schemas live in their OWN repos
 * (@email/contracts, @calendar/contracts) and the platform cannot import them,
 * so the shapes below are a second copy of a contract this package cannot
 * typecheck against. Two things keep that honest, and neither is a comment:
 *   1. Both app schemas are `.passthrough()` with almost everything optional,
 *      so this mapper stays deliberately PASS-THROUGH — it renames as little as
 *      possible instead of re-deriving fields the provider already normalized.
 *      Less restatement, less to drift.
 *   2. The receiving app validates and answers 400 on a bad batch. P-008 is the
 *      item that asserts on the RECEIVING end; until it lands, a shape error
 *      surfaces as a failed delivery, which P-007 makes visible.
 */
import type { ProducerApp } from './owner-mapping';

/**
 * The common shape both producer paths reduce to. Satisfied by
 * `PersonalDocumentInput` (push, pre-write) and by a stored `documents`
 * row (reconcile, post-read).
 */
export interface ProducerSourceRecord {
  source: string;
  kind: string;
  /**
   * Canonical datatype registry id — the ONLY routing key (D-010). Stamped at
   * ingestion and stored as documents.datatype_id, so push and reconcile route
   * identically and a non-Google provider's records reach the same app.
   */
  datatypeId?: string | null;
  /** Server-owned provider provenance, retained separately from payload metadata. */
  sourceId?: string | null;
  providerAccountId?: string | null;
  externalId?: string | null;
  occurredAt?: string | Date | null;
  title?: string | null;
  text?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** Which app consumes each canonical datatype (D-010). */
const APP_BY_DATATYPE: Readonly<Record<string, ProducerApp>> = {
  'email-message': 'email',
  'calendar-event': 'calendar',
};

/** The canonical datatype each app consumes; reconcile/status select on it. */
export const DATATYPE_FOR_APP: Readonly<Record<ProducerApp, string>> = {
  email: 'email-message',
  calendar: 'calendar-event',
};

export function appForDatatype(datatypeId: string | null | undefined): ProducerApp | null {
  const id = datatypeId?.trim();
  return id ? APP_BY_DATATYPE[id] ?? null : null;
}

/**
 * Stable app-row id: `<sourceId>:<nativeId>` whenever a source id exists, so
 * two sources reusing a native id stay distinct rows in the app (D-010).
 */
export function appRowId(nativeId: string, sourceId?: string | null): string {
  const sid = sourceId?.trim();
  return sid ? `${sid}:${nativeId}` : nativeId;
}

/**
 * The sync STREAM the platform producer writes to, for every app (D-023 §2).
 *
 * It names the stream, not a provider: one producer batch can carry rows from
 * several sources (a Gmail and an Outlook mailbox side by side), and each row
 * already names its own source through `sourceId` / `mailbox.sourceId`. A
 * provider-named ref here would mislabel every other provider's rows and give
 * the app a cursor per provider name instead of per producer.
 */
export const APP_SYNC_SOURCE_REF = 'papercusp-vault';

function isoTime(value: string | Date | null | undefined): string | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function metadataOf(record: ProducerSourceRecord): Record<string, unknown> {
  const meta = record.metadata;
  return meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {};
}

/**
 * Map one canonical platform record to its app's batch row.
 *
 * Returns null when the record does not belong to a producer app — the caller
 * skips it rather than inventing a destination. Throws only when the record IS
 * deliverable but structurally unusable (no external id), because an app row
 * without a stable id would break the idempotent upsert both apps rely on.
 */
export function appRowFromSourceRecord(
  record: ProducerSourceRecord,
): { app: ProducerApp; row: Record<string, unknown> } | null {
  const app = appForDatatype(record.datatypeId);
  if (!app) return null;

  const nativeId = record.externalId?.trim();
  if (!nativeId) {
    throw new Error(`app_row_external_id_required:${record.datatypeId}:${record.kind}`);
  }
  const id = appRowId(nativeId, record.sourceId);

  const metadata = metadataOf(record);
  const occurredAt = isoTime(record.occurredAt);

  if (app === 'email') {
    // The app keys messages by `id` and upserts, so `id` is the idempotency
    // key. Everything else the provider normalized rides through untouched;
    // title/text only FILL IN when the payload lacks the field.
    const row: Record<string, unknown> = { ...metadata, id, nativeId };
    // Provider provenance is authoritative and arrives on the stored
    // documents columns as well as on live events. Preserve it in the
    // app row as an explicit mailbox object so the email app never has to infer
    // an account from recipients when a source row already names one.
    // Only the normalized record columns are trusted for connection identity.
    // A provider payload may contain similarly named fields, but those are
    // content and must not be promoted into account provenance by this mapper.
    const sourceId = record.sourceId?.trim() || undefined;
    const providerAccountId = record.providerAccountId?.trim() || undefined;
    const suppliedMailbox = metadata.mailbox && typeof metadata.mailbox === 'object' && !Array.isArray(metadata.mailbox)
      ? metadata.mailbox as Record<string, unknown>
      : null;
    if (!suppliedMailbox && (sourceId || providerAccountId)) {
      row.mailbox = {
        key: sourceId ? `source:${sourceId}` : `provider:${providerAccountId}`,
        ...(sourceId ? { sourceId } : {}),
        ...(providerAccountId ? { providerAccountId } : {}),
        ...(providerAccountId?.includes('@') ? { address: providerAccountId } : {}),
        provenance: 'explicit',
      };
    } else if (suppliedMailbox && (sourceId || providerAccountId)) {
      row.mailbox = {
        ...suppliedMailbox,
        ...(sourceId && suppliedMailbox.sourceId === undefined ? { sourceId } : {}),
        ...(providerAccountId && suppliedMailbox.providerAccountId === undefined ? { providerAccountId } : {}),
        ...(suppliedMailbox.key === undefined
          ? { key: sourceId ? `source:${sourceId}` : `provider:${providerAccountId}` }
          : {}),
        provenance: suppliedMailbox.provenance ?? 'explicit',
      };
    }
    if (row.subject === undefined && record.title) row.subject = record.title;
    if (row.text === undefined && record.text) row.text = record.text;
    if (row.occurredAt === undefined && occurredAt) row.occurredAt = occurredAt;
    return { app, row };
  }

  // Calendar. `summary`/`description` are the event's title/body; the app's
  // schema defaults calendarId to 'primary' and its preprocess step already
  // accepts the string `organizer` and string attendees this payload carries,
  // so no reshaping is done here on purpose.
  const row: Record<string, unknown> = { ...metadata, id, nativeId };
  const calendarSourceId = record.sourceId?.trim();
  if (calendarSourceId && row.sourceId === undefined) row.sourceId = calendarSourceId;
  if (row.summary === undefined && record.title) row.summary = record.title;
  if (row.description === undefined && record.text) row.description = record.text;
  return { app, row };
}

export interface AppSyncBatch {
  app: ProducerApp;
  /** The exact JSON body POSTed to the app's `/api/sync`. */
  body: Record<string, unknown>;
  rowCount: number;
}

/**
 * Assemble the batch body for one app.
 *
 * Both apps accept `{ <rows>, contacts, cursor?, sourceRef? }` under a STRICT
 * schema, so only keys the app declares may appear. Push sends one row and
 * reconcile sends many through this same function — that is what makes the
 * single-row push a genuine batch rather than a parallel format.
 */
export function buildAppSyncBatch(
  app: ProducerApp,
  rows: Record<string, unknown>[],
  options: { cursor?: string | null } = {},
): AppSyncBatch {
  const body: Record<string, unknown> = app === 'email'
    ? { messages: rows, contacts: [] }
    : { events: rows, calendars: [], contacts: [] };
  body.sourceRef = APP_SYNC_SOURCE_REF;
  const cursor = options.cursor?.trim();
  if (cursor) body.cursor = cursor;
  return { app, body, rowCount: rows.length };
}
