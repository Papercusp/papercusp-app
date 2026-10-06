import type { Sql } from 'postgres';
import { runControlMutation } from '../../gateway-control/control-harness.ts';
import { getPotLearningScope, setPotLearningScope } from '../../learning/pot-gate/store.ts';
import { reconcileRoutineRestore, revertRoutineAudit } from '../../agent-tools/routines/revert.ts';
import { readRoutineSnap, writeRoutineSnap, routineSnapEqual, type RoutineSnap } from '../../agent-tools/routines/routine-snapshot.ts';
import { computeNextFireAt } from '../../harness/routines/cron.ts';

type Receipt = { ok: boolean; applied?: boolean; reverted?: boolean; verify?: { ok: boolean }; auditId?: string };
export type RestorationPorts = {
  disableMaster: () => Promise<Receipt>;
  masterDisabled: () => Promise<boolean>;
  revertRoutine: (auditId: string) => Promise<Receipt>;
};

export function studyRestorationPorts(sql: Sql, workspaceId: string, potSlug: string, ownerId: string): RestorationPorts {
  const read = () => getPotLearningScope(sql, { workspaceId, potSlug });
  return {
    masterDisabled: async () => (await read())?.enabled === false,
    disableMaster: async () => {
      // Cleanup uses the same store + audit harness as learning:set-pot-scope.
      // It must not depend on either HTTP host and must never re-enable learning
      // when a post-write read fails. Keep the error visible for reconciliation.
      const outcome = await runControlMutation({
        action: 'learning:set-pot-scope', subject: potSlug, actor: ownerId,
        capturePrev: async () => ({ [potSlug]: await read() }),
        apply: async () => {
          await setPotLearningScope(sql, { workspaceId, potSlugs: [potSlug], enabled: false, setBy: ownerId });
          return { [potSlug]: await read() };
        },
        revertTo: async () => { throw new Error('Study cleanup cannot re-enable the learning master'); },
        verify: async () => ({ ok: (await read())?.enabled === false }),
      }, { verifyMustPass: false });
      return { ok: outcome.verify?.ok === true, applied: outcome.applied, verify: outcome.verify, auditId: outcome.auditId };
    },
    revertRoutine: (auditId) => revertRoutineAudit({ auditId }, { sql, workspaceId, actor: ownerId }),
  };
}

export async function enableStudyMaster(sql: Sql, workspaceId: string, potSlug: string, ownerId: string) {
  const read = () => getPotLearningScope(sql, { workspaceId, potSlug });
  const outcome = await runControlMutation({
    action: 'learning:set-pot-scope', subject: potSlug, actor: ownerId,
    capturePrev: async () => {
      const prior = await read();
      if (prior?.enabled !== false) throw new Error('Learning master changed after study preflight');
      return { [potSlug]: prior };
    },
    apply: async () => {
      await setPotLearningScope(sql, { workspaceId, potSlugs: [potSlug], enabled: true, setBy: ownerId });
      return { [potSlug]: await read() };
    },
    revertTo: async () => { await setPotLearningScope(sql, { workspaceId, potSlugs: [potSlug], enabled: false, setBy: ownerId }); },
    verify: async () => ({ ok: (await read())?.enabled === true }),
  });
  if (!outcome.applied || outcome.reverted || outcome.verify?.ok !== true || !outcome.auditId)
    throw new Error('Study master enable did not verify with an audit receipt');
  return { ok: true, applied: outcome.applied, auditId: outcome.auditId, verify: outcome.verify };
}

type RoutinePorts = { read: () => Promise<RoutineSnap>; write: (snap: RoutineSnap) => Promise<void>; actor: string; subject: string };

/** Persist the intended inverse BEFORE the first write. The caller retains this
 * object before apply, so a lost/failed apply receipt cannot erase cleanup. */
export async function prepareStudyRoutine(
  ports: RoutinePorts, payload: Record<string, unknown>, log: (entry: unknown) => Promise<void>,
) {
  const before = await ports.read();
  if (before.active) throw new Error('Expected inactive manual Dream routine before study setup');
  const next: RoutineSnap = {
    ...before, active: true, triggerConfig: { ...before.triggerConfig, cron: '0 0 0 1 1 *' },
    // Annual scheduled firing is kept outside this bounded manual study window.
    nextFireAtIso: computeNextFireAt('0 0 0 1 1 *', new Date())?.toISOString() ?? null,
    payloadTemplate: payload,
  };
  await log({ phase: 'routine-restore-prepared', subject: ports.subject, before, next });
  let auditId: string | undefined;
  let attempted = false;
  return {
    apply: async () => {
      attempted = true;
      const outcome = await runControlMutation<RoutineSnap>({
        action: 'routines:set', subject: ports.subject, actor: ports.actor, capturePrev: ports.read,
        apply: async () => {
          if (!routineSnapEqual(await ports.read(), before)) throw new Error('Routine changed after study preflight');
          await ports.write(next);
          return next;
        },
        revertTo: async () => { await ports.write(reconcileRoutineRestore(await ports.read(), before, next)); },
        verify: async () => ({ ok: routineSnapEqual(await ports.read(), next) }),
      });
      auditId = outcome.auditId;
      if (!outcome.applied || outcome.reverted || outcome.verify?.ok !== true || !auditId)
        throw new Error('Study routine setup did not verify with an audit receipt');
      return { ok: true, applied: true, verify: outcome.verify, auditId };
    },
    restore: async () => {
      if (!attempted) return { ok: true, applied: true, verify: { ok: true } };
      const outcome = await runControlMutation<RoutineSnap>({
        action: 'routines:set:revert', subject: ports.subject, actor: ports.actor, revertOf: auditId,
        capturePrev: ports.read,
        apply: async () => {
          const restored = reconcileRoutineRestore(await ports.read(), before, next);
          await ports.write(restored);
          return restored;
        },
        revertTo: async () => { throw new Error('Study cleanup cannot re-enable a routine'); },
        verify: async () => {
          const current = await ports.read();
          return { ok: routineSnapEqual(current, reconcileRoutineRestore(current, before, next)) };
        },
      }, { verifyMustPass: false });
      return { ok: outcome.verify?.ok === true, applied: outcome.applied, verify: outcome.verify, auditId: outcome.auditId };
    },
  };
}

export function studyRoutinePorts(sql: Sql, workspaceId: string, potSlug: string, ownerId: string): RoutinePorts {
  return {
    read: () => readRoutineSnap(sql, workspaceId, potSlug, 'dream-cycle-manual'),
    write: snap => writeRoutineSnap(sql, workspaceId, potSlug, 'dream-cycle-manual', snap),
    actor: ownerId, subject: potSlug + '/dream-cycle-manual',
  };
}

/** Restore every control even when one fails; logging cannot prevent cleanup.
 * An uncertain disable is reconciled by reading the real gate, never by assuming
 * a lost response means the write failed. No paid work runs from this helper. */
export async function restoreStudyControls(
  state: { masterAttempted: boolean; routineAudit?: string; restoreRoutine?: () => Promise<Receipt> },
  ports: RestorationPorts,
  log: (entry: unknown) => Promise<void>,
) {
  const errors: unknown[] = [];
  const receipts: unknown[] = [];
  if (state.masterAttempted) {
    let writeError: unknown;
    try { receipts.push({ master: await ports.disableMaster() }); }
    catch (error) { writeError = error; }
    try {
      if (!(await ports.masterDisabled())) throw new Error('Learning master is not verified OFF');
      if (writeError) receipts.push({ masterResponseError: String(writeError), reconciledDisabled: true });
    } catch (error) { errors.push(...(writeError ? [writeError] : []), error); }
  }
  if (state.routineAudit || state.restoreRoutine) {
    try {
      const receipt = state.restoreRoutine ? await state.restoreRoutine() : await ports.revertRoutine(state.routineAudit!);
      receipts.push({ routine: receipt });
      if (!receipt.ok || !receipt.applied || receipt.reverted || receipt.verify?.ok !== true)
        throw new Error('Routine restoration did not verify');
    } catch (error) { errors.push(error); }
  }
  await log({ phase: 'restoration', success: errors.length === 0, receipts, errors: errors.map(String) });
  if (errors.length) throw new AggregateError(errors, 'Study restoration needs immediate attention');
}
