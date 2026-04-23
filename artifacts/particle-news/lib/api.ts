export type SourceType = "mainstream" | "tech" | "niche";

export type Source = {
  name: string;
  url: string;
  type: SourceType;
};

export type Summaries = {
  fiveWs: string[];
  eli5: string[];
  keyHighlights: string[];
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
  const domain = process.env.EXPO_PUBLIC_DOMAIN;
  if (domain) return `https://${domain}`;
  return "";
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
