/**
 * WI-6382 (client half): one predicate for "this panel is showing you nothing
 * because something is BROKEN", covering both ways that can happen.
 *
 * ## The bug this closes
 *
 * Every Learning panel already had a written `{sync.error ? <error/> : …}`
 * branch and an `onStatus('bad')` path. Both were UNREACHABLE for a data-layer
 * fault: the `learning.*` resolvers catch read failures and return a SUCCESSFUL
 * empty snapshot, so `sync.error` stays null and the panel falls through to its
 * calm "nothing here yet" empty state. The error UI fired only for TRANSPORT
 * failure (server down / SSE drop) — never for the failure it appeared to
 * handle. A broken or half-migrated install was therefore indistinguishable
 * from an idle healthy one, and the empty-state copy actively instructed the
 * user to go wait for something that would never arrive.
 *
 * The server side now tags the degraded snapshot (`unavailable` +
 * `unavailableKind` + `unavailableReason`, see
 * `packages/operator-core/lib/sync-resolver/degraded-snapshot.ts`). This is the
 * client's half: fold that tag into the SAME branch the panel already has, so
 * the existing error UI becomes reachable rather than adding a third state
 * nobody wires up.
 */

/** The provenance a degraded server snapshot carries. Mirrors the server type. */
export interface SnapshotProvenance {
  unavailable?: boolean;
  unavailableKind?: "pre-migration" | "read-failed";
  unavailableReason?: string;
}

export interface SnapshotFault {
  /** True when the panel has nothing to show because something failed. */
  failed: boolean;
  /**
   * Reader-facing cause, ready to render. Never a bare "unavailable": an
   * unavailability the user cannot act on is a bug in the message, not just in
   * the backend (owner report 2026-07-25, whose real cause — a corrupted mem0ai
   * install — was invisible from the screen).
   */
  message: string | null;
  /** Which half fired, for tests and for status reporting. */
  source: "transport" | "data" | null;
}

/**
 * Combine a sync hook's transport error with a snapshot's degraded provenance.
 *
 * `label` names the surface ("EKG", "Throughput") and is used to build a
 * message that reads correctly in both cases.
 */
/**
 * `snap` is deliberately `unknown` rather than `SnapshotProvenance`.
 *
 * Every provenance field is optional, which makes `SnapshotProvenance` a WEAK
 * type: TypeScript then rejects any concrete snapshot that happens to share no
 * properties with it (TS2559 — "has no properties in common"), which is every
 * caller here, since `EkgSnapshot` / `MttshVitals` / `FrontierSnapshot` declare
 * only their own payload fields. Widening to `unknown` and narrowing inside is
 * also the truthful signature: this value came off the wire, so the client
 * cannot assume its shape — the same defensive posture the panels already take
 * with `Array.isArray(snap?.shifts)`.
 */
export function snapshotFault(
  syncError: unknown,
  snap: unknown,
  label: string,
): SnapshotFault {
  if (syncError) {
    // Deliberately DETAIL-FREE. A transport error's message is arbitrary
    // network/socket internals, and the panels have a standing decision not to
    // surface it (EkgPanel.test.tsx: "renders a quiet retry state without
    // exposing transport details" — it pins that a thrown "socket secret" never
    // reaches the screen). This is the asymmetry with the data-layer branch
    // below: `unavailableReason` is a message OUR resolver authored about OUR
    // substrate, so it is safe — and necessary — to show.
    return { failed: true, source: "transport", message: `${label} unavailable` };
  }
  const prov = (snap ?? null) as SnapshotProvenance | null;
  if (prov?.unavailable) {
    // Pre-migration is a DIFFERENT fact from a read failure, and saying so is
    // the difference between "your install isn't finished" and "something is
    // wrong". Both beat "nothing has happened yet", which was the old render.
    const lead =
      prov.unavailableKind === "pre-migration"
        ? `${label} not available yet — this install hasn't created its storage`
        : `${label} unavailable`;
    return {
      failed: true,
      source: "data",
      message: prov.unavailableReason ? `${lead} (${prov.unavailableReason})` : lead,
    };
  }
  return { failed: false, source: null, message: null };
}
