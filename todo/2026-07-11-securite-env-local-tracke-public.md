# 🔴 SÉCU — `.env.local` tracké dans le repo Hub PUBLIC

> **Sévérité** : 🔴 P0 (credential DB en clair, repo public)
> **Owner** : agent veridian-hub
> **Créé** : 2026-07-11
> **Signalé par** : agent veridian-prospection (sweep sécu suite au C2 prospection)

## Constat

`veridian-hub/.env.local` est **tracké par git** dans le repo `Christ-Roy/veridian-hub`
qui est **PUBLIC**. Il contient au moins :

```
.env.local:3 : DATABASE_URL=postgresql://<user>:<password>@localhost:5433/veridian_core?schema=hub_app
```

Le host est `localhost` (donc pas exploitable à distance directement), mais :
- un credential DB en clair dans un repo public reste une fuite (réutilisation
  possible du mot de passe ailleurs, historique indexable) ;
- `.env.local` ne doit JAMAIS être versionné (convention Next.js : gitignore).

## À faire (agent Hub)

1. `git rm --cached .env.local` + l'ajouter au `.gitignore` (vérifier qu'il n'y
   est pas déjà — s'il y est mais reste tracké, c'est un `git rm --cached` oublié).
2. Vérifier si le password `veridian_core` de ce fichier est réutilisé en prod
   (staging/prod DATABASE_URL). Si oui → **rotation** + MAJ des conscommateurs.
3. Purge d'historique (BFG / git-filter-repo) sur ce fichier + force-push
   (coordonner : repo public, CI, autres agents).
4. Stocker les vrais creds dans `~/credentials/.all-creds.env` (pas dans le repo).
5. Vérifier le `scripts/ci/check-secrets.sh` / Trivy : pourquoi ce fichier n'a
   pas été bloqué au commit ? Durcir le garde-fou (pattern `.env.local` tracké).

## Contexte

Découvert pendant la remédiation du C2 prospection (password DB prod prospection
hardcodé dans `open-data/scripts/enrich-api-gouv.py`, corrigé côté prospection le
2026-07-11). Le sweep des 4 repos publics (prospection/hub/analytics/cms) a
remonté ce `.env.local` Hub comme seconde exposition notable. Les findings
analytics/cms étaient des creds CI/test sur localhost (éphémères, faible sévérité).
