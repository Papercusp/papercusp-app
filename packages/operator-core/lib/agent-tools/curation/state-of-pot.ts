/**
 * curation:state-of-pot — the read projection of the "state of the Hive"
 * corpus digest (hive-creative-ideation-2026-06-08 P-003 / build-item B1).
 *
 * The Scout loop's corpus-synthesis step (step 1): a deterministic rollup of
 * cross-corpus META-patterns — recurring friction, time/token sinks, chronic
 * deferrals, capability gaps — over the change feed + completions + reverts. The
 * grounded substrate the divergent ideators (P-004) read instead of per-turn
 * context; each pattern carries `refs` back to the originals (the change-feed
 * pattern — no duplicated log).
 *
 * Read-only; reuses the completion / improvement / spend / audit sources
 * unchanged. Loads on the next :3070 restart like any new tool.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { synthesizeStateOfHive } from '../../scout/corpus-digest';
import { buildStateOfHiveReaders } from '../../scout/corpus-digest-deps';

const DEFAULT_PER_CATEGORY = 20;
const MAX_PER_CATEGORY = 100;

export default defineTool({
  name: 'curation:state-of-pot',
  description:
    'The "state of the Pot" corpus digest — a deterministic rollup of cross-corpus meta-patterns (recurring friction, time/token sinks, chronic deferrals, capability gaps) over the change feed + completions + reverts. The Blender loop\'s grounded ideation substrate; each pattern references the originals (drill in via work_items:get / plans:get / curation:change-feed).',
  capability: 'curation:read',
  guidance: {
    when: 'You want the introspective "what are the Pot\'s standing meta-patterns" rollup — the recurring friction, where time/tokens go, what keeps being deferred, and the absent capabilities — as the grounded substrate for generative ideation (the Blender loop) or a state-of-the-Pot review. Each pattern carries refs back to the originals.',
    notWhen:
      'For the raw stream of recent completions use curation:change-feed. For salience-ranked live fleet signals (escalations/blockers) use curation:feed. For the captured-improvement triage queue (auto vs human lanes) use improvements:digest.',
    chaining:
      'curation:state-of-pot → drill into a pattern via its refs (work_items:get on wi:<id>, plans:get on plan:<slug>, curation:change-feed) → feed the digest to the Blender ideators.',
    seeAlso: [
      'curation:change-feed (the change feed it rolls up)',
      'work_items:get (drill into a surfaced pattern)',
      'rubrics:trend (per-rubric health over time)',
    ],
  },
  requirePrincipal: false,
  args: z.object({
    /** Max patterns returned per category (default 20, max 100). */
    perCategory: z.number().int().positive().max(MAX_PER_CATEGORY).optional(),
  }),
  async handler(args) {
    const readers = buildStateOfHiveReaders();
    const digest = await synthesizeStateOfHive(readers, {
      nowMs: Date.now(),
      perCategory: args.perCategory ?? DEFAULT_PER_CATEGORY,
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ ok: true, digest }),
        },
      ],
    };
  },
});
