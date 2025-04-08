import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { KeyboardListenerWrapper } from "@/components/KeyboardListenerWrapper";

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
  // Add other metadata as needed
  manifest: "/manifest.json", // Will be used once PWA is set up
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
        </KeyboardListenerWrapper>
      </body>
    </html>
  );
}
