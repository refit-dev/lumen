import { blogPosts } from "../blogs";
import { redirect } from "next/navigation";

function normalizeToTokens(input: string): string[] {
  const normalized = input
    .toLowerCase()
    .replace(/-/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? normalized.split(" ") : [];
}

function compact(input: string): string {
  return input.toLowerCase().replace(/[-\s]/g, "");
}

function getBestMatchHref(query: string): string | null {
  const queryTokens = normalizeToTokens(query);
  const queryCompact = compact(query);

  let bestHref: string | null = null;
  let bestScore = -1;

  for (const post of blogPosts) {
    const slug = post.href.split("/").filter(Boolean).pop() || "";

    const titleTokens = normalizeToTokens(post.title);
    const slugTokens = normalizeToTokens(slug);
    const candidateTokens = Array.from(
      new Set([...titleTokens, ...slugTokens])
    );

    let score = 0;
    const candidateSet = new Set(candidateTokens);
    for (const token of queryTokens) {
      if (candidateSet.has(token)) score += 1;
    }

    const titleCompact = compact(post.title);
    const slugCompact = compact(slug);

    if (queryCompact === titleCompact || queryCompact === slugCompact) {
      return post.href;
    }

    if (
      titleCompact.includes(queryCompact) ||
      slugCompact.includes(queryCompact)
    ) {
      score += 0.5;
    }

    if (score > bestScore) {
      bestScore = score;
      bestHref = post.href;
    }
  }

  return bestScore > 0 ? bestHref : null;
}

export default async function CatchAllPage({
  params,
}: {
  params: Promise<{ catchAll: string }>;
}) {
  const { catchAll } = await params;
  const match = getBestMatchHref(catchAll);
  if (match) {
    redirect(match);
  }
  redirect("/blog");
}
