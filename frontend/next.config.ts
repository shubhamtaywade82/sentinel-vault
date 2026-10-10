import type { NextConfig } from "next";

// The Rails API owns every /api/v1 route. Not a secret: a URL, defaulting to
// the API's local dev port.
const VAULT_API_URL = process.env.VAULT_API_URL ?? "http://localhost:4781";

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
  async rewrites() {
    return {
      // beforeFiles wins over the legacy route handlers in src/app/api, so the
      // browser keeps same-origin URLs while Rails answers every request.
      beforeFiles: [{ source: "/api/v1/:path*", destination: `${VAULT_API_URL}/api/v1/:path*` }],
      afterFiles: [],
      fallback: [],
    };
  },
};

export default nextConfig;
