// 模糊檢索：在條目文字中找一句話的「近似」出現處——容許異文、脫文、衍文，不要求逐字相同。
// 比對前與一般檢索一樣去掉標點、逐字轉為簡體（toComparableText），每個字的位置都能對回原文。
// 做法：先用檢索句中的一至三字片段在原文中投票，找出可能的位置；再在這些位置附近做編輯距離對齊
// （Sellers 算法：檢索句須整句對上、原文起止不限），相似度 = 1 − 編輯距離 ÷ 檢索句字數。
import { diffTokens, toComparableText } from "./similarity";
import { splitQueryTerms } from "./search";
import type { SearchResult, SearchScope } from "./search-engine";
import type { WorkspaceData } from "./types";
import { summarize } from "./utils";

export const FUZZY_DEFAULT_MIN_SIMILARITY = 0.75;
export const FUZZY_MIN_SIMILARITY_FLOOR = 0.4;

export interface FuzzyHit {
  start: number; // 在 tokens 中的起點（含）
  end: number; // 終點（不含）
  distance: number;
  similarity: number;
  matches: number; // 命中中與檢索句相同的字數
}

const MAX_WINDOWS = 64;

// 在已歸一的原文 tokens 中找 query 的近似出現處，返回互不重疊的命中（按位置排序）。
export function approximateMatches(
  text: string[],
  query: string[],
  minSimilarity: number,
  maxHits = 8,
): FuzzyHit[] {
  const m = query.length;
  const n = text.length;
  if (m === 0 || n === 0) {
    return [];
  }
  const maxDistance = Math.max(0, Math.min(m - 1, Math.floor(m * (1 - minSimilarity) + 1e-9)));

  // 片段長度：在 q-gram 引理（d 處編輯至少保留 m−k+1−k·d 個片段）仍能篩選時取較長的。
  let k = 1;
  if (m - 3 + 1 - 3 * maxDistance >= 2) {
    k = 3;
  } else if (m - 2 + 1 - 2 * maxDistance >= 2) {
    k = 2;
  }
  const grams = new Map<string, number[]>();
  for (let i = 0; i + k <= m; i += 1) {
    const gram = query.slice(i, i + k).join("");
    const list = grams.get(gram);
    if (list) {
      list.push(i);
    } else {
      grams.set(gram, [i]);
    }
  }
  const band = Math.max(4, Math.floor(m / 3));
  const votes = new Map<number, number>();
  for (let j = 0; j + k <= n; j += 1) {
    const gram = k === 1 ? text[j] : k === 2 ? text[j] + text[j + 1] : text[j] + text[j + 1] + text[j + 2];
    const positions = grams.get(gram);
    if (!positions) {
      continue;
    }
    for (const qi of positions) {
      const key = Math.floor((j - qi) / band);
      votes.set(key, (votes.get(key) ?? 0) + 1);
    }
  }
  if (votes.size === 0) {
    return [];
  }
  const need = Math.max(1, m - k + 1 - k * maxDistance);
  const bands = [...votes]
    .filter(([, count]) => count >= need)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_WINDOWS)
    .map(([key]) => key)
    .sort((a, b) => a - b);

  // 相鄰的候選合併成窗口
  const windows: Array<[number, number]> = [];
  for (const key of bands) {
    const start = Math.max(0, key * band - maxDistance - band);
    const end = Math.min(n, key * band + band + m + maxDistance + band);
    const last = windows[windows.length - 1];
    if (last && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      windows.push([start, end]);
    }
  }

  const candidates: FuzzyHit[] = [];
  for (const [ws, we] of windows) {
    sellers(text, ws, we, query, maxDistance, candidates);
  }
  // 取距離最小的、互不重疊的命中。同距離時取相同字較多的（「天亡我」對「天之亡我」，不把「天」算作脫文），
  // 再同時取較短的（「誤朕。朕無面目」中，「死」是脫文，不是把上句的「朕」改成了「死」）。
  candidates.sort(
    (a, b) =>
      a.distance - b.distance ||
      b.matches - a.matches ||
      a.end - a.start - (b.end - b.start) ||
      a.start - b.start,
  );
  const picked: FuzzyHit[] = [];
  for (const hit of candidates) {
    if (picked.every((other) => hit.end <= other.start || hit.start >= other.end)) {
      picked.push(hit);
      if (picked.length >= maxHits) {
        break;
      }
    }
  }
  return picked.sort((a, b) => a.start - b.start);
}

// 半全局編輯距離：query 須整句對上，text[ws, we) 中起止不限；同時記下每條路徑的起點與相同字數。
// 每格取距離最小的路徑；同距離取相同字較多的，再同時取起點較晚（較短）的。
// 距離與相同字數都沿路徑相加，按這個次序逐格取優，終點上得到的也是整體最優。
function sellers(text: string[], ws: number, we: number, query: string[], maxDistance: number, out: FuzzyHit[]): void {
  const width = we - ws;
  const m = query.length;
  let prevCost = new Int32Array(width + 1);
  let prevStart = new Int32Array(width + 1);
  let prevSame = new Int32Array(width + 1);
  let cost = new Int32Array(width + 1);
  let start = new Int32Array(width + 1);
  let same = new Int32Array(width + 1);
  for (let j = 0; j <= width; j += 1) {
    prevStart[j] = j;
  }
  for (let i = 1; i <= m; i += 1) {
    const q = query[i - 1];
    cost[0] = i;
    start[0] = 0;
    same[0] = 0;
    for (let j = 1; j <= width; j += 1) {
      const equal = text[ws + j - 1] === q;
      let c = prevCost[j - 1] + (equal ? 0 : 1);
      let sm = prevSame[j - 1] + (equal ? 1 : 0);
      let s = prevStart[j - 1];
      const up = prevCost[j] + 1;
      if (up < c || (up === c && (prevSame[j] > sm || (prevSame[j] === sm && prevStart[j] > s)))) {
        c = up;
        sm = prevSame[j];
        s = prevStart[j];
      }
      const left = cost[j - 1] + 1;
      if (left < c || (left === c && (same[j - 1] > sm || (same[j - 1] === sm && start[j - 1] > s)))) {
        c = left;
        sm = same[j - 1];
        s = start[j - 1];
      }
      cost[j] = c;
      same[j] = sm;
      start[j] = s;
    }
    [prevCost, cost] = [cost, prevCost];
    [prevStart, start] = [start, prevStart];
    [prevSame, same] = [same, prevSame];
  }
  for (let j = 1; j <= width; j += 1) {
    const d = prevCost[j];
    if (d <= maxDistance && j > prevStart[j]) {
      out.push({ start: ws + prevStart[j], end: ws + j, distance: d, similarity: 1 - d / m, matches: prevSame[j] });
    }
  }
}

// ---------------------------------------------------------------- 標黃
export interface FuzzyRange {
  start: number;
  end: number;
  same: boolean; // 與檢索句相同的字；false 為異文或多出的字
}

// 原文中所有近似命中的範圍（對回原文的字元位置），命中內再分「與檢索句相同」和「不同」兩種。
export function fuzzyHighlightRanges(text: string, query: string, minSimilarity: number): FuzzyRange[] {
  if (!text) {
    return [];
  }
  const comparable = toComparableText(text);
  const ranges: FuzzyRange[] = [];
  for (const term of splitQueryTerms(query)) {
    const termTokens = toComparableText(term).tokens;
    if (termTokens.length === 0) {
      continue;
    }
    for (const hit of approximateMatches(comparable.tokens, termTokens, minSimilarity, 40)) {
      const hitTokens = comparable.tokens.slice(hit.start, hit.end);
      const same = new Array<boolean>(hitTokens.length).fill(false);
      const ops = diffTokens(termTokens, hitTokens, 400);
      if (ops) {
        for (const op of ops) {
          if (op.type === "equal") {
            same[op.bIndex] = true;
          }
        }
      }
      let runStart = 0;
      for (let index = 1; index <= hitTokens.length; index += 1) {
        if (index === hitTokens.length || same[index] !== same[runStart]) {
          ranges.push({
            start: comparable.starts[hit.start + runStart],
            end: comparable.ends[hit.start + index - 1],
            same: same[runStart],
          });
          runStart = index;
        }
      }
    }
  }
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: FuzzyRange[] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.start < last.end) {
      continue; // 多個檢索詞的命中重疊時，保留先出現的
    }
    merged.push(range);
  }
  return merged;
}

// ---------------------------------------------------------------- 全庫檢索（在背景線程中運行）
const TAG_REGEX = /#([^\s#，。；、,.;:!?！？【】（）()<>《》]+)/g;

export interface FuzzyDocument {
  result: SearchResult;
  fields: Record<SearchScope, string>;
  tagLowerSet: string[];
}

export interface FuzzyCriteria {
  query: string;
  queryScopes?: SearchScope[];
  tag: string;
  minSimilarity: number;
  projectId?: string;
  chapterId?: string;
  limit?: number;
}

export type FuzzySearchResult = SearchResult & { similarity: number };

function extractTags(text: string): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(TAG_REGEX)) {
    const token = `#${(match[1] ?? "").trim()}`;
    const key = token.toLocaleLowerCase();
    if (token === "#" || seen.has(key)) {
      continue;
    }
    seen.add(key);
    tags.push(token);
  }
  return tags;
}

export function buildFuzzyDocuments(workspace: WorkspaceData): FuzzyDocument[] {
  const docs: FuzzyDocument[] = [];
  for (const projectId of workspace.projectOrder) {
    const project = workspace.projects[projectId];
    if (!project) {
      continue;
    }
    for (const chapterId of project.chapterIds) {
      const chapter = workspace.chapters[chapterId];
      if (!chapter) {
        continue;
      }
      for (const entryId of chapter.entryIds) {
        const entry = workspace.entries[entryId];
        if (!entry) {
          continue;
        }
        const tags = extractTags(entry.note);
        docs.push({
          result: {
            projectId: project.id,
            chapterId: chapter.id,
            entryId: entry.id,
            projectTitle: project.title,
            chapterTitle: chapter.title,
            timeText: entry.timeText,
            summaryText: entry.summary,
            snippet: summarize(entry.sourceText, 120),
            citation: summarize(entry.citation, 80),
            tags,
          },
          fields: {
            project: project.title,
            chapter: chapter.title,
            time: entry.timeText,
            summary: entry.summary,
            source: entry.sourceText,
            note: entry.note,
            citation: entry.citation,
            refId: entry.refId ?? "",
          },
          tagLowerSet: tags.map((tag) => tag.toLocaleLowerCase()),
        });
      }
    }
  }
  return docs;
}

// 各欄位歸一後的字串按原文緩存：反覆檢索時不必重算。
const foldCache = new Map<string, string[]>();

export function clearFuzzyCache(): void {
  foldCache.clear();
}

function foldedTokens(text: string): string[] {
  let tokens = foldCache.get(text);
  if (!tokens) {
    tokens = toComparableText(text).tokens;
    if (foldCache.size > 20000) {
      foldCache.clear();
    }
    foldCache.set(text, tokens);
  }
  return tokens;
}

const ALL_SCOPES: SearchScope[] = ["project", "chapter", "time", "summary", "source", "note", "citation", "refId"];

// 每個檢索詞（空白分隔）都須在所選欄位中近似出現；條目的相似度取各詞中最低的一個。結果按相似度排序。
export function fuzzySearch(docs: FuzzyDocument[], criteria: FuzzyCriteria): FuzzySearchResult[] {
  const minSimilarity = Math.max(FUZZY_MIN_SIMILARITY_FLOOR, Math.min(1, criteria.minSimilarity));
  const terms = splitQueryTerms(criteria.query.trim())
    .map((term) => toComparableText(term).tokens)
    .filter((tokens) => tokens.length > 0);
  const tag = criteria.tag.trim();
  const normalizedTag = tag ? (tag.startsWith("#") ? tag : `#${tag}`).toLocaleLowerCase() : "";
  if (terms.length === 0) {
    return [];
  }
  const scopes = criteria.queryScopes && criteria.queryScopes.length > 0 ? criteria.queryScopes : ALL_SCOPES;
  const output: Array<FuzzySearchResult & { order: number }> = [];
  docs.forEach((doc, order) => {
    if (criteria.projectId && doc.result.projectId !== criteria.projectId) {
      return;
    }
    if (criteria.chapterId && doc.result.chapterId !== criteria.chapterId) {
      return;
    }
    if (normalizedTag && !doc.tagLowerSet.includes(normalizedTag)) {
      return;
    }
    let score = 1;
    for (const term of terms) {
      let best = 0;
      for (const scope of scopes) {
        const text = doc.fields[scope];
        if (!text) {
          continue;
        }
        const [hit] = approximateMatches(foldedTokens(text), term, minSimilarity, 1);
        if (hit && hit.similarity > best) {
          best = hit.similarity;
          if (best >= 1) {
            break;
          }
        }
      }
      score = Math.min(score, best);
      if (score < minSimilarity) {
        return;
      }
    }
    output.push({ ...doc.result, similarity: score, order });
  });
  output.sort((a, b) => b.similarity - a.similarity || a.order - b.order);
  const limit = Math.max(1, Math.min(2000, criteria.limit ?? 600));
  return output.slice(0, limit).map(({ order: _order, ...rest }) => rest);
}
