/**
 * Runtime Configuration Endpoint
 *
 * Expose les variables d'environnement publiques au runtime.
 *
 * IMPORTANT : Les variables NEXT_PUBLIC_* ne sont PAS accessibles dans process.env
 * côté serveur si elles n'étaient pas définies au build-time. C'est une limitation
 * de Next.js.
 *
 * Solution : On utilise des variables runtime avec le préfixe DASHBOARD_*
 * et on les renomme en NEXT_PUBLIC_* pour le client.
 *
 * Mapping :
 * - DASHBOARD_SITE_URL → NEXT_PUBLIC_SITE_URL
 * - DASHBOARD_SUPABASE_URL → NEXT_PUBLIC_SUPABASE_URL
 * etc.
 *
 * ⚠️ CRITICAL : export const dynamic = 'force-dynamic' est OBLIGATOIRE
 * Sans ça, Next.js optimise cette route comme statique et fige les valeurs à null !
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  // Récupérer depuis les variables d'environnement RUNTIME (préfixe DASHBOARD_)
  // Fallback sur NEXT_PUBLIC_* pour compatibilité avec l'ancien système
  const config = {
    NEXT_PUBLIC_SITE_URL: process.env.DASHBOARD_SITE_URL || process.env.NEXT_PUBLIC_SITE_URL || null,
    NEXT_PUBLIC_SUPABASE_URL: process.env.DASHBOARD_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || null,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.DASHBOARD_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || null,
    NEXT_PUBLIC_TWENTY_URL: process.env.DASHBOARD_TWENTY_URL || process.env.NEXT_PUBLIC_TWENTY_URL || null,
    NEXT_PUBLIC_NOTIFUSE_URL: process.env.DASHBOARD_NOTIFUSE_URL || process.env.NEXT_PUBLIC_NOTIFUSE_URL || null,
    NEXT_PUBLIC_NOTIFUSE_API_URL: process.env.DASHBOARD_NOTIFUSE_API_URL || process.env.NEXT_PUBLIC_NOTIFUSE_API_URL || null,
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: process.env.DASHBOARD_STRIPE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || null,
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY_LIVE: process.env.DASHBOARD_STRIPE_PUBLISHABLE_KEY_LIVE || process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY_LIVE || null,
    NEXT_PUBLIC_GTM_ID: process.env.DASHBOARD_GTM_ID || process.env.NEXT_PUBLIC_GTM_ID || null,
  };

  return Response.json(config, {
    headers: {
      // Cache pendant 5 minutes pour permettre les mises à jour rapides
      'Cache-Control': 'public, max-age=300, stale-while-revalidate=600',
    },
  });
}
