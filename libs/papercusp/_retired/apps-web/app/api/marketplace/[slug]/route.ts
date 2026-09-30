import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * Marketplace harness detail proxy.
 *
 * Returns the latest manifest + readme for a published slug. Falls back
 * to a 404 if the marketplace is unreachable or the slug isn't published.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const base = process.env.PAPERCUSP_MARKETPLACE_URL ?? 'http://localhost:3057';
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(slug)) {
    return NextResponse.json({ error: 'invalid slug' }, { status: 400 });
  }
  try {
    const r = await fetch(`${base}/catalog/${slug}`, { cache: 'no-store', signal: AbortSignal.timeout(2000) });
    if (!r.ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
    const detail = await r.json();
    if (detail.versions?.[0]) {
      const manifestR = await fetch(`${base}/catalog/${slug}/${detail.versions[0]}`, { cache: 'no-store', signal: AbortSignal.timeout(2000) });
      if (manifestR.ok) {
        const full = await manifestR.json();
        return NextResponse.json({ ...detail, manifest: full.manifest, readme: full.readme });
      }
    }
    return NextResponse.json(detail);
  } catch (e: any) {
    return NextResponse.json({ error: 'marketplace unreachable' }, { status: 503 });
  }
}
