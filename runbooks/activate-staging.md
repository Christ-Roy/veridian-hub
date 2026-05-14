# Activation staging éphémère Hub — Runbook

> Procédure à exécuter UNE FOIS après le merge de la PR #18
> (feat/staging-ephemeral-ci). Active le workflow `hub-staging.yml` qui
> spawn/teardown une stack staging par PR sur dev server.

## Pré-requis (déjà en place)

- ✅ Traefik standalone sur dev : `~/traefik-staging/` (systemd
  `traefik-staging.service`, image `traefik:v3.6.17`)
- ✅ Network external `staging-edge` créé
- ✅ DNS wildcard `*.staging.veridian.site` → `37.187.199.185`
- ✅ Cert wildcard Let's Encrypt DNS-01 (Cloudflare)
- ✅ Workflow `.github/workflows/hub-staging.yml` mergé sur main
- ✅ Compose pattern `compose/base.yml` + `compose/staging.yml` mergé

## Étape 1 — Créer un user SSH dédié staging sur dev

```sh
ssh dev-pub bash <<'EOF'
sudo useradd -m -s /bin/bash -G docker staging-deploy
sudo mkdir -p /home/staging-deploy/.ssh
sudo chmod 700 /home/staging-deploy/.ssh
# /opt/staging/hub appartient à staging-deploy pour qu'il puisse écrire
sudo mkdir -p /opt/staging/hub
sudo chown -R staging-deploy:staging-deploy /opt/staging/hub
sudo chmod 755 /opt/staging
EOF
```

Vérifier que `staging-deploy` peut bien lancer `docker` (groupe docker).

## Étape 2 — Générer une clé SSH ed25519 pour la CI

Sur la machine locale (mail) :

```sh
ssh-keygen -t ed25519 -C "github-actions-staging-veridian-hub" \
  -f ~/credentials/staging-deploy-veridian-hub -N ""
```

Deux fichiers générés :
- `~/credentials/staging-deploy-veridian-hub` (privé)
- `~/credentials/staging-deploy-veridian-hub.pub` (public)

## Étape 3 — Déployer la clé publique sur dev

```sh
PUBKEY=$(cat ~/credentials/staging-deploy-veridian-hub.pub)
ssh dev-pub "sudo -u staging-deploy bash -c \"echo '$PUBKEY' >> /home/staging-deploy/.ssh/authorized_keys && chmod 600 /home/staging-deploy/.ssh/authorized_keys\""
```

Tester la connexion :

```sh
ssh -i ~/credentials/staging-deploy-veridian-hub \
    staging-deploy@dev-pub.veridian.site 'docker ps'
```

Doit lister les containers actifs sur dev (notamment `traefik`).

## Étape 4 — Configurer les secrets/variables GitHub repo

Repo : `Christ-Roy/veridian-hub` → Settings → Secrets and variables → Actions

### Secrets (boutons « New repository secret »)

| Nom | Valeur |
|---|---|
| `STAGING_SSH_KEY` | Contenu de `~/credentials/staging-deploy-veridian-hub` (la clé PRIVÉE, ed25519 entier) |
| `STAGING_HUB_AUTH_SECRET` | `$(openssl rand -base64 32)` — 32 bytes base64, à régénérer ici |
| `STAGING_POSTGRES_PASSWORD` | `$(openssl rand -base64 24)` — 24 bytes base64 |

### Variables (onglet Variables, boutons « New repository variable »)

| Nom | Valeur |
|---|---|
| `STAGING_HOST` | `dev-pub.veridian.site` |
| `STAGING_USER` | `staging-deploy` |

Commande pour générer les secrets aléatoires :

```sh
echo "STAGING_HUB_AUTH_SECRET = $(openssl rand -base64 32)"
echo "STAGING_POSTGRES_PASSWORD = $(openssl rand -base64 24)"
```

Coller chaque valeur dans le formulaire GitHub correspondant.

## Étape 5 — Déployer le GC sur dev

```sh
scp scripts/ops/staging-gc.sh dev-pub:/tmp/
ssh dev-pub bash <<'EOF'
sudo mv /tmp/staging-gc.sh /opt/scripts/staging-gc-hub.sh
sudo chmod +x /opt/scripts/staging-gc-hub.sh
sudo chown root:root /opt/scripts/staging-gc-hub.sh

# Authentifier gh CLI pour le user staging-deploy (token GitHub read-only PR)
# Cf documentation gh auth login --with-token, à faire interactivement.
# Sinon le GC fallback sur l'âge des dossiers (7 jours).

# Systemd timer hebdomadaire (dimanche 03:00 UTC)
sudo tee /etc/systemd/system/staging-gc-hub.service > /dev/null <<UNIT
[Unit]
Description=Veridian Hub staging GC
After=docker.service

[Service]
Type=oneshot
ExecStart=/opt/scripts/staging-gc-hub.sh
User=root
UNIT

sudo tee /etc/systemd/system/staging-gc-hub.timer > /dev/null <<UNIT
[Unit]
Description=Run Hub staging GC weekly

[Timer]
OnCalendar=Sun *-*-* 03:00:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now staging-gc-hub.timer
sudo systemctl list-timers | grep staging-gc-hub
EOF
```

## Étape 6 — Test end-to-end

1. Ouvrir une PR vers `main` (par exemple PR #17 `fix/dashboard-rsc-icon-prop`)
2. Vérifier dans GitHub Actions que `Hub Staging (ephemeral per PR)` se
   déclenche et le job `spawn` passe au vert
3. Vérifier que le bot commente la PR avec l'URL
   `https://hub-<slug>.staging.veridian.site`
4. Ouvrir l'URL dans le navigateur, smoke test manuel (signup → login →
   dashboard)
5. Fermer la PR sans merger (ou la merger) → vérifier que le job
   `teardown` tourne et supprime la stack
6. Sur dev : `docker ps | grep hub-` → ne doit plus rien lister
7. Sur dev : `ls /opt/staging/hub/` → doit être vide

## Troubleshooting

### Le workflow skip avec « Staging SSH credentials manquants »

Vérifier que les secrets `STAGING_SSH_KEY` et les variables `STAGING_HOST`
+ `STAGING_USER` sont bien définis dans Settings → Secrets and variables.
Les **secrets** (chiffrés) sont distincts des **variables** (claires) — le
workflow lit `secrets.STAGING_SSH_KEY` ET `vars.STAGING_HOST`.

### Container hub-<slug> ne devient pas healthy

```sh
ssh staging-deploy@dev-pub docker logs hub-<slug> --tail 100
```

Causes fréquentes :
- Variable d'env Prisma manquante → migration au boot échoue
- Erreur de connexion à `hub-db` (postgres éphémère) → vérifier que les
  deux containers sont sur le même `hub-internal` network

### Cert SSL invalide sur https://hub-<slug>.staging.veridian.site

Traefik gère le cert wildcard automatiquement. Si erreur cert :

```sh
ssh dev-pub 'docker logs traefik --tail 100 | grep -i cert'
ssh dev-pub 'ls -la ~/traefik-staging/acme/'
```

Le wildcard cert peut prendre 1-2 min à être émis au premier démarrage.

### Plusieurs stacks staging tournent en même temps

Normal. Chaque PR a sa propre stack, son propre sous-domaine, sa propre
DB éphémère. Le GC hebdo nettoie celles dont la PR est fermée depuis > 24h.
