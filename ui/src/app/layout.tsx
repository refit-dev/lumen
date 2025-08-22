import type { Metadata } from "next";
import { Geist, Geist_Mono, Neuton } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { PostHogProvider } from "./providers";
import { CookieConsentProvider } from "@/lib/cookie-consent-context";
import { AuthErrorProvider } from "@/lib/auth-error-provider";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const neuton = Neuton({
  variable: "--font-neuton",
  subsets: ["latin"],
  weight: ["400", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Lumen Payments",
  description: "Ship AI billing fast - usage, credits and flexible pricing",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${neuton.variable} antialiased`}
      >
        <CookieConsentProvider>
          <PostHogProvider>
            <AuthErrorProvider>
              <main>{children}</main>
              <Toaster />
            </AuthErrorProvider>
          </PostHogProvider>
        </CookieConsentProvider>
      </body>
    </html>
  );
}
