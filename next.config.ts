import type { NextConfig } from "next";
import withPWA from "next-pwa";

const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
};

const pwaConfig = withPWA({
  dest: "public",
  register: true,
  skipWaiting: true,
  disable: process.env.NODE_ENV === "development",
  runtimeCaching: [
    {
      urlPattern: /^https:\/\/fonts\.(googleapis|gstatic)\.com/,
      handler: "CacheFirst",
      options: {
        cacheName: "google-fonts",
        expiration: {
          maxEntries: 20,
          maxAgeSeconds: 30 * 24 * 60 * 60, // 30 days
        },
      },
    },
    {
      urlPattern: /\.(png|svg|jpg|jpeg|gif|webp|ico)$/,
      handler: "CacheFirst",
      options: {
        cacheName: "images",
        expiration: {
          maxEntries: 50,
          maxAgeSeconds: 30 * 24 * 60 * 60, // 30 days
        },
      },
    },
    {
      urlPattern: /\.(?:mp3|wav|ogg|m4a|aac)$/i,
      handler: "CacheFirst",
      options: {
        cacheName: "audio-files",
        expiration: {
          maxEntries: 100,
          maxAgeSeconds: 365 * 24 * 60 * 60, // 1 year
        },
        rangeRequests: true,
      },
    },
    {
      urlPattern: /^https?.*/,
      handler: "NetworkFirst",
      options: {
        cacheName: "offlineCache",
        expiration: {
          maxEntries: 200,
          maxAgeSeconds: 24 * 60 * 60, // 24 hours
        },
      },
    },
  ],
})(nextConfig);

export default pwaConfig;
