/** Process-local Slack Socket Mode connection manager, visible through schedule:inventory. */
import { WebSocket } from 'ws';
import { pinModuleState } from '@papercusp/module-singleton';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import {
  type ExternalTriggerSourceRow,
  listPollableExternalTriggerSources,
  updateExternalTriggerSourceSyncState,
} from './source-store';
import {
  acknowledgeSlackSocketEnvelope,
  ingestSlackSocketEnvelope,
  openSlackSocketUrl,
  parseSlackSocketEnvelope,
  reconcileSlackHistoryOnce,
  resolveSlackSocketCredentials,
  type SlackNormalizedEvent,
  type SlackSocketCredentials,
  type SlackSocketEnvelope,
} from './slack';

const RECONCILE_MS = 15_000;
const MAX_BACKOFF_MS = 60_000;

export interface SlackSocketLike {
  send(payload: string): void;
  close(): void;
  on(event: string, listener: (...args: any[]) => void): void;
}

interface Connection {
  source: ExternalTriggerSourceRow;
  socket: SlackSocketLike;
  phase: 'connecting' | 'open';
  processing: Promise<void>;
}

export interface SlackSocketManagerDeps {
  sql?: ReturnType<typeof getOrgPg>['sql'];
  workspaceId?: () => string;
  listSources?: typeof listPollableExternalTriggerSources;
  resolveCredentials?: (source: ExternalTriggerSourceRow, installSlug: string) => Promise<SlackSocketCredentials>;
  reconcileHistory?: (
    source: ExternalTriggerSourceRow,
    credentials: SlackSocketCredentials,
  ) => Promise<ExternalTriggerSourceRow>;
  openUrl?: (credentials: SlackSocketCredentials) => Promise<string>;
  createSocket?: (url: string) => SlackSocketLike;
  processEnvelope?: (
    source: ExternalTriggerSourceRow,
    envelope: SlackSocketEnvelope,
  ) => Promise<SlackNormalizedEvent | null>;
  updateSource?: typeof updateExternalTriggerSourceSyncState;
  now?: () => number;
  log?: (message: string) => void;
}

function key(source: Pick<ExternalTriggerSourceRow, 'workspaceId' | 'id'>): string {
  return `${source.workspaceId}\0${source.id}`;
}

function installSlug(source: ExternalTriggerSourceRow): string {
  const value = source.config.installSlug;
  return typeof value === 'string' && value.trim() ? value.trim() : 'papercusp';
}

function terminalCredentialFailure(message: string): boolean {
  return /token_(?:not_connected|invalid)|credential_ref_invalid|auth_test_401|connections_open_401/i.test(message);
}

function frameText(raw: unknown): unknown {
  if (typeof raw === 'string' || Buffer.isBuffer(raw) || raw instanceof ArrayBuffer) return raw;
  if (raw && typeof raw === 'object' && 'toString' in raw) return String(raw);
  return raw;
}

export class SlackSocketManager {
  private readonly connections = new Map<string, Connection>();
  private readonly attempts = new Map<string, number>();
  private readonly retryAt = new Map<string, number>();
  private stopped = false;

  constructor(private readonly deps: SlackSocketManagerDeps = {}) {}

  private sql() { return this.deps.sql ?? getOrgPg().sql; }
  private now() { return this.deps.now?.() ?? Date.now(); }
  private log(message: string) { (this.deps.log ?? ((value) => console.warn(value)))(`[slack-socket] ${message}`); }

  private async update(source: ExternalTriggerSourceRow, input: Parameters<typeof updateExternalTriggerSourceSyncState>[3]) {
    return (this.deps.updateSource ?? updateExternalTriggerSourceSyncState)(
      this.sql(), source.workspaceId, source.id, input,
    );
  }

  private scheduleRetry(source: ExternalTriggerSourceRow, cause: unknown): void {
    const id = key(source);
    const attempt = (this.attempts.get(id) ?? 0) + 1;
    this.attempts.set(id, attempt);
    this.retryAt.set(id, this.now() + Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.min(attempt - 1, 6)));
    const error = (cause instanceof Error ? cause.message : String(cause)).slice(0, 4000);
    void this.update(source, {
      status: terminalCredentialFailure(error) ? 'error' : 'degraded',
      lastError: error,
    }).catch((updateError) => this.log(`source ${source.id} health update failed: ${String(updateError)}`));
  }

  private rememberLiveChannel(connection: Connection, event: SlackNormalizedEvent | null): Promise<void> {
    if (!event?.channelId) return Promise.resolve();
    const current = Array.isArray(connection.source.cursor.channels)
      ? connection.source.cursor.channels.filter((value): value is string => typeof value === 'string')
      : [];
    const channels = [...new Set([...current, event.channelId])];
    return this.update(connection.source, {
      status: 'connected',
      cursor: { ...connection.source.cursor, channels, lastEventAt: event.occurredAt ?? new Date(this.now()).toISOString() },
      lastError: null,
      connected: true,
    }).then((updated) => { connection.source = updated; });
  }

  private attach(source: ExternalTriggerSourceRow, socket: SlackSocketLike): void {
    const id = key(source);
    const connection: Connection = { source, socket, phase: 'connecting', processing: Promise.resolve() };
    this.connections.set(id, connection);
    socket.on('open', () => {
      connection.phase = 'open';
      this.attempts.delete(id);
      this.retryAt.delete(id);
      void this.update(connection.source, { status: 'connected', lastError: null, connected: true })
        .then((updated) => { connection.source = updated; })
        .catch((error) => this.log(`source ${source.id} open health update failed: ${String(error)}`));
    });
    socket.on('message', (raw: unknown) => {
      const envelope = parseSlackSocketEnvelope(frameText(raw));
      if (!envelope) return;
      try {
        acknowledgeSlackSocketEnvelope(envelope, (payload) => socket.send(payload));
      } catch (error) {
        this.scheduleRetry(connection.source, error);
        try { socket.close(); } catch { /* already closed */ }
        return;
      }
      if (envelope.type === 'disconnect') {
        try { socket.close(); } catch { /* already closed */ }
        return;
      }
      connection.processing = connection.processing
        .then(async () => {
          const event = await (this.deps.processEnvelope
            ? this.deps.processEnvelope(connection.source, envelope)
            : ingestSlackSocketEnvelope(this.sql(), connection.source, envelope));
          await this.rememberLiveChannel(connection, event);
        })
        .catch((error) => {
          this.log(`source ${source.id} envelope failed: ${String(error)}`);
          this.scheduleRetry(connection.source, error);
        });
    });
    socket.on('close', (code?: number, reason?: Buffer) => {
      if (this.connections.get(id) !== connection) return;
      this.connections.delete(id);
      this.scheduleRetry(connection.source, new Error(
        `slack_socket_closed:${code ?? 0}${reason?.length ? `:${reason.toString('utf8').slice(0, 200)}` : ''}`,
      ));
    });
    socket.on('error', (error: Error) => this.log(`source ${source.id} socket error: ${error.message}`));
  }

  async reconcile(): Promise<void> {
    if (this.stopped) return;
    const sql = this.sql();
    const workspaceId = (this.deps.workspaceId ?? activeWorkspaceId)();
    const sources = await (this.deps.listSources ?? listPollableExternalTriggerSources)(sql, workspaceId, 'slack');
    const live = new Set(sources.map(key));
    for (const [id, connection] of this.connections) {
      if (live.has(id)) continue;
      this.connections.delete(id);
      try { connection.socket.close(); } catch { /* already closed */ }
    }
    for (const source of sources) {
      const id = key(source);
      if (this.connections.has(id) || (this.retryAt.get(id) ?? 0) > this.now()) continue;
      try {
        const credentials = await (this.deps.resolveCredentials ?? resolveSlackSocketCredentials)(source, installSlug(source));
        const reconciled = this.deps.reconcileHistory
          ? await this.deps.reconcileHistory(source, credentials)
          : (await reconcileSlackHistoryOnce(sql, source, credentials.botToken)).source;
        const url = await (this.deps.openUrl
          ? this.deps.openUrl(credentials)
          : openSlackSocketUrl(credentials.appToken));
        await this.update(reconciled, { status: 'connecting', lastError: null });
        this.attach(reconciled, (this.deps.createSocket ?? ((value) => new WebSocket(value) as unknown as SlackSocketLike))(url));
      } catch (error) {
        this.scheduleRetry(source, error);
      }
    }
  }

  stop(): void {
    this.stopped = true;
    for (const connection of this.connections.values()) {
      try { connection.socket.close(); } catch { /* already closed */ }
    }
    this.connections.clear();
  }
}

type GlobalState = { manager: SlackSocketManager; timer: ManagedHandle };
interface GlobalStateHolder {
  current?: GlobalState;
}

/**
 * Pin the holder through the shared primitive so duplicate module records stay
 * on one manager and the split remains visible to the module-duplication audit.
 * The holder is eager, while the manager/timer stay lazy so the first caller's
 * injected dependencies retain the existing startup contract.
 */
const state = pinModuleState<GlobalStateHolder>(
  'papercusp.external-triggers.slack-socket-manager',
  () => ({}),
);

/** Start once in the background host. The managed timer is the schedule:inventory health row. */
export function startSlackSocketManager(deps: SlackSocketManagerDeps = {}): GlobalState {
  if (state.current) return state.current;
  const manager = new SlackSocketManager(deps);
  const timer = managedSetInterval('slack-socket-reconcile', RECONCILE_MS, () => manager.reconcile(), {
    category: 'lifecycle',
    classification: 'timeout-reaper',
    fireOnArm: true,
  });
  state.current = { manager, timer };
  return state.current;
}
