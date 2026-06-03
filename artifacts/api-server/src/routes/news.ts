import { Router, type IRouter } from "express";
import { XMLParser } from "fast-xml-parser";
//import { ai } from "@workspace/integrations-gemini-ai";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { cleanArticleParagraphs } from "../lib/articleCleaner";

const router: IRouter = Router();

// ── Groq AI helper ──────────────────────────────────────────────────────────
// All AI summaries now go through Groq's Llama 4 Scout. Free tier, much faster
// than Claude, similar quality for structured JSON. ANTHROPIC_API_KEY kept as
// optional fallback for now (some routes still call Claude until migrated).
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct"; // Deep Dive (flagship) — dedicated daily budget
const GROQ_MODEL_FAST = "llama-3.1-8b-instant"; // chatty/high-volume tasks (article tools, Q&A) — separate budget
const GROQ_MODEL_ENRICH = "llama-3.3-70b-versatile"; // feed enrichment: cluster headlines + 25-word summaries — separate budget (~100k/day)
async function callGroq(
  prompt: string,
  maxTokens: number,
  opts: { temperature?: number; signal?: AbortSignal; model?: string; task?: string } = {},
): Promise<string> {
  const key = process.env["GROQ_API_KEY"];
  if (!key) throw new Error("GROQ_API_KEY missing");
  const model = opts.model ?? GROQ_MODEL;
  const r = await fetch(GROQ_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature: opts.temperature ?? 0.3,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: opts.signal,
  });
  if (!r.ok) { recordAiUsage(model, opts.task ?? "other", 0, false); throw new Error(`Groq ${r.status}`); }
  const data = (await r.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { total_tokens?: number };
  };
  recordAiUsage(model, opts.task ?? "other", data.usage?.total_tokens ?? 0, true);
  return data.choices?.[0]?.message?.content ?? "";
}

// ── Per-model / per-task AI usage tracker (for the in-app dashboard) ─────────
// Sums real tokens (prompt+completion) Groq reports, grouped by model and task,
// per UTC day. In-memory (resets on container cold start) — best-effort gauge.
const GROQ_TPD_LIMITS: Record<string, number> = {
  "meta-llama/llama-4-scout-17b-16e-instruct": 500000,
  "llama-3.1-8b-instant": 500000,
  "llama-3.3-70b-versatile": 100000,
};
interface TaskUsage { tokens: number; calls: number; errors: number; }
interface ModelUsage { tokens: number; calls: number; errors: number; tasks: Record<string, TaskUsage>; }
let aiUsageDay = new Date().toISOString().slice(0, 10);
const aiUsageByModel: Record<string, ModelUsage> = {};
function recordAiUsage(model: string, task: string, tokens: number, ok: boolean): void {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== aiUsageDay) { aiUsageDay = today; for (const k of Object.keys(aiUsageByModel)) delete aiUsageByModel[k]; }
  const m = (aiUsageByModel[model] ??= { tokens: 0, calls: 0, errors: 0, tasks: {} });
  const t = (m.tasks[task] ??= { tokens: 0, calls: 0, errors: 0 });
  m.calls++; t.calls++;
  m.tokens += tokens; t.tokens += tokens;
  if (!ok) { m.errors++; t.errors++; }
}

// Disk cache lives in /tmp so it survives in-process restarts within the same
// container (dev workflow restarts, autoscale instance reuse). Replit Autoscale
// instances get a fresh /tmp on cold-start, so this is best-effort persistence
// — the next user request will trigger a fresh refresh if cache is empty.
const FEED_DISK_CACHE_PATH = "/tmp/particle-news-feed-cache.json";

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
  summary: string;
  aiSummary?: string;
  summaries: {
    fiveWs: string[];
    eli5: string;
    keyHighlights: string;
  };
  sources: Source[];
  sourceCount: number;
  isTrending?: boolean;
  isBreaking?: boolean;
  isDeveloping?: boolean;
};

// ── Mixed-feed types ─────────────────────────────────────────────────────────
type FeedCluster = {
  type: "cluster";
  topicTitle: string;
  topicSummary: string;
  articles: StoryCard[];
};
type FeedArticle = StoryCard & { type: "article" };
type FeedItem = FeedCluster | FeedArticle;

// Raw article + cluster-group cache (RSS fetch + clustering, 10-min TTL)
type RawFeedEntry = { articles: NewsDataArticle[]; groups: number[][]; at: number };
const rawFeedCache = new Map<string, RawFeedEntry>();
const RAW_FEED_TTL_MS = 10 * 60 * 1000;

// Scored, ordered feed cache (5-min TTL — scores decay as freshness changes)
type CacheEntry = { at: number; data: FeedItem[] };
export const cache = new Map<string, CacheEntry>();
export const feedCache = cache; // alias used by other routes
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const TECH_CACHE_TTL_MS = 5 * 60 * 1000;

// Title Case for notif titles. Keep common acronyms uppercased.
const ACRONYMS = new Set(["AI", "ML", "EV", "EVS", "US", "UK", "EU", "UN", "RBI", "GST", "GDP", "IPO", "API", "ISRO", "NASA", "OTT", "TV", "VR", "AR", "SAAS", "NFT", "DEFI", "BJP", "AAP", "NCR", "IIT", "JEE", "NEET", "AIIMS", "OPEC", "NATO", "G7", "G20", "PLA", "IDF", "CBI", "ED", "SC", "HC"]);
function toTitleCase(s: string): string {
  return s
    .split(/(\s+|[-&·•|])/)
    .map((part) => {
      if (/^\s+$/.test(part) || /^[-&·•|]$/.test(part)) return part;
      const up = part.toUpperCase();
      if (ACRONYMS.has(up)) return up;
      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    })
    .join("");
}

function ttlFor(_topic: string): number {
  return DEFAULT_CACHE_TTL_MS;
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
  { id: "techcrunch",   name: "TechCrunch",       url: "https://techcrunch.com/feed/" },
  { id: "theverge",     name: "The Verge",         url: "https://www.theverge.com/rss/index.xml" },
  { id: "arstechnica",  name: "Ars Technica",      url: "https://feeds.arstechnica.com/arstechnica/index" },
  { id: "wired",        name: "Wired",             url: "https://www.wired.com/feed/rss" },
  { id: "9to5google",   name: "9to5Google",        url: "https://9to5google.com/feed/" },
  { id: "9to5mac",      name: "9to5Mac",           url: "https://9to5mac.com/feed/" },
  { id: "engadget",     name: "Engadget",          url: "https://www.engadget.com/rss.xml" },
  { id: "venturebeat",  name: "VentureBeat",       url: "https://venturebeat.com/feed/" },
  { id: "thenextweb",   name: "The Next Web",      url: "https://thenextweb.com/feed/" },
  { id: "hackernews",   name: "Hacker News",       url: "https://hnrss.org/frontpage" },
  { id: "mittech",      name: "MIT Tech Review",   url: "https://www.technologyreview.com/feed/" },
  { id: "scrollin",     name: "Scroll.in",         url: "https://feeds.feedburner.com/ScrollinArticles.rss" },
  // IE direct URLs → 403 from Render IPs; FeedBurner proxy works (IE Tech section, 200 items)
  { id: "ie-tech",      name: "Indian Express",    url: "https://feeds.feedburner.com/indianexpress" },
  // Financial Express RSS feeds are dead (410 / returns HTML) — removed
];

// Topic-specific Indian source lists
// IE / News18 / Firstpost / MoneyControl all return HTTP 403 from Render's
// datacenter IP range. IE only works via FeedBurner proxy (Tech section only).
const INDIA_POLITICS_RSS_SOURCES: RssSource[] = [
  { id: "ndtv-india",   name: "NDTV",        url: "https://feeds.feedburner.com/ndtvnews-india-news" },
  { id: "ndtv-latest",  name: "NDTV",        url: "https://feeds.feedburner.com/ndtvnews-latest" },
  { id: "indiatoday",   name: "India Today", url: "https://www.indiatoday.in/rss/home" },
  { id: "theprint-ind", name: "The Print",   url: "https://theprint.in/category/india/feed/" },
  { id: "theprint-pol", name: "The Print",   url: "https://theprint.in/category/politics/feed/" },
  { id: "thequint-ind", name: "The Quint",   url: "https://feeds.feedburner.com/thequint" },
  { id: "cnbctv18-ind", name: "CNBC TV18",   url: "https://www.cnbctv18.com/commonfeeds/v1/cne/rss/india.xml" },
  { id: "scrollin",     name: "Scroll.in",   url: "https://feeds.feedburner.com/ScrollinArticles.rss" },
  { id: "ht-india",     name: "Hindustan Times",  url: "https://www.hindustantimes.com/feeds/rss/india-news/rssfeed.xml" },
  { id: "toi-india",   name: "Times of India",   url: "https://timesofindia.indiatimes.com/rssfeeds/-2128936835.cms" },
];

const MARKETS_RSS_SOURCES: RssSource[] = [
  { id: "et-markets",   name: "Economic Times", url: "https://economictimes.indiatimes.com/rssfeedsdefault/4719148.cms" },
  { id: "livemint",     name: "Livemint",       url: "https://www.livemint.com/rss/markets" },
  { id: "cnbctv18",     name: "CNBC TV18",      url: "https://www.cnbctv18.com/commonfeeds/v1/cne/rss/market.xml" },
  // Financial Express RSS dead (410). IE direct 403. Livemint tech covers some market content.
  { id: "livemint-tech", name: "Livemint",      url: "https://www.livemint.com/rss/technology" },
];

// Reuters ended public RSS June 2020. AP News retired /rss/apf-* paths — use hub format.
// The Guardian and NPR World are reliable open RSS alternatives.
const GEOPOLITICS_RSS_SOURCES: RssSource[] = [
  { id: "bbc-world",    name: "BBC World",   url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
  { id: "guardian-wld", name: "The Guardian", url: "https://www.theguardian.com/world/rss" },
  { id: "aljazeera",    name: "Al Jazeera",  url: "https://www.aljazeera.com/xml/rss/all.xml" },
  { id: "nyt-world",    name: "NYT World",   url: "https://rss.nytimes.com/services/xml/rss/nyt/World.xml" },
  { id: "npr-world",    name: "NPR World",   url: "https://feeds.npr.org/1004/rss.xml" },
  { id: "theprint-wld", name: "The Print",       url: "https://theprint.in/category/world/feed/" },
  { id: "ht-world",     name: "Hindustan Times", url: "https://www.hindustantimes.com/feeds/rss/world-news/rssfeed.xml" },
  { id: "toi-world",    name: "Times of India",  url: "https://timesofindia.indiatimes.com/rssfeeds/296589292.cms" },
  // Financial Express 403/dead, IE direct 403
];

const BUSINESS_RSS_SOURCES: RssSource[] = [
  { id: "livemint-co",  name: "Mint",        url: "https://www.livemint.com/rss/companies" },
  { id: "et-co",        name: "Economic Times", url: "https://economictimes.indiatimes.com/rssfeedsdefault/4719148.cms" },
  { id: "inc42",        name: "Inc42",       url: "https://inc42.com/feed/" },
  { id: "cnbctv18-biz", name: "CNBC TV18",   url: "https://www.cnbctv18.com/commonfeeds/v1/cne/rss/business.xml" },
  { id: "theprint-biz", name: "The Print",   url: "https://theprint.in/category/economy/feed/" },
  // Financial Express RSS dead, IE direct 403
];

// Unified pool of all non-tech RSS sources (deduplicated by id).
// Fetched together in fetchIndianFeeds, then narrowed by TOPIC_KEYWORDS per topic.
// This lets Economic Times appear in india-politics, News18 in markets, etc.
const ALL_GENERAL_RSS_SOURCES: RssSource[] = (() => {
  const seen = new Set<string>();
  const out: RssSource[] = [];
  for (const s of [
    ...INDIA_POLITICS_RSS_SOURCES,
    ...MARKETS_RSS_SOURCES,
    ...GEOPOLITICS_RSS_SOURCES,
    ...BUSINESS_RSS_SOURCES,
  ]) {
    if (!seen.has(s.id)) { seen.add(s.id); out.push(s); }
  }
  return out;
})();

const TOPIC_KEYWORDS: Record<string, string[]> = {
  // Specific political terms only — "india"/"government"/"state"/"party" are
  // too broad and let market/world articles bleed into this tab.
  "india-politics": ["parliament", "modi", "bjp", "congress", "election", "minister", "lok sabha", "rajya sabha", "political", "opposition", "cabinet", "chief minister", "mla", "governor", "supreme court", "delhi", "kejriwal", "rahul", "amit shah", "yogi", "mamata", "coalition", "bypolls", "constituency", "legislative", "rajnath", "cm ", "mps ", "mlc"],
  // World-news sources (BBC/Guardian/NYT/AJ/NPR/ThePrint) are already curated;
  // add enough terms to catch diplomacy, security and trade stories.
  "geopolitics":    ["war", "conflict", "treaty", "nato", "sanction", "diplomacy", "foreign", "international", "global", "china", "russia", "pakistan", "ukraine", "israel", "gaza", "border", "military", "nuclear", "ceasefire", "united nations", "taiwan", "iran", "pentagon", "kremlin", "white house", "g7", "g20", "imf", "world bank", "trade deal", "tariff"],
  "markets":        ["sensex", "nifty", "stock", "shares", "bse", "nse", "rupee", "rbi", "equity", "ipo", "mutual fund", "trading", "rate cut", "repo", "inflation", "sebi", "market cap", "rally", "selloff", "futures", "bonds", "yield", "fed ", "interest rate"],
  "business":       ["startup", "revenue", "profit", "acquisition", "ceo", "merger", "funding", "crore", "billion", "corporate", "deal", "valuation", "unicorn", "quarter", "investor", "venture", "series", "founder", "layoff", "earnings", "quarterly"],
};

const SPORTS_ENTERTAINMENT_RE = /\b(cricket|ipl|bcci|test match|odi|t20i?|football|soccer|premier league|la liga|bundesliga|serie a|ligue 1|nfl|nba|mlb|nhl|fifa|tennis|wimbledon|formula[- ]1|f1 race|chess|olympics|hockey|badminton|icc|world cup final|match report|match preview|scorecard|squad announced|batting|bowling|wicket|wickets|run chase|innings|half.?time|full.?time|penalty kick|goal scored|transfer window|player transfer|fantasy cricket|dream11|my11circle|rohit sharma|virat kohli|ms dhoni|bollywood|hindi film|tollywood|kollywood|mollywood|south film|telugu film|tamil film|movie release|film release|first look|box office|box office collection|trailer launch|song launch|music video|item song|oscar|grammy|award show|web series|ott platform|album launch|concert tour|celebrity gossip|dating|gossip|entertainment news|celebrity|actor|actress|sports score|match score|celebrity wedding|star spotted|promo codes?|discount codes?|coupon codes?|cashback|voucher|referral codes?|offer codes?|redeem codes?|flash sale|best deals?|top deals?|exclusive deals?|\d+%\s*off|save \d+%|get \d+% off|limited.{0,10}offer|today.{0,10}deals?|affiliate|phone price|smartphone price|price drops?|price cut|price hike|price reveal|lowest price|best price|now available|available for rs|launched at|starts at rs|starts at \$|goes on sale|gets a price|exchange offer|upcoming phone|specifications|specs leak|hands.?on review|camera test|benchmark|unboxing|vs comparison|best phone|budget phone|flagship phone|iphone \d+ price|watch price|earbuds price|laptop deal|tablet deal|gadget deal|record low price|all.?time low|price history)\b/i;

// Low-priority breaking content: phone prices, gadget deals, specs leaks, routine sports/entertainment
const BREAKING_LOWPRIORITY_RE = /\b(phone price|smartphone price|budget phone|feature phone|price drops?|price cut|price hike|price reveal|price history|lowest price|lowest ever price|best price|now available|available for rs|available at|launched at|starts at rs|starts at \$|goes on sale|now on sale|gets a price|cashback|exchange offer|upcoming phone|specifications|specs leak|hands.?on review|camera test|benchmark|unboxing|vs comparison|best phone|top phone|redmi|realme note|poco [a-z]|samsung [a-z]+\d+|iphone \d+ price|watch price|earbuds price|laptop deal|tablet deal|gadget deal|at the lowest|record low price|all.?time low|match preview|scorecard|squad|batting|bowling|wicket|fantasy cricket|dream11|box office|trailer|song launch|celebrity gossip|tollywood|bollywood film|film release)\b/i;

// High-priority breaking content: geopolitics, economy, India, major tech
const BREAKING_HIGHPRIORITY_RE = /\b(war|conflict|attack|blast|explosion|earthquake|tsunami|flood|pandemic|outbreak|crisis|emergency|election result|sanctions|nuclear|missile|treaty|summit|terror|coup|protest|strike|budget|gdp|inflation|rate hike|rate cut|fed |rbi |rupee|dollar crash|china|russia|pakistan|ukraine|israel|hamas|nato|un security council|supreme court|parliament|lok sabha|rajya sabha|prime minister|president|minister|assassination|death toll|casualties|ceasefire|ipo|acquisition|merger|layoff|bankruptcy|market crash|market rally|sensex|nifty|tariff|trade war|ai regulation|openai|chatgpt|gemini|nvidia|data breach|cyberattack|antitrust|ban on|crackdown)\b/i;

function breakingScore(a: NewsDataArticle): number {
  const text = `${a.title ?? ""} ${a.description ?? ""}`;
  const ts = a.pubDate ? Date.parse(a.pubDate) : 0;
  const hoursOld = (Date.now() - ts) / (1000 * 60 * 60);
  let score = 0;
  if (BREAKING_HIGHPRIORITY_RE.test(text)) score += 20;
  if (BREAKING_LOWPRIORITY_RE.test(text)) score -= 20;
  if (SPORTS_ENTERTAINMENT_RE.test(text)) score -= 25;
  // Freshness: up to 8 points for articles < 8 hours old
  score += Math.max(0, 8 - hoursOld);
  return score;
}

function isSportsOrEntertainment(article: NewsDataArticle): boolean {
  const text = `${article.title ?? ""} ${article.description ?? ""}`.slice(0, 300);
  return SPORTS_ENTERTAINMENT_RE.test(text);
}

// NYT's recurring "Here's the Latest" live-briefing roundup is a placeholder,
// not a story — drop it at the source so it never reaches web or app feeds.
function isJunkRoundup(article: NewsDataArticle): boolean {
  const title = (article.title ?? "").toLowerCase();
  if (!/here.?s the latest|here are the latest/.test(title)) return false;
  const domain = article.link ? articleDomain(article.link) : "";
  const src = (article.source_id ?? "").toLowerCase();
  return /nyt|nytimes|new york times/.test(domain) || /nyt|nytimes|new york times/.test(src);
}

function matchesTopic(article: NewsDataArticle, topic: string): boolean {
  const kws = TOPIC_KEYWORDS[topic];
  if (!kws) return true;
  const text = `${article.title ?? ""} ${article.description ?? ""}`.toLowerCase();
  return kws.some(kw => text.includes(kw));
}

function sourcesForTopic(topic: string): RssSource[] {
  switch (topic) {
    case "india-politics": return INDIA_POLITICS_RSS_SOURCES;
    case "markets":        return MARKETS_RSS_SOURCES;
    case "geopolitics":    return GEOPOLITICS_RSS_SOURCES;
    case "business":       return BUSINESS_RSS_SOURCES;
    default:               return INDIA_POLITICS_RSS_SOURCES;
  }
}

// Cap articles per source publication (by domain of the article link, not
// source_id) so the same outlet fetched under multiple IDs (e.g. India Today
// appearing in two source arrays) cannot double its slot allocation.
// Also deduplicates by canonical URL before applying the cap.
function capBySource(articles: NewsDataArticle[], max: number): NewsDataArticle[] {
  const seenUrls = new Set<string>();
  const count: Record<string, number> = {};
  return articles.filter(a => {
    // URL-level deduplicate — same story fetched under two source IDs
    const url = a.link ? canonicalizeUrl(a.link) : null;
    if (url) {
      if (seenUrls.has(url)) return false;
      seenUrls.add(url);
    }
    // Cap by article domain (publication), not source_id
    const domain = a.link ? articleDomain(a.link) : (a.source_id ?? "unknown");
    count[domain] = (count[domain] ?? 0) + 1;
    return count[domain] <= max;
  });
}

// Default/placeholder OG images that should be treated as "no image"
const DEFAULT_OG_IMAGE_PATTERNS = [
  "theprint_default_image",
  "default_image_new",
  "/default-og",
  "/placeholder",
  "/no-image",
  "/logo-og",
];

function isDefaultOgImage(url: string): boolean {
  return DEFAULT_OG_IMAGE_PATTERNS.some(p => url.includes(p));
}

// Try fetching the featured image for a WordPress article via WP-JSON.
// Avoids hitting the full article HTML page (which gets rate-limited).
async function fetchWpFeaturedImage(articleUrl: string): Promise<string | null> {
  let parsed: URL;
  try { parsed = new URL(articleUrl); } catch { return null; }
  const host = parsed.hostname.replace(/^www\./, "");
  if (!WP_JSON_HOSTS.has(host)) return null;
  const segments = parsed.pathname.split("/").filter(Boolean);
  const slug = segments[segments.length - 1];
  if (!slug) return null;
  const apiUrl = `${parsed.origin}/wp-json/wp/v2/posts?slug=${encodeURIComponent(slug)}&_embed&_fields=_embedded`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3_000);
  try {
    const res = await fetch(apiUrl, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "application/json",
      },
    });
    if (!res.ok) return null;
    const data = await res.json() as Array<{ _embedded?: { "wp:featuredmedia"?: Array<{ source_url?: string }> } }>;
    if (!Array.isArray(data) || data.length === 0) return null;
    const img = data[0]?._embedded?.["wp:featuredmedia"]?.[0]?.source_url;
    return img ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Detect WordPress thumbnail-sized image URLs (e.g. -150x150.jpg, -300x169.jpg).
// These are auto-generated resized variants — we want the full featured image instead.
function isWpThumbnailUrl(url: string): boolean {
  return /\-\d{2,4}x\d{2,4}\.(jpg|jpeg|png|webp)(\?.*)?$/i.test(url);
}

function needsImageEnrichment(a: NewsDataArticle): boolean {
  if (!a.link) return false;
  if (!a.image_url) return true;
  // For TechCrunch (WP-JSON hosts), replace thumbnail-sized RSS images with the
  // full-resolution featured image from the WordPress API.
  try {
    const host = new URL(a.link).hostname.replace(/^www\./, "");
    if (WP_JSON_HOSTS.has(host) && isWpThumbnailUrl(a.image_url)) return true;
  } catch { /* ignore */ }
  return false;
}

async function enrichMissingImages(articles: NewsDataArticle[]): Promise<void> {
  const needs = articles.filter(needsImageEnrichment);
  if (needs.length === 0) return;
  const results = await Promise.allSettled(needs.map(async a => {
    // For WordPress sites, use WP-JSON to fetch the featured image — avoids
    // rate-limiting from bulk page scraping and gives full-resolution images.
    const wpImg = await fetchWpFeaturedImage(a.link!);
    if (wpImg) return wpImg;
    if (a.image_url) return a.image_url; // keep existing if WP-JSON fails
    const og = await getOgImageCached(a.link!);
    // Treat known placeholder/default OG images as null
    if (og && isDefaultOgImage(og)) return null;
    return og;
  }));
  results.forEach((res, idx) => {
    if (res.status === "fulfilled" && res.value) needs[idx]!.image_url = res.value;
  });
}

async function fetchIndianFeeds(topic: string): Promise<NewsDataArticle[]> {
  // Use per-category source lists so each tab only pulls from relevant outlets.
  // Cross-category pooling caused market/world articles to bleed into India tab
  // via broad keywords like "india" or "government".
  const sources = sourcesForTopic(topic);
  const results = await Promise.allSettled(
    sources.map(s => fetchOneRssFeed(s, topic)),
  );
  const articles: NewsDataArticle[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") articles.push(...r.value);
  }
  const filtered = articles
    .filter(a => !isSportsOrEntertainment(a))
    .filter(a => !isJunkRoundup(a))
    .filter(a => matchesTopic(a, topic));

  filtered.sort((a, b) => {
    const ta = a.pubDate ? Date.parse(a.pubDate) : 0;
    const tb = b.pubDate ? Date.parse(b.pubDate) : 0;
    return tb - ta;
  });
  await enrichMissingImages(filtered);
  return filtered;
}


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
  // Try src first (skip data: URIs)
  const srcMatch = /<img[^>]+src=["']([^"']+)["']/i.exec(html);
  if (srcMatch?.[1] && !srcMatch[1].startsWith('data:')) return srcMatch[1];
  // Lazy-load attributes (WordPress, TechCrunch, others)
  for (const attr of ['data-lazy-src', 'data-src', 'data-original', 'data-hi-res-src']) {
    const m = new RegExp(`<img[^>]+${attr}=["']([^"']+)["']`, 'i').exec(html);
    if (m?.[1] && !m[1].startsWith('data:')) return m[1];
  }
  // First URL in srcset
  const srcsetMatch = /<img[^>]+srcset=["']([^\s,"']+)/i.exec(html);
  if (srcsetMatch?.[1]) return srcsetMatch[1];
  return null;
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
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
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
  category = "technology",
): NewsDataArticle[] {
  const parsed = xmlParser.parse(xml) as Record<string, unknown>;

  // RSS 2.0
  const rss = parsed["rss"] as { channel?: Record<string, unknown> } | undefined;
  if (rss?.channel) {
    const channelBuildDate = pickText(rss.channel["lastBuildDate"]);
    const items = asArray(rss.channel["item"] as unknown);
    return items.map((raw) => {
      const item = raw as Record<string, unknown>;
      const title = decodeEntities(pickText(item["title"]));
      const rawLink = pickText(item["link"]);
      const link = canonicalizeUrl(rawLink);
      const pubDate = pickText(item["pubDate"]);
      const guid = pickText(item["guid"]);
      const descRaw = pickText(item["description"]);
      const contentRaw = pickText(item["content:encoded"]) || descRaw;

      let imageUrl: string | null = null;
      const enclosure = item["enclosure"] as
        | { "@_url"?: string; "@_type"?: string }
        | undefined;
      if (enclosure?.["@_url"]) {
        const encType = enclosure["@_type"] ?? "";
        if (!encType || encType.startsWith("image")) {
          imageUrl = enclosure["@_url"];
        }
      }
      const mediaContent = item["media:content"] as
        | { "@_url"?: string; "@_medium"?: string }
        | { "@_url"?: string; "@_medium"?: string }[]
        | undefined;
      if (!imageUrl) {
        const mc = Array.isArray(mediaContent) ? mediaContent[0] : mediaContent;
        if (mc?.["@_url"]) imageUrl = mc["@_url"];
      }
      // media:group → media:content (used by YouTube, NDTV, others)
      const mediaGroup = item["media:group"] as Record<string, unknown> | undefined;
      if (!imageUrl && mediaGroup) {
        const gc = mediaGroup["media:content"] as { "@_url"?: string } | { "@_url"?: string }[] | undefined;
        const gItem = Array.isArray(gc) ? gc[0] : gc;
        if (gItem?.["@_url"]) imageUrl = gItem["@_url"];
        if (!imageUrl) {
          const gt = mediaGroup["media:thumbnail"] as { "@_url"?: string } | undefined;
          if (gt?.["@_url"]) imageUrl = gt["@_url"];
        }
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

      // Use GUID as stable article ID when it looks like a real identifier.
      // Many publishers (TOI, The Hindu) use numeric or URL GUIDs that are
      // more stable than the link, which can carry tracking params.
      const stableId = (guid && guid.length > 0 && guid !== rawLink)
        ? guid
        : (link || title);

      // Normalise date — some Indian sources emit IST without offset; treat as-is
      // Fall back to date embedded in URL slug (YYYYMMDDHHMMSS) then channel lastBuildDate.
      let pubDateIso: string | undefined;
      if (pubDate) {
        try { pubDateIso = new Date(pubDate).toISOString(); } catch { /* skip */ }
      }
      if (!pubDateIso && link) {
        const m = link.match(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
        if (m) {
          try {
            pubDateIso = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+05:30`).toISOString();
          } catch { /* skip */ }
        }
      }
      if (!pubDateIso && channelBuildDate) {
        try { pubDateIso = new Date(channelBuildDate).toISOString(); } catch { /* skip */ }
      }

      return {
        article_id: `${source.id}-${stableId}`,
        title,
        description,
        content,
        link,
        source_id: source.id,
        source_name: source.name,
        source_url: source.url,
        pubDate: pubDateIso,
        image_url: imageUrl,
        category: [category],
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
        link = canonicalizeUrl(linkAttr.find((l) => l["@_href"])?.["@_href"] ?? "");
      } else if (linkAttr?.["@_href"]) {
        link = canonicalizeUrl(linkAttr["@_href"]);
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

async function fetchOneRssFeed(source: RssSource, category = "technology"): Promise<NewsDataArticle[]> {
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
    return parseRssFeed(xml, source, category);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchCategoryRss(
  sources: RssSource[],
  category: string,
): Promise<NewsDataArticle[]> {
  const results = await Promise.allSettled(
    sources.map((s) => fetchOneRssFeed(s, category)),
  );
  const articles: NewsDataArticle[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") articles.push(...r.value);
  }
  articles.sort((a, b) => {
    const ta = a.pubDate ? Date.parse(a.pubDate) : 0;
    const tb = b.pubDate ? Date.parse(b.pubDate) : 0;
    return tb - ta;
  });
  return articles;
}

const ogImageCache = new Map<string, { url: string | null; ts: number }>();
const OG_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const OG_NULL_CACHE_TTL_MS = 5 * 60 * 1000; // retry failed lookups after 5 min

async function getOgImageCached(articleUrl: string): Promise<string | null> {
  const cached = ogImageCache.get(articleUrl);
  if (cached) {
    const ttl = cached.url ? OG_CACHE_TTL_MS : OG_NULL_CACHE_TTL_MS;
    if (Date.now() - cached.ts < ttl) return cached.url;
  }
  const url = await fetchOgImage(articleUrl);
  ogImageCache.set(articleUrl, { url, ts: Date.now() });
  return url;
}

const PREFERRED_SOURCES = new Set(["techcrunch", "theverge", "arstechnica"]);
const SIXTY_HOURS_MS = 60 * 60 * 60 * 1000;
const FORTY_HOURS_MS = SIXTY_HOURS_MS; // alias kept for tech feed usage

async function fetchTechRss(): Promise<NewsDataArticle[]> {
  const results = await Promise.allSettled(
    TECH_RSS_SOURCES.map((s) => fetchOneRssFeed(s)),
  );
  const articles: NewsDataArticle[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") articles.push(...r.value);
  }

  // Sort: preferred sources first, then newest first within each tier
  articles.sort((a, b) => {
    const ta = a.pubDate ? Date.parse(a.pubDate) : 0;
    const tb = b.pubDate ? Date.parse(b.pubDate) : 0;
    const prefA = PREFERRED_SOURCES.has(a.source_id ?? "") ? 1 : 0;
    const prefB = PREFERRED_SOURCES.has(b.source_id ?? "") ? 1 : 0;
    if (prefB !== prefA) return prefB - prefA;
    return tb - ta;
  });

  const top = articles.slice(0, 300);

  await enrichMissingImages(top);
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

// ----- Deterministic clustering (zero AI cost) -----
// Groups articles by title similarity (Jaccard on word tokens) and same-domain
// proximity. No external API calls, runs in <1ms per article.
const STOPWORDS = new Set([
  "a","an","the","is","are","was","were","be","been","being","have","has",
  "had","do","does","did","will","would","could","should","may","might",
  "shall","to","of","in","for","on","with","as","at","by","from","that",
  "this","it","its","and","or","but","not","no","if","so","up","out","about",
  "into","over","after","new","says","said","us","can","now","more","how",
  "than","its","their","they","we","he","she","his","her","our","your",
  // News-specific false-connector words that cause unrelated articles to merge
  "live","update","updates","latest","breaking","report","reports","watch",
  "today","top","key","big","full","first","last","amid","here",
  "what","why","when","where","who","video","read","know","just","get",
  "make","take","come","give","back","time","year","week","day","month","major",
]);

function titleTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// What fraction of the smaller headline's tokens appear in the larger one.
// Better than Jaccard for same-story detection across headlines of different lengths.
function overlapCoefficient(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection++;
  }
  return intersection / Math.min(a.size, b.size);
}

function articleDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

const TRACKING_PARAMS = new Set([
  "utm_source","utm_medium","utm_campaign","utm_term","utm_content","utm_id",
  "fbclid","gclid","gbraid","wbraid","ref","source","_r","cid",
  "mc_cid","mc_eid","ncid","s","sr","via","icid","cms","outputType",
]);

function canonicalizeUrl(url: string): string {
  if (!url) return url;
  try {
    const u = new URL(url);
    for (const p of TRACKING_PARAMS) u.searchParams.delete(p);
    u.hash = "";
    return u.href;
  } catch {
    return url;
  }
}

function titleNamedEntities(title: string): Set<string> {
  const entities = new Set<string>();
  const words = title.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!.replace(/[^a-zA-Z]/g, "");
    // ALL-CAPS acronym (e.g. BJP, NASA, IPL)
    if (/^[A-Z]{2,}$/.test(w) && w.length > 2) {
      entities.add(w.toLowerCase());
    }
    // Two consecutive Title-Case words = named entity
    if (i < words.length - 1) {
      const w2 = words[i + 1]!.replace(/[^a-zA-Z]/g, "");
      if (
        w.length > 1 && w2.length > 1 &&
        /^[A-Z]/.test(w) && /^[A-Z]/.test(w2)
      ) {
        entities.add((w + " " + w2).toLowerCase());
      }
    }
  }
  return entities;
}

// Cluster articles by title similarity and same-domain proximity.
// Returns a ClusterResult matching the same shape buildStoryCards expects.
function deterministicCluster(articles: NewsDataArticle[]): ClusterResult {
  const tokenSets = articles.map((a) => titleTokens(a.title ?? ""));
  const entitySets = articles.map((a) => titleNamedEntities(a.title ?? ""));
  const assigned = new Array<number>(articles.length).fill(-1);
  const clusters: ClusterResult["clusters"] = [];

  for (let i = 0; i < articles.length; i++) {
    if (assigned[i] !== -1) continue;
    const clusterIdx = clusters.length;
    assigned[i] = clusterIdx;
    const members: number[] = [i];

    for (let j = i + 1; j < articles.length; j++) {
      if (assigned[j] !== -1) continue;
      if (members.length >= 8) break;
      // Never cluster same domain/publisher.
      const domA = articleDomain(articles[i]!.link ?? "");
      const domB = articleDomain(articles[j]!.link ?? "");
      if (domA && domA === domB) continue;
      const overlap = overlapCoefficient(tokenSets[i]!, tokenSets[j]!);
      // Force-cluster if 2+ shared named entities (e.g. "Narendra Modi", "Supreme Court")
      let sharedEntities = 0;
      for (const e of entitySets[i]!) {
        if (entitySets[j]!.has(e)) sharedEntities++;
      }
      if (overlap >= 0.35 || sharedEntities >= 2) {
        assigned[j] = clusterIdx;
        members.push(j);
      }
    }

    const rep = articles[i]!;
    const desc = stripHtml(
      (rep.description ?? rep.content ?? rep.title ?? "").trim(),
    );
    const summary = naiveParagraph(desc);

    clusters.push({
      headline: rep.title ?? "Untitled",
      category: pickCategory(rep),
      article_indexes: members,
      fiveWs: naiveFiveWs(desc),
      eli5: summary,
      keyHighlights: summary,
      source_types: members.map((idx) =>
        classifySource(articles[idx]!.link ?? "", articles[idx]!.source_name ?? ""),
      ),
    });
  }

  // eslint-disable-next-line no-console
  console.log(
    `[clustering] deterministic: ${articles.length} articles → ${clusters.length} clusters`,
  );
  return { clusters };
}

// ── Mixed-feed pipeline ───────────────────────────────────────────────────────

// Topic title for a cluster: words appearing in 2+ headlines → shared theme.
function feedClusterLabel(articles: NewsDataArticle[]): string {
  const freq: Record<string, number> = {};
  for (const a of articles) {
    const seen = new Set<string>();
    for (const t of titleTokens(a.title ?? "")) {
      if (!seen.has(t)) { seen.add(t); freq[t] = (freq[t] ?? 0) + 1; }
    }
  }
  const shared = Object.entries(freq)
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([w]) => w.charAt(0).toUpperCase() + w.slice(1));
  if (shared.length > 0) return shared.join(" ");
  const rep = Array.from(titleTokens(articles[0]?.title ?? "")).slice(0, 3);
  return rep.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ") || "News";
}

// Union-Find clustering: articles sharing 2+ non-stopword title tokens are
// grouped. Returns array of groups (each is an array of article indices).
// Same-domain articles never merge. Groups are capped at 8 members.
function clusterForMixedFeed(articles: NewsDataArticle[]): number[][] {
  const tokenSets = articles.map(a => titleTokens(a.title ?? ""));
  const n = articles.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const rank = new Array<number>(n).fill(0);
  function find(x: number): number {
    if (parent[x] !== x) parent[x] = find(parent[x]!);
    return parent[x]!;
  }
  function unite(x: number, y: number) {
    const [px, py] = [find(x), find(y)];
    if (px === py) return;
    if (rank[px]! < rank[py]!) parent[px] = py;
    else if (rank[px]! > rank[py]!) parent[py] = px;
    else { parent[py] = px; rank[px]!++; }
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const domA = articleDomain(articles[i]!.link ?? "");
      const domB = articleDomain(articles[j]!.link ?? "");
      if (domA && domB && domA === domB) continue;
      let shared = 0;
      for (const t of tokenSets[i]!) if (tokenSets[j]!.has(t)) shared++;
      if (shared >= 3) unite(i, j);
    }
  }
  const compMap = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!compMap.has(root)) compMap.set(root, []);
    compMap.get(root)!.push(i);
  }
  return Array.from(compMap.values()).map(g => g.slice(0, 6));
}

// ── Cached AI feed enrichment (on the GROQ_MODEL_ENRICH model) ───────────────
// Makes the feed feel AI-curated WITHOUT AI clustering (which is algorithmic /
// free). For each CLUSTER: a meaningful Title-Case headline + a 25-word summary
// (one combined call). For each ARTICLE: a 25-word summary. All generated lazily
// and cached per signature so each runs ~once, NOT every cron poll. A shared
// 15-min back-off on any rate-limit/error stops it hammering or draining Groq;
// when it backs off the feed just falls back to the non-AI text.
const ENRICH_TTL_MS = 24 * 60 * 60 * 1000;
let enrichPausedUntil = 0;
function clampWords25(text: string): string {
  const w = (text || "").trim().replace(/\s+/g, " ").split(" ").filter(Boolean);
  return w.length <= 25 ? w.join(" ") : w.slice(0, 25).join(" ") + "…";
}

// — Cluster: label + 25-word summary —
const clusterEnrichCache = new Map<string, { label: string; summary: string; at: number }>();
const clusterEnrichInflight = new Set<string>();
function clusterSignature(ga: NewsDataArticle[]): string {
  const key = ga.slice(0, 4).map((a) => (a.link ? canonicalizeUrl(a.link) : "") || a.title || "").sort().join("|");
  return createHash("md5").update(key).digest("hex");
}
async function generateClusterEnrichment(sig: string, ga: NewsDataArticle[]): Promise<void> {
  try {
    const lines = ga.slice(0, 6).map((a) => `- ${a.title ?? ""}: ${stripHtml((a.description ?? "").slice(0, 140))}`).join("\n");
    const prompt = `These news articles all cover the SAME story. Return JSON ONLY (no markdown):
{"label":"a sharp 3-6 word Title Case headline leading with the key entity/place","summary":"ONE neutral sentence, AT MOST 25 words, of what they collectively report — no source names"}

${lines}`;
    const raw = (await callGroq(prompt, 160, { model: GROQ_MODEL_ENRICH, task: "cluster-enrich" })).replace(/```json|```/g, "").trim();
    const m = raw.match(/\{[\s\S]*\}/);
    const parsed = m ? (JSON.parse(m[0]) as { label?: string; summary?: string }) : {};
    const label = typeof parsed.label === "string" ? parsed.label.trim().slice(0, 80) : "";
    const summary = clampWords25(stripHtml(typeof parsed.summary === "string" ? parsed.summary : ""));
    if (label || summary) clusterEnrichCache.set(sig, { label, summary, at: Date.now() });
  } catch {
    enrichPausedUntil = Date.now() + 15 * 60 * 1000;
  } finally {
    clusterEnrichInflight.delete(sig);
  }
}
function clusterEnrichment(ga: NewsDataArticle[]): { label: string; summary: string } | null {
  const sig = clusterSignature(ga);
  const c = clusterEnrichCache.get(sig);
  if (c && Date.now() - c.at < ENRICH_TTL_MS) return { label: c.label, summary: c.summary };
  if (Date.now() > enrichPausedUntil && !clusterEnrichInflight.has(sig)) {
    clusterEnrichInflight.add(sig);
    void generateClusterEnrichment(sig, ga);
  }
  return null;
}

// — Article: 25-word summary (card-based; applied only to TOP feed cards) —
// Keyed by the card's source URL so it survives re-clustering. Only the top N
// ranked cards are ever asked (see buildMixedFeed) so 70b's budget isn't blown
// trying to summarise the full ~300-article feed.
const articleSummaryCache = new Map<string, { summary: string; at: number }>();
const articleSummaryInflight = new Set<string>();
function cardSignature(card: StoryCard): string {
  const url = card.sources?.[0]?.url ?? "";
  return createHash("md5").update((url ? canonicalizeUrl(url) : "") || card.headline || "").digest("hex");
}
async function generateCardSummary(sig: string, card: StoryCard): Promise<void> {
  try {
    const body = stripHtml((card.summary ?? "").slice(0, 600));
    const prompt = `Summarise this news article in ONE neutral, informative sentence of AT MOST 25 words. No preamble, no markdown.\n\nHeadline: ${card.headline ?? ""}\n${body}\n\nSummary:`;
    const text = (await callGroq(prompt, 80, { model: GROQ_MODEL_ENRICH, task: "article-summary-feed" })).trim().replace(/^summary:\s*/i, "");
    const summary = clampWords25(stripHtml(text));
    if (summary) articleSummaryCache.set(sig, { summary, at: Date.now() });
  } catch {
    enrichPausedUntil = Date.now() + 15 * 60 * 1000;
  } finally {
    articleSummaryInflight.delete(sig);
  }
}
function cardAiSummary(card: StoryCard): string | null {
  const sig = cardSignature(card);
  const c = articleSummaryCache.get(sig);
  if (c && Date.now() - c.at < ENRICH_TTL_MS) return c.summary;
  if (Date.now() > enrichPausedUntil && !articleSummaryInflight.has(sig)) {
    articleSummaryInflight.add(sig);
    void generateCardSummary(sig, card);
  }
  return null;
}

// Score and order all groups into a mixed FeedItem[].
// Groups ≥ 3 become clusters; smaller groups produce standalone FeedArticle items.
// score = velocity * 0.4 + freshness * 0.35 + relevance * 0.25
function buildMixedFeed(articles: NewsDataArticle[], groups: number[][]): FeedItem[] {
  const now = Date.now();
  const scored: Array<{ item: FeedItem; score: number }> = [];

  for (const group of groups) {
    const ga = group.map(i => articles[i]!).filter(Boolean);
    if (ga.length === 0) continue;

    const newest = Math.max(...ga.map(a => a.pubDate ? Date.parse(a.pubDate) : 0));
    const hoursOld = Math.max(0, (now - newest) / 3_600_000);

    if (group.length >= 3) {
      const recentCount = ga.filter(a => {
        const ms = a.pubDate ? Date.parse(a.pubDate) : 0;
        return now - ms < 3 * 3_600_000;
      }).length;
      const velocity = recentCount / ga.length;
      const freshness = 1 / (hoursOld + 1);
      const relevance = Math.log(ga.length + 1);
      const score = velocity * 0.4 + freshness * 0.35 + relevance * 0.25;

      const cards = buildFallbackStories(ga);
      const rep = ga[0]!;
      // AI feed enrichment (cached): a meaningful cluster headline + 25-word
      // summary. Falls back to the algorithmic label / lead description until
      // generated or if Groq's enrich budget is unavailable.
      const enrich = clusterEnrichment(ga);
      const topicTitle = (enrich?.label) || feedClusterLabel(ga);
      const topicSummary =
        (enrich?.summary) ||
        naiveParagraph(stripHtml((rep.description ?? rep.content ?? rep.title ?? "").trim()));
      scored.push({ item: { type: "cluster", topicTitle, topicSummary, articles: cards }, score });
    } else {
      for (const a of ga) {
        const pubMs = a.pubDate ? Date.parse(a.pubDate) : 0;
        const ah = Math.max(0, (now - pubMs) / 3_600_000);
        const velocity = ah < 1 ? 1 : Math.exp(-0.5 * (ah - 1));
        const freshness = 1 / (ah + 1);
        const score = velocity * 0.4 + freshness * 0.35 + 0.3 * 0.25;
        const [card] = buildFallbackStories([a]);
        if (card) scored.push({ item: { ...card, type: "article" }, score });
      }
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const items = scored.map(s => s.item);
  // 25-word AI summary ONLY for the top-ranked solo cards (what users see
  // first). Bounded so 70b's daily budget isn't blown on the full ~300-item
  // feed. Lazy + cached; falls back to the raw summary until ready.
  const TOP_AI_SUMMARIES = 24;
  let done = 0;
  for (const item of items) {
    if (done >= TOP_AI_SUMMARIES) break;
    if (item.type === "article") {
      const ai = cardAiSummary(item);
      if (ai) item.aiSummary = ai;
      done++;
    }
  }
  return items;
}

// Extract all StoryCards from a FeedItem array (used for publisher counting,
// push notification fingerprinting, etc.).
function extractCards(items: FeedItem[]): StoryCard[] {
  const out: StoryCard[] = [];
  for (const item of items) {
    if (item.type === "cluster") out.push(...item.articles);
    else out.push(item);
  }
  return out;
}

// Representative StoryCards for push-notification dedup fingerprinting.
// For clusters, returns the first article with sourceCount set to cluster size.
function feedToRepCards(items: FeedItem[]): StoryCard[] {
  return items.flatMap(item => {
    if (item.type === "cluster") {
      const rep = item.articles[0];
      return rep ? [{ ...rep, sourceCount: item.articles.length }] : [];
    }
    return [item as StoryCard];
  });
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
  "financialexpress.com",
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
  // Skip descriptions that are just a URL (common in HN/aggregator feeds)
  if (/^https?:\/\/\S+$/.test(text.trim())) return [];
  const sentences = text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12 && !/^https?:\/\//i.test(s));
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
  // Skip URL-only descriptions
  if (/^https?:\/\/\S+$/.test(text.trim())) return "";
  const compact = text
    .replace(/\s+/g, " ")
    .trim();
  const words = compact.split(" ");
  if (words.length <= 110) return compact;
  return words.slice(0, 110).join(" ") + "…";
}

function first50Words(text: string): string {
  if (!text) return "";
  const compact = text.replace(/\s+/g, " ").trim();
  const words = compact.split(" ").filter(Boolean);
  if (words.length <= 50) return compact;
  return words.slice(0, 50).join(" ") + "…";
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
      id: createHash("md5").update(sourceUrl || a.article_id || `${Date.now()}-${idx}`).digest("hex").slice(0, 16),
      headline,
      category: pickCategory(a),
      imageUrl: a.image_url ?? null,
      publishedAt: a.pubDate ?? new Date().toISOString(),
      summary: first50Words(text),
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

    // Deduplicate by domain — one entry per publisher
    const seenDomains = new Set<string>();
    const sources: Source[] = clusterArticles.reduce<Source[]>((acc, a, i) => {
      const domain = articleDomain(a.link ?? "");
      if (domain && seenDomains.has(domain)) return acc;
      if (domain) seenDomains.add(domain);
      acc.push({
        name: a.source_name ?? a.source_id ?? "Unknown",
        url: a.link ?? "",
        type: cluster.source_types?.[i] ?? "niche",
        imageUrl: a.image_url ?? null,
        publishedAt: a.pubDate ?? undefined,
      });
      return acc;
    }, []);

    const firstWithImage = clusterArticles.find((a) => a.image_url);
    const firstArticle = clusterArticles[0];

    return {
      id: `${Date.now()}-${idx}-${firstArticle?.article_id ?? idx}`,
      headline: cluster.headline,
      category: cluster.category,
      imageUrl: firstWithImage?.image_url ?? null,
      publishedAt: firstArticle?.pubDate ?? new Date().toISOString(),
      summary: first50Words(
        firstArticle?.description ?? firstArticle?.content ?? firstArticle?.title ?? "",
      ),
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

function detectTrending(stories: StoryCard[]): StoryCard[] {
  const now = Date.now();
  return stories.map(s => {
    const age = now - new Date(s.publishedAt).getTime();
    return {
      ...s,
      isTrending: s.sourceCount >= 3,
      isBreaking: s.sourceCount >= 2 && age < 2 * 60 * 60 * 1000,
      isDeveloping: s.sourceCount >= 4 && age < 6 * 60 * 60 * 1000,
    };
  });
}

const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;

async function buildBreakingFeed(): Promise<FeedItem[]> {
  const cutoff = Date.now() - EIGHT_HOURS_MS;

  // All sources: tech + all topic-specific feeds, deduped by id
  const seen = new Set<string>();
  const uniqueSources: RssSource[] = [];
  for (const s of [
    ...TECH_RSS_SOURCES,
    ...INDIA_POLITICS_RSS_SOURCES,
    ...MARKETS_RSS_SOURCES,
    ...GEOPOLITICS_RSS_SOURCES,
    ...BUSINESS_RSS_SOURCES,
  ]) {
    if (!seen.has(s.id)) { seen.add(s.id); uniqueSources.push(s); }
  }

  const results = await Promise.allSettled(
    uniqueSources.map(s => fetchOneRssFeed(s, "breaking")),
  );
  const raw: NewsDataArticle[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") raw.push(...r.value);
  }

  // Hard-filter: remove sports/entertainment and gadget-deal noise
  const filtered = raw
    .filter(a => !isSportsOrEntertainment(a))
    .filter(a => !isJunkRoundup(a))
    .filter(a => {
      const text = `${a.title ?? ""} ${a.description ?? ""}`;
      return !BREAKING_LOWPRIORITY_RE.test(text);
    });

  // Score and sort by relevance + freshness
  const scored = filtered.map(a => ({ a, score: breakingScore(a) }));
  scored.sort((x, y) => y.score - x.score);

  // Drop articles with negative scores (low-priority even after hard filter)
  const recent = scored.filter(({ score }) => score >= -2).map(({ a }) => a);

  const recentDeduped = capBySource(recent, 999);
  await enrichMissingImages(recentDeduped);
  const groups = clusterForMixedFeed(recentDeduped);
  return buildMixedFeed(recentDeduped, groups);
}

// ----- AI clustering (stale-while-revalidate, 30-min TTL) -----

function articleFingerprint(articles: any[]): string {
  return articles
    .slice(0, 20)
    .map(a => a.id || a.headline?.slice(0, 20))
    .join('|');
}

const globalClusterCache = new Map<string, {
  clusters: any[];
  fingerprint: string;
  ts: number;
}>();

const CLUSTER_TTL = 30 * 60 * 1000;
let clusteringInProgress = false;
let aiCallsToday = 0;
let lastReset = Date.now();

function clusterByKeywords(articles: any[]): any[] {
  return articles.slice(0, 8);
}

async function getAIClusters(topic: string, articles: any[]): Promise<any[]> {
  const fingerprint = articleFingerprint(articles);
  const cached = globalClusterCache.get(topic);

  if (
    cached &&
    cached.fingerprint === fingerprint &&
    Date.now() - cached.ts < CLUSTER_TTL
  ) {
    return cached.clusters;
  }

  if (cached && !clusteringInProgress) {
    clusteringInProgress = true;
    runAIClustering(topic, articles, fingerprint)
      .finally(() => { clusteringInProgress = false; });
    return cached.clusters;
  }

  if (!cached) {
    return await runAIClustering(topic, articles, fingerprint);
  }

  return cached.clusters;
}

async function runAIClustering(
  topic: string,
  articles: any[],
  fingerprint: string,
): Promise<any[]> {
  try {
    if (Date.now() - lastReset > 86400000) {
      aiCallsToday = 0;
      lastReset = Date.now();
    }

    // Daily AI-call budget cap removed by request — AI clustering always runs.
    // (Counter kept only for logging/visibility.)

    const headlines = articles
      .slice(0, 30)
      .map((a, i) => {
        // Use a:Headline | Summary excerpt so the AI sees more semantic signal.
        const summary = (a as { summary?: string }).summary?.replace(/\s+/g, ' ').slice(0, 160) ?? '';
        return `${i}: ${a.headline}${summary ? ` | ${summary}` : ''}`;
      })
      .join('\n');

    const prompt = `You are a senior news editor. Read each headline + summary excerpt and group the stories into clusters.

${headlines}

GROUPING RULES (strict — read carefully):
- Cluster only stories that are about the SAME UNDERLYING EVENT or the SAME ONGOING SITUATION involving the same primary entity. Examples:
  * Two stories about today's Fed rate decision → SAME cluster.
  * Fed decision + a general "interest rates explained" piece → DIFFERENT clusters.
  * iPhone 17 launch coverage from 3 outlets → SAME cluster.
  * iPhone 17 launch + Apple Vision Pro update → DIFFERENT clusters.
- Same broad theme is NOT enough ("tech", "politics", "cricket"). It must be the same event/entity.
- Each headline index appears in exactly one group.
- 4-8 groups maximum.
- Stories that don't fit any cluster go into "Other".

LABEL STYLE — write each cluster label like a magazine section title:
- 3-6 words, Title Case.
- Lead with the named entity/place when there is one ("Iran-Israel Strikes", "Modi Cabinet Reshuffle", "Apple iPhone 17 Launch", "Tesla Q3 Earnings", "OpenAI Sora 2 Release").
- Capture the ANGLE, not just the topic: "Fed Holds Rates Amid Inflation Fears" beats "Federal Reserve".
- No vague labels like "Politics", "Tech", "Updates", "News". No clickbait. No emoji.
- "Other" is the only allowed generic label, and only for unrelated singletons.

Return JSON only:
{"groups":[{"label":"<sharp label>","indices":[0,1,4]},{"label":"Other","indices":[2,3]}]}`;

    aiCallsToday++;
    console.log(`AI call #${aiCallsToday} today for ${topic}`);

    const text = await callGroq(prompt, 600, { model: GROQ_MODEL_FAST, task: "clustering" });
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    if (!parsed?.groups?.length) throw new Error('Bad response');

    const clustered = parsed.groups
      .map((g: any) => {
        const groupArticles = (g.indices || [])
          .filter((i: number) => i >= 0 && i < articles.length)
          .map((i: number) => articles[i])
          .filter(Boolean);

        if (!groupArticles.length) return null;
        const primary = groupArticles[0];

        return {
          id: primary.id || `ai_${g.label}`,
          headline: primary.headline,
          summary: primary.summary,
          imageUrl: primary.imageUrl,
          publishedAt: primary.publishedAt,
          category: primary.category,
          clusterLabel: g.label,
          sourceCount: groupArticles.length,
          isTrending: groupArticles.length >= 3,
          isBreaking:
            groupArticles.length >= 2 &&
            Date.now() - new Date(primary.publishedAt).getTime() < 7200000,
          sources: groupArticles.map((a: any) => ({
            name: a.source || a.sources?.[0]?.name || '',
            url: a.url || a.sources?.[0]?.url || '',
            imageUrl: a.imageUrl,
            publishedAt: a.publishedAt,
          })),
        };
      })
      .filter(Boolean)
      .sort(
        (a: any, b: any) =>
          new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime(),
      )
      .slice(0, 8);

    globalClusterCache.set(topic, { clusters: clustered, fingerprint, ts: Date.now() });
    return clustered;

  } catch (e) {
    console.error(`AI clustering failed for ${topic}:`, e);
    const fallback = clusterByKeywords(articles);
    if (fallback.length > 0) {
      globalClusterCache.set(topic, { clusters: fallback, fingerprint, ts: Date.now() });
      return fallback;
    }
    return articles;
  }
}

async function buildFreshFeed(topic: string): Promise<FeedItem[]> {
  if (topic === "breaking") return buildBreakingFeed();

  // Reuse cluster assignments when only scores need updating (saves RSS round-trip).
  const rawEntry = rawFeedCache.get(topic);
  if (rawEntry && Date.now() - rawEntry.at < RAW_FEED_TTL_MS) {
    return buildMixedFeed(rawEntry.articles, rawEntry.groups);
  }

  let articles: NewsDataArticle[];
  switch (topic) {
    case "technology":
      articles = await fetchTechRss();
      break;
    case "india-politics":
    case "geopolitics":
    case "markets":
    case "business":
      articles = await fetchIndianFeeds(topic);
      break;
    default:
      articles = await fetchNewsData(topic);
  }
  if (articles.length === 0) return [];

  // Deduplicate by canonical URL before clustering — prevents same-URL articles
  // from landing in the same cluster and generating identical MD5 IDs.
  const deduped = capBySource(articles, 999);
  const groups = clusterForMixedFeed(deduped);
  rawFeedCache.set(topic, { articles: deduped, groups, at: Date.now() });
  return buildMixedFeed(deduped, groups);
}

const inflightFeed = new Map<string, Promise<FeedItem[]>>();

// Minimum number of distinct publisher hostnames a refresh must produce before
// we'll let it overwrite an existing healthy cache entry. Prevents a cold-start
// scenario where only one RSS source returned in time from poisoning the cache
// for the next TTL window.
const MIN_HEALTHY_PUBLISHERS = 3;

function distinctPublisherCount(items: FeedItem[]): number {
  const hosts = new Set<string>();
  for (const card of extractCards(items)) {
    for (const src of card.sources ?? []) {
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
    .then((feed) => {
      const freshPubs = distinctPublisherCount(feed);
      const existing = cache.get(topic);
      const existingPubs = existing ? distinctPublisherCount(existing.data) : 0;

      const isDegraded = freshPubs < MIN_HEALTHY_PUBLISHERS;
      const shouldKeepExisting = isDegraded && existing && existingPubs > freshPubs;

      if (shouldKeepExisting) {
        // eslint-disable-next-line no-console
        console.log(
          `[prewarm] ${topic} SKIPPED cache write (degraded: ${freshPubs} publishers, ${feed.length} items) — keeping existing (${existingPubs} publishers, ${existing.data.length} items)`,
        );
      } else {
        const repCards = feedToRepCards(existing?.data ?? []);
        const previousFps = new Set(repCards.map(clusterFingerprint));
        cache.set(topic, { at: Date.now(), data: feed });
        persistFeedCache();
        // eslint-disable-next-line no-console
        console.log(
          `[prewarm] ${topic} refreshed in ${Date.now() - started}ms (${feed.length} items, ${freshPubs} publishers${isDegraded ? " — DEGRADED but accepted (no prior cache)" : ""})`,
        );
        if (existing) {
          notifyOnNewClusters(feedToRepCards(feed), previousFps).catch(() => {});
        }
      }
      return feed;
    })
    .catch((err) => {
      log.warn({ err, topic }, "background refresh failed");
      return [] as FeedItem[];
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
// Persist sent-fingerprints to disk so Render restarts don't replay yesterday's
// breaking pushes. Map<fp, sentAtMs> with 24h TTL.
const SENT_FP_PATH = "/tmp/push-sent-fingerprints.json";
const SENT_TTL_MS = 24 * 60 * 60 * 1000;
const sentFingerprints = new Map<string, number>(
  ((): [string, number][] => {
    try {
      const raw = readFileSync(SENT_FP_PATH, "utf8");
      const arr = JSON.parse(raw) as [string, number][];
      const cutoff = Date.now() - SENT_TTL_MS;
      return arr.filter(([, t]) => t > cutoff);
    } catch { return []; }
  })(),
);
function persistSentFingerprints(): void {
  try {
    writeFileSync(SENT_FP_PATH, JSON.stringify([...sentFingerprints.entries()]));
  } catch { /* best effort */ }
}

// Per-token rate limit: max 5 pushes/hour. In-memory rolling window.
const PUSH_RATE_PATH = "/tmp/push-rate-window.json";
const PUSH_RATE_MAX = 5;
const PUSH_RATE_WINDOW_MS = 60 * 60 * 1000;
const pushRateWindow = new Map<string, number[]>(
  ((): [string, number[]][] => {
    try { return JSON.parse(readFileSync(PUSH_RATE_PATH, "utf8")) as [string, number[]][]; }
    catch { return []; }
  })(),
);
function persistPushRate(): void {
  try {
    writeFileSync(PUSH_RATE_PATH, JSON.stringify([...pushRateWindow.entries()]));
  } catch {}
}
// Per-token hourly rate limit removed by request — no volume caps anywhere.
// Dedup (rememberSent fingerprint) + freshness window still prevent duplicate
// and stale sends; this only governs raw volume, which the user wants uncapped.
function tokensUnderLimit(tokens: string[]): string[] {
  return tokens;
}
function recordPushes(tokens: string[]): void {
  const now = Date.now();
  for (const t of tokens) {
    const arr = pushRateWindow.get(t) ?? [];
    arr.push(now);
    pushRateWindow.set(t, arr);
  }
  persistPushRate();
}

// Stable per-STORY signature: the significant headline tokens (stopwords
// stripped), sorted. Deliberately ignores source URLs and word order so that
// the SAME breaking story keeps ONE fingerprint even as more publishers join
// the cluster or the lead headline is reworded between polls — which was
// causing the same breaking push to fire repeatedly.
function storySignature(headline: string): string[] {
  return Array.from(titleTokens(headline ?? "")).sort();
}
function clusterFingerprint(s: StoryCard): string {
  const sig = storySignature(s.headline ?? "").join("|");
  // Fall back to the raw headline if it had no significant tokens at all.
  const key = sig || (s.headline ?? "").trim().toLowerCase().slice(0, 200);
  return createHash("sha256").update(key).digest("hex");
}

// NOTE: the signature-based clusterFingerprint above already de-dups the
// "same story, more sources joined" case that caused repeating breaking
// pushes. An additional fuzzy (Jaccard) guard was tried but over-suppressed
// genuinely-new stories, so it was removed — exact signature dedup only.

function rememberSent(fp: string): void {
  // Cheap GC: prune expired entries when the map grows.
  if (sentFingerprints.size > 1000) {
    const cutoff = Date.now() - SENT_TTL_MS;
    for (const [k, v] of sentFingerprints.entries()) {
      if (v < cutoff) sentFingerprints.delete(k);
    }
  }
  sentFingerprints.set(fp, Date.now());
  persistSentFingerprints();
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
  const aiFeedTokens = allPrefs
    .filter((p) => p.aiFeedEnabled)
    .map((p) => p.token);
  // Topic subs carry favSources too — when non-empty they AND-gate the
  // topic match (Option A: "only push topic-matched stories from my fav
  // publications"). Empty favSources = topic alone fires.
  const topicSubs = allPrefs
    .filter((p) => p.topicsEnabled && p.topicsKeywords.length > 0)
    .map((p) => ({
      token: p.token,
      kws: p.topicsKeywords,
      favSrcs: (p.favSourcesEnabled && Array.isArray(p.favSources))
        ? p.favSources.map((s: string) => s.toLowerCase())
        : [],
    }));
  // (favSourceSubs removed — fav sources are now only an AND-filter inside
  // topicSubs, no standalone fav-source notification stream.)

  const FRESH_MS = 90 * 60 * 1000;
  // No volume caps (per user request): every fresh, non-duplicate cluster that
  // matches a user's prefs is sent. Dedup fingerprint + 90-min freshness are
  // the only gates remaining.
  const DEVANAGARI = /[ऀ-ॿ]/; // Hindi headlines — out of scope, feed already filters.

  // Freshness filter + drop Hindi headlines.
  const fresh = newClusters.filter(({ s }) => {
    const headline = s.headline ?? "";
    const summary = (s as { summary?: string }).summary ?? "";
    if (DEVANAGARI.test(headline) || DEVANAGARI.test(summary)) return false;
    const ts = Date.parse((s as { publishedAt?: string }).publishedAt ?? "");
    return Number.isFinite(ts) && Date.now() - ts < FRESH_MS;
  });

  // No volume caps anywhere (per user request). Dedup + freshness still apply.
  for (const { s: cluster, fp } of fresh) {
    const isBreaking = (cluster.sourceCount ?? cluster.sources?.length ?? 0) >= 3;
    const primary = cluster.sources?.[0];
    const articlePayload = {
      id: cluster.id,
      headline: cluster.headline,
      summary: (cluster as { summary?: string }).summary ?? "",
      imageUrl: (cluster as { imageUrl?: string }).imageUrl ?? "",
      url: primary?.url ?? "",
      source: primary?.name ?? "",
      publishedAt: (cluster as { publishedAt?: string }).publishedAt ?? "",
    };

    // B) Breaking news: 3+ publisher confirmation, rate-limited per-token.
    if (isBreaking && breakingTokens.length > 0) {
      const allowed = tokensUnderLimit(breakingTokens);
      if (allowed.length > 0) {
        await sendPushToTokens(allowed, {
          title: "Breaking",
          body: cluster.headline,
          data: { kind: "breaking", clusterId: cluster.id, fp, article: articlePayload },
        });
        recordPushes(allowed);
      }
    }

    // B2) AI Feed alerts — same breaking trigger, deeplinks to AI Feed Deep
    // Dive. This is a BREAKING-tier notification (only fires on isBreaking),
    // so it must NOT be gated by the non-breaking cap — otherwise after 5
    // topic/fav pushes in a tick, AI Feed breaking would be silently dropped
    // (which is exactly the "AI feed notifs dead" symptom). Uncapped like
    // regular breaking; per-token hourly rate-limit still applies.
    if (isBreaking && aiFeedTokens.length > 0) {
      const allowed = tokensUnderLimit(aiFeedTokens);
      if (allowed.length > 0) {
        await sendPushToTokens(allowed, {
          title: "AI Feed · Breaking",
          body: cluster.headline,
          data: { kind: "ai-feed", clusterId: cluster.id, fp, article: articlePayload },
        });
        recordPushes(allowed);
      }
    }

    // C) Topic alerts: stars gate by MATCH STRENGTH (relevance signal), not
    // by source coverage — so a niche topic (e.g. ISRO) with one publisher
    // still fires at 5★. Per topic-entry "keyword|Label|stars":
    //   5★ = any single keyword match (headline OR summary)
    //   4★ = headline match OR 2+ summary matches
    //   3★ = headline match required (>=1 in headline)
    //   2★ = 2+ total matches across headline+summary
    //   1★ = 3+ total matches AND cluster is breaking-flagged
    //   0★ = skip
    // Back-compat: 2-field "keyword|label" treated as 3★.
    if (topicSubs.length > 0) {
      const headline = (cluster.headline ?? "").toLowerCase();
      const summary = ((cluster as { summary?: string }).summary ?? "").toLowerCase();
      const category = (cluster.category ?? "").toLowerCase();
      const clusterSrcs = (cluster.sources ?? [])
        .map((s: { name?: string }) => (s.name ?? "").toLowerCase())
        .filter(Boolean);
      const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const labelToTokens = new Map<string, string[]>();

      // Group entries by label so we count matches per topic, not per keyword.
      // Stars come from the label's strongest entry.
      type EntryMatch = { hHits: number; sHits: number; stars: number };
      for (const sub of topicSubs) {
        // Option A AND-gate: when user has fav sources, topic match must
        // ALSO come from one of those sources. Empty favSrcs = no filter.
        if (sub.favSrcs.length > 0) {
          const hit = clusterSrcs.some((s) => sub.favSrcs.includes(s));
          if (!hit) continue;
        }
        const perLabel = new Map<string, EntryMatch>();
        for (const entry of sub.kws as string[]) {
          const parts = entry.split("|");
          const kw = (parts[0] ?? "").toLowerCase().trim();
          const label = (parts[1] ?? "").trim() || "Topic alert";
          const starsRaw = parts[2];
          const stars = starsRaw == null ? 3 : Math.max(0, Math.min(5, parseInt(starsRaw, 10) || 0));
          if (!kw || stars === 0) continue;
          const re = new RegExp(`(?:^|[^a-z0-9])${escapeRe(kw)}(?:[^a-z0-9]|$)`, "gi");
          const hHits = (headline.match(re)?.length ?? 0) + (category.match(re)?.length ?? 0);
          const sHits = summary.match(re)?.length ?? 0;
          if (hHits === 0 && sHits === 0) continue;
          const prev = perLabel.get(label) ?? { hHits: 0, sHits: 0, stars };
          perLabel.set(label, {
            hHits: prev.hHits + hHits,
            sHits: prev.sHits + sHits,
            stars: Math.max(prev.stars, stars),
          });
        }

        // Pick the strongest matched label that also passes its tier.
        let chosen: string | undefined;
        let chosenScore = -1;
        for (const [label, m] of perLabel.entries()) {
          const total = m.hHits + m.sHits;
          let pass = false;
          if (m.stars >= 5) pass = total >= 1;
          else if (m.stars === 4) pass = m.hHits >= 1 || m.sHits >= 2;
          else if (m.stars === 3) pass = m.hHits >= 1;
          else if (m.stars === 2) pass = total >= 2;
          else if (m.stars === 1) pass = total >= 3 && isBreaking;
          if (!pass) continue;
          // Score: prefer higher star, then heavier headline weight.
          const score = m.stars * 100 + m.hHits * 3 + m.sHits;
          if (score > chosenScore) { chosenScore = score; chosen = label; }
        }
        if (chosen) {
          const arr = labelToTokens.get(chosen) ?? [];
          arr.push(sub.token);
          labelToTokens.set(chosen, arr);
        }
      }
      for (const [label, tokens] of labelToTokens.entries()) {
        const allowed = tokensUnderLimit(tokens);
        if (allowed.length === 0) continue;
        await sendPushToTokens(allowed, {
          // Header shows "Topic · Source" so the user sees which starred
          // topic matched AND which publisher it came from.
          title: primary?.name ? `${toTitleCase(label)} · ${primary.name}` : toTitleCase(label),
          body: cluster.headline,
          data: { kind: "topic", topicLabel: label, clusterId: cluster.id, fp, article: articlePayload },
        });
        recordPushes(allowed);
      }
    }

    // (Standalone fav-source notification stream removed.) Favorite sources
    // now serve ONLY as an AND-filter on topic alerts (section C) — picking
    // fav sources no longer blasts every story those publishers post.

    rememberSent(fp);
  }
}

// ----- Cache hydration on boot -----
// We intentionally DO NOT run a background prewarm worker. Refreshes happen
// only on demand: when a user pulls-to-refresh in the app (which sends
// `?refresh=1`) or when the disk cache is empty/stale at request time. This
// keeps Gemini and NewsData spend bounded by actual user activity.
loadFeedCacheFromDisk();
// eslint-disable-next-line no-console
console.log(
  `[boot] feedCache=${cache.size} topics (no background prewarm)`,
);

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

// Live per-source article count diagnostic — fetches all feeds and returns
// item counts, latency, and status per source. Used for debugging feed health.
router.get("/debug/sources", async (_req, res) => {
  const allSources: RssSource[] = (() => {
    const seen = new Set<string>();
    const out: RssSource[] = [];
    for (const s of [...TECH_RSS_SOURCES, ...ALL_GENERAL_RSS_SOURCES]) {
      if (!seen.has(s.id)) { seen.add(s.id); out.push(s); }
    }
    return out;
  })();

  const started = Date.now();
  const results = await Promise.allSettled(
    allSources.map(async (s) => {
      const t0 = Date.now();
      try {
        const articles = await fetchOneRssFeed(s, "debug");
        return { id: s.id, name: s.name, url: s.url, items: articles.length, latencyMs: Date.now() - t0, status: "ok" };
      } catch (err) {
        return { id: s.id, name: s.name, url: s.url, items: 0, latencyMs: Date.now() - t0, status: err instanceof Error ? err.message : "error" };
      }
    }),
  );

  const rows = results.map(r => r.status === "fulfilled" ? r.value : { items: 0, status: "promise-rejected" });
  rows.sort((a, b) => (b as { items: number }).items - (a as { items: number }).items);
  res.json({ fetchedIn: Date.now() - started, sources: rows });
});

// Cheap cron endpoint — fires breaking-feed refresh in background, returns
// immediately. Designed for cron-job.org (avoids their 30s timeout + body
// size cap from streaming a full feed response).
// Poll every topic feed so a newly-published article in ANY category the user
// cares about (incl. markets + india-politics) gets refreshed → matched →
// pushed. refreshInBackground fires notifyOnNewClusters on genuinely-new ones.
const CRON_POLL_TOPICS = ["breaking", "technology", "geopolitics", "business", "markets", "india-politics"];
let lastCronPollAt = 0;
let cronPollCount = 0;
router.get("/cron/poll", (req, res) => {
  lastCronPollAt = Date.now(); cronPollCount++;
  for (const topic of CRON_POLL_TOPICS) refreshInBackground(topic, req.log);
  res.json({ ok: true });
});
router.post("/cron/poll", (req, res) => {
  lastCronPollAt = Date.now(); cronPollCount++;
  for (const topic of CRON_POLL_TOPICS) refreshInBackground(topic, req.log);
  res.json({ ok: true });
});
// Heartbeat — confirms whether an external cron is actually hitting /cron/poll.
router.get("/cron/status", (_req, res) => {
  res.json({
    lastPollAt: lastCronPollAt ? new Date(lastCronPollAt).toISOString() : null,
    secondsSinceLastPoll: lastCronPollAt ? Math.round((Date.now() - lastCronPollAt) / 1000) : null,
    pollsSinceBoot: cronPollCount,
    bootedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
  });
});

// AI usage dashboard — per-model + per-task token totals for today (UTC).
router.get("/ai-usage", (_req, res) => {
  const TASK_LABELS: Record<string, string> = {
    deepdive: "Deep Dive",
    "cluster-enrich": "Cluster headlines + summaries",
    "article-summary-feed": "Article 25-word summaries",
    "cluster-summary": "Cluster summaries (old)", "cluster-labels": "Cluster labels (For You)",
    "article-summary": "Article summary (5Ws/ELI5)", qna: "Follow-up Q&A",
    clustering: "AI clustering", other: "Other",
  };
  const MODEL_ROLE: Record<string, string> = {
    "meta-llama/llama-4-scout-17b-16e-instruct": "Deep Dive (flagship)",
    "llama-3.3-70b-versatile": "Feed enrichment (headlines + summaries)",
    "llama-3.1-8b-instant": "Article tools · Q&A",
  };
  const models = Object.entries(aiUsageByModel).map(([model, m]) => {
    const limit = GROQ_TPD_LIMITS[model] ?? null;
    const REQ_LIMIT = 1000; // free-tier requests/day per model (approx)
    return {
      model,
      role: MODEL_ROLE[model] ?? "—",
      tokensUsed: m.tokens,
      tokensLimit: limit,
      pct: limit ? Math.min(100, Math.round((m.tokens / limit) * 100)) : null,
      calls: m.calls,
      requestsLimit: REQ_LIMIT,
      errors: m.errors,
      tasks: Object.entries(m.tasks)
        .map(([task, t]) => ({ task, label: TASK_LABELS[task] ?? task, tokens: t.tokens, calls: t.calls, errors: t.errors }))
        .sort((a, b) => b.tokens - a.tokens),
    };
  }).sort((a, b) => b.tokensUsed - a.tokensUsed);
  const totalTokens = models.reduce((s, m) => s + m.tokensUsed, 0);
  res.json({ day: aiUsageDay, totalTokens, models, note: "In-memory; resets on server restart. Limits are free-tier TPD (approx)." });
});

router.get("/feed", async (req, res) => {
  const topic = String(req.query["topic"] ?? "top").toLowerCase();
  const refresh = req.query["refresh"] === "1";
  const force = req.query["force"] === "1";

  const cached = cache.get(topic);
  const isFresh = cached && Date.now() - cached.at < ttlFor(topic);

  const respond = (feed: FeedItem[], extra: Record<string, unknown> = {}) => {
    res.json({ feed, ...extra });
  };

  if (force) {
    try {
      const buildTimeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("build timeout")), 12_000),
      );
      const feed = await Promise.race([buildFreshFeed(topic), buildTimeout]);
      if (feed.length > 0) {
        cache.set(topic, { at: Date.now(), data: feed });
        persistFeedCache();
      }
      respond(feed.length > 0 ? feed : (cached?.data ?? []), { cached: false, forced: true });
    } catch {
      if (cached) {
        refreshInBackground(topic, req.log);
        respond(cached.data, { cached: true, stale: true });
      } else {
        res.status(504).json({ error: "Feed refresh timed out, try again" });
      }
    }
    return;
  }

  if (!refresh && isFresh) {
    respond(cached.data, { cached: true });
    return;
  }

  if (cached) {
    refreshInBackground(topic, req.log);
    respond(cached.data, { cached: true, stale: true });
    return;
  }

  let p = inflightFeed.get(topic);
  if (!p) {
    p = buildFreshFeed(topic)
      .then((feed) => {
        cache.set(topic, { at: Date.now(), data: feed });
        return feed;
      })
      .finally(() => {
        inflightFeed.delete(topic);
      });
    inflightFeed.set(topic, p);
  }
  try {
    const feed = await p;
    respond(feed, { cached: false });
  } catch (err) {
    req.log.error({ err }, "feed cold fetch failed");
    res.status(502).json({
      error: err instanceof Error ? err.message : "News provider unavailable",
    });
  }
});

type ContentBlock =
  | { type: "p"; text: string }
  | { type: "img"; src: string; alt?: string };

type ArticleResult = {
  title?: string;
  summaryBullets: string[];
  paragraphs: string[];
  // Raw paragraphs as they came from the publisher's HTML, before any AI
  // dedup pass. Surfaced so the reader's "Original" tab can show the full
  // unedited article.
  originalParagraphs?: string[];
  // Mixed paragraph + image blocks in document order. Web reader renders
  // images inline between paragraphs when present. Falls back to `paragraphs`
  // if absent.
  contentBlocks?: ContentBlock[];
  byline?: string;
  deduped?: boolean;
};

const articleCache = new Map<string, { at: number; data: ArticleResult }>();
const ARTICLE_TTL_MS = 6 * 60 * 60 * 1000;
const ARTICLE_CACHE_MAX_ENTRIES = 300;
const ARTICLE_DISK_CACHE_PATH = "/tmp/particle-news-article-cache.json";
const inflightArticle = new Map<string, Promise<ArticleResult>>();


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

// Walk article HTML in document order and emit a mixed list of paragraph +
// image blocks. Skips tiny tracker pixels, social icons, and ads heuristically.
// Result is capped at IMG_CAP images and BLOCK_CAP total blocks.
function htmlToContentBlocks(rawHtmlChunk: string): ContentBlock[] {
  const IMG_CAP = 5;
  const BLOCK_CAP = 80;
  const BAD_SRC_RE = /pixel|tracking|analytics|sprite|icon|logo|avatar|emoji|share|social|placeholder|spacer|1x1\.|\.gif\?|adsystem|doubleclick/i;
  const PARA_RE = /<(p|li)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  const IMG_RE = /<img\b[^>]*>/gi;
  // Find every <p>, <li>, <img> with its position in the source.
  type Tok = { pos: number; kind: "p" | "img"; raw: string };
  const toks: Tok[] = [];
  let pm: RegExpExecArray | null;
  while ((pm = PARA_RE.exec(rawHtmlChunk)) !== null) toks.push({ pos: pm.index, kind: "p", raw: pm[2] ?? "" });
  let im: RegExpExecArray | null;
  while ((im = IMG_RE.exec(rawHtmlChunk)) !== null) toks.push({ pos: im.index, kind: "img", raw: im[0] });
  toks.sort((a, b) => a.pos - b.pos);

  const BOILERPLATE_RE =
    /^(advertisement|share this|read more|sign up|subscribe|follow us|related stories?|copyright|all rights reserved|terms of (use|service)|privacy policy|cookies?|by .{1,40}$|published .{1,40}$|updated .{1,40}$)/i;

  const blocks: ContentBlock[] = [];
  const seenImgs = new Set<string>();
  let imgCount = 0;
  for (const t of toks) {
    if (blocks.length >= BLOCK_CAP) break;
    if (t.kind === "p") {
      const text = decodeArticleEntities(cleanHtmlFragment(t.raw))
        .replace(/\s+/g, " ")
        .trim();
      if (text.length > 80 && text.split(" ").length > 14 && !BOILERPLATE_RE.test(text)) {
        blocks.push({ type: "p", text });
      }
    } else if (t.kind === "img" && imgCount < IMG_CAP) {
      // Prefer srcset's first candidate (highest-quality often last; just take first)
      // then data-src (lazy-load), then src.
      let src =
        /\s(?:data-srcset|srcset)=["']([^,"' ]+)/i.exec(t.raw)?.[1] ??
        /\s(?:data-src|data-original|data-lazy-src)=["']([^"']+)["']/i.exec(t.raw)?.[1] ??
        /\ssrc=["']([^"']+)["']/i.exec(t.raw)?.[1];
      if (!src) continue;
      // Strip query-string after first space for srcset descriptors.
      src = src.trim();
      if (src.startsWith("//")) src = "https:" + src;
      if (!/^https?:/i.test(src)) continue;
      if (BAD_SRC_RE.test(src)) continue;
      // Try to read width/height attributes — skip if obviously tiny.
      const w = parseInt(/\swidth=["']?(\d+)/i.exec(t.raw)?.[1] ?? "0", 10) || 0;
      const h = parseInt(/\sheight=["']?(\d+)/i.exec(t.raw)?.[1] ?? "0", 10) || 0;
      if (w > 0 && w < 200) continue;
      if (h > 0 && h < 150) continue;
      if (seenImgs.has(src)) continue;
      seenImgs.add(src);
      const alt = /\salt=["']([^"']*)["']/i.exec(t.raw)?.[1]?.trim();
      blocks.push({ type: "img", src, alt: alt || undefined });
      imgCount++;
    }
  }
  return blocks;
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

// Build an AMP URL for publishers known to block datacenter IPs on their main
// site but serve AMP pages via the AMP CDN without IP restrictions.
function toAmpUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (host === "ndtv.com") {
      // NDTV AMP: replace www.ndtv.com with amp.ndtv.com
      u.hostname = "amp.ndtv.com";
      return u.href;
    }
    return null;
  } catch {
    return null;
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
    let contentBlocks = htmlToContentBlocks(bodyHtml);
    if (paragraphs.length === 0) {
      paragraphs = htmlToParagraphs(html);
      if (contentBlocks.length === 0) contentBlocks = htmlToContentBlocks(html);
    }
    if (paragraphs.length > 0 || i === FETCH_USER_AGENTS.length - 1) {
      if (paragraphs.length === 0) {
        const ampUrl = toAmpUrl(url);
        if (ampUrl) {
          try {
            const ampHtml = await fetchHtmlWithUA(ampUrl, FETCH_USER_AGENTS[0]!);
            const { bodyHtml: ampBody, title: ampTitle } = extractArticleBody(ampHtml);
            const ampParas = htmlToParagraphs(ampBody);
            const ampBlocks = htmlToContentBlocks(ampBody);
            if (ampParas.length > 0) return { title: ampTitle ?? title, summaryBullets: [], paragraphs: ampParas, contentBlocks: ampBlocks };
          } catch { /* fall through */ }
        }
      }
      return { title, summaryBullets: [], paragraphs, contentBlocks };
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
        // Apply non-AI cleaning pipeline; fall back to raw on any error.
        try {
          const { paragraphs: cleaned, originalParagraphs } = cleanArticleParagraphs(data.paragraphs);
          data = { ...data, paragraphs: cleaned, originalParagraphs, deduped: true };
        } catch (_) {
          // cleaning failed — serve raw
        }
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

router.get("/article", async (req, res) => {
  const url = String(req.query["url"] ?? "");
  if (!url || !/^https?:\/\//i.test(url)) {
    res.status(400).json({ error: "Invalid url" });
    return;
  }
  try {
    const data = await getOrFetchArticle(url);
    if (!data.paragraphs.length) {
      res.status(502).json({ error: "Couldn't extract article body" });
      return;
    }
    res.json({
      ...data,
      // originalParagraphs is set by the cleaning pipeline; fall back to
      // paragraphs for backwards compat with older cache entries.
      originalParagraphs: data.originalParagraphs ?? data.paragraphs,
      deduped: data.deduped ?? false,
      cached: true,
    });
  } catch (err) {
    req.log.error({ err }, "article extract failed");
    res.status(502).json({
      error: err instanceof Error ? err.message : "Couldn't fetch article",
    });
  }
});

// Lightweight prefetch: warms the article cache without blocking the caller.
router.get("/article/prefetch", (req, res) => {
  const url = String(req.query["url"] ?? "");
  if (!url || !/^https?:\/\//i.test(url)) {
    res.status(400).end();
    return;
  }
  getOrFetchArticle(url).catch(() => {});
  res.status(204).end();
});

// ----- On-demand AI summary -----
// Accepts paragraphs + optional type ("summary" | "fiveWs" | "eli5").
// Cached 24 h per url+type so repeat taps are instant.
type AiSummaryEntry = { at: number; bullets: string[]; summary: string; fiveWs: string[]; eli5: string };
const aiSummaryCache = new Map<string, AiSummaryEntry>();
const AI_SUMMARY_TTL_MS = 24 * 60 * 60 * 1000;

type AiSummaryType = "summary" | "fiveWs" | "eli5";

function aiPrompt(type: AiSummaryType, text: string): { prompt: string; maxTokens: number } {
  switch (type) {
    case "fiveWs":
      return {
        maxTokens: 1100,
        prompt: `Analyze this news article. Return ONLY valid JSON (no markdown, no prose, no code fences) with exactly 5 entries:
{"fiveWs":["WHO: ...","WHAT: ...","WHEN: ...","WHERE: ...","WHY: ..."]}

Rules:
- Exactly 5 entries in this order: WHO, WHAT, WHEN, WHERE, WHY.
- Each entry MUST start with its label followed by ": ".
- Each entry is one continuous block of text — NO line breaks inside any entry.
- TOTAL across all 5 entries ~300 words (range 280-340). Distribute as the story demands; WHAT and WHY usually carry the most.
- Be specific: named parties, exact figures, dates, places. No filler.
- Neutral tone. No bullets, no markdown inside the strings.

Article: ${text}`,
      };
    case "eli5":
      return {
        maxTokens: 300,
        prompt: `Explain this news article simply, like to a 10-year-old. Return ONLY valid JSON:
{"eli5":"<explanation in 80-100 words, simple language, no jargon, conversational tone>"}
Article: ${text}`,
      };
    default:
      return {
        maxTokens: 1100,
        prompt: `Summarize this news article thoroughly. Return ONLY valid JSON:
{"bullets":["bullet 1","bullet 2","bullet 3","..."],"summary":""}
Rules:
- TOTAL across all bullets ~300 words (range 250-350). This is the only hard target.
- Number of bullets is YOUR call — choose what fits the story:
  * Breaking / fast-moving / single-event story → fewer, punchier bullets (~4-5, ~60 words each).
  * Complex / multi-thread / political / analysis story → more bullets (~7-10, ~30-40 words each).
  * One bullet = one distinct fact, angle, or development. Don't pad.
- Neutral tone. Cover all key facts: who, what, when, where, named parties, figures, timeline, context, reactions, stakes.
- Leave "summary" as an empty string — bullets carry everything.
Article: ${text}`,
      };
  }
}

// ----- AI cluster labels (stale-while-revalidate, 30-min TTL) -----
// Accepts a flat list of story headlines from the client, returns AI-generated
// topic group labels. The server caches by topic + content fingerprint so
// repeated requests within the TTL window are instant.

async function runLabelClustering(
  cacheKey: string,
  fingerprint: string,
  topic: string,
  texts: string[],
): Promise<{ label: string; indices: number[] }[]> {
  const limited = texts.slice(0, 30);
  const headlineList = limited.map((t, i) => `${i}: ${t}`).join('\n');

  const prompt = `You are a senior news editor. Group these ${topic} headlines into clusters and write SHARP, JOURNALISTIC labels.

${headlineList}

GROUPING RULES (strict):
- Cluster only stories about the SAME UNDERLYING EVENT or the SAME ONGOING SITUATION involving the same primary entity.
- Same broad theme is NOT enough (e.g. "tech", "politics"). It must be the same event/entity.
- Examples of SAME cluster: 3 outlets covering today's Fed rate decision; multiple stories on the iPhone 17 launch event.
- Examples of DIFFERENT clusters: Fed rate decision vs general inflation explainer; iPhone 17 launch vs Apple Vision Pro update.
- Each headline number appears in exactly one group.
- 3-7 groups maximum.
- Singletons → "Other".

LABEL STYLE — like a magazine section title:
- 3-6 words, Title Case.
- Lead with the named entity/place ("Iran-Israel Strikes", "Modi Cabinet Reshuffle", "Apple iPhone 17 Launch", "Tesla Q3 Earnings", "OpenAI Sora 2 Release").
- Capture the ANGLE, not just the topic: "Fed Holds Rates Amid Inflation" beats "Federal Reserve".
- No vague labels: avoid "Politics", "Tech", "Updates", "News". No emoji. No clickbait.
- "Other" only for unrelated singletons.

Return JSON only:
{"groups":[{"label":"<sharp label>","indices":[0,1,4]},{"label":"Other","indices":[2,3]}]}`;
  const text = await callGroq(prompt, 600, { model: GROQ_MODEL_FAST, task: "cluster-labels" });
  const raw = text.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(raw) as { groups?: { label: string; indices: number[] }[] };
  if (!Array.isArray(parsed?.groups)) throw new Error('bad AI response');

  const result = parsed.groups;
  globalClusterCache.set(cacheKey, { clusters: result, fingerprint, ts: Date.now() });
  return result;
}

let labelClusteringInProgress = false;

router.post("/cluster-labels", async (req, res) => {
  const { topic = 'breaking', headlines } = req.body as {
    topic?: string;
    headlines?: { id: string; text: string }[];
  };

  if (!Array.isArray(headlines) || headlines.length < 3) {
    res.json({ groups: [], cached: false });
    return;
  }

  const fingerprint = headlines.slice(0, 20).map(h => h.text.slice(0, 20)).join('|');
  const cacheKey = `labels_${topic}`;
  const cached = globalClusterCache.get(cacheKey);

  const mapResult = (clusters: { label: string; indices: number[] }[]) =>
    clusters
      .filter(g => g.label.toLowerCase() !== 'other')
      .map(g => ({
        label: g.label,
        ids: g.indices.filter(i => i < headlines.length).map(i => headlines[i]!.id),
      }));

  if (cached && cached.fingerprint === fingerprint) {
    if (Date.now() - cached.ts < CLUSTER_TTL) {
      res.json({ groups: mapResult(cached.clusters), cached: true });
      return;
    }
    // Stale but same content: return immediately, refresh in background
    if (!labelClusteringInProgress) {
      labelClusteringInProgress = true;
      runLabelClustering(cacheKey, fingerprint, topic, headlines.map(h => h.text))
        .finally(() => { labelClusteringInProgress = false; });
    }
    res.json({ groups: mapResult(cached.clusters), cached: true, stale: true });
    return;
  }

  // Content changed or no cache: wait for fresh AI grouping
  try {
    const groups = await runLabelClustering(cacheKey, fingerprint, topic, headlines.map(h => h.text));
    res.json({ groups: mapResult(groups), cached: false });
  } catch (err) {
    req.log.warn({ err }, 'cluster-labels failed');
    res.json({ groups: [], cached: false, error: true });
  }
});

router.post("/ai-summary", async (req, res) => {
  const { url, paragraphs, type = "summary" } = req.body as {
    url?: string;
    paragraphs?: string[];
    type?: AiSummaryType;
  };
  if (!url || !Array.isArray(paragraphs) || paragraphs.length === 0) {
    res.status(400).json({ error: "url and paragraphs required" });
    return;
  }

  const cacheKey = `${url}:${type}`;
  const hashKey = createHash("md5").update(cacheKey).digest("hex");
  const diskPath = `/tmp/ai-summary-${hashKey}.json`;

  // Check in-memory cache
  const cached = aiSummaryCache.get(cacheKey);
  if (cached && Date.now() - cached.at < AI_SUMMARY_TTL_MS) {
    res.json({ ...cached, cached: true });
    return;
  }

  // Check disk cache
  const diskCached = safeReadJson<AiSummaryEntry>(diskPath);
  if (diskCached && Date.now() - diskCached.at < AI_SUMMARY_TTL_MS) {
    aiSummaryCache.set(cacheKey, diskCached);
    res.json({ ...diskCached, cached: true });
    return;
  }

  if (!process.env["GROQ_API_KEY"]) {
    res.status(502).json({ error: "AI not configured" });
    return;
  }

  try {
    const text = paragraphs.slice(0, 20).join(" ").slice(0, 2500);
    const { prompt, maxTokens } = aiPrompt(type as AiSummaryType, text);
    const raw = (await callGroq(prompt, maxTokens, { model: GROQ_MODEL_FAST, task: "article-summary" })) || "{}";

    let parsed: { bullets?: string[]; summary?: string; fiveWs?: string[]; eli5?: string } = {};
    const cleaned = raw.replace(/```json|```/g, "").trim();
    try { parsed = JSON.parse(cleaned); }
    catch {
      // Forgiving recovery: extract the largest {...} block and escape stray
      // raw newlines inside string values so a model quirk never blanks output.
      try {
        const m = cleaned.match(/\{[\s\S]*\}/);
        if (m) {
          const safe = m[0].replace(/("(?:[^"\\]|\\.)*")|(\r?\n)/g, (full, str) => str ? str : "\\n");
          parsed = JSON.parse(safe);
        }
      } catch { /* give up */ }
    }

    const result: AiSummaryEntry = {
      at: Date.now(),
      bullets: Array.isArray(parsed.bullets) ? parsed.bullets.slice(0, 12) : [],
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      fiveWs: Array.isArray(parsed.fiveWs) ? parsed.fiveWs.slice(0, 5) : [],
      eli5: typeof parsed.eli5 === "string" ? parsed.eli5 : "",
    };

    aiSummaryCache.set(cacheKey, result);
    safeWriteJson(diskPath, result);

    res.json({ ...result, cached: false });
  } catch (err) {
    req.log.error({ err }, "ai-summary failed");
    res.status(502).json({ error: "AI summary unavailable" });
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

// ── AI Deep Dive — one-shot structured story understanding ─────────────────
// POST /api/news/deepdive
// Body: { url, headline, paragraphs }
// Returns: { tldr[], narrative, insight, questions[], tags[] } — all in ONE
// Claude call. Cached aggressively (memory + disk) to keep cost down.
interface TldrSection { heading: string; bullets: string[]; }
interface StorySection { heading: string; body: string; }
interface DeepDiveResult {
  at: number;
  tldr: string[];
  tldrSections: TldrSection[];
  narrative: string;
  storySections: StorySection[];
  insight: string;
  questions: string[];
  tags: string[];
  keyPeople: string[];
  keyCompanies: string[];
  topics: string[];
}
const deepDiveCache = new Map<string, DeepDiveResult>();
const DEEPDIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

router.post("/deepdive", async (req, res) => {
  const { url, headline, paragraphs } = req.body as {
    url?: string;
    headline?: string;
    paragraphs?: string[];
  };
  if (!url || !Array.isArray(paragraphs) || paragraphs.length === 0) {
    res.status(400).json({ error: "url and paragraphs required" });
    return;
  }

  const cacheKey = `deepdive:v4:${url}`; // v4 — TL;DR cap raised to 450 words
  const hashKey = createHash("md5").update(cacheKey).digest("hex");
  const diskPath = `/tmp/deepdive-${hashKey}.json`;

  const cached = deepDiveCache.get(cacheKey);
  if (cached && Date.now() - cached.at < DEEPDIVE_TTL_MS) {
    res.json({ ...cached, cached: true });
    return;
  }
  const diskCached = safeReadJson<DeepDiveResult>(diskPath);
  if (diskCached && Date.now() - diskCached.at < DEEPDIVE_TTL_MS) {
    deepDiveCache.set(cacheKey, diskCached);
    res.json({ ...diskCached, cached: true });
    return;
  }

  if (!process.env["GROQ_API_KEY"]) { res.status(502).json({ error: "AI not configured" }); return; }

  try {
    const text = paragraphs.slice(0, 40).join("\n").slice(0, 6000);
    const prompt = `You are transforming raw news coverage (multiple source excerpts, each tagged like "[Source Name]:") into a structured, AI-native "story understanding" experience. Read ALL excerpts and respond with ONLY valid JSON (no markdown, no prose) matching this exact shape:

{
  "tldrSections": [                                    // 2-3 grouped sections. Each section: SHORT all-caps thematic heading (4-8 words) + EXACTLY 3-4 bullets. Each bullet is 1-2 COMPLETE sentences (~30-45 words) — a self-contained, well-summarised thought that ALWAYS ends with proper punctuation; NEVER a sentence fragment and NEVER cut off mid-sentence. TOTAL words across ALL sections+bullets should be ~400-450 words (hard cap 450 — be thorough but don't pad). First section = the core event. Second = context / reactions / why it matters. Optional third = stakes / what's next. Bold key entities + figures inline with ** (e.g. "**Pakistan** signed a **$1.2M** deal").
    { "heading": "CORE EVENT", "bullets": ["complete 1-2 sentence summary.", "complete 1-2 sentence summary.", "complete 1-2 sentence summary."] },
    { "heading": "CONTEXT & WHY IT MATTERS", "bullets": ["complete 1-2 sentence summary.", "complete 1-2 sentence summary.", "complete 1-2 sentence summary."] }
  ],
  "tldr": ["flat fallback — 6-10 complete-sentence bullets, same ~400-450 word cap"],
  "storySections": [                                   // THE FULL STORY, broken into 4-6 LABELLED sections. TOTAL 450-800 words across all sections (hard minimum 400 — never less). Each "body" is 1-3 paragraphs of plain prose, paragraphs separated by literal "\\n\\n" (two-char escape, NOT raw newlines). Synthesise facts from EVERY source excerpt, not just the first. Attribute specific facts/figures/quotes to their source INLINE in parentheses using the [Source] tags, e.g. "...effective May 1, 2026 (Times of India)." Use 3+ distinct source attributions where available. No markdown, no repetition, no filler.
    // Choose the sections that FIT this story from this menu (always include the first two; add others when the material supports them). Use these exact ALL-CAPS headings:
    //   "WHAT HAPPENED"      — the core event, who/what/when/where. (required)
    //   "THE CONTEXT"        — background, how we got here, prior events. (required)
    //   "WHY IT MATTERS"     — significance, stakes, who is affected and how.
    //   "REACTIONS"          — responses from key parties, officials, markets, critics.
    //   "WHAT'S NEXT"        — likely next steps, timeline, future impact, things to watch.
    { "heading": "WHAT HAPPENED", "body": "para1\\n\\npara2" },
    { "heading": "THE CONTEXT", "body": "para1" },
    { "heading": "WHY IT MATTERS", "body": "para1" },
    { "heading": "WHAT'S NEXT", "body": "para1" }
  ],
  "insight": "...",                                    // ONE sharp takeaway sentence: why this matters or what to watch. Max 32 words.
  "questions": ["...", "...", "...", "..."],           // 3-4 conversational follow-up questions a curious reader would ask. Mix article-specific and broader context questions. Each ends with "?"
  "tags": ["...", "...", "..."],                       // 4-7 short noun-phrase entity/topic tags (e.g. "Federal Reserve", "Interest Rates", "Inflation"). Use exact names that appear in the text.
  "keyPeople": ["..."],                                // named individuals mentioned (full names). May be empty if none.
  "keyCompanies": ["..."],                             // organisations, companies, agencies, political parties. May be empty.
  "topics": ["..."]                                    // broader topics / themes (e.g. "Monetary Policy", "AI Safety"). 3-6 items.
}

Headline: ${headline ?? "(no headline)"}

Article:
${text}

Respond with JSON only.`;

    // Retry once on transient network failure.
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 90000);
    let raw = "";
    try {
      try {
        raw = await callGroq(prompt, 6000, { signal: ctrl.signal, task: "deepdive" });
      } catch (firstErr) {
        req.log.warn({ err: firstErr instanceof Error ? firstErr.message : String(firstErr) }, "deepdive: groq fetch failed, retrying once");
        await new Promise(r => setTimeout(r, 800));
        raw = await callGroq(prompt, 6000, { signal: ctrl.signal, task: "deepdive" });
      }
    } finally {
      clearTimeout(t);
    }
    if (!raw) raw = "{}";

    // Forgiving JSON parse — strip code fences, extract first {...} block,
    // and escape any raw newlines that slipped inside string values.
    let parsed: Partial<DeepDiveResult> = {};
    const cleaned = raw.replace(/```json|```/g, "").trim();
    try { parsed = JSON.parse(cleaned); }
    catch {
      try {
        const m = cleaned.match(/\{[\s\S]*\}/);
        if (m) {
          const safe = m[0].replace(/("(?:[^"\\]|\\.)*")|(\r?\n)/g, (full, str) => str ? str : "\\n");
          parsed = JSON.parse(safe);
        }
      } catch { /* give up */ }
    }

    // Parse tldrSections — sanitize each entry, then fall back to flat tldr if AI skipped sections.
    const rawSections = Array.isArray((parsed as { tldrSections?: unknown }).tldrSections)
      ? ((parsed as { tldrSections: unknown[] }).tldrSections)
      : [];
    const tldrSections: TldrSection[] = rawSections
      .map((s) => {
        const obj = s as { heading?: unknown; bullets?: unknown };
        return {
          heading: typeof obj?.heading === "string" ? obj.heading.slice(0, 120) : "",
          bullets: Array.isArray(obj?.bullets) ? obj.bullets.slice(0, 12).map(String) : [],
        };
      })
      .filter((s) => s.heading && s.bullets.length > 0)
      .slice(0, 4);

    const flatTldr = Array.isArray(parsed.tldr) && parsed.tldr.length > 0
      ? parsed.tldr.slice(0, 18).map(String)
      : tldrSections.flatMap((s) => s.bullets).slice(0, 18);

    // Parse the labelled full-story sections.
    const rawStory = Array.isArray((parsed as { storySections?: unknown }).storySections)
      ? ((parsed as { storySections: unknown[] }).storySections)
      : [];
    const storySections: StorySection[] = rawStory
      .map((s) => {
        const obj = s as { heading?: unknown; body?: unknown };
        return {
          heading: typeof obj?.heading === "string" ? obj.heading.slice(0, 80) : "",
          body: typeof obj?.body === "string" ? obj.body : "",
        };
      })
      .filter((s) => s.heading && s.body.trim())
      .slice(0, 6);

    // Back-compat narrative: prefer the model's narrative if it sent one,
    // otherwise stitch the section bodies into one string so older clients
    // (and the existing APK) still render a full story.
    const narrative = typeof parsed.narrative === "string" && parsed.narrative.trim()
      ? parsed.narrative
      : storySections.map((s) => s.body).join("\n\n");

    const result: DeepDiveResult = {
      at: Date.now(),
      tldr: flatTldr,
      tldrSections,
      narrative,
      storySections,
      insight: typeof parsed.insight === "string" ? parsed.insight : "",
      questions: Array.isArray(parsed.questions) ? parsed.questions.slice(0, 5).map(String) : [],
      tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 8).map(String) : [],
      keyPeople: Array.isArray(parsed.keyPeople) ? parsed.keyPeople.slice(0, 12).map(String) : [],
      keyCompanies: Array.isArray(parsed.keyCompanies) ? parsed.keyCompanies.slice(0, 10).map(String) : [],
      topics: Array.isArray(parsed.topics) ? parsed.topics.slice(0, 8).map(String) : [],
    };

    // Return whatever we got — even partial data is useful. Only fail on total emptiness.
    if (!result.tldr.length && !result.narrative && !result.insight && !result.questions.length) {
      req.log.error({ raw: raw.slice(0, 500) }, "deepdive: empty parse");
      res.status(502).json({ error: "AI returned no parseable content", raw: raw.slice(0, 200) });
      return;
    }

    deepDiveCache.set(cacheKey, result);
    safeWriteJson(diskPath, result);
    res.json({ ...result, cached: false });
  } catch (err) {
    req.log.error({ err: err instanceof Error ? err.message : String(err) }, "deepdive failed");
    res.status(502).json({ error: "Deep Dive unavailable", detail: err instanceof Error ? err.message : String(err) });
  }
});

// ── Follow-up Q&A — answer a question about a story ────────────────────────
// POST /api/news/ask
// Body: { question, headline, summary?, narrative? }
// Returns: { answer }
interface AskCacheEntry { at: number; answer: string; }
const askCache = new Map<string, AskCacheEntry>();
const ASK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

router.post("/ask", async (req, res) => {
  const { question, headline, summary, narrative } = req.body as {
    question?: string;
    headline?: string;
    summary?: string;
    narrative?: string;
  };
  if (!question || !headline) {
    res.status(400).json({ error: "question and headline required" });
    return;
  }

  const cacheKey = createHash("md5").update(`${headline}::${question}`).digest("hex");
  const diskPath = `/tmp/ask-${cacheKey}.json`;

  const cached = askCache.get(cacheKey);
  if (cached && Date.now() - cached.at < ASK_TTL_MS) {
    res.json({ answer: cached.answer, cached: true });
    return;
  }
  const diskCached = safeReadJson<AskCacheEntry>(diskPath);
  if (diskCached && Date.now() - diskCached.at < ASK_TTL_MS) {
    askCache.set(cacheKey, diskCached);
    res.json({ answer: diskCached.answer, cached: true });
    return;
  }

  if (!process.env["GROQ_API_KEY"]) { res.status(502).json({ error: "AI not configured" }); return; }

  const context = [headline, summary, narrative].filter(Boolean).join("\n\n").slice(0, 2500);
  const prompt = `You are a knowledgeable, friendly assistant answering a curious reader's follow-up question. Use the story context below as your primary source, and combine it with your own general knowledge to give a complete, useful answer.

Rules:
- Lead with what's known from the story.
- If you draw on general knowledge for background, context, or historical comparisons, add it naturally — don't refuse or hedge needlessly.
- If the question is broader than the story (e.g. "what happens next?", "how does this compare historically?"), use general knowledge to answer thoughtfully.
- If you genuinely don't know something specific, say so briefly, then offer the closest useful context.
- Never invent specific facts (names, dates, numbers) that aren't in the story or well-established public knowledge.

STORY CONTEXT:
${context}

QUESTION: ${question}

Answer in 3-5 sentences, ~120 words max. Plain text, no markdown. Conversational but precise.`;

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 60000);
    let answer = "";
    try {
      try { answer = (await callGroq(prompt, 600, { signal: ctrl.signal, temperature: 0.5, model: GROQ_MODEL_FAST, task: "qna" })).trim(); }
      catch { await new Promise(r => setTimeout(r, 600)); answer = (await callGroq(prompt, 600, { signal: ctrl.signal, temperature: 0.5, model: GROQ_MODEL_FAST, task: "qna" })).trim(); }
    } finally { clearTimeout(t); }
    if (!answer) throw new Error("Empty answer");

    const entry: AskCacheEntry = { at: Date.now(), answer };
    askCache.set(cacheKey, entry);
    safeWriteJson(diskPath, entry);
    res.json({ answer, cached: false });
  } catch (err) {
    req.log.error({ err: err instanceof Error ? err.message : String(err) }, "ask failed");
    res.status(502).json({ error: "Q&A unavailable", detail: err instanceof Error ? err.message : String(err) });
  }
});

// ── Usage / cost proxy ──────────────────────────────────────────────────────
// GET /api/news/usage?range=mtd|7d|30d
// Hits the api-usage-dashboard internal /api/usage (with shared LOG_SECRET) and
// returns a sanitized summary safe to expose to clients. Never leaks the token.
router.get("/usage", async (req, res) => {
  const url = process.env["USAGE_DASHBOARD_URL"];
  const token = process.env["USAGE_DASHBOARD_TOKEN"];
  if (!url || !token) {
    return res.status(503).json({ error: "Usage dashboard not configured" });
  }

  const range = String(req.query.range ?? "mtd").toLowerCase();
  const today = new Date();
  let start = new Date(today);
  let end = new Date(today);
  if (range === "7d") {
    start.setUTCDate(today.getUTCDate() - 6);
  } else if (range === "30d") {
    start.setUTCDate(today.getUTCDate() - 29);
  } else {
    // "mtd" — first of this month
    start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  }
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  try {
    const u = `${url.replace(/\/$/, "")}/api/usage?start=${iso(start)}&end=${iso(end)}`;
    const upstream = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
    if (!upstream.ok) return res.status(502).json({ error: `Dashboard ${upstream.status}` });
    const data = (await upstream.json()) as {
      range: { start: string; end: string };
      days: Array<{ day: string; total: { cost: number; calls: number; inputTokens: number; outputTokens: number } }>;
      totals: { cost: number; calls: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreateTokens: number };
      byModel: Record<string, { cost: number; calls: number }>;
      byFeature: Record<string, { cost: number; calls: number }>;
      byApp: Record<string, { cost: number; calls: number }>;
    };

    res.setHeader("Cache-Control", "public, max-age=300"); // 5 min CDN cache
    res.json({
      range: { ...data.range, key: range },
      totals: data.totals,
      days: data.days.map(d => ({ day: d.day, cost: d.total?.cost ?? 0, calls: d.total?.calls ?? 0 })),
      byModel: data.byModel,
      byFeature: data.byFeature,
      byApp: data.byApp,
    });
  } catch (err) {
    req.log?.warn({ err }, "usage proxy failed");
    res.status(502).json({ error: "Usage proxy failed" });
  }
});

export default router;
