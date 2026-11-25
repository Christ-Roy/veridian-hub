import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

import { sessionAdmin, type SessionAdmin } from '@/lib/admin/session-admin';

/** Le même refus partout : le corps dit quoi faire, jamais si le compte existe. */
export function refusAdmin(raison: Extract<SessionAdmin, { ok: false }>['raison']): NextResponse {
  if (raison === 'non_connecte') return NextResponse.json({ error: 'unauthorized', message: 'Provide x-admin-secret or authenticate.' }, { status: 401 });
  if (raison === 'preuve_ancienne') return NextResponse.json({ error: 'recent_auth_required', login_url: '/login?reauth=1' }, { status: 403 });
  if (raison === 'emprunt') return NextResponse.json({ error: 'forbidden', message: 'Impersonated session has no admin access.' }, { status: 403 });
  return NextResponse.json({ error: 'forbidden' }, { status: 403 });
}

/** Comparaison en temps constant ; sans secret posé, rien ne passe. */
export function secretAdminValide(fourni: string | null): boolean {
  const attendu = process.env.ADMIN_SECRET;
  if (!attendu || !fourni) return false;
  const a = Buffer.from(fourni);
  const b = Buffer.from(attendu);
  if (a.length !== b.length) {
    timingSafeEqual(a, Buffer.alloc(a.length));
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Garde des routes d'administration : `x-admin-secret` (outil `hub`, batterie) ou session d'un administrateur de plateforme.
 * `null` : autorisé. Sinon la réponse à rendre telle quelle.
 */
export async function requireAdmin(request: NextRequest): Promise<NextResponse | null> {
  if (secretAdminValide(request.headers.get('x-admin-secret'))) return null;
  const s = await sessionAdmin();
  return s.ok ? null : refusAdmin(s.raison);
}
