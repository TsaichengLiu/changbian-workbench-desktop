const path = require("path");
const OpenCC = require("opencc-js");

const TAG_REGEX = /#([^\s#，。；、,.;:!?！？【】（）()<>《》]+)/g;
const CITATION_TITLE_REGEX = /《([^》\n\r]+)》/g;
const SEARCH_REBUILD_DEBOUNCE_MS = 900;
const SEARCH_LIMIT_DEFAULT = 600;
const INCREMENTAL_REBUILD_THRESHOLD = 2400;
// 索引格式版本（存於 PRAGMA user_version）；變量寫法等改變時遞增，舊索引會整個重建。
// 2：條目簽名存進 entry_row_map，重啟後只更新改動的條目。
const INDEX_FORMAT_VERSION = 2;
// 空閒頁超過這個比例（且超過最少頁數）時壓縮資料庫檔案。
const VACUUM_FREE_RATIO = 0.25;
const VACUUM_MIN_FREE_PAGES = 256;
// WAL 檔在檢查點之後截短到此大小以內，不隨歷次寫入一直變大。
const WAL_SIZE_LIMIT_BYTES = 4 * 1024 * 1024;

const ALL_SCOPES = ["project", "chapter", "time", "summary", "source", "note", "citation", "refId"];

const SCOPE_COLUMN_MAP = Object.freeze({
  project: "project_variants",
  chapter: "chapter_variants",
  time: "time_variants",
  summary: "summary_variants",
  source: "source_variants",
  note: "note_variants",
  citation: "citation_variants",
  refId: "ref_variants",
});

let BetterSqlite3 = null;
try {
  BetterSqlite3 = require("better-sqlite3");
} catch {
  BetterSqlite3 = null;
}

// 繁簡轉換詞典（兩個方向約佔 30 MB）在第一次用到時才載入：
// 啟動時索引已是最新、又沒有檢索或改動條目時，就不必載入。
let twToCnConverter;
let cnToTwConverter;

function convertToSimplified(input) {
  if (twToCnConverter === undefined) {
    try {
      twToCnConverter = OpenCC.Converter({ from: "tw", to: "cn" });
    } catch {
      twToCnConverter = null;
    }
  }
  return twToCnConverter ? twToCnConverter(input) : null;
}

function convertToTraditional(input) {
  if (cnToTwConverter === undefined) {
    try {
      cnToTwConverter = OpenCC.Converter({ from: "cn", to: "tw" });
    } catch {
      cnToTwConverter = null;
    }
  }
  return cnToTwConverter ? cnToTwConverter(input) : null;
}

// 與 src/search.ts 一致：比對時忽略標點、符號與空白，保留 □ ■ 缺字符號。
const IGNORABLE_CHARS = /(?![□■])[\p{P}\p{S}\p{Z}\p{Cc}\p{Cf}]/gu;

function cleanText(input) {
  const text = typeof input === "string" ? input : input == null ? "" : String(input);
  return text.toLocaleLowerCase().replace(IGNORABLE_CHARS, "");
}

// 查詢以空白分隔為多個詞，每個詞都須命中。
function splitQueryTerms(query) {
  return query.split(/\s+/).filter(Boolean);
}

// 索引以 detail='none' 建立，不支持多字片語查詢；改以詞中每個三字片段 AND 起來預篩。
function trigramMatchExpression(variant) {
  const chars = [...variant];
  const grams = new Set();
  for (let index = 0; index + 3 <= chars.length; index += 1) {
    grams.add(chars.slice(index, index + 3).join(""));
  }
  return `(${[...grams].map((gram) => `"${gram.replace(/"/g, '""')}"`).join(" AND ")})`;
}

function buildVariants(input) {
  const base = cleanText(input);
  if (!base) {
    return [];
  }

  // 原文、轉簡體、轉繁體三種寫法都存：有些字繁簡不是一一對應（如 暱／昵、藉／借），
  // 只存簡體會漏檢。
  const variants = new Set([base]);
  const simplified = convertToSimplified(input);
  if (simplified !== null) {
    variants.add(cleanText(simplified));
  }
  const traditional = convertToTraditional(input);
  if (traditional !== null) {
    variants.add(cleanText(traditional));
  }
  return [...variants].filter(Boolean);
}

function joinVariants(input) {
  const variants = Array.isArray(input) ? input : buildVariants(input);
  if (!variants.length) {
    return "";
  }
  return variants.join("\n");
}

function summarizeText(input, maxChars) {
  const text = typeof input === "string" ? input : "";
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "";
  }
  if (compact.length <= maxChars) {
    return compact;
  }
  return `${compact.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function extractTags(input) {
  const text = typeof input === "string" ? input : "";
  const tags = [];
  const seen = new Set();
  for (const match of text.matchAll(TAG_REGEX)) {
    const token = `#${(match[1] || "").trim()}`;
    if (!token || token === "#") {
      continue;
    }
    const lowered = token.toLocaleLowerCase();
    if (seen.has(lowered)) {
      continue;
    }
    seen.add(lowered);
    tags.push(token);
  }
  return tags;
}

function extractCitationTitles(input) {
  const text = typeof input === "string" ? input : "";
  const titles = [];
  const seen = new Set();
  for (const match of text.matchAll(CITATION_TITLE_REGEX)) {
    const title = (match[1] || "").trim();
    if (!title) {
      continue;
    }
    const key = title.toLocaleLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    titles.push(title);
  }
  return titles;
}

function normalizeTagInput(input) {
  const trimmed = typeof input === "string" ? input.trim() : "";
  if (!trimmed) {
    return "";
  }
  return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
}

function parseTagsToken(tokenText) {
  if (!tokenText || typeof tokenText !== "string") {
    return [];
  }
  return tokenText
    .split("|")
    .map((segment) => segment.trim())
    .filter((segment) => segment.startsWith("#"));
}

function buildTagsToken(tags) {
  if (!Array.isArray(tags) || tags.length === 0) {
    return "";
  }
  const values = [];
  for (const tag of tags) {
    const text = typeof tag === "string" ? tag.trim().toLocaleLowerCase() : "";
    if (!text || !text.startsWith("#")) {
      continue;
    }
    values.push(text);
  }
  if (values.length === 0) {
    return "";
  }
  return `|${values.join("|")}|`;
}

function resolveSearchDbPath(workspaceFilePath) {
  const parsed = path.parse(workspaceFilePath);
  return path.join(parsed.dir, `${parsed.name}.fts5.sqlite`);
}

function getWorkspaceBucket(workspace, key) {
  const bucket = workspace && typeof workspace === "object" ? workspace[key] : null;
  return bucket && typeof bucket === "object" ? bucket : {};
}

function buildEntrySignature(entry) {
  return JSON.stringify([
    typeof entry.id === "string" ? entry.id : "",
    typeof entry.projectId === "string" ? entry.projectId : "",
    typeof entry.chapterId === "string" ? entry.chapterId : "",
    typeof entry.timeText === "string" ? entry.timeText : "",
    typeof entry.summary === "string" ? entry.summary : "",
    typeof entry.sourceText === "string" ? entry.sourceText : "",
    typeof entry.note === "string" ? entry.note : "",
    typeof entry.citation === "string" ? entry.citation : "",
    typeof entry.refId === "string" ? entry.refId : "",
  ]);
}

function resolveEntryContext(workspace, entryId) {
  const entries = getWorkspaceBucket(workspace, "entries");
  const projects = getWorkspaceBucket(workspace, "projects");
  const chapters = getWorkspaceBucket(workspace, "chapters");

  const rawEntry = entries[entryId];
  if (!rawEntry || typeof rawEntry !== "object") {
    return null;
  }

  const projectId = typeof rawEntry.projectId === "string" ? rawEntry.projectId : "";
  const project = projects[projectId];
  if (!project || typeof project !== "object") {
    return null;
  }

  const rawChapterId = typeof rawEntry.chapterId === "string" ? rawEntry.chapterId : "";
  const chapter = rawChapterId ? chapters[rawChapterId] : null;
  const chapterValid = Boolean(chapter && chapter.projectId === projectId);

  return {
    entryId: typeof rawEntry.id === "string" ? rawEntry.id : entryId,
    projectId,
    chapterId: chapterValid ? rawChapterId : "",
    projectTitle: typeof project.title === "string" ? project.title : "",
    chapterTitle: chapterValid && typeof chapter.title === "string" ? chapter.title : "",
    timeText: typeof rawEntry.timeText === "string" ? rawEntry.timeText : "",
    summaryText: typeof rawEntry.summary === "string" ? rawEntry.summary : "",
    sourceText: typeof rawEntry.sourceText === "string" ? rawEntry.sourceText : "",
    noteText: typeof rawEntry.note === "string" ? rawEntry.note : "",
    citationText: typeof rawEntry.citation === "string" ? rawEntry.citation : "",
    refId: typeof rawEntry.refId === "string" ? rawEntry.refId : "",
  };
}

function buildEntryIndexPayload(context) {
  const tags = extractTags(context.noteText);
  const citationTitles = extractCitationTitles(context.citationText);
  const citationTitleVariants = citationTitles.flatMap((title) => buildVariants(title));

  return {
    entryId: context.entryId,
    projectId: context.projectId,
    chapterId: context.chapterId,
    projectTitle: context.projectTitle,
    chapterTitle: context.chapterTitle,
    timeText: context.timeText,
    summaryText: context.summaryText,
    snippet: summarizeText(context.sourceText, 120),
    citationPreview: summarizeText(context.citationText, 80),
    tagsToken: buildTagsToken(tags),
    citationTitlesVariants: joinVariants(citationTitleVariants),
    projectVariants: joinVariants(context.projectTitle),
    chapterVariants: joinVariants(context.chapterTitle),
    timeVariants: joinVariants(context.timeText),
    summaryVariants: joinVariants(context.summaryText),
    sourceVariants: joinVariants(context.sourceText),
    noteVariants: joinVariants(context.noteText),
    citationVariants: joinVariants(context.citationText),
    refVariants: context.refId,
  };
}

function iterateWorkspaceEntryIds(workspace) {
  const entries = getWorkspaceBucket(workspace, "entries");
  const ids = [];
  for (const key of Object.keys(entries)) {
    const entry = entries[key];
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const entryId = typeof entry.id === "string" ? entry.id : key;
    if (!entryId) {
      continue;
    }
    ids.push(entryId);
  }
  return ids;
}

// 每條的索引簽名：條目內容加上所屬專案、章節的名稱（改名時須重建該條）。
function buildRowSignatures(workspace) {
  const entries = getWorkspaceBucket(workspace, "entries");
  const projects = getWorkspaceBucket(workspace, "projects");
  const chapters = getWorkspaceBucket(workspace, "chapters");
  const signatures = new Map();
  for (const entryId of iterateWorkspaceEntryIds(workspace)) {
    const entry = entries[entryId];
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const project = typeof entry.projectId === "string" ? projects[entry.projectId] : null;
    const chapter = typeof entry.chapterId === "string" ? chapters[entry.chapterId] : null;
    signatures.set(
      entryId,
      JSON.stringify([
        buildEntrySignature(entry),
        project && typeof project.title === "string" ? project.title : "",
        chapter && typeof chapter.title === "string" ? chapter.title : "",
      ]),
    );
  }
  return signatures;
}

class SearchIndexService {
  constructor(options) {
    this.getWorkspaceFilePath = options.getWorkspaceFilePath;
    this.db = null;
    this.dbPath = "";
    this.enabled = Boolean(BetterSqlite3);
    this.ready = false;
    this.lastError = this.enabled ? "" : "better-sqlite3 未安裝或載入失敗";
    this.lastIndexedAt = 0;
    this.rowCount = 0;
    this.rebuildTimer = null;
    this.pendingWorkspace = null;
    this.schemaInitialized = false;
    this.statements = null;

    // 已寫入索引的各條簽名；首次同步時從資料庫讀出。
    this.rowSignatures = new Map();
    this.rowSignaturesReady = false;
  }

  getStatus() {
    return {
      enabled: this.enabled,
      ready: this.ready,
      dbPath: this.dbPath,
      rowCount: this.rowCount,
      lastIndexedAt: this.lastIndexedAt,
      message: this.lastError,
      backend: this.enabled ? "sqlite-fts5" : "memory-fallback",
    };
  }

  ensureDb() {
    if (!this.enabled) {
      return false;
    }

    const workspacePath = this.getWorkspaceFilePath();
    const nextDbPath = resolveSearchDbPath(workspacePath);

    if (this.db && this.dbPath !== nextDbPath) {
      this.close();
    }

    if (this.db) {
      return true;
    }

    try {
      this.dbPath = nextDbPath;
      this.db = new BetterSqlite3(this.dbPath);
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = NORMAL");
      this.db.pragma(`journal_size_limit = ${WAL_SIZE_LIMIT_BYTES}`);
      this.initSchema();
      this.prepareStatements();
      this.compactIfBloated();
      this.rowCount = this.getMappedRowCount();
      this.ready = true;
      this.lastError = "";
      return true;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : "初始化 SQLite 失敗";
      this.ready = false;
      this.close();
      return false;
    }
  }

  close() {
    if (this.rebuildTimer) {
      clearTimeout(this.rebuildTimer);
      this.rebuildTimer = null;
    }
    if (this.db) {
      try {
        this.db.close();
      } catch {
        // ignore close errors
      }
    }
    this.db = null;
    this.ready = false;
    this.schemaInitialized = false;
    this.statements = null;
    this.rowSignatures = new Map();
    this.rowSignaturesReady = false;
  }

  // 整批刪改之後空閒頁會留在檔案裡；比例過高時壓縮，讓檔案回到實際大小。
  compactIfBloated() {
    if (!this.db) {
      return false;
    }
    try {
      const pageCount = Number(this.db.pragma("page_count", { simple: true })) || 0;
      const freePages = Number(this.db.pragma("freelist_count", { simple: true })) || 0;
      if (freePages < VACUUM_MIN_FREE_PAGES || freePages < pageCount * VACUUM_FREE_RATIO) {
        return false;
      }
      this.db.exec("VACUUM");
      this.db.pragma("wal_checkpoint(TRUNCATE)");
      return true;
    } catch {
      return false;
    }
  }

  // 索引裡的簽名與實際行數一致才可信；不一致（例如上次中途失敗）就當作沒有，整個重建。
  loadStoredSignatures() {
    const stored = new Map();
    if (!this.statements) {
      return stored;
    }
    try {
      for (const row of this.statements.selectAllRowMap.all()) {
        if (typeof row.entry_id === "string" && typeof row.signature === "string" && row.signature) {
          stored.set(row.entry_id, row.signature);
        }
      }
      const ftsRows = Number(this.statements.countFts.get()?.count ?? 0);
      if (ftsRows !== stored.size || this.getMappedRowCount() !== stored.size) {
        return null;
      }
    } catch {
      return null;
    }
    return stored;
  }

  initSchema() {
    if (!this.db || this.schemaInitialized) {
      return;
    }

    // 舊版索引（格式版本不同，或沒有「編號」欄）：刪掉重建。
    const existingColumns = this.db
      .prepare("PRAGMA table_info(entries_fts)")
      .all()
      .map((column) => column.name);
    const formatVersion = Number(this.db.pragma("user_version", { simple: true })) || 0;
    if (
      existingColumns.length > 0 &&
      (formatVersion !== INDEX_FORMAT_VERSION || !existingColumns.includes("ref_variants"))
    ) {
      this.db.exec("DROP TABLE IF EXISTS entries_fts; DROP TABLE IF EXISTS entry_row_map;");
    }

    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
        entry_id UNINDEXED,
        project_id UNINDEXED,
        chapter_id UNINDEXED,
        project_title UNINDEXED,
        chapter_title UNINDEXED,
        time_text UNINDEXED,
        summary_text UNINDEXED,
        snippet UNINDEXED,
        citation_preview UNINDEXED,
        tags_token UNINDEXED,
        citation_titles_variants UNINDEXED,
        project_variants,
        chapter_variants,
        time_variants,
        summary_variants,
        source_variants,
        note_variants,
        citation_variants,
        ref_variants,
        tokenize='trigram',
        detail='none',
        columnsize=0
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entry_row_map (
        entry_id TEXT PRIMARY KEY,
        rowid INTEGER NOT NULL,
        signature TEXT NOT NULL DEFAULT ''
      );
    `);
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_entry_row_map_rowid ON entry_row_map(rowid);
    `);
    this.db.pragma(`user_version = ${INDEX_FORMAT_VERSION}`);

    this.schemaInitialized = true;
  }

  prepareStatements() {
    if (!this.db || this.statements) {
      return;
    }

    this.statements = {
      insertFts: this.db.prepare(`
        INSERT INTO entries_fts (
          entry_id,
          project_id,
          chapter_id,
          project_title,
          chapter_title,
          time_text,
          summary_text,
          snippet,
          citation_preview,
          tags_token,
          citation_titles_variants,
          project_variants,
          chapter_variants,
          time_variants,
          summary_variants,
          source_variants,
          note_variants,
          citation_variants,
          ref_variants
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      deleteFtsByRowid: this.db.prepare(`DELETE FROM entries_fts WHERE rowid = ?`),
      deleteFtsByEntryId: this.db.prepare(`DELETE FROM entries_fts WHERE entry_id = ?`),
      selectRowMap: this.db.prepare(`SELECT rowid FROM entry_row_map WHERE entry_id = ?`),
      upsertRowMap: this.db.prepare(`
        INSERT INTO entry_row_map (entry_id, rowid, signature)
        VALUES (?, ?, ?)
        ON CONFLICT(entry_id) DO UPDATE SET rowid = excluded.rowid, signature = excluded.signature
      `),
      selectAllRowMap: this.db.prepare(`SELECT entry_id, signature FROM entry_row_map`),
      countFts: this.db.prepare(`SELECT COUNT(*) AS count FROM entries_fts`),
      deleteRowMap: this.db.prepare(`DELETE FROM entry_row_map WHERE entry_id = ?`),
      clearRowMap: this.db.prepare(`DELETE FROM entry_row_map`),
      countRowMap: this.db.prepare(`SELECT COUNT(*) AS count FROM entry_row_map`),
    };
  }

  getMappedRowCount() {
    if (!this.statements) {
      return 0;
    }
    const row = this.statements.countRowMap.get();
    return Number(row?.count ?? 0);
  }

  invalidate() {
    this.ready = false;
  }

  scheduleRebuild(workspace) {
    if (!this.enabled) {
      return;
    }

    this.pendingWorkspace = workspace;
    if (this.rebuildTimer) {
      clearTimeout(this.rebuildTimer);
    }

    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      const nextWorkspace = this.pendingWorkspace;
      this.pendingWorkspace = null;
      this.rebuild(nextWorkspace);
    }, SEARCH_REBUILD_DEBOUNCE_MS);
  }

  flushPendingRebuild() {
    if (!this.pendingWorkspace) {
      return;
    }
    const nextWorkspace = this.pendingWorkspace;
    this.pendingWorkspace = null;
    if (this.rebuildTimer) {
      clearTimeout(this.rebuildTimer);
      this.rebuildTimer = null;
    }
    this.rebuild(nextWorkspace);
  }

  deleteEntryRow(entryId) {
    if (!this.statements) {
      return;
    }

    const existing = this.statements.selectRowMap.get(entryId);
    if (existing && Number.isFinite(existing.rowid)) {
      this.statements.deleteFtsByRowid.run(existing.rowid);
      this.statements.deleteRowMap.run(entryId);
      return;
    }

    this.statements.deleteFtsByEntryId.run(entryId);
    this.statements.deleteRowMap.run(entryId);
  }

  // fresh 為 true 表示表已清空（整批重建），不必先刪舊行。
  upsertEntryRowFromWorkspace(workspace, entryId, signature, fresh = false) {
    if (!this.statements) {
      return;
    }

    if (!fresh) {
      this.deleteEntryRow(entryId);
    }

    const context = resolveEntryContext(workspace, entryId);
    if (!context) {
      return;
    }

    const payload = buildEntryIndexPayload(context);
    const result = this.statements.insertFts.run(
      payload.entryId,
      payload.projectId,
      payload.chapterId,
      payload.projectTitle,
      payload.chapterTitle,
      payload.timeText,
      payload.summaryText,
      payload.snippet,
      payload.citationPreview,
      payload.tagsToken,
      payload.citationTitlesVariants,
      payload.projectVariants,
      payload.chapterVariants,
      payload.timeVariants,
      payload.summaryVariants,
      payload.sourceVariants,
      payload.noteVariants,
      payload.citationVariants,
      payload.refVariants,
    );

    const rowid = Number(result.lastInsertRowid);
    this.statements.upsertRowMap.run(payload.entryId, rowid, signature || "");
  }

  rebuild(workspace) {
    if (!this.enabled) {
      return false;
    }
    if (!this.ensureDb() || !this.db || !this.statements) {
      return false;
    }

    try {
      const signatures = buildRowSignatures(workspace);
      const transaction = this.db.transaction(() => {
        this.db.exec("DELETE FROM entries_fts;");
        this.statements.clearRowMap.run();

        for (const [entryId, signature] of signatures) {
          this.upsertEntryRowFromWorkspace(workspace, entryId, signature, true);
        }
      });

      transaction();
      // 整批重寫後合併索引分段，並把騰出的空間還給磁碟。
      this.db.exec("INSERT INTO entries_fts(entries_fts) VALUES('optimize');");
      this.compactIfBloated();
      this.lastIndexedAt = Date.now();
      this.rowCount = this.getMappedRowCount();
      this.ready = true;
      this.lastError = "";
      this.rowSignatures = signatures;
      this.rowSignaturesReady = true;
      return true;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : "重建索引失敗";
      this.ready = false;
      this.rowSignatures = new Map();
      this.rowSignaturesReady = false;
      return false;
    }
  }

  syncWorkspace(workspace) {
    if (!this.enabled) {
      return false;
    }
    if (!this.ensureDb() || !this.db || !this.statements) {
      return false;
    }

    if (!workspace || typeof workspace !== "object") {
      return false;
    }

    if (!this.rowSignaturesReady) {
      const stored = this.loadStoredSignatures();
      // 讀不出可信的簽名、或索引是空的（新檔）：整批建立。
      if (!stored || stored.size === 0) {
        return this.rebuild(workspace);
      }
      this.rowSignatures = stored;
      this.rowSignaturesReady = true;
    }

    const nextSignatures = buildRowSignatures(workspace);
    const removedEntryIds = [];
    for (const entryId of this.rowSignatures.keys()) {
      if (!nextSignatures.has(entryId)) {
        removedEntryIds.push(entryId);
      }
    }
    const upsertEntryIds = [];
    for (const [entryId, signature] of nextSignatures) {
      if (this.rowSignatures.get(entryId) !== signature) {
        upsertEntryIds.push(entryId);
      }
    }

    const changesCount = removedEntryIds.length + upsertEntryIds.length;
    if (changesCount === 0) {
      this.ready = true;
      this.lastError = "";
      return true;
    }

    if (changesCount >= INCREMENTAL_REBUILD_THRESHOLD) {
      return this.rebuild(workspace);
    }

    try {
      const transaction = this.db.transaction(() => {
        for (const entryId of removedEntryIds) {
          this.deleteEntryRow(entryId);
        }
        for (const entryId of upsertEntryIds) {
          // 索引裡還沒有這條就直接插入，免得先按 entry_id 查刪。
          const fresh = !this.rowSignatures.has(entryId);
          this.upsertEntryRowFromWorkspace(workspace, entryId, nextSignatures.get(entryId), fresh);
        }
      });

      transaction();
      this.lastIndexedAt = Date.now();
      this.rowCount = this.getMappedRowCount();
      this.ready = true;
      this.lastError = "";
      this.rowSignatures = nextSignatures;
      return true;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : "增量索引更新失敗";
      this.ready = false;
      // 不確定寫入了哪些：下次同步從資料庫重新核對。
      this.rowSignatures = new Map();
      this.rowSignaturesReady = false;
      return false;
    }
  }

  buildQueryScopeColumns(queryScopes) {
    const scopes = Array.isArray(queryScopes) && queryScopes.length > 0 ? queryScopes : ALL_SCOPES;
    const columns = [];
    for (const scope of scopes) {
      if (typeof scope !== "string") {
        continue;
      }
      const column = SCOPE_COLUMN_MAP[scope];
      if (column) {
        columns.push(column);
      }
    }
    return columns.length > 0 ? columns : ALL_SCOPES.map((scope) => SCOPE_COLUMN_MAP[scope]);
  }

  search(criteria) {
    this.flushPendingRebuild();
    if (!this.enabled || !this.ensureDb() || !this.db) {
      return null;
    }

    const query = typeof criteria?.query === "string" ? criteria.query.trim() : "";
    const rawTag = typeof criteria?.tag === "string" ? criteria.tag : "";
    const normalizedTag = normalizeTagInput(rawTag).toLocaleLowerCase();
    const citationTitle = typeof criteria?.citationTitle === "string" ? criteria.citationTitle.trim() : "";
    const projectId = typeof criteria?.projectId === "string" ? criteria.projectId.trim() : "";
    const chapterId = typeof criteria?.chapterId === "string" ? criteria.chapterId.trim() : "";

    // 每個詞各自展開繁簡變體；只有標點的詞不參與比對。
    const queryTermVariants = splitQueryTerms(query)
      .map((term) => buildVariants(term))
      .filter((variants) => variants.length > 0);
    if (queryTermVariants.length === 0 && !normalizedTag && !citationTitle) {
      return [];
    }

    const limitRaw = Number(criteria?.limit ?? SEARCH_LIMIT_DEFAULT);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(2000, Math.floor(limitRaw))) : SEARCH_LIMIT_DEFAULT;

    const whereClauses = [];
    const params = [];

    if (projectId) {
      whereClauses.push("project_id = ?");
      params.push(projectId);
    }

    if (chapterId) {
      whereClauses.push("chapter_id = ?");
      params.push(chapterId);
    }

    if (queryTermVariants.length > 0) {
      const scopeColumns = this.buildQueryScopeColumns(criteria?.queryScopes);
      // 三字以上的詞先用 trigram 索引預篩，再逐詞以 LIKE 確認落在指定欄位；
      // 標點已在索引與查詢兩側去掉，所以 LIKE 的 % _ 不會出現在詞中。
      const ftsGroups = queryTermVariants
        .filter((variants) => variants.every((variant) => [...variant].length >= 3))
        .map((variants) => `(${variants.map(trigramMatchExpression).join(" OR ")})`);
      if (ftsGroups.length > 0) {
        whereClauses.push("entries_fts MATCH ?");
        params.push(ftsGroups.join(" AND "));
      }
      for (const variants of queryTermVariants) {
        const checks = [];
        for (const variant of variants) {
          for (const column of scopeColumns) {
            checks.push(`${column} LIKE ?`);
            params.push(`%${variant}%`);
          }
        }
        whereClauses.push(`(${checks.join(" OR ")})`);
      }
    }

    if (normalizedTag) {
      whereClauses.push("instr(tags_token, ?) > 0");
      params.push(`|${normalizedTag}|`);
    }

    if (citationTitle) {
      const citationVariants = buildVariants(citationTitle);
      if (citationVariants.length === 0) {
        return [];
      }

      const checks = [];
      for (const variant of citationVariants) {
        checks.push("instr(citation_titles_variants, ?) > 0");
        params.push(variant);
        checks.push("citation_variants LIKE ?");
        params.push(`%${variant}%`);
      }
      whereClauses.push(`(${checks.join(" OR ")})`);
    }

    if (whereClauses.length === 0) {
      return [];
    }

    const sql = `
      SELECT
        entry_id,
        project_id,
        chapter_id,
        project_title,
        chapter_title,
        time_text,
        summary_text,
        snippet,
        citation_preview,
        tags_token
      FROM entries_fts
      WHERE ${whereClauses.join(" AND ")}
      ORDER BY rowid ASC
      LIMIT ?
    `;

    params.push(limit);

    try {
      const statement = this.db.prepare(sql);
      const rows = statement.all(...params);
      return rows.map((row) => ({
        projectId: row.project_id,
        chapterId: row.chapter_id || null,
        entryId: row.entry_id,
        projectTitle: row.project_title,
        chapterTitle: row.chapter_title,
        timeText: row.time_text,
        summaryText: row.summary_text,
        snippet: row.snippet,
        citation: row.citation_preview,
        tags: parseTagsToken(row.tags_token),
      }));
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : "查詢失敗";
      return null;
    }
  }
}

module.exports = {
  SearchIndexService,
};
