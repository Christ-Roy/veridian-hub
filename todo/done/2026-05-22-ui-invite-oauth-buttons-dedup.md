# UI — Dédupliquer les boutons OAuth sur la page /invite (régression)

> **Sévérité** : 🟢 P2 — dette / régression de factorisation, pas de bug visible
> **Owner** : agent Hub
> **Créé** : 2026-05-22
> **Refs** : commit page invite 3d1029f, audit précédent `todo/done/2026-05-21-ui-audit-coherence.md` §4

## Contexte

L'audit UI du 2026-05-21 a fait extraire `components/auth/OAuthButtons.tsx` —
les SVG de marque Google/Microsoft et les handlers `signIn(...)` y vivent
désormais une seule fois, et `LoginForm`/`SignupForm` les consomment.

Mais `app/invite/[token]/InviteSignInOptions.tsx` (livré avec la page invite,
commit 3d1029f) **réimplémente sa propre copie** : les fonctions `GoogleIcon()`
et `MicrosoftIcon()` y sont redéfinies à l'identique, et les boutons OAuth y
sont recodés à la main. C'est exactement la duplication que `OAuthButtons` a été
créé pour éliminer — la régression est juste passée sur un fichier que l'audit
n'avait pas traité.

Conséquence : 3 sources de vérité pour les mêmes SVG de marque, divergence
garantie à la prochaine retouche.

## Travail à faire

1. **Réutiliser `OAuthButtons`** (ou ses parties) dans `InviteSignInOptions.tsx`.
   Attention : le composant `OAuthButtons` actuel rend les deux boutons +
   éventuellement un footer, dans des `<Field>`. `InviteSignInOptions` a un
   layout différent (séparateur "ou", boutons signup/login email en dessous,
   `data-testid` spécifiques pour les E2E invite).
   - Soit `OAuthButtons` est rendu suffisamment paramétrable (sans `<Field>`
     forcé, sans footer) pour être réutilisé tel quel sur la page invite.
   - Soit on extrait juste les deux SVG (`GoogleIcon`/`MicrosoftIcon`) dans un
     module partagé (`components/auth/provider-icons.tsx`) et chaque écran garde
     son layout mais importe les icônes. Cette option est la plus sûre vu les
     `data-testid` E2E spécifiques à `InviteSignInOptions`.
2. **Préserver les `data-testid`** de `InviteSignInOptions` (`invite-signin-google`,
   `invite-signin-microsoft`, etc.) — ils sont utilisés par les tests E2E invite.
3. Vérifier que le gating `allowOauth` (OAuth désactivé en staging Tailscale,
   cf. memory `feedback_oauth_pas_sur_staging_tailscale`) reste respecté.

## Fichiers concernés

- `app/invite/[token]/InviteSignInOptions.tsx` — supprimer les SVG/boutons dupliqués
- `components/auth/OAuthButtons.tsx` — éventuellement rendre plus paramétrable
- éventuellement nouveau `components/auth/provider-icons.tsx` (option 2)

## DoD

- [ ] Les SVG Google/Microsoft ne sont plus définis qu'à un seul endroit
- [ ] La page `/invite/[token]` réutilise la source partagée
- [ ] Les `data-testid` E2E de la page invite sont préservés
- [ ] Le gating `allowOauth` fonctionne toujours
