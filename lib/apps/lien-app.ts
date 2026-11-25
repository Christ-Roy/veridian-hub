/** L'app ouverte par le rebond signé du Hub (jamais un jeton gardé, VER-106). `null` : l'app n'est pas branchée ici. */
const ADRESSES: Record<string, (e: NodeJS.ProcessEnv) => string | undefined> = {
  crm: (e) => e.CRM_API_URL,
  notifuse: (e) => (e.NOTIFUSE_API_URL ? `${e.NOTIFUSE_API_URL.replace(/\/+$/, '')}/console` : undefined),
  prospection: (e) => e.NEXT_PUBLIC_PROSPECTION_URL,
  academy: (e) => e.ACADEMY_API_URL,
};

export function lienApp(cle: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const base = ADRESSES[cle]?.(env);
  return base ? `/login?next=${encodeURIComponent(`${base.replace(/\/+$/, '')}/`)}` : null;
}
