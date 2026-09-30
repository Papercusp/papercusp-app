/**
 * GET /api/desktop/tutorial-script — the ENTIRE deterministic tutorial payload in
 * ONE call (deterministic-onboarding-tutorial-2026-07-04 P-003).
 *
 * The tutorial-runner.mjs concierge (P-004) polls this once and then drives the whole
 * tutorial DETERMINISTICALLY — printing each section's `## Brief` VERBATIM, handling
 * [1]/[2]/menu with NO LLM. The agent is invoked ONLY when the user types a free-form
 * question. This endpoint is the reuse seam: it loads the same content pack
 * (tutorial-pack), GUI tour (gui-tab-tour), optional-setup items, and wizard progress
 * the agent tutor used, so the two onboarding paths can never drift.
 *
 * Query:
 *   ?tutorial=1   tutorial re-entry mode (finished machine); default first-run.
 *
 * The still-not-ready optional-setup items (mobile pairing, auto-update channel) are
 * filtered OUT unless FLAGS.ONBOARDING_PREVIEW_FEATURES is ON (P-001) — evaluated
 * server-side here so the runner never has to know the flag. Telemetry consent shipped
 * (desktop-update-center-2026-07-10 P-1): it is preview:false + required, so it now
 * ALWAYS appears and the runner collects it before graduation.
 */
import { platform } from 'node:os';
import { defineTool } from '@papercusp/agent-mcp';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import {
  chaptersFrom,
  loadTutorialPack,
  resolvePackRoot,
} from '../../../onboarding/tutorial-pack';
import { GUI_TAB_TOUR } from '../../../onboarding/gui-tab-tour';
import { visibleOptionalSetupItems } from '../../../onboarding/optional-setup-items';
import { readOperatorState } from '../../../operator-state-pg';
import { ensureInstallId } from '../../../setup-wizard-install-id';
import type { SetupWizardState } from './setup-wizard-state';

/** The core ~10-minute tour (owner-ratified curriculum): chapters 1 + 2 + the finale. */
const CORE_CHAPTERS = [1, 2] as const;

/** Resolve `p`, but fall back to `fallback` if it hasn't settled within `ms` — so a
 *  slow/unreachable dependency can't stall the tutorial's first paint (perf #1). */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

export default defineTool({
  method: 'GET',
  path: '/desktop/tutorial-script',
  auth: {},
  async handler(req: Request) {
    const url = new URL(req.url);
    const mode = url.searchParams.get('tutorial') === '1' ? 'tutorial' : 'first-run';

    // install_id is the stable per-install distinctId (same one telemetry uses); an
    // /admin/features override short-circuits it, so this is robust for an admin toggle.
    await ensureInstallId().catch(() => {});
    const wizard =
      (await readOperatorState<SetupWizardState>('setup_wizard_state').catch(() => null)) ?? null;
    const distinctId = wizard?.install_id ?? 'onboarding';

    // Time-box the flag read (it can touch PostHog) so a slow/unreachable flag
    // backend can't stall first paint. The pack load below is memoized (see
    // tutorial-pack). (perf #1) — Q&A no longer needs agent-CLI detection here;
    // it is answered server-side by /api/desktop/docs-qa (WI-2844).
    const previewEnabled = await withTimeout(
      getFlag(FLAGS.ONBOARDING_PREVIEW_FEATURES, distinctId),
      750,
      false,
    ).catch(() => false);

    const root = resolvePackRoot();
    const sections = root ? loadTutorialPack(root) : [];

    return Response.json({
      mode,
      os: platform(),
      previewEnabled,
      // Content pack — Brief + Details delivered VERBATIM by the runner (no LLM).
      sections: sections.map((s) => ({
        id: s.id,
        chapter: s.chapter,
        order: s.order,
        title: s.title,
        brief: s.brief,
        details: s.details,
        docSlugs: s.docSlugs,
      })),
      chapters: chaptersFrom(sections),
      coreChapters: [...CORE_CHAPTERS],
      // Where the runner resumes from (null on a fresh first run).
      progress: wizard?.tutorial_progress ?? null,
      // Phase-A optional setup — flag-filtered so a fresh install never sees not-ready items.
      optionalSetup: visibleOptionalSetupItems(previewEnabled),
      // Finale GUI tour — the runner narrates these left→right.
      guiTabTour: GUI_TAB_TOUR,
    });
  },
});
