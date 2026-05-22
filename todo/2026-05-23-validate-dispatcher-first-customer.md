# [HUB] Stripe — valider la chaîne dispatcher Hub→Notifuse au 1er paiement réel

> **Type** : Validation manuelle one-shot, monitoring ciblé
> **Sévérité** : 🟢 P2 — non-bloquant, opportuniste (à faire AU MOMENT du 1er paiement réel)
> **Owner** : agent Hub
> **Créé** : 2026-05-23
> **Réfère** : `docs/CONTRAT-BILLING.md` §8 (chaîne Stripe → Hub → apps),
>   `utils/stripe/prisma-sync.ts` (dispatcher),
>   suite de la validation `2026-05-22-stripe-dashboard-prerequis.md` (clos)

---

## 0. POURQUOI ce ticket

Le **2026-05-22**, validation finale Stripe LIVE bouclée en Option C :

- ✅ webhook secret LIVE matche (SHA256 byte-exact local ↔ Dokploy)
- ✅ endpoint Stripe `we_1SoQtORgvfRggzUNLjNlih83` enabled, 12 event types
- ✅ 18+ events Live processed sans erreur depuis le deploy v0.5.61
- ✅ signature constructEvent validée à chaque hit (sinon log `signature verification failed`)
- ✅ persistence idempotente DB `hub_app.stripe_events` confirmée
- ✅ dispatcher invoqué, fail-safe quand customer Stripe ne matche aucun User Hub

**Ce qui RESTE à observer en réel** : la chaîne **`update-plan` HMAC Hub → Notifuse**
qui ne s'exécute que quand un VRAI client signup Hub → checkout → paiement
réussi. En CI E2E on a déjà la couverture (specs 09/12 avec stripe-mock côté
staging), mais le branchement live entre Hub prod et Notifuse prod n'a jamais
servi 1 vrai event de bout en bout.

Risque résiduel = minime (dispatcher idempotent, fail-open conforme contrat,
testé en CI). La validation finale se fait naturellement **au 1er checkout
client réel**, qu'il faut juste monitorer.

---

## 1. CE QU'IL FAUT FAIRE

**Au moment du 1er paiement réel** (ou simulé sur compte preprod si on veut
forcer la validation avant un vrai client) :

### 1.1 Tail des logs Hub prod en direct
```bash
ssh prod-pub
docker logs -f compose-back-up-online-pixel-nl2k9p-hub-1 \
  | grep -iE 'webhook|stripe-sync|stripe-dispatch|HMAC update-plan'
```

### 1.2 Séquence de logs attendue (chemin nominal)

```
[webhook] checkout.session.completed (id=evt_...) env=PRODUCTION
[webhook] checkout.session.completed (id=evt_...) outcome=processed persistedNow=true
[webhook] customer.subscription.created (id=evt_...) env=PRODUCTION
[stripe-sync] Tenant <tenant_uuid> updated: notifuse=<plan>, prospection=<plan> (planKey=<KEY>, isActive=true, immune=false)
[stripe-sync] HMAC update-plan OK notifuse tenant=<tenant_uuid> plan=<plan>
[webhook] customer.subscription.created outcome=processed persistedNow=true
```

**Signes de réussite** :
- `[stripe-sync] HMAC update-plan OK notifuse tenant=... plan=...` apparaît
- `outcome=processed` (pas `failed`)
- En DB Hub : `tenant.notifusePlan` reflète le plan acheté
- En DB Notifuse : workspace correspondant a `plan=<plan>` mis à jour

**Signes d'échec à investiguer immédiatement** :
- `[stripe-sync] HMAC update-plan KO notifuse tenant=... : <message>`
  → HMAC secret désaligné, ou Notifuse en panne, ou tenant slug invalide
- `[stripe-dispatch] customer.subscription.created failed: Cannot resolve UUID for customer ...`
  → user_uuid metadata absent du checkout, OU stripe_customer_id pas en DB Hub
- `targetNotifuse "..." non reconnu côté Notifuse, propagation HMAC skip`
  → catalogue cross-app désynchronisé

### 1.3 Vérification post-paiement (DB)

```sql
-- Côté Hub : event persisté + processed + tenant à jour
SELECT event_id, event_type, processed_at, attempts, error
FROM hub_app.stripe_events
ORDER BY received_at DESC LIMIT 5;

SELECT id, "userId", "notifusePlan", "notifuseWorkspaceSlug"
FROM hub_app.tenants
WHERE "userId" = '<user_uuid_du_client>';
```

```sql
-- Côté Notifuse : workspace existe et plan correspond
-- (à exécuter via container Notifuse, voir runbook Notifuse)
```

---

## 2. CHAMP DE BATAILLE — issues annexes signalées le 2026-05-22

Ces 2 issues ont été identifiées pendant la validation et méritent leur
propre ticket si elles ne sont pas déjà couvertes :

### 2.1 TELEGRAM ENV manquant en prod Hub (P1)
Pendant le test, le dispatcher a tenté d'alerter Robert via Telegram mais a
silencieusement skip :
```
[telegram] TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_ID manquant — alerte ignorée
```
→ Si un futur paiement client casse le dispatcher, Robert ne sera pas alerté.
Ajouter `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` au compose Dokploy Hub
prod. **Voir `todo/2026-05-22-oauth-alerting-telegram.md`** — peut-être déjà
couvert, sinon élargir le scope du ticket à dispatcher Stripe.

### 2.2 Sub legacy past_due — Price ID inconnu du catalogue v3 (P2)
La sub `sub_1TUtgWRgvfRggzUNC5OjqiuU` (client legacy past_due) pointe sur
le Price `price_1SvGFYRgvfRggzUNMoGboHCU` qui n'est plus dans le catalogue
v3. Warning au webhook :
```
[stripe-sync] Unknown stripe_price_id price_1SvGFYRgvfRggzUNMoGboHCU
  for sub sub_1TUtgWRgvfRggzUNC5OjqiuU — add it to the catalogue or
  LEGACY_STRIPE_PRICE_MAPPING in lib/pricing/plans.ts
```
→ Voir ticket dédié `2026-05-23-legacy-stripe-price-mapping.md`.

---

## 3. DEFINITION OF DONE

- [ ] Au 1er paiement client réel : logs Hub observés en live
- [ ] Séquence nominale `[stripe-sync] HMAC update-plan OK notifuse ...` confirmée
- [ ] Pas de `[stripe-sync] HMAC update-plan KO` dans la chaîne
- [ ] DB Hub `tenant.notifusePlan` à jour
- [ ] DB Notifuse workspace `plan` à jour
- [ ] Si KO → ticket d'urgence + remontée Telegram (cf 2.1)

Une fois validé : **ce ticket est archivé `done/`** et le branchement Stripe
Live est officiellement battle-tested en prod.
