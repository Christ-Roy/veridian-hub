# hub.nomad.hcl — SOURCE DE VÉRITÉ GITOPS du déploiement PROD du Hub.
#
# Miroir versionné (dans CE repo) du job Nomad réellement déployé. La CI injecte
# le tag d'image promu (var image_tag) puis `nomad job plan`→`run`. Patron de
# référence : veridian-prospection/deploy/README.md (canon SSH-bastion Robert
# 2026-07-11). Adaptation Hub : cf deploy/README.md (migrate-on-boot, pas de step
# migrate CI).
#
# Veridian Hub (orchestrateur auth/billing/provisioning, Next.js, port 3000).
# Placement : serveur PROD OVH (provider=ovh-prod). DB actuelle =
# veridian-core-db (postgres:16-alpine) co-localisée dans le même group bridge.
# Le contrat runtime ne hardcode plus l'URL complète : `DATABASE_URL` est
# composée depuis les variables d'endpoint `HUB_DATABASE_*` et le secret
# `VERIDIAN_CORE_DB_PASSWORD`. Aujourd'hui le fallback explicite pointe le
# sidecar local (`HUB_DATABASE_MODE=local-colocated`, host 127.0.0.1:5432).
# Demain, le cutover HA remplace seulement l'endpoint (`HUB_DATABASE_MODE`,
# `HUB_DATABASE_SERVICE_NAME`, host/port ou proxy) sans changer le code Hub.
# TLS terminé par Traefik (certresolver letsencrypt sur app.veridian.site).
# Secrets = Nomad Variable nomad/jobs/hub (JAMAIS en clair).
# ⚠️ Stripe LIVE en prod (clés dans la Nomad var).
#
# ⚠️ DB PROD mono-instance postgres:16, volume bind /opt/veridian-lab/hub/core-db.
# NE PAS reschedule (le volume local ne suit pas). Cible infra à terme = cluster
# Patroni HA (le staging l'a déjà, cf deploy/hub-staging.nomad.hcl).

variable "image_tag" {
  type        = string
  description = "Tag de l'image ghcr.io/christ-roy/veridian-hub promue en prod (injecté par la CI)."
  # Recale sur ce qui tourne reellement en prod : le defaut retardait d'une
  # version et un deploiement hors CI aurait retrograde le Hub. Ce defaut se
  # perime a chaque promotion ; le verifier fait partie de tout deploiement
  # hors CI de ce fichier.
  # Recale le 2026-08-29 : mesure sur le job Nomad vivant = v0.5.32, deux
  # promotions devant ce defaut. Aucun effet sur le deploiement, la CI injecte
  # -var image_tag ; l'effet est sur la VERITE des plans hors CI, ou le defaut
  # affichait une retrogradation qui n'existait pas et bloquait le chantier
  # perms des secrets.
  default     = "v0.5.32"
}

job "hub" {
  datacenters = ["veridian-eu"]
  type        = "service"
  priority    = 80

# veridian-contract:start
# veridian.contract.version=1
# veridian.managed_by=repo
# veridian.environment=production
# veridian.tier=saas-prod
# veridian.criticality=A
# veridian.owner=platform
# veridian.objective=availability-99.95
# veridian.rto_minutes=2
# veridian.rpo_minutes=5
# veridian.state=local-state
# veridian.mobility=local-gap
# veridian.preemptible=false
# veridian.staging_job=hub-staging
# veridian.promotion_policy=staging-required
# veridian-contract:end

  group "stack" {
    count = 1

    # auto_revert : un deploy prod qui n'atteint jamais healthy restaure la
    # dernière version saine (zéro trou prod). min_healthy_time : l'alloc doit
    # rester saine 15s avant d'être comptée healthy (anti-flap).
    update {
      max_parallel      = 1
      min_healthy_time  = "15s"
      healthy_deadline  = "5m"
      progress_deadline = "10m"
      auto_revert       = true
    }

    # Épinglé au serveur PROD : le bind core-db est local et ne suit pas l'allocation.
    constraint {
      attribute = "${meta.provider}"
      value     = "ovh-prod"
    }

    restart {
      attempts = 10
      interval = "10m"
      delay    = "15s"
      mode     = "delay"
    }

    network {
      mode = "bridge"
      # Les ingress tournent sur plusieurs nœuds. Le port applicatif doit donc
      # être annoncé sur le réseau Tailscale commun, pas sur l'IP publique du
      # nœud d'allocation (qui est filtrée entre origines et provoque un 504).
      port "http" {
        to           = 3000
        host_network = "tailscale"
      }
    }

    service {
      name     = "hub"
      provider = "nomad"
      port     = "http"
      tags = [
        "traefik.enable=true",
        "traefik.http.routers.hub.rule=Host(`hub-lab.veridian.site`)",
        "traefik.http.routers.hub.entrypoints=web",
        "traefik.http.routers.hub.middlewares=internal-only@nomad",
        "traefik.http.routers.hubsec.rule=Host(`hub-lab.veridian.site`)",
        "traefik.http.routers.hubsec.entrypoints=websecure",
        "traefik.http.routers.hubsec.middlewares=internal-only@nomad",
        "traefik.http.routers.hubsec.tls=true",
        "traefik.http.routers.hubprod.rule=Host(`app.veridian.site`)",
        "traefik.http.routers.hubprod.entrypoints=websecure",
        "traefik.http.routers.hubprod.tls=true",
        "traefik.http.routers.hubprod.tls.certresolver=letsencrypt",
      ]
      check {
        type     = "http"
        path     = "/api/health"
        interval = "15s"
        timeout  = "5s"
      }
    }

    # ---- veridian-core-db (postgres:16, frais, interne) ----
    task "veridian-core-db" {
      driver = "docker"
      config {
        # Image officielle postgres:16-alpine + pgBackRest epingle. La BASE est
        # identique au bit pres : changer d'image de base changerait la
        # collation (musl/glibc) et fausserait silencieusement les index.
        image = "ghcr.io/christ-roy/veridian-postgres-pgbackrest:16-alpine@sha256:ca672c3127d4e9e1fef42e813ecd751a6759ed4e7916e44a6ae7fb3a6862716e"
        args = [
          # --- Archivage continu des WAL vers le depot pgBackRest ---
          # C'est CE reglage, et non la sauvegarde nocturne, qui borne la perte
          # de donnees : chaque segment de journal part vers R2 des qu'il est
          # clos. archive_timeout force cette cloture toutes les 5 minutes quand
          # il y a eu de l'ecriture, donc RPO = 5 min.
          # Modifier archive_mode exige un REDEMARRAGE de PostgreSQL (ce n'est
          # pas rechargeable a chaud) : c'est la seule interruption qu'impose la
          # mise en place.
          # pgBackRest ne joint le cluster QUE par socket Unix ; il n'a aucune
          # option de connexion TCP pour un cluster local. La tache annexe vit
          # dans un autre espace de montage et ne voit donc pas
          # /var/run/postgresql. On publie une seconde socket dans /alloc, le
          # repertoire que Nomad partage entre les taches d'un meme groupe.
          # L'ancienne reste en place : `docker exec ... psql` continue de marcher.
          "-c", "unix_socket_directories=/var/run/postgresql,/alloc",
          "-c", "archive_mode=on",
          "-c", "archive_command=pgbackrest --stanza=hub-core archive-push %p",
          "-c", "archive_timeout=300",
          "-c", "wal_level=replica",
        ]
        volumes = [
          "/opt/veridian-lab/hub/core-db:/var/lib/postgresql/data",
        ]
      }
      template {
        destination = "secrets/pg.env"
        env         = true
        data        = <<EOH
TZ=UTC
POSTGRES_USER=veridian
POSTGRES_DB=veridian
{{ with nomadVar "nomad/jobs/hub" }}
POSTGRES_PASSWORD={{ .VERIDIAN_CORE_DB_PASSWORD }}
{{ end }}
# --- pgBackRest : configuration par variables d'environnement ---
# Aucun fichier de configuration : les identifiants R2 et la phrase de
# chiffrement ne sont jamais ecrits sur le disque de l'allocation. pgBackRest
# lit toute option sous la forme PGBACKREST_<OPTION>.
PGBACKREST_REPO1_TYPE=s3
PGBACKREST_REPO1_PATH=/pgbackrest/hub-core
PGBACKREST_REPO1_S3_REGION=auto
# path : R2 accepte les deux styles, celui-ci ne depend pas d'un DNS par bucket.
PGBACKREST_REPO1_S3_URI_STYLE=path
PGBACKREST_REPO1_CIPHER_TYPE=aes-256-cbc
PGBACKREST_COMPRESS_TYPE=zst
PGBACKREST_COMPRESS_LEVEL=6
PGBACKREST_REPO1_BUNDLE=y
PGBACKREST_REPO1_BLOCK=y
PGBACKREST_LOG_LEVEL_CONSOLE=info
PGBACKREST_LOG_LEVEL_FILE=off
PGBACKREST_PG1_PATH=/var/lib/postgresql/data
PGBACKREST_PG1_PORT=5432
PGBACKREST_PG1_USER=veridian
PGBACKREST_PG1_DATABASE=veridian
{{ with nomadVar "nomad/jobs/hub" }}
PGBACKREST_REPO1_S3_BUCKET={{ .R2_BUCKET }}
PGBACKREST_REPO1_S3_ENDPOINT={{ .R2_ENDPOINT }}
PGBACKREST_REPO1_S3_KEY={{ .R2_ACCESS_KEY_ID }}
PGBACKREST_REPO1_S3_KEY_SECRET={{ .R2_SECRET_ACCESS_KEY }}
# ATTENTION : PERDRE CETTE PHRASE = PERDRE TOUTES LES SAUVEGARDES. Copie de
# secours dans ~/credentials/.all-creds.env (PGBACKREST_CIPHER_HUB_CORE).
PGBACKREST_REPO1_CIPHER_PASS={{ .PGBACKREST_CIPHER_PASS }}
{{ end }}
EOH
      }
      resources {
        cpu        = 300
        memory     = 256
        memory_max = 7000
      }
    }

    # ---- pgBackRest : sauvegarde continue vers R2 ----
    # Tache annexe du MEME groupe, donc : meme espace reseau (elle joint
    # PostgreSQL par la socket publiee dans /alloc, authentification `trust`
    # locale, aucun mot de passe a promener) et meme bind mount de PGDATA (elle
    # lit les pages directement). Elle SUIT l'allocation : si Nomad replace le
    # groupe, la sauvegarde repart sans qu'on touche a un script.
    task "pgbackrest" {
      driver = "docker"
      config {
        image      = "ghcr.io/christ-roy/veridian-postgres-pgbackrest:16-alpine@sha256:ca672c3127d4e9e1fef42e813ecd751a6759ed4e7916e44a6ae7fb3a6862716e"
        entrypoint = ["/usr/local/bin/pgbackrest-scheduler"]
        command    = ""
        volumes = [
          "/opt/veridian-lab/hub/core-db:/var/lib/postgresql/data",
        ]
      }
      user = "postgres"

      template {
        destination = "secrets/pgbackrest.env"
        env         = true
        data        = <<EOH
TZ=UTC
PGBR_STANZA=hub-core
# Socket partagee avec la tache postgres via le repertoire d'allocation.
PGBACKREST_PG1_SOCKET_PATH=/alloc
# Complete le dimanche, differentielle les autres jours, incrementale toutes les
# 6 h. 20 : creneau propre a cette stanza pour ne pas taper R2 en meme
# temps que les autres bases du parc.
PGBR_FULL_DOW=0
PGBR_DAILY_HOUR=3
PGBR_DAILY_MINUTE=20
PGBR_INCR_EVERY_H=6
# Base de PRODUCTION cliente : 8 semaines de completes conservees. Les WAL
# retenus couvrent la meme profondeur, donc on peut viser n'importe quelle
# seconde des deux derniers mois.
PGBACKREST_REPO1_RETENTION_FULL=8
PGBACKREST_REPO1_RETENTION_DIFF=7
PGBACKREST_PROCESS_MAX=2
PGBACKREST_START_FAST=y
# --- pgBackRest : configuration par variables d'environnement ---
# Aucun fichier de configuration : les identifiants R2 et la phrase de
# chiffrement ne sont jamais ecrits sur le disque de l'allocation. pgBackRest
# lit toute option sous la forme PGBACKREST_<OPTION>.
PGBACKREST_REPO1_TYPE=s3
PGBACKREST_REPO1_PATH=/pgbackrest/hub-core
PGBACKREST_REPO1_S3_REGION=auto
# path : R2 accepte les deux styles, celui-ci ne depend pas d'un DNS par bucket.
PGBACKREST_REPO1_S3_URI_STYLE=path
PGBACKREST_REPO1_CIPHER_TYPE=aes-256-cbc
PGBACKREST_COMPRESS_TYPE=zst
PGBACKREST_COMPRESS_LEVEL=6
PGBACKREST_REPO1_BUNDLE=y
PGBACKREST_REPO1_BLOCK=y
PGBACKREST_LOG_LEVEL_CONSOLE=info
PGBACKREST_LOG_LEVEL_FILE=off
PGBACKREST_PG1_PATH=/var/lib/postgresql/data
PGBACKREST_PG1_PORT=5432
PGBACKREST_PG1_USER=veridian
PGBACKREST_PG1_DATABASE=veridian
{{ with nomadVar "nomad/jobs/hub" }}
PGBACKREST_REPO1_S3_BUCKET={{ .R2_BUCKET }}
PGBACKREST_REPO1_S3_ENDPOINT={{ .R2_ENDPOINT }}
PGBACKREST_REPO1_S3_KEY={{ .R2_ACCESS_KEY_ID }}
PGBACKREST_REPO1_S3_KEY_SECRET={{ .R2_SECRET_ACCESS_KEY }}
# ATTENTION : PERDRE CETTE PHRASE = PERDRE TOUTES LES SAUVEGARDES. Copie de
# secours dans ~/credentials/.all-creds.env (PGBACKREST_CIPHER_HUB_CORE).
PGBACKREST_REPO1_CIPHER_PASS={{ .PGBACKREST_CIPHER_PASS }}
{{ end }}
EOH
      }

      resources {
        cpu        = 100
        memory     = 64
        memory_max = 512
      }
    }

    # ---- hub (Next.js, port 3000) ----
    task "hub" {
      driver         = "docker"
      shutdown_delay = "10s"
      kill_timeout   = "30s"
      service {
        name     = "hub-selfheal"
        provider = "nomad"
        port     = "http"
        tags     = ["traefik.enable=false"]
        check {
          type     = "http"
          path     = "/api/health"
          interval = "15s"
          timeout  = "5s"
          check_restart {
            limit           = 4
            grace           = "120s"
            ignore_warnings = false
          }
        }
      }
      config {
        image = "ghcr.io/christ-roy/veridian-hub:${var.image_tag}"
        init  = true
        ports = ["http"]
      }
      template {
        destination = "secrets/hub.env"
        env         = true
        data        = <<EOH
NODE_ENV=production
PORT=3000
HOSTNAME=0.0.0.0
NEXT_TELEMETRY_DISABLED=1
AUTH_TRUST_HOST=true
DEPLOY_ENV=prod
ADMIN_EMAILS=brunon5robert@gmail.com,robert.brunon@veridian.site

AUTH_URL=https://app.veridian.site
NEXTAUTH_URL=https://app.veridian.site
NEXT_PUBLIC_SITE_URL=https://app.veridian.site
DASHBOARD_SITE_URL=https://app.veridian.site
DOMAIN=app.veridian.site
LANDING_ORIGIN=https://veridian.site

NEXT_PUBLIC_NOTIFUSE_URL=https://notifuse.app.veridian.site
NEXT_PUBLIC_NOTIFUSE_API_URL=https://notifuse.app.veridian.site/api/v1
NOTIFUSE_API_URL=https://notifuse.app.veridian.site
NOTIFUSE_API_ENDPOINT=https://notifuse.app.veridian.site

NEXT_PUBLIC_PROSPECTION_URL=https://prospection.app.veridian.site
PROSPECTION_API_URL=https://prospection.app.veridian.site
PROSPECTION_INTERNAL_URL=https://prospection.app.veridian.site

# Bascule vers le NOUVEAU moteur analytics (fork Rybbit rebrandé Veridian).
# L'ancien n'exposait pas la route interrogée au login (GET /api/users/by-email,
# vérifié : "Cannot GET") : la découverte analytics ne fonctionnait donc pas.
ANALYTICS_API_URL=https://analytics.app.veridian.site
# URL ouverte au CLIENT depuis la carte Analytics du tableau de bord. Lue au
# runtime (composant serveur) : changer cette valeur ne demande PAS de
# reconstruire l'image. Sans elle, le défaut en dur de attach-downstream.ts
# s'applique — et il pointait encore sur l'ancien moteur.
NEXT_PUBLIC_ANALYTICS_URL=https://analytics.app.veridian.site
CRM_METADATA_URL=https://crm.app.veridian.site/metadata
CRM_REST_URL=https://crm.app.veridian.site/rest
CRM_FRONTEND_URL=https://crm.app.veridian.site

{{ with nomadVar "nomad/jobs/hub" }}
{{ $dbMode := or .HUB_DATABASE_MODE.Value "local-colocated" }}
{{ $dbUser := or .HUB_DATABASE_USER.Value "veridian" }}
{{ $dbHost := or .HUB_DATABASE_HOST.Value "127.0.0.1" }}
{{ $dbPort := or .HUB_DATABASE_PORT.Value "5432" }}
{{ $dbName := or .HUB_DATABASE_NAME.Value "veridian" }}
{{ $dbSchema := or .HUB_DATABASE_SCHEMA.Value "hub_app" }}
{{ $dbPassword := .VERIDIAN_CORE_DB_PASSWORD }}
{{ if eq $dbMode "nomad-service" }}
{{ $dbServiceName := or .HUB_DATABASE_SERVICE_NAME.Value "hub-postgres" }}
{{ range nomadService $dbServiceName }}
HUB_DATABASE_MODE={{ $dbMode }}
HUB_DATABASE_SERVICE_NAME={{ $dbServiceName }}
HUB_DATABASE_USER={{ $dbUser }}
HUB_DATABASE_HOST={{ .Address }}
HUB_DATABASE_PORT={{ .Port }}
HUB_DATABASE_NAME={{ $dbName }}
HUB_DATABASE_SCHEMA={{ $dbSchema }}
DATABASE_URL=postgresql://{{ $dbUser }}:{{ $dbPassword }}@{{ .Address }}:{{ .Port }}/{{ $dbName }}?schema={{ $dbSchema }}
{{ end }}
{{ else }}
{{ $dbServiceName := or .HUB_DATABASE_SERVICE_NAME.Value "veridian-core-db" }}
HUB_DATABASE_MODE={{ $dbMode }}
HUB_DATABASE_SERVICE_NAME={{ $dbServiceName }}
HUB_DATABASE_USER={{ $dbUser }}
HUB_DATABASE_HOST={{ $dbHost }}
HUB_DATABASE_PORT={{ $dbPort }}
HUB_DATABASE_NAME={{ $dbName }}
HUB_DATABASE_SCHEMA={{ $dbSchema }}
DATABASE_URL=postgresql://{{ $dbUser }}:{{ $dbPassword }}@{{ $dbHost }}:{{ $dbPort }}/{{ $dbName }}?schema={{ $dbSchema }}
{{ end }}
AUTH_SECRET={{ .HUB_AUTH_SECRET }}
ADMIN_SECRET={{ .ADMIN_SECRET }}
CRON_SECRET={{ .CRON_SECRET }}
VAULT_ENC_KEY={{ .VAULT_ENC_KEY }}
CRM_VAULT_KEY={{ .CRM_VAULT_KEY }}
SESSION_HINT_SECRET={{ .SESSION_HINT_SECRET }}
GOOGLE_OAUTH_CLIENT_ID={{ .GOOGLE_OAUTH_CLIENT_ID }}
GOOGLE_OAUTH_CLIENT_SECRET={{ .GOOGLE_OAUTH_CLIENT_SECRET }}
GOOGLE_MAIL_CLIENT_ID={{ .GOOGLE_MAIL_CLIENT_ID }}
GOOGLE_MAIL_CLIENT_SECRET={{ .GOOGLE_MAIL_CLIENT_SECRET }}
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY={{ .STRIPE_PUBLISHABLE_KEY_LIVE }}
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY_LIVE={{ .STRIPE_PUBLISHABLE_KEY_LIVE }}
STRIPE_SECRET_KEY={{ .STRIPE_SECRET_KEY_LIVE }}
STRIPE_SECRET_KEY_LIVE={{ .STRIPE_SECRET_KEY_LIVE }}
STRIPE_WEBHOOK_SECRET={{ .STRIPE_WEBHOOK_SECRET_LIVE }}
STRIPE_WEBHOOK_SECRET_LIVE={{ .STRIPE_WEBHOOK_SECRET_LIVE }}
STRIPE_REFILL_PRODUCT_ID_LIVE={{ .STRIPE_REFILL_PRODUCT_ID_LIVE }}
NOTIFUSE_SECRET_KEY={{ .NOTIFUSE_SECRET_KEY }}
NOTIFUSE_ROOT_EMAIL={{ .NOTIFUSE_ROOT_EMAIL }}
NOTIFUSE_HUB_API_SECRET={{ .NOTIFUSE_HUB_API_SECRET }}
NOTIFUSE_HUB_WEBHOOK_SECRET={{ .NOTIFUSE_HUB_WEBHOOK_SECRET }}
NOTIFUSE_WEBHOOK_TOKEN={{ .NOTIFUSE_WEBHOOK_TOKEN }}
PROSPECTION_TENANT_API_SECRET={{ .PROSPECTION_TENANT_API_SECRET }}
PROSPECTION_WEBHOOK_TOKEN={{ .PROSPECTION_WEBHOOK_TOKEN }}
ANALYTICS_HUB_API_SECRET={{ .ANALYTICS_HUB_API_SECRET }}
BREVO_API_KEY={{ .BREVO_API_KEY }}
NEXT_PUBLIC_GTM_ID={{ .GTM_ID_APP_VERIDIAN }}
{{ end }}
EOH
      }
      resources {
        cpu        = 500
        memory     = 384
        memory_max = 7000
      }
    }
  }
}
