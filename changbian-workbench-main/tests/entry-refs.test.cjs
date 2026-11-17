const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");
const esbuild = require("esbuild");
const { validateWorkspace } = require("../electron/workspace-store.cjs");

function loadEntryRefs() {
  const entry = path.join(__dirname, "..", "src", "entry-refs.ts");
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

const {
  formatEntryRefId,
  nextFreeEntryRefId,
  assignEntryRefIds,
  collectEntryRefs,
  splitEntryRefs,
  rewriteEntryRefs,
  isEntryRefId,
} = loadEntryRefs();

// 本機時區的某一刻；編號按本機時間書寫。
const at = (...parts) => new Date(...parts).getTime();

test("編號是建立時間的年月日時分秒", () => {
  assert.equal(formatEntryRefId(at(2026, 3, 29, 15, 38, 1)), "20260429153801");
  assert.equal(formatEntryRefId(at(1999, 0, 2, 3, 4, 5, 678)), "19990102030405");
  assert.equal(isEntryRefId("20260429153801"), true);
  assert.equal(isEntryRefId("2026042915380"), false);
});

test("同一秒的條目順延一秒，跨分鐘也是合法時間", () => {
  const used = new Set(["20260429153859"]);
  assert.equal(nextFreeEntryRefId(at(2026, 3, 29, 15, 38, 59), used), "20260429153900");
});

test("補齊編號：保留已有的，缺少或重複的按建立時間順延", () => {
  const base = at(2026, 3, 29, 15, 38, 1);
  const entries = {
    a: { id: "a", createdAt: base },
    b: { id: "b", createdAt: base + 200 },
    c: { id: "c", createdAt: base - 60_000, refId: "20260429153801" },
    d: { id: "d", createdAt: base + 5_000, refId: "20260429153801" },
    e: { id: "e", createdAt: base + 9_000, refId: "壞編號" },
  };
  const changed = assignEntryRefIds(entries, ["20260429153803"]);
  // c 建立得最早，保住原編號；a、b 同一秒且被佔，依次順延並跳過保留的 03。
  assert.equal(entries.c.refId, "20260429153801");
  assert.equal(entries.a.refId, "20260429153802");
  assert.equal(entries.b.refId, "20260429153804");
  assert.equal(entries.d.refId, "20260429153806");
  assert.equal(entries.e.refId, "20260429153810");
  assert.deepEqual([...changed.keys()].sort(), ["a", "b", "d", "e"]);
  // 再跑一次不會改動任何編號。
  assert.equal(assignEntryRefIds(entries).size, 0);
});

test("解析與改寫備註中的 [[編號]]", () => {
  const note = "參見[[20260429153801]]，又見 [[20260429153802]] 與[[20260429153801]]；[[123]] 不算。";
  assert.deepEqual(collectEntryRefs(note), ["20260429153801", "20260429153802"]);
  const parts = splitEntryRefs(note);
  assert.equal(parts[1], "20260429153801");
  assert.equal(parts[0], "參見");
  assert.equal(
    rewriteEntryRefs(note, new Map([["20260429153801", "20990101000000"]])),
    "參見[[20990101000000]]，又見 [[20260429153802]] 與[[20990101000000]]；[[123]] 不算。",
  );
});

test("桌面存檔讀入時補上編號，與前端規則一致，並避開回收站中的編號", () => {
  const base = at(2026, 3, 29, 15, 38, 1);
  const entry = (id, createdAt, extra = {}) => ({
    id,
    projectId: "p",
    chapterId: "c",
    timeText: "",
    summary: "",
    sourceText: "",
    note: "",
    citation: "",
    createdAt,
    updatedAt: createdAt,
    ...extra,
  });
  const raw = {
    schemaVersion: 1,
    projectOrder: ["p"],
    projects: { p: { id: "p", title: "專案", chapterIds: ["c"], createdAt: base } },
    chapters: { c: { id: "c", projectId: "p", title: "章", entryIds: ["x", "y"], createdAt: base } },
    entries: { x: entry("x", base), y: entry("y", base + 100) },
    trash: [
      {
        id: "t",
        deletedAt: base,
        label: "刪除",
        payload: { kind: "entry", entries: [{ entry: entry("z", base, { refId: "20260429153802" }), entryIndex: 0 }] },
      },
    ],
  };
  const result = validateWorkspace(structuredClone(raw));
  assert.equal(result.ok, true);
  assert.equal(result.workspace.entries.x.refId, "20260429153801");
  assert.equal(result.workspace.entries.y.refId, "20260429153803");

  const viaFrontend = structuredClone(raw.entries);
  assignEntryRefIds(viaFrontend, ["20260429153802"]);
  assert.equal(viaFrontend.x.refId, result.workspace.entries.x.refId);
  assert.equal(viaFrontend.y.refId, result.workspace.entries.y.refId);
});

test("讀入缺少編號的資料檔時標記需要寫回；已有編號時不標記", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const { readWorkspaceFile } = require("../electron/workspace-store.cjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "refid-"));
  const file = path.join(dir, "workspace.json");
  const base = at(2026, 3, 29, 15, 38, 1);
  const raw = {
    schemaVersion: 1,
    projectOrder: ["p"],
    projects: { p: { id: "p", title: "專案", chapterIds: ["c"], createdAt: base } },
    chapters: { c: { id: "c", projectId: "p", title: "章", entryIds: ["x"], createdAt: base } },
    entries: {
      x: { id: "x", projectId: "p", chapterId: "c", timeText: "", summary: "", sourceText: "", note: "", citation: "", createdAt: base, updatedAt: base },
    },
    trash: [],
  };
  fs.writeFileSync(file, JSON.stringify(raw));
  const first = readWorkspaceFile(file);
  assert.equal(first.needsSave, true);
  assert.equal(first.workspace.entries.x.refId, "20260429153801");
  fs.writeFileSync(file, JSON.stringify(first.workspace));
  assert.equal(readWorkspaceFile(file).needsSave, false);
  fs.rmSync(dir, { recursive: true, force: true });
});
