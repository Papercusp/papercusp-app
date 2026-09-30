/**
 * scout-archive-port.ts — Scout P-012 production wire (the Scout→archive
 * direction): adapt su-8075f's ASYNC gym-QD {@link ArchiveAPI} to gym-bridge's
 * SYNC {@link ArchivePort} so the Scout router's gym rail (buildGymDispatchPort →
 * seedDistantNiches, wired in cb4b9's cycle-deps) seeds Scout's distant ideas
 * into the real MAP-Elites archive (harness_shared.gym_qd_archive, migration 193).
 *
 * The impedance: gym-bridge's ArchivePort is synchronous (seedDistantNiches reads
 * `listElites()` + calls `seed()` inline), but the archive store is async (PG).
 * Bridged by a SNAPSHOT + BUFFER + FLUSH:
 *   - build loads a one-shot snapshot of current elites (async);
 *   - `listElites()` / `seed()` read + admit against the snapshot (sync) — a scout
 *     seed (fitness 0) admits only into an EMPTY cell, exactly the gym-bridge
 *     contract, and is buffered;
 *   - `flush()` persists the buffered seeds via `upsertElite` (the authoritative
 *     admission); the production runner calls it after the cycle.
 *
 * The sync `seed()` result is a best-effort PREDICTION (snapshot-based); the flush's
 * upsertElite is the truth (it re-checks admission server-side). For a low-volume
 * scout seed into empty cells that prediction matches, and the persisted state is
 * always correct.
 */

import { getOrgPg } from '@papercusp/db-org';
import { makeGymArchive } from '../gym/qd/archive-recorder';
import type { ArchiveAPI } from '../gym/qd/archive';
import {
  nicheKey,
  type ArchiveEliteView,
  type ArchivePort,
  type ArchiveSeedEntry,
} from './gym-bridge';
import { listFrontierElites } from './foreign-frontier';
import { sanitizeForeignPriming } from './foreign-priming-sanitize';

/** An ArchivePort that buffers scout seeds for an async {@link ScoutArchivePort.flush}. */
export interface ScoutArchivePort extends ArchivePort {
  /** Persist buffered scout seeds to the real archive (call after the cycle). */
  flush(): Promise<void>;
}

export interface BuildScoutArchivePortOptions {
  workspaceId: string;
  harnessSlug: string;
  /** Override the archive (tests); default = makeGymArchive over the live PG store. */
  api?: ArchiveAPI;
}

/**
 * Build the sync {@link ScoutArchivePort} over the async archive: snapshot elites
 * now, admit scout seeds against the snapshot, buffer them, persist on flush.
 */
export async function buildScoutArchivePort(opts: BuildScoutArchivePortOptions): Promise<ScoutArchivePort> {
  const api =
    opts.api ?? makeGymArchive(getOrgPg().sql, { workspaceId: opts.workspaceId, harnessSlug: opts.harnessSlug });

  const snapshot = new Map<string, ArchiveEliteView>();
  const initialViews = opts.api
    ? (await api.listElites()).map((e) => ({ ...e, sourceHive: null }))
    : await listFrontierElites(getOrgPg().sql, { workspaceId: opts.workspaceId, harnessSlug: opts.harnessSlug });
  for (const e of initialViews) {
    const rationale =
      e.sourceHive && e.rationale
        ? sanitizeForeignPriming(e.rationale)
        : e.rationale;
    const existing = snapshot.get(e.nicheKey);
    if (existing && existing.fitness >= e.fitness) continue;
    snapshot.set(e.nicheKey, {
      nicheKey: e.nicheKey,
      coords: e.coords,
      candidateId: e.candidateId,
      fitness: e.fitness,
      descriptor: e.descriptor,
      source: e.source,
      ...(rationale ? { rationale } : {}),
    });
  }

  const buffered: ArchiveSeedEntry[] = [];

  return {
    listElites: () => [...snapshot.values()],
    seed: (entry: ArchiveSeedEntry) => {
      const key = nicheKey(entry.descriptor.coords);
      if (snapshot.has(key)) return { admitted: false, nicheKey: key };
      // Admit into the empty cell (scout seed, fitness 0): reflect in the snapshot
      // so a second seed into the same cell this cycle doesn't double-admit, + buffer.
      snapshot.set(key, {
        nicheKey: key,
        coords: entry.descriptor.coords,
        candidateId: entry.candidateId,
        fitness: 0,
        descriptor: entry.descriptor,
        source: 'scout',
        ...(entry.rationale ? { rationale: entry.rationale } : {}),
      });
      buffered.push(entry);
      return { admitted: true, nicheKey: key };
    },
    async flush() {
      for (const e of buffered) {
        try {
          await api.upsertElite({
            candidateId: e.candidateId,
            descriptor: e.descriptor,
            fitness: 0,
            source: 'scout',
            rationale: e.rationale ?? null,
          });
        } catch (err) {
           
          console.warn('[scout-archive-port] flush upsert failed:', err instanceof Error ? err.message : err);
        }
      }
      buffered.length = 0;
    },
  };
}
