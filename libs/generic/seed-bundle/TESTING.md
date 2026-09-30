# Testing — @papercusp/seed-bundle

Pure algorithm + orchestration; unit-tested with **Vitest**, zero I/O, zero mocks
of real substrates (providers are injected `vi.fn()` fakes).

```bash
# from this dir
npx vitest run
# or from repo root
npx vitest run libs/generic/seed-bundle/src/index.test.ts
```

`src/index.test.ts` covers:

- **manifest validation** — every field constraint, all three `source` variants,
  both `keyRef` variants, and each rejection path (bad version, empty ids, negative/
  non-integer epoch, empty stores, missing hash, bad source, invalid encryption).
- **encode/decode** — round-trip, canonical (key-order-independent) JSON, and the
  throw-on-invalid paths for both directions.
- **registry** — register/get/require, duplicate-kind rejection, diagnostic miss.
- **`restoreSeed`** — happy path, missing provider, verify-fail (restore NOT called),
  restore-throws isolation (other stores still run), and invalid-manifest fail-fast.

No integration tests here — the real corestore/git providers (with their two-peer /
fixture integration tests) live next to their substrates (plan P-003 / P-004).
