import { Metadata } from "next";
import Image from "next/image";
import { blogPosts } from "../blogs";

export const metadata: Metadata = {
  title: blogPosts[2].title,
  description: blogPosts[2].description,
  keywords: [
    "open source Stripe Billing alternative",
    "Stripe Billing open source",
    "Lumen Payments",
    "AI usage billing",
    "credit wallets",
    "seat-based billing",
    "self-hosted billing",
    "SaaS billing",
  ],
  openGraph: {
    title: blogPosts[2].title,
    description: blogPosts[2].description,
    images: [
      {
        url: blogPosts[2].imageSrc,
        width: 1200,
        height: 630,
        alt: blogPosts[2].title,
      },
    ],
    type: "article",
  },
  twitter: {
    card: "summary_large_image",
    title: blogPosts[2].title,
    description: blogPosts[2].description,
    images: [blogPosts[2].imageSrc],
  },
  alternates: {
    canonical: "/blog/stripe-open-source",
  },
};

export default function StripeOpenSourcePage() {
  const articleJsonLd = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: blogPosts[2].title,
    description: blogPosts[2].description,
    image: [blogPosts[2].imageSrc],
    datePublished: "2025-09-24",
    dateModified: "2025-09-24",
    author: {
      "@type": "Person",
      name: "Ramon Garate",
    },
  };

  const faqJsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: "Is there an open source alternative to Stripe Billing?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Yes. Lumen Payments is an open source alternative to Stripe Billing.",
        },
      },
      {
        "@type": "Question",
        name: "Is Lumen cheaper than Stripe Billing?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Yes. There is no 0.7% Stripe Billing fee. Self-host is free; our cloud is cheaper than Stripe Billing.",
        },
      },
      {
        "@type": "Question",
        name: "Does Lumen support trials, seats, orgs, usage, and credits?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Yes. Lumen supports subscriptions with free trials, seats and organizations, usage meters, and credit wallets.",
        },
      },
      {
        "@type": "Question",
        name: "Is it easier to integrate than Stripe, Paddle, or Adyen?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Yes. Lumen provides clean APIs, examples, and fewer webhooks to manage, making integration faster.",
        },
      },
    ],
  };

  return (
    <div className="max-w-3xl mx-auto px-6 py-16">
      <article className="prose prose-gray max-w-none">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(articleJsonLd) }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
        />
        <header className="mb-8">
          <p className="text-sm text-gray-500">
            {blogPosts[2].date} · 4 min read
          </p>
          <h1 className="text-3xl font-bold text-gray-900">
            {blogPosts[2].title}
          </h1>
        </header>

        <p className="text-gray-700 leading-relaxed">
          Billing gets messy fast: free trials, seats for teams, orgs, usage,
          credits. Stripe Billing helps at the start, but it becomes complex and
          costly. We built <strong>Lumen Payments</strong> as an open source
          alternative that gives you control, is easier to integrate, and costs
          less. It also handles AI usage and credit models in a clean way.
        </p>

        <hr className="my-8 border-gray-200" />

        <h2 className="text-2xl font-semibold text-gray-900 mt-10">
          Comparison: Lumen Payments vs Stripe Billing
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full border border-gray-300 border-collapse">
            <thead>
              <tr>
                <th className="border border-gray-200 px-3 py-2">Feature</th>
                <th className="border border-gray-200 px-3 py-2">
                  Lumen Payments
                </th>
                <th className="border border-gray-200 px-3 py-2">
                  Stripe Billing
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="border border-gray-200 px-3 py-2">
                  Open source
                </td>
                <td className="border border-gray-200 px-3 py-2">Yes</td>
                <td className="border border-gray-200 px-3 py-2">No</td>
              </tr>
              <tr>
                <td className="border border-gray-200 px-3 py-2">
                  Self-hosting
                </td>
                <td className="border border-gray-200 px-3 py-2">Yes (free)</td>
                <td className="border border-gray-200 px-3 py-2">No</td>
              </tr>
              <tr>
                <td className="border border-gray-200 px-3 py-2">
                  Pricing fee on billing
                </td>
                <td className="border border-gray-200 px-3 py-2">No</td>
                <td className="border border-gray-200 px-3 py-2">
                  0.7% of processed volume
                </td>
              </tr>
              <tr>
                <td className="border border-gray-200 px-3 py-2">
                  Seats & orgs
                </td>
                <td className="border border-gray-200 px-3 py-2">Built-in</td>
                <td className="border border-gray-200 px-3 py-2">
                  Custom work
                </td>
              </tr>
              <tr>
                <td className="border border-gray-200 px-3 py-2">
                  AI usage & credits
                </td>
                <td className="border border-gray-200 px-3 py-2">Native</td>
                <td className="border border-gray-200 px-3 py-2">
                  Complex setup
                </td>
              </tr>
              <tr>
                <td className="border border-gray-200 px-3 py-2">
                  Time to integrate
                </td>
                <td className="border border-gray-200 px-3 py-2">Hours</td>
                <td className="border border-gray-200 px-3 py-2">Days</td>
              </tr>
            </tbody>
          </table>
        </div>

        <hr className="my-8 border-gray-200" />

        <h2 className="text-2xl font-semibold text-gray-900 mt-10">
          Why it’s easier
        </h2>
        <ul className="list-disc pl-6">
          <li>Fewer steps, clear examples, minimal webhooks.</li>
          <li>Works locally with one command and seed data.</li>
          <li>You can extend flows in code instead of fighting a dashboard.</li>
        </ul>

        <hr className="my-8 border-gray-200" />

        <h2 className="text-2xl font-semibold text-gray-900 mt-10">Cost</h2>
        <ul className="list-disc pl-6">
          <li>Stripe Billingadds 0.7% on top of payment fees.</li>
          <li>
            <strong>Lumen self-host</strong>: no billing fee.
          </li>
          <li>
            <strong>Lumen cloud</strong>: significantly cheaper than Stripe
            Billing.
          </li>
        </ul>

        <hr className="my-8 border-gray-200" />

        <h2 className="text-2xl font-semibold text-gray-900 mt-10">
          AI usage and credits
        </h2>
        <p className="text-gray-700 leading-relaxed">
          Track tokens or calls, price by model, use credit wallets per user or
          org, define rollover rules in code, and keep an audit trail. Fixes and
          backfills are simple.
        </p>

        <hr className="my-8 border-gray-200" />

        <h2 className="text-2xl font-semibold text-gray-900 mt-10">
          Who should use Lumen
        </h2>
        <ul className="list-disc pl-6">
          <li>SaaS with trials, seats, orgs</li>
          <li>AI products with usage and credits</li>
          <li>Teams that want control and lower costs</li>
        </ul>

        <hr className="my-8 border-gray-200" />

        <h2 className="text-2xl font-semibold text-gray-900 mt-10">FAQ</h2>
        <div className="not-prose mt-4 space-y-3">
          <details className="rounded-lg border border-gray-200 bg-white p-4 open:shadow-sm">
            <summary className="cursor-pointer font-medium text-gray-900">
              Is there an open source alternative to Stripe Billing?
            </summary>
            <p className="mt-2 text-gray-700">
              Yes, <strong>Lumen Payments</strong>.
            </p>
          </details>
          <details className="rounded-lg border border-gray-200 bg-white p-4 open:shadow-sm">
            <summary className="cursor-pointer font-medium text-gray-900">
              Is Lumen cheaper than Stripe Billing?
            </summary>
            <p className="mt-2 text-gray-700">
              Yes. No 0.7% fee; self-host is free; cloud is still cheaper.
            </p>
          </details>
          <details className="rounded-lg border border-gray-200 bg-white p-4 open:shadow-sm">
            <summary className="cursor-pointer font-medium text-gray-900">
              Does Lumen support trials, seats, orgs, usage, and credits?
            </summary>
            <p className="mt-2 text-gray-700">Yes.</p>
          </details>
          <details className="rounded-lg border border-gray-200 bg-white p-4 open:shadow-sm">
            <summary className="cursor-pointer font-medium text-gray-900">
              Is it easier to integrate than Stripe, Paddle, or Adyen?
            </summary>
            <p className="mt-2 text-gray-700">Yes.</p>
          </details>
        </div>

        <p className="text-gray-700 leading-relaxed">
          We built Lumen to be a{" "}
          <a
            href="https://getlumen.dev"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:text-blue-800 underline transition-colors"
          >
            developer-first, open source billing platform
          </a>{" "}
          that you can self-host or run in our managed cloud.
        </p>

        <div className="mt-12 pt-8 border-t border-gray-200">
          <div className="flex items-center space-x-4">
            <Image
              src="/ramon.jpeg"
              alt="Ramon Garate"
              className="rounded-full object-cover"
              width={64}
              height={64}
            />
            <div>
              <h4 className="text-lg font-semibold text-gray-900">
                Ramon Garate
              </h4>
              <p className="text-gray-600">Founder of Lumen</p>
            </div>
          </div>
        </div>
      </article>
    </div>
  );
}
