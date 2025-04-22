import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { KeyboardListenerWrapper } from "@/components/KeyboardListenerWrapper";
import ProfileManager from "@/components/profiles/ProfileManager";
import ModalRenderer from "@/components/ModalRenderer";

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
  description: "Web-based soundboard application for triggering audio clips via keyboard shortcuts",
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
    ],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "ImpAmp3",
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
          <ProfileManager />
          <ModalRenderer />
        </KeyboardListenerWrapper>
      </body>
    </html>
  );
}
