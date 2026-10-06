/**
 * candidates-shared — the CLIENT-SAFE slice of knowledge-pack candidates.
 *
 * The `KnowledgePackCandidate` shape, its `CandidateStatus`, and the
 * `AUTO_ADOPT_REVIEWER` machine identity are needed by BOTH the server module
 * (`./candidates`) and the client Learnings view
 * (`apps/operator-vite/src/components/adv/KnowledgePackCandidates.tsx`).
 *
 * `./candidates` top-level imports `node:fs` / `node:path` / `@papercusp/db-org`
 * (and, transitively, `sync-sse` → `embedded-pg-discovery`), so a client
 * value-import of ANY symbol from it dragged that whole SERVER subtree into the
 * browser bundle. On the `:3055` Vite dev graph — no tree-shaking, `node:`
 * builtins externalized to stubs that THROW on property access — that
 * white-screened the `/adv` Learnings route ("This view hit an error":
 * `get@__vite-browser-external:node:path` → `module code@embedded-pg-discovery`).
 *
 * This file therefore carries ONLY types + a pure string constant with ZERO
 * node/server imports, so the client imports from HERE instead of `./candidates`.
 * The `import type` below is erased by esbuild → no runtime edge to pack-format.
 */
import type { AppliesTo, LearningKind } from './pack-format';

export type CandidateStatus = 'pending' | 'adopted' | 'dismissed';

/** The machine `by` identity stamped on every auto-decided candidate. */
export const AUTO_ADOPT_REVIEWER = 'fleet-candidate-auto-review';

/** The fleet-curated pack candidate adoption writes into (created on first
 *  adoption). Client-safe: a pure string both the server modules and the /adv
 *  Learnings view need. */
export const FLEET_LESSONS_PACK_ID = 'fleet-lessons';

export interface KnowledgePackCandidate {
  id: string;
  signature: string;
  title: string;
  draftText: string;
  kind: LearningKind;
  appliesTo: AppliesTo[];
  /** Distinct scopes ('operator' | 'harness:<slug>') the signature recurred across. */
  scopes: string[];
  recurrenceCount: number;
  /** Improvement-item ids (EI/WI) the recurrence was observed on. */
  sourceItemIds: string[];
  status: CandidateStatus;
  createdBy: string;
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
  decisionNote?: string;
  packId?: string;
  packItemId?: string;
  /** Explicit identity proposals stay workspace-private until reviewed adoption. */
  workspaceId?: string;
  targetIdentityId?: string;
  targetPackId?: string;
  sourceMemoryId?: string;
}
