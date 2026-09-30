'use client';

/** Operator adapter for the host-free shared card renderer. */
import type { ReactNode } from 'react';
import {
  AskChoiceCard as SharedAskChoiceCard,
  type AskChoiceCardProps,
} from '@papercusp/chat-cards';
import { ReportBlockCard } from './ReportBlockCard';

export type {
  AskChoiceAnswered,
  AskChoiceArgs,
  AskChoiceCardProps,
  AskChoiceOption,
  AskChoiceResponse,
} from '@papercusp/chat-cards';

export function AskChoiceCard(props: AskChoiceCardProps): ReactNode {
  return (
    <SharedAskChoiceCard
      {...props}
      renderReport={(report) => <ReportBlockCard report={report} />}
    />
  );
}
