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

export default router;
