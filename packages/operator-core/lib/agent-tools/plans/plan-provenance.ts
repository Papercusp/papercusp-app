/** Canonical Blender/Scout provenance embedded in plan frontmatter. */
export const BLENDER_PLAN_ORIGIN = 'scout' as const;
export const BLENDER_PLAN_CONTENT_MARKER = `\norigin: ${BLENDER_PLAN_ORIGIN}\n`;
export const BLENDER_PLAN_SQL_PATTERN = `%${BLENDER_PLAN_CONTENT_MARKER}%`;

export type PlanProvenance = 'blender' | 'outside-blender';

/** PURE. Content is canonical; a routed-idea ledger row is not plan provenance. */
export function isBlenderPlanContent(content: string | null | undefined): boolean {
  return content?.includes(BLENDER_PLAN_CONTENT_MARKER) === true;
}

/** PURE. Resolve the cheap boolean projected by plan index reads. */
export function planProvenanceFromBlenderFlag(
  isBlenderOrigin: boolean | null | undefined,
): PlanProvenance {
  return isBlenderOrigin === true ? 'blender' : 'outside-blender';
}

/** Preserve the plans:list wire contract while using canonical plan content. */
export function planOriginFromBlenderFlag(
  isBlenderOrigin: boolean | null | undefined,
): typeof BLENDER_PLAN_ORIGIN | null {
  return isBlenderOrigin === true ? BLENDER_PLAN_ORIGIN : null;
}
