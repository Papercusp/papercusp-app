'use client';

/**
 * /settings/autonomy — a RETIREMENT NOTICE. The page has no controls.
 * (queen-autonomy-policy-2026-06-13 B-15 / P-030, retired by
 * retire-mug-kettle-su-only-2026-08-09 P-011 / D-021, terminal step P-068 / D-098.)
 *
 * WHAT USED TO BE HERE: a table of the 13 autonomy categories — per row a
 * risk-ceiling slider, the earned graduated level, the derived effective level and
 * a lock toggle — reading the live policy via `useSyncQuery('autonomy.policy')`,
 * writing through the loopback `autonomy-policy-set` route, plus the P-031
 * recent-auto-decisions feed. All of it steered the Mug/Queen auto-decide gate.
 *
 * WHY IT IS GONE RATHER THAN GATED: the tier those ceilings governed is retired,
 * so nothing consults them. P-011/D-021 first hid the page behind the tier flag;
 * P-068 deleted that flag, making the retirement permanent, at which point the
 * whole body became unreachable under every flag state. It is deleted rather than
 * left dead because unreachable code does not merely sit there: TypeScript stops
 * narrowing inside it, so it began emitting a type error (TS18047 at the old
 * line 324) for a branch no reader could ever hit.
 *
 * ⚠ THE ROUTE STAYS REACHABLE BY URL. The settings nav hides this entry
 * (`SETTINGS_PATH_FLAGS` in ../layout.tsx), but `linkAllowed` filters the nav and
 * nothing else — a typed URL, a bookmark, or an /admin/plans deep-link still lands
 * here. That is precisely why this notice exists instead of a redirect or a 404:
 * the harm P-011 names is a DEAD CONTROL that reads as live, so the page must
 * render something honest and nothing clickable.
 *
 * Agent autonomy is now per-session (AUTO mode), not central policy.
 * The sliders' components (./CeilingSlider, ./RecentAutoDecisions) have been DELETED
 * by WI-38240, the D-098 mechanical-cleanup follow-up this notice handed off to.
 * The shared feed RecentAutoDecisions wrapped — ../../_components/DecisionLog — is NOT
 * dead and must stay: /admin/plans (PlansClient) and the Queue view still render it.
 */
import { useLexicon } from '@/lib/useLexicon';

export default function AutonomySettingsPage() {
  const t = useLexicon();

  return (
    <div>
      <h1>Autonomy</h1>
      <p className="pc-settings-intro" role="status">
        The {t('brain')} is retired, so there is no autonomy policy to steer. These
        per-category ceilings governed her auto-decide gate; with the tier switched off
        nothing consults them. Agent autonomy is now set per session (AUTO mode) rather
        than centrally here.
      </p>
    </div>
  );
}
