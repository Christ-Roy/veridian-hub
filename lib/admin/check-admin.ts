/**
 * La session est-elle celle d'un administrateur de plateforme ? La personne se lit en base à chaque fois : compte vivant, adresse prouvée, session à elle (ni
 * empruntée, ni ouverte par le fournisseur d'une organisation). La liste : `lib/admin/liste-admins.ts`. Base illisible : personne.
 */
import { isPlatformAdminId } from '@/lib/admin/liste-admins';
import { prisma } from '@/lib/prisma';

export { estAdresseOperateur, isPlatformAdminId } from '@/lib/admin/liste-admins';

type SessionLue = { impersonated?: unknown; user?: { id?: string; federe?: boolean; impersonated?: boolean } | null } | null | undefined;
export type Administrateur = { userId: string; hubUserId: string; email: string };

export async function administrateurDe(session: SessionLue): Promise<Administrateur | null> {
  const s = session?.user;
  if (!s?.id || s.federe === true || s.impersonated === true || session?.impersonated === true) return null;
  try {
    const u = await prisma.user.findUnique({ where: { id: s.id }, select: { email: true, supabaseUserId: true, emailVerified: true } });
    return u?.emailVerified && u.supabaseUserId && isPlatformAdminId(u.supabaseUserId) ? { userId: s.id, hubUserId: u.supabaseUserId, email: u.email } : null;
  } catch (err) {
    console.error('[admin] identité illisible', err instanceof Error ? err.message.slice(0, 160) : 'erreur');
    return null;
  }
}

export const isPlatformAdmin = async (session: SessionLue): Promise<boolean> => (await administrateurDe(session)) !== null;
