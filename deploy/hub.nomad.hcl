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
# le job `hub-db` (depuis le 07/11/2026), hors de ce groupe : un déploiement ne touche pas la base.
# Le contrat runtime ne hardcode plus l'URL complète : `DATABASE_URL` est
# composée depuis les variables d'endpoint `HUB_DATABASE_*` et le secret
# `VERIDIAN_CORE_DB_PASSWORD`. `HUB_DATABASE_MODE=nomad-service` : service `hub-postgres`.
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
  # Recale le 2026-09-24 (chantier durcissement conteneurs) : mesure sur le
  # job Nomad vivant = v0.5.35, juste avant ce commit.
  default     = "v0.5.35"
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
    # Bleu-vert (07/11/2026) : le canari demarre a cote de l'ancienne allocation ; Traefik ne le sert qu'une fois sain
    # (health check actif des tags du service), puis la promotion arrete l'ancienne apres `shutdown_delay`.
    # Avant : l'ancienne s'arretait d'abord, 11 a 14 s de 404 et 502 a chaque deploiement.
    update {
      max_parallel      = 1
      canary            = 1
      auto_promote      = true
      min_healthy_time  = "15s"
      healthy_deadline  = "5m"
      progress_deadline = "10m"
      auto_revert       = true
    }

    # Épinglé au serveur PROD : la base `hub-db` y vit, le Hub la joint par le catalogue Nomad.
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
        "traefik.http.routers.hubprod.middlewares=hub-retry@nomad",
        # Bleu-vert : Traefik n'envoie du trafic a une instance que si elle repond a /api/health, et rejoue sur l'autre une
        # connexion refusee. Les canary_tags du premier essai ouvraient 11 s de 404 a la promotion (07/11, 23:40).
        # Ne pas changer ces tags dans un deploiement ordinaire : deux versions aux tags differents donnent a Traefik deux
        # definitions du meme routeur, il l'ecarte, 12 s de 404 (mesure le 07/11 a 23:57). Changer les tags = deploiement annonce.
        "traefik.http.services.hub.loadbalancer.healthcheck.path=/api/health",
        "traefik.http.services.hub.loadbalancer.healthcheck.interval=2s",
        "traefik.http.services.hub.loadbalancer.healthcheck.timeout=1s",
        "traefik.http.middlewares.hub-retry.retry.attempts=4",
        "traefik.http.middlewares.hub-retry.retry.initialinterval=200ms",
      ]
      check {
        type     = "http"
        path     = "/api/health"
        interval = "15s"
        timeout  = "5s"
      }
    }

    # ---- hub (Next.js, port 3000) ----
    task "hub" {
      driver         = "docker"
      user           = "nextjs"
      # Traefik relit le catalogue toutes les 15 s : l'allocation sortante sert encore pendant qu'il l'oublie.
      shutdown_delay = "30s"
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
        # Durcissement Unix : empeche un processus non privilegie d'elever ses
        # droits via un binaire setuid. C'est le maillon entre « shell dans le
        # conteneur » et « root sur l'hote ». N'affecte PAS un processus qui
        # ABANDONNE ses droits au demarrage, seulement celui qui en gagne.
        security_opt    = ["no-new-privileges:true"]
        readonly_rootfs = true
        cap_drop        = ["ALL"]

        # Identification lisible du conteneur (2026-09-07). Nomad ne pose que
        # `com.hashicorp.nomad.alloc_id` : rien ne disait a quelle application
        # appartenait un conteneur. Les quatre premieres valeurs sont
        # interpolees par Nomad a l'execution, les deux dernieres sont des
        # proprietes du fichier (dossier jobs/<tier>/ et table du script
        # scripts/poser-labels-conteneurs.py).
        labels = {
          "site.veridian.job"   = "${NOMAD_JOB_NAME}"
          "site.veridian.group" = "${NOMAD_GROUP_NAME}"
          "site.veridian.task"  = "${NOMAD_TASK_NAME}"
          "site.veridian.node"  = "${node.unique.name}"
          "site.veridian.tier"  = "saas-prod"
          "site.veridian.app"   = "hub"
        }
        image = "ghcr.io/christ-roy/veridian-hub:${var.image_tag}"
        init  = true
        ports = ["http"]

        mount {
          type     = "tmpfs"
          target   = "/tmp"
          readonly = false
          tmpfs_options { size = 67108864 }
        }
        mount {
          type     = "tmpfs"
          target   = "/app/.next/cache"
          readonly = false
          tmpfs_options { size = 134217728 }
        }
      }
      template {
        destination = "secrets/hub.env"
        perms       = "600"   # secret: lisible du seul proprietaire
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
# CRM Veridian (Twenty) : provisioning signé et rebond, CONTRAT-HUB §5.1 et §6bis.8. Secret = HUB_API_SECRET de nomad/jobs/crm.
CRM_API_URL=https://crm.app.veridian.site
# Flow d'essai réel (mails aux clients au 5e mail Notifuse) : allumé le 09/11 sur le go de Robert
# (« Oui, allume après relecture », artefact des décisions du 08/11). Couper : retirer la ligne.
TRIAL_MACHINE_ENABLED=1

{{ with nomadVar "nomad/jobs/hub" }}
{{ $dbMode := or .HUB_DATABASE_MODE.Value "nomad-service" }}
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
{{ with nomadVar "nomad/jobs/hub/stack" }}CRM_HUB_API_SECRET={{ .CRM_HUB_API_SECRET }}{{ end }}
SESSION_HINT_SECRET={{ .SESSION_HINT_SECRET }}
GOOGLE_OAUTH_CLIENT_ID={{ .GOOGLE_OAUTH_CLIENT_ID }}
GOOGLE_OAUTH_CLIENT_SECRET={{ .GOOGLE_OAUTH_CLIENT_SECRET }}
MICROSOFT_OAUTH_CLIENT_ID={{ .MICROSOFT_OAUTH_CLIENT_ID }}
MICROSOFT_OAUTH_CLIENT_SECRET={{ .MICROSOFT_OAUTH_CLIENT_SECRET }}
TELEGRAM_BOT_TOKEN={{ .TELEGRAM_BOT_TOKEN }}
ALERT_CHAT_ID={{ .ALERT_CHAT_ID }}
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
        # 08/11 : reservation = memoire non reprenable mesuree (203 Mio) + 50 %, plafond = pointe (284 Mio) x 2,7.
        # Avant : 7000 Mio de plafond, une fuite du Hub pouvait avaler ovh-prod et tout ce qui y tourne.
        memory     = 320
        memory_max = 768
      }
    }
  }
}
