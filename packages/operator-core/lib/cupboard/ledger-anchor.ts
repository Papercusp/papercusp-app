/**
 * Hourly anchoring of the hash-chained ledgers (agent-economy-flywheel-2026-08-30
 * P-041, D-021, D-024).
 *
 * Every link that P-040 writes to `ledger_chain_links` becomes one leaf of a
 * per-workspace, append-only RFC 9162 Merkle log. Once an hour the operator
 * publishes the log's root and size through an `AnchorBackend`. That is the
 * open-core hook: the hosted service uses EAS on Base (ledger-anchor-eas.ts),
 * and a self-hosted install points the same hook at its own key and chain.
 *
 * Anyone holding an inclusion bundle (`buildInclusionBundle`) can then check,
 * with no Papercusp credential or server, that an entry is covered by an
 * anchored root (`verifyInclusionBundle` plus an `AnchorReader` over a public
 * RPC). Each anchor also stores a consistency proof from the previous anchor's
 * size, so a verifier can confirm the log only appended between anchors.
 *
 * `checkAnchorCadence` raises an alert when the last completed hour has no
 * anchor. A failed publication writes nothing, so it surfaces as a missed hour.
 */
import { canonicalJson, entryDigest, linkHash, type ChainLink } from '@papercusp/hash-chain';
import { consistencyProof, inclusionProof, leafHash, rootHash, verifyInclusion } from '@papercusp/merkle-log';

export const ANCHOR_LEAF_DOMAIN = 'papercusp.ledger-anchor/v1/leaf\n';
export const ANCHOR_PROOF_FORMAT = 'papercusp.ledger-anchor-proof' as const;
export const HOUR_SECONDS = 3600;
/** How long after the hour an anchor may still be in flight before the hour counts as missed. */
export const DEFAULT_ANCHOR_GRACE_SECONDS = 20 * 60;

const HEX64 = /^[0-9a-f]{64}$/;

/** One leaf of the anchor log: a chain link, identified by stream and position. */
export interface AnchorLeaf {
  readonly streamId: string;
  readonly seq: number;
  readonly entryHash: string;
}

export interface StoredAnchorLeaf extends AnchorLeaf {
  readonly leafIndex: number;
  readonly leafHash: string;
}

/** The leaf hash: domain-tagged canonical JSON of the link identity. */
export function anchorLeafHash(leaf: AnchorLeaf): string {
  if (!HEX64.test(leaf.entryHash)) throw new Error('anchorLeafHash: entryHash must be 64 lowercase hex characters');
  return leafHash(ANCHOR_LEAF_DOMAIN + canonicalJson({ entryHash: leaf.entryHash, seq: leaf.seq, streamId: leaf.streamId }));
}

/** What a backend publishes. Window bounds are unix seconds. */
export interface AnchorPublication {
  readonly logId: string;
  readonly logRoot: string;
  readonly treeSize: number;
  readonly windowStart: number;
  readonly windowEnd: number;
}

export interface AnchorReceipt {
  /** Backend kind, e.g. 'eas'. */
  readonly backend: string;
  readonly chainId: number | null;
  /** The backend's handle for the published record (an EAS attestation UID). */
  readonly ref: string;
  readonly txHash: string | null;
  readonly attester: string | null;
}

/** The open-core anchoring hook. */
export interface AnchorBackend {
  readonly kind: string;
  publish(publication: AnchorPublication): Promise<AnchorReceipt>;
}

/** What a reader recovers from public chain data for a published ref. */
export interface AnchoredRoot extends AnchorPublication {
  readonly attester: string | null;
  readonly revoked: boolean;
}

export interface AnchorReader {
  read(ref: string): Promise<AnchoredRoot | null>;
}

export interface StoredAnchor extends AnchorPublication, AnchorReceipt {
  readonly anchorSeq: number;
  /** The previous anchor's tree size; `consistencyProof` proves that log is a prefix of this one. */
  readonly consistencyFrom: number;
  readonly consistencyProof: readonly string[];
}

export interface LedgerAnchorStore {
  leaves(workspaceId: string): Promise<readonly StoredAnchorLeaf[]>;
  /** All-or-nothing append starting at `leaves[0].leafIndex`; a lost race reports `conflict`. */
  appendLeaves(workspaceId: string, leaves: readonly StoredAnchorLeaf[]): Promise<'ok' | 'conflict'>;
  anchors(workspaceId: string): Promise<readonly StoredAnchor[]>;
  recordAnchor(workspaceId: string, anchor: StoredAnchor): Promise<'ok' | 'conflict'>;
}

/** Source of every chain link in a workspace (the leaves the log must eventually hold). */
export interface AnchorLinkFeed {
  links(workspaceId: string): Promise<readonly AnchorLeaf[]>;
}

/**
 * D-027 §4: the primary feed's links plus each secondary's. A primary failure
 * fails the tick. A secondary failure is reported and skipped: its links join
 * at the next tick that reads them, which D-024 allows because a window promises
 * no completeness and leaves are never reordered. Two sources claiming one
 * stream id would collide on leaf identity, so that throws.
 */
export function unionAnchorLinkFeed(
  primary: AnchorLinkFeed,
  secondaries: readonly { readonly name: string; readonly feed: AnchorLinkFeed }[],
  onSecondaryError: (workspaceId: string, name: string, error: unknown) => void,
): AnchorLinkFeed {
  return {
    async links(workspaceId) {
      const all = [...(await primary.links(workspaceId))];
      const owner = new Map<string, string>();
      for (const l of all) owner.set(l.streamId, 'primary');
      for (const { name, feed } of secondaries) {
        let links: readonly AnchorLeaf[];
        try {
          links = await feed.links(workspaceId);
        } catch (error) {
          onSecondaryError(workspaceId, name, error);
          continue;
        }
        for (const l of links) {
          const prior = owner.get(l.streamId);
          if (prior !== undefined && prior !== name) {
            throw new Error(`unionAnchorLinkFeed: stream '${l.streamId}' is claimed by both ${prior} and ${name}`);
          }
          owner.set(l.streamId, name);
        }
        all.push(...links);
      }
      return all;
    },
  };
}

/** The completed hour that ends at or before `nowSeconds`. */
export function anchorWindow(nowSeconds: number): { readonly windowStart: number; readonly windowEnd: number } {
  const windowEnd = Math.floor(nowSeconds / HOUR_SECONDS) * HOUR_SECONDS;
  return { windowStart: windowEnd - HOUR_SECONDS, windowEnd };
}

const leafKey = (l: { streamId: string; seq: number }): string => `${l.streamId}\u0000${l.seq}`;

/** New links in deterministic order (stream, then position). */
export function pendingLeaves(existing: readonly StoredAnchorLeaf[], links: readonly AnchorLeaf[]): StoredAnchorLeaf[] {
  const seen = new Set(existing.map(leafKey));
  const fresh = links
    .filter((l) => !seen.has(leafKey(l)))
    .slice()
    .sort((a, b) => (a.streamId < b.streamId ? -1 : a.streamId > b.streamId ? 1 : a.seq - b.seq));
  return fresh.map((l, i) => ({
    streamId: l.streamId,
    seq: l.seq,
    entryHash: l.entryHash,
    leafIndex: existing.length + i,
    leafHash: anchorLeafHash(l),
  }));
}

export type AnchorTickResult =
  | { readonly status: 'anchored'; readonly anchor: StoredAnchor; readonly newLeaves: number }
  | { readonly status: 'already-anchored'; readonly anchor: StoredAnchor }
  | { readonly status: 'conflict'; readonly stage: 'leaves' | 'anchor' };

/**
 * One hourly pass: append every not-yet-logged link as a leaf, then publish the
 * root for the completed hour. An hour that is already anchored is a no-op, so
 * the tick is safe to repeat. After missed hours, one anchor covers the whole
 * gap (its window starts where the previous anchor ended).
 */
export async function runAnchorTick(input: {
  readonly workspaceId: string;
  readonly logId: string;
  readonly nowSeconds: number;
  readonly store: LedgerAnchorStore;
  readonly feed: AnchorLinkFeed;
  readonly backend: AnchorBackend;
}): Promise<AnchorTickResult> {
  const { workspaceId, store } = input;
  const window = anchorWindow(input.nowSeconds);
  const anchors = await store.anchors(workspaceId);
  const last = anchors.at(-1) ?? null;
  if (last && last.windowEnd >= window.windowEnd) return { status: 'already-anchored', anchor: last };

  const existing = await store.leaves(workspaceId);
  const fresh = pendingLeaves(existing, await input.feed.links(workspaceId));
  if (fresh.length > 0 && (await store.appendLeaves(workspaceId, fresh)) === 'conflict') {
    return { status: 'conflict', stage: 'leaves' };
  }
  const hashes = [...existing, ...fresh].map((l) => l.leafHash);
  const treeSize = hashes.length;
  const consistencyFrom = last?.treeSize ?? 0;
  const publication: AnchorPublication = {
    logId: input.logId,
    logRoot: rootHash(hashes),
    treeSize,
    windowStart: last ? last.windowEnd : window.windowStart,
    windowEnd: window.windowEnd,
  };
  const receipt = await input.backend.publish(publication);
  const anchor: StoredAnchor = {
    ...publication,
    ...receipt,
    anchorSeq: (last?.anchorSeq ?? -1) + 1,
    consistencyFrom,
    consistencyProof: consistencyProof(hashes, consistencyFrom, treeSize),
  };
  if ((await store.recordAnchor(workspaceId, anchor)) === 'conflict') return { status: 'conflict', stage: 'anchor' };
  return { status: 'anchored', anchor, newLeaves: fresh.length };
}

export interface MissedHourAlert {
  readonly workspaceId: string;
  readonly lastWindowEnd: number | null;
  readonly expectedWindowEnd: number;
  readonly hoursBehind: number;
}

/** Where a missed-hour alert goes (the operator files a deduplicated issue). */
export interface AnchorAlertSink {
  missedHour(alert: MissedHourAlert): Promise<void>;
}

export type CadenceVerdict =
  | { readonly status: 'on-time'; readonly lastWindowEnd: number }
  | ({ readonly status: 'missed' } & MissedHourAlert);

/** Pure: is the last completed hour (allowing `graceSeconds`) anchored? */
export function anchorCadence(input: {
  readonly workspaceId: string;
  readonly nowSeconds: number;
  readonly lastWindowEnd: number | null;
  readonly graceSeconds?: number;
}): CadenceVerdict {
  const grace = input.graceSeconds ?? DEFAULT_ANCHOR_GRACE_SECONDS;
  const expectedWindowEnd = anchorWindow(input.nowSeconds - grace).windowEnd;
  if (input.lastWindowEnd !== null && input.lastWindowEnd >= expectedWindowEnd) {
    return { status: 'on-time', lastWindowEnd: input.lastWindowEnd };
  }
  const hoursBehind =
    input.lastWindowEnd === null ? 1 : Math.max(1, Math.round((expectedWindowEnd - input.lastWindowEnd) / HOUR_SECONDS));
  return { status: 'missed', workspaceId: input.workspaceId, lastWindowEnd: input.lastWindowEnd, expectedWindowEnd, hoursBehind };
}

/** Read the anchors and alert when the last completed hour went unanchored. */
export async function checkAnchorCadence(input: {
  readonly workspaceId: string;
  readonly nowSeconds: number;
  readonly store: LedgerAnchorStore;
  readonly alert: AnchorAlertSink;
  readonly graceSeconds?: number;
}): Promise<CadenceVerdict> {
  const last = (await input.store.anchors(input.workspaceId)).at(-1) ?? null;
  const verdict = anchorCadence({
    workspaceId: input.workspaceId,
    nowSeconds: input.nowSeconds,
    lastWindowEnd: last?.windowEnd ?? null,
    ...(input.graceSeconds !== undefined ? { graceSeconds: input.graceSeconds } : {}),
  });
  if (verdict.status === 'missed') await input.alert.missedHour(verdict);
  return verdict;
}

/** A self-contained proof that one chain entry is covered by an anchored root. */
export interface AnchorInclusionBundle {
  readonly format: typeof ANCHOR_PROOF_FORMAT;
  readonly version: 1;
  readonly logId: string;
  readonly link: ChainLink;
  /** The entry itself; when present the verifier also checks it against `link.entryDigest`. */
  readonly entry?: unknown;
  readonly leafIndex: number;
  readonly treeSize: number;
  readonly logRoot: string;
  readonly proof: readonly string[];
  readonly anchor: AnchorReceipt & { readonly windowStart: number; readonly windowEnd: number };
}

/**
 * The bundle for a link, proven against the EARLIEST anchor that covers it (so
 * it also shows the entry existed by the end of that hour).
 */
export async function buildInclusionBundle(input: {
  readonly workspaceId: string;
  readonly link: ChainLink;
  readonly entry?: unknown;
  readonly store: LedgerAnchorStore;
}): Promise<AnchorInclusionBundle | { readonly error: 'not-in-log' | 'not-yet-anchored' }> {
  const leaves = await input.store.leaves(input.workspaceId);
  const leaf = leaves.find((l) => l.streamId === input.link.streamId && l.seq === input.link.seq);
  if (!leaf || leaf.entryHash !== input.link.entryHash) return { error: 'not-in-log' };
  const anchor = (await input.store.anchors(input.workspaceId)).find((a) => a.treeSize > leaf.leafIndex);
  if (!anchor) return { error: 'not-yet-anchored' };
  const hashes = leaves.map((l) => l.leafHash);
  return {
    format: ANCHOR_PROOF_FORMAT,
    version: 1,
    logId: anchor.logId,
    link: input.link,
    ...(input.entry !== undefined ? { entry: input.entry } : {}),
    leafIndex: leaf.leafIndex,
    treeSize: anchor.treeSize,
    logRoot: anchor.logRoot,
    proof: inclusionProof(hashes, leaf.leafIndex, anchor.treeSize),
    anchor: {
      backend: anchor.backend,
      chainId: anchor.chainId,
      ref: anchor.ref,
      txHash: anchor.txHash,
      attester: anchor.attester,
      windowStart: anchor.windowStart,
      windowEnd: anchor.windowEnd,
    },
  };
}

export type BundleVerdict =
  | { readonly ok: true; readonly anchoredWindowEnd: number; readonly attester: string | null }
  | {
      readonly ok: false;
      readonly reason:
        | 'malformed'
        | 'entry-mismatch'
        | 'link-mismatch'
        | 'not-included'
        | 'anchor-not-found'
        | 'anchor-revoked'
        | 'anchor-mismatch'
        | 'attester-mismatch';
    };

/**
 * Verify a bundle using only the bundle and an `AnchorReader` (public chain
 * data). Pin `expectedAttester` to the published anchor address; without it the
 * attester named in the bundle is checked against the chain record.
 */
export async function verifyInclusionBundle(
  bundle: AnchorInclusionBundle,
  reader: AnchorReader,
  opts: { readonly expectedAttester?: string; readonly expectedLogId?: string } = {},
): Promise<BundleVerdict> {
  if (bundle?.format !== ANCHOR_PROOF_FORMAT || bundle.version !== 1 || !bundle.link || !bundle.anchor?.ref) {
    return { ok: false, reason: 'malformed' };
  }
  const { link } = bundle;
  if (bundle.entry !== undefined && entryDigest(bundle.entry) !== link.entryDigest) return { ok: false, reason: 'entry-mismatch' };
  let recomputed: string;
  try {
    recomputed = linkHash(link);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (recomputed !== link.entryHash) return { ok: false, reason: 'link-mismatch' };
  const lh = anchorLeafHash({ streamId: link.streamId, seq: link.seq, entryHash: link.entryHash });
  if (!verifyInclusion({ leafHash: lh, index: bundle.leafIndex, treeSize: bundle.treeSize, proof: bundle.proof, root: bundle.logRoot })) {
    return { ok: false, reason: 'not-included' };
  }
  const anchored = await reader.read(bundle.anchor.ref);
  if (!anchored) return { ok: false, reason: 'anchor-not-found' };
  if (anchored.revoked) return { ok: false, reason: 'anchor-revoked' };
  const logId = opts.expectedLogId ?? bundle.logId;
  if (anchored.logRoot !== bundle.logRoot || anchored.treeSize !== bundle.treeSize || anchored.logId !== logId) {
    return { ok: false, reason: 'anchor-mismatch' };
  }
  const want = (opts.expectedAttester ?? bundle.anchor.attester)?.toLowerCase() ?? null;
  if (want !== null && anchored.attester?.toLowerCase() !== want) return { ok: false, reason: 'attester-mismatch' };
  return { ok: true, anchoredWindowEnd: anchored.windowEnd, attester: anchored.attester };
}

/** In-memory store (tests, dry runs). */
export function memoryLedgerAnchorStore(): LedgerAnchorStore {
  const leaves = new Map<string, StoredAnchorLeaf[]>();
  const anchors = new Map<string, StoredAnchor[]>();
  return {
    async leaves(ws) {
      return [...(leaves.get(ws) ?? [])];
    },
    async appendLeaves(ws, add) {
      const cur = leaves.get(ws) ?? [];
      if (add.length > 0 && add[0]!.leafIndex !== cur.length) return 'conflict';
      leaves.set(ws, [...cur, ...add]);
      return 'ok';
    },
    async anchors(ws) {
      return [...(anchors.get(ws) ?? [])];
    },
    async recordAnchor(ws, a) {
      const cur = anchors.get(ws) ?? [];
      if (a.anchorSeq !== cur.length) return 'conflict';
      anchors.set(ws, [...cur, a]);
      return 'ok';
    },
  };
}
