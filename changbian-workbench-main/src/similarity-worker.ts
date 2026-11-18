// 相似文本的計算放在背景線程：全庫兩兩比對在條目多時要數秒，不能卡住界面。
// 線程內保留各條原文與上次的對齊結果，只有原文或比對規則改變的配對才重算。
import {
  SimilarityIndex,
  type FrequentFragment,
  type SimilarityOptions,
  type SimilarMatch,
  type SimilarPair,
} from "./similarity";

// copy：兩條原文完全相同。
export type SimilarPairResult = SimilarPair & { copy: boolean };

export type SimilarityWorkerRequest =
  | {
      type: "sync";
      upserts: Array<{ id: string; text: string }>;
      removes: string[];
      options: SimilarityOptions;
    }
  | { type: "pairs"; requestId: number }
  | { type: "similar"; requestId: number; anchorId: string; limit: number };

export type SimilarityWorkerResponse =
  | { type: "pairs"; requestId: number; pairs: SimilarPairResult[]; frequentFragments: FrequentFragment[] }
  | {
      type: "similar";
      requestId: number;
      anchorId: string;
      matches: SimilarMatch[];
      frequentFragments: FrequentFragment[];
    }
  | { type: "error"; requestId: number; message: string };

const texts = new Map<string, string>();
let options: SimilarityOptions = {};
let optionsKey = "";
let index: SimilarityIndex | null = null;
let pairs: SimilarPairResult[] | null = null;

function currentIndex(): SimilarityIndex {
  if (!index) {
    index = new SimilarityIndex(
      [...texts].map(([id, text]) => ({ id, text })),
      options,
    );
  }
  return index;
}

function reply(response: SimilarityWorkerResponse) {
  self.postMessage(response);
}

self.onmessage = (event: MessageEvent<SimilarityWorkerRequest>) => {
  const data = event.data;
  if (!data) {
    return;
  }
  if (data.type === "sync") {
    let changed = false;
    for (const id of data.removes) {
      changed = texts.delete(id) || changed;
    }
    for (const { id, text } of data.upserts) {
      if (texts.get(id) !== text) {
        texts.set(id, text);
        changed = true;
      }
    }
    const nextKey = JSON.stringify(data.options);
    if (nextKey !== optionsKey) {
      options = data.options;
      optionsKey = nextKey;
      changed = true;
    }
    if (changed) {
      index = null;
      pairs = null;
    }
    return;
  }

  try {
    const current = currentIndex();
    if (data.type === "pairs") {
      pairs ??= current
        .findAllPairs()
        .map((pair) => ({ ...pair, copy: texts.get(pair.aId) === texts.get(pair.bId) }));
      reply({ type: "pairs", requestId: data.requestId, pairs, frequentFragments: current.frequentFragments });
      return;
    }
    reply({
      type: "similar",
      requestId: data.requestId,
      anchorId: data.anchorId,
      matches: current.findSimilar(data.anchorId, data.limit),
      frequentFragments: current.frequentFragments,
    });
  } catch (error) {
    reply({
      type: "error",
      requestId: data.requestId,
      message: error instanceof Error ? error.message : "similarity worker error",
    });
  }
};
