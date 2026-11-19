// 模糊檢索放在背景線程：逐條做近似比對，條目多時要上百毫秒，不能卡住界面。
// 線程只在第一次用模糊檢索時建立；內容改動後由界面重新送一次全庫（與檢索線程相同的做法）。
import {
  buildFuzzyDocuments,
  fuzzySearch,
  type FuzzyCriteria,
  type FuzzyDocument,
  type FuzzySearchResult,
} from "./fuzzy-search";
import type { WorkspaceData } from "./types";

export type FuzzyWorkerRequest =
  | { type: "index"; payload: WorkspaceData }
  | { type: "search"; requestId: number; criteria: FuzzyCriteria };

export type FuzzyWorkerResponse =
  | { type: "result"; requestId: number; results: FuzzySearchResult[] }
  | { type: "error"; requestId: number; message: string };

let docs: FuzzyDocument[] = [];

self.onmessage = (event: MessageEvent<FuzzyWorkerRequest>) => {
  const data = event.data;
  if (!data) {
    return;
  }
  if (data.type === "index") {
    // 歸一結果按原文緩存，內容未改的條目不必重算，所以這裡不清緩存（緩存有上限）。
    docs = buildFuzzyDocuments(data.payload);
    return;
  }
  try {
    const response: FuzzyWorkerResponse = {
      type: "result",
      requestId: data.requestId,
      results: fuzzySearch(docs, data.criteria),
    };
    self.postMessage(response);
  } catch (error) {
    const response: FuzzyWorkerResponse = {
      type: "error",
      requestId: data.requestId,
      message: error instanceof Error ? error.message : "fuzzy search worker error",
    };
    self.postMessage(response);
  }
};
