// POST /api/auth/email-proof/confirm : consomme le lien de preuve (formulaire de la
// page /auth/email-proof). En POST pour qu'un scanner de mail ne le déclenche pas.

import { NextRequest, NextResponse } from 'next/server';

import { getCurrentUser } from '@/lib/auth/get-user';
import { consumeEmailProof } from '@/lib/auth/email-proof';
import { getHubBaseUrl } from '@/lib/mail/oauth-cookies';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const baseUrl = getHubBaseUrl(request.url);
  const form = await request.formData();
  const token = form.get('token');
  const target = new URL('/auth/email-proof', baseUrl);

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.redirect(new URL('/login', baseUrl), 303);
  }
  if (typeof token !== 'string' || !token) {
    target.searchParams.set('result', 'invalid');
    return NextResponse.redirect(target, 303);
  }

  const result = await consumeEmailProof(prisma, token, user.id);
  if (result === 'proved') {
    return NextResponse.redirect(new URL('/dashboard?email_proof=ok', baseUrl), 303);
  }
  target.searchParams.set('result', result);
  return NextResponse.redirect(target, 303);
}
