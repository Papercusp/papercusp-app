/**
 * capabilities/taggable.ts — Taggable rides Linkable. The generic implementation
 * now lives in @papercusp/linkable-edges (generalize-libs-to-generic D-003 #7);
 * re-exported here so existing imports from '@papercusp/coordination/capabilities'
 * — and the pg-stores PgTaggableStore subclass — keep resolving unchanged.
 */
export { LinkBackedTaggable } from '@papercusp/linkable-edges';
