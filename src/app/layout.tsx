import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster as Sonner } from "@/components/ui/sonner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "tor-relay · dashboard",
  description:
    "Live request dashboard for the tor-relay — every request exits through a fresh Tor circuit. See which exit IP each request was routed through, plus the Vertex / Gemini / OpenAI / Anthropic / Z.ai provider allowlist.",
  keywords: [
    "tor",
    "relay",
    "proxy",
    "exit-ip",
    "vertex",
    "gemini",
    "openai",
    "anthropic",
    "dashboard",
    "Next.js",
  ],
  authors: [{ name: "tor-relay" }],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning className="dark">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Sonner />
      </body>
    </html>
  );
}
