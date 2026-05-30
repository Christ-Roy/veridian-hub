# Flow OAuth Gmail cassé : le client ne revient jamais dans l'app downstream (Notifuse)

> **Sévérité** : 🟡 P1
> **Owner** : agent veridian-hub
> **Créé** : 2026-05-30
> **Demandé par** : agent notifuse-veridian (Robert)

## Contexte (pourquoi ce ticket)

Notifuse (Veridian Mail) propose au client de connecter son Gmail pour
envoyer ses mails. Le bouton "Connect Gmail" de Notifuse redirige vers le
Hub (modèle OAuth centralisé : 1 seul consent screen / 1 seul audit Google /
1 seul stockage de refresh tokens, réutilisé par toutes les apps — design
voulu et correct).

**Problème vécu** : le client connecte son Gmail, mais **ne revient jamais
dans Notifuse**. Il reste bloqué sur le dashboard Hub, paumé. Le flow de
rebond `Notifuse → Hub (consent) → retour Notifuse` est cassé.

## Diagnostic précis (déjà fait, le fix est chirurgical)

Notifuse envoie le client sur :

```
https://app.veridian.site/dashboard/settings/mail?return=<url_notifuse>&add=1&provider=google
```

(cf. `notifuse-veridian/console/src/components/settings/veridian_mail_account_settings.tsx`
lignes 78-88, fonction `buildHubConnectUrl`)

**Le backend OAuth Hub gère DÉJÀ tout le rebond — rien à coder côté API :**

- `app/api/gmail/connect/route.ts` : lit `?return=`, le valide (anti
  open-redirect : doit commencer par `/`), le stocke dans `RETURN_COOKIE`. ✅
- `app/api/gmail/connect/callback/route.ts` : lit `RETURN_COOKIE`, et via
  `buildReturnRedirect()` redirige vers `<return>?mail_status=connected`
  après consent. ✅

**Le SEUL maillon cassé : la page UI ne propage pas `return` jusqu'au lien.**

Dans `app/dashboard/settings/mail/page.tsx` :
- La signature ne lit que `searchParams: { status?: string }` — elle
  **ignore** `return`, `add`, `provider`.

Dans `app/dashboard/settings/mail/MailSenderActions.tsx` :
- Les liens sont codés en dur `<a href="/api/gmail/connect">` **sans
  query string**. Donc `?return=` n'est jamais transmis à
  `/api/gmail/connect` → `RETURN_COOKIE` posé vide → le callback retombe
  sur le fallback `/dashboard/settings/mail` au lieu de rebondir vers
  Notifuse.

## Demande (fix côté Hub uniquement — ~30 lignes, 2 fichiers)

1. **`page.tsx`** : lire `return` (et optionnellement `provider`) depuis
   `searchParams`. Re-valider `return` côté serveur (commence par `https://`
   ET host dans une allowlist des domaines apps Veridian :
   `notifuse.app.veridian.site`, `prospection.app.veridian.site`, etc. —
   PAS juste `startsWith('/')` car ici c'est une URL absolue cross-domain,
   pas un path relatif comme dans `connect/route.ts`).

   ⚠️ **Attention** : `connect/route.ts` valide aujourd'hui un `return`
   **relatif** (`startsWith('/')`). Mais Notifuse envoie une **URL absolue**
   (`https://notifuse.app.veridian.site/...`). Il faut donc soit :
   - (a) que Notifuse envoie un path relatif (impossible : c'est un autre
     domaine), soit
   - (b) que le Hub accepte les URL absolues cross-domain avec **allowlist
     stricte de domaines** dans `connect/route.ts` ET `callback/route.ts`
     (`buildReturnRedirect`).

   → **Option (b) obligatoire.** Adapter la validation `safeReturn` dans
   `connect/route.ts` et `buildReturnRedirect` dans `callback/route.ts` pour
   accepter une URL absolue dont le host ∈ allowlist apps Veridian.

2. **`MailSenderActions.tsx`** : propager `return`/`provider` dans le href :
   `<a href={`/api/gmail/connect?return=${encodeURIComponent(returnUrl)}`}>`.
   Passer `returnUrl` en prop depuis `page.tsx`.

3. **Décision produit à trancher : mono vs multi-compte.**
   La page Hub est conçue **mono-compte** (`accounts.find(...)` → 1 seul
   `linkedAccount` Gmail). Mais l'UI Notifuse promet du **multi-compte**
   ("Connect **another** Gmail account", badge "Default", liste de comptes,
   proxy `GET /api/veridian/mail-accounts/me` qui retourne un tableau).
   → Soit le Hub passe en multi-compte (plus de taf), soit Notifuse
   s'aligne sur mono-compte (réduire son UI). À arbitrer avec Robert.
   **Le fix du rebond (points 1-2) est indépendant et prioritaire** —
   il débloque déjà le cas mono-compte.

## Impact côté Notifuse (ce qui dépend de ce fix)

- La page de retour `notifuse.app.veridian.site/console/workspace/{id}/settings/mail-account`
  attend le rebond avec `?mail_status=connected`. Tant que le Hub ne rebondit
  pas, la feature "envoyer ses mails via son Gmail" est **inutilisable de bout
  en bout** côté Notifuse (le client connecte mais Notifuse ne voit jamais le
  retour, donc l'UX est cassée).
- Notifuse ne touche à rien côté code pour ce fix : le rebond est 100 % Hub.
  Une fois le Hub corrigé, vérifier juste que `?mail_status=connected` est
  bien lu côté Notifuse (déjà prévu dans le composant).

## Test de validation (à faire après fix)

1. Depuis Notifuse, cliquer "Connect Gmail" → atterrir sur Hub consent.
2. Consentir chez Google.
3. **Vérifier le rebond automatique** vers
   `notifuse.app.veridian.site/.../mail-account?mail_status=connected`.
4. Vérifier le cas refus consent → rebond avec `?mail_status=denied`.
5. Vérifier qu'un `return` vers un domaine HORS allowlist est rejeté
   (sécurité open-redirect) → fallback `/dashboard/settings/mail`.
