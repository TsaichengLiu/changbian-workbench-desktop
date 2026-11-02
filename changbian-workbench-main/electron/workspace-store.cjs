const fs = require("fs");
const path = require("path");

const WORKSPACE_SCHEMA_VERSION = 1;
const TRASH_ITEM_LIMIT = 100;
const UNGROUPED_MIGRATION_CHAPTER_TITLE = "未分章";
const LOCK_RETRY_COUNT = 30;
const LOCK_RETRY_DELAY_MS = 10;
const STALE_LOCK_MS = 30_000;
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function asNullableId(value, field, errors) {
  if (value === null || typeof value === "string") {
    return value;
  }
  errors.push(`${field} 必須是字串或 null`);
  return null;
}

// 舊資料可能存在「未分章史料」（entry.chapterId 為 null，或掛在 project.entryIds 上）。
// 該設計已廢棄，讀取時一律遷入該專案下一個名為「未分章」的真章節，使 chapterId 恆為字串。
function migrateUngroupedEntries(projects, chapters, entries, legacyProjectEntryIds) {
  for (const project of Object.values(projects)) {
    const ordered = [];
    const seen = new Set();

    const push = (entryId) => {
      const entry = entries[entryId];
      if (!entry || entry.projectId !== project.id || seen.has(entryId)) return;
      seen.add(entryId);
      ordered.push(entryId);
    };

    for (const entryId of legacyProjectEntryIds.get(project.id) ?? []) {
      const entry = entries[entryId];
      if (entry && !entry.chapterId) push(entryId);
    }
    for (const entry of Object.values(entries)) {
      if (entry.projectId !== project.id) continue;
      // chapterId 為空，或指向已不存在的章節，都視為散條。
      if (!entry.chapterId || !chapters[entry.chapterId]) push(entry.id);
    }

    if (ordered.length === 0) continue;

    const chapterId = `chapter-ungrouped-${project.id}`;
    if (!chapters[chapterId]) {
      chapters[chapterId] = {
        id: chapterId,
        projectId: project.id,
        title: UNGROUPED_MIGRATION_CHAPTER_TITLE,
        entryIds: [],
        createdAt: Date.now(),
      };
    }
    if (!project.chapterIds.includes(chapterId)) {
      project.chapterIds.push(chapterId);
    }

    for (const entryId of ordered) {
      entries[entryId].chapterId = chapterId;
      if (!chapters[chapterId].entryIds.includes(entryId)) {
        chapters[chapterId].entryIds.push(entryId);
      }
    }
  }
}

function validateWorkspace(raw) {
  const errors = [];
  if (!isRecord(raw)) {
    return { ok: false, errors: ["工作臺資料必須是 JSON 物件"] };
  }

  const schemaVersion = raw.schemaVersion == null ? WORKSPACE_SCHEMA_VERSION : Number(raw.schemaVersion);
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
    errors.push("schemaVersion 無效");
  } else if (schemaVersion > WORKSPACE_SCHEMA_VERSION) {
    errors.push(`資料版本 ${schemaVersion} 高於目前支持的 ${WORKSPACE_SCHEMA_VERSION}`);
  }

  if (!Array.isArray(raw.projectOrder)) errors.push("projectOrder 必須是陣列");
  if (!isRecord(raw.projects)) errors.push("projects 必須是物件");
  if (!isRecord(raw.chapters)) errors.push("chapters 必須是物件");
  if (!isRecord(raw.entries)) errors.push("entries 必須是物件");
  if (raw.trash != null && !Array.isArray(raw.trash)) errors.push("trash 必須是陣列");
  if (errors.length > 0) return { ok: false, errors };

  const projects = {};
  const legacyProjectEntryIds = new Map();
  for (const [key, project] of Object.entries(raw.projects)) {
    if (!isRecord(project)) {
      errors.push(`projects.${key} 必須是物件`);
      continue;
    }
    if (typeof project.id !== "string" || !project.id) errors.push(`projects.${key}.id 無效`);
    if (typeof project.title !== "string") errors.push(`projects.${key}.title 必須是字串`);
    if (!Array.isArray(project.chapterIds)) errors.push(`projects.${key}.chapterIds 必須是陣列`);
    const projectId = typeof project.id === "string" && project.id ? project.id : key;
    // 舊檔的 project.entryIds（未分章史料）只留作遷移依據，不再寫回。
    legacyProjectEntryIds.set(
      projectId,
      Array.isArray(project.entryIds) ? project.entryIds.filter((id) => typeof id === "string") : [],
    );
    projects[key] = {
      ...project,
      id: projectId,
      title: typeof project.title === "string" ? project.title : "",
      chapterIds: Array.isArray(project.chapterIds) ? project.chapterIds.filter((id) => typeof id === "string") : [],
      createdAt: Number.isFinite(project.createdAt) ? project.createdAt : Date.now(),
    };
    delete projects[key].entryIds;
  }

  const chapters = {};
  for (const [key, chapter] of Object.entries(raw.chapters)) {
    if (!isRecord(chapter)) {
      errors.push(`chapters.${key} 必須是物件`);
      continue;
    }
    if (typeof chapter.id !== "string" || !chapter.id) errors.push(`chapters.${key}.id 無效`);
    if (typeof chapter.projectId !== "string" || !chapter.projectId) errors.push(`chapters.${key}.projectId 無效`);
    if (typeof chapter.title !== "string") errors.push(`chapters.${key}.title 必須是字串`);
    if (!Array.isArray(chapter.entryIds)) errors.push(`chapters.${key}.entryIds 必須是陣列`);
    chapters[key] = {
      ...chapter,
      id: typeof chapter.id === "string" && chapter.id ? chapter.id : key,
      projectId: typeof chapter.projectId === "string" ? chapter.projectId : "",
      title: typeof chapter.title === "string" ? chapter.title : "",
      entryIds: Array.isArray(chapter.entryIds) ? chapter.entryIds.filter((id) => typeof id === "string") : [],
      createdAt: Number.isFinite(chapter.createdAt) ? chapter.createdAt : Date.now(),
    };
  }

  const entries = {};
  for (const [key, entry] of Object.entries(raw.entries)) {
    if (!isRecord(entry)) {
      errors.push(`entries.${key} 必須是物件`);
      continue;
    }
    if (typeof entry.id !== "string" || !entry.id) errors.push(`entries.${key}.id 無效`);
    if (typeof entry.projectId !== "string" || !entry.projectId) errors.push(`entries.${key}.projectId 無效`);
    // 允許讀入空值，稍後由 migrateUngroupedEntries 一律補成真章節。
    const chapterId = typeof entry.chapterId === "string" ? entry.chapterId : "";
    entries[key] = {
      ...entry,
      id: typeof entry.id === "string" && entry.id ? entry.id : key,
      projectId: typeof entry.projectId === "string" ? entry.projectId : "",
      chapterId,
      timeText: typeof entry.timeText === "string" ? entry.timeText : "",
      summary: typeof entry.summary === "string" ? entry.summary : "",
      sourceText: typeof entry.sourceText === "string" ? entry.sourceText : "",
      note: typeof entry.note === "string" ? entry.note : "",
      citation: typeof entry.citation === "string" ? entry.citation : "",
      createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : Date.now(),
      updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : Date.now(),
    };
  }

  if (errors.length > 0) return { ok: false, errors };

  migrateUngroupedEntries(projects, chapters, entries, legacyProjectEntryIds);

  const revisionRaw = Number(raw.revision ?? 0);
  const revision = Number.isInteger(revisionRaw) && revisionRaw >= 0 ? revisionRaw : 0;
  const trash = (Array.isArray(raw.trash) ? raw.trash : [])
    .filter((item) => {
      if (!isRecord(item) || !isRecord(item.payload)) return false;
      return (
        typeof item.id === "string" &&
        typeof item.deletedAt === "number" &&
        typeof item.label === "string" &&
        ["project", "chapter", "entry"].includes(item.payload.kind)
      );
    })
    .sort((a, b) => b.deletedAt - a.deletedAt)
    .slice(0, TRASH_ITEM_LIMIT);
  return {
    ok: true,
    workspace: {
      ...raw,
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      revision,
      projectOrder: raw.projectOrder.filter((id) => typeof id === "string"),
      projects,
      chapters,
      entries,
      trash,
      activeProjectId: asNullableId(raw.activeProjectId ?? null, "activeProjectId", []),
      activeChapterId: asNullableId(raw.activeChapterId ?? null, "activeChapterId", []),
      selectedEntryId: asNullableId(raw.selectedEntryId ?? null, "selectedEntryId", []),
    },
  };
}

function readWorkspaceFile(filePath) {
  if (!fs.existsSync(filePath)) return { ok: true, workspace: null, revision: 0 };
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const validation = validateWorkspace(parsed);
    if (!validation.ok) {
      return { ok: false, error: `資料格式無效：${validation.errors.slice(0, 4).join("；")}` };
    }
    return { ok: true, workspace: validation.workspace, revision: validation.workspace.revision };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? `JSON 讀取失敗：${error.message}` : "JSON 讀取失敗" };
  }
}

function acquireLock(filePath) {
  const lockPath = `${filePath}.lock`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeFileSync(fd, `${process.pid}\n${Date.now()}\n`, "utf8");
      return { fd, lockPath };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (age > STALE_LOCK_MS) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      Atomics.wait(sleepBuffer, 0, 0, LOCK_RETRY_DELAY_MS);
    }
  }
  throw new Error("資料檔正在由另一個程序寫入，請稍後重試");
}

function releaseLock(lock) {
  try { fs.closeSync(lock.fd); } catch {}
  try { fs.rmSync(lock.lockPath, { force: true }); } catch {}
}

function writeWorkspaceFile(filePath, workspace, options = {}) {
  const validation = validateWorkspace(workspace);
  if (!validation.ok) {
    return { ok: false, error: `拒絕寫入無效資料：${validation.errors.slice(0, 4).join("；")}` };
  }

  let lock;
  let tempPath = "";
  try {
    lock = acquireLock(filePath);
    const current = readWorkspaceFile(filePath);
    if (!current.ok && !options.allowReplaceInvalid) return current;
    const currentRevision = current.ok ? current.revision : 0;
    if (Number.isInteger(options.expectedRevision) && options.expectedRevision !== currentRevision) {
      return {
        ok: false,
        conflict: true,
        revision: currentRevision,
        workspace: current.ok ? current.workspace : null,
        error: `資料已由其他程序更新（目前版本 ${currentRevision}，本機版本 ${options.expectedRevision}）`,
      };
    }

    const nextRevision = currentRevision + 1;
    const nextWorkspace = { ...validation.workspace, schemaVersion: WORKSPACE_SCHEMA_VERSION, revision: nextRevision };
    const directory = path.dirname(filePath);
    tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(tempPath, JSON.stringify(nextWorkspace, null, 2), "utf8");
    if (fs.existsSync(filePath)) fs.copyFileSync(filePath, `${filePath}.bak`);
    fs.renameSync(tempPath, filePath);
    return { ok: true, revision: nextRevision, workspace: nextWorkspace };
  } catch (error) {
    if (tempPath) {
      try { fs.rmSync(tempPath, { force: true }); } catch {}
    }
    return { ok: false, error: error instanceof Error ? error.message : "資料寫入失敗" };
  } finally {
    if (lock) releaseLock(lock);
  }
}

module.exports = {
  WORKSPACE_SCHEMA_VERSION,
  readWorkspaceFile,
  validateWorkspace,
  writeWorkspaceFile,
};
