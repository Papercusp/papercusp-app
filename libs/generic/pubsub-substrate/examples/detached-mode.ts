/**
 * detached-mode.ts — proof-of-genericity for @papercusp/pubsub-substrate.
 *
 * Stands up the substrate with ZERO operator and ZERO Postgres present: it
 * imports only the published package surface (`@papercusp/pubsub-substrate/core`
 * + `/event-log`) and runs the full L3 coordination loop against a throwaway OS
 * temp dir. This is the portability claim (papercusp-systems-abstraction
 * D-004): a detached agent — a session with no Papercusp operator, no PG, not
 * even a git checkout — can still send/receive messages, hand off work,
 * escalate, and emit plan-events purely over the filesystem.
 *
 * It deliberately does NOT import `/presence` (that's the PG seam — the
 * non-portable half, by design). FsCoordLog takes an explicit coordDir,
 * so there is no repo-root / env dependency either.
 *
 * NOTE: this detached FS event-log path is NOT the product path. The
 * operator wires the PG backends exclusively (coord-channels-pg-port-2026-05-30);
 * FsCoordLog survives only as this package's generic portability proof.
 *
 * Run:  npx tsx libs/generic/pubsub-substrate/examples/detached-mode.ts
 * Exits 0 on success (prints a PASS summary), non-zero on any failure.
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

import {
  newMsgId,
  filterInbox,
  foldThread,
  foldHandoffs,
  isHandoffRecord,
  foldEscalations,
  type CoordEnvelope,
  type HandoffRecord,
  type EscalationRecord,
  type EscalationResolvedEvent,
} from '@papercusp/pubsub-substrate/core';
import { FsCoordLog } from '@papercusp/pubsub-substrate/event-log';

const A = 'agent-A';
const B = 'agent-B';

async function main(): Promise<void> {
  // The ONLY ambient dependency: a writable temp dir. No operator, no PG.
  const dir = await fs.mkdtemp(join(tmpdir(), 'coord-detached-'));
  const log = new FsCoordLog({ coordDir: () => dir });
  const steps: string[] = [];

  // ── 1. messages + inbox ─────────────────────────────────────────────
  const m1: CoordEnvelope = {
    ts: new Date().toISOString(), msg_id: newMsgId(),
    from: A, to: [B], kind: 'message', summary: 'hello B',
  };
  await log.appendLine('messages', A, m1);
  await log.appendLine('messages', B, {
    ts: new Date().toISOString(), msg_id: newMsgId(),
    from: B, to: [A], kind: 'message', summary: 'B talking to self-loop',
  });
  const inboxB = filterInbox(await log.readLines('messages'), B);
  assert.deepEqual(inboxB.map((m) => m.summary), ['hello B'], 'B sees only the message addressed to it (own excluded)');
  steps.push('messages → inbox (per-writer outbox, broadcast/own filtering)');

  // ── 2. thread reconstruction via related_msg_id ─────────────────────
  const ack: CoordEnvelope = {
    ts: new Date().toISOString(), msg_id: newMsgId(),
    from: B, to: [A], kind: 'ack', related_msg_id: m1.msg_id,
  };
  await log.appendLine('messages', B, ack);
  const thread = foldThread(await log.readLines('messages'), m1.msg_id);
  assert.deepEqual(thread.map((t) => t.msg_id), [m1.msg_id, ack.msg_id], 'thread walks the related_msg_id chain');
  steps.push('thread fold (related_msg_id graph traversal)');

  // ── 3. handoff + acceptance (per-event files) ───────────────────────
  const h1: HandoffRecord = {
    ts: new Date().toISOString(), msg_id: newMsgId(),
    from: A, to: [B], kind: 'handoff', plan_slug: 'demo-2026-05-30', summary: 'phase 1 done',
    next_action: 'do phase 2',
  };
  await log.putEvent('handoffs', h1.msg_id, h1);
  const acc: HandoffRecord = {
    ts: new Date().toISOString(), msg_id: newMsgId(),
    from: B, to: [A], kind: 'handoff_accepted', related_msg_id: h1.msg_id,
    plan_slug: h1.plan_slug, summary: 'on it',
  };
  await log.putEvent('handoffs', acc.msg_id, acc);
  const handoffs = foldHandoffs((await log.readEvents('handoffs')).filter(isHandoffRecord));
  assert.equal(handoffs.length, 1, 'one handoff');
  assert.equal(handoffs[0].accepted_by?.msg_id, acc.msg_id, 'handoff paired with its acceptance');
  assert.equal(foldHandoffs((await log.readEvents('handoffs')).filter(isHandoffRecord), { status: 'open' }).length, 0, 'no open handoffs after acceptance');
  steps.push('handoff + accept (sibling-event fold)');

  // ── 4. escalation open + APPEND-ONLY resolve (P-012) ────────────────
  const e1: EscalationRecord = {
    ts: new Date().toISOString(), msg_id: newMsgId(),
    from: A, to: ['human'], kind: 'escalation', severity: 'blocker',
    summary: 'need a human call', resolved: null,
  };
  await log.putEvent('escalations', e1.msg_id, e1);
  // capture the open record's bytes BEFORE resolving
  const openPath = join(dir, 'escalations', `${e1.msg_id}.json`);
  const openBytesBefore = await fs.readFile(openPath, 'utf8');

  // resolve = append a SIBLING escalation_resolved event; never mutate the open file
  const rev: EscalationResolvedEvent = {
    ts: new Date().toISOString(), msg_id: newMsgId(),
    from: 'human', to: [e1.from], kind: 'escalation_resolved',
    related_msg_id: e1.msg_id, choice: 'go', by: 'human', note: 'approved',
  };
  await log.putEvent('escalations', rev.msg_id, rev);

  // the open record is byte-for-byte unchanged (append-only invariant)
  assert.equal(await fs.readFile(openPath, 'utf8'), openBytesBefore, 'open escalation file is immutable');

  // state is DERIVED by folding the resolve over the opens
  const all = await log.readEvents('escalations');
  const opens = all.filter((r) => r.kind === 'escalation') as EscalationRecord[];
  const resolves = all.filter((r) => r.kind === 'escalation_resolved') as EscalationResolvedEvent[];
  const resolved = foldEscalations(opens, resolves, { status: 'resolved' });
  assert.equal(resolved.length, 1, 'one resolved escalation');
  assert.equal(resolved[0].resolved?.choice, 'go', 'folded resolution carries the choice');
  assert.equal(foldEscalations(opens, resolves, { status: 'open' }).length, 0, 'no open escalations remain');
  steps.push('escalation open + append-only resolve fold (P-012)');

  // ── 5. plan-events (rotated append stream) ──────────────────────────
  for (const [slug, event] of [['demo-2026-05-30', 'created'], ['demo-2026-05-30', 'now_updated'], ['other', 'created']] as const) {
    await log.appendLine('plan-events', 'system', {
      ts: new Date().toISOString(), msg_id: newMsgId(),
      from: 'system', to: ['*'], kind: 'plan_event', plan_slug: slug, event,
    });
  }
  const demoEvents = (await log.readLines('plan-events')).filter((l) => l.plan_slug === 'demo-2026-05-30');
  assert.equal(demoEvents.length, 2, 'plan-events appended + read back, filtered by slug');
  steps.push('plan-events (append stream + filter)');

  // ── done ────────────────────────────────────────────────────────────
  await fs.rm(dir, { recursive: true, force: true });
  console.log('✅ @papercusp/pubsub-substrate detached-mode proof PASSED');
  console.log(`   zero operator, zero Postgres — pure FsCoordLog over a temp dir`);
  for (const s of steps) console.log(`   ✓ ${s}`);
}

main().catch((err) => {
  console.error('❌ detached-mode proof FAILED');
  console.error(err);
  process.exit(1);
});
