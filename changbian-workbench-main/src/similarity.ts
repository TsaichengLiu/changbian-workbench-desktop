import { isIgnorableChar, toSimplified } from "./search";

// 相似文本與比勘：去掉標點、空白與輕標記，逐字轉為同一字形後比對。
// 每個字（碼位）是一個 token，並記錄它在原文中的起止位置，結果可標回原文。
export interface ComparableText {
  tokens: string[];
  starts: number[];
  ends: number[];
}

// 片段長度：兩段至少有連續這麼多字相同，才從那裏開始逐字對齊。越短越能找到異文密集的轉引。
export const DEFAULT_GRAM_SIZE = 4;
export const MIN_GRAM_SIZE = 3;
export const MAX_GRAM_SIZE = 6;
// 每個對齊段落至少要有多少字相同才算數；調低可找回零散的短句重合，也會混入官名、套語。
export const DEFAULT_MIN_BLOCK_CHARS = 10;
export const MIN_MIN_BLOCK_CHARS = 4;
export const MAX_MIN_BLOCK_CHARS = 200;
// 兩條各段相同字數合計至少多少才列為相似。
export const DEFAULT_MIN_SHARED_CHARS = 10;
export const MIN_MIN_SHARED_CHARS = 4;
export const MAX_MIN_SHARED_CHARS = 200;
// 語序一致度下限（0–1）：0 為不限。只對上一段、無從比較次序時照常列出。
export const DEFAULT_MIN_ORDER_CONSISTENCY = 0;
const foldCache = new Map<string, string>();

function foldChar(char: string): string {
  let folded = foldCache.get(char);
  if (folded === undefined) {
    folded = toSimplified(char).toLocaleLowerCase();
    foldCache.set(char, folded);
  }
  return folded;
}

// strict 為 true 時不做繁簡、異體歸一，只忽略標點與大小寫。
export function toComparableText(text: string, strict = false): ComparableText {
  const tokens: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;
  for (const char of text) {
    if (!isIgnorableChar(char)) {
      tokens.push(strict ? char.toLocaleLowerCase() : foldChar(char));
      starts.push(offset);
      ends.push(offset + char.length);
    }
    offset += char.length;
  }
  return { tokens, starts, ends };
}

export function clampGramSize(size: number): number {
  return Number.isFinite(size)
    ? Math.min(MAX_GRAM_SIZE, Math.max(MIN_GRAM_SIZE, Math.round(size)))
    : DEFAULT_GRAM_SIZE;
}

export function clampMinBlockChars(value: number): number {
  return Number.isFinite(value)
    ? Math.min(MAX_MIN_BLOCK_CHARS, Math.max(MIN_MIN_BLOCK_CHARS, Math.round(value)))
    : DEFAULT_MIN_BLOCK_CHARS;
}

export function clampMinSharedChars(value: number): number {
  return Number.isFinite(value)
    ? Math.min(MAX_MIN_SHARED_CHARS, Math.max(MIN_MIN_SHARED_CHARS, Math.round(value)))
    : DEFAULT_MIN_SHARED_CHARS;
}

export function clampMaxGap(value: number): number {
  return Number.isFinite(value) ? Math.min(MAX_MAX_GAP, Math.max(MIN_MAX_GAP, Math.round(value))) : DEFAULT_MAX_GAP;
}

export function clampMinOrderConsistency(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : DEFAULT_MIN_ORDER_CONSISTENCY;
}

function gramsOf(tokens: string[], size: number): string[] {
  const grams: string[] = [];
  for (let index = 0; index + size <= tokens.length; index += 1) {
    grams.push(tokens.slice(index, index + size).join(""));
  }
  return grams;
}

// 標出 grams 中與 other 共有、且不在忽略之列的片段所覆蓋的字。
function sharedMask(
  grams: string[],
  other: Set<string>,
  length: number,
  ignored: Set<string>,
  size: number,
): Uint8Array {
  const mask = new Uint8Array(length);
  grams.forEach((gram, index) => {
    if (ignored.has(gram) || !other.has(gram)) {
      return;
    }
    for (let offset = 0; offset < size; offset += 1) {
      mask[index + offset] = 1;
    }
  });
  return mask;
}

function countMarked(mask: Uint8Array): number {
  let count = 0;
  for (const value of mask) {
    count += value;
  }
  return count;
}

// ── 局部對齊（種子—延伸）───────────────────────────────
// 1. 種子：兩段共有的 N 字片段（N 即「片段長度」）；高頻片段不作種子。
// 2. 串連：先後次序一致、彼此相隔不超過 maxGap 字的種子連成一串，圈出候選區域。
// 3. 延伸：在區域內逐字對齊，允許異文、脫文、衍文；相異的字累計比相同的多出 maxGap 字即分段。
// 4. 段內相同字數達到下限的，才算一個對齊段落；一段文字只對應對方的一處。
export const DEFAULT_MAX_GAP = 12;
export const MIN_MAX_GAP = 4;
export const MAX_MAX_GAP = 40;
// 片段在對方文本中出現太多次（反覆出現的套語）時不作種子，免得候選組合暴增。
const SEED_MAX_OCCURRENCES = 8;
// 候選區域向兩端多看幾個字，補回種子之外、緊鄰的相同字。
const REGION_MARGIN = 4;

export interface AlignedBlock {
  // token 區間（左閉右開）：a 為第一段文字，b 為第二段文字。
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
  // 段內相同的字數，及其佔段落長度（兩邊取較長者）的比例。
  matches: number;
  identity: number;
}

interface AlignInput {
  tokens: string[];
  grams: string[];
  positions: Map<string, number[]>;
}

interface Region {
  aFrom: number;
  aTo: number;
  bFrom: number;
  bTo: number;
}

function gramPositions(grams: string[]): Map<string, number[]> {
  const positions = new Map<string, number[]>();
  grams.forEach((gram, index) => {
    const list = positions.get(gram);
    if (list) {
      list.push(index);
    } else {
      positions.set(gram, [index]);
    }
  });
  return positions;
}

// 把共有片段（種子）串成候選區域。
function chainRegions(
  a: AlignInput,
  b: AlignInput,
  size: number,
  minBlock: number,
  ignored: Set<string>,
  maxGap: number,
): Region[] {
  const hitA: number[] = [];
  const hitB: number[] = [];
  a.grams.forEach((gram, i) => {
    if (ignored.has(gram)) {
      return;
    }
    const list = b.positions.get(gram);
    if (!list || list.length > SEED_MAX_OCCURRENCES) {
      return;
    }
    for (const j of list) {
      hitA.push(i);
      hitB.push(j);
    }
  });
  const count = hitA.length;
  if (count === 0) {
    return [];
  }
  // 鏈式動態規劃：score 為串到此種子時大致覆蓋的相同字數。
  const score = new Int32Array(count);
  const previous = new Int32Array(count).fill(-1);
  let windowStart = 0;
  for (let t = 0; t < count; t += 1) {
    const i = hitA[t];
    const j = hitB[t];
    while (hitA[windowStart] < i - size - maxGap) {
      windowStart += 1;
    }
    let best = size;
    let bestPrevious = -1;
    for (let p = t - 1; p >= windowStart; p -= 1) {
      const pi = hitA[p];
      const pj = hitB[p];
      if (pi >= i || pj >= j || j - pj - size > maxGap) {
        continue;
      }
      const candidate = score[p] + Math.min(size, i - pi, j - pj);
      if (candidate > best) {
        best = candidate;
        bestPrevious = p;
      }
    }
    score[t] = best;
    previous[t] = bestPrevious;
  }

  // 從得分最高的種子往回追，取出互不重複的串。
  const order = Array.from({ length: count }, (_, index) => index).sort((x, y) => score[y] - score[x] || x - y);
  const used = new Uint8Array(count);
  const minChain = Math.max(size, Math.ceil(minBlock / 2));
  const regions: Region[] = [];
  for (const end of order) {
    if (used[end]) {
      continue;
    }
    let first = end;
    let cursor = end;
    while (cursor >= 0 && !used[cursor]) {
      used[cursor] = 1;
      first = cursor;
      cursor = previous[cursor];
    }
    if (score[end] - (cursor >= 0 ? score[cursor] : 0) < minChain) {
      continue;
    }
    regions.push({
      aFrom: Math.max(0, hitA[first] - REGION_MARGIN),
      aTo: Math.min(a.tokens.length, hitA[end] + size + REGION_MARGIN),
      bFrom: Math.max(0, hitB[first] - REGION_MARGIN),
      bTo: Math.min(b.tokens.length, hitB[end] + size + REGION_MARGIN),
    });
  }
  return regions;
}

// 在候選區域內逐字對齊，再切出相同字佔優的連續段落。
function alignRegion(
  a: AlignInput,
  b: AlignInput,
  region: Region,
  size: number,
  minBlock: number,
  maxGap: number,
): AlignedBlock[] {
  const ops = diffTokens(a.tokens.slice(region.aFrom, region.aTo), b.tokens.slice(region.bFrom, region.bTo));
  if (!ops) {
    return [];
  }
  // 合成「相同」與「相異」交替的片段。
  const runs: Array<{ same: boolean; aStart: number; bStart: number; aLength: number; bLength: number }> = [];
  for (const op of ops) {
    const same = op.type === "equal";
    const last = runs[runs.length - 1];
    if (last && last.same === same) {
      last.aLength += op.type === "insert" ? 0 : 1;
      last.bLength += op.type === "delete" ? 0 : 1;
      continue;
    }
    runs.push({
      same,
      aStart: op.aIndex,
      bStart: op.bIndex,
      aLength: op.type === "insert" ? 0 : 1,
      bLength: op.type === "delete" ? 0 : 1,
    });
  }

  // 相同的字 +1；一處相異按兩邊較長者扣分（異文一字扣 1，脫衍 n 字扣 n）。
  // 從某段相同的字起累計，一旦比最高點低出 maxGap 就斷開；斷開前最後一處相同的字為段尾。
  // 段首、段尾不足「片段長度」的零星相同字（多半是碰巧相同的虛詞）不計入。
  const blocks: AlignedBlock[] = [];
  let index = 0;
  while (index < runs.length) {
    if (!runs[index].same) {
      index += 1;
      continue;
    }
    let total = 0;
    let best = 0;
    let end = index;
    let cursor = index;
    for (; cursor < runs.length; cursor += 1) {
      const run = runs[cursor];
      total += run.same ? run.aLength : -Math.max(run.aLength, run.bLength);
      best = Math.max(best, total);
      if (best - total > maxGap) {
        break;
      }
      if (run.same) {
        end = cursor;
      }
    }
    // 相同與相異的片段交替出現，同類相隔兩格。
    let first = index;
    while (first < end && runs[first].aLength < size) {
      first += 2;
    }
    while (end > first && runs[end].aLength < size) {
      end -= 2;
    }
    let matches = 0;
    for (let item = first; item <= end; item += 2) {
      matches += runs[item].aLength;
    }
    if (matches >= minBlock) {
      const aStart = region.aFrom + runs[first].aStart;
      const aEnd = region.aFrom + runs[end].aStart + runs[end].aLength;
      const bStart = region.bFrom + runs[first].bStart;
      const bEnd = region.bFrom + runs[end].bStart + runs[end].bLength;
      blocks.push({ aStart, aEnd, bStart, bEnd, matches, identity: matches / Math.max(aEnd - aStart, bEnd - bStart) });
    }
    index = cursor + 1;
  }
  return blocks;
}

// 一段文字只對應對方一處：按相同字數從多到少挑選，兩邊都不重疊。
function selectBlocks(blocks: AlignedBlock[]): AlignedBlock[] {
  const chosen: AlignedBlock[] = [];
  const ranked = [...blocks].sort((x, y) => y.matches - x.matches || x.aStart - y.aStart || x.bStart - y.bStart);
  for (const block of ranked) {
    const overlaps = chosen.some(
      (other) =>
        (block.aStart < other.aEnd && other.aStart < block.aEnd) ||
        (block.bStart < other.bEnd && other.bStart < block.bEnd),
    );
    if (!overlaps) {
      chosen.push(block);
    }
  }
  return chosen.sort((x, y) => x.aStart - y.aStart || x.bStart - y.bStart);
}

function mirrorBlocks(blocks: AlignedBlock[]): AlignedBlock[] {
  return blocks
    .map((block) => ({ ...block, aStart: block.bStart, aEnd: block.bEnd, bStart: block.aStart, bEnd: block.aEnd }))
    .sort((x, y) => x.aStart - y.aStart || x.bStart - y.bStart);
}

// 結果與兩段的先後無關：一律以原文較「小」的一段作 a 去對齊，需要時再對調。
function alignBothWays(
  aText: string,
  a: AlignInput,
  bText: string,
  b: AlignInput,
  size: number,
  minBlock: number,
  ignored: Set<string>,
  maxGap: number,
): AlignedBlock[] {
  const run = (x: AlignInput, y: AlignInput) =>
    selectBlocks(
      chainRegions(x, y, size, minBlock, ignored, maxGap).flatMap((region) =>
        alignRegion(x, y, region, size, minBlock, maxGap),
      ),
    );
  return aText <= bText ? run(a, b) : mirrorBlocks(run(b, a));
}

export interface AlignOptions {
  gramSize?: number;
  minBlockChars?: number;
  maxGap?: number;
  // 為 true 時不做繁簡、異體歸一。
  strict?: boolean;
}

// 兩段文字之間的對齊段落（不忽略高頻片段），供比勘使用。
export function alignTexts(aText: string, bText: string, options: AlignOptions = {}): AlignedBlock[] {
  const size = clampGramSize(options.gramSize ?? DEFAULT_GRAM_SIZE);
  const minBlock = clampMinBlockChars(options.minBlockChars ?? DEFAULT_MIN_BLOCK_CHARS);
  const maxGap = clampMaxGap(options.maxGap ?? DEFAULT_MAX_GAP);
  const input = (text: string): AlignInput => {
    const tokens = toComparableText(text, options.strict ?? false).tokens;
    const grams = gramsOf(tokens, size);
    return { tokens, grams, positions: gramPositions(grams) };
  };
  return alignBothWays(aText, input(aText), bText, input(bText), size, minBlock, new Set(), maxGap);
}

// 多段對齊時，次序一致的段落（按相同字數加權）所佔比例；只有一段時無從比較，回傳 null。
function blockOrderConsistency(blocks: AlignedBlock[]): number | null {
  if (blocks.length < 2) {
    return null;
  }
  const best = blocks.map((block) => block.matches);
  let top = 0;
  let total = 0;
  blocks.forEach((block, i) => {
    for (let j = 0; j < i; j += 1) {
      if (blocks[j].bStart < block.bStart) {
        best[i] = Math.max(best[i], best[j] + block.matches);
      }
    }
    top = Math.max(top, best[i]);
    total += block.matches;
  });
  return top / total;
}

export interface SimilarityDocument {
  id: string;
  text: string;
}

export interface SimilarMatch {
  entryId: string;
  // 本條有多少比例的文字落在對齊段落中；反之亦然。
  anchorCoverage: number;
  candidateCoverage: number;
  // 對齊段落中相同的字數，及其佔段落總長的比例。從哪一條看都相同。
  sharedChars: number;
  identity: number;
  // 對齊段落（a 為本條、b 為對方的 token 區間），按本條中的位置排列。
  blocks: AlignedBlock[];
  // 各段在兩條中先後次序一致的比例（按字數加權）；只對上一段時為 null。
  orderConsistency: number | null;
  // 相似度：較高一側的覆蓋率 × 段內一致率。
  score: number;
  // 對方文本中最長對齊段落的原文位置，用於摘錄顯示。
  candidateRun: { start: number; end: number } | null;
}

interface DocumentGrams {
  grams: string[];
  gramSet: Set<string>;
  positions: Map<string, number[]>;
}

interface IndexedDocument extends DocumentGrams {
  comparable: ComparableText;
}

export interface SimilarityOptions {
  gramSize?: number;
  minBlockChars?: number;
  minSharedChars?: number;
  // 相異的字累計多出這麼多即分段。
  maxGap?: number;
  // 為 true 時不做繁簡、異體歸一，只忽略標點與大小寫。
  strict?: boolean;
  // 語序一致度低於此值的不列出（0–1）。
  minOrderConsistency?: number;
  // 默認忽略高頻片段；設為 false 時所有共有片段都可作種子。
  ignoreFrequentFragments?: boolean;
}

// 高頻片段：出現在超過 25% 條目（且至少超過 5 條）中的片段，多為紀年、套語，默認不作為傳抄證據。
export const FREQUENT_FRAGMENT_SHARE = 0.25;
export const FREQUENT_FRAGMENT_MIN_ENTRIES = 5;

export interface FrequentFragment {
  // 取自第一處出現的原文，保留原來的字形與標點。
  text: string;
  entryCount: number;
}

// 全庫相似對：a 為錨點一側，match 中的覆蓋率、段落區間均以 a 的角度表示。
export interface SimilarPair {
  aId: string;
  bId: string;
  match: SimilarMatch;
}

// 條目內容未變時沿用歸一化結果；各片段長度的切分分別快取。
interface CachedDocument {
  text: string;
  strict: boolean;
  comparable: ComparableText;
  gramsBySize: Map<number, DocumentGrams>;
}

const documentCache = new Map<string, CachedDocument>();

function indexDocument(
  document: SimilarityDocument,
  size: number,
  strict: boolean,
): IndexedDocument & { text: string } {
  let cached = documentCache.get(document.id);
  if (!cached || cached.text !== document.text || cached.strict !== strict) {
    cached = { text: document.text, strict, comparable: toComparableText(document.text, strict), gramsBySize: new Map() };
    documentCache.set(document.id, cached);
  }
  let grams = cached.gramsBySize.get(size);
  if (!grams) {
    const list = gramsOf(cached.comparable.tokens, size);
    grams = { grams: list, gramSet: new Set(list), positions: gramPositions(list) };
    cached.gramsBySize.set(size, grams);
  }
  return { text: cached.text, comparable: cached.comparable, ...grams };
}

export class SimilarityIndex {
  readonly gramSize: number;
  readonly minBlockChars: number;
  readonly minSharedChars: number;
  readonly maxGap: number;
  readonly strict: boolean;
  readonly minOrderConsistency: number;
  readonly ignoreFrequentFragments: boolean;
  // 依目前條目數算出的高頻片段（無論是否忽略都會列出，方便查看）。
  readonly frequentFragments: FrequentFragment[];
  private readonly documents = new Map<string, IndexedDocument & { text: string }>();
  private readonly postings = new Map<string, string[]>();
  private readonly ignoredGrams: Set<string>;
  // 兩條之間的對齊段落，以 id 較小的一條為 a。
  private readonly pairBlocks = new Map<string, AlignedBlock[]>();

  constructor(documents: SimilarityDocument[], options: SimilarityOptions = {}) {
    this.gramSize = clampGramSize(options.gramSize ?? DEFAULT_GRAM_SIZE);
    this.minBlockChars = clampMinBlockChars(options.minBlockChars ?? DEFAULT_MIN_BLOCK_CHARS);
    this.minSharedChars = clampMinSharedChars(options.minSharedChars ?? DEFAULT_MIN_SHARED_CHARS);
    this.maxGap = clampMaxGap(options.maxGap ?? DEFAULT_MAX_GAP);
    this.strict = options.strict ?? false;
    this.minOrderConsistency = clampMinOrderConsistency(
      options.minOrderConsistency ?? DEFAULT_MIN_ORDER_CONSISTENCY,
    );
    this.ignoreFrequentFragments = options.ignoreFrequentFragments ?? true;
    for (const document of documents) {
      if (!document.text.trim()) {
        continue;
      }
      const indexed = indexDocument(document, this.gramSize, this.strict);
      this.documents.set(document.id, indexed);
      for (const gram of indexed.gramSet) {
        const ids = this.postings.get(gram);
        if (ids) {
          ids.push(document.id);
        } else {
          this.postings.set(gram, [document.id]);
        }
      }
    }
    for (const id of documentCache.keys()) {
      if (!this.documents.has(id)) {
        documentCache.delete(id);
      }
    }

    const frequentLimit = Math.max(
      FREQUENT_FRAGMENT_MIN_ENTRIES,
      Math.floor(this.documents.size * FREQUENT_FRAGMENT_SHARE),
    );
    const frequentGrams = new Map<string, number>();
    for (const [gram, ids] of this.postings) {
      if (ids.length > frequentLimit) {
        frequentGrams.set(gram, ids.length);
      }
    }
    this.frequentFragments = [...frequentGrams]
      .map(([gram, entryCount]) => ({ text: this.sampleText(gram), entryCount }))
      .sort((a, b) => b.entryCount - a.entryCount || a.text.localeCompare(b.text));
    this.ignoredGrams = this.ignoreFrequentFragments ? new Set(frequentGrams.keys()) : new Set();
  }

  // 取片段第一次出現處的原文，供界面顯示。
  private sampleText(gram: string): string {
    const firstId = this.postings.get(gram)?.[0];
    const document = firstId ? this.documents.get(firstId) : undefined;
    const index = document?.grams.indexOf(gram) ?? -1;
    if (!document || index < 0) {
      return gram;
    }
    const { starts, ends } = document.comparable;
    return document.text.slice(starts[index], ends[index + this.gramSize - 1]);
  }

  // 兩條之間的對齊段落，以 anchorId 一方為 a。同一對只算一次。
  private blocksBetween(anchorId: string, candidateId: string): AlignedBlock[] {
    const [firstId, secondId] = anchorId < candidateId ? [anchorId, candidateId] : [candidateId, anchorId];
    const key = `${firstId}\u0001${secondId}`;
    let blocks = this.pairBlocks.get(key);
    if (!blocks) {
      const first = this.documents.get(firstId);
      const second = this.documents.get(secondId);
      const input = (document: IndexedDocument): AlignInput => ({
        tokens: document.comparable.tokens,
        grams: document.grams,
        positions: document.positions,
      });
      blocks =
        first && second
          ? alignBothWays(
              first.text,
              input(first),
              second.text,
              input(second),
              this.gramSize,
              this.minBlockChars,
              this.ignoredGrams,
              this.maxGap,
            )
          : [];
      this.pairBlocks.set(key, blocks);
    }
    return anchorId === firstId ? blocks : mirrorBlocks(blocks);
  }

  findSimilar(anchorId: string, limit = 20): SimilarMatch[] {
    const anchor = this.documents.get(anchorId);
    if (!anchor) {
      return [];
    }
    const sharedGramCounts = new Map<string, number>();
    for (const gram of anchor.gramSet) {
      if (this.ignoredGrams.has(gram)) {
        continue;
      }
      for (const id of this.postings.get(gram) ?? []) {
        if (id !== anchorId) {
          sharedGramCounts.set(id, (sharedGramCounts.get(id) ?? 0) + 1);
        }
      }
    }

    // 段落比片段長時至少要有兩個種子，先排除只共有一個片段的條目。
    const minSeeds = this.minBlockChars > this.gramSize ? 2 : 1;
    const matches: SimilarMatch[] = [];
    for (const [id, seeds] of sharedGramCounts) {
      const candidate = this.documents.get(id);
      if (seeds < minSeeds || !candidate) {
        continue;
      }
      const blocks = this.blocksBetween(anchorId, id);
      if (blocks.length === 0) {
        continue;
      }
      const order = blockOrderConsistency(blocks);
      if (order !== null && order < this.minOrderConsistency) {
        continue;
      }
      let sharedChars = 0;
      let anchorCovered = 0;
      let candidateCovered = 0;
      let span = 0;
      let largest = blocks[0];
      for (const block of blocks) {
        sharedChars += block.matches;
        anchorCovered += block.aEnd - block.aStart;
        candidateCovered += block.bEnd - block.bStart;
        span += Math.max(block.aEnd - block.aStart, block.bEnd - block.bStart);
        if (block.matches > largest.matches) {
          largest = block;
        }
      }
      if (sharedChars < this.minSharedChars) {
        continue;
      }
      const anchorCoverage = anchorCovered / anchor.comparable.tokens.length;
      const candidateCoverage = candidateCovered / candidate.comparable.tokens.length;
      const identity = sharedChars / span;
      matches.push({
        entryId: id,
        anchorCoverage,
        candidateCoverage,
        sharedChars,
        identity,
        blocks,
        orderConsistency: order,
        score: Math.max(anchorCoverage, candidateCoverage) * identity,
        candidateRun: {
          start: candidate.comparable.starts[largest.bStart],
          end: candidate.comparable.ends[largest.bEnd - 1],
        },
      });
    }
    matches.sort((a, b) => b.score - a.score || b.sharedChars - a.sharedChars);
    return matches.slice(0, limit);
  }

  // 全庫兩兩比對，每對只列一次，按相似度排序。
  findAllPairs(limitPerEntry = 50): SimilarPair[] {
    const seen = new Set<string>();
    const pairs: SimilarPair[] = [];
    for (const aId of this.documents.keys()) {
      for (const match of this.findSimilar(aId, limitPerEntry)) {
        const key = aId < match.entryId ? `${aId}\u0001${match.entryId}` : `${match.entryId}\u0001${aId}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        pairs.push({ aId, bId: match.entryId, match });
      }
    }
    pairs.sort((a, b) => b.match.score - a.match.score || b.match.sharedChars - a.match.sharedChars);
    return pairs;
  }
}

export type DiffOpType = "equal" | "delete" | "insert";

export interface DiffOp {
  type: DiffOpType;
  aIndex: number;
  bIndex: number;
}

// Myers 差異算法（逐字）。差異過大、超過 maxEdits 步時放棄對齊，回傳 null。
export function diffTokens(a: string[], b: string[], maxEdits = 2500): DiffOp[] | null {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const n = a.length - prefix - suffix;
  const m = b.length - prefix - suffix;
  const A = (index: number) => a[prefix + index];
  const B = (index: number) => b[prefix + index];

  const middle: DiffOp[] = [];
  if (n > 0 || m > 0) {
    const max = n + m;
    const offset = max;
    const v = new Int32Array(2 * max + 2);
    const trace: Int32Array[] = [];
    let found = false;
    for (let d = 0; d <= max; d += 1) {
      if (d > maxEdits) {
        return null;
      }
      trace.push(v.slice(offset - d, offset + d + 1));
      for (let k = -d; k <= d; k += 2) {
        let x =
          k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
        let y = x - k;
        while (x < n && y < m && A(x) === B(y)) {
          x += 1;
          y += 1;
        }
        v[offset + k] = x;
        if (x >= n && y >= m) {
          found = true;
          break;
        }
      }
      if (found) {
        break;
      }
    }

    let x = n;
    let y = m;
    for (let d = trace.length - 1; d >= 0; d -= 1) {
      if (d === 0) {
        while (x > 0 && y > 0) {
          x -= 1;
          y -= 1;
          middle.push({ type: "equal", aIndex: prefix + x, bIndex: prefix + y });
        }
        break;
      }
      const previous = trace[d];
      const read = (k: number) => previous[k + d];
      const k = x - y;
      const previousK = k === -d || (k !== d && read(k - 1) < read(k + 1)) ? k + 1 : k - 1;
      const previousX = read(previousK);
      const previousY = previousX - previousK;
      while (x > previousX && y > previousY) {
        x -= 1;
        y -= 1;
        middle.push({ type: "equal", aIndex: prefix + x, bIndex: prefix + y });
      }
      if (x === previousX) {
        y -= 1;
        middle.push({ type: "insert", aIndex: prefix + x, bIndex: prefix + y });
      } else {
        x -= 1;
        middle.push({ type: "delete", aIndex: prefix + x, bIndex: prefix + y });
      }
    }
    middle.reverse();
  }

  const ops: DiffOp[] = [];
  for (let index = 0; index < prefix; index += 1) {
    ops.push({ type: "equal", aIndex: index, bIndex: index });
  }
  ops.push(...middle);
  for (let index = 0; index < suffix; index += 1) {
    ops.push({ type: "equal", aIndex: a.length - suffix + index, bIndex: b.length - suffix + index });
  }
  return ops;
}

// 一處差異：左右各自的 token 區間（左閉右開），一側為空即為脫文或衍文。
export interface DiffHunk {
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
}

export interface CompareResult {
  left: ComparableText;
  right: ComparableText;
  aligned: boolean;
  leftMarks: Uint8Array;
  rightMarks: Uint8Array;
  hunks: DiffHunk[];
  equalChars: number;
  leftCoverage: number;
  rightCoverage: number;
  // 只比對齊段落時為各段區間（a 為左、b 為右）；全文比勘時為 null；
  // 要求只比段落卻找不到時為空陣列，此時其餘欄位是全文比勘的結果。
  blocks: AlignedBlock[] | null;
  // 不在任何對齊段落中的字（只比對齊段落時才有）。
  leftOutside: Uint8Array | null;
  rightOutside: Uint8Array | null;
}

// 把逐字差異轉成標記與異文列表，回傳相同的字數。offset 為這段在全文中的起點。
function collectHunks(
  ops: DiffOp[],
  aOffset: number,
  bOffset: number,
  leftMarks: Uint8Array,
  rightMarks: Uint8Array,
  hunks: DiffHunk[],
): number {
  let equalChars = 0;
  let open: DiffHunk | null = null;
  let aCursor = aOffset;
  let bCursor = bOffset;
  for (const op of ops) {
    const aIndex = op.aIndex + aOffset;
    const bIndex = op.bIndex + bOffset;
    if (op.type === "equal") {
      equalChars += 1;
      if (open) {
        hunks.push(open);
        open = null;
      }
      aCursor = aIndex + 1;
      bCursor = bIndex + 1;
      continue;
    }
    if (!open) {
      open = { aStart: aCursor, aEnd: aCursor, bStart: bCursor, bEnd: bCursor };
    }
    if (op.type === "delete") {
      leftMarks[aIndex] = 1;
      open.aEnd = aIndex + 1;
      aCursor = aIndex + 1;
    } else {
      rightMarks[bIndex] = 1;
      open.bEnd = bIndex + 1;
      bCursor = bIndex + 1;
    }
  }
  if (open) {
    hunks.push(open);
  }
  return equalChars;
}

function compareWhole(left: ComparableText, right: ComparableText): CompareResult {
  const leftMarks = new Uint8Array(left.tokens.length);
  const rightMarks = new Uint8Array(right.tokens.length);
  const ops = diffTokens(left.tokens, right.tokens);
  const coverage = (count: number, length: number) => (length ? count / length : 0);

  if (!ops) {
    // 差異太大無法逐字對齊時，退而標出不在共有 4 字片段中的字。
    const leftGrams = gramsOf(left.tokens, DEFAULT_GRAM_SIZE);
    const rightGrams = gramsOf(right.tokens, DEFAULT_GRAM_SIZE);
    const none = new Set<string>();
    const leftShared = sharedMask(leftGrams, new Set(rightGrams), left.tokens.length, none, DEFAULT_GRAM_SIZE);
    const rightShared = sharedMask(rightGrams, new Set(leftGrams), right.tokens.length, none, DEFAULT_GRAM_SIZE);
    leftShared.forEach((value, index) => {
      leftMarks[index] = value ? 0 : 1;
    });
    rightShared.forEach((value, index) => {
      rightMarks[index] = value ? 0 : 1;
    });
    const sharedLeft = countMarked(leftShared);
    return {
      left,
      right,
      aligned: false,
      leftMarks,
      rightMarks,
      hunks: [],
      equalChars: sharedLeft,
      leftCoverage: coverage(sharedLeft, left.tokens.length),
      rightCoverage: coverage(countMarked(rightShared), right.tokens.length),
      blocks: null,
      leftOutside: null,
      rightOutside: null,
    };
  }

  const hunks: DiffHunk[] = [];
  const equalChars = collectHunks(ops, 0, 0, leftMarks, rightMarks, hunks);
  return {
    left,
    right,
    aligned: true,
    leftMarks,
    rightMarks,
    hunks,
    equalChars,
    leftCoverage: coverage(equalChars, left.tokens.length),
    rightCoverage: coverage(equalChars, right.tokens.length),
    blocks: null,
    leftOutside: null,
    rightOutside: null,
  };
}

// 只在對齊段落內逐字比勘；段落以外的文字不參與比較。
function compareWithinBlocks(left: ComparableText, right: ComparableText, blocks: AlignedBlock[]): CompareResult {
  const leftMarks = new Uint8Array(left.tokens.length);
  const rightMarks = new Uint8Array(right.tokens.length);
  const leftOutside = new Uint8Array(left.tokens.length).fill(1);
  const rightOutside = new Uint8Array(right.tokens.length).fill(1);
  const hunks: DiffHunk[] = [];
  let equalChars = 0;
  for (const block of blocks) {
    leftOutside.fill(0, block.aStart, block.aEnd);
    rightOutside.fill(0, block.bStart, block.bEnd);
    const ops = diffTokens(left.tokens.slice(block.aStart, block.aEnd), right.tokens.slice(block.bStart, block.bEnd));
    if (ops) {
      equalChars += collectHunks(ops, block.aStart, block.bStart, leftMarks, rightMarks, hunks);
    } else {
      // 段內一致率已過半，理應不會發生；保險起見整段作一處差異。
      leftMarks.fill(1, block.aStart, block.aEnd);
      rightMarks.fill(1, block.bStart, block.bEnd);
      hunks.push({ aStart: block.aStart, aEnd: block.aEnd, bStart: block.bStart, bEnd: block.bEnd });
    }
  }
  return {
    left,
    right,
    aligned: true,
    leftMarks,
    rightMarks,
    hunks,
    equalChars,
    leftCoverage: left.tokens.length ? equalChars / left.tokens.length : 0,
    rightCoverage: right.tokens.length ? equalChars / right.tokens.length : 0,
    blocks,
    leftOutside,
    rightOutside,
  };
}

// alignOptions 不為 null 時只比對齊段落（段落按繁簡歸一後的文字找出，strict 只影響段內逐字比較）。
export function compareTexts(
  leftText: string,
  rightText: string,
  strict = false,
  alignOptions: AlignOptions | null = null,
): CompareResult {
  const left = toComparableText(leftText, strict);
  const right = toComparableText(rightText, strict);
  if (!alignOptions) {
    return compareWhole(left, right);
  }
  // 歸一與否只改變字形，不改變 token 的數目與位置，段落區間可通用。
  const blocks = alignTexts(leftText, rightText, alignOptions);
  return blocks.length > 0 ? compareWithinBlocks(left, right, blocks) : { ...compareWhole(left, right), blocks: [] };
}

// 把 token 標記轉成原文中的區間；相鄰標記（中間只隔標點）合併為一段。
export function markedRanges(text: ComparableText, marks: Uint8Array): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < marks.length; index += 1) {
    if (!marks[index]) {
      continue;
    }
    const last = ranges[ranges.length - 1];
    if (last && index > 0 && marks[index - 1]) {
      last.end = text.ends[index];
    } else {
      ranges.push({ start: text.starts[index], end: text.ends[index] });
    }
  }
  return ranges;
}
