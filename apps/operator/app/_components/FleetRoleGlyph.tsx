'use client';

/**
 * FleetRoleGlyph — the fleet leader/member ICON, shared by every surface that
 * shows a fleet role (owner directive 2026-07-26: "instead of the lead and
 * member texts use the icons we have for that").
 *
 * REUSE, not invention: 👑/👤 is the EXISTING papercusp fleet-role iconography,
 * already rendered into every agent's terminal title and statusline by
 *   apps/operator/scripts/hooks/cc/statusline-fleet.sh:445
 *   apps/operator/scripts/hooks/cc/posttooluse-objective-title.sh:166
 * both of which map `role == 'leader' ? '👑' : '👤'`. This module is the WEB
 * side of that same mapping, so a leader reads identically in the terminal
 * title and in the UI. Those two are shell/python and cannot import this — if
 * the glyphs ever change, they change in three places, which is why the mapping
 * lives in ONE exported constant here rather than inline at each call site.
 *
 * ACCESSIBILITY IS LOAD-BEARING, not decoration: swapping a text label for an
 * emoji silently removes the role from the accessible tree unless the glyph
 * carries a name. Every render is `role="img"` + `aria-label`, so the role stays
 * readable to screen readers AND to agent-driven UI assertions (a test or a
 * ui:get_state drive that looked for the old "LEAD" text finds the label).
 */

export const FLEET_ROLE_GLYPH = {
  leader: '👑',
  member: '👤',
} as const;

export const FLEET_ROLE_LABEL = {
  leader: 'Fleet leader',
  member: 'Fleet member',
} as const;

export function isLeaderRole(role: string | null | undefined): boolean {
  return role === 'leader';
}

export default function FleetRoleGlyph({
  role,
  className,
}: {
  /** The fleet role as the roster reports it — anything not 'leader' is a member. */
  role: string | null | undefined;
  className?: string;
}) {
  const leader = isLeaderRole(role);
  const label = leader ? FLEET_ROLE_LABEL.leader : FLEET_ROLE_LABEL.member;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={className ? `fleet-role-glyph ${className}` : 'fleet-role-glyph'}
      data-testid={leader ? 'fleet-role-leader' : 'fleet-role-member'}
    >
      {leader ? FLEET_ROLE_GLYPH.leader : FLEET_ROLE_GLYPH.member}
    </span>
  );
}
