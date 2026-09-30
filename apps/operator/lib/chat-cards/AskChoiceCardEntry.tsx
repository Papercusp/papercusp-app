/**
 * Registers `chat:ask_choice` with the chat-card registry. Imported
 * for its side effect by `apps/operator/lib/chat-cards/index.ts`.
 *
 * The card itself lives at `app/_components/chat/AskChoiceCard.tsx` —
 * this module is the registry-side glue, kept separate so adding a
 * new card-tool means a new Entry module + an index import, not
 * a touch to every consumer.
 *
 * Plan ref: phase-4-endpoint-system-2026-05-12.md § T2.1.
 */

import { coerceAskChoiceOptions } from '@papercusp/operator-core/lib/ask-choice-options';
import { AskChoiceCard, type AskChoiceArgs, type AskChoiceAnswered } from '@/app/_components/chat/AskChoiceCard';
import { registerCard } from './registry';

type AskChoicePayload = {
  picks: Array<{ option_id: string; label: string }>;
  declined?: boolean;
};

registerCard<AskChoiceArgs>('chat:ask_choice', ({ args, answered, onAnswer }) => {
  if (!args || typeof args !== 'object') return null;
  // Models sometimes stringify the options array (`options: "[{…}]"`) and the
  // persisted turn stores the model's RAW input (operator_turns seq 12076) —
  // parse it here or the card for such a row silently never renders.
  // WI-5175: this coercion is SHARED with the answer path (turn-answer.ts).
  // It used to be inline here only, so the card rendered while the server's
  // uncoerced `(args?.options ?? []).map(...)` 500'd on the click. One helper,
  // both readers — otherwise they drift apart again.
  const options: unknown = coerceAskChoiceOptions(args.options) ?? args.options;
  if (!args.question || !Array.isArray(options) || options.length === 0) {
    // Bad payload — let the consumer's default chip render instead.
    return null;
  }
  return (
    <AskChoiceCard
      args={options === args.options ? args : { ...args, options: options as AskChoiceArgs['options'] }}
      answered={answered as AskChoiceAnswered | undefined}
      onResponse={(response) => {
        if (response.action === 'submit') {
          onAnswer({ picks: response.picks } satisfies AskChoicePayload);
        } else if (response.action === 'decline') {
          onAnswer({ picks: [], declined: true } satisfies AskChoicePayload);
        }
      }}
    />
  );
});
