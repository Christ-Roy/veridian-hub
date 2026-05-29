import { MetadataRoute } from 'next';
import { getURL } from '@/utils/helpers';

/**
 * ROBOTS.TXT - Instructions pour les crawlers (Google, Bing, etc.)
 *
 * `force-dynamic` OBLIGATOIRE : même piège que sitemap.ts. Sans ça, le
 * fichier est pré-généré au build avec NEXT_PUBLIC_SITE_URL absent →
 * `Sitemap: http://localhost:3000/sitemap.xml` en prod. Cf. app/sitemap.ts
 * pour le détail du raisonnement.
 */
export const dynamic = 'force-dynamic';

export default function robots(): MetadataRoute.Robots {
  const baseUrl = getURL();

  return {
    rules: [
      {
        userAgent: '*', // Tous les crawlers
        allow: [
          // Seules pages publiques du Hub : les pages légales. Le reste du
          // marketing vit sur veridian.site.
          '/legal',
          '/privacy',
          '/terms',
        ],
        disallow: [
          // Tunnel de checkout (noindex) + zones privées + pages qui
          // redirigent vers veridian.site.
          '/pricing',
          '/dashboard/',
          '/api/',
          '/auth/',
          '/login',
          '/signup',
        ],
      },
    ],
    sitemap: `${baseUrl}/sitemap.xml`,
  };
}
