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

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireUser } from '@/lib/auth/get-user';
import { prisma } from '@/lib/prisma';

const bodySchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    email: z.string().email().optional(),
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

  const updateData: { name?: string; email?: string; emailVerified?: Date | null } = {};
  if (name !== undefined) updateData.name = name;
  if (email !== undefined && email !== user.email) {
    updateData.email = email;
    updateData.emailVerified = null; // Re-verification needed
  }

  await prisma.user.update({
    where: { id: user.id },
    data: updateData,
  });

  // Si email change, on update aussi le providerAccountId du compte credentials
  if (email && email !== user.email) {
    await prisma.account
      .updateMany({
        where: { userId: user.id, provider: 'credentials' },
        data: { providerAccountId: email },
      })
      .catch(() => { /* non bloquant */ });
  }

  return NextResponse.json({ ok: true });
}
