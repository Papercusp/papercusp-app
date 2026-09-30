/**
 * POST /api/user/memory/reembed
 *
 * One-shot re-embed of every memory in the source mode's collection
 * into the target mode's collection. Triggered by /settings/user/memory
 * when the user switches memoryEmbedderMode and wants to bring old
 * memories forward. ~30-60s for OpenAI, ~2-5min for local on a 500-mem
 * collection.
 *
 * Ported from app/api/user/memory/reembed/route.ts. `auth: 'loopback'` (auth-tier Wave 1),
 * `timeoutSec: 600` to match the Next maxDuration.
 */
import { getSessionUserOrDefault } from '../../../auth';
import { reembedMemories } from '../../../memory/reembed';
import { loadVoicePrefs } from '../../../voice-prefs';
import {
  cutoverMemoryProfile,
  MemoryProfileCutoverError,
} from '../../../memory/profile-cutover';
import { defineTool } from '@papercusp/agent-mcp';
import { EMBEDDER_DIM_SPECS, type EmbeddingProfileId } from '@papercusp/memory';

// 'gemma' = EmbeddingGemma-300m @ native 768 (the default local embedder; its own
// space → memory_vec_gemma). Switching TO gemma from a prior mode re-embeds the
// corpus into the gemma vec table so old memories stay recall-visible.
// 'harrier' = harrier-oss-0.6b @ native-1024 (selectable, P-014; its own
// space → memory_vec_harrier, migration 547).
const VALID_MODES = ['openai', 'local', 'gemma', 'harrier'] as const;
type Mode = (typeof VALID_MODES)[number];

function isMode(v: unknown): v is Mode {
  return typeof v === 'string' && (VALID_MODES as readonly string[]).includes(v);
}

function isProfileId(v: unknown): v is EmbeddingProfileId {
  return typeof v === 'string' && /^[a-z0-9][a-z0-9._-]*@v[1-9]\d*$/.test(v);
}

const get = defineTool({
  method: 'GET',
  path: '/user/memory/reembed',
  auth: 'public',
  async handler(req) {
    await getSessionUserOrDefault(req.headers);
    const prefs = await loadVoicePrefs();
    const mode = isMode(prefs.memoryEmbedderMode) ? prefs.memoryEmbedderMode : null;
    const previousMode = prefs.previousMemoryEmbedderMode;
    return Response.json({
      current: mode ? { mode, profileId: EMBEDDER_DIM_SPECS[mode].profileId } : null,
      rollback: previousMode
        ? { mode: previousMode, profileId: prefs.previousMemoryEmbedderProfileId ?? EMBEDDER_DIM_SPECS[previousMode].profileId }
        : null,
      profiles: Object.fromEntries(
        VALID_MODES.map((profileMode) => [
          profileMode,
          { profileId: EMBEDDER_DIM_SPECS[profileMode].profileId },
        ]),
      ),
    });
  },
});

const post = defineTool({
  method: 'POST',
  path: '/user/memory/reembed',
  auth: 'loopback',
  timeoutSec: 600,
  async handler(req) {
    // Session is optional (single-user default fallback); the `loopback`
    // auth tier is the real gate. The re-embed is not per-user.
    const user = await getSessionUserOrDefault(req.headers);

    let body: {
      from?: unknown;
      to?: unknown;
      fromProfileId?: unknown;
      toProfileId?: unknown;
      cutover?: unknown;
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json({ error: 'invalid_json' }, { status: 400 });
    }
    if (!isMode(body.from) || !isMode(body.to)) {
      return Response.json({ error: 'invalid_mode' }, { status: 400 });
    }
    if (body.from === body.to) {
      return Response.json({ error: 'same_mode_noop' }, { status: 400 });
    }
    if (body.cutover !== undefined && typeof body.cutover !== 'boolean') {
      return Response.json({ error: 'invalid_cutover' }, { status: 400 });
    }
    if (body.fromProfileId !== undefined && !isProfileId(body.fromProfileId)) {
      return Response.json({ error: 'invalid_source_profile' }, { status: 400 });
    }
    if (body.toProfileId !== undefined && !isProfileId(body.toProfileId)) {
      return Response.json({ error: 'invalid_target_profile' }, { status: 400 });
    }
    if (body.cutover === true && (!isProfileId(body.fromProfileId) || !isProfileId(body.toProfileId))) {
      return Response.json({ error: 'profile_ids_required_for_cutover' }, { status: 400 });
    }

    try {
      const result = await reembedMemories(body.from, body.to, {
        ...(isProfileId(body.fromProfileId) ? { fromProfileId: body.fromProfileId } : {}),
        ...(isProfileId(body.toProfileId) ? { toProfileId: body.toProfileId } : {}),
      });
      let cutover = null;
      if (body.cutover === true) {
        // Repeating the guards inside this branch preserves their exact type
        // across TypeScript control flow as well as enforcing the wire check.
        if (!isProfileId(body.fromProfileId) || !isProfileId(body.toProfileId)) {
          return Response.json({ error: 'profile_ids_required_for_cutover' }, { status: 400 });
        }
        cutover = await cutoverMemoryProfile({
          userId: user.id,
          fromMode: body.from,
          toMode: body.to,
          fromProfileId: body.fromProfileId,
          toProfileId: body.toProfileId,
        });
      }
      return Response.json({
        ok: true,
        ...result,
        cutover: cutover
          ? { requested: true, applied: true, ...cutover }
          : { requested: false, applied: false },
      });
    } catch (err) {
      if (err instanceof MemoryProfileCutoverError) {
        return Response.json(
          { error: err.code, message: err.message, ...(err.coverage ? { coverage: err.coverage } : {}) },
          { status: 409 },
        );
      }
      const message = (err as Error).message;
      if (/^reembed_(?:source|target)_profile_mismatch:/.test(message)) {
        return Response.json({ error: 'profile_mismatch', message }, { status: 409 });
      }
      return Response.json(
        { error: 'reembed_failed', message },
        { status: 500 },
      );
    }
  },
});

export default [get, post];
