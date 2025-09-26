import { Metadata } from "next";
import Image from "next/image";
import { blogPosts } from "../blogs";

export const metadata: Metadata = {
  title: blogPosts[1].title,
  description: blogPosts[1].description,
  openGraph: {
    title: blogPosts[1].title,
    description: blogPosts[1].description,
    images: [
      {
        url: blogPosts[1].imageSrc,
        width: 1200,
        height: 630,
        alt: blogPosts[1].title,
      },
    ],
    type: "article",
  },
  twitter: {
    card: "summary_large_image",
    title: blogPosts[1].title,
    description: blogPosts[1].description,
    images: [blogPosts[1].imageSrc],
  },
};

export default function HowToStartAcceptingPaymentsOnlinePage() {
  return (
    <div className="max-w-3xl mx-auto px-6 py-16">
      <article className="prose prose-gray max-w-none">
        <header className="mb-8">
          <p className="text-sm text-gray-500">
            {blogPosts[1].date} · 5 min read
          </p>
          <h1 className="text-3xl font-bold text-gray-900">
            {blogPosts[1].title}
          </h1>
        </header>

        <p className="text-gray-700 leading-relaxed">
          If you are building a product online, at some point you probably need
          to accept payments. This can feel confusing if you’ve never done it
          before. The good news is that you don’t need to build everything from
          scratch. There are existing services that help you get started. Which
          option makes sense for you depends a lot on{" "}
          <strong>the country you live in</strong> and{" "}
          <strong>your budget</strong>.
        </p>

        <hr className="my-8 border-gray-200" />

        <h2 className="text-2xl font-semibold text-gray-900 mt-10">
          If Stripe is available where you live
        </h2>
        <p className="text-gray-700 leading-relaxed">
          <a
            href="https://stripe.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:text-blue-800 underline transition-colors"
          >
            <strong>Stripe</strong>
          </a>{" "}
          is usually the easiest choice. It lets you accept credit cards and a
          bunch of local payment methods. The documentation is good, and most
          developers find it easy to set up. The downside is that{" "}
          <strong>Stripe</strong> is
          <strong> not available everywhere</strong>. If your country is not on
          their supported list, you’ll need to look for a different solution.
        </p>

        <hr className="my-8 border-gray-200" />

        <h2 className="text-2xl font-semibold text-gray-900 mt-10">
          If Stripe is not available
        </h2>
        <p className="text-gray-700 leading-relaxed">
          If you can’t use Stripe, there are other choices:
        </p>
        <ul className="list-disc pl-6">
          <li>
            <a
              href="https://paddle.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:text-blue-800 underline transition-colors"
            >
              <strong>Paddle</strong>
            </a>
            : Common for software companies outside the US or EU. Paddle acts as
            a Merchant of Record, which means they handle taxes (like VAT) for
            you. The fees are a bit higher, but you don’t need to worry about
            tax across countries.
          </li>
          <li>
            <a
              href="https://dodopayments.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:text-blue-800 underline transition-colors"
            >
              <strong>DodoPayments</strong>
            </a>
            : Similar idea, for developers in countries where Stripe does not
            work. It also acts as a Merchant of Record and lets you get started
            quickly without setting up a foreign company.
          </li>
        </ul>

        <hr className="my-8 border-gray-200" />

        <h2 className="text-2xl font-semibold text-gray-900 mt-10">
          Opening a US Entity (LLC or C‑Corp)
        </h2>
        <p className="text-gray-700 leading-relaxed">
          Some developers decide to register a US company (like a Delaware
          C‑Corp or an LLC) just to gain access to Stripe or other US‑only
          payment providers. This does work, but you should know what comes with
          it.
        </p>
        <h3 className="text-xl font-semibold text-gray-900 mt-6">
          Costs to expect
        </h3>
        <ul className="list-disc pl-6">
          <li>
            <strong>Formation fees</strong>: $200–400 to set up an LLC, $500–800
            for a C‑Corp.
          </li>
          <li>
            <strong>Registered agent</strong>: around $100–300 per year.
          </li>
          <li>
            <strong>Franchise tax and annual reports</strong>: roughly $400–800
            per year for Delaware.
          </li>
          <li>
            <strong>Accounting and tax filing</strong>: at least $1,000–2,000
            per year.
          </li>
          <li>
            <strong>Bank account setup</strong>: can be tricky without visiting
            the US.
          </li>
        </ul>
        <p className="text-gray-700 leading-relaxed">
          So you’re looking at around <strong>$2,000–3,000 per year</strong>
          just to maintain the company.
        </p>

        <hr className="my-8 border-gray-200" />

        <h2 className="text-2xl font-semibold text-gray-900 mt-10">
          What is a Merchant of Record?
        </h2>
        <p className="text-gray-700 leading-relaxed">
          A <strong>Merchant of Record (MoR)</strong> is the company that
          officially sells your product to the customer. They collect the
          payment, handle taxes, deal with chargebacks, and then send the rest
          to you.
        </p>
        <p className="text-gray-700 leading-relaxed">Popular MoRs include:</p>
        <ul className="list-disc pl-6">
          <li>
            <strong>
              <a
                href="https://paddle.com"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:text-blue-800 underline transition-colors"
              >
                Paddle
              </a>
            </strong>
          </li>
          <li>
            <strong>
              <a
                href="https://dodopayments.com"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:text-blue-800 underline transition-colors"
              >
                DodoPayments
              </a>
            </strong>
          </li>
          <li>
            <strong>
              <a
                href="https://docs.stripe.com/payments/managed-payments"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:text-blue-800 underline transition-colors"
              >
                Stripe Managed Payments
              </a>
            </strong>{" "}
            (currently in Beta)
          </li>
        </ul>
        <p className="text-gray-700 leading-relaxed">
          Using a MoR makes compliance and taxes much easier, but you pay higher
          fees and give up some direct control.
        </p>

        <hr className="my-8 border-gray-200" />

        <h2 className="text-2xl font-semibold text-gray-900 mt-10">
          Comparison table
        </h2>
        <p className="text-gray-700 leading-relaxed">
          Here’s a quick side‑by‑side view to help you choose:
        </p>
        <div className="overflow-x-auto">
          <table className="w-full border border-gray-300 border-collapse">
            <thead>
              <tr>
                <th className="border border-gray-200 px-3 py-2">Option</th>
                <th className="border border-gray-200 px-3 py-2">
                  Availability
                </th>
                <th className="border border-gray-200 px-3 py-2">
                  Who handles taxes
                </th>
                <th className="border border-gray-200 px-3 py-2">Complexity</th>
                <th className="border border-gray-200 px-3 py-2">
                  Yearly costs
                </th>
                <th className="border border-gray-200 px-3 py-2">Control</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="border border-gray-200 px-3 py-2">
                  <strong>
                    <a
                      href="https://stripe.com"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:text-blue-800 underline transition-colors"
                    >
                      Stripe
                    </a>
                  </strong>{" "}
                  (direct)
                </td>
                <td className="border border-gray-200 px-3 py-2">
                  Countries supported by Stripe
                </td>
                <td className="border border-gray-200 px-3 py-2">You</td>
                <td className="border border-gray-200 px-3 py-2">
                  Easy if supported
                </td>
                <td className="border border-gray-200 px-3 py-2">
                  None (normal fees)
                </td>
                <td className="border border-gray-200 px-3 py-2">Full</td>
              </tr>
              <tr>
                <td className="border border-gray-200 px-3 py-2">
                  <strong>
                    <a
                      href="https://paddle.com"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:text-blue-800 underline transition-colors"
                    >
                      Paddle
                    </a>
                  </strong>{" "}
                  (MoR)
                </td>
                <td className="border border-gray-200 px-3 py-2">
                  Global (many countries)
                </td>
                <td className="border border-gray-200 px-3 py-2">Paddle</td>
                <td className="border border-gray-200 px-3 py-2">Simple</td>
                <td className="border border-gray-200 px-3 py-2">
                  % of each payment
                </td>
                <td className="border border-gray-200 px-3 py-2">Limited</td>
              </tr>
              <tr>
                <td className="border border-gray-200 px-3 py-2">
                  <strong>
                    <a
                      href="https://dodopayments.com"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:text-blue-800 underline transition-colors"
                    >
                      DodoPayments
                    </a>
                  </strong>{" "}
                  (MoR)
                </td>
                <td className="border border-gray-200 px-3 py-2">
                  Global (where supported)
                </td>
                <td className="border border-gray-200 px-3 py-2">
                  DodoPayments
                </td>
                <td className="border border-gray-200 px-3 py-2">Simple</td>
                <td className="border border-gray-200 px-3 py-2">
                  % of each payment
                </td>
                <td className="border border-gray-200 px-3 py-2">Limited</td>
              </tr>
              <tr>
                <td className="border border-gray-200 px-3 py-2">
                  <strong>
                    <a
                      href="https://docs.stripe.com/payments/managed-payments"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:text-blue-800 underline transition-colors"
                    >
                      Stripe Managed Payments
                    </a>
                  </strong>{" "}
                  (Beta, MoR)
                </td>
                <td className="border border-gray-200 px-3 py-2">
                  Expanding (still Beta)
                </td>
                <td className="border border-gray-200 px-3 py-2">Stripe</td>
                <td className="border border-gray-200 px-3 py-2">Simple</td>
                <td className="border border-gray-200 px-3 py-2">
                  % of each payment
                </td>
                <td className="border border-gray-200 px-3 py-2">Limited</td>
              </tr>
              <tr>
                <td className="border border-gray-200 px-3 py-2">
                  <strong>US Entity + Stripe</strong>
                </td>
                <td className="border border-gray-200 px-3 py-2">
                  Worldwide (via US)
                </td>
                <td className="border border-gray-200 px-3 py-2">You</td>
                <td className="border border-gray-200 px-3 py-2">Complex</td>
                <td className="border border-gray-200 px-3 py-2">
                  $2,000–3,000 per year
                </td>
                <td className="border border-gray-200 px-3 py-2">Full</td>
              </tr>
            </tbody>
          </table>
        </div>

        <hr className="my-8 border-gray-200" />

        <h2 className="text-2xl font-semibold text-gray-900 mt-10">
          A note if you’re building with AI
        </h2>
        <p className="text-gray-700 leading-relaxed">
          If you’re building an AI app, you often need extra features like
          <strong>
            {" "}
            usage‑based billing, adding credits for AI tokens, and free trials
          </strong>
          . Normally, this takes weeks of work to implement on top of payment
          providers.
        </p>
        <p className="text-gray-700 leading-relaxed">
          With
          <strong>
            {" "}
            <a
              href="https://getlumen.dev"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:text-blue-800 underline transition-colors"
            >
              Lumen Payments
            </a>
          </strong>
          , you can plug into Stripe, Paddle, DodoPayments, or Stripe Managed
          Payments and get all of this running in
          <strong> under 1 hour</strong>. That means you can skip weeks of
          billing logic and stay focused on your product.
        </p>

        <hr className="my-8 border-gray-200" />

        <h2 className="text-2xl font-semibold text-gray-900 mt-10">
          Putting it all together
        </h2>
        <ul className="list-disc pl-6">
          <li>If Stripe is in your country → use Stripe.</li>
          <li>
            If not → try a Merchant of Record like Paddle or DodoPayments.
          </li>
          <li>
            If you want full control worldwide → set up a US entity, but
            remember the $2,000–3,000 yearly cost.
          </li>
          <li>Keep an eye on Stripe Managed Payments (Beta).</li>
          <li>
            And if you’re working on an AI app, check out{" "}
            <a
              href="https://getlumen.dev"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:text-blue-800 underline transition-colors"
            >
              <strong>Lumen Payments</strong>
            </a>{" "}
            to save time on billing and credits.
          </li>
        </ul>

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
