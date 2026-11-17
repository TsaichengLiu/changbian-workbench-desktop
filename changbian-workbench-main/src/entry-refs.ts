// 條目編號與互相鏈接。
//
// 編號取條目建立時間（本機時區）的「年月日時分秒」共 14 位數字，如 20260429153801。
// 同一秒建立的條目順延一秒，直到不與已有編號重複；編號一經分配即保存下來，之後不再變動。
// 備註中以 [[編號]] 鏈接其他條目。
// electron/workspace-store.cjs 中有同樣規則的 CommonJS 版本（供桌面存檔與 MCP 使用），兩者須保持一致。

export const ENTRY_REF_ID_LENGTH = 14;

const REF_ID_PATTERN = /^\d{14}$/;
// 用於 split 時帶捕獲組，結果中奇數位置即編號。
const REF_SPLIT_PATTERN = /\[\[(\d{14})\]\]/;
const REF_GLOBAL_PATTERN = /\[\[(\d{14})\]\]/g;

export function isEntryRefId(value: unknown): value is string {
  return typeof value === "string" && REF_ID_PATTERN.test(value);
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

export function formatEntryRefId(timestamp: number): string {
  const date = new Date(Number.isFinite(timestamp) ? timestamp : Date.now());
  return (
    pad(date.getFullYear(), 4) +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  );
}

// 從 createdAt 起找第一個未被佔用的編號（每次順延一秒）。
export function nextFreeEntryRefId(createdAt: number, used: Set<string>): string {
  let time = Number.isFinite(createdAt) ? createdAt : Date.now();
  let candidate = formatEntryRefId(time);
  while (used.has(candidate)) {
    time += 1000;
    candidate = formatEntryRefId(time);
  }
  return candidate;
}

interface RefEntry {
  id: string;
  createdAt: number;
  refId?: string;
}

// 補齊缺少或重複的編號（就地修改）。已有且不重複的編號保持不變；
// 重複時按建立時間（其次 id）先到先得，後者重新分配。reserved 為不可再用的編號（如回收站中的條目）。
// 回傳被新分配或改動編號的條目：條目 id → 新編號。
export function assignEntryRefIds(
  entries: Record<string, RefEntry>,
  reserved: Iterable<string> = [],
): Map<string, string> {
  const ordered = Object.values(entries).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const used = new Set<string>(reserved);
  const pending: RefEntry[] = [];
  for (const entry of ordered) {
    if (isEntryRefId(entry.refId) && !used.has(entry.refId)) {
      used.add(entry.refId);
    } else {
      pending.push(entry);
    }
  }
  const changed = new Map<string, string>();
  for (const entry of pending) {
    const refId = nextFreeEntryRefId(entry.createdAt, used);
    used.add(refId);
    entry.refId = refId;
    changed.set(entry.id, refId);
  }
  return changed;
}

export function entryRefToken(refId: string): string {
  return `[[${refId}]]`;
}

// 文字中鏈接到的所有編號（去重，按出現順序）。
export function collectEntryRefs(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(REF_GLOBAL_PATTERN)) {
    if (!found.includes(match[1])) {
      found.push(match[1]);
    }
  }
  return found;
}

// 把文字切成普通文字與鏈接交替的片段：偶數位置是普通文字，奇數位置是編號。
export function splitEntryRefs(text: string): string[] {
  return text.split(REF_SPLIT_PATTERN);
}

// 按對照表改寫鏈接（匯入時編號改變的條目）。
export function rewriteEntryRefs(text: string, mapping: Map<string, string>): string {
  if (mapping.size === 0) {
    return text;
  }
  return text.replace(REF_GLOBAL_PATTERN, (token, refId: string) => {
    const next = mapping.get(refId);
    return next ? entryRefToken(next) : token;
  });
}
