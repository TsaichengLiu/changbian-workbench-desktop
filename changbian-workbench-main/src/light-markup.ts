// 輕量標記：**粗體**、__底線__、*斜體*，換行轉 <br />。
//
// 輸入是已經插入了高亮、比勘標記（<mark>、<span>）的 HTML。標記符號可能跨過這些標籤，
// 直接用正則替換會產生 <strong><mark>甲</strong>乙</mark> 這種交錯的標籤，瀏覽器會把
// 後面的高亮截斷。這裡先在去掉標籤的純文字上配對符號（規則與逐條正則替換相同），
// 輸出時遇到標籤就先關閉、再重開格式標籤，保證嵌套正確。

type Style = "strong" | "u" | "em";

interface MarkerEvent {
  length: number;
  style: Style;
  open: boolean;
}

const RULES: Array<{ pattern: RegExp; marker: number; style: Style }> = [
  { pattern: /\*\*([^*\n]+)\*\*/g, marker: 2, style: "strong" },
  { pattern: /__([^_\n]+)__/g, marker: 2, style: "u" },
  { pattern: /\*([^*\n]+)\*/g, marker: 1, style: "em" },
];

function tokenize(html: string): Array<{ tag: boolean; text: string }> {
  const parts: Array<{ tag: boolean; text: string }> = [];
  const tagPattern = /<[^>]*>/g;
  let cursor = 0;
  for (let match = tagPattern.exec(html); match; match = tagPattern.exec(html)) {
    if (match.index > cursor) {
      parts.push({ tag: false, text: html.slice(cursor, match.index) });
    }
    parts.push({ tag: true, text: match[0] });
    cursor = match.index + match[0].length;
  }
  if (cursor < html.length) {
    parts.push({ tag: false, text: html.slice(cursor) });
  }
  return parts;
}

/** 在純文字上找出各條規則配對成功的符號位置（位置以原純文字計）。 */
function findMarkers(plain: string): Map<number, MarkerEvent> {
  const events = new Map<number, MarkerEvent>();
  // 每條規則配對後，其符號從文字中移除，下一條規則在剩下的文字上配對（與逐條替換一致）。
  let positions = Array.from({ length: plain.length }, (_, index) => index);
  let text = plain;
  for (const rule of RULES) {
    const removed = new Set<number>();
    rule.pattern.lastIndex = 0;
    for (let match = rule.pattern.exec(text); match; match = rule.pattern.exec(text)) {
      const openAt = match.index;
      const closeAt = match.index + match[0].length - rule.marker;
      events.set(positions[openAt], { length: rule.marker, style: rule.style, open: true });
      events.set(positions[closeAt], { length: rule.marker, style: rule.style, open: false });
      for (let offset = 0; offset < rule.marker; offset += 1) {
        removed.add(openAt + offset);
        removed.add(closeAt + offset);
      }
    }
    if (removed.size) {
      // 位置一律以 UTF-16 碼元計，與正則的 index 一致。
      positions = positions.filter((_, index) => !removed.has(index));
      text = text
        .split("")
        .filter((_, index) => !removed.has(index))
        .join("");
    }
  }
  return events;
}

export function applyLightMarkup(html: string): string {
  const parts = tokenize(html);
  const plain = parts
    .filter((part) => !part.tag)
    .map((part) => part.text)
    .join("");
  const events = findMarkers(plain);
  if (!events.size) {
    return html.replace(/\r?\n/g, "<br />");
  }

  const open: Style[] = [];
  const closeAll = () =>
    open
      .slice()
      .reverse()
      .map((style) => `</${style}>`)
      .join("");
  const reopenAll = () => open.map((style) => `<${style}>`).join("");
  let out = "";
  let position = 0;
  // 符號本身不輸出；理論上符號不會被標籤隔開，但仍按位置跨段跳過。
  let skip = 0;
  for (const part of parts) {
    if (part.tag) {
      // 格式標籤不跨過其他標籤：先關閉，標籤之後再重開。
      out += open.length ? `${closeAll()}${part.text}${reopenAll()}` : part.text;
      continue;
    }
    for (let index = 0; index < part.text.length; index += 1, position += 1) {
      if (skip > 0) {
        skip -= 1;
        continue;
      }
      const event = events.get(position);
      if (!event) {
        out += part.text[index];
        continue;
      }
      skip = event.length - 1;
      if (event.open) {
        open.push(event.style);
        out += `<${event.style}>`;
        continue;
      }
      // 配對保證先開後關；若其後還開著別的格式，先一併關閉，再把那些重開，維持嵌套。
      const inner = open.splice(open.lastIndexOf(event.style));
      out += inner
        .slice()
        .reverse()
        .map((style) => `</${style}>`)
        .join("");
      for (const style of inner.slice(1)) {
        open.push(style);
        out += `<${style}>`;
      }
    }
  }
  out += closeAll();
  // 關閉再重開會留下空的格式標籤對，去掉。
  let previous = "";
  while (previous !== out) {
    previous = out;
    out = out.replace(/<(strong|u|em)><\/\1>/g, "");
  }
  return out.replace(/\r?\n/g, "<br />");
}
