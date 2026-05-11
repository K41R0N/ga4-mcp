import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  const user = req.nextUrl.searchParams.get('state');
  if (!code || !user) return new NextResponse('Missing code or state', { status: 400 });

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: process.env.GOOGLE_REDIRECT_URI!,
      grant_type: 'authorization_code',
    }),
  });
  const tokens = await tokenRes.json();
  if (!tokens.refresh_token) {
    return new NextResponse(
      'No refresh_token returned. Revoke prior consent at https://myaccount.google.com/permissions and try again.',
      { status: 400 },
    );
  }

  await redis.set(`google_refresh:${user}`, tokens.refresh_token);
  return new NextResponse(
    `Connected as ${user}. You can close this tab and go back to Claude.`,
  );
}
