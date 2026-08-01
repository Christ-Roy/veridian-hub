# hub.nomad.hcl — SOURCE DE VÉRITÉ GITOPS du déploiement PROD du Hub.
#
# Miroir versionné (dans CE repo) du job Nomad réellement déployé. La CI injecte
# le tag d'image promu (var image_tag) puis `nomad job plan`→`run`. Patron de
# référence : veridian-prospection/deploy/README.md (canon SSH-bastion Robert
# 2026-07-11). Adaptation Hub : cf deploy/README.md (migrate-on-boot, pas de step
# migrate CI).
#
# Veridian Hub (orchestrateur auth/billing/provisioning, Next.js, port 3000).
# Placement : serveur PROD OVH (provider=ovh-prod). DB = veridian-core-db
# (postgres:16-alpine) co-localisée dans le même group bridge → hub la joint en
# 127.0.0.1:5432 (schema hub_app). TLS terminé par Traefik (certresolver
# letsencrypt sur app.veridian.site). Secrets = Nomad Variable nomad/jobs/hub
# (JAMAIS en clair). ⚠️ Stripe LIVE en prod (clés dans la Nomad var).
#
# ⚠️ DB PROD mono-instance postgres:16, volume bind /opt/veridian-lab/hub/core-db.
# NE PAS reschedule (le volume local ne suit pas). Cible infra à terme = cluster
# Patroni HA (le staging l'a déjà, cf deploy/hub-staging.nomad.hcl).

variable "image_tag" {
  type        = string
  description = "Tag de l'image ghcr.io/christ-roy/veridian-hub promue en prod (injecté par la CI ; défaut latest)."
  default     = "latest"
}

job "hub" {
  datacenters = ["veridian-eu"]
  type        = "service"
  priority    = 80

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
      port "http" { to = 3000 }
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
        image = "postgres:16-alpine"
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
EOH
      }
      resources {
        cpu        = 300
        memory     = 256
        memory_max = 7000
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

ANALYTICS_API_URL=https://analytics-engine.app.veridian.site
CRM_METADATA_URL=https://crm.app.veridian.site/metadata
CRM_REST_URL=https://crm.app.veridian.site/rest
CRM_FRONTEND_URL=https://crm.app.veridian.site

{{ with nomadVar "nomad/jobs/hub" }}
DATABASE_URL=postgresql://veridian:{{ .VERIDIAN_CORE_DB_PASSWORD }}@127.0.0.1:5432/veridian?schema=hub_app
AUTH_SECRET={{ .HUB_AUTH_SECRET }}
ADMIN_SECRET={{ .ADMIN_SECRET }}
CRON_SECRET={{ .CRON_SECRET }}
VAULT_ENC_KEY={{ .VAULT_ENC_KEY }}
CRM_VAULT_KEY={{ .CRM_VAULT_KEY }}
SESSION_HINT_SECRET={{ .SESSION_HINT_SECRET }}
GOOGLE_OAUTH_CLIENT_ID={{ .GOOGLE_OAUTH_CLIENT_ID }}
GOOGLE_OAUTH_CLIENT_SECRET={{ .GOOGLE_OAUTH_CLIENT_SECRET }}
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
