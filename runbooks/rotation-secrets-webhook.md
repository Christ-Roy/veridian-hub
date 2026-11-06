# Rotation d'un secret de webhook sans coupure

> Procédure de référence. Elle existe parce qu'une rotation sèche a déjà coupé
> la production Veridian : les consommateurs n'avaient pas été prouvés avant le
> changement de valeur.

## Le principe

Un secret partagé entre un émetteur et un récepteur ne change **jamais** de
façon atomique. Il y a toujours un intervalle où l'un des deux porte encore
l'ancienne valeur. Si le récepteur n'accepte qu'une valeur, cet intervalle est
une coupure.

La parade est de rendre le récepteur tolérant pendant la bascule :

```
<NOM>            valeur COURANTE   — celle que les émetteurs doivent porter
<NOM>_PREVIOUS   valeur HÉRITÉE    — acceptée en plus, à retirer après bascule
```

Implémentation : `lib/webhooks/secret-rotation.ts`. Couvre les deux schémas
d'authentification du Hub — le Bearer v1.4 (`lib/webhooks/receiver.ts`) et le
HMAC hérité (`app/api/webhooks/notifuse/route.ts`).

## Ce qui rend la bascule MESURABLE

Chaque requête authentifiée émet une ligne à préfixe stable :

```
[webhook-auth] app=<app> channel=<v14-bearer|legacy-hmac> key=<current|previous|none> outcome=<accepted|rejected>
```

- `key=previous` → **un émetteur porte encore l'ancien secret**. La fenêtre doit
  rester ouverte. C'est un WARN, volontairement bruyant.
- `key=current` → cet émetteur a basculé.
- `key=none` → refus.

Le champ ne révèle jamais la valeur, seulement laquelle des deux a servi.

Lecture :

```bash
# Loki
obs logs hub --since 24h | grep '\[webhook-auth\]'
# ou directement sur l'alloc
nomad alloc logs -stderr <alloc> hub | grep '\[webhook-auth\]'
```

## ⚠️ Le trafic webhook Veridian est CLAIRSEMÉ

Constat du 2026-08-27 : quelques dizaines d'événements sur trois mois, plusieurs
jours entre deux. **Attendre du trafic organique ne prouve rien** — une absence
de `key=previous` peut simplement vouloir dire qu'aucun webhook n'est parti.

> Une absence de trace n'est pas une absence de problème.

Il faut donc **provoquer** le trafic depuis l'émetteur réel, avec sa
configuration réellement déployée. Voir §4.

## La procédure

### 0. Prouver les consommateurs — avant de toucher à quoi que ce soit

Ne pas se fier à une liste écrite : elle est fausse en quelques semaines.
Les quatre mesures à refaire :

```bash
# a. La valeur déployée dans le control-plane
nomad var get -out=json nomad/jobs/<app> | jq -r '.Items | keys[]'

# b. La valeur réellement présente sur les nœuds (par EMPREINTE, jamais en clair)
#    cf. la méthode du balayage dans secrets-migration/INVENTAIRE.md
# c. Les secrets CI
gh secret list -R Christ-Roy/<repo>
# d. Le code émetteur : quel canal utilise-t-il vraiment ?
```

Le point (d) est celui qu'on saute et qu'on paie : en 2026-08 le fork Notifuse
n'émettait que par le HMAC hérité, alors que le Hub portait aussi un Bearer v1.4
que **personne n'émettait**. Deux secrets, un seul canal réel.

### 1. Déployer la double acceptation — sans changer aucune valeur

Poser `<NOM>_PREVIOUS` vide et déployer le code de tolérance. Aucun changement
de comportement. Vérifier que le trafic passe toujours et que le log apparaît
avec `key=current`.

C'est la **ligne de base**. Sans elle, on ne saura pas distinguer « personne
n'utilise l'ancien secret » de « personne n'émet ».

### 2. Ouvrir la fenêtre côté RÉCEPTEUR d'abord

```
<NOM>_PREVIOUS = ancienne valeur
<NOM>          = nouvelle valeur
```

Déployer le Hub. À cet instant les deux valeurs sont acceptées.

**L'ordre n'est pas négociable.** Basculer un émetteur avant que le récepteur
tolère la nouvelle valeur produit des 401 immédiats.

### 3. Basculer les ÉMETTEURS, un par un

Pour chacun : poser la nouvelle valeur, redéployer, puis passer à §4 avant de
faire le suivant. Ne pas basculer en lot — on perd la capacité d'attribuer un
échec à un émetteur précis.

Ne pas oublier les émetteurs non évidents : le staging (qui peut partager la
valeur de prod), les secrets GitHub Actions, les fichiers d'environnement
résiduels d'une infra décommissionnée.

### 4. PROUVER que l'émetteur a basculé — en provoquant le trafic

Ne pas attendre. Déclencher un vrai événement depuis l'émetteur réel, puis
exiger le log correspondant :

```bash
# Notifuse (HMAC hérité) : provoquer un email.sent réel
notifuse transactional send --workspace <slug> ...
# Prospection (Bearer v1.4) : provoquer un event sortant
# puis, côté Hub :
nomad alloc logs -stderr <alloc> hub | grep '\[webhook-auth\]' | tail
```

Attendu : `key=current`. Tant que `key=previous` apparaît, la fenêtre reste
ouverte — c'est le comportement voulu, pas un échec.

Vérifier aussi l'effet métier (une row dans `hub_app.webhook_dedup` ou
`hub_app.prospect_events`), pas seulement un 200 : un 200 prouve
l'authentification, pas le traitement.

### 5. Fermer la fenêtre — et PROUVER le refus

Ne retirer `<NOM>_PREVIOUS` qu'après une période sans aucun `key=previous`
**couvrant du trafic réellement observé**.

Puis **provoquer le refus** : rejouer une requête signée avec l'ancienne valeur
et exiger un 401.

```bash
# Attendu : HTTP 401
```

> Un dispositif de sécurité qu'on n'a jamais vu se déclencher doit être
> considéré comme non fonctionnel jusqu'à preuve du contraire.

Tant que ce 401 n'a pas été observé, la rotation n'est **pas** terminée : le
secret publié reste peut-être utilisable.

### 6. Ranger

- Nouvelle valeur dans `~/credentials/.all-creds.env`, section d'origine conservée.
- Retirer la valeur héritée du control-plane et des nœuds.
- Purger les copies résiduelles (compose d'infra décommissionnée, `.env.bak-*`).
- Si le secret a fuité dans un dépôt public : la rotation est la remédiation.
  Réécrire l'historique git ne retire rien de ce qui a déjà été cloné ou indexé,
  et c'est destructif — cela se décide avec Robert, ce n'est pas un prérequis.

## Garde-fou

`scripts/ci/check-no-secrets.sh` refuse tout secret en clair dans un fichier
tracké (CI + pre-push). Son autotest `check-no-secrets.selftest.sh` rejoue la
forme exacte de la fuite du 2026-05-21 et **exige que le contrôle la refuse** —
sans quoi le garde-fou n'est qu'une décoration.
