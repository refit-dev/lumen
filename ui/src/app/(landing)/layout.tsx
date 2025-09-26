"use client";

import { Button } from "@/components/ui/button";
import Link from "next/link";
import Image from "next/image";
import { useSession } from "@/lib/auth-client";
import { ContactUsModal } from "@/components/ContactUsModal";
import { CookieBanner } from "@/components/CookieBanner";
import { submitNewsletterSignup } from "@/lib/actions/contact";
import { toast } from "sonner";
import { useState, useEffect } from "react";
import { useCookieConsent } from "@/lib/cookie-consent-context";
import localFont from "next/font/local";
import { Menu, X } from "lucide-react";

const calSans = localFont({
  src: "../../../public/CalSans-Regular.ttf",
  display: "swap",
  variable: "--font-cal-sans",
});

export default function LandingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { data: session, isPending } = useSession();
  const { autoConsentOnLogin } = useCookieConsent();
  const [newsletterEmail, setNewsletterEmail] = useState("");
  const [isSubmittingNewsletter, setIsSubmittingNewsletter] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  // Auto-consent when user is logged in but still on landing pages
  useEffect(() => {
    if (!isPending && session?.user) {
      autoConsentOnLogin();
    }
  }, [session, isPending, autoConsentOnLogin]);

  const handleNewsletterSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!newsletterEmail) {
      toast.error("Please enter your email address");
      return;
    }

    setIsSubmittingNewsletter(true);

    try {
      await submitNewsletterSignup({ email: newsletterEmail });
      toast.success("Thank you! You've been subscribed to our newsletter.");
      setNewsletterEmail("");
    } catch (error) {
      console.error("Newsletter signup error:", error);
      toast.error("Failed to subscribe. Please try again.");
    } finally {
      setIsSubmittingNewsletter(false);
    }
  };

  return (
    <div className="min-h-screen bg-white overflow-x-hidden">
      {/* Header */}
      <header className="relative border-b border-gray-100/50 backdrop-blur-sm bg-white/80 top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="relative flex justify-between items-center h-20">
            <div className="flex items-center space-x-4">
              <Link href="/" className="flex items-center space-x-3">
                <Image
                  src="/lumen-logo-black-bg.png"
                  alt="Lumen"
                  width={39}
                  height={39}
                  className="rounded-[0.75rem]"
                />
                <div className="hidden md:flex flex-col">
                  <span
                    className={`text-2xl font-semibold text-gray-900 tracking-wider ${calSans.className} mb-[-2px]`}
                  >
                    Lumen
                  </span>
                  <span className="text-xs text-gray-600">
                    Ship billing fast
                  </span>
                </div>
              </Link>
            </div>

            <nav className="hidden md:flex items-center space-x-10 absolute left-1/2 transform -translate-x-1/2">
              <Link
                href="/blog"
                className="text-gray-600 hover:text-gray-900 transition-all duration-200 font-medium text-sm tracking-wide"
              >
                Blog
              </Link>
              <Link
                href="/pricing"
                className="text-gray-600 hover:text-gray-900 transition-all duration-200 font-medium text-sm tracking-wide"
              >
                Pricing
              </Link>
              <Link
                href="https://docs.getlumen.dev"
                className="text-gray-600 hover:text-gray-900 transition-all duration-200 font-medium text-sm tracking-wide"
              >
                Documentation
              </Link>
              <ContactUsModal>
                <button className="text-gray-600 hover:text-gray-900 transition-all duration-200 font-medium text-sm tracking-wide cursor-pointer">
                  Contact Us
                </button>
              </ContactUsModal>
            </nav>

            <div className="flex items-center space-x-4">
              <button
                type="button"
                aria-label="Toggle menu"
                onClick={() => setIsMobileMenuOpen((prev) => !prev)}
                className="md:hidden p-2 text-gray-600 hover:text-gray-900 hover:bg-gray-50 rounded-lg transition-colors"
              >
                {isMobileMenuOpen ? (
                  <X className="w-6 h-6" />
                ) : (
                  <Menu className="w-6 h-6" />
                )}
              </button>
              <Link
                href="https://github.com/pretzelai/lumen"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center space-x-2 p-2 text-gray-600 hover:text-gray-900 hover:bg-gray-50 rounded-lg transition-all duration-200"
                title="View on GitHub"
              >
                <Image
                  src="/github.svg"
                  alt="GitHub"
                  width={20}
                  height={20}
                  className="w-5 h-5"
                />
                <span className="text-sm font-medium">Github</span>
              </Link>
              <Link
                href="https://cal.com/ramongarate/quick-chat"
                target="_blank"
                rel="noopener"
              >
                <Button
                  variant="ghost"
                  className="hidden sm:inline-flex text-sm font-medium hover:bg-gray-50 transition-all duration-200"
                >
                  Schedule a Call
                </Button>
              </Link>
              {!isPending && session?.user ? (
                <Link href="/dashboard">
                  <Button className="bg-gray-900 hover:bg-gray-800 text-white shadow-lg hover:shadow-xl transition-all duration-200 px-6">
                    Dashboard
                  </Button>
                </Link>
              ) : (
                <Link href="/login">
                  <Button className="bg-gray-900 hover:bg-gray-800 text-white shadow-lg hover:shadow-xl transition-all duration-200 px-6">
                    Login
                  </Button>
                </Link>
              )}
            </div>
          </div>
          {isMobileMenuOpen && (
            <div className="md:hidden w-full border-t border-gray-100 pt-4 pb-6">
              <div className="flex flex-col space-y-3">
                <Link
                  href="/blog"
                  onClick={() => setIsMobileMenuOpen(false)}
                  className="text-gray-700 hover:text-gray-900 transition-colors font-medium"
                >
                  Blog
                </Link>
                <Link
                  href="/pricing"
                  onClick={() => setIsMobileMenuOpen(false)}
                  className="text-gray-700 hover:text-gray-900 transition-colors font-medium"
                >
                  Pricing
                </Link>
                <Link
                  href="https://docs.getlumen.dev"
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setIsMobileMenuOpen(false)}
                  className="text-gray-700 hover:text-gray-900 transition-colors font-medium"
                >
                  Documentation
                </Link>
                <ContactUsModal>
                  <button
                    onClick={() => setIsMobileMenuOpen(false)}
                    className="text-left text-gray-700 hover:text-gray-900 transition-colors font-medium"
                  >
                    Contact Us
                  </button>
                </ContactUsModal>
              </div>
            </div>
          )}
        </div>
      </header>

      {/* Header Separator Line */}
      <div className="w-full h-px bg-gradient-to-r from-transparent via-gray-200 to-transparent"></div>

      {/* Page Content */}
      {children}

      {/* Footer */}
      <footer className="border-t border-gray-100 bg-white">
        <div className="py-16 px-6 lg:px-8">
          <div className="max-w-7xl mx-auto">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
              {/* Resources */}
              <div>
                <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wider mb-4">
                  Resources
                </h3>
                <ul className="space-y-3">
                  <li>
                    <Link
                      href="/pricing"
                      className="text-gray-600 hover:text-gray-900 transition-colors text-sm"
                    >
                      Pricing
                    </Link>
                  </li>
                  <li>
                    <Link
                      href="https://docs.getlumen.dev"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-gray-600 hover:text-gray-900 transition-colors text-sm"
                    >
                      Docs
                    </Link>
                  </li>
                </ul>
              </div>

              {/* Company */}
              <div>
                <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wider mb-4">
                  Company
                </h3>
                <ul className="space-y-3">
                  <li>
                    <Link
                      href="mailto:help@getlumen.dev"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-gray-600 hover:text-gray-900 transition-colors text-sm"
                    >
                      Contact
                    </Link>
                  </li>
                  <li>
                    <Link
                      href="/privacy"
                      className="text-gray-600 hover:text-gray-900 transition-colors text-sm"
                    >
                      Privacy Policy
                    </Link>
                  </li>
                  <li>
                    <Link
                      href="/terms"
                      className="text-gray-600 hover:text-gray-900 transition-colors text-sm"
                    >
                      Terms of Service
                    </Link>
                  </li>
                  <li>
                    <Link
                      href="/impressum"
                      className="text-gray-600 hover:text-gray-900 transition-colors text-sm"
                    >
                      Impressum
                    </Link>
                  </li>
                </ul>
              </div>

              {/* Social */}
              <div>
                <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wider mb-4">
                  Social
                </h3>
                <ul className="space-y-3">
                  <li>
                    <Link
                      href="https://github.com/pretzelai"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-gray-600 hover:text-gray-900 transition-colors text-sm"
                    >
                      GitHub
                    </Link>
                  </li>
                  <li>
                    <Link
                      href="https://x.com/LumenPayments"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-gray-600 hover:text-gray-900 transition-colors text-sm"
                    >
                      X (Twitter)
                    </Link>
                  </li>
                  <li>
                    <Link
                      href="https://www.linkedin.com/company/lumen-payments/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-gray-600 hover:text-gray-900 transition-colors text-sm"
                    >
                      LinkedIn
                    </Link>
                  </li>
                </ul>
              </div>

              {/* Newsletter */}
              <div>
                <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wider mb-4">
                  Newsletter
                </h3>
                <p className="text-gray-600 text-sm mb-4">
                  Get updates on new features and billing best practices.
                  Important updates only. Unsubscribe anytime.
                </p>
                <form onSubmit={handleNewsletterSubmit} className="flex w-full">
                  <input
                    type="email"
                    placeholder="Enter your email"
                    value={newsletterEmail}
                    onChange={(e) => setNewsletterEmail(e.target.value)}
                    className="flex-1 min-w-0 px-3 py-2 border border-gray-300 rounded-l-md text-sm focus:outline-none focus:ring-2 focus:ring-gray-900 focus:border-transparent"
                    required
                  />
                  <button
                    type="submit"
                    disabled={isSubmittingNewsletter}
                    className="px-4 py-2 bg-gray-900 text-white rounded-r-md hover:bg-gray-800 transition-colors text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isSubmittingNewsletter ? "..." : "Subscribe"}
                  </button>
                </form>
              </div>
            </div>

            {/* Bottom section */}
            <div className="mt-12 pt-8 border-t border-gray-200 flex flex-col md:flex-row justify-between items-center">
              <div className="flex items-center space-x-3 mb-4 md:mb-0">
                <Image
                  src="/lumen-logo-black-bg.png"
                  alt="Lumen"
                  width={28}
                  height={28}
                  className="h-7 w-7 rounded-lg"
                />
                <div className="hidden md:flex flex-col">
                  <span
                    className={`text-base font-bold text-gray-900 ${calSans.className}`}
                  >
                    Lumen
                  </span>
                  <span className="text-xs text-gray-600">
                    Ship billing fast
                  </span>
                </div>
              </div>
              <p className="text-gray-500 text-sm">
                &copy; 2025 Pretzel AI GmbH. All rights reserved.
              </p>
            </div>
          </div>
        </div>
      </footer>

      {/* Cookie Banner - only shown on landing pages */}
      <CookieBanner />
    </div>
  );
}
