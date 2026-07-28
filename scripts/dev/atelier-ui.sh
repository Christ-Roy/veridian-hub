#!/usr/bin/env bash
#
# Lance le dev server Next des ATELIERS UI (`/dev/*`) sur l'interface
# Tailscale du bastion, jamais sur 0.0.0.0.
#
#   ./scripts/dev/atelier-ui.sh          # port 3010 par défaut
#   PORT=3011 ./scripts/dev/atelier-ui.sh
#
# Pourquoi un bind explicite : sur ce bastion, 0.0.0.0 exposerait le port sur
# l'IP publique Contabo (eth0). On se lie donc à l'IP tailscale0 uniquement —
# seul le tailnet peut joindre l'atelier. Le script refuse de démarrer si
# Tailscale n'est pas up.
set -euo pipefail

cd "$(dirname "$0")/../.."

PORT="${PORT:-3010}"

TS_IP="$(tailscale ip -4 2>/dev/null | head -n1 || true)"
if [[ -z "$TS_IP" ]]; then
  echo "✗ Tailscale ne répond pas : impossible de déterminer l'IP du tailnet." >&2
  echo "  Vérifier 'tailscale status' avant de relancer." >&2
  exit 1
fi

# Fusible : ne jamais démarrer si NODE_ENV vaut production (les ateliers sont
# gardés côté app, mais on refuse même de servir l'app dans ce mode ici).
if [[ "${NODE_ENV:-}" == "production" ]]; then
  echo "✗ NODE_ENV=production : les ateliers UI ne tournent qu'en développement." >&2
  exit 1
fi

echo "→ Atelier UI Hub : http://${TS_IP}:${PORT}/dev/onboarding"
echo "  (bind sur l'interface Tailscale uniquement, pas sur l'IP publique)"
echo

exec pnpm exec next dev --turbo --hostname "$TS_IP" --port "$PORT"
