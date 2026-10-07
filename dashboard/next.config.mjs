/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Keep framework diagnostics in the terminal without exposing the
  // development indicator in the product UI.
  devIndicators: false,
  // Every page reflects live sheet state; nothing here is cacheable.
  experimental: { staleTimes: { dynamic: 0, static: 0 } },
};
export default nextConfig;
