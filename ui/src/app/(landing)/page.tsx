"use client";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";
import Image from "next/image";
import {
  ArrowRight,
  // Github,
  CreditCard,
  Shield,
  Users,
  Zap,
  CheckCircle,
  Star,
  FileText,
} from "lucide-react";
import { CodeBlock } from "@/components/ui/codeblock";
import dynamic from "next/dynamic";

const WebGLEarth = dynamic(() => import("@/components/WebGLEarth"), {
  ssr: false,
});

export default function Home() {
  return (
    <>
      {/* Hero Section */}
      <section className="relative pt-24 pb-32 px-6 lg:px-8 overflow-hidden">
        {/* WebGL Earth Background */}
        <div className="absolute top-0 right-0 w-2/3 h-full opacity-45 transform translate-x-12 -rotate-12">
          <WebGLEarth className="w-full h-full" />
        </div>

        {/* Geometric Background Pattern */}
        <div className="absolute inset-0 opacity-30">
          <svg
            className="absolute inset-0 h-full w-full"
            xmlns="http://www.w3.org/2000/svg"
          >
            <defs>
              <pattern
                id="geometric"
                x="0"
                y="0"
                width="60"
                height="60"
                patternUnits="userSpaceOnUse"
              >
                <circle
                  cx="30"
                  cy="30"
                  r="1.5"
                  fill="currentColor"
                  className="text-gray-400"
                />
                <circle
                  cx="0"
                  cy="0"
                  r="1"
                  fill="currentColor"
                  className="text-gray-300"
                />
                <circle
                  cx="60"
                  cy="0"
                  r="1"
                  fill="currentColor"
                  className="text-gray-300"
                />
                <circle
                  cx="0"
                  cy="60"
                  r="1"
                  fill="currentColor"
                  className="text-gray-300"
                />
                <circle
                  cx="60"
                  cy="60"
                  r="1"
                  fill="currentColor"
                  className="text-gray-300"
                />
                <path
                  d="M30 0L60 30L30 60L0 30Z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="0.5"
                  className="text-gray-200"
                />
              </pattern>
            </defs>
            <rect
              x="0"
              y="0"
              width="100%"
              height="100%"
              fill="url(#geometric)"
            />
          </svg>
        </div>

        {/* Gradient Overlays */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-96 h-96 bg-gradient-to-br from-blue-50 to-indigo-50 rounded-full blur-3xl opacity-60"></div>
        <div className="absolute bottom-0 right-1/4 w-80 h-80 bg-gradient-to-br from-purple-50 to-pink-50 rounded-full blur-3xl opacity-40"></div>

        <div className="relative max-w-5xl mx-auto text-center">
          <Link
            href="https://www.ycombinator.com/companies/lumen-payments"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center px-4 py-2 rounded-full bg-orange-50 text-orange-700 text-sm font-medium mb-8 border border-orange-200/50 hover:bg-orange-100 transition-colors"
          >
            <Image
              src="/yc_logo.png"
              alt="Y Combinator"
              width={16}
              height={16}
              className="mr-2"
            />
            Backed by Y Combinator
          </Link>

          <h1 className="text-6xl md:text-7xl lg:text-8xl font-light text-gray-900 mb-8 tracking-tight leading-none">
            Ship billing{" "}
            <span className="bg-gradient-to-r from-gray-900 via-gray-800 to-gray-700 bg-clip-text text-transparent font-medium">
              in minutes
            </span>
            ,
            <span className="block text-gray-600 font-extralight">
              not weeks
            </span>
          </h1>

          <div className="text-xl md:text-2xl text-gray-600 mb-12 max-w-3xl mx-auto leading-relaxed font-light">
            <p className="mb-2">
              Embed our{" "}
              <span className="font-medium text-gray-800">
                PricingTable component
              </span>{" "}
              and track usage in{" "}
              <span className="font-medium text-gray-800">real-time</span>.
            </p>
            <p>
              Control feature access{" "}
              <span className="font-medium text-gray-800">instantly</span> with
              usage-based billing, credit systems, feature gates and much more.
            </p>
          </div>

          <div className="flex flex-col sm:flex-row gap-6 justify-center items-center">
            <Link
              href="https://docs.getlumen.dev/getting-started"
              target="_blank"
            >
              <Button
                size="lg"
                className="group relative bg-gradient-to-r from-gray-900 via-gray-800 to-gray-900 hover:from-gray-800 hover:via-gray-700 hover:to-gray-800 text-white px-12 py-5 text-lg font-semibold shadow-2xl hover:shadow-3xl transition-all duration-500 rounded-2xl border border-gray-700/50 hover:border-gray-600/50 overflow-hidden"
              >
                <div className="absolute inset-0 bg-gradient-to-r from-white/0 via-white/5 to-white/0 translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-1000"></div>
                <span className="relative z-10 flex items-center">
                  Get Started
                  <ArrowRight className="ml-3 w-5 h-5 group-hover:translate-x-1 transition-transform duration-300" />
                </span>
              </Button>
            </Link>
            <Link href="https://cal.com/ramongarate/quick-chat" target="_blank">
              <Button
                size="lg"
                variant="outline"
                className="group relative px-12 py-5 text-lg font-semibold border-2 border-gray-300 hover:border-gray-400 bg-white/80 backdrop-blur-sm hover:bg-white text-gray-800 hover:text-gray-900 shadow-lg hover:shadow-xl transition-all duration-300 rounded-2xl overflow-hidden"
              >
                <div className="absolute inset-0 bg-gradient-to-r from-gray-50/0 via-gray-50/50 to-gray-50/0 translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-700"></div>
                <span className="relative z-10 flex items-center">
                  Schedule a Call
                </span>
              </Button>
            </Link>
          </div>
        </div>
      </section>

      {/* Hero to Features Separator */}
      <div className="relative py-16">
        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-gray-200"></div>
          </div>
          <div className="relative flex justify-center">
            <div className="bg-white px-8">
              <div className="flex items-center space-x-2">
                <div className="w-3 h-3 bg-gray-300 rounded-full"></div>
                <div className="w-2 h-2 bg-gray-400 rounded-full"></div>
                <div className="w-3 h-3 bg-gray-300 rounded-full"></div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Features Section */}
      <section className="py-32 px-6 lg:px-8 bg-gradient-to-b from-gray-50/50 to-white">
        <div className="max-w-7xl mx-auto">
          <div className="grid lg:grid-cols-2 gap-20">
            {/* Feature 1 */}
            <div className="space-y-8">
              <div className="flex items-center space-x-4 text-gray-600">
                <div className="w-10 h-10 bg-blue-100 rounded-xl flex items-center justify-center">
                  <CreditCard className="w-5 h-5 text-blue-600" />
                </div>
                <span className="text-sm font-semibold uppercase tracking-wider">
                  Payment Processing
                </span>
              </div>
              <div>
                <h3 className="text-4xl font-light text-gray-900 mb-6 leading-tight">
                  Process payments in minutes.{" "}
                  <span className="text-gray-600 font-extralight">
                    Handle subscriptions, one-time payments, and complex billing
                    scenarios. Integrate with Stripe and other providers
                    seamlessly.
                  </span>
                </h3>
              </div>
              <div className="bg-white rounded-2xl p-8 shadow-xl border border-gray-100/50 backdrop-blur-sm">
                <div className="space-y-4">
                  <div className="flex items-center justify-between p-4 bg-gray-50 rounded-xl hover:bg-gray-100 transition-colors duration-200">
                    <span className="font-medium text-gray-900">
                      Monthly Subscription
                    </span>
                    <Badge
                      variant="secondary"
                      className="bg-gray-200 text-gray-800 font-semibold"
                    >
                      $99/mo
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between p-4 bg-blue-50 rounded-xl border border-blue-200/50 hover:bg-blue-100 transition-colors duration-200">
                    <span className="font-medium text-gray-900">
                      Usage-based Billing
                    </span>
                    <Badge className="bg-blue-100 text-blue-800 font-semibold">
                      Metered
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between p-4 bg-gray-50 rounded-xl hover:bg-gray-100 transition-colors duration-200">
                    <span className="font-medium text-gray-900">
                      One-time Setup
                    </span>
                    <Badge
                      variant="secondary"
                      className="bg-gray-200 text-gray-800 font-semibold"
                    >
                      $299
                    </Badge>
                  </div>
                </div>
              </div>
            </div>

            {/* Feature 2 */}
            <div className="space-y-8">
              <div className="flex items-center space-x-4 text-gray-600">
                <div className="w-10 h-10 bg-green-100 rounded-xl flex items-center justify-center">
                  <Shield className="w-5 h-5 text-green-600" />
                </div>
                <span className="text-sm font-semibold uppercase tracking-wider">
                  Feature Access (Entitlements)
                </span>
              </div>
              <div>
                <h3 className="text-4xl font-light text-gray-900 mb-6 leading-tight">
                  Control access to every feature.{" "}
                  <span className="text-gray-600 font-extralight">
                    Define plans, manage quotas, and gate features with
                    real-time entitlement checks and usage tracking.
                  </span>
                </h3>
              </div>
              <div className="bg-white rounded-2xl p-8 shadow-xl border border-gray-100/50 backdrop-blur-sm">
                <div className="space-y-6">
                  <div className="flex items-center space-x-4 p-2">
                    <div className="w-12 h-12 bg-blue-100 rounded-xl flex items-center justify-center">
                      <Users className="w-6 h-6 text-blue-600" />
                    </div>
                    <div className="flex-1">
                      <p className="font-semibold text-gray-900 text-lg">
                        Team Collaboration
                      </p>
                      <p className="text-gray-500 font-medium">5/10 users</p>
                    </div>
                    <CheckCircle className="w-6 h-6 text-green-500" />
                  </div>
                  <div className="flex items-center space-x-4 p-2">
                    <div className="w-12 h-12 bg-purple-100 rounded-xl flex items-center justify-center">
                      <Zap className="w-6 h-6 text-purple-600" />
                    </div>
                    <div className="flex-1">
                      <p className="font-semibold text-gray-900 text-lg">
                        API Calls
                      </p>
                      <p className="text-gray-500 font-medium">
                        847/1000 this month
                      </p>
                    </div>
                    <CheckCircle className="w-6 h-6 text-green-500" />
                  </div>
                  <div className="flex items-center space-x-4 p-2">
                    <div className="w-12 h-12 bg-gray-100 rounded-xl flex items-center justify-center">
                      <Star className="w-6 h-6 text-gray-400" />
                    </div>
                    <div className="flex-1">
                      <p className="font-semibold text-gray-400 text-lg">
                        Advanced Analytics
                      </p>
                      <p className="text-gray-400 font-medium">
                        Upgrade to unlock
                      </p>
                    </div>
                    <div className="w-6 h-6" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Testimonial Section */}
      <section className="py-32 px-6 lg:px-8">
        <div className="max-w-5xl mx-auto">
          <div className="bg-gradient-to-br from-gray-50 to-white rounded-3xl p-12 md:p-16 shadow-2xl border border-gray-100/50">
            <div className="flex flex-col md:flex-row items-center gap-12">
              <div className="flex-shrink-0">
                <Image
                  src="/ramon.jpeg"
                  alt="Ramon Garate"
                  width={120}
                  height={120}
                  className="rounded-2xl shadow-lg"
                />
              </div>
              <div className="flex-1 text-center md:text-left">
                <blockquote className="text-2xl md:text-3xl text-gray-900 mb-6 font-light leading-relaxed">
                  &quot;Lumen saved me weeks of building usage tracking and
                  billing. I added metered billing and real-time usage tracking
                  to{" "}
                  <a
                    href="https://ramon.chat"
                    target="_blank"
                    className="text-blue-600 hover:text-blue-700 transition-colors duration-200 font-medium"
                  >
                    ramon.chat
                  </a>{" "}
                  in an hour.&quot;
                </blockquote>
                <div>
                  <p className="font-semibold text-gray-900 text-lg">
                    Ramon Garate
                  </p>
                  <p className="text-gray-600 font-medium">
                    Co-Founder and CTO (YC W24)
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Implementation Guide Section */}
      <section className="py-32 px-6 lg:px-8 bg-gradient-to-b from-white to-gray-50/50">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-20">
            <h2 className="text-5xl md:text-6xl font-light text-gray-900 mb-6 tracking-tight">
              Get Started in Minutes
            </h2>
            <p className="text-xl text-gray-600 font-light">
              Four simple steps to integrate payments and feature access
            </p>
          </div>

          <div className="space-y-24">
            {/* Step 1: Installation */}
            <div className="grid lg:grid-cols-2 gap-12 items-center">
              <div>
                <div className="flex items-center space-x-4 mb-6">
                  <div className="w-12 h-12 bg-gradient-to-br from-blue-500 to-blue-600 rounded-2xl flex items-center justify-center shadow-lg flex-shrink-0">
                    <span className="text-white font-bold text-lg leading-none">
                      1
                    </span>
                  </div>
                  <h3 className="text-3xl font-light text-gray-900">
                    Install the Packages & Pricing Table
                  </h3>
                </div>
                <p className="text-lg text-gray-600 mb-6 font-light leading-relaxed">
                  The recommended way is to use our shadcn component so you can
                  easily edit the styling with Cursor or similar tools
                </p>
              </div>
              <div className="space-y-4">
                <CodeBlock
                  language="bash"
                  code={`npm install @getlumen/react @getlumen/server`}
                />
                <CodeBlock
                  language="bash"
                  code={`npx shadcn@latest add https://getlumen.dev/pricing-table.json`}
                />
              </div>
            </div>

            {/* Step 2: Basic Implementation */}
            <div className="grid lg:grid-cols-2 gap-12 items-center">
              <div>
                <div className="flex items-center space-x-4 mb-6">
                  <div className="w-12 h-12 bg-gradient-to-br from-green-500 to-green-600 rounded-2xl flex items-center justify-center shadow-lg flex-shrink-0">
                    <span className="text-white font-bold text-lg leading-none">
                      2
                    </span>
                  </div>
                  <h3 className="text-3xl font-light text-gray-900">
                    Frontend Integration
                  </h3>
                </div>
                <p className="text-lg text-gray-600 mb-6 font-light leading-relaxed">
                  Import the PricingTable component and add it to your NextJS
                  pricing page
                </p>
              </div>
              <div>
                <CodeBlock
                  language="tsx"
                  code={`import { PricingTable } from '@/components/ui/pricing-table';
// OR if you don't want to use shadcn
// import { PricingTable } from '@getlumen/react'

export default function PricingPage() {
  return (
    <PricingTable
      lumenPublishableKey={process.env.NEXT_PUBLIC_LUMEN_PUBLISHABLE_KEY}
      userId={session?.user?.id}
      loginRedirectUrl="/login"
    />
  );
}`}
                />
              </div>
            </div>

            {/* Step 3: Entitlements Check */}
            <div className="grid lg:grid-cols-2 gap-12 items-center">
              <div>
                <div className="flex items-center space-x-4 mb-6">
                  <div className="w-12 h-12 bg-gradient-to-br from-purple-500 to-purple-600 rounded-2xl flex items-center justify-center shadow-lg flex-shrink-0">
                    <span className="text-white font-bold text-lg leading-none">
                      3
                    </span>
                  </div>
                  <h3 className="text-3xl font-light text-gray-900">
                    Backend Integration
                  </h3>
                </div>
                <p className="text-lg text-gray-600 mb-6 font-light leading-relaxed">
                  Check if a user has access to a feature and record usage with
                  1 line of code
                </p>
              </div>
              <div>
                <CodeBlock
                  language="tsx"
                  code={`import { sendEvent, isFeatureEntitled } from "@getlumen/server";;

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  // Check if user still has credits
  if (
     await isFeatureEntitled({
        feature: "ai-chat-requests",
        userId: user.id
      })
    ) {
    // Do something here ...
    // after completion you can record usage with:
    sendEvent({
      name: "ai-chat-requests",
      userId: user.id,
    });
  }
}`}
                />
              </div>
            </div>
            {/* Step 4: Dashboard */}
            <div className="grid lg:grid-cols-2 gap-12 items-center">
              <div>
                <div className="flex items-center space-x-4 mb-6">
                  <div className="w-12 h-12 bg-gradient-to-br from-orange-500 to-orange-600 rounded-2xl flex items-center justify-center shadow-lg flex-shrink-0">
                    <span className="text-white font-bold text-lg leading-none">
                      4
                    </span>
                  </div>
                  <h3 className="text-3xl font-light text-gray-900">
                    Set up your plans & features in the dashboard
                  </h3>
                </div>
                <Link href="/dashboard" target="_blank">
                  <Button
                    variant="outline"
                    className="mt-6 px-8 py-3 text-lg font-medium border-2 hover:bg-gray-50 transition-all duration-200 rounded-xl"
                  >
                    Go to Dashboard <ArrowRight className="ml-2 w-5 h-5" />
                  </Button>
                </Link>
              </div>
              <div>
                <Image
                  src="/createplan.png"
                  alt="Lumen dashboard onboarding"
                  width={1000}
                  height={1000}
                  className="rounded-2xl shadow-lg hover:shadow-xl border border-gray-200/50 transition-all duration-300"
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Comprehensive Features Section */}
      <section className="py-32 px-6 lg:px-8">
        <div className="max-w-7xl mx-auto">
          <div className="grid lg:grid-cols-2 gap-20 items-start">
            {/* Left Side - Value Proposition */}
            <div>
              <h2 className="text-5xl md:text-6xl font-light text-gray-900 mb-8 tracking-tight leading-tight">
                Complete billing for any scale.{" "}
                <span className="text-gray-600 font-extralight">
                  Engineered for speed, designed for developer experience.
                </span>
              </h2>
              <p className="text-xl text-gray-600 font-light leading-relaxed">
                Stop building billing infrastructure from scratch. Lumen handles
                usage tracking, complex pricing models, and entitlements so you
                can focus on shipping features.
              </p>
            </div>

            {/* Right Side - Feature List */}
            <div className="space-y-12">
              {/* Real-time Usage Tracking */}
              <div className="flex items-start space-x-4">
                <div className="w-6 h-6 bg-blue-100 rounded-lg flex items-center justify-center flex-shrink-0 mt-1">
                  <Zap className="w-4 h-4 text-blue-600" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-gray-900 mb-2">
                    Real-time Usage Tracking
                  </h3>
                  <p className="text-gray-600 leading-relaxed">
                    Track usage in real-time without building your own system.
                    Same data powers both billing and entitlements. No duplicate
                    tracking needed.
                  </p>
                </div>
              </div>

              {/* Complex Billing Models */}
              <div className="flex items-start space-x-4">
                <div className="w-6 h-6 bg-purple-100 rounded-lg flex items-center justify-center flex-shrink-0 mt-1">
                  <CreditCard className="w-4 h-4 text-purple-600" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-gray-900 mb-2">
                    Complex Billing Made Simple
                  </h3>
                  <p className="text-gray-600 leading-relaxed">
                    Monthly, yearly, credits, overrides, multiple billing dates.
                    Build sophisticated pricing models in minutes that would
                    take days with Stripe.
                  </p>
                </div>
              </div>

              {/* Zero State Management */}
              <div className="flex items-start space-x-4">
                <div className="w-6 h-6 bg-green-100 rounded-lg flex items-center justify-center flex-shrink-0 mt-1">
                  <Shield className="w-4 h-4 text-green-600" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-gray-900 mb-2">
                    Zero State Management
                  </h3>
                  <p className="text-gray-600 leading-relaxed">
                    No subscription tables in your DB. No feature flags to
                    maintain. We handle all user state. You just check
                    entitlements with one API call.
                  </p>
                </div>
              </div>

              {/* Instant Pricing Changes */}
              <div className="flex items-start space-x-4">
                <div className="w-6 h-6 bg-orange-100 rounded-lg flex items-center justify-center flex-shrink-0 mt-1">
                  <Users className="w-4 h-4 text-orange-600" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-gray-900 mb-2">
                    Instant Pricing Changes
                  </h3>
                  <p className="text-gray-600 leading-relaxed">
                    Move features between plans, adjust credit limits, test new
                    pricing, all without code changes. Perfect for rapid
                    experimentation.
                  </p>
                </div>
              </div>

              {/* Everything Connected */}
              <div className="flex items-start space-x-4">
                <div className="w-6 h-6 bg-indigo-100 rounded-lg flex items-center justify-center flex-shrink-0 mt-1">
                  <CheckCircle className="w-4 h-4 text-indigo-600" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-gray-900 mb-2">
                    Everything Connected
                  </h3>
                  <p className="text-gray-600 leading-relaxed">
                    Credits → Usage → Billing → Entitlements. One unified system
                    where changes ripple through automatically. No manual
                    syncing required.
                  </p>
                </div>
              </div>

              {/* Lightning Fast Setup */}
              <div className="flex items-start space-x-4">
                <div className="w-6 h-6 bg-pink-100 rounded-lg flex items-center justify-center flex-shrink-0 mt-1">
                  <Star className="w-4 h-4 text-pink-600" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-gray-900 mb-2">
                    Lightning Fast Setup
                  </h3>
                  <p className="text-gray-600 leading-relaxed">
                    What takes weeks with traditional billing solutions takes
                    minutes with Lumen. Create complex plans in minutes, import
                    our component and start sending and tracking usage in
                    real-time.
                  </p>
                </div>
              </div>

              {/* Taxes & Invoices */}
              <div className="flex items-start space-x-4">
                <div className="w-6 h-6 bg-emerald-100 rounded-lg flex items-center justify-center flex-shrink-0 mt-1">
                  <FileText className="w-4 h-4 text-emerald-600" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-gray-900 mb-2">
                    Taxes & Invoices Included
                  </h3>
                  <p className="text-gray-600 leading-relaxed">
                    Global tax calculation and professional invoice generation
                    handled automatically. No need to integrate separate tax
                    providers or build invoice systems.
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Bottom CTA */}
          <div className="text-center mt-24">
            <div className="inline-flex items-center px-4 py-2 rounded-full bg-gray-100 text-gray-700 text-sm font-medium mb-8 border border-gray-200/50">
              <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse mr-2"></span>
              Ready to ship in production
            </div>
            <h3 className="text-3xl font-light text-gray-900 mb-6">
              Stop building billing infrastructure.
              <span className="block font-medium">
                Start shipping features.
              </span>
            </h3>
            <div className="flex flex-col sm:flex-row gap-4 justify-center items-center">
              <Link
                href="https://docs.getlumen.dev/getting-started"
                target="_blank"
              >
                <Button
                  size="lg"
                  className="group relative bg-gradient-to-r from-gray-900 via-gray-800 to-gray-900 hover:from-gray-800 hover:via-gray-700 hover:to-gray-800 text-white px-10 py-4 text-lg font-semibold shadow-xl hover:shadow-2xl transition-all duration-300 rounded-xl"
                >
                  <span className="relative z-10 flex items-center">
                    Get Started for Free
                    <ArrowRight className="ml-2 w-5 h-5 group-hover:translate-x-1 transition-transform duration-300" />
                  </span>
                </Button>
              </Link>
              <Link
                href="https://cal.com/ramongarate/quick-chat"
                target="_blank"
              >
                <Button
                  size="lg"
                  variant="outline"
                  className="px-10 py-4 text-lg font-semibold border-2 border-gray-300 hover:border-gray-400 bg-white hover:bg-gray-50 text-gray-800 hover:text-gray-900 shadow-lg hover:shadow-xl transition-all duration-300 rounded-xl"
                >
                  Book a Demo
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
