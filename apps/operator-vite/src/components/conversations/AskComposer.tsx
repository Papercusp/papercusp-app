/**
 * AskComposer — asking the fleet a question, in the two chromes that need it.
 *
 * OWNER RULE (owner, 2026-07-25): "in the ask fleet section, you should be
 * required to select a specific agent." Before this, an ask was routed purely by
 * TOPIC — which meant an untagged question reached only whoever happened to
 * subscribe, and an ask could land nowhere at all while still reporting success.
 * A named recipient is now mandatory: the Ask button stays disabled until one is
 * chosen, and the chosen agent is SUBSCRIBED to the question before fan-out, so
 * it reaches them whether or not any topic routes to them.
 *
 * This module owns that rule ONCE. The /adv modal and the left rail's inline
 * composer both build on `useAskAgents` + `submitAsk` + `AskAgentSelect`, so the
 * requirement cannot be enforced on one surface and quietly skipped on the
 * other. Topics remain optional and additive — they widen the audience beyond
 * the named agent, they no longer stand in for one.
 */
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useSyncQuery } from '@papercusp/sync';
import { Modal } from '@/app/harness/Modal';
import { Select, type SelectEntry } from '@/app/harness/Select';
import {
  inputStyle,
  primaryBtnStyle,
  secondaryBtnStyle,
  friendlyApiError,
  ErrorBanner,
  FieldLabel,
  HintText,
} from '@/app/harness/picker-kit';
// Relative, not `@/…`: the `@` alias points at the operator (Next) tree, so an
// intra-operator-vite import must be a relative path or it won't resolve.
//
// Reuse, not re-derivation: the roster's membership rule (`isRunningAgent`) and
// display name (`displayName`) are the SAME ones the agents-running pill and the
// rail's Fleet pane use, so the Ask picker cannot disagree with them about who
// is available to answer.
import { displayName, isRunningAgent, type RosterAgent } from '../adv/AgentsRunningPill';
import { conversationErrText, coordFetch } from './unified-conversations';
import { advRosterArgs } from '@/lib/adv-roster-args';

/** advRoster.list returns a single-element array wrapping the roster object. */
interface RosterResponse {
  active: RosterAgent[];
}

export interface AskAgentOption {
  ownerId: string;
  name: string;
  fleetSlug?: string | null;
  intent?: string;
}

/**
 * The agents an ask may be addressed to: everyone currently RUNNING, newest
 * heartbeat first (the roster's own order), fleeted agents grouped by fleet so a
 * long roster stays navigable in a narrow `<select>`.
 */
export function useAskAgents(enabled = true): {
  agents: AskAgentOption[];
  loading: boolean;
  error: unknown;
} {
  const roster = useSyncQuery<RosterResponse>({
    queryName: 'advRoster.list',
    args: advRosterArgs(null),
    enabled,
    staleTime: 8_000,
  });
  const agents = useMemo<AskAgentOption[]>(
    () =>
      (roster.data?.[0]?.active ?? [])
        .filter(isRunningAgent)
        .map((a) => ({
          ownerId: a.ownerId,
          name: displayName(a),
          fleetSlug: a.fleetSlug ?? null,
          intent: a.intent,
        })),
    [roster.data],
  );
  return { agents, loading: roster.loading, error: roster.error };
}

/** Group for the `<optgroup>`s: fleets alphabetically, then unfleeted agents. */
function groupOptions(agents: readonly AskAgentOption[]): Array<{ label: string; agents: AskAgentOption[] }> {
  const fleets = new Map<string, AskAgentOption[]>();
  const loose: AskAgentOption[] = [];
  for (const a of agents) {
    if (a.fleetSlug) {
      const list = fleets.get(a.fleetSlug);
      if (list) list.push(a);
      else fleets.set(a.fleetSlug, [a]);
    } else {
      loose.push(a);
    }
  }
  const groups = [...fleets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([label, list]) => ({ label, agents: list }));
  if (loose.length) groups.push({ label: 'No fleet', agents: loose });
  return groups;
}

/**
 * Send the ask. `agentId` is REQUIRED — this helper refuses rather than silently
 * broadcasting, so a caller that forgets the picker fails loudly in development
 * instead of shipping an unaddressed question.
 *
 * No `force_open` is sent: coord:ask no longer has a knowledge tier to bypass.
 * `to` is now REQUIRED server-side (WI-5951), so naming an agent IS the whole
 * contract — the tool can only open a directed question. Args schemas are
 * `.strict()`, so passing the removed `force_open` would hard-fail the call.
 */
export async function submitAsk(input: {
  question: string;
  agentId: string;
  topics?: string[];
  harness?: string;
}): Promise<{ conversation_id?: string }> {
  const question = input.question.trim();
  if (!question) throw new Error('A question is required.');
  if (!input.agentId) throw new Error('Choose which agent to ask.');
  return coordFetch<{ conversation_id?: string }>('coord/ask', {
    question,
    to: [input.agentId],
    topics: input.topics?.length ? input.topics : undefined,
    harness: input.harness || undefined,
  });
}

export function parseTopics(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 8);
}

/**
 * The required recipient picker.
 *
 * Built on the shared `Select` primitive rather than a native `<select>` — the
 * design lint bans natives in app UI, and the primitive gives us grouped options
 * (agents by fleet) with theming that actually matches the panel, which a bare
 * `<select>` does not inherit.
 */
export function AskAgentSelect({
  agents,
  value,
  onChange,
  loading,
  compact = false,
  id,
}: {
  agents: readonly AskAgentOption[];
  value: string;
  onChange: (ownerId: string) => void;
  loading?: boolean;
  /** Rail chrome: smaller type + tighter box. */
  compact?: boolean;
  id?: string;
}) {
  const empty = !loading && agents.length === 0;
  const options = useMemo<SelectEntry[]>(
    () =>
      groupOptions(agents).map((g) => ({
        kind: 'group' as const,
        label: g.label,
        options: g.agents.map((a) => ({ value: a.ownerId, label: a.name })),
      })),
    [agents],
  );
  return (
    <Select
      id={id}
      testId="ask-agent-select"
      ariaLabel="Agent to ask"
      value={value}
      onChange={onChange}
      options={options}
      disabled={empty}
      placeholder={loading ? 'Loading agents…' : empty ? 'No agents are running' : 'Choose an agent…'}
      triggerClassName={compact ? 'pclsb-select' : undefined}
      triggerStyle={compact ? undefined : { ...inputStyle, cursor: 'pointer' }}
    />
  );
}

/**
 * The /adv "+ Ask" modal. Same field vocabulary as the Create sidebar; the only
 * behavioural change is that the recipient is now a required first field rather
 * than an implicit topic fan-out.
 */
export default function AskComposer({
  open,
  onOpenChange,
  onAsked,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onAsked: () => void;
}) {
  const [question, setQuestion] = useState('');
  const [agentId, setAgentId] = useState('');
  const [topics, setTopics] = useState('');
  const [harness, setHarness] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { agents, loading } = useAskAgents(open);

  const reset = () => {
    setQuestion('');
    setAgentId('');
    setTopics('');
    setHarness('');
    setError(null);
  };

  const ready = question.trim().length > 0 && agentId.length > 0 && !busy;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await submitAsk({
        question,
        agentId,
        topics: parseTopics(topics),
        harness: harness.trim(),
      });
      const name = agents.find((a) => a.ownerId === agentId)?.name ?? agentId;
      toast.success(`Question sent to ${name} — their answer lands in Conversations.`, { duration: 4000 });
      reset();
      onOpenChange(false);
      onAsked();
    } catch (e) {
      setError(friendlyApiError(undefined, conversationErrText(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
      title="Ask the agents"
      contentStyle={{
        width: 'min(540px, 96vw)',
        background: 'var(--bg-popover, #0d1829)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: 22,
        color: 'var(--fg, #e8e8ea)',
      }}
    >
      <p style={{ margin: '0 0 16px', fontSize: 12.5, lineHeight: 1.5, color: 'var(--fg-dim)' }}>
        Opens a question addressed to the agent you choose. Answers arrive back in{' '}
        <strong>Conversations</strong> — this never blocks.
      </p>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      <div style={{ marginBottom: 14 }}>
        <FieldLabel>Ask</FieldLabel>
        <AskAgentSelect agents={agents} value={agentId} onChange={setAgentId} loading={loading} />
        <HintText>
          Required. The question is delivered to this agent directly, whether or not a topic routes to them.
        </HintText>
      </div>
      <div style={{ marginBottom: 14 }}>
        <FieldLabel>Question</FieldLabel>
        <textarea
          autoFocus
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void submit();
          }}
          placeholder="What do you want to ask?"
          rows={4}
          maxLength={2000}
          style={{ ...inputStyle, resize: 'vertical', minHeight: 88, lineHeight: 1.5 }}
        />
      </div>
      <div style={{ marginBottom: 14 }}>
        <FieldLabel>Topics (optional)</FieldLabel>
        <input
          value={topics}
          onChange={(e) => setTopics(e.target.value)}
          placeholder="e.g. inference-gateway, sync (comma-separated)"
          style={inputStyle}
        />
        <HintText>Widens the audience beyond the agent you picked — topic subscribers see it too.</HintText>
      </div>
      <div style={{ marginBottom: 18 }}>
        <FieldLabel>Scope to a pot (optional)</FieldLabel>
        <input
          value={harness}
          onChange={(e) => setHarness(e.target.value)}
          placeholder="harness slug — leave blank for workspace-wide"
          style={inputStyle}
        />
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button type="button" style={secondaryBtnStyle} onClick={() => onOpenChange(false)} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          style={{ ...primaryBtnStyle, opacity: ready ? 1 : 0.6 }}
          onClick={() => void submit()}
          disabled={!ready}
        >
          {busy ? 'Asking…' : 'Ask'}
        </button>
      </div>
    </Modal>
  );
}
