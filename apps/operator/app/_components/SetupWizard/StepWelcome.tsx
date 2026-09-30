'use client';

export function StepWelcome({ onStart }: { onStart: () => void }) {
  return (
    <div className="pc-welcome">
      <h2 className="pc-welcome__hello">Welcome. We’ll set this up together.</h2>
      <p className="pc-welcome__lead">
        Papercusp works best with a local database, a project folder, and one coding agent.
        This guide checks those gently, explains why each item matters, and lets optional
        steps wait until you are ready.
      </p>

      <ul className="pc-welcome__checklist" aria-label="Setup essentials">
        <li>
          <span className="pc-welcome__step">1</span>
          <span>
            <strong>Local database</strong>
            <small>Bundled Postgres</small>
          </span>
        </li>
        <li>
          <span className="pc-welcome__step">2</span>
          <span>
            <strong>Workspace folder</strong>
            <small>Where projects live</small>
          </span>
        </li>
        <li>
          <span className="pc-welcome__step">3</span>
          <span>
            <strong>Coding agent</strong>
            <small>Claude Code or oh-my-pi</small>
          </span>
        </li>
      </ul>

      <ul className="pc-welcome__comfort" aria-label="Setup reassurance">
        <li>Nothing leaves your machine unless you choose it.</li>
        <li>Required steps are clearly marked.</li>
        <li>You can come back from Settings at any time.</li>
      </ul>

      <div className="pc-welcome__actions">
        <button type="button" className="pc-btn pc-btn--primary pc-btn--large" onClick={onStart}>
          Start setup →
        </button>
        <span className="pc-welcome__action-note">Start with the essentials. Optional polish can wait.</span>
      </div>
    </div>
  );
}
