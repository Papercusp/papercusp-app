/**
 * @papercusp/coordination/event-log/conformance — re-export shim. The
 * CoordEventLog contract suite lives in the generic lib; the operator's live-PG
 * integration test imports it from here to run `PgCoordLog` against the SAME
 * assertions as the fs/in-memory backends.
 */
export * from '@papercusp/pubsub-substrate/event-log/conformance';
