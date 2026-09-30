#!/usr/bin/env node
/**
 * print-canonical-hive-invite — owner-run, once: read the canonical `papercusp` hive
 * identity the Papercusp app already published to the owner's PRIVATE GitHub gist
 * (papercusp-hive-identity.json, via the Solution-C share path on first boot) and print
 * the pubkey + invite secret to paste into
 *   packages/operator-core/lib/harness/canonical-hive-invite.ts
 * to ACTIVATE the silent on-install canonical-hive auto-join
 * (dogfood-silent-canonical-hive-join P-003 / D-001).
 *
 * The invite is a DISCOVERY TOKEN, not an access grant — committing it is safe (real
 * gating = GitHub repo permissions + the owner-signed allowlist). This NEVER prints or
 * commits the private key (that stays in the gist).
 *
 * Usage (on the box / account that OWNS the canonical hive):
 *   GITHUB_TOKEN=$(gh auth token) node packages/operator-core/bin/print-canonical-hive-invite.mjs
 *
 * IMPORTANT: verify the printed pubkey matches the LIVE hive's federation pubkey before
 * committing — a wrong value puts every joiner on the wrong topic. If multiple identity
 * gists exist (WI-867), this uses the OLDEST (the same canonical-dedup rule the app's
 * fetchOwnerHiveIdentity uses) and warns you to delete the stale ones.
 */

const FILENAME = 'papercusp-hive-identity.json';
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

if (!token) {
  console.error(
    'Set GITHUB_TOKEN to the owner account that hosts the canonical hive, e.g.:\n' +
      '  GITHUB_TOKEN=$(gh auth token) node packages/operator-core/bin/print-canonical-hive-invite.mjs',
  );
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'papercusp-print-canonical-invite',
};

const listRes = await fetch('https://api.github.com/gists?per_page=100', { headers });
if (!listRes.ok) {
  console.error(`gist list failed: HTTP ${listRes.status} (does the token have the \`gist\` scope?)`);
  process.exit(1);
}
const list = await listRes.json();
const matches = (Array.isArray(list) ? list : []).filter(
  (g) => g && g.id && g.files && Object.prototype.hasOwnProperty.call(g.files, FILENAME),
);
if (matches.length === 0) {
  console.error(
    `No ${FILENAME} gist found on this account.\n` +
      'Boot the desktop app once on the owner box (it creates + publishes the canonical hive\n' +
      'identity via the Solution-C share path), then re-run this script.',
  );
  process.exit(1);
}

// Oldest-first = canonical (mirrors fetchOwnerHiveIdentity's findCanonicalGistId dedup).
matches.sort((a, b) => {
  const ta = a.created_at ?? '';
  const tb = b.created_at ?? '';
  if (ta !== tb) return ta < tb ? -1 : 1;
  return (a.id ?? '') < (b.id ?? '') ? -1 : 1;
});
const canonical = matches[0];

const oneRes = await fetch(`https://api.github.com/gists/${canonical.id}`, { headers });
if (!oneRes.ok) {
  console.error(`fetch canonical gist ${canonical.id} failed: HTTP ${oneRes.status}`);
  process.exit(1);
}
const one = await oneRes.json();
const content = one.files?.[FILENAME]?.content;
let blob;
try {
  blob = JSON.parse(content);
} catch {
  console.error(`canonical gist ${canonical.id} has a malformed ${FILENAME} blob`);
  process.exit(1);
}
if (!blob || typeof blob.pubkeyBase64 !== 'string' || typeof blob.inviteSecret !== 'string') {
  console.error(`canonical gist ${canonical.id} is missing pubkeyBase64 / inviteSecret`);
  process.exit(1);
}

console.log('\nCanonical Papercusp hive invite (canonical gist:', canonical.id + ')');
console.log('Paste into packages/operator-core/lib/harness/canonical-hive-invite.ts:\n');
console.log(`  const CANONICAL_PUBKEY_BASE64 = '${blob.pubkeyBase64}';`);
console.log(`  const CANONICAL_INVITE_SECRET = '${blob.inviteSecret}';`);
console.log('\n⚠️  VERIFY this pubkey matches the LIVE hive federation pubkey before committing.');

if (matches.length > 1) {
  console.warn(
    `\n⚠️  ${matches.length} identity gists found (WI-867 divergence) — used the OLDEST (${canonical.id}).\n` +
      `   Delete the ${matches.length - 1} stale gist(s) so they can't be re-selected:\n` +
      matches
        .slice(1)
        .map((g) => `     gh gist delete ${g.id}`)
        .join('\n'),
  );
}
