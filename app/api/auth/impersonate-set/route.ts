/**
 * POST /api/auth/impersonate-set
 *
 * Endpoint admin qui PRÉPARE une impersonation : génère un token impersonate
 * court-vécu (10 min, usage unique, stocké hashé) pour un user cible et
 * retourne l'URL `/api/auth/impersonate-callback` à ouvrir pour consommer ce
 * token et se retrouver loggué en tant que ce user.
 *
 * Découplé de POST /api/admin/impersonate (qui, lui, génère AUSSI les liens
 * auto-login Prospection / Notifuse). Cet endpoint-ci ne fait QUE le volet
 * session Hub — il est appelable seul, et c'est lui que la route admin
 * réutilise pour la partie "lien Hub".
 *
 * Sécurité (tier 🔴 HAUT) :
 *  - `authenticateAdmin` : x-admin-secret timing-safe OU session platform admin.
 *  - Anti-ré-impersonation : si la session courante est elle-même impersonée,
 *    refus 403 — un user impersoné ne peut pas rebondir pour impersoner.
 *  - Audit log `admin.impersonate.start` à chaque génération de token.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { auth } from '@/auth';
import { authenticateAdmin } from '@/lib/admin/authenticate';
import { writeAuditLog } from '@/lib/admin/audit-log';
import { prisma } from '@/lib/prisma';
import {
  createImpersonationToken,
  isImpersonatedSession,
} from '@/lib/auth/impersonation';
import { getURL } from '@/utils/helpers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const bodySchema = z.object({
  email: z.string().email(),
});

export async function POST(request: NextRequest) {
  // 1. Auth admin (timing-safe secret OU session platform admin) + rate-limit IP.
  const adminAuth = await authenticateAdmin(request);
  if (!adminAuth.ok) return adminAuth.response;

  // 2. Anti-ré-impersonation : refuser si la session courante est déjà
  //    impersonée. Le x-admin-secret n'a pas de session → jamais impersoné.
  const currentSession = await auth();
  if (isImpersonatedSession(currentSession)) {
    return NextResponse.json(
      { error: 'forbidden', message: 'An impersonated session cannot start another impersonation.' },
      { status: 403 }
    );
  }

  // 3. Parse + valide le body.
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_body', message: 'email is required and must be valid' },
      { status: 400 }
    );
  }
  const { email } = parsed.data;

  // 4. Résout le user cible.
  const targetUser = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true },
  });
  if (!targetUser) {
    return NextResponse.json({ error: 'user_not_found', email }, { status: 404 });
  }

  // 5. Génère le token impersonate (hashé en base, usage unique, TTL 10min).
  const { rawToken, expires } = await createImpersonationToken(prisma, targetUser.id);

  // 6. Audit — qui prépare l'impersonation de qui, quand.
  const actor = adminAuth.sessionEmail
    ? `admin:${adminAuth.sessionEmail}`
    : 'token:ADMIN_SECRET';
  await writeAuditLog(prisma, {
    action: 'admin.impersonate.start',
    actor,
    targetType: 'user',
    targetId: targetUser.id,
    payload: { targetEmail: targetUser.email, expiresAt: expires.toISOString() },
  });

  const callbackUrl = `${getURL('/api/auth/impersonate-callback')}?token=${encodeURIComponent(rawToken)}`;

  return NextResponse.json({
    ok: true,
    target_user_id: targetUser.id,
    target_email: targetUser.email,
    callback_url: callbackUrl,
    expires_at: expires.toISOString(),
  });
}
