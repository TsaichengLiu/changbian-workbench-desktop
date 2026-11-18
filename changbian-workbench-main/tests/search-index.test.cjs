const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { SearchIndexService } = require("../electron/search-index.cjs");

function workspaceFixture() {
  return {
    schemaVersion: 1,
    revision: 1,
    projectOrder: ["project_1"],
    projects: {
      project_1: {
        id: "project_1",
        title: "明代政治",
        chapterIds: [],
        entryIds: ["entry_1"],
        createdAt: 1,
      },
    },
    chapters: {},
    entries: {
      entry_1: {
        id: "entry_1",
        refId: "20260101093000",
        projectId: "project_1",
        chapterId: null,
        timeText: "萬曆十年",
        summary: "改革前夕",
        sourceText: "張居正主持萬曆改革，整飭吏治。",
        note: "#政治",
        citation: "《明史》卷一百",
        createdAt: 1,
        updatedAt: 1,
      },
    },
    activeProjectId: "project_1",
    activeChapterId: null,
    selectedEntryId: "entry_1",
  };
}

test("SQLite 搜尋同時支持 FTS 長詞、短詞 fallback 與標籤", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "changbian-search-"));
  const workspacePath = path.join(directory, "workspace.json");
  const service = new SearchIndexService({ getWorkspaceFilePath: () => workspacePath });
  try {
    assert.equal(service.syncWorkspace(workspaceFixture()), true);
    const longQuery = service.search({ query: "張居正", tag: "", citationTitle: "" });
    assert.notEqual(longQuery, null, service.getStatus().message);
    assert.equal(longQuery.length, 1);
    const shortQuery = service.search({ query: "改革", tag: "", citationTitle: "" });
    assert.equal(shortQuery.length, 1);
    const tagged = service.search({ query: "", tag: "政治", citationTitle: "" });
    assert.equal(tagged.length, 1);
    const inProject = service.search({
      query: "改革",
      tag: "",
      citationTitle: "",
      projectId: "project_1",
    });
    assert.equal(inProject.length, 1);
    const outsideProject = service.search({
      query: "改革",
      tag: "",
      citationTitle: "",
      projectId: "project_missing",
    });
    assert.equal(outsideProject.length, 0);
    const outsideChapter = service.search({
      query: "改革",
      tag: "",
      citationTitle: "",
      chapterId: "chapter_missing",
    });
    assert.equal(outsideChapter.length, 0);
  } finally {
    service.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("SQLite 搜尋忽略標點，空格分隔的多個詞須同時命中", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "changbian-search-"));
  const workspacePath = path.join(directory, "workspace.json");
  const service = new SearchIndexService({ getWorkspaceFilePath: () => workspacePath });
  const search = (query) => service.search({ query, tag: "", citationTitle: "" });
  try {
    assert.equal(service.syncWorkspace(workspaceFixture()), true);
    // 原文「萬曆改革，整飭吏治。」有句讀，查詢沒有句讀也要命中，反之亦然。
    assert.equal(search("改革整飭吏治").length, 1);
    assert.equal(search("主持，萬曆").length, 1);
    assert.equal(search("改革，整").length, 1);
    assert.equal(search("張居正 吏治").length, 1);
    assert.equal(search("张居正 吏治").length, 1);
    assert.equal(search("張居正 海瑞").length, 0);
    assert.equal(search("。，").length, 0);
    const scoped = service.search({ query: "改革整飭", tag: "", citationTitle: "", queryScopes: ["note"] });
    assert.equal(scoped.length, 0);
  } finally {
    service.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("SQLite 搜尋可按編號查找；舊版索引（沒有編號欄）會自動重建", () => {
  const Database = require("better-sqlite3");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "changbian-search-"));
  const workspacePath = path.join(directory, "workspace.json");
  const search = (service, query, queryScopes) => service.search({ query, tag: "", citationTitle: "", queryScopes });
  let service = new SearchIndexService({ getWorkspaceFilePath: () => workspacePath });
  try {
    assert.equal(service.syncWorkspace(workspaceFixture()), true);
    assert.equal(search(service, "20260101093000").length, 1);
    assert.equal(search(service, "20260101093000", ["refId"]).length, 1);
    assert.equal(search(service, "20260101093000", ["note"]).length, 0);
    const dbPath = service.dbPath;
    service.close();

    // 模擬舊版索引：資料表沒有 ref_variants 欄。
    const legacy = new Database(dbPath);
    legacy.exec(`
      DROP TABLE entries_fts;
      CREATE VIRTUAL TABLE entries_fts USING fts5(
        entry_id UNINDEXED, project_id UNINDEXED, chapter_id UNINDEXED, project_title UNINDEXED,
        chapter_title UNINDEXED, time_text UNINDEXED, summary_text UNINDEXED, snippet UNINDEXED,
        citation_preview UNINDEXED, tags_token UNINDEXED, citation_titles_variants UNINDEXED,
        project_variants, chapter_variants, time_variants, summary_variants, source_variants,
        note_variants, citation_variants, tokenize='trigram', detail='none', columnsize=0
      );
    `);
    legacy.close();

    service = new SearchIndexService({ getWorkspaceFilePath: () => workspacePath });
    assert.equal(service.syncWorkspace(workspaceFixture()), true);
    assert.equal(search(service, "20260101093000").length, 1);
    assert.equal(search(service, "張居正").length, 1);
  } finally {
    service.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("SQLite 索引：重啟後只更新改動的條目，未改動時不重建", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "changbian-search-"));
  const workspacePath = path.join(directory, "workspace.json");
  const open = () => {
    const service = new SearchIndexService({ getWorkspaceFilePath: () => workspacePath });
    service.rebuildCalls = 0;
    const rebuild = service.rebuild.bind(service);
    service.rebuild = (workspace) => {
      service.rebuildCalls += 1;
      return rebuild(workspace);
    };
    return service;
  };
  const search = (service, query) => service.search({ query, tag: "", citationTitle: "" });
  let service = open();
  try {
    assert.equal(service.syncWorkspace(workspaceFixture()), true);
    assert.equal(service.rebuildCalls, 1);
    service.close();

    // 重啟、內容未變：不重建。
    service = open();
    assert.equal(service.syncWorkspace(workspaceFixture()), true);
    assert.equal(service.rebuildCalls, 0);
    assert.equal(search(service, "張居正").length, 1);
    service.close();

    // 重啟、改了一條並改了專案名：只更新這條，查得到新內容與新專案名。
    const changed = workspaceFixture();
    changed.entries.entry_1.sourceText = "海瑞上疏，直言時弊。";
    changed.projects.project_1.title = "嘉靖朝政";
    service = open();
    assert.equal(service.syncWorkspace(changed), true);
    assert.equal(service.rebuildCalls, 0);
    assert.equal(search(service, "海瑞上疏").length, 1);
    assert.equal(search(service, "張居正").length, 0);
    assert.equal(service.search({ query: "嘉靖朝", tag: "", citationTitle: "", queryScopes: ["project"] }).length, 1);
  } finally {
    service.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("SQLite 索引：繁體查詢可命中簡體原文，整批重建後壓縮空閒空間", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "changbian-search-"));
  const workspacePath = path.join(directory, "workspace.json");
  const service = new SearchIndexService({ getWorkspaceFilePath: () => workspacePath });
  try {
    const workspace = workspaceFixture();
    workspace.entries.entry_1.sourceText = "张居正主持万历改革，整饬吏治。";
    assert.equal(service.syncWorkspace(workspace), true);
    assert.equal(service.search({ query: "張居正主持", tag: "", citationTitle: "" }).length, 1);
    assert.equal(service.search({ query: "萬曆", tag: "", citationTitle: "" }).length, 1);

    // 大量條目寫入後全部刪去：空閒頁過多時應自動壓縮。
    const big = workspaceFixture();
    for (let index = 0; index < 400; index += 1) {
      big.entries[`bulk_${index}`] = {
        ...big.entries.entry_1,
        id: `bulk_${index}`,
        refId: `2026010109${String(index).padStart(4, "0")}`,
        sourceText: `第${index}條：${"甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥".repeat(40)}${index}`,
      };
    }
    assert.equal(service.rebuild(big), true);
    const pagesBefore = Number(service.db.pragma("page_count", { simple: true }));
    assert.equal(service.rebuild(workspaceFixture()), true);
    const pagesAfter = Number(service.db.pragma("page_count", { simple: true }));
    const freePages = Number(service.db.pragma("freelist_count", { simple: true }));
    assert.ok(pagesAfter < pagesBefore / 2, `${pagesBefore} -> ${pagesAfter}`);
    assert.ok(freePages < 256, `free pages ${freePages}`);
  } finally {
    service.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
