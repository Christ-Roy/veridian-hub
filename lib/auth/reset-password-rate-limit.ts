/**
 * Rate-limiters de `POST /auth/reset_password`.
 *
 * Ces instances vivaient d'abord dans le fichier de la route, mais Next.js
 * interdit à un `route.ts` d'exporter autre chose que ses handlers et quelques
 * clés de config : le type généré dans `.next/types` échoue alors avec
 * « does not satisfy the constraint '{ [x: string]: never; }' » et le build de
 * prod casse (`ignoreBuildErrors: false`). D'où ce module dédié — les tests ont
 * besoin de `.reset()` sur les instances, donc elles doivent rester exportables
 * depuis quelque part.
 *
 * Elles ne sont pas dans `lib/auth/rate-limit.ts` (qui porte les limiters
 * partagés) parce qu'elles ne servent qu'à cette route.
 */

import { RateLimiter } from '@/lib/auth/rate-limit';

// Plafond par IP sur la DEMANDE de reset. Fenêtre longue (15 min) volontaire :
// un plafond à la minute ne gêne pas un attaquant qui lisse son débit, alors
// que le coût réel (mail envoyé) se mesure à l'heure. 5/15 min laisse un humain
// se rater plusieurs fois — y compris un client en première connexion (cette
// route sert aussi de flow « je n'ai jamais eu de mot de passe »).
export const resetRequestIpLimiter = new RateLimiter({
  capacity: 5,
  windowMs: 15 * 60_000,
  name: 'reset-password-request-ip',
});

// Plafond par EMAIL VISÉ. Indispensable : le mail-bombing d'une victime précise
// passe sous n'importe quel plafond purement IP dès que l'attaquant tourne
// (proxies, botnet). Ici la clé est la cible, pas la source → l'attaquant a
// beau changer d'IP, la boîte de la victime ne reçoit pas plus de 4 mails/h.
// 4/h reste large pour un légitime : le lien vaut 1 h, redemander plus de 4
// fois dans l'heure n'a aucun sens fonctionnel.
//
// Anti-énumération : ce limiter est appliqué AVANT le lookup user, donc il
// compte pareil pour un email inexistant. Un 429 ne dit jamais « ce compte
// existe », seulement « cet email a déjà été demandé récemment ».
export const resetRequestEmailLimiter = new RateLimiter({
  capacity: 4,
  windowMs: 60 * 60_000,
  name: 'reset-password-request-email',
});

// Plafond par IP sur la CONSOMMATION du token. Le token fait 32 bytes (~10^77),
// le brute-force est hors de portée, mais on plafonne le scan (bruit de logs +
// coût bcrypt par tentative). 10/min laisse un humain corriger sa saisie.
export const resetConsumeLimiter = new RateLimiter({
  capacity: 10,
  windowMs: 60_000,
  name: 'reset-password-consume',
});
