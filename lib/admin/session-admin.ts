/**
 * La session courante administre-t-elle la plateforme ? Une seule lecture pour les routes, les pages et l'emprunt : identité relue en base, jamais une
 * session d'emprunt, jamais une session fédérée, connexion réelle de moins de 24 h.
 */
import { auth } from '@/auth';
import { administrateurDe, type Administrateur } from '@/lib/admin/check-admin';
import { isImpersonatedSession } from '@/lib/auth/impersonation';
import { isAuthRecent, PREUVE_COMPTE_S } from '@/lib/auth/recent-auth';

export type SessionAdmin = ({ ok: true } & Administrateur) | { ok: false; raison: 'non_connecte' | 'emprunt' | 'pas_admin' | 'preuve_ancienne' };

export async function sessionAdmin(): Promise<SessionAdmin> {
  const session = await auth();
  if (!session?.user) return { ok: false, raison: 'non_connecte' };
  // Emprunter le compte d'un administrateur ne rend pas administrateur.
  if (isImpersonatedSession(session)) return { ok: false, raison: 'emprunt' };
  const a = await administrateurDe(session);
  if (!a) return { ok: false, raison: 'pas_admin' };
  if (!isAuthRecent(session.user.authAt, PREUVE_COMPTE_S)) return { ok: false, raison: 'preuve_ancienne' };
  return { ok: true, ...a };
}
