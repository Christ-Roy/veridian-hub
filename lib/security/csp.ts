/**
 * Politique de sécurité du contenu du Hub (VER-265, modèle `securite/CSP-MODELE.md`, relevé sur Academy) : scripts par nonce
 * seulement ('strict-dynamic' laisse passer ce qu'un script nonce charge : GTM), aucun plugin, violations remontées à `/api/csp`
 * (report-uri seul : avec report-to, Chrome retarde ou perd le rapport, mesuré par Prospection le 26/11).
 * Posée d'abord en Report-Only (`CSP_MODE` absent ou `rapport`) ; `CSP_MODE=appliquer` la rend bloquante, après un parcours relu.
 * Pas de `form-action` : Chrome l'applique aux redirections qui suivent un formulaire, et la connexion d'une organisation part vers
 * son propre fournisseur (OIDC ou SAML, adresse propre à chaque client). `frame-ancestors` est dans la politique, par chemin (`ancetres`).
 */
export const CHEMIN_RAPPORT = '/api/csp';

/**
 * Qui peut encadrer la page : le Hub seul, sauf la fenêtre de l'assistant (/ia/chat), qu'affichent les apps (*.app.veridian.site).
 * DANS la CSP : l'en-tête de next.config.js qui le portait a le même nom, et la CSP bloquante le remplaçait (26/11, frame-ancestors
 * disparu de /login et /ia/chat, vu par la sonde d'identité de la CI).
 */
export function ancetres(chemin = '/'): string {
  return chemin === '/ia/chat' ? "frame-ancestors 'self' https://*.app.veridian.site" : "frame-ancestors 'self'";
}

export function politique(nonce: string, dev = process.env.NODE_ENV === 'development', chemin = '/'): string {
  return [
    "default-src 'self'",
    // Le rechargement à chaud du mode développement évalue du code ; la production, jamais.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    // React pose des attributs style qu'aucun nonce ne couvre ; un style ne s'exécute pas.
    // Google One Tap (/login) : sa feuille, son statut et son cadre viennent de accounts.google.com (relevé en Report-Only le 26/11).
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com/gsi/",
    "font-src 'self' data: https://fonts.gstatic.com",
    // Avatars des fournisseurs (Google, Microsoft), pixels de mesure : des images, jamais du code.
    "img-src 'self' data: blob: https:",
    "connect-src 'self' https://accounts.google.com/gsi/ https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com",
    "frame-src 'self' https://accounts.google.com/gsi/ https://*.app.veridian.site https://www.googletagmanager.com https://js.stripe.com",
    "object-src 'none'",
    ancetres(chemin),
    "base-uri 'self'",
    ...(dev ? [] : ['upgrade-insecure-requests']),
    `report-uri ${CHEMIN_RAPPORT}`,
  ].join('; ');
}

/** L'en-tête à poser : bloquant seulement sur `CSP_MODE=appliquer`. */
export function enteteCsp(env: Record<string, string | undefined> = process.env): 'Content-Security-Policy' | 'Content-Security-Policy-Report-Only' {
  return env.CSP_MODE === 'appliquer' ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only';
}

export function nonce(): string {
  const o = new Uint8Array(16);
  crypto.getRandomValues(o);
  return btoa(String.fromCharCode.apply(null, Array.from(o)));
}

export type Violation = { directive: string; bloque: string; page: string; source: string | null };

/** Ce qu'on garde d'un rapport : la directive et l'origine bloquée, jamais la query ni l'extrait de code (il peut porter une donnée). */
export function resumerRapport(brut: unknown): Violation[] {
  const liste = Array.isArray(brut) ? brut : [brut];
  const court = (s: unknown, n = 200) => (typeof s === 'string' ? s.slice(0, n) : '');
  const sansQuery = (u: string) => {
    try {
      const x = new URL(u);
      return `${x.origin}${x.pathname}`;
    } catch {
      return u.split(/[?#]/)[0];
    }
  };
  return liste.slice(0, 20).flatMap((r) => {
    const o = (r as Record<string, unknown>) ?? {};
    // Ancien format (`report-uri`) : { "csp-report": {...} } ; Reporting API : { type: "csp-violation", body: {...} }.
    const c = (o['csp-report'] ?? (o.type === 'csp-violation' ? o.body : null)) as Record<string, unknown> | null;
    if (!c || typeof c !== 'object') return [];
    const directive = court(c['effective-directive'] ?? c.effectiveDirective ?? c['violated-directive'], 80);
    if (!directive) return [];
    const bloque = court(c['blocked-uri'] ?? c.blockedURL);
    const ligne = c['line-number'] ?? c.lineNumber;
    const fichier = c['source-file'] ?? c.sourceFile;
    return [{
      directive,
      bloque: /^(inline|eval|data|blob|self)$/.test(bloque) ? bloque : sansQuery(bloque),
      page: sansQuery(court(c['document-uri'] ?? c.documentURL, 300)),
      source: fichier ? `${sansQuery(court(fichier))}:${ligne ?? '?'}` : null,
    }];
  });
}
