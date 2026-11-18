// 比對用的文字歸一：忽略標點、轉為簡體。
// 只引入 opencc 的「繁轉簡」部分（約 70 KB），不帶「簡轉繁」詞典；相似文本的背景線程只用到這裡。
import { Converter } from "opencc-js/t2cn";

// 檢索、標黃與比勘時忽略標點、符號與空白，句讀有無不影響比對。
// □ ■ 是缺字符號，代表一個字，保留。
const IGNORABLE_CHAR = /(?![□■])[\p{P}\p{S}\p{Z}\p{Cc}\p{Cf}]/u;

export function isIgnorableChar(char: string): boolean {
  return IGNORABLE_CHAR.test(char);
}

// 轉換器在第一次用到時才建立（建立時要把詞典讀成樹，頗佔記憶體）。
let twToCnConverter: ((text: string) => string) | null | undefined;

export function toSimplified(text: string): string {
  if (twToCnConverter === undefined) {
    try {
      twToCnConverter = Converter({ from: "tw", to: "cn" });
    } catch {
      twToCnConverter = null;
    }
  }
  return twToCnConverter ? twToCnConverter(text) : text;
}
