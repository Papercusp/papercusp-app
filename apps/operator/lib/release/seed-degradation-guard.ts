/**
 * P-015 — the recurrence guard for the D-009 class: a seed that CLAIMS to be sparse
 * while shipping the full own-log history.
 *
 * WHY THIS EXISTS. `computeSparseFrom` (seed-provider-corestore.ts:201-207) returns 0
 * when it finds no complete snapshot inside the reader's scan window. The provider then
 * writes `coreSparseFrom[key] = 0` into the manifest anyway — the seed is LABELLED sparse
 * and ships every block — behind nothing louder than a `console.warn`. That is how the
 * 2026-07-21 release shipped 461,475 blocks / 1.9 GB labelled sparse and nobody noticed
 * for three weeks (P-013 → D-009/D-012).
 *
 * WHY IT MUST JUDGE THE FINAL MANIFEST, NOT THE CUT (D-023, EI-19483689516127637).
 * The default release path does not take the fresh-cut branch at all. `ensure-release-seed.sh`
 * defaults `PAPERCUSP_SEED_REUSE_CORESTORE=auto`, which passes `--reuse-corestore` whenever a
 * committed corestore exists, and `graftCorestoreEntry` (cut-seed-cli.ts:316) copies that prior
 * entry onto the new manifest VERBATIM — `meta.coreSparseFrom` included — with no inspection
 * beyond a double-add check. So the degradation is SELF-PERPETUATING: every default release
 * re-ships the degraded core, and a guard that only covered the fresh path would miss the
 * only path that actually ships. Judging the FINAL manifest is what makes one guard cover
 * both branches by construction.
 *
 * THE THREE MANIFEST STATES this distinguishes (they are not two):
 *   1. no `coreSparseFrom` key at all  → an honestly-labelled FULL cut. Big, but not a lie.
 *   2. `coreSparseFrom` present, some core starting at 0 with real length → THE LIE. A sparse
 *      cut that degraded to full history and said so only in a warn.
 *   3. `coreSparseFrom` present, every core starting above 0 → a genuine sparse cut.
 * State 1 is still gated, but by the SIZE floor rather than the label, because a 50x installer
 * is a defect whether or not it is honestly described.
 *
 * THE FOURTH STATE, and why it is recorded rather than inferred (WI-10001612). The path that
 * actually SHIPS is neither of the three above: `cut-seed-cli` passes `filtered: true`, and the
 * provider's `if (filtered)` branch mints a complete current-state PROJECTION — a fresh core
 * folded from the owner's log — which returns before the sparse block and omits `coreSparseFrom`
 * deliberately. It therefore arrives labelled `full` and is oversized by bytes while being
 * structurally incapable of carrying history.
 *
 * From 2026-08-15 that population was exempted by a PROXY: a core shorter than
 * `DEFAULT_CORE_LENGTH_FLOOR_BLOCKS` "cannot hold history". Sound when written (the 0.0.17-alpha
 * projection was 76 blocks against a 1,000 floor — 13x headroom) and it EXPIRED SILENTLY as the
 * workspace grew. On 2026-09-16 the 0.0.20 cut minted ~1,041 blocks, 4.1% over, and this guard
 * refused a healthy 4.06 GB projection after a 4.5-hour scan — while printing the SPARSE remedy,
 * which describes a code path that cut never entered. Nothing announced the expiry; the guard
 * simply began refusing healthy artifacts and citing a cause that had never applied.
 *
 * So the exemption is now STRUCTURAL: the minting branch records `coreProjectedFrom` (see
 * `seed-projection-meta.ts`) and this guard keys off that recorded fact. A proxy for a fact is a
 * time bomb with an unknown fuse — the repair is to record the fact, not to enlarge the proxy.
 * ⛔ Do NOT "fix" a future recurrence by raising either floor constant: see each one's note.
 */

import type { SeedManifest, SeedStoreEntry } from '@papercusp/seed-bundle';
import {
  SEED_PROJECTED_FROM_META_KEY,
  readCoreProjectedFrom,
} from '@papercusp/operator-core/lib/sync/hyperbee/seed-projection-meta';

/** Explicit, deliberate acknowledgement that this cut ships full history anyway. */
export const SEED_ACK_FULL_HISTORY_ENV = 'PAPERCUSP_SEED_ACK_FULL_HISTORY';

/**
 * A corestore above this ships history, not a head span — BUT ONLY when the payload is long
 * enough to hold history (see `historyCapable` at the size check; bytes alone cannot tell a
 * history dump from a big current-state projection).
 *
 * CALIBRATION, and the population it originally MISSED. This floor was set against two
 * artifact classes: the sparse cut advertises ~40 MB, and the degraded 2026-07-21 core was
 * 1,998,388,355 B. 256 MB sits clear of both, so neither is a borderline call — that much is
 * still true, and it is why the constant is not simply raised.
 *
 * There is a THIRD class the original calibration never contemplated, and it is what the
 * shipping path actually produces: a FILTERED current-state projection. The 0.0.17-alpha cut
 * measured 318,544,683 B across 76 blocks — 7.6x the sparse figure, so ABOVE this floor, while
 * being 6.1x SMALLER and carrying 1,430x fewer blocks than the corestore that actually shipped
 * on 2026-07-05 (1,955,653,943 B / 108,633 blocks, per that cut's committed seed manifest).
 * Healthy, in other words, and well above the floor.
 *
 * ⛔ Do NOT re-derive this as "the floor is miscalibrated for the filtered path" and raise the
 * constant: raising it would blind the SPARSE path to the very regression the floor exists to
 * catch. A projection is separated from a history dump by the RECORDED projection fact
 * (`coreProjectedFrom`), not by bytes and not by a block count; the byte floor stays where it is
 * and keeps judging the populations it was calibrated against.
 *
 * ⚠ Nor is the projection's SIZE this guard's question. A 4.06 GB projection is not a
 * degradation — measured across the 0.0.17-alpha and 0.0.20 cuts the per-block size is identical
 * (4.19 MB) and the workspace itself grew 13.7x, so the artifact is an honest picture of a large
 * hive. Whether an installer that size is acceptable is a PRODUCT decision; this guard exists to
 * catch a seed that LIES about what it carries, and answering a product question with a
 * correctness refusal is what produced the WI-10001612 false refusal.
 */
export const DEFAULT_CORESTORE_SIZE_FLOOR_BYTES = 256 * 1024 * 1024;

/**
 * Below this many blocks, `coreSparseFrom === 0` is not evidence of degradation — a core with
 * no history to trim legitimately starts at 0. Only a core long enough for the distinction to
 * matter can carry the lie.
 *
 * ⚠ SCOPE, narrowed by WI-10001612. This floor judges the SPARSE label only, where it compares
 * a core against ITS OWN recorded start index — a self-contained question that does not drift as
 * the workspace grows. It is no longer the projection test. Using it as a stand-in for "this
 * payload cannot be history" is what expired on 2026-09-16, and raising it would only re-arm the
 * identical trap one growth step further out: the proxy WAS the defect, so the repair is the
 * recorded fact, never a larger constant.
 *
 * It survives in ONE reduced role beyond the sparse findings — judging a pre-marker manifest
 * grafted forward by `--reuse-corestore`. See `legacyProjectionAdmitted` below for why that use
 * cannot expire the way this one did.
 */
export const DEFAULT_CORE_LENGTH_FLOOR_BLOCKS = 1_000;

export type SeedDegradationCode =
  /** State 2 — the manifest claims sparse and ships a core's full history. */
  | 'sparse-label-but-full-history'
  /** Claims sparse from 0 for a core whose length the manifest does not record. */
  | 'sparse-label-unverifiable-length'
  /** The corestore payload is history-sized regardless of how it is labelled. */
  | 'corestore-exceeds-size-floor'
  /**
   * The projection analogue of `sparse-label-but-full-history`: the manifest claims a core is a
   * minted projection while naming the owner's OWN LOG as the shipped key. A real projection is
   * minted into a fresh core the owner never wrote, so this claims the one thing a projection
   * cannot be — a replica of the source history — and would otherwise buy a size-floor exemption
   * for exactly the payload the floor exists to refuse.
   */
  | 'projection-label-but-source-core';

export interface SeedDegradationFinding {
  readonly code: SeedDegradationCode;
  readonly detail: string;
  /** Hex core keys that triggered a core-scoped finding. */
  readonly cores?: readonly string[];
}

/** Which branch produced the manifest under judgement — decides which remedy is quoted. */
export type SeedCutOrigin = 'fresh' | 'reuse';

/**
 * What the manifest says it is — which decides WHICH REMEDY a refusal quotes.
 *
 * `projection` is the shipping path (see the header's fourth state) and is reported
 * separately from `full` precisely so a projection refusal can stop printing sparse-path
 * advice. Conflating the two is what made the WI-10001612 refusal quote "append a fresh head
 * snapshot so computeSparseFrom resolves a real suffix start" at a cut that never called
 * `computeSparseFrom` — confident, specific, actionable and wrong, which is worse than vague.
 */
export type SeedManifestLabel = 'sparse' | 'full' | 'projection' | 'no-corestore';

export interface SeedDegradationVerdict {
  /** false ⇒ the cut must fail. `acknowledged` is applied separately by the caller. */
  readonly ok: boolean;
  /** What the manifest claims about itself. */
  readonly label: SeedManifestLabel;
  readonly origin: SeedCutOrigin;
  readonly sizeBytes: number;
  readonly findings: readonly SeedDegradationFinding[];
  /**
   * True when the payload was exempted from the size floor by the LEGACY block-count
   * heuristic rather than a recorded projection fact — a pre-marker manifest grafted forward.
   * Surfaced on the verdict (and announced in `message`) so the heuristic can never again be
   * the silent thing it was: a reader can see which evidence carried the verdict.
   */
  readonly legacyProjectionAdmitted: boolean;
  /** Human-readable verdict + remedy, ready to throw or log. */
  readonly message: string;
}

export interface JudgeSeedDegradationOptions {
  readonly origin?: SeedCutOrigin;
  readonly sizeFloorBytes?: number;
  readonly coreLengthFloorBlocks?: number;
}

/** Narrow an untyped `meta` bag to a hex-key → number record. Manifests are read off disk
 *  from prior cuts, so nothing here may assume the provider's in-process types. */
function numberRecord(value: unknown): Record<string, number> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/** Narrow an untyped `meta` bag to a string list. Same defensive posture as {@link numberRecord}:
 *  manifests are read off disk from prior cuts, so nothing here may assume the provider's types. */
function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const v of value) if (typeof v === 'string') out.push(v);
  return out;
}

function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${n} B`;
}

/**
 * Remedies, keyed by the BRANCH THAT PRODUCED THE PAYLOAD — not by origin alone (WI-10001612).
 *
 * A remedy quoted at the wrong branch is worse than no remedy: it is confident, specific and
 * actionable, so it gets FOLLOWED. The 2026-09-16 refusal printed `sparseDegraded` at a filtered
 * projection, and following it meant re-running a 4.5-hour scan (plus a fleet-wide git-sync
 * outage) to redo a head-snapshot append that had already succeeded before the scan started —
 * arriving at a byte-identical refusal, because on the filtered path `computeSparseFrom` is
 * never called at all. A vague error would have prompted an investigation; this one did not.
 */
const REMEDY = {
  /** The sparse path degraded — this is the ONLY remedy that may mention computeSparseFrom. */
  sparseDegraded:
    'Append a fresh head snapshot at the own-log tail before cutting (produceLogSnapshot after the ' +
    'pre-cut drain) so computeSparseFrom resolves a real suffix start.',
  /** An honestly-labelled FULL cut, over the byte floor. Not a lie — just the wrong cut mode. */
  oversizedFullCut:
    'This payload is a full-history cut, not a current-state projection: it carries no ' +
    `\`${SEED_PROJECTED_FROM_META_KEY}\` and no sparse start. Cut it FILTERED (the shipping path — ` +
    'cut-seed-cli passes `filtered: true`), which mints a projection and records that fact, or cut ' +
    'it sparse. Do NOT raise the size floor to admit it.',
  /** The projection claim is self-refuting — the shipped key IS the source own-log. */
  projectionSourceCore:
    'The manifest claims a minted projection but ships the OWNER OWN-LOG key itself, which is a ' +
    'replica of the source history rather than a projection of it. Fix the minting branch ' +
    '(mintFilteredSeedContentCore must mint into a FRESH core and replicate only its blocks) — do ' +
    'not relabel the manifest to match the payload.',
  /** The graft dominates every other remedy: fixing the cut cannot change what is reused. */
  reuse:
    'The committed corestore is being grafted forward as-cut (D-023: PAPERCUSP_SEED_REUSE_CORESTORE ' +
    'defaults to `auto`). Re-cut fresh with PAPERCUSP_SEED_REUSE_CORESTORE=0 — fixing the cut path ' +
    'alone can never change what ships while the degraded core is reused.',
} as const;

/**
 * Pick the remedy for a refusal. `reuse` wins outright — while the degraded core is grafted
 * forward, no fix to the cut path changes what ships — and otherwise the FINDINGS decide, so a
 * projection refusal can never quote sparse-path advice.
 */
function selectRemedy(
  origin: SeedCutOrigin,
  label: SeedManifestLabel,
  findings: readonly SeedDegradationFinding[],
): string {
  if (origin === 'reuse') return REMEDY.reuse;
  if (findings.some((f) => f.code === 'projection-label-but-source-core')) {
    return REMEDY.projectionSourceCore;
  }
  if (label === 'sparse') return REMEDY.sparseDegraded;
  return REMEDY.oversizedFullCut;
}

/**
 * Judge a FINAL seed manifest — the one written to disk, after any `--reuse-corestore` graft.
 * Pure: no env, no fs. The caller supplies `origin` and applies the acknowledgement.
 */
export function judgeSeedDegradation(
  manifest: SeedManifest,
  opts: JudgeSeedDegradationOptions = {},
): SeedDegradationVerdict {
  const origin: SeedCutOrigin = opts.origin ?? 'fresh';
  const sizeFloor = opts.sizeFloorBytes ?? DEFAULT_CORESTORE_SIZE_FLOOR_BYTES;
  const lengthFloor = opts.coreLengthFloorBlocks ?? DEFAULT_CORE_LENGTH_FLOOR_BLOCKS;

  const entry: SeedStoreEntry | undefined = manifest.stores.find((s) => s.kind === 'corestore');
  if (!entry) {
    return {
      ok: true,
      label: 'no-corestore',
      origin,
      sizeBytes: 0,
      findings: [],
      legacyProjectionAdmitted: false,
      message: '[seed-guard] no corestore entry in the manifest — nothing to judge.',
    };
  }

  const meta = entry.meta ?? {};
  const sparseFrom = numberRecord(meta.coreSparseFrom);
  const lengths = numberRecord(meta.coreLengths) ?? {};
  const projectedFrom = readCoreProjectedFrom(meta);
  const findings: SeedDegradationFinding[] = [];

  if (sparseFrom !== undefined) {
    // State 2 vs 3. A core is degraded when the manifest claims a sparse start of 0 for a core
    // long enough that a real snapshot would have moved it. Judge per-core: a PARTIAL degradation
    // (one core of several starting at 0) is the same lie and must not pass because its siblings
    // are healthy.
    const degraded: string[] = [];
    const unverifiable: string[] = [];
    for (const [key, from] of Object.entries(sparseFrom)) {
      if (from > 0) continue;
      const len = lengths[key];
      if (len === undefined) unverifiable.push(key);
      else if (len > lengthFloor) degraded.push(key);
    }
    if (degraded.length > 0) {
      findings.push({
        code: 'sparse-label-but-full-history',
        cores: degraded,
        detail:
          `${degraded.length} core(s) are labelled sparse but start at block 0, shipping full history: ` +
          degraded.map((k) => `${k.slice(0, 12)}… (${lengths[k]!.toLocaleString()} blocks)`).join(', '),
      });
    }
    if (unverifiable.length > 0) {
      findings.push({
        code: 'sparse-label-unverifiable-length',
        cores: unverifiable,
        detail:
          `${unverifiable.length} core(s) claim a sparse start of 0 but the manifest records no ` +
          `coreLengths entry, so the claim cannot be shown harmless: ` +
          unverifiable.map((k) => `${k.slice(0, 12)}…`).join(', '),
      });
    }
  }

  // ── Is this payload a FILTERED PROJECTION? (WI-10001612) ────────────────────────────────
  // A projection is minted by folding the source log to a current-state snapshot into a FRESH
  // core, so it structurally cannot carry history and the byte floor must not judge it. That
  // is a FACT the minting branch records (`coreProjectedFrom`), not something inferred here.
  //
  // Two conditions, and both are load-bearing:
  //   • EVERY shipped core is marked. A partial mark means some shipped core is not proven to
  //     be a projection — the same reasoning as the per-core sparse findings above, where one
  //     bad core among healthy siblings is still the lie. Fail safe: no exemption.
  //   • No marked core names ITSELF as its source. The minted key is a fresh core the owner
  //     never wrote, so `minted === source` means the payload is a replica of the owner's own
  //     log wearing a projection label — precisely the history the floor exists to refuse, and
  //     the one way this exemption could be turned into a hole. That is a FINDING, not a
  //     silent loss of the exemption, because a manifest asserting it is making a false claim.
  const coreKeys = stringArray(meta.coreKeys) ?? Object.keys(lengths);
  const selfSourced = coreKeys.filter((k) => projectedFrom?.[k] === k);
  const everyCoreProjected =
    projectedFrom !== undefined && coreKeys.length > 0 && coreKeys.every((k) => projectedFrom[k] !== undefined);
  if (selfSourced.length > 0) {
    findings.push({
      code: 'projection-label-but-source-core',
      cores: selfSourced,
      detail:
        `${selfSourced.length} core(s) are labelled a minted projection whose source is the SAME key, ` +
        `so the payload ships the owner's own log rather than a projection of it: ` +
        selfSourced.map((k) => `${k.slice(0, 12)}…`).join(', '),
    });
  }
  const isProjection = everyCoreProjected && selfSourced.length === 0;

  // LEGACY, and deliberately narrow: a manifest cut BEFORE the marker existed, grafted forward
  // by `--reuse-corestore`. The block-count proxy is the only evidence such a manifest carries,
  // and — unlike the use that expired — it is applied to a FROZEN artifact. That is the whole
  // difference: the proxy failed because newly-minted projections GREW past it (76 → 882 →
  // 1,041 blocks as the workspace grew 13.7x), whereas a reused entry's block count was fixed
  // at the moment it was cut and cannot drift afterwards. A FRESH cut needs no such fallback:
  // cut-seed-cli passes `filtered: true`, so every fresh projection now records the fact, and a
  // fresh payload without it is a sparse or full cut that the floor is calibrated to judge.
  // This path sunsets itself — the first re-cut replaces the pre-marker artifact.
  const legacyProjectionAdmitted =
    !isProjection &&
    origin === 'reuse' &&
    projectedFrom === undefined &&
    coreKeys.length > 0 &&
    coreKeys.every((k) => lengths[k] !== undefined) &&
    coreKeys.every((k) => lengths[k]! <= lengthFloor);

  // The byte floor judges everything the two exemptions above do not clear. FAIL SAFE in both
  // directions: an unmarked payload is not PROVEN to be a projection, and an unknown core length
  // is not proof of harmlessness — neither turns "unknown" into "fine".
  if (entry.sizeBytes > sizeFloor && !isProjection && !legacyProjectionAdmitted) {
    findings.push({
      code: 'corestore-exceeds-size-floor',
      detail:
        `corestore payload is ${formatBytes(entry.sizeBytes)}, above the ${formatBytes(sizeFloor)} floor ` +
        `— this seed ships history, not a head span.`,
    });
  }

  // Report the projection as its OWN label rather than folding it into `full`. The two want
  // opposite remedies, and `full` is what made a projection refusal quote sparse-path advice.
  const label: SeedManifestLabel = isProjection ? 'projection' : sparseFrom === undefined ? 'full' : 'sparse';

  const ok = findings.length === 0;
  const totalBlocks = coreKeys.reduce((n, k) => n + (lengths[k] ?? 0), 0);
  const message = ok
    ? [
        `[seed-guard] corestore OK (${label}, ${formatBytes(entry.sizeBytes)}` +
          `${totalBlocks > 0 ? `, ${totalBlocks.toLocaleString()} blocks` : ''}).`,
        // The size of an honest projection is a PRODUCT question, not a degradation — but it
        // must never be invisible, which is how a 4 GB installer reaches a user unremarked.
        ...(isProjection && entry.sizeBytes > sizeFloor
          ? [
              `[seed-guard] ⚠ this projection is ${formatBytes(entry.sizeBytes)} — above the ` +
                `${formatBytes(sizeFloor)} history floor, and EXEMPT because it is a recorded ` +
                `current-state projection (${SEED_PROJECTED_FROM_META_KEY}), not history. Its size ` +
                `tracks the hive, so judge whether an installer this large is acceptable.`,
            ]
          : []),
        // Never let the legacy heuristic be the silent thing the proxy was.
        ...(legacyProjectionAdmitted && entry.sizeBytes > sizeFloor
          ? [
              `[seed-guard] ⚠ admitted by the LEGACY block-count heuristic (${totalBlocks.toLocaleString()} ` +
                `≤ ${lengthFloor.toLocaleString()} blocks): this grafted manifest predates ` +
                `${SEED_PROJECTED_FROM_META_KEY} and carries no projection fact to check. Re-cut fresh ` +
                `(PAPERCUSP_SEED_REUSE_CORESTORE=0) for a structural verdict.`,
            ]
          : []),
      ].join('\n')
    : [
        `[seed-guard] REFUSING a degraded seed (${origin} cut, labelled ${label}, ${formatBytes(entry.sizeBytes)}):`,
        ...findings.map((f) => `  • ${f.code}: ${f.detail}`),
        `  remedy: ${selectRemedy(origin, label, findings)}`,
        `  to ship it anyway, set ${SEED_ACK_FULL_HISTORY_ENV}=1 — a deliberate, recorded acknowledgement.`,
      ].join('\n');

  return {
    ok,
    label,
    origin,
    sizeBytes: entry.sizeBytes,
    findings,
    legacyProjectionAdmitted,
    message,
  };
}

/** Read the acknowledgement from an env bag. Kept separate so `judgeSeedDegradation` stays pure. */
export function isFullHistoryAcknowledged(env: Record<string, string | undefined>): boolean {
  return env[SEED_ACK_FULL_HISTORY_ENV] === '1';
}

/**
 * Enforce the verdict: throw unless clean or explicitly acknowledged. An acknowledged
 * degradation is announced on stderr — the whole defect class is that it used to be silent,
 * so the acknowledged path must be louder than the refusal, not quieter.
 */
export function assertSeedNotDegraded(
  manifest: SeedManifest,
  opts: JudgeSeedDegradationOptions & { readonly env?: Record<string, string | undefined> } = {},
): SeedDegradationVerdict {
  const verdict = judgeSeedDegradation(manifest, opts);
  if (verdict.ok) return verdict;
  if (isFullHistoryAcknowledged(opts.env ?? process.env)) {
    console.warn(
      `${verdict.message}\n[seed-guard] ⚠ ${SEED_ACK_FULL_HISTORY_ENV}=1 — shipping the degraded seed ` +
        `BY EXPLICIT ACKNOWLEDGEMENT. The installer carries full history.`,
    );
    return verdict;
  }
  throw new Error(verdict.message);
}
