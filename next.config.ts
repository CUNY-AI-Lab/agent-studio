import type { NextConfig } from "next";

const prod = process.env.NODE_ENV === 'production';

const nextConfig: NextConfig = {
  // Base path for deployment at a subpath (e.g., /studio)
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || '',
  serverExternalPackages: ["pdf-parse"],
  // Expand Turbopack's filesystem root to handle .venv symlinks
  turbopack: {
    // Keep root scoped to the project directory to avoid scanning the entire FS
    root: process.cwd(),
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'X-Frame-Options',
            value: 'SAMEORIGIN',
          },
          {
            key: 'X-XSS-Protection',
            value: '1; mode=block',
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
          // Note: CSP is relaxed for Next.js inline scripts and Recharts
          // In production, remove unsafe-eval
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              prod
                ? "script-src 'self' 'unsafe-inline' https://unpkg.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net"
                : "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://unpkg.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
              "style-src 'self' 'unsafe-inline' https://unpkg.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://fonts.googleapis.com", // Required for Tailwind + CDNs + Google Fonts
              "img-src 'self' data: blob: https: http:", // Allow images from anywhere (maps, etc)
              "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com",
              "connect-src 'self' https://api.openalex.org https://api-na.hosted.exlibrisgroup.com https://oauth.oclc.org https://lgapi-us.libapps.com https://worldcat.org https://*.tile.openstreetmap.org https://unpkg.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://*.openstreetmap.org https://threejs.org",
              "frame-src 'self' blob:",
              "object-src 'none'",
              "base-uri 'self'",
              "form-action 'self'",
              "frame-ancestors 'self'",
            ].join('; '),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
