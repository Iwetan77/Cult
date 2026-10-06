import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The dev-only "N" badge sits over the app's bottom-left corner.
  devIndicators: false,
  // Let phones on the same Wi-Fi load the dev server (this PC's LAN addresses).
  allowedDevOrigins: ['10.71.212.42', '192.168.0.152', '10.225.205.42']
};

export default nextConfig;