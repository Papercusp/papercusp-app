/**
 * provisioner/recommend-types — the small shared type between catalog.ts and recommend.ts,
 * split out to avoid a catalog.ts <-> recommend.ts import cycle (catalog entries are tagged
 * with the hardware tier they target; recommend.ts derives a tier from detected hardware and
 * matches it against the catalog).
 */
export type HardwareTier = 'nvidia-24gb-plus' | 'nvidia-mid' | 'nvidia-low' | 'apple-silicon' | 'cpu-only';
