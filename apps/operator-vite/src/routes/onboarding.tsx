import { createFileRoute } from '@tanstack/react-router';
import Chromeless from '@/app/_components/Chromeless';
import { OnboardingConsole } from '@/app/_components/OnboardingConsole';

/**
 * /onboarding — the agent-chat-first first-run surface
 * (plan agent-first-onboarding-2026-07-03, P-003).
 *
 * A full-window terminal running the onboarding concierge → agent-tutor
 * handoff. The root route sends unfinished first-runs here when
 * FLAGS.ONBOARDING_AGENT_FIRST is on; the component itself carries the
 * escape hatches back to the classic GUI wizard (`/setup?force=1`).
 *
 * Deliberately NOT flag-gated here (no requireFlag): reaching it directly is
 * harmless and the tutorial re-entry (`papercusp tutorial`, P-014) may deep
 * link to it even after first-run.
 */
export const Route = createFileRoute('/onboarding')({
  component: OnboardingPage,
});

function OnboardingPage() {
  return (
    <div className="pc-shell pc-onboarding-shell">
      <Chromeless />
      <OnboardingConsole />
    </div>
  );
}
