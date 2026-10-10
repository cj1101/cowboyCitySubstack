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
      {
        protocol: "https",
        hostname: "mc-heads.net",
      },
    ],
  },
  async rewrites() {
    return [
      { source: "/cities", destination: "/factions" },
      { source: "/cities/:path*", destination: "/factions/:path*" },
      { source: "/:path+/favicon.ico", destination: "/favicon.ico" },
      { source: "/:path+/apple-touch-icon.png", destination: "/apple-touch-icon.png" },
      { source: "/:path+/apple-touch-icon-precomposed.png", destination: "/apple-touch-icon-precomposed.png" },
    ];
  },
};

export default nextConfig;