/**
 * Rate limiter in-memory IP-based — fenêtre glissante simple.
 *
 * Cible : routes Auth.js publiques (/api/auth/signin, /api/auth/callback)
 * qui ne peuvent pas reposer sur userId (le user n'est pas encore loggué).
 *
 * Choix d'implé :
 * - In-memory Map (pas Redis). Hub tourne en mono-instance Dokploy →
 *   pas de problème de cohérence. Si on passe multi-instance, basculer
 *   sur Redis avec INCR + EXPIRE (changement de lib transparent côté
 *   appelant grâce à la signature `enforce()`).
 * - Pas de dépendance externe (pas de `@upstash/ratelimit` etc.).
 * - GC à chaque appel : on retire les entrées expirées avant de compter.
 *   Acceptable car la Map reste petite (≤ N IPs uniques actives).
 *
 * Une instance de RateLimiter = une fenêtre + cap + namespace donné.
 * Plusieurs instances cohabitent (signin: 10/min, callback: 30/min).
 */

export type RateLimitResult =
  | { ok: true; remaining: number; resetAt: number }
  | { ok: false; remaining: 0; resetAt: number; retryAfterSeconds: number };

export class RateLimiter {
  private hits: Map<string, number[]> = new Map();

  constructor(
    private readonly options: {
      /** Capacité max sur la fenêtre */
      capacity: number;
      /** Durée de la fenêtre en ms */
      windowMs: number;
      /** Namespace (pour debug logs) */
      name: string;
    }
  ) {
    if (options.capacity <= 0) throw new Error('capacity must be > 0');
    if (options.windowMs <= 0) throw new Error('windowMs must be > 0');
  }

  /**
   * Enregistre un hit pour `key` et retourne si la requête est autorisée.
   * Si non, retourne aussi `retryAfterSeconds` pour le header Retry-After.
   *
   * Important : on incrémente AVANT de tester, donc même les requêtes
   * refusées comptent dans la fenêtre (sinon on pourrait bypasser en
   * spammant — chaque tentative coûte).
   */
  enforce(key: string, now: number = Date.now()): RateLimitResult {
    const windowStart = now - this.options.windowMs;
    const existing = this.hits.get(key) ?? [];
    // GC fenêtre : on garde seulement les hits dans la fenêtre
    const fresh = existing.filter((t) => t > windowStart);
    fresh.push(now);
    this.hits.set(key, fresh);

    const count = fresh.length;
    const oldestHit = fresh[0] ?? now;
    const resetAt = oldestHit + this.options.windowMs;

    if (count > this.options.capacity) {
      return {
        ok: false,
        remaining: 0,
        resetAt,
        retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
      };
    }

    return {
      ok: true,
      remaining: this.options.capacity - count,
      resetAt,
    };
  }

  /** Utilitaire tests : vide le storage. */
  reset() {
    this.hits.clear();
  }

  /** Utilitaire tests : compte d'entrées trackées (≤ IPs uniques actives). */
  size() {
    return this.hits.size;
  }
}

/**
 * Extrait l'IP du caller depuis les headers standards.
 * Priorité : `x-forwarded-for` (Traefik/proxy), `x-real-ip`, fallback `unknown`.
 *
 * On prend la première IP de `x-forwarded-for` (la plus à gauche = client
 * originel, le reste = chaîne de proxies).
 */
export function extractClientIp(headers: Headers): string {
  const xff = headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const realIp = headers.get('x-real-ip');
  if (realIp) return realIp.trim();
  return 'unknown';
}

// ─── Instances partagées pour les routes Auth.js ────────────────────────────
//
// Caps choisis pour ne pas pénaliser les users légitimes :
// - 10 starts/min/IP suffit largement pour un user qui clique "Login with Google"
//   (sauf bot qui spamme le bouton).
// - 30 callbacks/min/IP pour ne pas bloquer les redirects OAuth normaux
//   (un user peut faire 2-3 round-trips à cause d'erreurs UX).

export const oauthStartLimiter = new RateLimiter({
  capacity: 10,
  windowMs: 60_000,
  name: 'oauth-start',
});

export const oauthCallbackLimiter = new RateLimiter({
  capacity: 30,
  windowMs: 60_000,
  name: 'oauth-callback',
});

// Limit anti-brute-force pour les routes admin protégées par x-admin-secret.
// Cap volontairement bas : un usage légitime fait quelques appels/min
// (provisioning d'un client), pas des centaines. Un bot qui brute-force le
// secret 48-chars n'a aucune chance même sans rate-limit (espace ~10^86),
// mais on ajoute la défense en profondeur pour bloquer aussi les attaques
// par dictionnaire et limiter le bruit dans les logs.
export const adminApiLimiter = new RateLimiter({
  capacity: 30,
  windowMs: 60_000,
  name: 'admin-api',
});

// Anti-DoS sur l'endpoint signup public. Sans ça, un attaquant peut créer
// des milliers de users en quelques secondes → pollution DB + spam MX
// (chaque user crédentiels reçoit potentiellement un email bienvenue) +
// stats produit corrompues. 5/min/IP est généreux pour un humain légitime
// (qui ne signup qu'une fois dans sa vie) tout en bloquant les bots.
export const signupLimiter = new RateLimiter({
  capacity: 5,
  windowMs: 60_000,
  name: 'signup',
});

// Anti-brute-force password sur /api/auth/callback/credentials.
// Le wrapper Auth.js callback générique limite déjà à 30/min/IP, mais
// 30 tentatives/min reste exploitable contre des passwords faibles
// (~43k tentatives/jour/IP). On ajoute un limiter dédié plus strict :
// 5 tentatives/min/IP — suffisant pour un humain qui se trompe 2-3 fois,
// très restrictif pour un bot.
//
// Pour aller plus loin (rate-limit par couple IP+email pour empêcher un
// botnet de répartir l'attaque), il faudrait parser le body x-www-form-
// urlencoded avant Auth.js. À faire si attaques observées.
export const credentialsLoginLimiter = new RateLimiter({
  capacity: 5,
  windowMs: 60_000,
  name: 'credentials-login',
});

// Anti-flood sur POST /api/invitations/create (machine-to-machine HMAC).
// Une app downstream légitime ne crée que quelques invitations/min (un humain
// click). Si une app compromise spam le Hub, on plafonne à 60/min/IP — assez
// large pour un onboarding batch légitime, étouffant pour un bot.
// Clé = IP, pas l'app HMAC, parce qu'un attaquant qui contrôle une app
// downstream peut faire varier x-veridian-app pour bypasser un namespace
// per-app.
export const invitationCreateLimiter = new RateLimiter({
  capacity: 60,
  windowMs: 60_000,
  name: 'invitation-create',
});

// Anti brute-force token sur GET /api/invitations/[token]/verify.
// Le token est 32 bytes = 256 bits → brute-force statistiquement impossible
// (~10^77 espace), mais on plafonne quand même à 30/min/IP pour limiter
// le bruit dans les logs et empêcher un attaquant de scanner massivement
// en pariant sur d'éventuelles collisions/devine. Un user humain ne va
// pas appeler /verify plus de quelques fois.
export const invitationVerifyLimiter = new RateLimiter({
  capacity: 30,
  windowMs: 60_000,
  name: 'invitation-verify',
});
