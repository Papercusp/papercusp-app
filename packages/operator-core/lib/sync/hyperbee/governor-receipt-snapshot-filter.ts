/**
 * P-530 — serializable policy for removing retired resource-governor receipts
 * from an own-log snapshot without inventing deletes in the source log.
 *
 * The live-key census is taken after `maxSourceIndexExclusive` is captured. A
 * row below that boundary is therefore safe to omit only when it was absent
 * from PostgreSQL at the census. Anything appended at or beyond the boundary
 * is retained, which closes the insert-after-census race without a database
 * lookup per folded row.
 */
import type { OpAAD } from './hive-epoch-crypto';
import { buildOpAAD } from './hive-epoch-serving';

export const ENGINEER_ISSUES_SNAPSHOT_TABLE = 'engineer-issues';

/** Cheap pre-parse test on opened plaintext: a receipt's JSON always names this key. */
const RESOURCE_GOVERNOR_KEY_BYTES = Buffer.from('"resource_governor"', 'utf8');

export interface GovernorReceiptSnapshotFilter {
  /** Own-log length captured immediately before the PostgreSQL census. */
  maxSourceIndexExclusive: number;
  /** Qualified `<storage-harness>/<WI-or-EI-id>` rows still present in work_items. */
  liveQualifiedKeys: readonly string[];
  /**
   * D-024 — the hive-epoch keys that open this log's `{__rekey}` envelopes. Own-log
   * engineer-issues rows are stored encrypted, so the receipt shape is only visible in
   * the plaintext. Absent (or a row whose epoch has no key here) ⇒ that row is KEPT.
   */
  envelopeKeys?: GovernorReceiptEnvelopeKeys;
}

export interface GovernorReceiptEnvelopeKeys {
  /** The AAD `potId` — the Hive home slug the rows were sealed under. */
  potId: string;
  keys: ReadonlyArray<{ epoch: number; key: Uint8Array }>;
}

export interface GovernorReceiptSnapshotContext {
  table: string;
  hbKey: string;
  /** Physical source-log index of the op (or snapshot chunk) being folded. */
  sourceIndex?: number;
  /** The epoch the row's `{__rekey}` value was sealed under (part of its AAD). */
  epoch?: number;
  /** The row's ORIGINAL `author_pubkey` (part of its AAD opId). */
  authorPubkey?: string;
}

/**
 * D-024 — opens a row's `{__rekey}` envelope to plaintext bytes, or null when the value
 * is not an envelope, no key covers its epoch, or authentication fails.
 */
export type GovernorReceiptEnvelopeOpener = (
  value: unknown,
  context: GovernorReceiptSnapshotContext,
) => Uint8Array | null;

/**
 * Build a {@link GovernorReceiptEnvelopeOpener} from the filter's serializable keys and
 * a synchronous AEAD open (`openOpCiphertext` bound to a loaded sodium). The AAD identity
 * is the one read-merge.ts uses for a snapshot row: `(table, hbKey, author_pubkey ?? '')`.
 * `onUnopened` counts envelopes that could not be opened — no keys or no `open` at all,
 * no key for the row's epoch, or an auth failure — so a filter that cannot see the
 * receipts reports it instead of reading as "no receipts".
 */
export function governorReceiptEnvelopeOpener(
  envelopeKeys: GovernorReceiptEnvelopeKeys | undefined,
  open: ((ciphertext: Uint8Array, key: Uint8Array, ad: OpAAD) => Uint8Array) | undefined,
  onUnopened: () => void = () => {},
): GovernorReceiptEnvelopeOpener {
  const byEpoch = new Map((envelopeKeys?.keys ?? []).map((k) => [k.epoch, k.key]));
  return (value, context) => {
    const envelope = record(value)?.__rekey;
    if (typeof envelope !== 'string') return null;
    const key = context.epoch == null ? undefined : byEpoch.get(context.epoch);
    if (!key || !envelopeKeys || !open) {
      onUnopened();
      return null;
    }
    try {
      return open(
        Buffer.from(envelope, 'base64'),
        key,
        buildOpAAD(envelopeKeys.potId, context.epoch!, {
          tableTag: context.table,
          rowKey: context.hbKey,
          authorPubkey: context.authorPubkey ?? '',
        }),
      );
    } catch {
      onUnopened();
      return null;
    }
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** True only for the retired work_items-backed governor receipt wire shape. */
export function isLegacyGovernorReceiptSnapshotValue(value: unknown): boolean {
  const row = record(value);
  const payload = record(row?.payload);
  return record(payload?.resource_governor) !== null;
}

/**
 * Resolve a pre-829 bare engineer-issue key only when the authenticated row value
 * proves its physical target. The scope field drives the projection write; the
 * separate harness_slug field is only the federation routing slug and may name a
 * different harness. Operator rows do not carry enough physical identity here.
 */
function qualifiedKeyForBareEngineerIssue(value: unknown, hbKey: string): string | null {
  const row = record(value);
  if (!row || !hbKey || row.issue_id !== hbKey || typeof row.scope !== 'string') return null;
  if (!row.scope.startsWith('harness:')) return null;
  const storageHarnessSlug = row.scope.slice('harness:'.length);
  if (!storageHarnessSlug || storageHarnessSlug.includes('/')) return null;
  if (
    row.storage_harness_slug !== undefined &&
    (typeof row.storage_harness_slug !== 'string' ||
      !row.storage_harness_slug ||
      row.storage_harness_slug !== storageHarnessSlug)
  ) {
    return null;
  }
  return `${storageHarnessSlug}/${hbKey}`;
}

/**
 * Fail-safe drop decision. Bare legacy keys, malformed values, rows without a
 * measured source index, post-census appends, non-receipts, currently-live
 * receipt keys, and envelopes that cannot be opened are all retained.
 *
 * The cheap key checks run first: only a row that survives them costs an AEAD open
 * (D-024 measured ~9 us per open and ~10 us per receipt parse on the tower).
 */
export function shouldDropGovernorReceiptSnapshotRow(
  value: unknown,
  context: GovernorReceiptSnapshotContext,
  filter: GovernorReceiptSnapshotFilter,
  liveQualifiedKeys: ReadonlySet<string> = new Set(filter.liveQualifiedKeys),
  openEnvelope?: GovernorReceiptEnvelopeOpener,
): boolean {
  if (context.table !== ENGINEER_ISSUES_SNAPSHOT_TABLE) return false;
  if (!Number.isSafeInteger(context.sourceIndex) || context.sourceIndex! < 0) return false;
  if (context.sourceIndex! >= filter.maxSourceIndexExclusive) return false;
  const qualified = context.hbKey.indexOf('/') > 0;
  // Current qualified rows need no decrypt. A bare alias must be opened first
  // because its value carries the only available physical-scope proof.
  if (qualified && liveQualifiedKeys.has(context.hbKey)) return false;

  let receiptValue = value;
  if (!isLegacyGovernorReceiptSnapshotValue(receiptValue)) {
    // D-024: own-log content rows are hive-epoch envelopes; judge authenticated plaintext.
    const plaintext = openEnvelope?.(value, context);
    if (!plaintext) return false;
    const bytes = Buffer.isBuffer(plaintext)
      ? plaintext
      : Buffer.from(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength);
    if (bytes.indexOf(RESOURCE_GOVERNOR_KEY_BYTES) < 0) return false;
    try {
      receiptValue = JSON.parse(bytes.toString('utf8'));
    } catch {
      return false;
    }
    if (!isLegacyGovernorReceiptSnapshotValue(receiptValue)) return false;
  }

  const physicalKey = qualified
    ? context.hbKey
    : qualifiedKeyForBareEngineerIssue(receiptValue, context.hbKey);
  if (!physicalKey || liveQualifiedKeys.has(physicalKey)) return false;
  return true;
}
