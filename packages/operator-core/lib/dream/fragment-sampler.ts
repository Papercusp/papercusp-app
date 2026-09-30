import { cosineSimilarity } from '@papercusp/overlap-clusters';
import {
  DREAM_FRAGMENT_KINDS,
  resolveDreamSamplerConfig,
  type DreamFragmentKind,
  type DreamSamplerConfig,
} from './dream-config';

export interface DreamFragment {
  id: string;
  kind: DreamFragmentKind;
  ref: string;
  text: string;
  createdAt: string;
  harness: string;
  salience?: number;
  embedding?: readonly number[];
}

export type DreamFragmentStrata = Record<DreamFragmentKind, DreamFragment[]>;

export interface DreamFragmentIndexCensus {
  input: number;
  recent: number;
  remote: number;
  excludedHarness: number;
  excludedInvalid: number;
  excludedAgeGap: number;
  droppedByQuota: number;
}

export interface DreamFragmentIndex {
  recent: DreamFragmentStrata;
  remote: DreamFragmentStrata;
  census: DreamFragmentIndexCensus;
}

export interface IndexDreamFragmentsOptions {
  harness: string;
  now: Date | string | number;
  config?: Partial<DreamSamplerConfig>;
}

export type DreamPairingMode = 'banded' | 'random';

export interface DreamFragmentPair {
  anchor: DreamFragment;
  partner: DreamFragment;
  pairing: DreamPairingMode;
  similarity: number | null;
}

export interface SampleDreamPairOptions extends IndexDreamFragmentsOptions {
  rng?: () => number;
}

function emptyStrata(): DreamFragmentStrata {
  return {
    observation: [],
    work_item: [],
    memory: [],
    stat: [],
  };
}

function nowMs(value: Date | string | number): number {
  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(timestamp)) throw new RangeError('now must be a valid timestamp');
  return timestamp;
}

function salience(fragment: DreamFragment): number {
  if (fragment.salience === undefined) return 1;
  return Number.isFinite(fragment.salience) ? Math.max(0, fragment.salience) : 0;
}

function candidateOrder(a: DreamFragment, b: DreamFragment): number {
  return salience(b) - salience(a) || Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id);
}

function capStrata(strata: DreamFragmentStrata, maxPerKind: number): { strata: DreamFragmentStrata; dropped: number } {
  const capped = emptyStrata();
  let dropped = 0;
  for (const kind of DREAM_FRAGMENT_KINDS) {
    const ordered = [...strata[kind]].sort(candidateOrder);
    capped[kind] = ordered.slice(0, maxPerKind);
    dropped += Math.max(0, ordered.length - maxPerKind);
  }
  return { strata: capped, dropped };
}

export function indexDreamFragments(
  fragments: readonly DreamFragment[],
  options: IndexDreamFragmentsOptions,
): DreamFragmentIndex {
  const config = resolveDreamSamplerConfig(options.config);
  const timestamp = nowMs(options.now);
  const recent = emptyStrata();
  const remote = emptyStrata();
  const census: DreamFragmentIndexCensus = {
    input: fragments.length,
    recent: 0,
    remote: 0,
    excludedHarness: 0,
    excludedInvalid: 0,
    excludedAgeGap: 0,
    droppedByQuota: 0,
  };

  for (const fragment of fragments) {
    if (fragment.harness !== options.harness) {
      census.excludedHarness += 1;
      continue;
    }

    const createdAt = Date.parse(fragment.createdAt);
    const text = fragment.text.trim();
    if (!Number.isFinite(createdAt) || createdAt > timestamp || text.length === 0) {
      census.excludedInvalid += 1;
      continue;
    }

    const normalized = { ...fragment, text: text.slice(0, config.maxTextChars) };
    const age = timestamp - createdAt;
    if (age <= config.recentWindowMs) {
      recent[fragment.kind].push(normalized);
      continue;
    }
    if (age > config.remoteMinAgeMs) {
      remote[fragment.kind].push(normalized);
      continue;
    }
    census.excludedAgeGap += 1;
  }

  const cappedRecent = capStrata(recent, config.maxFragmentsPerKind);
  const cappedRemote = capStrata(remote, config.maxFragmentsPerKind);
  census.recent = DREAM_FRAGMENT_KINDS.reduce((count, kind) => count + cappedRecent.strata[kind].length, 0);
  census.remote = DREAM_FRAGMENT_KINDS.reduce((count, kind) => count + cappedRemote.strata[kind].length, 0);
  census.droppedByQuota = cappedRecent.dropped + cappedRemote.dropped;

  return { recent: cappedRecent.strata, remote: cappedRemote.strata, census };
}

function draw(rng: () => number): number {
  const value = rng();
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new RangeError('rng must return a finite value in [0, 1)');
  }
  return value;
}

function pickUniform<T>(values: readonly T[], rng: () => number): T | undefined {
  if (values.length === 0) return undefined;
  return values[Math.floor(draw(rng) * values.length)];
}

function pickWeighted(fragments: readonly DreamFragment[], rng: () => number): DreamFragment | undefined {
  if (fragments.length === 0) return undefined;
  const total = fragments.reduce((sum, fragment) => sum + salience(fragment), 0);
  if (total <= 0) return pickUniform(fragments, rng);

  let cursor = draw(rng) * total;
  for (const fragment of fragments) {
    cursor -= salience(fragment);
    if (cursor < 0) return fragment;
  }
  return fragments[fragments.length - 1];
}

function similarity(a: DreamFragment, b: DreamFragment): number | null {
  if (!a.embedding || !b.embedding) return null;
  return cosineSimilarity(a.embedding, b.embedding);
}

export function sampleDreamPairFromIndex(
  index: DreamFragmentIndex,
  options: Pick<SampleDreamPairOptions, 'config' | 'rng'> = {},
): DreamFragmentPair | null {
  const config = resolveDreamSamplerConfig(options.config);
  const rng = options.rng ?? Math.random;
  const anchorKinds = DREAM_FRAGMENT_KINDS.filter(
    (kind) =>
      index.recent[kind].length > 0 &&
      DREAM_FRAGMENT_KINDS.some((remoteKind) => remoteKind !== kind && index.remote[remoteKind].length > 0),
  );
  const anchorKind = pickUniform(anchorKinds, rng);
  if (!anchorKind) return null;
  const anchor = pickWeighted(index.recent[anchorKind], rng);
  if (!anchor) return null;

  const remote = DREAM_FRAGMENT_KINDS.filter((kind) => kind !== anchor.kind).flatMap((kind) => index.remote[kind]);
  const randomArm = draw(rng) < config.randomPartnerRate;

  if (randomArm) {
    const partner = pickUniform(remote, rng);
    if (!partner) return null;
    return { anchor, partner, pairing: 'random', similarity: similarity(anchor, partner) };
  }

  const candidates = remote
    .map((partner) => ({ partner, similarity: similarity(anchor, partner) }))
    .filter(
      (candidate): candidate is { partner: DreamFragment; similarity: number } =>
        candidate.similarity !== null &&
        candidate.similarity >= config.minSimilarity &&
        candidate.similarity <= config.maxSimilarity,
    )
    .sort(
      (a, b) =>
        b.similarity - a.similarity ||
        a.partner.kind.localeCompare(b.partner.kind) ||
        a.partner.id.localeCompare(b.partner.id),
    );
  const best = candidates[0];
  if (!best) return null;
  return { anchor, partner: best.partner, pairing: 'banded', similarity: best.similarity };
}

export function sampleDreamPair(
  fragments: readonly DreamFragment[],
  options: SampleDreamPairOptions,
): DreamFragmentPair | null {
  return sampleDreamPairFromIndex(indexDreamFragments(fragments, options), options);
}
