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
 * Priorités :
 * - 1.0 : Homepage (maximum)
 * - 0.8-0.9 : Pages importantes (pricing, docs)
 * - 0.5 : Pages secondaires (legal)
 */
export const dynamic = 'force-dynamic';

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = getURL();
  const currentDate = new Date();

  return [
    // Pages principales
    {
      url: baseUrl,
      lastModified: currentDate,
      changeFrequency: 'weekly',
      priority: 1,
    },
    {
      url: `${baseUrl}/pricing`,
      lastModified: currentDate,
      changeFrequency: 'weekly',
      priority: 0.9,
    },
    {
      url: `${baseUrl}/docs`,
      lastModified: currentDate,
      changeFrequency: 'weekly',
      priority: 0.8,
    },
    // Note: /legal exclu du sitemap (économie de budget crawl, page sans valeur SEO)
  ];
}
