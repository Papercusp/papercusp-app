/**
 * netem-types.ts — shared types for the Tier-2 netem driver. Kept separate
 * from netem-inner.ts so the outer scenario can import them WITHOUT executing
 * the inner driver's top-level `main()` (netem-inner is a process entrypoint,
 * like peer-child).
 */

export interface NetemProfile {
  rttMs: number;
  jitterMs: number;
  lossPct: number;
}

export interface NetemInnerConfig {
  profile: NetemProfile;
  /** Which measurement to run through the impaired links. */
  mode: 'sustained' | 'cold-join' | 'loss-curve';
  readers: number;
  rate?: number;
  count?: number;
  preSeed?: number;
  seed: number;
}
