import type { NextConfig } from "next";

/**
 * The app renders no third-party content and only calls its own API, so the policy stays narrow.
 * Inline styles and scripts remain allowed because Next injects them during hydration.
 */
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://m.media-amazon.com https://images-na.ssl-images-amazon.com https://images-eu.ssl-images-amazon.com https://images-fe.ssl-images-amazon.com https://images-cn.ssl-images-amazon.com",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join("; ");

const config: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Content-Security-Policy", value: contentSecurityPolicy },
        // Credentials and analysis results must never be retained by a shared cache.
        { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
      ],
    }];
  },
};

export default config;
