/** Explicit D-143 HTTP surface for hosted reverse connectors and session exchange. */
import { defineTool, type RouteContext } from '@papercusp/agent-mcp';
import { isHostedPrincipal, type HostedPrincipal } from '../../auth/hosted-principal';
import {
  HostedWorkspaceConnectorGateway,
  readHostedConnectorBearer,
  readHostedConnectorTicket,
  type HostedConnectorBinding,
  type HostedConnectorTicketBinding,
  type HostedConnectorTransport,
} from '../hosted-workspace-connector';

export const HOSTED_WORKSPACE_CONNECTOR_ROUTES = [
  { method: 'POST', path: '/hosted/workspaces/:workspaceId/connectors/enroll', access: 'authenticated' },
  { method: 'POST', path: '/hosted/workspaces/:workspaceId/connectors/rotate', access: 'authenticated' },
  { method: 'POST', path: '/hosted/workspaces/:workspaceId/connectors/revoke', access: 'authenticated' },
  { method: 'POST', path: '/hosted/workspaces/:workspaceId/connectors/session-ticket', access: 'authenticated' },
  { method: 'POST', path: '/hosted/connectors/register', access: 'public' },
  { method: 'POST', path: '/hosted/connectors/heartbeat', access: 'public' },
  { method: 'GET', path: '/hosted/connectors/events', access: 'public' },
  { method: 'GET', path: '/hosted/connectors/socket', access: 'public' },
] as const;

const HOSTED_OPERATE_AUTH = {
  capabilities: ['workspace:operate'],
  kind: ['user'],
  trust: ['verified'],
} as const;

type ConnectorBody = { hostId?: unknown; routeLabel?: unknown; transport?: unknown; audience?: unknown };
const jsonError = (code: string, status: number) => Response.json({ ok: false, error: { code } }, { status });

async function body(req: Request): Promise<ConnectorBody | null> {
  try {
    const value = await req.json();
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as ConnectorBody : null;
  } catch { return null; }
}

function transport(value: unknown): HostedConnectorTransport | null {
  return value === 'sse' || value === 'websocket' ? value : null;
}

function browserBinding(ctx: RouteContext, input: ConnectorBody): HostedConnectorBinding | Response {
  if (!ctx.principal || !isHostedPrincipal(ctx.principal)) return jsonError('hosted_principal_required', 401);
  const principal: HostedPrincipal = ctx.principal;
  const customerWorkspaceId = String(ctx.params.workspaceId ?? '').trim();
  const hostId = typeof input.hostId === 'string' ? input.hostId.trim() : '';
  const routeLabel = typeof input.routeLabel === 'string' ? input.routeLabel.trim() : '';
  const selectedTransport = transport(input.transport);
  if (!customerWorkspaceId || principal.selectedWorkspaceId !== customerWorkspaceId) return jsonError('workspace_binding_mismatch', 403);
  if (!hostId || !routeLabel || !selectedTransport) return jsonError('invalid_connector_binding', 400);
  return {
    controlPlaneWorkspaceId: principal.workspaceId,
    organizationId: principal.activeOrganizationId,
    customerWorkspaceId,
    hostId,
    routeLabel,
    generation: 0,
    state: 'pending',
    transport: selectedTransport,
  };
}

function omitLifecycle(binding: HostedConnectorBinding) {
  const { state: _state, generation: _generation, ...rest } = binding;
  return rest;
}

export function connectorHostMatches(request: Request, binding: Pick<HostedConnectorBinding, 'routeLabel'>): boolean {
  const hostname = new URL(request.url).hostname.toLowerCase();
  return hostname === 'app.papercusp.com' || hostname === `${binding.routeLabel}.workspaces.papercusp.com`;
}

export async function authenticateHostedConnectorTransport(
  gateway: HostedWorkspaceConnectorGateway,
  request: Request,
  expectedTransport: HostedConnectorTransport,
): Promise<HostedConnectorBinding | null> {
  const bearer = readHostedConnectorBearer(request.headers);
  const binding = bearer ? await gateway.authenticate(bearer) : await (async () => {
    const ticket = readHostedConnectorTicket(request);
    return ticket ? gateway.consumeSessionTicket(ticket) : null;
  })();
  return binding && binding.transport === expectedTransport && connectorHostMatches(request, binding) ? binding : null;
}

export type HostedConnectorSocketAuthentication =
  | { role: 'connector'; binding: HostedConnectorBinding }
  | { role: 'browser'; binding: HostedConnectorTicketBinding };

/** Authenticate a native upgrade without mixing connector bearers into browser auth. */
export async function authenticateHostedConnectorSocket(
  gateway: HostedWorkspaceConnectorGateway,
  request: Request,
): Promise<HostedConnectorSocketAuthentication | null> {
  const bearer = readHostedConnectorBearer(request.headers);
  if (bearer) {
    const binding = await gateway.authenticate(bearer);
    return binding && binding.transport === 'websocket' && connectorHostMatches(request, binding)
      ? { role: 'connector', binding }
      : null;
  }
  const ticket = readHostedConnectorTicket(request);
  if (!ticket) return null;
  const binding = await gateway.consumeSessionTicket(ticket);
  return binding && binding.transport === 'websocket' &&
    binding.kind === 'session' &&
    binding.audience === 'workspace-operator' &&
    connectorHostMatches(request, binding)
    ? { role: 'browser', binding }
    : null;
}

export function createHostedWorkspaceConnectorRoutes(gateway: HostedWorkspaceConnectorGateway) {
  const enroll = defineTool({ method: 'POST', path: HOSTED_WORKSPACE_CONNECTOR_ROUTES[0].path, auth: HOSTED_OPERATE_AUTH,
    async handler(req, ctx) { const parsed=await body(req); if(!parsed) return jsonError('invalid_json',400); const binding=browserBinding(ctx,parsed); if(binding instanceof Response)return binding; const result=await gateway.enroll(omitLifecycle(binding)); return Response.json({ok:true,...result}); } });
  const rotate = defineTool({ method: 'POST', path: HOSTED_WORKSPACE_CONNECTOR_ROUTES[1].path, auth: HOSTED_OPERATE_AUTH,
    async handler(req,ctx){const parsed=await body(req);if(!parsed)return jsonError('invalid_json',400);const binding=browserBinding(ctx,parsed);if(binding instanceof Response)return binding;const result=await gateway.rotate(omitLifecycle(binding));return result?Response.json({ok:true,...result}):jsonError('connector_not_active',409);} });
  const revoke = defineTool({ method: 'POST', path: HOSTED_WORKSPACE_CONNECTOR_ROUTES[2].path, auth: HOSTED_OPERATE_AUTH,
    async handler(req,ctx){const parsed=await body(req);if(!parsed)return jsonError('invalid_json',400);const binding=browserBinding(ctx,parsed);if(binding instanceof Response)return binding;return (await gateway.revoke(omitLifecycle(binding)))?Response.json({ok:true}):jsonError('connector_not_found',404);} });
  const sessionTicket = defineTool({ method:'POST',path:HOSTED_WORKSPACE_CONNECTOR_ROUTES[3].path,auth:HOSTED_OPERATE_AUTH,
    async handler(req,ctx){const parsed=await body(req);if(!parsed)return jsonError('invalid_json',400);const binding=browserBinding(ctx,parsed);if(binding instanceof Response)return binding;const principal=ctx.principal as HostedPrincipal;const result=await gateway.issueSessionTicket({...binding,userId:principal.userId,hostedSessionId:principal.sessionId,audience:typeof parsed.audience==='string'?parsed.audience:'workspace-operator'});return result?Response.json({ok:true,...result}):jsonError('connector_not_active',409);} });
  const register = defineTool({method:'POST',path:HOSTED_WORKSPACE_CONNECTOR_ROUTES[4].path,auth:'public',async handler(req){const ticket=readHostedConnectorTicket(req);if(!ticket)return jsonError('connector_ticket_required',401);const result=await gateway.register(ticket);return result?Response.json({ok:true,...result}):jsonError('connector_ticket_invalid',401);} });
  const heartbeat = defineTool({method:'POST',path:HOSTED_WORKSPACE_CONNECTOR_ROUTES[5].path,auth:'public',async handler(req){const bearer=readHostedConnectorBearer(req.headers);const parsed=await body(req);const selected=transport(parsed?.transport);if(!bearer||!selected)return jsonError('connector_credential_required',401);const binding=await gateway.heartbeat(bearer,selected);return binding?Response.json({ok:true,binding}):jsonError('connector_credential_invalid',401);} });
  const events = defineTool({method:'GET',path:HOSTED_WORKSPACE_CONNECTOR_ROUTES[6].path,auth:'public',async handler(req){const binding=await authenticateHostedConnectorTransport(gateway,req,'sse');if(!binding)return jsonError('connector_transport_unauthorized',401);const encoder=new TextEncoder();let untrack=()=>{};const stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(encoder.encode(`event: bound\ndata: ${JSON.stringify(binding)}\n\n`));untrack=gateway.track(binding,(reason)=>{untrack();controller.enqueue(encoder.encode(`event: close\ndata: ${JSON.stringify({reason})}\n\n`));controller.close();});},cancel(){untrack();}});return new Response(stream,{headers:{'content-type':'text/event-stream','cache-control':'no-store','x-accel-buffering':'no'}});} });
  const socket = defineTool({method:'GET',path:HOSTED_WORKSPACE_CONNECTOR_ROUTES[7].path,auth:'public',handler(){return jsonError('websocket_upgrade_required',426);} });
  return [enroll,rotate,revoke,sessionTicket,register,heartbeat,events,socket] as const;
}
