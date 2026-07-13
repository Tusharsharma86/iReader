import { Router, type IRouter } from "express";
import { XMLParser } from "fast-xml-parser";
//import { ai } from "@workspace/integrations-gemini-ai";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { cleanArticleParagraphs, deduplicateCrossArticle } from "../lib/articleCleaner";
import { getNotifHistoryForToken, getMutedThemesForToken, setMutedThemesForToken } from "../lib/push-sender";

const router: IRouter = Router();

// ── AI inference providers ──────────────────────────────────────────────────
// Groq (LPU) primary for everything. Cerebras optional boost when available.
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const CEREBRAS_URL = "https://api.cerebras.ai/v1/chat/completions";
const GROQ_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct"; // Deep Dive primary
const GROQ_MODEL_FAST = "openai/gpt-oss-20b"; // background bulk + article summaries
const GROQ_MODEL_QUALITY = "openai/gpt-oss-20b"; // Q&A
const GROQ_MODEL_ENRICH = "openai/gpt-oss-20b"; // cluster headlines + themes
const CEREBRAS_MODEL = "gpt-oss-120b"; // ~3000 tok/s, free tier
// Global rate gate for BACKGROUND enrichment calls (clustering, cluster-enrich,
// card summaries, theme discovery). A feed build fires ~25 of these at once,
// which blows Groq's free-tier RPM/TPM and 429s most of them. Serialising them
// ~every 4.5s (~13/min) keeps the burst under the cap; they're fire-and-forget
// + cached, so spreading them over a minute is invisible. User-facing calls
// (Deep Dive, Q&A) pass `background:false` and skip the gate for low latency.
let groqNextSlot = 0;
const GROQ_BG_INTERVAL_MS = 4500;
function groqBgGate(): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, groqNextSlot);
  groqNextSlot = at + GROQ_BG_INTERVAL_MS;
  const wait = at - now;
  return wait > 0 ? new Promise((r) => setTimeout(r, wait)) : Promise.resolve();
}

// Same idea as groqBgGate but for the user-facing Deep Dive call specifically.
// Deep Dive used to skip any gate entirely ("low volume, user-initiated"), but
// with client-side prewarming (top-N cards on AI Feed mount) plus real opens
// from multiple users, concurrent deepdive calls burst well past Groq's
// free-tier RPM and 429 almost everything (observed: 46/47 failed in one
// day, scout model, despite only 4% of its daily token budget used — this is
// real-time rate limiting, not quota exhaustion). 3s spacing keeps it under
// ~20/min, still far more responsive than the 4.5s background gate since this
// is what the user is actively waiting on.
let deepDiveNextSlot = 0;
let scoutPausedUntil = 0;
const DEEPDIVE_GATE_INTERVAL_MS = 3000;
function deepDiveGate(): Promise<void> {
  const now = Date.now();
  if (now < scoutPausedUntil) return Promise.reject(new Error("rate-gate-paused"));
  const at = Math.max(now, deepDiveNextSlot);
  deepDiveNextSlot = at + DEEPDIVE_GATE_INTERVAL_MS;
  const wait = at - now;
  return wait > 0 ? new Promise((r) => setTimeout(r, wait)) : Promise.resolve();
}
function pauseScoutModel() { scoutPausedUntil = Date.now() + 65_000; }

// Unified gate for ALL 8b calls (background + foreground). 8b has 30 RPM on
// Groq free tier. 2.2s spacing = ~27 RPM, under the limit. On 429, pause ALL
// 8b calls for 65s so Groq's sliding window fully resets before we resume.
let model8bNextSlot = 0;
let model8bPausedUntil = 0;
const MODEL_8B_GATE_MS = 2200;
function model8bGate(): Promise<void> {
  const now = Date.now();
  if (now < model8bPausedUntil) {
    return Promise.reject(new Error("rate-gate-paused"));
  }
  const at = Math.max(now, model8bNextSlot);
  model8bNextSlot = at + MODEL_8B_GATE_MS;
  const wait = at - now;
  return wait > 0 ? new Promise((r) => setTimeout(r, wait)) : Promise.resolve();
}
function pause8bModel() { model8bPausedUntil = Date.now() + 65_000; }

// ── Cerebras inference (article summaries) ──────────────────────────────────
// Free tier is ~30 RPM. Background calls (feed card summaries) are serialized
// at 2.5s spacing so a feed build's ~25-call burst can't starve user-facing
// summaries/Deep Dives. A 429 pauses ALL Cerebras calls 30s so the window
// resets; callers fail fast to their Groq fallback instead of queueing.
let cerebrasBgNextSlot = 0;
const CEREBRAS_BG_INTERVAL_MS = 2500;
function cerebrasBgGate(): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, cerebrasBgNextSlot);
  cerebrasBgNextSlot = at + CEREBRAS_BG_INTERVAL_MS;
  const wait = at - now;
  return wait > 0 ? new Promise((r) => setTimeout(r, wait)) : Promise.resolve();
}
let cerebrasPausedUntil = 0;
function pauseCerebras() { cerebrasPausedUntil = Date.now() + 30_000; }

async function callCerebras(
  prompt: string,
  maxTokens: number,
  opts: { temperature?: number; task?: string; jsonMode?: boolean; model?: string; signal?: AbortSignal; background?: boolean } = {},
): Promise<string> {
  const key = process.env["CEREBRAS_API_KEY"];
  if (!key) throw new Error("CEREBRAS_API_KEY missing");
  if (Date.now() < cerebrasPausedUntil) throw new Error("cerebras-paused");
  if (opts.background) await cerebrasBgGate();
  const model = opts.model ?? CEREBRAS_MODEL;
  const task = opts.task ?? "other";
  // gpt-oss-120b is a reasoning model: its chain-of-thought consumes
  // max_tokens BEFORE the visible answer. Keep effort low and give the
  // budget generous headroom or small calls return empty content.
  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens + 2000,
    temperature: opts.temperature ?? 0.3,
    reasoning_effort: "low",
    messages: [{ role: "user", content: prompt }],
  };
  if (opts.jsonMode) body["response_format"] = { type: "json_object" };
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(CEREBRAS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (r.ok) {
      const data = (await r.json()) as {
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
        usage?: { total_tokens?: number };
      };
      const content = data.choices?.[0]?.message?.content ?? "";
      if (!content.trim()) {
        recordAiUsage(model, task, data.usage?.total_tokens ?? 0, false);
        throw new Error(`Cerebras empty content: ${JSON.stringify(data.choices?.[0]).slice(0, 300)}`);
      }
      recordAiUsage(model, task, data.usage?.total_tokens ?? 0, true);
      return content;
    }
    const retryable = r.status === 502 || r.status === 503;
    if (retryable && attempt < 1) {
      await new Promise((res) => setTimeout(res, 2000));
      continue;
    }
    recordAiUsage(model, task, 0, false);
    if (r.status === 429) pauseCerebras();
    throw new Error(`Cerebras ${r.status}`);
  }
}

async function callGroq(
  prompt: string,
  maxTokens: number,
  opts: { temperature?: number; signal?: AbortSignal; model?: string; task?: string; background?: boolean; jsonMode?: boolean } = {},
): Promise<string> {
  const key = process.env["GROQ_API_KEY"];
  if (!key) throw new Error("GROQ_API_KEY missing");
  const model = opts.model ?? GROQ_MODEL;
  const task = opts.task ?? "other";
  if (model === GROQ_MODEL_FAST || model === GROQ_MODEL_ENRICH || model === GROQ_MODEL_QUALITY) await model8bGate();
  else if (model === GROQ_MODEL && Date.now() < scoutPausedUntil) throw new Error("rate-gate-paused");
  else if (opts.background) await groqBgGate();
  for (let attempt = 0; ; attempt++) {
    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      temperature: opts.temperature ?? 0.3,
      messages: [{ role: "user", content: prompt }],
    };
    // Groq supports OpenAI-compatible JSON mode — guarantees the model emits
    // a syntactically valid JSON object (or it errors at the API level).
    if (opts.jsonMode) body["response_format"] = { type: "json_object" };
    const r = await fetch(GROQ_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (r.ok) {
      const data = (await r.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { total_tokens?: number };
      };
      recordAiUsage(model, task, data.usage?.total_tokens ?? 0, true);
      const content = data.choices?.[0]?.message?.content ?? "";
      return content;
    }
    // Only retry on transient server errors (502/503), NOT on 429 — retrying
    // rate-limits multiplies the RPM pressure and makes the window worse.
    // The per-model gate prevents 429s; if one still happens, fail fast.
    const retryable = r.status === 502 || r.status === 503;
    if (retryable && attempt < 1) {
      await new Promise((res) => setTimeout(res, 3000));
      continue;
    }
    recordAiUsage(model, task, 0, false);
    if (r.status === 429) {
      if (model === GROQ_MODEL_FAST || model === GROQ_MODEL_ENRICH || model === GROQ_MODEL_QUALITY) pause8bModel();
      else if (model === GROQ_MODEL) pauseScoutModel();
    }
    throw new Error(`Groq ${r.status}`);
  }
}

// ── Per-model / per-task AI usage tracker (for the in-app dashboard) ─────────
// Sums real tokens (prompt+completion) Groq reports, grouped by model and task,
// per UTC day. In-memory (resets on container cold start) — best-effort gauge.
const GROQ_TPD_LIMITS: Record<string, number> = {
  "meta-llama/llama-4-scout-17b-16e-instruct": 500000,
  "openai/gpt-oss-20b": 500000,
  "llama-4-scout-17b-16e-instruct": 1000000,
  "llama3.1-8b": 1000000,
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
// ── Keep-alive self-ping ─────────────────────────────────────────────────────
// Render free tier spins the container down after ~15 min without inbound
// traffic; the next visitor then eats a 30-60s cold start. Pinging our own
// public URL every 10 min counts as inbound and keeps the instance warm.
// 750 free instance-hours/month covers one service running 24/7.
const SELF_PING_URL = process.env["RENDER_EXTERNAL_URL"]
  ? `${process.env["RENDER_EXTERNAL_URL"]}/api/news/ai-usage`
  : "https://ireader.onrender.com/api/news/ai-usage";
if (process.env["NODE_ENV"] === "production") {
  setInterval(() => { fetch(SELF_PING_URL).catch(() => {}); }, 10 * 60 * 1000).unref();
}

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
  collection?: boolean; // true = theme collection (different stories, same subject), not a same-event cluster
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
  { id: "wired",        name: "Wired",             url: "https://www.wired.com/feed/rss" },
  { id: "9to5google",   name: "9to5Google",        url: "https://9to5google.com/feed/" },
  { id: "9to5mac",      name: "9to5Mac",           url: "https://9to5mac.com/feed/" },
  { id: "engadget",     name: "Engadget",          url: "https://www.engadget.com/rss.xml" },
  { id: "venturebeat",  name: "VentureBeat",       url: "https://venturebeat.com/feed/" },
  { id: "thenextweb",   name: "The Next Web",      url: "https://thenextweb.com/feed/" },
  { id: "hackernews",   name: "Hacker News",       url: "https://hnrss.org/frontpage" },
  // IE direct URLs → 403 from Render IPs; FeedBurner proxy works (IE Tech section, 200 items)
  { id: "ie-tech",      name: "Indian Express",    url: "https://feeds.feedburner.com/indianexpress" },
  // Financial Express RSS feeds are dead (410 / returns HTML) — removed
];

// Topic-specific Indian source lists
// IE / News18 / Firstpost / MoneyControl all return HTTP 403 from Render's
// datacenter IP range. IE only works via FeedBurner proxy (Tech section only).
const INDIA_POLITICS_RSS_SOURCES: RssSource[] = [
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

const SPORTS_ENTERTAINMENT_RE = /\b(cricket|ipl|bcci|test match|odi|t20i?|football|soccer|premier league|la liga|bundesliga|serie a|ligue 1|nfl|nba|mlb|nhl|fifa|tennis|wimbledon|formula[- ]1|f1 race|chess|olympics|hockey|badminton|icc|world cup final|match report|match preview|scorecard|squad announced|batting|bowling|wicket|wickets|run chase|innings|half.?time|full.?time|penalty kick|goal scored|transfer window|player transfer|fantasy cricket|dream11|my11circle|rohit sharma|virat kohli|ms dhoni|bollywood|hindi film|tollywood|kollywood|mollywood|south film|telugu film|tamil film|movie release|film release|first look|box office|box office collection|trailer launch|song launch|music video|item song|oscar|grammy|award show|web series|ott platform|album launch|concert tour|celebrity gossip|dating|gossip|entertainment news|celebrity|actor|actress|sports score|match score|celebrity wedding|star spotted|promo codes?|discount codes?|coupon codes?|cashback|voucher|referral codes?|offer codes?|redeem codes?|flash sale|best deals?|top deals?|exclusive deals?|\d+%\s*off|save \d+%|get \d+% off|limited.{0,10}offer|today.{0,10}deals?|affiliate|phone price|smartphone price|price drops?|price cut|price hike|price reveal|lowest price|best price|now available|available for rs|available under rs|available at rs|launched at|starts at rs|starts at \$|goes on sale|gets a price|exchange offer|upcoming phone|specifications|specs leak|hands.?on review|camera test|benchmark|unboxing|vs comparison|best phone|budget phone|flagship phone|iphone \d+ price|iphone (air|pro|plus|max|mini).{0,30}(price|available|discount|deal|rs\b|flipkart|amazon)|watch price|earbuds price|laptop deal|tablet deal|gadget deal|record low price|all.?time low|price history|discount on flipkart|discount on amazon|flipkart sale|amazon sale|9to5mac daily|9to5google daily|newsletter)\b/i;

// Low-priority breaking content: phone prices, gadget deals, specs leaks, routine sports/entertainment
const BREAKING_LOWPRIORITY_RE = /\b(phone price|smartphone price|budget phone|feature phone|price drops?|price cut|price hike|price reveal|price history|lowest price|lowest ever price|best price|now available|available for rs|available under rs|available at rs|available at ₹|launched at|starts at rs|starts at \$|goes on sale|now on sale|gets a price|cashback|exchange offer|upcoming phone|specifications|specs leak|hands.?on review|camera test|benchmark|unboxing|vs comparison|best phone|top phone|redmi|realme note|poco [a-z]|samsung [a-z]+\d+|iphone \d+ price|iphone (air|pro|plus|max|mini).{0,30}(price|available|discount|deal|rs\b|flipkart|amazon)|watch price|earbuds price|laptop deal|tablet deal|gadget deal|at the lowest|record low price|all.?time low|discount on flipkart|discount on amazon|flipkart sale|amazon sale|flipkart deal|amazon deal|match preview|scorecard|squad|batting|bowling|wicket|fantasy cricket|dream11|box office|trailer|song launch|celebrity gossip|tollywood|bollywood film|film release|9to5mac daily|9to5google daily|morning brew|evening brew|newsletter)\b/i;

// High-priority breaking content: geopolitics, economy, India, major tech
const BREAKING_HIGHPRIORITY_RE = /\b(war|conflict|attack|blast|explosion|earthquake|tsunami|flood|pandemic|outbreak|crisis|emergency|election result|sanctions|nuclear|missile|treaty|summit|terror|coup|protest|strike|budget|gdp|inflation|rate hike|rate cut|fed |rbi |rupee|dollar crash|china|russia|pakistan|ukraine|israel|hamas|nato|un security council|supreme court|parliament|lok sabha|rajya sabha|prime minister|president|minister|assassination|death toll|casualties|ceasefire|ipo|acquisition|merger|layoff|bankruptcy|market crash|market rally|sensex|nifty|tariff|trade war|ai regulation|openai|chatgpt|gemini|nvidia|data breach|cyberattack|antitrust|ban on|crackdown|plane crash|aircraft crash|helicopter crash|building collapse|bridge collapse|stampede|mass casualty|mass shooting|hostage|evacuation|corruption|bribery|resignation|humanitarian|cyclone|typhoon|hurricane|tornado|volcano|wildfire)\b/i;

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

// Catches sports/entertainment the main list misses: general "world cup", bare
// movie/film, casting language, and common Bollywood/Hollywood names.
const EXTRA_SE_RE = /\b(world cup|t20 world cup|asia cup|champions trophy|movies?|films?|film festival|to star in|stars in (the|a|an|upcoming)|box.?office|streaming series|reality show|salman khan|shah rukh|\bsrk\b|aamir khan|ajay devgn|akshay kumar|ranbir kapoor|ranveer singh|deepika padukone|alia bhatt|kareena|katrina kaif|priyanka chopra|kangana|hrithik|kravitz|kardashian|taylor swift|pop group|k.?pop|kpop|j.?pop|boy band|girl group|fan(?:dom|s)|stan(?:s|ned)?|sykkuno|twitch streamer|twitch star|youtuber|content creator|influencer|tiktoker|streamer cheats|cheating scandal|sneak peek|first look|teaser drop|debut album|outback steakhouse|le sserafim|bts |blackpink|nct |stray kids|new jeans|cookies|tough cookies|varun dhawan|sidharth malhotra|tiger shroff|kartik aaryan|vicky kaushal|rajkummar rao|nawazuddin|pankaj tripathi|allu arjun|vijay sethupathi|\bdhanush\b|mahesh babu|prabhas|jr ntr|\byash\b|rana daggubati|david dhawan|karan johar|rohit shetty|sanjay leela bhansali|imtiaz ali|zoya akhtar|anurag kashyap|farhan akhtar|aditya chopra|director's formula|formula (?:finally )?(?:expires|works|fails|delivers|returns)|film review|movie review|series review|show review|episode \d+ review|trailer (?:review|reaction|out|drops?)|teaser (?:out|drops?)|hindi (?:film|movie|cinema)|telugu (?:film|movie)|tamil (?:film|movie)|malayalam (?:film|movie)|kannada (?:film|movie)|punjabi (?:film|movie)|marathi (?:film|movie)|gujarati (?:film|movie)|bengali (?:film|movie)|south indian (?:film|movie|cinema)|theatrical release|theatres? on|cinemas? on|directorial debut|cinematic universe|netflix series|amazon prime original|disney\+ hotstar|hotstar special|sonyliv original|zee5 original|jiocinema)\b/i;
// Sports/entertainment patterns missed by SPORTS_ENTERTAINMENT_RE — major
// tournaments, named players, and generic markers like "lifts trophy".
const EXTRA_SPORTS_RE = /\b(french open|roland garros|us open(?:\s+tennis)?|australian open|monte carlo masters|atp|wta|grand slam|davis cup|laver cup|indian wells|miami open|madrid open|italian open|cincinnati open|paris masters|champion(?:ship)?s? trophy|lifts? (?:the )?trophy|wins? (?:the )?title|wins? (?:gold|silver|bronze)|gold medal|silver medal|bronze medal|podium finish|coach (?:fired|sacked|hired|appointed)|head coach|defending champion|reigning champion|knocked out|advances? to (?:final|semi|quarter)|reaches? (?:final|semi|quarter)|seeded|wildcard|qualifier|nadal|federer|djokovic|alcaraz|sinner|medvedev|swiatek|sabalenka|andreeva|gauff|rybakina|paolini|pegula|jabeur|kyrgios|tsitsipas|zverev|ruud|fritz|tiafoe|raducanu|tennis player|tennis star|grand prix|qualifying round|qualifying race|race winner|race results|pole position|fastest lap|pit stop|pit lane|hamilton (?:wins|leads|crashes)|verstappen|leclerc|norris|piastri|russell|alonso|sainz|formula one|f1 grand prix|moto ?gp|nascar|indycar|grand final|grand slam title|gold cup|copa america|euros? \d{4}|nations league|hat.?trick|brace|own goal|own.?goal|sent off|red card|yellow card|stoppage time|extra time|aggregate score|league standings|fixture (?:announced|released)|table topper|table toppers|league title|championship win|finals? mvp|series mvp|playoff (?:berth|spot|win|loss|game)|coaching change|trade rumor|rumour|trade deadline|free agent|salary cap|\d+-run (?:win|victory|loss|defeat|margin|lead|deficit|target)|run (?:chase|target|rate|machine)|perfect start.{0,40}(?:win|beat|defeat|match)|maintain.{0,20}(?:perfect|winning) start|sloppy (?:batting|bowling|fielding|scotland|england|india|pakistan|australia)|overs? (?:left|remaining)|super over|powerplay|death overs?|duckworth.?lewis|net run rate|nrr|qualify(?:ing)? (?:for|to) super|group stage (?:win|loss|match)|match winner|man of the match|player of the match|innings victory|by \d+ (?:runs|wickets)|tour (?:match|game)|warm.?up (?:match|game)|squad (?:named|announced|selected|revealed) for|playing (?:xi|eleven)|first.?class cricket|county cricket|domestic cricket)\b/i;

function isSportsOrEntertainment(article: NewsDataArticle): boolean {
  const text = `${article.title ?? ""} ${article.description ?? ""}`.slice(0, 300);
  return SPORTS_ENTERTAINMENT_RE.test(text)
    || EXTRA_SE_RE.test(text)
    || EXTRA_SPORTS_RE.test(text);
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

      // Wire-syndicated items (PTI via India Today, etc.) commonly ship an
      // empty <description> with the real text only in <content:encoded>.
      // contentRaw already falls back to descRaw when content:encoded is
      // missing — description needs the same fallback in reverse, otherwise
      // an empty descRaw locks the summary to "" (not undefined, so the
      // `rep.description ?? rep.content` fallback chain downstream never
      // kicks in) and it ultimately surfaces as the headline repeated as
      // its own "summary".
      const description = stripHtml(descRaw || contentRaw).slice(0, 600);
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
      // Same fallback as the RSS 2.0 branch above — an empty <summary> with
      // real text only in <content> must not lock description to "".
      const description = stripHtml(summaryRaw || contentRaw).slice(0, 600);
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
const OG_CACHE_TTL_MS = 90 * 60 * 1000;
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

const PREFERRED_SOURCES = new Set(["techcrunch", "theverge"]);
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

  // Hard-filter: remove sports/entertainment/gadget-deal noise (matches breaking
  // and indian-feeds paths). Without this Tech leaked phone-discount, Steam
  // Frame promos, celebrity items into the feed.
  const filtered = articles
    .filter(a => !isSportsOrEntertainment(a));
  const top = filtered.slice(0, 500); // tech pool ceiling

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

// Return the article from `group` whose headline has the highest average
// token overlap with all other members — the "centroid" representative.
// Falls back to index 0 if group has only one member.
function clusterRepresentative<T extends { title?: string | null }>(group: T[]): T {
  if (group.length <= 1) return group[0]!;
  const sets = group.map((a) => titleTokens(a.title ?? ""));
  let bestIdx = 0;
  let bestScore = -1;
  for (let i = 0; i < group.length; i++) {
    let total = 0;
    for (let j = 0; j < group.length; j++) {
      if (i === j) continue;
      total += overlapCoefficient(sets[i]!, sets[j]!);
    }
    const avg = total / (group.length - 1);
    if (avg > bestScore) { bestScore = avg; bestIdx = i; }
  }
  return group[bestIdx]!;
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

// Country names that, if different between two headlines, signal different stories.
const COUNTRY_TOKENS = new Set([
  "australia","australian","canada","canadian","india","indian","china","chinese",
  "russia","russian","ukraine","ukrainian","usa","us","american","america","uk","britain","british",
  "france","french","germany","german","japan","japanese","brazil","brazilians","pakistan","iran",
  "israel","israeli","iran","iranian","turkey","turkish","mexico","south korea","north korea",
  "italy","italian","spain","spanish","sweden","swedish","indonesia","saudi","nigeria",
  "south africa","netherlands","dutch","new zealand","singapore","thailand","argentina",
]);

function headlineCountry(tokens: Set<string>): string | null {
  for (const t of tokens) {
    if (COUNTRY_TOKENS.has(t)) return t;
  }
  return null;
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
      // Block clustering if articles mention different countries — same topic in
      // different countries (e.g. "Australia bans social media" vs "Canada bans
      // social media") are different stories even if token overlap is high.
      const countryI = headlineCountry(tokenSets[i]!);
      const countryJ = headlineCountry(tokenSets[j]!);
      if (countryI && countryJ && countryI !== countryJ) continue;
      if (overlap >= 0.35 || sharedEntities >= 2) {
        assigned[j] = clusterIdx;
        members.push(j);
      }
    }

    const repArticle = clusterRepresentative(members.map((idx) => articles[idx]!));
    const desc = stripHtml(
      (repArticle.description || repArticle.content || repArticle.title || "").trim(),
    );
    const summary = naiveParagraph(desc);

    clusters.push({
      headline: repArticle.title ?? "Untitled",
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
  // Prefer words shared across 2+ articles, take up to 4 to ensure label is
  // always at least 2 words (single-word labels fall back to rep title tokens).
  const shared = Object.entries(freq)
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([w]) => w.charAt(0).toUpperCase() + w.slice(1));
  if (shared.length >= 2) return shared.join(" ");
  // Fallback: take first 4 meaningful tokens from representative article title
  const rep = Array.from(titleTokens(articles[0]?.title ?? "")).slice(0, 4);
  const repLabel = rep.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  return repLabel || "News Update";
}

// Turn a headline into a SHORT cluster title (~6-10 words). Strips the
// " - Source" suffix, drops the ": subtitle" / "; aside" / "— aside" tail, then
// trims to ~10 words (preferring a comma break) so a cluster card shows a tight
// label, never a 4-line hero headline. Used for both the AI label and the
// fallback article headline.
function cleanClusterHeadline(raw: string): string {
  let t = stripUrlJunk((raw ?? "").trim()).replace(/\s+[|–—-]\s+[^|–—-]+$/, "").trim();
  // Strip article-specific date stamps ("June 2026", "May 29", "2026", "Q1 FY26",
  // "Day 0/Day 3" subscription counters) so cluster topics don't look like a
  // single article's headline.
  t = t
    .replace(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s*\d{4})?\b/gi, "")
    .replace(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+\d{4}\b/gi, "")
    .replace(/\b(?:Day|Q[1-4])\s*\d{1,2}\b/gi, "")
    .replace(/\b(?:FY|fy)\s?\d{2,4}\b/g, "")
    .replace(/\b(?:19|20)\d{2}\b/g, "")
    // Tidy orphaned punctuation left by date removal ("RBI policy : How..." → "RBI policy: How...")
    .replace(/\s+([:;,–—-])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
  // Drop a trailing subtitle/elaboration clause; keep the lead clause if substantial.
  const lead = t.split(/\s*[:;–—]\s+/)[0]!.trim();
  if (lead.split(/\s+/).length >= 3) t = lead;
  // Cluster titles want a tight 5-6 word topic label, not a full headline.
  // Cut at the first natural break (preposition/connective), else hard-cap at 6 words.
  const words = t.split(/\s+/);
  if (words.length > 6) {
    const BREAK = new Set([
      "to","of","for","as","after","amid","while","with","but","over","despite","following","since","because","that","by","in","on","at","from","into","says","said","approves","approved","plans","plan","launches","launched","announces","announced","unveils","reveals","reports","reported","files","filed","raises","raised","secures","secured","aims","seeks","wants",
    ]);
    let cut = 6;
    for (let i = 4; i <= Math.min(words.length - 1, 6); i++) {
      const w = words[i]!.toLowerCase().replace(/[^a-z]/g, "");
      if (BREAK.has(w)) { cut = i; break; }
    }
    t = words.slice(0, cut).join(" ");
  }
  // Tidy trailing punctuation and dangling prepositions/conjunctions.
  t = t.replace(/[\s,:;–—-]+$/, "").replace(/\s+(for|and|to|of|the|a|an|in|on|with|as|its|that|by)$/i, "").trim();
  return t.split(/\s+/).length >= 3 ? t : "";
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

// ── AI (semantic) clustering — groups same-event stories across outlets ──────
// Lexical clustering above misses cross-outlet coverage (different wording), so
// most clusters end up single-source. This groups by MEANING via Groq. To avoid
// the token-drain that got it rolled back before, it is THROTTLED per topic:
// Groq is called at most once per topic per TTL; between calls the last grouping
// is reused, remapped onto the current articles by article-id (new articles =
// their own singleton). Runs on the cheap 8B model's own budget; on any error
// it reuses the last grouping or falls back to lexical clustering.
const AI_CLUSTER_TTL_MS = 90 * 60 * 1000;
const aiTopicClusterCache = new Map<string, { at: number; idToCluster: Map<string, number> }>();
function clusterArticleKey(a: NewsDataArticle): string {
  return ((a.link ? canonicalizeUrl(a.link) : "") || a.title || "").slice(0, 160);
}
function groupsFromAssignment(articles: NewsDataArticle[], idToCluster: Map<string, number>): number[][] {
  const clusterToIdx = new Map<number, number[]>();
  const unknownIdx: number[] = [];
  articles.forEach((a, idx) => {
    const c = idToCluster.get(clusterArticleKey(a));
    if (c === undefined) { unknownIdx.push(idx); return; }
    const arr = clusterToIdx.get(c) ?? [];
    arr.push(idx);
    clusterToIdx.set(c, arr);
  });
  // Re-validate coherence on the CURRENT articles. A cached cluster id may have
  // grouped stories via a bridging article that has since aged out, leaving
  // unrelated members (e.g. a Delhi fire story stuck in a Trump/Iran cluster).
  // Re-split each cached cluster so only members still connected by >=2 shared
  // title tokens stay together. This is the precision guard that catches the
  // stale-chain over-merges the cache can't see.
  const groups: number[][] = [];
  for (const g of clusterToIdx.values()) {
    if (g.length <= 1) { groups.push(g); continue; }
    for (const sg of splitIncoherent(g, articles)) groups.push(sg.slice(0, 6));
  }
  // Fresh/unknown articles (arrived between AI runs): cluster them by TITLE only
  // (>=3 shared title tokens, different domains) — conservative, never chains
  // unrelated stories. Body-token clustering was tried and over-merged badly, so
  // we accept that a rare different-worded pair stays split.
  if (unknownIdx.length > 1) {
    const pool = unknownIdx.map((i) => articles[i]!);
    for (const lg of clusterForMixedFeed(pool)) {
      groups.push(lg.map((li) => unknownIdx[li]!).slice(0, 6));
    }
  } else if (unknownIdx.length === 1) {
    groups.push([unknownIdx[0]!]);
  }
  return groups;
}
// Coherence guard: the 8B model sometimes lumps unrelated stories into one
// group via a BRIDGE article (e.g. an "Iran war + Israel-Hezbollah" piece
// linking a US-politics story to a separate Israel-Lebanon ceasefire cluster).
// Old version used union-find: a single bridge collapsed everything into one
// component. New version: each member must have >=2 STRONG connections (≥2
// shared title tokens with ≥2 OTHER members of the group). Lone-bridge members
// and isolated outliers get split off as their own singletons — so distinct
// stories the AI accidentally chained stay separate.
function splitIncoherent(indices: number[], subset: NewsDataArticle[]): number[][] {
  const m = indices.length;
  if (m <= 1) return [indices];
  const toks = indices.map(i => titleTokens(subset[i]?.title ?? ""));
  // Build adjacency graph: edge i↔j iff they share >=3 title tokens.
  // Raised from 2 to prevent loosely-related articles (sharing only "iPhone"
  // or "Apple") from staying in the same cluster.
  const adj: number[][] = Array.from({ length: m }, () => []);
  for (let i = 0; i < m; i++) {
    for (let j = i + 1; j < m; j++) {
      let shared = 0;
      for (const t of toks[i]!) if (toks[j]!.has(t)) shared++;
      if (shared >= 3) { adj[i]!.push(j); adj[j]!.push(i); }
    }
  }
  // Require each member to have >=2 strong neighbours in groups of 4+,
  // >=1 in smaller groups.
  const minDeg = m >= 4 ? 2 : 1;
  const keep = (i: number) => adj[i]!.length >= minDeg;
  // Build groups: BFS connected components among kept members only. Members
  // that fail the degree threshold become singletons.
  const groups: number[][] = [];
  const visited = new Set<number>();
  for (let i = 0; i < m; i++) {
    if (visited.has(i)) continue;
    if (!keep(i)) { groups.push([indices[i]!]); visited.add(i); continue; }
    const comp: number[] = [];
    const stack = [i];
    while (stack.length) {
      const x = stack.pop()!;
      if (visited.has(x)) continue;
      visited.add(x); comp.push(x);
      for (const y of adj[x]!) if (!visited.has(y) && keep(y)) stack.push(y);
    }
    groups.push(comp.map((c) => indices[c]!));
  }
  return groups;
}
async function aiClusterGroups(articles: NewsDataArticle[], topic: string): Promise<number[][]> {
  const n = articles.length;
  if (n === 0) return [];
  const cached = aiTopicClusterCache.get(topic);
  if (cached && Date.now() - cached.at < AI_CLUSTER_TTL_MS) {
    return groupsFromAssignment(articles, cached.idToCluster);
  }
  const MAX = 40; // cap prompt size; extras become singletons
  const subset = articles.slice(0, MAX);
  try {
    const lines = subset
      .map((a, i) => {
        const sum = (a.description ?? "").replace(/\s+/g, " ").slice(0, 140);
        return `${i}: ${a.title ?? ""}${sum ? ` | ${sum}` : ""}`;
      })
      .join("\n");
    const prompt = `You are a senior news editor. Group these stories by SAME UNDERLYING EVENT / same ongoing situation involving the same primary entity. A shared broad theme (e.g. "tech", "politics") is NOT enough — it must be the same specific event, even if the outlets word the headline differently.

${lines}

Rules:
- Each index appears in exactly ONE group.
- Group together coverage of the SAME event from different outlets; unrelated stories are their own single-item group.
- CRITICAL: The same type of event happening in DIFFERENT countries = DIFFERENT stories. E.g. "Australia bans social media for kids" and "Canada proposes social media ban for kids" are TWO separate stories — do NOT group them together just because the topic is similar.
- Return JSON ONLY, no prose:
{"groups":[{"indices":[0,3]},{"indices":[1]},{"indices":[2,5,7]}]}`;
    const text = await callGroq(prompt, 700, { model: GROQ_MODEL_FAST, task: "clustering" });
    const parsed = JSON.parse(text.replace(/```json|```/g, "").trim()) as { groups?: { indices?: number[] }[] };
    if (!Array.isArray(parsed?.groups) || parsed.groups.length === 0) throw new Error("empty AI groups");
    const idToCluster = new Map<string, number>();
    const seen = new Set<number>();
    let cid = 0;
    for (const g of parsed.groups) {
      const idxs = (g.indices ?? []).filter((i) => Number.isInteger(i) && i >= 0 && i < subset.length && !seen.has(i));
      for (const i of idxs) seen.add(i);
      if (!idxs.length) continue;
      // Split any over-grouped AI clusters into lexically-coherent subgroups.
      for (const sg of splitIncoherent(idxs, subset)) {
        for (const i of sg.slice(0, 6)) idToCluster.set(clusterArticleKey(subset[i]!), cid);
        cid++;
      }
    }
    for (let i = 0; i < subset.length; i++) if (!seen.has(i)) idToCluster.set(clusterArticleKey(subset[i]!), cid++);
    aiTopicClusterCache.set(topic, { at: Date.now(), idToCluster });
    return groupsFromAssignment(articles, idToCluster);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`AI clustering failed for ${topic}:`, e instanceof Error ? e.message : e);
    if (cached) return groupsFromAssignment(articles, cached.idToCluster);
    return clusterForMixedFeed(articles);
  }
}

// ── Cached AI feed enrichment (on the GROQ_MODEL_ENRICH model) ───────────────
// Makes the feed feel AI-curated WITHOUT AI clustering (which is algorithmic /
// free). For each CLUSTER: a meaningful Title-Case headline + a 25-word summary
// (one combined call). For each ARTICLE: a 25-word summary. All generated lazily
// and cached per signature so each runs ~once, NOT every cron poll. A shared
// 15-min back-off on any rate-limit/error stops it hammering or draining Groq;
// when it backs off the feed just falls back to the non-AI text.
const ENRICH_TTL_MS = 24 * 60 * 60 * 1000;
let enrichPausedUntil = 0;          // cluster-enrich backoff (70B)
let articleSummaryPausedUntil = 0;  // per-card summary backoff (8B) — kept SEPARATE so
                                    // article-summary rate-limits never pause cluster enrichment
function clampWords25(text: string): string {
  const w = (text || "").trim().replace(/\s+/g, " ").split(" ").filter(Boolean);
  return w.length <= 25 ? w.join(" ") : w.slice(0, 25).join(" ") + "…";
}

// — Cluster: label + 25-word summary —
const clusterEnrichCache = new Map<string, { label: string; summary: string; at: number }>();
const clusterEnrichInflight = new Set<string>();
// Secondary index: article URL → signature that has a cached label. A cluster's
// signature churns whenever a new article joins (md5 of top-4 URLs), which used
// to throw away the AI label and fall back to the raw headline. Overlapping
// URLs = same story, so reuse the old label under the new signature.
const clusterEnrichUrlIndex = new Map<string, string>();
function clusterSignature(ga: NewsDataArticle[]): string {
  const key = ga.slice(0, 4).map((a) => (a.link ? canonicalizeUrl(a.link) : "") || a.title || "").sort().join("|");
  return createHash("md5").update(key).digest("hex");
}
function clusterUrls(ga: NewsDataArticle[]): string[] {
  return ga.slice(0, 4).map((a) => (a.link ? canonicalizeUrl(a.link) : "")).filter(Boolean);
}
// Cache lookup that survives signature churn: direct hit first, then via any
// member URL. A URL hit re-aliases the entry under the current signature.
function getClusterEnrichCached(ga: NewsDataArticle[]): { label: string; summary: string } | null {
  const sig = clusterSignature(ga);
  const c = clusterEnrichCache.get(sig);
  if (c && Date.now() - c.at < ENRICH_TTL_MS) return { label: c.label, summary: c.summary };
  for (const url of clusterUrls(ga)) {
    const oldSig = clusterEnrichUrlIndex.get(url);
    if (!oldSig) continue;
    const oc = clusterEnrichCache.get(oldSig);
    if (oc && Date.now() - oc.at < ENRICH_TTL_MS) {
      clusterEnrichCache.set(sig, oc);
      for (const u of clusterUrls(ga)) clusterEnrichUrlIndex.set(u, sig);
      return { label: oc.label, summary: oc.summary };
    }
  }
  return null;
}
async function generateClusterEnrichment(sig: string, ga: NewsDataArticle[], foreground = false): Promise<void> {
  try {
    const lines = ga.slice(0, 6).map((a) => `- ${a.title ?? ""}: ${stripHtml((a.description ?? "").slice(0, 140))}`).join("\n");
    const prompt = `These news articles all cover the SAME story. Return JSON ONLY (no markdown):
{"label":"EXACTLY 5-6 words, Title Case, naming the event — lead with the key entity then the action (e.g. \"Trump Iran War Powers Vote\", \"Apple Vision Pro Sales Drop\", \"Israel Lebanon Ceasefire Deal Signed\"). HARD RULE: count the words, must be 5 or 6. NOT a full sentence, NOT an article headline.","summary":"ONE neutral sentence, AT MOST 25 words, of what they collectively report — no source names"}

${lines}`;
    // Background path stays gated (4.5s serial) so stray fire-and-forget calls
    // never burst. Feed builds use foreground=true: clusterEnrichmentAwait's
    // 3-slot concurrency is the burst control there, and waiting 4.5s × N
    // clusters inside a build defeats the point of awaiting.
    const raw = (await callGroq(prompt, 160, { model: GROQ_MODEL_ENRICH, task: "cluster-enrich", background: !foreground })).replace(/```json|```/g, "").trim();
    const m = raw.match(/\{[\s\S]*\}/);
    const parsed = m ? (JSON.parse(m[0]) as { label?: string; summary?: string }) : {};
    const label = typeof parsed.label === "string" ? parsed.label.trim().slice(0, 110) : "";
    const summary = clampWords25(stripHtml(typeof parsed.summary === "string" ? parsed.summary : ""));
    if (label || summary) {
      clusterEnrichCache.set(sig, { label, summary, at: Date.now() });
      for (const u of clusterUrls(ga)) clusterEnrichUrlIndex.set(u, sig);
    }
  } catch {
    enrichPausedUntil = Date.now() + 60_000;
  } finally {
    clusterEnrichInflight.delete(sig);
  }
}
function clusterEnrichment(ga: NewsDataArticle[]): { label: string; summary: string } | null {
  const cached = getClusterEnrichCached(ga);
  if (cached) return cached;
  const sig = clusterSignature(ga);
  if (Date.now() > enrichPausedUntil && !clusterEnrichInflight.has(sig)) {
    clusterEnrichInflight.add(sig);
    void generateClusterEnrichment(sig, ga);
  }
  return null;
}

// Synchronous AWAIT variant — used during feed builds (cron poll path) so every
// cluster gets a real AI label before the feed is cached. 15s per-cluster cap;
// at most 3 in-flight at once to avoid a 429 burst. Falls back to the cleaned
// hero headline only if Groq paused/errored.
let enrichInflightCount = 0;
// Acquire pattern: the count check and increment happen in the same synchronous
// tick, so N concurrent awaiters can't all pass the check before anyone counts
// (the old check-then-increment-after-await let a Promise.all of 60 callers all
// see count=0 and go concurrent — a 429 storm on cold cache).
async function acquireEnrichSlot(): Promise<void> {
  for (;;) {
    if (enrichInflightCount < 3) { enrichInflightCount++; return; }
    await new Promise((r) => setTimeout(r, 120));
  }
}
async function clusterEnrichmentAwait(ga: NewsDataArticle[]): Promise<{ label: string; summary: string } | null> {
  const cached = getClusterEnrichCached(ga);
  if (cached) return cached;
  if (Date.now() <= enrichPausedUntil) return null;
  const sig = clusterSignature(ga);
  if (!clusterEnrichInflight.has(sig)) {
    clusterEnrichInflight.add(sig);
    await acquireEnrichSlot();
    // Release the slot when the Groq call actually settles — NOT when the 15s
    // race times out — so real in-flight concurrency stays ≤3 even when slow.
    const call = generateClusterEnrichment(sig, ga, true).finally(() => { enrichInflightCount--; });
    try {
      await Promise.race([call, new Promise<void>((res) => setTimeout(res, 15000))]);
    } catch { /* swallow — fall through to cache read */ }
  }
  const fresh = clusterEnrichCache.get(sig);
  return fresh ? { label: fresh.label, summary: fresh.summary } : null;
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
    const body = stripUrlJunk(stripHtml((card.summary ?? "").slice(0, 600)));
    // When there's no usable body (e.g. a Hacker News item that was only links),
    // ask the model to characterise the article from its headline instead.
    const prompt = body.length > 12
      ? `Summarise this news article in ONE neutral, informative sentence of AT MOST 25 words. No preamble, no markdown.\n\nHeadline: ${card.headline ?? ""}\n${body}\n\nSummary:`
      : `Write ONE neutral, informative sentence of AT MOST 25 words describing what this article is most likely about, based on its headline. No preamble, no markdown, no speculation beyond the headline.\n\nHeadline: ${card.headline ?? ""}\n\nSummary:`;
    let rawText: string;
    if (process.env["CEREBRAS_API_KEY"]) {
      try {
        rawText = await callCerebras(prompt, 80, { task: "article-summary-feed", background: true });
      } catch {
        rawText = await callGroq(prompt, 80, { model: GROQ_MODEL_FAST, task: "article-summary-feed", background: true });
      }
    } else {
      rawText = await callGroq(prompt, 80, { model: GROQ_MODEL_FAST, task: "article-summary-feed", background: true });
    }
    const text = rawText.trim().replace(/^summary:\s*/i, "");
    const summary = clampWords25(stripHtml(text));
    if (summary) articleSummaryCache.set(sig, { summary, at: Date.now() });
  } catch {
    articleSummaryPausedUntil = Date.now() + 60_000;
  } finally {
    articleSummaryInflight.delete(sig);
  }
}
function cardAiSummary(card: StoryCard): string | null {
  const sig = cardSignature(card);
  const c = articleSummaryCache.get(sig);
  if (c && Date.now() - c.at < ENRICH_TTL_MS) return c.summary;
  if (Date.now() > articleSummaryPausedUntil && !articleSummaryInflight.has(sig)) {
    articleSummaryInflight.add(sig);
    void generateCardSummary(sig, card);
  }
  return null;
}

// Score and order all groups into a mixed FeedItem[].
// Groups ≥ 3 become clusters; smaller groups produce standalone FeedArticle items.
// score = velocity * 0.4 + freshness * 0.35 + relevance * 0.25
// ── Theme collections — group DIFFERENT stories by company / hot theme ───────
// A second clustering TYPE (distinct from same-event clusters). For tech /
// business / markets, the many one-off singletons are grouped by the company or
// theme they're about (Apple, "AI Agents", "Earnings"…) so the feed has useful
// "what's happening with X" rails. Hybrid: keyword map first, then 8B for the
// keyword-missed leftovers. Cross-company themes are checked BEFORE companies so
// a theme (e.g. "AI Agents") wins over a single company when both match.
type ThemeRule = { name: string; re: RegExp };
const COMPANY_RULES: ThemeRule[] = [
  { name: "Apple",     re: /\b(apple|iphone|ipad|macbook|macos|\bios\b|siri|app store|airpods|vision pro|tim cook|cupertino)\b/i },
  { name: "Google",    re: /\b(google|alphabet|android|pixel|chrome|deepmind|gemini|gemma|waymo|sundar pichai)\b/i },
  { name: "Meta",      re: /\b(\bmeta\b|facebook|instagram|whatsapp|zuckerberg|threads|reality labs|oculus)\b/i },
  { name: "Microsoft", re: /\b(microsoft|windows \d|azure|copilot|\bxbox\b|satya nadella)\b/i },
  { name: "Nvidia",    re: /\b(nvidia|jensen huang|\bcuda\b|geforce|blackwell)\b/i },
  { name: "OpenAI",    re: /\b(openai|chatgpt|sam altman)\b/i },
  { name: "Amazon",    re: /\b(amazon|\baws\b|alexa|jeff bezos|prime video)\b/i },
  { name: "Tesla",     re: /\b(tesla|elon musk|cybertruck|full self-driving)\b/i },
  { name: "Samsung",   re: /\b(samsung|galaxy s\d|galaxy z|galaxy fold)\b/i },
  { name: "Anthropic", re: /\b(anthropic|\bclaude\b)\b/i },
  { name: "xAI",       re: /\b(\bxai\b|\bgrok\b)\b/i },
  { name: "Intel",     re: /\b(\bintel\b|core ultra|\bxeon\b)\b/i },
  { name: "AMD",       re: /\b(\bamd\b|ryzen|radeon|lisa su)\b/i },
  { name: "TSMC",      re: /\b(\btsmc\b|taiwan semiconductor)\b/i },
  { name: "Qualcomm",  re: /\b(qualcomm|snapdragon)\b/i },
  { name: "Netflix",   re: /\b(netflix)\b/i },
  { name: "Spotify",   re: /\b(spotify)\b/i },
  { name: "TikTok",    re: /\b(tiktok|bytedance)\b/i },
  { name: "Reddit",    re: /\b(reddit)\b/i },
  { name: "Oracle",    re: /\b(\boracle\b)\b/i },
  { name: "Salesforce",re: /\b(salesforce)\b/i },
  { name: "Adobe",     re: /\b(\badobe\b)\b/i },
  { name: "IBM",       re: /\b(\bibm\b)\b/i },
  { name: "Sony",      re: /\b(\bsony\b|playstation)\b/i },
  { name: "Nintendo",  re: /\b(nintendo|switch 2)\b/i },
];
const TECH_THEME_RULES: ThemeRule[] = [
  { name: "AI Agents",  re: /\b(ai agents?|agentic|autonomous agents?)\b/i },
  { name: "New AI Models", re: /\b(gpt-?\d|large language model|\bllm\b|foundation model|open-?weight|new ai model|model release|llama \d|claude \d|mistral|deepseek|\bqwen\b|reasoning model)\b/i },
  { name: "Chips & Semiconductors", re: /\b(semiconductor|chipmaker|\bchips?\b|wafer|foundry|\beuv\b|nanometer|\bfabs?\b)\b/i },
  { name: "Quantum Computing", re: /\b(quantum comput|\bqubits?\b|quantum processor|quantum supremacy)\b/i },
  { name: "Robotics", re: /\b(\brobots?\b|robotics|humanoid|boston dynamics)\b/i },
  { name: "AR / VR", re: /\b(augmented reality|virtual reality|mixed reality|vr headset|ar glasses|metaverse|quest \d|smart glasses)\b/i },
  { name: "Cybersecurity", re: /\b(ransomware|data breach|malware|zero-day|vulnerabilit|hacked|cyberattack|phishing|spyware)\b/i },
  { name: "Crypto & Web3", re: /\b(crypto|bitcoin|ethereum|blockchain|stablecoin|web3|\bnft\b)\b/i },
  { name: "EVs & Autonomy", re: /\b(electric vehicle|\bevs?\b|self-driving|robotaxi|autonomous vehicle|ev charging)\b/i },
  { name: "Space", re: /\b(spacex|\bnasa\b|rocket launch|satellite|starship|blue origin)\b/i },
  { name: "Layoffs & Hiring", re: /\b(layoffs?|job cuts?|\bfired\b|hiring freeze|restructuring|workforce reduction)\b/i },
  { name: "Antitrust & Regulation", re: /\b(antitrust|monopoly|\bftc\b|\bdoj\b|regulat|\beu fine|lawsuit|\bsued\b|probe)\b/i },
  { name: "Privacy & Data", re: /\b(privacy|data protection|surveillance|tracking|\bgdpr\b|age verification)\b/i },
  { name: "Social Media", re: /\b(social media|content moderation|misinformation|deepfakes?|going viral)\b/i },
  { name: "Gaming", re: /\b(video game|game pass|\bconsole\b|esports)\b/i },
  { name: "Streaming & Media", re: /\b(streaming|subscribers?|box office|original series)\b/i },
  { name: "Fintech & Payments", re: /\b(fintech|\bpayments?\b|digital wallet|\bupi\b|neobank)\b/i },
  { name: "Health & Biotech", re: /\b(biotech|health tech|\bdrug\b|\bfda\b|clinical trial|genom)\b/i },
  { name: "Climate & Energy", re: /\b(climate tech|renewable|solar power|\bbattery\b|nuclear|carbon)\b/i },
];
const BIZ_THEME_RULES: ThemeRule[] = [
  { name: "Earnings",   re: /\b(earnings|quarterly results|q[1-4] (results|profit)|net profit|profit (jump|rise|fall|down|up)|guidance)\b/i },
  { name: "IPOs & Listings", re: /\b(\bipo\b|listing|market debut|goes public|drhp|grey market premium|\bgmp\b)\b/i },
  { name: "Banking & Rates", re: /\b(\bbank\b|\brbi\b|\bfed\b|interest rate|\bloans?\b|deposit|\bnpa\b|repo rate)\b/i },
  { name: "Mergers & Deals", re: /\b(acquir|acquisition|merger|takeover|buyout|\bstake\b|block deal)\b/i },
  { name: "Startups & Funding", re: /\b(startup|\bfunding\b|raises? \$|series [a-e]\b|valuation|venture capital|\bvc\b)\b/i },
  { name: "Oil & Energy", re: /\b(crude|oil price|\bopec\b|natural gas|\bpetrol\b|diesel)\b/i },
  { name: "Gold & Commodities", re: /\b(\bgold\b|\bsilver\b|commodit|bullion)\b/i },
  { name: "Real Estate", re: /\b(real estate|\bproperty\b|housing|realty|homebuilder)\b/i },
  { name: "Auto & EVs", re: /\b(auto sales|carmaker|vehicle sales|automaker)\b/i },
  { name: "Pharma & Healthcare", re: /\b(pharma|drugmaker|\busfda\b|healthcare|\bvaccine\b)\b/i },
  { name: "Aviation", re: /\b(airline|aviation|\bairport\b|aircraft|boeing|airbus|indigo)\b/i },
  { name: "Inflation & Economy", re: /\b(inflation|\bgdp\b|recession|unemployment|jobs report)\b/i },
  { name: "Tariffs & Trade", re: /\b(tariffs?|trade war|import duty|\bwto\b)\b/i },
  { name: "Currency & Rupee", re: /\b(\brupee\b|dollar index|\bforex\b|exchange rate)\b/i },
  { name: "Tax & Policy", re: /\b(\btax\b|\bgst\b|\bbudget\b|fiscal|\bsebi\b)\b/i },
  { name: "Dividends & Buybacks", re: /\b(dividend|buyback|bonus (issue|share)|stock split)\b/i },
  { name: "Markets & Indices", re: /\b(sensex|nifty|nasdaq|\bdow\b|s&p|stock market|\bindex\b|yields?)\b/i },
];
// Politics / world themes — for breaking (the cross-domain firehose) + the
// india-politics / geopolitics feeds, which the tech/biz maps don't cover.
const WORLD_THEME_RULES: ThemeRule[] = [
  { name: "Trump & US Politics", re: /\b(trump|white house|\bgop\b|republican|democrat|\bcongress\b|\bsenate\b|capitol|\bmaga\b)\b/i },
  { name: "India Politics", re: /\b(\bmodi\b|\bbjp\b|congress party|parliament|lok sabha|rajya sabha|rahul gandhi|kejriwal|mamata|amit shah)\b/i },
  { name: "Israel & Gaza", re: /\b(israel|\bgaza\b|hamas|netanyahu|\bidf\b|palestinian|west bank|hezbollah)\b/i },
  { name: "Iran", re: /\b(\biran\b|tehran|\birgc\b|ayatollah)\b/i },
  { name: "Russia–Ukraine", re: /\b(russia|ukraine|\bputin\b|zelensky|\bkyiv\b|moscow|kremlin)\b/i },
  { name: "China", re: /\b(\bchina\b|beijing|xi jinping|\bccp\b|taiwan)\b/i },
  { name: "Elections", re: /\b(election|\bballot\b|polling booth|campaign trail|by-election|exit poll)\b/i },
  { name: "Courts & Law", re: /\b(supreme court|high court|\bverdict\b|\bruling\b|sentenced|indicted|\bplea\b)\b/i },
  { name: "Immigration", re: /\b(immigration|deportation|migrants?|asylum)\b/i },
  { name: "Protests & Unrest", re: /\b(protests?|\briot|clashes?|\bunrest\b|demonstration)\b/i },
  { name: "Defence & Military", re: /\b(\bmilitary\b|defence ministry|airstrike|\btroops?\b|warship|drone strike)\b/i },
  { name: "Disasters & Weather", re: /\b(earthquake|\bflood|wildfire|hurricane|cyclone|monsoon|landslide)\b/i },
  { name: "Crime & Police", re: /\b(\bmurder\b|shooting|\barrested\b|\bkidnap|\bassault\b)\b/i },
];
const THEME_TOPICS = new Set(["technology", "business", "markets", "breaking", "india-politics", "geopolitics"]);
function themeRulesFor(topic: string): ThemeRule[] {
  if (topic === "technology") return [...TECH_THEME_RULES, ...COMPANY_RULES];
  if (topic === "business") return [...BIZ_THEME_RULES, ...COMPANY_RULES];
  // Markets: drop the catch-all "Markets & Indices" — in a markets feed it would
  // swallow nearly everything and stop being a useful rail.
  if (topic === "markets") return [...BIZ_THEME_RULES.filter(r => r.name !== "Markets & Indices"), ...COMPANY_RULES];
  if (topic === "india-politics" || topic === "geopolitics") return [...WORLD_THEME_RULES];
  // breaking = firehose across every domain → all maps, politics/world first.
  if (topic === "breaking") return [...WORLD_THEME_RULES, ...TECH_THEME_RULES, ...BIZ_THEME_RULES.filter(r => r.name !== "Markets & Indices"), ...COMPANY_RULES];
  return [];
}
function themeNamesFor(topic: string): string[] { return themeRulesFor(topic).map(r => r.name); }
function detectTheme(a: NewsDataArticle, rules: ThemeRule[]): string | null {
  const text = `${a.title ?? ""} ${stripHtml(a.description ?? "").slice(0, 160)}`;
  for (const r of rules) if (r.re.test(text)) return r.name;
  return null;
}

// Hybrid leftover pass: 8B assigns a theme to keyword-unmatched articles.
// Throttled per topic + cached by article key (mirrors aiClusterGroups). Lazy:
// the first build triggers it, later builds use the cached assignment.
const THEME_ASSIGN_TTL_MS = 24 * 60 * 60 * 1000;
const themeAssignCache = new Map<string, { at: number; idToTheme: Map<string, string> }>();
const themeAssignInflight = new Set<string>();
async function generateThemeAssignments(topic: string, untagged: NewsDataArticle[]): Promise<void> {
  try {
    const preferred = themeNamesFor(topic);
    const subset = untagged.slice(0, 36);
    const lines = subset.map((a, i) => `${i}: ${a.title ?? ""}`).join("\n");
    // OPEN-ENDED discovery — the model names the themes itself (not limited to a
    // fixed list), so anything recurring (quantum computing, layoffs, tariffs,
    // a company we never hard-coded…) can form a rail. Keyword names are only a
    // preference for consistent spelling.
    const prompt = `You are a ${topic} news editor building "what's happening with X" rails. Below are today's one-off headlines. DISCOVER the recurring themes — each is a specific company (e.g. Apple, Nvidia, TSMC, Anthropic), a technology (e.g. quantum computing, AI agents, robotics), or a topic (e.g. layoffs, antitrust, tariffs, oil prices). Assign each headline to ONE concise theme it clearly belongs to, or "none" if it stands alone. Use a 1-3 word Title Case name and REUSE the exact same name for related stories. Prefer these names when they fit: ${preferred.join(", ")}.

${lines}

Return JSON ONLY: {"a":[{"i":0,"t":"Apple"},{"i":1,"t":"Quantum Computing"},{"i":2,"t":"none"}]}`;
    const text = await callGroq(prompt, 800, { model: GROQ_MODEL_FAST, task: "theme-assign", background: true });
    const parsed = JSON.parse(text.replace(/```json|```/g, "").trim()) as { a?: { i?: number; t?: string }[] };
    const idToTheme = new Map<string, string>();
    for (const e of parsed.a ?? []) {
      if (typeof e.i !== "number" || e.i < 0 || e.i >= subset.length) continue;
      const t = (e.t ?? "").trim().replace(/\s+/g, " ").slice(0, 28);
      if (t && t.toLowerCase() !== "none" && t.length >= 2) idToTheme.set(clusterArticleKey(subset[e.i]!), t);
    }
    // Cap to top 8 themes by article count — prevents 15+ micro-rails that clutter the feed
    const themeCounts = new Map<string, number>();
    for (const t of idToTheme.values()) themeCounts.set(t, (themeCounts.get(t) ?? 0) + 1);
    const top8 = new Set([...themeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t]) => t));
    for (const [k, t] of idToTheme.entries()) { if (!top8.has(t)) idToTheme.delete(k); }
    themeAssignCache.set(topic, { at: Date.now(), idToTheme });
  } catch {
    // Keep the last assignment but retry soon (~10 min) rather than waiting the
    // full TTL — a transient rate-limit shouldn't block discovery for 90 min.
    const prev = themeAssignCache.get(topic);
    themeAssignCache.set(topic, { at: Date.now() - THEME_ASSIGN_TTL_MS + 10 * 60 * 1000, idToTheme: prev?.idToTheme ?? new Map() });
  } finally {
    themeAssignInflight.delete(topic);
  }
}
function cachedThemeAssign(topic: string, untagged: NewsDataArticle[]): Map<string, string> {
  const c = themeAssignCache.get(topic);
  const fresh = c && Date.now() - c.at < THEME_ASSIGN_TTL_MS;
  if (!fresh && untagged.length >= 3 && Date.now() > enrichPausedUntil && !themeAssignInflight.has(topic)) {
    themeAssignInflight.add(topic);
    void generateThemeAssignments(topic, untagged);
  }
  return c?.idToTheme ?? new Map();
}

// Group leftover singletons into theme groups (keyword + AI), freshest first.
function buildThemeGroups(singletons: NewsDataArticle[], topic: string): { theme: string; arts: NewsDataArticle[] }[] {
  const rules = themeRulesFor(topic);
  if (rules.length === 0) return [];
  // Canonicalise so keyword + AI-discovered names merge (case-insensitive),
  // preferring the keyword map's spelling when one matches.
  const known = new Map(rules.map(r => [r.name.toLowerCase(), r.name] as const));
  const byKey = new Map<string, { name: string; arts: NewsDataArticle[] }>();
  const add = (rawTheme: string, a: NewsDataArticle) => {
    const key = rawTheme.trim().toLowerCase();
    if (!key) return;
    const g = byKey.get(key) ?? { name: known.get(key) ?? rawTheme.trim(), arts: [] };
    g.arts.push(a); byKey.set(key, g);
  };
  const untagged: NewsDataArticle[] = [];
  for (const a of singletons) {
    const th = detectTheme(a, rules);
    if (th) add(th, a); else untagged.push(a);
  }
  const aiThemes = cachedThemeAssign(topic, untagged);
  if (aiThemes.size > 0) for (const a of untagged) { const th = aiThemes.get(clusterArticleKey(a)); if (th) add(th, a); }
  const ts = (a: NewsDataArticle) => (a.pubDate ? Date.parse(a.pubDate) : 0);
  return Array.from(byKey.values())
    .filter(g => g.arts.length >= 3)
    .map(g => ({ theme: g.name, arts: g.arts.sort((x, y) => ts(y) - ts(x)) }));
}

// Deterministic ~25-word digest for a theme collection: the freshest few
// headlines, cleaned of a trailing " - Source" / " | Section" attribution only
// (whitespace-delimited, so hyphenated words like "Ex-banker" survive).
function themeDigest(arts: NewsDataArticle[]): string {
  const clean = (t: string) => (t || "").replace(/\s+[|–—-]\s+[^|–—-]+$/, "").trim();
  const parts = arts.slice(0, 3).map(a => clean(a.title ?? "")).filter(Boolean);
  return clampWords25(parts.join(" · "));
}

// AI 20-word meta-summary for a theme collection (~Apple, AI Agents, Banking).
// Theme collections hold DIFFERENT stories on a topic, so the summary describes
// the CURRENT state of coverage, not a single event. Fire-and-forget + cached
// 24h; next feed build picks up the cached summary. Falls back to themeDigest.
function themeKey(theme: string, arts: NewsDataArticle[]): string {
  const ids = arts.slice(0, 6).map(a => (a.link ? canonicalizeUrl(a.link) : "") || a.title || "").sort().join("|");
  return createHash("md5").update(theme + "::" + ids).digest("hex");
}
async function generateThemeSummary(key: string, theme: string, arts: NewsDataArticle[]): Promise<void> {
  try {
    const lines = arts.slice(0, 6).map((a) => `- ${a.title ?? ""}: ${stripHtml((a.description ?? "").slice(0, 100))}`).join("\n");
    const prompt = `These articles all relate to the topic "${theme}" but are DIFFERENT stories. Summarise the current state of "${theme}" coverage in ONE neutral sentence of AT MOST 20 words. Capture WHAT'S HAPPENING ACROSS the stories (multiple angles, recurring entities, key developments) — NOT one story. Return JSON ONLY: {"summary":"..."}\n\n${lines}`;
    const raw = (await callGroq(prompt, 120, { model: GROQ_MODEL_ENRICH, task: "theme-summary", background: true })).replace(/```json|```/g, "").trim();
    const m = raw.match(/\{[\s\S]*\}/);
    const parsed = m ? (JSON.parse(m[0]) as { summary?: string }) : {};
    const summary = clampWords25(stripHtml(typeof parsed.summary === "string" ? parsed.summary : "")).split(/\s+/).slice(0, 20).join(" ");
    if (summary) clusterEnrichCache.set(key, { label: "", summary, at: Date.now() });
  } catch {
    themeSummaryPausedUntil = Date.now() + 60_000;
  }
}
let themeSummaryPausedUntil = 0; // OWN pause — don't inherit cluster-enrich's
function themeSummary(theme: string, arts: NewsDataArticle[]): string | null {
  const key = themeKey(theme, arts);
  const c = clusterEnrichCache.get(key);
  if (c && c.summary && Date.now() - c.at < ENRICH_TTL_MS) return c.summary;
  if (Date.now() > themeSummaryPausedUntil && !clusterEnrichInflight.has(key)) {
    clusterEnrichInflight.add(key);
    void generateThemeSummary(key, theme, arts).finally(() => clusterEnrichInflight.delete(key));
  }
  return null;
}

async function buildMixedFeed(articles: NewsDataArticle[], groups: number[][], topic = ""): Promise<FeedItem[]> {
  const now = Date.now();
  const scored: Array<{ item: FeedItem; score: number }> = [];
  const singletonArts: NewsDataArticle[] = []; // one-off articles, grouped into theme collections below

  // First pass: score every cluster so we know which are the TOP N to enrich.
  // Firing clusterEnrichment for every cluster bursts ~60 calls and 92% 429.
  type ClusterInfo = { ga: NewsDataArticle[]; score: number; hoursOld: number };
  const clusterInfos: ClusterInfo[] = [];
  for (const group of groups) {
    const ga = group.map(i => articles[i]!).filter(Boolean);
    if (ga.length === 0) continue;
    const newest = Math.max(...ga.map(a => a.pubDate ? Date.parse(a.pubDate) : 0));
    const hoursOld = Math.max(0, (now - newest) / 3_600_000);
    // Hard age cap on event clusters: a cluster whose newest article is >24h
    // old is stale and shouldn't surface (was showing 41h Shivakumar cluster).
    if (hoursOld > 24 && group.length >= 3) continue;
    if (group.length >= 3) {
      const recentCount = ga.filter(a => {
        const ms = a.pubDate ? Date.parse(a.pubDate) : 0;
        return now - ms < 3 * 3_600_000;
      }).length;
      const velocity = recentCount / ga.length;
      const freshness = 1 / (hoursOld + 1);
      const relevance = Math.log(ga.length + 1);
      const score = velocity * 0.4 + freshness * 0.35 + relevance * 0.25;
      clusterInfos.push({ ga, score, hoursOld });
    } else {
      for (const a of ga) singletonArts.push(a);
    }
  }
  // AWAIT AI labels so the feed is never cached with raw-headline cluster
  // titles. Cache hits (incl. URL-index hits after signature churn) are free;
  // misses call Groq foreground, 3 at a time, under a total build budget.
  // Whatever misses the budget keeps generating and lands in cache for the
  // next build — only those clusters fall back to the cleaned headline.
  const ENRICH_BUILD_BUDGET_MS = 20_000;
  const enrichDeadline = Date.now() + ENRICH_BUILD_BUDGET_MS;
  const enrichMap = new Map<number, { label: string; summary: string } | null>();
  await Promise.all(clusterInfos.map(async ({ ga }, idx) => {
    const cached = getClusterEnrichCached(ga);
    if (cached) { enrichMap.set(idx, cached); return; }
    const remaining = enrichDeadline - Date.now();
    if (remaining <= 0) { enrichMap.set(idx, clusterEnrichment(ga)); return; }
    const r = await Promise.race([
      clusterEnrichmentAwait(ga),
      new Promise<null>((res) => setTimeout(() => res(null), remaining)),
    ]);
    enrichMap.set(idx, r ?? getClusterEnrichCached(ga));
  }));
  clusterInfos.forEach(({ ga, score }, idx) => {
    const cards = buildFallbackStories(ga);
    const rep = clusterRepresentative(ga);
    const enrich = enrichMap.get(idx) ?? null;
    const topicTitle = cleanClusterHeadline(enrich?.label || rep.title || "") || feedClusterLabel(ga);
    // AI summary already clampWords25'd at generation. When AI fails / hasn't
    // landed, clamp the article-description fallback to 25 words too so the
    // cluster summary is consistently ~25 words instead of spilling the full
    // lead description.
    const topicSummary =
      (enrich?.summary) ||
      // `||` not `??` — an empty-string description (common on wire-syndicated
      // items with a blank <description>) must fall through to content/title
      // same as a genuinely missing field, otherwise it locks to "" and the
      // card ends up showing its own headline as the "summary".
      clampWords25(naiveParagraph(stripUrlJunk(stripHtml((rep.description || rep.content || rep.title || "").trim()))));
    scored.push({ item: { type: "cluster", topicTitle, topicSummary, articles: cards }, score });
  });

  // ── Theme collections (tech / business / markets) ──────────────────────────
  // Group the one-off singletons by company / hot theme into "what's happening
  // with X" rails. Claim only the displayed slice so no story is lost — any
  // overflow flows on as a normal single card.
  const claimed = new Set<NewsDataArticle>();
  if (THEME_TOPICS.has(topic)) {
    const COLLECTION_CAP = 8;
    // Cross-domain firehoses make tons of rails — cap how many for those so the
    // feed isn't all carousels. Tech/Business/Markets stay uncapped (by request).
    const MAX_RAILS: Record<string, number> = { breaking: 12, "india-politics": 8, geopolitics: 8 };
    const maxRails = MAX_RAILS[topic] ?? Infinity;
    const themeGroups = buildThemeGroups(singletonArts, topic)
      .sort((a, b) => b.arts.length - a.arts.length) // biggest themes first when capping
      .slice(0, maxRails);
    // Theme AI summaries DISABLED — free-tier Groq RPM gets saturated by the
    // already-shipped cluster-enrich + article-summary-feed bursts, so the
    // theme-summary calls fire last in each build and 100% 429'd. The
    // deterministic themeDigest (joined first-3 headlines) gives the reader the
    // same surface info reliably; re-enable with batching or paid Groq tier later.
    // Old-but-important stories dropped from TREND rails get their own honest
    // rail ("Catch Up") at the bottom instead of masquerading as trending or
    // vanishing into buried singles.
    const catchUpPool: NewsDataArticle[] = [];
    themeGroups.forEach(({ theme, arts }) => {
      // Rails read newest-first and hard-cap members at 7 days (the original
      // bug was a 10-day zombie sitting FIRST because only the rail's newest
      // member was age-checked, in raw feed order). Prefer ≤72h members, but
      // if fewer than 3 exist, BACKFILL with 3-7 day ones so themes/companies
      // rails don't vanish wholesale — newest-first ordering guarantees the
      // older fill never leads the rail.
      const MEMBER_FRESH_MS = 72 * 3_600_000;
      const MEMBER_HARD_MAX_MS = 7 * 24 * 3_600_000;
      const within7d = arts
        .filter(a => { const ms = a.pubDate ? Date.parse(a.pubDate) : 0; return ms > 0 && now - ms <= MEMBER_HARD_MAX_MS; })
        .sort((a, b) => (Date.parse(b.pubDate ?? "") || 0) - (Date.parse(a.pubDate ?? "") || 0));
      const fresh = within7d.filter(a => now - (Date.parse(a.pubDate ?? "") || 0) <= MEMBER_FRESH_MS);
      const display = (fresh.length >= 3 ? fresh : within7d).slice(0, COLLECTION_CAP);
      // Anything 3-7 days old that didn't make the rail feeds the Catch Up rail.
      const displaySet = new Set(display);
      for (const a of within7d) {
        if (!displaySet.has(a) && now - (Date.parse(a.pubDate ?? "") || 0) > MEMBER_FRESH_MS) catchUpPool.push(a);
      }
      if (display.length < 3) return;
      const newest = Math.max(...display.map(a => (a.pubDate ? Date.parse(a.pubDate) : 0)));
      const hoursOld = Math.max(0, (now - newest) / 3_600_000);
      // Rail-level freshness gate: drop the rail if even its freshest story is
      // >24h old (12h proved too strict — most theme rails died off-peak; the
      // members are newest-first so a 20h lead still reads as current).
      if (hoursOld > 24) { for (const a of display) { if (now - (Date.parse(a.pubDate ?? "") || 0) > MEMBER_FRESH_MS) catchUpPool.push(a); } return; }
      for (const a of display) claimed.add(a);
      const cards = buildFallbackStories(display);
      const score = (1 / (hoursOld + 1)) * 0.4 + Math.log(display.length + 1) * 0.25 + 0.08;
      scored.push({ item: { type: "cluster", topicTitle: theme, topicSummary: themeDigest(display), articles: cards, collection: true }, score });
    });

    // "Catch Up" rail — 3-7 day-old stories that were part of hot themes but
    // aged out of TREND rails. One honest rail near the feed bottom instead of
    // zombies posing as trending. Newest-first, capped at 8, needs ≥3.
    if (catchUpPool.length >= 3) {
      const seen = new Set<NewsDataArticle>();
      const catchUp = catchUpPool
        .filter(a => !claimed.has(a) && !seen.has(a) && (seen.add(a), true))
        .sort((a, b) => (Date.parse(b.pubDate ?? "") || 0) - (Date.parse(a.pubDate ?? "") || 0))
        .slice(0, COLLECTION_CAP);
      if (catchUp.length >= 3) {
        for (const a of catchUp) claimed.add(a);
        const cards = buildFallbackStories(catchUp);
        scored.push({
          item: { type: "cluster", topicTitle: "Catch Up · Big Stories This Week", topicSummary: themeDigest(catchUp), articles: cards, collection: true },
          // Above stale singles (~0.09) so it's actually findable, below every
          // fresh rail and recent story. 0.04 buried it at the very bottom of
          // a 300-item feed — users couldn't find it at all.
          score: 0.15,
        });
      }
    }
  }

  // Remaining one-off singletons → article items.
  for (const a of singletonArts) {
    if (claimed.has(a)) continue;
    const pubMs = a.pubDate ? Date.parse(a.pubDate) : 0;
    const ah = Math.max(0, (now - pubMs) / 3_600_000);
    const velocity = ah < 1 ? 1 : Math.exp(-0.5 * (ah - 1));
    const freshness = 1 / (ah + 1);
    const score = velocity * 0.4 + freshness * 0.35 + 0.3 * 0.25;
    const [card] = buildFallbackStories([a]);
    if (card) scored.push({ item: { ...card, type: "article" }, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const items = scored.map(s => s.item);
  // 25-word AI summary for solo cards — bounded so 70b's daily budget isn't
  // blown on the full ~300-item feed. PRIORITISE cards whose summary is empty
  // (junk-only sources like Hacker News) since they have nothing else to show,
  // then fill remaining slots with the top-ranked cards. Lazy + cached.
  const AI_SUMMARY_BUDGET = 8; // lowest-priority enrichment — kept small so headlines (queued first) drain quickly through the rate gate
  const articleItems = items.filter((i): i is StoryCard => i.type === "article");
  const isEmpty = (s?: string) => !s || s.length < 12;
  const ordered = [
    ...articleItems.filter(i => isEmpty(i.summary)),
    ...articleItems.filter(i => !isEmpty(i.summary)),
  ];
  let done = 0;
  for (const item of ordered) {
    if (done >= AI_SUMMARY_BUDGET) break;
    const ai = cardAiSummary(item);
    if (ai) {
      item.aiSummary = ai;
      if (isEmpty(item.summary)) item.summary = ai; // clients without aiSummary still show it
    }
    done++;
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
  "cnn",
  "guardian",
  "washingtonpost",
  "financialexpress.com",
  "aljazeera",
  "npr",
];
const TECH_HOSTS = [
  "techcrunch",
  "theverge",
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

// Strip aggregator boilerplate (Hacker News etc.) and bare URLs from a
// description so we never display "Article URL: … Comments URL: … Points: …".
function stripUrlJunk(text: string): string {
  return (text || "")
    .replace(/Article URL:\s*\S+/gi, "")
    .replace(/Comments URL:\s*\S+/gi, "")
    .replace(/#\s*Comments?:\s*\d+/gi, "")
    .replace(/\bPoints?:\s*\d+/gi, "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function buildFallbackStories(articles: NewsDataArticle[]): StoryCard[] {
  return articles.map((a, idx) => {
    const rawText = (a.description || a.content || a.title || "").trim();
    // Drop "Article URL: … Comments URL: … Points: …" aggregator boilerplate so
    // raw links never show as the summary; falls back to the title if nothing
    // meaningful remains (e.g. a Hacker News item with only links).
    const cleaned = stripUrlJunk(rawText);
    const text = cleaned.length > 12 ? cleaned : (a.title ?? "").trim();
    const sourceName = a.source_name ?? a.source_id ?? "Unknown";
    const sourceUrl = a.link ?? "";
    const sourceType = classifySource(sourceUrl, sourceName);

    const headline = (a.title ?? text.slice(0, 90) ?? "Untitled").trim();

    return {
      id: createHash("md5").update(sourceUrl || a.article_id || `${Date.now()}-${idx}`).digest("hex").slice(0, 16),
      headline,
      category: pickCategory(a),
      imageUrl: a.image_url ?? null,
      publishedAt: a.pubDate ?? new Date().toISOString(),
      // Display summary = cleaned description only (empty if it was just links/
      // points — top cards then get an AI summary post-sort).
      summary: first50Words(cleaned),
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
        firstArticle?.description || firstArticle?.content || firstArticle?.title || "",
      ),
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
  // Exclude Hacker News — HN frontpage is curated tech links/tutorials, not breaking news.
  const breakingTechSources = TECH_RSS_SOURCES.filter(s => s.id !== "hackernews");
  for (const s of [
    ...breakingTechSources,
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
    .filter(a => {
      const text = `${a.title ?? ""} ${a.description ?? ""}`;
      return !BREAKING_LOWPRIORITY_RE.test(text);
    });

  // Score and sort by relevance + freshness
  const scored = filtered.map(a => ({ a, score: breakingScore(a) }));
  scored.sort((x, y) => y.score - x.score);

  // Require real breaking signal — freshness alone (max 8pts) cannot clear this bar.
  // Articles need a BREAKING_HIGHPRIORITY_RE match (+20) to pass.
  const recent = scored.filter(({ score }) => score >= 15).map(({ a }) => a);

  const recentDeduped = capBySource(recent, 999);
  await enrichMissingImages(recentDeduped);
  const groups = await aiClusterGroups(recentDeduped, "breaking");
  return buildMixedFeed(recentDeduped, groups, "breaking");
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

HEADLINE STYLE — write each label as a COMPLETE news headline, not a section title:
- 6-7 words. Sentence case (capitalise first word + proper nouns only).
- Must be a COMPLETE grammatical sentence — never cut off mid-thought.
- DECLARATIVE only. Never start with How/What/Will/Can/Should/Is/Are/Did/Why/Who/When/Could — use statements, not questions.
- Tell the reader WHAT HAPPENED or WHAT IS HAPPENING. Use an active verb.
- Include the key entity AND the action/outcome: "Delhi hotel fire kills three, CM honours rescue workers" not "Delhi: 3 members".
- Be specific: named parties, exact stakes, key outcome. No filler words.
- For ongoing stories use present tense: "Iran and US signal nuclear deal is within reach".
- No vague labels like "Politics", "Tech", "Updates", "Latest". No clickbait. No emoji.
- "Other" is the only allowed exception (for unrelated singletons only).

Return JSON only:
{"groups":[{"label":"<sharp label>","indices":[0,1,4]},{"label":"Other","indices":[2,3]}]}`;

    aiCallsToday++;
    console.log(`AI call #${aiCallsToday} today for ${topic}`);

    const text = await callGroq(prompt, 900, { model: GROQ_MODEL_FAST, task: "clustering" });
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
    return buildMixedFeed(rawEntry.articles, rawEntry.groups, topic);
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
  const groups = await aiClusterGroups(deduped, topic);
  rawFeedCache.set(topic, { articles: deduped, groups, at: Date.now() });
  return buildMixedFeed(deduped, groups, topic);
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
  const key = sig || (s.headline ?? "").trim().toLowerCase().slice(0, 200);
  // Include publication day so same-topic stories on different days fire independently
  const day = s.publishedAt ? new Date(s.publishedAt).toISOString().slice(0, 10) : "";
  return createHash("sha256").update(`${key}|${day}`).digest("hex");
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

  // Fetch all opted-in users once. Select only the columns this function needs
  // so a schema migration adding new columns never breaks the notification flow.
  const allPrefs = await db.select({
    token: notificationPrefsTable.token,
    breakingEnabled: notificationPrefsTable.breakingEnabled,
    aiFeedEnabled: notificationPrefsTable.aiFeedEnabled,
    topicsEnabled: notificationPrefsTable.topicsEnabled,
    topicsKeywords: notificationPrefsTable.topicsKeywords,
    favSourcesEnabled: notificationPrefsTable.favSourcesEnabled,
    favSources: notificationPrefsTable.favSources,
  }).from(notificationPrefsTable);
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
        // Detect which of the 73 themes the cluster matches so the notif
        // title reads "Breaking · <theme>" instead of just "Breaking".
        const breakingRules = themeRulesFor("breaking");
        const text = `${cluster.headline} ${articlePayload.summary}`;
        let matchedTheme: string | null = null;
        for (const r of breakingRules) {
          if (r.re.test(text)) { matchedTheme = r.name; break; }
        }
        // Backend-side theme mute: drop tokens whose user has muted this theme.
        // The pseudo-theme "Other Breaking" matches anything WITHOUT a theme,
        // letting users silence all unclassified breaking pushes in one toggle.
        const muteKey = matchedTheme ?? "Other Breaking";
        const recipients = allowed.filter(tk => !getMutedThemesForToken(tk).has(muteKey));
        if (recipients.length === 0) continue;
        const title = matchedTheme ? `Breaking · ${matchedTheme}` : "Breaking";
        await sendPushToTokens(recipients, {
          title,
          body: cluster.headline,
          data: { kind: "breaking", clusterId: cluster.id, fp, article: articlePayload },
          ...(articlePayload.imageUrl ? { richContent: { image: articlePayload.imageUrl } } : {}),
        });
        recordPushes(recipients);
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
        // Same per-theme title treatment as Main Breaking.
        const breakingRules = themeRulesFor("breaking");
        const text = `${cluster.headline} ${articlePayload.summary}`;
        let matchedTheme: string | null = null;
        for (const r of breakingRules) {
          if (r.re.test(text)) { matchedTheme = r.name; break; }
        }
        const muteKey = matchedTheme ?? "Other Breaking";
        const recipients = allowed.filter(tk => !getMutedThemesForToken(tk).has(muteKey));
        if (recipients.length === 0) continue;
        const title = matchedTheme ? `AI Feed · ${matchedTheme}` : "AI Feed · Breaking";
        await sendPushToTokens(recipients, {
          title,
          body: cluster.headline,
          data: { kind: "ai-feed", clusterId: cluster.id, fp, article: articlePayload },
          ...(articlePayload.imageUrl ? { richContent: { image: articlePayload.imageUrl } } : {}),
        });
        recordPushes(recipients);
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
    "theme-assign": "Theme tagging (collections)",
    "theme-summary": "Theme 20-word AI summary",
    "cluster-summary": "Cluster summaries (old)", "cluster-labels": "Cluster labels (For You)",
    "article-summary": "Article summary (5Ws/ELI5)", qna: "Follow-up Q&A",
    questions: "Suggested questions", qa: "Article Q&A",
    clustering: "AI clustering", other: "Other",
  };
  const MODEL_ROLE: Record<string, string> = {
    "meta-llama/llama-4-scout-17b-16e-instruct": "Deep Dive fallback (Groq)",
    "openai/gpt-oss-20b": "Q&A · clustering · Deep Dive last-resort",
    "gpt-oss-120b": "Summaries + Deep Dive (Cerebras, ~3000 tok/s)",
  };
  const KNOWN_MODELS = [
    "llama-4-scout-17b-16e-instruct",
    "llama3.1-8b",
    "meta-llama/llama-4-scout-17b-16e-instruct",
    "openai/gpt-oss-20b",
  ];
  const allModels = Array.from(new Set([...KNOWN_MODELS, ...Object.keys(aiUsageByModel)]));
  const models = allModels.map((model) => {
    const m = aiUsageByModel[model] ?? { tokens: 0, calls: 0, errors: 0, tasks: {} };
    const limit = GROQ_TPD_LIMITS[model] ?? null;
    const REQ_LIMITS: Record<string, number> = { "openai/gpt-oss-20b": 14400, "meta-llama/llama-4-scout-17b-16e-instruct": 1000, "llama-4-scout-17b-16e-instruct": 5000, "llama3.1-8b": 5000 };
    const REQ_LIMIT = REQ_LIMITS[model] ?? 1000;
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

const questionsCache = new Map<string, { questions: { text: string; accent: string }[]; ts: number }>();
const QUESTIONS_TTL_MS = 30 * 60 * 1000;

const Q_ACCENTS = ['#9b7cff', '#5b9fef', '#34c468', '#ff9a00', '#ff6b6b'];

router.get("/questions", async (req, res) => {
  const now = Date.now();
  const hit = questionsCache.get('v1');
  if (hit && now - hit.ts < QUESTIONS_TTL_MS) {
    res.json({ questions: hit.questions, cached: true }); return;
  }
  try {
    const breakingEntry = cache.get('breaking');
    if (!breakingEntry?.data?.length) { res.json({ questions: [], cached: false }); return; }
    const headlines = breakingEntry.data.slice(0, 12).map((item: any) =>
      item.clusterLabel || item.headline || item.articles?.[0]?.headline || ''
    ).filter(Boolean).slice(0, 10).join('\n');

    const prompt = `You are a curious, intelligent reader. Based on these current news headlines, generate exactly 5 probing questions that a smart person would genuinely want answered. Be specific — not "What is happening?" but "Why is Iran rushing to sign now?". Return JSON only:
{"questions":["<specific question>","<specific question>","<specific question>","<specific question>","<specific question>"]}

Headlines:
${headlines}`;

    const raw = await callGroq(prompt, 400, { model: GROQ_MODEL, task: 'questions', jsonMode: true });
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim()) as { questions?: string[] };
    const qs = (parsed.questions ?? []).filter((q): q is string => typeof q === 'string' && q.length > 0).slice(0, 5);
    const result = qs.map((text, i) => ({ text, accent: Q_ACCENTS[i % Q_ACCENTS.length] }));
    if (result.length > 0) questionsCache.set('v1', { questions: result, ts: now });
    res.json({ questions: result, cached: false });
  } catch (err) {
    req.log?.error?.({ err }, 'questions failed');
    res.json({ questions: [], error: true });
  }
});

router.get("/qa", async (req, res) => {
  const q = String(req.query['q'] ?? '').trim();
  if (!q) { res.status(400).json({ error: 'q required' }); return; }
  try {
    const breakingEntry = cache.get('breaking');
    const context = (breakingEntry?.data ?? []).slice(0, 8).map((item: any) => {
      const h = item.clusterLabel || item.headline || item.articles?.[0]?.headline || '';
      const s = item.summary || item.articles?.[0]?.summary || '';
      return `${h}. ${s}`;
    }).join('\n\n').slice(0, 1800);

    const prompt = `You are a concise news analyst. Answer the question based on recent news. Be direct and specific. 80-120 words max.

Question: ${q}

Recent news context:
${context}

Answer:`;

    const answer = await callGroq(prompt, 220, { model: GROQ_MODEL_QUALITY, task: 'qa' });
    res.json({ answer: answer.trim() });
  } catch (err) {
    req.log?.error?.({ err }, 'qa failed');
    res.status(502).json({ error: 'AI unavailable' });
  }
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
    .filter((p) => {
      if (p.length <= 80) return false;
      const words = p.split(" ").length;
      if (words <= 14) return false;
      if (BOILERPLATE_RE.test(p)) return false;
      // Drop tag-cloud / nav dumps — real prose has punctuation; keyword lists don't.
      // Fewer than 1 punctuation mark per 30 words → nav/trending ticker → skip.
      const puncts = (p.match(/[.,;:!?()"]/g) ?? []).length;
      if (words > 20 && puncts < words * 0.033) return false;
      // Drop headline mashups — long blocks where many capitalised sentences are
      // jammed together (TOI trending sidebars). Real paragraphs have < 1 new
      // sentence per 15 words; mashups have a new headline every 5-8 words.
      const sentenceStarts = (p.match(/\. [A-Z]/g) ?? []).length;
      if (words > 30 && sentenceStarts / words > 0.06) return false;
      return true;
    })
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
function toAmpUrl(_url: string): string | null {
  return null;
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
          const { paragraphs: cleaned, originalParagraphs } = cleanArticleParagraphs(
            data.paragraphs,
            undefined,
            { headline: data.title },
          );
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
// Guards for the client pre-warm herd: coalesce identical in-flight requests,
// cap concurrent Groq generations, and trip a 60s breaker on a 429 so the
// whole queue backs off instead of retrying into the same rate-limit wall.
const aiSummaryInflightMap = new Map<string, Promise<AiSummaryEntry>>();
let aiSummaryActiveCount = 0;
const AI_SUMMARY_MAX_CONCURRENT = 4;
// Article summaries now use Cerebras (separate free budget, no gate needed).

type AiSummaryType = "summary" | "fiveWs" | "eli5";

function aiPrompt(
  type: AiSummaryType,
  text: string,
  opts: { maxWords?: number; keyPoints?: number; eli5Tone?: 'kid' | 'casual' | 'plain' } = {},
): { prompt: string; maxTokens: number } {
  const maxWords = Math.max(80, Math.min(750, opts.maxWords ?? 250));
  const keyPoints = Math.max(3, Math.min(10, opts.keyPoints ?? 3));
  const eli5Tone = opts.eli5Tone ?? 'casual';
  // Map words → paragraph count for the summary prompt.
  const paraCount = maxWords < 180 ? 2 : maxWords < 320 ? 3 : 4;
  // Token budget = ~1.6x word target, plus 200 for bullets + JSON overhead.
  const summaryTokens = Math.round(maxWords * 1.6) + 250;
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
    case "eli5": {
      const toneInstruction = eli5Tone === 'kid'
        ? 'Explain like to a curious 8-year-old. Use very short words, fun analogies (toys, animals, school).'
        : eli5Tone === 'plain'
          ? 'Explain in plain English. Clear, direct, neutral. No childish analogies; just simple jargon-free sentences.'
          : 'Explain simply, like to a smart 13-year-old. Friendly conversational tone, light analogies OK.';
      return {
        maxTokens: 300,
        prompt: `${toneInstruction} Return ONLY valid JSON:
{"eli5":"<explanation in 80-100 words, simple language, no jargon>"}
Article: ${text}`,
      };
    }
    default: {
      const bulletExamples = Array.from({ length: keyPoints },
        () => '"<complete 1-2 sentence takeaway, ~30-40 words>"').join(',');
      const wordRange = `${Math.round(maxWords * 0.85)}-${Math.round(maxWords * 1.1)}`;
      return {
        maxTokens: summaryTokens,
        prompt: `You are an experienced news editor writing for an intelligent, time-pressed reader. Write a story-style summary of this article that reads like sharp journalism, not a mechanical shortening. Return ONLY a valid JSON object, no prose before or after, no markdown fences.

Schema:
{"summary":"<news-style narrative, ${wordRange} words, ${paraCount} paragraphs separated by \\n\\n. Plain journalistic prose. NO bullets, NO headers.>","bullets":[${bulletExamples}]}

Editorial rules:
- Lead with the single most important fact, not a scene-setting preamble.
- Be specific: name the people, organizations, exact figures, dates and places from the source — never vague placeholders like "officials said" or "a significant number" when the article gives you the real name or number.
- Explain WHY it matters or what happens next, not just what happened — one sentence of context or consequence beats a restated fact.
- Every sentence must add new information; never restate the same fact two different ways to fill space.
- Avoid generic AI phrasing ("in a significant development", "this comes as", "it remains to be seen") — write like a human editor, not a template.
- "bullets" are NOT a compressed rehash of the summary — each one should surface a distinct concrete detail (a figure, a quote, a name, a next step) that a skimming reader would want even if they only read the bullets.

Hard rules:
- "summary" MUST be ${wordRange} words across ${paraCount} paragraphs separated by \\n\\n.
- "bullets" array MUST have EXACTLY ${keyPoints} entries.
- Each bullet is 1-2 COMPLETE sentences, ~30-40 words — never a sentence fragment, never cut off mid-thought.

Article:
${text}`,
      };
    }
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

HEADLINE STYLE — write each label as a COMPLETE news headline, not a section title:
- 6-7 words. Sentence case (capitalise first word + proper nouns only).
- Must be a COMPLETE grammatical sentence — never cut off mid-thought.
- DECLARATIVE only. Never start with How/What/Will/Can/Should/Is/Are/Did/Why/Who/When/Could — use statements, not questions.
- Tell the reader WHAT HAPPENED or WHAT IS HAPPENING. Use an active verb.
- Include the key entity AND the action/outcome: "Delhi hotel fire kills three, CM honours rescue workers" not "Delhi: 3 members".
- Be specific: named parties, exact stakes, key outcome. No filler words.
- For ongoing stories use present tense: "Iran and US signal nuclear deal is within reach".
- No vague labels like "Politics", "Tech", "Updates", "Latest". No clickbait. No emoji.
- "Other" is the only allowed exception (for unrelated singletons only).

Return JSON only:
{"groups":[{"label":"<sharp label>","indices":[0,1,4]},{"label":"Other","indices":[2,3]}]}`;
  const text = await callGroq(prompt, 900, { model: GROQ_MODEL_FAST, task: "cluster-labels" });
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
  const { url, paragraphs, type = "summary", maxWords, keyPoints, eli5Tone } = req.body as {
    url?: string;
    paragraphs?: string[];
    type?: AiSummaryType;
    maxWords?: number;
    keyPoints?: number;
    eli5Tone?: 'kid' | 'casual' | 'plain';
  };
  if (!url || !Array.isArray(paragraphs) || paragraphs.length === 0) {
    res.status(400).json({ error: "url and paragraphs required" });
    return;
  }

  // v4 — cache key now includes maxWords + keyPoints so changing Customize
  // → summary length / key points count yields a fresh response instead of
  // serving the prior result. (Server-side previously ignored those params.)
  // v5 — include eli5Tone so kid/casual/plain yield distinct caches.
  const cacheKey = `${url}:${type}:v5:${maxWords ?? 'd'}:${keyPoints ?? 'd'}:${eli5Tone ?? 'd'}`;
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

  // Expired-but-present copy → stale-while-revalidate below: serve it
  // instantly, refresh in the background. Same pattern clusters use.
  const staleEntry = cached ?? diskCached ?? null;

  if (!process.env["GROQ_API_KEY"]) {
    res.status(502).json({ error: "AI not configured" });
    return;
  }

  // Load shedding — client pre-warm fires 40 of these per session, so without
  // guards a few concurrent sessions turn into a Groq 429 retry storm that
  // also starves Deep Dive / Q&A (shared RPM).
  // Article summaries use Cerebras (separate provider, no Groq RPM contention).
  // Coalesce: identical request already generating → share its result instead
  // of a duplicate Groq call (two users pre-warming the same story).
  const inflight = aiSummaryInflightMap.get(cacheKey);
  if (inflight) {
    if (staleEntry) { res.json({ ...staleEntry, cached: true, stale: true }); return; }
    try { res.json({ ...(await inflight), cached: true }); }
    catch { res.status(502).json({ error: "AI summary unavailable" }); }
    return;
  }
  if (aiSummaryActiveCount >= AI_SUMMARY_MAX_CONCURRENT) {
    if (staleEntry) { res.json({ ...staleEntry, cached: true, stale: true }); return; }
    res.status(503).set("Retry-After", "5").json({ error: "AI summary busy" });
    return;
  }

  const generate = (async (): Promise<AiSummaryEntry> => {
    const text = paragraphs.slice(0, 20).join(" ").slice(0, 2500);
    // Ratio guard — a summary must be meaningfully shorter than its source or
    // the model pads/hallucinates to hit the word target. Cap at ~45% of the
    // article, floor 60 words so tiny articles still get a usable summary.
    // Long articles (800+ words) honor the user's Customize setting untouched.
    const sourceWords = text.split(/\s+/).filter(Boolean).length;
    const ratioCap = Math.max(60, Math.round(sourceWords * 0.45));
    const effectiveMaxWords = Math.min(maxWords ?? 250, ratioCap);
    const effectiveKeyPoints = sourceWords < 150 ? Math.min(keyPoints ?? 3, 2) : keyPoints;
    const { prompt, maxTokens } = aiPrompt(type as AiSummaryType, text, { maxWords: effectiveMaxWords, keyPoints: effectiveKeyPoints, eli5Tone });
    let raw = "{}";
    let cerebrasNote = "";
    // 30s abort — without it a hung provider held the request until the
    // client gave up (Deep Dive always had one; summaries didn't).
    const ctrl = new AbortController();
    const abortTimer = setTimeout(() => ctrl.abort(), 30000);
    try {
      if (process.env["CEREBRAS_API_KEY"]) {
        try {
          raw = (await callCerebras(prompt, maxTokens, { task: "article-summary", signal: ctrl.signal })) || "{}";
        } catch (cerebrasErr) {
          cerebrasNote = cerebrasErr instanceof Error ? cerebrasErr.message : String(cerebrasErr);
          req.log.warn({ err: cerebrasNote }, "ai-summary: Cerebras failed, falling back to Groq");
          raw = (await callGroq(prompt, maxTokens, { model: GROQ_MODEL, task: "article-summary", jsonMode: true, signal: ctrl.signal })) || "{}";
        }
      } else {
        raw = (await callGroq(prompt, maxTokens, { model: GROQ_MODEL, task: "article-summary", jsonMode: true, signal: ctrl.signal })) || "{}";
      }
    } finally {
      clearTimeout(abortTimer);
    }

    let parsed: { bullets?: string[]; summary?: string; fiveWs?: string[]; eli5?: string } = {};
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

    const result: AiSummaryEntry = {
      at: Date.now(),
      bullets: Array.isArray(parsed.bullets) ? parsed.bullets.slice(0, 12) : [],
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      fiveWs: Array.isArray(parsed.fiveWs) ? parsed.fiveWs.slice(0, 5) : [],
      eli5: typeof parsed.eli5 === "string" ? parsed.eli5 : "",
    };

    // Only cache if the result is genuinely useful. For "summary" we now
    // REQUIRE the narrative `summary` field to be meaningful — bullets-only
    // responses are treated as failures so the next request retries against
    // Groq instead of serving a poisoned cache for 24h.
    const hasContent = (type === "summary" && result.summary.length > 100)
      || (type === "fiveWs" && result.fiveWs.length >= 3)
      || (type === "eli5" && result.eli5.length > 30);
    if (hasContent) {
      aiSummaryCache.set(cacheKey, result);
      safeWriteJson(diskPath, result);
    }
    return result;
  })();

  aiSummaryActiveCount++;
  aiSummaryInflightMap.set(cacheKey, generate);
  // Stale-while-revalidate: expired copy goes out instantly; the refresh
  // continues in the background and lands in cache for the next request.
  if (staleEntry) {
    generate.catch(() => {}).finally(() => {
      aiSummaryActiveCount--;
      aiSummaryInflightMap.delete(cacheKey);
    });
    res.json({ ...staleEntry, cached: true, stale: true });
    return;
  }
  try {
    const result = await generate;
    res.json({ ...result, cached: false });
  } catch (err) {
    req.log.error({ err }, "ai-summary failed");
    res.status(502).json({ error: "AI summary unavailable" });
  } finally {
    aiSummaryActiveCount--;
    aiSummaryInflightMap.delete(cacheKey);
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
  quote: { text: string; by: string } | null;
  insight: string;
  questions: string[];
  tags: string[];
  keyPeople: string[];
  keyCompanies: string[];
  topics: string[];
  articlesRead: number;
  articlesAttempted: number;
  confidence: number;
}
const deepDiveCache = new Map<string, DeepDiveResult>();
const DEEPDIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
// Coalesce concurrent generations of the same dive: the client pre-warm and a
// user's card view often request the same url+depth seconds apart — without
// this, both paid a full 20-40s Groq generation.
const deepDiveInflight = new Map<string, Promise<DeepDiveResult>>();

// Fetch + extract the full readable text of one article. Returns "" on failure
// (paywall, JS-only page, timeout) so callers can fall back to summaries.
// TOI (and some other Indian publishers) append trending-topic tickers +
// site-nav dumps after the article body. Truncate at the first occurrence.
const PUBLISHER_JUNK_STOP_RE =
  /\bHeadlines\s+Sports\s+News\b|\bBusiness\s+News\s+India\s+News\b|\bTOI\s+Home\s+Decor\b|\bIs\s+Bank\s+Open\s+Today\b|\bGold\s+Rate\s+Today\b|\bPetrol\s+Price\s+Today\b|\bCricbuzz\b|\bNewspaper\s+Subscription\b|\bFood\s+News\s+TV\b|\bTimes\s+Life\s+Times\b|\bLifestyle\s+Newspaper\b/;

async function fetchArticleText(u: string): Promise<string> {
  try {
    const html = await fetchArticleHtml(u);
    const { bodyHtml } = extractArticleBody(html);
    let paras = htmlToParagraphs(bodyHtml);
    if (paras.length < 2) paras = htmlToParagraphs(html);
    // Truncate at publisher navigation/tag-cloud footer
    const cutIdx = paras.findIndex(p => PUBLISHER_JUNK_STOP_RE.test(p));
    if (cutIdx > 0) paras = paras.slice(0, cutIdx);
    return paras.join("\n\n").trim();
  } catch {
    return "";
  }
}

// ── Confidence scoring helpers ───────────────────────────────────────────────
// Tier-1: gold-standard wire services / major nationals.
// Tier-2: reputable regional / sector outlets.
const TRUSTED_T1 = new Set([
  'reuters.com','bloomberg.com','apnews.com','bbc.co.uk','bbc.com',
  'nytimes.com','theguardian.com','ft.com','wsj.com','economist.com',
  'washingtonpost.com','ap.org',
]);
const TRUSTED_T2 = new Set([
  'thehindu.com','indianexpress.com','hindustantimes.com','ndtv.com',
  'economictimes.indiatimes.com','livemint.com','theprint.in','scroll.in',
  'cnbc.com','cnn.com','aljazeera.com','npr.org','techcrunch.com',
  'theverge.com','arstechnica.com','wired.com','forbes.com','time.com',
]);

function credibilityScore(urls: string[]): number {
  for (const u of urls) {
    try {
      const host = new URL(u).hostname.replace(/^www\./, '');
      if (TRUSTED_T1.has(host)) return 1.0;
    } catch {}
  }
  let t2 = 0;
  for (const u of urls) {
    try {
      const host = new URL(u).hostname.replace(/^www\./, '');
      if (TRUSTED_T2.has(host)) t2++;
    } catch {}
  }
  if (t2 >= 2) return 0.8;
  if (t2 === 1) return 0.55;
  return 0.25; // unknown sources
}

function ageScore(publishedAt?: string): number {
  if (!publishedAt) return 0.5;
  const ageHrs = (Date.now() - new Date(publishedAt).getTime()) / 3_600_000;
  if (ageHrs < 0.5) return 0.1;   // < 30 min: still breaking, few cross-checks
  if (ageHrs < 1)   return 0.3;
  if (ageHrs < 3)   return 0.6;
  if (ageHrs < 6)   return 0.8;
  if (ageHrs < 12)  return 0.95;
  return 1.0;                       // 12 h+: well-corroborated
}

router.post("/deepdive", async (req, res) => {
  const { url, headline, paragraphs, sourceUrls, depth: rawDepth, publishedAt } = req.body as {
    url?: string;
    headline?: string;
    paragraphs?: string[];
    sourceUrls?: string[];
    depth?: 'quick' | 'standard' | 'deep';
    publishedAt?: string;
  };
  if (!url || !Array.isArray(paragraphs) || paragraphs.length === 0) {
    res.status(400).json({ error: "url and paragraphs required" });
    return;
  }
  const depth: 'quick' | 'standard' | 'deep' =
    rawDepth === 'quick' || rawDepth === 'deep' ? rawDepth : 'standard';

  // v12 — 4-signal confidence: grounding + credibility + diversity + age
  const cacheKey = `deepdive:v17:${depth}:${url}`;
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

  // Join an in-flight generation of the same dive instead of starting another.
  const inflight = deepDiveInflight.get(cacheKey);
  if (inflight) {
    try { res.json({ ...(await inflight), cached: true }); }
    catch { res.status(502).json({ error: "Deep Dive unavailable" }); }
    return;
  }

  const gen = (async (): Promise<DeepDiveResult> => {
    // RICHER INPUT: for a multi-source story, READ THE FULL TEXT OF EVERY SOURCE
    // (capped for latency/tokens), not just the short summaries the app already
    // has. Each source is fetched in parallel; any that block (paywall/JS-only)
    // fall back to their summary. This is what makes the synthesis genuinely
    // "read all the articles".
    const MAX_FETCH = 5;
    const urlsToRead = Array.from(new Set([url, ...(Array.isArray(sourceUrls) ? sourceUrls : [])].filter(Boolean))).slice(0, MAX_FETCH) as string[];
    const fetched = await Promise.all(
      urlsToRead.map(async (u) => {
        let host = u;
        try { host = new URL(u).hostname.replace(/^www\./, ""); } catch { /* keep url */ }
        const body = await fetchArticleText(u);
        return { host, body };
      }),
    );
    // Cross-article dedup: remove wire-copy sentences reprinted across sources
    const substantiveFetched = fetched.filter((f) => f.body.length > 200);
    try {
      if (substantiveFetched.length > 1) {
        const dedupedBodies = deduplicateCrossArticle(substantiveFetched.map((f) => f.body));
        dedupedBodies.forEach((body, i) => { substantiveFetched[i].body = body; });
      }
    } catch {
      // dedup failed — proceed with original bodies
    }

    const fullArticles = substantiveFetched
      .map((f) => `=== FULL ARTICLE (${f.host}) ===\n${f.body.slice(0, 8000)}`)
      .join("\n\n");
    const summaries = paragraphs.slice(0, 40).join("\n");
    const sourceCount = fetched.filter(f => f.body.length > 200).length;
    const text = (
      fullArticles.length > 200
        ? `You have the FULL text of ${sourceCount} source article(s) covering the SAME story, plus short summaries from any sources that couldn't be fetched. Read them ALL.\n\n${fullArticles}\n\n=== OTHER SOURCE SUMMARIES ===\n${summaries}`
        : summaries
    ).slice(0, 20000);
    const diffAnglesInstruction = sourceCount <= 1
      ? `"DIFFERENT ANGLES"  — ONLY analyse the FRAMING and TONE of the single source and the key questions it leaves UNANSWERED. CRITICAL: do NOT mention or imply "various outlets", "different sources", "covered differently by outlets", or suggest multiple sources exist. There is only ONE source — write accordingly.`
      : `"DIFFERENT ANGLES"  — ONLY a META-COMMENTARY on the COVERAGE itself — do NOT restate story facts here. Contrast what each named outlet EMPHASISES, frames, or omits (e.g. "Reuters leads on the financial penalty; the BBC frames it as legal precedent; Indian outlets centre the Indian victims"). If all excerpts are one outlet/very similar, instead analyse the framing/tone used and the key questions left UNANSWERED.`;
    // Depth targets are baked directly INTO the JSON schema below. They used to
    // live in a "DEPTH OVERRIDE" note at the very END of the (16k-char) prompt,
    // AFTER "Respond with JSON only." — the model followed the inline word
    // counts in the schema and ignored the trailing note, so quick/standard/deep
    // produced identical lengths.
    //
    // Ratio guard — same principle as ai-summary: output must stay under the
    // source material or the model pads sections 4-5 (context/what's-next)
    // with invented history and predictions. Deep Dive synthesises across 5
    // sections so it may run closer to source length than a summary (0.9x),
    // but never past it. Rich sources (>= depth max / 0.9) are unaffected.
    const sourceWords = text.split(/\s+/).filter(Boolean).length;
    const depthMax = depth === 'quick' ? 480 : depth === 'deep' ? 1100 : 900;
    const depthMin = depth === 'quick' ? 250 : depth === 'deep' ? 700 : 450;
    const storyMax = Math.min(depthMax, Math.max(250, Math.round(sourceWords * 0.9)));
    const thinSource = sourceWords < 600;
    // Thin source: no minimum — "shorter than target" must beat "padded".
    const storyMin = thinSource ? 0 : Math.min(depthMin, Math.round(storyMax * 0.6));
    // Very thin source (< 300 words): 3 sections — DIFFERENT ANGLES and
    // CONTEXT & BACKGROUND need material to analyse; with none they invent.
    const sectionCount = sourceWords < 300 ? 3 : 5;
    const perHi = Math.round(storyMax / sectionCount);
    const perLo = Math.max(35, Math.round(perHi * 0.55));
    const storyWords = `~${perLo}-${perHi} words`;
    const storyTotal = storyMin > 0
      ? `TOTAL ${storyMin}-${storyMax} words (hard cap ${storyMax})`
      : `TOTAL at most ${storyMax} words (hard cap) — the source is short, so shorter and accurate beats longer and padded; NEVER pad to fill`;
    const tldrBullets = depth === 'quick' ? 'EXACTLY 2-3' : 'EXACTLY 3-4';
    const tldrCap = Math.min(depth === 'quick' ? 280 : 450, Math.max(150, Math.round(sourceWords * 0.6)));
    const tldrTotal = `~${Math.round(tldrCap * 0.85)}-${tldrCap} words (hard cap ${tldrCap})`;
    const qCount = depth === 'quick' ? 'EXACTLY 3' : '3-4';
    const prompt = `You are transforming news coverage into a structured, AI-native "story understanding" experience. Length mode for this request: "${depth.toUpperCase()}" — every word target below is calibrated for this mode; obey them strictly. The input may include the FULL lead article followed by short summaries from other sources (each tagged like "[Source Name]:"). READ ALL of it and respond with ONLY valid JSON (no markdown, no prose) matching this exact shape:

{
  "tldrSections": [                                    // 2-3 grouped sections. Each section: SHORT all-caps thematic heading (4-8 words) + ${tldrBullets} bullets. Each bullet is 1-2 COMPLETE sentences (~30-45 words) — a self-contained, well-summarised thought that ALWAYS ends with proper punctuation; NEVER a sentence fragment and NEVER cut off mid-sentence. TOTAL words across ALL sections+bullets should be ${tldrTotal} — be thorough but don't pad. First section = the core event. Second = context / reactions / why it matters. Optional third = stakes / what's next. Bold key entities + figures inline with ** (e.g. "**Pakistan** signed a **$1.2M** deal").
    { "heading": "CORE EVENT", "bullets": ["complete 1-2 sentence summary.", "complete 1-2 sentence summary.", "complete 1-2 sentence summary."] },
    { "heading": "CONTEXT & WHY IT MATTERS", "bullets": ["complete 1-2 sentence summary.", "complete 1-2 sentence summary.", "complete 1-2 sentence summary."] }
  ],
  "tldr": ["flat fallback — 6-10 complete-sentence bullets, same ${tldrTotal} cap"],
  "storySections": [                                   // THE FULL STORY. EXACTLY these ${sectionCount} sections, IN THIS ORDER. Each "body" = ONE well-developed paragraph (${storyWords}) of engaging plain prose (no markdown). ${storyTotal}. Attribute specific facts to their source inline in parentheses using the [Source] tags, e.g. "...228 died (Reuters)."
    // ── ABSOLUTE RULE: ZERO REPETITION. Each section must contain information that appears in NO other section. NEVER restate a fact, figure, name, quote or sentence you already used. If a section would repeat something, REPLACE it with new detail, analysis, or implication. A reader must learn something NEW in every section. Vary sentence openings; do not start multiple sections the same way.
    // ── GROUNDING RULE: every fact, figure, name and event must come from the source text. For background/history/what's-next, use ONLY what the sources state or directly imply; if the sources give no history or next steps, SAY what is unknown or pending rather than inventing it. Never import outside knowledge that the sources don't mention.
    // Each section has a STRICT, NON-OVERLAPPING scope:
    //   1. "WHAT HAPPENED"     — ONLY the single core event in 2-3 sentences: who did what, the headline outcome. No numbers-dump, no background, no consequences. The spine, nothing else.
    //   2. "THE DETAILS"       — ONLY concrete specifics NOT in section 1: exact figures, dates, the sequence of events, names/titles, locations, the mechanism/how. Pure factual texture. No consequences, no framing. FACT-DENSITY RULE: this section must include EVERY distinct concrete fact from the sources — every number, amount, percentage, date, deadline, name, title, place and direct quote that fits. Prefer packing more facts over smoother prose; it may run up to ${depth === 'quick' ? '120' : '220'} words if the sources are fact-rich. NEVER drop a specific figure in favour of a vague phrase ("millions" when a source says "$4.2M").
${sectionCount === 5 ? `    //   3. ${diffAnglesInstruction}
    //   4. "CONTEXT & BACKGROUND" — ONLY history and the bigger picture AS GIVEN IN THE SOURCES: prior events, how we got here, precedent, the pattern this fits, stakes for the wider field. NO restating today's event.
    //   5. "WHAT'S NEXT"       — ONLY the forward look: concrete expected next steps, pending decisions, appeals, timelines, awaited reactions, what to watch. Future tense only; no recap.
    { "heading": "WHAT HAPPENED", "body": "one paragraph" },
    { "heading": "THE DETAILS", "body": "one paragraph" },
    { "heading": "DIFFERENT ANGLES", "body": "one paragraph" },
    { "heading": "CONTEXT & BACKGROUND", "body": "one paragraph" },
    { "heading": "WHAT'S NEXT", "body": "one paragraph" }` : `    //   3. "WHAT'S NEXT"       — ONLY the forward look stated or implied by the sources: expected next steps, pending decisions, timelines, what to watch. If the sources name none, say what remains unknown. Future tense only; no recap.
    { "heading": "WHAT HAPPENED", "body": "one paragraph" },
    { "heading": "THE DETAILS", "body": "one paragraph" },
    { "heading": "WHAT'S NEXT", "body": "one paragraph" }`}
  ],
  "quote": {"text": "...", "by": "..."},               // REQUIRED — ONE notable DIRECT quote from the sources, VERBATIM (no paraphrase), with the speaker's full name and title in "by" (e.g. "Sundar Pichai, CEO of Google"). Pick the most striking, newsworthy on-record line. Search the full text thoroughly for quoted speech (words inside quotation marks with attribution). Only return null if the text genuinely contains ZERO direct quotes — this is rare, so try hard to find one.
  "insight": "...",                                    // ONE sharp takeaway sentence: why this matters or what to watch. Max 32 words.
  "questions": ["...", "...", "...", "..."],           // ${qCount} conversational follow-up questions a curious reader would ask. Mix article-specific and broader context questions. Each ends with "?"
  "tags": ["...", "...", "..."],                       // 4-7 short noun-phrase entity/topic tags (e.g. "Federal Reserve", "Interest Rates", "Inflation"). Use exact names that appear in the text.
  "keyPeople": ["..."],                                // named individuals mentioned (full names). May be empty if none.
  "keyCompanies": ["..."],                             // organisations, companies, agencies, political parties. May be empty.
  "topics": ["..."]                                    // broader topics / themes (e.g. "Monetary Policy", "AI Safety"). 3-6 items.
}

Headline: ${headline ?? "(no headline)"}

Article:
${text}

Respond with JSON only. REMINDER: length mode is "${depth.toUpperCase()}" — each storySection body must be ${storyWords}; count your words.`;

    // Retry once on transient network failure.
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 90000);
    let raw = "";
    try {
      // Cerebras gpt-oss-120b primary → Groq Scout → Groq gpt-oss-20b
      try {
        if (process.env["CEREBRAS_API_KEY"]) {
          raw = await callCerebras(prompt, 6000, { signal: ctrl.signal, temperature: 0.45, task: "deepdive" });
        } else {
          await deepDiveGate();
          raw = await callGroq(prompt, 6000, { signal: ctrl.signal, temperature: 0.45, task: "deepdive" });
        }
      } catch (firstErr) {
        req.log.warn({ err: firstErr instanceof Error ? firstErr.message : String(firstErr) }, "deepdive: primary failed, falling back to Groq");
        try {
          await deepDiveGate();
          raw = await callGroq(prompt, 6000, { signal: ctrl.signal, temperature: 0.45, task: "deepdive" });
        } catch {
          raw = await callGroq(prompt, 6000, { signal: ctrl.signal, temperature: 0.45, model: GROQ_MODEL_FAST, task: "deepdive" });
        }
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

    const articlesRead = fetched.filter((f) => f.body.length > 200).length;
    // 4-signal confidence score (0-100):
    //   40% grounding    — fraction of source URLs where full text was fetched
    //   20% credibility  — tier-1/tier-2 source presence (Reuters, BBC, etc.)
    //   20% diversity    — distinct source count (capped at 5)
    //   20% age          — older stories have had time to be cross-verified
    const grounding   = urlsToRead.length > 0 ? (articlesRead / urlsToRead.length) : 0;
    const diversity   = Math.min(urlsToRead.length, 5) / 5;
    const credibility = credibilityScore(urlsToRead);
    const age         = ageScore(publishedAt);
    const confidence  = Math.round(grounding * 40 + credibility * 20 + diversity * 20 + age * 20);
    const result: DeepDiveResult = {
      at: Date.now(),
      tldr: flatTldr,
      tldrSections,
      narrative,
      storySections,
      quote: (parsed.quote && typeof parsed.quote === "object" && typeof (parsed.quote as { text?: unknown }).text === "string" && (parsed.quote as { text: string }).text.trim().length > 10)
        ? { text: String((parsed.quote as { text: string }).text).slice(0, 400), by: String((parsed.quote as { by?: unknown }).by ?? "").slice(0, 120) }
        : null,
      insight: typeof parsed.insight === "string" ? parsed.insight : "",
      questions: Array.isArray(parsed.questions) ? parsed.questions.slice(0, 5).map(String) : [],
      tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 8).map(String) : [],
      keyPeople: Array.isArray(parsed.keyPeople) ? parsed.keyPeople.slice(0, 12).map(String) : [],
      keyCompanies: Array.isArray(parsed.keyCompanies) ? parsed.keyCompanies.slice(0, 10).map(String) : [],
      topics: Array.isArray(parsed.topics) ? parsed.topics.slice(0, 8).map(String) : [],
      articlesRead,
      articlesAttempted: urlsToRead.length,
      confidence,
    };

    // Return whatever we got — even partial data is useful. Only fail on total emptiness.
    if (!result.tldr.length && !result.narrative && !result.insight && !result.questions.length) {
      req.log.error({ raw: raw.slice(0, 500) }, "deepdive: empty parse");
      throw new Error("AI returned no parseable content");
    }

    deepDiveCache.set(cacheKey, result);
    safeWriteJson(diskPath, result);
    return result;
  })();

  deepDiveInflight.set(cacheKey, gen);
  try {
    res.json({ ...(await gen), cached: false });
  } catch (err) {
    req.log.error({ err: err instanceof Error ? err.message : String(err) }, "deepdive failed");
    res.status(502).json({ error: "Deep Dive unavailable" });
  } finally {
    deepDiveInflight.delete(cacheKey);
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
      // Cerebras primary (fast, separate RPM pool) → Groq gpt-oss-20b fallback
      if (process.env["CEREBRAS_API_KEY"]) {
        try { answer = (await callCerebras(prompt, 600, { signal: ctrl.signal, temperature: 0.5, task: "qna" })).trim(); }
        catch { answer = (await callGroq(prompt, 600, { signal: ctrl.signal, temperature: 0.5, model: GROQ_MODEL_QUALITY, task: "qna" })).trim(); }
      } else {
        try { answer = (await callGroq(prompt, 600, { signal: ctrl.signal, temperature: 0.5, model: GROQ_MODEL_QUALITY, task: "qna" })).trim(); }
        catch { await new Promise(r => setTimeout(r, 600)); answer = (await callGroq(prompt, 600, { signal: ctrl.signal, temperature: 0.5, model: GROQ_MODEL_QUALITY, task: "qna" })).trim(); }
      }
    } finally { clearTimeout(t); }
    if (!answer) throw new Error("Empty answer");

    const entry: AskCacheEntry = { at: Date.now(), answer };
    askCache.set(cacheKey, entry);
    safeWriteJson(diskPath, entry);
    res.json({ answer, cached: false });
  } catch (err) {
    req.log.error({ err: err instanceof Error ? err.message : String(err) }, "ask failed");
    res.status(502).json({ error: "Q&A unavailable" });
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

// ── /muted-themes ───────────────────────────────────────────────────────────
// Per-token muted breaking themes. Client POSTs whenever the user toggles a
// theme; backend uses this to drop push recipients before sending.
router.post("/muted-themes", (req, res) => {
  const { token, themes } = (req.body ?? {}) as { token?: string; themes?: string[] };
  if (!token || typeof token !== "string") {
    res.status(400).json({ error: "token required" });
    return;
  }
  const list = Array.isArray(themes)
    ? themes.filter((t): t is string => typeof t === "string").slice(0, 200)
    : [];
  setMutedThemesForToken(token, list);
  res.json({ ok: true, count: list.length });
});

// ── /notif-history ──────────────────────────────────────────────────────────
// Per-token notification log. Used by Android to backfill local history with
// pushes that landed while the app was killed, and by Web to mirror Android
// via a pair code (the user's Expo push token).
router.get("/notif-history", (req, res) => {
  const token = String(req.query.token ?? "").trim();
  const sinceRaw = String(req.query.since ?? "0");
  const since = Number.isFinite(Number(sinceRaw)) ? Number(sinceRaw) : 0;
  const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 200)));
  if (!token) {
    res.status(400).json({ error: "token required" });
    return;
  }
  // Accept either the full Expo token or its short pair-code form (last 12).
  // For now we require the full token; pair-code lookup would need an index.
  const entries = getNotifHistoryForToken(token, limit)
    .filter((e) => e.firedAt > since);
  res.json({ entries });
});

export default router;
