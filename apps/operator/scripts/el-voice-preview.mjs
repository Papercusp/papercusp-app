#!/usr/bin/env node
/**
 * EL voice / model A-B preview.
 *
 * Synthesises a representative operator-style line with any voice id +
 * model combination and plays it back, so we can audition candidates
 * before pushing them to the live agent via el-agent-sync.mjs.
 *
 * Usage:
 *   node apps/operator/scripts/el-voice-preview.mjs <voice_id> [model_id]
 *   # default model is eleven_turbo_v2 (the only Conv-AI-eligible non-flash)
 *
 * Browse voices: https://elevenlabs.io/app/voice-library
 *
 * Plays via `ffplay -nodisp -autoexit` (most Linux desktops have it via
 * ffmpeg). If you prefer a different player, set EL_PREVIEW_PLAYER, e.g.
 *   EL_PREVIEW_PLAYER='mpv --no-video' node ...
 *
 * Falls back to writing /tmp/el-preview.mp3 if no player is available.
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';

const VOICE_ID = process.argv[2];
const MODEL_ID = process.argv[3] ?? 'eleven_turbo_v2';
if (!VOICE_ID) {
  console.error('usage: el-voice-preview.mjs <voice_id> [model_id]');
  process.exit(2);
}

const SAMPLE = process.env.EL_PREVIEW_TEXT ??
  "Three features pending. Sheets is at twenty-eight of eighty-eight. " +
  "Forms validator just failed schema check — that one's tier-high, want me to dispatch?";

const credPath = `${os.homedir()}/.papercusp/credentials.json`;
async function tryLoopbackKey() {
  for (const port of [process.env.OPERATOR_PORT ?? '3070', '3070', '3055']) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/agent-mcp/el-admin-creds`);
      if (!r.ok) continue;
      const d = await r.json();
      return d.apiKey ?? null;
    } catch { /* try next */ }
  }
  return null;
}
let xiKey = process.env.XI_API_KEY ??
  (fs.existsSync(credPath) ? JSON.parse(fs.readFileSync(credPath, 'utf8'))?.elevenlabs?.apiKey : null);
if (!xiKey) xiKey = await tryLoopbackKey();
if (!xiKey) {
  console.error('no XI_API_KEY env, no ~/.papercusp/credentials.json, and operator app not reachable on 127.0.0.1:3070/3055');
  process.exit(1);
}

console.log(`[1/3] synthesising — voice=${VOICE_ID} model=${MODEL_ID}`);
console.log(`      text: ${SAMPLE.slice(0, 80)}…`);

const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`, {
  method: 'POST',
  headers: { 'xi-api-key': xiKey, 'content-type': 'application/json', 'accept': 'audio/mpeg' },
  body: JSON.stringify({
    text: SAMPLE,
    model_id: MODEL_ID,
    voice_settings: { stability: 0.5, similarity_boost: 0.8, speed: 1.0 },
  }),
});

if (!r.ok) {
  const body = await r.text().catch(() => '');
  console.error(`tts failed: HTTP ${r.status} — ${body.slice(0, 400)}`);
  process.exit(1);
}

const out = '/tmp/el-preview.mp3';
const buf = Buffer.from(await r.arrayBuffer());
fs.writeFileSync(out, buf);
console.log(`[2/3] wrote ${out} (${(buf.length / 1024).toFixed(1)} KB)`);

const player = process.env.EL_PREVIEW_PLAYER;
const candidates = player ? [player] : [
  'ffplay -nodisp -autoexit -loglevel quiet',
  'mpv --no-video --really-quiet',
  'paplay',
  'afplay', // macOS
];

console.log('[3/3] playing…');
let played = false;
for (const cmd of candidates) {
  const [bin, ...args] = cmd.split(' ');
  const r = spawnSync(bin, [...args, out], { stdio: 'ignore' });
  if (r.status === 0) { played = true; break; }
}
if (!played) {
  console.log(`(no audio player found — open ${out} manually)`);
  console.log('  set EL_PREVIEW_PLAYER=<your-player> to use a custom one');
}
