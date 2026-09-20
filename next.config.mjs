/**
 * Next.js 14 configuration.
 *
 * Note: Next 14 requires `next.config.js`/`.mjs` (a `next.config.ts` is a Next 15
 * feature and makes `next lint`/`next build` throw).
 */

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // `postgres` and `pdf-lib` are Node-only; keep them out of the bundler's
  // special-casing so the Route Handlers run them on the Node.js runtime.
  experimental: {
    serverComponentsExternalPackages: ['postgres', 'pdf-lib'],
    serverActions: {
      bodySizeLimit: '25mb',
    },
  },
  eslint: {
    dirs: ['app', 'components', 'lib', 'db', 'services', 'worker', 'scripts', 'tests'],
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
