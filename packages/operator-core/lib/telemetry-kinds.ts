/**
 * Telemetry event kind taxonomy.
 *
 * Every report sent through /api/desktop/telemetry-report or forwarded
 * via lib/telemetry-flush.ts uses one of these kinds. The map is the
 * single source of truth — adding a new kind means editing this file
 * and nothing else. Consumers (operator, agents, plugins) import
 * `TELEMETRY_KINDS`/`TelemetryKind` and get autocomplete + compile
 * errors at every site that drifts.
 *
 * Payload shapes per kind are intentionally permissive (unknown) so
 * the wire format stays forward-compat — schema enforcement lives in
 * the analysis layer (PostHog/grafana), not the ingress.
 */

export const TELEMETRY_KINDS = {
  /** End-user-triggered diagnostic. Carries no automatic info — used
   *  by Step 12's "Send test report" button. */
  test: 'test',

  /** Unhandled JS exception caught by the operator's global error
   *  boundary. Payload should include stack + url + componentStack. */
  crash: 'crash',

  /** Tauri shell or Rust-side panic surfaced via the bridge.
   *  Payload: panicMessage, location. */
  native_crash: 'native_crash',

  /** Operator boot failed (couldn't bind port, sidecar refused to
   *  start, embedded PG failed to come up). Payload: stage, detail. */
  startup_failed: 'startup_failed',

  /** A migration runner aborted. Payload: migration filename,
   *  errorCode, queryFragment. */
  migration_failed: 'migration_failed',

  /** A long-running operation hit a hard timeout. Payload: operation,
   *  elapsedMs, lastEventTs. */
  hang_detected: 'hang_detected',

  /** A locked-down route returned 403/404 because the user's PostHog
   *  flag evaluated false. Useful for "are users hitting cut surfaces
   *  via stale bookmarks?". Payload: route, flagKey. */
  feature_unavailable: 'feature_unavailable',

  /** Anchored to Setup Wizard interactions — useful for understanding
   *  drop-off through the 12-step flow. Payload: stepId, action
   *  ('view'|'skip'|'complete'|'finish'). */
  setup_step: 'setup_step',

  /** A swarm peer's announce was conclusively REFUSED admission to the
   *  substrate (per-peer-Hypercore + channel-2-admitted-merge boundary,
   *  D-004). Fleet-health signal: a spike means canonicalisation drift,
   *  a stale revocation set, or active forgery attempts. Payload:
   *  harness_slug, reason ('bad_sig'|'binding_invalid'|'revoked'), and a
   *  truncated peer label (NOT the full device pubkey). The same event is
   *  recorded locally on the boot-history channel; this kind forwards the
   *  count off-device when the user has opted in. */
  substrate_admission_rejected: 'substrate_admission_rejected',
} as const;

export type TelemetryKind = (typeof TELEMETRY_KINDS)[keyof typeof TELEMETRY_KINDS];

/**
 * Loose payload typing — each kind has a recommended shape but the
 * wire is permissive. Use this as the second arg to telemetry helpers
 * so callers get a hint without breaking forward-compat.
 */
export interface TelemetryPayloads {
  test: { source?: string; triggered_at?: string };
  crash: { message: string; stack?: string; url?: string; componentStack?: string };
  native_crash: { panicMessage: string; location?: string };
  startup_failed: { stage: 'port' | 'sidecar' | 'pg' | 'migrations' | 'other'; detail: string };
  migration_failed: { migration: string; errorCode?: string; queryFragment?: string };
  hang_detected: { operation: string; elapsedMs: number; lastEventTs?: string };
  feature_unavailable: { route: string; flagKey: string };
  setup_step: { stepId: string; action: 'view' | 'skip' | 'complete' | 'finish' };
  substrate_admission_rejected: {
    harness_slug: string;
    reason: 'bad_sig' | 'binding_invalid' | 'revoked';
    /** Truncated peer label (e.g. first bytes of the log key) — NOT the full pubkey. */
    peer?: string;
  };
}

export function isTelemetryKind(s: string): s is TelemetryKind {
  return Object.prototype.hasOwnProperty.call(TELEMETRY_KINDS, s);
}
