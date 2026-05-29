# [HUB] Intégrer CRM dans la state machine trial v1.5

> **Sévérité** : 🟡 P1
> **Owner** : agent veridian-hub
> **Créé** : 2026-05-27
> **Refs** :
> - Roadmap UX premium audit `/tmp/audit-crm-needs-2026-05-27.md` §F.1
> - Sprint Hub v1.4 closed 2026-05-21 (cf memory `project_sprint_v14_complete_2026-05-21.md`)
> - State machine existante : `lib/billing/trial-state-machine.ts` (ou équivalent), `TenantTrial` model

## Contexte

La state machine trial Hub v1.5 (livrée sprint v1.4) orchestre le flow
5 mails → 2j silence → 15j visible → +30j paywall pour les apps
Notifuse et Prospection. Elle s'appuie sur :

- Model Prisma `TenantTrial` (ou colonnes `trial_*` dans `Tenant`)
- Cron `/api/cron/trial-tick` qui scanne les trials et déclenche les events
- Dispatcher Stripe `lib/stripe/dispatcher.ts` qui réagit aux events
- Templates email Notifuse

**Problème** : `crm_tenants` est une table **séparée** (cf décision
ticket route-admin), donc le cron `/api/cron/trial-tick` actuel **ne la
scanne pas**. Conséquence : un user en trial CRM ne reçoit aucun email,
pas de bascule auto vers paywall à J+15, pas de tracking lifecycle.

Ce ticket étend la state machine pour inclure les CRM tenants.

## Action attendue

### 1. Étendre le cron trial-tick

`app/api/cron/trial-tick/route.ts` (ou équivalent) doit aussi scanner
`crm_tenants` :

```typescript
// Trials Notifuse/Prospection (existant)
const tenantTrials = await prisma.tenant.findMany({
  where: { trialEndsAt: { not: null }, status: 'active' },
  ...
});

// 🆕 Trials CRM
const crmTrials = await prisma.crmTenant.findMany({
  where: { trialEndsAt: { not: null }, status: 'active' },
  ...
});

for (const tenant of [...tenantTrials, ...crmTrials]) {
  await processTrialTick(tenant);
}
```

### 2. Adapter le processeur

`processTrialTick` doit savoir si c'est un Notifuse/Prospection
(`Tenant`) ou un CRM (`CrmTenant`) et router en conséquence :

```typescript
async function processTrialTick(tenant: Tenant | CrmTenant) {
  const isCrm = 'twentyWorkspaceId' in tenant;
  const daysUntilEnd = differenceInDays(tenant.trialEndsAt, new Date());

  // Mail J-10 (rappel doux)
  if (daysUntilEnd === 5 && !alreadySent(tenant, 'trial_d10')) {
    await sendTrialMail(tenant, 'trial-ending-soon', { app: isCrm ? 'crm' : detectApp(tenant) });
    await markSent(tenant, 'trial_d10');
  }

  // Mail J-13 (urgence)
  if (daysUntilEnd === 2 && !alreadySent(tenant, 'trial_d13')) {
    await sendTrialMail(tenant, 'trial-add-card', { app: isCrm ? 'crm' : detectApp(tenant) });
    await markSent(tenant, 'trial_d13');
  }

  // Mail J0 (trial ended)
  if (daysUntilEnd <= 0 && !alreadySent(tenant, 'trial_ended')) {
    await sendTrialMail(tenant, 'trial-ended', { app: isCrm ? 'crm' : detectApp(tenant) });
    await markSent(tenant, 'trial_ended');

    // Soft suspend CRM tenant (pas de purge data, juste block magic link)
    if (isCrm) {
      await prisma.crmTenant.update({
        where: { id: tenant.id },
        data: { status: 'trial_expired' },
      });
    }
  }
}
```

### 3. Nouveau statut `trial_expired` côté `crm_tenants`

Ajouter la valeur `'trial_expired'` à la colonne `status` (déjà TEXT,
pas d'enum constrainte). Convention :

| Status | Magic link possible | Description |
|---|---|---|
| `active` | ✅ | Trial actif ou plan payant en cours |
| `trial_expired` | ❌ | Trial fini, pas de CB, paywall doux |
| `suspended` | ❌ | Stripe past_due ou suspension admin |
| `deleted` | ❌ | Soft delete (data restée Twenty) |

La route `POST /api/admin/crm/tenants/[id]/magic-link` doit refuser tout
status autre que `active` avec 403 + message "Réactivez votre abonnement
pour accéder à votre CRM".

### 4. Templates email à créer

Dans `lib/email/templates/` :

- `crm-trial-ending-soon.html` (J-5) : "Plus que 5 jours d'essai
  Veridian CRM. Découvrez vos data déjà importées."
- `crm-trial-add-card.html` (J-2) : "Plus que 2 jours. Ajoutez votre CB
  pour continuer sans interruption."
- `crm-trial-ended.html` (J0) : "Votre essai est terminé. Choisissez un
  plan pour récupérer l'accès."

Tous via Notifuse transactionnel (pattern existant).

### 5. Lien upgrade dans emails

Chaque email contient un CTA `Réactiver mon CRM` qui pointe vers :

```
https://app.veridian.site/upgrade?plan=crm-pro&from=trial-email
```

Page upgrade gère le checkout Stripe → webhook orchestrator → status
`active` + magic link regénéré dans email confirmation.

### 6. Notifications cross-app dans la state machine

Si l'user a déjà un trial Notifuse/Prospection actif **ET** trial CRM,
**éviter le spam d'emails** : grouper en un seul mail digest "Vos
essais Veridian se terminent" plutôt que 3 mails séparés.

Logique : au moment d'envoyer un mail trial, check si un autre trial du
même user a déjà déclenché un email dans les dernières 24h → si oui,
fusionner en un seul email multi-app.

(Optionnel vague 4 si trop complexe — première itération : 1 mail par
trial, OK quitte à spammer.)

### 7. Reactivation flow

Quand un user en `trial_expired` paye via Stripe Checkout :
- Webhook `checkout.session.completed` → orchestrator détecte
  `metadata.app === 'crm'` → update `crm_tenants.status = 'active'`,
  `plan = <new plan>`, `trial_ends_at = NULL`
- Email confirmation "Votre CRM Veridian est réactivé" avec magic link

## Tests / DoD

- [ ] Test unitaire `processTrialTick` :
  - `CrmTenant` trial J-5 → mail `crm-trial-ending-soon` envoyé
  - `CrmTenant` trial J-2 → mail `crm-trial-add-card` envoyé
  - `CrmTenant` trial J0 → mail `crm-trial-ended` envoyé + status passé à `trial_expired`
  - Pas de double envoi si déjà sent (`already_sent` check)
- [ ] Test route magic-link CRM :
  - Tenant `trial_expired` → 403 avec message clair
  - Tenant `active` → magic link OK
- [ ] Test reactivation :
  - Webhook Stripe `checkout.session.completed` avec metadata crm → status `active`
- [ ] Test cron schedule :
  - Le scan `crmTenants` est bien ajouté au cron horaire (mock cron run)
- [ ] Mock email send (pas d'envoi réel pendant CI)
- [ ] Templates email rendent correctement (snapshot test HTML)
- [ ] **Bombe temporelle** : tests utilisent `vi.useFakeTimers()` (cf memory `feedback_bombes_temporelles_tests`)

## Non-objectifs

- ❌ Email digest cross-app (vague 4 si premiers tests montrent spam)
- ❌ A/B test des copies email (vague 5+)
- ❌ Push notifications (vague 6+)
- ❌ Modifier le mécanisme trial Notifuse/Prospection (juste l'étendre à CRM)
- ❌ Hard delete des tenants `trial_expired` (vague 4+, runbook séparé)
