import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { KeyboardListenerWrapper } from "@/components/KeyboardListenerWrapper";
import PWAInstallPrompt from "@/components/PWAInstallPrompt";
import ProfileManager from "@/components/profiles/ProfileManager";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "ImpAmp 2 Soundboard",
  description: "Web-based soundboard application for triggering audio clips via keyboard shortcuts",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "ImpAmp 2",
  },
};

export const viewport = {
  themeColor: "#000000",
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
        <KeyboardListenerWrapper>
          {children}
          <PWAInstallPrompt />
          <ProfileManager />
        </KeyboardListenerWrapper>
      </body>
    </html>
  );
}
