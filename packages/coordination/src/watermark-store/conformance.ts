/**
 * @papercusp/coordination/watermark-store/conformance — re-export shim. The
 * WatermarkStore contract suite lives in the generic lib; the operator's
 * live-PG integration test imports it from here to run `PgWatermarkStore`
 * against the SAME assertions as the in-memory double.
 */
export * from '@papercusp/pubsub-substrate/watermark-store/conformance';
