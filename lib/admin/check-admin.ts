/**
 * Administrateur de plateforme : des PERSONNES, désignées par leur hub_user_id (`PLATFORM_ADMINS`), jamais par une adresse (VER-263). Une adresse se tape à
 * l'inscription : la session s'ouvre avant qu'elle soit prouvée, et la liste d'adresses était lisible dans ce dépôt public. La personne se lit en base à chaque
 * fois : compte vivant, adresse prouvée, session à elle (ni empruntée, ni ouverte par le fournisseur d'une organisation). Réglage vide : personne.
 */
import { prisma } from '@/lib/prisma';

type SessionLue = { user?: { id?: string; federe?: boolean; impersonated?: boolean } | null } | null | undefined;
const liste = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

export const isPlatformAdminId = (hubUserId: string | null | undefined): boolean => !!hubUserId && liste(process.env.PLATFORM_ADMINS).includes(hubUserId.toLowerCase());

export async function isPlatformAdmin(session: SessionLue): Promise<boolean> {
  const s = session?.user;
  if (!s?.id || s.federe === true || s.impersonated === true) return false;
  try {
    const u = await prisma.user.findUnique({ where: { id: s.id }, select: { supabaseUserId: true, emailVerified: true } });
    return !!u?.emailVerified && isPlatformAdminId(u.supabaseUserId);
  } catch (err) {
    console.error('[admin] identité illisible', err instanceof Error ? err.message.slice(0, 160) : 'erreur');
    return false;
  }
}

/** Pour un RAPPORT seulement (qui est l'opérateur dans un espace client) : n'ouvre aucun droit. */
export const estAdresseOperateur = (email: string): boolean => liste(process.env.ADRESSES_OPERATEUR).includes(email.trim().toLowerCase());
