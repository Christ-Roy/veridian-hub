// Helpers d'auth partagés post-migration Auth.js v5.
//
// CONTRAT IMPORTANT — IDs après migration Supabase → Prisma :
//
// - `User.id` (hub_app.users.id) = TEXT, format = stringification de l'UUID
//   Supabase originel (préserve la traçabilité). Pour les nouveaux signups
//   post-migration, c'est un cuid Auth.js standard.
// - `User.supabaseUserId` (hub_app.users.supabase_user_id) = TEXT, c'est le
//   même UUID stringifié — utilisé pour faire le pont avec les tables
//   `tenants`/`subscriptions` qui utilisent `user_id UUID`.
// - `Tenant.userId` (hub_app.tenants.user_id) = UUID, garde l'UUID Supabase
//   originel pour préserver les FK et les références externes (Twenty etc.).
//
// Donc : pour récupérer les tenants d'un user logué Auth.js, on utilise
// `user.supabaseUserId` (cast en UUID dans la query Prisma).

import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';

export type AuthUser = {
  /** ID Auth.js (TEXT). Pour les users migrés = UUID stringifié. */
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  /** UUID stringifié — sert de pont vers tenants.user_id / subscriptions.user_id. */
  supabaseUserId: string | null;
};

/**
 * Récupère le user authentifié + ses infos Prisma. Retourne null si pas de
 * session active. Doit être appelé depuis un Server Component ou route
 * handler Node runtime (pas edge — Prisma n'est pas edge-compatible).
 */
export async function getCurrentUser(): Promise<AuthUser | null> {
  const session = await auth();
  if (!session?.user?.id) return null;

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      id: true,
      email: true,
      name: true,
      image: true,
      supabaseUserId: true,
    },
  });

  return user;
}

/**
 * Variante qui throw 401 si pas de session — pour les routes API qui
 * exigent un user. Utiliser dans les routes /api/* protégées.
 */
export async function requireUser(): Promise<AuthUser> {
  const user = await getCurrentUser();
  if (!user) {
    throw new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return user;
}

/**
 * Helper pour récupérer l'UUID Supabase qui sert de FK vers tenants /
 * subscriptions. Pour la majorité des migrés, c'est égal à `user.id`.
 * Throw si pas de supabaseUserId (cas pathologique pour un user post-migration).
 */
export function userUuid(user: AuthUser): string {
  if (!user.supabaseUserId) {
    throw new Error(
      `User ${user.id} has no supabaseUserId — impossible to query tenants/subscriptions`
    );
  }
  return user.supabaseUserId;
}
