#!/usr/bin/env node
/** R-3 live self drill. Uses the production hook and its ACK-on-emission ledger.
 * Run in the observing Codex session with PAPERCUSP_OPERATOR_URL pointing at the
 * current build. Hook context is emitted on stdout; do not discard that stream.
 * Evidence is written to R3_OUT. Never treats a zero transport exit as applied.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { resolveScriptPgUrl } from './lib/pg-url.mjs';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';

export function assertAppliedActivation(snapshot, events, afterId, ideate) {
  const activation = snapshot?.activation;
  const generation = Number(snapshot?.generation);
  if (activation?.status !== 'applied' || !Number.isSafeInteger(generation) || generation < 1 ||
      Number(snapshot.delivered) !== generation ||
      !activation.desired?.specificationRevision || !activation.desired?.stateRevision ||
      activation.applied?.specificationRevision !== activation.desired.specificationRevision ||
      activation.applied?.stateRevision !== activation.desired.stateRevision) {
    throw new Error('R3 requires confirmed applied state at the current generation');
  }
  const current = events.filter((event) => Number(event.id) > afterId && Number(event.control_generation) === generation);
  let previous = afterId;
  for (const phase of ['desired', 'prepared', 'applied']) {
    const event = current.find((row) => row.phase === phase && Number(row.id) > previous);
    if (!event || event.actor_id !== event.owner_id || !event.principal_id || !event.adv_session_id ||
        event.specification_revision !== activation.desired.specificationRevision ||
        event.state_revision !== activation.desired.stateRevision ||
        !Array.isArray(event.stack_refs) || event.stack_refs.includes('ideation:su.mode-ideate') !== ideate) {
      throw new Error(`R3 lacks an ordered, attributed ${phase} receipt for the expected stack`);
    }
    previous = Number(event.id);
  }
  return generation;
}

export function requireHookContext(output, allowEmpty = false) {
  // Confirmation may have no new text: the server still consumes the prior
  // delivery token. Only the subsequent activation receipt proves success.
  if (allowEmpty && !output.trim()) return null;
  let payload;
  try { payload = JSON.parse(output); } catch { /* fail closed below */ }
  const text = payload?.hookSpecificOutput?.additionalContext;
  if (payload?.hookSpecificOutput?.hookEventName !== 'UserPromptSubmit' || typeof text !== 'string' || !text.trim()) {
    throw new Error('R3 production hook emitted no turn-start context');
  }
  return text;
}

export async function main() {
  const owner = process.env.PAPERCUSP_SID;
  if (!owner) throw new Error('PAPERCUSP_SID required: drill acts only on its invoking session');
  const workspace = process.env.PAPERCUSP_WORKSPACE || 'papercusp-workspace';
  const base = new URL(process.env.PAPERCUSP_OPERATOR_URL || 'http://127.0.0.1:3170');
  if (!['localhost', '127.0.0.1'].includes(base.hostname) || !base.port || base.port === '3070') {
    throw new Error('R3 requires an explicit local current-build operator, not the release');
  }
  const out = resolve(process.env.R3_OUT || `/tmp/p015-r3-${Date.now()}`);
  mkdirSync(out, { recursive: true });
  const sql = postgres(resolveScriptPgUrl().url, { max: 1, connect_timeout: 10, idle_timeout: 2, onnotice: () => {} });
  const evidence = { schemaVersion: 'p015-r3-live-hook-v1', status: 'running', owner, workspace,
    operator: base.origin, startedAt: new Date().toISOString(), hook: 'apps/operator/scripts/hooks/inject/index.mjs',
    delivery: 'production Codex hook stdout, followed by production ledger confirmation', steps: [] };
  let restore = false;
  const snapshot = async () => (await sql`
    SELECT control_generation AS generation, control_delivered_generation AS delivered,
           control_state->'activation' AS activation, control_state->'modes' AS modes
    FROM harness_shared.session_briefs WHERE owner_id=${owner} AND workspace_id=${workspace}`)[0];
  const events = async (floor) => sql`
    SELECT id, control_generation, phase, source, stack_refs, specification_revision,
           state_revision, adv_session_id, actor_id, owner_id, principal_id, recorded_at
    FROM harness_shared.session_identity_activation_events
    WHERE owner_id=${owner} AND workspace_id=${workspace} AND id>${floor} ORDER BY id`;
  const call = (name, args, label) => {
    const output = execFileSync(process.execPath, ['scripts/mcp-call.mjs', name, '--json', '-',
      '--client', owner, '--workspace', workspace, '--port', base.port], {
      input: JSON.stringify(args), encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
    });
    writeFileSync(resolve(out, `${label}.json`), output);
    // mcp-call fails on tool errors. Keep its response for independent audit.
    evidence.steps.push({ label, tool: name, responsePath: resolve(out, `${label}.json`) });
  };
  const hook = (label, allowEmpty = false) => {
    const output = execFileSync(process.execPath, [evidence.hook, '--client=codex', '--event=user-prompt-submit'], {
      input: JSON.stringify({ cwd: process.cwd(), prompt: `R3 live self drill ${label}: deliver current control context` }),
      env: { ...process.env, PAPERCUSP_OPERATOR_URL: base.origin },
      encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
    });
    const context = requireHookContext(output, allowEmpty);
    writeFileSync(resolve(out, `${label}.json`), output);
    process.stdout.write(output);
    evidence.steps.push({ label, emitted: context !== null, path: resolve(out, `${label}.json`) });
  };
  try {
    const initial = await snapshot();
    if (!initial || initial.modes?.includes('ideate')) throw new Error('R3 requires an existing session with ideate initially off');
    evidence.baseline = initial;
    evidence.treeHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const [{ floor }] = await sql`SELECT coalesce(max(id),0) AS floor FROM harness_shared.session_identity_activation_events`;
    evidence.eventFloor = Number(floor);
    for (const enabled of [true, false]) {
      const label = enabled ? 'ideate-on' : 'ideate-off';
      restore = true;
      call('mode:set', { mode: 'ideate', enabled, reason: 'WI-10002713 R3 bounded live acceptance drill' }, label);
      call('coord:orient', { afterCompaction: true }, `${label}-orient`);
      const beforeHook = await snapshot();
      if (beforeHook.activation?.status !== 'desired') throw new Error('R3 orient unexpectedly applied the desired transition');
      hook(`${label}-emit`);
      const prepared = await snapshot();
      if (prepared.activation?.status !== 'prepared') throw new Error('R3 first hook did not leave an unconfirmed prepared candidate');
      hook(`${label}-confirm`, true);
      const applied = await snapshot();
      const receipts = await events(Number(floor));
      assertAppliedActivation(applied, receipts, Number(floor), enabled);
      evidence.steps.push({ label, beforeHook, prepared, applied, receipts });
      call('coord:whoami', {}, `${label}-read-in-span`);
      if (!enabled) restore = false;
    }
    evidence.events = await events(Number(floor));
    const appliedIds = evidence.events.filter((row) => row.phase === 'applied').map((row) => row.id);
    evidence.spans = await sql`SELECT activation_event_id, control_generation, actor_id, principal_id,
      layer_slot, layer_ref, active_from, active_until FROM harness_shared.session_identity_layer_spans
      WHERE owner_id=${owner} AND activation_event_id IN ${sql(appliedIds)} ORDER BY activation_event_id,layer_slot`;
    if (!evidence.spans.some((row) => row.layer_ref === 'ideation:su.mode-ideate' && row.active_until)) {
      throw new Error('R3 missing a closed ideate layer span');
    }
    evidence.status = 'pass';
  } catch (error) {
    evidence.status = 'fail';
    evidence.error = String(error);
    throw error;
  } finally {
    if (restore) {
      try { call('mode:set', { mode: 'ideate', enabled: false, reason: 'R3 failure cleanup: restore original mode' }, 'cleanup'); }
      catch (error) { evidence.cleanupError = String(error); }
    }
    evidence.finishedAt = new Date().toISOString();
    writeFileSync(resolve(out, 'evidence.json'), JSON.stringify(evidence, null, 2));
    await sql.end();
    console.error(JSON.stringify({ status: evidence.status, evidence: resolve(out, 'evidence.json') }));
  }
}

if (isCliEntry(import.meta.url)) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
