import { Router, type IRouter } from "express";
import { XMLParser } from "fast-xml-parser";
import { ai } from "@workspace/integrations-gemini-ai";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

const router: IRouter = Router();

// Disk cache lives in /tmp so it survives in-process restarts within the same
// container (dev workflow restarts, autoscale instance reuse). Replit Autoscale
// instances get a fresh /tmp on cold-start, so this is best-effort persistence
// — the prewarm worker handles the rest.
const FEED_DISK_CACHE_PATH = "/tmp/particle-news-feed-cache.json";
const CHUNK_DISK_CACHE_PATH = "/tmp/particle-news-chunk-cache.json";

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

// ----- Persistent disk cache -----
function safeWriteJson(path: string, payload: unknown): void {
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(payload), "utf8");
  } catch {
    // best-effort; ignore disk errors
  }
}

function safeReadJson<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function persistFeedCache(): void {
  const snapshot: Record<string, CacheEntry> = {};
  for (const [topic, entry] of cache.entries()) {
    snapshot[topic] = entry;
  }
  safeWriteJson(FEED_DISK_CACHE_PATH, snapshot);
}

function loadFeedCacheFromDisk(): void {
  const snapshot = safeReadJson<Record<string, CacheEntry>>(FEED_DISK_CACHE_PATH);
  if (!snapshot) return;
  for (const [topic, entry] of Object.entries(snapshot)) {
    if (entry?.data && Array.isArray(entry.data)) {
      cache.set(topic, entry);
    }
  }
}

// ----- Per-chunk cluster cache -----
// Hashes the article set in a Gemini chunk and caches the clustered result.
// If the same articles appear again (e.g. unchanged RSS items between refreshes),
// we skip the Gemini call entirely.
type ChunkCacheEntry = { at: number; result: ClusterResult };
const chunkCache = new Map<string, ChunkCacheEntry>();
const CHUNK_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CHUNK_CACHE_MAX_ENTRIES = 500;

function chunkHash(articles: NewsDataArticle[]): string {
  const fingerprint = articles
    .map((a) => `${a.source_id ?? ""}|${a.link ?? ""}|${a.title ?? ""}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(fingerprint).digest("hex");
}

function getCachedChunk(hash: string): ClusterResult | null {
  const entry = chunkCache.get(hash);
  if (!entry) return null;
  if (Date.now() - entry.at > CHUNK_CACHE_TTL_MS) {
    chunkCache.delete(hash);
    return null;
  }
  return entry.result;
}

function setCachedChunk(hash: string, result: ClusterResult): void {
  if (chunkCache.size >= CHUNK_CACHE_MAX_ENTRIES) {
    // simple eviction: drop the oldest entry
    const oldestKey = chunkCache.keys().next().value;
    if (oldestKey) chunkCache.delete(oldestKey);
  }
  chunkCache.set(hash, { at: Date.now(), result });
}

function persistChunkCache(): void {
  const snapshot: Record<string, ChunkCacheEntry> = {};
  for (const [hash, entry] of chunkCache.entries()) {
    snapshot[hash] = entry;
  }
  safeWriteJson(CHUNK_DISK_CACHE_PATH, snapshot);
}

function loadChunkCacheFromDisk(): void {
  const snapshot = safeReadJson<Record<string, ChunkCacheEntry>>(
    CHUNK_DISK_CACHE_PATH,
  );
  if (!snapshot) return;
  const now = Date.now();
  for (const [hash, entry] of Object.entries(snapshot)) {
    if (entry?.result && now - entry.at < CHUNK_CACHE_TTL_MS) {
      chunkCache.set(hash, entry);
    }
  }
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
  { id: "9to5google", name: "9to5Google", url: "https://9to5google.com/feed/" },
  { id: "venturebeat", name: "VentureBeat", url: "https://venturebeat.com/feed/" },
  { id: "thenextweb", name: "The Next Web", url: "https://thenextweb.com/feed/" },
  { id: "hackernews", name: "Hacker News", url: "https://hnrss.org/frontpage" },
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
  const CHUNK_SIZE = 10;
  const chunks: NewsDataArticle[][] = [];
  for (let i = 0; i < articles.length; i += CHUNK_SIZE) {
    chunks.push(articles.slice(i, i + CHUNK_SIZE));
  }
  // For each chunk, check the per-chunk cache first; only call Gemini for misses.
  const chunkHashes = chunks.map((c) => chunkHash(c));
  let chunkCacheHits = 0;
  let chunkCacheWrites = 0;
  const results = await Promise.allSettled(
    chunks.map(async (chunk, idx) => {
      const hash = chunkHashes[idx]!;
      const cached = getCachedChunk(hash);
      if (cached) {
        chunkCacheHits += 1;
        return cached;
      }
      const fresh = await clusterAndSummarize(chunk);
      setCachedChunk(hash, fresh);
      chunkCacheWrites += 1;
      return fresh;
    }),
  );
  if (chunkCacheWrites > 0) persistChunkCache();
  // eslint-disable-next-line no-console
  console.log(
    `[clustering] chunks=${chunks.length} cacheHits=${chunkCacheHits} fresh=${chunkCacheWrites}`,
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

// Minimum number of distinct publisher hostnames a refresh must produce before
// we'll let it overwrite an existing healthy cache entry. Prevents a cold-start
// scenario where only one RSS source returned in time from poisoning the cache
// for the next TTL window.
const MIN_HEALTHY_PUBLISHERS = 3;

function distinctPublisherCount(stories: StoryCard[]): number {
  const hosts = new Set<string>();
  for (const story of stories) {
    for (const src of story.sources ?? []) {
      try {
        if (src.url) hosts.add(new URL(src.url).hostname.replace(/^www\./, ""));
      } catch {
        // ignore unparseable URLs
      }
    }
  }
  return hosts.size;
}

function refreshInBackground(
  topic: string,
  log: { warn: (...args: unknown[]) => void },
): void {
  if (inflightFeed.has(topic)) return;
  const started = Date.now();
  const p = buildFreshFeed(topic)
    .then((stories) => {
      const freshPubs = distinctPublisherCount(stories);
      const existing = cache.get(topic);
      const existingPubs = existing ? distinctPublisherCount(existing.data) : 0;

      // Skip the cache write if this refresh is degraded (too few publishers)
      // AND we already have a healthier entry. Don't regress the cache just
      // because some RSS feeds were slow this round. We still return `stories`
      // to any in-flight awaiter so they get something rather than nothing.
      const isDegraded = freshPubs < MIN_HEALTHY_PUBLISHERS;
      const shouldKeepExisting =
        isDegraded && existing && existingPubs > freshPubs;

      if (shouldKeepExisting) {
        // eslint-disable-next-line no-console
        console.log(
          `[prewarm] ${topic} SKIPPED cache write (degraded: ${freshPubs} publishers, ${stories.length} stories) — keeping existing (${existingPubs} publishers, ${existing.data.length} stories)`,
        );
      } else {
        // Use a CONTENT fingerprint (not StoryCard.id, which is Date.now()-
        // based and therefore changes every refresh) to detect new clusters.
        // Without this, every prewarm cycle would treat all stories as new
        // and spam users with push notifications.
        const previousFps = new Set(
          (existing?.data ?? []).map(clusterFingerprint),
        );
        cache.set(topic, { at: Date.now(), data: stories });
        persistFeedCache();
        // eslint-disable-next-line no-console
        console.log(
          `[prewarm] ${topic} refreshed in ${Date.now() - started}ms (${stories.length} stories, ${freshPubs} publishers${isDegraded ? " — DEGRADED but accepted (no prior cache)" : ""})`,
        );
        // Fire-and-forget push notifications for new clusters. Skip on the
        // very first prewarm (no `existing`) to avoid pushing the entire
        // initial feed at boot.
        if (existing) {
          notifyOnNewClusters(stories, previousFps).catch(() => {});
        }
      }
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

// ----- Push notification fan-out -----
// Tracks which cluster fingerprints we've already pushed in the past 24h so we
// never double-notify even if a story stays in the cache across multiple
// refreshes. The fingerprint hashes the cluster's source URLs + headline so it
// is stable across refreshes (unlike StoryCard.id, which uses Date.now()).
const sentFingerprints = new Map<string, number>();
const SENT_TTL_MS = 24 * 60 * 60 * 1000;

function clusterFingerprint(s: StoryCard): string {
  const urls = (s.sources ?? [])
    .map((src) => (src.url ?? "").trim().toLowerCase())
    .filter((u) => u.length > 0)
    .sort()
    .join("|");
  const head = (s.headline ?? "").trim().toLowerCase().slice(0, 200);
  return createHash("sha256").update(`${head}\n${urls}`).digest("hex");
}

function rememberSent(fp: string): void {
  // Cheap GC: prune expired entries when the map grows.
  if (sentFingerprints.size > 1000) {
    const cutoff = Date.now() - SENT_TTL_MS;
    for (const [k, v] of sentFingerprints.entries()) {
      if (v < cutoff) sentFingerprints.delete(k);
    }
  }
  sentFingerprints.set(fp, Date.now());
}

function alreadySent(fp: string): boolean {
  const at = sentFingerprints.get(fp);
  if (!at) return false;
  if (Date.now() - at > SENT_TTL_MS) {
    sentFingerprints.delete(fp);
    return false;
  }
  return true;
}

async function notifyOnNewClusters(
  stories: StoryCard[],
  previousFps: Set<string>,
): Promise<void> {
  // Tag each cluster with its fingerprint so we filter and send-side dedupe
  // using the same key.
  const tagged = stories.map((s) => ({ s, fp: clusterFingerprint(s) }));
  const newClusters = tagged.filter(
    ({ fp }) => !previousFps.has(fp) && !alreadySent(fp),
  );
  if (newClusters.length === 0) return;

  // Lazy-load DB + push sender so this module can boot without a DB at all if
  // it's broken — the news API still works.
  let db: typeof import("@workspace/db").db;
  let notificationPrefsTable: typeof import("@workspace/db").notificationPrefsTable;
  let sendPushToTokens: typeof import("../lib/push-sender").sendPushToTokens;
  try {
    const dbMod = await import("@workspace/db");
    db = dbMod.db;
    notificationPrefsTable = dbMod.notificationPrefsTable;
    const senderMod = await import("../lib/push-sender");
    sendPushToTokens = senderMod.sendPushToTokens;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[push] skipped fan-out (db/sender import failed):", err);
    return;
  }

  // Fetch all opted-in users once.
  const allPrefs = await db.select().from(notificationPrefsTable);
  if (allPrefs.length === 0) return;

  const breakingTokens = allPrefs
    .filter((p) => p.breakingEnabled)
    .map((p) => p.token);
  const topicSubs = allPrefs
    .filter((p) => p.topicsEnabled && p.topicsKeywords.length > 0)
    .map((p) => ({ token: p.token, kws: p.topicsKeywords }));

  for (const { s: cluster, fp } of newClusters) {
    const isBreaking = (cluster.sourceCount ?? cluster.sources?.length ?? 0) >= 3;

    // B) Breaking news: 3+ publisher confirmation
    if (isBreaking && breakingTokens.length > 0) {
      await sendPushToTokens(breakingTokens, {
        title: "Breaking",
        body: cluster.headline,
        data: { kind: "breaking", clusterId: cluster.id, fp },
      });
    }

    // C) Topic alerts: per-user keyword match against headline + category.
    if (topicSubs.length > 0) {
      const haystack = `${cluster.headline} ${cluster.category ?? ""}`.toLowerCase();
      const matched: string[] = [];
      for (const sub of topicSubs) {
        if (sub.kws.some((k: string) => haystack.includes(k)))
          matched.push(sub.token);
      }
      if (matched.length > 0) {
        await sendPushToTokens(matched, {
          title: "Topic alert",
          body: cluster.headline,
          data: { kind: "topic", clusterId: cluster.id, fp },
        });
      }
    }

    rememberSent(fp);
  }
}

// ----- Background prewarm worker -----
// Keeps the feed cache always warm so user requests are sub-100ms.
// Runs on module load and every PREWARM_INTERVAL_MS thereafter.
const PREWARM_TOPICS = ["technology"];
const PREWARM_INTERVAL_MS = 2 * 60 * 1000;

const noopLog = { warn: () => {} };

function prewarmAll(): void {
  for (const topic of PREWARM_TOPICS) {
    refreshInBackground(topic, noopLog);
  }
}

// Hydrate from disk first (so we have something to serve even before the first
// prewarm completes), then kick off an immediate prewarm and a recurring timer.
loadFeedCacheFromDisk();
loadChunkCacheFromDisk();
// eslint-disable-next-line no-console
console.log(
  `[boot] feedCache=${cache.size} topics, chunkCache=${chunkCache.size} entries`,
);
// Don't block boot — fire and forget.
setTimeout(prewarmAll, 500);
setInterval(prewarmAll, PREWARM_INTERVAL_MS).unref();

// Filter clusters down to those that include at least one source matching the
// given source id (e.g. "techcrunch"). Source ids align with the RSS source
// list in TECH_RSS_SOURCES — we match by hostname containment so it works for
// both raw articles and AI-clustered output.
function filterStoriesBySource(
  stories: StoryCard[],
  sourceId: string,
): StoryCard[] {
  const id = sourceId.toLowerCase();
  const rssSource = TECH_RSS_SOURCES.find((s) => s.id === id);
  let matchHost: string | null = null;
  try {
    matchHost = rssSource ? new URL(rssSource.url).hostname.replace(/^www\./, "") : null;
  } catch {
    matchHost = null;
  }
  // Hacker News special case: the feed lives on hnrss.org but story links go
  // to news.ycombinator.com or the original article — so source-filtering by
  // hostname doesn't work. We tag clusters that came from hackernews via the
  // friendly source name instead.
  return stories.filter((story) =>
    (story.sources ?? []).some((src) => {
      const nameMatch =
        rssSource && src.name && src.name.toLowerCase() === rssSource.name.toLowerCase();
      if (nameMatch) return true;
      if (!matchHost) return false;
      try {
        const host = new URL(src.url).hostname.replace(/^www\./, "");
        return host.includes(matchHost) || matchHost.includes(host);
      } catch {
        return false;
      }
    }),
  );
}

router.get("/sources", (_req, res) => {
  res.json({
    sources: TECH_RSS_SOURCES.map((s) => ({ id: s.id, name: s.name })),
  });
});

router.get("/feed", async (req, res) => {
  const topic = String(req.query["topic"] ?? "top").toLowerCase();
  const refresh = req.query["refresh"] === "1";
  const sourceFilter =
    typeof req.query["source"] === "string" && req.query["source"].length > 0
      ? String(req.query["source"]).toLowerCase()
      : null;
  const cached = cache.get(topic);
  const isFresh = cached && Date.now() - cached.at < ttlFor(topic);

  const respond = (
    stories: StoryCard[],
    extra: Record<string, unknown> = {},
  ) => {
    const filtered = sourceFilter
      ? filterStoriesBySource(stories, sourceFilter)
      : stories;
    res.json({ stories: filtered, ...extra });
  };

  // Fast path: return cached data if fresh.
  if (!refresh && isFresh) {
    respond(cached.data, { cached: true });
    return;
  }

  // Stale-while-revalidate: if user hit refresh OR cache is stale, return what
  // we have immediately and refetch in the background. The next request will
  // see the fresh data.
  if (cached) {
    refreshInBackground(topic, req.log);
    respond(cached.data, { cached: true, stale: true });
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
    respond(stories, { cached: false, source: "ai" });
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
  // Raw paragraphs as they came from the publisher's HTML, before any AI
  // dedup pass. Surfaced so the reader's "Original" tab can show the full
  // unedited article.
  originalParagraphs?: string[];
  byline?: string;
  deduped?: boolean;
};

const articleCache = new Map<string, { at: number; data: ArticleResult }>();
const ARTICLE_TTL_MS = 6 * 60 * 60 * 1000;
const ARTICLE_CACHE_MAX_ENTRIES = 300;
const ARTICLE_DISK_CACHE_PATH = "/tmp/particle-news-article-cache.json";
const inflightArticle = new Map<string, Promise<ArticleResult>>();

// ----- Dedup cache (AI-cleaned article bodies) -----
const dedupCache = new Map<string, { at: number; data: ArticleResult }>();
const DEDUP_TTL_MS = 6 * 60 * 60 * 1000;
const DEDUP_CACHE_MAX_ENTRIES = 300;
const DEDUP_DISK_CACHE_PATH = "/tmp/particle-news-dedup-cache.json";
const inflightDedup = new Map<string, Promise<ArticleResult>>();

function persistArticleCache(): void {
  const snapshot: Record<string, { at: number; data: ArticleResult }> = {};
  for (const [url, entry] of articleCache.entries()) {
    snapshot[url] = entry;
  }
  safeWriteJson(ARTICLE_DISK_CACHE_PATH, snapshot);
}

function loadArticleCacheFromDisk(): void {
  const snapshot = safeReadJson<Record<string, { at: number; data: ArticleResult }>>(
    ARTICLE_DISK_CACHE_PATH,
  );
  if (!snapshot) return;
  const now = Date.now();
  for (const [url, entry] of Object.entries(snapshot)) {
    if (entry?.data && now - entry.at < ARTICLE_TTL_MS) {
      articleCache.set(url, entry);
    }
  }
}

function decodeArticleEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) =>
      String.fromCodePoint(parseInt(n, 16)),
    );
}

// Strip out chrome (scripts, styles, nav, etc.) from an HTML fragment but keep
// paragraph-level structure so we can split sensibly later.
function cleanHtmlFragment(html: string): string {
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
    .replace(/<figure[\s\S]*?<\/figure>/gi, " ")
    .replace(/<figcaption[\s\S]*?<\/figcaption>/gi, " ")
    .replace(/<!--([\s\S]*?)-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|br|section|article)>/gi, "\n\n")
    .replace(/<br\s*\/?>(?!\n)/gi, "\n")
    .replace(/<[^>]+>/g, " ");
}

function htmlToParagraphs(rawHtmlChunk: string): string[] {
  const text = decodeArticleEntities(cleanHtmlFragment(rawHtmlChunk))
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n\n")
    .trim();
  // Drop boilerplate lines that commonly survive the strip pass.
  const BOILERPLATE_RE =
    /^(advertisement|share this|read more|sign up|subscribe|follow us|related stories?|copyright|all rights reserved|terms of (use|service)|privacy policy|cookies?|by .{1,40}$|published .{1,40}$|updated .{1,40}$)/i;
  return text
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(
      (p) =>
        p.length > 80 &&
        p.split(" ").length > 14 &&
        !BOILERPLATE_RE.test(p),
    )
    .slice(0, 60);
}

// Pull the most likely article body using simple structural heuristics.
// Tries <article>, then common article containers, and falls back to <body>.
function extractArticleBody(html: string): {
  bodyHtml: string;
  title?: string;
} {
  const titleMatch =
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(
      html,
    ) ??
    /<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']/i.exec(
      html,
    ) ??
    /<title>([^<]+)<\/title>/i.exec(html);
  const title = titleMatch?.[1] ? decodeArticleEntities(titleMatch[1]).trim() : undefined;

  // Prefer <article>...</article>
  const articleMatches = [...html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)];
  if (articleMatches.length > 0) {
    // Pick the largest article block.
    const biggest = articleMatches
      .map((m) => m[1] ?? "")
      .reduce((a, b) => (b.length > a.length ? b : a), "");
    if (biggest.length > 500) return { bodyHtml: biggest, title };
  }

  // Look for common article body containers (itemprop, role, class hints).
  const containerPatterns: RegExp[] = [
    /<div[^>]+itemprop=["']articleBody["'][^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]+(?:class|id)=["'][^"']*(?:article-body|articleBody|post-body|entry-content|c-entry-content|story-body|prose|article__body)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    /<main\b[^>]*>([\s\S]*?)<\/main>/i,
  ];
  for (const re of containerPatterns) {
    const m = re.exec(html);
    if (m?.[1] && m[1].length > 500) return { bodyHtml: m[1], title };
  }

  // Fallback: <body>
  const bodyMatch = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  if (bodyMatch?.[1]) return { bodyHtml: bodyMatch[1], title };

  return { bodyHtml: html, title };
}

// Tried in order. Some publishers (Ars Technica, etc.) block generic browser
// User-Agents from datacenter IPs (Replit deploys live on GCP) but happily
// serve Googlebot/Bingbot, since blocking search crawlers would be suicidal
// for SEO. We retry once with Googlebot if the first fetch fails or returns
// a Cloudflare challenge page.
const FETCH_USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
];

async function fetchHtmlWithUA(url: string, ua: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9_000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": ua,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!res.ok) {
      throw new Error(`Source ${res.status}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchArticleHtml(url: string): Promise<string> {
  return fetchHtmlWithUA(url, FETCH_USER_AGENTS[0]!);
}

// Publishers known to expose the full article body via the WordPress REST API
// (`/wp-json/wp/v2/posts?slug=…`). For these, we hit the JSON API first because
// their public HTML pages are JS-hydrated and only ship a stub of the body in
// the initial response. The JSON path is faster (smaller payload) and gives
// us the complete article. If anything fails or the response looks empty we
// fall back to the standard HTML extractor — so non-WP behaviour is unchanged.
const WP_JSON_HOSTS = new Set(["techcrunch.com"]);

// Strip a few decorative wrappers WordPress wraps around captions/figures so
// the "first paragraph" the dedup model sees is real article prose, not a
// figcaption. The general htmlToParagraphs already drops figures via its tag
// stripping, but this helps the title field render cleanly.
function decodeHtmlEntitiesOnce(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&hellip;/g, "…")
    .replace(/&ldquo;/g, "“")
    .replace(/&rdquo;/g, "”")
    .replace(/&lsquo;/g, "‘")
    .replace(/&rsquo;/g, "’");
}

// Two passes to handle double-encoded entities like `&amp;#8217;` that
// WordPress sometimes emits.
function decodeHtmlEntities(s: string): string {
  const once = decodeHtmlEntitiesOnce(s);
  return /&[a-z#0-9]+;/i.test(once) ? decodeHtmlEntitiesOnce(once) : once;
}

async function tryWordPressJson(
  url: string,
): Promise<{ paragraphs: string[]; title?: string } | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^www\./, "");
  if (!WP_JSON_HOSTS.has(host)) return null;
  const segments = parsed.pathname.split("/").filter(Boolean);
  const slug = segments[segments.length - 1];
  if (!slug) return null;
  const apiUrl = `${parsed.origin}/wp-json/wp/v2/posts?slug=${encodeURIComponent(slug)}&_fields=title,content`;
  const ctrl = new AbortController();
  // 2.5s timeout: WP-JSON is a small JSON read; if it can't respond fast we
  // bail and let the HTML fallback run, keeping worst-case latency at
  // ~11.5s (2.5s WP + 9s HTML) instead of 13s.
  const timer = setTimeout(() => ctrl.abort(), 2_500);
  try {
    const res = await fetch(apiUrl, {
      signal: ctrl.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "application/json",
      },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Array<{
      title?: { rendered?: string };
      content?: { rendered?: string };
    }>;
    if (!Array.isArray(data) || data.length === 0) return null;
    const post = data[0];
    const html = post?.content?.rendered;
    if (typeof html !== "string" || !html) return null;
    const paragraphs = htmlToParagraphs(html);
    // Sanity floor: WP-JSON should give us a real article body. We accept
    // anything ≥2 paragraphs (covers legit short news posts) — the HTML
    // fallback only runs if we got 0–1 paragraphs back, which usually means
    // the post is deleted, paywalled, or returned an unexpected shape.
    if (paragraphs.length < 2) return null;
    const titleRaw = post?.title?.rendered;
    const title =
      typeof titleRaw === "string" && titleRaw
        ? decodeHtmlEntities(titleRaw.replace(/<[^>]+>/g, "")).trim()
        : undefined;
    return { paragraphs, title };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function extractArticle(url: string): Promise<ArticleResult> {
  // Fast path for known WordPress publishers (currently TechCrunch). Returns
  // the full article body via their public JSON API — bypasses the JS-hydrated
  // stub HTML their page ships with. Falls through to HTML extraction on any
  // failure, so non-WP sites and WP failures both behave exactly as before.
  const wp = await tryWordPressJson(url);
  if (wp) {
    return {
      title: wp.title,
      summaryBullets: [],
      paragraphs: wp.paragraphs,
    };
  }
  // First attempt with a desktop browser UA. If extraction yields nothing
  // (often a Cloudflare interstitial on datacenter IPs), retry with a Googlebot
  // UA which most publishers whitelist for SEO.
  for (let i = 0; i < FETCH_USER_AGENTS.length; i++) {
    let html: string;
    try {
      html = await fetchHtmlWithUA(url, FETCH_USER_AGENTS[i]!);
    } catch (err) {
      // Network/HTTP error on this UA — try the next one if we have any.
      if (i === FETCH_USER_AGENTS.length - 1) throw err;
      continue;
    }
    const { bodyHtml, title } = extractArticleBody(html);
    let paragraphs = htmlToParagraphs(bodyHtml);
    if (paragraphs.length === 0) {
      // Last-resort within this UA: try the whole document.
      paragraphs = htmlToParagraphs(html);
    }
    if (paragraphs.length > 0 || i === FETCH_USER_AGENTS.length - 1) {
      return { title, summaryBullets: [], paragraphs };
    }
  }
  return { summaryBullets: [], paragraphs: [] };
}

function trimArticleCacheIfNeeded(): void {
  if (articleCache.size <= ARTICLE_CACHE_MAX_ENTRIES) return;
  const oldestKey = articleCache.keys().next().value;
  if (oldestKey) articleCache.delete(oldestKey);
}

async function getOrFetchArticle(url: string): Promise<ArticleResult> {
  const cached = articleCache.get(url);
  // Treat zero-paragraph cache entries as misses. They are almost always the
  // result of a transient publisher block (e.g. Cloudflare 403 from a
  // datacenter IP) and we'd rather retry — possibly with a different UA — than
  // serve a blank article for the next 6 hours.
  const cachedHasContent =
    cached && (cached.data.paragraphs?.length ?? 0) > 0;
  if (cached && cachedHasContent && Date.now() - cached.at < ARTICLE_TTL_MS) {
    // True LRU: refresh recency on hit by re-inserting the key.
    articleCache.delete(url);
    articleCache.set(url, cached);
    return cached.data;
  }
  const inflight = inflightArticle.get(url);
  if (inflight) return inflight;
  const p = extractArticle(url)
    .then((data) => {
      // Only cache successful extractions so a transient block doesn't pin a
      // bad result for the full TTL window.
      if ((data.paragraphs?.length ?? 0) > 0) {
        articleCache.set(url, { at: Date.now(), data });
        trimArticleCacheIfNeeded();
        // Persist asynchronously; ignore errors.
        Promise.resolve().then(() => persistArticleCache());
      } else {
        // Drop any prior empty entry so the next request retries cleanly.
        articleCache.delete(url);
      }
      return data;
    })
    .finally(() => {
      inflightArticle.delete(url);
    });
  inflightArticle.set(url, p);
  return p;
}

// Hydrate the article cache from disk on boot.
loadArticleCacheFromDisk();
// eslint-disable-next-line no-console
console.log(`[boot] articleCache=${articleCache.size} entries (from disk)`);

// ----- Dedup cache plumbing -----

function persistDedupCache(): void {
  const snapshot: Record<string, { at: number; data: ArticleResult }> = {};
  for (const [url, entry] of dedupCache.entries()) {
    snapshot[url] = entry;
  }
  safeWriteJson(DEDUP_DISK_CACHE_PATH, snapshot);
}

function loadDedupCacheFromDisk(): void {
  const snapshot = safeReadJson<Record<string, { at: number; data: ArticleResult }>>(
    DEDUP_DISK_CACHE_PATH,
  );
  if (!snapshot) return;
  const now = Date.now();
  for (const [url, entry] of Object.entries(snapshot)) {
    if (entry?.data && now - entry.at < DEDUP_TTL_MS) {
      dedupCache.set(url, entry);
    }
  }
}

function trimDedupCacheIfNeeded(): void {
  if (dedupCache.size <= DEDUP_CACHE_MAX_ENTRIES) return;
  const oldestKey = dedupCache.keys().next().value;
  if (oldestKey) dedupCache.delete(oldestKey);
}

// Hard timeout for the Gemini dedup call. If the model stalls, we return the
// raw paragraphs so the reader never hangs indefinitely.
const DEDUP_TIMEOUT_MS = 20_000;

// Result shape for the dedup pass: includes whether the cleaned output is
// trustworthy enough to display in place of the raw paragraphs.
type DedupOutcome = { paragraphs: string[]; deduped: boolean };

// Strips punctuation and lowercases — used to measure how much of the cleaned
// text overlaps with the source. Cheap proxy for "did Gemini hallucinate?".
function normalizeForFidelity(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// With the index-based dedup, kept text is byte-identical to source by
// construction. We only need a count-floor guard so the model can't aggressively
// compress the article into something resembling a summary. Floor of 0.70 means
// at least 70% of the source paragraphs must survive — well above what any
// reasonable summary would keep, while still allowing real duplicate/boilerplate
// removal on the noisiest sources.
const KEPT_PARAGRAPH_FLOOR = 0.7;

function passesIndexDedupFidelityCheck(
  sourceCount: number,
  keptCount: number,
): boolean {
  if (keptCount === 0) return false;
  if (keptCount > sourceCount) return false;
  return keptCount / sourceCount >= KEPT_PARAGRAPH_FLOOR;
}

// Calls Gemini 2.5 Flash to identify redundant paragraphs in a news article.
// Crucially, Gemini only returns INDICES of paragraphs to keep — it never
// returns text. The server reconstructs the deduped article by copying those
// paragraphs verbatim from the source. This makes summarisation, paraphrase,
// and quote-tampering impossible by construction (not by trust).
async function dedupParagraphs(paragraphs: string[]): Promise<DedupOutcome> {
  if (paragraphs.length <= 2) return { paragraphs, deduped: false };
  const numbered = paragraphs.map((p, i) => `[${i}] ${p}`).join("\n\n");
  const prompt = `You are reviewing the body of a news article that has been split into numbered paragraphs. The reader wants the WHOLE article preserved word-for-word. Your only job is to identify which paragraphs to DROP because they are redundant.

DROP a paragraph ONLY if it is one of:
1. An exact or near-exact duplicate of an earlier paragraph (same facts, same quotes, same conclusions, just restated).
2. Pure boilerplate that is not part of the article's reporting: newsletter signup prompts, "follow us on social media", "this story originally appeared in…", author/byline bios, "related reading" link lists, advertising copy, podcast plugs, affiliate-link disclaimers, "subscribe for more" calls to action.

KEEP everything else, including:
- Paragraphs that feel less important — relevance is not your call.
- Paragraphs that elaborate, give context, quote a source, give an example, or add nuance.
- Paragraphs whose ideas are touched on elsewhere but in different words.
- Short paragraphs, transitional sentences, scene-setting.

You are NOT summarising. You are NOT rewriting. You are NOT condensing. You return only a list of paragraph indices to KEEP, in ascending order. The server will reconstruct the article by copying your kept paragraphs verbatim. If there are no duplicates and no boilerplate, return every index. Expect to keep 80-100% of paragraphs in most articles.

Return ONLY JSON in this exact shape:
{
  "keep": [0, 1, 2, ...]
}

Article paragraphs (${paragraphs.length} total, indices 0-${paragraphs.length - 1}):
${numbered}`;

  // Race the Gemini call against a hard timeout.
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error(`dedup timeout after ${DEDUP_TIMEOUT_MS}ms`)),
      DEDUP_TIMEOUT_MS,
    );
  });

  try {
    const response = await Promise.race([
      ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: {
          maxOutputTokens: 4096,
          responseMimeType: "application/json",
        },
      }),
      timeoutPromise,
    ]);
    const text = response.text ?? "{}";
    const cleaned = text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .replace(/,(\s*[\]}])/g, "$1");
    let parsed: { keep?: unknown };
    try {
      parsed = JSON.parse(cleaned) as { keep?: unknown };
    } catch {
      const start = cleaned.indexOf("{");
      const end = cleaned.lastIndexOf("}");
      if (start === -1 || end === -1) return { paragraphs, deduped: false };
      parsed = JSON.parse(cleaned.slice(start, end + 1)) as { keep?: unknown };
    }
    if (!Array.isArray(parsed.keep)) {
      return { paragraphs, deduped: false };
    }
    // Validate indices: integers, in range, unique. Sort ascending so output
    // order matches source order even if Gemini shuffled them.
    const seen = new Set<number>();
    const keep: number[] = [];
    for (const v of parsed.keep) {
      const n = typeof v === "number" ? v : Number(v);
      if (!Number.isInteger(n)) continue;
      if (n < 0 || n >= paragraphs.length) continue;
      if (seen.has(n)) continue;
      seen.add(n);
      keep.push(n);
    }
    keep.sort((a, b) => a - b);
    if (!passesIndexDedupFidelityCheck(paragraphs.length, keep.length)) {
      // eslint-disable-next-line no-console
      console.warn(
        `[dedup] fidelity floor failed (src=${paragraphs.length}p, kept=${keep.length}p) — keeping raw`,
      );
      return { paragraphs, deduped: false };
    }
    // Reconstruct the deduped article by copying source paragraphs verbatim.
    // This is the key guarantee: it is byte-identical to the source, just with
    // some paragraphs missing. Summarisation is impossible here.
    const out = keep.map((i) => paragraphs[i]).filter((p): p is string => typeof p === "string");
    const meaningfulChange = out.length !== paragraphs.length;
    return { paragraphs: out, deduped: meaningfulChange };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[dedup] gemini failed, returning raw: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { paragraphs, deduped: false };
  }
}

async function getOrFetchDedupedArticle(url: string): Promise<ArticleResult> {
  const cached = dedupCache.get(url);
  if (cached && Date.now() - cached.at < DEDUP_TTL_MS) {
    // True LRU: refresh recency on hit by re-inserting the key.
    dedupCache.delete(url);
    dedupCache.set(url, cached);
    return cached.data;
  }
  const inflight = inflightDedup.get(url);
  if (inflight) return inflight;

  const p = (async () => {
    const raw = await getOrFetchArticle(url);
    if (!raw.paragraphs.length) {
      // Nothing to dedup — cache the empty result so we don't keep retrying.
      const data: ArticleResult = {
        ...raw,
        originalParagraphs: raw.paragraphs,
        deduped: false,
      };
      dedupCache.set(url, { at: Date.now(), data });
      trimDedupCacheIfNeeded();
      Promise.resolve().then(() => persistDedupCache());
      return data;
    }
    const outcome = await dedupParagraphs(raw.paragraphs);
    const data: ArticleResult = {
      ...raw,
      paragraphs: outcome.paragraphs,
      // Always preserve the raw extraction for the reader's "Original" tab.
      originalParagraphs: raw.paragraphs,
      deduped: outcome.deduped,
    };
    dedupCache.set(url, { at: Date.now(), data });
    trimDedupCacheIfNeeded();
    Promise.resolve().then(() => persistDedupCache());
    return data;
  })().finally(() => {
    inflightDedup.delete(url);
  });
  inflightDedup.set(url, p);
  return p;
}

// Hydrate the dedup cache from disk on boot.
loadDedupCacheFromDisk();
// eslint-disable-next-line no-console
console.log(`[boot] dedupCache=${dedupCache.size} entries (from disk)`);

router.get("/article", async (req, res) => {
  const url = String(req.query["url"] ?? "");
  if (!url || !/^https?:\/\//i.test(url)) {
    res.status(400).json({ error: "Invalid url" });
    return;
  }
  // Fastest path: AI-deduped version cached.
  const dedupHit = dedupCache.get(url);
  if (dedupHit && Date.now() - dedupHit.at < DEDUP_TTL_MS) {
    res.json({ ...dedupHit.data, cached: true });
    return;
  }
  try {
    const data = await getOrFetchDedupedArticle(url);
    if (!data.paragraphs.length) {
      res.status(502).json({ error: "Couldn't extract article body" });
      return;
    }
    res.json({ ...data, cached: false });
  } catch (err) {
    req.log.error({ err }, "article extract failed");
    res.status(502).json({
      error: err instanceof Error ? err.message : "Couldn't fetch article",
    });
  }
});

// Lightweight prefetch endpoint: warms BOTH the raw extraction cache and the
// AI-deduped cache without forcing the client to wait. Returns 204 immediately
// and continues working in the background. Used by the feed to prefetch the
// first source for visible cards so taps feel instant.
router.get("/article/prefetch", (req, res) => {
  const url = String(req.query["url"] ?? "");
  if (!url || !/^https?:\/\//i.test(url)) {
    res.status(400).end();
    return;
  }
  const dedupHit = dedupCache.get(url);
  if (dedupHit && Date.now() - dedupHit.at < DEDUP_TTL_MS) {
    res.status(204).end();
    return;
  }
  // Fire-and-forget; dedupe via getOrFetchDedupedArticle's inflight map.
  getOrFetchDedupedArticle(url).catch(() => {});
  res.status(204).end();
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
