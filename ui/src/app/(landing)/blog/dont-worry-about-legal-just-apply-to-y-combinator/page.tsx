import { Metadata } from "next";
import Image from "next/image";
import { blogPosts } from "../blogs";

export const metadata: Metadata = {
  title: blogPosts[3].title,
  description: blogPosts[3].description,
  openGraph: {
    title: blogPosts[3].title,
    description: blogPosts[3].description,
    images: [
      {
        url: blogPosts[3].imageSrc,
        width: 1200,
        height: 630,
        alt: blogPosts[3].title,
      },
    ],
    type: "article",
  },
  twitter: {
    card: "summary_large_image",
    title: blogPosts[3].title,
    description: blogPosts[3].description,
    images: [blogPosts[3].imageSrc],
  },
};

export default function DontWorryAboutLegalJustApplyToYCombinatorPage() {
  return (
    <div className="max-w-3xl mx-auto px-6 py-16">
      <article className="prose prose-gray max-w-none">
        <header className="mb-8">
          <p className="text-sm text-gray-500">
            {blogPosts[3].date} · 4 min read
          </p>
          <h1 className="text-3xl font-bold text-gray-900">
            {blogPosts[3].title}
          </h1>
        </header>

        <p className="text-gray-700 leading-relaxed">
          We got into YC with only an idea. No incorporation, no bank account,
          no contracts. We were preparing to talk to VCs in general and we
          filled the YC application on the day of the deadline. Less than a week
          later, we interviewed and got accepted.
        </p>

        <hr className="my-8 border-gray-200" />

        <h2 className="text-2xl font-semibold text-gray-900 mt-10">
          What we had
        </h2>
        <p className="text-gray-700 leading-relaxed">
          An idea and a demo hosted in a $10 domain. No Delaware entity, no cap
          table, no lawyers engaged.
        </p>

        <h2 className="text-2xl font-semibold text-gray-900 mt-10">
          Why this is fine for YC
        </h2>
        <p className="text-gray-700 leading-relaxed">
          YC is a reputable investor. If they say yes, the money will arrive.
          That means you can ask lawyers to defer payment, or you can use your
          own money for initial filings and reimburse it later, because you know
          a clean wire is coming once things are set up. You do not need to
          finish legal before you apply.
        </p>

        <h2 className="text-2xl font-semibold text-gray-900 mt-10">
          The sequence that worked for us
        </h2>
        <ul className="list-disc pl-6">
          <li>
            Submit the YC application with only the idea and a clear problem.
          </li>
          <li>
            Do the interview. Answer directly. Focus on users and the problem.
          </li>
          <li>
            After acceptance, engage with the law firm recommended by YC and
            defer fees until the wire lands.{" "}
          </li>
          <li>Incorporate with lawyers assistance & open bank account.</li>
        </ul>

        <p className="text-gray-700 leading-relaxed">
          Once the company was incorporated and the bank account was open, we
          received the $500k wire from YC and we paid vendors. That included the
          legal work, filings, and any small costs we took on.
        </p>

        <h2 className="text-2xl font-semibold text-gray-900 mt-10">
          Closing remarks
        </h2>

        <p className="text-gray-700 leading-relaxed">
          The important thing is to focus on your startup and start building
          your product. The legal part will come later. If you want to build a
          demo like the one that got us into YC really fast, you can use{" "}
          <a
            href="https://getlumen.dev"
            target="_blank"
            className="text-blue-600 hover:text-blue-800 underline transition-colors"
          >
            Lumen
          </a>{" "}
          to handle AI & credits super easily.{" "}
          <a
            href="https://www.linkedin.com/in/ramon-garate-4b379093/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:text-blue-800 underline transition-colors"
          >
            Connect with me on LinkedIn
          </a>{" "}
          if you have any questions.
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
