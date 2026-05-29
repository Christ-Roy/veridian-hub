import { MetadataRoute } from 'next';
import { getURL } from '@/utils/helpers';

/**
 * SITEMAP.XML - Généré dynamiquement à chaque requête.
 *
 * `force-dynamic` est OBLIGATOIRE : sans ça, Next.js pré-génère le sitemap
 * au moment du `pnpm build` en CI, où NEXT_PUBLIC_SITE_URL n'est pas
 * disponible (pas de build-arg côté Dockerfile, cf. choix d'archi
 * "une seule image pour tous les envs"). Résultat : sitemap pointe vers
 * http://localhost:3000 en prod = catastrophe SEO (Google indexe rien).
 *
 * Le coût d'un rendu dynamique est négligeable (sitemap rarement crawlé,
 * pas de DB call, juste lecture de `process.env.NEXT_PUBLIC_SITE_URL`).
 *
 * Périmètre : le Hub n'est PAS une vitrine — le marketing vit sur
 * `veridian.site`. Le sitemap ne liste donc QUE les pages légales (exigées
 * indexables par Google pour la brand verification OAuth + Stripe). La home
 * et /docs redirigent (301) vers veridian.site, /pricing est un tunnel de
 * checkout en noindex : aucune ne figure ici.
 */
export const dynamic = 'force-dynamic';

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = getURL();
  const currentDate = new Date();

  return [
    {
      url: `${baseUrl}/privacy`,
      lastModified: currentDate,
      changeFrequency: 'monthly',
      priority: 0.5,
    },
    {
      url: `${baseUrl}/terms`,
      lastModified: currentDate,
      changeFrequency: 'monthly',
      priority: 0.5,
    },
    {
      url: `${baseUrl}/legal`,
      lastModified: currentDate,
      changeFrequency: 'yearly',
      priority: 0.4,
    },
  ];
}
