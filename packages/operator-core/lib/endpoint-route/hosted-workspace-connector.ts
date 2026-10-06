/** Outbound-only hosted workspace reverse-connector identity and ticket substrate. */
import { createHash, randomBytes } from 'node:crypto';
import type { Sql } from 'postgres';
import type { HostedServiceContextRunner } from '../auth/hosted/workos-lifecycle-postgres';

export type HostedConnectorTransport = 'sse' | 'websocket';
export type HostedConnectorTicketKind = 'enrollment' | 'session';

export interface HostedConnectorBinding {
  controlPlaneWorkspaceId: string;
  organizationId: string;
  customerWorkspaceId: string;
  hostId: string;
  routeLabel: string;
  generation: number;
  transport: HostedConnectorTransport;
  state: 'pending' | 'active' | 'revoked';
  /** Server-derived at socket admission; never accepted from a connector or browser. */
  hosting?: 'byoc' | 'papercusp';
}

export interface HostedConnectorTicketBinding extends HostedConnectorBinding {
  kind: HostedConnectorTicketKind;
  userId?: string;
  hostedSessionId?: string;
  audience: string;
  expiresAt: Date;
}

/**
 * How long a connector's last recorded liveness counts as "connected" (P-001,
 * psu-cloud-connector-liveness-multi-signin-2026-09-29).
 *
 * The relay broker pings every connector socket each
 * `HOSTED_WORKSPACE_PING_INTERVAL_MS` (30s) and records `heartbeat_at` on every
 * pong, so a live link is never more than ~30s stale. 90s tolerates two lost
 * pongs before the cloud stops calling the machine reachable. Before this, the
 * row state alone decided reachability, so a half-open link read as "connected"
 * for hours (measured on avi-test, 2026-09-29).
 */
export const HOSTED_CONNECTOR_LIVENESS_FRESH_MS = 90_000;

/** The one reachability predicate: an active WebSocket connector with a fresh heartbeat. */
export function isHostedConnectorLive(
  connector: { state: string; transport: string; heartbeatAt: Date | null } | null | undefined,
  now: Date,
): boolean {
  if (!connector || connector.state !== 'active' || connector.transport !== 'websocket') return false;
  if (!connector.heartbeatAt) return false;
  return now.getTime() - connector.heartbeatAt.getTime() <= HOSTED_CONNECTOR_LIVENESS_FRESH_MS;
}

export type HostedConnectorLivenessBinding = Pick<
  HostedConnectorBinding,
  'controlPlaneWorkspaceId' | 'organizationId' | 'customerWorkspaceId' | 'hostId' | 'generation'
>;

export interface HostedConnectorCredential {
  binding: HostedConnectorBinding;
  bearer: string;
}

export interface HostedConnectorTicket {
  binding: HostedConnectorTicketBinding;
  ticket: string;
}

export interface HostedWorkspaceConnectorStore {
  createEnrollment(input: Omit<HostedConnectorBinding, 'generation' | 'state'> & { ticketHash: string; expiresAt: Date }): Promise<HostedConnectorBinding>;
  register(ticketHash: string, credentialHash: string, now: Date): Promise<HostedConnectorBinding | null>;
  authenticate(credentialHash: string, now: Date): Promise<HostedConnectorBinding | null>;
  heartbeat(credentialHash: string, transport: HostedConnectorTransport, now: Date): Promise<HostedConnectorBinding | null>;
  /**
   * Record what the relay broker observed on the connector socket of ONE exact
   * generation: `alive` stamps `heartbeat_at = at`, `!alive` clears it. Both are
   * guarded by `at` so a write never moves the stamp backwards.
   */
  recordLiveness(binding: HostedConnectorLivenessBinding, alive: boolean, at: Date): Promise<boolean>;
  issueSessionTicket(input: HostedConnectorTicketBinding & { ticketHash: string; issuedAt: Date }): Promise<HostedConnectorTicketBinding | null>;
  consumeTicket(ticketHash: string, kind: HostedConnectorTicketKind, now: Date): Promise<HostedConnectorTicketBinding | null>;
  rotate(input: Omit<HostedConnectorBinding, 'generation' | 'state'> & { ticketHash: string; expiresAt: Date; now: Date }): Promise<HostedConnectorBinding | null>;
  revoke(input: Omit<HostedConnectorBinding, 'generation' | 'state' | 'transport'> & { now: Date }): Promise<HostedConnectorBinding | null>;
}

const SAFE_ID = /^[a-z0-9][a-z0-9._:-]{0,159}$/i;
const SAFE_ROUTE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function required(value: string, field: string, route = false): string {
  const normalized = value?.trim() ?? '';
  if (!(route ? SAFE_ROUTE : SAFE_ID).test(normalized)) throw new TypeError(`invalid_hosted_connector_${field}`);
  return normalized;
}

function digest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function token(prefix: 'hc' | 'ht', entropy: (size: number) => Uint8Array): string {
  const bytes = Buffer.from(entropy(32));
  if (bytes.byteLength !== 32) throw new Error('hosted_connector_entropy_source_returned_wrong_size');
  return `${prefix}_${bytes.toString('base64url')}`;
}

export function readHostedConnectorBearer(headers: Headers): string | null {
  const authorization = headers.get('authorization')?.trim() ?? '';
  const match = /^Bearer\s+(hc_[A-Za-z0-9_-]{43})$/.exec(authorization);
  return match?.[1] ?? null;
}

export function readHostedConnectorTicket(request: Request): string | null {
  const url = new URL(request.url);
  const query = url.searchParams.get('ticket')?.trim() ?? '';
  if (/^ht_[A-Za-z0-9_-]{43}$/.test(query)) return query;
  const header = request.headers.get('x-papercusp-connector-ticket')?.trim() ?? '';
  return /^ht_[A-Za-z0-9_-]{43}$/.test(header) ? header : null;
}

function connectorIdentityKey(
  binding: Pick<
    HostedConnectorBinding,
    'controlPlaneWorkspaceId' | 'organizationId' | 'customerWorkspaceId' | 'hostId'
  >,
): string {
  return JSON.stringify([
    binding.controlPlaneWorkspaceId,
    binding.organizationId,
    binding.customerWorkspaceId,
    binding.hostId,
  ]);
}

export class HostedWorkspaceConnectorGateway {
  private readonly active = new Map<string, Set<{ generation: number; close: (reason: string) => void }>>();

  constructor(
    readonly store: HostedWorkspaceConnectorStore,
    private readonly clock: () => Date = () => new Date(),
    private readonly entropy: (size: number) => Uint8Array = (size) => randomBytes(size),
  ) {}

  async enroll(input: Omit<HostedConnectorBinding, 'generation' | 'state'>, ttlMs = 5 * 60_000): Promise<HostedConnectorTicket> {
    const now = this.clock();
    const ticketValue = token('ht', this.entropy);
    const binding = await this.store.createEnrollment({
      ...normalizeBinding(input), ticketHash: digest(ticketValue), expiresAt: new Date(now.getTime() + ttlMs),
    });
    this.closeGeneration(binding, binding.generation - 1, 'connector_reenrolled');
    return { ticket: ticketValue, binding: { ...binding, kind: 'enrollment', audience: 'connector-register', expiresAt: new Date(now.getTime() + ttlMs) } };
  }

  async register(ticketValue: string): Promise<HostedConnectorCredential | null> {
    const bearer = token('hc', this.entropy);
    const binding = await this.store.register(digest(ticketValue), digest(bearer), this.clock());
    return binding ? { binding, bearer } : null;
  }

  authenticate(bearer: string): Promise<HostedConnectorBinding | null> {
    return this.store.authenticate(digest(bearer), this.clock());
  }

  heartbeat(bearer: string, transport: HostedConnectorTransport): Promise<HostedConnectorBinding | null> {
    return this.store.heartbeat(digest(bearer), transport, this.clock());
  }

  private readonly livenessWrites = new Map<string, Promise<unknown>>();

  /**
   * Persist the relay broker's view of one connector socket (P-001). Writes for
   * the same connector run strictly in call order, so a detach can never be
   * overtaken by the pong that preceded it. Failures are reported, never thrown:
   * the caller is a socket event handler.
   */
  recordLiveness(
    binding: HostedConnectorLivenessBinding,
    alive: boolean,
    onError: (error: unknown) => void = () => {},
  ): Promise<void> {
    const key = `${connectorIdentityKey(binding)}\u0000${binding.generation}`;
    const at = this.clock();
    const previous = this.livenessWrites.get(key) ?? Promise.resolve();
    const next = previous
      .then(() => this.store.recordLiveness(binding, alive, at))
      .then(() => undefined, (error: unknown) => { onError(error); });
    this.livenessWrites.set(key, next);
    void next.then(() => {
      if (this.livenessWrites.get(key) === next) this.livenessWrites.delete(key);
    });
    return next;
  }

  async issueSessionTicket(
    input: Omit<HostedConnectorTicketBinding, 'kind' | 'expiresAt'>,
    ttlMs = 60_000,
  ): Promise<HostedConnectorTicket | null> {
    const now = this.clock();
    const ticketValue = token('ht', this.entropy);
    const binding: HostedConnectorTicketBinding = {
      ...normalizeBinding(input), kind: 'session', userId: required(input.userId ?? '', 'user_id'),
      hostedSessionId: required(input.hostedSessionId ?? '', 'session_id'), audience: required(input.audience, 'audience'),
      expiresAt: new Date(now.getTime() + ttlMs),
    };
    const stored = await this.store.issueSessionTicket({ ...binding, ticketHash: digest(ticketValue), issuedAt: now });
    return stored ? { ticket: ticketValue, binding: stored } : null;
  }

  consumeSessionTicket(ticketValue: string): Promise<HostedConnectorTicketBinding | null> {
    return this.store.consumeTicket(digest(ticketValue), 'session', this.clock());
  }

  async rotate(input: Omit<HostedConnectorBinding, 'generation' | 'state'>, ttlMs = 5 * 60_000): Promise<HostedConnectorTicket | null> {
    const now = this.clock();
    const ticketValue = token('ht', this.entropy);
    const binding = await this.store.rotate({ ...normalizeBinding(input), ticketHash: digest(ticketValue), expiresAt: new Date(now.getTime() + ttlMs), now });
    if (!binding) return null;
    this.closeGeneration(binding, binding.generation - 1, 'connector_rotated');
    return { ticket: ticketValue, binding: { ...binding, kind: 'enrollment', audience: 'connector-register', expiresAt: new Date(now.getTime() + ttlMs) } };
  }

  async revoke(input: Omit<HostedConnectorBinding, 'generation' | 'state' | 'transport'>): Promise<boolean> {
    const binding = await this.store.revoke({ ...input, now: this.clock() });
    if (!binding) return false;
    this.closeGeneration(binding, binding.generation, 'connector_revoked');
    return true;
  }

  track(binding: HostedConnectorBinding, close: (reason: string) => void): () => void {
    const key = connectorIdentityKey(binding);
    const tracked = { generation: binding.generation, close };
    const entries = this.active.get(key) ?? new Set();
    entries.add(tracked);
    this.active.set(key, entries);
    return () => { entries.delete(tracked); if (entries.size === 0) this.active.delete(key); };
  }

  private closeGeneration(binding: HostedConnectorBinding, generation: number, reason: string): void {
    for (const stream of this.active.get(connectorIdentityKey(binding)) ?? []) {
      if (stream.generation === generation) stream.close(reason);
    }
  }
}

function normalizeBinding<T extends Omit<HostedConnectorBinding, 'state' | 'generation'> & Partial<Pick<HostedConnectorBinding, 'state' | 'generation'>>>(input: T): T {
  return {
    ...input,
    controlPlaneWorkspaceId: required(input.controlPlaneWorkspaceId, 'control_workspace_id'),
    organizationId: required(input.organizationId, 'organization_id'),
    customerWorkspaceId: required(input.customerWorkspaceId, 'workspace_id'),
    hostId: required(input.hostId, 'host_id'),
    routeLabel: required(input.routeLabel, 'route_label', true),
  };
}

type ConnectorRow = {
  control_workspace_id: string; organization_id: string; customer_workspace_id: string; host_id: string;
  route_label: string; generation: number; transport: HostedConnectorTransport; state: HostedConnectorBinding['state'];
};

function rowBinding(row: ConnectorRow): HostedConnectorBinding {
  return { controlPlaneWorkspaceId: row.control_workspace_id, organizationId: row.organization_id,
    customerWorkspaceId: row.customer_workspace_id, hostId: row.host_id, routeLabel: row.route_label,
    generation: Number(row.generation), transport: row.transport, state: row.state };
}

/** hosted_service-only Postgres implementation; all ticket consumption is one UPDATE ... RETURNING. */
export class PostgresHostedWorkspaceConnectorStore implements HostedWorkspaceConnectorStore {
  constructor(private readonly run: HostedServiceContextRunner) {}

  async createEnrollment(input: Omit<HostedConnectorBinding, 'generation' | 'state'> & { ticketHash: string; expiresAt: Date }): Promise<HostedConnectorBinding> {
    return this.run(async (sql) => {
      const rows = await sql<ConnectorRow[]>`
        INSERT INTO papercusp_auth.hosted_workspace_connectors
          (control_workspace_id, organization_id, customer_workspace_id, host_id, route_label, generation, credential_hash, state, transport)
        VALUES (${input.controlPlaneWorkspaceId}, ${input.organizationId}, ${input.customerWorkspaceId}, ${input.hostId}, ${input.routeLabel}, 1, NULL, 'pending', ${input.transport})
        ON CONFLICT (control_workspace_id, organization_id, customer_workspace_id, host_id)
        DO UPDATE SET route_label=EXCLUDED.route_label, generation=papercusp_auth.hosted_workspace_connectors.generation+1,
          state='pending', transport=EXCLUDED.transport, credential_hash=NULL, registered_at=NULL,
          heartbeat_at=NULL, revoked_at=NULL, updated_at=now()
        RETURNING control_workspace_id, organization_id, customer_workspace_id, host_id, route_label, generation, transport, state`;
      const binding = rows[0]; if (!binding) throw new Error('hosted_connector_binding_not_found');
      await this.insertTicket(sql, { ...rowBinding(binding), kind: 'enrollment', audience: 'connector-register', expiresAt: input.expiresAt, ticketHash: input.ticketHash, issuedAt: new Date() });
      return rowBinding(binding);
    });
  }

  register(ticketHash: string, credentialHash: string, now: Date): Promise<HostedConnectorBinding | null> {
    return this.run(async (sql) => {
      const ticket = await this.consume(sql, ticketHash, 'enrollment', now); if (!ticket) return null;
      const rows = await sql<ConnectorRow[]>`UPDATE papercusp_auth.hosted_workspace_connectors SET credential_hash=${credentialHash}, state='active', registered_at=${now}, heartbeat_at=${now}, updated_at=${now}
        WHERE control_workspace_id=${ticket.controlPlaneWorkspaceId} AND organization_id=${ticket.organizationId} AND customer_workspace_id=${ticket.customerWorkspaceId} AND host_id=${ticket.hostId} AND generation=${ticket.generation} AND state='pending'
        RETURNING control_workspace_id, organization_id, customer_workspace_id, host_id, route_label, generation, transport, state`;
      return rows[0] ? rowBinding(rows[0]) : null;
    });
  }

  authenticate(hash: string, now: Date): Promise<HostedConnectorBinding | null> { return this.run(async (sql) => {
    const rows=await sql<ConnectorRow[]>`SELECT control_workspace_id,organization_id,customer_workspace_id,host_id,route_label,generation,transport,state FROM papercusp_auth.hosted_workspace_connectors WHERE credential_hash=${hash} AND state='active' AND revoked_at IS NULL LIMIT 1`;
    return rows[0] ? rowBinding(rows[0]) : null;
  }); }

  heartbeat(hash: string, transport: HostedConnectorTransport, now: Date): Promise<HostedConnectorBinding | null> { return this.run(async (sql) => {
    const rows=await sql<ConnectorRow[]>`UPDATE papercusp_auth.hosted_workspace_connectors SET heartbeat_at=${now},updated_at=${now} WHERE credential_hash=${hash} AND state='active' AND revoked_at IS NULL AND transport=${transport} RETURNING control_workspace_id,organization_id,customer_workspace_id,host_id,route_label,generation,transport,state`;
    return rows[0] ? rowBinding(rows[0]) : null;
  }); }

  recordLiveness(binding: HostedConnectorLivenessBinding, alive: boolean, at: Date): Promise<boolean> { return this.run(async (sql) => {
    // Deliberately leaves updated_at alone: a 30s pong stamp is not a change to the binding.
    const rows = alive
      ? await sql`UPDATE papercusp_auth.hosted_workspace_connectors SET heartbeat_at=${at}
          WHERE control_workspace_id=${binding.controlPlaneWorkspaceId} AND organization_id=${binding.organizationId}
            AND customer_workspace_id=${binding.customerWorkspaceId} AND host_id=${binding.hostId}
            AND generation=${binding.generation} AND state='active' AND revoked_at IS NULL
            AND (heartbeat_at IS NULL OR heartbeat_at < ${at})
          RETURNING generation`
      : await sql`UPDATE papercusp_auth.hosted_workspace_connectors SET heartbeat_at=NULL
          WHERE control_workspace_id=${binding.controlPlaneWorkspaceId} AND organization_id=${binding.organizationId}
            AND customer_workspace_id=${binding.customerWorkspaceId} AND host_id=${binding.hostId}
            AND generation=${binding.generation} AND heartbeat_at <= ${at}
          RETURNING generation`;
    return rows.length > 0;
  }); }

  issueSessionTicket(input: HostedConnectorTicketBinding & { ticketHash: string; issuedAt: Date }): Promise<HostedConnectorTicketBinding | null> { return this.run(async (sql) => {
    const rows=await sql<ConnectorRow[]>`SELECT control_workspace_id,organization_id,customer_workspace_id,host_id,route_label,generation,transport,state FROM papercusp_auth.hosted_workspace_connectors WHERE control_workspace_id=${input.controlPlaneWorkspaceId} AND organization_id=${input.organizationId} AND customer_workspace_id=${input.customerWorkspaceId} AND host_id=${input.hostId} AND route_label=${input.routeLabel} AND state='active' LIMIT 1`;
    if(!rows[0]) return null;
    const binding={...rowBinding(rows[0]),kind:'session' as const,userId:input.userId,hostedSessionId:input.hostedSessionId,audience:input.audience,expiresAt:input.expiresAt};
    await this.insertTicket(sql,{...binding,ticketHash:input.ticketHash,issuedAt:input.issuedAt});
    return binding;
  }); }

  consumeTicket(hash: string, kind: HostedConnectorTicketKind, now: Date): Promise<HostedConnectorTicketBinding | null> { return this.run((sql)=>this.consume(sql,hash,kind,now)); }

  rotate(input: Omit<HostedConnectorBinding,'generation'|'state'> & {ticketHash:string;expiresAt:Date;now:Date}): Promise<HostedConnectorBinding|null> { return this.run(async(sql)=>{
    const rows=await sql<ConnectorRow[]>`UPDATE papercusp_auth.hosted_workspace_connectors SET generation=generation+1,credential_hash=NULL,state='pending',transport=${input.transport},route_label=${input.routeLabel},revoked_at=NULL,registered_at=NULL,heartbeat_at=NULL,updated_at=${input.now} WHERE control_workspace_id=${input.controlPlaneWorkspaceId} AND organization_id=${input.organizationId} AND customer_workspace_id=${input.customerWorkspaceId} AND host_id=${input.hostId} AND state='active' RETURNING control_workspace_id,organization_id,customer_workspace_id,host_id,route_label,generation,transport,state`;
    if(!rows[0]) return null; const binding=rowBinding(rows[0]); await this.insertTicket(sql,{...binding,kind:'enrollment',audience:'connector-register',expiresAt:input.expiresAt,ticketHash:input.ticketHash,issuedAt:input.now}); return binding;
  }); }

  revoke(input: Omit<HostedConnectorBinding,'generation'|'state'|'transport'> & {now:Date}): Promise<HostedConnectorBinding|null> { return this.run(async(sql)=>{
    const rows=await sql<ConnectorRow[]>`UPDATE papercusp_auth.hosted_workspace_connectors SET state='revoked',credential_hash=NULL,revoked_at=${input.now},updated_at=${input.now} WHERE control_workspace_id=${input.controlPlaneWorkspaceId} AND organization_id=${input.organizationId} AND customer_workspace_id=${input.customerWorkspaceId} AND host_id=${input.hostId} AND route_label=${input.routeLabel} AND state<>'revoked' RETURNING control_workspace_id,organization_id,customer_workspace_id,host_id,route_label,generation,transport,state`;
    return rows[0]?rowBinding(rows[0]):null;
  }); }

  private async insertTicket(sql: Sql,input:HostedConnectorTicketBinding & {ticketHash:string;issuedAt:Date}):Promise<void>{ await sql`INSERT INTO papercusp_auth.hosted_workspace_connector_tickets (ticket_hash,kind,control_workspace_id,organization_id,customer_workspace_id,host_id,route_label,generation,user_id,hosted_session_id,audience,transport,issued_at,expires_at) VALUES (${input.ticketHash},${input.kind},${input.controlPlaneWorkspaceId},${input.organizationId},${input.customerWorkspaceId},${input.hostId},${input.routeLabel},${input.generation},${input.userId??null},${input.hostedSessionId??null},${input.audience},${input.transport},${input.issuedAt},${input.expiresAt})`; }
  private async consume(sql:Sql,hash:string,kind:HostedConnectorTicketKind,now:Date):Promise<HostedConnectorTicketBinding|null>{ const rows=await sql<any[]>`UPDATE papercusp_auth.hosted_workspace_connector_tickets ticket SET consumed_at=${now} FROM papercusp_auth.hosted_workspace_connectors connector WHERE ticket.ticket_hash=${hash} AND ticket.kind=${kind} AND ticket.consumed_at IS NULL AND ticket.expires_at>${now} AND connector.control_workspace_id=ticket.control_workspace_id AND connector.organization_id=ticket.organization_id AND connector.customer_workspace_id=ticket.customer_workspace_id AND connector.host_id=ticket.host_id AND connector.generation=ticket.generation AND connector.state=${kind==='enrollment'?'pending':'active'} RETURNING ticket.*`; const r=rows[0]; return r?{controlPlaneWorkspaceId:r.control_workspace_id,organizationId:r.organization_id,customerWorkspaceId:r.customer_workspace_id,hostId:r.host_id,routeLabel:r.route_label,generation:Number(r.generation),transport:r.transport,state:kind==='enrollment'?'pending':'active',kind:r.kind,userId:r.user_id??undefined,hostedSessionId:r.hosted_session_id??undefined,audience:r.audience,expiresAt:new Date(r.expires_at)}:null; }
}
