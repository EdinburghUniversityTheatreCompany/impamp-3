import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import ClientLayout from "@/components/ClientLayout";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "ImpAmp3 Soundboard",
  description:
    "Web-based soundboard application for triggering audio clips via keyboard shortcuts",
  icons: {
    icon: [{ url: "/favicon.ico", sizes: "any" }],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "ImpAmp3",
  },
};

export const viewport = {
  // The same colour `manifest.ts` declares. These are two declarations of one
  // fact — the browser UI colour — and they disagreed, black here against the
  // manifest's brand orange, so which one a user saw depended on whether the
  // app was installed.
  themeColor: "#f2801f",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <ClientLayout>{children}</ClientLayout>
      </body>
    </html>
  );
}
