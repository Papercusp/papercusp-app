#!/usr/bin/env node
// EI-24190247768567149: host microphone and Chrome audio recovery.
// Keep the source here; a local fixmic command can point at this managed file.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';

const AUDIO_SUBTYPE = '--utility-sub-type=audio.mojom.AudioService';

export function sampleStats(bytes) {
  let peak = 0;
  let nonzero = 0;
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const value = bytes.readInt16LE(i);
    peak = Math.max(peak, Math.abs(value));
    if (value !== 0) nonzero++;
  }
  return { bytes: bytes.length, peak, nonzeroSamples: nonzero };
}

export function classifySample(stats) {
  if (stats.bytes === 0) return 'no-frames';
  if (stats.peak === 0) return 'silent-frames';
  return 'live-frames';
}

export function inspectAudioService(pid, { readFile = readFileSync, uid = process.getuid() } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('AudioService PID must be a positive integer');
  const cmdline = readFile(`/proc/${pid}/cmdline`).toString().split('\0').filter(Boolean);
  const status = readFile(`/proc/${pid}/status`, 'utf8').toString();
  const executable = cmdline[0] || '';
  const uidLine = /^Uid:\s+(\d+)/m.exec(status);
  if (!/(^|\/)(chrome|chromium|chromium-browser)$/.test(executable) || !cmdline.includes(AUDIO_SUBTYPE)) {
    throw new Error(`PID ${pid} is not a Chrome AudioService`);
  }
  if (!uidLine || Number(uidLine[1]) !== uid) throw new Error(`PID ${pid} belongs to another user`);
  return { pid, executable };
}

function command(run, name, args, options = {}) {
  const result = run(name, args, { encoding: 'utf8', ...options });
  if (result.error && result.error.code !== 'ETIMEDOUT') throw result.error;
  if (result.status !== 0 && !result.error?.code?.includes('TIMEDOUT')) {
    throw new Error(`${name} failed: ${(result.stderr || '').toString().trim() || result.status}`);
  }
  return result;
}

export function measureSource({ run = spawnSync, durationMs = 4000 } = {}) {
  const source = command(run, 'pactl', ['get-default-source']).stdout.trim();
  if (!source) throw new Error('No default microphone source');
  // parecord cannot open a Node pipe as its output on this host. Use a private
  // temporary file and remove it even when the capture times out or fails.
  const directory = mkdtempSync(join(tmpdir(), 'fixmic-'));
  const path = join(directory, 'capture.raw');
  try {
    const result = run('parecord', ['-d', source, '--raw', '--format=s16le', '--rate=48000', '--channels=1', path], {
      timeout: durationMs,
      maxBuffer: 1024 * 1024,
      encoding: 'buffer',
    });
    if (result.error && result.error.code !== 'ETIMEDOUT') throw result.error;
    if (result.status !== 0 && result.error?.code !== 'ETIMEDOUT') {
      throw new Error(`parecord failed: ${result.stderr?.toString().trim() || result.status}`);
    }
    return { source, ...sampleStats(readFileSync(path)) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function recover({ args = [], run = spawnSync, readFile = readFileSync,
  kill = process.kill, uid = process.getuid(), measure = measureSource,
  write = (line) => process.stdout.write(`${line}\n`) } = {}) {
  if (args[0] === '--restart-audio-service') {
    if (args.length !== 3 || args[2] !== '--reload-tried') {
      throw new Error('First reload the affected tab and retry. Then pass --restart-audio-service PID --reload-tried');
    }
    const pid = Number(args[1]);
    inspectAudioService(pid, { readFile, uid });
    kill(pid, 'SIGTERM');
    write(`Stopped Chrome AudioService PID ${pid}. Reload the affected tab and retry its microphone.`);
    return 'audio-service-restarted';
  }
  const restartServer = args.length === 2 && args[0] === '--restart-audio-server' && args[1] === '--confirmed-no-frames';
  if (args.length && !restartServer) {
    throw new Error('Usage: fixmic [--restart-audio-server --confirmed-no-frames | --restart-audio-service PID --reload-tried]');
  }
  const before = measure({ run });
  const state = classifySample(before);
  write(`Source ${before.source}: ${before.bytes} bytes, peak ${before.peak} (${state})`);
  if (state === 'live-frames') {
    write('Capture is live. If Chrome says devices are missing, reload that tab and retry first.');
    write('If reload fails, identify its exact Chrome AudioService PID and run fixmic --restart-audio-service PID --reload-tried.');
    return state;
  }
  if (state === 'silent-frames') {
    write('Frames arrived but were silent. Speak into the mic and retry; this alone does not prove a dead device.');
    return state;
  }
  if (!restartServer) {
    write('No frames in this probe. Repeat fixmic once; if still empty, run fixmic --restart-audio-server --confirmed-no-frames.');
    return state;
  }
  write('No capture frames. Restarting the user audio services, then measuring again.');
  command(run, 'systemctl', ['--user', 'restart', 'pipewire.service', 'pipewire-pulse.service', 'wireplumber.service']);
  command(run, 'sleep', ['6']);
  const after = measure({ run });
  const afterState = classifySample(after);
  write(`After restart: ${after.bytes} bytes, peak ${after.peak} (${afterState})`);
  write('If Chrome still reports missing devices, reload the affected tab first; then use the targeted AudioService command above.');
  return afterState;
}

if (isCliEntry(import.meta.url)) {
  try {
    const state = recover({ args: process.argv.slice(2) });
    if (state === 'no-frames') process.exitCode = 1;
  } catch (error) {
    console.error(`fixmic: ${error.message}`);
    process.exitCode = 2;
  }
}
