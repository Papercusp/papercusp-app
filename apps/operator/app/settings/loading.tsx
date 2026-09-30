const rows = Array.from({ length: 4 }, (_, index) => index);

export default function SettingsLoading() {
  return (
    <div className="pc-settings-shell" aria-busy="true">
      <aside className="pc-settings-nav" aria-label="Settings sections">
        {rows.map((row) => (
          <span key={row} className="pc-settings-nav-link" aria-hidden="true">
            Loading…
          </span>
        ))}
      </aside>
      <section>
        <div className="pc-card pc-marketplace-loading">Loading settings…</div>
      </section>
    </div>
  );
}
