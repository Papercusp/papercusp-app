/**
 * memory-store.ts — InMemoryWatermarkStore: the test double + the proof
 * that WatermarkStore is swappable. A Map<ownerId, Watermark>, with the
 * SAME pure merge/normalise the PG impl uses, so both pass one conformance
 * suite (P-050).
 */

import {
  emptyWatermark,
  mergeWatermark,
  normaliseWatermark,
  type Watermark,
} from '../core/watermark';
import type { WatermarkStore } from './types';

export class InMemoryWatermarkStore implements WatermarkStore {
  private rows = new Map<string, Watermark>();

  async read(ownerId: string): Promise<Watermark> {
    const cur = this.rows.get(ownerId);
    return cur ? normaliseWatermark(cur) : emptyWatermark();
  }

  async write(ownerId: string, patch: Partial<Watermark>): Promise<Watermark> {
    const next = mergeWatermark(await this.read(ownerId), patch);
    this.rows.set(ownerId, next);
    return next;
  }
}
