const path = require('path');

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Enable standalone output for Docker
  output: 'standalone',

  // Image optimization — WHITELIST STRICTE pour bloquer SSRF (CVE-2024-34351)
  // et abuse de bande passante via /_next/image?url=<anything>.
  //
  // Avant 2026-05-20 : `hostname: '**'` = catastrophe sécu (wildcard total).
  // Maintenant : on whitelist UNIQUEMENT les hostnames vraiment utilisés.
  // Si on ajoute un nouveau provider d'avatars (ex. Microsoft Graph), il
  // faudra l'ajouter explicitement ici. Le `<Image>` avec un hostname non-
  // whitelisté retourne 400.
  images: {
    remotePatterns: [
      // Avatars Google OAuth (User.image après login Google)
      { protocol: 'https', hostname: 'lh3.googleusercontent.com' },
      // Avatars Microsoft Graph (futur — pas utilisé actuellement mais
      // l'OAuth Microsoft retourne potentiellement une URL ici)
      { protocol: 'https', hostname: 'graph.microsoft.com' },
      // Assets internes Veridian (CDN futur, logos, etc.)
      { protocol: 'https', hostname: 'cdn.veridian.site' },
      { protocol: 'https', hostname: 'assets.internal.veridian.site' },
    ],
    // Sert les images Next-optimisées avec Content-Disposition: attachment
    // → empêche le rendu inline de fichiers non-image qui auraient passé
    // les filtres (défense en profondeur).
    contentDispositionType: 'attachment',
    // CSP minimaliste pour les images servies par /_next/image : interdit
    // toute action active (script, frame). Cf. doc Next.js sur image security.
    contentSecurityPolicy: "default-src 'none'; script-src 'none'; sandbox;",
  },

  // Allow cross-origin requests in dev mode (behind Traefik reverse proxy)
  allowedDevOrigins: ['https://dev.veridian.site'],

  // Routes auth dépréciées — anciennement des pages stub `redirect('/login')`.
  // Supprimées au profit de redirects 308 gérés par Next (pas de bundle React
  // pour 4 lignes de redirect). /login reste l'entrée canonique d'auth.
  async redirects() {
    return [
      { source: '/signin', destination: '/login', permanent: true },
      { source: '/signin1', destination: '/login', permanent: true },
      // /docs (anciennement page vitrine du Hub, indexée) → site vitrine.
      // 301 pour transférer le jus SEO vers veridian.site. Le Hub n'héberge
      // plus de doc publique.
      { source: '/docs', destination: 'https://veridian.site', permanent: true },
      { source: '/docs/:path*', destination: 'https://veridian.site', permanent: true },
    ];
  },

  // Skip type checking and linting during build for faster builds
  // Type checking should be done in CI/CD
  typescript: {
    ignoreBuildErrors: false, // Keep type checking enabled for safety
  },
  eslint: {
    ignoreDuringBuilds: true, // Skip ESLint during builds
  },

  // Webpack config
  webpack: (config, { dev, isServer }) => {
    // Alias @veridian/shared → ./shared/shared/index.ts (Git submodule veridian-infra).
    // Le tsconfig paths ne suffit pas car le bundling Next se fait via webpack
    // qui doit savoir résoudre l'alias en runtime (pas juste typecheck).
    config.resolve.alias = {
      ...(config.resolve.alias || {}),
      '@veridian/shared': path.resolve(__dirname, 'shared/shared/index.ts'),
    };

    // Remove console.* calls in production
    if (!dev && !isServer) {
      config.optimization = {
        ...config.optimization,
        minimize: true,
        minimizer: config.optimization.minimizer.map((plugin) => {
          if (plugin.constructor.name === 'TerserPlugin') {
            return new plugin.constructor({
              ...plugin.options,
              terserOptions: {
                ...plugin.options.terserOptions,
                compress: {
                  ...plugin.options.terserOptions?.compress,
                  drop_console: true, // Remove all console.* in production
                },
              },
            });
          }
          return plugin;
        }),
      };
    }
    return config;
  },
};

module.exports = nextConfig;
