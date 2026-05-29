import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/get-user';
import { resolveMarketingUrl } from '@/lib/marketing-url';

/**
 * HOME `/` — n'est plus une landing page (depuis 2026-05-29).
 *
 * Le marketing est centralisé sur le site vitrine statique `veridian.site`
 * (CF Pages, optimisé SEO). La home du Hub se contente de router :
 *
 *   - user loggué      → `/dashboard` (son espace — un client ne doit JAMAIS
 *                        être éjecté vers le marketing)
 *   - user non-loggué  → URL marketing (page produit SaaS), via
 *                        `resolveMarketingUrl()` configurable par ENV
 *                        `MARKETING_URL`.
 *
 * Le One Tap Google n'est PAS perdu : il vit toujours sur `/login` et
 * `/signup`, et sur la landing veridian.site (cf. docs/CROSS-SUBDOMAIN-LANDING.md).
 *
 * Les composants landing (`components/landing/*`) sont conservés
 * volontairement — retour arrière gratuit si on veut re-héberger une LP ici.
 *
 * `force-dynamic` : la décision dépend de la session courante, jamais de
 * cache statique.
 */
export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const user = await getCurrentUser();

  if (user) {
    redirect('/dashboard');
  }

  // Visiteur non-loggué → site vitrine. `redirect()` vers une URL externe
  // émet un 307 côté serveur (pas de flash de contenu).
  redirect(resolveMarketingUrl());
}
