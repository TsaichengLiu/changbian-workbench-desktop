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
