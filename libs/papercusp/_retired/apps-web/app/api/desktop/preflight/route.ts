import { NextResponse } from 'next/server';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

const exec = promisify(execFile);

type CheckStatus = 'ok' | 'missing' | 'error';

interface Check {
  name: string;
  status: CheckStatus;
  detail?: string;
  hint?: string;
}

async function checkBinary(bin: string, args: string[] = ['--version']): Promise<Check> {
  try {
    const { stdout, stderr } = await exec(bin, args, { timeout: 5000 });
    const out = (stdout || stderr).trim().split(/\r?\n/)[0] ?? '';
    return { name: bin, status: 'ok', detail: out };
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      return { name: bin, status: 'missing', detail: `${bin} not on PATH` };
    }
    return { name: bin, status: 'error', detail: String(err?.message ?? err) };
  }
}

async function checkPostgres(): Promise<Check> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (status: CheckStatus, detail: string) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolve({ name: 'postgres', status, detail });
    };
    socket.setTimeout(2000);
    socket.once('connect', () => finish('ok', 'localhost:5432 reachable'));
    socket.once('timeout', () => finish('missing', 'localhost:5432 timeout'));
    socket.once('error', (e: any) => finish('missing', `localhost:5432 ${e?.code ?? 'unreachable'}`));
    socket.connect(5432, '127.0.0.1');
  });
}

function checkHarnessDir(): Check {
  const dir = process.env.PAPERCUSP_HARNESS_DIR ?? join(homedir(), 'autonomous-harness');
  const runScript = join(dir, 'run.sh');
  if (!existsSync(runScript)) {
    return {
      name: 'harness',
      status: 'missing',
      detail: `${runScript} not found`,
      hint: 'Set PAPERCUSP_HARNESS_DIR or symlink ~/autonomous-harness',
    };
  }
  return { name: 'harness', status: 'ok', detail: dir };
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET() {
  const [node, claude, bash, postgres] = await Promise.all([
    checkBinary('node'),
    checkBinary('claude'),
    checkBinary('bash'),
    checkPostgres(),
  ]);
  const harness = checkHarnessDir();
  const checks = [node, postgres, claude, bash, harness];
  const allOk = checks.every((c) => c.status === 'ok');
  return NextResponse.json({ ok: allOk, checks }, { headers: CORS_HEADERS });
}
