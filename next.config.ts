import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // A stray lockfile in a parent dir makes Next pick the wrong root, which
  // nests standalone output and breaks `bun .next/standalone/server.js`.
  outputFileTracingRoot: __dirname,
  turbopack: { root: __dirname },
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
