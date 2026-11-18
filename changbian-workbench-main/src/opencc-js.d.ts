interface OpenCCLocaleConfig {
  from: "cn" | "tw" | "twp" | "hk" | "jp" | "t";
  to: "cn" | "tw" | "twp" | "hk" | "jp" | "t";
}

declare module "opencc-js" {
  export function Converter(config: OpenCCLocaleConfig): (text: string) => string;
}

// 只含單一方向詞典的分包：繁轉簡（t2cn）約 70 KB，簡轉繁（cn2t）約 1 MB。
declare module "opencc-js/t2cn" {
  export function Converter(config: OpenCCLocaleConfig): (text: string) => string;
}

declare module "opencc-js/cn2t" {
  export function Converter(config: OpenCCLocaleConfig): (text: string) => string;
}
