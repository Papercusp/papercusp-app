/**
 * @papercusp/coordination/core — re-export shim. The pure, host-agnostic
 * protocol layer was extracted to the borrowable generic lib
 * (@papercusp/pubsub-substrate); this package keeps only the Postgres tie-in
 * adapter. The public surface is unchanged.
 */
export * from '@papercusp/pubsub-substrate/core';
