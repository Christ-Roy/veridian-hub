import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/auth';
import { isPlatformAdmin } from '@/lib/admin/check-admin';

/**
 * Auth wrapper partagé pour les routes admin du Hub.
 *
 * Deux chemins acceptés :
 *  - header `x-admin-secret` qui matche `ADMIN_SECRET` env (script / cron)
 *  - session Auth.js dont l'email est whitelistée dans `isPlatformAdmin`
 *
 * Renvoie `null` si la requête est autorisée, sinon une `NextResponse` 401/403
 * que la route doit retourner directement.
 */
export async function requireAdmin(request: NextRequest): Promise<NextResponse | null> {
  const adminSecret = process.env.ADMIN_SECRET;
  const headerSecret = request.headers.get('x-admin-secret');
  if (adminSecret && headerSecret === adminSecret) return null;

  const session = await auth();
  if (!session?.user) {
    return NextResponse.json(
      { error: 'Unauthorized — provide x-admin-secret or authenticate' },
      { status: 401 },
    );
  }
  if (!isPlatformAdmin(session.user)) {
    return NextResponse.json({ error: 'Forbidden — admin access only' }, { status: 403 });
  }
  return null;
}
