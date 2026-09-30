/**
 * The PapercupChat stylesheet — as a JS string, so it travels WITH the component
 * (the operator-ui convention: AccountsTab ships ACCOUNTS_TAB_CSS the same way).
 *
 * Every rule is `.pc-chat*`-prefixed and every colour/size reads a
 * `--pc-chat-*` custom property with a literal fallback (P-006's token seam),
 * so the sheet renders correctly in a host that defines none of them and a host
 * that themes it defines only the variables. The chat-cards renderers inside it
 * (`.ask-choice-card`, `.input-card`, `.pending-cards-bar`) carry their own
 * sheet in the host; this one only positions them.
 *
 * Status-pill colours (WorkRefPill) read `--pc-chat-status-<state>-{solid,bg,text}`;
 * the owner host maps its STATUS table onto them at mount.
 *
 * ⚠ ONE TEMPLATE LITERAL: a stray backtick or ${ anywhere below — including
 * inside a comment — closes the string and the module stops parsing.
 */
export const PAPERCUP_CHAT_CSS = `
.pc-chat { display: flex; flex-direction: column; min-height: 0; height: 100%; gap: var(--pc-chat-gap, 0.5rem); background: var(--pc-chat-surface, transparent); color: var(--pc-chat-fg, inherit); font-size: var(--pc-chat-font-size, 13px); line-height: 1.45; }
.pc-chat__notice { margin: 0; padding: 6px 10px; border-radius: 8px; font-size: 11px; line-height: 1.35; color: var(--pc-chat-fg-mute, #6b7280); background: var(--pc-chat-notice-bg, rgba(99, 102, 241, 0.08)); border: 1px solid var(--pc-chat-notice-border, rgba(99, 102, 241, 0.25)); }
.pc-chat__scroller { position: relative; flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 0 2px; }
.pc-chat__list { position: relative; width: 100%; }
.pc-chat__load-earlier { display: block; margin: 4px auto 8px; padding: 3px 10px; border-radius: 999px; border: 1px solid var(--pc-chat-border, rgba(127, 127, 127, 0.3)); background: transparent; color: var(--pc-chat-fg-mute, #6b7280); font: inherit; font-size: 11px; cursor: pointer; }
.pc-chat__history-boundary { margin: 4px auto 8px; color: var(--pc-chat-fg-mute, #6b7280); font: inherit; font-size: 11px; text-align: center; }
.pc-chat__placeholder { margin: 24px 8px; text-align: center; color: var(--pc-chat-fg-mute, #6b7280); }
.pc-chat__turn { box-sizing: border-box; display: flex; flex-direction: column; gap: 4px; padding: 6px 4px; }
.pc-chat__message-line { display: flex; align-items: flex-start; gap: 6px; min-width: 0; width: 100%; }
.pc-chat__turn--user .pc-chat__message-line { justify-content: flex-end; }
.pc-chat__message-content { display: flex; flex: 0 1 auto; flex-direction: column; gap: 4px; min-width: 0; max-width: 100%; }
.pc-chat__turn--user .pc-chat__message-content { align-items: flex-end; }
.pc-chat__avatar { flex: 0 0 auto; }
.pc-chat__sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.pc-chat__time { flex: 0 0 auto; align-self: flex-start; margin-top: 9px; font-size: 9.5px; line-height: 1; text-align: left; white-space: nowrap; color: var(--pc-chat-fg-mute, #6b7280); font-variant-numeric: tabular-nums; }
.pc-chat__body { max-width: var(--pc-chat-bubble-max, 100%); padding: 8px 10px; border-radius: var(--pc-chat-bubble-radius, 10px); background: var(--pc-chat-bubble-assistant, #f7f7f8); color: var(--pc-chat-bubble-assistant-fg, inherit); overflow-wrap: anywhere; }
.pc-chat__turn--user .pc-chat__body { align-self: flex-end; background: var(--pc-chat-bubble-user, #eef2ff); color: var(--pc-chat-bubble-user-fg, inherit); }
.pc-chat__turn--system .pc-chat__body { background: transparent; border: 1px dashed var(--pc-chat-border, rgba(127, 127, 127, 0.3)); }
.pc-chat__body--empty { color: var(--pc-chat-fg-mute, #6b7280); }
.pc-chat__turn-error { margin: 0; padding: 8px 10px; border-radius: var(--pc-chat-bubble-radius, 10px); background: var(--pc-chat-error-bg, rgba(239, 68, 68, 0.1)); color: var(--pc-chat-error-fg, #b91c1c); }
.pc-chat__body :where(.pc-chat__p) { margin: 0; }
.pc-chat__body :where(.pc-chat__p + .pc-chat__p) { margin-top: 0.55em; }
.pc-chat__body :where(h1, h2, h3, h4, h5, h6) { margin: 0.6em 0 0.25em; font-size: 1.05em; line-height: 1.3; }
.pc-chat__body :where(ul, ol) { margin: 0.25em 0; padding-left: 1.3em; }
.pc-chat__body :where(li) { margin: 0.15em 0; }
.pc-chat__body :where(li > .pc-chat__p) { display: inline; }
.pc-chat__body :where(code) { font-family: var(--pc-chat-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 0.92em; padding: 0.05em 0.3em; border-radius: 4px; background: var(--pc-chat-code-bg, rgba(127, 127, 127, 0.14)); }
.pc-chat__body :where(pre) { margin: 0.4em 0; padding: 8px 10px; border-radius: 8px; overflow-x: auto; background: var(--pc-chat-pre-bg, rgba(127, 127, 127, 0.12)); }
.pc-chat__body :where(pre code) { padding: 0; background: transparent; }
.pc-chat__body :where(blockquote) { margin: 0.4em 0; padding: 0 0 0 10px; border-left: 3px solid var(--pc-chat-border, rgba(127, 127, 127, 0.3)); color: var(--pc-chat-fg-mute, #6b7280); }
.pc-chat__body :where(a) { color: var(--pc-chat-link, #4f46e5); text-decoration: underline; text-underline-offset: 2px; }
.pc-chat__body :where(table) { border-collapse: collapse; margin: 0.4em 0; font-size: 0.95em; }
.pc-chat__body :where(th, td) { padding: 3px 8px; border: 1px solid var(--pc-chat-border, rgba(127, 127, 127, 0.3)); text-align: left; }
.pc-chat__body :where(del) { opacity: 0.7; }
.pc-chat__body :where(input[type="checkbox"]) { margin: 0 6px 0 0; vertical-align: middle; }
.pc-chat__body :where(img.pc-chat__img) { max-width: 100%; height: auto; border-radius: 6px; }
.pc-chat__link-inert, .pc-chat__img-inert { color: var(--pc-chat-fg-mute, #6b7280); }
.pc-chat__table-inert { margin: 0.4em 0; padding: 8px 10px; border-radius: 8px; white-space: pre-wrap; background: var(--pc-chat-pre-bg, rgba(127, 127, 127, 0.12)); }
.pc-chat__tools { display: flex; flex-wrap: wrap; gap: 4px; margin: 0; padding: 0; list-style: none; }
.pc-chat__tool { display: inline-flex; align-items: center; padding: 1px 7px; border-radius: 999px; font-family: var(--pc-chat-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 10px; color: var(--pc-chat-tool-fg, #4b5563); background: var(--pc-chat-tool-bg, rgba(127, 127, 127, 0.14)); }
.pc-chat__card { margin-top: 2px; }
.pc-chat__report { margin-top: 2px; }
.pc-chat__turn-footer { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; font-size: 10.5px; color: var(--pc-chat-fg-mute, #6b7280); }
.pc-chat__turn-footer:empty { display: none; }
.pc-chat__actions { display: flex; gap: 4px; margin-left: auto; }
.pc-chat__streaming { display: inline-flex; align-items: center; gap: 8px; padding: 6px 10px; color: var(--pc-chat-fg-mute, #6b7280); }
.pc-chat__spinner { width: 10px; height: 10px; border-radius: 50%; border: 2px solid var(--pc-chat-border, rgba(127, 127, 127, 0.3)); border-top-color: var(--pc-chat-accent, #6366f1); animation: pc-chat-spin var(--pc-chat-duration-spin, 0.8s) linear infinite; }
@keyframes pc-chat-spin { to { transform: rotate(360deg); } }
.pc-chat__tail { display: flex; flex-direction: column; gap: 6px; }
.pc-chat__tail:empty { display: none; }
.pc-chat__error { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 0; padding: 7px 10px; border-radius: 8px; background: var(--pc-chat-error-bg, rgba(239, 68, 68, 0.1)); color: var(--pc-chat-error-fg, #b91c1c); }
.pc-chat__retry { padding: 3px 10px; border-radius: 999px; border: 1px solid currentColor; background: transparent; color: inherit; font: inherit; font-size: 11px; cursor: pointer; }
.pc-chat__composer { display: flex; align-items: flex-end; gap: 6px; padding: 6px; border-radius: var(--pc-chat-composer-radius, 10px); border: 1px solid var(--pc-chat-border, rgba(127, 127, 127, 0.3)); background: var(--pc-chat-composer-bg, transparent); }
.pc-chat__composer:focus-within { border-color: var(--pc-chat-accent, #6366f1); }
.pc-chat__input { flex: 1 1 auto; min-width: 0; min-height: 1.6em; max-height: 8em; resize: none; border: 0; outline: none; padding: 4px 6px; background: transparent; color: inherit; font: inherit; line-height: 1.4; }
.pc-chat__composer-chrome { display: flex; align-items: center; gap: 4px; }
.pc-chat__send, .pc-chat__stop { flex: 0 0 auto; padding: 5px 12px; border-radius: 999px; border: 0; font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; background: var(--pc-chat-accent, #6366f1); color: var(--pc-chat-accent-fg, #fff); transition: opacity var(--pc-chat-duration-enter, 120ms) ease; }
.pc-chat__send:disabled { opacity: 0.45; cursor: default; }
.pc-chat__stop { background: var(--pc-chat-stop-bg, rgba(127, 127, 127, 0.2)); color: inherit; }
.pc-chat[data-state="operator-down"] .pc-chat__composer { opacity: 0.7; }
@media (prefers-reduced-motion: reduce) { .pc-chat__spinner { animation: none; } }
`;
