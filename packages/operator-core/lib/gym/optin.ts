/**
 * Opt-in sign-off (P-023, D-012).
 *
 * Promotion into the gym's OWN dedicated harness is immediate + unattended (D-012).
 * But pointing a REAL production harness at the gym champion is a human decision — so
 * that outward action requires an explicit, matching, human-approved opt-in record.
 * Pure gate; the wiring stores/loads ChampionOptIn rows and calls this before any
 * real-harness repoint. (There is no production today — CLAUDE.md — so in practice this
 * stays closed until a human opts in.)
 */
export interface ChampionOptIn {
  /** The human who approved (non-empty). */
  approvedBy: string;
  championVariantId: string;
  targetHarnessSlug: string;
  approvedAt: number;
}

export function isOptInValidFor(
  optIn: ChampionOptIn | null | undefined,
  ctx: { championVariantId: string; targetHarnessSlug: string },
): boolean {
  if (!optIn) return false;
  if (!optIn.approvedBy.trim()) return false;
  return optIn.championVariantId === ctx.championVariantId && optIn.targetHarnessSlug === ctx.targetHarnessSlug;
}

export function assertProductionOptIn(
  optIn: ChampionOptIn | null | undefined,
  ctx: { championVariantId: string; targetHarnessSlug: string },
): void {
  if (!isOptInValidFor(optIn, ctx)) {
    throw new Error(
      `refusing to point production harness "${ctx.targetHarnessSlug}" at champion ` +
        `"${ctx.championVariantId}" without a matching human opt-in (P-023)`,
    );
  }
}
