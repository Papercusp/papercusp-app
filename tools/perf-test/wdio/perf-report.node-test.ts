import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { buildStartupStorageProbeScript, buildWebVitalsBundle, evaluateRequiredPageLoad, installStartupStorageProbe, readPageStartupTrace, writeStartupStorageDiagnosticIndex, type WebVitalsReading } from "./web-vitals-probe";
import type { Browser } from "webdriverio";
import { captureOwnedNativeStacks, collectOwnedWebKitSample, NativeSampleBuffer, NativeStackCaptureSchedule,
  parseNativeStackDelayMs, parseSchedstat, schedstatDelta, startNativeProcessProbe,
  stopNativeProcessProbe } from './native-process-probe';

import { assertPrivateIpcFixture, assertPrivateIpcFixtureUnchanged, BINARY_BUILT_AT_KEY, BUILD_IDENTITY_FILE, CONTEXT_STAMP_PREFIXES, desktopPerfRunPayload, hasRunOutcomeMeasure, readBuildIdentity, readPublisherToken, type PerfMeasure } from "./perf-report";
import {
  installPopupLayoutProbe,
  installPopupReactProbe,
  isTerminalWebDriverSessionError,
  readPlanPopupCandidates,
  readPlanPopupAttemptInPage,
  triggerPlanPopupAttemptInPage,
  waitForPackagedAppUrl,
  waitUntilOrFailOnTerminalSession,
} from "./app-mount";
import { classifyAttemptTimeout } from "../../../libs/generic/gui-readiness/src/interaction-measure";
import { beginInteraction, endInteraction, markInteractionPhase } from "../../../apps/operator/app/_components/perf/perf-marks";

// Exercise the real writer in overlapping launchers and their forked workers.
// Copy only this dependency-free module so the pre-fix shared-file reset cannot
// erase a developer's live run while reproducing the collision.
async function measureLauncher(source: string, runId: string, inheritedCollection?: string) {
  const script = String.raw`
    const { spawnSync } = require('node:child_process');
    const report = require(process.argv[1]);
    process.on('message', ({ id, command, measure }) => {
      try {
        let result;
        if (command === 'prepare') {
          if (report.prepareMeasures) report.prepareMeasures();
          report.resetMeasures();
          result = report.MEASURES_PATH;
        } else if (command === 'write') {
          const worker = spawnSync(process.execPath, ['--import', 'tsx', '-e',
            "const r=require(process.argv[1]);r.recordMeasure(JSON.parse(process.argv[2]));process.stdout.write(JSON.stringify({path:r.MEASURES_PATH,measures:r.readMeasures()}));",
            process.argv[1], JSON.stringify(measure)], { env: process.env, encoding: 'utf8' });
          if (worker.status !== 0) throw new Error(worker.stderr || String(worker.error));
          result = JSON.parse(worker.stdout);
        } else if (command === 'reset') {
          report.resetMeasures(); result = report.readMeasures();
        } else if (command === 'read') result = report.readMeasures();
        process.send({ id, result });
      } catch (error) { process.send({ id, error: String(error) }); }
    });
  `;
  const env: NodeJS.ProcessEnv = { ...process.env, PAPERCUSP_PERF_RUN_ID: runId };
  delete env.PAPERCUSP_PERF_MEASURES_PATH;
  if (inheritedCollection) env.PAPERCUSP_PERF_MEASURES_PATH = inheritedCollection;
  const child = spawn(process.execPath, ['--import', 'tsx', '-e', script, source], {
    cwd: __dirname, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  await once(child, 'spawn');
  let sequence = 0;
  const request = (command: string, measure?: PerfMeasure) => new Promise<any>((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => finish(new Error('measure launcher response timed out')), 5_000);
    const finish = (error?: Error, result?: unknown) => {
      clearTimeout(timer);
      child.off('message', receive);
      child.off('exit', exited);
      error ? reject(error) : resolve(result);
    };
    const receive = (message: any) => {
      if (message.id === id) finish(message.error ? new Error(message.error) : undefined, message.result);
    };
    const exited = () => finish(new Error('measure launcher exited before replying'));
    child.on('message', receive);
    child.once('exit', exited);
    child.send({ id, command, measure });
  });
  return { child, request };
}

async function stopMeasureLauncher(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, 'exit');
  child.kill('SIGTERM');
  await exit;
}

for (const profile of ['distinct', 'same', 'unnamed'] as const) {
  test(`overlapping measure launchers preserve worker receipts and reset isolation (${profile} profiles)`, {
    timeout: 15_000,
  }, async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'perf-measure-isolation-'));
    const source = path.join(root, 'perf-report.ts');
    writeFileSync(source, readFileSync(path.join(__dirname, 'perf-report.ts')));
    const launchers: Awaited<ReturnType<typeof measureLauncher>>[] = [];
    try {
      const a = await measureLauncher(source, profile === 'unnamed' ? '' : 'profile-A'); launchers.push(a);
      const first: PerfMeasure = { key: 'interaction:run-A', value: 1937, unit: 'ms', budget: 1500, ok: false };
      const second: PerfMeasure = { key: 'interaction:run-B', value: 590, unit: 'ms', budget: 1500, ok: true };
      const aPath = await a.request('prepare');
      const aWorker = await a.request('write', first);
      assert.equal(aWorker.path, aPath, 'worker must inherit its launcher collection');
      assert.deepEqual(aWorker.measures, [first]);
      // A new launcher may inherit a parent's old collection environment. Its
      // prepare must replace that binding; only spec workers reuse it.
      const b = await measureLauncher(source, profile === 'unnamed' ? '' : profile === 'same' ? 'profile-A' : 'profile-B', aPath);
      launchers.push(b);
      const bPath = await b.request('prepare');
      const afterPeerReset = await a.request('read');
      const bWorker = await b.request('write', second);
      const aBeforeClear = await a.request('read');
      const bBeforeClear = await b.request('read');
      await a.request('reset');
      const bAfterPeerClear = await b.request('read');
      assert.deepEqual(afterPeerReset, [first], 'another launcher preparation must not erase the first outcome');
      assert.notEqual(aPath, bPath, 'a profile name is not a unique collection lifetime');
      assert.equal(bWorker.path, bPath);
      assert.deepEqual(aBeforeClear, [first], 'run A must not publish run B outcomes');
      assert.deepEqual(bBeforeClear, [second], 'run B must not publish run A outcomes');
      assert.deepEqual(bAfterPeerClear, [second], 'run A completion must not delete run B outcomes');
      assert.deepEqual(await a.request('read'), []);
      assert.deepEqual(await b.request('reset'), []);
    } finally {
      await Promise.all(launchers.map(({ child }) => stopMeasureLauncher(child)));
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('unprepared measurement collection refuses the legacy shared file', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'perf-measure-unprepared-'));
  const source = path.join(root, 'perf-report.ts');
  const legacy = path.join(root, 'results', 'measures.jsonl');
  const saved = '{"key":"interaction:old-run","value":1,"unit":"ms","budget":1500,"ok":true}\n';
  try {
    writeFileSync(source, readFileSync(path.join(__dirname, 'perf-report.ts')));
    mkdirSync(path.dirname(legacy)); writeFileSync(legacy, saved);
    const env = { ...process.env }; delete env.PAPERCUSP_PERF_MEASURES_PATH;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '-e',
      "const r=require(process.argv[1]);const before=r.readMeasures();r.resetMeasures();r.recordMeasure({key:'interaction:new',value:1,unit:'ms',budget:2,ok:true});process.stdout.write(JSON.stringify({before,after:r.readMeasures(),path:r.MEASURES_PATH}));",
      source], { cwd: __dirname, env, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { before: [], after: [], path: null });
    assert.match(child.stderr, /collection was not prepared/);
    assert.equal(readFileSync(legacy, 'utf8'), saved, 'no read, write or reset may adopt the legacy file');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a fresh collection retains a crashed or unpublished prior receipt without adopting it', {
  timeout: 10_000,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'perf-measure-retention-'));
  const source = path.join(root, 'perf-report.ts');
  let launcher: Awaited<ReturnType<typeof measureLauncher>> | undefined;
  try {
    writeFileSync(source, readFileSync(path.join(__dirname, 'perf-report.ts')));
    launcher = await measureLauncher(source, 'reused-profile');
    const measure: PerfMeasure = { key: 'interaction:failed-run', value: 2000, unit: 'ms', budget: 1500, ok: false };
    const prior = await launcher.request('prepare');
    await launcher.request('write', measure);
    const next = await launcher.request('prepare');
    assert.notEqual(prior, next);
    assert.deepEqual(await launcher.request('read'), []);
    assert.equal(readFileSync(prior, 'utf8'), `${JSON.stringify(measure)}\n`);
    await launcher.request('reset');
    assert.equal(readFileSync(prior, 'utf8'), `${JSON.stringify(measure)}\n`);
  } finally {
    if (launcher) await stopMeasureLauncher(launcher.child);
    rmSync(root, { recursive: true, force: true });
  }
});

test('popup timeout snapshot retains late completion after the real end consumes its start', () => {
  const name = 'node-popup-late-completion';
  const context = { performance, window: {}, document: {
    querySelector: (selector: string) => selector === '[data-testid="plan-dash-open-full"]'
      ? { click: () => beginInteraction(name) } : null,
  }, name };
  const attempt = runInNewContext(`(${triggerPlanPopupAttemptInPage.toString()})(name)`, context);
  assert.equal(attempt.clicked, true);
  assert.ok(attempt.startTimeMs >= attempt.triggerAtMs);
  markInteractionPhase(name, 'request-started');
  markInteractionPhase(name, 'preview-rendered');
  assert.notEqual(endInteraction(name), null);
  assert.equal(performance.getEntriesByName(`${name}:start`, 'mark').length, 0);
  const snapshot = runInNewContext(`(${readPlanPopupAttemptInPage.toString()})(name, attempt)`, { ...context, attempt });
  assert.equal(snapshot.startMarkAgeMs, null);
  assert.equal(snapshot.measureCount, 1);
  assert.equal(snapshot.measures[0].startTimeMs, attempt.startTimeMs);
  assert.equal(snapshot.phases.length, 2);
  assert.equal(classifyAttemptTimeout({
    measureCount: snapshot.measureCount, beginObserved: true,
    startMarkPresent: false, startMarkAgeMs: null, staleStartMs: 30_000,
    phasesSeen: snapshot.phases.map((p: { name: string }) => p.name.slice(`${name}:phase:`.length)),
    dispatchPhase: 'request-started', terminalPlaceholder: null,
  }).verdict, 'measured');
  performance.clearMeasures(name);
  for (const phase of ['request-started', 'preview-rendered']) performance.clearMeasures(`${name}:phase:${phase}`);
  performance.clearMarks(`${name}:trigger-return`);
});

test('popup attempt excludes old and different-start phases and retains exact late duration', () => {
  const name = 'node-popup-phase-provenance';
  // Node derives duration by subtracting start from end. A fractional start
  // can round an exact 8637 ms fixture to 8636.999999999998; use an integer
  // fixture clock so the exact-duration assertion is deterministic.
  const start = Math.floor(performance.now());
  performance.mark(`${name}:start`, { startTime: start });
  performance.measure(`${name}:phase:old`, { start: start - 1, duration: 8 });
  performance.measure(`${name}:phase:request-started`, { start, duration: 66 });
  performance.measure(`${name}:phase:other-begin`, { start: start + 1, duration: 5 });
  performance.measure(name, { start: start - 1, duration: 1 });
  performance.measure(name, { start, duration: 8637 });
  performance.clearMarks(`${name}:start`);
  const attempt = { clicked: true, triggerAtMs: start, startTimeMs: start };
  const snapshot = runInNewContext(`(${readPlanPopupAttemptInPage.toString()})(name, attempt)`, {
    name, attempt, performance, window: {}, document: { querySelector: () => null },
  });
  assert.equal(snapshot.measureCount, 1);
  assert.equal(snapshot.measures[0].durationMs, 8637);
  assert.equal(snapshot.phases.length, 1);
  assert.equal(snapshot.phases[0].name, `${name}:phase:request-started`);
  assert.equal(snapshot.phases[0].startTimeMs, start);
  assert.equal(snapshot.phases[0].endTimeMs, start + 66);
  performance.clearMeasures(name);
  for (const phase of ['old', 'request-started', 'other-begin']) performance.clearMeasures(`${name}:phase:${phase}`);
});

test('popup trigger clears prior phases even when the new handler never begins timing', () => {
  const name = 'node-popup-no-begin';
  beginInteraction(name);
  markInteractionPhase(name, 'request-started');
  const context = { performance, window: {}, name, document: {
    querySelector: (selector: string) => selector === '[data-testid="plan-dash-open-full"]'
      ? { click: () => {} } : null,
  } };
  const attempt = runInNewContext(`(${triggerPlanPopupAttemptInPage.toString()})(name)`, context);
  const snapshot = runInNewContext(`(${readPlanPopupAttemptInPage.toString()})(name, attempt)`, { ...context, attempt });
  assert.equal(attempt.clicked, true);
  assert.equal(attempt.startTimeMs, null);
  assert.equal(snapshot.phases.length, 0);
  assert.equal(snapshot.measureCount, 0);
  assert.equal(classifyAttemptTimeout({
    measureCount: 0, beginObserved: false, startMarkPresent: false,
    startMarkAgeMs: null, staleStartMs: 30_000, phasesSeen: [],
    dispatchPhase: 'request-started', terminalPlaceholder: null,
  }).verdict, 'void');
  performance.clearMarks(`${name}:trigger-return`);
});

function nativeProcFixture() {
  const files = new Map<string, string>([['/proc/sys/kernel/random/boot_id', 'boot-A'],
    ['/proc/sys/kernel/sched_schedstats', '1']]);
  const dirs = new Map<string, string[]>();
  const links = new Map<string, string>();
  const stat = (pid: number, ppid: number, ticks = '100', name = 'WebKit (main)') => {
    const fields = Array<string>(22).fill('0');
    fields[0] = 'S'; fields[1] = String(ppid); fields[19] = ticks;
    return `${pid} (${name}) ${fields.join(' ')}`;
  };
  const add = (pid: number, ppid: number, exe: string, children = '', tids = [String(pid)]) => {
    files.set(`/proc/${pid}/stat`, stat(pid, ppid));
    files.set(`/proc/${pid}/task/${pid}/stat`, stat(pid, ppid));
    files.set(`/proc/${pid}/task/${pid}/schedstat`, '1000000 2000000 3');
    files.set(`/proc/${pid}/task/${pid}/wchan`, 'poll_schedule_timeout');
    links.set(`/proc/${pid}/exe`, exe);
    dirs.set(`/proc/${pid}/task`, tids);
    for (const tid of tids) files.set(`/proc/${pid}/task/${tid}/children`, tid === String(pid) ? children : '');
  };
  add(10, 1, '/usr/bin/tauri-driver', '20 40');
  add(20, 10, '/fixture/papercusp-desktop', '', ['20', '21']);
  // WebKit spawned by a non-main GLib task, through a sandbox helper.
  files.set('/proc/20/task/21/children', '25');
  add(25, 20, '/usr/bin/bwrap', '30');
  add(30, 25, '/usr/lib/WebKitWebProcess');
  add(40, 10, '/usr/lib/WebKitWebProcess'); // same driver, outside the app ancestry
  add(90, 1, '/usr/lib/WebKitWebProcess'); // peer's live desktop
  const get = <T>(map: Map<string, T>, file: string): T => {
    const value = map.get(file);
    if (value === undefined) throw new Error(`missing fixture ${file}`);
    return value;
  };
  const reads: string[] = [];
  return { files, dirs, links, stat, reads, options: { driverPid: 10,
    driverIdentity: 'linux:boot-A:100', appPath: '/fixture/papercusp-desktop' },
    proc: { read: (file: string) => { reads.push(file); return get(files, file); },
      list: (file: string) => get(dirs, file), link: (file: string) => get(links, file) } };
}

test('native main-task counters retain exact ns and reject resets/malformed instruments', () => {
  const before = parseSchedstat('900719925474099300 1000000 1');
  const after = parseSchedstat('900719925475349300 3500000 2');
  assert.deepEqual(schedstatDelta(before, after), { cpuMs: 1.25, runqueueMs: 2.5, timeslices: 1 });
  assert.throws(() => schedstatDelta(after, before), /counter reset/);
  for (const invalid of ['', '1 2', '1 2 3 4', 'NaN 0 1', '1 -2 3', '1.5 2 3']) {
    assert.throws(() => parseSchedstat(invalid), /Invalid schedstat/);
  }
});

test('native discovery reaches non-main-task children but excludes same-name peers and driver siblings', () => {
  const f = nativeProcFixture();
  const sample = collectOwnedWebKitSample(f.options, f.proc);
  assert.deepEqual(sample.processes.map(({ pid, kind }) => ({ pid, kind })),
    [{ pid: 20, kind: 'app' }, { pid: 30, kind: 'webkit' }]);
  const renderer = sample.processes[1];
  assert.equal(renderer.identity, 'linux:boot-A:100');
  assert.equal(renderer.appIdentity, 'linux:boot-A:100');
  assert.deepEqual(renderer.ancestry, [10, 20, 25].map((pid) => ({ pid, identity: 'linux:boot-A:100' })));
  assert.equal(renderer.wchan, 'poll_schedule_timeout');
  assert.equal(renderer.state, 'S');
  assert.equal(sample.counterUnit, 'ns');
  assert.equal(sample.task, 'main');
  assert.equal(sample.runqueueMeasured, true);
  assert.equal(sample.unavailable.length, 0);
  assert(f.reads.includes('/proc/30/task/30/schedstat'));
  assert(!f.reads.some((file) => file.startsWith('/proc/90/')));
  assert(!f.reads.includes('/proc/40/task/40/schedstat'));
  assert(sample.readCompletedEpochMs >= sample.readStartedEpochMs);
});

test('native discovery fails closed for a reused driver or changed boot', () => {
  for (const boot of ['boot-B', 'boot-A']) {
    const f = nativeProcFixture();
    f.files.set('/proc/sys/kernel/random/boot_id', boot);
    if (boot === 'boot-A') f.files.set('/proc/10/stat', f.stat(10, 1, '101'));
    assert.throws(() => collectOwnedWebKitSample(f.options, f.proc), /driver identity changed/);
  }
});

test('native sampling never attributes a reused main task to the earlier WebKit lifetime', () => {
  const f = nativeProcFixture();
  f.files.set('/proc/30/task/30/stat', f.stat(30, 25, '101'));
  const sample = collectOwnedWebKitSample(f.options, f.proc);
  assert(!sample.processes.some(({ pid }) => pid === 30));
  assert.match(sample.unavailable.join(' '), /identity changed during sampling/);
});

test('native sampling rejects a renderer reparented after discovery', () => {
  const f = nativeProcFixture();
  const read = f.proc.read;
  f.proc.read = (file) => {
    const value = read(file);
    if (file === '/proc/30/task/30/schedstat') f.files.set('/proc/30/stat', f.stat(30, 1));
    return value;
  };
  const sample = collectOwnedWebKitSample(f.options, f.proc);
  assert(!sample.processes.some(({ pid }) => pid === 30));
  assert.match(sample.unavailable.join(' '), /owned ancestry changed/);
});

test('native sampling marks disabled scheduler-wait accounting and missing counters as unavailable', () => {
  const f = nativeProcFixture();
  f.files.set('/proc/sys/kernel/sched_schedstats', '0');
  assert.equal(collectOwnedWebKitSample(f.options, f.proc).runqueueMeasured, false);
  f.files.delete('/proc/30/task/30/schedstat');
  const sample = collectOwnedWebKitSample(f.options, f.proc);
  assert(!sample.processes.some(({ pid }) => pid === 30));
  assert.match(sample.unavailable.join(' '), /schedstat/);
});

test('native lifecycle checks a missing owned identity directly and keeps signal/reaping unknown', () => {
  const f = nativeProcFixture();
  const previous = collectOwnedWebKitSample(f.options, f.proc).processes;
  f.files.set('/proc/25/task/25/children', '');
  f.files.delete('/proc/30/stat');
  const proc = { ...f.proc, read: (file: string) => {
    if (file === '/proc/30/stat') throw Object.assign(new Error('gone'), { code: 'ENOENT' });
    return f.proc.read(file);
  } };
  const sample = collectOwnedWebKitSample(f.options, proc, new Set(), previous);
  const row = sample.lifecycle.find(({ pid }) => pid === 30)!;
  assert.equal(row.status, 'procfs-missing');
  assert.equal(row.signal, null);
  assert.equal(row.exitCode, null);
  assert.equal(row.reaping, 'unknown');
  assert.equal(row.lastOwnedReadCompletedEpochMs, previous[1].readCompletedEpochMs);
  assert(row.readCompletedEpochMs >= row.readStartedEpochMs);
  assert(!f.reads.some((file) => file.startsWith('/proc/90/')));
});

test('native lifecycle distinguishes reparenting and incomplete discovery from process disappearance', () => {
  for (const reparented of [false, true]) {
    const f = nativeProcFixture();
    const previous = collectOwnedWebKitSample(f.options, f.proc).processes;
    if (reparented) {
      f.files.set('/proc/25/task/25/children', '');
      f.files.set('/proc/30/stat', f.stat(30, 1));
    } else f.files.delete('/proc/25/task/25/children');
    const sample = collectOwnedWebKitSample(f.options, f.proc, new Set(), previous);
    const row = sample.lifecycle.find(({ pid }) => pid === 30)!;
    assert.equal(row.status, 'same-identity-present');
    assert.equal(row.parentPid, reparented ? 1 : 25);
    assert.equal(row.discoveryIncomplete, !reparented);
    assert.equal(row.signal, null);
    assert.equal(row.reaping, 'unknown');
    assert(!sample.processes.some(({ pid }) => pid === 30));
  }
});

test('native lifecycle observes an unreaped zombie even after its executable link is gone', () => {
  const f = nativeProcFixture();
  const previous = collectOwnedWebKitSample(f.options, f.proc).processes;
  f.files.set('/proc/30/stat', f.stat(30, 25).replace(') S ', ') Z '));
  f.links.delete('/proc/30/exe');
  const row = collectOwnedWebKitSample(f.options, f.proc, new Set(), previous).lifecycle
    .find(({ pid }) => pid === 30)!;
  assert.equal(row.status, 'zombie');
  assert.equal(row.state, 'Z');
  assert.equal(row.reaping, 'not-reaped');
  assert.equal(row.signal, null);
  assert.equal(row.exitCode, null);
});

test('native lifecycle rejects PID reuse and races without attributing the replacement to the old process', () => {
  for (const racing of [false, true]) {
    const f = nativeProcFixture();
    const previous = collectOwnedWebKitSample(f.options, f.proc).processes;
    f.files.set('/proc/25/task/25/children', '');
    if (!racing) f.files.set('/proc/30/stat', f.stat(30, 25, '101'));
    let reads = 0;
    const proc = { ...f.proc, read: (file: string) => {
      const value = f.proc.read(file);
      if (racing && file === '/proc/30/stat' && ++reads === 1) {
        f.files.set(file, f.stat(30, 1, '101'));
      }
      return value;
    } };
    const row = collectOwnedWebKitSample(f.options, proc, new Set(), previous).lifecycle
      .find(({ pid }) => pid === 30)!;
    assert.equal(row.status, racing ? 'unavailable' : 'identity-replaced');
    assert.equal(row.state, null);
    assert.equal(row.parentPid, null);
    assert.equal(row.signal, null);
    assert.equal(row.reaping, 'unknown');
  }
});

test('native lifecycle refuses malformed/denied/oversized reads and a PID appearing between missing reads', () => {
  for (const failure of ['denied', 'malformed', 'oversized', 'appeared', 'boot']) {
    const f = nativeProcFixture();
    const previous = collectOwnedWebKitSample(f.options, f.proc).processes;
    f.files.set('/proc/25/task/25/children', '');
    let reads = 0;
    const proc = { ...f.proc, read: (file: string) => {
      if (file !== '/proc/30/stat') return f.proc.read(file);
      reads++;
      if (failure === 'denied') throw Object.assign(new Error('private-read-error'), { code: 'EACCES' });
      if (failure === 'malformed') return 'malformed';
      if (failure === 'oversized') return 'x'.repeat(4097);
      if (failure === 'appeared' && reads === 1) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      if (failure === 'boot') f.files.set('/proc/sys/kernel/random/boot_id', 'boot-B');
      return f.proc.read(file);
    } };
    if (failure === 'boot') {
      assert.throws(() => collectOwnedWebKitSample(f.options, proc, new Set(), previous), /driver exited\/reused/);
      continue;
    }
    const sample = collectOwnedWebKitSample(f.options, proc, new Set(), previous);
    const row = sample.lifecycle.find(({ pid }) => pid === 30)!;
    assert.equal(row.status, 'unavailable');
    assert.equal(row.signal, null);
    assert.equal(row.reaping, 'unknown');
    assert(!JSON.stringify(row).includes('private-read-error'));
  }
});

test('native lifecycle bounds previously observed identities before performing extra proc reads', () => {
  const f = nativeProcFixture();
  const previous = collectOwnedWebKitSample(f.options, f.proc).processes;
  f.reads.length = 0;
  assert.throws(() => collectOwnedWebKitSample(f.options, f.proc, new Set(),
    Array.from({ length: 65 }, () => previous[1])), /64-identity bound/);
  assert.equal(f.reads.length, 0);
  assert.throws(() => collectOwnedWebKitSample(f.options, f.proc, new Set(),
    [{ ...previous[1], pid: -1 }]), /invalid previously observed/);
  assert.equal(f.reads.length, 0);
});

test('native environment records only explicit diagnostic keys on owned app and renderer lifetimes', () => {
  const f = nativeProcFixture();
  f.files.set('/proc/20/environ', 'GST_REGISTRY_UPDATE=no\0GST_REGISTRY=/private/registry.bin\0API_KEY=excluded-secret\0');
  f.files.set('/proc/30/environ', 'GST_REGISTRY_UPDATE=no\0GST_PLUGIN_SYSTEM_PATH_1_0=\0XDG_CACHE_HOME=/private/cache\0GST_SECRET_TOKEN=excluded-secret\0OPENAI_API_KEY=excluded-secret\0');
  const sample = collectOwnedWebKitSample({ ...f.options, environment: true }, f.proc);
  const env = sample.processes[1].environment;
  assert(env?.status === 'captured');
  assert.deepEqual(env.values.GST_REGISTRY_UPDATE, { status: 'present', value: 'no' });
  assert.deepEqual(env.values.GST_PLUGIN_SYSTEM_PATH_1_0, { status: 'present', value: '' });
  assert.deepEqual(env.values.GST_REGISTRY, { status: 'absent' });
  assert.deepEqual(env.values.XDG_CACHE_HOME, { status: 'present', value: '/private/cache' });
  assert(sample.processes[0].environment?.status === 'captured');
  assert(!JSON.stringify(sample).includes('excluded-secret'));
  assert(!('OPENAI_API_KEY' in env.values));
  assert(!('GST_SECRET_TOKEN' in env.values));
  assert(!f.reads.includes('/proc/10/environ'));
  assert(!f.reads.includes('/proc/25/environ'));
  assert(!f.reads.includes('/proc/40/environ'));
  assert(!f.reads.some((file) => file.startsWith('/proc/90/')));
  assert(env.readCompletedEpochMs >= env.readStartedEpochMs);
});

test('native output captures only stdout, stderr and the requested debug file with exact descriptor counters', () => {
  const f = nativeProcFixture();
  for (const pid of [20, 30]) {
    f.links.set(`/proc/${pid}/fd/1`, '/dev/null');
    f.links.set(`/proc/${pid}/fd/2`, '/private/wdio.log');
    f.links.set(`/proc/${pid}/fd/8`, `/dev/shm/gst.${pid}.log`);
    f.links.set(`/proc/${pid}/fd/9`, '/unrelated/secret');
    f.dirs.set(`/proc/${pid}/fd`, ['1', '2', '8', '9']);
    for (const fd of [1, 2, 8]) f.files.set(`/proc/${pid}/fdinfo/${fd}`,
      'pos:\t90071992547409930\nflags:\t0100001\nmnt_id:\t42\nino:\t90071992547409931\n');
  }
  const sample = collectOwnedWebKitSample({ ...f.options, outputDescriptors: true,
    debugFile: '/dev/shm/gst.%p.log' }, f.proc);
  const output = sample.processes[1].output;
  assert(output);
  assert.equal(output.debugFileStatus, 'captured');
  assert.deepEqual(output.descriptors.map((d) => d.fd), [1, 2, 8]);
  const descriptor = output.descriptors[2];
  assert(descriptor.status === 'captured');
  assert.equal(descriptor.target, '/dev/shm/gst.30.log');
  assert.equal(descriptor.inode, '90071992547409931');
  assert.equal(descriptor.position, '90071992547409930');
  assert.equal(descriptor.mountId, '42');
  assert(!JSON.stringify(sample).includes('secret'));
  assert(!f.reads.includes('/proc/30/fdinfo/9'));
  assert(!f.reads.some((file) => file.startsWith('/proc/40/fdinfo/')));
});

test('native output reads are bounded, optional and do not expose raw failures', () => {
  const f = nativeProcFixture();
  const sample = collectOwnedWebKitSample({ ...f.options, outputDescriptors: true }, f.proc);
  assert.equal(sample.processes[1].output?.descriptors[0].status, 'unavailable');
  assert(!JSON.stringify(sample.processes[1].output).includes('missing fixture'));
  const disabled = nativeProcFixture();
  collectOwnedWebKitSample(disabled.options, disabled.proc);
  assert(!disabled.reads.some((file) => file.includes('/fdinfo/')));
  f.links.set('/proc/30/fd/2', '/private/wdio.log');
  const calls: number[] = [];
  const output = collectOwnedWebKitSample({ ...f.options, outputDescriptors: true }, {
    ...f.proc, readBounded: (_file: string, maxBytes: number) => { calls.push(maxBytes); return 'x'.repeat(4097); },
  }).processes[1].output;
  assert.equal(output?.descriptors[1].status, 'unavailable');
  assert(calls.every((bound) => bound === 4096));
  assert(!JSON.stringify(output).includes('xxxx'));
});

test('native output rejects reopened descriptors and changed owned lifetimes', () => {
  for (const change of ['target', 'inode', 'process', 'ancestry']) {
    const f = nativeProcFixture();
    f.links.set('/proc/30/fd/2', '/private/wdio.log');
    f.files.set('/proc/30/fdinfo/2', 'pos: 0\nflags: 0100001\nmnt_id: 42\nino: 7\n');
    const read = f.proc.read;
    let infoReads = 0;
    f.proc.read = (file) => {
      const value = read(file);
      if (file === '/proc/30/fdinfo/2' && ++infoReads === 1) {
        if (change === 'target') f.links.set('/proc/30/fd/2', '/different/output');
        if (change === 'inode') f.files.set(file, 'pos: 0\nflags: 0100001\nmnt_id: 42\nino: 8\n');
        if (change === 'process') f.files.set('/proc/30/stat', f.stat(30, 25, '101'));
        if (change === 'ancestry') f.files.set('/proc/25/stat', f.stat(25, 1));
      }
      return value;
    };
    const sample = collectOwnedWebKitSample({ ...f.options, outputDescriptors: true }, f.proc);
    const renderer = sample.processes.find((row) => row.pid === 30);
    if (change === 'target' || change === 'inode') {
      assert.deepEqual(renderer?.output?.descriptors[1], { fd: 2, status: 'unavailable', reason: 'descriptor-changed' });
    } else {
      assert(!renderer);
      assert.match(sample.unavailable.join(' '), /identity|ancestry/);
    }
  }
});

test('native debug-file discovery distinguishes not-open, unavailable bounds and descriptor replacement', () => {
  const f = nativeProcFixture();
  f.dirs.set('/proc/30/fd', ['7']);
  f.links.set('/proc/30/fd/7', '/other/file');
  const options = { ...f.options, outputDescriptors: true, debugFile: '/dev/shm/gst.log' };
  assert.equal(collectOwnedWebKitSample(options, f.proc).processes[1].output?.debugFileStatus, 'not-open');
  f.links.delete('/proc/30/fd/7');
  assert.equal(collectOwnedWebKitSample(options, f.proc).processes[1].output?.debugFileStatus, 'unavailable');
  f.links.set('/proc/30/fd/7', '/other/file');
  f.dirs.set('/proc/30/fd', Array.from({ length: 257 }, (_, i) => String(i)));
  assert.equal(collectOwnedWebKitSample(options, f.proc).processes[1].output?.debugFileStatus, 'unavailable');
  f.dirs.set('/proc/30/fd', ['7']);
  f.links.set('/proc/30/fd/7', '/dev/shm/gst.log');
  const link = f.proc.link;
  let reads = 0;
  f.proc.link = (file) => {
    if (file === '/proc/30/fd/7' && ++reads > 1) return '/changed/file';
    return link(file);
  };
  f.files.set('/proc/30/fdinfo/7', 'pos: 0\nflags: 0100001\nmnt_id: 42\nino: 7\n');
  const output = collectOwnedWebKitSample(options, f.proc).processes[1].output;
  assert.equal(output?.debugFileStatus, 'unavailable');
  assert.deepEqual(output?.descriptors[2], { fd: 7, status: 'unavailable', reason: 'descriptor-changed' });
});

test('native environment unavailability is explicit and never serializes a raw read error', () => {
  const f = nativeProcFixture();
  const read = f.proc.read;
  f.proc.read = (file) => {
    if (file.endsWith('/environ')) throw new Error('EACCES raw-secret-must-not-leak');
    return read(file);
  };
  const sample = collectOwnedWebKitSample({ ...f.options, environment: true }, f.proc);
  assert.equal(sample.processes.length, 2);
  assert.equal(sample.processes[1].environment?.status, 'unavailable');
  assert(!JSON.stringify(sample).includes('raw-secret'));
  assert.equal(sample.unavailable.length, 0); // Counters remain a separate observation.
});

test('native environment validates owned ancestry before reading and honors the disabled option', () => {
  const f = nativeProcFixture();
  const read = f.proc.read;
  f.proc.read = (file) => {
    const value = read(file);
    if (file === '/proc/30/task/30/schedstat') f.files.set('/proc/25/stat', f.stat(25, 1));
    return value;
  };
  const sample = collectOwnedWebKitSample({ ...f.options, environment: true }, f.proc);
  assert(!sample.processes.some(({ pid }) => pid === 30));
  assert(!f.reads.includes('/proc/30/environ'));
  const disabled = nativeProcFixture();
  collectOwnedWebKitSample({ ...disabled.options, environment: false }, disabled.proc);
  assert(!disabled.reads.some((file) => file.endsWith('/environ')));
});

test('native environment uses the bounded reader and treats an empty environment as measured absence', () => {
  const f = nativeProcFixture();
  const calls: Array<{ file: string; maxBytes: number }> = [];
  const proc = { ...f.proc, readBounded: (file: string, maxBytes: number) => {
    calls.push({ file, maxBytes });
    return '';
  } };
  const sample = collectOwnedWebKitSample({ ...f.options, environment: true }, proc);
  assert.deepEqual(calls, [20, 30].map((pid) => ({ file: `/proc/${pid}/environ`, maxBytes: 128 * 1024 })));
  for (const row of sample.processes) {
    assert(row.environment?.status === 'captured');
    assert(Object.values(row.environment.values).every((value) => value.status === 'absent'));
  }
});

test('native environment rejects unterminated, duplicate and oversized data without leaking it', () => {
  for (const value of ['GST_REGISTRY_UPDATE=raw-secret',
    'GST_REGISTRY_UPDATE=no\0GST_REGISTRY_UPDATE=raw-secret\0',
    `GST_REGISTRY=${'x'.repeat(4097)}raw-secret\0`,
    `UNRELATED=${'x'.repeat(128 * 1024)}raw-secret\0`]) {
    const f = nativeProcFixture();
    f.files.set('/proc/30/environ', value);
    const env = collectOwnedWebKitSample({ ...f.options, environment: true }, f.proc).processes[1].environment;
    assert.equal(env?.status, 'unavailable');
    assert(!JSON.stringify(env).includes('raw-secret'));
  }
});

test('native environment discards data if PID, executable, boot or owned ancestry changes during read', () => {
  for (const race of ['pid', 'executable', 'boot', 'ancestry']) {
    const f = nativeProcFixture();
    f.files.set('/proc/30/environ', 'GST_REGISTRY_UPDATE=raced-value\0');
    const read = f.proc.read;
    f.proc.read = (file) => {
      const value = read(file);
      if (file === '/proc/30/environ') {
        if (race === 'pid') f.files.set('/proc/30/stat', f.stat(30, 25, '101'));
        if (race === 'executable') f.links.set('/proc/30/exe', '/usr/bin/peer');
        if (race === 'boot') f.files.set('/proc/sys/kernel/random/boot_id', 'boot-B');
        if (race === 'ancestry') f.files.set('/proc/25/stat', f.stat(25, 1));
      }
      return value;
    };
    let recorded = '';
    try { recorded = JSON.stringify(collectOwnedWebKitSample({ ...f.options, environment: true }, f.proc)); }
    catch (error) { assert.match(String(error), /identity|boot|ancestry/); }
    assert(f.reads.includes('/proc/30/environ'), race);
    assert(!recorded.includes('raced-value'), race);
    if (recorded) assert(!JSON.parse(recorded).processes.some(({ pid }: { pid: number }) => pid === 30), race);
  }
});

test('native environment is captured once per PID identity, including unavailable reads', () => {
  const f = nativeProcFixture();
  f.files.set('/proc/30/environ', 'GST_REGISTRY_UPDATE=no\0');
  const first = collectOwnedWebKitSample({ ...f.options, environment: true }, f.proc);
  const seen = new Set(first.processes.filter((row) => row.environment)
    .map((row) => `${row.pid}:${row.identity}`));
  f.reads.length = 0;
  const next = collectOwnedWebKitSample({ ...f.options, environment: true }, f.proc, seen);
  assert(next.processes.every((row) => !row.environment));
  assert(!f.reads.some((file) => file.endsWith('/environ')));
  f.files.set('/proc/30/stat', f.stat(30, 25, '101'));
  f.files.set('/proc/30/task/30/stat', f.stat(30, 25, '101'));
  const reused = collectOwnedWebKitSample({ ...f.options, environment: true }, f.proc, seen);
  assert.equal(reused.processes.find(({ pid }) => pid === 30)?.environment?.status, 'captured');
});

test('native stack capture requires owned identity, real frames, detach and resumed target', () => {
  const f = nativeProcFixture();
  const target = collectOwnedWebKitSample(f.options, f.proc).processes[1];
  const validOutput = () => `NATIVE_STACK_STOP_EPOCH_MS=${Date.now()}\n` +
    '0x1000 0x2000 0x1000 0x0 r-xp /lib/x86_64-linux-gnu/libwebkit2gtk-4.1.so.0.21.10\n' +
    '#0  0x123 in poll ()\n[Inferior 1 (process 30) detached]\n';
  const result = captureOwnedNativeStacks(f.options, target, f.proc, (pid) => {
    assert.equal(pid, 30);
    return validOutput();
  });
  assert.equal(result.status, 'captured');
  assert.equal(result.identity, 'linux:boot-A:100');
  assert(result.stoppedEpochMs >= result.startedEpochMs);
  assert.equal(result.mappingLines.length, 1);
  for (const output of ['', '#0 poll\n', 'ptrace: Operation not permitted.\n']) {
    assert.equal(captureOwnedNativeStacks(f.options, target, f.proc, () => output).status, 'unavailable');
  }
  const noClock = captureOwnedNativeStacks(f.options, target, f.proc,
    () => '#0 poll\n[Inferior 1 (process 30) detached]\n');
  assert.equal(noClock.status, 'unavailable');
  if (noClock.status === 'unavailable') assert.match(noClock.error, /post-attach clock/);
  const noMap = captureOwnedNativeStacks(f.options, target, f.proc,
    () => `NATIVE_STACK_STOP_EPOCH_MS=${Date.now()}\n#0 poll\n[Inferior 1 (process 30) detached]\n`);
  assert.equal(noMap.status, 'unavailable');
  if (noMap.status === 'unavailable') {
    assert.match(noMap.error, /WebKit mapping/);
    assert.match(noMap.output ?? '', /NATIVE_STACK_STOP_EPOCH_MS=/);
    assert(noMap.stoppedEpochMs);
  }
  const stopped = captureOwnedNativeStacks(f.options, target, f.proc, () => {
    f.files.set('/proc/30/task/30/stat', f.stat(30, 25).replace(') S ', ') T '));
    return validOutput();
  });
  assert.equal(stopped.status, 'unavailable');
});

test('native stack attach refuses stale/peer targets and discards post-attach identity races', () => {
  const f = nativeProcFixture();
  const target = collectOwnedWebKitSample(f.options, f.proc).processes[1];
  let attaches = 0;
  const run = () => { attaches++; return `NATIVE_STACK_STOP_EPOCH_MS=${Date.now()}\n` +
    '0x1000 0x2000 0x1000 0x0 r-xp /lib/x86_64-linux-gnu/libwebkit2gtk-4.1.so.0.21.10\n' +
    '#0 poll\n[Inferior 1 (process 30) detached]\n'; };
  assert.equal(captureOwnedNativeStacks(f.options, { ...target, pid: 90 }, f.proc, run).status, 'unavailable');
  f.files.set('/proc/30/stat', f.stat(30, 25, '101'));
  assert.equal(captureOwnedNativeStacks(f.options, target, f.proc, run).status, 'unavailable');
  assert.equal(attaches, 0);
  f.files.set('/proc/30/stat', f.stat(30, 25));
  const raced = captureOwnedNativeStacks(f.options, target, f.proc, () => {
    f.files.set('/proc/30/stat', f.stat(30, 1));
    return run();
  });
  assert.equal(raced.status, 'unavailable');
  if (raced.status === 'unavailable') assert.equal(raced.output, undefined);
  assert.equal(attaches, 1);
});

test('native stack capture bounds output and reports debugger failures as unavailable', () => {
  const f = nativeProcFixture();
  const target = collectOwnedWebKitSample(f.options, f.proc).processes[1];
  const oversized = captureOwnedNativeStacks(f.options, target, f.proc, () => '🎯'.repeat(65537));
  assert(oversized.status === 'unavailable');
  assert.match(oversized.error, /byte bound/);
  const failed = captureOwnedNativeStacks(f.options, target, f.proc, () => { throw new Error('attach deadline'); });
  assert(failed.status === 'unavailable');
  assert.match(failed.error, /attach deadline/);
});

test('native stack schedule waits for the owned WebKit lifetime and bounds captures', () => {
  assert.equal(parseNativeStackDelayMs(undefined), 0);
  assert.equal(parseNativeStackDelayMs('5500'), 5500);
  for (const bad of ['', '-1', '1.5', '15001', '999999999999999999999']) {
    assert.throws(() => parseNativeStackDelayMs(bad), /integer from 0 to 15000 ms/);
  }
  const schedule = new NativeStackCaptureSchedule(5500);
  assert.equal(schedule.due(null, 1000), false);
  assert.equal(schedule.due('30:linux:boot-A:100:linux:boot-A:25', 1000), false);
  assert.equal(schedule.due('30:linux:boot-A:100:linux:boot-A:25', 6499), false);
  assert.equal(schedule.due('30:linux:boot-A:100:linux:boot-A:25', 6500), true);
  assert.equal(schedule.due('30:linux:boot-A:100:linux:boot-A:25', 7499), false);
  assert.equal(schedule.due('30:linux:boot-A:100:linux:boot-A:25', 7500), true);
  assert.equal(schedule.due('31:linux:boot-A:101:linux:boot-A:25', 7600), false,
    'replacement must earn its own delay; old WebKit timing cannot be reused');
  assert.equal(schedule.due('31:linux:boot-A:101:linux:boot-A:25', 13100), true);
  assert.equal(schedule.due('31:linux:boot-A:101:linux:boot-A:25', 14100), false,
    'a process replacement cannot bypass the global three-capture bound');
});

test('native sample memory has exact byte/sample bounds and reports work including serialization', () => {
  const f = nativeProcFixture();
  const sample = collectOwnedWebKitSample(f.options, f.proc);
  sample.unavailable = ['Unicode diagnostic: 🎯'];
  const bytes = Buffer.byteLength(`${JSON.stringify({ kind: 'sample', ...sample })}\n`);
  const buffer = new NativeSampleBuffer(bytes * 2 - 1);
  assert.equal(buffer.add(sample), true);
  assert.equal(buffer.add(sample), false);
  const rows = buffer.finish('buffer-bound', 100)!.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].unavailable, sample.unavailable);
  assert.equal(rows[1].bufferedBytes, bytes);
  assert.equal(rows[1].samples, 1);
  assert(rows[1].totalSampleWorkMs >= sample.readDurationMs);
  assert(rows[1].maxSampleWorkMs >= sample.readDurationMs);
  assert.equal(buffer.finish('stopped', 101), null);
  assert.equal(buffer.add(sample), false);
  const countBound = new NativeSampleBuffer(bytes * 3, 1);
  assert.equal(countBound.add(sample), true);
  assert.equal(countBound.add(sample), false);
  const oversized = new NativeSampleBuffer(bytes - 1);
  assert.equal(oversized.add(sample), false);
  assert.equal(JSON.parse(oversized.finish('buffer-bound', 1)!).samples, 0);
});

test('native diagnostic buffers during sampling, flushes on stop, and preserves earlier evidence', {
  skip: process.platform !== 'linux', timeout: 10_000,
}, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'native-process-probe-'));
  const file = path.join(dir, 'sample.jsonl');
  let child: ReturnType<typeof startNativeProcessProbe> | null = null;
  try {
    child = startNativeProcessProbe(process.pid, process.execPath, file);
    const header = readFileSync(file, 'utf8');
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('native sampler never produced a sample')), 5000);
      child!.once('message', (message) => {
        clearTimeout(timeout);
        assert.deepEqual(message, { kind: 'sampling-started' });
        resolve();
      });
    });
    // A real child has sampled, but no sample reached the filesystem.
    assert.equal(readFileSync(file, 'utf8'), header);
    await stopNativeProcessProbe(child);
    assert.equal(child.exitCode, 0);
    const rows = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(rows[0].maxSamples, 1200);
    assert.equal(rows[0].persistence, 'buffered-until-finish');
    assert.equal(rows[0].maxBufferedBytes, 16 * 1024 * 1024);
    assert.equal(rows[0].schemaVersion, 'native-process-probe-v7');
    assert.equal(rows[0].lifecycle.maxIdentities, 64);
    assert.equal(rows[0].lifecycle.maxStatBytes, 4096);
    assert(rows.filter((row) => row.kind === 'sample').every((row) => Array.isArray(row.lifecycle)));
    assert.equal(rows[0].environment.maxBytes, 128 * 1024);
    assert.equal(rows[0].environment.persistence, 'once-per-pid-identity');
    assert.equal(rows[0].output.persistence, 'per-sample-buffered');
    assert.equal(rows[0].output.maxInfoBytes, 4096);
    assert(rows.filter((row) => row.kind === 'sample').flatMap((row) => row.processes)
      .some((row) => row.output?.descriptors.some((d: { fd: number; status: string }) => d.fd === 2 && d.status === 'captured')));
    const environments = rows.filter((row) => row.kind === 'sample')
      .flatMap((row) => row.processes).filter((row) => row.environment);
    assert(environments.some((row) => row.environment.status === 'captured'));
    assert.equal(new Set(environments.map((row) => `${row.pid}:${row.identity}`)).size, environments.length);
    assert.equal(rows.at(-1).kind, 'end');
    assert.equal(rows.at(-1).reason, 'stopped');
    assert(rows.at(-1).samples >= 1);
    assert(rows.at(-1).maxReadDurationMs >= 0);
    assert(rows.at(-1).totalSampleWorkMs >= rows.at(-1).maxReadDurationMs);
    assert.equal(rows.at(-1).samples, rows.filter((row) => row.kind === 'sample').length);
    const saved = readFileSync(file, 'utf8');
    assert.throws(() => startNativeProcessProbe(process.pid, process.execPath, file), /EEXIST/);
    assert.equal(readFileSync(file, 'utf8'), saved);
  } finally {
    await stopNativeProcessProbe(child);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('real native sampler retains a disappeared child identity without guessing its known parent-side signal', {
  skip: process.platform !== 'linux', timeout: 10_000,
}, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'native-process-lifecycle-'));
  const file = path.join(dir, 'sample.jsonl');
  const target = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  let sampler: ReturnType<typeof startNativeProcessProbe> | null = null;
  try {
    await once(target, 'spawn');
    sampler = startNativeProcessProbe(process.pid, process.execPath, file);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('native sampler did not start')), 5000);
      sampler!.once('message', (message) => {
        clearTimeout(timeout);
        assert.deepEqual(message, { kind: 'sampling-started' });
        resolve();
      });
    });
    const exit = once(target, 'exit');
    assert.equal(target.kill('SIGTERM'), true);
    assert.deepEqual(await exit, [null, 'SIGTERM']);
    // Allow the maintained 100ms sampler to observe the parent's completed reap.
    await new Promise((resolve) => setTimeout(resolve, 250));
    await stopNativeProcessProbe(sampler);
    assert.equal(sampler.exitCode, 0);
    const samples = readFileSync(file, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line)).filter((row) => row.kind === 'sample');
    const before = samples.flatMap((row) => row.processes)
      .find((row) => row.pid === target.pid);
    assert(before, 'the actual child must have been observed before its exit');
    const after = samples.flatMap((row) => row.lifecycle)
      .find((row) => row.pid === target.pid && row.status === 'procfs-missing');
    assert(after, 'the running sampler must retain the missing child lifetime');
    assert.equal(after.identity, before.identity);
    assert.equal(after.signal, null, 'the sampler has no parent-side wait receipt');
    assert.equal(after.exitCode, null);
    assert.equal(after.reaping, 'unknown');
  } finally {
    if (target.exitCode === null && target.signalCode === null) {
      const exit = once(target, 'exit');
      target.kill('SIGTERM');
      await exit;
    }
    await stopNativeProcessProbe(sampler);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('diagnostic index rejects SPA directory symlinks and index hardlinks before touching the baseline', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'startup-storage-artifact-'));
  try {
    const baselineDir = path.join(dir, 'baseline');
    mkdirSync(baselineDir);
    const baseline = path.join(baselineDir, 'index.html');
    const html = '<html><head></head><body>baseline</body></html>';
    writeFileSync(baseline, html);
    const alias = path.join(dir, 'alias');
    symlinkSync(baselineDir, alias, 'dir');
    assert.throws(() => writeStartupStorageDiagnosticIndex(alias, baseline, 'probe();'), /aliases its baseline/);
    assert.equal(readFileSync(baseline, 'utf8'), html);
    const diagnostic = path.join(dir, 'diagnostic');
    mkdirSync(diagnostic);
    const index = path.join(diagnostic, 'index.html');
    linkSync(baseline, index);
    assert.throws(() => writeStartupStorageDiagnosticIndex(diagnostic, baseline, 'probe();'), /aliases its baseline/);
    assert.equal(readFileSync(baseline, 'utf8'), html);
    rmSync(index);
    writeFileSync(index, html);
    writeStartupStorageDiagnosticIndex(diagnostic, baseline, 'probe();');
    assert(readFileSync(index, 'utf8').includes('<script data-p007-startup-storage-probe="r158">probe();</script>'));
    assert.equal(readFileSync(baseline, 'utf8'), html);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('early native startup probe does not initialize speech and retains native timings beyond the storage cap', () => {
  const globals = ['window', 'Storage', 'performance'] as const;
  const originals = globals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  let clock = 0;
  let getterCalls = 0;
  let getterFailure = false;
  let methodFailure = false;
  const failure = new Error('native speech failure');
  const voices = [{ name: 'private voice' }];
  class NativeSpeech {
    getVoices() {
      assert.equal(this, speech);
      clock += 700;
      if (methodFailure) throw failure;
      return voices;
    }
  }
  class NativeStorage { getItem() { return null; } }
  const speech = new NativeSpeech();
  const storage = new NativeStorage();
  const fakeWindow = {} as { localStorage: NativeStorage; speechSynthesis: NativeSpeech; __pcStartupStorageProbe?: unknown };
  const speechGetter = function (this: unknown) {
    assert.equal(this, fakeWindow);
    getterCalls++;
    clock += 4000;
    if (getterFailure) throw failure;
    return speech;
  };
  Object.defineProperty(fakeWindow, 'speechSynthesis', { configurable: true, get: speechGetter });
  Object.defineProperty(fakeWindow, 'localStorage', { configurable: true, get: () => storage });
  const originalMethod = NativeSpeech.prototype.getVoices;
  for (const [name, value] of [['window', fakeWindow], ['Storage', NativeStorage],
    ['performance', { now: () => clock++, timeOrigin: 1000 }]] as const) {
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  try {
    Function(buildStartupStorageProbeScript())();
    const probe = fakeWindow.__pcStartupStorageProbe as ReturnType<typeof installStartupStorageProbe>;
    assert.equal(getterCalls, 0);
    for (let i = 0; i < 210; i++) fakeWindow.localStorage.getItem();
    assert.equal(fakeWindow.speechSynthesis, speech);
    assert.equal(speech.getVoices(), voices);
    getterFailure = true;
    assert.throws(() => fakeWindow.speechSynthesis, (error) => error === failure);
    getterFailure = false;
    methodFailure = true;
    assert.throws(() => speech.getVoices(), (error) => error === failure);
    methodFailure = false;
    const report = probe.stop();
    assert.equal(report.rows.length, 200);
    assert(report.dropped > 0);
    assert.equal(report.nativeStartup.rows.length, 4);
    assert(report.nativeStartup.rows.some((r) => r.operation === 'get:speechSynthesis' && r.durationMs >= 4000 && r.caller));
    assert(report.nativeStartup.rows.some((r) => r.operation === 'speechSynthesis.getVoices' && r.durationMs >= 700));
    assert.equal(report.nativeStartup.rows.filter((r) => r.threw).length, 2);
    assert(!JSON.stringify(report).includes('private voice'));
    assert.equal(Object.getOwnPropertyDescriptor(fakeWindow, 'speechSynthesis')!.get, speechGetter);
    assert.equal(NativeSpeech.prototype.getVoices, originalMethod);
    const bounded = installStartupStorageProbe();
    for (let i = 0; i < 25; i++) speech.getVoices();
    // Install the method lazily via the caller's first native getter access.
    fakeWindow.speechSynthesis;
    for (let i = 0; i < 25; i++) speech.getVoices();
    const boundedReport = bounded.stop();
    assert.equal(boundedReport.nativeStartup.rows.length, 20);
    assert.equal(boundedReport.nativeStartup.dropped, 6);
  } finally {
    NativeSpeech.prototype.getVoices = originalMethod;
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

test('early serialized storage probe measures native getters/calls, preserves semantics and restores', () => {
  const globals = ['window', 'Storage', 'performance'] as const;
  const originals = globals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  let clock = 0;
  let getterCalls = 0;
  let getterFailure = false;
  const failure = new Error('native failure');
  class NativeStorage {
    private readonly data = new Map<string, string>();
    getItem(key: string) { clock += 10; return this.data.get(key) ?? null; }
    setItem(key: string, value: string) { if (key === 'fail') throw failure; this.data.set(String(key), String(value)); }
    removeItem(key: string) { this.data.delete(key); }
    clear() { this.data.clear(); }
    key(index: number) { return [...this.data.keys()][index] ?? null; }
  }
  const native = new NativeStorage();
  const fakeWindow = {} as { localStorage: NativeStorage; __pcStartupStorageProbe?: unknown };
  const getter = () => { getterCalls++; clock += 6; if (getterFailure) throw failure; return native; };
  Object.defineProperty(fakeWindow, 'localStorage', { configurable: true, get: getter });
  Object.defineProperty(fakeWindow, 'sessionStorage', { configurable: false, get: getter });
  const originalGetItem = NativeStorage.prototype.getItem;
  for (const [name, value] of [['window', fakeWindow], ['Storage', NativeStorage],
    ['performance', { now: () => clock++, timeOrigin: 1000 }]] as const) {
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  try {
    // Exercise the exact bundled payload inserted in a native diagnostic SPA.
    const script = buildStartupStorageProbeScript();
    assert(!script.includes('__name'));
    Function(script)();
    const probe = fakeWindow.__pcStartupStorageProbe as ReturnType<typeof installStartupStorageProbe>;
    assert.equal(getterCalls, 0);
    const storage = fakeWindow.localStorage;
    storage.setItem('key', 'private value');
    assert.equal(storage.getItem('key'), 'private value');
    assert.equal(storage.key(0), 'key');
    let coercions = 0;
    storage.setItem('coercion', { toString() { coercions++; return 'coerced'; } } as unknown as string);
    assert.equal(coercions, 1);
    assert.throws(() => storage.setItem('fail', 'secret'), (error) => error === failure);
    getterFailure = true;
    assert.throws(() => fakeWindow.localStorage, (error) => error === failure);
    getterFailure = false;
    storage.removeItem('key');
    assert.equal(storage.getItem('key'), null);
    storage.clear();
    const report = probe.stop();
    assert.equal(fakeWindow.__pcStartupStorageProbe, probe);
    assert(report.unavailable.includes('get:sessionStorage'));
    assert(report.rows.some((row) => row.operation === 'get:localStorage' && row.durationMs >= 6));
    assert(report.rows.some((row) => row.operation === 'get:localStorage' && row.threw));
    assert(report.rows.some((row) => row.operation === 'getItem' && row.area === 'localStorage' && row.caller));
    assert(report.rows.some((row) => row.operation === 'setItem' && row.threw && row.key === 'fail'));
    assert.equal(report.rows.find((row) => row.operation === 'setItem')!.valueBytes, 'private value'.length * 2);
    assert(!JSON.stringify(report).includes('private value'));
    assert(!JSON.stringify(report).includes('secret'));
    assert.equal(Object.getOwnPropertyDescriptor(fakeWindow, 'localStorage')!.get, getter);
    assert.equal(NativeStorage.prototype.getItem, originalGetItem);
    assert.deepEqual(probe.stop().rows, report.rows);
    const bounded = installStartupStorageProbe();
    for (let i = 0; i < 220; i++) fakeWindow.localStorage.getItem('missing');
    const boundedReport = bounded.stop();
    assert.equal(boundedReport.rows.length, 200);
    assert(boundedReport.dropped > 0);
    const expired = installStartupStorageProbe();
    clock += 60_001;
    fakeWindow.localStorage.getItem('missing');
    assert.equal(expired.stop().rows.length, 0);
    const replaced = installStartupStorageProbe();
    const laterGetItem = () => 'later owner';
    NativeStorage.prototype.getItem = laterGetItem;
    replaced.stop();
    assert.equal(NativeStorage.prototype.getItem, laterGetItem);
    NativeStorage.prototype.getItem = originalGetItem;
  } finally {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

function startupRenderFixture() {
  const globals = ['window', 'document', 'performance', 'Storage'] as const;
  const originals = globals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  let clock = 0;
  let target: unknown = null;
  let subtitleTarget: unknown = null;
  let mutation: (() => void) | null = null;
  const frames = new Map<number, () => void>();
  let nextFrame = 0;
  let deadline: (() => void) | null = null;
  const companionTimers = new Map<number, () => void>();
  let nextTimer = 100;
  let disconnected = 0;
  let rectReads = 0;
  const milestones = new Map<string, unknown>();
  let watchedAttributes: string[] = [];
  const listeners = new Map<string, () => void>();
  const parent = { parentElement: null, style: { display: 'block', visibility: 'visible', opacity: '0' } };
  const element = { parentElement: parent, isConnected: true,
    style: { display: 'block', visibility: 'visible', opacity: '1' },
    getBoundingClientRect: () => { rectReads++; return { width: 100, height: 30, top: 1, left: 1, right: 101, bottom: 31 }; } };
  const subtitleParent = { ...parent, style: { ...parent.style, opacity: '1' } };
  const subtitle = { ...element, parentElement: subtitleParent };
  const fonts = { status: 'loading', ready: Promise.resolve(),
    addEventListener: (name: string, fn: () => void) => listeners.set(name, fn),
    removeEventListener: (name: string) => listeners.delete(name) };
  const fakeWindow = { innerWidth: 1280, innerHeight: 720,
    MutationObserver: class { constructor(fn: () => void) { mutation = fn; }
      observe(_root: unknown, options: { attributeFilter?: string[] }) { watchedAttributes = options.attributeFilter ?? []; }
      disconnect() { disconnected++; mutation = null; } },
    requestAnimationFrame: (fn: () => void) => { const id = ++nextFrame; frames.set(id, fn); return id; },
    cancelAnimationFrame: (id: number) => { frames.delete(id); },
    setTimeout: (fn: () => void, delay: number) => {
      if (delay === 0) { const id = ++nextTimer; companionTimers.set(id, fn); return id; }
      deadline = fn; return 2;
    },
    clearTimeout: (id: number) => { if (id === 2) deadline = null; else companionTimers.delete(id); },
    getComputedStyle: (node: typeof element | typeof parent) => node.style,
  };
  const values = { window: fakeWindow, document: { fonts, documentElement: {},
    querySelector: (selector: string) => selector === '.pclsb-acct__foot' ? target
      : selector === '.plans-pane__masthead-subtitle' ? subtitleTarget : milestones.get(selector) ?? null },
    performance: { now: () => clock }, Storage: undefined };
  for (const name of globals) Object.defineProperty(globalThis, name, { configurable: true, value: values[name] });
  return { fakeWindow, element, parent, subtitle, subtitleParent, fonts, listeners, tick: (ms: number) => { clock = ms; },
    insert: () => { target = element; mutation?.(); }, replace: () => { target = { ...element }; mutation?.(); },
    insertSubtitle: () => { subtitleTarget = subtitle; mutation?.(); },
    replaceSubtitle: () => { subtitleTarget = { ...subtitle }; mutation?.(); },
    insertMilestone: (selector: string, contains = (node: unknown) => node === element || node === subtitle, attribute?: string) => {
      milestones.set(selector, { isConnected: true, contains });
      if (!attribute || watchedAttributes.includes(attribute)) mutation?.();
    },
    mutate: () => mutation?.(),
    runFrame: () => { const pending = [...frames.values()]; frames.clear(); for (const fn of pending) fn(); },
    runCompanionTimers: () => { const pending = [...companionTimers.values()]; companionTimers.clear(); for (const fn of pending) fn(); },
    pendingCompanionTimers: () => companionTimers.size,
    expire: () => deadline?.(), pendingFrame: () => frames.size !== 0,
    disconnected: () => disconnected, rectReads: () => rectReads,
    restore: () => { for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    } },
  };
}

test('bundled startup frame timing separates a prompt timer from a delayed frame and costly geometry reads', () => {
  const f = startupRenderFixture();
  try {
    Function(buildStartupStorageProbeScript())();
    const probe = (f.fakeWindow as unknown as { __pcStartupStorageProbe: ReturnType<typeof installStartupStorageProbe> }).__pcStartupStorageProbe;
    f.tick(800); f.insert();
    assert.equal(f.rectReads(), 0);
    assert.equal(f.pendingCompanionTimers(), 1);
    f.tick(810); f.runCompanionTimers();
    let readAt = 1600;
    f.parent.style.opacity = '1';
    f.fakeWindow.getComputedStyle = (node) => { readAt += 5; f.tick(readAt); return node.style; };
    f.element.getBoundingClientRect = () => {
      readAt += 7; f.tick(readAt); return { width: 100, height: 30, top: 1, left: 1, right: 101, bottom: 31 };
    };
    f.tick(1600); f.runFrame();
    const report = probe.stop().render;
    assert.equal(report.firstFrameQueuedAtMs, 800);
    assert.equal(report.firstCompanionTimerAtMs, 810);
    assert.equal(report.firstCompanionTimerStopReason, 'completed');
    assert.equal(report.firstFrameAtMs, 1600);
    assert.equal(report.firstFrameReadCompletedAtMs, 1617);
    assert.equal(report.firstFrameOutcome, 'eligible');
    assert.equal(report.totalObserverWorkMs, 17);
    assert.equal(f.pendingCompanionTimers(), 0);
  } finally { f.restore(); }
});

test('bundled startup first-frame operations distinguish style lookup, property, traversal and rectangle costs', () => {
  const f = startupRenderFixture();
  try {
    Function(buildStartupStorageProbeScript())();
    const probe = (f.fakeWindow as unknown as { __pcStartupStorageProbe: ReturnType<typeof installStartupStorageProbe> }).__pcStartupStorageProbe;
    let clock = 1000;
    const advance = (ms: number) => { clock += ms; f.tick(clock); };
    const calls: string[] = [];
    f.parent.style.opacity = '1';
    Object.defineProperties(f.element.style, {
      display: { get: () => { calls.push('display'); advance(2); return 'block'; } },
      visibility: { get: () => { calls.push('visibility'); advance(3); return 'visible'; } },
      opacity: { get: () => { calls.push('opacity'); advance(5); return '1'; } },
    });
    Object.defineProperty(f.element, 'parentElement', { get: () => { advance(4); return f.parent; } });
    Object.defineProperty(f.parent, 'parentElement', { get: () => { advance(4); return null; } });
    f.fakeWindow.getComputedStyle = (node) => { advance(5); return node.style; };
    f.element.getBoundingClientRect = () => {
      advance(7); return { width: 100, height: 30, top: 1, left: 1, right: 101, bottom: 31 };
    };
    Object.defineProperty(f.fakeWindow, 'innerHeight', { get: () => { advance(11); return 720; } });
    Object.defineProperty(f.fakeWindow, 'innerWidth', { get: () => { advance(13); return 1280; } });
    f.tick(clock); f.insert();
    assert.deepEqual(calls, [], 'DOM discovery must not evaluate styles');
    f.runFrame();
    const report = probe.stop().render;
    assert.deepEqual(report.firstFrameOperations.map((row) => [row.operation, row.ancestorDepth, row.durationMs, row.threw]), [
      ['connection-check', null, 0, false],
      ['computed-style', 0, 5, false], ['visibility-check', 0, 13, false], ['parent-element', 0, 4, false],
      ['computed-style', 1, 5, false], ['visibility-check', 1, 0, false], ['parent-element', 1, 4, false],
      ['bounding-rect', null, 7, false], ['viewport-check', null, 24, false],
    ]);
    assert.deepEqual(calls, ['display', 'visibility', 'visibility', 'opacity'], 'preserve native short-circuit evaluation');
    assert.equal(report.firstFrameReadCompletedAtMs! - report.firstFrameAtMs!, 62);
    assert.equal(report.firstFrameOperations.reduce((sum, row) => sum + row.durationMs, 0), 62);
    for (const row of report.firstFrameOperations) assert.equal(row.completedAtMs - row.startedAtMs, row.durationMs);
    assert.match(report.firstFrameOperationsScope, /observer.*not.*cause/);
  } finally { f.restore(); }
});

test('startup operation timing retains thrown reads without geometry, retries or private error content', () => {
  for (const operation of ['computed-style', 'visibility-check', 'parent-element', 'bounding-rect', 'viewport-check']) {
    const f = startupRenderFixture();
    try {
      let clock = 200;
      const fail = () => { f.tick(clock += 9); throw new Error('private operation failure'); };
      f.parent.style.opacity = '1';
      if (operation === 'computed-style') f.fakeWindow.getComputedStyle = fail;
      if (operation === 'visibility-check') Object.defineProperty(f.element.style, 'display', { get: fail });
      if (operation === 'parent-element') Object.defineProperty(f.element, 'parentElement', { get: fail });
      if (operation === 'bounding-rect') f.element.getBoundingClientRect = fail;
      if (operation === 'viewport-check') Object.defineProperty(f.fakeWindow, 'innerHeight', { get: fail });
      const probe = installStartupStorageProbe();
      f.tick(clock); f.insert(); f.runFrame();
      const report = probe.stop().render;
      assert.equal(report.stopReason, 'unavailable');
      assert.equal(report.firstFrameOperations.at(-1)?.operation, operation);
      assert.equal(report.firstFrameOperations.at(-1)?.durationMs, 9);
      assert.equal(report.firstFrameOperations.at(-1)?.threw, true);
      assert.equal(report.firstFrameOperations.filter((row) => row.threw).length, 1);
      assert.equal(report.firstFrameReadCompletedAtMs, 209);
      assert(!JSON.stringify(report).includes('private operation failure'));
      assert.equal(f.pendingFrame(), false);
    } finally { f.restore(); }
  }
});

test('startup operation rows are bounded to the first frame and remain separate for each candidate', () => {
  const f = startupRenderFixture();
  try {
    const probe = installStartupStorageProbe();
    f.tick(300); f.insert(); f.insertSubtitle(); f.runFrame();
    for (let i = 0; i < 31; i++) { f.tick(400 + i); f.mutate(); f.runFrame(); }
    const reports = probe.stop().render.candidates;
    assert.equal(reports[0].frameReads, 32);
    assert.equal(reports[1].frameReads, 1);
    assert.deepEqual(reports[0].firstFrameOperations.map((row) => row.operation), [
      'connection-check', 'computed-style', 'visibility-check', 'parent-element', 'computed-style', 'visibility-check',
    ]);
    assert.equal(reports[1].firstFrameOperations.at(-2)?.operation, 'bounding-rect');
    assert.equal(reports[1].firstFrameOperations.at(-1)?.operation, 'viewport-check');
    assert(reports.every((report) => report.firstFrameOperations.every((row) => row.startedAtMs === 300)));
    assert.notEqual(reports[0].firstFrameOperations, reports[1].firstFrameOperations);
  } finally { f.restore(); }
});

test('startup ancestor cap prevents unbounded operation records and rectangle reads', () => {
  const f = startupRenderFixture();
  try {
    f.parent.style.opacity = '1';
    Object.defineProperty(f.parent, 'parentElement', { get: () => f.parent });
    Function(buildStartupStorageProbeScript())();
    const probe = (f.fakeWindow as unknown as { __pcStartupStorageProbe: ReturnType<typeof installStartupStorageProbe> }).__pcStartupStorageProbe;
    f.insert(); f.runFrame();
    const report = probe.stop().render;
    assert.equal(report.firstFrameOutcome, 'ancestor-depth');
    assert.equal(report.firstFrameOperations.length, 97);
    assert.equal(report.firstFrameOperations.filter((row) => row.operation === 'computed-style').length, 32);
    assert.equal(report.firstFrameOperations.at(-1)?.ancestorDepth, 31);
    assert.equal(f.rectReads(), 0);
    assert.equal(report.maxFirstFrameOperations, 99);
    assert(report.firstFrameOperations.length <= report.maxFirstFrameOperations);
  } finally { f.restore(); }
});

test('startup paired callbacks distinguish both delayed from a cancelled or unavailable timer', () => {
  const f = startupRenderFixture();
  try {
    const probe = installStartupStorageProbe();
    f.tick(200); f.insert(); f.insertSubtitle();
    assert.equal(f.pendingCompanionTimers(), 2, 'one timer per first candidate frame');
    for (let i = 0; i < 20; i++) f.mutate();
    assert.equal(f.pendingCompanionTimers(), 2, 'mutation bursts must not add timers');
    f.tick(900); f.runCompanionTimers(); f.tick(910); f.runFrame();
    const reports = probe.stop().render.candidates;
    assert.deepEqual(reports.map((row) => row.firstFrameQueuedAtMs), [200, 200]);
    assert.deepEqual(reports.map((row) => row.firstCompanionTimerAtMs), [900, 900]);
    assert.deepEqual(reports.map((row) => row.firstFrameReadCompletedAtMs), [910, 910]);
    assert.deepEqual(reports.map((row) => row.firstFrameOutcome), ['hidden-ancestor', 'eligible']);

    f.parent.style.opacity = '1';
    const frameFirst = installStartupStorageProbe(); f.tick(1000); f.runFrame();
    assert.equal(f.pendingCompanionTimers(), 2, 'eligible frames must preserve both pending companion observations');
    f.tick(1250); f.runCompanionTimers();
    const completed = frameFirst.stop().render;
    assert.equal(completed.firstCompanionTimerAtMs, 1250);
    assert.equal(completed.firstCompanionTimerStopReason, 'completed');
    assert.equal(completed.firstFrameAtMs, 1000, 'a later timer must not replace the first frame timestamp');
    assert.equal(f.pendingCompanionTimers(), 0);

    const timerNative = f.fakeWindow.setTimeout;
    f.fakeWindow.setTimeout = (fn, delay) => { if (delay === 0) throw new Error('private timer failure'); return timerNative(fn, delay); };
    const unavailable = installStartupStorageProbe(); f.runFrame();
    const missing = unavailable.stop().render;
    assert.equal(missing.firstCompanionTimerAtMs, null);
    assert.equal(missing.firstCompanionTimerStopReason, 'unavailable');
    assert(missing.unavailable.includes('companion-timer'));
    assert.equal(missing.stopReason, 'eligible-frame', 'timer failure must preserve frame observations');
    assert(!JSON.stringify(missing).includes('private timer failure'));
  } finally { f.restore(); }
});

test('startup companion timers are cancelled on replacement, explicit stop and deadline', () => {
  const f = startupRenderFixture();
  try {
    const replaced = installStartupStorageProbe(); f.insert(); f.replace();
    assert.equal(replaced.stop().render.firstCompanionTimerStopReason, 'candidate-replaced');
    assert.equal(f.pendingCompanionTimers(), 0);
    const stopped = installStartupStorageProbe();
    assert.equal(f.pendingCompanionTimers(), 1);
    assert.equal(stopped.stop().render.firstCompanionTimerStopReason, 'stopped');
    const expired = installStartupStorageProbe(); f.tick(60_000); f.expire();
    assert.equal(expired.stop().render.firstCompanionTimerStopReason, 'deadline');
    assert.equal(f.pendingCompanionTimers(), 0);
    assert.equal(f.pendingFrame(), false);
    f.tick(0);
    const delayedTimer = installStartupStorageProbe();
    f.tick(60_000); f.runCompanionTimers();
    const overdue = delayedTimer.stop().render;
    assert.equal(overdue.firstCompanionTimerAtMs, null, 'overdue callbacks are not accepted observations');
    assert.equal(overdue.firstCompanionTimerStopReason, 'deadline');
    assert.equal(overdue.stopReason, 'deadline');
    assert.equal(f.pendingFrame(), false);
  } finally { f.restore(); }
});

test('bundled frame-first companion observations survive eligibility but remain bounded by stop and deadline', () => {
  const f = startupRenderFixture();
  try {
    f.parent.style.opacity = '1';
    Function(buildStartupStorageProbeScript())();
    const probe = (f.fakeWindow as unknown as { __pcStartupStorageProbe: ReturnType<typeof installStartupStorageProbe> }).__pcStartupStorageProbe;
    f.tick(200); f.insert(); f.insertSubtitle();
    f.tick(900); f.runFrame();
    assert.equal(f.pendingCompanionTimers(), 2, 'frame completion must not censor a later timer callback');
    assert.equal(f.pendingFrame(), false);
    const reads = f.rectReads();
    for (let i = 0; i < 20; i++) f.mutate();
    assert.equal(f.pendingCompanionTimers(), 2, 'completed candidates never queue another companion');
    f.tick(950); f.runCompanionTimers();
    const rows = probe.stop().render.candidates;
    assert.deepEqual(rows.map((row) => row.firstFrameAtMs), [900, 900]);
    assert.deepEqual(rows.map((row) => row.firstCompanionTimerAtMs), [950, 950]);
    assert.deepEqual(rows.map((row) => row.firstCompanionTimerStopReason), ['completed', 'completed']);
    assert.equal(f.rectReads(), reads, 'the late timer performs no layout read');

    const stopped = installStartupStorageProbe(); f.tick(1000); f.runFrame();
    const cancelled = stopped.stop().render;
    assert.equal(cancelled.firstCompanionTimerAtMs, null);
    assert.equal(cancelled.firstCompanionTimerStopReason, 'stopped');
    assert.equal(cancelled.stopReason, 'eligible-frame');
    assert.equal(f.pendingCompanionTimers(), 0);

    const expired = installStartupStorageProbe(); f.tick(1100); f.runFrame();
    f.tick(61_000); f.expire();
    const overdue = expired.stop().render;
    assert.equal(overdue.firstCompanionTimerAtMs, null);
    assert.equal(overdue.firstCompanionTimerStopReason, 'deadline');
    assert.equal(f.pendingCompanionTimers(), 0);
  } finally { f.restore(); }
});

test('bundled startup milestones distinguish late Accounts mount from an earlier sidebar without layout or content reads', () => {
  const f = startupRenderFixture();
  try {
    Function(buildStartupStorageProbeScript())();
    const probe = (f.fakeWindow as unknown as { __pcStartupStorageProbe: ReturnType<typeof installStartupStorageProbe> }).__pcStartupStorageProbe;
    f.tick(100); f.insertMilestone('[data-testid="operator-shell"], .pc-advshell');
    f.tick(200); f.insertMilestone('[data-testid="left-sidebar"][data-tab="accounts"][data-collapsed="false"]');
    f.tick(210); f.insertMilestone('.pclsb__body > .pclsb-panel__empty', () => false);
    f.tick(900); f.insertMilestone('.pclsb-acct');
    f.tick(910); f.insert();
    assert.equal(f.rectReads(), 0);
    f.parent.style.opacity = '1'; f.tick(1000); f.runFrame();
    const report = probe.stop().render;
    assert.deepEqual(report.milestones.map((row) => row.firstObservedAtMs), [100, 200, 210, 900]);
    assert(report.milestones.every((row) => row.stopReason === 'observed'));
    assert.deepEqual(report.milestoneMatchesAtFirstObservation.map((row) => row.matches), [true, true, false, true]);
    assert.equal(report.firstObservedAtMs, 910);
    assert.equal(report.firstEligibleFrameAtMs, 1000);
    assert.equal(probe.renderCandidateMatches(f.element), true);
    assert(!JSON.stringify(report).includes('textContent'));
    assert.equal(f.pendingFrame(), false);
  } finally { f.restore(); }
});

test('startup milestone attribution distinguishes a replaced host, unavailable containment and unobserved mount', () => {
  const f = startupRenderFixture();
  try {
    const probe = installStartupStorageProbe();
    f.tick(100); f.insertMilestone('[data-testid="operator-shell"], .pc-advshell', () => false);
    f.tick(200); f.insertMilestone('[data-testid="left-sidebar"][data-tab="accounts"][data-collapsed="false"]', () => { throw new Error('private ancestor'); });
    f.tick(300); f.insertMilestone('[data-testid="operator-shell"], .pc-advshell');
    f.tick(400); f.insert();
    const report = probe.stop().render;
    assert.deepEqual(report.milestoneMatchesAtFirstObservation.map((row) => row.matches), [false, null, null, null]);
    assert.equal(report.milestones[0]!.firstObservedAtMs, 100, 'replacement cannot rewrite the earlier host identity');
    assert(report.milestones[1]!.unavailable.includes('containment-read'));
    assert.equal(report.milestones[3]!.firstObservedAtMs, null);
    assert.equal(report.milestones[3]!.stopReason, 'stopped');
    assert(!JSON.stringify(report).includes('private ancestor'));
  } finally { f.restore(); }
});

test('startup milestone observes attribute-only Accounts host activation before a later footer', () => {
  const f = startupRenderFixture();
  try {
    const probe = installStartupStorageProbe();
    f.tick(200); f.insertMilestone('[data-testid="left-sidebar"][data-tab="accounts"][data-collapsed="false"]', () => true, 'data-collapsed');
    f.tick(400); f.insert();
    const report = probe.stop().render;
    assert.equal(report.milestones[1]!.firstObservedAtMs, 200);
    assert.equal(report.milestoneMatchesAtFirstObservation[1]!.matches, true);
    assert.equal(f.rectReads(), 0);
  } finally { f.restore(); }
});

test('bundled startup probe separates late DOM discovery, ancestor visibility and font readiness', async () => {
  const f = startupRenderFixture();
  try {
    Function(buildStartupStorageProbeScript())();
    const probe = (f.fakeWindow as unknown as { __pcStartupStorageProbe: ReturnType<typeof installStartupStorageProbe> }).__pcStartupStorageProbe;
    f.tick(1000); f.insert();
    assert.equal(f.rectReads(), 0, 'MutationObserver must not force layout');
    f.tick(1200); f.runFrame();
    f.parent.style.opacity = '1';
    f.tick(1300); f.mutate();
    f.tick(1400); f.runFrame();
    assert.equal(f.disconnected(), 0, 'the missing subtitle still needs DOM observation');
    f.tick(1600); f.fonts.status = 'loaded';
    await Promise.resolve();
    const report = probe.stop();
    assert.equal(probe.renderCandidateMatches(f.element), true);
    assert.equal(probe.renderCandidateMatches({ ...f.element }), false);
    assert.equal(report.render.firstObservedAtMs, 1000);
    assert.equal(report.render.firstFrameAtMs, 1200);
    assert.equal(report.render.firstEligibleFrameAtMs, 1400);
    assert.equal(report.render.stopReason, 'eligible-frame');
    assert.equal(report.render.fonts.readyAtMs, 1600);
    assert.equal(report.render.fonts.initialStatus, 'loading');
    assert.equal(f.listeners.size, 0);
    assert.equal(f.pendingFrame(), false);
    assert(f.disconnected() > 0);
    assert(!JSON.stringify(report.render).includes('textContent'));
  } finally { f.restore(); }
});

test('bundled startup probe joins the actual subtitle independently of a later footer', () => {
  const f = startupRenderFixture();
  try {
    Function(buildStartupStorageProbeScript())();
    const probe = (f.fakeWindow as unknown as { __pcStartupStorageProbe: ReturnType<typeof installStartupStorageProbe> }).__pcStartupStorageProbe;
    assert.deepEqual(probe.renderCandidateMatchesBySelector(f.subtitle), [
      { selector: '.pclsb-acct__foot', matches: null },
      { selector: '.plans-pane__masthead-subtitle', matches: null },
    ]);
    f.tick(1000); f.insertSubtitle();
    assert.equal(f.rectReads(), 0);
    f.tick(1100); f.runFrame();
    assert.equal(f.disconnected(), 0, 'one eligible candidate must not end observation of the other');
    f.tick(2000); f.insert();
    f.tick(2100); f.runFrame();
    f.parent.style.opacity = '1';
    f.tick(2200); f.mutate(); f.runFrame();
    const report = probe.stop();
    assert.deepEqual(probe.renderCandidateMatchesBySelector(f.subtitle), [
      { selector: '.pclsb-acct__foot', matches: false },
      { selector: '.plans-pane__masthead-subtitle', matches: true },
    ]);
    assert.deepEqual(probe.renderCandidateMatchesBySelector(null).map((row) => row.matches), [null, null]);
    assert.deepEqual(probe.renderCandidateMatchesBySelector({ ...f.subtitle }).map((row) => row.matches), [false, false]);
    assert.equal(probe.renderCandidateMatches(f.subtitle), false, 'legacy field is still the footer join');
    assert.deepEqual(report.render.candidates.map((row) => [row.selector, row.firstObservedAtMs, row.firstEligibleFrameAtMs]), [
      ['.pclsb-acct__foot', 2000, 2200], ['.plans-pane__masthead-subtitle', 1000, 1100],
    ]);
    assert.equal(report.render.firstObservedAtMs, 2000, 'legacy timing is still the footer');
    assert.equal(f.listeners.size, 0);
    assert.equal(f.pendingFrame(), false);
  } finally { f.restore(); }
});

test('replaced or unreadable subtitle fails closed without cancelling the footer observation', () => {
  const f = startupRenderFixture();
  try {
    const probe = installStartupStorageProbe();
    f.insertSubtitle(); f.replaceSubtitle();
    assert.equal(f.pendingFrame(), false);
    assert.equal(f.disconnected(), 0);
    f.tick(3000); f.insert(); f.parent.style.opacity = '1'; f.runFrame();
    const report = probe.stop();
    assert.deepEqual(report.render.candidates.map((row) => row.stopReason), ['eligible-frame', 'candidate-replaced']);
    assert.deepEqual(probe.renderCandidateMatchesBySelector(f.subtitle).map((row) => row.matches), [false, null]);
    const failed = installStartupStorageProbe();
    f.fakeWindow.getComputedStyle = (node) => {
      if (node === f.subtitleParent) throw new Error('private subtitle style');
      return node.style;
    };
    f.runFrame();
    const failure = failed.stop();
    assert.equal(failure.render.stopReason, 'eligible-frame');
    assert.equal(failure.render.candidates[1].stopReason, 'unavailable');
    assert(failure.render.candidates[1].unavailable.includes('frame-read'));
    assert(!JSON.stringify(failure).includes('private subtitle style'));
  } finally { f.restore(); }
});

test('bundled Web Vitals preserves per-candidate identity for actual LCP entries and absent elements', async () => {
  const f = startupRenderFixture();
  try {
    Function(buildStartupStorageProbeScript())();
    f.insertSubtitle(); f.insert();
    const observers = new Map<string, (list: { getEntries: () => unknown[] }) => void>();
    const page = f.fakeWindow as typeof f.fakeWindow & { __wv_ready?: boolean; __wv_lcp_error?: unknown;
      __wv_lcp?: { startupCandidateMatches: boolean | null; startupCandidates: Array<{ selector: string; matches: boolean | null }> } };
    runInNewContext(buildWebVitalsBundle(), {
      window: page, self: page,
      document: { readyState: 'complete', visibilityState: 'visible', prerendering: false },
      performance: { now: () => 10_000, getEntriesByType: () => [] },
      addEventListener() {}, removeEventListener() {},
      requestAnimationFrame() {}, setTimeout() {}, queueMicrotask,
      PerformanceObserver: class {
        static supportedEntryTypes = ['largest-contentful-paint'];
        constructor(private callback: (list: { getEntries: () => unknown[] }) => void) {}
        observe({ type }: { type: string }) { observers.set(type, this.callback); }
        takeRecords() { return []; }
        disconnect() {}
      },
    });
    assert.equal(page.__wv_ready, true);
    const publish = async (element: unknown, startTime: number) => {
      const callback = observers.get('largest-contentful-paint');
      assert(callback, 'the real bundled LCP observer must register');
      callback({ getEntries: () => [{ startTime, renderTime: startTime, loadTime: 0, size: 100, element }] });
      await Promise.resolve();
      assert.equal(page.__wv_lcp_error, null);
      return JSON.parse(JSON.stringify(page.__wv_lcp));
    };
    const subtitle = await publish(f.subtitle, 1000);
    assert.equal(subtitle.startupCandidateMatches, false);
    assert.deepEqual(subtitle.startupCandidates, [
      { selector: '.pclsb-acct__foot', matches: false },
      { selector: '.plans-pane__masthead-subtitle', matches: true },
    ]);
    const footer = await publish(f.element, 2000);
    assert.equal(footer.startupCandidateMatches, true);
    assert.deepEqual(footer.startupCandidates.map((row: { matches: boolean }) => row.matches), [true, false]);
    assert.deepEqual((await publish(null, 3000)).startupCandidates.map((row: { matches: null }) => row.matches), [null, null]);
    (page as unknown as { __pcStartupStorageProbe: ReturnType<typeof installStartupStorageProbe> }).__pcStartupStorageProbe.stop();
  } finally { f.restore(); }
});

test('startup render observation bounds mutations, cancels frames and distinguishes missing from unavailable', () => {
  const f = startupRenderFixture();
  try {
    const bounded = installStartupStorageProbe();
    for (let i = 0; i < 1001; i++) f.mutate();
    const capped = bounded.stop().render;
    assert.equal(capped.stopReason, 'mutation-cap');
    assert.equal(capped.firstObservedAtMs, null);
    assert.equal(capped.mutationCallbacks, 1000);
    assert(capped.candidates.every((row) => row.stopReason === 'mutation-cap' && row.mutationCallbacks === 1000));
    assert(capped.milestones.every((row) => row.reads === 1000 && row.stopReason === 'read-cap'));
    const expired = installStartupStorageProbe();
    f.tick(60_001); f.expire();
    const deadlineReport = expired.stop().render;
    assert.equal(deadlineReport.stopReason, 'deadline');
    assert(deadlineReport.milestones.every((row) => row.stopReason === 'deadline'));
    const pending = installStartupStorageProbe();
    f.insert(); assert(f.pendingFrame());
    pending.stop(); assert.equal(f.pendingFrame(), false);
    (f.fakeWindow as unknown as { MutationObserver?: unknown }).MutationObserver = undefined;
    const missing = installStartupStorageProbe().stop().render;
    assert.equal(missing.stopReason, 'unavailable');
    assert(missing.unavailable.includes('MutationObserver'));
    assert(missing.candidates.every((row) => row.stopReason === 'unavailable' && row.unavailable.includes('MutationObserver')));
    assert(missing.milestones.every((row) => row.stopReason === 'unavailable' && row.unavailable.includes('MutationObserver')));
  } finally { f.restore(); }
});

test('startup render probe fails closed on candidate replacement, frame caps and failed reads', () => {
  const f = startupRenderFixture();
  try {
    const replaced = installStartupStorageProbe();
    assert.equal(replaced.renderCandidateMatches(f.element), null);
    f.insert(); f.replace();
    assert.equal(replaced.stop().render.stopReason, 'candidate-replaced');
    assert.equal(f.pendingFrame(), false);
    const bounded = installStartupStorageProbe();
    for (let i = 0; i < 33; i++) { f.mutate(); f.runFrame(); }
    const report = bounded.stop().render;
    assert.equal(report.stopReason, 'frame-cap');
    assert.equal(report.frameReads, 32);
    assert.equal(report.firstEligibleFrameAtMs, null);
    f.fakeWindow.getComputedStyle = () => { throw new Error('private style failure'); };
    const failed = installStartupStorageProbe();
    f.runFrame();
    const failure = failed.stop().render;
    assert.equal(failure.stopReason, 'unavailable');
    assert(failure.unavailable.includes('frame-read'));
    assert(!JSON.stringify(failure).includes('private style failure'));
  } finally { f.restore(); }
});

test("startup trace separates completed-before-paint requests from later completions", async () => {
  const globals = ['window', 'document', 'performance', 'location', 'PerformanceObserver'] as const;
  const originals = globals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const lcp = { tag: 'DIV', className: 'plans-list', text: 'Plan title', startMs: 200 };
  const renderer = { unit: 'ms', clock: 'performance.now', intervalMs: 50, startedAtMs: 31,
    lastObservedAtMs: 49, timerTicks: 0, maxGapMs: 18, gaps: [], stoppedAtMs: 49, stopReason: 'reply' };
  const values = {
    window: { __wv_lcp: lcp, __sync_metrics__: { snapshot: () => ({
      scheduler: { tasks: [{ label: 'GET /api/bootstrap', state: 'running', enqueuedAtMs: 1, startedAtMs: 2, settledAtMs: null }] },
      ipcAssertion: [{ startedAtMs: 3, importReadyAtMs: 30, invokeStartedAtMs: 31,
        invokeCompletedAtMs: 49, completedAtMs: 50, client: 'connected', renderer }], stages: { recent: [
      { stage: 'reactCommit', unit: 'ms', durationMs: 15, measuredAtMs: 185, queryName: 'plans.list', traceId: 'query-plan' },
      { stage: 'updateToScreen', unit: 'ms', durationMs: 25, measuredAtMs: 195, queryName: 'plans.list', traceId: 'query-plan' },
      { stage: 'reactCommit', unit: 'ms', durationMs: 999, measuredAtMs: 999, queryName: 'unrelated', traceId: 'other' },
    ] } }), queries: () => [
      { name: 'finished-before-fcp', startedAtMs: 10, waitMs: 20, requestMs: 30, outcome: 'ok' },
      { name: 'finished-before-lcp', startedAtMs: 40, waitMs: 10, requestMs: 120, outcome: 'ok' },
      { name: 'finished-after-lcp', startedAtMs: 50, waitMs: 200, requestMs: 30, outcome: 'timeout' },
      { name: 'started-after-lcp', startedAtMs: 210, waitMs: 0, requestMs: 10, outcome: 'ok' },
      { name: 'plans.list', startedAtMs: 100, waitMs: 10, requestMs: 60, outcome: 'ok', traceId: 'query-plan',
        stages: { schedulerWaitMs: 10, resolverMs: 12, transferMs: 20, parseCacheMs: 3 } },
    ] } },
    document: { readyState: 'complete' },
    performance: { timeOrigin: 1_700_000_000_000, now: () => 250,
      getEntriesByName: (name: string, type: string) => name === 'accounts-tab-import' && type === 'measure'
        ? [{ startTime: 20, duration: 120 }] : [],
      getEntriesByType: () => [{ name: 'papercusp://localhost/assets/main.js', startTime: 5, duration: 30, initiatorType: 'script' }] },
    location: { href: 'papercusp://localhost/adv' }, PerformanceObserver: { supportedEntryTypes: [] },
  };
  for (const name of globals) Object.defineProperty(globalThis, name, { configurable: true, value: values[name] });
  try {
    const trace = await readPageStartupTrace({ fcpMs: 100, lcpMs: 200 });
    assert.equal(trace.lcp, lcp);
    assert.equal(trace.storage, null);
    assert.deepEqual(trace.documentClock, { timeOriginMs: 1_700_000_000_000, capturedAtMs: 250 });
    assert.equal(trace.queryCountCompletedBeforeFcp, 1);
    assert.equal(trace.startedBeforeFcpCompletedLater, 3);
    assert.deepEqual(trace.longestRequestsCompletedBeforeFcp.map((query) => query.name), ['finished-before-fcp']);
    assert.equal(trace.beforeLcp.queryCountCompleted, 3);
    assert.equal(trace.beforeLcp.startedCompletedLater, 1);
    assert.deepEqual(trace.beforeLcp.longestRequests.map((query) => query.name), ['finished-before-lcp', 'plans.list', 'finished-before-fcp']);
    assert.equal(trace.syncTrace.clock, 'performance.now');
    assert.equal(trace.syncTrace.unit, 'ms');
    assert.equal(trace.syncTrace.startupQueries[0].name, 'finished-before-fcp');
    assert.deepEqual(trace.syncTrace.planQueries[0].stages,
      { schedulerWaitMs: 10, resolverMs: 12, transferMs: 20, parseCacheMs: 3 });
    assert.deepEqual(trace.syncTrace.planStages.map(({ stage, measuredAtMs }) => ({ stage, measuredAtMs })),
      [{ stage: 'reactCommit', measuredAtMs: 185 }, { stage: 'updateToScreen', measuredAtMs: 195 }]);
    assert.equal(trace.resources[0].endMs, 35);
    assert.deepEqual(trace.startupImports.accountsTab, { startMs: 20, durationMs: 120, endMs: 140 });
    assert.equal(trace.ipc.client.kind, 'unavailable');
    assert.deepEqual(trace.ipc.assertion, [{ startedAtMs: 3, importReadyAtMs: 30, invokeStartedAtMs: 31,
      invokeCompletedAtMs: 49, completedAtMs: 50, client: 'connected', renderer }]);
    assert.deepEqual(trace.scheduler, { tasks: [{ label: 'GET /api/bootstrap', state: 'running', enqueuedAtMs: 1,
      startedAtMs: 2, settledAtMs: null }] });
    const missing = await readPageStartupTrace({ fcpMs: null, lcpMs: null });
    assert.equal(missing.queryCountCompletedBeforeFcp, 0);
    assert.equal(missing.beforeLcp.queryCountCompleted, 0);
    // A real IPC round trip yielded to a later LCP observer in native r146.
    // The trace must keep the subject captured with the measured 200ms value.
    let storageStopped = false;
    const storageTrace = { marker: 'captured before IPC' };
    Object.assign(values.window, { __pcStartupStorageProbe: { stop: () => {
      storageStopped = true;
      return storageTrace;
    } }, __TAURI_INTERNALS__: { invoke: async () => {
      assert.equal(storageStopped, true);
      values.window.__wv_lcp = { ...lcp, startMs: 900 };
      return { client: 'connected', ownerIsContentOrigin: true };
    } } });
    const atomic = await readPageStartupTrace({ fcpMs: 100, lcpMs: 200,
      attribution: { lcp, lcpAttributionError: null } });
    assert.equal(atomic.lcp, lcp);
    assert.deepEqual(atomic.storage, storageTrace);
    assert.equal(values.window.__wv_lcp.startMs, 900);
  } finally {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

test("combined native load verdict retains both individual budget breaches", () => {
  const reading: WebVitalsReading = { instrument: 'ready', brokenReason: null,
    metrics: { FCP: 3_001, LCP: 4_001 }, missingExpected: [], absentByEnvironment: [], errors: [] };
  const verdict = evaluateRequiredPageLoad(reading);
  assert.deepEqual(verdict.measures.map(({ value, ok }) => ({ value, ok })), [
    { value: 3_001, ok: false }, { value: 4_001, ok: false },
  ]);
  assert.equal(verdict.failures.length, 2);
  assert.deepEqual(evaluateRequiredPageLoad({ ...reading, metrics: { FCP: 3_000, LCP: 4_000 } }).failures, []);
});

test("combined native load verdict cannot pass empty, invalid or broken instruments", () => {
  const reading: WebVitalsReading = { instrument: 'ready', brokenReason: null,
    metrics: {}, missingExpected: [], absentByEnvironment: [], errors: [] };
  for (const metrics of [{}, { FCP: NaN, LCP: 0 }, { FCP: -1, LCP: Infinity }]) {
    const verdict = evaluateRequiredPageLoad({ ...reading, metrics });
    assert.equal(verdict.measures.length, 0);
    assert.equal(verdict.failures.length, 2);
  }
  const realMetrics = { FCP: 100, LCP: 200 };
  assert.match(evaluateRequiredPageLoad({ ...reading, metrics: realMetrics, instrument: 'threw',
    brokenReason: 'observer failed' }).failures[0], /observer failed/);
  assert.deepEqual(evaluateRequiredPageLoad({ ...reading, metrics: realMetrics, errors: ['registration failed'] }).failures,
    ['registration failed']);
});

test("React probe rejects a component chunk before importing or invoking its minified export", async () => {
  const result = await new Promise<{ installed: boolean; error?: string }>((done) =>
    installPopupReactProbe('/assets/dist-82810595.js', done));
  assert.equal(result.installed, false);
  assert.match(result.error ?? '', /requires the packaged react-\*\.js asset/);
});

test("React probe validates hooks, preserves effect semantics and restores instrumentation", async () => {
  const names = ['Function', 'window', 'performance'] as const;
  const originals = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  let now = 0;
  let loadedUrl = '';
  let module: Record<string, unknown>;
  const calls: Array<{ effect: () => unknown; deps: unknown; receiver: unknown }> = [];
  const hook = function (this: unknown, effect: () => unknown, deps: unknown) {
    calls.push({ effect, deps, receiver: this });
    return 'hook-result';
  };
  const react = { useEffect: hook, useLayoutEffect: hook, useInsertionEffect: hook };
  module = { t: () => react };
  const fakeWindow: { __perfReactProbe?: { records: Array<{ hook: string; ms: number }>; restore(): void } } = {};
  Object.defineProperty(globalThis, 'Function', { configurable: true, value: function () {
    return async (url: string) => { loadedUrl = url; return module; };
  } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => now } });
  try {
    const install = () => new Promise<{ installed: boolean; hooks?: string[]; error?: string }>((done) =>
      installPopupReactProbe('/assets/react-test.js', done));
    assert.deepEqual(await install(), { installed: true, hooks: ['useEffect', 'useLayoutEffect', 'useInsertionEffect'] });
    assert.equal(loadedUrl, '/assets/react-test.js');
    const deps = ['unchanged'];
    const cleanup = () => 'cleanup';
    assert.equal(react.useEffect(() => { now += 7; return cleanup; }, deps), 'hook-result');
    assert.equal(calls[0].deps, deps);
    assert.equal(calls[0].receiver, react);
    assert.equal(calls[0].effect(), cleanup);
    const error = new Error('effect failure');
    react.useLayoutEffect(() => { now += 9; throw error; }, deps);
    assert.throws(calls[1].effect, (actual) => actual === error);
    assert.deepEqual(fakeWindow.__perfReactProbe!.records.map(({ hook, ms }) => ({ hook, ms })), [
      { hook: 'useEffect', ms: 7 }, { hook: 'useLayoutEffect', ms: 9 },
    ]);
    fakeWindow.__perfReactProbe!.restore();
    fakeWindow.__perfReactProbe!.restore();
    assert.equal(react.useEffect, hook);
    assert.equal(react.useLayoutEffect, hook);
    assert.equal(react.useInsertionEffect, hook);
    module = { t: () => ({ useEffect: hook }) };
    const invalid = await install();
    assert.equal(invalid.installed, false);
    assert.match(invalid.error ?? '', /does not expose all three/);
  } finally {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

test("layout probe measures a later computed-style getter and preserves target, errors and cleanup", () => {
  const names = ['window', 'Element', 'HTMLElement', 'CSSStyleDeclaration', 'performance'] as const;
  const originals = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  let now = 0;
  let getterMs = 25;
  let getterError: Error | null = null;
  class Styles {
    get animationName() {
      now += getterMs;
      if (getterError) throw getterError;
      return 'none';
    }
  }
  class FakeElement {}
  const styles = new Styles();
  const timers: Array<() => void> = [];
  const fakeWindow = {
    getComputedStyle: () => styles,
    setTimeout(handler: Function, _delay: number, ...args: unknown[]) {
      timers.push(() => handler.apply(fakeWindow, args));
      return timers.length;
    },
  };
  const originalStyleGetter = Object.getOwnPropertyDescriptor(Styles.prototype, 'animationName');
  const originalComputedStyle = fakeWindow.getComputedStyle;
  const originalTimer = fakeWindow.setTimeout;
  const globals = { window: fakeWindow, Element: FakeElement, HTMLElement: FakeElement, CSSStyleDeclaration: Styles, performance: { now: () => now } };
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: globals[name] });
  try {
    const result = installPopupLayoutProbe();
    assert.ok(result.observed.includes('animationName'));
    const element = { tagName: 'DIV', id: 'plan', classList: ['plan-popup'], getAttribute: (name: string) => name === 'data-testid' ? 'popup' : null } as unknown as Element;
    const computed = window.getComputedStyle(element);
    type Record = { api: string; ms: number; at: number; target?: string; waitMs?: number; firedAt?: number };
    const probe = (window as unknown as { __perfLayoutProbe: { records: Record[]; restore(): void } }).__perfLayoutProbe;
    assert.equal(probe.records.length, 0, 'a fast getComputedStyle is not the delayed read');
    assert.equal(computed.animationName, 'none');
    assert.deepEqual(probe.records.map(({ api, ms, target }) => ({ api, ms, target })), [
      { api: 'animationName', ms: 25, target: 'div#plan[data-testid="popup"].plan-popup' },
    ]);
    getterMs = 2;
    void computed.animationName;
    assert.equal(probe.records.length, 1, 'fast reads stay below the diagnostic threshold');
    getterMs = 30;
    getterError = new Error('native style failure');
    assert.throws(() => computed.animationName, /native style failure/);
    assert.equal(probe.records[1].ms, 30);

    let received: unknown[] | null = null;
    let receiver: unknown;
    const timerId = window.setTimeout(function (this: unknown, ...args: unknown[]) { receiver = this; received = args; }, 300, 'original-argument');
    assert.equal(timerId, 1);
    const timer = probe.records[2];
    assert.equal(timer.waitMs, 300);
    assert.equal(timer.firedAt, undefined);
    now += 320;
    timers[0]();
    assert.deepEqual(received, ['original-argument']);
    assert.equal(receiver, fakeWindow);
    assert.equal(timer.ms, 320);
    assert.equal(timer.firedAt, now);
    probe.restore();
    probe.restore();
    assert.deepEqual(Object.getOwnPropertyDescriptor(Styles.prototype, 'animationName'), originalStyleGetter);
    assert.equal(fakeWindow.getComputedStyle, originalComputedStyle);
    assert.equal(fakeWindow.setTimeout, originalTimer);
  } finally {
    if (originalStyleGetter) Object.defineProperty(Styles.prototype, 'animationName', originalStyleGetter);
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

test("layout probe observes native-style object properties when a prototype getter cannot be installed", () => {
  const names = ['window', 'Element', 'HTMLElement', 'CSSStyleDeclaration', 'performance'] as const;
  const originals = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  let now = 0;
  class Styles {
    #brand = true;
    getPropertyValue() {
      assert.equal(this.#brand, true, 'native methods need their real receiver');
      return 'none';
    }
  }
  const styles = new Styles();
  Object.defineProperty(styles, 'animationName', { configurable: false, get() { now += 40; return 'none'; } });
  class FakeElement {}
  const fakeWindow = { getComputedStyle: () => styles, setTimeout: () => 1 };
  const globals = { window: fakeWindow, Element: FakeElement, HTMLElement: FakeElement, CSSStyleDeclaration: Styles, performance: { now: () => now } };
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: globals[name] });
  try {
    const result = installPopupLayoutProbe();
    assert.ok(result.observed.includes('animationName-proxy'));
    const attributes: Record<string, string> = { 'data-anim': 'fade', 'data-state': 'open' };
    const element = { tagName: 'DIV', id: '', classList: ['h-modal__content'], getAttribute: (name: string) => attributes[name] ?? null } as unknown as Element;
    const computed = window.getComputedStyle(element);
    assert.equal(computed.animationName, 'none');
    assert.equal(computed.getPropertyValue('animation-name'), 'none');
    assert.equal(computed.getPropertyValue, computed.getPropertyValue, 'method identity remains stable');
    const probe = (window as unknown as { __perfLayoutProbe: { records: Array<{ api: string; ms: number; target?: string }>; restore(): void } }).__perfLayoutProbe;
    assert.deepEqual(probe.records.map(({ api, ms, target }) => ({ api, ms, target })), [
      { api: 'animationName', ms: 40, target: 'div.h-modal__content[data-anim="fade"][data-state="open"]' },
    ]);
    probe.restore();
    assert.equal(fakeWindow.getComputedStyle(), styles);
  } finally {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

test("render probe preserves native HTML setters and Lute receivers, results, failures and restoration", () => {
  const names = ['window', 'Element', 'HTMLElement', 'CSSStyleDeclaration', 'performance'] as const;
  const originals = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  let now = 0;
  let fail = false;
  class FakeElement {
    tagName = 'DIV'; id = 'preview'; classList = ['vditor-reset'];
    getAttribute() { return null; }
    #html = '';
    get innerHTML() { return this.#html; }
    set innerHTML(value: string) {
      now += 40;
      if (fail) throw new Error('HTML failure');
      this.#html = value;
    }
  }
  const instance = {
    Md2HTML(this: unknown, value: string) {
      assert.equal(this, instance);
      now += 25;
      if (fail) throw new Error('compile failure');
      return `<p>${value}</p>`;
    },
  };
  const lute = { New(this: unknown, option: string) {
    assert.equal(this, lute); assert.equal(option, 'original'); now += 15; return instance;
  } };
  const originalNew = lute.New;
  const originalCompile = instance.Md2HTML;
  const originalHtml = Object.getOwnPropertyDescriptor(FakeElement.prototype, 'innerHTML');
  const fakeWindow = { Lute: lute, getComputedStyle: () => ({}), setTimeout: () => 1 };
  const globals = { window: fakeWindow, Element: FakeElement, HTMLElement: FakeElement, CSSStyleDeclaration: class {}, performance: { now: () => now } };
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: globals[name] });
  try {
    const installed = installPopupLayoutProbe();
    assert.ok(installed.observed.includes('innerHTML:set'));
    assert.ok(installed.observed.includes('Lute.Md2HTML'));
    const root = new FakeElement();
    assert.equal(lute.New('original'), instance);
    root.innerHTML = instance.Md2HTML('ready');
    assert.equal(root.innerHTML, '<p>ready</p>');
    fail = true;
    assert.throws(() => instance.Md2HTML('fail'), /compile failure/);
    assert.throws(() => { root.innerHTML = 'fail'; }, /HTML failure/);
    const probe = (window as unknown as { __perfLayoutProbe: { records: Array<{ api: string; ms: number; target?: string }>; restore(): void } }).__perfLayoutProbe;
    assert.deepEqual(probe.records.map(({ api, ms }) => ({ api, ms })), [
      { api: 'Lute.New', ms: 15 }, { api: 'Lute.Md2HTML', ms: 25 },
      { api: 'innerHTML:set', ms: 40 }, { api: 'Lute.Md2HTML', ms: 25 }, { api: 'innerHTML:set', ms: 40 },
    ]);
    assert.equal(probe.records[2].target, 'div#preview.vditor-reset');
    probe.restore(); probe.restore();
    assert.equal(lute.New, originalNew);
    assert.equal(instance.Md2HTML, originalCompile);
    assert.deepEqual(Object.getOwnPropertyDescriptor(FakeElement.prototype, 'innerHTML'), originalHtml);
  } finally {
    if (originalHtml) Object.defineProperty(FakeElement.prototype, 'innerHTML', originalHtml);
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

test("native receipt publishing uses the selected operator credential", () => {
  const home = mkdtempSync(path.join(tmpdir(), "wdio-publisher-token-"));
  const scopedHome = path.join(home, "workspace", ".papercusp");
  try {
    mkdirSync(path.join(home, ".papercusp"), { recursive: true });
    mkdirSync(scopedHome, { recursive: true });
    writeFileSync(path.join(home, ".papercusp", "superuser-token"), "box-credential\n");
    writeFileSync(path.join(scopedHome, "superuser-token"), "workspace-credential\n");
    assert.equal(readPublisherToken({ PAPERCUSP_HOME: scopedHome }, home), "workspace-credential");
    assert.equal(readPublisherToken({}, home), "box-credential");
    assert.equal(readPublisherToken({ PAPERCUSP_HOME: "" }, home), "box-credential");
    rmSync(path.join(scopedHome, "superuser-token"));
    assert.throws(() => readPublisherToken({ PAPERCUSP_HOME: scopedHome }, home), /ENOENT/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

function retryingBrowser(): Browser {
  return {
    async waitUntil(condition: () => boolean | Promise<boolean>) {
      let lastError: unknown;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          if (await condition()) return;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError ?? new Error("fake waitUntil timed out");
    },
  } as unknown as Browser;
}

test("pinned plan readiness waits through unrelated cached rows", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  let rowReads = 0;
  const row = (slug: string) => ({
    getAttribute: () => `plans-pane-row-${slug}`,
    querySelector: () => ({ textContent: ' papercusp ' }),
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      querySelectorAll: () => ++rowReads < 3
        ? [row('other-plan')]
        : [row('other-plan'), row('pinned-plan')],
    },
  });
  try {
    let candidates: ReturnType<typeof readPlanPopupCandidates> = [];
    await retryingBrowser().waitUntil(() => {
      candidates = readPlanPopupCandidates({ maxRows: 1, requestedSlug: 'pinned-plan' });
      return candidates.length > 0;
    });
    assert.equal(rowReads, 3);
    assert.deepEqual(candidates, [{ slug: 'pinned-plan', harness: 'papercusp' }]);
    assert.deepEqual(readPlanPopupCandidates({ maxRows: 1, requestedSlug: null }), [
      { slug: 'other-plan', harness: 'papercusp' },
    ]);
    assert.deepEqual(readPlanPopupCandidates({ maxRows: 5, requestedSlug: 'absent' }), []);
  } finally {
    if (original) Object.defineProperty(globalThis, 'document', original);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});

test("terminal WebDriver session failures are recognized from protocol messages", () => {
  assert.equal(isTerminalWebDriverSessionError(new Error("WebDriverError: invalid session id")), true);
  assert.equal(isTerminalWebDriverSessionError({ error: "pagecrashorhang" }), true);
  assert.equal(isTerminalWebDriverSessionError({ cause: new Error("session terminated without reply") }), true);
  assert.equal(isTerminalWebDriverSessionError(new Error("temporary connection reset")), false);
});

test("a terminal session error ends a WDIO wait on its first failed probe", async () => {
  let probes = 0;
  const browser = retryingBrowser();

  await assert.rejects(
    waitUntilOrFailOnTerminalSession(browser, () => {
      probes += 1;
      throw new Error("WebDriverError: invalid session id");
    }, { timeout: 180_000, interval: 500 }),
    /invalid session id/i,
  );
  assert.equal(probes, 1);
});

test("ordinary transient wait errors still retry until the condition succeeds", async () => {
  let probes = 0;

  await waitUntilOrFailOnTerminalSession(retryingBrowser(), () => {
    probes += 1;
    if (probes === 1) throw new Error("temporary connection reset");
    return true;
  });
  assert.equal(probes, 2);
});

test("workspace navigation waits past about:blank for the packaged app origin", async () => {
  const urls = ["about:blank", "about:blank?ws=papercusp-workspace", "papercusp://localhost/adv"];
  let reads = 0;
  const browser = Object.assign(retryingBrowser(), {
    async getUrl() { reads += 1; return urls.shift() ?? "papercusp://localhost/adv"; },
  });

  assert.equal(await waitForPackagedAppUrl(browser), "papercusp://localhost/adv");
  assert.equal(reads, 3);
});

test('private IPC fixture rejects a stale default even with a fresh per-port record', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'native-ipc-preflight-'));
  const socketPath = path.join(dir, 'operator.sock');
  const replacementSocketPath = path.join(dir, 'replacement.sock');
  const server = createServer();
  const replacementServer = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  await new Promise<void>((resolve, reject) => { replacementServer.once('error', reject); replacementServer.listen(replacementSocketPath, resolve); });
  try {
    const live = { pid: process.pid, port: 3170, socketPath };
    const env = { PAPERCUSP_HOME: dir, PAPERCUSP_DEV_API_TARGET: "3170" };
    writeFileSync(
      path.join(dir, "endpoint-ipc.3170.json"),
      JSON.stringify(live),
    );
    writeFileSync(
      path.join(dir, "endpoint-ipc.json"),
      JSON.stringify({ ...live, socketPath: path.join(dir, "gone.sock") }),
    );
    assert.throws(
      () => assertPrivateIpcFixture(env, "linux"),
      /Invalid private native IPC fixture/,
    );
    writeFileSync(path.join(dir, "endpoint-ipc.json"), JSON.stringify(live));
    assert.doesNotThrow(() => assertPrivateIpcFixture(env, "linux"));
    const preflight = assertPrivateIpcFixture(env, "linux");
    writeFileSync(path.join(dir, "endpoint-ipc.json"), JSON.stringify({ ...live, socketPath: replacementSocketPath }));
    assert.doesNotThrow(() => assertPrivateIpcFixture(env, "linux"));
    assert.throws(() => assertPrivateIpcFixtureUnchanged(preflight, env, "linux"), /changed during the measured run/);
    writeFileSync(path.join(dir, "endpoint-ipc.json"), JSON.stringify(live));
    assert.doesNotThrow(() => assertPrivateIpcFixtureUnchanged(preflight, env, "linux"));
    // A named run must not silently skip this guard when the target was omitted.
    assert.throws(
      () =>
        assertPrivateIpcFixture(
          {
            PAPERCUSP_HOME: dir,
            PAPERCUSP_PERF_RUN_ID: "named-profile",
          },
          "linux",
        ),
      /PAPERCUSP_DEV_API_TARGET/,
    );
    assert.throws(
      () =>
        assertPrivateIpcFixture(
          {
            ...env,
            PAPERCUSP_DEV_API_TARGET: "invalid",
          },
          "linux",
        ),
      /Invalid PAPERCUSP_DEV_API_TARGET/,
    );
    assert.throws(
      () =>
        assertPrivateIpcFixture(
          { ...env, PAPERCUSP_DEV_API_TARGET: "3070" },
          "linux",
        ),
      /mismatched/,
    );
    writeFileSync(
      path.join(dir, "endpoint-ipc.json"),
      JSON.stringify({ ...live, pid: 2147483647 }),
    );
    assert.throws(
      () => assertPrivateIpcFixture(env, "linux"),
      /Invalid private native IPC fixture/,
    );
    assert.doesNotThrow(() => assertPrivateIpcFixture({}, "linux"));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => replacementServer.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

const host = (key: string): PerfMeasure => ({
  key,
  value: 0.1,
  unit: "count",
  budget: null,
  ok: true,
});

test("host-pressure context alone is not a publishable perf run", () => {
  assert.equal(hasRunOutcomeMeasure([
    host("host:psi-cpu-some-avg10-pct:start"),
    host("host:loadavg1-not-authoritative:end"),
  ]), false);
});

test("a timing or invariant makes the surrounding host context publishable", () => {
  assert.equal(hasRunOutcomeMeasure([
    host("host:psi-cpu-some-avg10-pct:start"),
    { key: "interaction:command-palette-open", value: 250, unit: "ms", budget: 400, ok: true },
  ]), true);
  assert.equal(hasRunOutcomeMeasure([
    host("host:psi-cpu-some-avg10-pct:start"),
    { key: "invariant:webview-http-egress", value: 0, unit: "count", budget: 0, ok: true, invariant: true },
  ]), true);
});

test("desktop perf receipts retain the measured workspace across the WDIO publisher boundary", () => {
  const measures = [{ key: "interaction:plan-popup-open", value: 1010, unit: "ms", budget: 1500, ok: true }] as const;
  assert.deepEqual(desktopPerfRunPayload(measures, "checkout-sha", "named-profile", {
    PAPERCUSP_PERF_WORKSPACE_ID: " papercusp-workspace ",
  }), {
    measures,
    gitSha: null,
    buildSha: null,
    runId: "named-profile",
    workspaceId: "papercusp-workspace",
  });
  assert.deepEqual(desktopPerfRunPayload(measures, "checkout-sha", null, {}), {
    measures,
    gitSha: "checkout-sha",
    buildSha: null,
    runId: null,
  });
  assert.equal("workspaceId" in desktopPerfRunPayload(measures, null, null, {}), false);
});

test("the binary's recorded build identity rides on named and unnamed runs alike", () => {
  const measures = [{ key: "interaction:plan-popup-open", value: 1010, unit: "ms", budget: 1500, ok: true }] as const;
  // A named profile drops the checkout sha (it is not the build) but keeps the
  // binary's own identity, which describes the artifact actually measured.
  assert.equal(desktopPerfRunPayload(measures, "checkout-sha", "named-profile", {}, "4223f93417df").buildSha, "4223f93417df");
  assert.equal(desktopPerfRunPayload(measures, "checkout-sha", "named-profile", {}, "4223f93417df").gitSha, null);
  assert.equal(desktopPerfRunPayload(measures, "checkout-sha", null, {}, "4223f93417df").buildSha, "4223f93417df");
});

test("readBuildIdentity finds the profile-dir identity above a deb staging binary", () => {
  const root = mkdtempSync(path.join(tmpdir(), "perf-build-identity-"));
  try {
    const bin = path.join(root, "release", "bundle", "deb", "pkg_0.0.1_amd64", "data", "usr", "bin", "papercusp-desktop");
    mkdirSync(path.dirname(bin), { recursive: true });
    writeFileSync(bin, "binary");
    const past = new Date(Date.now() - 60_000);
    utimesSync(bin, past, past);
    writeFileSync(path.join(root, "release", BUILD_IDENTITY_FILE), JSON.stringify({ buildSha: "4223F93417DF132EEC90ACE218A6017F5A97B8B3" }));
    assert.equal(readBuildIdentity(bin), "4223f93417df132eec90ace218a6017f5a97b8b3");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readBuildIdentity refuses an identity OLDER than the binary (rebuilt after the scripted build)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "perf-build-identity-"));
  try {
    const bin = path.join(root, "release", "papercusp-desktop");
    mkdirSync(path.dirname(bin), { recursive: true });
    const identity = path.join(root, "release", BUILD_IDENTITY_FILE);
    writeFileSync(identity, JSON.stringify({ buildSha: "4223f93417df" }));
    const past = new Date(Date.now() - 60_000);
    utimesSync(identity, past, past);
    writeFileSync(bin, "rebuilt later by a plain tauri build");
    assert.equal(readBuildIdentity(bin), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readBuildIdentity refuses a DIRTY build — its binary is not exactly the recorded sha (P-002)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "perf-build-identity-"));
  try {
    const bin = path.join(root, "release", "papercusp-desktop");
    mkdirSync(path.dirname(bin), { recursive: true });
    writeFileSync(bin, "binary");
    const past = new Date(Date.now() - 60_000);
    utimesSync(bin, past, past);
    const identity = path.join(root, "release", BUILD_IDENTITY_FILE);
    writeFileSync(identity, JSON.stringify({ buildSha: "4223f93417df", dirty: true }));
    assert.equal(readBuildIdentity(bin), null);
    // CONTROL: the same file recorded clean is trusted.
    writeFileSync(identity, JSON.stringify({ buildSha: "4223f93417df", dirty: false }));
    assert.equal(readBuildIdentity(bin), "4223f93417df");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readBuildIdentity returns null for a missing binary, missing file, or malformed sha", () => {
  const root = mkdtempSync(path.join(tmpdir(), "perf-build-identity-"));
  try {
    assert.equal(readBuildIdentity(path.join(root, "absent")), null);
    const bin = path.join(root, "release", "papercusp-desktop");
    mkdirSync(path.dirname(bin), { recursive: true });
    writeFileSync(bin, "binary");
    const past = new Date(Date.now() - 60_000);
    utimesSync(bin, past, past);
    assert.equal(readBuildIdentity(bin, 2), null);
    writeFileSync(path.join(root, "release", BUILD_IDENTITY_FILE), JSON.stringify({ buildSha: "not-a-sha" }));
    assert.equal(readBuildIdentity(bin), null);
    writeFileSync(path.join(root, "release", BUILD_IDENTITY_FILE), "{ truncated");
    assert.equal(readBuildIdentity(bin), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the runner resets stale measures before any preflight can throw", () => {
  const config = readFileSync(path.join(__dirname, "wdio.conf.ts"), "utf8");
  const onPrepare = config.slice(config.indexOf("async onPrepare()"), config.indexOf("async onComplete()"));
  const reset = onPrepare.indexOf("resetMeasures();");
  const prepare = onPrepare.indexOf("prepareMeasures();");
  assert(prepare >= 0 && prepare < reset, 'allocate a fresh inherited worker collection before any reset or preflight');
  assert(reset >= 0);
  assert(reset < onPrepare.indexOf("assertNativeWebDriverAvailable();"));
  assert(reset < onPrepare.indexOf("assertInstallationComplete();"));
});

test("named native publishing checks fixture continuity before sending a receipt", () => {
  const config = readFileSync(path.join(__dirname, "wdio.conf.ts"), "utf8");
  const publish = config.slice(
    config.indexOf("async function publishMeasures()"),
    config.indexOf("function resolveDriverPort"),
  );
  assert(publish.includes("assertPrivateIpcFixtureUnchanged(initialPrivateIpcFixture);"));
  assert(
    publish.indexOf("assertPrivateIpcFixtureUnchanged(initialPrivateIpcFixture);") <
      publish.indexOf("await fetch(url"),
  );
});

test("a build: stamp is context, not an outcome (WI-10003815)", () => {
  assert.equal(hasRunOutcomeMeasure([
    host("host:psi-cpu-some-avg10-pct:start"),
    { key: BINARY_BUILT_AT_KEY, value: 1_789_600_000_000, unit: "count", budget: null, ok: true },
  ]), false);
});

test("the runner's stamp literals match the gate's canonical constants", () => {
  // The runner cannot import operator-core, so it carries copies; a drifted key would
  // silently disable the release gate's stale-build check.
  const shared = readFileSync(
    path.resolve(__dirname, "../../..", "packages/operator-core/lib/admin-test-suites-shared.ts"),
    "utf8",
  );
  assert(shared.includes(`DESKTOP_PERF_BINARY_BUILT_AT_KEY = '${BINARY_BUILT_AT_KEY}'`));
  const prefixes = CONTEXT_STAMP_PREFIXES.map((p) => `'${p}'`).join(", ");
  assert(shared.includes(`DESKTOP_PERF_CONTEXT_STAMP_PREFIXES = [${prefixes}] as const`));
});

test("the runner stamps the binary under test before any spec can measure", () => {
  const config = readFileSync(path.join(__dirname, "wdio.conf.ts"), "utf8");
  const onPrepare = config.slice(config.indexOf("async onPrepare()"), config.indexOf("async onComplete()"));
  const stamp = onPrepare.indexOf("recordBinaryIdentity(TAURI_APP_PATH);");
  assert(stamp >= 0, "onPrepare must record the measured binary's build time");
  assert(stamp > onPrepare.indexOf("resetMeasures();"), "a stamp written before the reset is wiped");
});

test("the root perf command preserves WDIO failures through tee", () => {
  const rootPackage = JSON.parse(
    readFileSync(path.resolve(__dirname, "../../..", "package.json"), "utf8"),
  ) as { scripts: Record<string, string> };
  assert.match(rootPackage.scripts["perf:desktop"], /bash -o pipefail/);
});

test("the gate-selected `test` script is headless; the full GUI run is `test:all` (WI-10003821)", () => {
  // The green gate runs this package's `test` on every change here (STANDALONE_PACKAGE_DIRS in
  // scripts/affected-tests.mjs), and a gate box cannot boot the packaged desktop binary. So `test`
  // must never reach WDIO, and every caller that wants measures must name `test:all`.
  const own = JSON.parse(readFileSync(path.join(__dirname, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.doesNotMatch(own.scripts.test, /test:wdio|wdio run/, "`test` must stay headless");
  assert.match(own.scripts.test, /test:unit/, "`test` must still run the runner guards");
  assert.match(own.scripts["test:all"], /npm run test:wdio/, "`test:all` must run the specs");
  const rootPackage = JSON.parse(
    readFileSync(path.resolve(__dirname, "../../..", "package.json"), "utf8"),
  ) as { scripts: Record<string, string> };
  assert.match(rootPackage.scripts["perf:desktop"], /npm run test:all\b/);
});
