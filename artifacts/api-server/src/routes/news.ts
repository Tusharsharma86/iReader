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

function refreshInBackground(
  topic: string,
  log: { warn: (...args: unknown[]) => void },
): void {
  if (inflightFeed.has(topic)) return;
  const started = Date.now();
  const p = buildFreshFeed(topic)
    .then((stories) => {
      cache.set(topic, { at: Date.now(), data: stories });
      persistFeedCache();
      // eslint-disable-next-line no-console
      console.log(
        `[prewarm] ${topic} refreshed in ${Date.now() - started}ms (${stories.length} stories)`,
      );
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

async function fetchArticleHtml(url: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9_000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
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
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function extractArticle(url: string): Promise<ArticleResult> {
  const html = await fetchArticleHtml(url);
  const { bodyHtml, title } = extractArticleBody(html);
  const paragraphs = htmlToParagraphs(bodyHtml);
  if (paragraphs.length === 0) {
    // Last-resort: try the whole document.
    const fallback = htmlToParagraphs(html);
    return {
      title,
      summaryBullets: [],
      paragraphs: fallback,
    };
  }
  return {
    title,
    summaryBullets: [],
    paragraphs,
  };
}

function trimArticleCacheIfNeeded(): void {
  if (articleCache.size <= ARTICLE_CACHE_MAX_ENTRIES) return;
  const oldestKey = articleCache.keys().next().value;
  if (oldestKey) articleCache.delete(oldestKey);
}

async function getOrFetchArticle(url: string): Promise<ArticleResult> {
  const cached = articleCache.get(url);
  if (cached && Date.now() - cached.at < ARTICLE_TTL_MS) {
    // True LRU: refresh recency on hit by re-inserting the key.
    articleCache.delete(url);
    articleCache.set(url, cached);
    return cached.data;
  }
  const inflight = inflightArticle.get(url);
  if (inflight) return inflight;
  const p = extractArticle(url)
    .then((data) => {
      articleCache.set(url, { at: Date.now(), data });
      trimArticleCacheIfNeeded();
      // Persist asynchronously; ignore errors.
      Promise.resolve().then(() => persistArticleCache());
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

// Returns true if `out` looks like a trimmed/edited version of `source` rather
// than a free-form rewrite. We require:
// - cleaned length is between 25% and 110% of source length (no over-compression,
//   no inflation),
// - at least 75% of the cleaned text's tokens appear in the source text.
function passesFidelityCheck(source: string[], out: string[]): boolean {
  if (out.length === 0) return false;
  const sourceText = normalizeForFidelity(source.join(" "));
  const outText = normalizeForFidelity(out.join(" "));
  if (outText.length === 0) return false;
  const ratio = outText.length / Math.max(1, sourceText.length);
  if (ratio < 0.25 || ratio > 1.1) return false;
  const sourceTokens = new Set(sourceText.split(" ").filter((t) => t.length > 2));
  const outTokens = outText.split(" ").filter((t) => t.length > 2);
  if (outTokens.length === 0) return false;
  let hits = 0;
  for (const t of outTokens) if (sourceTokens.has(t)) hits += 1;
  const overlap = hits / outTokens.length;
  return overlap >= 0.75;
}

// Calls Gemini 2.5 Flash to remove redundant/repetitive sentences from the
// article body and return tightened paragraphs in the original order. Falls
// back to the input on any error or fidelity failure so the user always sees
// something faithful to the source.
async function dedupParagraphs(paragraphs: string[]): Promise<DedupOutcome> {
  if (paragraphs.length <= 2) return { paragraphs, deduped: false };
  const joined = paragraphs.map((p, i) => `[${i}] ${p}`).join("\n\n");
  const prompt = `You are an editor. Below is the body of a news article, split
into numbered paragraphs.

Your job:
- Remove paragraphs that are exact duplicates or near-duplicates of earlier paragraphs.
- Remove paragraphs that are clearly boilerplate (newsletter prompts, "follow us on social", "this story originally appeared in…", author bios, related-link lists, ads).
- Within the remaining paragraphs, tighten any sentences that repeat information already stated. Preserve the writer's voice and all factual claims.
- Do NOT summarize. Do NOT add any new information. Do NOT reorder paragraphs. Do NOT change quotes inside quotation marks.
- Output the cleaned paragraphs in their original order.

Return ONLY JSON in this exact shape:
{
  "paragraphs": [string, string, ...]
}

Article paragraphs:
${joined}`;

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
          maxOutputTokens: 8192,
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
    let parsed: { paragraphs?: unknown };
    try {
      parsed = JSON.parse(cleaned) as { paragraphs?: unknown };
    } catch {
      const start = cleaned.indexOf("{");
      const end = cleaned.lastIndexOf("}");
      if (start === -1 || end === -1) return { paragraphs, deduped: false };
      parsed = JSON.parse(cleaned.slice(start, end + 1)) as {
        paragraphs?: unknown;
      };
    }
    if (!Array.isArray(parsed.paragraphs)) {
      return { paragraphs, deduped: false };
    }
    const out = parsed.paragraphs
      .filter((p): p is string => typeof p === "string")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    // Fidelity guard: if Gemini went off the rails, discard its output.
    if (!passesFidelityCheck(paragraphs, out)) {
      // eslint-disable-next-line no-console
      console.warn(
        `[dedup] fidelity check failed (src=${paragraphs.length}p, out=${out.length}p) — keeping raw`,
      );
      return { paragraphs, deduped: false };
    }
    // If output is essentially identical to input, mark as not-deduped so the
    // client doesn't claim AI cleanup happened when nothing meaningful changed.
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
      const data: ArticleResult = { ...raw, deduped: false };
      dedupCache.set(url, { at: Date.now(), data });
      trimDedupCacheIfNeeded();
      Promise.resolve().then(() => persistDedupCache());
      return data;
    }
    const outcome = await dedupParagraphs(raw.paragraphs);
    const data: ArticleResult = {
      ...raw,
      paragraphs: outcome.paragraphs,
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
