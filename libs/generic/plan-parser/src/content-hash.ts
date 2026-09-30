/**
 * Canonical content hash for a plan's markdown source.
 *
 * This is the baseline for `plans:set-content`'s compare-and-swap
 * (D-011 of plans-admin-ui-2026-05-20): `plans:get` returns
 * `contentHash`, the editor echoes it back as `expectedHash`, and
 * `plans:set-content` compares the live file's hash against it before
 * writing. Both the read side and the write side MUST route through
 * this one function so the hash is byte-identical — a divergent
 * algorithm or encoding would make every save look stale.
 */

import { createHash } from 'node:crypto';

export function hashPlanContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
