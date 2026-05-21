# [HUB] Trial state machine — 5 mails → 2j attente → 15j Pro → downgrade

> **Type** : Business logic Hub — state machine cross-app
> **Sévérité** : 🔴 P1 — bloque le funnel d'acquisition (trial intelligent
> = différenciateur business clé vs concurrents qui balancent trial au
> signup)
> **Owner** : agent Hub
> **Créé** : 2026-05-21
> **Demandeur** : Robert (décision business + archi 2026-05-21)
> **Dépendances** :
> - Notifuse `2026-05-21-trial-eligible-signal.md` (émet le signal "5 mails")
> - Hub `2026-05-21-stripe-webhook-orchestrator.md` (orchestre les
>   `update-plan` vers les apps)

---

## Vision business

Pas de trial offert au signup (= attire les spammeurs et curieux qui
disparaissent). Le trial Pro 15j ne démarre que pour les **users
prouvés actifs** :

1. User signup sur `app.veridian.site` → état initial : **free** (sans
   trial)
2. User envoie 5 mails dans Notifuse (= signal d'engagement) →
   Notifuse émet webhook `tenant.activity_threshold_reached`
3. Hub reçoit le webhook → démarre un **timer de 2 jours d'attente**
4. 48h plus tard → Hub active le **trial Pro 15j** sur le tenant
   Notifuse (= `POST notifuse/update-plan plan=pro`)
5. 15 jours plus tard → Hub vérifie :
   - Si Stripe customer a une CB valide + subscription active →
     reste en Pro (passe en facturation réelle)
   - Si pas de CB → downgrade Free (= `POST notifuse/update-plan plan=free`)

Pourquoi 2j d'attente après le seuil ? **Pas paraître désespéré**.
"Trial!! Trial!!" dès la 1ère session = spam. 2j de cooldown laisse le
user se familiariser, puis l'offre arrive comme une récompense d'engagement.

---

## Périmètre

### Hub fait
- Recevoir le webhook `tenant.activity_threshold_reached` (de Notifuse)
- État machine : `eligible → waiting → trial → trial_ending → expired`
- Cron tick (~1×/heure) pour faire avancer les états
- Appeler `update-plan` sur l'app correspondante aux transitions
- Notification email/Telegram à Robert : "X trial activé sur tenant Y"
  (visibilité business)

### Hub ne fait pas
- ❌ Détecter l'activité (5 mails) → Notifuse (cf. son ticket)
- ❌ Décider du seuil (5 mails) → constante dans Notifuse, exposée via
  webhook
- ❌ UI bandeau "trial Pro 12j restants" → console Notifuse via
  `/api/limits`

### Apps font
- Émettre le signal "seuil atteint" (Notifuse: 5 mails. Prospection: à
  définir. Analytics: à définir. CMS: pas applicable peut-être)
- Exposer `/api/limits` enrichi pour que la console affiche le bandeau
  trial

---

## State machine

```
[free, no_trial_yet]
    │  (webhook tenant.activity_threshold_reached reçu)
    ▼
[eligible, started_at=NOW]
    │  (cron tick si NOW - started_at >= 48h)
    ▼
[trial_active, trial_started_at=NOW, plan=pro]
    │  ── (Hub appelle notifuse/update-plan plan=pro plan_source=stripe_trial)
    │  ── (Hub envoie email/notification au user "Trial démarré!")
    │
    │  (cron tick si NOW - trial_started_at >= 12d et pas de CB)
    ▼
[trial_ending_soon, notified=true]
    │  ── (email/notif "trial expire dans 3j, ajoute CB pour continuer")
    │
    │  (cron tick si NOW - trial_started_at >= 15d)
    ▼
[trial_expired, plan=free]
    │  ── (Hub appelle notifuse/update-plan plan=free plan_source=stripe)
    │  ── (Hub envoie email "trial fini, voici les data de ton activité")
```

Transitions parallèles :
- À tout moment, user upgrade Stripe → quitte la state machine →
  `plan_source=stripe`, plus de trial logic
- À tout moment, Robert peut grant manuellement (skill grant-unlimited)
  → quitte la state machine

---

## Livrables

### 1. Migration Hub — table tenant_trial_state

```sql
CREATE TABLE IF NOT EXISTS hub_app.tenant_trials (
  tenant_id       TEXT NOT NULL,                  -- workspace_id app
  app             TEXT NOT NULL,                  -- "notifuse" | "prospection" | ...
  state           TEXT NOT NULL,                  -- "eligible" | "trial_active" | "expired"
  eligible_at     TIMESTAMP WITH TIME ZONE,       -- moment du webhook activity_threshold
  trial_started_at TIMESTAMP WITH TIME ZONE,      -- NULL tant que pas démarré
  trial_ends_at   TIMESTAMP WITH TIME ZONE,       -- trial_started_at + 15j
  ending_soon_notified BOOLEAN DEFAULT FALSE,     -- email "trial dans 3j" déjà envoyé ?
  expired_at      TIMESTAMP WITH TIME ZONE,       -- date du downgrade effectif
  created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  PRIMARY KEY (tenant_id, app)
);

CREATE INDEX idx_tenant_trials_state ON hub_app.tenant_trials(state);
CREATE INDEX idx_tenant_trials_trial_ends_at ON hub_app.tenant_trials(trial_ends_at)
  WHERE state = 'trial_active';
```

### 2. Endpoint webhook receiver

`POST /api/webhooks/tenant-activity` — reçoit les webhooks des apps
downstream. Auth HMAC (chaque app a son secret).

```typescript
// Body attendu (cf. format ContractHub)
{
  "event_id": "uuid",
  "event_type": "tenant.activity_threshold_reached",
  "tenant_id": "client42",
  "data": {
    "emails_sent_lifetime": 5,
    "threshold": 5,
    "reached_at": "2026-05-21T09:14:23Z"
  }
}
```

Action : INSERT/UPDATE dans `tenant_trials` avec state=`eligible`,
`eligible_at=NOW`. Idempotent sur `(tenant_id, app)`.

### 3. Cron tick (toutes les 30 min)

```typescript
// 1. Trouver les eligible depuis ≥48h → activer trial
const toActivate = await db.query(`
  SELECT * FROM tenant_trials
  WHERE state = 'eligible' AND eligible_at <= NOW() - INTERVAL '2 days'
`)
for (const trial of toActivate) {
  await notifuseAPI.updatePlan(trial.tenant_id, { plan: 'pro', plan_source: 'stripe_trial' })
  await db.update(`UPDATE tenant_trials SET state='trial_active', trial_started_at=NOW(), trial_ends_at=NOW() + INTERVAL '15 days', updated_at=NOW() WHERE tenant_id=$1 AND app=$2`, [...])
  await sendEmail(...trialStartedTemplate)
  await notifyRobert(...telegram)
}

// 2. Trouver les trial_active à 12j → envoyer notif "expire dans 3j"
const toNotify = await db.query(`
  SELECT * FROM tenant_trials
  WHERE state = 'trial_active'
    AND trial_started_at <= NOW() - INTERVAL '12 days'
    AND ending_soon_notified = FALSE
`)
for (const trial of toNotify) {
  await sendEmail(...trialEndingSoonTemplate)
  await db.update(`UPDATE tenant_trials SET ending_soon_notified=TRUE WHERE ...`)
}

// 3. Trouver les trial_active expirés → downgrade
const toExpire = await db.query(`
  SELECT * FROM tenant_trials
  WHERE state = 'trial_active' AND trial_ends_at <= NOW()
`)
for (const trial of toExpire) {
  // Vérifier si Stripe customer a une subscription active → si oui, laisser tel quel
  const hasActiveSub = await stripe.hasActiveSubscription(trial.tenant_id, trial.app)
  if (hasActiveSub) {
    // Pas de downgrade, la subscription Stripe prend le relais
    await db.update(`UPDATE tenant_trials SET state='converted', updated_at=NOW() WHERE ...`)
    continue
  }
  await notifuseAPI.updatePlan(trial.tenant_id, { plan: 'free', plan_source: 'stripe' })
  await db.update(`UPDATE tenant_trials SET state='expired', expired_at=NOW(), updated_at=NOW() WHERE ...`)
  await sendEmail(...trialExpiredTemplate)
}
```

### 4. Exposition de l'état trial dans `/api/limits` (côté apps)

L'app expose dans son endpoint `GET /api/tenants/{id}/limits` (cf. lot
7 Notifuse) un champ optionnel `trial` :

```json
{
  "tenant_id": "client42",
  "plan": "pro",
  "plan_source": "stripe_trial",
  "limits": { ... },
  "trial": {
    "state": "trial_active",
    "trial_started_at": "2026-05-23T10:14:00Z",
    "trial_ends_at": "2026-06-07T10:14:00Z",
    "days_remaining": 12
  }
}
```

**Coté apps** : modif mineure du repo + service pour lire les champs
de la DB Hub (ou via reverse-call Hub /api/tenant-trial-state). À
discuter avec l'agent Hub.

### 5. Templates email

3 emails à créer (skill `notifuse-templates`) :
- `trial-started.mjml` : "Bienvenue dans le trial Pro 15 jours!"
- `trial-ending-soon.mjml` : "Plus que 3 jours sur ton trial — ajoute
  ta CB pour continuer"
- `trial-expired.mjml` : "Trial terminé — voici ton récap d'activité +
  lien d'upgrade"

### 6. Tests

- Webhook signature invalide → 401
- Webhook reçu nouveau → INSERT tenant_trials state=eligible
- Webhook reçu existant (idempotent) → UPDATE updated_at uniquement
- Cron tick eligible <48h → no-op
- Cron tick eligible >=48h → state=trial_active + appel update-plan mocké
- Cron tick trial_active 12j → notif envoyée, ending_soon_notified=true
- Cron tick trial_active 13j (déjà notifié) → no-op
- Cron tick trial_active 15j + pas Stripe sub → downgrade free
- Cron tick trial_active 15j + Stripe sub → state=converted, pas de downgrade
- E2E : webhook → wait 48h (mock time) → cron tick → trial actif

---

## Risques identifiés

1. **Race conditions cron tick** : 2 instances Hub qui tournent peuvent
   activer 2× le même trial. **Mitigation** : transaction PostgreSQL
   avec `SELECT FOR UPDATE SKIP LOCKED` sur la sélection. Ou lock
   Redis sur la queue.

2. **Stripe sub vérification au moment du downgrade** : Stripe API
   peut être down → ne pas downgrader par défaut (safer). **Mitigation** :
   si l'API Stripe foire au check, on garde trial_active 24h de plus
   et on retry.

3. **Notifuse down au moment de l'appel `update-plan`** : retry + alert
   Telegram si > 3 retries. Le trial_state reste `eligible` ou `trial_active`
   en attendant.

4. **Limites trial cross-app** : un user peut-il avoir 1 trial Notifuse
   ET 1 trial Prospection en même temps ? Recommandation : **oui** —
   trial par app, pas par user. Mais bien tracer pour pas paraître
   abusif si user "active" tous les SaaS en même temps.

---

## Décisions à figer

1. **Période d'attente** : 2 jours après le webhook (proposition Robert).
   À confirmer figé.
2. **Durée trial** : 15 jours (proposition Robert). À confirmer figé.
3. **Seuil d'activité par app** : Notifuse=5 mails. À définir pour
   Prospection (5 leads scrapés?), Analytics, CMS.
4. **Re-trial possible ?** : Si trial expiré + free pendant 6 mois +
   nouveau seuil atteint = nouveau trial ? Recommandation : non
   (1 trial par tenant lifetime). À confirmer.
5. **Email/notif sender** : envoyer via Notifuse (méta!) ou via Brevo
   directement depuis Hub ? Brevo plus simple côté Hub.

---

## Status

- [ ] Décisions figées (2j/15j/5mails/re-trial/sender)
- [ ] Migration Hub `tenant_trials`
- [ ] Endpoint webhook receiver
- [ ] Cron tick
- [ ] Templates email Veridian
- [ ] Tests unit + intégration
- [ ] Doc CONTRAT-HUB nouvelle section "Trial state machine"
- [ ] Curl live test E2E sur staging
