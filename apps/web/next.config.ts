import type { NextConfig } from 'next';
const config: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR || '.next',
  poweredByHeader: false,
  // Compression buffers proxied SSE until a gzip block fills; preserve live delivery.
  compress: false,
  devIndicators: false,
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${process.env.API_INTERNAL_URL || 'http://127.0.0.1:3101'}/api/:path*`,
      },
    ];
  },
};
export default config;
