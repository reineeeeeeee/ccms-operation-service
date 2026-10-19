// Operations (Transaction) is an API-only service: no pages, no static assets. The browser never calls it
// directly; every request arrives through ccms-api-gateway (/api/operations/* is forwarded here as /api/*).
/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['pg', 'typeorm'],
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
