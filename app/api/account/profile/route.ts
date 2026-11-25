/**
 * PATCH /api/account/profile
 *
 * Met à jour le profil du user authentifié (Auth.js v5 + Prisma).
 * Champs supportés :
 *  - name: string | null
 *  - email: string (déclenche aussi une revalidation `emailVerified`,
 *    cf. flow Auth.js — on remet à null pour forcer une re-vérification)
 *
 * Note: pour les users qui ont un Account 'credentials', on met aussi
 * à jour `providerAccountId` pour rester cohérent avec le legacy bridge.
 */

import { denyIfImpersonated, denyUnlessRecentAuth, PREUVE_COMPTE_S } from '@/lib/auth/recent-auth';
import { issueEmailProof } from '@/lib/auth/email-proof';
import { normaliserEmail } from '@/lib/auth/email-normalize';
import { writeAuditLog } from '@/lib/admin/audit-log';
import { prevenirAncienne } from '@/lib/adresses/annulation';
import { direArret, verifierApps } from '@/lib/adresses/garde';
import { pushUserToApps } from '@/lib/identity/push-user';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireUser } from '@/lib/auth/get-user';
import { prisma } from '@/lib/prisma';

const bodySchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    // D6 : forme canonique (espaces, minuscules) avant contrôle de doublon et écriture.
    email: z.string().transform(normaliserEmail).pipe(z.string().email()).optional(),
  })
  .refine((d) => d.name !== undefined || d.email !== undefined, {
    message: 'At least one field (name, email) is required',
  });

export async function PATCH(req: Request) {
  let user;
  try {
    user = await requireUser();
  } catch (resp) {
    if (resp instanceof Response) return resp;
    throw resp;
  }

  const json = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid input' },
      { status: 400 },
    );
  }

  const { name, email } = parsed.data;

  // Si email change, on vérifie qu'il n'est pas déjà utilisé
  if (email && email !== user.email) {
    const existing = await prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (existing && existing.id !== user.id) {
      return NextResponse.json(
        { error: 'Email already in use' },
        { status: 409 },
      );
    }
  }

  if (email && email !== user.email) {
    // D5 : une session d'assistance ne change pas l'adresse du client.
    const interdite = await denyIfImpersonated();
    if (interdite) return interdite;
    const denied = await denyUnlessRecentAuth(PREUVE_COMPTE_S);
    if (denied) return denied;
    // Même garde que la promotion (AD-M3) : une app qui désigne encore par l'adresse perdrait son accès, ou en créerait un double.
    const arret = await verifierApps({ hubUserId: user.supabaseUserId, email: user.email });
    if ('refus' in arret) {
      return NextResponse.json({ error: arret.refus, apps: arret.apps, message: direArret(arret) }, { status: arret.refus === 'app_indisponible' ? 503 : 409 });
    }
  }

  const updateData: { name?: string; email?: string; emailVerified?: Date | null } = {};
  if (name !== undefined) updateData.name = name;
  if (email !== undefined && email !== user.email) {
    updateData.email = email;
    updateData.emailVerified = null; // Re-verification needed
  }

  let aliasId: string | null = null;
  if (email && email !== user.email) {
    const ancienne = normaliserEmail(user.email);
    const prouveeLe = (await prisma.user.findUnique({ where: { id: user.id }, select: { emailVerified: true } }))?.emailVerified ?? null;
    try {
      aliasId = await prisma.$transaction(async (tx) => {
        // Elle reprend une adresse qu'elle avait déjà : la ligne secondaire laisse la place.
        await tx.userEmail.updateMany({ where: { userId: user.id, email, detacheeLe: null }, data: { detacheeLe: new Date(), detacheePar: 'reglages' } });
        await tx.user.update({ where: { id: user.id }, data: updateData });
        await tx.account.updateMany({ where: { userId: user.id, provider: 'credentials' }, data: { providerAccountId: email } });
        if (!prouveeLe) return null;
        // Même filet que la promotion (AD-M3) : l'ancienne, prouvée, reste à elle et peut annuler 72 h.
        return (await tx.userEmail.create({ data: { userId: user.id, email: ancienne, preuve: 'principale', prouveeLe }, select: { id: true } })).id;
      });
    } catch (err) {
      if ((err as { code?: string }).code !== 'P2002') throw err;
      return NextResponse.json({ error: 'Email already in use' }, { status: 409 });
    }
  } else {
    await prisma.user.update({ where: { id: user.id }, data: updateData });
  }

  // Sans cette trace, on ne savait pas dire si ce geste avait déjà servi (25/11). Ni l'ancienne ni la nouvelle adresse au journal.
  if (email && email !== user.email) {
    if (aliasId) {
      await prevenirAncienne(prisma, { userId: user.id, ancienne: normaliserEmail(user.email), aliasId }).catch((err) => console.error('[account/profile] avis à l\'ancienne adresse', err instanceof Error ? err.message.slice(0, 160) : 'erreur'));
    }
    await writeAuditLog(prisma, { action: 'adresse.changee', actor: `user:${user.id}`, targetType: 'user', targetId: user.id });
  }

  // Une nouvelle adresse reçoit son lien de preuve et n'atteint les apps qu'une fois
  // prouvée (cf. app/api/auth/email-proof/confirm/route.ts). Le nom part tout de suite.
  if (email && email !== user.email) {
    void issueEmailProof(prisma, { id: user.id, email }).catch((err) => {
      console.error('[account/profile] email proof failed (non-blocking):', err);
    });
  }
  if (name !== undefined && user.supabaseUserId) {
    void pushUserToApps({ hubUserId: user.supabaseUserId, name }).catch(() => undefined);
  }

  return NextResponse.json({ ok: true });
}
