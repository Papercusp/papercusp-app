/**
 * Test doubles for coord-ops + the program executor. A `FakeCaps` records calls
 * and returns scripted values, so every op + the program walk is unit-testable
 * without PG, the conversation stores, or real agent spawns. (Lives in `lib/` as
 * a `.ts` not `.test.ts` so both the op tests and the workflow tests import it.)
 */
import type { CoordOpCaps, CoordOpCtx, CollectedPost, ResolvedSpawn, SpawnRolesResult, RunProgramInput, ProgramOutcome } from './types.js';

export interface FakeCapsConfig {
  /** Posts `listPosts` returns (a function so a test can mutate over polls). */
  posts?: () => CollectedPost[];
  /** What `spawnRoles` does — defaults to "succeed, append a post per spec". */
  onSpawn?: (specs: ResolvedSpawn[]) => void;
  /** Answer `readAnswer` returns (default: never answered). */
  answer?: () => { answered: boolean; answer: string | null };
  /** What `runProgram` returns (sub-program recursion). */
  onRunProgram?: (input: RunProgramInput) => ProgramOutcome;
}

export interface CallLog {
  openThread: Parameters<CoordOpCaps['openThread']>[0][];
  postThread: Parameters<CoordOpCaps['postThread']>[0][];
  spawnRoles: ResolvedSpawn[][];
  escalate: Parameters<CoordOpCaps['escalate']>[0][];
  subscribe: Parameters<CoordOpCaps['subscribe']>[0][];
  notify: Parameters<CoordOpCaps['notify']>[0][];
  runProgram: RunProgramInput[];
  sleeps: number[];
}

export function makeFakeCaps(cfg: FakeCapsConfig = {}): { caps: CoordOpCaps; calls: CallLog } {
  const calls: CallLog = {
    openThread: [],
    postThread: [],
    spawnRoles: [],
    escalate: [],
    subscribe: [],
    notify: [],
    runProgram: [],
    sleeps: [],
  };
  let postSeq = 0;
  // A mutable in-memory post store the default spawn appends to + listPosts reads.
  let store: CollectedPost[] = [];

  const caps: CoordOpCaps = {
    async openThread(input) {
      calls.openThread.push(input);
      return { thread_id: 'thr-fake', conversation_id: 'conv-fake' };
    },
    async postThread(input) {
      calls.postThread.push(input);
      const post = { id: ++postSeq, author_id: 'self', body: input.body, created_ts: '2026-06-04T00:00:00Z' };
      store.push(post);
      return { post_id: post.id };
    },
    async listPosts() {
      return cfg.posts ? cfg.posts() : store;
    },
    async readAnswer() {
      return cfg.answer ? cfg.answer() : { answered: false, answer: null };
    },
    async spawnRoles(specs) {
      calls.spawnRoles.push(specs);
      if (cfg.onSpawn) cfg.onSpawn(specs);
      return {
        spawned: specs.map((s) => ({ role: s.role, inject: s.inject, ok: true })),
        launched: specs.length,
      } satisfies SpawnRolesResult;
    },
    async escalate(input) {
      calls.escalate.push(input);
      return { msg_id: 'esc-fake' };
    },
    async subscribe(input) {
      calls.subscribe.push(input);
      return { ok: true };
    },
    async notify(input) {
      calls.notify.push(input);
    },
    async runProgram(input) {
      calls.runProgram.push(input);
      return cfg.onRunProgram ? cfg.onRunProgram(input) : { outcome: 'resolve', resolved: true, decision: 'stub' };
    },
    async sleep(ms) {
      calls.sleeps.push(ms);
      // instant — never actually waits in tests
    },
  };
  return { caps, calls };
}

export function makeCtx(caps: CoordOpCaps, over: Partial<CoordOpCtx> = {}): CoordOpCtx {
  let seq = 0;
  return {
    identity: { ownerId: 'caller-1', ownerLabel: 'caller' },
    workspaceId: 'ws-test',
    harnessSlug: 'h-test',
    depth: 0,
    now: () => '2026-06-04T00:00:00Z',
    newId: (p) => `${p}-${++seq}`,
    caps,
    ...over,
  };
}

/** A vote post body in the structured-vote contract. */
export function votePostBody(option: string, confidence: number): string {
  return `Reasoning…\n\`\`\`vote\noption: ${option}\nconfidence: ${confidence}\n\`\`\``;
}
