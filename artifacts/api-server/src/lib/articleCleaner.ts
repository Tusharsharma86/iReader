/**
 * Non-AI article cleaning pipeline.
 * Steps:
 *  1. Boilerplate stripping (33 patterns + attribution bylines)
 *  2. Sentence-level near-dedup (Jaccard ≥ 0.80 OR TF-IDF cosine ≥ 0.75)
 *  3. Caption removal
 *  4. TextRank scoring (TF-IDF cosine edge weights)
 *  5. Selective sentence reconstruction
 *  6. 500-word cap
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

  // ── Attribution bylines (Reuters / AP / AFP / wire service style) ──────────
  // "Reporting by Jane Doe; Editing by John Smith"
  /^reporting\s+by\s+[\w\s,;.()]+$/i,
  // "Editing by Jane Doe" standalone line
  /^editing\s+by\s+[\w\s,;.()]+$/i,
  // "Writing by Jane Doe"
  /^writing\s+by\s+[\w\s,;.()]+$/i,
  // "Written by Jane Doe"
  /^written\s+by\s+[\w\s,;.()]+$/i,
  // "Compiled by Jane Doe"
  /^compiled\s+by\s+[\w\s,;.()]+$/i,
  // "Additional reporting by Jane Doe in Washington"
  /^additional\s+reporting\s+by\s+.{1,120}$/i,
  // "With reporting from / With inputs from"
  /^with\s+(additional\s+)?(reporting|inputs?|contributions?)\s+(by|from)\s+.{1,120}$/i,
  // Reuters standards footer: "Our Standards: The Thomson Reuters..."
  /^our\s+standards?\s*:\s*the\s+thomson\s+reuters/i,
  // AP/AFP/PTI/ANI trailing credit lines
  /^\(?(?:ap|afp|pti|ani|ians|reuters|bloomberg|xinhua)\)?\.?$/i,
  // "(AP)" / "(Reuters)" appearing as standalone paragraph
  /^\((?:ap|afp|pti|ani|ians|reuters|bloomberg)\)\.?$/i,
];

function isBoilerplate(sentence: string): boolean {
  const s = sentence.trim();
  if (!s) return true;
  return BOILERPLATE_PATTERNS.some((re) => re.test(s));
}

// ── Step 3: caption heuristics ──────────────────────────────────────────────

function isCaption(sentence: string): boolean {
  const s = sentence.trim();
  const wordCount = s.split(/\s+/).length;
  // Very short snippets that end with a source attribution or are all-caps labels
  if (wordCount <= 6 && /:\s*$/.test(s)) return true;
  // Looks like "Photo: Source Name" or "Image: AP/Reuters"
  if (/^(photo|image|picture|illustration|graphic|afp|ap|pti|reuters|ani|ians)\s*:/i.test(s)) return true;
  // Parenthetical-only captions: "(AP Photo/John Doe)"
  if (/^\(.*\)$/.test(s) && wordCount <= 10) return true;
  return false;
}

// ── Token helpers ────────────────────────────────────────────────────────────

function tokenise(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean),
  );
}

function tokeniseArr(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

// ── TF-IDF + cosine similarity ───────────────────────────────────────────────

/**
 * Build smoothed IDF map from a corpus of token arrays.
 * IDF(t) = log((N+1)/(df(t)+1)) + 1  — sklearn-style smoothing.
 */
function buildIdf(tokenArrays: string[][]): Map<string, number> {
  const N = tokenArrays.length;
  const df = new Map<string, number>();
  for (const tokens of tokenArrays) {
    for (const t of new Set(tokens)) {
      df.set(t, (df.get(t) ?? 0) + 1);
    }
  }
  const idf = new Map<string, number>();
  for (const [term, freq] of df) {
    idf.set(term, Math.log((N + 1) / (freq + 1)) + 1);
  }
  return idf;
}

/** Build a TF-IDF sparse vector for one sentence. */
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

/** Cosine similarity between two sparse TF-IDF vectors. */
function cosineSim(a: Map<string, number>, b: Map<string, number>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let dot = 0;
  let normA = 0;
  for (const [term, val] of a) {
    dot += val * (b.get(term) ?? 0);
    normA += val * val;
  }
  let normB = 0;
  for (const val of b.values()) normB += val * val;
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ── Step 2: Jaccard (kept for exact/short sentence dedup) ───────────────────

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Hybrid dedup: a sentence is a duplicate if EITHER
 *   - Jaccard(token sets) ≥ 0.80   (catches near-exact rewrites)
 *   - TF-IDF cosine    ≥ 0.75   (catches same-meaning with different wording)
 * Builds the IDF corpus from all input sentences before scanning.
 */
function dedupSentences(sentences: string[]): string[] {
  if (sentences.length === 0) return [];

  const tokenArrays = sentences.map(tokeniseArr);
  const idf = buildIdf(tokenArrays);

  const result: string[] = [];
  const keptTokenSets: Set<string>[] = [];
  const keptVecs: Map<string, number>[] = [];

  for (let i = 0; i < sentences.length; i++) {
    const ts  = new Set(tokenArrays[i]);
    const vec = tfidfVec(tokenArrays[i], idf);

    const isDup = keptTokenSets.some((prevTs, ki) => {
      if (jaccard(prevTs, ts) >= 0.80) return true;
      if (cosineSim(keptVecs[ki], vec) >= 0.75) return true;
      return false;
    });

    if (!isDup) {
      result.push(sentences[i]);
      keptTokenSets.push(ts);
      keptVecs.push(vec);
    }
  }
  return result;
}

// ── Step 4: TextRank (TF-IDF cosine edge weights) ────────────────────────────

/**
 * PageRank over a fully-connected sentence graph.
 * Edge weights = TF-IDF cosine similarity (more nuanced than plain Jaccard).
 * Falls back to Jaccard for very short sentences (< 4 tokens) where TF-IDF
 * vectors are too sparse to be meaningful.
 */
function textRank(sentences: string[], iterations = 20, dampingFactor = 0.85): number[] {
  const n = sentences.length;
  if (n === 0) return [];
  if (n === 1) return [1];

  const tokenArrays = sentences.map(tokeniseArr);
  const idf = buildIdf(tokenArrays);
  const vecs = tokenArrays.map((ta) => tfidfVec(ta, idf));
  const tokenSets = tokenArrays.map((ta) => new Set(ta));

  // Build similarity matrix — use cosine; fall back to Jaccard for sparse vecs
  const sim: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const s =
        tokenArrays[i].length < 4 || tokenArrays[j].length < 4
          ? jaccard(tokenSets[i], tokenSets[j])
          : cosineSim(vecs[i], vecs[j]);
      sim[i][j] = s;
      sim[j][i] = s;
    }
  }

  // Row-normalise
  const norm: number[][] = sim.map((row) => {
    const sum = row.reduce((a, b) => a + b, 0);
    return sum === 0 ? row.map(() => 0) : row.map((v) => v / sum);
  });

  // Power iteration
  let scores = new Array(n).fill(1 / n);
  for (let iter = 0; iter < iterations; iter++) {
    const next = new Array(n).fill((1 - dampingFactor) / n);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        next[i] += dampingFactor * norm[j][i] * scores[j];
      }
    }
    scores = next;
  }
  return scores;
}

// ── Step 5: selective reconstruction ────────────────────────────────────────

function selectSentences(sentences: string[], scores: number[], targetWords: number): string[] {
  if (sentences.length === 0) return [];

  // Keep at least 60 % of sentences; also enforce word budget.
  const minKeep = Math.max(1, Math.ceil(sentences.length * 0.6));
  const threshold = [...scores].sort((a, b) => b - a)[minKeep - 1] ?? 0;

  const selected: Array<{ idx: number; sentence: string }> = [];
  let wordCount = 0;

  for (let i = 0; i < sentences.length; i++) {
    if (scores[i] < threshold && selected.length >= minKeep) continue;
    const wc = sentences[i].split(/\s+/).length;
    if (wordCount + wc > targetWords && selected.length >= minKeep) break;
    selected.push({ idx: i, sentence: sentences[i] });
    wordCount += wc;
  }

  // Preserve original document order
  selected.sort((a, b) => a.idx - b.idx);
  return selected.map((s) => s.sentence);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function splitIntoSentences(paragraph: string): string[] {
  // Naïve sentence splitter — splits on ". ", "! ", "? " with optional quote/paren.
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

/**
 * Run the full 6-step cleaning pipeline on raw paragraph strings.
 * Returns cleaned paragraphs (may be shorter) and the originals preserved for
 * the reader's "Original" tab.
 */
export function cleanArticleParagraphs(
  rawParagraphs: string[],
  captions?: string[],
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

  // -- Step 3 (pre-dedup): caption removal at paragraph level ---
  const afterCaptionRemoval = afterBoilerplate.filter((p) => !isCaption(p));

  // -- Flatten to sentences ---
  const allSentences: string[] = [];
  for (const para of afterCaptionRemoval) {
    const sentences = splitIntoSentences(para);
    for (const s of sentences) {
      if (!isBoilerplate(s) && !isCaption(s)) {
        allSentences.push(s);
      }
    }
  }

  if (allSentences.length === 0) {
    return { paragraphs: originalParagraphs, originalParagraphs };
  }

  // -- Step 2: hybrid Jaccard + TF-IDF cosine near-dedup ---
  const deduped = dedupSentences(allSentences);

  if (deduped.length === 0) {
    return { paragraphs: originalParagraphs, originalParagraphs };
  }

  // -- Step 4: TextRank scoring (TF-IDF cosine graph) ---
  const scores = textRank(deduped);

  // -- Step 5: selective reconstruction (target: 500 words) ---
  const TARGET_WORDS = 500;
  const selected = selectSentences(deduped, scores, TARGET_WORDS);

  // -- Step 6: 500-word hard cap ---
  const cappedSentences: string[] = [];
  let wc = 0;
  for (const s of selected) {
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
