// POST /api/auth/signup — création d'un user + Account credentials.
//
// Auth.js v5 ne fournit pas de signup natif pour CredentialsProvider, donc on
// gère la création nous-mêmes :
// 1. Hash bcrypt du password
// 2. Création User + Account (provider='credentials', access_token=hash)
// 3. supabaseUserId = randomUUID() pour cohérence avec les users migrés
//    (ces ID servent de pont vers tenants.user_id et subscriptions.user_id qui
//    sont en UUID).
// 4. Provisioning tenants (async, non bloquant — préserve la logique métier
//    Supabase pré-migration).
//
// Le client (SignupForm) appellera ensuite signIn('credentials', ...) pour
// créer la session JWT Auth.js.

import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';

import { prisma } from '@/lib/prisma';
import { provisionTenants } from '@/utils/tenants/provision';

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export async function POST(request: NextRequest) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = signupSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid email or password (min 8 chars)' },
      { status: 400 }
    );
  }

  const { email, password } = parsed.data;
  const normalizedEmail = email.toLowerCase().trim();

  // Vérifier qu'on ne crée pas un doublon
  const existing = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    select: { id: true },
  });

  if (existing) {
    return NextResponse.json(
      { error: 'An account with this email already exists' },
      { status: 409 }
    );
  }

  const passwordHash = await bcrypt.hash(password, 10);
  // UUID stringifié — sert de pont vers tenants.user_id (UUID) /
  // subscriptions.user_id (UUID). Pour les users migrés c'est l'ID Supabase
  // originel ; pour les nouveaux c'est un UUID v4 frais.
  const userUuid = randomUUID();

  try {
    const user = await prisma.user.create({
      data: {
        id: userUuid,
        email: normalizedEmail,
        supabaseUserId: userUuid,
        accounts: {
          create: {
            type: 'credentials',
            provider: 'credentials',
            providerAccountId: normalizedEmail,
            access_token: passwordHash,
          },
        },
      },
      select: { id: true, email: true },
    });

    // Provisioning Twenty + Notifuse + Prospection en background.
    // Note : on passe le password en clair car le provisioning crée des
    // comptes downstream (Twenty admin, Notifuse user) qui ont besoin du mdp.
    // Pas de await — on ne veut pas bloquer la réponse.
    provisionTenants(user.email, password, user.id).catch((err) => {
      console.error('[Signup] Tenant provisioning failed:', err);
    });

    return NextResponse.json({ id: user.id, email: user.email }, { status: 201 });
  } catch (err: any) {
    console.error('[Signup] Failed to create user:', err);
    return NextResponse.json(
      { error: 'Failed to create account' },
      { status: 500 }
    );
  }
}
