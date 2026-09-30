import { Coffee, CupSoda, Thermometer } from 'lucide-react';
import type { ComponentType } from 'react';

export type ChatIconComponent = ComponentType<{
  className?: string;
  'aria-hidden'?: boolean;
}>;

/** Canonical marks for known agent identities in owner-facing chat surfaces. */
export const AGENT_MARKS: Record<string, ChatIconComponent> = {
  mug: Coffee,
  kettle: Thermometer,
  papercup: CupSoda,
};
