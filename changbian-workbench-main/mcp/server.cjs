#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  WORKSPACE_SCHEMA_VERSION,
  readWorkspaceFile,
  writeWorkspaceFile,
} = require("../electron/workspace-store.cjs");

const DEFAULT_STORAGE_FILE = path.join(os.homedir(), ".changbian-workbench", "workspace.json");
const SETTINGS_FILE = path.join(os.homedir(), ".changbian-workbench", "settings.json");

function resolveStorageFile() {
  const envPath = (process.env.CHANGBIAN_MCP_STORE || "").trim();
  if (envPath) {
    return envPath;
  }

  try {
    if (!fs.existsSync(SETTINGS_FILE)) {
      return DEFAULT_STORAGE_FILE;
    }
    const raw = fs.readFileSync(SETTINGS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const configuredPath =
      parsed && typeof parsed.workspacePath === "string" ? parsed.workspacePath.trim() : "";
    return configuredPath || DEFAULT_STORAGE_FILE;
  } catch {
    return DEFAULT_STORAGE_FILE;
  }
}

const TAG_REGEX = /#([^\s#，。；、,.;:!?！？【】（）()<>《》]+)/g;
const CITATION_TITLE_REGEX = /《([^》\n\r]+)》/g;

function createId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function extractTags(text) {
  const tags = [];
  const seen = new Set();
  for (const match of String(text || "").matchAll(TAG_REGEX)) {
    const token = `#${(match[1] || "").trim()}`;
    if (!token || token === "#") {
      continue;
    }
    const key = token.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    tags.push(token);
  }
  return tags;
}

function extractCitationTitles(text) {
  const titles = [];
  const seen = new Set();
  for (const match of String(text || "").matchAll(CITATION_TITLE_REGEX)) {
    const token = (match[1] || "").trim();
    if (!token) {
      continue;
    }
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);
    titles.push(token);
  }
  return titles;
}

function includesIgnoreCase(text, query) {
  if (!query) {
    return true;
  }
  return String(text || "").toLowerCase().includes(query.toLowerCase());
}

function createInitialWorkspace() {
  const projectId = createId("project");
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    revision: 0,
    projectOrder: [projectId],
    projects: {
      [projectId]: {
        id: projectId,
        title: "MCP 新建專案",
        chapterIds: [],
        createdAt: Date.now(),
      },
    },
    chapters: {},
    entries: {},
    trash: [],
    activeProjectId: projectId,
    activeChapterId: null,
    selectedEntryId: null,
  };
}

function loadWorkspace(storageFile) {
  const result = readWorkspaceFile(storageFile);
  if (!result.ok) {
    throw new Error(`${result.error}。原檔已保留，請先修復或從 .bak 還原。`);
  }
  if (result.workspace) return result.workspace;

  const initial = createInitialWorkspace();
  const created = writeWorkspaceFile(storageFile, initial, { expectedRevision: 0 });
  if (!created.ok) throw new Error(created.error || "無法建立工作臺資料檔");
  return created.workspace;
}

function saveWorkspace(workspace, storageFile) {
  const result = writeWorkspaceFile(storageFile, workspace, {
    expectedRevision: Number.isInteger(workspace.revision) ? workspace.revision : 0,
  });
  if (!result.ok) {
    throw new Error(result.error || "資料寫入失敗");
  }
  workspace.revision = result.revision;
}

function uniqueProjectTitle(workspace, rawTitle) {
  const base = String(rawTitle || "").trim() || "新建專案";
  const used = new Set(Object.values(workspace.projects || {}).map((project) => project.title));
  if (!used.has(base)) {
    return base;
  }
  let counter = 2;
  while (used.has(`${base} (${counter})`)) {
    counter += 1;
  }
  return `${base} (${counter})`;
}

function appendEntry(workspace, payload) {
  const project = workspace.projects[payload.projectId];
  if (!project) {
    throw new Error("project_id 不存在");
  }

  if (!payload.chapterId) {
    throw new Error("chapter_id 為必填：史料必須錄入某個章節");
  }
  const chapter = workspace.chapters[payload.chapterId];
  if (!chapter) {
    throw new Error("chapter_id 不存在");
  }
  if (chapter.projectId !== payload.projectId) {
    throw new Error("chapter_id 不屬於 project_id");
  }

  const entryId = createId("entry");
  const now = Date.now();
  workspace.entries[entryId] = {
    id: entryId,
    projectId: payload.projectId,
    chapterId: payload.chapterId,
    timeText: payload.timeText || "",
    summary: payload.summary || "",
    sourceText: payload.sourceText || "",
    note: payload.note || "",
    citation: payload.citation || "",
    createdAt: now,
    updatedAt: now,
  };

  workspace.chapters[payload.chapterId].entryIds.push(entryId);

  workspace.activeProjectId = payload.projectId;
  workspace.activeChapterId = payload.chapterId;
  workspace.selectedEntryId = entryId;

  return entryId;
}

const TOOLS = [
  {
    name: "list_projects",
    description: "列出全部專案、章節與史料數量摘要。",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "create_project",
    description: "建立新專案。",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "專案標題" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "create_chapter",
    description: "在指定專案下建立新章節。",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "目標專案 ID" },
        title: { type: "string", description: "章節標題" },
      },
      required: ["project_id"],
      additionalProperties: false,
    },
  },
  {
    name: "add_entry",
    description: "錄入一條史料。",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "目標專案 ID" },
        chapter_id: { type: "string", description: "目標章節 ID（必填，史料一律錄入章節之下）" },
        time_text: { type: "string", description: "時間文本" },
        summary: { type: "string", description: "摘要（可選）" },
        source_text: { type: "string", description: "史料文本" },
        note: { type: "string", description: "備註（可含 #標籤）" },
        citation: { type: "string", description: "引文註釋" },
      },
      required: ["project_id", "chapter_id", "source_text"],
      additionalProperties: false,
    },
  },
  {
    name: "search_entries",
    description: "檢索史料，可按關鍵詞、標籤、引文《》書名篩選。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "關鍵詞" },
        tag: { type: "string", description: "標籤，如 #人物" },
        citation_title: { type: "string", description: "引文《》內書名" },
        limit: { type: "number", description: "返回數量上限（預設 50）" },
      },
      additionalProperties: false,
    },
  },
];

function toolText(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

function parseArgs(params) {
  if (!params || typeof params !== "object") {
    return {};
  }
  const args = params.arguments;
  if (!args || typeof args !== "object") {
    return {};
  }
  return args;
}

function handleToolCall(name, args) {
  const storageFile = resolveStorageFile();
  const workspace = loadWorkspace(storageFile);

  if (name === "list_projects") {
    const projects = workspace.projectOrder
      .map((projectId) => workspace.projects[projectId])
      .filter(Boolean)
      .map((project) => {
        const chapterCount = project.chapterIds.length;
        const chapterEntryCount = project.chapterIds.reduce((sum, chapterId) => {
          const chapter = workspace.chapters[chapterId];
          return sum + (chapter ? chapter.entryIds.length : 0);
        }, 0);
        return {
          id: project.id,
          title: project.title,
          chapter_count: chapterCount,
          entry_count: chapterEntryCount,
          chapters: project.chapterIds
            .map((chapterId) => workspace.chapters[chapterId])
            .filter(Boolean)
            .map((chapter) => ({
              id: chapter.id,
              title: chapter.title,
              entry_count: chapter.entryIds.length,
            })),
        };
      });

    return toolText({
      storage_file: storageFile,
      project_count: projects.length,
      projects,
    });
  }

  if (name === "create_project") {
    const projectId = createId("project");
    const title = uniqueProjectTitle(workspace, args.title);
    workspace.projects[projectId] = {
      id: projectId,
      title,
      chapterIds: [],
      createdAt: Date.now(),
    };
    workspace.projectOrder.push(projectId);
    workspace.activeProjectId = projectId;
    workspace.activeChapterId = null;
    workspace.selectedEntryId = null;
    saveWorkspace(workspace, storageFile);

    return toolText({
      ok: true,
      project_id: projectId,
      title,
    });
  }

  if (name === "create_chapter") {
    const projectId = String(args.project_id || "").trim();
    if (!projectId || !workspace.projects[projectId]) {
      throw new Error("project_id 不存在");
    }

    const chapterId = createId("chapter");
    const title = String(args.title || "").trim() || "新章節";

    workspace.chapters[chapterId] = {
      id: chapterId,
      projectId,
      title,
      entryIds: [],
      createdAt: Date.now(),
    };
    workspace.projects[projectId].chapterIds.push(chapterId);
    workspace.activeProjectId = projectId;
    workspace.activeChapterId = chapterId;
    workspace.selectedEntryId = null;
    saveWorkspace(workspace, storageFile);

    return toolText({
      ok: true,
      chapter_id: chapterId,
      project_id: projectId,
      title,
    });
  }

  if (name === "add_entry") {
    const projectId = String(args.project_id || "").trim();
    const chapterId = String(args.chapter_id || "").trim();

    const entryId = appendEntry(workspace, {
      projectId,
      chapterId: chapterId || null,
      timeText: String(args.time_text || ""),
      summary: String(args.summary || ""),
      sourceText: String(args.source_text || ""),
      note: String(args.note || ""),
      citation: String(args.citation || ""),
    });
    saveWorkspace(workspace, storageFile);

    return toolText({
      ok: true,
      entry_id: entryId,
      project_id: projectId,
      chapter_id: chapterId || null,
    });
  }

  if (name === "search_entries") {
    const query = String(args.query || "").trim();
    const tagRaw = String(args.tag || "").trim();
    const tag = tagRaw ? (tagRaw.startsWith("#") ? tagRaw.toLowerCase() : `#${tagRaw.toLowerCase()}`) : "";
    const citationTitle = String(args.citation_title || "").trim();
    const limit = Math.max(1, Math.min(500, Number(args.limit) || 50));

    const rows = [];

    for (const projectId of workspace.projectOrder) {
      const project = workspace.projects[projectId];
      if (!project) {
        continue;
      }

      const chapterLevel = project.chapterIds.flatMap((chapterId) => {
        const chapter = workspace.chapters[chapterId];
        if (!chapter) {
          return [];
        }
        return chapter.entryIds.map((entryId) => ({
          entry: workspace.entries[entryId],
          chapterId,
          chapterTitle: chapter.title,
        }));
      });

      for (const item of chapterLevel) {
        const entry = item.entry;
        if (!entry) {
          continue;
        }

        const queryPass = query
          ? includesIgnoreCase(
              [
                project.title,
                item.chapterTitle,
                entry.timeText,
                entry.summary || "",
                entry.sourceText,
                entry.note,
                entry.citation,
              ].join("\n"),
              query,
            )
          : true;

        const tagPass = tag
          ? extractTags(entry.note).some((token) => token.toLowerCase() === tag)
          : true;

        const citationPass = citationTitle
          ? extractCitationTitles(entry.citation).some((token) => includesIgnoreCase(token, citationTitle)) ||
            includesIgnoreCase(entry.citation, citationTitle)
          : true;

        if (!queryPass || !tagPass || !citationPass) {
          continue;
        }

        rows.push({
          entry_id: entry.id,
          project_id: project.id,
          project_title: project.title,
          chapter_id: item.chapterId,
          chapter_title: item.chapterTitle,
          time_text: entry.timeText,
          summary: entry.summary || "",
          source_text: entry.sourceText,
          note: entry.note,
          citation: entry.citation,
          tags: extractTags(entry.note),
        });

        if (rows.length >= limit) {
          break;
        }
      }

      if (rows.length >= limit) {
        break;
      }
    }

    return toolText({
      count: rows.length,
      rows,
    });
  }

  throw new Error(`未知工具：${name}`);
}

// MCP 的 stdio 傳輸使用「一行一則 JSON」(NDJSON)；舊版本只實作了 LSP 式的
// Content-Length 標頭，導致任何 MCP 客戶端都連不上。這裡兩種都支援：
// 依客戶端送來的框格式回覆，預設 NDJSON。
let useContentLengthFraming = false;

function sendMessage(payload) {
  const json = JSON.stringify(payload);
  if (useContentLengthFraming) {
    process.stdout.write(`Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n` + json);
  } else {
    process.stdout.write(json + "\n");
  }
}

function sendResult(id, result) {
  sendMessage({
    jsonrpc: "2.0",
    id,
    result,
  });
}

function sendError(id, code, message) {
  sendMessage({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  });
}

async function handleRequest(request) {
  const { id, method, params } = request;

  if (!method) {
    if (id !== undefined) {
      sendError(id, -32600, "Invalid Request");
    }
    return;
  }

  try {
    if (method === "initialize") {
      const protocolVersion = typeof params?.protocolVersion === "string" ? params.protocolVersion : "2024-11-05";
      sendResult(id, {
        protocolVersion,
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: "changbian-workbench-mcp",
          version: "0.1.0",
        },
      });
      return;
    }

    if (method === "notifications/initialized") {
      return;
    }

    if (method === "ping") {
      sendResult(id, {});
      return;
    }

    if (method === "tools/list") {
      sendResult(id, { tools: TOOLS });
      return;
    }

    if (method === "tools/call") {
      const name = String(params?.name || "").trim();
      const args = parseArgs(params);
      const result = handleToolCall(name, args);
      sendResult(id, result);
      return;
    }

    if (method === "resources/list") {
      sendResult(id, { resources: [] });
      return;
    }

    if (method === "prompts/list") {
      sendResult(id, { prompts: [] });
      return;
    }

    if (method === "shutdown") {
      sendResult(id, {});
      return;
    }

    if (id !== undefined) {
      sendError(id, -32601, `Method not found: ${method}`);
    }
  } catch (error) {
    if (id !== undefined) {
      sendError(id, -32000, error instanceof Error ? error.message : "Internal error");
    }
  }
}

let buffer = Buffer.alloc(0);

function dispatch(payload) {
  let request;
  try {
    request = JSON.parse(payload);
  } catch {
    return;
  }
  void handleRequest(request);
}

function drainNdjson() {
  while (true) {
    const newlineIndex = buffer.indexOf("\n");
    if (newlineIndex === -1) {
      return;
    }
    const line = buffer.slice(0, newlineIndex).toString("utf8").trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (line) {
      dispatch(line);
    }
  }
}

function drainContentLength() {
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      return;
    }

    const headerText = buffer.slice(0, headerEnd).toString("utf8");
    const lengthMatch = headerText.match(/Content-Length:\s*(\d+)/i);
    if (!lengthMatch) {
      buffer = Buffer.alloc(0);
      return;
    }

    const bodyLength = Number(lengthMatch[1]);
    const messageStart = headerEnd + 4;
    const messageEnd = messageStart + bodyLength;

    if (buffer.length < messageEnd) {
      return;
    }

    const payload = buffer.slice(messageStart, messageEnd).toString("utf8");
    buffer = buffer.slice(messageEnd);
    dispatch(payload);
  }
}

let framingDetected = false;

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);

  if (!framingDetected) {
    const head = buffer.slice(0, 32).toString("utf8").trimStart();
    if (head.length === 0) {
      return;
    }
    useContentLengthFraming = /^Content-Length:/i.test(head);
    framingDetected = true;
  }

  if (useContentLengthFraming) {
    drainContentLength();
  } else {
    drainNdjson();
  }
});

process.stdin.on("end", () => {
  process.exit(0);
});
