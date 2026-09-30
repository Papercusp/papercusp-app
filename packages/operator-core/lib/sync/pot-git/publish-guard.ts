/**
 * pot-git/publish-guard.ts — the OWN-NAMESPACE sibling of
 * foreign-mirror-quarantine.ts's admission checks (Phase 7 G-10,
 * p2p-git-live-activation-2026-07-09 / P-205).
 *
 * foreign-mirror-quarantine.ts judges OTHER people's objects arriving via the
 * foreign-workspace results channel. This module judges the DEVICE'S OWN new
 * objects right before they are exposed under its own namespace ref
 * (`refs/namespaces/<hex>/...`) for peers to fetch — the point P-202's
 * announce→fetch driver calls just before `buildSigrefs`/`buildScopeSigrefs`
 * signs a snapshot of the advancing namespace and announces it hive-wide.
 * There is no quarantine step here (the objects already live in the device's
 * own ODB) — this is a pure "would-be-safe-to-publish" judgment over the
 * (oldOid, newOid] range about to be exposed.
 *
 * Two independent gates, either one refuses the whole publish:
 *   - oversized blob (the sibling of run-git-sync.ts's `findOversizedDirtyFiles`
 *     / foreign-mirror-quarantine.ts's blob cap — a blob no peer should ever
 *     be asked to replicate, mirroring GitHub's own hard limit posture);
 *   - a secret (G-10, secrets-guard.ts) in any new TEXT blob.
 *
 * Fail-CLOSED like its siblings: any git failure judging the range refuses
 * the publish rather than letting an unjudged range through. Pure over the
 * `RunGit` seam (storage.ts) — unit-integration-tests against a real bare
 * repo, no mocked git.
 */
import { type RunGit, defaultRunGit, defaultRunGitStdin } from './storage';
import { type SecretFinding, describeSecretFindings } from './secrets-guard';
import { loadSecretsGuardPathExemptions, partitionExemptFindings } from './secrets-guard-exemptions';
import { exposedRefNegatives } from './namespace-genesis-baseline';
import {
  type BlobEntry,
  DEFAULT_SCAN_CHUNK_BYTES,
  scanTextBlobsChunked,
} from './chunked-blob-scan';

/** Default per-blob cap — matches GitHub's hard limit posture and
 *  foreign-mirror-quarantine's DEFAULT_MAX_BLOB_BYTES (the two "no one should
 *  ever replicate this" gates stay aligned). */
export const DEFAULT_MAX_PUBLISH_BLOB_BYTES = 100 * 1024 * 1024;
/** Default cap on total NEW bytes a single publish may introduce. */
export const DEFAULT_MAX_PUBLISH_TOTAL_BYTES = 500 * 1024 * 1024;
/** Default cap on NEW object count a single publish may introduce (flood control). */
export const DEFAULT_MAX_PUBLISH_NEW_OBJECTS = 50_000;
/**
 * WI-6254: PEAK-MEMORY budget for the G-10 secrets scan — how many bytes of
 * blob content may be resident at once.
 *
 * This is a different KIND of limit from the caps above, which is why it is a
 * separate knob rather than a reuse of `maxTotalNewBytes`. Those are VOLUME
 * gates: policy about how much a publish may introduce, and by design
 * `volumeGates: 'warn'` turns them off (see `volumeGates`). This one is a
 * RESOURCE bound on how the guard does its own work, so it must hold in BOTH
 * modes and can never be waived.
 *
 * Before this existed the scan materialised every text blob in the range into
 * one array simultaneously, so in 'warn' mode — exactly what the ref-announce
 * second-line guard passes — nothing bounded it at all. A range judged against
 * a wrong baseline (WI-6251: 7057 commits) drove the sidecar 2.35GB -> 3.67GB
 * into a FATAL heap OOM, crash frame `Builtins_StringSlowFlatten`. An OOM
 * inside a fail-CLOSED guard is a fail-OPEN in effect: the process dies, DBOS
 * restarts the fire at the same step, and git-sync wedges forever instead of
 * the guard returning a refusal.
 *
 * Note the ENFORCE path was never a real memory bound either — 500MB of UTF-8
 * becomes up to ~1GB of UTF-16 JS string, plus the scanner's working set.
 */
export const DEFAULT_PUBLISH_SCAN_CHUNK_BYTES = DEFAULT_SCAN_CHUNK_BYTES;

export interface PublishGuardCaps {
  maxBlobBytes?: number;
  maxTotalNewBytes?: number;
  maxNewObjects?: number;
  /** Peak bytes of blob content resident during the secrets scan
   *  ({@link DEFAULT_PUBLISH_SCAN_CHUNK_BYTES}). Bounds memory, never
   *  coverage: every text blob is still scanned, just not all at once. */
  scanChunkBytes?: number;
}

export interface PublishGuardInput {
  /** The bare pot-git repo (storage.ts's `hiveGitRepoPath`). */
  repoPath: string;
  /** The namespace's PREVIOUSLY published head (null on a device's first-ever
   *  publish — the whole history reachable from `toOid` is judged). */
  fromOid: string | null;
  /** The new head about to be published under the device's namespace. */
  toOid: string;
  caps?: PublishGuardCaps;
  runGit?: RunGit;
  /**
   * WI-5591: workspace whose runtime secrets-guard path exemptions
   * (harness_shared.secrets_guard_path_exemptions, migration 644) should be
   * consulted before a 'secrets' refusal is finalized — the no-restart escape
   * hatch for a false positive (see secrets-guard-exemptions.ts). Omitted ⇒
   * no runtime exemptions are consulted (only the static FIXTURE_FILES set
   * applies), preserving prior behavior for callers that don't pass it (e.g.
   * the existing unit/integration tests).
   */
  workspaceId?: string;
  /** Injectable for tests; defaults to the real DB-backed loader. */
  loadPathExemptions?: (workspaceId: string) => Promise<ReadonlySet<string>>;
  /**
   * WI-5738: how to treat the VOLUME gates (`total-over-cap`, `object-flood`).
   *
   * 'enforce' (default) — refuse, as always.
   *
   * 'warn' — record the breach in `volumeWarnings` but ADMIT the range. For a
   * SECOND-LINE guard re-judging content a first-line guard already admitted
   * commit-by-commit, the volume caps are pure double-jeopardy: the same bytes
   * get re-measured as one big range and re-refused, wedging the second guard
   * even though nothing unsafe is present. That is exactly how ref-announce
   * stayed stuck on 2026-07-20 *after* own-head-publish had been unwedged —
   * its baseline is sigrefs, so the manual namespace re-base never freed it.
   *
   * The HARD gates (`blob-over-cap`, `secrets`) are unaffected in both modes:
   * a secret leaving the machine is a real safety boundary, whereas a volume
   * cap is a courtesy rate-limit that receivers re-apply on their own side
   * anyway (foreign-mirror-quarantine.ts).
   */
  volumeGates?: 'enforce' | 'warn';
  /**
   * WI-10003528: the publishing device's own namespace key (lowercase hex).
   *
   * When set, objects reachable from the ALREADY-EXPOSED ref set are not
   * judged: another device's namespace, bootstrap-quarantine, or a
   * remote-tracking ref (EXPOSED_REF_GLOBS, with this device's own namespace
   * held out). That content has already left a machine, so refusing it here
   * un-exposes nothing and only wedges this device's egress. It is the same
   * exposure rule genesis already applies (deriveNamespaceGenesisBaseline),
   * now carried to every later publish instead of only the first.
   *
   * The set is a closed allow-list, so this can only ever judge LESS of what
   * is already public — never content that exists only under this device's
   * namespace or in a local ref. Unset keeps the strict (fromOid, toOid]
   * judgement.
   */
  selfNamespaceHex?: string | null;
}

/** The rev-list negatives for `input`'s judged range: `^fromOid`, then (WI-10003528)
 *  the already-exposed ref set when the caller named its own namespace. */
function rangeNegatives(input: Pick<PublishGuardInput, 'fromOid' | 'selfNamespaceHex'>): string[] {
  return [
    ...(input.fromOid ? [`^${input.fromOid}`] : []),
    ...(input.selfNamespaceHex ? exposedRefNegatives(input.selfNamespaceHex) : []),
  ];
}

export type PublishRefusalCode = 'blob-over-cap' | 'total-over-cap' | 'object-flood' | 'secrets' | 'error';

export interface PublishGuardResult {
  ok: boolean;
  refusalCode: PublishRefusalCode | null;
  newObjectCount: number;
  newTotalBytes: number;
  oversizeBlobs: { oid: string; path: string; bytes: number }[];
  secretFindings: SecretFinding[];
  /** Findings that WOULD have refused the publish but were suppressed by a
   *  runtime path exemption (WI-5591) — surfaced for audit/logging even
   *  though they no longer block. Empty when no exemption applied. */
  exemptedFindings: SecretFinding[];
  /** WI-5738: volume breaches ADMITTED because `volumeGates: 'warn'` was set.
   *  Non-empty means the range exceeded a volume cap but was let through by a
   *  second-line guard; the first-line guard already enforced it. */
  volumeWarnings: PublishRefusalCode[];
  errors: string[];
}

/**
 * The chunked-scan machinery lives in ./chunked-blob-scan so that this guard
 * and its untrusted-input sibling (foreign-mirror-quarantine, WI-6258) share
 * ONE byte-exact `cat-file --batch` frame parser instead of two copies.
 * Re-exported here because this module is where it was introduced (WI-6254)
 * and where its tests bind.
 */
export { partitionBlobsForScan } from './chunked-blob-scan';

/**
 * Judge the (fromOid, toOid] range about to be exposed under a device's own
 * namespace ref. Pure decision — the caller (P-202's publish driver) decides
 * what to do with a refusal (skip the publish tick, escalate, etc.); this
 * function never mutates refs.
 */
export async function checkPublishGuard(input: PublishGuardInput): Promise<PublishGuardResult> {
  const runGit = input.runGit ?? defaultRunGit;
  const caps = {
    maxBlobBytes: input.caps?.maxBlobBytes ?? DEFAULT_MAX_PUBLISH_BLOB_BYTES,
    maxTotalNewBytes: input.caps?.maxTotalNewBytes ?? DEFAULT_MAX_PUBLISH_TOTAL_BYTES,
    maxNewObjects: input.caps?.maxNewObjects ?? DEFAULT_MAX_PUBLISH_NEW_OBJECTS,
    scanChunkBytes: input.caps?.scanChunkBytes ?? DEFAULT_PUBLISH_SCAN_CHUNK_BYTES,
  };
  const res: PublishGuardResult = {
    ok: false,
    refusalCode: null,
    newObjectCount: 0,
    newTotalBytes: 0,
    oversizeBlobs: [],
    secretFindings: [],
    exemptedFindings: [],
    volumeWarnings: [],
    errors: [],
  };
  const warnVolume = input.volumeGates === 'warn';
  const refuse = (code: PublishRefusalCode, err?: string): PublishGuardResult => {
    if (err) res.errors.push(err);
    res.refusalCode = code;
    return res;
  };

  try {
    // 1. Enumerate NEW objects in (fromOid, toOid], minus anything already
    //    exposed when the caller named its own namespace (WI-10003528).
    const negatives = rangeNegatives(input);
    const list = await runGit(['rev-list', '--objects', input.toOid, ...negatives], input.repoPath);
    if (list.code !== 0) return refuse('error', `rev-list --objects failed: ${list.stderr.trim()}`);
    const entries = list.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const sp = l.indexOf(' ');
        return sp === -1 ? { oid: l, path: '' } : { oid: l.slice(0, sp), path: l.slice(sp + 1) };
      });
    res.newObjectCount = entries.length;
    if (entries.length > caps.maxNewObjects) {
      const msg = `${entries.length} new objects > cap ${caps.maxNewObjects}`;
      if (warnVolume) {
        res.volumeWarnings.push('object-flood');
        res.errors.push(`admitted despite object-flood (second-line guard): ${msg}`);
      } else {
        return refuse('object-flood', msg);
      }
    }
    if (entries.length === 0) {
      res.ok = true;
      return res; // nothing new to judge (e.g. a fast-forward with no new objects reachable)
    }

    // 2. Blob size caps via batch-check over the new set.
    const batch = await defaultRunGitStdin(
      ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)', '--buffer'],
      input.repoPath,
      entries.map((e) => e.oid).join('\n') + '\n',
    );
    if (batch.code !== 0) return refuse('error', `cat-file --batch-check failed: ${batch.stderr.trim()}`);
    const pathByOid = new Map(entries.map((e) => [e.oid, e.path] as const));
    const blobs: BlobEntry[] = [];
    // `--batch-check` output is the oid/type/size header lines only — no object
    // CONTENT — so it is pure ASCII and safe to decode. (`--batch`, which does
    // carry content, must stay a Buffer; see readTextBlobs.)
    for (const line of batch.stdout.toString('utf8').split('\n')) {
      const [oid, type, sizeS] = line.trim().split(/\s+/);
      if (!oid || !type) continue;
      const bytes = Number(sizeS ?? 0);
      res.newTotalBytes += Number.isFinite(bytes) ? bytes : 0;
      if (type === 'blob') {
        const path = pathByOid.get(oid) ?? '';
        blobs.push({ oid, path, bytes: Number.isFinite(bytes) ? bytes : 0 });
        if (bytes > caps.maxBlobBytes) {
          res.oversizeBlobs.push({ oid, path, bytes });
        }
      }
    }
    if (res.oversizeBlobs.length > 0) {
      return refuse(
        'blob-over-cap',
        res.oversizeBlobs
          .slice(0, 3)
          .map((b) => `${b.path || b.oid} is ${b.bytes} bytes (> ${caps.maxBlobBytes})`)
          .join('; '),
      );
    }
    if (res.newTotalBytes > caps.maxTotalNewBytes) {
      const msg = `${res.newTotalBytes} new bytes > cap ${caps.maxTotalNewBytes}`;
      if (warnVolume) {
        res.volumeWarnings.push('total-over-cap');
        res.errors.push(`admitted despite total-over-cap (second-line guard): ${msg}`);
      } else {
        return refuse('total-over-cap', msg);
      }
    }

    // 3. G-10 secrets scan over new TEXT blobs, read in BOUNDED chunks
    //    (WI-6254). Peak resident content is `scanChunkBytes`, not the whole
    //    range, and the read is one `cat-file --batch` per chunk rather than
    //    one `cat-file` process per blob. Coverage is unchanged: every text
    //    blob is still scanned, and `scanForSecrets` is a pure per-file
    //    map-concat, so scanning in ordered chunks yields exactly the findings
    //    (and the order) a single whole-range call would. Binary is skipped —
    //    the size caps above already own that class.
    // Fail-CLOSED, per this module's stated posture: a batch we could not read
    // means part of the range went unjudged. (The old per-blob loop swallowed
    // such a failure and carried on — a small fail-open hole; an individual
    // `missing` object is still tolerated, inside readTextBlobs.)
    const { findings, error: scanError } = await scanTextBlobsChunked(
      blobs,
      input.repoPath,
      caps.scanChunkBytes,
    );
    if (scanError) return refuse('error', scanError);
    res.secretFindings = findings;
    if (res.secretFindings.length > 0 && input.workspaceId) {
      // WI-5591: consult the runtime, no-restart exemption list before
      // finalizing a 'secrets' refusal — a false positive on an already
      // fail-closed-forever range can be cleared by an INSERT instead of a
      // code edit + bg-host restart. A path exempted here is moved to
      // exemptedFindings (kept for audit) rather than dropped silently.
      const load = input.loadPathExemptions ?? loadSecretsGuardPathExemptions;
      const exempt = await load(input.workspaceId);
      // WI-5738: matching goes through the SHARED partition helper, which also
      // understands `dir/` and `dir/**` prefix entries. Exact-only matching
      // made the escape hatch inapplicable to the accident class that
      // motivated it (one bad directory = thousands of paths).
      const { blocking, exempted } = partitionExemptFindings(res.secretFindings, exempt);
      res.secretFindings = blocking;
      res.exemptedFindings.push(...exempted);
    }
    if (res.secretFindings.length > 0) return refuse('secrets');

    res.ok = true;
    return res;
  } catch (e) {
    return refuse('error', e instanceof Error ? e.message : String(e));
  }
}

/** The volume gates — aggregate/rate concerns, satisfiable by publishing LESS.
 *  Contrast the hard gates (`blob-over-cap`, `secrets`), which no amount of
 *  range-splitting can satisfy because a single object is the problem. */
const VOLUME_REFUSALS: ReadonlySet<PublishRefusalCode> = new Set(['total-over-cap', 'object-flood']);

export function isVolumeRefusal(code: PublishRefusalCode | null): boolean {
  return code !== null && VOLUME_REFUSALS.has(code);
}

export interface IncrementalPublishResolution {
  /** The furthest sha in (fromOid, toOid] that is safe to publish. Equals
   *  `fromOid` when no progress is possible at all. */
  safeSha: string | null;
  /** True when `safeSha === toOid` — the whole range was admitted (fast path). */
  complete: boolean;
  /** A HARD refusal (oversized blob / secret / git error) at this commit.
   *  Everything before it is still safe and reflected in `safeSha`. */
  blocked: { commit: string; result: PublishGuardResult } | null;
  /** True when a VOLUME cap forced a partial advance — not an error, just a
   *  drain that continues next tick. */
  drained: boolean;
  /** A single commit that alone exceeds the volume caps and therefore cannot be
   *  split any further. It is published anyway (see the header) and named here
   *  so the health layer can say exactly what happened. */
  oversizedCommit: string | null;
  guardCalls: number;
  errors: string[];
}

/**
 * Resolve the furthest sha in (fromOid, toOid] that may be published, splitting
 * the range when a VOLUME cap refuses it.
 *
 * WI-5738 — the ratchet this exists to break. `checkPublishGuard` is a verdict
 * on a whole range, and every caller baselines that range on its own last
 * SUCCESS (own-head-publish's namespace ref, ref-announce's sigrefs). So a
 * refusal is TERMINAL by construction: the baseline can only advance through
 * the publish being refused, while each new commit makes the refused range
 * bigger. On 2026-07-20 a single accidental 2.26GB AppImage extraction put the
 * range over the 500MB total cap; the guard then refused every tick for five
 * days, and the total was still CLIMBING (2261MB → 2415MB) days later.
 * Deleting the files did nothing — the guard enumerates objects introduced
 * anywhere in the range, so the blobs stay counted while the commit that
 * introduced them is inside it.
 *
 * The fix distinguishes two kinds of refusal:
 *
 *   - VOLUME (`total-over-cap`, `object-flood`) is an aggregate/rate concern:
 *     "do not ask a peer to replicate this much at once". It is satisfiable by
 *     publishing LESS, so we binary-search the longest admissible prefix and
 *     publish that. The baseline advances, the remaining range shrinks, and the
 *     backlog drains over subsequent ticks instead of deadlocking.
 *
 *   - HARD (`blob-over-cap`, `secrets`) cannot be satisfied by splitting — one
 *     specific object is the problem — so those still refuse. But they now
 *     refuse AT A COMMIT, with everything before it published, which both keeps
 *     the plane moving and names the offender exactly.
 *
 * A single commit that alone busts the volume caps is published anyway: it
 * cannot be split, and refusing it forever is precisely the outage this
 * function removes. It is reported as `oversizedCommit` so the health layer can
 * raise it. Prevention for that case belongs at COMMIT time (a cumulative dirty
 * -bytes cap in git-sync), not as a terminal publish-time latch.
 *
 * Cost: the admitted fast path is ONE guard call, exactly as before. The split
 * path is O(log n) guard calls and only runs while something is already wedged.
 */
export async function resolveIncrementalPublishSha(input: PublishGuardInput): Promise<IncrementalPublishResolution> {
  const runGit = input.runGit ?? defaultRunGit;
  const res: IncrementalPublishResolution = {
    safeSha: input.fromOid,
    complete: false,
    blocked: null,
    drained: false,
    oversizedCommit: null,
    guardCalls: 0,
    errors: [],
  };

  const judge = async (to: string): Promise<PublishGuardResult> => {
    res.guardCalls += 1;
    return checkPublishGuard({ ...input, toOid: to });
  };

  // Fast path: the whole range is fine (the overwhelming majority of ticks).
  const whole = await judge(input.toOid);
  if (whole.ok) return { ...res, safeSha: input.toOid, complete: true };

  // Enumerate the range oldest-first so a prefix is always a valid publish
  // point. Cheap — commits only, no object walk.
  // Same negatives as the guard's object walk (WI-10003528): a prefix candidate
  // is never an already-exposed commit, so a split can only land on content
  // this device is the first to expose.
  const range = [input.toOid, ...rangeNegatives(input)];
  const revs = await runGit(['rev-list', '--reverse', ...range], input.repoPath);
  if (revs.code !== 0) {
    res.errors.push(`rev-list --reverse failed, cannot split range: ${revs.stderr.trim()}`);
    res.blocked = { commit: input.toOid, result: whole };
    return res;
  }
  const commits = revs.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  if (commits.length <= 1) {
    // Nothing to split. A volume-only refusal on a single indivisible commit is
    // published anyway rather than wedging the plane forever.
    if (isVolumeRefusal(whole.refusalCode) && commits.length === 1) {
      return { ...res, safeSha: input.toOid, complete: true, oversizedCommit: commits[0], drained: true };
    }
    res.blocked = { commit: commits[0] ?? input.toOid, result: whole };
    return res;
  }

  // Binary-search the longest admissible prefix. Cumulative object volume grows
  // monotonically along the range, so the predicate is monotone for the volume
  // gates; a hard refusal inside the prefix simply makes it look inadmissible,
  // which is safe (we publish less, never more).
  let lo = 0; // commits[0..lo] known-unknown
  let hi = commits.length - 1;
  let bestIdx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const verdict = await judge(commits[mid]);
    if (verdict.ok) {
      bestIdx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (bestIdx >= 0) {
    res.safeSha = commits[bestIdx];
    res.drained = true;
  }

  // Judge the very next commit to attribute the stall precisely.
  const nextIdx = bestIdx + 1;
  if (nextIdx < commits.length) {
    const nextVerdict = await judge(commits[nextIdx]);
    if (!nextVerdict.ok) {
      if (isVolumeRefusal(nextVerdict.refusalCode) && bestIdx === -1) {
        // The FIRST commit alone busts a volume cap — indivisible. Publish it
        // rather than latching the whole plane shut (see the header).
        res.safeSha = commits[nextIdx];
        res.oversizedCommit = commits[nextIdx];
        res.drained = true;
      } else if (!isVolumeRefusal(nextVerdict.refusalCode)) {
        res.blocked = { commit: commits[nextIdx], result: nextVerdict };
      }
    }
  }
  res.complete = res.safeSha === input.toOid;
  return res;
}

/** A one-line operator/log message for a refused publish (secrets already masked
 *  by describeSecretFindings-style masking upstream in secrets-guard.ts). */
export function describePublishRefusal(res: PublishGuardResult): string {
  if (res.ok) return 'publish admitted';
  switch (res.refusalCode) {
    case 'blob-over-cap':
      return `refusing to publish — oversized blob(s): ${res.oversizeBlobs
        .slice(0, 3)
        .map((b) => `${b.path || b.oid} (${b.bytes}B)`)
        .join('; ')}`;
    case 'total-over-cap':
      return `refusing to publish — ${res.newTotalBytes} new bytes exceeds the total-new-bytes cap`;
    case 'object-flood':
      return `refusing to publish — ${res.newObjectCount} new objects exceeds the object-count cap`;
    case 'secrets':
      // EI-18751879785723304: name the PATHS, not just a count. This refusal is
      // fail-closed-forever (the guard baseline never advances past a refused
      // range) and its documented remedy — pot_git:secrets_exemptions
      // { action:'add', path } — needs the exact path. Emitting only a count
      // forced the operator to hand-reproduce the scan over the whole stranded
      // range to recover the one input the fix requires (EI-18750935999066024:
      // 1,736 files re-scanned by hand during a 3h fleet-wide egress freeze).
      // describeSecretFindings already renders path:line [rule] excerpt with the
      // excerpt MASKED at detection, so this discloses where to look, never the
      // material — the same reason `blob-over-cap` above already names paths.
      return describeSecretFindings(res.secretFindings);
    default:
      return `refusing to publish — ${res.errors.join('; ') || 'unknown error'}`;
  }
}
