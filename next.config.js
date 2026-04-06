/** @type {import('next').NextConfig} */
const nextConfig = {
  // Enable standalone output for Docker
  output: 'standalone',

  // Image optimization
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**',
      },
    ],
  },

  // Disable static optimization during build
  // This prevents Next.js from trying to pre-render pages that call Twenty/Notifuse APIs
  // Those pages will be rendered on-demand (SSR) instead
  experimental: {
    missingSuspenseWithCSRBailout: false,
  },

  // Allow cross-origin requests in dev mode (behind Traefik reverse proxy)
  allowedDevOrigins: ['https://dev.veridian.site'],

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
