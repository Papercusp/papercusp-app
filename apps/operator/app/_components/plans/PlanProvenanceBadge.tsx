import { UserRound } from "lucide-react";
import type { AuthorIdentity } from "../AuthorBadge";

export type PlanProvenanceOrigin = "scout" | null | undefined;
export const PLAN_SOURCE_FILTERS = ["all", "user", "blender"] as const;
export type PlanSourceFilter = (typeof PLAN_SOURCE_FILTERS)[number];
export type PlanSourceKind = Exclude<PlanSourceFilter, "all">;

export interface PlanSourceInput {
  origin?: PlanProvenanceOrigin;
  ownerIdentity?: Pick<AuthorIdentity, "handle"> | null;
}

export interface ResolvedPlanSource {
  kind: PlanSourceKind;
  label: string;
  title: string;
  ariaLabel: string;
}

/** One canonical projection shared by badges and filters. The plan-content
 * marker decides Blender; the already-resolved plan owner supplies the visible
 * user name without inventing a second provenance backend. */
export function resolvePlanSource(input: PlanSourceInput): ResolvedPlanSource {
  if (input.origin === "scout") {
    return {
      kind: "blender",
      label: "Blender",
      title:
        "Blender-created plan — canonical plan content declares origin: scout",
      ariaLabel: "Plan source: Blender",
    };
  }
  const handle = input.ownerIdentity?.handle?.trim();
  const label = handle || "User";
  return {
    kind: "user",
    label,
    title: handle ? `User source — plan owner ${handle}` : "User source",
    ariaLabel: handle ? `Plan source: ${handle} (User)` : "Plan source: User",
  };
}

export function matchesPlanSource(
  input: PlanSourceInput,
  filter: PlanSourceFilter,
): boolean {
  return filter === "all" || resolvePlanSource(input).kind === filter;
}

export function planSourceFilterLabel(filter: PlanSourceFilter): string {
  return filter === "all" ? "All" : filter === "user" ? "User" : "Blender";
}

/** A literal kitchen-blender glyph; lucide-react does not ship one. */
export function BlenderIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4.5 3h12" />
      <path d="M6 3 7.5 13h6L15 3" />
      <path d="M15.5 4.5a3 3 0 0 1 0 6" />
      <path d="M6.5 13h8v3.5a2.5 2.5 0 0 1-2.5 2.5H9a2.5 2.5 0 0 1-2.5-2.5z" />
    </svg>
  );
}

export default function PlanProvenanceBadge({
  origin,
  ownerIdentity,
  testId,
  className = "",
}: {
  origin?: PlanProvenanceOrigin;
  ownerIdentity?: Pick<AuthorIdentity, "handle"> | null;
  testId?: string;
  className?: string;
}) {
  const source = resolvePlanSource({ origin, ownerIdentity });
  const blender = source.kind === "blender";

  return (
    <span
      className={`plans-pane__badge plan-provenance-badge plan-provenance-badge--${source.kind} ${className}`.trim()}
      title={source.title}
      aria-label={source.ariaLabel}
      data-testid={testId}
      data-plan-provenance={source.kind}
    >
      {blender ? <BlenderIcon /> : <UserRound size={14} aria-hidden="true" />}
      {source.label}
    </span>
  );
}
