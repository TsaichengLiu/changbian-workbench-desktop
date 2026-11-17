import * as OpenCC from "opencc-js";

let twToCnConverter: ((text: string) => string) | null = null;
let cnToTwConverter: ((text: string) => string) | null = null;

try {
  twToCnConverter = OpenCC.Converter({ from: "tw", to: "cn" });
  cnToTwConverter = OpenCC.Converter({ from: "cn", to: "tw" });
} catch {
  twToCnConverter = null;
  cnToTwConverter = null;
}

// 檢索、標黃與比勘時忽略標點、符號與空白，句讀有無不影響比對。
// □ ■ 是缺字符號，代表一個字，保留。
const IGNORABLE_CHAR = /(?![□■])[\p{P}\p{S}\p{Z}\p{Cc}\p{Cf}]/u;
const IGNORABLE_CHARS = /(?![□■])[\p{P}\p{S}\p{Z}\p{Cc}\p{Cf}]/gu;

export function isIgnorableChar(char: string): boolean {
  return IGNORABLE_CHAR.test(char);
}

// 查詢以空白分隔為多個詞，每個詞都須命中；詞內的標點不計。
export function splitQueryTerms(query: string): string[] {
  return query.split(/\s+/).filter(Boolean);
}

function clean(text: string): string {
  return text.toLocaleLowerCase().replace(IGNORABLE_CHARS, "");
}

export function toSimplified(text: string): string {
  return twToCnConverter ? twToCnConverter(text) : text;
}

export function buildVariants(text: string): string[] {
  const base = clean(text);
  if (!base) {
    return [];
  }

  const set = new Set<string>([base]);

  if (twToCnConverter) {
    set.add(clean(twToCnConverter(text)));
  }

  if (cnToTwConverter) {
    set.add(clean(cnToTwConverter(text)));
  }

  return [...set].filter(Boolean);
}

export function matchesTraditionalSimplified(haystack: string, query: string): boolean {
  const queryVariants = buildVariants(query);
  if (queryVariants.length === 0) {
    return true;
  }

  const haystackVariants = buildVariants(haystack);
  return queryVariants.some((queryVariant) =>
    haystackVariants.some((haystackVariant) => haystackVariant.includes(queryVariant)),
  );
}
