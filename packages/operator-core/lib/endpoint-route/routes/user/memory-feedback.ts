/**
 * GET /api/user/memory/feedback — the extraction-prompt-adaptation text
 * derived from memory mutations recorded in harness_shared.memory_feedback.
 * Powers the "Active extraction-prompt adaptation (from your feedback)"
 * panel in /settings/user/memory.
 *
 * The lifetime edit/delete COUNTS this route used to also carry moved to
 * the `userMemory.feedbackStats` sync query
 * (all-active-surfaces-data-sync-migration-2026-07-11 P-013) — that's a
 * live, multi-writer table read (user edits/deletes on the page AND
 * agent-tool memory:update/memory:forget calls) so it belongs on the
 * push-invalidated sync path, not a one-shot fetch a stale page never
 * re-runs. `learning_instructions` stays REST: it's a derived-text
 * snapshot (buildLearningInstructions), not a live counter, in the same
 * "backend/filesystem/learning-instruction metadata outside sync" class as
 * GET /user/memory/backend's envelope.
 *
 * Ported from app/api/user/memory/feedback/route.ts. `auth: 'public'`,
 * with the seeded-`default`-user fallback (single-user installs: the
 * desktop webview typically carries no session cookie).
 */
import { getSessionUserOrDefault } from '../../../auth';
import { buildLearningInstructions } from '../../../memory/learning';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'GET',
  path: '/user/memory/feedback',
  auth: 'public',
  async handler(req) {
    await getSessionUserOrDefault(req.headers);
    const learningInstructions = await buildLearningInstructions().catch(() => null);
    return Response.json({ learning_instructions: learningInstructions });
  },
});
