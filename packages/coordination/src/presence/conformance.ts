/**
 * @papercusp/coordination/presence/conformance — re-export shim. The
 * PresenceStore contract suite lives in the generic lib; the operator's live-PG
 * integration test imports it from here to run `PgPresenceStore` against the
 * SAME assertions as the in-memory double.
 */
export * from '@papercusp/pubsub-substrate/presence/conformance';
