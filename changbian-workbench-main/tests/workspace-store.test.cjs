const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  WORKSPACE_SCHEMA_VERSION,
  knownRevisionIfUnchanged,
  readWorkspaceFile,
  removeStaleTempFiles,
  validateWorkspace,
  writeWorkspaceFile,
} = require("../electron/workspace-store.cjs");

function fixture(title = "測試專案") {
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    revision: 0,
    projectOrder: ["project_1"],
    projects: {
      project_1: {
        id: "project_1",
        title,
        chapterIds: [],
        entryIds: [],
        createdAt: 1,
      },
    },
    chapters: {},
    entries: {},
    trash: [],
    activeProjectId: "project_1",
    activeChapterId: null,
    selectedEntryId: null,
  };
}

test("原子寫入會遞增 revision、保留備份並拒絕過期寫入", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "changbian-store-"));
  const filePath = path.join(directory, "workspace.json");
  try {
    const first = writeWorkspaceFile(filePath, fixture("第一版"), { expectedRevision: 0 });
    assert.equal(first.ok, true);
    assert.equal(first.revision, 1);

    const stale = writeWorkspaceFile(filePath, fixture("過期版本"), { expectedRevision: 0 });
    assert.equal(stale.ok, false);
    assert.equal(stale.conflict, true);
    assert.equal(readWorkspaceFile(filePath).workspace.projects.project_1.title, "第一版");

    const second = writeWorkspaceFile(filePath, fixture("第二版"), { expectedRevision: 1 });
    assert.equal(second.ok, true);
    assert.equal(second.revision, 2);
    assert.equal(fs.existsSync(`${filePath}.bak`), true);
    assert.equal(JSON.parse(fs.readFileSync(`${filePath}.bak`, "utf8")).revision, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("格式錯誤時保留原始檔，不以空白工作區覆蓋", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "changbian-invalid-"));
  const filePath = path.join(directory, "workspace.json");
  try {
    fs.writeFileSync(filePath, "{invalid-json", "utf8");
    const before = fs.readFileSync(filePath, "utf8");
    assert.equal(readWorkspaceFile(filePath).ok, false);
    const attempted = writeWorkspaceFile(filePath, fixture(), { expectedRevision: 0 });
    assert.equal(attempted.ok, false);
    assert.equal(fs.readFileSync(filePath, "utf8"), before);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("舊版缺少摘要與版本欄位時可安全遷移", () => {
  const legacy = fixture();
  delete legacy.schemaVersion;
  delete legacy.revision;
  legacy.projects.project_1.entryIds.push("entry_1");
  legacy.entries.entry_1 = {
    id: "entry_1",
    projectId: "project_1",
    chapterId: null,
    timeText: "萬曆十年",
    sourceText: "史料",
    note: "",
    citation: "",
    createdAt: 1,
    updatedAt: 1,
  };
  const result = validateWorkspace(legacy);
  assert.equal(result.ok, true);
  assert.equal(result.workspace.schemaVersion, WORKSPACE_SCHEMA_VERSION);
  assert.equal(result.workspace.entries.entry_1.summary, "");
  assert.deepEqual(result.workspace.trash, []);
});

test("舊版未分章史料會遷入真章節，且 project.entryIds 不再寫回", () => {
  const legacy = fixture();
  legacy.projects.project_1.entryIds.push("entry_1");
  legacy.entries.entry_1 = {
    id: "entry_1",
    projectId: "project_1",
    chapterId: null,
    timeText: "萬曆十年",
    sourceText: "散條",
    note: "",
    citation: "",
    createdAt: 1,
    updatedAt: 1,
  };
  legacy.entries.entry_2 = {
    id: "entry_2",
    projectId: "project_1",
    chapterId: "chapter_missing",
    timeText: "萬曆十一年",
    sourceText: "指向已刪章節",
    note: "",
    citation: "",
    createdAt: 1,
    updatedAt: 1,
  };

  const result = validateWorkspace(legacy);
  assert.equal(result.ok, true);

  const project = result.workspace.projects.project_1;
  assert.equal("entryIds" in project, false);
  assert.deepEqual(project.chapterIds, ["chapter-ungrouped-project_1"]);

  const migrated = result.workspace.chapters["chapter-ungrouped-project_1"];
  assert.equal(migrated.title, "未分章");
  assert.deepEqual(migrated.entryIds, ["entry_1", "entry_2"]);
  assert.equal(result.workspace.entries.entry_1.chapterId, "chapter-ungrouped-project_1");
  assert.equal(result.workspace.entries.entry_2.chapterId, "chapter-ungrouped-project_1");

  // 再驗證一次不應重複建章或重複掛載。
  const again = validateWorkspace(result.workspace);
  assert.equal(again.ok, true);
  assert.deepEqual(again.workspace.projects.project_1.chapterIds, ["chapter-ungrouped-project_1"]);
  assert.deepEqual(again.workspace.chapters["chapter-ungrouped-project_1"].entryIds, ["entry_1", "entry_2"]);
});

test("回收站持久化時只保留最新 100 次刪除操作", () => {
  const workspace = fixture();
  workspace.trash = Array.from({ length: 105 }, (_, index) => ({
    id: `trash_${index}`,
    deletedAt: index,
    label: `項目 ${index}`,
    payload: {
      kind: "entry",
      entries: [],
    },
  }));
  const result = validateWorkspace(workspace);
  assert.equal(result.ok, true);
  assert.equal(result.workspace.trash.length, 100);
  assert.equal(result.workspace.trash[0].id, "trash_104");
  assert.equal(result.workspace.trash[99].id, "trash_5");
});

test("連續存檔不重讀資料檔；外部程序改寫後仍能偵測版本衝突", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "changbian-store-"));
  const filePath = path.join(directory, "workspace.json");
  try {
    const first = writeWorkspaceFile(filePath, fixture("一"), { expectedRevision: 0 });
    assert.equal(first.revision, 1);
    assert.equal(knownRevisionIfUnchanged(filePath), 1);

    // 自己剛寫入的檔案：第二次存檔不必讀入整個檔案。
    const originalRead = fs.readFileSync;
    let reads = 0;
    fs.readFileSync = (...args) => {
      if (String(args[0]) === filePath) reads += 1;
      return originalRead(...args);
    };
    try {
      const second = writeWorkspaceFile(filePath, fixture("二"), { expectedRevision: 1 });
      assert.equal(second.revision, 2);
    } finally {
      fs.readFileSync = originalRead;
    }
    assert.equal(reads, 0);

    // 外部程序（如 MCP）以原子替換寫入新版本。
    const external = { ...fixture("外部"), revision: 5 };
    const tempPath = path.join(directory, "external.tmp");
    fs.writeFileSync(tempPath, JSON.stringify(external), "utf8");
    fs.renameSync(tempPath, filePath);
    assert.equal(knownRevisionIfUnchanged(filePath), null);

    const stale = writeWorkspaceFile(filePath, fixture("三"), { expectedRevision: 2 });
    assert.equal(stale.ok, false);
    assert.equal(stale.conflict, true);
    assert.equal(stale.revision, 5);
    assert.equal(stale.workspace.projects.project_1.title, "外部");
    assert.equal(readWorkspaceFile(filePath).workspace.projects.project_1.title, "外部");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("啟動時只清掉這個資料檔的舊暫存檔", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "changbian-store-"));
  const filePath = path.join(directory, "workspace.json");
  try {
    const old = Date.now() / 1000 - 3600;
    const make = (name, ageSeconds) => {
      const target = path.join(directory, name);
      fs.writeFileSync(target, "x", "utf8");
      if (ageSeconds) fs.utimesSync(target, old, old);
      return target;
    };
    make(".workspace.json.123.1700000000000.tmp", true);
    make(".workspace.json.123.1700000000000.ab12.tmp", true);
    const fresh = make(".workspace.json.456.1800000000000.tmp", false);
    const otherFile = make(".notes.json.123.1700000000000.tmp", true);
    const userFile = make("workspace.json.tmp", true);
    const removed = removeStaleTempFiles(filePath).sort();
    assert.deepEqual(removed, [".workspace.json.123.1700000000000.ab12.tmp", ".workspace.json.123.1700000000000.tmp"]);
    assert.ok(fs.existsSync(fresh));
    assert.ok(fs.existsSync(otherFile));
    assert.ok(fs.existsSync(userFile));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
