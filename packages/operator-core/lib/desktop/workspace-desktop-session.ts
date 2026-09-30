/** D-363: a lease crosses Unix identities over the pack's group-restricted socket. */
import { connect, type Socket } from 'node:net';
import type { Readable, Writable } from 'node:stream';
import { FrameDecoder, FrameType, encodeJsonFrame } from '@papercusp/ipc-framing';
import { z } from 'zod';
import type { ProvisionOptions, SandboxDesktop } from '../agent-tools/computer/desktop-provisioner';
import { kasmvncWebsocketPort } from './x-server-backend';

export const WORKSPACE_DESKTOP_SOCKET = '/run/papercusp-desktop/session.sock';
export const WORKSPACE_DESKTOP_PROTOCOL = 'papercusp-desktop-session-v1';
export const WORKSPACE_DESKTOP_MAX_BYTES = 128 * 1024;

// Wire callers cannot choose a Unix identity, executable, environment, password path or display.
export const workspaceDesktopOptions = z.object({
  width: z.number().int().min(1).max(7680).optional(),
  height: z.number().int().min(1).max(4320).optional(),
  captureWidth: z.number().int().min(1).max(7680).optional(),
  captureHeight: z.number().int().min(1).max(4320).optional(),
  apps: z.array(z.array(z.string().min(1).max(4096).refine(s => !s.includes('\0'))).min(1).max(16)).max(16).optional(),
}).strict();

export const workspaceDesktopRequest = z.discriminatedUnion('action', [
  z.object({ protocol: z.literal(WORKSPACE_DESKTOP_PROTOCOL), action: z.literal('provision'), options: workspaceDesktopOptions }).strict(),
  z.object({ protocol: z.literal(WORKSPACE_DESKTOP_PROTOCOL), action: z.literal('release') }).strict(),
]);

const credential = z.object({ user: z.string().min(1), secret: z.string().min(1) }).strict();
const desktopReply = z.object({
  protocol: z.literal(WORKSPACE_DESKTOP_PROTOCOL),
  display: z.string().regex(/^:[1-9]\d*$/),
  number: z.number().int().min(110).max(250),
  width: z.number().int().min(1).max(7680),
  height: z.number().int().min(1).max(4320),
  capture: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
  gl: z.object({ id: z.enum(['virtualgl', 'native', 'mesa-software', 'none']), tier: z.enum(['hardware', 'software', 'none']), launchPrefix: z.array(z.string()), reason: z.string(), env: z.record(z.string(), z.string()), renderer: z.string().nullable() }).strict(),
  glProbeSandboxed: z.boolean(),
  endpoint: z.object({ host: z.literal('127.0.0.1'), port: z.number().int() }).strict(),
  credentials: z.object({ view: credential, control: credential }).strict(),
}).strict();

export function serializeWorkspaceDesktop(desktop: SandboxDesktop): unknown {
  if (desktop.xServer !== 'kasmvnc' || !desktop.credentials || !desktop.endpoint) {
    throw new Error('isolated desktop did not produce an authenticated KasmVNC endpoint');
  }
  return {
    protocol: WORKSPACE_DESKTOP_PROTOCOL,
    display: desktop.display, number: desktop.number, width: desktop.width, height: desktop.height,
    ...(desktop.capture ? { capture: desktop.capture } : {}),
    gl: desktop.gl, glProbeSandboxed: desktop.glProbeSandboxed,
    endpoint: desktop.endpoint,
    credentials: { view: desktop.credentials.view, control: desktop.credentials.control },
  };
}

export function parseWorkspaceDesktop(value: unknown) {
  const result = desktopReply.parse(value);
  if (result.display !== `:${result.number}` || result.endpoint.port !== kasmvncWebsocketPort(result.number)) {
    throw new Error('isolated desktop endpoint does not match its display');
  }
  return result;
}

/** One socket-activated service instance owns one desktop and releases it on EOF/error. */
export async function serveWorkspaceDesktop(
  input: Readable,
  output: Writable,
  provision: (options: z.infer<typeof workspaceDesktopOptions>) => Promise<SandboxDesktop>,
): Promise<void> {
  let desktop: SandboxDesktop | undefined;
  const decoder = new FrameDecoder();
  try {
    for await (const chunk of input) {
      decoder.push(Buffer.from(chunk));
      if (decoder.bufferedBytes > WORKSPACE_DESKTOP_MAX_BYTES) throw new Error('desktop request too large');
      for (const frame of decoder.drain()) {
        if (frame.type !== FrameType.REQUEST || frame.payload.length > WORKSPACE_DESKTOP_MAX_BYTES) {
          throw new Error('invalid desktop request frame');
        }
        const request = workspaceDesktopRequest.parse(JSON.parse(frame.payload.toString('utf8')));
        if (request.action === 'release') return;
        if (desktop) throw new Error('desktop already provisioned');
        desktop = await provision(request.options);
        if (input.destroyed || output.destroyed) return;
        output.write(encodeJsonFrame(FrameType.EVENT_JSON, serializeWorkspaceDesktop(desktop)));
      }
    }
    if (decoder.bufferedBytes) throw new Error('incomplete desktop request');
  } catch {
    // Never reflect arbitrary requests, app argv or credentials into the response/log.
    if (!output.destroyed) output.write(encodeJsonFrame(FrameType.ERROR, { error: 'desktop_session_failed' }));
  } finally {
    try { await desktop?.release(); }
    finally { output.end(); }
  }
}

/** The existing lease owns this socket; its closure is also the worker's stop signal. */
export async function provisionWorkspaceDesktop(
  options: ProvisionOptions = {},
  deps: { connect?: () => Socket; timeoutMs?: number } = {},
): Promise<SandboxDesktop> {
  const request = workspaceDesktopOptions.parse(options);
  const socket = (deps.connect ?? (() => connect(WORKSPACE_DESKTOP_SOCKET)))();
  const decoder = new FrameDecoder();
  const desktop = await new Promise<ReturnType<typeof parseWorkspaceDesktop>>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: ReturnType<typeof parseWorkspaceDesktop>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener('data', onData);
      if (error) { socket.destroy(); reject(error); }
      else resolve(value!);
    };
    const timer = setTimeout(() => finish(new Error('isolated desktop did not become ready')), deps.timeoutMs ?? 60_000);
    const onData = (data: Buffer) => {
      try {
        decoder.push(data);
        if (decoder.bufferedBytes > WORKSPACE_DESKTOP_MAX_BYTES) throw new Error('desktop reply too large');
        for (const frame of decoder.drain()) {
          if (frame.payload.length > WORKSPACE_DESKTOP_MAX_BYTES) throw new Error('desktop reply too large');
          if (frame.type === FrameType.ERROR) throw new Error('isolated desktop provisioning failed; inspect its service journal');
          if (frame.type !== FrameType.EVENT_JSON) throw new Error('unexpected desktop reply');
          finish(undefined, parseWorkspaceDesktop(JSON.parse(frame.payload.toString('utf8'))));
        }
      } catch (error) { finish(error as Error); }
    };
    socket.on('data', onData);
    socket.on('error', error => finish(error));
    socket.on('close', () => finish(new Error('isolated desktop connection closed before readiness')));
    socket.once('connect', () => socket.write(encodeJsonFrame(FrameType.REQUEST, {
      protocol: WORKSPACE_DESKTOP_PROTOCOL, action: 'provision', options: request,
    })));
  });
  let released = false;
  return {
    ...desktop,
    gl: desktop.gl,
    xServer: 'kasmvnc', taskId: null,
    isAlive: () => !released && !socket.destroyed,
    credentials: { ...desktop.credentials, passwordFile: '', destroy: () => {} },
    appDiagnostics: () => [],
    release: async () => {
      if (released) return;
      released = true;
      if (socket.destroyed) return;
      // EOF is intentional: the worker's finally block tears down before exiting.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { socket.destroy(); reject(new Error('isolated desktop teardown timed out')); }, 10_000);
        socket.once('close', () => { clearTimeout(timer); resolve(); });
        socket.end(encodeJsonFrame(FrameType.REQUEST, { protocol: WORKSPACE_DESKTOP_PROTOCOL, action: 'release' }));
      });
    },
  };
}
