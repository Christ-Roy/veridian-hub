# UI — Migrer OAuthButtons vers le module partagé provider-icons.tsx

> **Sévérité** : 🟢 P2 — dette / finition de factorisation
> **Owner** : agent Hub
> **Créé** : 2026-05-22
> **Refs** : ticket `todo/2026-05-22-ui-invite-oauth-buttons-dedup.md` (résolu partiellement)

## Contexte

Le ticket de dédup OAuth invite a été traité : `components/auth/provider-icons.tsx`
a été créé (source unique des SVG de marque Google / Microsoft), et
`app/invite/[token]/InviteSignInOptions.tsx` consomme désormais ce module au
lieu de réimplémenter ses propres `GoogleIcon()` / `MicrosoftIcon()`.

**Reste un dernier point** : `components/auth/OAuthButtons.tsx` définit encore
les deux SVG en inline dans son JSX. Il n'a PAS été modifié pendant le sprint
UI Lot 4 parce que l'agent "one-tap" travaillait dessus en parallèle (règle de
non-collision worktree multi-agents).

État actuel des sources des SVG de marque :
- ✅ `components/auth/provider-icons.tsx` — source canonique
- ✅ `app/invite/[token]/InviteSignInOptions.tsx` — consomme provider-icons
- ⏳ `components/auth/OAuthButtons.tsx` — SVG encore inline (à migrer)

## Travail à faire

1. Dans `OAuthButtons.tsx`, supprimer les deux `<svg>` inline et importer
   `GoogleIcon` / `MicrosoftIcon` depuis `@/components/auth/provider-icons`.
2. Vérifier le rendu sur `/login` et `/signup` (les deux écrans qui consomment
   `OAuthButtons` via `LoginForm` / `SignupForm`).
3. `__tests__/components/auth/OAuthButtons.test.tsx` doit rester vert.

C'est une migration purement mécanique (les SVG de `provider-icons.tsx` sont
byte-identiques à ceux d'`OAuthButtons`, à l'attribut `aria-hidden` près qui
est neutre ici). Aucune surface API ne change.

## DoD

- [ ] `OAuthButtons.tsx` importe les icônes depuis `provider-icons.tsx`
- [ ] Plus aucun `<path fill="#4285F4"` / `<path fill="#f25022"` hors de `provider-icons.tsx`
- [ ] Tests `OAuthButtons.test.tsx` + `LoginForm` + `SignupForm` verts
