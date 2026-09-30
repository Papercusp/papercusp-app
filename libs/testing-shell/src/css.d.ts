// Side-effect CSS imports (e.g. `import './domain-panel.css'`) carry no
// types; the bundler (Vite for operator-vite, Next for operator) handles
// them. This ambient declaration keeps standalone `tsc --noEmit` clean.
declare module '*.css';
