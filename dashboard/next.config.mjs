/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Every page reflects live sheet state; nothing here is cacheable.
  experimental: { staleTimes: { dynamic: 0, static: 0 } },
};
export default nextConfig;
