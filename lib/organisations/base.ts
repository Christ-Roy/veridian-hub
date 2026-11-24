/** Adresse publique du Hub, celle que les apps atteignent (logo). Lue à l'exécution : jamais une `NEXT_PUBLIC_*` figée au build. */
export const hubPublicUrl = (env: NodeJS.ProcessEnv = process.env): string => (env.AUTH_URL || 'https://app.veridian.site').replace(/\/+$/, '');
