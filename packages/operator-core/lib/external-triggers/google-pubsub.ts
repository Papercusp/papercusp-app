/**
 * Idempotent Google Pub/Sub provisioning for Gmail push notifications.
 *
 * The existing Vertex service account is used only for GCP control-plane
 * operations. User mailbox access remains on the Desktop OAuth provider. The
 * provisioner uses google-auth-library for a short-lived bearer token, and
 * takes both its transport (gaxios) and its wire shapes (@googleapis/pubsub)
 * from the published libraries instead of hand-rolling either — the same
 * pattern google-gmail.ts and google-calendar.ts already use. gcloud is still
 * avoided; this is a typed REST client, not the heavyweight @google-cloud SDK.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { Gaxios, type GaxiosError } from 'gaxios';
import type { pubsub_v1 } from '@googleapis/pubsub';

export const GMAIL_PUSH_PUBLISHER = 'serviceAccount:gmail-api-push@system.gserviceaccount.com';
export const PUBSUB_CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

const DEFAULT_TOPIC_ID = 'papercusp-gmail-push';
const PUBSUB_API_ORIGIN = 'https://pubsub.googleapis.com';
const RESOURCE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._~+%:-]{0,254}$/;
const requireCjs = createRequire(import.meta.url);

export interface GooglePubSubProvisionInput {
  /** Every workspace gets an independent pull subscription on the shared topic. */
  workspaceId: string;
  /** Defaults to project_id in the service-account JSON. */
  projectId?: string;
  /** Defaults to PAPERCUSP_GOOGLE_PUBSUB_SERVICE_ACCOUNT_PATH, then GOOGLE_APPLICATION_CREDENTIALS. */
  serviceAccountPath?: string;
  topicId?: string;
  subscriptionId?: string;
  ackDeadlineSeconds?: number;
}

export interface GooglePubSubProvisionResult {
  projectId: string;
  subscriptionId: string;
  topicName: string;
  subscriptionName: string;
  topic: 'created' | 'existing';
  subscription: 'created' | 'existing';
  publisherGrant: 'added' | 'existing';
}

export interface GooglePubSubProvisionDeps {
  fetch?: typeof fetch;
  getAccessToken?: (serviceAccountPath: string) => Promise<string>;
  apiOrigin?: string;
}

export interface GooglePubSubReceivedMessage {
  ackId: string;
  message?: {
    data?: string;
    messageId?: string;
    publishTime?: string;
    attributes?: Record<string, string>;
  };
}

export interface GooglePubSubPullInput extends GooglePubSubProvisionInput {
  maxMessages?: number;
}

/**
 * Wire shapes come from @googleapis/pubsub rather than being hand-written, so
 * a field Google adds, re-types, or makes nullable cannot silently drift out of
 * this file. These are ALIASES, not renames: every call site below keeps the
 * name it already used, which is what keeps the blast radius at zero.
 *
 * The published types are WIDER than the hand-written ones they replace —
 * `members` is `string[] | null`, not `string[] | undefined`. That is the
 * point: withGmailPublisher already rebuilt every binding's members through
 * `[...(binding.members ?? [])]`, so the runtime always tolerated an absent
 * list and only the signature was narrower than the behaviour it described.
 */
type IamBinding = pubsub_v1.Schema$Binding;
type IamPolicy = pubsub_v1.Schema$Policy;

function resourceSegment(value: string | undefined, field: string): string {
  const normalized = value?.trim() ?? '';
  if (!normalized || !RESOURCE_SEGMENT.test(normalized) || normalized.includes('/')) {
    throw new Error(`google_pubsub_invalid_${field}`);
  }
  return normalized;
}

/** Stable, collision-resistant subscription id for one workspace. */
export function googleGmailSubscriptionId(workspaceId: string): string {
  const normalized = workspaceId.trim();
  if (!normalized) throw new Error('google_pubsub_invalid_workspace_id');
  const readable =
    normalized
      .toLowerCase()
      .replace(/[^a-z0-9._~+%-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 200) || 'workspace';
  const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 12);
  return resourceSegment(`papercusp-gmail-pull-${readable}-${digest}`, 'subscription_id');
}

/**
 * Resolve the Pub/Sub key file, preferring a credential dedicated to THIS subsystem.
 *
 * `GOOGLE_APPLICATION_CREDENTIALS` is the ambient ADC chain for the whole process, and
 * another subsystem in this same process legitimately needs it ABSENT: workspace-host
 * provisioning bans service-account keys outright (`gcp-preflight.ts`), so
 * `papercup-bg-host.service.d/95-bundled-entry.conf` unsets ADC in ExecStart. bg-host is
 * also the DBOS routines primary (`PAPERCUSP_DBOS_ROUTINES=1`), which is where
 * `google-gmail-poll` runs — so before this precedence existed, one subsystem's correct
 * hardening silently stranded another's, and both Gmail sources sat degraded on
 * `google_pubsub_service_account_path_required` while the topic, its publisher IAM binding
 * and the pull subscription were all already provisioned (WI-474688, measured 2026-08-28).
 *
 * A dedicated variable removes the coupling: Pub/Sub gets an explicit key path and ADC
 * stays clean for the callers that must refuse a key. Explicit `input` still wins over both.
 */
function serviceAccountPath(input?: string): string {
  const path =
    input?.trim() ||
    process.env.PAPERCUSP_GOOGLE_PUBSUB_SERVICE_ACCOUNT_PATH?.trim() ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (!path) throw new Error('google_pubsub_service_account_path_required');
  return path;
}

interface ServiceAccountIdentity {
  projectId: string | null;
  /** `client_email` from the key file — the principal every 401/403 below is really about. */
  principal: string | null;
}

/**
 * Read project + principal from the key file.
 *
 * `required` is true only when the caller supplied no explicit `projectId` and
 * the file is therefore load-bearing. Otherwise the read is best-effort: the
 * principal is wanted purely to make a 403 legible, and a caller that passed its
 * own project must not start failing because a key file is unreadable.
 */
async function serviceAccountIdentity(
  path: string,
  required: boolean,
): Promise<ServiceAccountIdentity> {
  let parsed: { project_id?: string; client_email?: string };
  try {
    parsed = JSON.parse(await fs.readFile(path, 'utf8')) as typeof parsed;
  } catch (error) {
    if (required) throw error;
    return { projectId: null, principal: null };
  }
  const principal = parsed.client_email?.trim();
  const projectId = parsed.project_id?.trim();
  return {
    projectId: projectId && projectId.length > 0 ? projectId : null,
    principal: principal && principal.length > 0 ? principal : null,
  };
}

/**
 * The Pub/Sub permission each REST call actually consumes.
 *
 * Google answers every one of them with the same opaque "User not authorized to
 * perform this action." and never names the denied principal, so a 403 here is
 * indistinguishable from an expired user login unless we say which identity was
 * used. `set_topic_iam_policy` is the reason the grant must be `roles/pubsub.admin`
 * rather than `roles/pubsub.editor` — editor confers no `setIamPolicy`.
 */
const PUBSUB_OPERATION_PERMISSIONS: Readonly<Record<string, string>> = {
  get_topic: 'pubsub.topics.get',
  create_topic: 'pubsub.topics.create',
  get_topic_iam_policy: 'pubsub.topics.getIamPolicy',
  set_topic_iam_policy: 'pubsub.topics.setIamPolicy',
  get_subscription: 'pubsub.subscriptions.get',
  create_subscription: 'pubsub.subscriptions.create',
  pull: 'pubsub.subscriptions.consume',
  acknowledge: 'pubsub.subscriptions.consume',
};

/** Role that grants every permission in the map above. */
export const PUBSUB_REQUIRED_ROLE = 'roles/pubsub.admin';

interface PubSubAuthContext {
  token: string;
  principal: string | null;
  projectId: string;
  credentialPath: string;
}

/**
 * Turn an opaque 401/403 into the one line an operator can act on: which
 * principal was denied, where that principal came from, and the exact grant.
 */
export function describePubSubAuthFailure(
  operation: string,
  auth: Pick<PubSubAuthContext, 'principal' | 'projectId' | 'credentialPath'>,
): string {
  const permission = PUBSUB_OPERATION_PERMISSIONS[operation];
  const principal = auth.principal ?? `unresolved (no client_email in ${auth.credentialPath})`;
  return (
    ` [denied_principal=${principal}` +
    ` project=${auth.projectId}` +
    (permission ? ` missing_permission=${permission}` : '') +
    ` required_role=${PUBSUB_REQUIRED_ROLE}` +
    ` credential_source=GOOGLE_APPLICATION_CREDENTIALS=${auth.credentialPath}` +
    ` fix=gcloud projects add-iam-policy-binding ${auth.projectId}` +
    ` --member=serviceAccount:${auth.principal ?? '<client_email>'}` +
    ` --role=${PUBSUB_REQUIRED_ROLE}]`
  );
}

async function defaultAccessToken(path: string): Promise<string> {
  // Lazy CJS interop matches the existing FCM credential path and keeps the
  // auth package out of processes that never provision Google resources.
  const { GoogleAuth } = requireCjs('google-auth-library') as typeof import('google-auth-library');
  const auth = new GoogleAuth({ keyFilename: path, scopes: [PUBSUB_CLOUD_PLATFORM_SCOPE] });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('google_pubsub_access_token_empty');
  return token;
}

async function runtimeContext(
  input: GooglePubSubProvisionInput,
  deps: GooglePubSubProvisionDeps,
): Promise<{
  projectId: string;
  subscriptionId: string;
  auth: PubSubAuthContext;
  fetchImpl: typeof fetch;
  origin: string;
}> {
  const credentialPath = serviceAccountPath(input.serviceAccountPath);
  const identity = await serviceAccountIdentity(credentialPath, !input.projectId?.trim());
  const projectId = resourceSegment(input.projectId ?? identity.projectId ?? undefined, 'project_id');
  const subscriptionId = resourceSegment(
    input.subscriptionId ?? googleGmailSubscriptionId(input.workspaceId),
    'subscription_id',
  );
  const token = await (deps.getAccessToken ?? defaultAccessToken)(credentialPath);
  return {
    projectId,
    subscriptionId,
    auth: { token, principal: identity.principal, projectId, credentialPath },
    fetchImpl: deps.fetch ?? fetch,
    origin: (deps.apiOrigin ?? PUBSUB_API_ORIGIN).replace(/\/$/, ''),
  };
}

const PUBSUB_MAX_RETRIES = 3;

/**
 * gaxios ships retrying GET/HEAD/PUT/OPTIONS/DELETE on 408/429/5xx and
 * deliberately NOT retrying POST. We keep that exclusion and WIDEN it to every
 * mutating method — but the reason here is NOT the one google-calendar.ts
 * carries, and the distinction is worth stating rather than copying.
 *
 * Nothing in this file publishes a message, so no replay can duplicate a
 * delivery. What a replayed 5xx can do:
 *   - `pull` — lease a SECOND batch while the first (possibly delivered, its
 *     response lost) stays leased until the ack deadline, so a doorbell is
 *     double-leased and processed twice.
 *   - `setIamPolicy` — a read-modify-write whose etag is sent back; a stale
 *     replay is rejected by Google rather than clobbering a concurrent edit,
 *     so this one is protected already.
 *   - `acknowledge` / `create_topic` / `create_subscription` — genuinely
 *     idempotent: re-acking the same ids is a no-op, and re-creating answers
 *     ALREADY_EXISTS, which the callers below already handle.
 * Only `pull` is actually hazardous; the blanket exclusion is deliberate
 * conservatism plus consistency with the two sibling adapters, not a claim
 * that each of these would double-write.
 *
 * 429 is the exception in the other direction: rate-limited means the request
 * was provably NOT performed, so it is safe to replay for every method.
 *
 * Supplying `shouldRetry` REPLACES gaxios' own predicate, so this states the
 * whole policy rather than delegating half of it.
 */
const PUBSUB_UNSAFE_TO_REPLAY = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

function shouldRetryPubSub(err: GaxiosError): boolean {
  const attempt = err.config?.retryConfig?.currentRetryAttempt ?? 0;
  if (attempt >= PUBSUB_MAX_RETRIES) return false;
  const method = (err.config?.method ?? 'GET').toUpperCase();
  const mutating = PUBSUB_UNSAFE_TO_REPLAY.has(method);
  const status = err.response?.status;
  if (status === undefined) {
    // No response at all (socket/DNS): the server may still have acted on a
    // mutating request, so only replay methods that are safe to repeat.
    return !mutating && attempt < 2;
  }
  if (mutating) return status === 429;
  return status === 408 || status === 429 || (status >= 100 && status <= 199) || (status >= 500 && status <= 599);
}

/**
 * Format a provider failure into this file's existing error contract. The
 * prefix stays byte-identical so existing matchers keep working; the identity
 * diagnostic is appended only where it is the actual question.
 */
function pubSubApiError(
  status: number,
  operation: string,
  data: unknown,
  auth?: PubSubAuthContext,
): Error {
  const providerMessage =
    typeof data === 'string'
      ? data.slice(0, 500) || undefined
      : data && typeof data === 'object'
        ? ((data as { error?: { message?: string }; message?: string }).error?.message ??
          (data as { message?: string }).message)
        : undefined;
  const diagnostic =
    auth && (status === 401 || status === 403) ? describePubSubAuthFailure(operation, auth) : '';
  return new Error(
    `google_pubsub_${operation}_${status}${providerMessage ? `:${providerMessage}` : ''}${diagnostic}`,
  );
}

function authHeaders(token: string, body: unknown): HeadersInit {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/json',
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
  };
}

async function request<T>(
  fetchImpl: typeof fetch,
  auth: PubSubAuthContext,
  operation: string,
  url: string,
  method: string,
  body?: unknown,
): Promise<{ status: number; value: T | null }> {
  const transport = new Gaxios({ fetchImplementation: fetchImpl });
  try {
    const response = await transport.request<T>({
      url,
      method: method as 'GET',
      headers: authHeaders(auth.token, body) as Record<string, string>,
      // Pre-serialized so the wire body stays a JSON string, byte-identical to
      // what the hand-rolled encoder sent.
      body: body === undefined ? undefined : JSON.stringify(body),
      retryConfig: { retry: PUBSUB_MAX_RETRIES, shouldRetry: shouldRetryPubSub },
      errorRedactor: false,
    });
    // Mirrors the previous parser exactly: an empty 200 body became `{}`, not
    // null, and two callers below distinguish "absent" (404) from "present but
    // empty" — collapsing them would turn a routable empty policy into the
    // `unroutable` error.
    const data = response.data as T | undefined;
    return {
      status: response.status,
      value: data === undefined || (data as unknown) === '' ? ({} as T) : data,
    };
  } catch (err) {
    const gaxios = err as Partial<GaxiosError> & { status?: number };
    const status = gaxios?.response?.status ?? gaxios?.status;
    // 404 is load-bearing and must NOT throw: `get_topic` reads it as "create
    // it", and `get_topic_iam_policy` reads it as "the request never reached
    // the method" (WI-41682). gaxios rejects non-2xx by default, so the branch
    // that used to sit before the parser now lives here.
    if (status === 404) return { status: 404, value: null };
    if (typeof status !== 'number') throw err instanceof Error ? err : new Error(String(err));
    throw pubSubApiError(status, operation, gaxios?.response?.data, auth);
  }
}

function withGmailPublisher(policy: IamPolicy): { policy: IamPolicy; changed: boolean } {
  const bindings = (policy.bindings ?? []).map((binding) => ({
    ...binding,
    members: [...(binding.members ?? [])],
  }));
  let publisher = bindings.find(
    (binding) => binding.role === 'roles/pubsub.publisher' && binding.condition === undefined,
  );
  if (!publisher) {
    publisher = { role: 'roles/pubsub.publisher', members: [] };
    bindings.push(publisher);
  }
  if (publisher.members!.includes(GMAIL_PUSH_PUBLISHER)) {
    return { policy: { ...policy, bindings }, changed: false };
  }
  publisher.members!.push(GMAIL_PUSH_PUBLISHER);
  publisher.members!.sort();
  return { policy: { ...policy, bindings }, changed: true };
}

/**
 * Ensure the Gmail topic, publisher IAM binding, and pull subscription exist.
 * Existing resources are read and validated; a subscription pointing at a
 * different topic fails closed instead of being silently repurposed.
 */
export async function provisionGoogleGmailPubSub(
  input: GooglePubSubProvisionInput,
  deps: GooglePubSubProvisionDeps = {},
): Promise<GooglePubSubProvisionResult> {
  const { projectId, subscriptionId, auth, fetchImpl, origin } = await runtimeContext(input, deps);
  const topicId = resourceSegment(input.topicId ?? DEFAULT_TOPIC_ID, 'topic_id');
  const ackDeadlineSeconds = input.ackDeadlineSeconds ?? 60;
  if (!Number.isInteger(ackDeadlineSeconds) || ackDeadlineSeconds < 10 || ackDeadlineSeconds > 600) {
    throw new Error('google_pubsub_invalid_ack_deadline_seconds');
  }

  const projectSegment = encodeURIComponent(projectId);
  const topicSegment = encodeURIComponent(topicId);
  const subscriptionSegment = encodeURIComponent(subscriptionId);
  const topicName = `projects/${projectId}/topics/${topicId}`;
  const subscriptionName = `projects/${projectId}/subscriptions/${subscriptionId}`;
  const topicUrl = `${origin}/v1/projects/${projectSegment}/topics/${topicSegment}`;
  const subscriptionUrl = `${origin}/v1/projects/${projectSegment}/subscriptions/${subscriptionSegment}`;

  const existingTopic = await request<{ name: string }>(fetchImpl, auth, 'get_topic', topicUrl, 'GET');
  let topic: GooglePubSubProvisionResult['topic'] = 'existing';
  if (existingTopic.status === 404) {
    await request(fetchImpl, auth, 'create_topic', topicUrl, 'PUT', {});
    topic = 'created';
  }

  // Pub/Sub v1 exposes topics.getIamPolicy as a GET; only setIamPolicy is a
  // POST. A POST here matches no API method, so Google answers with its generic
  // HTML 404 page rather than a JSON API error — which request() folds into the
  // 404 branch, producing a falsy value and a domain error about the policy
  // (WI-41682). The verb is load-bearing, not stylistic.
  const policyResult = await request<IamPolicy>(
    fetchImpl,
    auth,
    'get_topic_iam_policy',
    `${topicUrl}:getIamPolicy`,
    'GET',
  );
  // The topic demonstrably exists by this point — it was either fetched above or
  // just created — and a topic with no bindings still answers 200 with an etag.
  // So a 404 here is never "the policy is absent"; it means the request did not
  // reach topics.getIamPolicy at all. Say that, instead of blaming the policy.
  if (!policyResult.value) {
    throw new Error(`google_pubsub_get_topic_iam_policy_unroutable:${topicName}`);
  }
  const merged = withGmailPublisher(policyResult.value);
  let publisherGrant: GooglePubSubProvisionResult['publisherGrant'] = 'existing';
  if (merged.changed) {
    await request(fetchImpl, auth, 'set_topic_iam_policy', `${topicUrl}:setIamPolicy`, 'POST', {
      policy: merged.policy,
    });
    publisherGrant = 'added';
  }

  const existingSubscription = await request<{ name: string; topic?: string }>(
    fetchImpl,
    auth,
    'get_subscription',
    subscriptionUrl,
    'GET',
  );
  let subscription: GooglePubSubProvisionResult['subscription'] = 'existing';
  if (existingSubscription.status === 404) {
    await request(fetchImpl, auth, 'create_subscription', subscriptionUrl, 'PUT', {
      topic: topicName,
      ackDeadlineSeconds,
    });
    subscription = 'created';
  } else if (existingSubscription.value?.topic !== topicName) {
    throw new Error(`google_pubsub_subscription_topic_mismatch:${existingSubscription.value?.topic ?? 'unset'}`);
  }

  return {
    projectId,
    subscriptionId,
    topicName,
    subscriptionName,
    topic,
    subscription,
    publisherGrant,
  };
}

/** Pull a bounded doorbell batch from this workspace's subscription. */
export async function pullGoogleGmailNotifications(
  input: GooglePubSubPullInput,
  deps: GooglePubSubProvisionDeps = {},
): Promise<GooglePubSubReceivedMessage[]> {
  const { projectId, subscriptionId, auth, fetchImpl, origin } = await runtimeContext(input, deps);
  const maxMessages = input.maxMessages ?? 100;
  if (!Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > 1_000) {
    throw new Error('google_pubsub_invalid_max_messages');
  }
  const url =
    `${origin}/v1/projects/${encodeURIComponent(projectId)}` +
    `/subscriptions/${encodeURIComponent(subscriptionId)}:pull`;
  const pulled = await request<{ receivedMessages?: GooglePubSubReceivedMessage[] }>(
    fetchImpl,
    auth,
    'pull',
    url,
    'POST',
    { maxMessages, returnImmediately: true },
  );
  if (pulled.status === 404) throw new Error(`google_pubsub_subscription_missing:${subscriptionId}`);
  return (pulled.value?.receivedMessages ?? []).filter(
    (received): received is GooglePubSubReceivedMessage =>
      typeof received?.ackId === 'string' && received.ackId.length > 0,
  );
}

/** Ack only notifications whose Gmail reconciliation and cursor commit succeeded. */
export async function acknowledgeGoogleGmailNotifications(
  input: GooglePubSubProvisionInput,
  ackIds: string[],
  deps: GooglePubSubProvisionDeps = {},
): Promise<number> {
  const uniqueAckIds = [...new Set(ackIds.filter((ackId) => ackId.trim()))];
  if (uniqueAckIds.length === 0) return 0;
  if (uniqueAckIds.length > 1_000) throw new Error('google_pubsub_too_many_ack_ids');
  const { projectId, subscriptionId, auth, fetchImpl, origin } = await runtimeContext(input, deps);
  const url =
    `${origin}/v1/projects/${encodeURIComponent(projectId)}` +
    `/subscriptions/${encodeURIComponent(subscriptionId)}:acknowledge`;
  const acknowledged = await request(fetchImpl, auth, 'acknowledge', url, 'POST', { ackIds: uniqueAckIds });
  if (acknowledged.status === 404) {
    throw new Error(`google_pubsub_subscription_missing:${subscriptionId}`);
  }
  return uniqueAckIds.length;
}
