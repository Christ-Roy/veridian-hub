# [HUB] 🔵 P3 — CLAUDE.md Hub ne mentionne pas `lib/prospect/` (réconciliateur) dans la structure

> **Sévérité** : 🔵 P3 / **Owner** : agent veridian-hub / **Créé** : 2026-06-17 (audit cohérence réconciliateur)

## Contexte

Le réconciliateur prospect est en prod (`lib/prospect/ingest.ts` + `scoring.ts`, tables
`prospect_events` / `prospect_scores`, handlers webhook). Mais le `CLAUDE.md` du Hub (section
"Structure" qui liste `lib/auth/`, `lib/notifuse/`, `lib/stripe/`, `lib/mfa/`, etc.) **ne mentionne ni
`lib/prospect/` ni le réconciliateur**. Vérifié : `grep -niE "prospect|réconcil|behavioral|scoring"
veridian-hub/CLAUDE.md` ne renvoie que des occurrences de "Prospection" (l'app downstream, sans rapport).

C'est un écart doc↔code mineur : un nouvel agent qui découvre le Hub via son CLAUDE.md ne saura pas que
le réconciliateur vit là, ni qu'il y a un standard event comportemental.

> NB — le reste de la doc est **à jour et cohérent** : `docs/CONTRAT-HUB.md §7.5` (schéma d'event,
> barème exact `opened+1 / clicked+5 / replied+20 / page.hit+3`, signal keys
> `{opened,clicked,replied,page_hit}`, deux voies de transport legacy HMAC + v1.4 Bearer, jointure
> email/vid, best-effort) reflète fidèlement `lib/prospect/*` et la route. **Aucune incohérence dans
> CONTRAT-HUB §7.5** — ne pas y toucher.

## Demande précise

Dans `veridian-hub/CLAUDE.md`, section "Structure", ajouter sous `lib/` une ligne :

```
│   ├── prospect/             # Réconciliateur prospect : ingestion events comportementaux + scoring V1
```

et, dans une phrase de la section adéquate, un pointeur vers `docs/CONTRAT-HUB.md §7.5` comme source de
vérité du standard event comportemental cross-app (au même titre que le pointeur PRICING-VERIDIAN.md
existant).

## Impact

Faible mais réel : la cartographie mentale d'un agent qui arrive sur le Hub doit inclure le
réconciliateur. 2 lignes de doc. À faire en passant lors du prochain commit doc du Hub.

## Priorité

🔵 P3 — cosmétique/onboarding. Non bloquant.
