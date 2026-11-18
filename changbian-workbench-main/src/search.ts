import { Converter as cnToTwBuilder } from "opencc-js/cn2t";
import { isIgnorableChar, toSimplified } from "./text-fold";

export { isIgnorableChar, toSimplified };

// 「簡轉繁」只有瀏覽器版的檢索用得到（桌面版由主程序的 SQLite 索引處理），第一次用到時才建立。
let cnToTwConverter: ((text: string) => string) | null | undefined;

function toTraditional(text: string): string | null {
  if (cnToTwConverter === undefined) {
    try {
      cnToTwConverter = cnToTwBuilder({ from: "cn", to: "tw" });
    } catch {
      cnToTwConverter = null;
    }
  }
  return cnToTwConverter ? cnToTwConverter(text) : null;
}

const IGNORABLE_CHARS = /(?![□■])[\p{P}\p{S}\p{Z}\p{Cc}\p{Cf}]/gu;

// 查詢以空白分隔為多個詞，每個詞都須命中；詞內的標點不計。
export function splitQueryTerms(query: string): string[] {
  return query.split(/\s+/).filter(Boolean);
}

function clean(text: string): string {
  return text.toLocaleLowerCase().replace(IGNORABLE_CHARS, "");
}

export function buildVariants(text: string): string[] {
  const base = clean(text);
  if (!base) {
    return [];
  }

  const set = new Set<string>([base]);
  set.add(clean(toSimplified(text)));
  const traditional = toTraditional(text);
  if (traditional !== null) {
    set.add(clean(traditional));
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
