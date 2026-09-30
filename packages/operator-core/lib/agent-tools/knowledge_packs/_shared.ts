/**
 * knowledge_packs tool-group shared bits (learning-packs-2026-06-11 P-009).
 * Thin: the real logic lives in lib/knowledge-packs/{load-packs,seed,manage}.
 */
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';

export const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

/** Flag gate — OFF hides pack management (KNOWLEDGE_PACKS, default ON). */
export async function knowledgePacksEnabled(): Promise<boolean> {
  try {
    return await getFlag(FLAGS.KNOWLEDGE_PACKS, 'system');
  } catch {
    return true; // flag infra hiccup must not brick the verbs (default-ON flag)
  }
}

export const FLAG_OFF = {
  ok: false,
  reason: 'feature-disabled',
  flag: 'papercusp-knowledge-packs',
  hint: 'Knowledge packs are flagged off — flip papercusp-knowledge-packs in /admin/features.',
};
