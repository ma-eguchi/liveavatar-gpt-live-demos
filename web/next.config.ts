import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

const nextConfig: NextConfig = {
  // The wire protocol lives in ../shared (imported by both this app and the
  // orchestrator), so the bundler's root is the monorepo, not web/.
  turbopack: { root: fileURLToPath(new URL("..", import.meta.url)) },
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // The mic is the product; nothing else gets device access.
          { key: "Permissions-Policy", value: "microphone=(self), camera=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
