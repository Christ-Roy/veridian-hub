# hub.nomad.hcl — SOURCE DE VÉRITÉ GITOPS du déploiement PROD du Hub.
#
# App stateless uniquement. PostgreSQL PROD vit dans deploy/hub-db.nomad.hcl
# (job `hub-db`) sur le volume local ovh-prod /opt/veridian-lab/hub/core-db.
# La CI ne redémarre plus PostgreSQL pour un bump image ou un rightsizing app.
#
# Secrets = Nomad Variable nomad/jobs/hub (JAMAIS en clair). Stripe LIVE en prod.

variable "image_tag" {
  type        = string
  description = "Tag de l'image ghcr.io/christ-roy/veridian-hub promue en prod (injecté par la CI ; défaut latest)."
  default     = "latest"
}

job "hub" {
  datacenters = ["veridian-eu"]
  type        = "service"
  priority    = 80

  group "app" {
    count = 1

    # App stateless : un canary peut démarrer avant bascule, puis auto-revert si
    # le nouvel alloc ne devient pas healthy. Le migrate-on-boot Hub est
    # idempotent/advisory-lock côté Postgres.
    update {
      max_parallel      = 1
      canary            = 1
      auto_promote      = true
      min_healthy_time  = "15s"
      healthy_deadline  = "10m"
      progress_deadline = "15m"
      auto_revert       = true
    }

    restart {
      attempts = 10
      interval = "10m"
      delay    = "15s"
      mode     = "delay"
    }

    reschedule {
      delay          = "15s"
      delay_function = "exponential"
      max_delay      = "2m"
      unlimited      = true
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

    # Readiness DB avant migrate-on-boot. Le host est l'IP Tailscale ovh-prod :
    # la DB stateful est volontairement épinglée au même nœud que son volume.
    task "wait-for-db" {
      driver = "docker"

      lifecycle {
        hook    = "prestart"
        sidecar = false
      }

      config {
        image   = "postgres:16-alpine"
        command = "sh"
        args = [
          "-ec",
          "for i in $(seq 1 120); do pg_isready -h 100.88.202.29 -p 5432 -U veridian -d veridian && exit 0; sleep 2; done; echo 'hub-db not ready after 240s' >&2; exit 1",
        ]
      }

      resources {
        cpu    = 50
        memory = 64
      }
    }

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
DATABASE_URL=postgresql://veridian:{{ .VERIDIAN_CORE_DB_PASSWORD }}@100.88.202.29:5432/veridian?schema=hub_app&connect_timeout=10
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
        # p99 CPU 30 j = 35 MHz ; pic mémoire = 261 MiB.
        cpu        = 150
        memory     = 384
        memory_max = 512
      }
    }
  }
}
