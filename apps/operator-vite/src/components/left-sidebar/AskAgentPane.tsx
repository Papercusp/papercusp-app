/**
 * AskAgentPane — "ask a specific agent a question", in the rail's Agents tab.
 *
 * PLACEMENT (owner, 2026-07-25): "actually the ask tab should be in the agents
 * pane not the conversations pane." Conversations is where answers are READ; the
 * Agents tab is where you deal with agents, so that is where you address one.
 * The Conversations tab deliberately carries no compose control — it would have
 * put the same action in two places in one rail.
 *
 * COMPOSED, not folded into AutomationPane: that pane is the automation CATALOG
 * (scheduled routines + their pause controls) shared by Blender and Docs, and
 * asking a question is neither automation nor something those two panes should
 * inherit. AgentsTab stacks this section above it instead.
 *
 * The rule that a recipient is REQUIRED, the roster that feeds the picker, and
 * the coord:ask call all come from components/conversations/AskComposer — the
 * same module the /adv modal uses, so the two cannot drift.
 */
import { useState } from 'react';
import { ChevronDown, ChevronRight, MessageCircleQuestion, Send } from 'lucide-react';
import { useQueryState, parseAsString, parseAsBoolean } from 'nuqs';
// Relative, not `@/…`: the `@` alias points at the operator (Next) tree, so an
// intra-operator-vite import must be a relative path or it won't resolve.
import {
  AskAgentSelect,
  parseTopics,
  submitAsk,
  useAskAgents,
} from '../conversations/AskComposer';
import { conversationErrText } from '../conversations/unified-conversations';

export default function AskAgentPane({ active }: { active: boolean }) {
  // The chosen recipient is user-meaningful state, so it lives in the URL
  // (CLAUDE.md) — the pane is then deep-linkable and agent-driveable
  // (ui:get_state / ui:dispatch can preselect who gets asked). The mid-edit
  // question/topics drafts are useState: they are drafts, not state anyone
  // should be able to link to.
  const [agentId, setAgentId] = useQueryState('lsq', parseAsString.withDefault(''));
  // Collapsed by default: Ask sits above BOTH Agents lanes, and the Routines
  // lane is meant to be dense (owner 2026-07-25), so it must cost one row of
  // height until you actually want it. Disclosure state is panel open-state →
  // nuqs, per CLAUDE.md.
  const [open, setOpen] = useQueryState('lsqx', parseAsBoolean.withDefault(false));
  const [question, setQuestion] = useState('');
  const [topics, setTopics] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  // Only fetch the roster once the composer is actually open.
  const { agents, loading } = useAskAgents(active && open);
  const ready = question.trim().length > 0 && agentId.length > 0 && !busy;

  async function send() {
    if (!ready) return;
    setBusy(true);
    setError(null);
    setSent(null);
    try {
      await submitAsk({ question, agentId, topics: parseTopics(topics) });
      const name = agents.find((a) => a.ownerId === agentId)?.name ?? agentId;
      setSent(`Sent to ${name}. Their answer lands in Conversations.`);
      setQuestion('');
      setTopics('');
    } catch (e) {
      setError(conversationErrText(e));
    } finally {
      setBusy(false);
    }
  }

  if (!active) return null;

  return (
    <section className={`pclsb-ask${open ? ' is-open' : ''}`} data-testid="ask-agent-pane">
      <button
        type="button"
        className="pclsb-ask__head"
        aria-expanded={open}
        onClick={() => void setOpen(open ? null : true)}
        data-testid="ask-agent-toggle"
      >
        <MessageCircleQuestion size={12} aria-hidden />
        <span className="pclsb-ask__title">Ask an agent</span>
        <span className="pclsb-ask__chev" aria-hidden>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
      </button>

      {!open ? null : (
        <>
      <label className="pclsb-ask__label" htmlFor="lsb-ask-agent">
        Who
      </label>
      <AskAgentSelect
        id="lsb-ask-agent"
        compact
        agents={agents}
        value={agentId}
        loading={loading}
        onChange={(v) => void setAgentId(v || null)}
      />

      <label className="pclsb-ask__label" htmlFor="lsb-ask-question">
        Question
      </label>
      <textarea
        id="lsb-ask-question"
        className="pclsb-ask__textarea"
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void send();
        }}
        placeholder="What do you want to ask them?"
        rows={3}
        maxLength={2000}
      />

      <input
        className="pclsb-ask__input"
        value={topics}
        onChange={(e) => setTopics(e.target.value)}
        placeholder="topics (optional) — e.g. sync, gateway"
        aria-label="Topics (optional)"
      />

      <button
        type="button"
        className="pclsb-ask__send"
        disabled={!ready}
        onClick={() => void send()}
        data-testid="ask-agent-send"
      >
        <Send size={11} aria-hidden />
        {busy ? 'Asking…' : 'Ask'}
      </button>

      {!agentId && !loading && agents.length > 0 && (
        <p className="pclsb-ask__hint">Pick who to ask — a question with no recipient can land nowhere.</p>
      )}
      {sent && (
        <p className="pclsb-ask__ok" role="status">
          {sent}
        </p>
      )}
      {error && (
        <p className="pclsb-ask__err" role="alert">
          {error}
        </p>
      )}
        </>
      )}
    </section>
  );
}
