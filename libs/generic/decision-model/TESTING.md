# Testing — @papercusp/decision-model

```bash
npm run test:file -- libs/generic/decision-model/src/client.test.ts
```

Vitest unit tests against RECORDED FIXTURES (the response shapes from https://docs.typesafe.ai/api.md).
No test makes a live network call: `fetch`, `sleep` and `random` are injected.

## Falsifiability controls live in the test file, permanently

`src/client.test.ts` keeps a deliberately-lenient parser (`lenientParse`) beside the real adapter. It
accepts a partially-answered body. The same assertion that proves the real parser rejects such a body
is run against the lenient one and must fail, so the "all or nothing" guard is demonstrably able to
catch the bug it exists for. Do not prove falsifiability by mutating `src/jev.ts` in place: this tree
is swept and committed by git-sync on a schedule.
