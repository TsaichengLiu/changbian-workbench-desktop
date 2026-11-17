const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");
const esbuild = require("esbuild");

// 瀏覽器版（Web Worker）用的檢索引擎是 TypeScript，測試時用 esbuild 即時打包成 CommonJS 再載入。
function loadSearchEngine() {
  const entry = path.join(__dirname, "..", "src", "search-engine.ts");
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

const { buildSearchIndex, searchInIndex } = loadSearchEngine();

const index = buildSearchIndex({
  projectOrder: ["p1"],
  projects: { p1: { id: "p1", title: "國變相關", chapterIds: ["c1"] } },
  chapters: { c1: { id: "c1", projectId: "p1", title: "史可法致多爾袞書", entryIds: ["e1", "e2"] } },
  entries: {
    e1: {
      id: "e1",
      projectId: "p1",
      chapterId: "c1",
      timeText: "崇禎十七年秋",
      summary: "史可法書異文",
      sourceText: "君父之仇，不共戴天。闖賊手毒君親，中國臣民，不聞加遺一矢。",
      note: "#爲明復仇",
      citation: "《明季南略》",
    },
    e2: {
      id: "e2",
      projectId: "p1",
      chapterId: "c1",
      timeText: "崇禎十七年冬",
      summary: "高傑覆豪格書",
      sourceText: "史可法提兵救之，隨抵揚州。",
      note: "",
      citation: "",
    },
  },
});

const ids = (query) =>
  searchInIndex(index, { query, tag: "", citationTitle: "" }).map((result) => result.entryId);

test("檢索忽略標點：無句讀的查詢能找到有句讀的原文", () => {
  assert.deepEqual(ids("君父之仇不共戴天"), ["e1"]);
  assert.deepEqual(ids("闖賊手毒君親中國臣民"), ["e1"]);
  assert.deepEqual(ids("不共戴天，闖賊"), ["e1"]);
});

test("檢索：空格分隔的多個詞須同時命中，可跨欄位", () => {
  assert.deepEqual(ids("史可法 揚州"), ["e2"]);
  assert.deepEqual(ids("史可法 戴天"), ["e1"]);
  assert.deepEqual(ids("史可法"), ["e1", "e2"]);
  assert.deepEqual(ids("史可法 海瑞"), []);
});

test("檢索：繁簡仍互通，只有標點的查詢不命中任何條目", () => {
  assert.deepEqual(ids("为明复仇"), ["e1"]);
  assert.deepEqual(ids("，。"), []);
});
