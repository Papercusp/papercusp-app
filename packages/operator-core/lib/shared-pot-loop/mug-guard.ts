/**
 * mug-guard.ts — the split-brain-Mug guard + detection invariant
 * (shared-hive-loop-e2e-testing-2026-06-10 P-005; semantics recorded as that
 * plan's D-008).
 *
 * Mug-ness today is placement-by-convention (`deploy:pot
 * { mug: { placement } }` decides where the Mug RUNS, but nothing records
 * a durable "home swarm" any runtime check could assert) — so two swarms of
 * one Hive can BOTH wake a Mug and steer the shared backlog against each
 * other. The probe test (split-brain-mug.integration.test.ts) documents
 * what actually happens at HEAD: no crash, no detection — the steers
 * interleave and LWW silently crowns the LAST writer per item, so the first
 * Mug's prioritization is dropped on the floor (thrash, not divergence).
 *
 * Two pure pieces close the gap:
 *
 *  - `evaluateMugTurnGate` — the HOME-SWARM ASSERTION a Mug turn runs
 *    before steering: only the swarm whose device pubkey matches the Hive's
 *    recorded mug-home may steer; an unset home FAILS OPEN (today's
 *    behavior, alarmed by the detector) so the gate cannot brick a Hive whose
 *    settings predate it. The recommended durable home for the record is the
 *    federated `hive_settings` table (key `mug-home-pubkey`), written at
 *    deploy/create time — the production wiring is the D-008 owner item.
 *
 *  - `detectDoubleSteering` — the DETECTION INVARIANT (P-012/P-013 monitor
 *    family): over a window of steering events (feature_order writes,
 *    attributable locally by the steering session and remotely by CDC op
 *    provenance `author_pubkey`), two DISTINCT steerers inside the window =
 *    a split-brain incident, reported with both sides' forensics.
 */

export interface MugTurnGateInput {
  /** This swarm's device pubkey (the election/announce identity). */
  selfPubkey: string;
  /** The Hive's recorded mug home (e.g. hive_settings['mug-home-pubkey']), or null when unset. */
  queenHomePubkey: string | null;
}

export type MugTurnGate =
  | { ok: true; reason: 'home-swarm' | 'fail-open-unset' }
  | { ok: false; reason: 'not-home-swarm'; queenHomePubkey: string };

/** The home-swarm assertion a Mug turn runs BEFORE steering (D-008). */
export function evaluateMugTurnGate(input: MugTurnGateInput): MugTurnGate {
  if (input.queenHomePubkey == null || input.queenHomePubkey === '') {
    // Unset home: today's convention-only world. Fail open (don't brick the
    // Hive) — the detector below is the alarm for this state.
    return { ok: true, reason: 'fail-open-unset' };
  }
  if (input.queenHomePubkey === input.selfPubkey) return { ok: true, reason: 'home-swarm' };
  return { ok: false, reason: 'not-home-swarm', queenHomePubkey: input.queenHomePubkey };
}

/** One observed steering write (a feature_order / reorder authored by a Mug turn). */
export interface SteeringEvent {
  workItemId: string;
  /** The steering swarm: the local session's swarm pubkey, or the CDC op's author_pubkey for remote arrivals. */
  steererPubkey: string;
  tsMs: number;
}

export interface SplitBrainIncident {
  /** The distinct steerers seen inside the window. */
  steerers: string[];
  windowStartMs: number;
  windowEndMs: number;
  /** Items steered by ≥2 distinct steerers inside the window — the direct contention surface. */
  contestedItems: string[];
  /** Every event inside the window (the forensics payload). */
  events: SteeringEvent[];
}

/**
 * The split-brain detection invariant: two DISTINCT steerers within
 * `windowMs` of each other = one incident (merged transitively, so a steady
 * interleaving reports as one incident, not N). Pure and deterministic.
 */
export function detectDoubleSteering(events: readonly SteeringEvent[], windowMs: number): SplitBrainIncident[] {
  const sorted = [...events].sort((a, b) => a.tsMs - b.tsMs || (a.workItemId < b.workItemId ? -1 : 1));
  const incidents: SplitBrainIncident[] = [];
  let cluster: SteeringEvent[] = [];

  const flush = () => {
    if (cluster.length === 0) return;
    const steerers = [...new Set(cluster.map((e) => e.steererPubkey))].sort();
    if (steerers.length >= 2) {
      const byItem = new Map<string, Set<string>>();
      for (const e of cluster) {
        let s = byItem.get(e.workItemId);
        if (!s) byItem.set(e.workItemId, (s = new Set()));
        s.add(e.steererPubkey);
      }
      incidents.push({
        steerers,
        windowStartMs: cluster[0].tsMs,
        windowEndMs: cluster[cluster.length - 1].tsMs,
        contestedItems: [...byItem.entries()].filter(([, s]) => s.size >= 2).map(([k]) => k).sort(),
        events: cluster,
      });
    }
    cluster = [];
  };

  for (const e of sorted) {
    if (cluster.length > 0 && e.tsMs - cluster[cluster.length - 1].tsMs > windowMs) flush();
    cluster.push(e);
  }
  flush();
  return incidents;
}
