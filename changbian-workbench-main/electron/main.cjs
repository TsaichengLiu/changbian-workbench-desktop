const path = require("path");
const fs = require("fs");
const os = require("os");
const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain } = require("electron");
const { SearchIndexService } = require("./search-index.cjs");
const {
  knownRevisionIfUnchanged,
  readWorkspaceFile,
  removeStaleTempFiles,
  validateWorkspace,
  writeWorkspaceFile,
} = require("./workspace-store.cjs");

const isDev = !app.isPackaged;
const DEFAULT_SHARED_WORKSPACE_FILE = path.join(os.homedir(), ".changbian-workbench", "workspace.json");
const SETTINGS_FILE = path.join(os.homedir(), ".changbian-workbench", "settings.json");
const forcedWorkspaceFile = (process.env.CHANGBIAN_MCP_STORE || "").trim();
const DEFAULT_APPEARANCE = Object.freeze({
  theme: "changbian",
  cardStyle: "changbian",
});
const UI_THEME_IDS = new Set(["changbian", "obsidian", "ocean", "graphite", "dusk", "vaporwave"]);
const UI_CARD_STYLE_IDS = new Set(["changbian", "outline", "frosted"]);

const MENU_THEME_OPTIONS = [
  { id: "changbian", label: "縹緗" },
  { id: "obsidian", label: "黑曜石" },
  { id: "ocean", label: "海藍" },
  { id: "graphite", label: "石墨" },
  { id: "dusk", label: "黃昏" },
  { id: "vaporwave", label: "蒸汽波" },
];
const THEME_BACKGROUNDS = {
  changbian: "#f3ecdb",
  obsidian: "#0c0c10",
  ocean: "#061a2c",
  graphite: "#1d1e21",
  dusk: "#2b1b2c",
  vaporwave: "#1c0d33",
};
const MENU_CARD_OPTIONS = [
  { id: "changbian", label: "縹緗" },
  { id: "outline", label: "毛玻璃" },
  { id: "frosted", label: "金屬" },
];

function writeJsonAtomic(filePath, payload) {
  const serialized = JSON.stringify(payload, null, 2);
  const content = typeof serialized === "string" ? serialized : "null";
  const directory = path.dirname(filePath);
  const tempName = `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  const tempPath = path.join(directory, tempName);

  fs.mkdirSync(directory, { recursive: true });
  try {
    fs.writeFileSync(tempPath, content, "utf8");
    fs.renameSync(tempPath, filePath);
    return true;
  } catch {
    try {
      if (fs.existsSync(tempPath)) {
        fs.rmSync(tempPath, { force: true });
      }
    } catch {
      // Ignore temp cleanup failures.
    }
    return false;
  }
}

function loadSettings() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) {
      return {};
    }
    const raw = fs.readFileSync(SETTINGS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}

function saveSettings(settings) {
  return writeJsonAtomic(SETTINGS_FILE, settings);
}

function sanitizeAppearance(raw, fallback = DEFAULT_APPEARANCE) {
  const source = raw && typeof raw === "object" ? raw : {};
  const theme = typeof source.theme === "string" && UI_THEME_IDS.has(source.theme) ? source.theme : fallback.theme;
  const cardStyle =
    typeof source.cardStyle === "string" && UI_CARD_STYLE_IDS.has(source.cardStyle)
      ? source.cardStyle
      : fallback.cardStyle;
  return { theme, cardStyle };
}

function loadAppearanceFromSettings() {
  const settings = loadSettings();
  return sanitizeAppearance(settings.appearance, DEFAULT_APPEARANCE);
}

function resolveSharedWorkspaceFile() {
  if (forcedWorkspaceFile) {
    return forcedWorkspaceFile;
  }
  const settings = loadSettings();
  const configuredPath = typeof settings.workspacePath === "string" ? settings.workspacePath.trim() : "";
  return configuredPath || DEFAULT_SHARED_WORKSPACE_FILE;
}

let sharedWorkspaceFile = resolveSharedWorkspaceFile();
let currentAppearance = loadAppearanceFromSettings();
let workspaceWatcher = null;
let workspaceWatchTimer = null;
let lastInternalWorkspaceRevision = 0;
const searchIndexService = new SearchIndexService({
  getWorkspaceFilePath: () => sharedWorkspaceFile,
});

// 關窗／退出前請渲染程序先寫出去抖中的修改。
const CLOSE_FLUSH_TIMEOUT_MS = 5000;
let isQuitting = false;
let closeFlushRequestSeq = 0;
const pendingCloseFlushRequests = new Map();
const closeFlushReadyContents = new Set();

function requestRendererFlush(win) {
  return new Promise((resolve) => {
    closeFlushRequestSeq += 1;
    const requestId = closeFlushRequestSeq;
    const timer = setTimeout(() => {
      pendingCloseFlushRequests.delete(requestId);
      resolve(null);
    }, CLOSE_FLUSH_TIMEOUT_MS);
    pendingCloseFlushRequests.set(requestId, (result) => {
      clearTimeout(timer);
      resolve(result && typeof result === "object" ? result : null);
    });
    win.webContents.send("app:close-flush-request", requestId);
  });
}

async function confirmWindowClose(win) {
  if (win.isDestroyed() || win.webContents.isCrashed() || !closeFlushReadyContents.has(win.webContents.id)) {
    return true;
  }
  const result = await requestRendererFlush(win);
  if (win.isDestroyed()) {
    return true;
  }

  let message = "";
  let detail = "";
  if (!result) {
    message = "長編工作臺沒有回應存檔請求。";
    detail = "現在關閉，最近幾秒的修改可能會遺失。";
  } else if (result.hasUnsavedDraft) {
    message = "有一條史料還在編輯中，尚未保存。";
    detail = "現在關閉，這條史料的修改會遺失。";
  } else if (!result.saved) {
    message = "最近的修改未能寫入資料檔。";
    detail = "現在關閉，這些修改可能會遺失。建議先取消，到「檔案資料管理」中備份。";
  } else {
    return true;
  }

  const { response } = await dialog.showMessageBox(win, {
    type: "warning",
    buttons: ["取消", "仍要關閉"],
    defaultId: 0,
    cancelId: 0,
    message,
    detail,
  });
  return response === 1;
}

ipcMain.on("app:close-flush-ready", (event, ready) => {
  if (ready) {
    closeFlushReadyContents.add(event.sender.id);
  } else {
    closeFlushReadyContents.delete(event.sender.id);
  }
});

ipcMain.on("app:close-flush-done", (_event, requestId, result) => {
  const resolve = pendingCloseFlushRequests.get(requestId);
  if (resolve) {
    pendingCloseFlushRequests.delete(requestId);
    resolve(result);
  }
});

function broadcastAppearance() {
  const payload = { ...currentAppearance };
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) {
      continue;
    }
    win.webContents.send("appearance:changed", payload);
  }
}

function applyAppearance(nextAppearance, source = "renderer") {
  const merged = sanitizeAppearance({ ...currentAppearance, ...(nextAppearance || {}) }, currentAppearance);
  const changed =
    merged.theme !== currentAppearance.theme || merged.cardStyle !== currentAppearance.cardStyle;
  if (!changed) {
    return { changed: false, appearance: currentAppearance };
  }

  currentAppearance = merged;
  const settings = loadSettings();
  settings.appearance = currentAppearance;
  saveSettings(settings);
  setApplicationMenu();

  if (source === "menu") {
    broadcastAppearance();
  }
  return { changed: true, appearance: currentAppearance };
}

function getStorageInfo() {
  return {
    path: sharedWorkspaceFile,
    defaultPath: DEFAULT_SHARED_WORKSPACE_FILE,
    envLocked: Boolean(forcedWorkspaceFile),
    envPath: forcedWorkspaceFile || null,
  };
}

// 啟動時主程序已讀過一次資料檔；界面隨即來要時若檔案未變，直接交出這份，免得再解析一遍。
let startupWorkspace = null;

function loadSharedWorkspace() {
  const cached = startupWorkspace;
  startupWorkspace = null;
  if (cached && cached.path === sharedWorkspaceFile && knownRevisionIfUnchanged(sharedWorkspaceFile) === cached.result.revision) {
    return cached.result;
  }
  return readWorkspaceFile(sharedWorkspaceFile);
}

function saveSharedWorkspace(workspace, expectedRevision) {
  const result = writeWorkspaceFile(sharedWorkspaceFile, workspace, { expectedRevision });
  if (!result.ok) {
    return result;
  }
  lastInternalWorkspaceRevision = result.revision;
  searchIndexService.syncWorkspace(result.workspace);
  return result;
}

function broadcastExternalWorkspaceChange(revision) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send("workspace:external-change", { revision });
    }
  }
}

function stopWorkspaceWatcher() {
  if (workspaceWatchTimer) {
    clearTimeout(workspaceWatchTimer);
    workspaceWatchTimer = null;
  }
  if (workspaceWatcher) {
    try { workspaceWatcher.close(); } catch {}
    workspaceWatcher = null;
  }
}

function startWorkspaceWatcher() {
  stopWorkspaceWatcher();
  const directory = path.dirname(sharedWorkspaceFile);
  const targetName = path.basename(sharedWorkspaceFile);
  fs.mkdirSync(directory, { recursive: true });
  try {
    workspaceWatcher = fs.watch(directory, (_eventType, filename) => {
      if (filename && String(filename) !== targetName) return;
      if (workspaceWatchTimer) clearTimeout(workspaceWatchTimer);
      workspaceWatchTimer = setTimeout(() => {
        workspaceWatchTimer = null;
        // 本程序自己剛寫入的變動：不必再讀入解析。
        if (knownRevisionIfUnchanged(sharedWorkspaceFile) === lastInternalWorkspaceRevision) return;
        const result = readWorkspaceFile(sharedWorkspaceFile);
        if (!result.ok || !result.workspace || result.revision === lastInternalWorkspaceRevision) return;
        lastInternalWorkspaceRevision = result.revision;
        broadcastExternalWorkspaceChange(result.revision);
      }, 160);
    });
  } catch {
    workspaceWatcher = null;
  }
}

function setSharedWorkspacePath(nextPath, workspace) {
  if (forcedWorkspaceFile) {
    return {
      ok: false,
      error: `目前由環境變數 CHANGBIAN_MCP_STORE 鎖定路徑：${forcedWorkspaceFile}`,
    };
  }

  const candidate = typeof nextPath === "string" ? nextPath.trim() : "";
  if (!candidate) {
    return { ok: false, error: "請輸入有效路徑。" };
  }

  const normalizedPath = path.resolve(candidate);
  let revision = 0;
  if (workspace && typeof workspace === "object") {
    const currentTarget = readWorkspaceFile(normalizedPath);
    const saved = writeWorkspaceFile(normalizedPath, workspace, {
      expectedRevision: currentTarget.ok ? currentTarget.revision : undefined,
    });
    if (!saved.ok) {
      return { ok: false, error: `未切換路徑，目標檔寫入失敗：${saved.error || "未知錯誤"}` };
    }
    revision = saved.revision;
  }

  const settings = loadSettings();
  settings.workspacePath = normalizedPath;
  if (!saveSettings(settings)) {
    return { ok: false, error: "資料已寫入目標檔，但無法保存路徑設定；目前路徑未切換。" };
  }

  sharedWorkspaceFile = normalizedPath;
  lastInternalWorkspaceRevision = revision;
  searchIndexService.close();
  if (workspace && typeof workspace === "object") searchIndexService.syncWorkspace(workspace);
  startWorkspaceWatcher();
  return { ok: true, path: sharedWorkspaceFile, revision };
}

function resetSharedWorkspacePath(workspace) {
  if (forcedWorkspaceFile) {
    return {
      ok: false,
      error: `目前由環境變數 CHANGBIAN_MCP_STORE 鎖定路徑：${forcedWorkspaceFile}`,
    };
  }

  let revision = 0;
  if (workspace && typeof workspace === "object") {
    const currentTarget = readWorkspaceFile(DEFAULT_SHARED_WORKSPACE_FILE);
    const saved = writeWorkspaceFile(DEFAULT_SHARED_WORKSPACE_FILE, workspace, {
      expectedRevision: currentTarget.ok ? currentTarget.revision : undefined,
    });
    if (!saved.ok) {
      return { ok: false, error: `未重設路徑，預設檔寫入失敗：${saved.error || "未知錯誤"}` };
    }
    revision = saved.revision;
  }

  const settings = loadSettings();
  delete settings.workspacePath;
  if (!saveSettings(settings)) {
    return { ok: false, error: "資料已寫入預設檔，但無法更新路徑設定；目前路徑未切換。" };
  }

  sharedWorkspaceFile = DEFAULT_SHARED_WORKSPACE_FILE;
  lastInternalWorkspaceRevision = revision;
  searchIndexService.close();
  if (workspace && typeof workspace === "object") searchIndexService.syncWorkspace(workspace);
  startWorkspaceWatcher();
  return { ok: true, path: sharedWorkspaceFile, revision };
}

function ensureJsonExtension(filePath) {
  const normalized = typeof filePath === "string" ? filePath.trim() : "";
  if (!normalized) {
    return "";
  }
  return normalized.toLocaleLowerCase().endsWith(".json") ? normalized : `${normalized}.json`;
}

function buildAppearanceSubmenu() {
  return [
    {
      label: "配色",
      submenu: MENU_THEME_OPTIONS.map((option) => ({
        label: option.label,
        type: "radio",
        checked: currentAppearance.theme === option.id,
        click: () => {
          applyAppearance({ theme: option.id }, "menu");
        },
      })),
    },
    {
      label: "卡片",
      submenu: MENU_CARD_OPTIONS.map((option) => ({
        label: option.label,
        type: "radio",
        checked: currentAppearance.cardStyle === option.id,
        click: () => {
          applyAppearance({ cardStyle: option.id }, "menu");
        },
      })),
    },
  ];
}

function buildAppMenuTemplate() {
  const base = [
    { role: "appMenu" },
    { role: "fileMenu" },
    { role: "editMenu" },
    {
      label: "外觀",
      submenu: buildAppearanceSubmenu(),
    },
    // 打包版不提供重新載入：重新載入不會觸發關窗前的存檔。
    isDev
      ? { role: "viewMenu" }
      : {
          role: "viewMenu",
          submenu: [
            { role: "resetZoom" },
            { role: "zoomIn" },
            { role: "zoomOut" },
            { type: "separator" },
            { role: "togglefullscreen" },
          ],
        },
    { role: "windowMenu" },
  ];

  if (process.platform !== "darwin") {
    return [
      ...base,
      {
        role: "help",
        submenu: [],
      },
    ];
  }
  return base;
}

function setApplicationMenu() {
  const menu = Menu.buildFromTemplate(buildAppMenuTemplate());
  Menu.setApplicationMenu(menu);
}

ipcMain.handle("workspace:load-shared", () => loadSharedWorkspace());
// 「複製引用」：經由主程序寫入系統剪貼簿，不受網頁焦點與權限限制。
ipcMain.handle("clipboard:write-text", (_event, text) => {
  clipboard.writeText(String(text ?? ""));
  return true;
});
// 存檔成功時界面只需要新版本號，不把整個工作區再傳回去。
ipcMain.handle("workspace:save-shared", (_event, workspace, expectedRevision) => {
  const result = saveSharedWorkspace(workspace, expectedRevision);
  if (result.ok) {
    const { workspace: _saved, ...rest } = result;
    return rest;
  }
  return result;
});
ipcMain.handle("workspace:shared-path", () => sharedWorkspaceFile);
ipcMain.handle("workspace:storage-info", () => getStorageInfo());
ipcMain.handle("workspace:set-shared-path", (_event, nextPath, workspace) =>
  setSharedWorkspacePath(nextPath, workspace),
);
ipcMain.handle("workspace:reset-shared-path", (_event, workspace) =>
  resetSharedWorkspacePath(workspace),
);
ipcMain.handle("appearance:get", () => ({ ...currentAppearance }));
ipcMain.handle("appearance:set", (_event, nextAppearance) => {
  const { appearance } = applyAppearance(nextAppearance, "renderer");
  return { ...appearance };
});
ipcMain.handle("search:query", (_event, criteria) => searchIndexService.search(criteria));
ipcMain.handle("search:status", () => searchIndexService.getStatus());
ipcMain.handle("workspace:pick-shared-path", async () => {
  const focused = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || undefined;
  const result = await dialog.showSaveDialog(focused, {
    title: "選擇史料資料檔",
    defaultPath: sharedWorkspaceFile,
    filters: [{ name: "JSON", extensions: ["json"] }],
    properties: ["createDirectory", "showOverwriteConfirmation"],
  });

  if (result.canceled) {
    return null;
  }
  return result.filePath || null;
});

ipcMain.handle("workspace:export-file", async (_event, workspace, suggestedFileName) => {
  const focused = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || undefined;
  const baseName =
    typeof suggestedFileName === "string" && suggestedFileName.trim()
      ? suggestedFileName.trim()
      : path.basename(sharedWorkspaceFile) || "workspace.json";
  const defaultPath = path.join(path.dirname(sharedWorkspaceFile), ensureJsonExtension(baseName));
  const result = await dialog.showSaveDialog(focused, {
    title: "備份工作臺檔案",
    defaultPath,
    buttonLabel: "備份到",
    filters: [{ name: "JSON", extensions: ["json"] }],
    properties: ["createDirectory", "showOverwriteConfirmation"],
  });

  if (result.canceled || !result.filePath) {
    return { ok: false, canceled: true };
  }

  const filePath = ensureJsonExtension(result.filePath);
  if (fs.existsSync(filePath)) {
    const confirm = await dialog.showMessageBox(focused, {
      type: "warning",
      title: "確認覆蓋備份檔",
      message: `檔案已存在：\n${filePath}\n\n是否要覆蓋這個備份檔？`,
      buttons: ["取消", "覆蓋備份檔"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (confirm.response !== 1) {
      return { ok: false, canceled: true };
    }
  }
  const validation = validateWorkspace(workspace);
  if (!validation.ok) {
    return { ok: false, error: `拒絕備份無效資料：${validation.errors.slice(0, 4).join("；")}` };
  }
  const saved = writeJsonAtomic(filePath, validation.workspace);
  if (!saved) {
    return { ok: false, error: "無法寫入檔案。" };
  }
  return { ok: true, path: filePath };
});

ipcMain.handle("workspace:import-file", async () => {
  const focused = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || undefined;
  const result = await dialog.showOpenDialog(focused, {
    title: "匯入工作臺檔案",
    defaultPath: path.dirname(sharedWorkspaceFile),
    filters: [{ name: "JSON", extensions: ["json"] }],
    properties: ["openFile"],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { ok: false, canceled: true };
  }

  const filePath = result.filePaths[0];
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw);
    const validation = validateWorkspace(data);
    if (!validation.ok) {
      return { ok: false, error: `檔案格式不正確：${validation.errors.slice(0, 4).join("；")}` };
    }
    return { ok: true, path: filePath, data: validation.workspace };
  } catch {
    return { ok: false, error: "檔案讀取或解析失敗，請確認為有效 JSON。" };
  }
});

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1600,
    height: 960,
    minWidth: 1180,
    minHeight: 760,
    titleBarStyle: "hiddenInset",
    // 與當前配色的底色一致（見 styles.css 的 --bg-0），避免載入時閃一下別的顏色。
    backgroundColor: THEME_BACKGROUNDS[currentAppearance.theme] || THEME_BACKGROUNDS.changbian,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  if (isDev) {
    mainWindow.loadURL("http://localhost:5173");
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }

  mainWindow.webContents.on("did-finish-load", () => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send("appearance:changed", { ...currentAppearance });
    }
  });

  const contentsId = mainWindow.webContents.id;
  mainWindow.webContents.on("did-start-loading", () => {
    closeFlushReadyContents.delete(contentsId);
  });

  let closeApproved = false;
  let closeCheckInProgress = false;
  mainWindow.on("close", (event) => {
    if (closeApproved) {
      return;
    }
    event.preventDefault();
    if (closeCheckInProgress) {
      return;
    }
    closeCheckInProgress = true;
    void confirmWindowClose(mainWindow).then((proceed) => {
      closeCheckInProgress = false;
      if (!proceed) {
        isQuitting = false;
        return;
      }
      closeApproved = true;
      if (isQuitting) {
        app.quit();
      } else if (!mainWindow.isDestroyed()) {
        mainWindow.close();
      }
    });
  });

  mainWindow.on("closed", () => {
    closeFlushReadyContents.delete(contentsId);
  });
}

app.whenReady().then(() => {
  setApplicationMenu();
  // 清掉上次中斷存檔留下的暫存檔。
  removeStaleTempFiles(sharedWorkspaceFile);
  removeStaleTempFiles(SETTINGS_FILE);
  const loaded = readWorkspaceFile(sharedWorkspaceFile);
  if (loaded.ok) {
    startupWorkspace = { path: sharedWorkspaceFile, result: loaded };
  }
  if (loaded.ok && loaded.workspace) {
    lastInternalWorkspaceRevision = loaded.revision;
  }
  startWorkspaceWatcher();
  createWindow();
  // 先開窗口，再同步檢索索引：索引已是最新時只需核對各條簽名；需要重建也不擋住窗口出現。
  if (loaded.ok && loaded.workspace) {
    setImmediate(() => searchIndexService.syncWorkspace(loaded.workspace));
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      startWorkspaceWatcher();
      createWindow();
      // 窗口關著時資料檔可能被 MCP 改過：重新打開時核對一次索引。
      setImmediate(() => {
        const reloaded = readWorkspaceFile(sharedWorkspaceFile);
        if (reloaded.ok && reloaded.workspace) {
          lastInternalWorkspaceRevision = reloaded.revision;
          searchIndexService.syncWorkspace(reloaded.workspace);
        }
      });
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
    return;
  }
  // macOS 關掉窗口後程式仍在背景：停止監看資料檔、關閉索引資料庫（WAL 檔隨之併回並刪除），
  // 下次打開窗口時再啟用。
  stopWorkspaceWatcher();
  searchIndexService.close();
});

app.on("before-quit", () => {
  isQuitting = true;
});

// 視窗關閉前仍可能寫出最後一次存檔，所以清理要等到 will-quit。
app.on("will-quit", () => {
  stopWorkspaceWatcher();
  searchIndexService.close();
});
