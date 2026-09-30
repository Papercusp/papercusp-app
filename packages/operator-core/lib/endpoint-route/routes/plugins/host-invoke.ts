/**
 * POST /api/plugins/host/invoke — host-mediated RPC for iframe plugin surfaces.
 * Tries WASM/daemon dispatcher first; falls back to JS plugin invoke path.
 * Ported from app/api/plugins/host/invoke/route.ts. `auth: 'loopback'` (auth-tier Wave 1).
 */
import { invokePluginAction, callWasmAction } from '../../../plugin-host-runtime';
import { papercuspRoot } from '../../../papercusp-root';
import { join } from 'node:path';
import { defineTool } from '@papercusp/agent-mcp';

interface ReqBody {
  pluginName: string;
  installSlug: string;
  actionName: string;
  payloadB64: string;
  surface?: 'iframe' | 'react' | 'core';
}

export default defineTool({
  method: 'POST',
  path: '/plugins/host/invoke',
  auth: 'loopback',
  async handler(req) {
    let body: ReqBody;
    try {
      body = (await req.json()) as ReqBody;
    } catch {
      return Response.json({ ok: false, error: 'invalid JSON' }, { status: 400 });
    }
    if (!body.pluginName || !body.installSlug || !body.actionName) {
      return Response.json(
        { ok: false, error: 'pluginName, installSlug, actionName required' },
        { status: 400 },
      );
    }

    const wasmResult = await callWasmAction({
      pluginName: body.pluginName,
      installSlug: body.installSlug,
      actionName: body.actionName,
      payload: Buffer.from(body.payloadB64 ?? '', 'base64'),
      origin: body.surface === 'iframe' ? 'ui' : 'core',
    });
    if (wasmResult.ok) {
      return Response.json({
        ok: true,
        payloadB64: Buffer.from(wasmResult.payload).toString('base64'),
      });
    }
    if (!wasmResult.error.includes('no WASM plugin loaded')) {
      return Response.json({ ok: false, error: wasmResult.error });
    }

    try {
      const projectDir = process.cwd();
      const stateDir = join(papercuspRoot(), 'harnesses', body.installSlug);
      const rawBytes = Buffer.from(body.payloadB64 ?? '', 'base64');
      const text = rawBytes.toString('utf8');
      let params: unknown;
      try { params = text ? JSON.parse(text) : null; }
      catch { params = { payloadB64: body.payloadB64 ?? '' }; }
      const result = await invokePluginAction({
        pluginName: body.pluginName,
        actionName: body.actionName,
        installSlug: body.installSlug,
        projectDir,
        stateDir,
        params,
      });
      if (result.ok) {
        const payloadJson = JSON.stringify(result.result ?? null);
        return Response.json({
          ok: true,
          payloadB64: Buffer.from(payloadJson, 'utf8').toString('base64'),
        });
      }
      return Response.json({ ok: false, error: result.error ?? 'unknown' });
    } catch (e: unknown) {
      return Response.json(
        { ok: false, error: e instanceof Error ? e.message : String(e) },
        { status: 500 },
      );
    }
  },
});
