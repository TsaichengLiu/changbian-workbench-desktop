const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");
const esbuild = require("esbuild");

// 模糊檢索是 TypeScript，測試時用 esbuild 即時打包成 CommonJS 再載入。
function loadFuzzy() {
  const entry = path.join(__dirname, "..", "src", "fuzzy-search.ts");
  const result = esbuild.buildSync({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    logLevel: "silent",
  });
  const compiled = new Module(entry);
  compiled.paths = Module._nodeModulePaths(path.dirname(entry));
  compiled._compile(result.outputFiles[0].text, entry);
  return compiled.exports;
}

const { approximateMatches, fuzzyHighlightRanges, buildFuzzyDocuments, fuzzySearch } = loadFuzzy();
const chars = (s) => [...s];

test("近似匹配：容許脫文與異文，相似度按編輯距離計", () => {
  const text = chars("項王笑曰天之亡我我何渡為且籍與江東子弟八千人渡江而西");
  const [hit] = approximateMatches(text, chars("天亡我何渡為"), 0.6, 1);
  assert.ok(hit);
  assert.equal(text.slice(hit.start, hit.end).join(""), "天之亡我我何渡為");
  assert.equal(hit.distance, 2);
  assert.ok(Math.abs(hit.similarity - (1 - 2 / 6)) < 1e-9);
  // 門檻高於實際相似度時不命中
  assert.equal(approximateMatches(text, chars("天亡我何渡為"), 0.9, 1).length, 0);
  // 完全相同時相似度為 1
  assert.equal(approximateMatches(text, chars("江東子弟"), 0.8, 1)[0].similarity, 1);
});

test("近似匹配：同距離時取相同字多的，再取較短的（脫文不誤作異文）", () => {
  // 「死」脫去：不應把上句末的「朕」拉進來當作「死」的異文
  const text = chars("皆諸臣誤朕朕無面目見祖宗於地下將髮覆面");
  const [hit] = approximateMatches(text, chars("朕死無面目見祖宗於地下"), 0.75, 1);
  assert.equal(text.slice(hit.start, hit.end).join(""), "朕無面目見祖宗於地下");
  assert.equal(hit.distance, 1);
  assert.equal(hit.matches, 10);
  const ranges = fuzzyHighlightRanges("皆諸臣誤朕。朕無面目見祖宗於地下，將髮覆面", "朕死无面目见祖宗于地下", 0.75);
  assert.equal(ranges.length, 1);
  assert.ok(ranges[0].same);
});

test("近似匹配：只找互不重疊的命中，按位置排列", () => {
  const text = chars("朕死無面目見祖宗於地下又曰朕死無顏見祖宗於地下");
  const hits = approximateMatches(text, chars("朕死無面目見祖宗於地下"), 0.7, 5);
  assert.equal(hits.length, 2);
  assert.ok(hits[0].start < hits[1].start);
  assert.equal(hits[0].similarity, 1);
  assert.ok(hits[1].similarity < 1 && hits[1].similarity >= 0.7);
});

test("標黃：對回原文位置，跨過標點；命中內區分相同與不同的字", () => {
  const text = "項王笑曰：「天之亡我，我何渡為！」";
  const ranges = fuzzyHighlightRanges(text, "天亡我何渡为", 0.6);
  assert.ok(ranges.length > 0);
  const covered = ranges.map((r) => text.slice(r.start, r.end)).join("|");
  // 「之」與重出的「我」是檢索句沒有的，標為不同；其餘標為相同（簡體輸入對上繁體原文）
  const diff = ranges.filter((r) => !r.same).map((r) => text.slice(r.start, r.end)).join("");
  assert.ok(/之/.test(diff), covered);
  assert.ok(ranges.some((r) => r.same && text.slice(r.start, r.end).includes("渡為")), covered);
  assert.ok(ranges[0].start >= text.indexOf("天"));
});

function workspace() {
  return {
    projectOrder: ["p1"],
    projects: { p1: { id: "p1", title: "甲申史料", chapterIds: ["c1"] } },
    chapters: { c1: { id: "c1", projectId: "p1", title: "崇禎遺詔", entryIds: ["e1", "e2", "e3"] } },
    entries: {
      e1: { id: "e1", projectId: "p1", chapterId: "c1", timeText: "三月十九日", summary: "遺詔", refId: "1",
        sourceText: "朕涼德藐躬，上干天咎……朕死無面目見祖宗於地下，自去冠冕，以髮覆面。", note: "#遺詔", citation: "《甲申傳信錄》" },
      e2: { id: "e2", projectId: "p1", chapterId: "c1", timeText: "", summary: "", refId: "2",
        sourceText: "朕死，無面目見祖宗，自去冠冕，以髮覆面，任賊分裂。", note: "", citation: "《明季北略》" },
      e3: { id: "e3", projectId: "p1", chapterId: "c1", timeText: "", summary: "", refId: "3",
        sourceText: "上崩於萬歲山。", note: "#遺詔", citation: "《國榷》" },
    },
  };
}

test("全庫模糊檢索：按相似度排序，未達門檻的不列", () => {
  const docs = buildFuzzyDocuments(workspace());
  const results = fuzzySearch(docs, { query: "朕死无面目见祖宗于地下", tag: "", minSimilarity: 0.6, queryScopes: ["source"] });
  assert.deepEqual(results.map((r) => r.entryId), ["e1", "e2"]);
  assert.equal(results[0].similarity, 1);
  assert.ok(results[1].similarity < 1 && results[1].similarity >= 0.6);
  const strict = fuzzySearch(docs, { query: "朕死无面目见祖宗于地下", tag: "", minSimilarity: 0.95, queryScopes: ["source"] });
  assert.deepEqual(strict.map((r) => r.entryId), ["e1"]);
});

test("全庫模糊檢索：標籤、欄位與多個詞的組合", () => {
  const docs = buildFuzzyDocuments(workspace());
  const withTag = fuzzySearch(docs, { query: "朕死无面目见祖宗", tag: "#遺詔", minSimilarity: 0.6 });
  assert.deepEqual(withTag.map((r) => r.entryId), ["e1"]);
  // 只查引文欄：史料文本中的句子不算
  assert.equal(fuzzySearch(docs, { query: "朕死无面目", tag: "", minSimilarity: 0.6, queryScopes: ["citation"] }).length, 0);
  // 兩個詞都須近似出現
  const both = fuzzySearch(docs, { query: "以髮覆面 任賊分裂", tag: "", minSimilarity: 0.7 });
  assert.deepEqual(both.map((r) => r.entryId), ["e2"]);
});
