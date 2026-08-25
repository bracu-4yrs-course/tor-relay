import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  reactStrictMode: false,

  // Hide the fact that this is a Next.js app from anyone probing headers.
  poweredByHeader: false,

  // Strip source maps in production — no leaked server code, no leaked
  // route paths in stack traces available to browser DevTools.
  productionBrowserSourceMaps: false,

  // Custom headers to harden the surface area.
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Download-Options", value: "noopen" },
          { key: "Referrer-Policy", value: "no-referrer" },
          // Don't let this site be embedded in iframes (clickjacking)
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          // We never want this site to be referer-leaked to upstream targets.
          // The proxy strips referer itself, but defense in depth.
        ],
      },
      // Static assets: cache them as usual (Next handles this).
      {
        source: "/_next/static/(.*)",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
    ];
  },

  // Strip even more headers from responses. Next doesn't normally let you
  // remove Server, but we can at least not add anything identifying.
  async rewrites() {
    return [];
  },
};

export default nextConfig;
