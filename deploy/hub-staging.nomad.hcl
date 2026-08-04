# hub-staging — stack Next.js hub (staging) sur ovh-dev, servie via l'ingress bastion.
# Privé Tailscale : middleware internal-only (ipAllowList 100.64/10) → 403 hors tailnet.
#
# ⚠️ DB : plus de postgres co-localisé. La DB `hub` vit désormais dans le cluster
# Patroni HA `hub-staging-db` (3 nœuds, DCS Consul — jobs/hub-staging-db.nomad.hcl).
# L'app se connecte au LEADER dynamique via un sidecar HAProxy (task "pgproxy") :
#   HAProxy interroge l'API Patroni REST (GET /master sur :8010) de chaque nœud et
#   ne route le trafic PG que vers celui qui répond 200 = le primaire courant.
#   → l'app garde DATABASE_URL=...@127.0.0.1:5432/... (inchangé) ; sur failover,
#     HAProxy bascule vers le nouveau leader (shutdown-sessions coupe les conns
#     vers l'ancien → le pool Prisma reconnecte). Pattern driver-agnostic
#     (Prisma ne supporte pas le multi-host libpq target_session_attrs).
#
# Rollback DB co-localisée : ~/nomad-veridian/jobs/hub-staging.nomad.hcl.rollback
# Secrets = Nomad var nomad/jobs/hub-staging (env réels du container staging dev).
#
# SOURCE DE VÉRITÉ GITOPS (dans CE repo). La CI injecte var image_tag
# (staging-<sha7>) puis `nomad job plan`→`run`. Canon : Prospection deploy/README.md.

variable "image_tag" {
  type        = string
  description = "Tag de l'image ghcr.io/christ-roy/veridian-hub staging (injecté par la CI ; défaut staging-latest)."
  default     = "staging-latest"
}

job "hub-staging" {
  datacenters = ["veridian-eu"]
  type        = "service"

  group "stack" {
    count = 1

    # Le routeur permanent Sablier de l'ingress pointe sur le port fixe 19096.
    # Cette meta autorise Sablier à endormir/réveiller uniquement l'app.
    meta = { "sablier.enable" = "true" }

    # Stratégie de déploiement (canon Prospection). healthy_deadline large
    # (1er pull image sans cache) + auto_revert (restaure la dernière version
    # saine si le deploy n'atteint jamais healthy).
    update {
      healthy_deadline  = "15m"
      progress_deadline = "20m"
      min_healthy_time  = "15s"
      auto_revert       = true
    }

    # Épinglé à ovh-dev (là où tournait la stack ; DB désormais dans le cluster Patroni).
    constraint {
      attribute = "${meta.provider}"
      value     = "ovh-dev"
    }

    restart {
      attempts = 10
      interval = "10m"
      delay    = "15s"
      mode     = "delay"
    }

    network {
      mode = "bridge"
      # host_network tailscale : le port CNI bind sur l'IP Tailscale du nœud uniquement
      # → app injoignable en public (bypass ipAllowList impossible), Traefik route via Tailscale.
      port "http" {
        static       = 19096
        to           = 3000
        host_network = "tailscale"
      }
    }

    service {
      name     = "hub-staging"
      provider = "nomad"
      port     = "http"
      # Le routing vit dans ingress.nomad.hcl avec un service @file permanent.
      # Un second routeur @nomad contournerait Sablier et recréerait du drift.
      tags = ["traefik.enable=false"]
      check {
        type     = "http"
        path     = "/api/health"
        interval = "5s"
        timeout  = "5s"
      }
    }

    # ---- pgproxy (HAProxy sidecar → toujours le LEADER Patroni) ----
    # Écoute 127.0.0.1:5432 dans le netns du groupe ; l'app tape localhost:5432.
    task "pgproxy" {
      driver = "docker"
      config {
        image   = "haproxy:3.0-alpine"
        command = "haproxy"
        args    = ["-f", "/local/haproxy.cfg"]
      }
      template {
        destination = "local/haproxy.cfg"
        change_mode = "restart"
        data        = <<EOH
global
    maxconn 200
    log stdout format raw local0 info

defaults
    log global
    mode tcp
    option tcplog
    retries 2
    timeout connect 5s
    timeout client 30m
    timeout server 30m
    timeout check 5s

# Route PG vers le seul nœud dont l'API Patroni répond 200 sur /master = le primaire.
# on-marked-down shutdown-sessions : sur bascule, coupe les conns vers l'ex-leader
# → le pool applicatif reconnecte et retombe sur le nouveau primaire.
listen postgres-primary
    bind 127.0.0.1:5432
    option httpchk GET /master
    http-check expect status 200
    default-server inter 3s fall 2 rise 2 on-marked-down shutdown-sessions
    server patroni-contabo 100.108.136.89:5433 check port 8010
    server patroni-ovhprod 100.88.202.29:5433  check port 8010
    server patroni-ovhdev  100.92.215.42:5433  check port 8010
EOH
      }
      resources {
        cpu    = 100
        memory = 64
      }
    }

    # ---- hub (Next.js, port 3000) ----
    task "hub" {
      driver = "docker"
      config {
        image = "ghcr.io/christ-roy/veridian-hub:${var.image_tag}"
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
DEPLOY_ENV=staging
OAUTH_TEST_PROVIDER=true
ADMIN_EMAILS=brunon5robert@gmail.com,robert.brunon@veridian.site

AUTH_URL=https://hub.staging.veridian.site
NEXTAUTH_URL=https://hub.staging.veridian.site
NEXT_PUBLIC_SITE_URL=https://hub.staging.veridian.site
DASHBOARD_SITE_URL=https://hub.staging.veridian.site
DOMAIN=hub.staging.veridian.site
LANDING_ORIGIN=https://veridian.site

NEXT_PUBLIC_NOTIFUSE_URL=https://notifuse.staging.veridian.site
NEXT_PUBLIC_NOTIFUSE_API_URL=https://notifuse.staging.veridian.site/api/v1
NOTIFUSE_API_URL=https://notifuse.staging.veridian.site
NOTIFUSE_API_ENDPOINT=https://notifuse.staging.veridian.site

NEXT_PUBLIC_PROSPECTION_URL=https://prospection.staging.veridian.site
PROSPECTION_API_URL=https://prospection.staging.veridian.site
PROSPECTION_INTERNAL_URL=https://prospection.staging.veridian.site

ANALYTICS_API_URL=https://analytics-engine.staging.veridian.site
CRM_METADATA_URL=https://crm.staging.veridian.site/metadata
CRM_REST_URL=https://crm.staging.veridian.site/rest
CRM_FRONTEND_URL=https://crm.staging.veridian.site

{{ with nomadVar "nomad/jobs/hub-staging" }}
# DB → sidecar HAProxy (127.0.0.1:5432) qui pointe le LEADER Patroni courant.
DATABASE_URL=postgresql://hub:{{ .HUB_DB_PASSWORD }}@127.0.0.1:5432/hub?schema=hub_app
AUTH_SECRET={{ .AUTH_SECRET }}
ADMIN_SECRET={{ .ADMIN_SECRET }}
CRON_SECRET={{ .CRON_SECRET }}
VAULT_ENC_KEY={{ .VAULT_ENC_KEY }}
CRM_VAULT_KEY={{ .CRM_VAULT_KEY }}
SESSION_HINT_SECRET={{ .SESSION_HINT_SECRET }}
E2E_RATELIMIT_BYPASS_SECRET={{ .E2E_RATELIMIT_BYPASS_SECRET }}
GOOGLE_MAIL_CLIENT_ID={{ .GOOGLE_MAIL_CLIENT_ID }}
GOOGLE_MAIL_CLIENT_SECRET={{ .GOOGLE_MAIL_CLIENT_SECRET }}
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY={{ .STRIPE_PUBLISHABLE_KEY_TEST }}
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY_LIVE={{ .STRIPE_PUBLISHABLE_KEY_TEST }}
STRIPE_SECRET_KEY={{ .STRIPE_SECRET_KEY_TEST }}
STRIPE_SECRET_KEY_LIVE={{ .STRIPE_SECRET_KEY_TEST }}
STRIPE_WEBHOOK_SECRET={{ .STRIPE_WEBHOOK_SECRET_TEST }}
STRIPE_WEBHOOK_SECRET_LIVE={{ .STRIPE_WEBHOOK_SECRET_TEST }}
STRIPE_REFILL_PRODUCT_ID_TEST={{ .STRIPE_REFILL_PRODUCT_ID_TEST }}
NOTIFUSE_SECRET_KEY={{ .NOTIFUSE_SECRET_KEY }}
NOTIFUSE_ROOT_EMAIL={{ .NOTIFUSE_ROOT_EMAIL }}
NOTIFUSE_HUB_API_SECRET={{ .NOTIFUSE_HUB_API_SECRET }}
NOTIFUSE_HUB_WEBHOOK_SECRET={{ .NOTIFUSE_HUB_WEBHOOK_SECRET }}
NOTIFUSE_WEBHOOK_TOKEN={{ .NOTIFUSE_WEBHOOK_TOKEN }}
PROSPECTION_TENANT_API_SECRET={{ .PROSPECTION_TENANT_API_SECRET }}
PROSPECTION_WEBHOOK_TOKEN={{ .PROSPECTION_WEBHOOK_TOKEN }}
ANALYTICS_HUB_API_SECRET={{ .ANALYTICS_HUB_API_SECRET }}
HUB_INVITATION_SECRET_ANALYTICS={{ .HUB_INVITATION_SECRET_ANALYTICS }}
HUB_INVITATION_SECRET_CMS={{ .HUB_INVITATION_SECRET_CMS }}
HUB_INVITATION_SECRET_NOTIFUSE={{ .HUB_INVITATION_SECRET_NOTIFUSE }}
HUB_INVITATION_SECRET_PROSPECTION={{ .HUB_INVITATION_SECRET_PROSPECTION }}
{{ end }}
EOH
      }
      resources {
        cpu    = 400
        memory = 600
      }
    }
  }
}
