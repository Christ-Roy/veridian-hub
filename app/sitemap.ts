import { MetadataRoute } from 'next';
import { getURL } from '@/utils/helpers';

/**
 * SITEMAP.XML - Généré dynamiquement
 *
 * Liste toutes les pages publiques à indexer par Google
 *
 * Utilise getURL() pour récupérer le domaine depuis NEXT_PUBLIC_SITE_URL
 *
 * Pour ajouter une page :
 * - Ajoutez une entrée dans le tableau avec url, lastModifiedDate, changeFrequency
 *
 * Priorités :
 * - 1.0 : Homepage (maximum)
 * - 0.8-0.9 : Pages importantes (pricing, docs)
 * - 0.5 : Pages secondaires (legal)
 */
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
