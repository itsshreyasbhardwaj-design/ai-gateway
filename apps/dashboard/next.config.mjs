/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The shared UI package is consumed as TypeScript source rather than built
  // output, so Next compiles it alongside the app.
  transpilePackages: ['@ai-gateway/ui'],
  // Workspace packages resolve through pnpm symlinks; tracing the monorepo root
  // keeps standalone output complete.
  outputFileTracingRoot: new URL('../../', import.meta.url).pathname,
  eslint: { ignoreDuringBuilds: true },
  poweredByHeader: false,
  output: 'standalone',
};

export default nextConfig;
