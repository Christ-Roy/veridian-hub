/**
 * POST /api/admin/users/identity
 *
 * Change le nom ou l'email d'un compte au Hub, seule source de vérité des utilisateurs
 * (CONTRAT-HUB §3.8), et pousse le changement vers les apps. L'email est attesté par
 * l'admin qui agit : il vaut preuve, tracé dans l'audit.
 *
 * Auth : `authenticateAdmin`. Audit : `admin.user.identity`.
 * Corps : { email, new_email?, name? }. Réponse : { hub_user_id, email, name, push }.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { writeAuditLog, resolveActor } from '@/lib/admin/audit-log';
import { authenticateAdmin } from '@/lib/admin/authenticate';
import { pushUserToApps } from '@/lib/identity/push-user';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z
  .object({
    email: z.string().email(),
    new_email: z.string().email().optional(),
    name: z
      .string()
      .min(1)
      .max(120)
      .refine((s) => !/[\x00-\x1f<>]/.test(s), { message: 'name: no control characters or < >' })
      .optional(),
  })
  .refine((d) => d.new_email !== undefined || d.name !== undefined, {
    message: 'new_email or name is required',
  });

export async function POST(request: NextRequest) {
  const authResult = await authenticateAdmin(request);
  if (!authResult.ok) return authResult.response;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_payload', issues: parsed.error.issues }, { status: 400 });
  }

  const email = parsed.data.email.trim().toLowerCase();
  const newEmail = parsed.data.new_email?.trim().toLowerCase();
  const { name } = parsed.data;

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, name: true, supabaseUserId: true, emailVerified: true },
  });
  if (!user) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  if (newEmail && newEmail !== email) {
    const taken = await prisma.user.findUnique({ where: { email: newEmail }, select: { id: true } });
    if (taken) {
      return NextResponse.json({ error: 'email_conflict' }, { status: 409 });
    }
  }

  const changesEmail = Boolean(newEmail && newEmail !== email);
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: {
      ...(name !== undefined ? { name } : {}),
      ...(changesEmail ? { email: newEmail, emailVerified: new Date() } : {}),
    },
    select: { email: true, name: true, emailVerified: true },
  });
  if (changesEmail) {
    await prisma.account.updateMany({
      where: { userId: user.id, provider: 'credentials' },
      data: { providerAccountId: newEmail },
    });
  }

  // Une adresse non prouvée ne part jamais vers les apps.
  const push = user.supabaseUserId
    ? await pushUserToApps({
        hubUserId: user.supabaseUserId,
        ...(name !== undefined ? { name } : {}),
        ...(updated.emailVerified ? { email: updated.email } : {}),
      })
    : {};

  await writeAuditLog(prisma, {
    action: 'admin.user.identity',
    actor: resolveActor(request.headers, authResult.sessionEmail),
    targetType: 'user',
    targetId: user.id,
    payload: { email_before: email, email_after: updated.email, name_changed: name !== undefined, push },
  });

  return NextResponse.json({
    hub_user_id: user.supabaseUserId,
    email: updated.email,
    name: updated.name,
    push,
  });
}
