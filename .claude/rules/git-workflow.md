---
paths:
  - "**/*"
---

# Git Workflow

- Branche principale : `main`. Recoit du code via CI uniquement (merge auto).
- Branche dev prospection : `staging`. Auto-deploy sur dev server.
- Branche dev hub : feature branches ou commits directs sur `main` (tests verts = deploy auto).
- JAMAIS push --force sur une branche partagee.
- JAMAIS git stash -u. Deplacer vers /tmp/.
- Batch 3-5 commits avant de push. Max 1 push / 15 min (CI billing).
- Format commit : `type(scope): description` (feat, fix, refactor, test, ci, docs, perf, chore).
- Quand migration DB : body du commit commence par `Existing tenants:`.
