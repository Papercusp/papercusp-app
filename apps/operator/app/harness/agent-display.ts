import type { BoundLexicon, TermKey, TermOptions } from '@papercusp/lexicon';

/**
 * Backend role/kind ids are wire contracts and can outlive a public rename.
 * Keep the compatibility aliases here so every frontend surface presents the
 * active lexicon without rewriting stored session data.
 */
const AGENT_TERM_BY_ALIAS: Readonly<Record<string, TermKey>> = {
  mug: 'brain',
  queen: 'brain',
  papercup: 'operator',
  sentinel: 'operator',
  operator: 'operator',
  kettle: 'overwatch',
  overwatch: 'overwatch',
  blender: 'scout',
  scout: 'scout',
  scanner: 'scout',
  cup: 'contributor',
  bee: 'contributor',
};

export function agentTermKey(value: string | null | undefined): TermKey | undefined {
  return value ? AGENT_TERM_BY_ALIAS[value.trim().toLowerCase()] : undefined;
}

/** Resolve a raw role/kind id for display while preserving unknown custom roles. */
export function agentRoleLabel(
  value: string | null | undefined,
  t: BoundLexicon,
  options?: TermOptions,
): string {
  const raw = value?.trim() ?? '';
  const termKey = agentTermKey(raw);
  return termKey ? t(termKey, options) : raw;
}

/**
 * Normalize only system-shaped labels: an exact role alias or aliases in the
 * middle-dot/slash segments emitted by session owners. Arbitrary human labels
 * such as "Queen of QA" deliberately remain untouched.
 */
export function agentDisplayLabel(
  value: string | null | undefined,
  t: BoundLexicon,
): string {
  const raw = value?.trim() ?? '';
  if (!raw) return raw;

  const exact = agentTermKey(raw);
  if (exact) return t(exact);

  if (!raw.includes(' · ') && !raw.includes('/')) return raw;

  return raw
    .split(/( · |\/)/)
    .map((segment) => {
      const termKey = agentTermKey(segment.trim());
      return termKey ? t(termKey) : segment;
    })
    .join('');
}
