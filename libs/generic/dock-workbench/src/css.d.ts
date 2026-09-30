// Ambient declaration for side-effect CSS imports (e.g. dockview's theme).
// Consuming apps supply their own bundler handling; this lets the package
// type-check stand-alone.
declare module '*.css';
