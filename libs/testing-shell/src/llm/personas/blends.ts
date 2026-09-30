/**
 * Named persona blends — convenience aliases over PersonaTraits.
 *
 * Scenarios can reference `'brief-admin'` instead of inlining the traits
 * object. Authors of new scenarios should override traits inline when
 * they need fine-grained variance; blends exist for the common cases.
 */

import type { Persona } from '../types';

export const BRIEF_ADMIN: Persona = {
  id: 'brief-admin',
  description: 'Busy admin who asks short, precise questions and expects efficient answers.',
  traits: {
    verbosity: 'terse',
    politeness: 'neutral',
    clarification: 'never_clarifies',
    goalClarity: 'precise',
    interrupts: false,
    modality: 'text',
    domain: 'admin',
  },
};

export const PATIENT_ADMIN: Persona = {
  id: 'patient-admin',
  description: 'Admin who explains context and tolerates multi-step investigation.',
  traits: {
    verbosity: 'normal',
    politeness: 'polite',
    clarification: 'sometimes',
    goalClarity: 'precise',
    interrupts: false,
    modality: 'text',
    domain: 'admin',
  },
};

export const ADVERSARIAL: Persona = {
  id: 'adversarial',
  description: 'Dev who shifts requirements mid-conversation and demands exhaustive enumeration.',
  traits: {
    verbosity: 'verbose',
    politeness: 'rude',
    clarification: 'always',
    goalClarity: 'shifting',
    interrupts: false,
    modality: 'text',
    domain: 'dev',
  },
};

export const VOICE_USER: Persona = {
  id: 'voice-user',
  description: 'Voice-mode admin who speaks short sentences and answers cards by voice.',
  traits: {
    verbosity: 'normal',
    politeness: 'neutral',
    clarification: 'sometimes',
    goalClarity: 'vague',
    interrupts: false,
    modality: 'voice',
    domain: 'admin',
  },
};

export const HOSTILE: Persona = {
  id: 'hostile',
  description: 'Frustrated user who interrupts mid-turn and never clarifies.',
  traits: {
    verbosity: 'terse',
    politeness: 'rude',
    clarification: 'never_clarifies',
    goalClarity: 'vague',
    interrupts: true,
    modality: 'text',
  },
};

export const PEDANTIC_DEV: Persona = {
  id: 'pedantic-dev',
  description: 'Engineer who asks for full reasoning and corrects imprecise language.',
  traits: {
    verbosity: 'verbose',
    politeness: 'neutral',
    clarification: 'always',
    goalClarity: 'precise',
    interrupts: false,
    modality: 'text',
    domain: 'dev',
  },
};

export const BLENDS: ReadonlyArray<Persona> = [
  BRIEF_ADMIN,
  PATIENT_ADMIN,
  ADVERSARIAL,
  VOICE_USER,
  HOSTILE,
  PEDANTIC_DEV,
];

export function lookupBlend(id: string): Persona | undefined {
  return BLENDS.find((b) => b.id === id);
}
