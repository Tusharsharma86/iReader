import { Router, type IRouter } from "express";
import { ai } from "@workspace/integrations-gemini-ai";

const router: IRouter = Router();

type Source = {
  name: string;
  url: string;
  type: "mainstream" | "tech" | "niche";
};

type StoryCard = {
  id: string;
  headline: string;
  category: string;
  imageUrl: string | null;
  publishedAt: string;
  summaries: {
    fiveWs: string[];
    eli5: string[];
    keyHighlights: string[];
  };
  sources: Source[];
  sourceCount: number;
};

type CacheEntry = { at: number; data: StoryCard[] };
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 10 * 60 * 1000;

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
    eli5: string[];
    keyHighlights: string[];
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
3. Write THREE summary modes — each as bullet point arrays. ANTI-FLUFF rules: NO repetitive paragraphs, NO redundant background, NO filler phrases ("In a world where...", "It is important to note..."). Only unique, high-density facts. Each bullet 12-22 words.
   - "fiveWs": 5 bullets answering Who, What, When, Where, Why (in that order, prefix-free).
   - "eli5": 3 bullets explaining the story like the reader is 11. Plain language, concrete analogies.
   - "keyHighlights": 4-5 bullets with the most newsworthy facts, numbers, quotes, or implications.
4. For each source in the cluster, classify its type: "mainstream" (e.g. Reuters, BBC, AP, NYT, CNN, WSJ, Bloomberg, Guardian), "tech" (e.g. TechCrunch, The Verge, Ars Technica, Wired, Engadget, 9to5Mac), or "niche" (specialty/regional/independent blogs).

Return STRICT JSON ONLY matching this TypeScript type:
{
  "clusters": [
    {
      "headline": string,
      "category": string,
      "article_indexes": number[],
      "fiveWs": string[],
      "eli5": string[],
      "keyHighlights": string[],
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
      maxOutputTokens: 8192,
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
        eli5: cluster.eli5 ?? [],
        keyHighlights: cluster.keyHighlights ?? [],
      },
      sources,
      sourceCount: sources.length,
    };
  });
}

router.get("/feed", async (req, res) => {
  const topic = String(req.query["topic"] ?? "top").toLowerCase();
  const refresh = req.query["refresh"] === "1";

  const cached = cache.get(topic);
  if (!refresh && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    res.json({ stories: cached.data, cached: true });
    return;
  }

  try {
    const articles = await fetchNewsData(topic);
    if (articles.length === 0) {
      res.json({ stories: [], cached: false });
      return;
    }
    const clusters = await clusterAndSummarize(articles);
    const stories = buildStoryCards(articles, clusters);
    cache.set(topic, { at: Date.now(), data: stories });
    res.json({ stories, cached: false });
  } catch (err) {
    req.log.error({ err }, "feed failed");
    if (cached) {
      res.json({ stories: cached.data, cached: true, stale: true });
      return;
    }
    res.status(500).json({
      error: err instanceof Error ? err.message : "Unknown error",
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
