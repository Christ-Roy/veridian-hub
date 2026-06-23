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

import { timingSafeEqual } from 'node:crypto';

export type RateLimitResult =
  | { ok: true; remaining: number; resetAt: number }
  | { ok: false; remaining: 0; resetAt: number; retryAfterSeconds: number };

/** Fréquence du GC amorti des clés mortes (1 balayage toutes les N requêtes). */
const GC_EVERY = 256;

export class RateLimiter {
  private hits: Map<string, number[]> = new Map();
  /** Compteur d'ops depuis le dernier GC des clés expirées (cf enforce). */
  private opsSinceGc = 0;

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

    // GC AMORTI des clés mortes : sans ça, la Map accumule 1 clé par IP unique
    // À VIE (même une IP qui a fait 1 requête il y a 1h garde sa clé avec un
    // tableau vide) → leak mémoire OOM lent sur les endpoints publics qui voient
    // passer des milliers d'IP. On ne purge PAS à chaque appel (coût O(N) sous
    // charge) mais une fois toutes les GC_EVERY requêtes : amorti et borné.
    if (++this.opsSinceGc >= GC_EVERY) {
      this.opsSinceGc = 0;
      // Array.from : le tsconfig Hub cible ES5 → pas d'itération directe sur Map
      // (sinon "can only be iterated with --downlevelIteration / target es2015+").
      for (const [k, hits] of Array.from(this.hits)) {
        if (hits.length === 0 || hits[hits.length - 1] <= windowStart) {
          this.hits.delete(k);
        }
      }
    }

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

  /**
   * Variante avec bypass E2E intégré.
   *
   * Si les headers portent le header `x-veridian-e2e-bypass-ratelimit`
   * valide ET qu'on est hors prod (DEPLOY_ENV !== 'prod'), on retourne
   * `{ok:true, bypassed:true}` SANS incrémenter le compteur — la requête
   * passe gratuitement.
   *
   * Sinon délègue à `enforce(key)` (comportement normal).
   *
   * Audit log : émet un unique warn `[ratelimit-bypass]` côté process
   * pour chaque bypass utilisé (observabilité staging + détection prod
   * hypothétique — même si déjà bloquée par le garde-fou DEPLOY_ENV).
   * Pas de log spam : un seul warn par requête bypassée.
   *
   * Utilisation typique côté route :
   * ```ts
   * const rate = signupLimiter.enforceWithBypass(ip, request.headers);
   * if (!rate.ok) return tooManyResponse(rate.retryAfterSeconds);
   * ```
   */
  enforceWithBypass(
    key: string,
    headers: Headers,
    now: number = Date.now(),
  ): RateLimitResult & { bypassed?: boolean } {
    if (shouldBypassRateLimit(headers)) {
      // Audit observabilité — un seul warn par requête bypassée.
      console.warn(
        JSON.stringify({
          tag: '[ratelimit-bypass]',
          level: 'warn',
          limiter: this.options.name,
          key,
          deploy_env: process.env.DEPLOY_ENV ?? 'unset',
          ts: new Date(now).toISOString(),
        }),
      );
      return {
        ok: true,
        remaining: this.options.capacity,
        resetAt: now + this.options.windowMs,
        bypassed: true,
      };
    }
    return this.enforce(key, now);
  }

  /** Utilitaire tests : vide le storage. */
  reset() {
    this.hits.clear();
  }

  /**
   * Compte d'entrées trackées dans la Map. Grâce au GC amorti (cf enforce),
   * ce nombre reste borné aux IPs actives sur la fenêtre récente (les clés
   * mortes sont purgées toutes les GC_EVERY requêtes) — il ne croît PLUS à
   * l'infini avec le nombre d'IPs uniques vues depuis le boot.
   */
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

/**
 * Bypass rate-limit pour les tests E2E staging — STRICTEMENT staging.
 *
 * Contexte : derrière Traefik staging, `x-forwarded-for` est réécrit par
 * le proxy, donc toutes les requêtes E2E partagent le même bucket IP côté
 * Hub. La suite `e2e/staging-full` enchaîne 60+ appels admin sur quelques
 * minutes → `adminApiLimiter` (30/min/IP) se cap silencieusement et les
 * setups suivants tombent en 429 cascade.
 *
 * Solution : un header `x-veridian-e2e-bypass-ratelimit` portant un secret
 * long (>= 32 chars), comparé timing-safe à `E2E_RATELIMIT_BYPASS_SECRET`,
 * et accepté UNIQUEMENT quand `DEPLOY_ENV !== 'prod'`.
 *
 * Triple garde-fou anti-fuite prod :
 *   1. Gate ENV stricte : `DEPLOY_ENV !== 'prod'` (DEPLOY_ENV, jamais
 *      NODE_ENV — cf. memory feedback_node_env_vs_deploy_env). En prod
 *      le bypass est totalement court-circuité, peu importe le header.
 *   2. Secret obligatoire ET ≥ 32 chars (sinon configuration trop faible,
 *      on refuse plutôt que de laisser un bypass-presque-vide passer).
 *   3. Comparaison timing-safe (`crypto.timingSafeEqual`) — pas de `===`
 *      naïf qui leak la longueur du secret via timing.
 *
 * Audit : retourne `true` si bypass valide. L'appelant logge l'usage.
 */
export function shouldBypassRateLimit(headers: Headers): boolean {
  // Garde-fou 1 : DEPLOY_ENV. Variable fiable, pas NODE_ENV (qui vaut
  // 'production' même sur le build staging Next.js).
  if (process.env.DEPLOY_ENV === 'prod') return false;

  const secret = process.env.E2E_RATELIMIT_BYPASS_SECRET;
  // Garde-fou 2 : secret configuré ET assez long.
  if (!secret || secret.length < 32) return false;

  const provided = headers.get('x-veridian-e2e-bypass-ratelimit');
  if (!provided) return false;

  // Garde-fou 3 : comparaison timing-safe. timingSafeEqual exige des
  // Buffers de même longueur — sinon throw. On normalise en alignant
  // sur la longueur du secret stocké.
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  if (a.length !== b.length) {
    // Normalise quand même le timing en faisant un compare dummy.
    try {
      timingSafeEqual(b, Buffer.alloc(b.length));
    } catch {
      /* noop */
    }
    return false;
  }
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
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

// Poll endpoint GET /api/tenants/[tenantId]/billing-state — réconciliation
// CONTRAT-BILLING §6.3. Une app downstream câble un cron lent (~1×/jour par
// tenant), mais on tolère un poll plus fréquent (jusqu'à 60/min/secret) pour
// permettre des batches de réconciliation initiale après reset cache ou
// migration. Clé = app HMAC (pas IP) car le caller est une app server-side
// trustée derrière le HMAC ; un même secret = un même rate bucket.
export const billingStatePollLimiter = new RateLimiter({
  capacity: 60,
  windowMs: 60_000,
  name: 'billing-state-poll',
});

// Rate-limit sur GET /api/users/by-email (Discovery cross-app).
// Brief ticket "30 req/min/secret" — un secret = une app downstream. Une
// app downstream appelle au login user → quelques req/min en steady-state,
// peak max ~10/min pendant un onboarding batch. 30/min/clé est généreux
// pour le pattern, étouffant pour un bot qui scrute des emails.
//
// IMPORTANT : la clé d'enforcement est composite `${app}:${ip}` après
// vérification HMAC. Avant HMAC, on rate-limit par IP seule pour ne pas
// laisser un attaquant épuiser le quota d'une app légitime en variant le
// header `x-veridian-app` (qui n'est pas authentifié avant HMAC valide).
//
// On utilise donc DEUX limiters distincts pour éviter le bypass :
//   - `discoveryPreVerifyLimiter` : 60/min/IP, frein anti-flood avant
//     d'engager le coût CPU/DB du HMAC + lookup.
//   - `discoveryAppLimiter` : 30/min/app (clé = nom app HMAC-vérifié),
//     plafond contractuel par secret comme demandé par le brief.
export const discoveryPreVerifyLimiter = new RateLimiter({
  capacity: 60,
  windowMs: 60_000,
  name: 'discovery-pre-verify',
});

export const discoveryAppLimiter = new RateLimiter({
  capacity: 30,
  windowMs: 60_000,
  name: 'discovery-app',
});

// Rate-limit Mail Gateway v1 (`POST /api/mail/send-as-user`).
// Gmail standard = 250 mails/jour/user, 2000 si Workspace. On veut empêcher
// une app downstream compromise de griller le quota d'un user en quelques
// minutes (= ban du user côté Google, pas juste un 429 court).
//
// Cap conservateur : 5 mails/min/(app + user) en steady-state. Pour
// reprendre un batch (campagne outreach Prospection qui envoie 50 mails
// en burst), l'app downstream doit étaler dans le temps OU implémenter
// son propre throttling côté worker. Volontairement strict — la couche
// Hub ne sait pas distinguer un envoi légitime d'un envoi anormal, donc
// on cap court et on laisse l'app implémenter la logique métier.
//
// Clé d'enforcement = `${app}:${userId}` (post-HMAC). Avant HMAC on
// rate-limit par IP via un limiter générique (anti-flood broker).
export const mailSendAsUserPreVerifyLimiter = new RateLimiter({
  capacity: 60,
  windowMs: 60_000,
  name: 'mail-send-pre-verify',
});

export const mailSendAsUserLimiter = new RateLimiter({
  capacity: 5,
  windowMs: 60_000,
  name: 'mail-send-as-user',
});
