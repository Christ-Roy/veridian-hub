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
# base pg-saas (depuis le 09/11/2026) : un déploiement ne touche pas la base.
# Le contrat runtime ne hardcode plus l'URL complète : `DATABASE_URL` est
# composée depuis les variables d'endpoint `HUB_DATABASE_*` et le secret
# `PG_SAAS_PASSWORD` (pg-saas, plan §21).
# Demain, le cutover HA remplace seulement l'endpoint (`HUB_DATABASE_MODE`,
# `HUB_DATABASE_SERVICE_NAME`, host/port ou proxy) sans changer le code Hub.
# TLS terminé par Traefik (certresolver letsencrypt sur app.veridian.site).
# Secrets = Nomad Variable nomad/jobs/hub (JAMAIS en clair).
# ⚠️ Stripe LIVE en prod (clés dans la Nomad var).
#
# Base : grappe pg-saas (Patroni, plan nomad-veridian §21). L'ancienne base hub-db est purgée (09/11/2026).

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

    # Épinglé au serveur PROD : l'entrée pg-saas 172.26.64.1 (pont Nomad) y vit.
    constraint {
      attribute = "${meta.provider}"
      value     = "ovh-prod"
    }

    restart {
      attempts = 10
      interval = "10m"
      # 2 s (et non 15) : retour servi après un plantage en ~6 s, mesuré sur le CMS le 09/11 (26 s avant).
      delay    = "2s"
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
# Academy (e-learning) : même contrat que le CRM, app réservée aux comptes activés (Robert, 22/11).
ACADEMY_API_URL=https://academy.app.veridian.site
# Atelier « Mon IA » (moteur abonnement) : comptes autorisés, Robert seul tant qu'Anthropic n'a pas confirmé par
# écrit (docs/MON-IA.md). Son adresse est lue dans local/atelier-url (template à part, sans redémarrage du Hub).
ATELIER_URL_FICHIER=/local/atelier-url
# Abonnement ouvert par tenant (hub ia atelier ouvrir) ; plafond de tenants ouverts, 1 faute d'isolation par processus.
ATELIER_CAPACITE=1
{{ with nomadVar "nomad/jobs/hub" }}
# Base du Hub : pg-saas (grappe Patroni, entree 172.26.64.1:15432, base hub, role hub). Migration du 09/11/2026 (plan §21).
# DATABASE_URL composee depuis HUB_DATABASE_* (defauts = pg-saas) : une bascule change une cle, pas ce fichier.
{{ $dbMode := or .HUB_DATABASE_MODE.Value "pg-saas" }}
{{ $dbUser := or .HUB_DATABASE_USER.Value "hub" }}
{{ $dbHost := or .HUB_DATABASE_HOST.Value "172.26.64.1" }}
{{ $dbPort := or .HUB_DATABASE_PORT.Value "15432" }}
{{ $dbName := or .HUB_DATABASE_NAME.Value "hub" }}
{{ $dbSchema := or .HUB_DATABASE_SCHEMA.Value "hub_app" }}
HUB_DATABASE_MODE={{ $dbMode }}
HUB_DATABASE_USER={{ $dbUser }}
HUB_DATABASE_HOST={{ $dbHost }}
HUB_DATABASE_PORT={{ $dbPort }}
HUB_DATABASE_NAME={{ $dbName }}
HUB_DATABASE_SCHEMA={{ $dbSchema }}
DATABASE_URL=postgresql://{{ $dbUser }}:{{ .PG_SAAS_PASSWORD }}@{{ $dbHost }}:{{ $dbPort }}/{{ $dbName }}?schema={{ $dbSchema }}
# Flow d'essai réel : allumé (go de Robert). Défaut 1 si la clé est absente ; 0 coupe.
# Couper : nomad/jobs/hub TRIAL_MACHINE_ENABLED=0 (bloc complet, stdin, -check-index), puis rendre le job.
TRIAL_MACHINE_ENABLED={{ or .TRIAL_MACHINE_ENABLED.Value "1" }}
AUTH_SECRET={{ .HUB_AUTH_SECRET }}
ADMIN_SECRET={{ .ADMIN_SECRET }}
CRON_SECRET={{ .CRON_SECRET }}
VAULT_ENC_KEY={{ .VAULT_ENC_KEY }}
{{ with nomadVar "nomad/jobs/hub/stack" }}CRM_HUB_API_SECRET={{ .CRM_HUB_API_SECRET }}{{ end }}
{{ with .ACADEMY_HUB_API_SECRET }}ACADEMY_HUB_API_SECRET={{ .Value }}{{ end }}
{{ with .ATELIER_SECRET }}ATELIER_SECRET={{ .Value }}{{ end }}
SESSION_HINT_SECRET={{ .SESSION_HINT_SECRET }}
GOOGLE_OAUTH_CLIENT_ID={{ .GOOGLE_OAUTH_CLIENT_ID }}
GOOGLE_OAUTH_CLIENT_SECRET={{ .GOOGLE_OAUTH_CLIENT_SECRET }}
MICROSOFT_OAUTH_CLIENT_ID={{ .MICROSOFT_OAUTH_CLIENT_ID }}
MICROSOFT_OAUTH_CLIENT_SECRET={{ .MICROSOFT_OAUTH_CLIENT_SECRET }}
TELEGRAM_BOT_TOKEN={{ .TELEGRAM_BOT_TOKEN }}
ALERT_CHAT_ID={{ .ALERT_CHAT_ID }}
ANALYTICS_TRACK_KEY={{ .ANALYTICS_TRACK_KEY }}
MCP_SIGNING_JWK={{ .MCP_SIGNING_JWK }}
GOOGLE_MAIL_CLIENT_ID={{ .GOOGLE_MAIL_CLIENT_ID }}
GOOGLE_MAIL_CLIENT_SECRET={{ .GOOGLE_MAIL_CLIENT_SECRET }}
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY={{ .STRIPE_PUBLISHABLE_KEY_LIVE }}
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY_LIVE={{ .STRIPE_PUBLISHABLE_KEY_LIVE }}
STRIPE_SECRET_KEY={{ .STRIPE_SECRET_KEY_LIVE }}
STRIPE_SECRET_KEY_LIVE={{ .STRIPE_SECRET_KEY_LIVE }}
STRIPE_WEBHOOK_SECRET={{ .STRIPE_WEBHOOK_SECRET_LIVE }}
STRIPE_WEBHOOK_SECRET_LIVE={{ .STRIPE_WEBHOOK_SECRET_LIVE }}
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
      # Adresse de l'atelier, relue à chaque appel : un redéploiement de l'atelier ne relance jamais le Hub.
      template {
        destination = "local/atelier-url"
        change_mode = "noop"
        data        = "{{ range nomadService \"hub-atelier\" }}http://{{ .Address }}:{{ .Port }}{{ end }}"
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
  # ---- atelier « Mon IA » (docs/MON-IA.md) : le binaire officiel Claude Code pour chaque client connecté avec
  # son abonnement. Même image que le Hub, autre point d'entrée. Groupe à part : volume durable (la connexion de
  # chaque client, rangée par le binaire, survit aux déploiements) et aucun secret du Hub dans son environnement.
  # Le binaire n'a aucun outil intégré et ne sort que par le proxy à liste blanche (Anthropic seulement).
  group "atelier" {
    count = 1

    # Sonde de sortie (ADR-033) : une allocation en échec est replacée vite, sans fin (défaut Nomad : 30 s puis
    # tentatives bornées). Gabarit des relais mail, éprouvé sur dragonair.
    reschedule {
      delay          = "10s"
      delay_function = "exponential"
      max_delay      = "10m"
      unlimited      = true
    }

    update {
      max_parallel     = 1
      min_healthy_time = "10s"
      healthy_deadline = "5m"
      auto_revert      = true
    }

    # Sur rise, à l'écart de la prod du Hub : le volume hub-atelier y vit (nomad-veridian
    # nodes/volumes/hub-atelier.volume.hcl, 0700, propriétaire 1001:1001 = nextjs:nodejs).
    constraint {
      attribute = "${node.unique.name}"
      value     = "veridian-rise-01"
    }

    volume "hub-atelier" {
      type            = "host"
      source          = "hub-atelier"
      access_mode     = "single-node-single-writer"
      attachment_mode = "file-system"
    }

    # Réseau CNI dédié « atelier » (pont atelier0, 172.31.250.0/24, nomad-veridian nodes/atelier/) : le pare-feu
    # nftables veridian_atelier de rise n'y laisse sortir que DNS 1.1.1.1/9.9.9.9, le HTTPS public (Anthropic est
    # derrière un CDN ; la liste par nom, c'est hub-atelier-proxy) et le Hub sur ses ports dynamiques ; en entrée,
    # seuls le Hub et l'hôte (check de santé). Prouvé par l'infra le 22/11, 14 cas sur 14.
    network {
      mode = "cni/atelier"
      port "atelier" {
        to           = 3100
        host_network = "tailscale"
      }
      # Le résolveur de rise (127.0.0.53) est injoignable depuis le conteneur, et le pare-feu n'autorise que ces deux-là.
      dns {
        servers = ["1.1.1.1", "9.9.9.9"]
      }
    }

    service {
      name     = "hub-atelier"
      provider = "nomad"
      port     = "atelier"
      tags     = ["traefik.enable=false"]
      check {
        type     = "http"
        path     = "/sante"
        interval = "15s"
        timeout  = "5s"
      }
    }

    task "hub-atelier" {
      driver = "docker"
      user   = "nextjs"
      config {
        image           = "ghcr.io/christ-roy/veridian-hub:${var.image_tag}"
        init            = true
        ports           = ["atelier"]
        command         = "node"
        args            = ["/opt/atelier/serveur.mjs"]
        security_opt    = ["no-new-privileges:true"]
        readonly_rootfs = true
        cap_drop        = ["ALL"]
        labels = {
          "site.veridian.job"   = "${NOMAD_JOB_NAME}"
          "site.veridian.group" = "${NOMAD_GROUP_NAME}"
          "site.veridian.task"  = "${NOMAD_TASK_NAME}"
          "site.veridian.node"  = "${node.unique.name}"
          "site.veridian.tier"  = "saas-prod"
          "site.veridian.app"   = "hub-atelier"
        }
        mount {
          type     = "tmpfs"
          target   = "/tmp"
          readonly = false
          tmpfs_options { size = 134217728 }
        }
      }
      volume_mount {
        volume      = "hub-atelier"
        destination = "/data/atelier"
      }
      template {
        destination = "secrets/atelier.env"
        perms       = "600"
        env         = true
        change_mode = "restart"
        data        = <<EOH
NODE_ENV=production
ATELIER_PORT=3100
ATELIER_DONNEES=/data/atelier
ATELIER_PROXY=http://127.0.0.1:3128
# Fusible de capacité : un client par atelier (pas d'enfermement par processus sur nos nœuds, docs/MON-IA.md).
ATELIER_CLIENTS_MAX=1
ATELIER_HUB_URL_FICHIER=/local/hub-url
{{ with nomadVar "nomad/jobs/hub" }}{{ with .ATELIER_SECRET }}ATELIER_SECRET={{ .Value }}{{ end }}{{ end }}
EOH
      }
      # Adresse interne du Hub, relue à chaque appel : un déploiement du Hub ne relance pas l'atelier. Pendant un
      # bleu-vert, deux instances : une par ligne, l'atelier prend la première qui répond.
      template {
        destination = "local/hub-url"
        change_mode = "noop"
        data        = "{{ range nomadService \"hub\" }}http://{{ .Address }}:{{ .Port }}\n{{ end }}"
      }
      resources {
        cpu        = 300
        # ~150 Mio par tour actif (binaire mesuré au repos le 22/11), 4 tours simultanés au plus (atelier/regles.mjs).
        memory     = 256
        memory_max = 1024
      }
    }

    # Proxy de sortie (atelier/proxy.mjs) : seuls api.anthropic.com, claude.ai, claude.com, platform.claude.com.
    task "hub-atelier-proxy" {
      driver = "docker"
      user   = "nextjs"
      lifecycle {
        hook    = "prestart"
        sidecar = true
      }
      config {
        image           = "ghcr.io/christ-roy/veridian-hub:${var.image_tag}"
        init            = true
        command         = "node"
        args            = ["/opt/atelier/proxy.mjs"]
        security_opt    = ["no-new-privileges:true"]
        readonly_rootfs = true
        cap_drop        = ["ALL"]
        labels = {
          "site.veridian.job"   = "${NOMAD_JOB_NAME}"
          "site.veridian.group" = "${NOMAD_GROUP_NAME}"
          "site.veridian.task"  = "${NOMAD_TASK_NAME}"
          "site.veridian.node"  = "${node.unique.name}"
          "site.veridian.tier"  = "saas-prod"
          "site.veridian.app"   = "hub-atelier"
        }
      }
      resources {
        cpu    = 50
        memory = 64
      }
    }

    # Sonde de sortie (ADR-033) : la sortie du réseau atelier perdue (règle CNI ou pare-feu), l'allocation échoue et
    # Nomad la replace avec un réseau neuf. Pas de tâche planifiée. DNS sur les deux résolveurs autorisés, deux échecs
    # consécutifs. Mêmes paramètres que les relais mail (éprouvés sur dragonair, plan/INFRA-CIBLE.md 4.1.6).
    task "hub-atelier-sonde-sortie" {
      driver = "docker"
      restart {
        attempts = 1
        interval = "10m"
        delay    = "5s"
        mode     = "fail"
      }
      config {
        image        = "busybox:1.36.1@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662"
        command      = "sh"
        args         = ["-c", "sleep 10; k=0; while :; do if timeout 3 nslookup -type=a one.one.one.one 1.1.1.1 >/dev/null 2>&1 || timeout 3 nslookup -type=a dns.quad9.net 9.9.9.9 >/dev/null 2>&1; then k=0; else k=$((k+1)); echo \"sortie KO ($k)\"; fi; [ $k -ge 2 ] && { echo 'sortie perdue : echec pour replanifier'; exit 1; }; sleep 5; done"]
        security_opt = ["no-new-privileges:true"]
        cap_drop     = ["ALL"]
        labels = {
          "site.veridian.job"   = "${NOMAD_JOB_NAME}"
          "site.veridian.group" = "${NOMAD_GROUP_NAME}"
          "site.veridian.task"  = "${NOMAD_TASK_NAME}"
          "site.veridian.node"  = "${node.unique.name}"
          "site.veridian.tier"  = "saas-prod"
          "site.veridian.app"   = "hub-atelier"
        }
      }
      resources {
        cpu        = 10
        memory     = 16
        memory_max = 32
      }
    }
  }
}
