const path = require('path');

const PAPERCUP_UPSTREAM = process.env.PAPERCUSP_PAPERCUP_UPSTREAM ?? 'http://localhost:3061';
const WEB_UPSTREAM      = process.env.PAPERCUSP_WEB_UPSTREAM      ?? 'http://localhost:3001';

/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,
  output: 'standalone',
  // Workspace root is the parent monorepo (~/Restart), not this submodule.
  // Both must agree per Next 16: turbopack.root mirrors outputFileTracingRoot.
  // __dirname here is libs/papercusp/apps/web → 4 levels up = ~/Restart.
  outputFileTracingRoot: path.join(__dirname, '../../../..'),
  turbopack: { root: path.join(__dirname, '../../../..') },
  typescript: { ignoreBuildErrors: true },
  images: { unoptimized: true },
  experimental: {
    // Disable Turbopack persistent disk cache: deadlocks under load with
    // "Persisting failed: Another write batch or compaction is already active"
    // and pegs the dev server at >600% CPU / >10GB RSS until killed.
    turbopackFileSystemCacheForDev: false,
  },
  transpilePackages: [
    '@papercusp/agent-chat',
    '@papercusp/db-org',
    '@papercusp/git-graph',
    '@papercusp/papercusp-shared',
    '@papercusp/ui-primitives',
  ],
  // /api/harness/* and /api/plugins/* are served LOCALLY by this app
  // (mounted in app/api/[[...route]]/route.ts).
  //
  // Cross-app routes still need rewrites:
  //   /api/{org,briefings,public}/* → apps/papercup on :3061 (Papercup demo)
  //   /api/{admin-sidebar,repo-git,build-info}/* → apps/web on :3001 (Restart admin)
  async rewrites() {
    return [
      { source: '/api/org/:path*',           destination: `${PAPERCUP_UPSTREAM}/api/org/:path*` },
      { source: '/api/briefings/:path*',     destination: `${PAPERCUP_UPSTREAM}/api/briefings/:path*` },
      { source: '/api/public/:path*',        destination: `${PAPERCUP_UPSTREAM}/api/public/:path*` },
      { source: '/api/admin-sidebar/:path*', destination: `${WEB_UPSTREAM}/api/admin-sidebar/:path*` },
      { source: '/api/repo-git/:path*',      destination: `${WEB_UPSTREAM}/api/repo-git/:path*` },
      { source: '/api/build-info',           destination: `${WEB_UPSTREAM}/api/build-info` },
    ];
  },
};
