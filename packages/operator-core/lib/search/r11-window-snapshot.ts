/** Read-only, repeatable-read evidence capture for plan shared-vector-search-libraries P-008 R-11. */
import { createHash } from 'node:crypto';
import { executeGovernedByteProcess } from '../../../../scripts/lib/governed-test-process.mjs';
import type { getOrgPg } from '@papercusp/db-org';
import {
  TARGETS,
  activeRecipeVersion,
  eligiblePredicateSql,
  modeColOf,
  profileColOf,
  recipeColOf,
  stalePredicateSql,
  type BackfillTarget,
} from './embed-backfill';
import { resolveProseProfileSelection } from './prose-vector-dims';

type Sql = ReturnType<typeof getOrgPg>['sql'];
type Profile = Parameters<typeof resolveProseProfileSelection>[1];
export type R11Stage = 'preflight' | 'T0' | 'Tcut' | 'T1';
export interface R11Row { key: string; stale: boolean; recency: string | null }
export interface R11TargetSnapshot {
  table: string;
  embedCol: string;
  keyCols: string[];
  predicateHash: string;
  rows: R11Row[];
}
export interface R11Snapshot {
  stage: R11Stage;
  capturedAt: string;
  mode: string;
  profileId: string;
  targets: R11TargetSnapshot[];
}

export interface R11TimerSpec {
  stage: 'Tcut' | 'T1';
  unit: string;
  at: string;
}

/** Build the exact user timer command, including each stage's frozen inputs. */
export function buildR11SystemdRunArgs(
  spec: R11TimerSpec,
  paths: { t0: string; cut: string; t1: string },
  runtime: { repoRoot: string; tsx: string; script: string },
): string[] {
  const args = spec.stage === 'Tcut'
    ? ['Tcut', paths.cut, paths.t0]
    : ['T1', paths.t1, paths.t0, paths.cut];
  return ['--user', `--unit=${spec.unit}`, `--on-calendar=${spec.at}`,
    '--timer-property=AccuracySec=1s', `--working-directory=${runtime.repoRoot}`,
    '/usr/bin/bash', '-c', 'set -a; . ./apps/operator/.env.local; set +a; exec "$@"',
    'r11-capture', runtime.tsx, runtime.script, ...args];
}

/** Freeze both one-shot deadlines from the database timestamp in the T0 receipt. */
export function buildR11TimerSpecs(t0: R11Snapshot): [R11TimerSpec, R11TimerSpec] {
  if (t0.stage !== 'T0') throw new Error('Timer scheduling requires a T0 snapshot');
  const start = Date.parse(t0.capturedAt);
  if (!Number.isFinite(start)) throw new Error('T0 has an invalid database timestamp');
  const stamp = Math.floor(start / 1000);
  const format = (offsetMs: number) => `${new Date(start + offsetMs).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
  return [
    { stage: 'Tcut', unit: `r11-p008-tcut-${stamp}`, at: format((24 * 60 - 10) * 60_000) },
    { stage: 'T1', unit: `r11-p008-t1-${stamp}`, at: format(24 * 60 * 60_000) },
  ];
}

/** Arm each frozen timer through the maintained process receipt and roll back on failure. */
export async function scheduleR11Timers(
  specs: readonly R11TimerSpec[],
  paths: Parameters<typeof buildR11SystemdRunArgs>[1],
  runtime: Parameters<typeof buildR11SystemdRunArgs>[2],
  dryRun = false,
  executeProcess: typeof executeGovernedByteProcess = executeGovernedByteProcess,
) {
  const armed: string[] = [];
  const timers: Array<R11TimerSpec & { show?: string; command?: string[] }> = [];
  const run = async (executable: string, args: string[]) => {
    const result = await executeProcess(executable, args, new Uint8Array(), {
      namespace: 'r11-window-snapshot', timeoutMs: 30_000, maxBuffer: 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
      throw new Error(`${executable} failed (${result.error?.code ?? result.signal ?? result.status}): ${result.stderr}`);
    }
    return result.stdout;
  };
  try {
    for (const spec of specs) {
      const command = buildR11SystemdRunArgs(spec, paths, runtime);
      if (dryRun) {
        timers.push({ ...spec, command });
        continue;
      }
      await run('systemd-run', command);
      armed.push(`${spec.unit}.timer`);
      const show = await run('systemctl', ['--user', 'show', `${spec.unit}.timer`,
        '-p', 'ActiveState', '-p', 'NextElapseUSecRealtime', '-p', 'Unit']);
      if (!show.includes('ActiveState=active') || !show.includes(`Unit=${spec.unit}.service`)) {
        throw new Error(`Timer ${spec.unit} was not armed: ${show}`);
      }
      timers.push({ ...spec, show });
    }
  } catch (error) {
    for (const unit of armed) {
      try { await run('systemctl', ['--user', 'stop', unit]); } catch { /* preserve the first error */ }
    }
    throw error;
  }
  return timers;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** Uses the same target registry and eligibility/staleness builders as the live sweep. */
export function buildR11TargetQuery(
  target: BackfillTarget,
  columns: Set<string>,
  mode: string,
  profile: Profile,
): { query: string; params: Array<string | number>; predicateHash: string } {
  for (const col of [target.embedCol, ...target.keyCols]) {
    if (!columns.has(col)) throw new Error(`${target.table}: missing required column ${col}`);
  }
  const spaceAware = columns.has(modeColOf(target));
  const profileAware = columns.has(profileColOf(target));
  const recipeVersion = activeRecipeVersion(target, columns.has(recipeColOf(target)));
  const selection = profileAware ? resolveProseProfileSelection(mode, profile) : null;
  if (profileAware && !selection) throw new Error(`${target.table}: incompatible profile ${profile.profileId}`);

  const params: Array<string | number> = [];
  const bind = (value: string | number) => { params.push(value); return `$${params.length}`; };
  const modeExpr = spaceAware ? bind(mode) : 'NULL';
  const profileExpr = selection ? bind(selection.profileId) : null;
  const recipeExpr = recipeVersion === null ? null : bind(recipeVersion);
  const stale = stalePredicateSql(target, spaceAware, modeExpr, recipeExpr,
    selection ? { profileExpr: profileExpr!, legacyModeCompatible: selection.legacyMode === mode } : undefined);
  const eligible = eligiblePredicateSql(target);
  const key = `jsonb_build_array(${target.keyCols.join(', ')})::text`;
  const recency = target.recencyCol && columns.has(target.recencyCol)
    ? `${target.recencyCol}::text` : 'NULL::text';
  const query = `SELECT ${key} AS row_key, (${stale}) AS stale, ${recency} AS recency
    FROM ${target.table} WHERE ${eligible} ORDER BY ${target.keyCols.join(', ')}`;
  return { query, params, predicateHash: sha256(JSON.stringify({ query, mode, profileId: profile.profileId, params })) };
}

export function selectR11StageRows(
  stage: R11Stage, current: R11Row[], t0?: R11Row[], cut?: R11Row[],
): R11Row[] {
  if (stage === 'Tcut') {
    if (!t0) throw new Error('Tcut requires the frozen T0 keys');
    const old = new Set(t0.map((row) => row.key));
    return current.filter((row) => !old.has(row.key));
  }
  if (stage === 'T1') {
    if (!t0 || !cut) throw new Error('T1 requires the frozen T0 and Tcut cohorts');
    const cohort = new Set([...t0.filter((row) => row.stale), ...cut].map((row) => row.key));
    return current.filter((row) => cohort.has(row.key));
  }
  return current;
}

export async function captureR11Snapshot(
  sql: Sql, stage: R11Stage, resolved: { mode: string; profile: Profile },
  prior: { t0?: R11Snapshot; cut?: R11Snapshot } = {},
): Promise<R11Snapshot> {
  return sql.begin(async (tx) => {
    await tx.unsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const clock = await tx.unsafe<Array<{ captured_at: Date | string }>>('SELECT transaction_timestamp() AS captured_at');
    const capturedAt = clock[0]?.captured_at ? new Date(clock[0].captured_at).toISOString() : null;
    if (!capturedAt) throw new Error('Postgres transaction timestamp unavailable');
    const targets: R11TargetSnapshot[] = [];
    for (const target of TARGETS) {
      const [schema, table] = target.table.split('.');
      if (!schema || !table) throw new Error(`Invalid target table: ${target.table}`);
      const found = await tx.unsafe<Array<{ column_name: string }>>(
        'SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2',
        [schema, table],
      );
      const { query, params, predicateHash } = buildR11TargetQuery(
        target, new Set(found.map((row) => row.column_name)), resolved.mode, resolved.profile,
      );
      const rows = await tx.unsafe<Array<{ row_key: string; stale: boolean; recency: string | null }>>(query, params);
      const priorTarget = (snapshot?: R11Snapshot) => {
        const match = snapshot?.targets.find((entry) => entry.table === target.table && entry.embedCol === target.embedCol);
        if (snapshot && !match) throw new Error(`${target.table}: target absent from prior snapshot`);
        return match;
      };
      const current = rows.map((row) => ({ key: row.row_key, stale: row.stale, recency: row.recency }));
      targets.push({
        table: target.table,
        embedCol: target.embedCol,
        keyCols: [...target.keyCols],
        predicateHash,
        rows: selectR11StageRows(stage, current, priorTarget(prior.t0)?.rows, priorTarget(prior.cut)?.rows),
      });
    }
    return { stage, capturedAt, mode: resolved.mode, profileId: resolved.profile.profileId, targets };
  });
}

export interface R11TargetResult {
  table: string;
  t0Stale: number;
  t0Retained: number;
  t0Embedded: number;
  inWindowEligible: number;
  inWindowRetained: number;
  inWindowEmbedded: number;
  passed: boolean;
}

/** Pure cutoff comparison. A removed/re-scoped row is absent from T1's eligible map. */
export function evaluateR11Snapshots(t0: R11Snapshot, cut: R11Snapshot, t1: R11Snapshot): {
  verdict: 'healthy' | 'failed' | 'inconclusive';
  targets: R11TargetResult[];
  reason: string;
} {
  if (t0.stage !== 'T0' || cut.stage !== 'Tcut' || t1.stage !== 'T1') throw new Error('Wrong snapshot stage order');
  const targetIds = (s: R11Snapshot) => s.targets.map((t) => `${t.table}.${t.embedCol}`).join('|');
  if (targetIds(t0) !== targetIds(cut) || targetIds(t0) !== targetIds(t1)) throw new Error('TARGETS changed during window');
  if (t0.targets.some((target, i) => target.predicateHash !== cut.targets[i]!.predicateHash ||
      target.predicateHash !== t1.targets[i]!.predicateHash)) {
    return { verdict: 'inconclusive', targets: [], reason: 'A target predicate or embedding profile changed during the window' };
  }
  const start = Date.parse(t0.capturedAt);
  const cutAt = Date.parse(cut.capturedAt);
  const endAt = Date.parse(t1.capturedAt);
  const cutOffset = cutAt - start;
  const endOffset = endAt - start;
  if (![start, cutAt, endAt].every(Number.isFinite) || cutAt <= start || endAt <= cutAt ||
      Math.abs(cutOffset - (24 * 60 - 10) * 60_000) > 60_000 ||
      Math.abs(endOffset - 24 * 60 * 60_000) > 60_000) {
    return { verdict: 'inconclusive', targets: [], reason: 'A cutoff capture missed its predeclared deadline by over 60 seconds' };
  }
  const targets = t0.targets.map((startTarget, i): R11TargetResult => {
    const cutTarget = cut.targets[i]!;
    const endTarget = t1.targets[i]!;
    const endRows = new Map(endTarget.rows.map((row) => [row.key, row]));
    const t0StaleRows = startTarget.rows.filter((row) => row.stale);
    const t0Retained = t0StaleRows.filter((row) => endRows.has(row.key));
    const t0Embedded = t0Retained.filter((row) => !endRows.get(row.key)!.stale).length;
    const inWindowRows = cutTarget.rows;
    const inWindowRetained = inWindowRows.filter((row) => endRows.has(row.key));
    const inWindowEmbedded = inWindowRetained.filter((row) => !endRows.get(row.key)!.stale).length;
    return {
      table: startTarget.table, t0Stale: t0StaleRows.length, t0Retained: t0Retained.length,
      t0Embedded, inWindowEligible: inWindowRows.length, inWindowRetained: inWindowRetained.length,
      inWindowEmbedded,
      passed: (t0StaleRows.length === 0 || t0Embedded > 0) && inWindowEmbedded === inWindowRetained.length,
    };
  });
  if (targets.every((target) => target.t0Stale === 0)) {
    return { verdict: 'inconclusive', targets, reason: 'All T0 stale cohorts were empty' };
  }
  if (targets.some((target) => target.t0Stale > 0 && target.t0Retained === 0)) {
    return { verdict: 'inconclusive', targets, reason: 'A target lost every originally stale eligible row before T1, so clause 1 is unproven' };
  }
  return targets.every((target) => target.passed)
    ? { verdict: 'healthy', targets, reason: 'All nonempty retained cohorts met the progress rule' }
    : { verdict: 'failed', targets, reason: 'At least one retained cohort missed its progress rule' };
}
