import { Metadata } from "next";
import Image from "next/image";
import { CodeBlock } from "@/components/ui/codeblock";
import { BlogCode } from "@/components/ui/blog-code";
import { blogPosts } from "../blogs";

export const metadata: Metadata = {
  title: blogPosts[0].title,
  description: blogPosts[0].description,
  openGraph: {
    title: blogPosts[0].title,
    description: blogPosts[0].description,
    images: [
      {
        url: blogPosts[0].imageSrc,
        width: 1200,
        height: 630,
        alt: blogPosts[0].title,
      },
    ],
    type: "article",
  },
  twitter: {
    card: "summary_large_image",
    title: blogPosts[0].title,
    description: blogPosts[0].description,
    images: [blogPosts[0].imageSrc],
  },
};

export default function HowIPrototypeAsAYCombinatorFounderPage() {
  return (
    <div className="max-w-3xl mx-auto px-6 py-16">
      <article className="prose prose-gray max-w-none">
        <header className="mb-8">
          <p className="text-sm text-gray-500">
            {blogPosts[0].date} · 5 min read
          </p>
          <h1 className="text-3xl font-bold text-gray-900">
            {blogPosts[0].title}
          </h1>
        </header>
        <p className="text-gray-700 leading-relaxed">
          TL;DR: I use Next.js (hosted in Vercel), Supabase and Lumen. The
          entire stack is free to use.
        </p>
        <br />
        <p>
          All the code is available in{" "}
          <a
            href="https://github.com/pretzelai/lumen-nextjs-starter"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:text-blue-800 underline transition-colors"
          >
            Github
          </a>
        </p>{" "}
        A live version can be found at{" "}
        <a
          href="https://lumen-nextjs-starter.vercel.app"
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-600 hover:text-blue-800 underline transition-colors"
        >
          https://lumen-nextjs-starter.vercel.app{" "}
        </a>
        <h2 className="text-2xl font-semibold text-gray-900 mt-10">
          Why I chose this stack
        </h2>
        <br />
        <p>
          <strong>NextJS</strong>: Easy to use and free to deploy in Vercel. AI
          knows it very well so it makes it easy to debug and build. I have used
          it extensively so it is the easiest to use for me. Trying Vite or
          other alternatives would only slow me down.
        </p>
        <br />
        <p>
          <strong>Supabase</strong>: generous free tier that is good enough for
          demos. Integrated auth makes it super easy to ship fast.
        </p>
        <br />
        <p>
          <strong>Lumen</strong>: out of the box credit system to limit AI usage
          per account. If you connect Stripe, you also get payments working
          without any extra effort.
        </p>
        <h2 className="text-2xl font-semibold text-gray-900 mt-10">
          Supabase configuration
        </h2>
        <h3 className="text-xl font-semibold text-gray-900 mt-6">
          Supabase per-user JSON store with RLS
        </h3>
        This is probably the most controversial part. I just make each user have
        a big json storing all the user data so I can reapidly iterate. Most of
        the prototypes I have made never got out of the demo stage so I only add
        proper tables and optimizations after I get the first paying customer.
        <h3 className="text-xl font-semibold text-gray-900 mt-6">
          Table & RLS
        </h3>
        <p className="text-gray-700 leading-relaxed">
          Create a table <BlogCode>public.user_data</BlogCode> with{" "}
          <BlogCode>data</BlogCode> as <BlogCode>jsonb</BlogCode> and{" "}
          <BlogCode>user_id</BlogCode> as <BlogCode>uuid</BlogCode> defaulting
          to <BlogCode>auth.uid()</BlogCode>. Enable RLS and add a policy that
          allows all operations only when{" "}
          <BlogCode>user_id = auth.uid()</BlogCode>.
        </p>
        <div className="mt-4">
          <CodeBlock
            code={`-- Table
create table if not exists public.user_data (
  user_id uuid not null default auth.uid(),
  data jsonb not null,
  primary key (user_id)
);

-- Row Level Security
alter table public.user_data enable row level security;

create policy "Users can manage their own user_data"
on public.user_data
for all
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());`}
            language="sql"
          />
        </div>
        <h3 className="text-xl font-semibold text-gray-900 mt-6">
          Supabase storage: per-user &quot;files&quot; bucket policy
        </h3>
        <p className="text-gray-700 leading-relaxed">
          Create a storage bucket named <BlogCode>files</BlogCode> and add a
          policy that restricts access to objects inside a folder named after
          the
          <BlogCode>user_id</BlogCode>. Save files to paths like
          <BlogCode>{"${auth.uid()}/avatar.png"}</BlogCode> so only the owner
          can read and write them.
        </p>
        <div className="mt-4">
          <CodeBlock
            code={`-- Create private bucket (no-op if it already exists)
insert into storage.buckets (id, name, public)
values ('files', 'files', false)
on conflict (id) do nothing;

-- Storage RLS policy (applied to storage.objects)
create policy "Users can manage files in their own folder"
on storage.objects
for all
to authenticated
using (((bucket_id = 'files'::text)
  and ((select (auth.uid())::text as uid) = (storage.foldername(name))[1])))
with check (((bucket_id = 'files'::text)
  and ((select (auth.uid())::text as uid) = (storage.foldername(name))[1])));`}
            language="sql"
          />
        </div>
        <h2 className="text-2xl font-semibold text-gray-900 mt-10">
          Lumen configuration
        </h2>
        Since many of my demos are AI based, I always want to put some limits
        per user to prevent abuse and track usage. I make a free account in{" "}
        <a
          href="https://getlumen.dev/login"
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-600 hover:text-blue-800 underline transition-colors"
        >
          Lumen
        </a>{" "}
        and skip adding Stripe API keys for now (or you can add them if you want
        to validate that users want to pay already). Then I create a free plan
        and I add the credits I want to allow per month.
        <div className="flex justify-center">
          <Image
            src="/lumen-starter-plan.png"
            alt="Create free plan with Lumen"
            width={400}
            height={400}
          />
        </div>
        <h2 className="text-2xl font-semibold text-gray-900 mt-10">
          Wrapping up
        </h2>
        This is the easiest way I found to build MVPs fast. Althought we built
        Lumen to process payments, it also helps build credit systems for AI
        even before implementing payments (I wish I had Lumen when I built the
        demo that got us into Y-Combinator).
        <br />
        Please let me know what you think, I reply to all the people who reach
        out! Email me at{" "}
        <a
          href="mailto:ramon@getlumen.dev"
          className="text-blue-600 hover:text-blue-800 underline transition-colors"
        >
          ramon@getlumen.dev
        </a>{" "}
        or message me on{" "}
        <a
          href="https://www.linkedin.com/in/ramon-garate-4b379093/"
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-600 hover:text-blue-800 underline transition-colors"
        >
          LinkedIn
        </a>{" "}
        or{" "}
        <a
          href="https://x.com/ramonverse"
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-600 hover:text-blue-800 underline transition-colors"
        >
          Twitter
        </a>
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
