export type SourceType = "mainstream" | "tech" | "niche";

export type Source = {
  name: string;
  url: string;
  type: SourceType;
  imageUrl?: string | null;
  publishedAt?: string;
};

export type Summaries = {
  fiveWs: string[];
  eli5: string;
  keyHighlights: string;
};

export type StoryCard = {
  id: string;
  headline: string;
  category: string;
  imageUrl: string | null;
  publishedAt: string;
  summaries: Summaries;
  sources: Source[];
  sourceCount: number;
};

export type FeedResponse = {
  stories: StoryCard[];
  cached?: boolean;
  stale?: boolean;
};

function getBaseUrl(): string {
  const explicit = process.env.EXPO_PUBLIC_API_URL;
  if (explicit) return explicit.replace(/\/$/, "");
  const domain = process.env.EXPO_PUBLIC_DOMAIN;
  if (domain) return `https://${domain}`;
  return "";
}

import { Platform } from "react-native";

export function proxiedImageUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (Platform.OS !== "web") return url;
  const base = getBaseUrl();
  if (!base) return url;
  return `${base}/api/news/image?url=${encodeURIComponent(url)}`;
}

export type ArticleResponse = {
  title?: string;
  byline?: string;
  summaryBullets: string[];
  // Cleaned/deduped paragraphs (Key Information tab).
  paragraphs: string[];
  // Raw extraction with no AI editing (Original tab). Optional for backwards
  // compatibility with older cache entries — fall back to `paragraphs` when
  // missing.
  originalParagraphs?: string[];
  cached?: boolean;
};

export async function fetchArticle(url: string): Promise<ArticleResponse> {
  const u = new URL(`${getBaseUrl()}/api/news/article`);
  u.searchParams.set("url", url);
  const res = await fetch(u.toString());
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Reader failed (${res.status}): ${body.slice(0, 160)}`);
  }
  return res.json() as Promise<ArticleResponse>;
}

// Fire-and-forget prefetch. Tells the API to warm its article cache for `url`
// so when the user actually opens the reader, the response is instant.
const prefetchedUrls = new Set<string>();
export function prefetchArticle(url: string): void {
  if (!url || prefetchedUrls.has(url)) return;
  prefetchedUrls.add(url);
  const u = new URL(`${getBaseUrl()}/api/news/article/prefetch`);
  u.searchParams.set("url", url);
  // Don't await; ignore errors.
  fetch(u.toString()).catch(() => {
    prefetchedUrls.delete(url);
  });
}

export async function fetchFeed(
  topic: string,
  refresh = false,
): Promise<FeedResponse> {
  const url = new URL(`${getBaseUrl()}/api/news/feed`);
  url.searchParams.set("topic", topic);
  if (refresh) url.searchParams.set("refresh", "1");
  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Feed failed (${res.status}): ${body.slice(0, 120)}`);
  }
  return res.json() as Promise<FeedResponse>;
}
