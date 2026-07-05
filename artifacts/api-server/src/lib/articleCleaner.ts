/**
 * Non-AI article cleaning pipeline.
 * Steps:
 *  1. Boilerplate stripping (33 patterns + attribution bylines)
 *  2. Headline echo removal — drops first sentence if it restates the title
 *  3. Sentence-level near-dedup (Jaccard ≥ 0.80 OR TF-IDF cosine ≥ 0.75)
 *  4. Caption removal
 *  5. 2500-word safety cap (mega-pages only)
 *
 * TextRank + MMR selection + 500-word cap were removed: they summarised
 * rather than cleaned, so the "Full Article" tab silently showed at most
 * 500 cherry-picked words. Summarisation belongs to the Summary tab.
 */

// ── Step 1: boilerplate patterns ────────────────────────────────────────────

const BOILERPLATE_PATTERNS: RegExp[] = [
  /subscribe\s+(to|for)\s+(our|the|this)/i,
  /sign\s+up\s+for\s+(our|the|this|free)/i,
  /newsletter/i,
  /click\s+here\s+to\s+(read|subscribe|learn|see|view)/i,
  /read\s+more\s*(:|at|on|in|about)?/i,
  /also\s+read\s*:/i,
  /follow\s+us\s+on/i,
  /share\s+this\s+article/i,
  /copyright\s+\d{4}/i,
  /all\s+rights?\s+reserved/i,
  /terms\s+of\s+(use|service)/i,
  /privacy\s+policy/i,
  /cookie\s+(policy|notice|consent)/i,
  /advertisement/i,
  /sponsored\s+(content|by|post)/i,
  /this\s+article\s+(first\s+appeared|was\s+(originally\s+)?published)/i,
  /originally\s+published\s+(in|on|at|by)/i,
  /reprinted\s+(with|by)\s+permission/i,
  /related\s+articles?\s*:/i,
  /you\s+may\s+also\s+like/i,
  /recommended\s+for\s+you/i,
  /most\s+read\s*:/i,
  /trending\s+(now|stories)/i,
  /watch\s+(the\s+)?video\s*(:|above|below)?/i,
  /loading\s*\.\.\./i,
  /^\s*(get|have)\s+the\s+(latest|best|top)\s+news/i,
  /join\s+our\s+(mailing\s+list|community)/i,
  /\[?\s*file\s+photo\s*\]?/i,
  /\[?\s*representational\s+image\s*\]?/i,
  /\[?\s*image\s+courtesy\s*:?/i,
  /photo\s+credit\s*:/i,

  // ── Attribution bylines ────────────────────────────────────────────────────
  /^reporting\s+by\s+[\w\s,;.()]+$/i,
  /^editing\s+by\s+[\w\s,;.()]+$/i,
  /^writing\s+by\s+[\w\s,;.()]+$/i,
  /^written\s+by\s+[\w\s,;.()]+$/i,
  /^compiled\s+by\s+[\w\s,;.()]+$/i,
  /^additional\s+reporting\s+by\s+.{1,120}$/i,
  /^with\s+(additional\s+)?(reporting|inputs?|contributions?)\s+(by|from)\s+.{1,120}$/i,
  /^our\s+standards?\s*:\s*the\s+thomson\s+reuters/i,
  /^\(?(?:ap|afp|pti|ani|ians|reuters|bloomberg|xinhua)\)?\.?$/i,
  /^\((?:ap|afp|pti|ani|ians|reuters|bloomberg)\)\.?$/i,
];

function isBoilerplate(sentence: string): boolean {
  const s = sentence.trim();
  if (!s) return true;
  return BOILERPLATE_PATTERNS.some((re) => re.test(s));
}

// ── Caption heuristics ───────────────────────────────────────────────────────

function isCaption(sentence: string): boolean {
  const s = sentence.trim();
  const wordCount = s.split(/\s+/).length;
  if (wordCount <= 6 && /:\s*$/.test(s)) return true;
  if (/^(photo|image|picture|illustration|graphic|afp|ap|pti|reuters|ani|ians)\s*:/i.test(s)) return true;
  if (/^\(.*\)$/.test(s) && wordCount <= 10) return true;
  return false;
}

// ── Stopwords ────────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'a','an','the','and','or','but','nor','so','yet','both','either','neither',
  'whether','if','unless','until','while','although','though','because','since',
  'as','than','then','when','where','which','who','whom','whose','that','what',
  'this','these','those','it','its','i','we','you','he','she','they','them',
  'their','our','your','his','her','my','me','us','him','himself','herself',
  'itself','themselves','ourselves','yourself','yourselves','myself',
  'is','are','was','were','be','been','being','have','has','had','do','does',
  'did','will','would','could','should','may','might','shall','must','ought',
  'am','can','need','dare','used',
  'in','on','at','by','for','with','about','against','between','into',
  'through','during','before','after','above','below','from','up','down',
  'of','to','off','over','under','again','further','once','out','not',
  'no','nor','only','own','same','too','very','just','also','even','still',
  'already','always','never','often','here','there','now','more','most',
  'other','another','each','every','all','any','few','some','such','new',
  'per','via','re','vs','ie','eg','etc',
]);

// ── Stemmer (lightweight suffix stripping) ───────────────────────────────────

function stem(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith('tion') && word.length > 6) return word.slice(0, -4);
  if (word.endsWith('ness') && word.length > 6) return word.slice(0, -4);
  if (word.endsWith('ment') && word.length > 6) return word.slice(0, -4);
  if (word.endsWith('ful') && word.length > 5) return word.slice(0, -3);
  if (word.endsWith('less') && word.length > 6) return word.slice(0, -4);
  if (word.endsWith('ing') && word.length > 5) return word.slice(0, -3);
  if (word.endsWith('ied')) return word.slice(0, -3) + 'y';
  if (word.endsWith('ies') && word.length > 4) return word.slice(0, -3) + 'y';
  if (word.endsWith('ers') && word.length > 5) return word.slice(0, -3);
  if (word.endsWith('er') && word.length > 4) return word.slice(0, -2);
  if (word.endsWith('ed') && word.length > 4) return word.slice(0, -2);
  if (word.endsWith('ly') && word.length > 4) return word.slice(0, -2);
  if (word.endsWith('s') && word.length > 4 && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

// ── Token helpers ────────────────────────────────────────────────────────────

/** Raw token set — used for Jaccard (no stopword/stem filtering). */
function tokenise(s: string): Set<string> {
  return new Set(
    s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean),
  );
}

/**
 * Content-bearing token array — stopwords removed, stems applied.
 * Used for TF-IDF / cosine similarity and TextRank.
 */
function tokeniseArr(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(stem);
}

// ── TF-IDF + cosine similarity ───────────────────────────────────────────────

/** Smoothed IDF: log((N+1)/(df+1)) + 1 (sklearn-style). */
function buildIdf(tokenArrays: string[][]): Map<string, number> {
  const N = tokenArrays.length;
  const df = new Map<string, number>();
  for (const tokens of tokenArrays) {
    for (const t of new Set(tokens)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const idf = new Map<string, number>();
  for (const [term, freq] of df) {
    idf.set(term, Math.log((N + 1) / (freq + 1)) + 1);
  }
  return idf;
}

function tfidfVec(tokens: string[], idf: Map<string, number>): Map<string, number> {
  if (tokens.length === 0) return new Map();
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  const vec = new Map<string, number>();
  for (const [term, count] of tf) {
    vec.set(term, (count / tokens.length) * (idf.get(term) ?? 1));
  }
  return vec;
}

function cosineSim(a: Map<string, number>, b: Map<string, number>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let dot = 0, normA = 0;
  for (const [term, val] of a) {
    dot += val * (b.get(term) ?? 0);
    normA += val * val;
  }
  let normB = 0;
  for (const val of b.values()) normB += val * val;
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ── Jaccard (kept for exact/short sentence dedup) ────────────────────────────

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ── Step 2 (headline echo) ────────────────────────────────────────────────────

/**
 * Drops the first sentence if it is a near-restatement of the article title.
 * Wire articles (Reuters/AP) almost always open with the headline verbatim.
 * Threshold: cosine ≥ 0.65 (deliberately lenient — stems+stopword removal
 * shrinks vectors so even exact echoes score ~0.70-0.85, not 1.0).
 */
function removeHeadlineEcho(sentences: string[], headline: string): string[] {
  if (sentences.length === 0 || !headline.trim()) return sentences;
  const htokens = tokeniseArr(headline);
  const hidf = buildIdf([htokens, ...sentences.slice(0, 3).map(tokeniseArr)]);
  const hvec = tfidfVec(htokens, hidf);
  const s0vec = tfidfVec(tokeniseArr(sentences[0]), hidf);
  if (cosineSim(hvec, s0vec) >= 0.65) return sentences.slice(1);
  return sentences;
}

// ── Step 3: hybrid dedup ─────────────────────────────────────────────────────

/**
 * Sentence is a duplicate if EITHER:
 *   Jaccard(raw tokens) ≥ 0.80  — near-exact rewrites
 *   TF-IDF cosine       ≥ 0.75  — same meaning, different vocabulary
 */
function dedupSentences(sentences: string[]): string[] {
  if (sentences.length === 0) return [];
  const tokenArrays = sentences.map(tokeniseArr);
  const idf = buildIdf(tokenArrays);

  const result: string[] = [];
  const keptSets: Set<string>[] = [];
  const keptVecs: Map<string, number>[] = [];

  for (let i = 0; i < sentences.length; i++) {
    const ts  = tokenise(sentences[i]);
    const vec = tfidfVec(tokenArrays[i], idf);
    const isDup = keptSets.some((prevTs, ki) =>
      jaccard(prevTs, ts) >= 0.80 || cosineSim(keptVecs[ki], vec) >= 0.75,
    );
    if (!isDup) {
      result.push(sentences[i]);
      keptSets.push(ts);
      keptVecs.push(vec);
    }
  }
  return result;
}

// ── Step 5: TextRank (TF-IDF cosine edge weights) ────────────────────────────

function textRank(sentences: string[], iterations = 20, dampingFactor = 0.85): number[] {
  const n = sentences.length;
  if (n === 0) return [];
  if (n === 1) return [1];

  const tokenArrays = sentences.map(tokeniseArr);
  const idf = buildIdf(tokenArrays);
  const vecs = tokenArrays.map((ta) => tfidfVec(ta, idf));
  const tokenSets = tokenArrays.map((ta) => new Set(ta));

  const sim: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const s = tokenArrays[i].length < 4 || tokenArrays[j].length < 4
        ? jaccard(tokenSets[i], tokenSets[j])
        : cosineSim(vecs[i], vecs[j]);
      sim[i][j] = s;
      sim[j][i] = s;
    }
  }

  const norm: number[][] = sim.map((row) => {
    const sum = row.reduce((a, b) => a + b, 0);
    return sum === 0 ? row.map(() => 0) : row.map((v) => v / sum);
  });

  let scores = new Array(n).fill(1 / n);
  for (let iter = 0; iter < iterations; iter++) {
    const next = new Array(n).fill((1 - dampingFactor) / n);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) next[i] += dampingFactor * norm[j][i] * scores[j];
    }
    scores = next;
  }
  return scores;
}

// ── Step 6: MMR selection ────────────────────────────────────────────────────

/**
 * Maximal Marginal Relevance — greedily picks the next sentence that maximises:
 *   λ * relevance(s) − (1−λ) * max_sim(s, already_selected)
 *
 * λ=0.6 slightly favours relevance; adjust toward 0.5 for more diversity.
 * Ensures high-scoring sentences don't crowd out novel information.
 */
function mmrSelect(
  sentences: string[],
  scores: number[],
  idf: Map<string, number>,
  targetWords: number,
  lambda = 0.6,
): string[] {
  const n = sentences.length;
  if (n === 0) return [];

  const tokenArrays = sentences.map(tokeniseArr);
  const vecs = tokenArrays.map((ta) => tfidfVec(ta, idf));

  const maxScore = Math.max(...scores);
  const normScores = scores.map((s) => (maxScore > 0 ? s / maxScore : 0));

  const selected: number[] = [];
  const remaining = new Set(Array.from({ length: n }, (_, i) => i));
  let wordCount = 0;

  while (remaining.size > 0) {
    let bestIdx = -1;
    let bestScore = -Infinity;

    for (const i of remaining) {
      const wc = sentences[i].split(/\s+/).length;
      if (wordCount + wc > targetWords && selected.length > 0) continue;

      const relevance = normScores[i];
      const maxSim = selected.length === 0
        ? 0
        : Math.max(...selected.map((j) => cosineSim(vecs[i], vecs[j])));
      const mmr = lambda * relevance - (1 - lambda) * maxSim;

      if (mmr > bestScore) { bestScore = mmr; bestIdx = i; }
    }

    if (bestIdx === -1) break;
    selected.push(bestIdx);
    remaining.delete(bestIdx);
    wordCount += sentences[bestIdx].split(/\s+/).length;
  }

  selected.sort((a, b) => a - b);
  return selected.map((i) => sentences[i]);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function splitIntoSentences(paragraph: string): string[] {
  return paragraph
    .split(/(?<=[.!?]['")\]]*)\s+(?=[A-Z"'(\[])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function countWords(paragraphs: string[]): number {
  return paragraphs.reduce((acc, p) => acc + p.split(/\s+/).filter(Boolean).length, 0);
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface CleanResult {
  paragraphs: string[];
  originalParagraphs: string[];
}

export interface CleanOptions {
  /** Article title — used for headline echo detection. */
  headline?: string;
}

/**
 * Run the full 7-step cleaning pipeline on raw paragraph strings.
 */
export function cleanArticleParagraphs(
  rawParagraphs: string[],
  captions?: string[],
  options: CleanOptions = {},
): CleanResult {
  const originalParagraphs = [...rawParagraphs];

  // -- Step 1: boilerplate paragraph removal ---
  const captionSet = new Set((captions ?? []).map((c) => c.trim()));
  const afterBoilerplate = rawParagraphs.filter((p) => {
    const trimmed = p.trim();
    if (!trimmed) return false;
    if (captionSet.has(trimmed)) return false;
    if (isBoilerplate(trimmed)) return false;
    return true;
  });

  // -- Caption removal at paragraph level ---
  const afterCaptionRemoval = afterBoilerplate.filter((p) => !isCaption(p));

  // -- Flatten to sentences ---
  const allSentences: string[] = [];
  for (const para of afterCaptionRemoval) {
    for (const s of splitIntoSentences(para)) {
      if (!isBoilerplate(s) && !isCaption(s)) allSentences.push(s);
    }
  }

  if (allSentences.length === 0) {
    return { paragraphs: originalParagraphs, originalParagraphs };
  }

  // -- Step 2: headline echo removal ---
  const afterEchoRemoval = options.headline
    ? removeHeadlineEcho(allSentences, options.headline)
    : allSentences;

  // -- Step 3: hybrid Jaccard + TF-IDF cosine near-dedup ---
  const deduped = dedupSentences(afterEchoRemoval);

  if (deduped.length === 0) {
    return { paragraphs: originalParagraphs, originalParagraphs };
  }

  // -- Steps 5-7 (TextRank + MMR selection + 500-word cap) REMOVED for the
  // article reader: they summarised, not cleaned — a 1500-word article showed
  // at most 500 selected sentences under a tab labelled "Full Article", and
  // even short articles lost a third of their content. The Summary tab is the
  // summarisation surface; Full Article keeps every non-duplicate sentence in
  // original order. A very generous safety cap guards against mega-pages only.
  const TARGET_WORDS = 2500;
  const cappedSentences: string[] = [];
  let wc = 0;
  for (const s of deduped) {
    const sw = s.split(/\s+/).filter(Boolean).length;
    if (wc + sw > TARGET_WORDS) break;
    cappedSentences.push(s);
    wc += sw;
  }

  if (cappedSentences.length === 0) {
    return { paragraphs: originalParagraphs, originalParagraphs };
  }

  // Regroup sentences into ~3-sentence paragraphs for readability
  const SENTENCES_PER_PARA = 3;
  const cleanedParagraphs: string[] = [];
  for (let i = 0; i < cappedSentences.length; i += SENTENCES_PER_PARA) {
    cleanedParagraphs.push(cappedSentences.slice(i, i + SENTENCES_PER_PARA).join(' '));
  }

  // Sanity: if cleaning removed > 90 % of original words, fall back to originals
  const origWords = countWords(originalParagraphs);
  const cleanedWords = countWords(cleanedParagraphs);
  if (origWords > 50 && cleanedWords < origWords * 0.1) {
    return { paragraphs: originalParagraphs, originalParagraphs };
  }

  return { paragraphs: cleanedParagraphs, originalParagraphs };
}

/**
 * Cross-article sentence deduplication for cluster/deep-dive contexts.
 *
 * Given N article texts (plain strings), removes sentences that appear in
 * more than one article (wire copy reprinted verbatim / near-verbatim).
 * First occurrence wins; later duplicates are dropped.
 *
 * Threshold: cosine ≥ 0.82 (higher than within-article 0.75 to reduce
 * false positives across genuinely different stories in the same cluster).
 *
 * Returns one cleaned string per input article.
 */
export function deduplicateCrossArticle(texts: string[]): string[] {
  if (texts.length <= 1) return texts;

  // Pool all sentences tagged by article index
  const pool: Array<{ ai: number; text: string; tokens: string[] }> = [];
  for (let ai = 0; ai < texts.length; ai++) {
    const paras = texts[ai].split(/\n+/);
    for (const para of paras) {
      for (const s of splitIntoSentences(para)) {
        const trimmed = s.trim();
        if (trimmed.length > 20) {
          pool.push({ ai, text: trimmed, tokens: tokeniseArr(trimmed) });
        }
      }
    }
  }

  if (pool.length === 0) return texts;

  const idf = buildIdf(pool.map((p) => p.tokens));
  const vecs = pool.map((p) => tfidfVec(p.tokens, idf));

  // Mark duplicates: keep first occurrence, drop subsequent across different articles
  const isDup = new Set<number>();
  for (let i = 0; i < pool.length; i++) {
    if (isDup.has(i)) continue;
    for (let j = i + 1; j < pool.length; j++) {
      if (isDup.has(j)) continue;
      if (pool[i].ai === pool[j].ai) continue; // same article — handled by dedupSentences
      if (cosineSim(vecs[i], vecs[j]) >= 0.82) isDup.add(j);
    }
  }

  // Reconstruct per-article text without cross-article duplicates
  const byArticle: string[][] = texts.map(() => []);
  for (let idx = 0; idx < pool.length; idx++) {
    if (!isDup.has(idx)) byArticle[pool[idx].ai].push(pool[idx].text);
  }

  return byArticle.map((sentences, ai) =>
    sentences.length > 0 ? sentences.join(' ') : texts[ai],
  );
}
