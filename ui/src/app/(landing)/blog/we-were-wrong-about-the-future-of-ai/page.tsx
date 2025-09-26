import { Metadata } from "next";
import Image from "next/image";
import { blogPosts } from "../blogs";

export const metadata: Metadata = {
  title: blogPosts[4]?.title,
  description: blogPosts[4]?.description,
  openGraph: {
    title: blogPosts[4]?.title,
    description: blogPosts[4]?.description,
    images: [
      {
        url: blogPosts[4]?.imageSrc,
        width: 1200,
        height: 630,
        alt: blogPosts[4]?.title,
      },
    ],
    type: "article",
  },
  twitter: {
    card: "summary_large_image",
    title: blogPosts[4]?.title,
    description: blogPosts[4]?.description,
    images: [blogPosts[4]?.imageSrc],
  },
};

export default function WeWereWrongAboutAIPage() {
  return (
    <div className="max-w-3xl mx-auto px-6 py-16">
      <article className="prose prose-gray max-w-none">
        <header className="mb-8">
          <p className="text-sm text-gray-500">
            {blogPosts[4]?.date} · 3 min read
          </p>
          <h1 className="text-3xl font-bold text-gray-900">
            {blogPosts[4]?.title}
          </h1>
        </header>

        <p className="text-gray-700 leading-relaxed mb-8">
          When we were doing YC in the beginning of 2024, the common idea was
          that LLMs would keep getting better and cheaper. At the time, many
          pitches assumed that even if the current burn rate was high, it would
          drop soon. Some assumed we would also be able to self‑host open source
          models and reduce costs that way.
        </p>

        <p className="text-gray-700 leading-relaxed mb-8">
          Only one of those assumptions turned out true: the models did get
          better, but they also got much more expensive, especially with agentic
          workflows. On top of that, they have become slower with the widespread
          of reasoning capabilities.
        </p>

        <p className="text-gray-700 leading-relaxed mb-8">
          Switching to cheaper models is usually not an option, since the
          product ends up performing worse next to competitors who are paying
          for stronger models. Because of this, companies are trying to figure
          out pricing models that make sense. Most experiments fall into 4
          buckets:
        </p>

        <ol className="list-decimal pl-6 space-y-4 mb-8">
          <li>
            <p className="m-0">
              <strong>Flat fee</strong>
            </p>
            <p className="text-gray-700 leading-relaxed">
              This is popular because it’s easy to implement with Stripe or
              similar providers. Companies put a fixed usage limit (e.g. Claude
              and Cursor) and hope for the best. Powerusers are balanced by
              light users, and the math works out overall.
            </p>
          </li>
          <li>
            <p className="m-0">
              <strong>Credit system</strong>
            </p>
            <p className="text-gray-700 leading-relaxed">
              This is the most common approach today. Customers buy credits that
              map closely to tokens or dollar cost. Credits are often renewed
              automatically with the billing cycle or added via top up (i.e.
              prepaid credits).
            </p>
          </li>
          <li>
            <p className="m-0">
              <strong>Usage‑based billing</strong>
            </p>
            <p className="text-gray-700 leading-relaxed">
              This can be the only pricing model or in addition to the flat-fee
              or credit based system (aka overusage). This model is not new but
              it is fairly popular with AI since it allows to easily implement{" "}
              <em>cost + margin</em> model.
            </p>
          </li>
          <li>
            <p className="m-0">
              <strong>Outcome‑based pricing</strong>
            </p>
            <p className="text-gray-700 leading-relaxed">
              Common in AI customer support. Instead of paying per token,
              customers pay for a solved ticket or a completed outcome. This
              works because companies already pay by resolution when outsourcing
              support. It sets clear expectations but doesn’t always map well to
              open‑ended AI use cases.
            </p>
          </li>
        </ol>

        <div className="pt-8 border-t border-gray-200">
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
