# hub-db.nomad.hcl — PostgreSQL PROD stateful du Hub.
#
# Ce job existe pour découpler le volume PostgreSQL local du job applicatif Hub.
# Il garde EXACTEMENT la même donnée et les mêmes secrets que l'ancien job
# co-localisé : volume /opt/veridian-lab/hub/core-db, user/db veridian,
# Nomad Variable nomad/jobs/hub, clé VERIDIAN_CORE_DB_PASSWORD.
#
# Cutover requis : ne jamais lancer ce job tant que l'ancien job `hub` contient
# encore la task `veridian-core-db`, sinon deux postgres peuvent monter le même
# volume. Voir deploy/README.md § cutover.

job "hub-db" {
  datacenters = ["veridian-eu"]
  type        = "service"
  priority    = 80

  group "db" {
    count = 1

    # Le volume est local à ovh-prod. Pas de reschedule : le disque ne suit pas.
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
      port "db" {
        static       = 5432
        to           = 5432
        host_network = "tailscale"
      }
    }

    service {
      name     = "hub-db"
      provider = "nomad"
      port     = "db"
      tags     = ["traefik.enable=false"]

      check {
        type     = "tcp"
        interval = "10s"
        timeout  = "2s"
      }
    }

    task "veridian-core-db" {
      driver         = "docker"
      shutdown_delay = "10s"
      kill_timeout   = "30s"

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
        # p99 CPU 30 j = 7 MHz ; pic mémoire = 55 MiB.
        cpu        = 100
        memory     = 256
        memory_max = 512
      }
    }
  }
}
