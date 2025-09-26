import Image from "next/image";
import Link from "next/link";

import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { blogPosts } from "./blogs";

export default function BlogPage() {
  return (
    <div className="max-w-6xl mx-auto px-6 py-12">
      <h1 className="text-3xl font-semibold tracking-tight">Blog</h1>

      <div className="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {blogPosts
          .slice()
          .reverse()
          .map((post) => (
            <Link key={post.href} href={post.href} className="group">
              <Card className="h-full transition-shadow group-hover:shadow-md">
                <div className="px-6">
                  <div className="relative aspect-[16/9] w-full overflow-hidden rounded-lg bg-muted">
                    <Image
                      src={post.imageSrc}
                      alt={post.title}
                      fill
                      sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
                      className="object-cover"
                      priority={false}
                    />
                  </div>
                </div>
                <CardHeader>
                  <p className="text-sm text-gray-500">{post.date}</p>
                  <CardTitle>{post.title}</CardTitle>
                  <CardDescription>{post.description}</CardDescription>
                </CardHeader>
              </Card>
            </Link>
          ))}
      </div>
    </div>
  );
}
