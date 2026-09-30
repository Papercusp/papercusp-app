# UI mockups and specs

The PUI public-release interaction contract lives in
[`../../apps/tui/PUBLIC_RELEASE_UX.md`](../../apps/tui/PUBLIC_RELEASE_UX.md).
Its machine-validated UI-IR companion is
[`pui-public-release-ux.ir.json`](./pui-public-release-ux.ir.json), derived from
the accepted Surface B reference in
[`pui-agent-cockpit.html`](./pui-agent-cockpit.html).

## Portal Work surfaces

[`portal-work-plans-inbox.html`](./portal-work-plans-inbox.html) is a self-contained
design board for bringing the operator Plans rail/page and Resolution Inbox
rail/page into the cloud portal at `http://127.0.0.1:3081/`.

It includes three directions and a responsive state:

- **A — Work hub (recommended):** one portal rail destination with Plans and
  Inbox as URL-backed inner faces, preserving a list/detail workflow.
- **B — Twin rail:** Plans and Inbox each get a first-class portal icon and
  badge for the shortest path to either surface.
- **C — Attention home:** Work opens on a unified “Needs your call” and “Plans
  in motion” overview, with full Plans and Inbox pages behind it.
- **Narrow state:** the outer rail collapses to icons; secondary details move
  into a drawer or a route-backed detail screen.

The companion [`portal-work-plans-inbox.ir.json`](./portal-work-plans-inbox.ir.json)
is the UI-IR v0.1 design spec. It reuses the registered `control.text`,
`overlay.popover`, `action.primary`, and `action.secondary` primitives.

Open the HTML directly, or use the **Open live portal** link in its header to
compare the study with the current shell.
