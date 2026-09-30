/**
 * mock-org-pg.ts — the ONE sanctioned partial stand-in for `getOrgPg()` in unit tests.
 *
 * ## Why this exists
 *
 * `getOrgPg()` returns the full postgres client. Unit tests across operator-core drive
 * exactly one member of it — the `sql` tagged-template function — so every one of them
 * installed the same partial stand-in by hand:
 *
 *     vi.mocked(getOrgPg).mockReturnValue({ sql: mockSql } as never);   // or `as any`
 *
 * That line appeared **25 times across 6 files**. Each copy is an independent, silent,
 * undocumented exception, and `as never` / `as any` defeats the mock setter's type check
 * *completely*: the argument becomes assignable to any signature at all, so the fixture
 * could be pointed at the wrong mock entirely and tsc would not object.
 *
 * ## What this helper does and does NOT buy you
 *
 * Be precise about this, because the honest claim is narrower than the occurrence count
 * suggests:
 *
 * - ✅ The cast goes through the REAL `ReturnType<typeof getOrgPg>` instead of `any`/`never`,
 *   so the mock setter's own type check stays live. Verified: a value cast to the wrong
 *   type still fails at the setter with TS2345 — only `as any`/`as never` suppress that.
 *   You therefore cannot hand this stand-in to a mock that does not return an org pg.
 * - ✅ The exception is stated ONCE, here, with a reason — instead of 25 silent copies.
 * - ✅ If `getOrgPg`'s return type is ever replaced outright, this one site breaks loudly
 *   rather than 25 sites continuing to compile against a type that no longer applies.
 * - ❌ It does NOT type-check the `sql` stand-in you pass. That parameter is `unknown` on
 *   purpose — see the comment on it. Two narrower signatures were tried and both rejected
 *   real, correct fixtures, and since the object is asserted to `OrgPg` on the very next
 *   line, a narrower parameter would have bought the APPEARANCE of checking, not checking.
 * - ❌ It does NOT make those 25 fixtures fully type-safe. The stand-in is still PARTIAL —
 *   `{ sql }` is not a complete client — and that remains asserted by hand, here.
 *   Consolidation reduces `check-mock-cast-escape.mjs`'s count by 24, but only one of the
 *   24 is a genuine soundness gain; the rest is de-duplication. Do not read the ratchet
 *   dropping as "25 fixtures got typed".
 *
 * The consolidation does improve the ratchet's SIGNAL, which is the real point: a future
 * test that needs an org-pg stand-in now calls this helper (no new occurrence, correctly),
 * leaving `check-mock-cast-escape.mjs` free to fire only on someone hand-rolling a genuinely
 * NEW `as never` escape — which is the drift it exists to catch.
 *
 * ## Usage
 *
 *     import { mockOrgPgSql } from '../testing/mock-org-pg';
 *
 *     const mockSql = vi.fn().mockResolvedValue(rows);
 *     mockOrgPgSql(vi.mocked(getOrgPg), mockSql);       // was: .mockReturnValue({ sql: mockSql } as never)
 *
 * `vi.mocked(...)` stays at the CALL SITE on purpose: this module imports nothing from
 * vitest at runtime (type-only imports throughout), so it never pulls the test runner into
 * a bundle, and the caller keeps an explicit, greppable link to the mock it is installing.
 *
 * If your test drives a member of the client OTHER than `sql`, do not widen this helper
 * with a second escape — build the fixture your test actually needs and type it.
 */
import type { Mock } from 'vitest';
import type { getOrgPg } from '@papercusp/db-org';

/** The real return type of `getOrgPg()` — the full postgres client. */
type OrgPg = ReturnType<typeof getOrgPg>;

/**
 * Install a `getOrgPg` mock whose only exercised member is `.sql`.
 *
 * @param mockedGetOrgPg the mock, e.g. `vi.mocked(getOrgPg)`
 * @param sql            the stand-in tagged-template fn, e.g. `vi.fn().mockResolvedValue(rows)`
 */
export function mockOrgPgSql(
  mockedGetOrgPg: Mock,
  // `unknown`, deliberately, after two narrower attempts FAILED against real fixtures:
  //   `Mock`                            -> TS2345, arg was 'Mock<Constructable | Procedure>'
  //   `(...args: never[]) => unknown`   -> TS2345, same arg
  // The callers declare their stand-in as `ReturnType<typeof vi.fn>`, i.e. an
  // UNPARAMETERISED `Mock<Constructable | Procedure>`. Because that type argument is a
  // union carrying a CONSTRUCT signature, TypeScript cannot reduce it to one call
  // signature, so it satisfies no callable type — including the permissive one above.
  // Widening here is honest rather than lazy: the object is asserted to `OrgPg` on the
  // next line regardless, so a narrower parameter would buy no real checking, only the
  // appearance of it. See the "does NOT buy you" list in the module doc.
  sql: unknown,
): void {
  // The single, deliberate partial-stand-in assertion — see the module doc above.
  mockedGetOrgPg.mockReturnValue({ sql } as unknown as OrgPg);
}
