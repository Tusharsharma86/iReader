/**
 * Non-AI article cleaning pipeline.
 * Steps:
 *  1. Boilerplate stripping
 *  2. Sentence-level near-dedup (Jaccard ≥ 0.80)
 *  3. Caption removal
 *  4. TextRank scoring
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

// ── Step 2: Jaccard similarity ───────────────────────────────────────────────

function tokenise(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function dedupSentences(sentences: string[]): string[] {
  const result: string[] = [];
  const tokenSets: Set<string>[] = [];
  for (const s of sentences) {
    const ts = tokenise(s);
    const isDup = tokenSets.some((prev) => jaccard(prev, ts) >= 0.8);
    if (!isDup) {
      result.push(s);
      tokenSets.push(ts);
    }
  }
  return result;
}

// ── Step 4: TextRank ─────────────────────────────────────────────────────────

function textRank(sentences: string[], iterations = 20, dampingFactor = 0.85): number[] {
  const n = sentences.length;
  if (n === 0) return [];
  if (n === 1) return [1];

  const tokenSets = sentences.map(tokenise);

  // Build similarity matrix (undirected)
  const sim: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const s = jaccard(tokenSets[i], tokenSets[j]);
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
 * Run the full 7-step cleaning pipeline on raw paragraph strings.
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

  // -- Step 2: sentence-level near-dedup ---
  const deduped = dedupSentences(allSentences);

  if (deduped.length === 0) {
    return { paragraphs: originalParagraphs, originalParagraphs };
  }

  // -- Step 4: TextRank scoring ---
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
