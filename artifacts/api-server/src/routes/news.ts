import { Router, type IRouter } from "express";
import { XMLParser } from "fast-xml-parser";
import { ai } from "@workspace/integrations-gemini-ai";

const router: IRouter = Router();

type Source = {
  name: string;
  url: string;
  type: "mainstream" | "tech" | "niche";
  imageUrl?: string | null;
  publishedAt?: string;
};

type StoryCard = {
  id: string;
  headline: string;
  category: string;
  imageUrl: string | null;
  publishedAt: string;
  summaries: {
    fiveWs: string[];
    eli5: string;
    keyHighlights: string;
  };
  sources: Source[];
  sourceCount: number;
};

type CacheEntry = { at: number; data: StoryCard[] };
const cache = new Map<string, CacheEntry>();
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;
const TECH_CACHE_TTL_MS = 30 * 60 * 1000;

function ttlFor(topic: string): number {
  return topic === "technology" ? TECH_CACHE_TTL_MS : DEFAULT_CACHE_TTL_MS;
}

const TOPIC_CATEGORY: Record<string, string> = {
  top: "top",
  technology: "technology",
  business: "business",
  science: "science",
  world: "world",
  sports: "sports",
  entertainment: "entertainment",
  health: "health",
  politics: "politics",
};

type NewsDataArticle = {
  article_id?: string;
  title?: string;
  description?: string | null;
  content?: string | null;
  link?: string;
  source_id?: string;
  source_name?: string;
  source_url?: string;
  pubDate?: string;
  image_url?: string | null;
  category?: string[] | null;
};

type RssSource = {
  id: string;
  name: string;
  url: string;
};

const TECH_RSS_SOURCES: RssSource[] = [
  { id: "techcrunch", name: "TechCrunch", url: "https://techcrunch.com/feed/" },
  { id: "theverge", name: "The Verge", url: "https://www.theverge.com/rss/index.xml" },
  {
    id: "arstechnica",
    name: "Ars Technica",
    url: "https://feeds.arstechnica.com/arstechnica/index",
  },
  { id: "gizmodo", name: "Gizmodo", url: "https://gizmodo.com/rss" },
  { id: "engadget", name: "Engadget", url: "https://www.engadget.com/rss.xml" },
  { id: "wired", name: "Wired", url: "https://www.wired.com/feed/rss" },
  { id: "9to5mac", name: "9to5Mac", url: "https://9to5mac.com/feed/" },
  {
    id: "mittech",
    name: "MIT Tech Review",
    url: "https://www.technologyreview.com/feed/",
  },
];

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  cdataPropName: "__cdata",
  trimValues: true,
});

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function pickText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj["__cdata"] === "string") return obj["__cdata"] as string;
    if (typeof obj["#text"] === "string") return obj["#text"] as string;
  }
  return "";
}

function decodeEntities(s: string): string {
  if (!s) return "";
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/&#8216;/g, "\u2018")
    .replace(/&#8217;/g, "\u2019")
    .replace(/&#8220;/g, "\u201C")
    .replace(/&#8221;/g, "\u201D")
    .replace(/&#8211;/g, "\u2013")
    .replace(/&#8212;/g, "\u2014")
    .replace(/&#8230;/g, "\u2026")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) =>
      String.fromCodePoint(parseInt(h, 16)),
    )
    .replace(/&#(\d+);/g, (_, n: string) =>
      String.fromCodePoint(parseInt(n, 10)),
    );
}

function stripHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function extractFirstImage(html: string): string | null {
  const m = /<img[^>]+src=["']([^"']+)["']/i.exec(html);
  return m?.[1] ?? null;
}

function extractOgImage(html: string): string | null {
  const patterns = [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i,
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m?.[1]) return m[1];
  }
  return null;
}

async function fetchOgImage(url: string): Promise<string | null> {
  if (!url) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3500);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; ParticleNews/1.0; +https://example.com)",
        Accept: "text/html",
      },
    });
    if (!res.ok) return null;
    const reader = res.body?.getReader();
    if (!reader) return null;
    const decoder = new TextDecoder("utf-8");
    let buf = "";
    let bytes = 0;
    while (bytes < 96_000) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      buf += decoder.decode(value, { stream: true });
      if (/<\/head>/i.test(buf)) break;
    }
    try {
      await reader.cancel();
    } catch {}
    return extractOgImage(buf);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parseRssFeed(
  xml: string,
  source: RssSource,
): NewsDataArticle[] {
  const parsed = xmlParser.parse(xml) as Record<string, unknown>;

  // RSS 2.0
  const rss = parsed["rss"] as { channel?: Record<string, unknown> } | undefined;
  if (rss?.channel) {
    const items = asArray(rss.channel["item"] as unknown);
    return items.map((raw) => {
      const item = raw as Record<string, unknown>;
      const title = decodeEntities(pickText(item["title"]));
      const link = pickText(item["link"]);
      const pubDate = pickText(item["pubDate"]);
      const descRaw = pickText(item["description"]);
      const contentRaw = pickText(item["content:encoded"]) || descRaw;

      let imageUrl: string | null = null;
      const enclosure = item["enclosure"] as
        | { "@_url"?: string; "@_type"?: string }
        | undefined;
      if (enclosure?.["@_url"] && enclosure["@_type"]?.startsWith("image")) {
        imageUrl = enclosure["@_url"];
      }
      const mediaContent = item["media:content"] as
        | { "@_url"?: string }
        | { "@_url"?: string }[]
        | undefined;
      if (!imageUrl) {
        const m = Array.isArray(mediaContent) ? mediaContent[0] : mediaContent;
        if (m?.["@_url"]) imageUrl = m["@_url"];
      }
      const mediaThumbnail = item["media:thumbnail"] as
        | { "@_url"?: string }
        | { "@_url"?: string }[]
        | undefined;
      if (!imageUrl) {
        const t = Array.isArray(mediaThumbnail) ? mediaThumbnail[0] : mediaThumbnail;
        if (t?.["@_url"]) imageUrl = t["@_url"];
      }
      if (!imageUrl) imageUrl = extractFirstImage(contentRaw);

      const description = stripHtml(descRaw).slice(0, 600);
      const content = stripHtml(contentRaw).slice(0, 2000);

      return {
        article_id: `${source.id}-${link || title}`,
        title,
        description,
        content,
        link,
        source_id: source.id,
        source_name: source.name,
        source_url: source.url,
        pubDate: pubDate ? new Date(pubDate).toISOString() : undefined,
        image_url: imageUrl,
        category: ["technology"],
      };
    });
  }

  // Atom (The Verge)
  const feed = parsed["feed"] as Record<string, unknown> | undefined;
  if (feed) {
    const entries = asArray(feed["entry"] as unknown);
    return entries.map((raw) => {
      const entry = raw as Record<string, unknown>;
      const title = decodeEntities(pickText(entry["title"]));
      const linkAttr = entry["link"] as
        | { "@_href"?: string }
        | { "@_href"?: string }[]
        | undefined;
      let link = "";
      if (Array.isArray(linkAttr)) {
        link = linkAttr.find((l) => l["@_href"])?.["@_href"] ?? "";
      } else if (linkAttr?.["@_href"]) {
        link = linkAttr["@_href"];
      }
      const published =
        pickText(entry["published"]) || pickText(entry["updated"]);
      const summaryRaw = pickText(entry["summary"]);
      const contentRaw = pickText(entry["content"]) || summaryRaw;
      const imageUrl = extractFirstImage(contentRaw) ?? extractFirstImage(summaryRaw);
      const description = stripHtml(summaryRaw).slice(0, 600);
      const content = stripHtml(contentRaw).slice(0, 2000);

      return {
        article_id: `${source.id}-${link || title}`,
        title,
        description,
        content,
        link,
        source_id: source.id,
        source_name: source.name,
        source_url: source.url,
        pubDate: published ? new Date(published).toISOString() : undefined,
        image_url: imageUrl,
        category: ["technology"],
      };
    });
  }

  return [];
}

async function fetchOneRssFeed(source: RssSource): Promise<NewsDataArticle[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(source.url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; ParticleNews/1.0; +https://example.com)",
        Accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8",
      },
    });
    if (!res.ok) {
      throw new Error(`${source.name} ${res.status}`);
    }
    const xml = await res.text();
    return parseRssFeed(xml, source);
  } finally {
    clearTimeout(timer);
  }
}

const ogImageCache = new Map<string, { url: string | null; ts: number }>();
const OG_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

async function getOgImageCached(articleUrl: string): Promise<string | null> {
  const cached = ogImageCache.get(articleUrl);
  if (cached && Date.now() - cached.ts < OG_CACHE_TTL_MS) {
    return cached.url;
  }
  const url = await fetchOgImage(articleUrl);
  ogImageCache.set(articleUrl, { url, ts: Date.now() });
  return url;
}

async function fetchTechRss(): Promise<NewsDataArticle[]> {
  const results = await Promise.allSettled(
    TECH_RSS_SOURCES.map((s) => fetchOneRssFeed(s)),
  );
  const articles: NewsDataArticle[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") articles.push(...r.value);
  }
  // Sort newest first, cap at 24 to keep clustering input lean
  articles.sort((a, b) => {
    const ta = a.pubDate ? Date.parse(a.pubDate) : 0;
    const tb = b.pubDate ? Date.parse(b.pubDate) : 0;
    return tb - ta;
  });
  const top = articles.slice(0, 80);

  // Enrich items missing image_url by scraping og:image (parallel, time-boxed).
  const needs = top
    .map((a, i) => ({ a, i }))
    .filter(({ a }) => !a.image_url && a.link);
  if (needs.length > 0) {
    const enriched = await Promise.allSettled(
      needs.map(({ a }) => getOgImageCached(a.link!)),
    );
    enriched.forEach((res, idx) => {
      if (res.status === "fulfilled" && res.value) {
        const target = needs[idx]!.a;
        target.image_url = res.value;
      }
    });
  }

  return top;
}

async function fetchNewsData(topic: string): Promise<NewsDataArticle[]> {
  const apiKey = process.env["NEWSDATA_API_KEY"];
  if (!apiKey) throw new Error("NEWSDATA_API_KEY missing");

  const category = TOPIC_CATEGORY[topic] ?? "top";
  const url = new URL("https://newsdata.io/api/1/latest");
  url.searchParams.set("apikey", apiKey);
  url.searchParams.set("language", "en");
  url.searchParams.set("category", category);
  url.searchParams.set("size", "10");
  url.searchParams.set("removeduplicate", "1");

  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`NewsData ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { results?: NewsDataArticle[] };
  return json.results ?? [];
}

type ClusterResult = {
  clusters: {
    headline: string;
    category: string;
    article_indexes: number[];
    fiveWs: string[];
    eli5: string;
    keyHighlights: string;
    source_types: ("mainstream" | "tech" | "niche")[];
  }[];
};

async function clusterAndSummarize(
  articles: NewsDataArticle[],
): Promise<ClusterResult> {
  const compact = articles.map((a, i) => ({
    i,
    title: a.title ?? "",
    desc: (a.description ?? a.content ?? "").slice(0, 400),
    source: a.source_name ?? a.source_id ?? "Unknown",
  }));

  const prompt = `You are a news editor for a premium aggregator like Particle News. Below is a JSON array of news articles. Group articles covering the same underlying STORY into clusters (use 1-element clusters for unique stories). For each cluster:

1. Write a single neutral, sharp headline (10-14 words max).
2. Pick the best matching category (one of: World, Politics, Business, Technology, Science, Health, Sports, Entertainment).
3. Write THREE summary modes. ANTI-FLUFF rules: NO repetitive sentences, NO redundant background, NO filler phrases ("In a world where...", "It is important to note...", "In conclusion..."). Only unique, high-density facts. Plain prose, no bullet markers, no headings.
   - "fiveWs": ARRAY of EXACTLY 5 strings. Each entry MUST start with the literal label and a colon, in this exact order: "WHO: ...", "WHAT: ...", "WHEN: ...", "WHERE: ...", "WHY: ...". Each answer is a complete sentence of 18-32 words.
   - "eli5": ONE string. A single 90-110 word PARAGRAPH explaining the story like the reader is 11. Plain language, concrete analogies, conversational. NO bullets, NO labels, NO line breaks.
   - "keyHighlights": ONE string. A single 90-110 word PARAGRAPH delivering the most newsworthy facts, numbers, quotes, and implications in a tight neutral voice. NO bullets, NO labels, NO line breaks.
4. For each source in the cluster, classify its type: "mainstream" (e.g. Reuters, BBC, AP, NYT, CNN, WSJ, Bloomberg, Guardian), "tech" (e.g. TechCrunch, The Verge, Ars Technica, Wired, Engadget, 9to5Mac), or "niche" (specialty/regional/independent blogs).

Return STRICT JSON ONLY matching this TypeScript type:
{
  "clusters": [
    {
      "headline": string,
      "category": string,
      "article_indexes": number[],
      "fiveWs": string[],
      "eli5": string,
      "keyHighlights": string,
      "source_types": ("mainstream"|"tech"|"niche")[]
    }
  ]
}

source_types must have the SAME length and order as article_indexes.

Articles:
${JSON.stringify(compact)}`;

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: {
      maxOutputTokens: 16384,
      responseMimeType: "application/json",
    },
  });

  const text = response.text ?? "{}";
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .replace(/,(\s*[\]}])/g, "$1");
  let parsed: ClusterResult;
  try {
    parsed = JSON.parse(cleaned) as ClusterResult;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1) throw new Error("Gemini returned non-JSON");
    parsed = JSON.parse(cleaned.slice(start, end + 1)) as ClusterResult;
  }
  if (!parsed.clusters || !Array.isArray(parsed.clusters)) {
    throw new Error("Invalid cluster response");
  }
  return parsed;
}

// Splits articles into chunks and runs clusterAndSummarize on each in parallel.
// Failed chunks fall back to per-article singletons with naive bullets so they
// still render with at least keyHighlights populated.
async function clusterAndSummarizeBatched(
  articles: NewsDataArticle[],
): Promise<ClusterResult> {
  const CHUNK_SIZE = 20;
  const chunks: NewsDataArticle[][] = [];
  for (let i = 0; i < articles.length; i += CHUNK_SIZE) {
    chunks.push(articles.slice(i, i + CHUNK_SIZE));
  }
  const results = await Promise.allSettled(
    chunks.map((chunk) => clusterAndSummarize(chunk)),
  );
  const merged: ClusterResult = { clusters: [] };
  let offset = 0;
  let okChunks = 0;
  results.forEach((r, idx) => {
    const chunkLen = chunks[idx]!.length;
    if (r.status === "fulfilled") {
      okChunks += 1;
      r.value.clusters.forEach((c) => {
        merged.clusters.push({
          ...c,
          article_indexes: c.article_indexes.map((i) => i + offset),
        });
      });
    } else {
      // Chunk failed: emit singleton clusters with naive paragraphs so the
      // cards still show 5Ws/ELI5/keyHighlights derived from the description.
      for (let i = 0; i < chunkLen; i++) {
        const a = articles[offset + i]!;
        const desc = a.description ?? a.content ?? "";
        merged.clusters.push({
          headline: a.title ?? "Untitled",
          category: "Technology",
          article_indexes: [offset + i],
          fiveWs: naiveFiveWs(desc),
          eli5: naiveParagraph(desc),
          keyHighlights: naiveParagraph(desc),
          source_types: [
            classifySource(a.link ?? "", a.source_name ?? "") as
              | "mainstream"
              | "tech"
              | "niche",
          ],
        });
      }
    }
    offset += chunkLen;
  });
  if (okChunks === 0) {
    throw new Error("All Gemini chunks failed");
  }
  return merged;
}

const MAINSTREAM_HOSTS = [
  "reuters",
  "bbc",
  "apnews",
  "ap.org",
  "nytimes",
  "cnn",
  "wsj",
  "bloomberg",
  "guardian",
  "washingtonpost",
  "ft.com",
  "aljazeera",
  "npr",
];
const TECH_HOSTS = [
  "techcrunch",
  "theverge",
  "arstechnica",
  "wired",
  "engadget",
  "9to5mac",
  "9to5google",
  "thenextweb",
  "venturebeat",
  "gizmodo",
  "mashable",
];

function classifySource(url: string, name: string): Source["type"] {
  const blob = `${url} ${name}`.toLowerCase();
  if (MAINSTREAM_HOSTS.some((h) => blob.includes(h))) return "mainstream";
  if (TECH_HOSTS.some((h) => blob.includes(h))) return "tech";
  return "niche";
}

function pickCategory(article: NewsDataArticle): string {
  const raw = article.category?.[0]?.toLowerCase();
  if (!raw) return "Top";
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function naiveBullets(text: string, count: number): string[] {
  if (!text) return [];
  const sentences = text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12);
  return sentences.slice(0, count);
}

const FIVE_W_LABELS = ["WHO", "WHAT", "WHEN", "WHERE", "WHY"];

function naiveFiveWs(text: string): string[] {
  const bullets = naiveBullets(text, 5);
  return bullets.map((s, i) => `${FIVE_W_LABELS[i]}: ${s}`);
}

// Squash a description into a single ~100 word paragraph, used as a
// last-resort fallback when AI summarization fails.
function naiveParagraph(text: string): string {
  if (!text) return "";
  const compact = text
    .replace(/\s+/g, " ")
    .trim();
  const words = compact.split(" ");
  if (words.length <= 110) return compact;
  return words.slice(0, 110).join(" ") + "…";
}

function buildFallbackStories(articles: NewsDataArticle[]): StoryCard[] {
  return articles.map((a, idx) => {
    const text = (a.description ?? a.content ?? a.title ?? "").trim();
    const sourceName = a.source_name ?? a.source_id ?? "Unknown";
    const sourceUrl = a.link ?? "";
    const sourceType = classifySource(sourceUrl, sourceName);

    const headline = (a.title ?? text.slice(0, 90) ?? "Untitled").trim();
    const fiveWs = naiveFiveWs(text);
    const paragraph = naiveParagraph(text);

    return {
      id: `${Date.now()}-${idx}-${a.article_id ?? idx}`,
      headline,
      category: pickCategory(a),
      imageUrl: a.image_url ?? null,
      publishedAt: a.pubDate ?? new Date().toISOString(),
      summaries: {
        fiveWs,
        eli5: paragraph,
        keyHighlights: paragraph,
      },
      sources: [
        {
          name: sourceName,
          url: sourceUrl,
          type: sourceType,
          imageUrl: a.image_url ?? null,
          publishedAt: a.pubDate ?? undefined,
        },
      ],
      sourceCount: 1,
    };
  });
}

function buildStoryCards(
  articles: NewsDataArticle[],
  clusters: ClusterResult,
): StoryCard[] {
  return clusters.clusters.map((cluster, idx) => {
    const clusterArticles = cluster.article_indexes
      .map((i) => articles[i])
      .filter((a): a is NewsDataArticle => Boolean(a));

    const sources: Source[] = clusterArticles.map((a, i) => ({
      name: a.source_name ?? a.source_id ?? "Unknown",
      url: a.link ?? "",
      type: cluster.source_types?.[i] ?? "niche",
      imageUrl: a.image_url ?? null,
      publishedAt: a.pubDate ?? undefined,
    }));

    const firstWithImage = clusterArticles.find((a) => a.image_url);
    const firstArticle = clusterArticles[0];

    return {
      id: `${Date.now()}-${idx}-${firstArticle?.article_id ?? idx}`,
      headline: cluster.headline,
      category: cluster.category,
      imageUrl: firstWithImage?.image_url ?? null,
      publishedAt: firstArticle?.pubDate ?? new Date().toISOString(),
      summaries: {
        fiveWs: cluster.fiveWs ?? [],
        eli5: typeof cluster.eli5 === "string" ? cluster.eli5 : "",
        keyHighlights:
          typeof cluster.keyHighlights === "string"
            ? cluster.keyHighlights
            : "",
      },
      sources,
      sourceCount: sources.length,
    };
  });
}

async function buildFreshFeed(topic: string): Promise<StoryCard[]> {
  const articles =
    topic === "technology"
      ? await fetchTechRss()
      : await fetchNewsData(topic);
  if (articles.length === 0) return [];
  try {
    const clusters = await clusterAndSummarizeBatched(articles);
    return buildStoryCards(articles, clusters);
  } catch {
    return buildFallbackStories(articles);
  }
}

const inflightFeed = new Map<string, Promise<StoryCard[]>>();

function refreshInBackground(topic: string, log: { warn: Function }): void {
  if (inflightFeed.has(topic)) return;
  const p = buildFreshFeed(topic)
    .then((stories) => {
      cache.set(topic, { at: Date.now(), data: stories });
      return stories;
    })
    .catch((err) => {
      log.warn({ err, topic }, "background refresh failed");
      return [] as StoryCard[];
    })
    .finally(() => {
      inflightFeed.delete(topic);
    });
  inflightFeed.set(topic, p);
}

router.get("/feed", async (req, res) => {
  const topic = String(req.query["topic"] ?? "top").toLowerCase();
  const refresh = req.query["refresh"] === "1";
  const cached = cache.get(topic);
  const isFresh = cached && Date.now() - cached.at < ttlFor(topic);

  // Fast path: return cached data if fresh.
  if (!refresh && isFresh) {
    res.json({ stories: cached.data, cached: true });
    return;
  }

  // Stale-while-revalidate: if user hit refresh OR cache is stale, return what
  // we have immediately and refetch in the background. The next request will
  // see the fresh data.
  if (cached) {
    refreshInBackground(topic, req.log);
    res.json({ stories: cached.data, cached: true, stale: true });
    return;
  }

  // Cold path (no cache at all): user has to wait for the first build.
  // De-dupe concurrent first-time fetches with inflightFeed.
  let p = inflightFeed.get(topic);
  if (!p) {
    p = buildFreshFeed(topic)
      .then((stories) => {
        cache.set(topic, { at: Date.now(), data: stories });
        return stories;
      })
      .finally(() => {
        inflightFeed.delete(topic);
      });
    inflightFeed.set(topic, p);
  }
  try {
    const stories = await p;
    res.json({ stories, cached: false, source: "ai" });
  } catch (err) {
    req.log.error({ err }, "feed cold fetch failed");
    res.status(502).json({
      error: err instanceof Error ? err.message : "News provider unavailable",
    });
  }
});

type ArticleResult = {
  title?: string;
  summaryBullets: string[];
  paragraphs: string[];
  byline?: string;
};

const articleCache = new Map<string, { at: number; data: ArticleResult }>();
const ARTICLE_TTL_MS = 60 * 60 * 1000;

function stripHtmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<aside[\s\S]*?<\/aside>/gi, " ")
    .replace(/<form[\s\S]*?<\/form>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--([\s\S]*?)-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|br|section|article)>/gi, "\n")
    .replace(/<br\s*\/?>(?!\n)/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n\n")
    .trim();
}

async function fetchArticleText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  if (!res.ok) {
    throw new Error(`Source ${res.status}`);
  }
  const html = await res.text();
  const text = stripHtmlToText(html);
  return text.slice(0, 12000);
}

function fallbackParagraphs(rawText: string): string[] {
  return rawText
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 80 && p.split(" ").length > 12)
    .slice(0, 40);
}

async function extractReadable(
  url: string,
  rawText: string,
): Promise<ArticleResult> {
  const prompt = `You will receive raw extracted text from a news article web page. Your job is to produce a clean READER MODE version of the article.

Rules:
- Remove navigation, cookie banners, related-stories teasers, ads, social CTAs, author bios, comments, and boilerplate.
- Keep only the substantive article body.
- Preserve original wording — do NOT rewrite paragraphs. Only clean and split.
- Split the article into well-formed paragraphs (3-7 sentences each, no markdown).
- Drop any paragraph that is repetitive, navigation, or filler.
- Provide a "summaryBullets" field: 4-5 bullet pointers totaling about 100 words combined (90-110 words). Each bullet should be a single concise sentence covering Who/What, Numbers, Why it matters, What's next. NO fluff.
- Provide "title" (article headline) and optional "byline" (author/source line).

Return STRICT JSON ONLY:
{
  "title": string,
  "byline": string,
  "summaryBullets": string[],
  "paragraphs": string[]
}

Article URL: ${url}

Raw extracted text:
${rawText}`;

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: {
      maxOutputTokens: 8192,
      responseMimeType: "application/json",
    },
  });

  const text = response.text ?? "{}";
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .replace(/,(\s*[\]}])/g, "$1");
  let parsed: ArticleResult;
  try {
    parsed = JSON.parse(cleaned) as ArticleResult;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1) throw new Error("Gemini returned non-JSON");
    parsed = JSON.parse(cleaned.slice(start, end + 1)) as ArticleResult;
  }
  if (!Array.isArray(parsed.paragraphs)) parsed.paragraphs = [];
  if (!Array.isArray(parsed.summaryBullets)) parsed.summaryBullets = [];
  return parsed;
}

router.get("/article", async (req, res) => {
  const url = String(req.query["url"] ?? "");
  if (!url || !/^https?:\/\//i.test(url)) {
    res.status(400).json({ error: "Invalid url" });
    return;
  }

  const cached = articleCache.get(url);
  if (cached && Date.now() - cached.at < ARTICLE_TTL_MS) {
    res.json({ ...cached.data, cached: true });
    return;
  }

  try {
    const rawText = await fetchArticleText(url);
    if (rawText.length < 200) {
      throw new Error("Article body too short to extract");
    }
    let data: ArticleResult;
    try {
      data = await extractReadable(url, rawText);
      if (!data.paragraphs?.length) {
        data.paragraphs = fallbackParagraphs(rawText);
      }
    } catch (geminiErr) {
      req.log.warn({ err: geminiErr }, "gemini extract failed; using raw");
      data = {
        summaryBullets: [],
        paragraphs: fallbackParagraphs(rawText),
      };
    }
    articleCache.set(url, { at: Date.now(), data });
    res.json({ ...data, cached: false });
  } catch (err) {
    req.log.error({ err }, "article extract failed");
    res.status(502).json({
      error: err instanceof Error ? err.message : "Couldn't fetch article",
    });
  }
});

router.get("/image", async (req, res) => {
  const url = String(req.query["url"] ?? "");
  if (!url || !/^https?:\/\//i.test(url)) {
    res.status(400).send("Invalid url");
    return;
  }
  try {
    const upstream = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      },
    });
    if (!upstream.ok || !upstream.body) {
      res.status(upstream.status || 502).send("Upstream image failed");
      return;
    }
    const contentType = upstream.headers.get("content-type") ?? "image/jpeg";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.end(buf);
  } catch (err) {
    req.log.warn({ err }, "image proxy failed");
    res.status(502).send("Image proxy failed");
  }
});

export default router;
