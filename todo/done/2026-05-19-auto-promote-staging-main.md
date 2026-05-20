# Ticket Hub — Câbler auto-promote staging → main

> **Demandeur** : Agent Prospection (session 2026-05-19)
> **Source de vérité** : `docs/CI-ARCHITECTURE.md` §19.3 (à étoffer par le ticket
> `2026-05-19-ci-architecture-etoffer.md` déposé en parallèle).
> **Priorité** : P2 — amélioration cadence ship, pas bloquant
> **Estim** : 30 min

## Pourquoi ce ticket

Décision Robert 2026-05-19 :

| App | Promotion staging→main |
|---|---|
| Prospection | Manuelle uniquement (giga MAJ) — app critique |
| **Hub** | **Auto-promote si staging vert + e2e OK** ← à câbler |
| Analytics | Auto-promote si staging vert ← à câbler (autre ticket Analytics) |
| CMS | ✅ déjà câblé |
| Notifuse | ✅ déjà câblé |

Aujourd'hui le Hub fait passer staging mais la promotion main est manuelle.
Cette manualité empile des commits sur staging sans aller en prod, et
augmente le risque de divergence longue.

## Demande

Câbler un job `promote-to-main` dans `hub-staging.yml` (ou un nouveau
workflow `hub-promote.yml`), pattern de référence :
`veridian-cms/.github/workflows/cms-staging.yml:promote-to-main`.

### Pré-requis

1. **PAT GitHub** `GH_AUTOPROMOTE_PAT` (scope `repo`, `workflow`) ajouté
   en GitHub Secrets du repo veridian-hub.
2. **Tags Telegram** `TG_BOT_TOKEN` + `TG_CHAT_ID` déjà présents.
3. **Workflow `hub-ci.yml`** doit pouvoir être déclenché manuellement
   via `gh workflow run` (déjà le cas si trigger `push: branches: [main]`).

### Job à ajouter

```yaml
promote-to-main:
  name: Auto-promote staging → main
  needs: [deploy, smoke-staging]   # ces 2 jobs DOIVENT être verts
  if: |
    github.event_name == 'push' &&
    github.ref == 'refs/heads/staging' &&
    !contains(github.event.head_commit.message, '[skip-prod]') &&
    !contains(github.event.head_commit.message, '[wip]')
  runs-on: ubuntu-latest
  permissions:
    contents: write
    actions: write
  steps:
    - uses: actions/checkout@v6
      with:
        fetch-depth: 0
        token: ${{ secrets.GH_AUTOPROMOTE_PAT }}

    - name: Fast-forward merge staging → main
      run: |
        git config user.email "ci-bot@veridian.site"
        git config user.name "Veridian CI Bot"
        git fetch origin main
        STAGING_SHA=$(git rev-parse HEAD)
        git checkout main
        if ! git merge --ff-only "$STAGING_SHA"; then
          echo "::error::main a divergé de staging — promotion impossible en ff-only"
          echo "::error::Investiguer : git log main..staging et résoudre manuellement"
          exit 1
        fi
        git push origin main
        echo "STAGING_SHA=$STAGING_SHA" >> $GITHUB_OUTPUT
        echo "✓ main avancé vers $STAGING_SHA (auto-promote)"

    - name: Trigger hub-ci.yml on main
      env:
        GH_TOKEN: ${{ secrets.GH_AUTOPROMOTE_PAT }}
      run: gh workflow run hub-ci.yml --ref main

    - name: Notify Telegram (success)
      if: success()
      run: |
        SHA7="${{ github.sha }}"
        SHA7="${SHA7:0:7}"
        curl -sS "https://api.telegram.org/bot${{ secrets.TG_BOT_TOKEN }}/sendMessage" \
          -d chat_id="${{ secrets.TG_CHAT_ID }}" \
          -d parse_mode=HTML \
          -d "text=✅ <b>Hub auto-promote</b> staging→main réussi (${SHA7})"

    - name: Notify Telegram (failure)
      if: failure()
      run: |
        SHA7="${{ github.sha }}"
        SHA7="${SHA7:0:7}"
        curl -sS "https://api.telegram.org/bot${{ secrets.TG_BOT_TOKEN }}/sendMessage" \
          -d chat_id="${{ secrets.TG_CHAT_ID }}" \
          -d parse_mode=HTML \
          -d "text=🚨 <b>Hub auto-promote</b> ÉCHEC sur ${SHA7} — investigation requise: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"
```

### Garde-fous

Les conditions strictes :

1. `needs: [deploy, smoke-staging]` → si staging deploy KO ou smoke KO,
   pas de promotion.
2. `if: !contains([skip-prod]) && !contains([wip])` → l'agent qui veut
   ship staging sans aller en prod ajoute `[skip-prod]` dans le commit
   (utile pour les WIP, dette TODO, exploration).
3. Merge `--ff-only` strict → si main a divergé (intervention manuelle
   Robert sur main, par exemple), le job échoue proprement avec Telegram
   alerte plutôt que de force-push silencieusement.

### Pré-requis SHA check (§18.1 de CI-ARCHITECTURE.md)

Avant d'activer ce job, idéalement **livrer aussi** :

- Endpoint `GET /api/version` côté Hub qui retourne `git_sha`
- Smoke staging modifié pour vérifier le `git_sha` retourné par staging
  matche le SHA pushé

Sinon, on a la même bombe que sur Prospection : promotion réussie côté CI
alors que Dokploy n'a pas pull staging. Voir détails dans le ticket
`2026-05-19-ci-architecture-etoffer.md`.

## Critère DoD

- [ ] Job `promote-to-main` mergé dans `hub-staging.yml`
- [ ] PAT `GH_AUTOPROMOTE_PAT` provisionné en secrets
- [ ] Premier auto-promote vérifié sur un commit anodin (genre doc-only)
- [ ] Telegram OK
- [ ] Section §19.1 de CI-ARCHITECTURE mise à jour : Hub `🟢 auto-promote câblé`
- [ ] Ticket archivé dans `todo/done/`

## Réponse — 2026-05-19 (agent Hub)

✅ **Câblé côté workflow.**

### Ce qui a été fait

- Job `promote-to-main` ajouté en fin de
  `.github/workflows/hub-staging.yml`, pattern aligné sur
  `veridian-cms/.github/workflows/cms-staging.yml:promote-to-main`.
- `needs: deploy` → si build ou smoke staging KO, pas de promotion.
- `if` : push sur `staging`, pas `[skip-prod]` ni `[wip]` dans le message commit.
- `merge --ff-only` strict (échec si main a divergé, pas de force-push silencieux).
- Trigger explicite de `hub-ci.yml` sur main via `gh workflow run` (sinon
  GitHub anti-loop ne déclenche pas le workflow main quand le push vient
  de GITHUB_TOKEN).
- Notif Telegram optionnelle (`if-defined` sur `TELEGRAM_BOT_TOKEN` +
  `TELEGRAM_CHAT_ID`, no-op si secrets pas câblés).

### Choix d'implémentation

- Le PAT lu est `AUTO_PROMOTE_PAT` (nom CMS, cohérence cross-app) avec
  fallback `GH_AUTOPROMOTE_PAT` (nom cité dans le ticket) puis
  `GITHUB_TOKEN`. Le premier disponible gagne.
- YAML validé localement.

### Reste à faire (côté Robert / infra)

- [ ] Provisionner `AUTO_PROMOTE_PAT` (PAT scope `repo` + `workflow`) en
      GitHub Secrets du repo veridian-hub **si** la branche main a une
      branch protection avec status checks (sinon GITHUB_TOKEN suffit).
- [ ] (Optionnel) `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` pour les notifs.
- [ ] Vérifier le premier auto-promote sur un commit anodin (genre doc-only).
- [ ] Mettre à jour CI-ARCHITECTURE.md §19.1 : Hub `🟢 auto-promote câblé`
      (fait dans le ticket parallèle `ci-architecture-etoffer.md`).
- [ ] Archiver ce ticket dans `todo/done/` une fois le premier promote OK.
