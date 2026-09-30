export default function HomePage() {
  return (
    <div className="pc-shell">
      <h1>Papercusp</h1>
      <p style={{ fontSize: 17, color: 'var(--fg)', maxWidth: 640, marginBottom: 32 }}>
        An open-source framework for running autonomous multi-agent missions.
        Define a goal in plain English, install a harness from the marketplace,
        and watch a coordinated team of AI roles plan, execute, validate,
        and iterate against your spec — until it&rsquo;s done.
      </p>

      <div className="pc-grid cards-3" style={{ marginTop: 24 }}>
        <div className="pc-card">
          <h3>Browse the marketplace</h3>
          <p>
            Pick a harness — a coding-project harness, a research org, a content
            pipeline — and install it with one command.
          </p>
          <a href="/marketplace" className="pc-button">Browse →</a>
        </div>
        <div className="pc-card">
          <h3>Run locally</h3>
          <p>
            Your API keys and project files stay on your machine. Papercusp
            runs the harness against your local Anthropic / OpenAI keys.
          </p>
          <a href="/settings/api-keys" className="pc-button">Set up keys →</a>
        </div>
        <div className="pc-card">
          <h3>Publish your harness</h3>
          <p>
            Built something useful? Publish it to the marketplace so others
            can install it with <code>papercusp install &lt;slug&gt;</code>.
          </p>
          <a href="/signup" className="pc-button">Sign up →</a>
        </div>
      </div>

      <div style={{ marginTop: 48, paddingTop: 24, borderTop: '1px solid var(--border)', color: 'var(--fg-mute)', fontSize: 12 }}>
        <p>
          Papercup is the first reference install of Papercusp — a 5-department
          fictional company running an AI-driven shareholder briefing pipeline.
          See <a href="https://papercupai.com">papercupai.com</a>.
        </p>
      </div>
    </div>
  );
}
