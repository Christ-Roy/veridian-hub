# [HUB] Telegram — ajouter TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID en prod

> **Type** : Config compose Dokploy Hub prod (ENV manquantes)
> **Sévérité** : 🔴 P1 — alertes silencieuses sur incidents prod
> **Owner** : agent Hub + Robert (rotation token si nécessaire)
> **Créé** : 2026-05-23
> **Réfère** : code émetteur `lib/notifications/telegram.ts` (à confirmer),
>   `utils/stripe/prisma-sync.ts` (consommateur sur dispatcher KO),
>   `compose/prod.yml`

---

## 0. POURQUOI ce ticket

Découvert pendant la validation Stripe LIVE du **2026-05-22** (Option D).
En créant une sub test LIVE puis en observant le dispatcher Hub, j'ai vu
ce log :

```
[stripe-dispatch] customer.subscription.created failed: Cannot resolve UUID
  for customer cus_UZ9tmboPKZ2nl3 — no User found
[telegram] TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_ID manquant — alerte ignorée:
  <b>Stripe webhook dispatcher KO</b>
```

Le dispatcher A TENTÉ d'alerter Robert via Telegram quand son dispatch a
échoué — mais les ENV `TELEGRAM_BOT_TOKEN` et `TELEGRAM_CHAT_ID` ne sont
**pas configurées dans le compose Dokploy Hub prod**, donc l'alerte est
silencieusement skip.

**Impact** :
- Si demain un paiement client réel fait planter le dispatcher (HMAC KO
  vers Notifuse, secret désaligné, Notifuse down, etc.), Robert ne sera
  PAS alerté.
- L'event passera en `outcome=failed` dans `hub_app.stripe_events` mais
  personne ne le verra avant le prochain ticket support client.
- C'est exactement le scénario "silent failure" qu'on a précisément câblé
  Telegram pour éviter.

---

## 1. CE QU'IL FAUT FAIRE

### 1.1 Vérifier l'état actuel du bot Telegram Veridian

```bash
grep -E "^TELEGRAM_" ~/credentials/.all-creds.env
```

Si pas présent → créer un bot via `@BotFather` sur Telegram, récupérer le
token + le chat_id (id de Robert ou d'un groupe alertes Veridian).

### 1.2 Ajouter les 2 ENV au compose Dokploy Hub prod

Via API Dokploy :

```bash
DOKPLOY_API_KEY=$(grep "^DOKPLOY_API_KEY=" ~/credentials/.all-creds.env | cut -d= -f2-)
COMPOSE_ID="_kxAHDCv1LhvsdwNRX3Vk"  # Hub prod

# Lire l'env actuel
curl -sS -H "x-api-key: $DOKPLOY_API_KEY" \
  "https://dokploy.veridian.site/api/compose.one?composeId=$COMPOSE_ID" \
  | jq -r '.env'

# Appendre TELEGRAM_BOT_TOKEN=... et TELEGRAM_CHAT_ID=...
# Puis POST compose.update + compose.deploy
```

### 1.3 Valider que le bot répond

Après deploy, déclencher un dispatcher fail volontaire (curl avec mauvaise
signature → 400 sans alerte ; il faut un dispatcher KO réel, par ex resend
d'un event customer.subscription qui n'a pas de user mappé) et vérifier
qu'on reçoit le message Telegram.

### 1.4 Élargir le scope du bot

Actuellement le seul appelant Telegram identifié = dispatcher Stripe.
Profiter du câblage pour brancher aussi :
- OAuth audit failures (déjà ticket : `2026-05-22-oauth-alerting-telegram.md`)
- HMAC update-plan KO côté apps downstream
- Healthcheck Hub qui passe en `unhealthy`
- Trivy critical/high découvert dans l'image deployed (cron sécurité)

→ Si ce ticket est mergé avec OAuth alerting, fusionner.

---

## 2. PIÈGES ATTENDUS

- **CRLF dans le token** : copier-coller depuis BotFather → vérifier `wc -c`
  du token (devrait être ~46 caractères, pas plus avec \r en fin)
- **chat_id négatif pour un groupe** : si le bot est dans un groupe
  Veridian, le chat_id commence par `-` (pas le user_id de Robert)
- **Rate limit Telegram** : 30 messages/sec global, 1/sec par chat. Si le
  dispatcher boucle en erreur, on peut se faire ratelimiter → ajouter
  debouncing côté code émetteur (out of scope ici, ticket P3 si pas déjà)
- **Pas en clair dans le compose Git** : utiliser le système de secrets
  Dokploy plutôt que de hardcoder en clair dans `compose/prod.yml`

---

## 3. DEFINITION OF DONE

- [ ] `TELEGRAM_BOT_TOKEN` configuré dans compose Dokploy Hub prod
- [ ] `TELEGRAM_CHAT_ID` configuré dans compose Dokploy Hub prod
- [ ] Compose redeployé sans downtime
- [ ] Test fonctionnel : provoquer un dispatcher fail → message reçu par Robert
- [ ] Logs Hub ne contiennent plus `[telegram] ... manquant — alerte ignorée`
- [ ] Documenter la procédure de rotation du token (en cas de leak)
