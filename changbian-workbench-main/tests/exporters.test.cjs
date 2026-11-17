const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");
const esbuild = require("esbuild");
const JSZip = require("jszip");

// 打包 exporters.ts；下載改為攔截，便於檢查匯出內容（插件只能用非同步 API）。
async function loadExporters() {
  const entry = path.join(__dirname, "..", "src", "exporters.ts");
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    logLevel: "silent",
    plugins: [
      {
        name: "capture-download",
        setup(build) {
          build.onResolve({ filter: /^\.\/utils$/ }, () => ({ path: "utils-stub", namespace: "stub" }));
          build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
            contents:
              "export function downloadBlob(blob, name) { globalThis.__exported = { blob, name }; }\n" +
              "export function sanitizeFilename(name) { return name; }",
            loader: "js",
          }));
        },
      },
    ],
  });
  const compiled = new Module(entry);
  compiled.paths = Module._nodeModulePaths(path.dirname(entry));
  compiled._compile(result.outputFiles[0].text, entry);
  return compiled.exports;
}

const exportersReady = loadExporters();

function entry(id, refId, projectId, chapterId, fields = {}) {
  return {
    id,
    refId,
    projectId,
    chapterId,
    timeText: "崇禎十七年",
    summary: "",
    sourceText: "原文",
    note: "",
    citation: "",
    createdAt: 0,
    updatedAt: 0,
    ...fields,
  };
}

const workspace = {
  schemaVersion: 1,
  revision: 0,
  projectOrder: ["p1", "p2"],
  projects: {
    p1: { id: "p1", title: "甲專案", chapterIds: ["c1"], createdAt: 0 },
    p2: { id: "p2", title: "乙專案", chapterIds: ["c2"], createdAt: 0 },
  },
  chapters: {
    c1: { id: "c1", projectId: "p1", title: "第一章", entryIds: ["a", "b"], createdAt: 0 },
    c2: { id: "c2", projectId: "p2", title: "第二章", entryIds: ["c"], createdAt: 0 },
  },
  entries: {
    a: entry("a", "20260101000001", "p1", "c1", {
      summary: "甲條",
      note: "參見[[20260101000002]]，另見[[20260101000003]]，[[20990101000000]] 已刪。",
    }),
    b: entry("b", "20260101000002", "p1", "c1", { summary: "乙條" }),
    c: entry("c", "20260101000003", "p2", "c2", { summary: "丙條" }),
  },
  trash: [],
  activeProjectId: "p1",
  activeChapterId: "c1",
  selectedEntryId: "a",
};

test("TXT 匯出帶編號，鏈接附上目標標題", async () => {
  const { exportAsTxt } = await exportersReady;
  exportAsTxt(workspace, "active");
  const text = await globalThis.__exported.blob.text();
  assert.match(text, /編號：20260101000001/);
  assert.match(text, /參見\[\[20260101000002\]\]〈崇禎十七年｜乙條〉/);
  assert.match(text, /另見\[\[20260101000003\]\]〈崇禎十七年｜丙條〉/);
  assert.match(text, /\[\[20990101000000\]\] 已刪/);
});

test("Word 匯出：條目有書籤；鏈接本次匯出中的條目為文檔內連結，其餘保留編號", async () => {
  const { exportAsDocx } = await exportersReady;
  await exportAsDocx(workspace, "active");
  const zip = await JSZip.loadAsync(await globalThis.__exported.blob.arrayBuffer());
  const xml = await zip.file("word/document.xml").async("string");
  assert.match(xml, /w:bookmarkStart[^>]*w:name="ref_20260101000002"/);
  assert.match(xml, /<w:hyperlink[^>]*w:anchor="ref_20260101000002"/);
  assert.match(xml, /→崇禎十七年｜乙條/);
  // 丙條在乙專案，不在本次（目前專案）匯出中：不做連結，保留編號與標題。
  assert.doesNotMatch(xml, /w:anchor="ref_20260101000003"/);
  assert.match(xml, /\[\[20260101000003\]\]〈崇禎十七年｜丙條〉/);
  assert.match(xml, /編號 20260101000001/);
});
