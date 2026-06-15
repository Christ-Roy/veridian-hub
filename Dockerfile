# ============================================================================
# STAGE 1: Dependencies
# ============================================================================
FROM node:22-alpine AS deps

# Install dependencies needed for node-gyp
RUN apk add --no-cache libc6-compat

WORKDIR /app

# Copy package files + Prisma schema (needed by postinstall → prisma generate)
COPY package.json pnpm-lock.yaml* ./
COPY prisma ./prisma

# Install pnpm and dependencies
# --ignore-scripts blinde la supply chain : aucun postinstall malveillant
# d'un package npm bumped par Renovate ne s'exécutera ici.
# `prisma generate` est invoqué explicitement après l'install (nécessite
# prisma/schema.prisma déjà copié).
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm exec prisma generate

# ============================================================================
# STAGE 2: Builder
# ============================================================================
FROM node:22-alpine AS builder

WORKDIR /app

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Enable pnpm
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

# ============================================================================
# BUILD ARGUMENTS - RUNTIME CONFIGURATION
# ============================================================================
# NOUVELLE APPROCHE : Les variables NEXT_PUBLIC_* ne sont PLUS injectées au build-time
# Elles sont maintenant injectées au RUNTIME via docker-compose.
#
# AVANTAGES :
# ✅ Une seule image Docker pour tous les environnements (dev, staging, prod)
# ✅ Pas de rebuild pour changer d'environnement
# ✅ Pas de secrets dans les layers Docker
# ✅ Plus flexible pour les déploiements
#
# COMMENT ÇA MARCHE :
# 1. Le build Next.js se fait SANS variables d'environnement
# 2. Au démarrage du container, les variables sont injectées via ENV
# 3. L'endpoint /api/config expose ces variables au client
# 4. Le EnvProvider charge ces variables au runtime
#
# FALLBACK : Si les variables runtime ne sont pas disponibles, l'app utilise
# les valeurs de build-time (compatibilité avec l'ancien système)
# ============================================================================

# Build the application
# NOTE: No .env files copied - all variables injected at build/runtime via docker-compose
# This makes the image generic and reusable across environments (dev/prod/local)
ENV NEXT_TELEMETRY_DISABLED=1
# Disable SWC lockfile patching to avoid "Cannot read properties of undefined (reading 'os')" error
ENV NEXT_SKIP_NATIVE_POSTINSTALL=1
RUN pnpm run build

# ============================================================================
# STAGE 3: Runner (Production)
# ============================================================================
FROM node:22-alpine AS runner

WORKDIR /app

# Set production environment
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Note Trivy gate : node:22-alpine et node:24-alpine shippent un npm dont
# picomatch transitif est 4.0.3 (CVE-2026-33671 DoS regex). Pas patchable
# in-image sans casser npm (bug bump npm 10→11). Accepté via .trivyignore :
# - npm n'est pas exécuté au runtime du container Next.js
# - C'est un DoS regex via extglob, pas une RCE / auth bypass
# - Upstream Node devra bump le npm bundled

# Patch les paquets OS Alpine (openssl/libcrypto3/libssl3, etc.) sans attendre
# que l'image node:22-alpine officielle rebuild. Sans ça, l'image hérite des
# CVE OS publiées entre deux releases Node (ex CVE-2026-45447 openssl HIGH,
# fixée en 3.5.7-r0) → le gate Trivy `CRIT/HIGH bloquant` bloque le deploy prod.
RUN apk upgrade --no-cache

# Create a non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy built application from builder
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/scripts ./scripts

# Prisma schema + migrations + config → nécessaires pour `prisma migrate deploy`
# au boot du container (cf. CMD). Le standalone Next.js ne les embarque pas.
# `prisma.config.ts` (Prisma 7) déclare le schema, le chemin migrations et lit
# DATABASE_URL depuis l'env — chargé nativement par le CLI prisma (loader TS
# bundlé, pas besoin de tsx au runtime).
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts

# Install runtime dependencies for init-stripe script + prisma migrate-on-boot.
# These are needed because init-stripe.mjs and `prisma migrate deploy` run before
# Next.js and aren't in the standalone bundle.
# Install in /tmp then merge with standalone's node_modules (overwrites are OK - standalone doesn't need these)
#
# `prisma` (CLI) + `dotenv` (importé par prisma.config.ts) permettent d'appliquer
# les migrations Prisma au démarrage (cf. CMD). Empreinte ~225 Mo (le CLI prisma 7
# embarque @prisma/engines + son loader de config). Pinné sur la même version que
# le devDep du package.json (prisma ^7.7.0) — bumper les deux ensemble.
RUN echo '{"type":"module"}' > /tmp/package.json && \
    cd /tmp && \
    npm install --omit=dev --no-package-lock \
      stripe@14.25.0 \
      @supabase/supabase-js@2.43.4 \
      prisma@7.7.0 \
      dotenv@17.2.3 && \
    mkdir -p /app/node_modules && \
    cp -r /tmp/node_modules/* /app/node_modules/ && \
    rm -rf /tmp/node_modules /tmp/package.json

# Set correct permissions
RUN chown -R nextjs:nodejs /app

# Switch to non-root user
USER nextjs

# Expose port 3000
EXPOSE 3000

# Set hostname to listen on all interfaces (required for Docker)
ENV HOSTNAME="0.0.0.0"
ENV PORT=3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start the application : migrations Prisma au boot → init Stripe → serveur Next.
#
# `prisma migrate deploy` :
#   - IDEMPOTENT : n'applique que les migrations manquantes (compare au
#     _prisma_migrations de la DB), exit 0 si tout est déjà appliqué.
#   - FAIL FAST : si une migration échoue (ou DB injoignable), exit non-zero →
#     le `&&` court-circuite, server.js NE démarre PAS. Mieux qu'un 500
#     silencieux sur table inexistante (cf. incident réconciliateur 2026-06-15,
#     todo/done/2026-06-15-staging-migrations-prisma-non-appliquees.md).
#   - CONCURRENCE : Prisma pose un advisory lock Postgres (pg_advisory_lock)
#     avant d'appliquer → si plusieurs replicas démarrent en parallèle, un seul
#     applique, les autres attendent puis voient "no pending". Safe au scale.
#   - Lit DATABASE_URL via prisma.config.ts (Prisma 7) — même URL que le runtime.
CMD ["sh", "-c", "node node_modules/prisma/build/index.js migrate deploy && node scripts/init-stripe.mjs && node server.js"]

# ============================================================================
# STAGE 4: Development (with hot reload)
# ============================================================================
FROM node:22-alpine AS dev

WORKDIR /app

# Install dependencies for node-gyp and wget for healthcheck
RUN apk add --no-cache libc6-compat wget

# Enable pnpm
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

# Copy package files and install dependencies in the image
# This avoids reinstalling everything on every container start
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile

# Set development environment
ENV NODE_ENV=development
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME="0.0.0.0"
ENV PORT=3000

# Expose port 3000
EXPOSE 3000

# Health check adapted for dev (more permissive)
# - start-period: 2 minutes to allow for initial setup
# - retries: 5 to be more tolerant during dev restarts
HEALTHCHECK --interval=30s --timeout=10s --start-period=2m --retries=5 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1

# Start in dev mode with hot reload + Stripe init + Dev user seed
# The source code will be mounted as a volume
# Only install new dependencies if package.json changed (--prefer-offline is fast)
#
# Workflow:
# 1. Install dependencies (if package.json changed)
# 2. Initialize Stripe products (sync to Supabase)
# 3. Start Next.js dev server in background
# 4. Seed dev user + provision tenants (waits for server to be ready)
# 5. Bring server to foreground (keeps container alive)
CMD ["sh", "-c", "\
  pnpm install --prefer-offline && \
  node scripts/init-stripe.mjs && \
  echo '🚀 Starting Next.js dev server...' && \
  pnpm dev & \
  SERVER_PID=$! && \
  echo '⏳ Waiting 5s for server to initialize...' && \
  sleep 5 && \
  echo '🌱 Seeding dev user...' && \
  node scripts/dev/seed-dev-user.mjs && \
  echo '✅ Dev environment ready!' && \
  wait $SERVER_PID \
"]
