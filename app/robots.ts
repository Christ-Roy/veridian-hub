import { MetadataRoute } from 'next';
import { getURL } from '@/utils/helpers';

/**
 * ROBOTS.TXT - Instructions pour les crawlers (Google, Bing, etc.)
 *
 * ✅ Autoriser : Pages publiques (marketing, legal, docs)
 * ❌ Bloquer : Dashboard privé, API, auth, webhooks
 *
 * Utilise getURL() pour récupérer le domaine depuis NEXT_PUBLIC_SITE_URL
 */
export default function robots(): MetadataRoute.Robots {
  const baseUrl = getURL();

  return {
    rules: [
      {
        userAgent: '*', // Tous les crawlers
        allow: [
          // Pages publiques autorisées
          '/',
          '/pricing',
          '/docs',
          '/legal',
        ],
        disallow: [
          // Zones privées - Désactivées
          '/dashboard/',
          '/api/',
          '/signin/',
          '/signin1/',
          '/_signin-legacy/',
          '/auth/',
          '/login/',
          '/signup/',
        ],
      },
    ],
    sitemap: `${baseUrl}/sitemap.xml`,
  };
}
