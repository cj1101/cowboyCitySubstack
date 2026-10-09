import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "firebasestorage.googleapis.com",
      },
      {
        protocol: "https",
        hostname: "*.firebasestorage.app",
      },
    ],
  },
  async rewrites() {
    return [
      { source: "/cities", destination: "/factions" },
      { source: "/cities/:path*", destination: "/factions/:path*" },
    ];
  },
};

export default nextConfig;