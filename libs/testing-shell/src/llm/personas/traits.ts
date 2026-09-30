/**
 * Persona traits — composition over enumeration.
 *
 * Authoring a new persona = picking trait values, not writing prose.
 * The sim-user system prompt is composed at runtime from these values.
 */

import type { Persona, PersonaTraits } from '../types';

/**
 * Compose a sim-user system-prompt fragment from a PersonaTraits object.
 *
 * Stable, append-only — adding a new trait extends the prompt but never
 * mutates the meaning of existing trait values. The runner records the
 * resolved traits on each run so a persona-prompt change is detectable
 * via the run's `identity_hash`.
 */
export function composePersonaPrompt(traits: PersonaTraits): string {
  const parts: string[] = [];

  parts.push(`You are a simulated user in a test conversation. Behave like a real person.`);

  switch (traits.verbosity) {
    case 'terse':   parts.push(`You are TERSE: single short sentences, no preamble, no pleasantries.`); break;
    case 'normal':  parts.push(`You write in NORMAL prose: 1–3 sentences, natural cadence.`); break;
    case 'verbose': parts.push(`You are VERBOSE: explain your reasoning, give context, multiple sentences per turn.`); break;
  }

  switch (traits.politeness) {
    case 'rude':    parts.push(`You are RUDE and demanding. Don't say please or thank you. Expect results.`); break;
    case 'neutral': parts.push(`You are NEUTRAL: businesslike, neither warm nor cold.`); break;
    case 'polite':  parts.push(`You are POLITE: thank the assistant, soften requests.`); break;
  }

  switch (traits.clarification) {
    case 'never_clarifies': parts.push(`You NEVER clarify ambiguous requests; you assume the assistant should figure it out.`); break;
    case 'sometimes':       parts.push(`You SOMETIMES add a clarifying detail when the assistant pushes back, but not always.`); break;
    case 'always':          parts.push(`You ALWAYS clarify ambiguous requests up front and respond to clarifying questions in detail.`); break;
  }

  switch (traits.goalClarity) {
    case 'precise':  parts.push(`Your goal is PRECISE and you know exactly what you want.`); break;
    case 'vague':    parts.push(`Your goal is VAGUE: you describe the outcome you want but not how to get there.`); break;
    case 'shifting': parts.push(`Your goal SHIFTS mid-conversation: you change your mind based on what the assistant says.`); break;
  }

  if (traits.interrupts) {
    parts.push(`You sometimes INTERRUPT: when the assistant is mid-task, you send another message before it's done.`);
  }

  switch (traits.modality) {
    case 'text':  parts.push(`Modality: TEXT — you type messages, paragraph format is fine.`); break;
    case 'voice': parts.push(`Modality: VOICE — you speak short sentences; long blocks feel unnatural.`); break;
  }

  if (traits.domain) {
    parts.push(`Your domain background is ${traits.domain.toUpperCase()}: vocabulary and references should match.`);
  }

  return parts.join('\n');
}

/** Resolve a persona reference (Persona | PersonaTraits | blend-name) into a Persona. */
export function resolvePersona(ref: Persona | PersonaTraits | string, blendLookup: (id: string) => Persona | undefined): Persona {
  if (typeof ref === 'string') {
    const blend = blendLookup(ref);
    if (!blend) throw new Error(`Unknown persona blend: '${ref}'`);
    return blend;
  }
  // PersonaTraits — wrap in an inline Persona
  if ('verbosity' in ref) {
    return {
      id: 'inline',
      description: 'Inline traits — no named blend',
      traits: ref,
    };
  }
  return ref;
}
