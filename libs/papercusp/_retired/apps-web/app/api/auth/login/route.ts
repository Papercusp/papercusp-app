import { NextResponse } from 'next/server';
import { requestMagicLink, sendMagicLinkEmail, ipFromHeaders } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const email = typeof body?.email === 'string' ? body.email.trim() : '';
  if (!email) return NextResponse.json({ error: 'email required' }, { status: 400 });

  let token: string;
  try {
    const ip = await ipFromHeaders();
    const result = await requestMagicLink(email, ip);
    token = result.token;
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'failed' }, { status: 400 });
  }

  // Build the magic link URL using the request's host, so it works whether
  // the user came in via :3055 directly or via papercuspai.com later.
  const url = new URL(req.url);
  const magicUrl = `${url.origin}/api/auth/verify?token=${token}`;
  await sendMagicLinkEmail(email.toLowerCase(), magicUrl);

  // In dev we also surface the link in the response so manual testing
  // doesn't require tailing the server log. Production builds should
  // strip this — return only `{ ok: true }`.
  const exposeLink = process.env.NODE_ENV !== 'production';
  return NextResponse.json({ ok: true, ...(exposeLink ? { devMagicUrl: magicUrl } : {}) });
}
