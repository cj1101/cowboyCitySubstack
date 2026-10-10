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
      {
        protocol: "https",
        hostname: "cowboycityrealm.firebasestorage.app",
      },
      {
        protocol: "https",
        hostname: "storage.googleapis.com",
      },
      {
        protocol: "https",
        hostname: "*.appspot.com",
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