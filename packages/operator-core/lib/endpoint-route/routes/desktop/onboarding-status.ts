/**
 * GET /api/desktop/onboarding-status — ONE call the onboarding concierge
 * (onboard-launcher.mjs) polls: the full detection snapshot + the resolved
 * concierge stage (plan agent-first-onboarding-2026-07-03, P-002).
 *
 * The stage machine itself is the PURE resolver in
 * `lib/onboarding/stage-resolver.ts` — this route only gathers IO (binary
 * detection, sign-in probes, credentials, wizard state) and threads the
 * concierge's session choices in via query params:
 *
 *   ?chosen=<claude|codex>                the user's picked framework
 *   ?forcePick=1                          decline the pre-detection auto-skip
 *   ?embeddingsSkipped=1                  user skipped the embeddings-key step
 *   ?tutorial=1                           tutorial re-entry (P-014): finished
 *                                         machines resolve to handoff, not done
 *
 * Keeping resolution server-side means the .mjs concierge needs no TS import
 * of the resolver — it just polls this endpoint (~5s) and acts on `stage`.
 */
import { platform } from 'node:os';
import { defineTool } from '@papercusp/agent-mcp';
import {
  detectClaude,
  detectCodex,
  detectOmp,
} from '../../../preflight-binaries';
import { claudeSignedIn, codexSignedIn, ompSignedIn } from '../../../agent-auth-detect';
import { readCredentials } from '../../../credentials';
import { readOperatorState } from '../../../operator-state-pg';
import {
  FRAMEWORK_LABELS,
  allowedFrameworks,
  resolveStage,
  type OnboardingFramework,
  type OnboardingSnapshot,
  type ResolveOpts,
} from '../../../onboarding/stage-resolver';

async function safe<T>(p: Promise<T> | T, fallback: T): Promise<T> {
  try {
    return await p;
  } catch {
    return fallback;
  }
}

/** Parse + validate the concierge's session choices from the request URL. Pure; exported for tests. */
export function parseOnboardingQuery(url: string, os: string): ResolveOpts {
  const q = new URL(url, 'http://local').searchParams;
  const rawChosen = q.get('chosen');
  const chosen =
    rawChosen && (allowedFrameworks(os) as string[]).includes(rawChosen)
      ? (rawChosen as OnboardingFramework)
      : null;
  return {
    chosen,
    forcePick: q.get('forcePick') === '1',
    embeddingsSkipped: q.get('embeddingsSkipped') === '1',
    tutorial: q.get('tutorial') === '1',
    os,
  };
}

export default defineTool({
  method: 'GET',
  path: '/desktop/onboarding-status',
  auth: {},
  async handler(req: Request) {
    const os = platform();
    const [
      claudeInstalled,
      codexInstalled,
      ompInstalled,
      claudeAuth,
      codexAuth,
      ompAuth,
      creds,
      wizard,
    ] = await Promise.all([
      safe(detectClaude(), false),
      safe(detectCodex(), false),
      safe(detectOmp(), false),
      safe(Promise.resolve(claudeSignedIn()), false),
      safe(Promise.resolve(codexSignedIn()), false),
      safe(Promise.resolve(ompSignedIn()), false),
      safe(readCredentials(), {} as Awaited<ReturnType<typeof readCredentials>>),
      safe(readOperatorState<{ finished_at?: string }>('setup_wizard_state'), null),
    ]);

    const snapshot: OnboardingSnapshot = {
      claudeInstalled,
      codexInstalled,
      ompInstalled,
      claudeSignedIn: claudeAuth,
      codexSignedIn: codexAuth,
      ompSignedIn: ompAuth,
      embeddingsKeyPresent: Boolean(creds.openai_api_key),
      setupFinished: Boolean(wizard?.finished_at),
    };
    const stage = resolveStage(snapshot, parseOnboardingQuery(req.url, os));
    return Response.json({ os, snapshot, stage, labels: FRAMEWORK_LABELS });
  },
});
