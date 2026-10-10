import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster as SonnerToaster } from "@/components/ui/sonner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Sentinel Vault — Secrets Operations Console",
  description:
    "Workspace-isolated, encrypted, versioned secret storage with proactive credential rotation for the Sentinel Vault.",
  icons: {
    icon: "/logo.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <SonnerToaster
          position="bottom-right"
          toastOptions={{
            classNames: {
              toast:
                "rounded-lg border border-zinc-800 bg-zinc-900/95 text-zinc-100",
              success: "border-emerald-700/60 text-emerald-100",
              error: "border-rose-700/60 text-rose-100",
            },
          }}
        />
      </body>
    </html>
  );
}
