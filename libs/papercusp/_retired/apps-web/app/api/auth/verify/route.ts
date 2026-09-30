import { NextResponse } from 'next/server';
import { verifyMagicLink, setSessionCookie, uaFromHeaders, ipFromHeaders } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get('token');
  if (!token) return NextResponse.json({ error: 'token required' }, { status: 400 });

  const ua = await uaFromHeaders();
  const ip = await ipFromHeaders();
  const result = await verifyMagicLink(token, ua, ip);
  if (!result.ok) {
    // Redirect back to /login with an error param.
    const back = new URL('/login', url.origin);
    back.searchParams.set('error', result.reason ?? 'unknown');
    return NextResponse.redirect(back);
  }

  await setSessionCookie(result.sessionId!);
  // Redirect to settings/profile so the user can fill in their preferences.
  return NextResponse.redirect(new URL('/settings/profile', url.origin));
}
