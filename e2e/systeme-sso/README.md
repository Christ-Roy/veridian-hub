# Batterie système SSO : le Hub est-il la source unique des utilisateurs ?

Playwright dans un vrai Chromium, contre la **prod** (Prospection, Notifuse, Rybbit/Analytics ; Twenty sur son
staging s'il est servi). Une commande :

```bash
pnpm test:systeme          # ou : bash scripts/test-systeme-sso.sh [filtre, ex. 05-]
```

Sortie : `0` tout passe · `1` au moins un ÉCHOUE · `2` au moins un NON ABOUTI.
Résultat lisible dans `e2e/systeme-sso/.run/resultat.txt` et `.json`.

## Les états

| État | Sens |
|---|---|
| ✅ PASSE | la condition est vraie, mesurée dans le navigateur |
| ❌ ÉCHOUE | une assertion est fausse sur une app dont le correctif EST servi |
| ⚪ NON ABOUTI | on n'a pas pu mesurer (compte non créé, API muette, Twenty non servi, témoin positif absent) |
| 🟡 ATTENDU ROUGE | échoue sur une image listée dans `avant` : **version servie** (relue par `nomad job inspect`) sans encore le correctif ; n'interrompt rien, affiche la version |

Le classement est dans `lib/cibles.ts` (`SERVI`) : seule une image listée dans `avant` rend un échec « attendu rouge », et toute autre version est stricte. Forcer : `SSO_APPS_CORRIGEES=notifuse,analytics`.

## Les cas

| Fichier | Ce qu'il prouve |
|---|---|
| `00-controle-echec` | chaque assertion, présentée fausse, **tombe** (et tient quand elle est vraie) |
| `00-reference` | dérives `hub reconcile` héritées, relevées avant tout compte |
| `01-arrivee` | compte à adresse prouvée : session à son e-mail et identifiant Hub, ses données |
| `02-sans-preuve` | inscription publique non confirmée : n'entre pas, aucun lien émis (témoin positif exigé) |
| `02-preuve-mail` | page du lien de preuve rendue dans un navigateur, bouton cliqué, jeton faux refusé |
| `03-liens-morts` | lien consommé / inconnu / expiré (`SSO_EXPIRY=0` ignore l expiration (TTL 10 min)) |
| `04-rebond` | session Hub ouverte : rebond sans saisie, deux fois de suite |
| `05-plan` | plan posé au Hub relu dans l'app, dans les deux sens |
| `05-synchro-identite` | nom et email changés au Hub, relus dans chaque app par `GET /api/hub/users` (§3.8) |
| `06-reconcile` | aucune dérive nouvelle, et aucun de nos comptes cité par l'audit d'identité |
| `07-isolation` | A ne voit rien de B ni d'un autre tenant (B = présence qui rend l'absence probante) |
| `08-session-longue` | session Hub : app ouverte sans saisie ; sans session : connexion ; jeton expiré refusé ; cookie d'un an ; iframe refusée ; déconnexion partout et compte supprimé : plus aucun accès |
| `99-nettoyage` | suppression des comptes de test, vérifiée au Hub et dans reconcile |

## Comptes de test

Adresses `e2e-sso-<run>-<a|b|np>@veridian.site`, nom « TEST SYSTEME SSO … », créés par le chemin réel
(invitation → mot de passe → session Hub). **Aucun mail ne part** (`sendEmail: false`), jamais de compte client.
Chaque compte est noté dans `.run/comptes.jsonl` *avant* usage ; `99-nettoyage` et le `global-teardown` ne
suppriment **que** ceux-là, par `delete-tenant` (qui propage aux apps) + suppression du workspace Notifuse.

## Limites connues

- Rybbit n'a jamais été vu **vert** dans cette batterie tant que son correctif n'est pas servi : le chemin positif du
  cas Analytics est écrit mais non éprouvé.
- Plan Analytics/Twenty : le Hub n'en pose pas, cas NON ABOUTI.
- Twenty : tant que le staging n'est pas servi, NON ABOUTI ; le parcours Twenty reste à écrire.
- Le secret admin vient de `ADMIN_SECRET` ou du fichier de credentials de la machine ; il n'est jamais écrit ni affiché.
