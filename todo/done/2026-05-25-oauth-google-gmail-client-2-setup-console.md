# [HUB] OAuth Google Mail Sender — Client 2 créé console (LIVRÉ console-side)

> **Type** : Config Google Cloud Console — action humaine ✅ FAITE
> **Sévérité** : 🟢 ARCHIVÉ — partie console livrée 2026-05-25 via MCP Chrome
> **Owner** : Robert (clics) + team-lead Hub (automation MCP)
> **Créé** : 2026-05-25 (remplace `2026-05-25-oauth-google-gmail-send-test-users.md`)

---

## Décisions arbitrées

**Pattern multi-clients OAuth Google** (standard industriel Notion/Linear/Hubspot) :
1. **Client 1 existant** `Veridian Hub` (`792581780186-i...`) — scope basic `openid email profile` — sign-in/login, en Production, partout publié
2. **Client 2 nouveau** `Veridian Mail Sender` (`nbmuq4gletbsqt1f3r185ab7la4kke4q...`) — scope `gmail.send` ajouté pour envoi mail au nom de l'user

**Pourquoi 2 clients séparés** : isole le scope sensitive `gmail.send` du sign-in production. Aucun impact UX sur les users existants OAuth signup. Brand verification de chacun reste indépendante.

## Livré console (par MCP Chrome)

- ✅ Scope `https://www.googleapis.com/auth/gmail.send` ajouté au consent screen `veridian-preprod` (warning Validation requise = attendu)
- ✅ Client OAuth `Veridian Mail Sender` créé type Web :
  - **Client ID** : `nbmuq4gletbsqt1f3r185ab7la4kke4q.apps.googleusercontent.com`
  - **Client Secret** : `GOCSPX-bDIxXIwcuQBPS_VWYHJQg_bbLgy`
  - **Origins JS** : `https://app.veridian.site`, `https://hub.staging.veridian.site`, `http://localhost:3000`
  - **Redirect URIs** : `/api/gmail/connect/callback` pour les 3 hosts ci-dessus
- ✅ Credentials persistés dans `~/credentials/.all-creds.env` (`GOOGLE_MAIL_CLIENT_ID`, `GOOGLE_MAIL_CLIENT_SECRET`)
- ✅ Projet reste en **mode Production** (88 slots / 100 max disponibles pour users qui consomment le scope sensitive non-validé — n'affecte PAS le sign-in Client 1)

## Notes Google

- L'utilisateur qui clique "Connecter Gmail" verra le warning **"Google hasn't verified this app"** au consent. Tant qu'on est dans les 100 slots, c'est acceptable beta privée.
- Refresh token expire selon les règles standard (forever en Production publié) — pas la limite 7j du mode Testing.
- Pour ouverture commerciale large : brand verification + Trust & Safety review (~6-8 semaines) sur scope restricted.

## Suite

Code Hub à livrer = ticket séparé `todo/2026-05-25-gmail-send-implementation-hub.md`.
Vision archi globale = `todo/2026-05-25-mail-gateway-hub-multi-provider.md` (toujours pending).
