# @papercusp/decision-model

A provider-agnostic client for **typed decision models**. These models never write text. They answer
typed questions about a piece of `state` with probabilities. First adapter: TypeSafe **Jev**
(`POST https://api.typesafe.ai/v1/systemone`), pinned to `jev-1.13.0`.

```ts
import { createDecisionClient, createJevProvider, configureDecisionModel, decide } from '@papercusp/decision-model';

configureDecisionModel(createDecisionClient({
  provider: createJevProvider(),
  resolveKey: () => loadKeyFromYourSecretStore(),   // null ⇒ inconclusive('no-key'), nothing sent
  timeoutMs: 400,                                   // ONE deadline, retries included
  onCall: (record) => writeAuditRow(record),        // fire-and-forget, never awaited
}));

const out = await decide({
  state: { query, memory },
  questions: {
    relevant: { type: 'yesNo', instructions: 'Would \`memory\` help answer \`query\`?' },
    kind: { type: 'choice', instructions: 'What is \`memory\`?', options: { fact: null, preference: null, noise: 'Chatter or a stale status line' } },
  },
}, { consumer: 'memory-injection' });

if (out.kind === 'inconclusive') return fallbackToTodaysBehaviour(out.reason);
out.answers.relevant.pYes;          // number
out.answers.kind.choice;            // 'fact' | 'preference' | 'noise'
```

## Contract

- **Fail open, never silently.** No key, 401, 422, 429/529 after retries, a timeout, a network fault
  or a malformed body all return `{ kind: 'inconclusive', reason }`. `decide` does not throw for these.
- **All or nothing.** An `answered` outcome answers EVERY asked question with its asked type. A 2xx
  body that misses a question, names an unasked option, or has probabilities that do not sum to 1 is
  `malformed-response`.
- **Pinned model.** The adapter sends a versioned id, never `jev-latest`, and the outcome records the
  model id the provider says answered.
- **`confidence` is a margin, not P(correct).** Yes/no answers carry no confidence at all.

## Why not the TypeSafe SDK

The official SDK would couple this generic library to one vendor, and its built-in retry policy runs
outside our single deadline. The wire contract is a single JSON POST, so the adapter is ~150 lines and
fully testable against recorded fixtures.
