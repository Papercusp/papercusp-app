/**
 * Generic conformance suite for FileClaimCoordinator.
 *
 * Any implementation (FileLockQueue adapter, SU-locks adapter, future
 * Redis adapter, …) should pass this suite. Adapters consume it like:
 *
 *   import { describeConformance } from '@papercusp/file-claim/conformance';
 *
 *   describeConformance('FileLockQueue', async () => ({
 *     coordinator: new FileLockQueueCoordinator(),
 *     cleanup: async () => { },
 *   }));
 *
 * The factory is called once per test (NOT per suite) so cases don't
 * cross-contaminate. Adapters with heavy setup can amortise inside
 * cleanup-shared state (e.g. one PG pool per file) and return a fresh
 * logical workspace per call.
 *
 * Excludes from this suite (out of scope — backend-specific):
 *   - TTL expiry tests (in-process coordinator has no TTL).
 *   - Cross-process visibility (only the PG backend has it).
 *   - The reactive grant-cascade (PG-specific bookkeeping).
 *
 * These belong in each backend's own test file. Conformance is the
 * shape every backend MUST satisfy, not every behaviour either ONE
 * may add.
 */

import { describe, expect, it } from 'vitest';
import type { FileClaim, FileClaimCoordinator } from './index';

export interface ConformanceFactory {
  coordinator: FileClaimCoordinator;
  cleanup: () => Promise<void>;
}

export function describeConformance(
  name: string,
  factory: () => Promise<ConformanceFactory>,
): void {
  describe(`${name} — FileClaimCoordinator conformance`, () => {
    async function withCoordinator<T>(
      body: (c: FileClaimCoordinator) => Promise<T>,
    ): Promise<T> {
      const { coordinator, cleanup } = await factory();
      try {
        return await body(coordinator);
      } finally {
        await cleanup();
      }
    }

    async function mustAcquire(
      c: FileClaimCoordinator,
      owner: string,
      paths: readonly string[],
      ownerLabel?: string,
    ): Promise<FileClaim> {
      const r = await c.acquire(owner, paths, {
        waitMs: 0,
        ownerLabel: ownerLabel ?? owner,
      });
      if (!r.ok) {
        throw new Error(
          `acquire failed for ${owner} on ${JSON.stringify(paths)}: ${JSON.stringify(r.busy)}`,
        );
      }
      return r.claim;
    }

    it('acquire on a free path returns a usable claim', async () => {
      await withCoordinator(async (c) => {
        const claim = await mustAcquire(c, 'w1', ['a.ts', 'b.ts']);
        expect(claim.owner).toBe('w1');
        // The implementation MAY sort & dedupe; the conformance contract
        // is that all requested paths are held.
        expect([...claim.paths].sort()).toEqual(['a.ts', 'b.ts']);
        expect(typeof claim.claimId).toBe('string');
        expect(claim.claimId.length).toBeGreaterThan(0);
      });
    });

    it('acquire on a held path returns busy with the holder identified', async () => {
      await withCoordinator(async (c) => {
        await mustAcquire(c, 'w1', ['contended.ts'], 'W1');
        const r = await c.acquire('w2', ['contended.ts'], { waitMs: 0 });
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.busy.length).toBeGreaterThan(0);
        const e = r.busy.find((b) => b.path === 'contended.ts');
        expect(e).toBeTruthy();
        expect(e!.owner).toBe('w1');
      });
    });

    it('release frees the paths for the next acquirer', async () => {
      await withCoordinator(async (c) => {
        const a = await mustAcquire(c, 'w1', ['x.ts']);
        await c.release(a);
        const b = await mustAcquire(c, 'w2', ['x.ts']);
        expect(b.owner).toBe('w2');
      });
    });

    it('release is idempotent (second release is a no-op)', async () => {
      await withCoordinator(async (c) => {
        const a = await mustAcquire(c, 'w1', ['y.ts']);
        await c.release(a);
        await expect(c.release(a)).resolves.toBeUndefined();
      });
    });

    it('empty-path acquire is legal and returns a no-op claim', async () => {
      await withCoordinator(async (c) => {
        const r = await c.acquire('w1', [], { waitMs: 0 });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.claim.paths).toEqual([]);
        await expect(c.release(r.claim)).resolves.toBeUndefined();
      });
    });

    it('extend returns a NEW claim, never mutates the input', async () => {
      await withCoordinator(async (c) => {
        const a = await mustAcquire(c, 'w1', ['p1.ts']);
        const before = [...a.paths];
        const r = await c.extend(a, { addPaths: ['p2.ts'] });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        // Input claim must be unchanged.
        expect([...a.paths]).toEqual(before);
        // New claim covers the union.
        expect([...r.claim.paths].sort()).toEqual(['p1.ts', 'p2.ts']);
      });
    });

    it('extend onto a contended path returns busy without losing the original claim', async () => {
      await withCoordinator(async (c) => {
        const a = await mustAcquire(c, 'w1', ['own.ts']);
        await mustAcquire(c, 'w2', ['blocker.ts'], 'W2');
        const r = await c.extend(a, { addPaths: ['blocker.ts'] });
        expect(r.ok).toBe(false);
        // Original claim should still cover its original path.
        const probe = await c.acquire('w3', ['own.ts'], { waitMs: 0 });
        expect(probe.ok).toBe(false);
      });
    });

    it('reap drops every claim the owner currently holds', async () => {
      await withCoordinator(async (c) => {
        await mustAcquire(c, 'w1', ['r1.ts']);
        await mustAcquire(c, 'w1', ['r2.ts']);
        const dropped = await c.reap('w1');
        expect(dropped).toBeGreaterThanOrEqual(2);
        // After reap, paths are free.
        const probe = await mustAcquire(c, 'w2', ['r1.ts']);
        expect(probe.owner).toBe('w2');
      });
    });

    it('reap of an unknown owner returns 0', async () => {
      await withCoordinator(async (c) => {
        const dropped = await c.reap('never-acquired');
        expect(dropped).toBe(0);
      });
    });

    it('same owner can hold multiple claims with disjoint paths', async () => {
      await withCoordinator(async (c) => {
        const a = await mustAcquire(c, 'w1', ['m1.ts']);
        const b = await mustAcquire(c, 'w1', ['m2.ts']);
        expect(a.claimId).not.toBe(b.claimId);
      });
    });

    it('multi-path acquire is atomic — none held if any blocked', async () => {
      await withCoordinator(async (c) => {
        await mustAcquire(c, 'w1', ['lock.ts'], 'W1');
        const r = await c.acquire('w2', ['free.ts', 'lock.ts'], {
          waitMs: 0,
        });
        expect(r.ok).toBe(false);
        // Nobody should be holding 'free.ts' now — w2's failed multi-
        // path acquire must not have grabbed it partially.
        const probe = await c.acquire('w3', ['free.ts'], { waitMs: 0 });
        expect(probe.ok).toBe(true);
      });
    });
  });
}
